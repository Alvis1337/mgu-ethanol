'use strict';
/**
 * reader.js - ethanol content from the engine unit, READ ONLY.
 *
 * Goes through kit/readonly-diag.js (only UDS 0x22 and OBD 0x01 / 0x09 can leave the head unit) and
 * kit/dids.js (candidate list, first plausible answer wins and is tried first next time).
 *
 *   const r = new EthanolReader(link, config);
 *   r.source = 'auto';          // or one candidate's label ('550D', 'F452', 'OBD 52'): Settings > Ethanol source
 *   const s = await r.poll();   // { value, source, bytes, why, at }  value = % or null
 *   const k = await r.tank();   // { litres, pct, source, why, at }  fuel in the tank, for the fill-up calculator
 */
const { DidReader } = require('./kit/dids');

const DEFAULT = {
    ecu: 18,
    candidates: [
        { did: 'F452', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100 },
        { obd: '52', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100 },
    ],
    probe: [],
    // fuel in the tank: litres from the DME (583B, DME8FF_R), else the OBD fuel level in % of the tank
    tankLitres: [{ did: '583B', bytes: 1, at: 0, factor: 1, offset: 0, min: 0, max: 150 }],
    tankPercent: [{ obd: '2F', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100 }],
    // The link skips a unit after 5 requests in a row without an answer (kit/readonly-diag.js) until it is woken.
    // A DME that is asleep when the app opens (ignition off, engine not started) would then never be asked again:
    // wake it at most this often so reading starts once it answers.
    wakeMs: 10000,
};

class EthanolReader {
    constructor(link, config) {
        this.cfg = Object.assign({}, DEFAULT, config || {});
        this.link = link;
        this.rd = new DidReader(link, { ecu: this.cfg.ecu });
        this.wokeAt = 0;
        this.probeAt = 0;
        this.source = 'auto';
        this.last = { value: null, source: '', bytes: '', why: 'not read yet', at: 0 };
        this.lastTank = { litres: null, pct: null, source: '', why: 'not read yet', at: 0 };
        this.probes = [];       // [{ label, bytes, why }] raw replies of config.probe (never shown as the value)
    }

    /** Is the link skipping the DME for now (it stopped answering)? */
    silent() {
        return !!(this.link && typeof this.link.silent === 'function' && this.link.silent(this.cfg.ecu));
    }

    /** Wake the DME on the link when it is being skipped and wakeMs has passed since the last wake. */
    wakeIfSilent(now) {
        if (!this.silent() || typeof this.link.wake !== 'function') return false;
        if (now - this.wokeAt < this.cfg.wakeMs) return false;
        this.wokeAt = now;
        this.link.wake(this.cfg.ecu);
        return true;
    }

    /** The candidates to try: all of config.candidates in order, or only the one chosen as the source. */
    candidates() {
        const all = this.cfg.candidates || [];
        if (!this.source || this.source === 'auto') return all;
        const one = all.filter((c) => DidReader.label(c) === this.source);
        return one.length ? one : all;
    }

    /** One round: the first candidate with a plausible number, else why none did. */
    async poll() {
        this.wakeIfSilent(Date.now());
        const list = this.candidates(), name = 'ethanol:' + (this.source || 'auto');
        const v = await this.rd.value(name, list);
        const now = Date.now();
        if (v !== null) {
            const i = this.rd.pick[name] || 0, c = list[i], raw = this.rd.raws[this.rd.key(c)];
            this.last = { value: Math.max(0, Math.min(100, v)), source: DidReader.label(c), bytes: raw ? raw.bytes : '', why: '', at: now };
        } else {
            // why: the reasons of the candidates, e.g. "F452 NRC 31 requestOutOfRange"
            const why = list.map((c) => {
                const r = this.rd.raws[this.rd.key(c)];
                return DidReader.label(c) + (r && r.why ? ' ' + r.why : '');
            }).join(' / ');
            this.last = { value: null, source: '', bytes: '', why: why || 'no candidates', at: this.last.at };
        }
        return this.last;
    }

    /** Fuel in the tank: litres if the DME has them, else percent of the tank (OBD 2F), else why neither. */
    async tank() {
        this.wakeIfSilent(Date.now());
        const now = Date.now(), lit = this.cfg.tankLitres || [], per = this.cfg.tankPercent || [];
        const l = lit.length ? await this.rd.value('tankLitres', lit) : null;
        if (l !== null) {
            this.lastTank = { litres: l, pct: null, source: DidReader.label(lit[this.rd.pick.tankLitres || 0]), why: '', at: now };
            return this.lastTank;
        }
        const p = per.length ? await this.rd.value('tankPercent', per) : null;
        if (p !== null) {
            this.lastTank = { litres: null, pct: p, source: DidReader.label(per[this.rd.pick.tankPercent || 0]), why: '', at: now };
            return this.lastTank;
        }
        const why = lit.concat(per).map((c) => {
            const r = this.rd.raws[this.rd.key(c)];
            return DidReader.label(c) + (r && r.why ? ' ' + r.why : '');
        }).join(' / ');
        this.lastTank = { litres: null, pct: null, source: '', why: why || 'no candidates', at: this.lastTank.at };
        return this.lastTank;
    }

    /** Raw replies of the probe identifiers (at most every 30 s), for the details line. */
    async probe(force) {
        const now = Date.now();
        if (!force && now - this.probeAt < 30000) return this.probes;
        this.probeAt = now;
        const out = [];
        for (const c of this.cfg.probe || []) {
            await this.rd.read(c);
            const r = this.rd.raws[this.rd.key(c)] || {};
            out.push({ label: DidReader.label(c), bytes: r.bytes || '', why: r.why || '' });
        }
        this.probes = out;
        return out;
    }
}

module.exports = EthanolReader;
