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
const { Debug: RealDebug, PROBES, EC_PROBES, shortLine } = require(path.join(root, 'apps', 'alvis_ethanol', 'debug.js'));
/** the Debug page without its 5 s settle and 4 s gaps, and without other apps' logs, unless a test asks */
class Debug extends RealDebug {
    constructor(link, log, opts) { super(link, log, Object.assign({ settleMs: 0, ecGapMs: 0, appsDir: '/nonexistent/apps' }, opts)); }
}
const EC = EC_PROBES.length;
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
        assert.strictEqual(link.calls.length, EC + PROBES.length);
        assert.deepStrictEqual(link.calls.slice(0, EC).map((c) => c.target), [0x29, 0x29, 0x19, 0x19, 0x12], "Engine Config's reads first");
        link.calls.slice(EC).forEach((c, i) => assert.strictEqual(c.target, target(PROBES[i])));
        assert.ok(OTHER >= 4 && link.calls.slice(EC, EC + OTHER).every((c) => c.target !== 0x12), 'the other units are asked before the DME');
        assert.strictEqual(link.wakes, EC + PROBES.length, 'a silent unit is still asked');
        assert.strictEqual(d.running, false);
        assert.strictEqual(d.done, d.total);
        assert.ok(d.rows.filter((r) => r.state === 'nrc').length === EC + PROBES.length);
    }],
    ['a DME that gives no reply 4 times in a row: the rest is skipped, the bus is still asked', async () => {
        const units = new Map([[0x40, '0F1050']]);
        const link = fakeLink({}, units);
        const d = new Debug(link, quiet, { ecu: 0x12 });
        const rows = await d.run();
        assert.strictEqual(link.calls.length, EC + OTHER + 4, "Engine Config's reads, each other unit once, the DME 4 times");
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
        assert.strictEqual(link.calls.length, EC + OTHER + 3 + 4);
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
        const first = rows.filter((r) => r.req === '22 F150 @29')[0];  // the first request (Engine Config's DSC read)
        assert.strictEqual(first.state, 'error');
        assert.strictEqual(first.text, 'head unit refused: TEMPORARILY_NOT_ACCEPTED');
        assert.strictEqual(link.calls.length, EC + PROBES.length - 1);
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
        assert.strictEqual(odd.length, EC + PROBES.length, 'every request saw a response the kit did not take');
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
        assert.strictEqual(link.calls.filter((c) => c.target === 0x12).length, 1 + 4, "Engine Config's DME read, then 4 before the skip");
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
        assert.strictEqual(t[0], 2000, "Engine Config's DME read: its 2 s");
        assert.strictEqual(t[1], 10000);
        assert.ok(t.slice(2).every((x) => x === 3000));
        assert.ok(PROBES.some((p) => p[2].ecu === 0x29) && PROBES.some((p) => p[2].did === 0x4098), 'DSC and the MHD identifiers are asked');
    }],
    ['catalog: the transport as the unit lists it, and ethanol / fuel quality names anywhere', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethanol-cat-'));
        const file = path.join(dir, 'someip-interfaces.json');
        fs.writeFileSync(file, JSON.stringify({
            interfaces: {
                'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': { methods: { sendTasuRequest: {} }, events: [{ name: 'sendTasuResponse' }] },
                'de.bmw.diagnosis.ObdService': { methods: {} },
                'de.bmw.infotainment.vehicle.CDS2': { fields: { statusFuelQuality: { getter: {}, type: { members: [{ name: 'ethanolPortion' }] } } } },
                'de.bmw.infotainment.KombiIF': { fields: { statusRangeTankStatus: { type: { enum: ['KRAFTSTOFFART_E85'] } } } },
            },
            instanceIDs: { 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': { SystemFunctionsInternalTasuInst1: 1, SystemFunctionsInternalTasuInst2: 2 } },
        }));
        const logged = [];
        const rows = new Debug(fakeLink({}), { info: (m) => logged.push(m), warn() {}, error() {} }, { catalogFile: file }).catalogRows();
        const by = (l) => rows.filter((r) => r.label === l)[0];
        assert.ok(/^4 interfaces/.test(by('Unit catalog').text));
        assert.strictEqual(by('TASU in the catalog').text, 'methods sendTasuRequest | events sendTasuResponse | instances SystemFunctionsInternalTasuInst1 SystemFunctionsInternalTasuInst2');
        assert.strictEqual(by('Other diagnostic interfaces').text, 'ObdService');
        assert.ok(/^3 found/.test(by('Ethanol / fuel names').text), by('Ethanol / fuel names').text);
        const m = rows.filter((r) => /^match/.test(r.label)).map((r) => r.text);
        assert.ok(m.indexOf('CDS2.fields.statusFuelQuality') >= 0, m.join(' | '));
        assert.ok(m.some((x) => /ethanolPortion$/.test(x)), m.join(' | '));
        assert.ok(m.some((x) => /= KRAFTSTOFFART_E85$/.test(x)), m.join(' | '));
        assert.strictEqual(logged.filter((x) => /catalog match/.test(x)).length, 3);
        const big = new Debug(fakeLink({}), quiet, { catalogFile: file, catalogMaxParse: 100 }).catalogRows();
        assert.ok(/too big to parse here/.test(big[0].text), big[0].text);
        assert.ok(big.some((r) => r.text === 'statusFuelQuality') && big.some((r) => r.text === 'KRAFTSTOFFART_E85'), big.map((r) => r.text).join(' | '));
        const none = new Debug(fakeLink({}), quiet, { catalogFile: '/nonexistent/c.json' }).catalogRows();
        assert.strictEqual(none.length, 1);
        assert.ok(/^cannot read/.test(none[0].text));
    }],
    ["other apps' logs: Engine Config's xDrive evidence, shortened; unreadable or absent said so", async () => {
        const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'ethanol-apps-'));
        ['oap_101', 'oap_101/data', 'oap_102', 'oap_102/data', 'oap_103'].forEach((d) => fs.mkdirSync(path.join(apps, d)));   // (Node 8: no recursive)
        const ev = { schema: 1, event: 'uds_result', target: '29', request: '22 F1 50', status: 'positive_response', response: '62 F1 50 0F 28 50', elapsedMs: 41 };
        const id = { event: 'identified', snapshot: { dscIndex: '0F2850', dscUnit: 'DSC_G30N', supported: true, vehicle: { rpm: 702 } } };
        fs.writeFileSync(path.join(apps, 'oap_102/data/live_adjustments.log'), [
            '2026-11-12T20:30:01.000Z INFO starting live_adjustments 0.9.3',
            '2026-11-12T20:30:05.000Z INFO xdrive-diagnostic ' + JSON.stringify(ev),
            '2026-11-12T20:30:06.000Z INFO xdrive-diagnostic ' + JSON.stringify(id),
            '2026-11-12T20:30:07.000Z INFO something else',
        ].join('\n') + '\n');
        const logged = [];
        const rows = new Debug(fakeLink({}), { info: (m) => logged.push(m), warn() {}, error() {} }, { appsDir: apps }).otherLogRows();
        assert.strictEqual(rows[0].label, 'Engine Config');
        assert.ok(/^2 matching lines/.test(rows[0].text), rows[0].text);
        assert.strictEqual(rows[1].text, '20:30:05 29 22 F1 50 -> positive_response 62 F1 50 0F 28 50 (41 ms)');
        assert.strictEqual(rows[2].text, '20:30:06 identified: DSC 0F2850 DSC_G30N, supported true, rpm 702');
        assert.strictEqual(logged.length, 2);
        const none = new Debug(fakeLink({}), quiet, { appsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ethanol-noapps-')) }).otherLogRows();
        assert.ok(/no Engine Config/.test(none[0].text));
        const gone = new Debug(fakeLink({}), quiet, { appsDir: '/nonexistent/apps' }).otherLogRows();
        assert.ok(/^cannot list/.test(gone[0].text));
        assert.strictEqual(shortLine('2026-11-12T20:30:07.000Z WARN plain text'), '20:30:07 plain text');
    }],
    ["the settle and Engine Config's 4 s gaps are really waited (shortened here)", async () => {
        const link = fakeLink({}, null, true);
        const at = [];
        const phys = link.physical.bind(link);
        link.physical = function () { at.push(Date.now()); return phys.apply(null, arguments); };
        const t0 = Date.now();
        const d = new Debug(link, quiet, { settleMs: 60, ecGapMs: 40 });
        const p = d.run();
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(d.settling, true);
        await p;
        assert.ok(at[0] - t0 >= 55, 'nothing sent while settling: ' + (at[0] - t0));
        for (let i = 1; i < EC; i++) assert.ok(at[i] - at[i - 1] >= 35, 'gap ' + i + ': ' + (at[i] - at[i - 1]));
    }],
    ['vehicle state row, and the run trace with times from the run start', async () => {
        const t0 = Date.now();
        const tap = { responses: 0, subscribed: 'yes', requests: 0, verdicts: {}, callErrors: {}, frames: {}, errors: {}, rejects: {}, short: 0, last: [],
            trace: [{ at: t0 - 5000, dir: '>', text: '#1 to 12: 22 55 0D' }] };
        const link = fakeLink({}, null, true);
        const phys = link.physical.bind(link);
        link.physical = function (target, sid, data) {
            tap.trace.push({ at: Date.now(), dir: '>', text: '#x to ' + target.toString(16) });
            tap.trace.push({ at: Date.now(), dir: '<', text: 'rejected 25: F0 F2 7F 31 25' });
            return phys.apply(null, arguments);
        };
        const d = new Debug(link, quiet, { tap, car: () => ({ engine: 'running', tankL: 20, condition: 'FAHREN' }) });
        const rows = await d.run();
        const vs = rows.filter((r) => r.label === 'Vehicle state')[0];
        assert.strictEqual(vs.text, 'FAHREN = ready / engine running');
        const tr = rows.filter((r) => r.group === 'Trace');
        assert.ok(tr.length > 0 && tr.length <= 121, String(tr.length));
        assert.ok(tr.every((r) => /^\+\d+ ms$|^\.\.\.$/.test(r.label)), 'times from the run start');
        assert.ok(!tr.some((r) => /#1 to 12/.test(r.text)), 'nothing from before the run');
        assert.strictEqual(tr.filter((r) => r.state === 'odd').length > 0, true, 'rejects marked');
        const ten = new Debug(fakeLink({}), quiet, { car: () => ({ condition: 10 }) }).carRows();
        assert.strictEqual(ten[2].text, '10 = FAHREN: ready / engine running');
    }],
];
