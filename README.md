# mgu-ethanol

An app for the BMW iDrive 7 head unit (MGU) that shows the **ethanol content (E%) of the fuel**, for cars running
a flex-fuel setup (an ethanol content analyzer feeding the DME). It is a source for the
[MGU Store](https://github.com/robertnisipeanu/mgu-store): the head unit builds the app from this repository.

Unofficial: nothing here is made, endorsed or supported by BMW AG. Install at your own risk, with the car parked.

## What it does

- Big E% number and a 0-100 bar, with a target band marked (default E30-E50, changeable in Settings).
- Status: in / above / below the band. Min and max since reset. 20-minute trend.
- A details line: which identifier answered and its raw bytes, or why nothing did.
- **Read only.** It asks the engine unit (DME, address 0x12) with UDS `22` and OBD `01` reads through the kit's
  read-only link (`kit/runtime/readonly-diag.js`), which refuses every other service. It never writes, codes or
  clears anything.

## Where the number comes from

Tried in order, the first plausible answer wins (`config` in `apps/alvis_ethanol/app.json`):

1. DID `F452` = standard OBD PID 0x52 (ethanol fuel %), through UDS 22; raw 0..255 = 0..100 %.
2. OBD service 01, PID `52`.

Whether a DME fills PID 0x52 on a given tune is not known in advance. If neither answers, the screen says NO DATA and
the details line shows the refusal codes. `config.probe` lists identifiers that are only *read* and whose raw bytes are
shown on the details line (default: DID `550D`, which the upstream Live Data app lists as "Ethanol in the fuel"); use it
to work out the scaling of a BMW-specific identifier, then add it to `config.candidates`.

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
| `apps/alvis_ethanol/` | the app: `app.json`, `main.js` (screen), `reader.js` (the DME read), `icon.png` |
| `kit/` | the MGU App Kit from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT, see `kit/LICENSE`), vendored as the Store builds from it |
| `test/` | unit tests (`test/run.js`) |
| `mgu-repo.json` | what the Store reads |

No BMW SDK files are in this repository; the head unit links the app against the SDK already on it.
