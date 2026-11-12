'use strict';
/**
 * debug.js - the Debug page: fires a list of READ-ONLY requests at the engine unit (and asks which units are on
 * the bus) and keeps every answer as it came, so you can see what this car's DME answers.
 *
 * Everything goes through the app's ReadOnlyDiag (kit/readonly-diag.js): UDS 22 (read data by identifier),
 * OBD 01 / 09 (current data / vehicle information) and 22 F1 50 to all units. Nothing is written or coded.
 *
 *   const dbg = new Debug(link, log, { ecu: 0x12, extra: config.probe, tap: tap.stats, tapSince: tap.since, car: () => car });
 *   (tap: what the transport said, tap.js; car(): { engine, tankL } from the car's own signals)
 *   dbg.run();          // in the background; dbg.rows fill in as answers arrive, dbg.running / dbg.done
 *
 * A run, in this order, so that one run tells where an answer gets lost:
 *   1. the link, the car's own signals (engine running?), and how the app was set up on this unit: what the
 *      installer left out (kit/missing-interfaces.json), whether the app's generated interface config and access
 *      list have the transport's request method and its response broadcast, and whether the app subscribed to it;
 *   2. 22 F150 to all units (does anything answer at all?);
 *   3. the VIN from four other units (gateway, body, cluster, the head unit itself): the transport against the DME;
 *   4. the DME's requests.
 * A unit that gives no reply to giveUpAfter requests in a row (asleep) has its other requests skipped. When the kit
 * says "no reply" but the transport did send something during that request (tap.js), the row shows it ('odd').
 *
 * A row: { group, label, req, state: 'wait' | 'ok' | 'nrc' | 'none' | 'odd' | 'error' | 'info', text }
 */
const fs = require('fs');
const path = require('path');
const { hex, NRC } = require('./kit/diag');
const { withAlpha } = require('./kit/canvas');
const { tally } = require('./tap');

const pct = (b) => (b * 100 / 255).toFixed(1) + ' %';
const ascii = (bytes) => bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
const u16 = (b) => b[0] * 256 + b[1];
/** raw data bytes, and the first byte as a percentage (an ethanol content would read 0..100 %) */
const raw = (b) => b.length + ' bytes, 1st = ' + pct(b[0]);

/** OBD supported-PID bitmap (PIDs base+1 .. base+0x20): which of the PIDs we care about are flagged. */
function supported(base, want) {
    return (b) => {
        if (b.length < 4) return 'short';
        const has = want.filter((p) => p > base && p <= base + 0x20).map((p) => {
            const i = p - base - 1;
            return hex(p) + (b[i >> 3] & (0x80 >> (i & 7)) ? ' yes' : ' no');
        });
        return 'PIDs ' + hex(base + 1) + '-' + hex(base + 0x20) + (has.length ? ': ' + has.join(', ') : '');
    };
}
const WANT = [0x0C, 0x2F, 0x51, 0x52];
const FUEL_TYPE = { 1: 'petrol', 2: 'methanol', 3: 'ethanol', 4: 'diesel', 5: 'LPG', 6: 'CNG', 8: 'electric', 9: 'bifuel petrol', 0x0A: 'bifuel methanol', 0x0B: 'bifuel ethanol', 0x11: 'hybrid petrol', 0x13: 'hybrid diesel' };

/*
 * The requests. did = UDS 22 identifier, obd = OBD service 01 PID, vin = OBD 09 PID. decode(data bytes after
 * the echo) -> text. The BMW identifiers and scalings are the DME8FF_R (B58 / S58 MG1) ones from the upstream
 * kit's Live Data catalog (github.com/cauliflowermossgrape/idrive7-apps, MIT); another DME may use other numbers,
 * which is what this page is for. F4xx = the OBD PID xx read through UDS (ISO 27145).
 */
const PROBES = [
    ['Other units', 'Gateway ZGW (10): VIN', { ecu: 0x10, did: 0xF190, decode: ascii }],
    ['Other units', 'Body BDC (40): VIN', { ecu: 0x40, did: 0xF190, decode: ascii }],
    ['Other units', 'Cluster KOMBI (60): VIN', { ecu: 0x60, did: 0xF190, decode: ascii }],
    ['Other units', 'Head unit (63): VIN', { ecu: 0x63, did: 0xF190, decode: ascii }],
    // the chassis / powertrain FlexRay units: on the first car tried none of them (nor the DME) answered 22 F150,
    // while the body and PT-CAN units did. One answering here and not the DME points at the DME, none at the route.
    ['FlexRay units', 'Stability DSC (29): VIN', { ecu: 0x29, did: 0xF190, decode: ascii }],
    ['FlexRay units', 'Steering EPS (30): VIN', { ecu: 0x30, did: 0xF190, decode: ascii }],
    ['FlexRay units', 'Airbag ACSM (01): VIN', { ecu: 0x01, did: 0xF190, decode: ascii }],
    ['FlexRay units', 'DME 2 (13): VIN', { ecu: 0x13, did: 0xF190, decode: ascii }],
    // a unit may take up to 10 s (BMW's own tools wait that long): the first DME request gets it
    ['DME identity', 'VIN (waits 10 s)', { did: 0xF190, decode: ascii, timeoutMs: 10000 }],
    ['DME identity', 'SGBD index (DME type)', { did: 0xF150, decode: (b) => (b.length >= 3 ? hex(((b[0] << 16) | (b[1] << 8) | b[2]) >>> 0, 6) : 'short') }],
    ['Ethanol', 'BMW alcohol in fuel (550D)', { did: 0x550D, decode: (b) => pct(b[0]) + (b.length > 1 ? '  (2 bytes: ' + u16(b) + ')' : '') }],
    ['Ethanol', 'OBD 52 through UDS (F452)', { did: 0xF452, decode: (b) => pct(b[0]) }],
    ['Ethanol', 'OBD 01 PID 52', { obd: 0x52, decode: (b) => pct(b[0]) }],
    ['Ethanol', 'Fuel type, UDS (F451)', { did: 0xF451, decode: (b) => hex(b[0]) + ' ' + (FUEL_TYPE[b[0]] || '?') }],
    ['Ethanol', 'Fuel type, OBD 01 PID 51', { obd: 0x51, decode: (b) => hex(b[0]) + ' ' + (FUEL_TYPE[b[0]] || '?') }],
    ['Ethanol', 'Fuel quality adapted (5776)', { did: 0x5776, decode: (b) => (b[0] / 256).toFixed(3) + ' (0 = RON98, 1 = RON91)' }],
    ['Ethanol', 'Fuel + ethanol in oil (593A)', { did: 0x593A, decode: (b) => (u16(b) * 0.02133333).toFixed(1) + ' g' }],
    ['Tank', 'Tank level (583B)', { did: 0x583B, decode: (b) => b[0] + ' l' }],
    ['Tank', 'Left tank half (5949)', { did: 0x5949, decode: (b) => (b[0] * 0.5).toFixed(1) + ' l' }],
    ['Tank', 'Right tank half (594A)', { did: 0x594A, decode: (b) => (b[0] * 0.5).toFixed(1) + ' l' }],
    ['Tank', 'Fuel level, UDS (F42F)', { did: 0xF42F, decode: (b) => pct(b[0]) }],
    ['Tank', 'Fuel level, OBD 01 PID 2F', { obd: 0x2F, decode: (b) => pct(b[0]) }],
    ['Engine', 'RPM, UDS (F40C)', { did: 0xF40C, decode: (b) => (u16(b) / 4) + ' rpm' }],
    ['Engine', 'RPM, OBD 01 PID 0C', { obd: 0x0C, decode: (b) => (u16(b) / 4) + ' rpm' }],
    ['Engine', 'Coolant, OBD 01 PID 05', { obd: 0x05, decode: (b) => (b[0] - 40) + ' C' }],
    ['Engine', 'Fuel temperature (4AD5)', { did: 0x4AD5, decode: (b) => (b[0] * 0.75 - 48).toFixed(1) + ' C' }],
    ['Engine', 'Fuel flow (5656)', { did: 0x5656, decode: (b) => (u16(b) * 0.00119209).toFixed(2) + ' ml/s' }],
    ['Engine', 'Fuel mass flow (4521)', { did: 0x4521, decode: (b) => (u16(b) * 0.1).toFixed(1) + ' kg/h' }],
    ['Supported', 'UDS F400', { did: 0xF400, decode: supported(0x00, WANT) }],
    ['Supported', 'UDS F420', { did: 0xF420, decode: supported(0x20, WANT) }],
    ['Supported', 'UDS F440', { did: 0xF440, decode: supported(0x40, WANT) }],
    ['Supported', 'OBD 01 PID 00', { obd: 0x00, decode: supported(0x00, WANT) }],
    ['Supported', 'OBD 01 PID 20', { obd: 0x20, decode: supported(0x20, WANT) }],
    ['Supported', 'OBD 01 PID 40', { obd: 0x40, decode: supported(0x40, WANT) }],
    ['DME identity', 'VIN, OBD 09 PID 02', { vin: 0x02, decode: (b) => ascii(b.slice(1)) }],
    // the identifiers MHD's own app reads from the DME (upstream Engine Config's README, from captures of an MG1 with
    // MHD): one of them may carry the flex fuel kit's ethanol content. Shown raw.
    ['MHD reads', 'MHD 3010', { did: 0x3010, decode: raw }],
    ['MHD reads', 'MHD 3020', { did: 0x3020, decode: raw }],
    ['MHD reads', 'MHD 3030', { did: 0x3030, decode: raw }],
    ['MHD reads', 'MHD 3031', { did: 0x3031, decode: raw }],
    ['MHD reads', 'MHD 3032', { did: 0x3032, decode: raw }],
    ['MHD reads', 'MHD 37FE', { did: 0x37FE, decode: raw }],
    ['MHD reads', 'MHD 586A', { did: 0x586A, decode: raw }],
    ['MHD reads', 'MHD 4098', { did: 0x4098, decode: raw }],
];

const idx = (b) => (b.length >= 3 ? hex(((b[0] << 16) | (b[1] << 8) | b[2]) >>> 0, 6) : 'short');

/*
 * The reads upstream's Engine Config makes for its xDrive tab (apps/live_adjustments/xdrive.js), the same bytes at its
 * pace (2 s timeout, one every 4 s), sent first, on a quiet link: its owner reports it switches xDrive on this car,
 * which needs the DSC to answer the head unit. If these answer here too, the DME's silence is the DME's; if they
 * don't, while Engine Config's do, something this app does differs (its other traffic, its timing).
 */
const EC_PROBES = [
    ['Engine Config reads', 'DSC (29): type', { ecu: 0x29, did: 0xF150, decode: idx, timeoutMs: 2000, gapMs: 4000 }],
    ['Engine Config reads', 'DSC (29): xDrive DBE1', { ecu: 0x29, did: 0xDBE1, decode: (b) => b.map(hex).join(' ') + (b[0] ? ' (xDrive on)' : ' (off)'), timeoutMs: 2000, gapMs: 4000 }],
    ['Engine Config reads', 'Transfer case LMV (19): type', { ecu: 0x19, did: 0xF150, decode: idx, timeoutMs: 2000, gapMs: 4000 }],
    ['Engine Config reads', 'LMV (19): front torque DB32', { ecu: 0x19, did: 0xDB32, decode: (b) => b.map(hex).join(' '), timeoutMs: 2000, gapMs: 4000 }],
    ['Engine Config reads', 'DME (12): type, same pace', { ecu: 0x12, did: 0xF150, decode: idx, timeoutMs: 2000, gapMs: 4000 }],
];

/* The other apps whose logs show their own DME / DSC exchanges on this unit (kit/runtime/mgu.js: data/<id>.log). */
const OTHER_LOGS = [
    ['live_adjustments', 'Engine Config', /xdrive|DME ident|UDS ->|uds_result|link/i],
    ['live_data', 'Live Data', /DME|unit 12|22 |UDS|engine/i],
    ['car_vitals', 'M Vitals', /DME|UDS|boost|OBD/i],
    ['dtc_scanner', 'Fault Scanner', /scan|unit|UDS|19 02/i],
];

/** One log line made short: the time, and for Engine Config's JSON evidence its exchange in a few words. */
function shortLine(line) {
    const at = line.slice(11, 19), rest = line.replace(/^\S+\s+\S+\s+/, '');
    const j = rest.indexOf('{');
    if (/xdrive-diagnostic/.test(rest) && j >= 0) {
        try {
            const o = JSON.parse(rest.slice(j)), sn = o.snapshot || {};
            if (o.event === 'uds_result') return at + ' ' + o.target + ' ' + o.request + ' -> ' + o.status + (o.response ? ' ' + o.response : '') + ' (' + o.elapsedMs + ' ms)';
            return at + ' ' + o.event + ': DSC ' + (sn.dscIndex || '?') + ' ' + (sn.dscUnit || '') + ', supported ' + sn.supported + ', rpm ' + (sn.vehicle && sn.vehicle.rpm);
        } catch (e) { /* not JSON after all */ }
    }
    return at + ' ' + rest;
}

/* SGBD index -> DME type, for the DME's F150 answer (the DME entries of the upstream kit's sgbd_index, MIT). */
const DME_TYPES = {
    '0F1090': 'MSD85L6', '0F10A0': 'D73N57A0', '0F1370': 'MSD87', '0F1380': 'MSD87_R0', '0F13E0': 'MSV90', '0F13F0': 'MEVD172',
    '0F1740': 'D72N47A0', '0F1780': 'MSD85YL6', '0F17F0': 'MEVD1725', '0F1810': 'MEVD1724', '0F1910': 'MEVD172Y',
    '0F19E0': 'EDMEI1', '0F1A10': 'S63TU_R0', '0F1A20': 'N63TU_R0', '0F1EA0': 'S55', '0F2220': 'N55_ALP', '0F28E0': 'DME9FF_R',
};
['0F1D20', '0F1D22', '0F1D24', '0F1D26'].forEach((k) => { DME_TYPES[k] = 'DME_BX8'; });
['0F2422', '0F2424', '0F2426', '0F2427', '0F2428', '0F2429', '0F242A', '0F242C', '0F242E', '0F2460', '0F25A0', '0F25A2',
    '0F26B4', '0F26B8', '0F26BC', '0F26E0', '0F26E4', '0F26E8', '0F2930'].forEach((k) => { DME_TYPES[k] = 'DME8FF_R (B58/S58 MG1)'; });

/** An error as a short row text: the transport's refusals without their long prefix. */
const errText = (e) => String(e && e.message || e).replace(/^transport refused: (APP_REQUEST_)?/, 'head unit refused: ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* BMW's vehicle state (VehicleCondition.statusConditionVehicle), names as kit/runtime/car.js and Engine Config read them */
const CONDITION = {
    1: 'parked, battery low', 2: 'parked', 3: 'standby, nobody in', 5: 'WOHNEN: accessory, no ignition',
    7: 'PRUEFEN: ignition on, engine off', 8: 'getting ready', 10: 'FAHREN: ready / engine running', 12: 'ending ready',
    PARKEN_BN_NIO: 'parked, battery low', PARKEN_BN_IO: 'parked', STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 'standby, nobody in',
    WOHNEN: 'accessory, no ignition', PRUEFEN_ANALYSE_DIAGNOSE: 'ignition on, engine off', FAHRBEREITSCHAFT_HERSTELLEN: 'getting ready',
    FAHREN: 'ready / engine running', FAHRBEREITSCHAFT_BEENDEN: 'ending ready',
};

const label = (p) => (p.did != null ? '22 ' + hex(p.did, 4) : p.obd != null ? '01 ' + hex(p.obd) : '09 ' + hex(p.vin)) + (p.ecu != null ? ' @' + hex(p.ecu) : '');

const TASU = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const yes = (b) => (b ? 'yes' : 'NO');
/** A file's text, or null. */
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };

class Debug {
    constructor(link, log, opts) {
        this.link = link;
        this.log = log;
        this.ecu = (opts && opts.ecu) || 0x12;
        this.timeoutMs = (opts && opts.timeoutMs) || 3000;
        this.giveUpAfter = (opts && opts.giveUpAfter) || 4;     // no replies in a row before the DME is skipped
        this.tap = (opts && opts.tap) || null;
        this.tapSince = (opts && opts.tapSince) || null;
        // where the installed app's files are: kit/ next to this file, someipInterfaces/ two levels up (oap_<uid>/)
        this.kitDir = (opts && opts.kitDir) || path.join(__dirname, 'kit');
        this.ifaceDir = (opts && opts.ifaceDir) || path.resolve(__dirname, '..', '..', 'someipInterfaces');
        // the kit's second place for interface configs (kit/runtime/signals.js), and the manifest the installer got
        this.ifaceDir2 = (opts && opts.ifaceDir2) || path.resolve(__dirname, '..', 'someipdefs');
        this.manifestFile = (opts && opts.manifestFile) || path.resolve(__dirname, '..', 'manifest.json');
        // the unit's own SOME/IP interface catalog (what BMW's installer checks apps against: kit/tools/build.py)
        this.catalogFile = (opts && opts.catalogFile) || '/etc/oap/someip/someip-interfaces.json';
        this.catalogMaxParse = (opts && opts.catalogMaxParse) || 16 * 1024 * 1024;   // bytes parsed as JSON at most
        // where the installed apps are (oap_<uid>/ folders side by side): for the other apps' logs
        this.appsDir = (opts && opts.appsDir) || path.resolve(__dirname, '..', '..', '..');
        this.settleMs = opts && opts.settleMs != null ? opts.settleMs : 5000;          // quiet before the first request
        this.ecProbes = (opts && opts.ecProbes) || EC_PROBES;
        this.ecGapMs = opts && opts.ecGapMs != null ? opts.ecGapMs : null;            // tests: no 4 s gaps
        this.car = (opts && opts.car) || (() => ({}));
        this.discoverOpts = (opts && opts.discover) || { idleMs: 3000, maxMs: 15000 };
        const extra = ((opts && opts.extra) || []).filter((c) => c && c.did).map((c) => ['Your probes', 'config.probe ' + c.did, { did: parseInt(c.did, 16), decode: (b) => b.length + ' bytes' }]);
        this.probes = PROBES.concat(extra);
        this.rows = [];
        this.running = false;
        this.done = 0;
        this.startedAt = 0;
        this.endedAt = 0;
    }

    /** steps of a run: Engine Config's reads, the bus discovery, then every request */
    get total() { return this.ecProbes.length + this.probes.length + 1; }

    /** The link's own state, as a row. */
    linkRow() {
        const l = this.link, yes = (b) => (b ? 'yes' : 'no');
        const text = 'ready ' + yes(l.ready) + ', available ' + yes(l.available) + (l.error ? ', ' + l.error : '');
        return { group: 'Link', label: 'Diagnostic link', req: '', state: l.ready ? 'info' : 'error', text };
    }

    /** The engine and the fuel level as the car's own signals give them (no diagnostic request). */
    carRows() {
        const c = this.car() || {};
        const eng = c.engine == null ? 'no signal yet' : c.engine;
        return [
            { group: 'Car', label: 'Engine (car signal)', req: 'CDS', state: c.engine === 'running' ? 'ok' : c.engine == null ? 'none' : 'error',
                text: eng + (c.engine === 'running' ? '' : c.engine == null ? '' : ': the DME may not answer') },
            { group: 'Car', label: 'Fuel level (cluster)', req: 'KombiIF', state: c.tankL == null ? 'none' : 'ok',
                text: c.tankL == null ? 'no signal yet' : c.tankL + ' l' },
            { group: 'Car', label: 'Vehicle state', req: 'VehCond', state: c.condition == null ? 'none' : 'info',
                text: c.condition == null ? 'no signal yet' : String(c.condition) + (CONDITION[c.condition] ? ' = ' + CONDITION[c.condition] : '') },
        ];
    }

    /**
     * How the app was set up on this unit, as rows: what the installer left out because this unit's firmware lacks
     * it, whether the generated interface config and access list carry the transport's request and response, and
     * whether the app subscribed to the response.
     */
    setupRows() {
        const rows = [];
        const missing = readText(path.join(this.kitDir, 'missing-interfaces.json'));
        let m = null;
        try { m = missing ? JSON.parse(missing) : {}; } catch (e) { m = null; }
        const keys = m ? Object.keys(m) : [];
        rows.push({ label: 'Left out at install', req: 'build',
            state: m === null ? 'error' : keys.some((k) => /Tasu/i.test(k)) ? 'error' : keys.length ? 'odd' : 'ok',
            text: m === null ? 'unreadable: ' + missing.slice(0, 60) : keys.length ? keys.join(' | ') : 'nothing' });
        let man = null;
        try { man = JSON.parse(readText(this.manifestFile)); } catch (e) { man = null; }
        const mt = man && man.proxies && man.proxies[TASU];
        rows.push({ label: 'Manifest as built', req: 'build', state: mt && /sendTasuResponse/.test(JSON.stringify(mt)) ? 'ok' : 'error',
            text: !man ? 'no ' + this.manifestFile : !mt ? 'TASU not in it' : 'instances ' + JSON.stringify(mt.instances) +
                ', methods ' + JSON.stringify(mt.methods || []) + ', broadcasts ' + JSON.stringify(mt.broadcasts || []) });
        const cfgName = TASU.replace(/\./g, '_') + '.json';
        let cfgFile = path.join(this.ifaceDir, cfgName);
        let cfg = readText(cfgFile);
        if (cfg === null && readText(path.join(this.ifaceDir2, cfgName)) !== null) { cfgFile = path.join(this.ifaceDir2, cfgName); cfg = readText(cfgFile); }
        rows.push({ label: 'TASU interface config', req: 'config', state: cfg && /sendTasuRequest/.test(cfg) && /sendTasuResponse/.test(cfg) ? 'ok' : 'error',
            text: cfg === null ? 'no file ' + cfgFile : 'request ' + yes(/sendTasuRequest/.test(cfg)) + ', response ' + yes(/sendTasuResponse/.test(cfg)) + ' (' + cfg.length + ' bytes)' });
        const acl = readText(path.join(this.ifaceDir, 'acl.json'));
        rows.push({ label: 'TASU access list', req: 'acl', state: acl && /InternalTasu/.test(acl) ? 'info' : 'error',
            text: acl === null ? 'no acl.json' : 'TASU ' + yes(/InternalTasu/.test(acl)) + ', request ' + yes(/sendTasuRequest/.test(acl)) + ', response ' + yes(/sendTasuResponse/.test(acl)) + ' (' + acl.length + ' bytes)' });
        let files = null;
        try { files = fs.readdirSync(this.ifaceDir).filter((f) => /\.json$/.test(f) && f !== 'acl.json'); } catch (e) { files = null; }
        rows.push({ label: 'Interfaces generated', req: 'config', state: files && files.length ? 'info' : 'error',
            text: files === null ? 'no folder ' + this.ifaceDir : files.length + ': ' + files.map((f) => f.replace(/\.json$/, '').split('_').slice(-1)[0]).join(', ') });
        if (this.tap) {
            const sub = this.tap.subscribed;
            rows.push({ label: 'Response subscription', req: 'TASU', state: sub === 'yes' ? 'ok' : 'error', text: String(sub) });
        }
        return rows.map((r) => Object.assign({ group: 'Setup' }, r));
    }

    /**
     * The unit's interface catalog, as rows: what it lists for the diagnostic transport (methods, events, instances),
     * other diagnostic-looking interfaces, and every name or text in it that looks like ethanol / fuel quality - a
     * car signal the app could subscribe to (as the cluster's fuel level) where the DME cannot be asked.
     */
    catalogRows() {
        const rows = [], push = (label, text, state) => rows.push({ group: 'Catalog', label, req: 'catalog', state: state || 'info', text });
        const RX = /ethanol|alcohol|alkohol|flex.?fuel|e85|fuel.?qual|fuel.?type|fuel.?compos|kraftstoff.?(qual|art)|krst/i;
        let size = -1;
        try { size = fs.statSync(this.catalogFile).size; } catch (e) { /* reported below */ }
        if (size > this.catalogMaxParse) {
            // too big to parse safely in the app's memory: scan its text for the names only
            const big = readText(this.catalogFile) || '';
            const found = [], re = /"([^"]{1,120})"/g;
            let m;
            while ((m = re.exec(big)) && found.length < 200) { if (RX.test(m[1]) && found.indexOf(m[1]) < 0) found.push(m[1]); }
            push('Unit catalog', size + ' bytes: too big to parse here, names scanned only');
            push('Ethanol / fuel names', found.length ? found.length + ' found (all in the log)' : 'none in the catalog', found.length ? 'ok' : 'none');
            found.slice(0, 12).forEach((h, i) => push('match ' + (i + 1), h));
            found.forEach((h) => this.log.info('debug catalog match: ' + h));
            return rows;
        }
        const txt = readText(this.catalogFile);
        if (txt === null) { push('Unit catalog', 'cannot read ' + this.catalogFile, 'error'); return rows; }
        let db;
        try { db = JSON.parse(txt); } catch (e) { push('Unit catalog', 'not JSON: ' + (e && e.message || e), 'error'); return rows; }
        const ifs = (db && db.interfaces) || {}, ids = (db && db.instanceIDs) || {};
        const names = (x) => (!x ? [] : Array.isArray(x) ? x.map((e) => (e && typeof e === 'object' ? e.name : e)).filter(Boolean) : Object.keys(x));
        const short = (k) => k.split('.').slice(-1)[0];
        push('Unit catalog', Object.keys(ifs).length + ' interfaces (' + txt.length + ' bytes)');
        const t = ifs[TASU];
        push('TASU in the catalog', t ? 'methods ' + (names(t.methods).join(' ') || '-') + ' | events ' + (names(t.events).join(' ') || '-') +
            ' | instances ' + (Object.keys(ids[TASU] || {}).join(' ') || '-') : 'not listed', t ? 'info' : 'error');
        const diag = Object.keys(ifs).filter((k) => k !== TASU && /tasu|diag|uds|obd|tester/i.test(k));
        push('Other diagnostic interfaces', diag.length ? diag.map(short).join(', ') : 'none');
        // names / texts that look like an ethanol or fuel quality signal, anywhere in the catalog
        const hits = [];
        const walk = (v, at, depth) => {
            if (hits.length >= 200 || depth > 12 || v === null || typeof v !== 'object') return;
            Object.keys(v).forEach((k) => {
                const x = v[k], here = at + (Array.isArray(v) ? '[' + k + ']' : '.' + k);
                if (!Array.isArray(v) && RX.test(k)) hits.push(here);
                if (typeof x === 'string' && RX.test(x)) hits.push(here + ' = ' + x);
                walk(x, here, depth + 1);
            });
        };
        Object.keys(ifs).forEach((k) => walk(ifs[k], short(k), 0));
        push('Ethanol / fuel names', hits.length ? hits.length + (hits.length >= 200 ? '+' : '') + ' found (all in the log)' : 'none in the catalog', hits.length ? 'ok' : 'none');
        hits.slice(0, 12).forEach((h, i) => push('match ' + (i + 1), h));
        hits.forEach((h) => this.log.info('debug catalog match: ' + h));
        return rows;
    }

    /**
     * The last DME / DSC exchanges of the other apps on this unit, from their logs (data/<id>.log in each
     * oap_<uid>/), where this app may read them: Engine Config's xDrive evidence in particular.
     */
    otherLogRows() {
        const rows = [], push = (label, text, state) => rows.push({ group: 'Other apps', label, req: 'log', state: state || 'info', text });
        let dirs;
        try { dirs = fs.readdirSync(this.appsDir).filter((d) => /^oap_/.test(d)); } catch (e) {
            push('Other apps', 'cannot list ' + this.appsDir + ': ' + (e && e.code || e), 'error');
            return rows;
        }
        OTHER_LOGS.forEach((o) => {
            let file = null;
            dirs.forEach((d) => { const f = path.join(this.appsDir, d, 'data', o[0] + '.log'); try { fs.accessSync(f); file = f; } catch (e) { /* not this one */ } });
            if (!file) return;
            let text = null, why = '';
            try {
                const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, n = Math.min(size, 96 * 1024), buf = Buffer.alloc(n);
                fs.readSync(fd, buf, 0, n, size - n);
                fs.closeSync(fd);
                text = buf.toString('utf8');
            } catch (e) { why = String(e && e.code || e); }
            if (text === null) { push(o[1], 'log there, cannot read it: ' + why, 'error'); return; }
            const lines = text.split('\n').filter((l) => o[2].test(l));
            push(o[1], lines.length + ' matching lines in the last ' + Math.round(text.length / 1024) + ' KB of its log', lines.length ? 'ok' : 'none');
            lines.slice(-6).forEach((l) => { push('  ' + o[1], shortLine(l)); this.log.info('debug ' + o[1] + ' log: ' + l.slice(0, 400)); });
        });
        if (!rows.length) push('Other apps', 'no Engine Config / Live Data / M Vitals / Fault Scanner log found in ' + dirs.length + ' app folders', 'none');
        return rows;
    }

    /** The run's request trace (tap.js): each request, its verdict and each response, with ms from the run's start. */
    traceRows() {
        const t = this.tap;
        if (!t || !t.trace) return [];
        const mine = t.trace.filter((e) => e.at >= this.startedAt);
        const rows = mine.map((e) => ({ group: 'Trace', label: '+' + (e.at - this.startedAt) + ' ms', req: e.dir === '>' ? 'sent' : e.dir === '=' ? 'verdict' : 'heard',
            state: e.dir === '<' ? (/^from/.test(e.text) ? 'ok' : 'odd') : 'info', text: e.text }));
        mine.forEach((e) => this.log.info('debug trace +' + (e.at - this.startedAt) + ' ' + e.dir + ' ' + e.text));
        return rows.length > 120 ? rows.slice(0, 60).concat([{ group: 'Trace', label: '...', req: '', state: 'info', text: (rows.length - 120) + ' more in the log' }], rows.slice(-60)) : rows;
    }

    /** What the transport said since the app started (tap.js), as rows. */
    transportRows() {
        const t = this.tap;
        if (!t) return [];
        const rows = [
            { label: 'Head unit took', text: t.requests + ' requests: ' + tally(t.verdicts) + (Object.keys(t.callErrors).length ? ' | call errors: ' + tally(t.callErrors) : '') },
            { label: 'Responses heard', text: t.responses + (t.responses ? ': ' + (Object.keys(t.frames).length ? 'from ' + tally(t.frames) : 'no replies from a unit') : ' - nothing came back from the head unit') },
            { label: 'Transport errors', text: tally(t.errors) },
            { label: 'Transport rejects', text: tally(t.rejects) + (t.short ? ', short frames ' + t.short : '') },
        ].concat(t.last.map((x, i) => ({ label: 'Response -' + (t.last.length - i), text: x.kind + ': ' + x.bytes })));
        if (t.firstVerdict) rows.push({ label: 'First verdict (raw)', text: t.firstVerdict });
        return rows.map((r) => Object.assign({ group: 'Transport', req: 'TASU', state: 'info' }, r));
    }

    /** What the link has counted since the app started, as a row. */
    statsRow() {
        const l = this.link, s = l.stats || {};
        const text = 'sent ' + (s.sent || 0) + ', replies ' + (s.replies || 0) + ', missed ' + (s.missed || 0) + ', busy ' + (l.busy || 0);
        return { group: 'Link', label: 'Requests so far', req: '', state: 'info', text };
    }

    /** One request: the row with what came back. */
    async probe(p) {
        const row = { group: p[0], label: p[1], req: label(p[2]), state: 'wait', text: '...' };
        this.rows.push(row);
        const c = p[2], ecu = c.ecu != null ? c.ecu : this.ecu;
        const seq0 = this.tap ? this.tap.responses : 0;
        let sid, data, ok;
        if (c.did != null) { sid = 0x22; data = [c.did >> 8, c.did & 0xFF]; ok = (u) => u[0] === 0x62 && ((u[1] << 8) | u[2]) === c.did; }
        else if (c.obd != null) { sid = 0x01; data = [c.obd]; ok = (u) => u[0] === 0x41 && u[1] === c.obd; }
        else { sid = 0x09; data = [c.vin]; ok = (u) => u[0] === 0x49 && u[1] === c.vin; }
        const accept = (u) => ok(u) || (u[0] === 0x7F && u[1] === sid);
        if (typeof this.link.wake === 'function') this.link.wake(ecu);      // the debug run asks every time
        const t0 = Date.now();
        let uds;
        try { uds = await this.link.physical(ecu, sid, data, c.timeoutMs || this.timeoutMs, accept); } catch (e) {
            row.state = 'error'; row.text = errText(e); return row;
        }
        const ms = Date.now() - t0;
        if (!uds) {
            // the kit took nothing as the reply: did the transport send anything meanwhile?
            const heard = this.tapSince ? this.tapSince(seq0) : [];
            if (heard.length) {
                row.state = 'odd';
                row.text = 'no reply, but ' + heard.length + ' came: ' + heard[0].kind + ': ' + heard[0].bytes;
            } else { row.state = 'none'; row.text = 'no reply (' + ms + ' ms)'; }
            return row;
        }
        const bytes = uds.map((x) => hex(x)).join(' ');
        if (uds[0] === 0x7F) { row.state = 'nrc'; row.text = 'NRC ' + hex(uds[2]) + (NRC[uds[2]] ? ' ' + NRC[uds[2]] : ''); return row; }
        const body = uds.slice(sid === 0x22 ? 3 : 2);
        let dec;
        try { dec = body.length ? c.decode(body) : 'empty'; } catch (e) { dec = 'decode: ' + (e && e.message || e); }
        row.state = 'ok';
        row.text = dec + '  [' + (bytes.length > 26 ? bytes.slice(0, 24) + '..' : bytes) + ']';
        row.bytes = bytes;
        return row;
    }

    /** 22 F1 50 to all units: which units answer, and the DME's type. */
    async discover() {
        const row = { group: 'Bus', label: 'Units answering 22 F150', req: '22 F150 all', state: 'wait', text: 'asking (up to 15 s)...' };
        this.rows.push(row);
        if (typeof this.link.discover !== 'function') { row.state = 'error'; row.text = 'link cannot discover'; return row; }
        let units;
        try { units = await this.link.discover(this.discoverOpts); } catch (e) { row.state = 'error'; row.text = errText(e); return row; }
        if (!units || !units.size) { row.state = 'none'; row.text = 'no unit answered'; return row; }
        const addrs = Array.from(units.keys()).sort((a, b) => a - b);
        const dme = units.get(this.ecu);
        row.state = 'ok';
        row.text = addrs.length + ' units; DME ' + hex(this.ecu) + (units.has(this.ecu) ? ' ' + (dme || 'refused') + (DME_TYPES[dme] ? ' = ' + DME_TYPES[dme] : '') : ' NOT among them');
        row.all = addrs.map((a) => hex(a) + (units.get(a) ? ':' + units.get(a) : '')).join(' ');
        // every unit with its SGBD index, five to a row
        for (let i = 0; i < addrs.length; i += 5) {
            this.rows.push({ group: 'Bus', label: 'units ' + (i + 1) + '-' + Math.min(addrs.length, i + 5), req: '', state: 'info',
                text: addrs.slice(i, i + 5).map((a) => hex(a) + (units.get(a) ? ':' + units.get(a) : '')).join(' ') });
        }
        return row;
    }

    /** Run every request once, in turn (in the background: rows fill in). Resolves with the rows. */
    async run() {
        if (this.running) return this.rows;
        this.running = true;
        this.rows = [];
        this.done = 0;
        this.startedAt = Date.now();
        this.endedAt = 0;
        try {
            const lr = this.linkRow();
            this.rows.push(lr);
            this.carRows().concat(this.setupRows(), this.otherLogRows(), this.catalogRows()).forEach((r) => { this.rows.push(r); this.log.info('debug ' + r.label + ': ' + r.text); });
            if (!this.link.ready) {
                lr.state = 'error';
                lr.text = 'diagnostic link not ready' + (this.link.error ? ': ' + this.link.error : '') + ' - nothing sent';
                this.transportRows().forEach((r) => this.rows.push(r));
                return this.rows;
            }
            // a quiet link first (the app's own reads are paused while a run lasts), then Engine Config's reads at its pace
            if (this.settleMs) { this.settling = true; await sleep(this.settleMs); this.settling = false; }
            for (const p of this.ecProbes) {
                const r = await this.probe(p);
                this.done++;
                this.log.info('debug ' + r.req + ' ' + r.label + ': ' + r.text);
                const gap = this.ecGapMs != null ? this.ecGapMs : p[2].gapMs;
                if (gap) await sleep(gap);
            }
            const d = await this.discover();
            this.done++;
            this.log.info('debug ' + d.label + ': ' + d.text + (d.all ? ' | ' + d.all : ''));
            const silent = {}, skipped = {};
            const ecuOf = (p) => (p[2].ecu != null ? p[2].ecu : this.ecu);
            for (let i = 0; i < this.probes.length; i++) {
                const ecu = ecuOf(this.probes[i]);
                if (skipped[ecu]) { this.done++; continue; }
                const r = await this.probe(this.probes[i]);
                this.done++;
                this.log.info('debug ' + r.req + ' ' + r.label + ': ' + r.text);
                // silence: no reply, or the head unit turning the request away (a transport reject / error, as
                // 7F 31 25 for the DME on the first car tried)
                const quiet = r.state === 'none' || (r.state === 'odd' && /^no reply, but \d+ came: (rejected|error)/.test(r.text));
                silent[ecu] = quiet ? (silent[ecu] || 0) + 1 : 0;
                const left = this.probes.slice(i + 1).filter((p) => ecuOf(p) === ecu).length;
                if (silent[ecu] >= this.giveUpAfter && left) {
                    skipped[ecu] = true;
                    const who = ecu === this.ecu ? 'DME' : 'Unit ' + hex(ecu);
                    this.rows.push({ group: who, label: 'Skipped ' + left + ' requests', req: '', state: 'error',
                        text: who + ' gave no reply (or was turned away) ' + silent[ecu] + ' times in a row' + ((this.car() || {}).engine === 'running' ? ' with the engine running: see Transport' : ': engine off / asleep?') });
                    this.log.info('debug: ' + who + ' silent ' + silent[ecu] + ' times in a row, ' + left + ' requests skipped');
                }
            }
            const end = this.statsRow();
            this.rows.push(end);
            this.log.info('debug link: ' + this.linkRow().text + ' | ' + end.text);
            this.transportRows().forEach((r) => { this.rows.push(r); this.log.info('debug ' + r.label + ': ' + r.text); });
            this.traceRows().forEach((r) => this.rows.push(r));
        } finally {
            this.running = false;
            this.endedAt = Date.now();
        }
        return this.rows;
    }
}

/** Text cut to fit maxW (with '..'), drawn as is (no translation lookup). Returns its width. */
function fitText(cv, str, x, y, size, color, maxW, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    let s = String(str);
    if (cv.textWidth(s, size, o) > maxW) {
        while (s.length > 1 && cv.textWidth(s + '..', size, o) > maxW) s = s.slice(0, -1);
        s += '..';
    }
    return cv.text(s, x, y, size, color, o);
}

const GO = '#2fd27a';
const PER_COL = 17;

/** The Debug page's content (under the page's tab bar): two columns of 17 rows (request, what it reads, the answer). */
function drawDebug(cv, t, dbg, pageNo) {
    const W = cv.w;
    const rows = dbg.rows.length ? dbg.rows : [dbg.linkRow()];
    const perPage = PER_COL * 2, pages = Math.max(1, Math.ceil(rows.length / perPage)), page = (pageNo || 0) % pages;
    const head = dbg.settling ? 'Letting the link go quiet (5 s) ...' : dbg.running ? 'Running ' + dbg.done + ' / ' + dbg.total + ' ...'
        : dbg.endedAt ? 'Done in ' + Math.round((dbg.endedAt - dbg.startedAt) / 1000) + ' s. Take a photo of each page.'
            : 'Start the engine, then press Run all requests. Read-only: nothing is written.';
    fitText(cv, head, 24, 74, 20, dbg.running ? t.accent : t.text, W - 260, { font: 'bold' });
    cv.text('Page ' + (page + 1) + ' / ' + pages, W - 24, 74, 20, t.dim, { align: 'right', font: 'bold', literal: true });
    const colW = Math.floor((W - 72) / 2);
    rows.slice(page * perPage, (page + 1) * perPage).forEach((r, k) => {
        const x = 24 + (k >= PER_COL ? colW + 24 : 0), y = 106 + (k % PER_COL) * 24;
        if (k % 2 === 1) cv.fillRect(x - 4, y - 18, colW + 8, 24, withAlpha('#ffffff', 0.04));
        const c = r.state === 'ok' ? GO : r.state === 'nrc' || r.state === 'error' || r.state === 'odd' ? t.warn : r.state === 'none' || r.state === 'wait' ? t.dim : t.text;
        fitText(cv, r.req, x, y, 17, t.dim, 96);
        fitText(cv, r.label, x + 100, y, 17, t.text, 250);
        fitText(cv, r.text, x + 358, y, 17, c, colW - 358);
    });
    return cv;
}

module.exports = { Debug, PROBES, EC_PROBES, DME_TYPES, drawDebug, fitText, shortLine };
