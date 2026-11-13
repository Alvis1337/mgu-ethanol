// run_tests.cpp - host tests for the pure logic (blend.hpp, fuel.hpp). Build with g++ -std=gnu++98.
#include "check.hpp"
#include "../src/blend.hpp"
#include "../src/fuel.hpp"
#include "../src/app_core.hpp"

using namespace ethanol;

static void test_blend() {
    std::printf("blend:\n");

    // 1) a normal blend that reaches the target exactly.
    Plan p = plan(Fill(59, 15, 30, 50, 85, 10));
    chk::ok(p.ok, "normal blend ok");
    chk::ok(p.status == Plan::OK, "normal blend status OK");
    chk::near(p.roomL, 44.0, 1e-9, "room = 44 L");
    chk::near(p.e85L, 2060.0 / 75.0, 1e-6, "E85 litres");
    chk::near(p.pumpL, 44.0 - 2060.0 / 75.0, 1e-6, "pump litres");
    chk::near(p.resultE, 50.0, 1e-9, "result = target");
    chk::near(p.e85L + p.pumpL, p.roomL, 1e-9, "E85 + pump fills the room");

    // 2) full tank -> nothing to add.
    Plan full = plan(Fill(59, 59, 40, 50, 85, 10));
    chk::ok(full.ok && full.status == Plan::FULL, "full tank -> FULL");
    chk::near(full.e85L, 0.0, 1e-9, "full: no E85");
    chk::near(full.pumpL, 0.0, 1e-9, "full: no pump");
    chk::near(full.resultE, 40.0, 1e-9, "full: result stays at current");

    // 3) target unreachably high -> LOW, best effort is all E85.
    Plan low = plan(Fill(50, 40, 10, 90, 85, 10));
    chk::ok(low.ok && low.status == Plan::LOW, "too-high target -> LOW");
    chk::near(low.e85L, 10.0, 1e-9, "LOW: fill room with E85");
    chk::near(low.pumpL, 0.0, 1e-9, "LOW: no pump");
    chk::near(low.resultE, 25.0, 1e-9, "LOW: result = highE");

    // 4) target below what even all pump petrol gives -> HIGH.
    Plan high = plan(Fill(50, 40, 80, 20, 85, 10));
    chk::ok(high.ok && high.status == Plan::HIGH, "too-low target -> HIGH");
    chk::near(high.resultE, high.lowE, 1e-9, "HIGH: result = lowE");
    chk::near(high.lowE, 66.0, 1e-9, "HIGH: lowE = 66");

    // 5) bad inputs -> not ok (JS returned null).
    chk::ok(!plan(Fill(0, 0, 0, 50, 85, 10)).ok, "tankL=0 -> not ok");
    double nan = 0.0; nan = nan / nan;  // NaN without <cmath>
    chk::ok(!plan(Fill(59, nan, 30, 50, 85, 10)).ok, "NaN input -> not ok");

    // 6) E85 and pump the same ethanol % -> no blending leverage.
    Plan same = plan(Fill(59, 10, 10, 10, 10, 10));
    chk::ok(same.ok && same.status == Plan::OK, "e85==pump at target -> OK");

    // 7) inputs clamp like the JS version (nowL over tank, nowE over 100).
    Plan cl = plan(Fill(50, 80, 150, 50, 85, 10));
    chk::near(cl.roomL, 0.0, 1e-9, "nowL clamped to tank -> room 0");
    chk::ok(cl.status == Plan::FULL, "over-full clamps to FULL");

    // unit conversions
    chk::near(lToGal(galToL(5.0)), 5.0, 1e-9, "gal<->L round trip");
    chk::near(galToL(1.0), 3.785411784, 1e-9, "1 gal = 3.7854 L");
}

static void test_fuel() {
    std::printf("fuel:\n");

    chk::near(ethanolPct(true, 0.40, RATIO).value, 40.0, 1e-9, "ratio 0.40 -> 40 %");
    chk::near(ethanolPct(true, 85.0, PERCENT).value, 85.0, 1e-9, "percent 85 -> 85 %");
    chk::near(ethanolPct(true, 102.0, BYTE).value, 40.0, 0.05, "byte 0x66 -> ~40 %");
    chk::near(ethanolPct(true, 300.0, PERCENT).value, 100.0, 1e-9, "percent clamps to 100");
    chk::ok(!ethanolPct(false, 50.0, PERCENT).ok, "absent -> not ok");
    { double nan = 0.0; nan = nan / nan; chk::ok(!ethanolPct(true, nan, RATIO).ok, "NaN -> not ok"); }

    chk::near(fuelLitres(true, 45.0, true, 59.0).value, 45.0, 1e-9, "fuel litres passthrough");
    chk::near(fuelLitres(true, 50.0, false, 60.0).value, 30.0, 1e-9, "fuel percent -> litres");
    chk::ok(!fuelLitres(true, 50.0, false, 0.0).ok, "percent w/o capacity -> not ok");

    chk::eqs(pctLabel(ethanolPct(true, 0.40, RATIO)), "40 %", "pct label");
    chk::eqs(pctLabel(Reading()), "--", "absent pct label");
    chk::eqs(litreLabel(fuelLitres(true, 45.0, true, 59.0)), "45.0 L", "litre label");
    chk::eqs(litreLabel(Reading()), "--", "absent litre label");
    chk::eqs(galLabel(galToL(10.0)), "10.00 gal", "gallon label");
}

static void test_app() {
    std::printf("app:\n");

    // live CDS ethanol + live fuel -> live source, computed rows.
    Inputs in;
    in.tankCapacityL = 65; in.targetE = 50; in.e85 = 85; in.pump = 10;
    in.ethanolLive = Reading(30.0);
    in.fuelL = Reading(15.0);
    Labels L = render(in);
    chk::eqs(L.source, "Live (CDS)", "live source");
    chk::eqs(L.ethanol, "30 %", "live ethanol label");
    chk::eqs(L.fuelLevel, "15.0 L", "fuel label");
    chk::ok(L.result == "50 %", "result reaches target");
    chk::ok(L.addE85 != "--" && L.addPump != "--", "fill rows present");

    // manual mode overrides a present live reading.
    in.manualMode = true; in.manualE = 72.0;
    Labels M = render(in);
    chk::eqs(M.source, "Manual", "manual source");
    chk::eqs(M.ethanol, "72 %", "manual ethanol label");

    // no ethanol anywhere -> prompt to set manually, no fill rows.
    Inputs none;
    none.tankCapacityL = 65; none.fuelL = Reading(20.0);   // fuel known, ethanol unknown
    Labels N = render(none);
    chk::eqs(N.source, "No data - set manually", "no-data source");
    chk::eqs(N.ethanol, "--", "no-data ethanol label");
    chk::eqs(N.result, "--", "no-data no result");
    chk::eqs(N.note, "Need ethanol % (set manually)", "no-data note");

    // ethanol known but tank level missing -> ask for tank level.
    Inputs noFuel;
    noFuel.tankCapacityL = 65; noFuel.ethanolLive = Reading(40.0);
    Labels F = render(noFuel);
    chk::eqs(F.ethanol, "40 %", "ethanol shown without fuel");
    chk::eqs(F.note, "Need tank level", "missing-fuel note");

    // full tank note.
    Inputs full;
    full.tankCapacityL = 65; full.fuelL = Reading(65.0); full.manualMode = true; full.manualE = 40;
    chk::eqs(render(full).note, "Tank full - nothing to add", "full note");
}

int main() {
    test_blend();
    test_fuel();
    test_app();
    return chk::report();
}
