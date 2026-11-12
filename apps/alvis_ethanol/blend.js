'use strict';
/**
 * blend.js - fill-up calculator: how much E85 and how much pump petrol to add to fill the tank at a target
 * ethanol content.
 *
 *   plan({ tankL: 59, nowL: 15, nowE: 30, targetE: 50, e85: 85, pump: 10 })
 *   -> { roomL: 44, e85L, pumpL, resultE, status, lowE, highE }
 *
 * All contents are percent ethanol by volume; volumes in litres (litres() / gallons() convert). Blending by volume
 * is linear, so with x litres of E85 and (room - x) of pump petrol:
 *   nowL * nowE + x * e85 + (room - x) * pump = tankL * targetE
 * status: 'ok' (target reached), 'low' (even a tank topped up with E85 only stays below target: highE),
 *         'high' (even topping up with pump petrol only stays above target: lowE), 'full' (no room to add).
 */
const L_PER_GAL = 3.785411784;

const num = (x) => typeof x === 'number' && isFinite(x);

function plan(p) {
    const tankL = p.tankL, e85 = p.e85, pump = p.pump, targetE = p.targetE;
    if (![tankL, p.nowL, p.nowE, targetE, e85, pump].every(num) || tankL <= 0) return null;
    const nowL = Math.max(0, Math.min(tankL, p.nowL));
    const nowE = Math.max(0, Math.min(100, p.nowE));
    const roomL = tankL - nowL;
    const mixE = (addE85) => (nowL * nowE + addE85 * e85 + (roomL - addE85) * pump) / tankL;
    const lowE = mixE(0), highE = mixE(roomL);
    const out = { roomL, e85L: 0, pumpL: roomL, resultE: lowE, status: 'ok', lowE, highE };
    if (roomL < 0.05) return Object.assign(out, { pumpL: 0, resultE: nowE, status: 'full' });
    if (e85 === pump) return Object.assign(out, { status: Math.abs(lowE - targetE) < 0.5 ? 'ok' : lowE < targetE ? 'low' : 'high' });
    const x = (tankL * targetE - nowL * nowE - roomL * pump) / (e85 - pump);
    if (x <= 0) return Object.assign(out, { status: lowE - targetE > 0.5 ? 'high' : 'ok' });
    if (x >= roomL) return Object.assign(out, { e85L: roomL, pumpL: 0, resultE: highE, status: targetE - highE > 0.5 ? 'low' : 'ok' });
    return Object.assign(out, { e85L: x, pumpL: roomL - x, resultE: targetE });
}

const gallons = (l) => l / L_PER_GAL;
const litres = (gal) => gal * L_PER_GAL;

module.exports = { plan, gallons, litres, L_PER_GAL };
