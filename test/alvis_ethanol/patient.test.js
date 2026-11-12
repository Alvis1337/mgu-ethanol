'use strict';
/* alvis_ethanol: requests tried again while the head unit's transport is busy (Node 8, run by test/run.js) */
const assert = require('assert');
const path = require('path');
const { patient } = require(path.join(__dirname, '..', '..', 'apps', 'alvis_ethanol', 'patient.js'));

const BUSY = 'transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED';
/** link whose physical() is turned away busy the first n times, then answers */
const busyFor = (n) => ({
    calls: 0, ready: true, available: true, error: null, busy: 3, stats: { sent: 1 },
    physical() { this.calls++; return this.calls <= n ? Promise.reject(new Error(BUSY)) : Promise.resolve([0x62, 0x55, 0x0D, 0x66]); },
    discover() { this.calls++; return this.calls <= n ? Promise.reject(new Error(BUSY)) : Promise.resolve(new Map([[0x12, '0F26E8']])); },
});

module.exports = [
    ['busy: sent again until the transport takes it', async () => {
        const link = busyFor(2), w = patient(link, { waitMs: 5, maxWaitMs: 1000 });
        assert.deepStrictEqual(await w.physical(0x12, 0x22, [0x55, 0x0D]), [0x62, 0x55, 0x0D, 0x66]);
        assert.strictEqual(link.calls, 3);
        assert.strictEqual(w.retried, 2);
        assert.strictEqual((await w.discover()).get(0x12), '0F26E8');
    }],
    ['busy for longer than maxWaitMs: the refusal is passed on', async () => {
        const link = busyFor(1000), w = patient(link, { waitMs: 5, maxWaitMs: 30 });
        let err = null;
        try { await w.physical(0x12, 0x22, [0x55, 0x0D]); } catch (e) { err = e; }
        assert.ok(err && /TEMPORARILY_NOT_ACCEPTED/.test(err.message));
        assert.ok(link.calls >= 2 && link.calls <= 8, String(link.calls));
        assert.strictEqual(w.gaveUp, 1);
    }],
    ['other errors and no reply are passed on at once', async () => {
        const link = { calls: 0, physical() { this.calls++; return Promise.reject(new Error('read-only: service 2E is not allowed')); } };
        let err = null;
        try { await patient(link, { waitMs: 5 }).physical(0x12, 0x2E, [1, 2]); } catch (e) { err = e; }
        assert.ok(err && /read-only/.test(err.message));
        assert.strictEqual(link.calls, 1);
        const silent = { physical() { return Promise.resolve(null); } };
        assert.strictEqual(await patient(silent).physical(0x12, 0x22, [0xF4, 0x52]), null);
    }],
    ['the link state reads through (ready, available, stats, silent / wake)', () => {
        const woke = [];
        const link = { ready: true, available: false, error: 'x', busy: 2, stats: { sent: 4 }, silent: (t) => t === 0x12, wake: (t) => woke.push(t) };
        const w = patient(link);
        assert.strictEqual(w.ready, true); assert.strictEqual(w.available, false); assert.strictEqual(w.error, 'x');
        assert.strictEqual(w.busy, 2); assert.strictEqual(w.stats.sent, 4);
        assert.strictEqual(w.silent(0x12), true); assert.strictEqual(w.silent(0x40), false);
        w.wake(0x12); assert.deepStrictEqual(woke, [0x12]);
        assert.strictEqual(patient({}).silent(0x12), false);
    }],
];
