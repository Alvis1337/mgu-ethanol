'use strict';
/* alvis_ethanol: the reader against a fake engine unit (Node 8, run by test/run.js) */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
// the app requires './kit/...' (kit/runtime once built): point that at kit/runtime for the test
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent) {
    const args = Array.prototype.slice.call(arguments);
    if (typeof req === 'string' && req.indexOf('./kit/') === 0) args[0] = path.join(root, 'kit', 'runtime', req.slice(6));
    return orig.apply(this, args);
};
const Reader = require(path.join(root, 'apps', 'alvis_ethanol', 'reader.js'));
const { check } = require(path.join(root, 'kit', 'runtime', 'readonly-diag.js'));
const cfg = require(path.join(root, 'apps', 'alvis_ethanol', 'app.json')).config;

/** fake link: replies[key] = bytes | undefined (= no answer); key = 'sid:hexdata' */
const fake = (replies) => ({
    calls: [],
    physical(target, sid, data) {
        const key = sid.toString(16) + ':' + data.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
        this.calls.push({ target, sid, data: data.slice() });
        return Promise.resolve(replies[key] || null);
    },
});

module.exports = [
    ['PID 52 through UDS F452: 0x66 = 40 %', async () => {
        const s = await new Reader(fake({ '22:f452': [0x62, 0xF4, 0x52, 0x66] }), cfg).poll();
        assert.strictEqual(Math.round(s.value), 40);
        assert.strictEqual(s.source, 'F452');
        assert.strictEqual(s.bytes, '62 F4 52 66');
    }],
    ['falls back to OBD service 01 when F452 is refused (NRC 31)', async () => {
        const s = await new Reader(fake({ '22:f452': [0x7F, 0x22, 0x31], '1:52': [0x41, 0x52, 0x80] }), cfg).poll();
        assert.strictEqual(Math.round(s.value), 50);
        assert.strictEqual(s.source, 'OBD 52');
    }],
    ['E0 and E100 are valid (0x00 and 0xFF)', async () => {
        assert.strictEqual((await new Reader(fake({ '22:f452': [0x62, 0xF4, 0x52, 0x00] }), cfg).poll()).value, 0);
        assert.strictEqual(Math.round((await new Reader(fake({ '22:f452': [0x62, 0xF4, 0x52, 0xFF] }), cfg).poll()).value), 100);
    }],
    ['no answer: value null, with the reasons', async () => {
        const s = await new Reader(fake({ '22:f452': [0x7F, 0x22, 0x31] }), cfg).poll();
        assert.strictEqual(s.value, null);
        assert.ok(/F452 NRC 31/.test(s.why), s.why);
        assert.ok(/OBD 52 no reply/.test(s.why), s.why);
    }],
    ['probe 550D is read but never becomes the value', async () => {
        const r = new Reader(fake({ '22:550d': [0x62, 0x55, 0x0D, 0x01, 0x90] }), cfg);
        assert.strictEqual((await r.poll()).value, null);
        const p = await r.probe(true);
        assert.strictEqual(p[0].label, '550D');
        assert.strictEqual(p[0].bytes, '62 55 0D 01 90');
    }],
    ['every request goes to the DME and passes the read-only check', async () => {
        const link = fake({});
        const r = new Reader(link, cfg);
        await r.poll(); await r.probe(true);
        assert.ok(link.calls.length >= 3);
        link.calls.forEach((c) => { check(c.target, c.sid, c.data, false); assert.strictEqual(c.target, 0x12); });
    }],
];
