// blend.hpp - fill-up calculator (pure logic), ported from apps/alvis_ethanol/blend.js.
//
//   Plan p = plan(Fill(/*tankL*/59, /*nowL*/15, /*nowE*/30, /*targetE*/50, /*e85*/85, /*pump*/10));
//   if (p.ok) { ... p.e85L litres of E85, p.pumpL litres of pump petrol, result p.resultE % ... }
//
// All ethanol contents are percent by volume; volumes in litres (galToL / lToGal convert). Blending by
// volume is linear, so with x litres of E85 and (room - x) litres of pump petrol:
//   nowL*nowE + x*e85 + (room - x)*pump = tankL*targetE
// status: OK (target reached), LOW (even a tank topped up with E85 only stays below target -> highE),
//         HIGH (even topping up with pump only stays above target -> lowE), FULL (no room to add).
//
// C++98, no exceptions, header-only so host tests include it directly. Keep this file pure (no framework,
// no I/O) - it is the part we can prove correct off the car.
#ifndef IDRIVE6_BLEND_HPP
#define IDRIVE6_BLEND_HPP

namespace ethanol {

const double L_PER_GAL = 3.785411784;

inline double galToL(double gal) { return gal * L_PER_GAL; }
inline double lToGal(double l)   { return l / L_PER_GAL; }

// finite check without <cmath>/C++11: NaN fails (x==x); +/-inf fails (x-x==0).
inline bool finite_(double x) { return (x == x) && (x - x == 0.0); }

inline double clamp_(double x, double lo, double hi) {
    return x < lo ? lo : (x > hi ? hi : x);
}

// local abs for double without pulling <cmath> (keeps the header standalone for host tests)
inline double fabs_(double x) { return x < 0.0 ? -x : x; }

struct Fill {
    double tankL, nowL, nowE, targetE, e85, pump;
    Fill(double tankL_, double nowL_, double nowE_, double targetE_, double e85_, double pump_)
        : tankL(tankL_), nowL(nowL_), nowE(nowE_), targetE(targetE_), e85(e85_), pump(pump_) {}
};

struct Plan {
    bool ok;            // false == the JS "return null" (bad inputs)
    enum Status { OK, LOW, HIGH, FULL } status;
    double roomL;       // room left in the tank
    double e85L;        // litres of E85 to add
    double pumpL;       // litres of pump petrol to add
    double resultE;     // resulting ethanol % after the add
    double lowE;        // % if you top up with pump petrol only
    double highE;       // % if you top up with E85 only
    Plan() : ok(false), status(OK), roomL(0), e85L(0), pumpL(0), resultE(0), lowE(0), highE(0) {}
};

inline Plan plan(const Fill& f) {
    Plan out;
    const double tankL = f.tankL, e85 = f.e85, pump = f.pump, targetE = f.targetE;
    if (!(finite_(tankL) && finite_(f.nowL) && finite_(f.nowE) &&
          finite_(targetE) && finite_(e85) && finite_(pump)) || tankL <= 0.0)
        return out;  // ok stays false

    const double nowL = clamp_(f.nowL, 0.0, tankL);
    const double nowE = clamp_(f.nowE, 0.0, 100.0);
    const double roomL = tankL - nowL;

    // mixE(addE85): resulting % if addE85 litres of the room is E85 and the rest is pump petrol.
    const double lowE  = (nowL * nowE + 0.0 * e85 + (roomL - 0.0) * pump) / tankL;    // mixE(0)
    const double highE = (nowL * nowE + roomL * e85 + (roomL - roomL) * pump) / tankL; // mixE(roomL)

    out.ok = true;
    out.roomL = roomL;
    out.e85L = 0.0;
    out.pumpL = roomL;
    out.resultE = lowE;
    out.status = Plan::OK;
    out.lowE = lowE;
    out.highE = highE;

    if (roomL < 0.05) { out.pumpL = 0.0; out.resultE = nowE; out.status = Plan::FULL; return out; }

    if (e85 == pump) {
        out.status = (fabs_(lowE - targetE) < 0.5) ? Plan::OK : (lowE < targetE ? Plan::LOW : Plan::HIGH);
        return out;
    }

    const double x = (tankL * targetE - nowL * nowE - roomL * pump) / (e85 - pump);
    if (x <= 0.0) { out.status = (lowE - targetE > 0.5) ? Plan::HIGH : Plan::OK; return out; }
    if (x >= roomL) {
        out.e85L = roomL; out.pumpL = 0.0; out.resultE = highE;
        out.status = (targetE - highE > 0.5) ? Plan::LOW : Plan::OK;
        return out;
    }
    out.e85L = x; out.pumpL = roomL - x; out.resultE = targetE;
    return out;
}

}  // namespace ethanol

#endif
