'use strict';
/**
 * tap.js - see what the head unit's diagnostic transport (TASU) says, for the Debug page.
 *
 * The kit's Diag (kit/runtime/diag.js) talks to the transport through the signals module it is given: call() for
 * sendTasuRequest, on() for the sendTasuResponse broadcast. It drops what is not a reply (transport errors, frames
 * the transport rejected, short frames) without a word, so "no reply" can mean the DME was silent or that the
 * transport answered something else. tapSignals(signals) gives the same module with call() and on() looked through:
 * every request and every response passes unchanged, and is only counted here.
 *
 *   const tap = tapSignals(ctx.signals);
 *   const link = new ReadOnlyDiag(tap.signals, log);
 *   tap.stats  // { requests, verdicts: { NO_ERROR: 27 }, responses, frames: { '12': 3 }, errors, rejects, short, last,
 *              //   subscribed: 'not yet' | 'yes' | 'failed: ...', recent: [{ seq, at, kind, bytes }] }
 *   tap.since(seq)  // the responses heard after response number seq (the last 32 are kept)
 *   tap.proxy       // the transport's proxy, once the kit made it (for the Debug page's sendTasuRequestExt test)
 *   tap.hear(v)     // count / trace a response that came another way (an Ext response event)
 *   tap.stats.trace // [{ at, dir: '>' | '=' | '<', text }]: each request, the transport's verdict on it and each
 *                   // response, in order with their times (the last 400), to tie a reject to its request
 */
const REQUEST = 'sendTasuRequest', RESPONSE = 'sendTasuResponse';
const TASU = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';

const hex = (n) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase();

function toBytes(b) {
    if (!b) return [];
    if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Array.prototype.slice.call(b);
    if (Array.isArray(b)) return b.slice();
    if (b.data) return toBytes(b.data);
    if (typeof b === 'object' && typeof b.length === 'number') return Array.prototype.slice.call(b);
    return [];
}

/** The transport's verdict on a request, as diag.js reads it. */
function verdictOf(r) {
    const v = r && typeof r === 'object' ? (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
    return v === undefined ? 'NO_ERROR' : String(v);
}

function tapSignals(signals, opts) {
    const keep = (opts && opts.keep) || 4, ring = (opts && opts.ring) || 32;
    const stats = {
        since: Date.now(), requests: 0, verdicts: {}, callErrors: {},
        responses: 0, frames: {}, errors: {}, rejects: {}, short: 0, last: [], firstVerdict: null,
        subscribed: 'not yet', recent: [], trace: [],
    };
    const traceMax = (opts && opts.trace) || 400;
    const trace = (dir, text) => { stats.trace.push({ at: Date.now(), dir, text }); while (stats.trace.length > traceMax) stats.trace.shift(); };
    const count = (m, k) => { m[k] = (m[k] || 0) + 1; };

    function see(v) {
        stats.responses++;
        const err = v && v.errorCode;
        const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
        let kind;
        if (err !== undefined && err !== 'NO_ERROR' && err !== 0) { count(stats.errors, String(err)); kind = 'error ' + err; }
        else if (b.length >= 5 && b[2] === 0x7F) { count(stats.rejects, hex(b[4])); kind = 'rejected ' + hex(b[4]); }
        else if (b.length < 10) { stats.short++; kind = 'short'; }
        else { count(stats.frames, hex(b[6])); kind = 'from ' + hex(b[6]); }
        const seen = { seq: stats.responses, at: Date.now(), kind, bytes: b.slice(0, 24).map(hex).join(' ') + (b.length > 24 ? ' ..' : '') };
        stats.last.push(seen);
        while (stats.last.length > keep) stats.last.shift();
        stats.recent.push(seen);
        while (stats.recent.length > ring) stats.recent.shift();
        trace('<', kind + ': ' + seen.bytes);
    }

    const out = { stats, proxy: null };
    const tapped = Object.assign({}, signals, {
        proxy(iface, instance) {
            const r = signals.proxy(iface, instance);
            if (iface === TASU) Promise.resolve(r).then((px) => { if (!out.proxy) out.proxy = px; }, () => {});
            return r;
        },
        call(p, method, params, timeoutMs) {
            const r = signals.call(p, method, params, timeoutMs);
            if (method !== REQUEST) return r;
            stats.requests++;
            const q = params || {}, data = toBytes(q.udsData);
            const n = stats.requests;
            trace('>', '#' + n + ' to ' + hex((q.targetAddress || 0) & 0xFF) + ': ' + [q.serviceID || 0].concat(data).map(hex).join(' '));
            return Promise.resolve(r).then((v) => {
                count(stats.verdicts, verdictOf(v));
                trace('=', '#' + n + ' ' + verdictOf(v));
                if (stats.firstVerdict === null) { try { stats.firstVerdict = JSON.stringify(v); } catch (e) { stats.firstVerdict = String(v); } }
                return v;
            }, (e) => { count(stats.callErrors, String(e && e.message || e)); trace('=', '#' + n + ' call failed: ' + (e && e.message || e)); throw e; });
        },
        on(p, name, fn, log) {
            if (name !== RESPONSE) return signals.on(p, name, fn, log);
            const r = signals.on(p, name, (v) => { try { see(v); } catch (e) { /* counting only */ } fn(v); }, log);
            Promise.resolve(r).then(() => { stats.subscribed = 'yes'; }, (e) => { stats.subscribed = 'failed: ' + (e && e.message || e); });
            return r;
        },
    });
    out.signals = tapped;
    out.since = (seq) => stats.recent.filter((x) => x.seq > seq);
    out.hear = (v) => { try { see(v); } catch (e) { /* counting only */ } };
    out.trace = trace;
    return out;
}

/** "NO_ERROR 27, X 2" (or none) */
const tally = (m) => { const k = Object.keys(m); return k.length ? k.map((x) => x + ' ' + m[x]).join(', ') : 'none'; };

module.exports = { tapSignals, verdictOf, tally };
