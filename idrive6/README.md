# Ethanol — iDrive 6 (NBT Evo) port

A port of the MGU (iDrive 7) ethanol app to the **NBT Evo** head unit used by **iDrive 5/6**. Shows fuel
ethanol content and a fill-up calculator (how much E85 + pump petrol to hit a target %).

> **This is not the same program as the iDrive 7 app.** iDrive 6 runs **QNX**, not Linux, and apps are
> **native C++ plugins** loaded by `HmiMain3D`, not Node packages built by the MGU Store. So the JavaScript
> did not carry over — this is a rebuild. What carried over is the logic that was always the real value: the
> fill-up math and manual entry, re-implemented in C++98 and covered by host tests.

Built on the structure proven by the reference native app
[MGD4096/IDRIVE_GAUGE_APP](https://github.com/MGD4096/IDRIVE_GAUGE_APP) (QNX SDP 6.5, CDS data, PluginApp).

## What iDrive 6 can and can't do (settled)

NBT Evo apps don't do diagnostics — they subscribe to the **Car Data Service (CDS)**, the same push feed the
instrument cluster reads. So the question was whether CDS carries ethanol.

- **Live ethanol: no.** The authoritative [CDS property list](https://bimmergestalt.github.io/BMWConnectedAnalysis/cds/)
  has no ethanol / flex-fuel / alcohol / fuel-quality / composition property. The only fuel-type signal,
  `engine.info.fuelType`, is a petrol/diesel-class enum, not an E-percentage. So iDrive 6 hits the same wall
  as MGU — now confirmed from the schema, not a silent probe. **Ethanol is entered by hand.**
- **Live tank level: yes, and this is the win.** `sensors.fuel` reports `tanklevel` in **litres**, push-fed and
  reliable. That is exactly what the fill-up calculator needs, and it was a fight to get on MGU. So on iDrive 6
  the calculator runs on a real, live tank level plus a hand-entered ethanol % — arguably better than the MGU
  version for the fill-up job.

## Layout

```
idrive6/
  src/
    blend.hpp        fill-up math (pure, ported from the JS blend.js)   ← tested
    fuel.hpp         ethanol/fuel value interpretation + label formatting (pure)  ← tested
    app_core.hpp     decide live-vs-manual, run the math, format every row (pure)  ← tested
    cds_keys.hpp     CDS property names + the ethanol candidates to probe
    qnx_binding.cpp  the ONLY file touching the car's frameworks (CDS → render → data model)
  tests/
    run_tests.cpp    host tests (g++, no car) — 53 checks
    check.hpp        tiny test harness
  EthanolApp.xml       menu row + screen, labels bound to raDataModel
  EthanolApp.manifest  registration read by CAppManager
  Makefile             `make check` (host) / `make` (car) / `make db`
  make_db.py           build strings + menu icon
```

The pure headers (`blend/fuel/app_core`) hold all the decisions and are provable off the car. `qnx_binding.cpp`
is a thin cable. Every place that needs a real framework detail is marked **`[RECONCILE]`** — those must be
checked against the headers in the car's `libAppFramework`/`libCoreFramework` before the car build is trusted.

## Build

Off the car (do this now, needs nothing special):

```
make check      # compiles and runs the host tests
make db         # writes data_out/strings.txt + ethanol_icon.png (Pillow optional)
```

For the car (needs the QNX toolchain + the unit's libraries):

1. Install **QNX SDP 6.5** (provides `qcc`, `gcc_ntoarmv7le`).
2. Copy `libAppFramework.A.so` and `libCoreFramework.A.so` off the unit (`/opt/hmi/ID5/lib`) into `./lib/`.
3. `make` → `libEthanolApp.so`.

## Install (own car, at your own risk)

Requires **root/SSH** on the head unit and **one** of the coding options `A4A`, `A4A_REMOTE_APPS`,
`REMOTE_HMI`, or `TOUCH_COMMAND` enabled — without one, `HmiMain3D` will not load any PluginApp.

1. Copy `libEthanolApp.so`, `EthanolApp.xml`, `EthanolApp.manifest`, and the packed data to
   `/opt/hmi/ID5/data/ro/Plugins/EthanolApp/` (remount read-only storage writable if needed).
2. Hold the power button ~30 s to restart. An **Ethanol** row should appear under Media/Radio.
3. To uninstall: delete the folder and restart.

Logs: `slog`, plus `nbt-ethanol.log` on the USB stick (raw CDS ethanol-candidate values — send me that file).

## Status

- ✅ Pure logic (fill-up math, value decode, label/decision logic) — written and **host-tested (53 checks)**.
- ✅ CDS reality — **settled**: no live ethanol (manual entry), live tank level in litres from `sensors.fuel`.
- 🟨 Framework binding (`qnx_binding.cpp`), XML, manifest — the first versions were modeled on the reference
  app's README. The reference app's **actual** glue (hand-declared BMW symbols, runtime vtable patching,
  UTF-16 CDS text, the `pluginAppInfo` export) is more involved; the faithful rewrite is **pending the
  licensing decision below**, since that glue is derived from PolyForm-Noncommercial code and this repo is
  public-domain.
- ⬜ Build with `qcc` and run on a unit — needs the two framework libraries and root/SSH on the car.

## Licensing note (important)

The only working reference for the NBT Evo framework glue is
[IDRIVE_GAUGE_APP](https://github.com/MGD4096/IDRIVE_GAUGE_APP) (and the NBT-AAD project it derives from),
licensed **PolyForm-Noncommercial-1.0.0**. A faithful binding is a derivative of that work and **cannot** be
released into the public domain like the rest of this repo. The pure logic here (`blend/fuel/app_core`) is
original and ported from the MGU app (Unlicense); the framework binding, XML and manifest patterns are not.
Before shipping the car build, this `idrive6/` subtree should carry PolyForm-Noncommercial + attribution
(fine for a personal, non-commercial app), or the glue must be written clean-room. Decide before merging.

## Disclaimer

Use at your own risk. Installing native plugins on a head unit needs root and can crash or brick the unit —
the reference project reports the HMI can crash. Not affiliated with or endorsed by BMW. The author is not
responsible for anything that happens to your vehicle, head unit, or data. Never operate while driving.

Released into the public domain (see repository `LICENSE`, The Unlicense). The reference gauge app and any
BMW framework headers/libraries keep their own licenses.
