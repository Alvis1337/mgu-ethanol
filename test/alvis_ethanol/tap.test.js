'use strict';
/* alvis_ethanol: the transport tap passes everything through unchanged and counts it (Node 8, run by test/run.js) */
const assert = require('assert');
const path = require('path');
const { tapSignals, verdictOf, tally } = require(path.join(__dirname, '..', '..', 'apps', 'alvis_ethanol', 'tap.js'));

/** fake signals module: call() resolves with verdict, on() keeps the handler so the test can broadcast */
const fakeSignals = (verdict) => {
    const s = { handlers: {}, calls: [], other: 0 };
    s.call = (p, method, params, t) => { s.calls.push({ method, params, t }); return Promise.resolve(verdict); };
    s.on = (p, name, fn) => { s.handlers[name] = fn; return Promise.resolve(); };
    s.proxy = () => Promise.resolve({});
    s.onAvailable = () => { s.other++; return Promise.resolve(); };
    return s;
};
const frame = (ecu, uds) => ({ errorCode: 'NO_ERROR', udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)) });

module.exports = [
    ['requests pass unchanged; the verdicts are counted', async () => {
        const s = fakeSignals({ TasuErrorEnum: 'NO_ERROR' }), tap = tapSignals(s);
        const params = { targetAddress: 0x12, serviceID: 0x22 };
        assert.deepStrictEqual(await tap.signals.call('p', 'sendTasuRequest', params, 8000), { TasuErrorEnum: 'NO_ERROR' });
        assert.strictEqual(s.calls[0].params, params);
        assert.strictEqual(s.calls[0].t, 8000);
        await tap.signals.call('p', 'somethingElse', {});
        assert.strictEqual(tap.stats.requests, 1);
        assert.deepStrictEqual(tap.stats.verdicts, { NO_ERROR: 1 });
        assert.strictEqual(tap.stats.firstVerdict, '{"TasuErrorEnum":"NO_ERROR"}');
        assert.deepStrictEqual(await tap.signals.proxy('x', '1'), await s.proxy('x', '1'), 'proxy() passes through');
        await tap.signals.onAvailable(); assert.strictEqual(s.other, 1);
    }],
    ['responses reach the kit unchanged; frames, errors, rejects and short frames are counted', async () => {
        const s = fakeSignals(undefined), tap = tapSignals(s);
        const got = [];
        await tap.signals.on('p', 'sendTasuResponse', (v) => got.push(v));
        const h = s.handlers.sendTasuResponse;
        const f = frame(0x12, [0x62, 0x55, 0x0D, 0x66]);
        h(f);
        h({ errorCode: 'TIMEOUT', udsResponse: Buffer.from([]) });
        h({ errorCode: 'NO_ERROR', udsResponse: Buffer.from([0, 0, 0x7F, 0, 0x31]) });
        h({ errorCode: 0, udsResponse: Buffer.from([1, 2, 3]) });
        assert.strictEqual(got.length, 4);
        assert.strictEqual(got[0], f);
        const t = tap.stats;
        assert.strictEqual(t.responses, 4);
        assert.deepStrictEqual(t.frames, { 12: 1 });
        assert.deepStrictEqual(t.errors, { TIMEOUT: 1 });
        assert.deepStrictEqual(t.rejects, { 31: 1 });
        assert.strictEqual(t.short, 1);
        assert.strictEqual(t.last[0].kind, 'from 12');
        assert.strictEqual(t.last[0].bytes, '00 00 00 00 00 00 12 00 00 62 55 0D 66');
    }],
    ['other broadcasts are not touched', async () => {
        const s = fakeSignals(), tap = tapSignals(s);
        const fn = () => {};
        await tap.signals.on('p', 'statusEngineStatus', fn);
        assert.strictEqual(s.handlers.statusEngineStatus, fn);
        assert.strictEqual(tap.stats.responses, 0);
    }],
    ['verdicts as diag.js reads them, and tallies', () => {
        assert.strictEqual(verdictOf(undefined), 'NO_ERROR');
        assert.strictEqual(verdictOf({ TasuErrorEnum: 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' }), 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED');
        assert.strictEqual(verdictOf({ x: 'REQUEST_PENDING' }), 'REQUEST_PENDING');
        assert.strictEqual(verdictOf(0), '0');
        assert.strictEqual(tally({}), 'none');
        assert.strictEqual(tally({ A: 2, B: 1 }), 'A 2, B 1');
    }],
    ['the response subscription: yes, or why it failed', async () => {
        const ok = fakeSignals(), t1 = tapSignals(ok);
        assert.strictEqual(t1.stats.subscribed, 'not yet');
        await t1.signals.on('p', 'sendTasuResponse', () => {});
        await Promise.resolve();
        assert.strictEqual(t1.stats.subscribed, 'yes');
        const bad = fakeSignals();
        bad.on = () => Promise.reject(new Error('event sendTasuResponse not in config'));
        const t2 = tapSignals(bad);
        let err = null;
        try { await t2.signals.on('p', 'sendTasuResponse', () => {}); } catch (e) { err = e; }
        assert.ok(err, 'the kit still sees the failure');
        await Promise.resolve();
        assert.strictEqual(t2.stats.subscribed, 'failed: event sendTasuResponse not in config');
    }],
    ['since(n): the responses after number n, from the last 32', async () => {
        const s = fakeSignals(), tap = tapSignals(s);
        await tap.signals.on('p', 'sendTasuResponse', () => {});
        for (let i = 0; i < 40; i++) s.handlers.sendTasuResponse(frame(0x12, [0x62, 0xF1, 0x90, i]));
        assert.strictEqual(tap.stats.responses, 40);
        assert.strictEqual(tap.stats.recent.length, 32);
        assert.deepStrictEqual(tap.since(37).map((x) => x.seq), [38, 39, 40]);
        assert.strictEqual(tap.since(40).length, 0);
        assert.strictEqual(tap.since(0).length, 32);
    }],
    ['trace: each request, its verdict and each response, in order', async () => {
        const s = fakeSignals({ TasuErrorEnum: 'REQUEST_PENDING' }), tap = tapSignals(s);
        await tap.signals.on('p', 'sendTasuResponse', () => {});
        await tap.signals.call('p', 'sendTasuRequest', { targetAddress: 0x29, serviceID: 0x22, udsData: Buffer.from([0xF1, 0x50]) });
        s.handlers.sendTasuResponse({ errorCode: 'NO_ERROR', udsResponse: Buffer.from([0xF0, 0xF2, 0x7F, 0x31, 0x25]) });
        s.handlers.sendTasuResponse(frame(0x29, [0x62, 0xF1, 0x50, 0x0F, 0x28, 0x50]));
        const tr = tap.stats.trace.map((e) => e.dir + ' ' + e.text);
        assert.deepStrictEqual(tr, [
            '> #1 to 29: 22 F1 50',
            '= #1 REQUEST_PENDING',
            '< rejected 25: F0 F2 7F 31 25',
            '< from 29: 00 00 00 00 00 00 29 00 00 62 F1 50 0F 28 50',
        ]);
        assert.ok(tap.stats.trace.every((e) => typeof e.at === 'number'));
    }],
    ['proxy: the transport proxy kept for the Ext test; other proxies passed through', async () => {
        const s = fakeSignals();
        s.proxy = (iface) => Promise.resolve({ iface });
        const tap = tapSignals(s);
        await tap.signals.proxy('de.bmw.infotainment.vehicle.CDS', '1');
        assert.strictEqual(tap.proxy, null);
        const px = await tap.signals.proxy('com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu', 'SystemFunctionsInternalTasuInst1');
        await Promise.resolve();
        assert.strictEqual(tap.proxy, px);
        tap.hear(frame(0x29, [0x62, 0xF1, 0x50, 1, 2, 3]));
        assert.deepStrictEqual(tap.stats.frames, { 29: 1 });
    }],
];
