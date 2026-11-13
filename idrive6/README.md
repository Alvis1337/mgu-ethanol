# Ethanol — iDrive 6 (NBT Evo) port

A port of the MGU (iDrive 7) ethanol app to the **NBT Evo** head unit used by **iDrive 5/6**. Shows fuel
ethanol content and a fill-up calculator (how much E85 + pump petrol to hit a target %).

> **This is not the same program as the iDrive 7 app.** iDrive 6 runs **QNX**, not Linux, and apps are
> **native C++ plugins** loaded by `HmiMain3D`, not Node packages built by the MGU Store. So the JavaScript
> did not carry over — this is a rebuild. What carried over is the logic that was always the real value: the
> fill-up math and manual entry, re-implemented in C++98 and covered by host tests.

Built on the structure proven by the reference native app
[MGD4096/IDRIVE_GAUGE_APP](https://github.com/MGD4096/IDRIVE_GAUGE_APP) (QNX SDP 6.5, CDS data, PluginApp).

## The one thing iDrive 6 might do that iDrive 7 could not

On MGU, the head unit's internal diagnostic route **cannot reach the DME**, so live ethanol was impossible and
the app fell back to manual entry. NBT Evo apps don't do diagnostics at all — they subscribe to the
**Car Data Service (CDS)**, the same push feed the instrument cluster reads (`engine.*`, `sensors.fuel`, …).

**If** CDS publishes a fuel-ethanol property to plugin apps, this port reads ethanol **live**. That is an open
question — we don't yet know the property name or whether it exists. The app subscribes to a list of
candidate names (`src/cds_keys.hpp`) and logs whatever fires, so one tank of known E-content on the car tells
us the answer. If nothing ever fires, manual entry is the answer (same place MGU landed) — and the fill-up
calculator works either way.

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

- ✅ Pure logic (fill-up math, value decode, label/decision logic) — ported and **host-tested (53 checks)**.
- 🟨 Framework binding, XML, manifest — structured against the reference app, **not yet reconciled** with the
  car's headers or run on a unit. All such spots are marked `[RECONCILE]`.
- ❓ Whether CDS exposes ethanol at all — **the experiment**, answered by one logged tank on the car.

## Disclaimer

Use at your own risk. Installing native plugins on a head unit needs root and can crash or brick the unit —
the reference project reports the HMI can crash. Not affiliated with or endorsed by BMW. The author is not
responsible for anything that happens to your vehicle, head unit, or data. Never operate while driving.

Released into the public domain (see repository `LICENSE`, The Unlicense). The reference gauge app and any
BMW framework headers/libraries keep their own licenses.
