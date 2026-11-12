'use strict';
/* alvis_ethanol: the Debug page's requests against a fake link (Node 8, run by test/run.js) */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent) {
    const args = Array.prototype.slice.call(arguments);
    if (typeof req === 'string' && req.indexOf('./kit/') === 0) args[0] = path.join(root, 'kit', 'runtime', req.slice(6));
    return orig.apply(this, args);
};
const { Debug, PROBES } = require(path.join(root, 'apps', 'alvis_ethanol', 'debug.js'));
const { check } = require(path.join(root, 'kit', 'runtime', 'readonly-diag.js'));

const quiet = { info() {}, warn() {}, error() {} };

/**
 * fake ReadOnlyDiag: answers[key] = reply bytes, key = 'sid:hexdata'; checks every request like the real one;
 * refuseRest: every other request is refused (NRC 31 / 12) instead of left without a reply
 */
const fakeLink = (answers, units, refuseRest) => ({
    ready: true, available: true, error: null, busy: 0,
    stats: { sent: 0, replies: 0, missed: 0 },
    wakes: 0, calls: [],
    wake() { this.wakes++; },
    physical(target, sid, data, timeoutMs, accept) {
        check(target, sid, data, false);
        this.calls.push({ target, sid, data: data.slice() });
        this.stats.sent++;
        const key = sid.toString(16) + ':' + data.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
        const r = key in answers ? answers[key] : refuseRest ? [0x7F, sid, sid === 0x22 ? 0x31 : 0x12] : null;
        if (!r) { this.stats.missed++; return Promise.resolve(null); }
        assert.ok(accept(r), 'accept() takes the reply to ' + key);
        this.stats.replies++;
        return Promise.resolve(r);
    },
    discover() { return Promise.resolve(units || new Map()); },
});

module.exports = [
    ['every request is read-only, goes to the DME and wakes it first', async () => {
        const link = fakeLink({}, null, true);
        const d = new Debug(link, quiet, { ecu: 0x12 });
        await d.run();
        assert.strictEqual(link.calls.length, PROBES.length);
        link.calls.forEach((c) => assert.strictEqual(c.target, 0x12));
        assert.strictEqual(link.wakes, PROBES.length, 'a silent DME is still asked');
        assert.strictEqual(d.running, false);
        assert.strictEqual(d.done, d.total);
        assert.ok(d.rows.filter((r) => r.state === 'nrc').length === PROBES.length);
    }],
    ['a DME that gives no reply 4 times in a row: the rest is skipped, the bus is still asked', async () => {
        const units = new Map([[0x40, '0F1050']]);
        const link = fakeLink({}, units);
        const d = new Debug(link, quiet, { ecu: 0x12 });
        const rows = await d.run();
        assert.strictEqual(link.calls.length, 4);
        const skip = rows.filter((r) => /^Skipped/.test(r.label))[0];
        assert.ok(skip, 'a row says what was skipped');
        assert.ok(/no reply 4 times in a row/.test(skip.text), skip.text);
        assert.ok(/1 units; DME 12 NOT among them/.test(rows.filter((r) => r.group === 'Bus')[0].text));
        assert.strictEqual(d.done, d.total);
    }],
    ['an answer resets the count of no replies in a row', async () => {
        const link = fakeLink({ '22:550d': [0x62, 0x55, 0x0D, 0x66] });     // 3rd request answers, the rest are silent
        await new Debug(link, quiet, { ecu: 0x12 }).run();
        assert.strictEqual(link.calls.length, 3 + 4);
    }],
    ['answers, refusals and silence each show as such', async () => {
        const link = fakeLink({
            '22:550d': [0x62, 0x55, 0x0D, 0x66],
            '22:f452': [0x7F, 0x22, 0x31],
            '22:583b': [0x62, 0x58, 0x3B, 0x20],
            '22:f190': [0x62, 0xF1, 0x90].concat('WBA5U7C09LFH12345'.split('').map((ch) => ch.charCodeAt(0))),
            '1:52': [0x41, 0x52, 0xCC],
            '1:40': [0x41, 0x40, 0x00, 0x00, 0xC0, 0x00],      // PIDs 51 and 52 flagged (bits 17 and 18)
            '1:05': null,                                     // no reply (the rest are refused)
        }, null, true);
        const d = new Debug(link, quiet, { ecu: 0x12 });
        const rows = await d.run();
        const by = (req) => rows.filter((r) => r.req === req)[0];
        assert.strictEqual(by('22 550D').state, 'ok');
        assert.ok(/^40\.0 %/.test(by('22 550D').text), by('22 550D').text);
        assert.strictEqual(by('22 F452').state, 'nrc');
        assert.ok(/NRC 31/.test(by('22 F452').text));
        assert.ok(/^32 l/.test(by('22 583B').text), by('22 583B').text);
        assert.ok(/WBA5U7C09LFH12345/.test(by('22 F190').text));
        assert.ok(/^80\.0 %/.test(by('01 52').text), by('01 52').text);
        assert.ok(/51 yes, 52 yes/.test(by('01 40').text), by('01 40').text);
        assert.strictEqual(by('01 0C').state, 'nrc');
        assert.ok(/NRC 12/.test(by('01 0C').text));
        assert.strictEqual(by('01 05').state, 'none');
        assert.ok(/no reply/.test(by('01 05').text));
    }],
    ['bus discovery names the DME type and lists every unit', async () => {
        const units = new Map([[0x12, '0F26E8'], [0x40, '0F1050'], [0x60, ''], [0x18, '000001'], [0x63, '000002'], [0x01, '000003']]);
        const d = new Debug(fakeLink({}, units), quiet, { ecu: 0x12 });
        const rows = await d.run();
        const bus = rows.filter((r) => r.group === 'Bus');
        assert.ok(/6 units; DME 12 0F26E8 = DME8FF_R/.test(bus[0].text), bus[0].text);
        assert.strictEqual(bus.length, 3, 'one summary row and two rows of units');
        assert.ok(/^01:000003 12:0F26E8 18:000001 40:0F1050 60/.test(bus[1].text), bus[1].text);
    }],
    ['link not ready: nothing is sent, the row says why', async () => {
        const link = fakeLink({});
        link.ready = false; link.error = 'TASU unavailable';
        const d = new Debug(link, quiet, { ecu: 0x12 });
        const rows = await d.run();
        assert.strictEqual(link.calls.length, 0);
        assert.strictEqual(rows.length, 1);
        assert.ok(/not ready: TASU unavailable/.test(rows[0].text));
    }],
    ['a request the link throws on is shown as an error and the run goes on', async () => {
        const link = fakeLink({}, null, true);
        let n = 0;
        const phys = link.physical.bind(link);
        link.physical = function () { if (n++ === 0) return Promise.reject(new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED')); return phys.apply(null, arguments); };
        const rows = await new Debug(link, quiet, { ecu: 0x12 }).run();
        assert.strictEqual(rows[1].state, 'error');
        assert.strictEqual(rows[1].text, 'head unit refused: TEMPORARILY_NOT_ACCEPTED');
        assert.strictEqual(link.calls.length, PROBES.length - 1);
    }],
];
