# mgu-ethanol

An app for the BMW iDrive 7 head unit (MGU) that shows the **ethanol content (E%) of the fuel**, for cars running
a flex-fuel setup (an ethanol content analyzer feeding the DME). It is a source for the
[MGU Store](https://github.com/robertnisipeanu/mgu-store): the head unit builds the app from this repository.

Unofficial: nothing here is made, endorsed or supported by BMW AG. Install at your own risk, with the car parked.

## What it does

- Big E% number and a 0-100 bar, with a target band marked (default E30-E50, changeable in Settings).
- Status: in / above / below the band. Min and max since reset. 20-minute trend.
- A details line: which identifier answered and its raw bytes, or why nothing did. If the DME stops answering
  (asleep, engine off) it is asked again every 10 seconds, so the number appears once the engine runs.
- **Fill-up** page: how much E85 and how much 93 to add to fill the tank at a target E%.
- **Debug** page: fires a list of read-only requests at the DME and shows what each one answered, to find out
  what your car's DME supports.

The three pages are tabs at the top (touch them, or turn the controller onto them); in the Standard layout
**Next page** in the bar turns them. The bar's other two buttons do the page's jobs: Reset min / max and the ethanol
source on Ethanol, Target -5 / +5 on Fill-up, Run all requests / More rows on Debug.
- **Read only.** It asks the engine unit (DME, address 0x12) with UDS `22` and OBD `01` reads through the kit's
  read-only link (`kit/runtime/readonly-diag.js`), which refuses every other service. It never writes, codes or
  clears anything.

## Where the number comes from

Tried in order, the first plausible answer wins (`config` in `apps/alvis_ethanol/app.json`):

1. DID `550D` = the BMW DME's `PROZENT_ALK_KRST` ("percent alcohol in fuel", DME8FF_R: one byte, 0..255 = 0..100 %).
2. OBD service 01, PID `52` = standard OBD ethanol fuel %; raw 0..255 = 0..100 %.
3. DID `F452` = the same PID through UDS 22. Last: on the first car tried it got no reply, and a request without a
   reply keeps the head unit's diagnostic transport busy for seconds (the app then waits and sends again, up to 12 s).

Which of them a DME answers on a given tune is not known in advance: run the Debug page to see. Once you know,
**Settings -> Ethanol source** (or the Source button on the Ethanol page) pins one of them instead of taking the
first that answers. If none answers, the screen
says NO DATA and the details line shows the refusal codes. `config.probe` lists extra identifiers that are only *read*
(raw bytes on the details line and the Debug page); use it to work out the scaling of another BMW-specific identifier,
then add it to `config.candidates`.

## Fill-up calculator

The **Fill-up** tab. Set the target with **Target -5 / +5** in the bar (or Settings -> Fill-up target);
it shows how much E85 and how much 93 to add to fill the tank at that E%, and the lowest and highest E% a full tank can
reach from where you are (all 93 / all E85).

It works from:

- **Ethanol now**: the live reading, else Settings -> Ethanol now, when not read.
- **Fuel in the tank**: the instrument cluster's fuel level signal (litres), else read from the DME (`583B`, litres;
  else OBD PID `2F`, % of the tank), or set by hand in
  Settings -> Fuel in the tank now (1/8 steps).
- **Tank size**: Settings (default 59 l / 15.6 gal).
- **E85 at the pump is really** (default 85; summer / winter E85 is often 70-83 %) and **93 at the pump has**
  (default 10 %).

Amounts are in US gallons or litres (Settings -> Fill-up amounts in). Blending is by volume, so the answer is only as
good as the inputs: pump E85 varies, and a test kit or the car's own reading after a fill-up tells you what you got.

## Debug page

The **Debug** tab, then **Run all requests**, with the engine running. One run is laid out to tell where an answer
gets lost:

1. **Car and setup**: the engine state and fuel level from the car's own signals; what the installer left out because
   this unit's firmware lacks it (`kit/missing-interfaces.json`); whether the manifest as built, the app's generated
   interface config and its access list carry the diagnostic transport's request method and response broadcast; and
   whether the app's subscription to the responses worked.
2. **Catalog**: the unit's own SOME/IP interface catalog (`/etc/oap/someip/someip-interfaces.json`): what it lists
   for the diagnostic transport (methods, events, instances), other diagnostic interfaces, and every name in it that
   looks like an ethanol / fuel quality signal - a car signal the app could subscribe to where the DME can't be asked.
3. **Bus**: 22 F150 to all units: which units answer at all, and the DME's type.
4. **Other units**: the VIN from the gateway, body, cluster and head unit, then from the chassis / powertrain FlexRay
   units (DSC, EPS, airbag) and the DME's second address: the transport against the DME alone, and the DME against
   the whole FlexRay side (on the first car tried, a G01 with an MHD flex fuel kit, the DME, DSC, EPS and airbag all
   stayed silent to the head unit while the body units and the gearbox answered; the head unit answered each DME
   request with `F0 F2 7F 31 25`). The head unit wraps each request in a RoutineControl (`31 01 0F0B`: an answer
   comes back as `71 01 0F 0B`, the unit's address, a length and the UDS reply), so `7F 31 25` is that routine's
   negative answer with NRC 25, noResponseFromSubnetComponent: the unit never answered. Such frames carry no
   address, so one can land in the next request's window.
5. **DME**: the VIN (waiting up to 10 s) and type, the three ethanol identifiers, fuel type, tank level, engine
   values, which OBD PIDs it claims to support, and the identifiers MHD's own app reads (`3010 3020 3030 3031 3032
   37FE 586A 4098`, raw: one may carry an MHD flex fuel kit's ethanol content).
6. **Transport**: what the head unit's diagnostic transport (TASU) said: its verdicts, how many responses came back
   and from which unit, errors, rejects, and the raw bytes of the last ones (`tap.js` counts them without changing
   anything; the kit drops whatever is not a reply silently).

Each row shows the request, what it reads and the answer: green = a value (with the raw bytes), amber = refused (NRC),
turned away by the head unit, or **"no reply, but ... came"** (the transport sent something during that request that
the kit did not take as the reply: its raw bytes follow), grey = no reply at all. A unit that gives no reply to 4
requests in a row, or that the head unit turns away 4 times, has its other requests skipped. A run takes up to about two minutes and fills two pages: take a photo
of each (**More rows**). Every row is also written to the app's log. Everything is a read (UDS 22, OBD 01 / 09) through `kit/runtime/readonly-diag.js`.

## Install (MGU Store)

Needs the MGU Store on the car, and iDrive 7. In the Store: **Settings -> Add source**, type
`<your-github-user>/mgu-ethanol`, pick **Branch main** (or Releases once you tag one), then install **Ethanol**. The Store
installs the GPU renderer and controller gate (`requires` in `mgu-repo.json`) from its default sources first.

## Develop

```sh
python3 kit/tools/build.py alvis_ethanol --preview-only      # offline stage in dist/ (no SDK, not installable)
node kit/tools/preview.js dist/alvis_ethanol preview render  # PNG of what it draws (demo data)
NODE=/path/to/node8 tools/check.sh                           # Node 8 syntax of the kit and the app + unit tests
```

The car runs **Node 8**: no `?.`, `??`, object spread, `flat`, `matchAll`, optional catch binding. Every callback goes
through `guard()` in `main.js` (the platform uninstalls an app that crashes).

## Layout

| Path | |
| --- | --- |
| `apps/alvis_ethanol/` | the app: `app.json`, `main.js` (screens), `reader.js` (the DME read), `blend.js` (fill-up maths), `debug.js` (Debug page), `patient.js` (retry while the transport is busy), `tap.js` (what the transport said), `icon.png` |
| `kit/` | the MGU App Kit from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT, see `kit/LICENSE`), vendored as the Store builds from it |
| `test/` | unit tests (`test/run.js`) |
| `mgu-repo.json` | what the Store reads |

No BMW SDK files are in this repository; the head unit links the app against the SDK already on it.
