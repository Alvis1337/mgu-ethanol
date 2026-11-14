'use strict';
/**
 * cluster.js - find where the instrument cluster (KOMBI, 0x60) keeps the ethanol content, READ ONLY.
 *
 * On a car where the head unit cannot reach the DME (every request answered 7F 31 25, "no response from subnet
 * component") the cluster still answers, and it shows the E% itself (hold BC: the MHD flex fuel kit's value reaches
 * it from the DME). So the cluster is the one unit the head unit can ask. Which identifier holds the number is not
 * known: this walks the cluster's UDS 22 identifiers (through the app's read-only link, which refuses everything but
 * reads) and flags every answer whose bytes read as the E% you tell it (the one the cluster shows now) under a
 * plausible scaling.
 *
 * Started by a file in the app's data folder, so it needs no screen:
 *   cluster-scan.json   { "target": 43, "ecu": 96, "ranges": [[0xD000, 0xDFFF], ...], "tol": 0.6 }
 * Results: cluster-scan-result.json (rewritten as it goes), and a log line per flagged answer.
 *
 *   const s = new ClusterScan(link, log, { dir: ctx.dataDir });
 *   s.poll();                 // looks for the trigger file; runs a scan when there is one
 */
const fs = require('fs');
const path = require('path');

const TRIGGER = 'cluster-scan.json';
const RESULT = 'cluster-scan-result.json';
const STOP = 'cluster-scan-stop';
const BATCH = 8;                      // identifiers in one request (readonly-diag allows 8)
// F190 (the VIN: every unit has it) among seven the cluster does not have: a batch that still answers F190 works
const CALIBRATION = [0xF190, 0xD100, 0xD101, 0xD102, 0xD103, 0xD104, 0xD105, 0xD108];

// the order the identifiers are walked in: where BMW units keep live values first, the rest after
const RANGES = [[0xF100, 0xF4FF], [0xD000, 0xDFFF], [0x4000, 0x5FFF], [0x1000, 0x1FFF], [0x0100, 0x0FFF], [0x2000, 0x3FFF], [0x6000, 0xCFFF], [0xE000, 0xF0FF], [0xF500, 0xFFFF]];

const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');

/**
 * Every way the data bytes can read as a percentage, as { how, pct }: one byte as 0..255 = 0..100 %, as the number
 * itself, as half steps; two bytes (big and little endian) as the number, tenths, hundredths, or 0..65535 = 0..100 %.
 */
function readings(data) {
    const out = [];
    for (let i = 0; i < data.length && i < 16; i++) {
        const b = data[i];
        out.push({ how: 'byte' + i + ' x100/255', pct: b * 100 / 255 }, { how: 'byte' + i, pct: b }, { how: 'byte' + i + ' /2', pct: b / 2 });
    }
    for (let i = 0; i + 1 < data.length && i < 16; i++) {
        const be = data[i] * 256 + data[i + 1], le = data[i + 1] * 256 + data[i];
        [['be', be], ['le', le]].forEach((p) => {
            out.push({ how: 'u16' + p[0] + '@' + i, pct: p[1] }, { how: 'u16' + p[0] + '@' + i + ' /10', pct: p[1] / 10 },
                { how: 'u16' + p[0] + '@' + i + ' /100', pct: p[1] / 100 }, { how: 'u16' + p[0] + '@' + i + ' x100/65535', pct: p[1] * 100 / 65535 });
        });
    }
    return out;
}

/** The readings of data that come out as target % (within tol), e.g. ['byte0 x100/255', 'byte2']. */
function matches(data, target, tol) {
    const seen = {}, out = [];
    readings(data).forEach((r) => { if (Math.abs(r.pct - target) <= tol && !seen[r.how]) { seen[r.how] = 1; out.push(r.how); } });
    return out;
}

/** Which of dids the positive reply 62 <DID> <data> ... holds (their two bytes appear after the service byte). */
function present(uds, dids) {
    return dids.filter((d) => {
        for (let i = 1; i + 1 < uds.length; i++) if (uds[i] === ((d >> 8) & 0xFF) && uds[i + 1] === (d & 0xFF)) return true;
        return false;
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ClusterScan {
    constructor(link, log, opts) {
        this.link = link;
        this.log = log;
        this.dir = (opts && opts.dir) || '.';
        this.timeoutMs = (opts && opts.timeoutMs) || 1500;
        this.giveUpAfter = (opts && opts.giveUpAfter) || 20;      // no answers in a row before the scan stops
        this.running = false;
        this.stop = false;
        this.progress = { did: 0, asked: 0, answered: 0, refused: 0, silent: 0 };
        this.hits = [];
        this.flagged = [];
    }

    get file() { return path.join(this.dir, TRIGGER); }
    get resultFile() { return path.join(this.dir, RESULT); }

    /** Run a scan when the trigger file is there (it is removed first, so a crash cannot loop). */
    async poll() {
        if (this.running) return false;
        let txt;
        try { txt = fs.readFileSync(this.file, 'utf8'); } catch (e) { return false; }
        try { fs.unlinkSync(this.file); } catch (e) { /* read-only folder: the scan would repeat, so stop here */ this.log.warn('cluster scan: cannot remove ' + this.file); return false; }
        let req;
        try { req = JSON.parse(txt || '{}'); } catch (e) { this.log.warn('cluster scan: ' + TRIGGER + ' is not JSON'); return false; }
        await this.run(req);
        return true;
    }

    save(state, req) {
        const body = { state, request: req, at: new Date().toISOString(), progress: this.progress, flagged: this.flagged, hits: this.hits };
        try { fs.writeFileSync(this.resultFile, JSON.stringify(body)); } catch (e) { this.log.warn('cluster scan: result not saved: ' + (e && e.message || e)); }
    }

    /** One request for these identifiers (1 to 8): the reply, null (no answer) or undefined (cancelled). */
    async ask(ecu, dids) {
        const data = [];
        dids.forEach((d) => data.push((d >> 8) & 0xFF, d & 0xFF));
        try {
            return await this.link.physical(ecu, 0x22, data, this.timeoutMs,
                (u) => (u[0] === 0x62 && dids.indexOf((u[1] << 8) | u[2]) >= 0) || (u[0] === 0x7F && u[1] === 0x22));
        } catch (e) { return null; }
    }

    /** Does this cluster answer a batch with the identifiers it has (and refuse only when it has none)? */
    async calibrate(ecu) {
        const uds = await this.ask(ecu, CALIBRATION);
        const ok = !!uds && uds[0] === 0x62 && present(uds, CALIBRATION).indexOf(0xF190) >= 0;
        this.log.info('cluster scan: batches of ' + CALIBRATION.length + ' ' + (ok ? 'work' : 'are refused (' + (uds ? uds.map((b) => hex(b)).join(' ') : 'no answer') + '): one identifier at a time'));
        return ok;
    }

    stopFile() { return path.join(this.dir, STOP); }

    /** Keep one answered identifier, and flag it when it reads as the target. */
    keep(did, data, target, tol) {
        const hit = { did: hex(did, 4), data: data.map((b) => hex(b)).join(' ') };
        this.hits.push(hit);
        this.progress.answered++;
        if (Number.isFinite(target)) {
            const m = matches(data, target, tol);
            if (m.length) { hit.reads = m; this.flagged.push(hit); this.log.info('cluster scan: ' + hit.did + ' = ' + hit.data + ' reads as ' + target + ' %: ' + m.join(', ')); }
        }
    }

    /**
     * Walk the ranges. With batch (the default, when the cluster passes calibrate()) 8 identifiers go in one request:
     * the reply names the ones the cluster has, which are then read one by one for their exact data. Every positive
     * answer is kept, the ones that read as the target are flagged and logged.
     */
    async run(req) {
        req = req || {};
        const ecu = req.ecu != null ? req.ecu : 0x60, target = Number(req.target), tol = req.tol != null ? Number(req.tol) : 0.6;
        const ranges = Array.isArray(req.ranges) && req.ranges.length ? req.ranges : RANGES;
        this.running = true; this.stop = false;
        this.hits = []; this.flagged = [];
        this.progress = { did: 0, asked: 0, answered: 0, refused: 0, silent: 0 };
        this.log.info('cluster scan: started, unit ' + hex(ecu) + ', target ' + target + ' %, ' + ranges.length + ' ranges');
        let state = 'done', misses = 0, lastSave = Date.now(), lastLog = 0, n = 0;
        try {
            try { fs.unlinkSync(this.stopFile()); } catch (e) { /* none */ }
            if (typeof this.link.wake === 'function') this.link.wake(ecu);
            const batch = req.batch === false ? false : await this.calibrate(ecu);
            const size = batch ? BATCH : 1;
            outer:
            for (const r of ranges) {
                for (let from = r[0]; from <= r[1]; from += size) {
                    if (this.stop || (++n % 8 === 0 && fs.existsSync(this.stopFile()))) { state = 'stopped'; break outer; }
                    const dids = [];
                    for (let d = from; d < from + size && d <= r[1]; d++) dids.push(d);
                    if (typeof this.link.wake === 'function') this.link.wake(ecu);
                    const uds = await this.ask(ecu, dids);
                    const p = this.progress;
                    p.did = dids[dids.length - 1]; p.asked += dids.length;
                    if (uds === undefined) { state = 'cancelled'; break outer; }
                    if (!uds) {
                        p.silent++; misses++;
                        if (misses >= this.giveUpAfter) { state = 'cluster stopped answering at ' + hex(dids[0], 4); break outer; }
                        await sleep(200);
                        continue;
                    }
                    misses = 0;
                    if (uds[0] === 0x62) {
                        // a batch's reply only says which identifiers it holds; their exact data comes from single reads
                        const have = dids.length === 1 ? dids : present(uds, dids);
                        p.refused += dids.length - have.length;
                        for (const d of have) {
                            const one = dids.length === 1 ? uds : await this.ask(ecu, [d]);
                            if (one && one[0] === 0x62 && one.length > 3) this.keep(d, one.slice(3), target, tol);
                            else p.refused++;
                        }
                    } else p.refused += dids.length;
                    if (Date.now() - lastSave > 5000) { lastSave = Date.now(); this.save('running', req); }
                    if (p.asked - lastLog >= 2048) { lastLog = p.asked; this.log.info('cluster scan: at ' + hex(p.did, 4) + ', ' + p.answered + ' answers, ' + this.flagged.length + ' flagged'); }
                }
            }
        } catch (e) {
            state = 'error: ' + (e && e.message || e);
            this.log.warn('cluster scan: ' + state);
        }
        this.running = false;
        this.save(state, req);
        this.log.info('cluster scan: ' + state + ', ' + this.progress.asked + ' asked, ' + this.progress.answered + ' answers, ' + this.flagged.length + ' flagged');
        return state;
    }
}

module.exports = { ClusterScan, matches, readings, present, TRIGGER, RESULT, STOP, RANGES };
