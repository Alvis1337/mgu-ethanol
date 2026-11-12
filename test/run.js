'use strict';
/**
 * Unit tests, Node 8 (the car's major): `node test/run.js` (or `tools/check.sh`).
 * Runs test/*.test.js (every app) and test/<app id>/*.test.js (one app's own tests): a new app's tests are found
 * by dropping them in test/<its id>/. Every test file exports [[name, fn], ...]; fn may return a promise.
 * Exit 1 on any failure.
 */
const fs = require('fs');
const path = require('path');

const isTest = (f) => /\.test\.js$/.test(f);
const dirs = fs.readdirSync(__dirname).filter((f) => fs.statSync(path.join(__dirname, f)).isDirectory()).sort();
const files = fs.readdirSync(__dirname).filter(isTest).sort().map((f) => [f, path.join(__dirname, f)]);
dirs.forEach((d) => fs.readdirSync(path.join(__dirname, d)).filter(isTest).sort()
    .forEach((f) => files.push([d + '/' + f, path.join(__dirname, d, f)])));
const tests = [];
files.forEach((f) => require(f[1]).forEach((t) => tests.push([f[0].replace(/\.test\.js$/, '') + ': ' + t[0], t[1]])));

let passed = 0, failed = 0;
(async () => {
    for (const t of tests) {
        try {
            await Promise.race([Promise.resolve().then(t[1]), new Promise((res, rej) => setTimeout(() => rej(new Error('timed out after 20 s')), 20000).unref())]);
            passed++;
        } catch (e) {
            failed++;
            console.log('FAIL ' + t[0] + '\n  ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n  '));
        }
    }
    console.log(passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
