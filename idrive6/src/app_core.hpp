// app_core.hpp - the Ethanol app's decision logic, framework-free and testable.
//
// The QNX binding (qnx_binding.cpp) feeds this the latest CDS readings and the user's settings, gets back
// the exact strings each screen label should show, and pushes them into the plugin's data model. Keeping
// the logic here means the part that decides "live or manual?", runs the fill-up math and formats every
// row is provable off the car (tests/run_tests.cpp), and the binding stays a thin cable.
//
// Pure (no framework, no I/O). C++98.
#ifndef IDRIVE6_APP_CORE_HPP
#define IDRIVE6_APP_CORE_HPP

#include "fuel.hpp"
#include "blend.hpp"
#include <string>

namespace ethanol {

// Everything the screen needs, gathered each refresh.
struct Inputs {
    Reading ethanolLive;   // from CDS, if a property carries it (see cds_keys.hpp)
    Reading fuelL;         // tank contents in litres (from CDS sensors.fuel, converted if a percent)

    bool    manualMode;    // user typed the % instead of trusting CDS
    double  manualE;       // the typed ethanol %

    double  tankCapacityL; // configured tank size (G01 ~ 65 L; set in settings)
    double  targetE;       // fill-up target %
    double  e85;           // ethanol % of the E85 pump (often ~70-85 seasonally)
    double  pump;          // ethanol % of the petrol pump (often ~10 for E10)

    Inputs() : manualMode(false), manualE(0), tankCapacityL(0), targetE(50), e85(85), pump(10) {}
};

// The screen has this many label rows (raDataModel ids 21..27); one per Labels field below.
enum { kRowCount = 7 };

// One string per label the XML binds (raDataModel rows).
struct Labels {
    std::string ethanol;    // "72 %" / "--"
    std::string source;     // "Live (CDS)" / "Manual" / "No data"
    std::string fuelLevel;  // "41.3 L" / "--"
    std::string addE85;     // "27.5 L (7.26 gal)" / "--"
    std::string addPump;    // "16.5 L (4.36 gal)" / "--"
    std::string result;     // "50 %" / "--"
    std::string note;       // status line: "", "Tank full", "Max with E85 ~25 %", ...
};

inline std::string addLabel(double litres) {
    return litreLabel(Reading(litres)) + " (" + galLabel(litres) + ")";
}

inline std::string statusNote(const Plan& p) {
    switch (p.status) {
        case Plan::FULL: return "Tank full - nothing to add";
        case Plan::LOW:  return "Can't reach target; max is " + pctLabel(Reading(p.highE));
        case Plan::HIGH: return "Already above target; min is " + pctLabel(Reading(p.lowE));
        case Plan::OK:   default: return "";
    }
}

inline Labels render(const Inputs& in) {
    Labels L;

    // 1) which ethanol number do we trust?
    Reading e;
    if (in.manualMode) { e = ethanolPct(true, in.manualE, PERCENT); L.source = "Manual"; }
    else if (in.ethanolLive.ok) { e = in.ethanolLive; L.source = "Live (CDS)"; }
    else { L.source = "No data - set manually"; }
    L.ethanol = pctLabel(e);

    // 2) fuel level.
    L.fuelLevel = litreLabel(in.fuelL);

    // 3) fill-up rows, only when we have both a tank level and an ethanol figure.
    if (in.fuelL.ok && e.ok && in.tankCapacityL > 0) {
        Plan p = plan(Fill(in.tankCapacityL, in.fuelL.value, e.value, in.targetE, in.e85, in.pump));
        if (p.ok) {
            L.addE85 = addLabel(p.e85L);
            L.addPump = addLabel(p.pumpL);
            L.result = pctLabel(Reading(p.resultE));
            L.note = statusNote(p);
            return L;
        }
    }
    L.addE85 = "--"; L.addPump = "--"; L.result = "--";
    L.note = (!in.fuelL.ok) ? "Need tank level" : (!e.ok ? "Need ethanol % (set manually)" : "");
    return L;
}

}  // namespace ethanol

#endif
