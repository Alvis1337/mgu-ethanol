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

const fs = require('fs');
const os = require('os');
const quiet = { info() {}, warn() {}, error() {} };
const target = (p) => (p[2].ecu != null ? p[2].ecu : 0x12);
const DME_PROBES = PROBES.filter((p) => target(p) === 0x12).length;
const OTHER = PROBES.length - DME_PROBES;
/** a temporary installed-app layout: kit/ and someipInterfaces/ with the given files */
function layout(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethanol-debug-'));
    const kitDir = path.join(root, 'kit'), ifaceDir = path.join(root, 'someipInterfaces');
    fs.mkdirSync(kitDir); fs.mkdirSync(ifaceDir);
    Object.keys(files).forEach((f) => fs.writeFileSync(path.join(root, f), files[f]));
    return { kitDir, ifaceDir, ifaceDir2: path.join(root, 'someipdefs'), manifestFile: path.join(root, 'manifest.json') };
}
const TASU_CFG = 'someipInterfaces/com_harman_infotainment_systemfunctions_tasu_tasu_InternalTasu.json';

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
        link.calls.forEach((c, i) => assert.strictEqual(c.target, target(PROBES[i])));
        assert.ok(OTHER >= 4 && link.calls.slice(0, OTHER).every((c) => c.target !== 0x12), 'the other units are asked before the DME');
        assert.strictEqual(link.wakes, PROBES.length, 'a silent unit is still asked');
        assert.strictEqual(d.running, false);
        assert.strictEqual(d.done, d.total);
        assert.ok(d.rows.filter((r) => r.state === 'nrc').length === PROBES.length);
    }],
    ['a DME that gives no reply 4 times in a row: the rest is skipped, the bus is still asked', async () => {
        const units = new Map([[0x40, '0F1050']]);
        const link = fakeLink({}, units);
        const d = new Debug(link, quiet, { ecu: 0x12 });
        const rows = await d.run();
        assert.strictEqual(link.calls.length, OTHER + 4, 'each other unit once, the DME 4 times');
        const skip = rows.filter((r) => /^Skipped/.test(r.label));
        assert.strictEqual(skip.length, 1, 'only the DME has requests left to skip');
        assert.ok(/DME gave no reply \(or was turned away\) 4 times in a row/.test(skip[0].text), skip[0].text);
        const bus = rows.filter((r) => r.group === 'Bus')[0];
        assert.ok(/1 units; DME 12 NOT among them/.test(bus.text));
        assert.ok(rows.indexOf(bus) < rows.indexOf(rows.filter((r) => r.req === '22 F190 @10')[0]), 'the bus is asked first');
        assert.strictEqual(d.done, d.total);
    }],
    ['an answer resets the count of no replies in a row', async () => {
        const link = fakeLink({ '22:550d': [0x62, 0x55, 0x0D, 0x66] });     // 3rd request answers, the rest are silent
        await new Debug(link, quiet, { ecu: 0x12 }).run();
        assert.strictEqual(link.calls.length, OTHER + 3 + 4);
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
        assert.ok(rows.filter((r) => r.group === 'Setup').length >= 4, 'the setup rows still show');
        assert.ok(/not ready: TASU unavailable/.test(rows[0].text));
    }],
    ['a request the link throws on is shown as an error and the run goes on', async () => {
        const link = fakeLink({}, null, true);
        let n = 0;
        const phys = link.physical.bind(link);
        link.physical = function () { if (n++ === 0) return Promise.reject(new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED')); return phys.apply(null, arguments); };
        const rows = await new Debug(link, quiet, { ecu: 0x12 }).run();
        const first = rows.filter((r) => r.req === '22 F190 @10')[0];  // the first request (the gateway's VIN)
        assert.strictEqual(first.state, 'error');
        assert.strictEqual(first.text, 'head unit refused: TEMPORARILY_NOT_ACCEPTED');
        assert.strictEqual(link.calls.length, PROBES.length - 1);
    }],
    ['car signal rows: engine and cluster fuel level, or that none came', async () => {
        let car = { engine: 'running', tankL: 41 };
        const d = new Debug(fakeLink({}, null, true), quiet, { ecu: 0x12, car: () => car });
        let rows = await d.run();
        assert.strictEqual(rows[1].text, 'running'); assert.strictEqual(rows[1].state, 'ok');
        assert.strictEqual(rows[2].text, '41 l');
        car = { engine: 'off', tankL: null };
        rows = await d.run();
        assert.ok(/off: the DME may not answer/.test(rows[1].text));
        assert.strictEqual(rows[2].text, 'no signal yet');
    }],
    ['transport rows: what the head unit took and what came back', async () => {
        const tap = { requests: 3, verdicts: { NO_ERROR: 3 }, callErrors: {}, responses: 2, frames: { 40: 1 }, errors: { TIMEOUT: 1 }, rejects: {}, short: 0,
            last: [{ kind: 'error TIMEOUT', bytes: '' }, { kind: 'from 40', bytes: '00 00 00 00 00 00 40 00 00 62 F1 90' }], firstVerdict: '{"TasuErrorEnum":"NO_ERROR"}' };
        const rows = await new Debug(fakeLink({}, null, true), quiet, { ecu: 0x12, tap }).run();
        const tr = rows.filter((r) => r.group === 'Transport');
        assert.strictEqual(tr[0].text, '3 requests: NO_ERROR 3');
        assert.strictEqual(tr[1].text, '2: from 40 1');
        assert.strictEqual(tr[2].text, 'TIMEOUT 1');
        assert.strictEqual(tr[3].text, 'none');
        assert.ok(/^from 40: 00 00/.test(tr[5].text));
        assert.ok(/TasuErrorEnum/.test(tr[tr.length - 1].text));
    }],
    ['setup: what the installer left out, the TASU config and access list, the subscription', async () => {
        let dirs = layout({
            'kit/missing-interfaces.json': JSON.stringify({ 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu: sendTasuResponse': 'these signals' }),
            [TASU_CFG]: '{"methods":{"sendTasuRequest":{}}}',
            'someipInterfaces/acl.json': '{"requests":[{"interface":"com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu","methods":["sendTasuRequest"]}]}',
            'someipInterfaces/de_bmw_infotainment_vehicle_CDS.json': '{}',
            'manifest.json': JSON.stringify({ proxies: { 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': { instances: 'SystemFunctionsInternalTasuInst1', methods: ['sendTasuRequest'] } } }),
        });
        let rows = new Debug(fakeLink({}), quiet, Object.assign({ tap: { subscribed: 'failed: no such event' } }, dirs)).setupRows();
        const by = (l) => rows.filter((r) => r.label === l)[0];
        assert.strictEqual(by('Left out at install').state, 'error');
        assert.ok(/InternalTasu: sendTasuResponse/.test(by('Left out at install').text));
        assert.ok(/request yes, response NO/.test(by('TASU interface config').text), by('TASU interface config').text);
        assert.strictEqual(by('TASU interface config').state, 'error');
        assert.ok(/TASU yes, request yes, response NO/.test(by('TASU access list').text), by('TASU access list').text);
        assert.ok(/^2: InternalTasu, CDS$|^2: CDS, InternalTasu$/.test(by('Interfaces generated').text), by('Interfaces generated').text);
        assert.strictEqual(by('Response subscription').text, 'failed: no such event');
        assert.strictEqual(by('Manifest as built').state, 'error');
        assert.ok(/methods \["sendTasuRequest"\], broadcasts \[\]/.test(by('Manifest as built').text), by('Manifest as built').text);
        dirs = layout({ [TASU_CFG]: '{"methods":{"sendTasuRequest":{}},"events":{"sendTasuResponse":{}}}' });
        rows = new Debug(fakeLink({}), quiet, Object.assign({ tap: { subscribed: 'yes' } }, dirs)).setupRows();
        assert.strictEqual(by('Left out at install').text, 'nothing');
        assert.strictEqual(by('TASU interface config').state, 'ok');
        assert.strictEqual(by('TASU access list').text, 'no acl.json');
        assert.strictEqual(by('Response subscription').state, 'ok');
        rows = new Debug(fakeLink({}), quiet, { kitDir: '/nonexistent/kit', ifaceDir: '/nonexistent/si', ifaceDir2: '/nonexistent/d', manifestFile: '/nonexistent/m.json' }).setupRows();
        assert.ok(/^no file /.test(by('TASU interface config').text));
        assert.ok(/^no \/nonexistent/.test(by('Manifest as built').text));
        assert.ok(/^no folder /.test(by('Interfaces generated').text));
    }],
    ['no reply from the kit, but the transport sent something meanwhile: shown, and not counted as silence', async () => {
        const tap = { responses: 0, subscribed: 'yes', requests: 0, verdicts: {}, callErrors: {}, frames: {}, errors: {}, rejects: {}, short: 0, last: [] };
        const heard = [];
        const link = fakeLink({});
        const phys = link.physical.bind(link);
        link.physical = function () {
            tap.responses++;
            heard.push({ seq: tap.responses, kind: 'from 12', bytes: '10 0B 00 00 F2 00 12 00 00 62 F1 90' });
            return phys.apply(null, arguments);
        };
        const rows = await new Debug(link, quiet, { ecu: 0x12, tap, tapSince: (n) => heard.filter((x) => x.seq > n) }).run();
        const odd = rows.filter((r) => r.state === 'odd');
        assert.strictEqual(odd.length, PROBES.length, 'every request saw a response the kit did not take');
        assert.ok(/no reply, but 1 came: from 12: 10 0B/.test(odd[0].text), odd[0].text);
        assert.strictEqual(rows.filter((r) => /^Skipped/.test(r.label)).length, 0);
    }],
    ['the head unit turning the DME away (7F 31 25) counts as silence: skipped after 4', async () => {
        const tap = { responses: 0, subscribed: 'yes', requests: 0, verdicts: {}, callErrors: {}, frames: {}, errors: {}, rejects: {}, short: 0, last: [] };
        const heard = [];
        const link = fakeLink({}, null, true);
        const phys = link.physical.bind(link);
        link.physical = function (target) {
            if (target !== 0x12) return phys.apply(null, arguments);       // the other units refuse (NRC): they answer
            link.calls.push({ target });
            tap.responses++;
            heard.push({ seq: tap.responses, kind: 'rejected 25', bytes: 'F0 F2 7F 31 25' });
            return Promise.resolve(null);
        };
        const rows = await new Debug(link, quiet, { ecu: 0x12, tap, tapSince: (n) => heard.filter((x) => x.seq > n) }).run();
        assert.strictEqual(link.calls.filter((c) => c.target === 0x12).length, 4);
        const skip = rows.filter((r) => /^Skipped/.test(r.label));
        assert.strictEqual(skip.length, 1);
        assert.ok(/^DME gave no reply \(or was turned away\) 4/.test(skip[0].text), skip[0].text);
        assert.ok(rows.filter((r) => r.state === 'odd').every((r) => /rejected 25: F0 F2 7F 31 25/.test(r.text)));
    }],
    ['the first DME request waits 10 s, the others the default', async () => {
        const link = fakeLink({}, null, true);
        const t = [];
        const phys = link.physical.bind(link);
        link.physical = function (target, sid, data, timeoutMs) { if (target === 0x12) t.push(timeoutMs); return phys.apply(null, arguments); };
        await new Debug(link, quiet, { ecu: 0x12 }).run();
        assert.strictEqual(t[0], 10000);
        assert.ok(t.slice(1).every((x) => x === 3000));
        assert.ok(PROBES.some((p) => p[2].ecu === 0x29) && PROBES.some((p) => p[2].did === 0x4098), 'DSC and the MHD identifiers are asked');
    }],
];
