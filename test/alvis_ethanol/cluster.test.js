'use strict';
/* alvis_ethanol: the cluster scan against a fake cluster (Node 8, run by test/run.js) */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { ClusterScan, matches, TRIGGER, RESULT } = require(path.join(root, 'apps', 'alvis_ethanol', 'cluster.js'));
const { check } = require(path.join(root, 'kit', 'runtime', 'readonly-diag.js'));

const log = { info() {}, warn() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));

/** fake link: answers[did] = data bytes (positive), anything else in 0xD000..0xD0FF = NRC 31, outside = no answer */
const fake = (answers, silentOutside) => ({
    asked: [],
    wake() {},
    physical(target, sid, data) {
        assert.strictEqual(sid, 0x22);
        check(target, sid, data, false);                       // only a read leaves the head unit
        const did = (data[0] << 8) | data[1];
        this.asked.push(did);
        if (answers[did]) return Promise.resolve([0x62, data[0], data[1]].concat(answers[did]));
        if (did >= 0xD000 && did <= 0xD0FF) return Promise.resolve([0x7F, 0x22, 0x31]);
        return Promise.resolve(silentOutside ? null : [0x7F, 0x22, 0x31]);
    },
});

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
        const state = await s.run({ target: 43, ranges: [[0xD000, 0xD0FF]] });
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
        const link = fake({}, true);
        const s = new ClusterScan(link, log, { dir: tmp(), giveUpAfter: 3 });
        const state = await s.run({ target: 43, ranges: [[0x0100, 0x01FF]] });
        assert.ok(/stopped answering/.test(state), state);
        assert.strictEqual(link.asked.length, 3);
    }],
    ['poll: the trigger file starts a scan and is removed first', async () => {
        const dir = tmp();
        const link = fake({ 0xD001: [43] });
        const s = new ClusterScan(link, log, { dir });
        assert.strictEqual(await s.poll(), false);
        fs.writeFileSync(path.join(dir, TRIGGER), JSON.stringify({ target: 43, ranges: [[0xD000, 0xD00F]] }));
        assert.strictEqual(await s.poll(), true);
        assert.ok(!fs.existsSync(path.join(dir, TRIGGER)));
        assert.strictEqual(s.flagged.length, 1);
        assert.strictEqual(await s.poll(), false);
    }],
];
