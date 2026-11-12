'use strict';
/**
 * Ethanol - live ethanol content (E%) of the fuel, from the engine unit. Read only.
 *
 *   - big segmented bar 0-100 % with the target band marked (default E30-E50, set in Settings)
 *   - status: in / above / below the band
 *   - min / max since reset, 20-minute trend
 *   - details line: which identifier answered, raw bytes, or why nothing did
 *   - Fill-up page: how much E85 and how much 93 to add to fill the tank at a target E% (blend.js)
 *   - Debug page: a list of read-only requests to the DME and what each one answered (debug.js)
 *
 * One canvas screen with three pages (tabs): the kit's full-screen renderer runs one canvas screen, a second screen
 * opened over it fought it for the display. BTN_ACTION / BTN_ACTION2 do the page's two jobs (their labels follow the
 * page); BTN_PAGE turns the pages where the tabs cannot be touched (the kit hides it where they can).
 *
 * The value comes from the DME (ecu 0x12) with a read-only request (see reader.js, app.json config).
 * Without a car link the demo data runs (Settings > Demo data).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const Reader = require('./reader');
const Blend = require('./blend');
const { Debug, drawDebug, fitText } = require('./debug');
const { patient } = require('./patient');
const { tapSignals } = require('./tap');

const W = 1600, H = 520;
const GO = '#2fd27a';
const HIST_MS = 20 * 60 * 1000;
const TABS = ['Ethanol', 'Fill-up', 'Debug'];
const ETHANOL = 0, FILL = 1, DEBUG = 2;
// statusEngineStatus.statusEngineRunDrive (as the upstream Live Data app reads it)
const ENGINE = { MOTOR_AUS: 'off', MOTOR_STARTET: 'starting', MOTOR_LAEUFT: 'running', 0: 'off', 1: 'starting', 2: 'running' };

const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };

// The platform treats a crash as a fault (first crash wipes the app's data, the second uninstalls it), so every
// callback goes through guard(): an error is logged, never thrown.
const guard = (log, name, fn) => function () {
    try {
        const r = fn.apply(this, arguments);
        if (r && typeof r.catch === 'function') return r.catch((e) => { log.warn(name + ': ' + (e && e.message || e)); });
        return r;
    } catch (e) { log.warn(name + ': ' + (e && e.message || e)); return undefined; }
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // the read-only link, tried again while the head unit's transport is busy (patient.js), over signals that
        // count what the transport says for the Debug page (tap.js: everything passes unchanged)
        const tap = tapSignals(ctx.signals);
        const link = patient(new ReadOnlyDiag(tap.signals, log));
        const reader = new Reader(link, (ctx.spec && ctx.spec.config) || {});
        // connect in the background: the screen must not wait for the diagnostic link
        link.init().catch((e) => { log.warn('diagnostic link: ' + (e && e.message || e)); });

        let cur = null, curAt = 0;                  // last real value (%) and its steady-clock time
        let min = null, max = null;
        const hist = [];                            // [steady time, %] every 5 s
        let lastHist = 0, seenAt = 0, busy = false, lastWhy = '', pollTimer = null;
        let demoMode = null;                        // whether min / max / trend hold demo or real values
        let page = ETHANOL;
        // the car's own signals (no diagnostic request): engine state, and the fuel level from the instrument cluster
        const car = { engine: null, tankL: null, tankAt: 0, condition: null };
        ctx.signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: (v) => {
                const st = v && v.statusConditionVehicle;
                if (st !== undefined && st !== car.condition) log.info('vehicle state: ' + st);
                if (st !== undefined) car.condition = st;
            },
        }, log).then((r) => { if (r.error) log.warn('vehicle state signal: ' + r.error); }).catch((e) => log.warn('vehicle state signal: ' + e));
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineStatus: (v) => {
                const st = v && v.statusEngineRunDrive;
                const e = ENGINE[st] !== undefined ? ENGINE[st] : String(st);
                if (e !== car.engine) log.info('engine: ' + e + ' (' + st + ')');
                car.engine = e;
            },
        }, log).then((r) => { if (r.error) log.warn('engine signal: ' + r.error); }).catch((e) => log.warn('engine signal: ' + e));
        ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
            statusRangeTankStatus: (v) => {
                const l = v && v.fluidLevelFuelTank;
                if (typeof l === 'number' && l >= 0 && l < 255) { car.tankL = l; car.tankAt = Date.now(); }
            },
        }, log).then((r) => { if (r.error) log.warn('fuel level signal: ' + r.error); }).catch((e) => log.warn('fuel level signal: ' + e));
        // the Debug page's sendTasuRequestExt test (reads only: debug.js checks each request with readonly-diag's check)
        const ext = {
            call(params) {
                if (!tap.proxy) return Promise.reject(new Error('no transport proxy yet'));
                tap.trace('>', 'Ext to ' + (params.targetAddress & 0xFF).toString(16).toUpperCase() + ': 22 ' + Array.prototype.map.call(params.udsData, (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join(' '));
                return ctx.signals.call(tap.proxy, 'sendTasuRequestExt', params, 8000)
                    .then((v) => { tap.trace('=', 'Ext ' + JSON.stringify(v)); return v; }, (e) => { tap.trace('=', 'Ext call failed: ' + (e && e.message || e)); throw e; });
            },
            getField(name) {
                if (!tap.proxy) return Promise.reject(new Error('no transport proxy yet'));
                if (typeof tap.proxy.getValue !== 'function') return Promise.reject(new Error('the proxy has no getValue'));
                // from a fresh tick, as kit/runtime/signals.js reads fields (the native binding deadlocks inline)
                return new Promise((resolve) => setImmediate(resolve)).then(() => tap.proxy.getValue(name, 3000));
            },
            subscribe(name) {
                if (!tap.proxy) return Promise.reject(new Error('no transport proxy yet'));
                return ctx.signals.on(tap.proxy, name, (v) => { tap.trace('<', name + ' ' + JSON.stringify(v).slice(0, 200)); tap.hear(v); }, log);
            },
        };
        const dbg = new Debug(link, log, { ecu: reader.cfg.ecu, extra: reader.cfg.probe, tap: tap.stats, tapSince: tap.since, car: () => car, ext, dumpDir: ctx.dataDir });

        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !link.available);
        const demoValue = () => 38 + 9 * Math.sin(Date.now() / 9000) + 2 * Math.sin(Date.now() / 1700);
        /*
         * The E% entered by hand (Settings > Ethanol now, or the Ethanol page's -1 / +1): shown when the source is
         * "Entered by hand", or when the car gives no reading (Auto: the DME failed GIVE_UP rounds in a row, as on a car
         * whose head unit cannot reach it). It is never taken as a reading: no min / max / trend from it.
         */
        const GIVE_UP = 5, RETRY_MS = 10 * 60 * 1000;
        let lastPoll = 0, misses = 0;
        const entered = () => G.clamp(Number(settings.get('ethanolNow')) || 0, 0, 100);
        const fresh = () => cur !== null && mono() - curAt < 15000;
        const manualOn = () => !demoOn() && (settings.get('source') === 'manual' || (misses >= GIVE_UP && !fresh()));
        const value = () => (demoOn() ? demoValue() : fresh() ? cur : manualOn() ? entered() : null);
        function stepEntered(d) { settings.set('ethanolNow', G.clamp(entered() + d, 0, 100)); }

        // Demo and real values never mix: switching between them (e.g. demo until the car link is up) starts
        // min / max, the trend and the age of reading afresh.
        function useMode(demo) {
            if (demo === demoMode) return;
            if (demoMode !== null) log.info(demo ? 'demo data on: real values cleared' : 'demo data off: demo values cleared');
            demoMode = demo;
            cur = null; curAt = 0; min = null; max = null; hist.length = 0; lastHist = 0;
        }

        function take(v) {
            const m = mono();
            cur = v; curAt = m;
            min = min === null ? v : Math.min(min, v);
            max = max === null ? v : Math.max(max, v);
            if (m - lastHist > 5000) {
                lastHist = m; hist.push([m, v]);
                while (hist.length && m - hist[0][0] > HIST_MS) hist.shift();
            }
        }

        // poll about once a second while the screen is on, every 5 s just after it left (keeps the trend filling)
        async function poll() {
            if (busy) return;
            busy = true;
            try {
                reader.source = settings.get('source') || 'auto';
                useMode(demoOn());
                if (!demoOn() && settings.get('source') === 'manual') {
                    // entered by hand: the DME is not asked
                } else if (!demoOn() && link.ready) {
                    const s = await reader.poll();
                    if (s.value !== null) take(s.value);
                    else if (s.why !== lastWhy) { lastWhy = s.why; log.info('no ethanol value: ' + s.why); }
                    if (Date.now() - seenAt < 3000) await reader.probe(false);
                } else if (demoOn()) {
                    take(demoValue());
                }
            } catch (e) {
                log.warn('ethanol poll: ' + e);
            } finally { busy = false; }
        }
        // a Debug run has the link to itself (the transport takes one request at a time). The DME is asked at most every
        // 4 s, and only every 10 min once it failed GIVE_UP rounds in a row (back to every 4 s when it answers): each
        // unanswered request holds the head unit's transport 5-8 s (other apps' requests are turned away meanwhile)
        pollTimer = setInterval(guard(log, 'poll', () => {
            if (dbg.running || busy) return undefined;
            if (settings.get('source') === 'manual' && !demoOn()) return undefined;
            const every = misses >= GIVE_UP ? RETRY_MS : 4000;
            if (Date.now() - lastPoll < every) return undefined;
            lastPoll = Date.now();
            return poll().then(() => {
                const was = misses;
                misses = demoOn() || cur !== null && mono() - curAt < 6000 ? 0 : misses + 1;
                if (misses === GIVE_UP && was < GIVE_UP) log.info('DME gave no reading ' + GIVE_UP + ' rounds in a row: the entered E% is shown, the DME asked every 10 min');
                if (!misses && was >= GIVE_UP) log.info('DME answers again: readings shown');
            });
        }), 1000);
        if (pollTimer && pollTimer.unref) pollTimer.unref();


        function details() {
            if (demoOn()) return 'demo data - no car link';
            if (manualOn() && !fresh()) {
                return settings.get('source') === 'manual' ? 'Entered by hand: -1 / +1 below, or Settings > Ethanol now'
                    : 'No reading from the car: entered E% (-1 / +1 below); the DME is tried every 10 min';
            }
            const l = reader.last;
            const probes = reader.probes.filter((p) => p.bytes).map((p) => p.label + ' ' + p.bytes).join('   ');
            if (l.value !== null) return 'DME 0x' + reader.cfg.ecu.toString(16) + '  ' + l.source + '  [' + l.bytes + ']' + (probes ? '   ' + probes : '');
            if (link.ready && reader.silent()) return 'DME not answering - retrying every ' + Math.round(reader.cfg.wakeMs / 1000) + ' s';
            return (l.why || 'waiting for the diagnostic link') + (probes ? '   ' + probes : '');
        }

        /** Ethanol page: gauge, trend, status panel. */
        function drawEthanol(cv, t) {
            const v = value(), lo = settings.get('bandLow'), hi = Math.max(settings.get('bandHigh'), lo + 5);
            const room = G.pageBottom(cv) - G.BOTTOM, half = Math.round(room / 2);

            // ---- gauge
            G.segBar(cv, t, 24, G.TOP, 880, 225 + half, {
                label: 'Ethanol content', value: v, unit: '%', decimals: 0, min: 0, max: 100, step: 5, scale: { every: 25 },
                zones: [{ from: lo, to: hi, color: 'ok' }],
                marks: [{ value: lo, color: GO }, { value: hi, color: GO }],
            });

            // ---- trend
            const gp = G.panel(cv, t, 24, G.TOP + 242 + half, 880, 225 - half, 'Last 20 min');
            const gx = 52, gw = 824, gh = Math.max(60, gp.h - 96), gy = G.TOP + 242 + half + 58;
            const Y = (e) => gy + gh - G.clamp(e, 0, 100) / 100 * gh;
            cv.fillRect(gx, Y(hi), gw, Y(lo) - Y(hi), withAlpha(GO, 0.12));
            cv.fillRect(gx, gy + gh, gw, 1, withAlpha(t.tick, 0.5));
            [0, 50, 100].forEach((e) => cv.text(String(e), gx + gw + 4, Y(e) + 7, 18, t.dim));
            const m0 = mono(), X = (ts) => gx + gw - ((m0 - ts) / HIST_MS) * gw;
            const pts = hist.map((h) => [X(h[0]), Y(h[1])]).filter((p) => p[0] >= gx);
            if (pts.length > 1) cv.polyline(pts, 3, t.accent2 || t.accent);

            // ---- status panel
            G.panel(cv, t, 928, 44, 648, 468, null);
            let st, col;
            if (v === null) { st = 'NO DATA'; col = t.dim; }
            else if (v < lo) { st = 'BELOW BAND  E' + lo + '-E' + hi; col = t.warn; }
            else if (v > hi) { st = 'ABOVE BAND  E' + lo + '-E' + hi; col = t.warn; }
            else { st = 'IN BAND  E' + lo + '-E' + hi; col = GO; }
            cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.22));
            cv.text(st, 1252, 114, st.length > 16 ? 30 : 38, col, { align: 'center', font: 'bold', spacing: 3 });

            cv.text('ETHANOL', 952, 170, 22, t.dim, { font: 'bold', spacing: 1.5 });
            // the large number font has digits only: the E in bold beside it
            if (v === null) cv.text('--', 952, 275, 110, t.dim, { font: 'num' });
            else {
                const ew = cv.text('E', 952, 275, 60, t.dim, { font: 'bold' });
                const nw = cv.text(String(Math.round(v)), 964 + ew, 275, 130, t.text, { font: 'num' });
                cv.text('%', 976 + ew + nw, 275, 40, t.dim);
            }

            const row = (label, val, y) => {
                cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(val === null || val === undefined ? '--' : 'E' + Math.round(val), 1552, y + 2, 30, t.text, { align: 'right', font: 'bold' });
            };
            row('MIN SINCE RESET', min, 330);
            row('MAX SINCE RESET', max, 372);
            const ageS = curAt ? Math.round((mono() - curAt) / 1000) : null;
            cv.text('AGE OF READING', 952, 414, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(demoOn() ? 'demo' : manualOn() && !fresh() ? 'entered' : ageS === null ? '--' : ageS + ' s', 1552, 416, 30, t.text, { align: 'right', font: 'bold', literal: true });

            fitText(cv, details(), 952, 470, 20, t.dim, 600);
        }

        // ---------------- Fill-up calculator (BLEND)
        let tankAt = 0, tankBusy = false;
        function readTank() {
            if (tankBusy || demoOn() || !link.ready) return;
            tankBusy = true;
            reader.tank().catch((e) => { log.warn('tank: ' + (e && e.message || e)); }).then(() => { tankBusy = false; });
        }

        function stepTarget(dir) {
            const it = settings.item('blendTarget'), list = (it && it.steps) || [];
            if (!list.length) return;
            const i = list.indexOf(settings.get('blendTarget'));
            const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? list.indexOf(it.default) : i) + dir));
            settings.set('blendTarget', list[j]);
        }

        /** What the calculator works from: the car's readings where there are fresh ones, else Settings. */
        function blendInputs() {
            const tankL = Number(settings.get('tankSize')) || 59;
            let nowE, eFrom;
            if (!demoOn() && cur !== null && mono() - curAt < 10 * 60 * 1000) { nowE = cur; eFrom = 'read from the car (' + (reader.last.source || 'DME') + ')'; }
            else { nowE = entered(); eFrom = 'entered by hand (Ethanol page or Settings)'; }
            let nowL = null, lFrom;
            const fn = settings.get('fuelNow'), k = reader.lastTank, fresh = k.at && Date.now() - k.at < 2 * 60 * 1000;
            if (fn !== 'car') { nowL = Number(fn) * tankL; lFrom = 'from Settings'; }
            else if (car.tankL !== null && !demoOn()) { nowL = Math.min(tankL, car.tankL); lFrom = 'read from the car (instrument cluster)'; }
            else if (fresh && k.litres !== null) { nowL = Math.min(tankL, k.litres); lFrom = 'read from the car (' + k.source + ')'; }
            else if (fresh && k.pct !== null) { nowL = k.pct / 100 * tankL; lFrom = 'read from the car (' + k.source + ', ' + Math.round(k.pct) + ' % of the tank)'; }
            else if (demoOn()) lFrom = 'no car link: set Fuel in the tank now in Settings';
            else lFrom = k.at || (k.why && k.why !== 'not read yet') ? 'not read (' + k.why + '): set it in Settings' : 'reading...';
            return {
                tankL, nowL, nowE, eFrom, lFrom,
                targetE: Number(settings.get('blendTarget')), e85: Number(settings.get('e85Content')), pump: Number(settings.get('pumpContent')),
            };
        }

        /** Fill-up page: what the calculation starts from (left) and how much of each to add (right). */
        function drawFill(cv, t) {
            // the DME's tank level only where the cluster's fuel level signal has not come
            if (settings.get('fuelNow') === 'car' && car.tankL === null && Date.now() - tankAt > 30000 && !dbg.running) { tankAt = Date.now(); readTank(); }
            const inp = blendInputs(), gal = settings.get('volumeUnit') !== 'l', unit = gal ? 'gal' : 'l';
            const vol = (l) => (gal ? Blend.gallons(l) : l).toFixed(1);
            const p = inp.nowL === null ? null : Blend.plan(inp);

            // ---- left: what the calculation starts from
            G.panel(cv, t, 24, 44, 700, 468, null);
            const row = (label, val, from, y) => {
                cv.text(label, 48, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(val, 700, y + 2, 30, t.text, { align: 'right', font: 'bold', literal: true });
                if (from) fitText(cv, from, 48, y + 30, 18, t.dim, 652);
            };
            row('ETHANOL NOW', 'E' + Math.round(inp.nowE), inp.eFrom, 100);
            row('FUEL IN THE TANK', inp.nowL === null ? '--' : vol(inp.nowL) + ' ' + unit, inp.lFrom, 196);
            row('TANK SIZE', vol(inp.tankL) + ' ' + unit, 'Settings > Tank size', 292);
            row('E85 AT THE PUMP', 'E' + inp.e85, 'Settings > E85 at the pump is really', 388);
            row('93 AT THE PUMP', 'E' + inp.pump, null, 466);

            // ---- right: the answer
            G.panel(cv, t, 748, 44, 828, 468, null);
            cv.text('TARGET', 772, 100, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('E' + inp.targetE, 1552, 108, 48, t.accent, { align: 'right', font: 'bold', literal: true });
            fitText(cv, 'Target -5 / +5 in the bar below, or Settings > Fill-up target', 772, 132, 18, t.dim, 780);
            if (!p) {
                cv.text('--', 772, 280, 72, t.dim, { font: 'bold', literal: true });
                fitText(cv, 'Fuel in the tank unknown: ' + inp.lFrom, 772, 340, 22, t.warn, 780);
            } else {
                const amount = (label, l, y, color) => {
                    cv.text(label, 772, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
                    const w = cv.text(vol(l), 1460, y + 50, 72, color, { align: 'right', font: 'bold', literal: true });
                    cv.text(unit, 1472, y + 50, 30, t.dim, { literal: true });
                    return w;
                };
                amount('ADD E85', p.e85L, 190, p.e85L > 0.05 ? GO : t.dim);
                amount('ADD 93', p.pumpL, 300, p.pumpL > 0.05 ? t.text : t.dim);
                let msg, col;
                if (p.status === 'full') { msg = 'The tank is full: nothing to add.'; col = t.dim; }
                else if (p.status === 'low') { msg = 'All E85 only reaches E' + Math.round(p.highE) + ' when full.'; col = t.warn; }
                else if (p.status === 'high') { msg = 'Already above: all 93 still gives E' + Math.round(p.lowE) + '.'; col = t.warn; }
                else { msg = 'Fills the tank (' + vol(p.roomL) + ' ' + unit + ') at E' + Math.round(p.resultE) + '.'; col = GO; }
                fitText(cv, msg, 772, 440, 24, col, 780, { font: 'bold' });
                fitText(cv, 'Range when full: E' + Math.round(p.lowE) + ' (all 93) to E' + Math.round(p.highE) + ' (all E85)', 772, 476, 18, t.dim, 780);
            }
        }

        // ---------------- pages, tabs and the bar's two page buttons
        function runDebug() {
            if (dbg.running) return;
            dbgPage = 0;
            log.info('debug: run started');
            dbg.run().catch((e) => log.warn('debug run: ' + (e && e.message || e)));
        }
        let dbgPage = 0;

        const shown = {};
        /** Set a bar button's text when it changed (ui.text pushes it to the HMI). */
        function label(id, text) {
            if (shown[id] === text) return;
            shown[id] = text;
            ui.text(id, text);
        }
        function labels() {
            if (page === FILL) { label('BTN_ACTION', 'Target -5'); label('BTN_ACTION2', 'Target +5'); }
            else if (page === DEBUG) {
                label('BTN_ACTION', dbg.running ? 'Running ' + dbg.done + ' / ' + dbg.total : 'Run all requests');
                label('BTN_ACTION2', 'More rows');
            } else {
                const src = settings.get('source') || 'auto';
                if (manualOn() && !fresh()) { label('BTN_ACTION', 'E% -1'); label('BTN_ACTION2', 'E% +1'); return; }
                label('BTN_ACTION', 'Reset min / max');
                label('BTN_ACTION2', 'Source: ' + (src === 'auto' ? 'Auto' : src === 'manual' ? 'By hand' : src));
            }
        }
        function openPage(i) {
            if (!(i >= 0 && i < TABS.length)) return;
            page = i;
            log.info('page ' + TABS[page]);
            labels();
        }
        ui.onClick('BTN_ACTION', guard(log, 'action', () => {
            if (page === FILL) stepTarget(-1);
            else if (page === DEBUG) runDebug();
            else if (manualOn() && !fresh()) stepEntered(-1);
            else { min = cur; max = cur; hist.length = 0; }
            labels();
        }));
        ui.onClick('BTN_ACTION2', guard(log, 'action 2', () => {
            if (page === FILL) stepTarget(1);
            else if (page === DEBUG) dbgPage++;
            else if (manualOn() && !fresh()) stepEntered(1);
            else settings.cycle('source');
            labels();
        }));
        ui.onClick('BTN_PAGE', guard(log, 'next page', () => openPage((page + 1) % TABS.length)));
        if (ctx.onTab) ctx.onTab((i) => { openPage(i); });

        function render() {
            const t = ctx.theme();
            seenAt = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === FILL) drawFill(cv, t);
            else if (page === DEBUG) drawDebug(cv, t, dbg, dbgPage);
            else drawEthanol(cv, t);
            G.frame(cv, t, TABS, page, [demoOn() && { text: 'DEMO' }, page === ETHANOL && manualOn() && !fresh() && { text: 'ENTERED' }, page === DEBUG && dbg.running && { text: 'RUNNING' }]);
            labels();
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 4, guard(log, 'draw', render));
        labels();

        Promise.resolve(guard(log, 'first frame', render)()).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
