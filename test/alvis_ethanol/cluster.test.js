'use strict';
/* alvis_ethanol: the cluster scan against a fake cluster (Node 8, run by test/run.js) */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { ClusterScan, matches, present, TRIGGER, RESULT, STOP } = require(path.join(root, 'apps', 'alvis_ethanol', 'cluster.js'));
const { check } = require(path.join(root, 'kit', 'runtime', 'readonly-diag.js'));

const log = { info() {}, warn() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));

/**
 * fake cluster: answers[did] = data bytes. A request for several identifiers gets 62 with each one it has (in request
 * order), or NRC 31 when it has none; refuseMixed = a cluster that refuses any request of more than one identifier;
 * silentOutside = no reply at all outside 0xD000..0xD0FF
 */
const fake = (answers, opts) => ({
    asked: [],
    wake() {},
    physical(target, sid, data) {
        assert.strictEqual(sid, 0x22);
        check(target, sid, data, false);                       // only a read leaves the head unit
        const dids = [];
        for (let i = 0; i < data.length; i += 2) dids.push((data[i] << 8) | data[i + 1]);
        this.asked.push(dids);
        if (dids.length > 1 && opts && opts.refuseMixed) return Promise.resolve([0x7F, 0x22, 0x31]);
        const out = [0x62];
        dids.forEach((d) => { if (answers[d]) out.push((d >> 8) & 0xFF, d & 0xFF, ...answers[d]); });
        if (out.length > 1) return Promise.resolve(out);
        if (opts && opts.silentOutside && !(dids[0] >= 0xD000 && dids[0] <= 0xD0FF)) return Promise.resolve(null);
        return Promise.resolve([0x7F, 0x22, 0x31]);
    },
});
const count = (link) => link.asked.reduce((n, d) => n + d.length, 0);

module.exports = [
    ['matches: 43 % as a byte, as 0..255, as half steps, as tenths', () => {
        assert.deepStrictEqual(matches([0x6D], 43, 0.6), ['byte0 x100/255']);        // 109 / 255 = 42.7
        assert.ok(matches([43], 43, 0.6).indexOf('byte0') >= 0);
        assert.ok(matches([86], 43, 0.6).indexOf('byte0 /2') >= 0);
        assert.ok(matches([0x01, 0xAE], 43, 0.6).indexOf('u16be@0 /10') >= 0);       // 430
        assert.deepStrictEqual(matches([0, 7], 43, 0.6), []);
    }],
    ['a scan flags the identifier that reads as the target and keeps the others', async () => {
        const dir = tmp();
        const link = fake({ 0xD00A: [0x6D], 0xD00B: [0x00, 0x07] });
        const s = new ClusterScan(link, log, { dir });
        const state = await s.run({ target: 43, batch: false, ranges: [[0xD000, 0xD0FF]] });
        assert.strictEqual(state, 'done');
        assert.strictEqual(link.asked.length, 256);
        assert.strictEqual(s.hits.length, 2);
        assert.strictEqual(s.flagged.length, 1);
        assert.strictEqual(s.flagged[0].did, 'D00A');
        const res = JSON.parse(fs.readFileSync(path.join(dir, RESULT), 'utf8'));
        assert.strictEqual(res.state, 'done');
        assert.strictEqual(res.flagged[0].data, '6D');
    }],
    ['a cluster that stops answering ends the scan', async () => {
        const link = fake({}, { silentOutside: true });
        const s = new ClusterScan(link, log, { dir: tmp(), giveUpAfter: 3 });
        const state = await s.run({ target: 43, batch: false, ranges: [[0x0100, 0x01FF]] });
        assert.ok(/stopped answering/.test(state), state);
        assert.strictEqual(link.asked.length, 3);
    }],
    ['poll: the trigger file starts a scan and is removed first', async () => {
        const dir = tmp();
        const link = fake({ 0xD001: [43], 0xF190: [0x35, 0x55] });
        const s = new ClusterScan(link, log, { dir });
        assert.strictEqual(await s.poll(), false);
        fs.writeFileSync(path.join(dir, TRIGGER), JSON.stringify({ target: 43, ranges: [[0xD000, 0xD00F]] }));
        assert.strictEqual(await s.poll(), true);
        assert.ok(!fs.existsSync(path.join(dir, TRIGGER)));
        assert.strictEqual(s.flagged.length, 1);
        assert.strictEqual(await s.poll(), false);
    }],
    ['present: the identifiers a batch reply holds', () => {
        assert.deepStrictEqual(present([0x62, 0xD1, 0x25, 0x04, 0x6D, 0xD1, 0x27, 0x07], [0xD125, 0xD126, 0xD127]), [0xD125, 0xD127]);
        assert.deepStrictEqual(present([0x7F, 0x22, 0x31], [0xD125]), []);
    }],
    ['batches of 8: far fewer requests, the same answers (exact data from single reads)', async () => {
        const answers = { 0xF190: [0x35, 0x55], 0xD00A: [0x6D], 0xD00B: [0x00, 0x07], 0xD0F0: [43] };
        const single = fake(answers), batched = fake(answers);
        const a = new ClusterScan(single, log, { dir: tmp() }), b = new ClusterScan(batched, log, { dir: tmp() });
        await a.run({ target: 43, batch: false, ranges: [[0xD000, 0xD0FF]] });
        const state = await b.run({ target: 43, ranges: [[0xD000, 0xD0FF]] });
        assert.strictEqual(state, 'done');
        assert.deepStrictEqual(b.hits, a.hits);
        assert.deepStrictEqual(b.flagged, a.flagged);
        assert.strictEqual(b.hits.length, 3);
        assert.ok(batched.asked.length < 60, 'requests: ' + batched.asked.length);          // 1 calibration + 32 batches + 3 single reads
        assert.ok(batched.asked.every((d) => d.length <= 8));
    }],
    ['a cluster that refuses mixed batches is scanned one identifier at a time', async () => {
        const link = fake({ 0xF190: [0x35], 0xD00A: [0x6D] }, { refuseMixed: true });
        const s = new ClusterScan(link, log, { dir: tmp() });
        const state = await s.run({ target: 43, ranges: [[0xD000, 0xD03F]] });
        assert.strictEqual(state, 'done');
        assert.strictEqual(s.hits.length, 1);
        assert.strictEqual(s.flagged[0].did, 'D00A');
        assert.strictEqual(link.asked.filter((d) => d.length === 1).length, 64);
    }],
    ['the stop file ends a scan', async () => {
        const dir = tmp();
        const link = fake({ 0xF190: [0x35] });
        const s = new ClusterScan(link, log, { dir });
        const inner = link.physical;
        link.physical = function () {                                          // the file appears while the scan runs
            if (this.asked.length === 20) fs.writeFileSync(path.join(dir, STOP), '');
            return inner.apply(this, arguments);
        };
        const run = s.run({ target: 43, ranges: [[0x4000, 0x5FFF]] });
        const state = await run;
        assert.strictEqual(state, 'stopped');
        assert.ok(count(link) < 8192);
    }],
];
