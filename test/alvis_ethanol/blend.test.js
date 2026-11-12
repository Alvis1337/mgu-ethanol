'use strict';
/* alvis_ethanol: the fill-up calculator (Node 8, run by test/run.js) */
const assert = require('assert');
const path = require('path');
const { plan, gallons, litres } = require(path.join(__dirname, '..', '..', 'apps', 'alvis_ethanol', 'blend.js'));

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) < (eps || 0.01), (what || '') + ' ' + a + ' != ' + b);
/** the blend the plan actually gives when full */
const mixed = (p, q) => (q.nowL * q.nowE + p.e85L * q.e85 + p.pumpL * q.pump) / q.tankL;

module.exports = [
    ['60 l tank, 15 l of E30, target E50: 28 l E85 + 17 l of E10', () => {
        const q = { tankL: 60, nowL: 15, nowE: 30, targetE: 50, e85: 85, pump: 10 };
        const p = plan(q);
        assert.strictEqual(p.status, 'ok');
        near(p.e85L, 28, 0.001, 'E85');
        near(p.pumpL, 17, 0.001, '93');
        near(p.e85L + p.pumpL, 45, 0.001, 'fills the tank');
        near(mixed(p, q), 50, 0.001, 'blend');
    }],
    ['empty tank to E30 with real-world E85 (E72) and E10 pump fuel', () => {
        const q = { tankL: 59, nowL: 0, nowE: 0, targetE: 30, e85: 72, pump: 10 };
        const p = plan(q);
        assert.strictEqual(p.status, 'ok');
        near(mixed(p, q), 30, 0.001, 'blend');
        near(p.e85L, 59 * 20 / 62, 0.001, 'E85');
    }],
    ['target above what all E85 can reach: all E85, status low with the best reachable', () => {
        const q = { tankL: 60, nowL: 40, nowE: 10, targetE: 70, e85: 85, pump: 10 };
        const p = plan(q);
        assert.strictEqual(p.status, 'low');
        near(p.e85L, 20); near(p.pumpL, 0);
        near(p.highE, (40 * 10 + 20 * 85) / 60);
        near(p.resultE, p.highE);
    }],
    ['target below what all pump fuel gives: all 93, status high with the lowest reachable', () => {
        const q = { tankL: 60, nowL: 40, nowE: 80, targetE: 30, e85: 85, pump: 10 };
        const p = plan(q);
        assert.strictEqual(p.status, 'high');
        near(p.e85L, 0); near(p.pumpL, 20);
        near(p.lowE, (40 * 80 + 20 * 10) / 60);
    }],
    ['already at the target: the rest is the mix that keeps it there', () => {
        const q = { tankL: 60, nowL: 30, nowE: 40, targetE: 40, e85: 85, pump: 10 };
        const p = plan(q);
        assert.strictEqual(p.status, 'ok');
        near(mixed(p, q), 40, 0.001);
    }],
    ['full tank: nothing to add', () => {
        const p = plan({ tankL: 60, nowL: 60, nowE: 35, targetE: 50, e85: 85, pump: 10 });
        assert.strictEqual(p.status, 'full');
        assert.strictEqual(p.e85L, 0); assert.strictEqual(p.pumpL, 0);
    }],
    ['more fuel read than the tank holds is taken as full; bad input gives null', () => {
        assert.strictEqual(plan({ tankL: 60, nowL: 70, nowE: 35, targetE: 50, e85: 85, pump: 10 }).status, 'full');
        assert.strictEqual(plan({ tankL: 60, nowL: null, nowE: 35, targetE: 50, e85: 85, pump: 10 }), null);
        assert.strictEqual(plan({ tankL: 0, nowL: 0, nowE: 35, targetE: 50, e85: 85, pump: 10 }), null);
    }],
    ['gallons and litres', () => {
        near(gallons(59), 15.586, 0.001);
        near(litres(gallons(42)), 42, 1e-9);
    }],
];
