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
        assert.strictEqual(tap.signals.proxy, s.proxy);
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
];
