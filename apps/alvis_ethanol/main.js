'use strict';
/**
 * Ethanol - live ethanol content (E%) of the fuel, from the engine unit. Read only.
 *
 *   - big segmented bar 0-100 % with the target band marked (default E30-E50, set in Settings)
 *   - status: in / above / below the band
 *   - min / max since reset, 20-minute trend
 *   - details line: which identifier answered, raw bytes, or why nothing did
 *
 * The value comes from the DME (ecu 0x12) with a read-only request (see reader.js, app.json config).
 * Without a car link the demo data runs (Settings > Demo data).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const Reader = require('./reader');

const W = 1600, H = 520;
const GO = '#2fd27a';
const HIST_MS = 20 * 60 * 1000;

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
        const link = new ReadOnlyDiag(ctx.signals, log);
        const reader = new Reader(link, (ctx.spec && ctx.spec.config) || {});
        // connect in the background: the screen must not wait for the diagnostic link
        link.init().catch((e) => { log.warn('diagnostic link: ' + (e && e.message || e)); });

        let cur = null, curAt = 0;                  // last real value (%) and its steady-clock time
        let min = null, max = null;
        const hist = [];                            // [steady time, %] every 5 s
        let lastHist = 0, seenAt = 0, busy = false, lastWhy = '', pollTimer = null;

        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !link.available);
        const demoValue = () => 38 + 9 * Math.sin(Date.now() / 9000) + 2 * Math.sin(Date.now() / 1700);
        const value = () => (demoOn() ? demoValue() : (cur !== null && mono() - curAt < 15000 ? cur : null));

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
                if (!demoOn() && link.ready) {
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
        pollTimer = setInterval(guard(log, 'poll', () => { if (Date.now() - seenAt < 3000 || mono() - lastHist > 5000) return poll(); }), 1000);
        if (pollTimer && pollTimer.unref) pollTimer.unref();

        ui.onClick('BTN_RESET', guard(log, 'reset', () => { min = cur; max = cur; hist.length = 0; }));

        function details() {
            if (demoOn()) return 'demo data - no car link';
            const l = reader.last;
            const probes = reader.probes.filter((p) => p.bytes).map((p) => p.label + ' ' + p.bytes).join('   ');
            if (l.value !== null) return 'DME 0x' + reader.cfg.ecu.toString(16) + '  ' + l.source + '  [' + l.bytes + ']' + (probes ? '   ' + probes : '');
            return (l.why || 'waiting for the diagnostic link') + (probes ? '   ' + probes : '');
        }

        function render() {
            const t = ctx.theme(), now = Date.now();
            seenAt = now;
            const cv = ctx.canvas(W, H).clear(t.bg);
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
            cv.text(demoOn() ? 'demo' : ageS === null ? '--' : ageS + ' s', 1552, 416, 30, t.text, { align: 'right', font: 'bold' });

            const dt = details();
            cv.text(dt.length > 62 ? dt.slice(0, 61) + '..' : dt, 952, 470, 20, t.dim);

            G.frame(cv, t, ['Ethanol'], 0, [demoOn() && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 4, guard(log, 'draw', render));
        Promise.resolve(guard(log, 'first frame', render)()).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
