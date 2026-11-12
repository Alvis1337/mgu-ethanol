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
- **Fill-up calculator**: how much E85 and how much 93 to add to fill the tank at a target E%.
- **Debug page**: fires a list of read-only requests at the DME and shows what each one answered, to find out
  what your car's DME supports.
- **Read only.** It asks the engine unit (DME, address 0x12) with UDS `22` and OBD `01` reads through the kit's
  read-only link (`kit/runtime/readonly-diag.js`), which refuses every other service. It never writes, codes or
  clears anything.

## Where the number comes from

Tried in order, the first plausible answer wins (`config` in `apps/alvis_ethanol/app.json`):

1. DID `F452` = standard OBD PID 0x52 (ethanol fuel %), through UDS 22; raw 0..255 = 0..100 %.
2. OBD service 01, PID `52`.
3. DID `550D` = the BMW DME's `PROZENT_ALK_KRST` ("percent alcohol in fuel", DME8FF_R: one byte, 0..255 = 0..100 %).

Which of them a DME answers on a given tune is not known in advance: run the Debug page to see. Once you know,
**Settings -> Ethanol source** pins one of them instead of taking the first that answers. If none answers, the screen
says NO DATA and the details line shows the refusal codes. `config.probe` lists extra identifiers that are only *read*
(raw bytes on the details line and the Debug page); use it to work out the scaling of another BMW-specific identifier,
then add it to `config.candidates`.

## Fill-up calculator

**Fill-up calculator** on the main screen. Set the target with **Target -5 / +5** (or Settings -> Fill-up target);
it shows how much E85 and how much 93 to add to fill the tank at that E%, and the lowest and highest E% a full tank can
reach from where you are (all 93 / all E85).

It works from:

- **Ethanol now**: the live reading, else Settings -> Ethanol now, when not read.
- **Fuel in the tank**: read from the DME (`583B`, litres; else OBD PID `2F`, % of the tank), or set by hand in
  Settings -> Fuel in the tank now (1/8 steps).
- **Tank size**: Settings (default 59 l / 15.6 gal).
- **E85 at the pump is really** (default 85; summer / winter E85 is often 70-83 %) and **93 at the pump has**
  (default 10 %).

Amounts are in US gallons or litres (Settings -> Fill-up amounts in). Blending is by volume, so the answer is only as
good as the inputs: pump E85 varies, and a test kit or the car's own reading after a fill-up tells you what you got.

## Debug page

**Debug** on the main screen, then **Run all requests**, with the engine running (or at least the ignition on). It asks
the DME for the VIN and its type (SGBD index), the three ethanol identifiers, fuel type, tank level, a few engine values
and which OBD PIDs it claims to support, then which units are on the bus (22 F150 to all). Each row shows the request,
what it reads, and the answer: green = a value (with the raw bytes), amber = refused (NRC), grey = no reply. The run
takes up to about a minute and fits on one page; take a photo of it. Every row is also written to the app's log.
Everything is a read (UDS 22, OBD 01 / 09) through `kit/runtime/readonly-diag.js`.

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
| `apps/alvis_ethanol/` | the app: `app.json`, `main.js` (screens), `reader.js` (the DME read), `blend.js` (fill-up maths), `debug.js` (Debug page), `icon.png` |
| `kit/` | the MGU App Kit from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT, see `kit/LICENSE`), vendored as the Store builds from it |
| `test/` | unit tests (`test/run.js`) |
| `mgu-repo.json` | what the Store reads |

No BMW SDK files are in this repository; the head unit links the app against the SDK already on it.
