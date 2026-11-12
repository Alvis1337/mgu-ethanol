'use strict';
/**
 * debug.js - the Debug page: fires a list of READ-ONLY requests at the engine unit (and asks which units are on
 * the bus) and keeps every answer as it came, so you can see what this car's DME answers.
 *
 * Everything goes through the app's ReadOnlyDiag (kit/readonly-diag.js): UDS 22 (read data by identifier),
 * OBD 01 / 09 (current data / vehicle information) and 22 F1 50 to all units. Nothing is written or coded.
 *
 *   const dbg = new Debug(link, log, { ecu: 0x12, extra: config.probe, tap: tap.stats, car: () => car });
 *   (tap: what the transport said, tap.js; car(): { engine, tankL } from the car's own signals)
 *   dbg.run();          // in the background; dbg.rows fill in as answers arrive, dbg.running / dbg.done
 *
 * When the DME gives no reply to several requests in a row (asleep: ignition off), the rest of its requests are
 * skipped (each would wait timeoutMs and keep the transport busy) and the run goes on with the bus discovery.
 *
 * A row: { group, label, req, state: 'wait' | 'ok' | 'nrc' | 'none' | 'error' | 'info', text }
 */
const { hex, NRC } = require('./kit/diag');
const { withAlpha } = require('./kit/canvas');
const { tally } = require('./tap');

const pct = (b) => (b * 100 / 255).toFixed(1) + ' %';
const ascii = (bytes) => bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
const u16 = (b) => b[0] * 256 + b[1];

/** OBD supported-PID bitmap (PIDs base+1 .. base+0x20): which of the PIDs we care about are flagged. */
function supported(base, want) {
    return (b) => {
        if (b.length < 4) return 'short';
        const has = want.filter((p) => p > base && p <= base + 0x20).map((p) => {
            const i = p - base - 1;
            return hex(p) + (b[i >> 3] & (0x80 >> (i & 7)) ? ' yes' : ' no');
        });
        return 'PIDs ' + hex(base + 1) + '-' + hex(base + 0x20) + (has.length ? ': ' + has.join(', ') : '');
    };
}
const WANT = [0x0C, 0x2F, 0x51, 0x52];
const FUEL_TYPE = { 1: 'petrol', 2: 'methanol', 3: 'ethanol', 4: 'diesel', 5: 'LPG', 6: 'CNG', 8: 'electric', 9: 'bifuel petrol', 0x0A: 'bifuel methanol', 0x0B: 'bifuel ethanol', 0x11: 'hybrid petrol', 0x13: 'hybrid diesel' };

/*
 * The requests. did = UDS 22 identifier, obd = OBD service 01 PID, vin = OBD 09 PID. decode(data bytes after
 * the echo) -> text. The BMW identifiers and scalings are the DME8FF_R (B58 / S58 MG1) ones from the upstream
 * kit's Live Data catalog (github.com/cauliflowermossgrape/idrive7-apps, MIT); another DME may use other numbers,
 * which is what this page is for. F4xx = the OBD PID xx read through UDS (ISO 27145).
 */
const PROBES = [
    ['DME identity', 'VIN', { did: 0xF190, decode: ascii }],
    ['DME identity', 'SGBD index (DME type)', { did: 0xF150, decode: (b) => (b.length >= 3 ? hex(((b[0] << 16) | (b[1] << 8) | b[2]) >>> 0, 6) : 'short') }],
    ['Ethanol', 'BMW alcohol in fuel (550D)', { did: 0x550D, decode: (b) => pct(b[0]) + (b.length > 1 ? '  (2 bytes: ' + u16(b) + ')' : '') }],
    ['Ethanol', 'OBD 52 through UDS (F452)', { did: 0xF452, decode: (b) => pct(b[0]) }],
    ['Ethanol', 'OBD 01 PID 52', { obd: 0x52, decode: (b) => pct(b[0]) }],
    ['Ethanol', 'Fuel type, UDS (F451)', { did: 0xF451, decode: (b) => hex(b[0]) + ' ' + (FUEL_TYPE[b[0]] || '?') }],
    ['Ethanol', 'Fuel type, OBD 01 PID 51', { obd: 0x51, decode: (b) => hex(b[0]) + ' ' + (FUEL_TYPE[b[0]] || '?') }],
    ['Ethanol', 'Fuel quality adapted (5776)', { did: 0x5776, decode: (b) => (b[0] / 256).toFixed(3) + ' (0 = RON98, 1 = RON91)' }],
    ['Ethanol', 'Fuel + ethanol in oil (593A)', { did: 0x593A, decode: (b) => (u16(b) * 0.02133333).toFixed(1) + ' g' }],
    ['Tank', 'Tank level (583B)', { did: 0x583B, decode: (b) => b[0] + ' l' }],
    ['Tank', 'Left tank half (5949)', { did: 0x5949, decode: (b) => (b[0] * 0.5).toFixed(1) + ' l' }],
    ['Tank', 'Right tank half (594A)', { did: 0x594A, decode: (b) => (b[0] * 0.5).toFixed(1) + ' l' }],
    ['Tank', 'Fuel level, UDS (F42F)', { did: 0xF42F, decode: (b) => pct(b[0]) }],
    ['Tank', 'Fuel level, OBD 01 PID 2F', { obd: 0x2F, decode: (b) => pct(b[0]) }],
    ['Engine', 'RPM, UDS (F40C)', { did: 0xF40C, decode: (b) => (u16(b) / 4) + ' rpm' }],
    ['Engine', 'RPM, OBD 01 PID 0C', { obd: 0x0C, decode: (b) => (u16(b) / 4) + ' rpm' }],
    ['Engine', 'Coolant, OBD 01 PID 05', { obd: 0x05, decode: (b) => (b[0] - 40) + ' C' }],
    ['Engine', 'Fuel temperature (4AD5)', { did: 0x4AD5, decode: (b) => (b[0] * 0.75 - 48).toFixed(1) + ' C' }],
    ['Engine', 'Fuel flow (5656)', { did: 0x5656, decode: (b) => (u16(b) * 0.00119209).toFixed(2) + ' ml/s' }],
    ['Engine', 'Fuel mass flow (4521)', { did: 0x4521, decode: (b) => (u16(b) * 0.1).toFixed(1) + ' kg/h' }],
    ['Supported', 'UDS F400', { did: 0xF400, decode: supported(0x00, WANT) }],
    ['Supported', 'UDS F420', { did: 0xF420, decode: supported(0x20, WANT) }],
    ['Supported', 'UDS F440', { did: 0xF440, decode: supported(0x40, WANT) }],
    ['Supported', 'OBD 01 PID 00', { obd: 0x00, decode: supported(0x00, WANT) }],
    ['Supported', 'OBD 01 PID 20', { obd: 0x20, decode: supported(0x20, WANT) }],
    ['Supported', 'OBD 01 PID 40', { obd: 0x40, decode: supported(0x40, WANT) }],
    ['DME identity', 'VIN, OBD 09 PID 02', { vin: 0x02, decode: (b) => ascii(b.slice(1)) }],
];

/* SGBD index -> DME type, for the DME's F150 answer (the DME entries of the upstream kit's sgbd_index, MIT). */
const DME_TYPES = {
    '0F1090': 'MSD85L6', '0F10A0': 'D73N57A0', '0F1370': 'MSD87', '0F1380': 'MSD87_R0', '0F13E0': 'MSV90', '0F13F0': 'MEVD172',
    '0F1740': 'D72N47A0', '0F1780': 'MSD85YL6', '0F17F0': 'MEVD1725', '0F1810': 'MEVD1724', '0F1910': 'MEVD172Y',
    '0F19E0': 'EDMEI1', '0F1A10': 'S63TU_R0', '0F1A20': 'N63TU_R0', '0F1EA0': 'S55', '0F2220': 'N55_ALP', '0F28E0': 'DME9FF_R',
};
['0F1D20', '0F1D22', '0F1D24', '0F1D26'].forEach((k) => { DME_TYPES[k] = 'DME_BX8'; });
['0F2422', '0F2424', '0F2426', '0F2427', '0F2428', '0F2429', '0F242A', '0F242C', '0F242E', '0F2460', '0F25A0', '0F25A2',
    '0F26B4', '0F26B8', '0F26BC', '0F26E0', '0F26E4', '0F26E8', '0F2930'].forEach((k) => { DME_TYPES[k] = 'DME8FF_R (B58/S58 MG1)'; });

/** An error as a short row text: the transport's refusals without their long prefix. */
const errText = (e) => String(e && e.message || e).replace(/^transport refused: (APP_REQUEST_)?/, 'head unit refused: ');

const label = (p) => (p.did != null ? '22 ' + hex(p.did, 4) : p.obd != null ? '01 ' + hex(p.obd) : '09 ' + hex(p.vin));

class Debug {
    constructor(link, log, opts) {
        this.link = link;
        this.log = log;
        this.ecu = (opts && opts.ecu) || 0x12;
        this.timeoutMs = (opts && opts.timeoutMs) || 3000;
        this.giveUpAfter = (opts && opts.giveUpAfter) || 4;     // no replies in a row before the DME is skipped
        this.tap = (opts && opts.tap) || null;
        this.car = (opts && opts.car) || (() => ({}));
        this.discoverOpts = (opts && opts.discover) || { idleMs: 3000, maxMs: 15000 };
        const extra = ((opts && opts.extra) || []).filter((c) => c && c.did).map((c) => ['Your probes', 'config.probe ' + c.did, { did: parseInt(c.did, 16), decode: (b) => b.length + ' bytes' }]);
        this.probes = PROBES.concat(extra);
        this.rows = [];
        this.running = false;
        this.done = 0;
        this.startedAt = 0;
        this.endedAt = 0;
    }

    /** steps of a run: every request, then the bus discovery */
    get total() { return this.probes.length + 1; }

    /** The link's own state, as a row. */
    linkRow() {
        const l = this.link, yes = (b) => (b ? 'yes' : 'no');
        const text = 'ready ' + yes(l.ready) + ', available ' + yes(l.available) + (l.error ? ', ' + l.error : '');
        return { group: 'Link', label: 'Diagnostic link', req: '', state: l.ready ? 'info' : 'error', text };
    }

    /** The engine and the fuel level as the car's own signals give them (no diagnostic request). */
    carRows() {
        const c = this.car() || {};
        const eng = c.engine == null ? 'no signal yet' : c.engine;
        return [
            { group: 'Car', label: 'Engine (car signal)', req: 'CDS', state: c.engine === 'running' ? 'ok' : c.engine == null ? 'none' : 'error',
                text: eng + (c.engine === 'running' ? '' : c.engine == null ? '' : ': the DME may not answer') },
            { group: 'Car', label: 'Fuel level (cluster)', req: 'KombiIF', state: c.tankL == null ? 'none' : 'ok',
                text: c.tankL == null ? 'no signal yet' : c.tankL + ' l' },
        ];
    }

    /** What the transport said since the app started (tap.js), as rows. */
    transportRows() {
        const t = this.tap;
        if (!t) return [];
        const rows = [
            { label: 'Head unit took', text: t.requests + ' requests: ' + tally(t.verdicts) + (Object.keys(t.callErrors).length ? ' | call errors: ' + tally(t.callErrors) : '') },
            { label: 'Responses heard', text: t.responses + (t.responses ? ': ' + (Object.keys(t.frames).length ? 'from ' + tally(t.frames) : 'no replies from a unit') : ' - nothing came back from the head unit') },
            { label: 'Transport errors', text: tally(t.errors) },
            { label: 'Transport rejects', text: tally(t.rejects) + (t.short ? ', short frames ' + t.short : '') },
        ].concat(t.last.map((x, i) => ({ label: 'Response -' + (t.last.length - i), text: x.kind + ': ' + x.bytes })));
        if (t.firstVerdict) rows.push({ label: 'First verdict (raw)', text: t.firstVerdict });
        return rows.map((r) => Object.assign({ group: 'Transport', req: 'TASU', state: 'info' }, r));
    }

    /** What the link has counted since the app started, as a row. */
    statsRow() {
        const l = this.link, s = l.stats || {};
        const text = 'sent ' + (s.sent || 0) + ', replies ' + (s.replies || 0) + ', missed ' + (s.missed || 0) + ', busy ' + (l.busy || 0);
        return { group: 'Link', label: 'Requests so far', req: '', state: 'info', text };
    }

    /** One request: the row with what came back. */
    async probe(p) {
        const row = { group: p[0], label: p[1], req: label(p[2]), state: 'wait', text: '...' };
        this.rows.push(row);
        const c = p[2], ecu = this.ecu;
        let sid, data, ok;
        if (c.did != null) { sid = 0x22; data = [c.did >> 8, c.did & 0xFF]; ok = (u) => u[0] === 0x62 && ((u[1] << 8) | u[2]) === c.did; }
        else if (c.obd != null) { sid = 0x01; data = [c.obd]; ok = (u) => u[0] === 0x41 && u[1] === c.obd; }
        else { sid = 0x09; data = [c.vin]; ok = (u) => u[0] === 0x49 && u[1] === c.vin; }
        const accept = (u) => ok(u) || (u[0] === 0x7F && u[1] === sid);
        if (typeof this.link.wake === 'function') this.link.wake(ecu);      // the debug run asks every time
        const t0 = Date.now();
        let uds;
        try { uds = await this.link.physical(ecu, sid, data, this.timeoutMs, accept); } catch (e) {
            row.state = 'error'; row.text = errText(e); return row;
        }
        const ms = Date.now() - t0;
        if (!uds) { row.state = 'none'; row.text = 'no reply (' + ms + ' ms)'; return row; }
        const bytes = uds.map((x) => hex(x)).join(' ');
        if (uds[0] === 0x7F) { row.state = 'nrc'; row.text = 'NRC ' + hex(uds[2]) + (NRC[uds[2]] ? ' ' + NRC[uds[2]] : ''); return row; }
        const body = uds.slice(sid === 0x22 ? 3 : 2);
        let dec;
        try { dec = body.length ? c.decode(body) : 'empty'; } catch (e) { dec = 'decode: ' + (e && e.message || e); }
        row.state = 'ok';
        row.text = dec + '  [' + (bytes.length > 26 ? bytes.slice(0, 24) + '..' : bytes) + ']';
        row.bytes = bytes;
        return row;
    }

    /** 22 F1 50 to all units: which units answer, and the DME's type. */
    async discover() {
        const row = { group: 'Bus', label: 'Units answering 22 F150', req: '22 F150 all', state: 'wait', text: 'asking (up to 15 s)...' };
        this.rows.push(row);
        if (typeof this.link.discover !== 'function') { row.state = 'error'; row.text = 'link cannot discover'; return row; }
        let units;
        try { units = await this.link.discover(this.discoverOpts); } catch (e) { row.state = 'error'; row.text = errText(e); return row; }
        if (!units || !units.size) { row.state = 'none'; row.text = 'no unit answered'; return row; }
        const addrs = Array.from(units.keys()).sort((a, b) => a - b);
        const dme = units.get(this.ecu);
        row.state = 'ok';
        row.text = addrs.length + ' units; DME ' + hex(this.ecu) + (units.has(this.ecu) ? ' ' + (dme || 'refused') + (DME_TYPES[dme] ? ' = ' + DME_TYPES[dme] : '') : ' NOT among them');
        row.all = addrs.map((a) => hex(a) + (units.get(a) ? ':' + units.get(a) : '')).join(' ');
        // every unit with its SGBD index, five to a row
        for (let i = 0; i < addrs.length; i += 5) {
            this.rows.push({ group: 'Bus', label: 'units ' + (i + 1) + '-' + Math.min(addrs.length, i + 5), req: '', state: 'info',
                text: addrs.slice(i, i + 5).map((a) => hex(a) + (units.get(a) ? ':' + units.get(a) : '')).join(' ') });
        }
        return row;
    }

    /** Run every request once, in turn (in the background: rows fill in). Resolves with the rows. */
    async run() {
        if (this.running) return this.rows;
        this.running = true;
        this.rows = [];
        this.done = 0;
        this.startedAt = Date.now();
        this.endedAt = 0;
        try {
            const lr = this.linkRow();
            this.rows.push(lr);
            this.carRows().forEach((r) => { this.rows.push(r); this.log.info('debug ' + r.label + ': ' + r.text); });
            if (!this.link.ready) {
                lr.state = 'error';
                lr.text = 'diagnostic link not ready' + (this.link.error ? ': ' + this.link.error : '') + ' - nothing sent';
                this.transportRows().forEach((r) => this.rows.push(r));
                return this.rows;
            }
            let silentRun = 0;
            for (let i = 0; i < this.probes.length; i++) {
                const r = await this.probe(this.probes[i]);
                this.done++;
                this.log.info('debug ' + r.req + ' ' + r.label + ': ' + r.text);
                silentRun = r.state === 'none' ? silentRun + 1 : 0;
                if (silentRun >= this.giveUpAfter && i < this.probes.length - 1) {
                    const left = this.probes.length - 1 - i;
                    this.rows.push({ group: 'DME', label: 'Skipped ' + left + ' requests', req: '', state: 'error',
                        text: 'DME gave no reply ' + silentRun + ' times in a row' + ((this.car() || {}).engine === 'running' ? ' with the engine running: see Transport' : ': engine off / asleep?') });
                    this.log.info('debug: DME silent ' + silentRun + ' times in a row, ' + left + ' requests skipped');
                    this.done += left;
                    break;
                }
            }
            const d = await this.discover();
            this.done++;
            this.log.info('debug ' + d.label + ': ' + d.text + (d.all ? ' | ' + d.all : ''));
            const end = this.statsRow();
            this.rows.push(end);
            this.log.info('debug link: ' + this.linkRow().text + ' | ' + end.text);
            this.transportRows().forEach((r) => { this.rows.push(r); this.log.info('debug ' + r.label + ': ' + r.text); });
        } finally {
            this.running = false;
            this.endedAt = Date.now();
        }
        return this.rows;
    }
}

/** Text cut to fit maxW (with '..'), drawn as is (no translation lookup). Returns its width. */
function fitText(cv, str, x, y, size, color, maxW, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    let s = String(str);
    if (cv.textWidth(s, size, o) > maxW) {
        while (s.length > 1 && cv.textWidth(s + '..', size, o) > maxW) s = s.slice(0, -1);
        s += '..';
    }
    return cv.text(s, x, y, size, color, o);
}

const GO = '#2fd27a';
const PER_COL = 17;

/** The Debug page's content (under the page's tab bar): two columns of 17 rows (request, what it reads, the answer). */
function drawDebug(cv, t, dbg, pageNo) {
    const W = cv.w;
    const rows = dbg.rows.length ? dbg.rows : [dbg.linkRow()];
    const perPage = PER_COL * 2, pages = Math.max(1, Math.ceil(rows.length / perPage)), page = (pageNo || 0) % pages;
    const head = dbg.running ? 'Running ' + dbg.done + ' / ' + dbg.total + ' ...'
        : dbg.endedAt ? 'Done in ' + Math.round((dbg.endedAt - dbg.startedAt) / 1000) + ' s. Take a photo of each page.'
            : 'Start the engine, then press Run all requests. Read-only: nothing is written.';
    fitText(cv, head, 24, 74, 20, dbg.running ? t.accent : t.text, W - 260, { font: 'bold' });
    cv.text('Page ' + (page + 1) + ' / ' + pages, W - 24, 74, 20, t.dim, { align: 'right', font: 'bold', literal: true });
    const colW = Math.floor((W - 72) / 2);
    rows.slice(page * perPage, (page + 1) * perPage).forEach((r, k) => {
        const x = 24 + (k >= PER_COL ? colW + 24 : 0), y = 106 + (k % PER_COL) * 24;
        if (k % 2 === 1) cv.fillRect(x - 4, y - 18, colW + 8, 24, withAlpha('#ffffff', 0.04));
        const c = r.state === 'ok' ? GO : r.state === 'nrc' || r.state === 'error' ? t.warn : r.state === 'none' || r.state === 'wait' ? t.dim : t.text;
        fitText(cv, r.req, x, y, 17, t.dim, 96);
        fitText(cv, r.label, x + 100, y, 17, t.text, 250);
        fitText(cv, r.text, x + 358, y, 17, c, colW - 358);
    });
    return cv;
}

module.exports = { Debug, PROBES, DME_TYPES, drawDebug, fitText };
