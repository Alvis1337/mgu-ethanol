// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// config.hpp - the app's settings, read from a small text file on the USB stick.
//
// NBT Evo has no easy on-screen keyboard for a PluginApp, and there is no live ethanol to read (see
// cds_keys.hpp), so the ethanol % and the fill-up targets are set by editing nbt-ethanol.cfg on the same
// USB stick used for logging. Lines are "key=value"; '#' starts a comment; unknown keys are ignored:
//
//   ethanol = 72     # ethanol % currently in the tank (what the DME would show on the BC readout)
//   target  = 50     # desired ethanol % after the fill-up
//   e85     = 85     # ethanol % of the E85 pump (seasonal; summer ~83, winter ~70)
//   pump    = 10     # ethanol % of the petrol pump (E10 = 10)
//   tank    = 65     # tank capacity in litres (G01/F97 ~ 65)
//
// The tank LEVEL is not set here - it comes live from CDS (sensors.fuel). Pure logic; the binding reads the
// file and calls parseConfig on its contents. C++98.
#ifndef IDRIVE6_CONFIG_HPP
#define IDRIVE6_CONFIG_HPP

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

namespace ethanol {

struct Settings {
    bool   manualMode;     // always true for now (no live ethanol); kept for future CDS surprises
    double manualE;        // ethanol % in the tank, from the file
    double tankCapacityL;
    double targetE, e85, pump;
    bool   hasEthanol;     // whether the file actually gave an ethanol % (else the app shows "set it")
    Settings() : manualMode(true), manualE(0), tankCapacityL(65), targetE(50), e85(85), pump(10), hasEthanol(false) {}
};

// trims leading/trailing spaces and tabs in place, returns the start.
inline char* trim_(char* s) {
    while (*s == ' ' || *s == '\t') ++s;
    char* e = s + strlen(s);
    while (e > s && (e[-1] == ' ' || e[-1] == '\t' || e[-1] == '\r' || e[-1] == '\n')) --e;
    *e = 0;
    return s;
}

// Applies "key=value" lines from text to s. Recognized keys update their field; ethanol also sets hasEthanol.
// Returns the number of recognized keys applied. Robust to missing/garbage lines.
inline int parseConfig(const char* text, Settings& s) {
    if (!text) return 0;
    int applied = 0;
    char line[128];
    const char* p = text;
    while (*p) {
        size_t n = 0;
        while (p[n] && p[n] != '\n') ++n;
        size_t copy = n < sizeof(line) - 1 ? n : sizeof(line) - 1;
        memcpy(line, p, copy);
        line[copy] = 0;
        p += n;
        if (*p == '\n') ++p;

        char* hash = strchr(line, '#');
        if (hash) *hash = 0;
        char* eq = strchr(line, '=');
        if (!eq) continue;
        *eq = 0;
        char* key = trim_(line);
        char* val = trim_(eq + 1);
        if (!*key || !*val) continue;

        char* end = NULL;
        double v = strtod(val, &end);
        bool isNum = (end != val) && (v > -1e6 && v < 1e6);  // rejects NaN/inf too

        if (!isNum) continue;
        if (!strcmp(key, "ethanol")) { s.manualE = v; s.hasEthanol = true; ++applied; }
        else if (!strcmp(key, "target")) { s.targetE = v; ++applied; }
        else if (!strcmp(key, "e85"))   { s.e85 = v; ++applied; }
        else if (!strcmp(key, "pump"))  { s.pump = v; ++applied; }
        else if (!strcmp(key, "tank"))  { s.tankCapacityL = v; ++applied; }
        else if (!strcmp(key, "manual")){ s.manualMode = (v != 0); ++applied; }
    }
    return applied;
}

}  // namespace ethanol

#endif
