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
    blend.hpp        fill-up math (pure, ported from the JS blend.js)              ← host-tested
    fuel.hpp         ethanol/fuel value interpretation + label formatting (pure)   ← host-tested
    app_core.hpp     decide live-vs-manual, run the math, format every row (pure)  ← host-tested
    config.hpp       parse the USB settings file (ethanol %, targets) (pure)       ← host-tested
    cds_text.hpp     narrow/utf8<->16 + numField for the CDS JSON text (pure)      ← host-tested
    cds_keys.hpp     the CDS properties used (sensors.fuel, engine.info)
    qnx_binding.cpp  the ONLY file touching the car's frameworks (CDS → render → data model)
  tests/
    run_tests.cpp        pure-logic tests (72 checks)
    app_host_test.cpp    dlopen the built .so, drive it against a fake framework, check the rows
    fake_appframework.*  stand-in for the car's libraries (34-slot vtable), host only
  EthanolApp.xml       menu row + screen, 7 labels bound to raDataModel 21..27
  EthanolApp.manifest  registration read by CAppManager
  Makefile             `make check` (host) / `make` (car) / `make db`
  make_db.py           build the text + image DB zips
```

The pure headers hold every decision and are provable off the car. `qnx_binding.cpp` is the thin cable; the
host integration test loads the actual built library and exercises that cable against a fake framework.

## Build

Off the car (do this now, needs only g++ and Python+Pillow):

```
make check      # pure-logic tests + the dlopen integration test
make db         # writes EthanolApp_ALL_Texts.zip + EthanolApp_ALL_Images.zip
```

For the car (needs the QNX toolchain + the unit's libraries):

1. Install **QNX SDP 6.5** (provides `qcc`, `gcc_ntoarmv7le_gpp`).
2. Copy `libAppFramework.A.so` and `libCoreFramework.A.so` off the unit (`/opt/hmi/ID5/lib`) into `./lib/`.
3. `make` → `libEthanolApp.so`, then `make db`.

## Settings file (how you set the ethanol %)

NBT Evo has no easy on-screen keyboard for a plugin, so the ethanol % and fill-up targets are read from
`nbt-ethanol.cfg` on the **same USB stick** used for logging. The app re-reads it every few seconds, so you can
edit it and watch the rows change. Example:

```
ethanol = 72     # ethanol % now in the tank (what the BC readout shows)
target  = 50     # desired ethanol % after the fill-up
e85     = 85     # ethanol % of the E85 pump (summer ~83, winter ~70)
pump    = 10     # ethanol % of the petrol pump (E10 = 10)
tank    = 65     # tank capacity in litres (G01/F97 ~ 65)
```

The tank **level** is not set here — it comes live from CDS (`sensors.fuel`).

## Install (own car, at your own risk)

Requires **root/SSH** on the head unit and **one** of the coding options `A4A`, `A4A_REMOTE_APPS`,
`REMOTE_HMI`, or `TOUCH_COMMAND` enabled — without one, `HmiMain3D` will not load any PluginApp.

1. Copy `libEthanolApp.so` (as `EthanolApp`), `EthanolApp.xml`, `EthanolApp.manifest`,
   `EthanolApp_ALL_Texts.zip` and `EthanolApp_ALL_Images.zip` into
   `/opt/hmi/ID5/data/ro/Plugins/EthanolApp/` (remount read-only storage writable if needed).
2. Put `nbt-ethanol.cfg` (and an empty `nbt-ethanol.log` to enable logging) on a USB stick.
3. Hold the power button ~30 s to restart. An **ETHANOL APP** row should appear under Media/Radio.
4. To uninstall: delete the folder and restart.

Logs go to `slog` and to `nbt-ethanol.log` on the stick — send me that file after the first drive.

## Status

- ✅ Pure logic (fill-up math, value decode, settings parse, CDS text, decisions) — **host-tested (72 checks)**.
- ✅ CDS reality — **settled**: no live ethanol (manual entry), live tank level in litres from `sensors.fuel`.
- ✅ Framework binding, XML, manifest, data build — written against the reference app's real glue and
  **host-tested**: the integration test `dlopen`s the built `.so`, runs create → onInit → CDS subscribe →
  live fuel → fill-up → finalize against a fake framework and checks the rows.
- ⬜ Build with `qcc` and run on a real unit — needs the two framework libraries and root/SSH on the car.
  (The mangled-symbol declarations, vtable offsets and XML ids still want a final check against the specific
  firmware; the reference app itself notes it has not been run on a unit either.)

## Licensing

This `idrive6/` subtree is **PolyForm-Noncommercial-1.0.0** (see `idrive6/LICENSE`) — the rest of the repo
stays public-domain (The Unlicense). The NBT Evo framework glue, host-test harness, data build and XML/manifest
patterns are derived from [IDRIVE_GAUGE_APP](https://github.com/MGD4096/IDRIVE_GAUGE_APP) and
[NBT-AAD](https://github.com/Sq00ky/Supra-iDrive6-Android-Auto), both PolyForm-Noncommercial, so this subtree
keeps a compatible license. Fine for personal use and sharing; not for sale. The pure logic
(`blend/fuel/app_core`) is original and is also available under The Unlicense from this repo's MGU app.

## Disclaimer

Use at your own risk. Installing native plugins on a head unit needs root and can crash or brick the unit —
the reference project reports the HMI can crash. Not affiliated with or endorsed by BMW. The author is not
responsible for anything that happens to your vehicle, head unit, or data. Never operate while driving.
