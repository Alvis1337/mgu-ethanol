// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// qnx_binding.cpp - libEthanolApp.so: the NBT Evo (ID5/ID6) PluginApp cable.
//
// Subscribes to the Car Data Service for the live tank level, reads the ethanol % and fill-up targets from a
// settings file on the USB stick (no live ethanol exists in CDS - see cds_keys.hpp), and twice a second writes
// the seven label rows that app_core::render() produces.
//
// The framework glue - the hand-declared bmw::PluginApp / BasicString / CDS delegate, the runtime vtable copy
// that installs our onInit/onError/onFinalize, the bmw::Runnable stand-in and the exported pluginAppInfo - is
// adapted from MGD4096/IDRIVE_GAUGE_APP (src/engine_data.cpp), which in turn follows NBT-AAD
// (Sq00ky/Supra-iDrive6-Android-Auto). Both PolyForm-Noncommercial; see idrive6/LICENSE. There are no BMW
// headers: the symbols below are exported by libAppFramework.A.so / libCoreFramework.A.so and resolved at link
// time with --allow-shlib-undefined. Not yet built with qcc or run on a unit.
//
// Nothing here writes to the car. It only subscribes to CDS and draws labels.
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <new>
#include <dirent.h>
#include <sys/stat.h>
#include <dlfcn.h>
#ifndef RTLD_DEFAULT
#define RTLD_DEFAULT ((void*)-2)   // QNX value
#endif
#include <pthread.h>
#ifdef __QNX__
#include <sys/slog.h>
#include <sys/slogcodes.h>
#endif

#include "app_core.hpp"
#include "cds_text.hpp"
#include "cds_keys.hpp"
#include "config.hpp"

#define ETHANOL_APP_VERSION "ethanol-idrive6-0.1.0 (" __DATE__ " " __TIME__ ")"

// ---- minimal declarations of BMW's RHMI app framework (names/types only; defined by the car's libraries) -----------
namespace bmw {
class IDispatcher;
class Bundle;
class Runnable;
enum RHMIInterfaceVersion { RHMI_INTERFACE_VERSION_1 = 1 };

template <typename T> class BasicString {
public:
    BasicString(const T* s);
    BasicString(const BasicString& other);
    ~BasicString();
    const T* raw() const { return m_data; }
private:
    T* m_data;
};

template <typename R, typename A1, typename A2, typename A3, typename A4> struct Delegate {
    void* object;
    R (*stub)(void* object, A1 a1);
};
typedef Delegate<bool, const BasicString<unsigned short>&, void, void, void> CdsDelegate;

const size_t kPluginAppStorage = 0x200;

class PluginApp {
public:
    PluginApp(IDispatcher& dispatcher, BasicString<char> name, unsigned major, unsigned minor,
              RHMIInterfaceVersion rhmi, const Bundle& params, const Bundle& config);
    void post(Runnable* runnable, unsigned delayMs);
    void updateModel(unsigned modelId, const BasicString<unsigned short>& text);
    void cdsAddPropertyChangedEventHandler(BasicString<char>& property, unsigned id, const CdsDelegate& handler);
    bool onInit();
    void onFinalize();
private:
    unsigned char m_storage[kPluginAppStorage];
};
} // namespace bmw

namespace {

// ---- constants ----------------------------------------------------------------------------------------------------
const unsigned kFirstRowModel   = 21;       // raDataModel ids 21..27 in EthanolApp.xml, one per row (7 rows)
const unsigned kSubscribeDelayMs = 1500;    // CDS handlers registered ~1.5 s after onInit, like the reference app
const unsigned kRenderMs        = 500;      // label refresh period
const long     kSettingsReloadS = 3;        // re-read the USB settings file at most this often
const long     kNoDataWarnS     = 25;
const char* const kCfgName   = "nbt-ethanol.cfg";
const char* const kUsbLogName = "nbt-ethanol.log";
const long     kUsbLogMaxBytes = 4L * 1024L * 1024L;
enum { kSlotOnError = 21, kSlotOnInit = 22, kSlotOnFinalize = 23, kVtblSlots = 34 };

// property indices
enum { kFuelProp = 0, kEngineInfoProp = 1, kPropCount = 2 };
const char* propName(int p) { return p == kFuelProp ? ethanol::CDS_FUEL : ethanol::CDS_ENGINE_INFO; }

// ---- logging ------------------------------------------------------------------------------------------------------
pthread_mutex_t g_logMutex = PTHREAD_MUTEX_INITIALIZER;
char   g_logPath[320] = "";
time_t g_logChecked = 0;

bool fileExists(const char* p) { struct stat st; return stat(p, &st) == 0; }

// First /mnt/umass* stick that holds `name`, or an env override (for host tests / flexibility).
bool usbFile(const char* name, const char* envVar, char* out, size_t n, bool mustExist) {
    const char* env = envVar ? getenv(envVar) : NULL;
    if (env && *env) { snprintf(out, n, "%s", env); return !mustExist || fileExists(out); }
    DIR* d = opendir("/mnt");
    if (!d) return false;
    bool found = false;
    struct dirent* e;
    while ((e = readdir(d)) != NULL) {
        if (strncmp(e->d_name, "umass", 5) != 0) continue;
        char p[320];
        snprintf(p, sizeof(p), "/mnt/%.200s/%s", e->d_name, name);
        if (!mustExist || fileExists(p)) { snprintf(out, n, "%s", p); found = true; break; }
    }
    closedir(d);
    return found;
}

bool usbLogPath(char* out, size_t n) {
    pthread_mutex_lock(&g_logMutex);
    time_t now = time(NULL);
    if (!g_logChecked || now - g_logChecked >= 5 || now < g_logChecked) {
        g_logChecked = now;
        g_logPath[0] = 0;
        char p[320];
        if (usbFile(kUsbLogName, "NBT_ETHANOL_LOG", p, sizeof(p), true)) {
            struct stat st;
            if (stat(p, &st) == 0 && (long)st.st_size < kUsbLogMaxBytes && access(p, W_OK) == 0)
                snprintf(g_logPath, sizeof(g_logPath), "%s", p);
        }
    }
    bool ok = g_logPath[0] != 0;
    if (ok) snprintf(out, n, "%s", g_logPath);
    pthread_mutex_unlock(&g_logMutex);
    return ok;
}

void elog(const char* fmt, ...) {
    char msg[320];
    va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof(msg), fmt, ap); va_end(ap);
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    char line[400];
    int n = snprintf(line, sizeof(line), "[%5ld.%03ld] [Ethanol] %s\n", (long)ts.tv_sec, (long)(ts.tv_nsec / 1000000), msg);
    if (n < 0) return;
    if (n >= (int)sizeof(line)) n = (int)sizeof(line) - 1;
    char path[320];
    if (usbLogPath(path, sizeof(path))) {
        int fd = open(path, O_WRONLY | O_APPEND);
        if (fd >= 0) { ssize_t w = write(fd, line, (size_t)n); (void)w; close(fd); }
    }
#ifdef __QNX__
    slogf(_SLOG_SETCODE(0x4e48, 1), _SLOG_INFO, "[Ethanol] %s", msg);
#else
    fputs(line, stderr);
#endif
}

long monoSec() { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (long)ts.tv_sec; }

// ---- state --------------------------------------------------------------------------------------------------------
bmw::PluginApp* g_app = NULL;
pthread_mutex_t g_dataMutex = PTHREAD_MUTEX_INITIALIZER;
double          g_fuelLitres = 0;        // latest sensors.fuel tanklevel (litres)
bool            g_fuelOk = false;
ethanol::Settings g_settings;            // from the USB cfg file (app thread only)
long            g_settingsAt = -1;
char            g_shown[ethanol::kRowCount][128];
bool            g_shownValid = false;
long            g_subscribedAt = -1;
bool            g_noDataLogged = false;
int             g_totalSeen = 0;
bool            g_fuelTypeLogged = false;

void loadSettings() {
    char path[320];
    ethanol::Settings s;  // defaults
    if (usbFile(kCfgName, "NBT_ETHANOL_CFG", path, sizeof(path), true)) {
        FILE* f = fopen(path, "rb");
        if (f) {
            char buf[4096];
            size_t r = fread(buf, 1, sizeof(buf) - 1, f);
            buf[r] = 0;
            fclose(f);
            int applied = ethanol::parseConfig(buf, s);
            elog("settings: %d key(s) from %s (ethanol=%s)", applied, path, s.hasEthanol ? "set" : "unset");
        }
    } else {
        elog("settings: no %s on a USB stick; using defaults (ethanol unset)", kCfgName);
    }
    g_settings = s;
    g_settingsAt = monoSec();
}

// ---- bmw::Runnable stand-in (vtable: offset-to-top, typeinfo, ~D1, ~D0, run), as in the reference app -------------
struct StandInRunnable { void** vptr; };
void runnableNoop(void*) {}
void initRunnable(StandInRunnable& r, void** vtbl /* 5 slots */, void (*run)(void*)) {
    void** base = reinterpret_cast<void**>(dlsym(RTLD_DEFAULT, "_ZTVN3bmw8RunnableE"));
    if (base) memcpy(vtbl, base, 5 * sizeof(void*));
    else { vtbl[0] = NULL; vtbl[1] = NULL; }
    vtbl[2] = reinterpret_cast<void*>(&runnableNoop);
    vtbl[3] = reinterpret_cast<void*>(&runnableNoop);
    vtbl[4] = reinterpret_cast<void*>(run);
    r.vptr = vtbl + 2;
}
StandInRunnable g_subRunnable, g_renderRunnable;
void* g_subVtbl[5];
void* g_renderVtbl[5];

// ---- display ------------------------------------------------------------------------------------------------------
void writeRow(bmw::PluginApp* app, int row, const char* utf8) {
    unsigned short wide[128];
    ethanol::utf8to16(utf8, wide, 128);
    bmw::BasicString<unsigned short> text(wide);
    app->updateModel(kFirstRowModel + (unsigned)row, text);
}

// Builds the Inputs from the latest fuel reading + current settings, renders the rows, writes changed ones.
void renderRows(bmw::PluginApp* app, bool force) {
    double fuel; bool fuelOk;
    pthread_mutex_lock(&g_dataMutex);
    fuel = g_fuelLitres; fuelOk = g_fuelOk;
    pthread_mutex_unlock(&g_dataMutex);

    ethanol::Inputs in;
    in.fuelL = ethanol::fuelLitres(fuelOk, fuel, ethanol::FUEL_IS_LITRES, g_settings.tankCapacityL);
    in.manualMode = g_settings.manualMode;
    in.manualE = g_settings.manualE;
    if (g_settings.manualMode && !g_settings.hasEthanol) in.manualMode = false;  // nothing typed yet -> "set it"
    in.tankCapacityL = g_settings.tankCapacityL;
    in.targetE = g_settings.targetE; in.e85 = g_settings.e85; in.pump = g_settings.pump;

    ethanol::Labels L = ethanol::render(in);
    const char* rows[ethanol::kRowCount] = {
        L.ethanol.c_str(), L.source.c_str(), L.fuelLevel.c_str(),
        L.addE85.c_str(), L.addPump.c_str(), L.result.c_str(), L.note.c_str()
    };
    for (int i = 0; i < ethanol::kRowCount; ++i) {
        if (!force && g_shownValid && strcmp(rows[i], g_shown[i]) == 0) continue;
        writeRow(app, i, rows[i]);
        snprintf(g_shown[i], sizeof(g_shown[i]), "%s", rows[i]);
    }
    g_shownValid = true;
}

void renderRun(void* /*self*/) {
    bmw::PluginApp* app = g_app;
    if (!app) return;
    if (g_settingsAt < 0 || monoSec() - g_settingsAt >= kSettingsReloadS) loadSettings();
    renderRows(app, false);
    if (!g_noDataLogged && g_subscribedAt >= 0 && g_totalSeen == 0 && monoSec() - g_subscribedAt >= kNoDataWarnS) {
        g_noDataLogged = true;
        elog("no CDS value %ld s after subscribing: the car may not publish sensors.fuel to plugin apps", (long)kNoDataWarnS);
    }
    app->post(reinterpret_cast<bmw::Runnable*>(&g_renderRunnable), kRenderMs);
}

// ---- CDS ----------------------------------------------------------------------------------------------------------
void handleCds(int prop, const bmw::BasicString<unsigned short>& value) {
    char text[256];
    ethanol::narrow(value.raw(), text, sizeof(text));
    if (prop == kFuelProp) {
        double v = 0;
        bool ok = ethanol::numField(text, ethanol::CDS_FUEL_FIELD, &v) && v >= 0 && v < 500;
        pthread_mutex_lock(&g_dataMutex);
        g_fuelLitres = v; g_fuelOk = ok; ++g_totalSeen;
        pthread_mutex_unlock(&g_dataMutex);
        if (g_totalSeen <= 5) elog("CDS sensors.fuel = '%s' -> tanklevel %s", text, ok ? "ok" : "not usable");
    } else if (prop == kEngineInfoProp) {
        double ft = 0;
        bool ok = ethanol::numField(text, ethanol::CDS_FUELTYPE_FIELD, &ft);
        if (!g_fuelTypeLogged) { g_fuelTypeLogged = true; elog("CDS engine.info fuelType = %s ('%s')", ok ? "present" : "absent", text); }
    }
}

typedef bool (*CdsStub)(void*, const bmw::BasicString<unsigned short>&);
template <int P> bool onCds(void* /*app*/, const bmw::BasicString<unsigned short>& v) { handleCds(P, v); return true; }
const CdsStub kStubs[kPropCount] = { &onCds<0>, &onCds<1> };

void subscribeRun(void* /*self*/) {
    bmw::PluginApp* app = g_app;
    if (!app) return;
    for (int p = 0; p < kPropCount; ++p) {
        bmw::BasicString<char> name(propName(p));
        bmw::CdsDelegate d; d.object = app; d.stub = kStubs[p];
        app->cdsAddPropertyChangedEventHandler(name, 0, d);
        elog("CDS handler for %s registered", propName(p));
    }
    g_subscribedAt = monoSec();
    initRunnable(g_renderRunnable, g_renderVtbl, &renderRun);
    app->post(reinterpret_cast<bmw::Runnable*>(&g_renderRunnable), kRenderMs);
}

// ---- the app object -----------------------------------------------------------------------------------------------
void* g_vtbl[2 + kVtblSlots];

bool appOnInit(bmw::PluginApp* self) {
    bool ok = self->onInit();
    g_totalSeen = 0; g_subscribedAt = -1; g_noDataLogged = false; g_shownValid = false; g_fuelTypeLogged = false;
    g_fuelOk = false; g_fuelLitres = 0;
    loadSettings();
    renderRows(self, true);                              // placeholders until CDS / settings arrive
    initRunnable(g_subRunnable, g_subVtbl, &subscribeRun);
    self->post(reinterpret_cast<bmw::Runnable*>(&g_subRunnable), kSubscribeDelayMs);
    elog("onInit: base -> %d, %d rows, CDS subscription in %u ms", (int)ok, (int)ethanol::kRowCount, kSubscribeDelayMs);
    return ok;
}
void appOnError(bmw::PluginApp* /*self*/, unsigned code, const bmw::BasicString<char>& text) {
    const char* s = text.raw(); elog("onError %u: %s", code, s ? s : "(null)");
}
void appOnFinalize(bmw::PluginApp* self) { elog("onFinalize"); g_app = NULL; self->onFinalize(); }

bmw::PluginApp* createApp(bmw::IDispatcher& dispatcher, const char* name, const bmw::Bundle& params, const bmw::Bundle& config) {
    elog("create(name=%s) %s", name ? name : "(null)", ETHANOL_APP_VERSION);
    if (g_app) { elog("create: already created"); return NULL; }
    void* mem = ::operator new(bmw::kPluginAppStorage);
    memset(mem, 0, bmw::kPluginAppStorage);
    bmw::PluginApp* app = new (mem) bmw::PluginApp(dispatcher, bmw::BasicString<char>(name ? name : "EthanolApp"), 1, 0,
                                                   bmw::RHMI_INTERFACE_VERSION_1, params, config);
    void** base = *reinterpret_cast<void***>(app);
    memcpy(g_vtbl, base - 2, sizeof(g_vtbl));
    g_vtbl[2 + kSlotOnInit]     = reinterpret_cast<void*>(&appOnInit);
    g_vtbl[2 + kSlotOnError]    = reinterpret_cast<void*>(&appOnError);
    g_vtbl[2 + kSlotOnFinalize] = reinterpret_cast<void*>(&appOnFinalize);
    *reinterpret_cast<void***>(app) = g_vtbl + 2;
    g_app = app;
    elog("create: app %p", (void*)app);
    return app;
}
void destroyApp(void* app) {
    elog("destroy(%p)", app);
    if (!app) return;
    if (app == g_app) g_app = NULL;
    void** vt = *reinterpret_cast<void***>(app);
    reinterpret_cast<void (*)(void*)>(vt[1])(app);
}

__attribute__((constructor)) void libraryLoaded() { elog("library loaded into pid %d, %s", (int)getpid(), ETHANOL_APP_VERSION); }

} // namespace

// ---- entry point looked up by ManagedPluginApp::init (dlsym "pluginAppInfo") --------------------------------------
extern "C" {
struct EthanolPluginAppInfo {
    uint16_t versionMajor;
    uint16_t versionMinor;
    const char* name;
    const char* vendor;
    uint32_t rhmiInterfaceVersion;
    bmw::PluginApp* (*create)(bmw::IDispatcher&, const char*, const bmw::Bundle&, const bmw::Bundle&);
    void (*destroy)(void*);
};
__attribute__((visibility("default"))) EthanolPluginAppInfo pluginAppInfo = {
    1, 0, "ETHANOL APP", "NBT-ETHANOL", 1, &createApp, &destroyApp
};
}
