// fuel.hpp - interpret and format fuel/ethanol values for the NBT Evo labels (pure logic).
//
// On NBT Evo an app reads the Car Data Service (CDS), not diagnostics: values arrive already typed
// (a double from cdsAddPropertyChangedEventHandler), not as raw UDS bytes. We do not yet know which
// CDS property, if any, carries ethanol content, nor its scaling. So this file keeps the interpretation
// a tiny, testable unit: given a raw CDS value and a declared scaling, produce a clean 0..100 % (or a
// "no value" marker), and format the label strings the XML screen binds to.
//
// Known scalings we may meet (set in cds_keys.hpp once confirmed on the car):
//   RATIO   value is 0..1            -> * 100
//   PERCENT value is already 0..100  -> * 1
//   BYTE    value is 0..255          -> * 100/255   (if a raw diagnostic byte is ever surfaced)
//
// Pure (no framework, no I/O). C++98.
#ifndef IDRIVE6_FUEL_HPP
#define IDRIVE6_FUEL_HPP

#include <string>
#include <cstdio>

namespace ethanol {

const double L_PER_GAL_F = 3.785411784;  // kept local so this header stands alone

inline bool finiteF_(double x) { return (x == x) && (x - x == 0.0); }
inline double clampF_(double x, double lo, double hi) { return x < lo ? lo : (x > hi ? hi : x); }

enum Scaling { RATIO, PERCENT, BYTE };

// A value plus whether it is present. CDS hands "--" when a property is unavailable or invalid; we mirror
// that with ok=false rather than guessing a number.
struct Reading {
    bool ok;
    double value;   // meaning depends on context: % for ethanol, litres for fuel
    Reading() : ok(false), value(0) {}
    Reading(double v) : ok(true), value(v) {}
};

// Turn a raw CDS value into a clean ethanol percent 0..100.
inline Reading ethanolPct(bool present, double raw, Scaling s) {
    if (!present || !finiteF_(raw)) return Reading();
    double pct = raw;
    if (s == RATIO) pct = raw * 100.0;
    else if (s == BYTE) pct = raw * 100.0 / 255.0;
    // PERCENT: as-is
    return Reading(clampF_(pct, 0.0, 100.0));
}

// Fuel in the tank. CDS sensors.fuel units are unconfirmed; the app declares which via isLitres.
// If it is a percent and the tank capacity is known, convert to litres for the fill-up calculator.
inline Reading fuelLitres(bool present, double raw, bool isLitres, double tankCapacityL) {
    if (!present || !finiteF_(raw)) return Reading();
    if (isLitres) return Reading(clampF_(raw, 0.0, tankCapacityL > 0 ? tankCapacityL : raw));
    if (tankCapacityL <= 0) return Reading();            // percent but no capacity -> can't give litres
    return Reading(clampF_(raw, 0.0, 100.0) * tankCapacityL / 100.0);
}

// ---- label formatting (what the XML labels show) ----

inline std::string fmt(const char* f, double v) {
    char b[48];
    std::snprintf(b, sizeof b, f, v);
    return std::string(b);
}

inline std::string pctLabel(const Reading& r) {
    return r.ok ? fmt("%.0f %%", r.value) : std::string("--");
}

inline std::string litreLabel(const Reading& r) {
    return r.ok ? fmt("%.1f L", r.value) : std::string("--");
}

inline std::string galLabel(double litres) {
    return fmt("%.2f gal", litres / L_PER_GAL_F);
}

}  // namespace ethanol

#endif
