// qnx_binding.cpp - the thin cable between NBT Evo's framework and app_core::render().
//
// This is the ONE file that touches the car's frameworks (libAppFramework, libCoreFramework). Everything it
// decides or formats lives in app_core.hpp / blend.hpp / fuel.hpp, which are proven by host tests. This file
// only: (1) registers the plugin, (2) subscribes to CDS properties, (3) every refresh builds an Inputs,
// calls render(), and pushes the Labels into the screen's data model, (4) logs raw ethanol-candidate values
// so we can discover which CDS property (if any) carries ethanol.
//
// IMPORTANT: the framework signatures below are reconstructed from the reference gauge app's README, NOT from
// the real headers. Before building for the car, reconcile every call marked [RECONCILE] against the headers
// that ship in libAppFramework.A.so / libCoreFramework.A.so on the unit (/opt/hmi/ID5/lib + SDK headers).
// Nothing here writes to the car, changes coding, or leaves the HMI process - it only reads CDS and draws.
//
// Build: qcc -V4.4.2,gcc_ntoarmv7le (QNX SDP 6.5). Host build excludes this file (see Makefile).

#include "app_core.hpp"
#include "cds_keys.hpp"

#include <cstdio>
#include <cstring>
#include <string>

// === [RECONCILE] provided by libAppFramework / libCoreFramework on the unit ==========================
// Minimal surface the gauge app uses. Names/signatures MUST be checked against the car's headers.
namespace fw {
    // Base class the HMI instantiates for a plugin (HmiMain3D PluginApp framework).
    class PluginApp {
    public:
        virtual ~PluginApp() {}
        virtual void onCreate() {}        // called once when the app is opened
        virtual void onDestroy() {}
        // push a string into a named row of the app's data model (raDataModel binding in the XML).
        void setModelText(const char* rowId, const char* text);
        // ask for a periodic callback (ms); returns a timer id. onTimer() fires on the HMI thread.
        int  startTimer(int periodMs);
        virtual void onTimer(int /*timerId*/) {}
    };

    // CDS: subscribe to a property; cb(ctx, property, value, valid) fires on change. Mirrors
    // cdsAddPropertyChangedEventHandler used by NbtAad / the gauge app.
    typedef void (*CdsCb)(void* ctx, const char* property, double value, bool valid);
    int  cdsAddPropertyChangedEventHandler(const char* property, CdsCb cb, void* ctx);
    void slog(const char* msg);   // diagnostics to the system log
}
// ======================================================================================================

namespace {

// Latest CDS readings, updated by callbacks, read by the timer. Single HMI thread, so no locking.
struct State {
    ethanol::Reading fuel;         // from CDS_FUEL
    ethanol::Reading ethanolLive;  // from whichever ETHANOL_CANDIDATE fired
    std::string      ethanolProp;  // which property it was (for the log / settings)

    // user settings (persisted by the framework's settings store - [RECONCILE]; defaults for now)
    bool   manualMode;
    double manualE;
    double tankCapacityL;
    double targetE, e85, pump;

    State() : manualMode(false), manualE(50), tankCapacityL(65), targetE(50), e85(85), pump(10) {}
};

State g;
std::FILE* g_log = 0;

void logf(const char* fmt, double v, const char* s) {
    if (!g_log) g_log = std::fopen("/mnt/usb/nbt-ethanol.log", "a");  // [RECONCILE] USB mount path on unit
    if (g_log) { std::fprintf(g_log, fmt, s, v); std::fflush(g_log); }
    fw::slog("nbt-ethanol: cds update");
}

// CDS callbacks ---------------------------------------------------------------------------------------
void onFuel(void* /*ctx*/, const char* /*prop*/, double value, bool valid) {
    g.fuel = ethanol::fuelLitres(valid, value, ethanol::FUEL_IS_LITRES, g.tankCapacityL);
}

void onEthanolCandidate(void* /*ctx*/, const char* prop, double value, bool valid) {
    // Log every candidate that ever fires with its raw value - this is how we learn the schema.
    logf("ethanol candidate %s raw=%.3f\n", value, prop);
    if (!valid) return;
    // Assume PERCENT until raw values on the car tell us otherwise (see cds_keys.hpp).
    g.ethanolLive = ethanol::ethanolPct(true, value, ethanol::PERCENT);
    g.ethanolProp = prop;
}

ethanol::Inputs collect() {
    ethanol::Inputs in;
    in.ethanolLive = g.ethanolLive;
    in.fuelL = g.fuel;
    in.manualMode = g.manualMode;
    in.manualE = g.manualE;
    in.tankCapacityL = g.tankCapacityL;
    in.targetE = g.targetE; in.e85 = g.e85; in.pump = g.pump;
    return in;
}

}  // namespace

// The plugin ------------------------------------------------------------------------------------------
class EthanolApp : public fw::PluginApp {
public:
    virtual void onCreate() {
        fw::cdsAddPropertyChangedEventHandler(ethanol::CDS_FUEL, onFuel, 0);
        for (int i = 0; ethanol::ETHANOL_CANDIDATES[i]; ++i)
            fw::cdsAddPropertyChangedEventHandler(ethanol::ETHANOL_CANDIDATES[i], onEthanolCandidate, 0);
        startTimer(500);   // refresh rows at 2 Hz, like the gauge app
        refresh();
    }

    virtual void onTimer(int /*id*/) { refresh(); }

    void refresh() {
        ethanol::Labels L = ethanol::render(collect());
        setModelText("rowEthanol", L.ethanol.c_str());
        setModelText("rowSource",  L.source.c_str());
        setModelText("rowFuel",    L.fuelLevel.c_str());
        setModelText("rowAddE85",  L.addE85.c_str());
        setModelText("rowAddPump", L.addPump.c_str());
        setModelText("rowResult",  L.result.c_str());
        setModelText("rowNote",    L.note.c_str());
    }
};

// [RECONCILE] the HMI discovers the plugin through CAppManager + EthanolApp.manifest; the exact factory
// export (symbol name / signature) must match what the gauge app exports from libGaugeApp.so.
extern "C" fw::PluginApp* createPluginApp() { return new EthanolApp(); }
