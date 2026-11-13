// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Host test: loads a host build of libEthanolApp.so the way ManagedPluginApp does (dlsym "pluginAppInfo"), drives
// create / onInit / posted Runnables / CDS callbacks / onFinalize / destroy against the fake framework, and checks
// the label rows. Adapted from MGD4096/IDRIVE_GAUGE_APP tests/app_host_test.cpp (PolyForm-Noncommercial); see
// idrive6/LICENSE.
#include <dlfcn.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include "fake_appframework.hpp"

static int g_fail = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); ++g_fail; } } while (0)
#define CHECK_STR(a, b) do { std::string _a = (a); if (_a != (b)) { printf("FAIL %s:%d: '%s' != '%s'\n", __FILE__, __LINE__, _a.c_str(), (b)); ++g_fail; } } while (0)

struct Info {
    uint16_t a, b;
    const char* name;
    const char* vendor;
    uint32_t rhmi;
    bmw::PluginApp* (*create)(bmw::IDispatcher&, const char*, const bmw::Bundle&, const bmw::Bundle&);
    void (*destroy)(void*);
};

static int runPosted() {
    std::vector<std::pair<bmw::Runnable*, unsigned> > now;
    now.swap(g_fake.posted);
    for (size_t i = 0; i < now.size(); ++i) {
        void** vptr = *(void***)now[i].first;
        ((void (*)(void*))vptr[2])(now[i].first);   // slot 2 of the vptr array = run()
    }
    return (int)now.size();
}

static void feed(const char* prop, const char* ascii) {
    std::map<std::string, bmw::CdsDelegate>::iterator it = g_fake.cds.find(prop);
    if (it == g_fake.cds.end()) { printf("FAIL: no CDS handler for %s\n", prop); ++g_fail; return; }
    unsigned short buf[256];
    size_t n = 0;
    for (; ascii[n] && n < 255; ++n) buf[n] = (unsigned char)ascii[n];
    buf[n] = 0;
    bmw::BasicString<unsigned short> s(buf);
    it->second.stub(it->second.object, s);
}

static const std::string& row(unsigned i) { return g_fake.modelText[21 + i]; }

int main(int argc, char** argv) {
    if (argc < 2) { printf("usage: %s libEthanolApp.so\n", argv[0]); return 2; }

    // settings the app will read at onInit (ethanol % + fill-up targets, as if from the USB stick)
    const char* cfgPath = "./nbt-ethanol-test.cfg";
    FILE* f = fopen(cfgPath, "wb");
    if (!f) { printf("cannot write %s\n", cfgPath); return 1; }
    fputs("ethanol = 72\ntarget = 50\ne85 = 85\npump = 10\ntank = 65\n", f);
    fclose(f);
    setenv("NBT_ETHANOL_CFG", cfgPath, 1);

    void* h = dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL);
    if (!h) { printf("dlopen: %s\n", dlerror()); return 1; }
    Info* info = (Info*)dlsym(h, "pluginAppInfo");
    if (!info) { printf("no pluginAppInfo\n"); return 1; }
    printf("pluginAppInfo: %u.%u name=%s vendor=%s rhmi=%u\n", info->a, info->b, info->name, info->vendor, info->rhmi);
    CHECK(info->a == 1 && info->b == 0 && info->rhmi == 1);

    char dummy[16];
    bmw::PluginApp* app = info->create(*(bmw::IDispatcher*)dummy, "EthanolApp", *(bmw::Bundle*)dummy, *(bmw::Bundle*)dummy);
    if (!app) { printf("create returned NULL\n"); return 1; }
    CHECK(strcmp(app->name, "EthanolApp") == 0);
    CHECK(info->create(*(bmw::IDispatcher*)dummy, "EthanolApp", *(bmw::Bundle*)dummy, *(bmw::Bundle*)dummy) == NULL);  // single instance

    // ---- onInit: 7 rows, ethanol from the file, tank level not known yet ----
    CHECK(app->onInit());
    CHECK(g_fake.baseOnInit == 1);
    CHECK(g_fake.modelWrites.size() == 7);
    CHECK_STR(row(0), "72 %");                 // ethanol (from cfg)
    CHECK_STR(row(1), "Manual");               // source
    CHECK_STR(row(2), "--");                   // fuel level unknown
    CHECK_STR(row(5), "--");                   // result
    CHECK_STR(row(6), "Need tank level");      // note
    CHECK(g_fake.posted.size() == 1 && g_fake.posted[0].second == 1500);
    CHECK(g_fake.cds.empty());

    // ---- subscription runs: two handlers (sensors.fuel, engine.info) ----
    runPosted();
    CHECK(g_fake.cds.size() == 2);
    CHECK(g_fake.cds.count("sensors.fuel") && g_fake.cds.count("engine.info"));
    CHECK(g_fake.posted.size() == 1 && g_fake.posted[0].second == 500);

    // ---- live tank level arrives -> fill-up computed ----
    feed("sensors.fuel", "{\"fuel\":{\"range\":522,\"reserve\":0,\"tanklevel\":39}}");
    feed("engine.info", "{\"fuelType\":4}");
    CHECK_STR(row(2), "--");                   // not written before the render tick
    runPosted();
    CHECK_STR(row(0), "72 %");
    CHECK_STR(row(2), "39.0 L");               // live tank level, litres
    CHECK_STR(row(5), "50 %");                 // result reaches target
    CHECK(row(3) != "--" && row(3) != "");     // some E85 to add
    CHECK_STR(row(6), "");                     // no warning note
    CHECK(g_fake.posted.size() == 1);          // render loop re-posted itself

    // ---- a bad fuel frame -> tank level unknown again ----
    feed("sensors.fuel", "{\"error\":400}");
    runPosted();
    CHECK_STR(row(2), "--");
    CHECK_STR(row(6), "Need tank level");

    // ---- finalize: the render loop stops posting ----
    bmw::BasicString<char> msg("integration error");
    app->onError(7, msg);
    app->onFinalize();
    CHECK(g_fake.baseOnFinalize == 1);
    runPosted();
    CHECK(g_fake.posted.empty());
    info->destroy(app);

    remove(cfgPath);
    if (g_fail) { printf("%d check(s) failed\n", g_fail); return 1; }
    printf("app_host_test OK\n");
    return 0;
}
