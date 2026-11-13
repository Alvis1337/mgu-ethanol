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

    /** Walk the ranges; every positive answer is kept, the ones that read as the target are flagged and logged. */
    async run(req) {
        req = req || {};
        const ecu = req.ecu != null ? req.ecu : 0x60, target = Number(req.target), tol = req.tol != null ? Number(req.tol) : 0.6;
        const ranges = Array.isArray(req.ranges) && req.ranges.length ? req.ranges : RANGES;
        this.running = true; this.stop = false;
        this.hits = []; this.flagged = [];
        this.progress = { did: 0, asked: 0, answered: 0, refused: 0, silent: 0 };
        this.log.info('cluster scan: started, unit ' + hex(ecu) + ', target ' + target + ' %, ' + ranges.length + ' ranges');
        let state = 'done', misses = 0, lastSave = Date.now();
        try {
            outer:
            for (const r of ranges) {
                for (let did = r[0]; did <= r[1]; did++) {
                    if (this.stop) { state = 'stopped'; break outer; }
                    if (typeof this.link.wake === 'function') this.link.wake(ecu);
                    let uds;
                    const want = did;
                    try {
                        uds = await this.link.physical(ecu, 0x22, [(did >> 8) & 0xFF, did & 0xFF], this.timeoutMs,
                            (u) => (u[0] === 0x62 && ((u[1] << 8) | u[2]) === want) || (u[0] === 0x7F && u[1] === 0x22));
                    } catch (e) { uds = null; }
                    const p = this.progress;
                    p.did = did; p.asked++;
                    if (uds === undefined) { state = 'cancelled'; break outer; }
                    if (!uds) {
                        p.silent++; misses++;
                        if (misses >= this.giveUpAfter) { state = 'cluster stopped answering at ' + hex(did, 4); break outer; }
                        await sleep(200);
                        continue;
                    }
                    misses = 0;
                    if (uds[0] === 0x62 && uds.length > 3) {
                        p.answered++;
                        const data = uds.slice(3);
                        const hit = { did: hex(did, 4), data: data.map((b) => hex(b)).join(' ') };
                        this.hits.push(hit);
                        if (Number.isFinite(target)) {
                            const m = matches(data, target, tol);
                            if (m.length) { hit.reads = m; this.flagged.push(hit); this.log.info('cluster scan: ' + hit.did + ' = ' + hit.data + ' reads as ' + target + ' %: ' + m.join(', ')); }
                        }
                    } else p.refused++;
                    if (Date.now() - lastSave > 5000) { lastSave = Date.now(); this.save('running', req); }
                    if (p.asked % 2048 === 0) this.log.info('cluster scan: at ' + hex(did, 4) + ', ' + p.answered + ' answers, ' + this.flagged.length + ' flagged');
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

module.exports = { ClusterScan, matches, readings, TRIGGER, RESULT, RANGES };
