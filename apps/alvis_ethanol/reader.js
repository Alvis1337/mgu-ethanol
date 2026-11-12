'use strict';
/**
 * reader.js - ethanol content from the engine unit, READ ONLY.
 *
 * Goes through kit/readonly-diag.js (only UDS 0x22 and OBD 0x01 / 0x09 can leave the head unit) and
 * kit/dids.js (candidate list, first plausible answer wins and is tried first next time).
 *
 *   const r = new EthanolReader(link, config);
 *   const s = await r.poll();   // { value, source, bytes, why, at }  value = % or null
 */
const { DidReader } = require('./kit/dids');

const DEFAULT = {
    ecu: 18,
    candidates: [
        { did: 'F452', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100 },
        { obd: '52', bytes: 1, at: 0, factor: 100 / 255, offset: 0, min: 0, max: 100 },
    ],
    probe: [],
};

class EthanolReader {
    constructor(link, config) {
        this.cfg = Object.assign({}, DEFAULT, config || {});
        this.rd = new DidReader(link, { ecu: this.cfg.ecu });
        this.probeAt = 0;
        this.last = { value: null, source: '', bytes: '', why: 'not read yet', at: 0 };
        this.probes = [];       // [{ label, bytes, why }] raw replies of config.probe (never shown as the value)
    }

    /** One round: the first candidate with a plausible number, else why none did. */
    async poll() {
        const list = this.cfg.candidates || [];
        const v = await this.rd.value('ethanol', list);
        const now = Date.now();
        if (v !== null) {
            const i = this.rd.pick.ethanol || 0, c = list[i], raw = this.rd.raws[this.rd.key(c)];
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
