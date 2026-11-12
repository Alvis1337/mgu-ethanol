'use strict';
/**
 * patient.js - the read-only link, with requests tried again while the head unit's diagnostic transport is busy.
 *
 * The transport (TASU) keeps a request until the unit answered or its own timeout ran out, which is longer than the
 * kit waits for a reply; a request sent meanwhile is turned away with APP_REQUEST_TEMPORARILY_NOT_ACCEPTED. The kit
 * tries again for about a second (readonly-diag.js: busyMs 100 x 1..4), then gives up with "transport refused: ...".
 * Seen on the car right after a request the DME did not answer. Here such a request is sent again every waitMs for up
 * to maxWaitMs. Anything else (a reply, no reply, a refused read-only check) is passed on as it is.
 *
 *   const link = patient(new ReadOnlyDiag(signals, log));
 */
const BUSY = /TEMPORARILY_NOT_ACCEPTED|BUSY/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function patient(link, opts) {
    const waitMs = (opts && opts.waitMs) || 1000, maxWaitMs = (opts && opts.maxWaitMs) || 12000;
    const w = {
        retried: 0,             // requests sent again because the transport was busy
        gaveUp: 0,              // requests still turned away after maxWaitMs
        get ready() { return link.ready; },
        get available() { return link.available; },
        get error() { return link.error; },
        get busy() { return link.busy; },
        get stats() { return link.stats; },
        init() { return link.init(); },
        silent(target) { return typeof link.silent === 'function' ? link.silent(target) : false; },
        wake(target) { if (typeof link.wake === 'function') link.wake(target); },
        cancel() { if (typeof link.cancel === 'function') link.cancel(); },
        physical() { const a = arguments; return retry(() => link.physical.apply(link, a)); },
        discover() { const a = arguments; return retry(() => link.discover.apply(link, a)); },
    };
    async function retry(fn) {
        const t0 = Date.now();
        for (;;) {
            try { return await fn(); } catch (e) {
                if (!BUSY.test(String(e && e.message || e))) throw e;
                if (Date.now() - t0 + waitMs > maxWaitMs) { w.gaveUp++; throw e; }
                w.retried++;
                await sleep(waitMs);
            }
        }
    }
    return w;
}

module.exports = { patient, BUSY };
