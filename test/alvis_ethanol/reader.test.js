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

/**
 * fake link that, like kit/readonly-diag.js, skips a unit after 5 requests in a row without an answer until wake();
 * the DME answers 0x66 (40 %) to everything once awake = true
 */
const sleepy = () => ({
    misses: 0, sent: 0, wakes: 0, awake: false,
    silent() { return this.misses >= 5; },
    wake() { this.wakes++; this.misses = 0; },
    physical(target, sid, data) {
        if (this.silent(target)) return Promise.resolve(null);
        this.sent++;
        if (!this.awake) { this.misses++; return Promise.resolve(null); }
        this.misses = 0;
        return Promise.resolve(sid === 0x22 ? [0x62, data[0], data[1], 0x66] : [0x41, data[0], 0x66]);
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
    ['a config.probe identifier is read but never becomes the value', async () => {
        const r = new Reader(fake({ '22:4ad5': [0x62, 0x4A, 0xD5, 0x01, 0x90] }), Object.assign({}, cfg, { probe: [{ did: '4AD5', bytes: 2, at: 0 }] }));
        assert.strictEqual((await r.poll()).value, null);
        const p = await r.probe(true);
        assert.strictEqual(p[0].label, '4AD5');
        assert.strictEqual(p[0].bytes, '62 4A D5 01 90');
    }],
    ['a DME asleep at start is woken at most every wakeMs and read once it answers', async () => {
        const link = sleepy();
        const r = new Reader(link, cfg);
        assert.strictEqual(r.cfg.wakeMs, 10000);
        for (let i = 0; i < 8; i++) await r.poll();          // asleep: the link ends up skipping it
        assert.ok(link.silent(), 'skipped after 5 misses');
        assert.ok(r.silent());
        assert.strictEqual(link.wakes, 1, 'woken once (the first time it was skipped), not on every poll');
        const sent = link.sent;
        await r.poll();
        assert.strictEqual(link.sent, sent, 'within wakeMs of the last wake nothing is sent');
        assert.strictEqual(r.last.value, null);
        link.awake = true;                                   // engine started
        r.wokeAt -= r.cfg.wakeMs;                            // wakeMs later
        const s = await r.poll();
        assert.strictEqual(link.wakes, 2);
        assert.strictEqual(Math.round(s.value), 40);
        assert.strictEqual(r.silent(), false);
    }],
    ['a link without silent() / wake() still works (no wake attempted)', async () => {
        const s = await new Reader(fake({ '22:f452': [0x62, 0xF4, 0x52, 0x66] }), cfg).poll();
        assert.strictEqual(Math.round(s.value), 40);
    }],
    ['550D (BMW alcohol in fuel) is used when F452 and OBD 52 are refused', async () => {
        const s = await new Reader(fake({ '22:f452': [0x7F, 0x22, 0x31], '1:52': [0x7F, 0x01, 0x12], '22:550d': [0x62, 0x55, 0x0D, 0x80] }), cfg).poll();
        assert.strictEqual(Math.round(s.value), 50);
        assert.strictEqual(s.source, '550D');
    }],
    ['Ethanol source pins one identifier: only that one is asked', async () => {
        const link = fake({ '22:f452': [0x62, 0xF4, 0x52, 0x66], '22:550d': [0x62, 0x55, 0x0D, 0x80] });
        const r = new Reader(link, cfg);
        r.source = '550D';
        const s = await r.poll();
        assert.strictEqual(s.source, '550D');
        assert.strictEqual(Math.round(s.value), 50);
        assert.deepStrictEqual(link.calls.map((c) => c.data[0]), [0x55]);
        r.source = 'nonsense';                                 // unknown: back to all of them, in order
        assert.strictEqual((await r.poll()).source, 'F452');
    }],
    ['tank: litres from 583B, else percent from OBD 2F, else why', async () => {
        let k = await new Reader(fake({ '22:583b': [0x62, 0x58, 0x3B, 0x24] }), cfg).tank();
        assert.strictEqual(k.litres, 36); assert.strictEqual(k.source, '583B');
        k = await new Reader(fake({ '22:583b': [0x7F, 0x22, 0x31], '1:2f': [0x41, 0x2F, 0x80] }), cfg).tank();
        assert.strictEqual(k.litres, null); assert.strictEqual(Math.round(k.pct), 50); assert.strictEqual(k.source, 'OBD 2F');
        k = await new Reader(fake({}), cfg).tank();
        assert.strictEqual(k.litres, null); assert.strictEqual(k.pct, null);
        assert.ok(/583B no reply \/ OBD 2F no reply/.test(k.why), k.why);
    }],
    ['every request goes to the DME and passes the read-only check', async () => {
        const link = fake({});
        const r = new Reader(link, cfg);
        await r.poll(); await r.probe(true);
        assert.ok(link.calls.length >= 3);
        link.calls.forEach((c) => { check(c.target, c.sid, c.data, false); assert.strictEqual(c.target, 0x12); });
    }],
];
