# Authoring Custom Lab Guides (`.json`)

**Bioelectrical Lab Sim** supports externally loaded guided labs stored as standalone `.json` files. Professors and instructors can customize existing demo labs or create new labs for their course without modifying the simulator's code.

## How Students Load a Custom Lab

1. **Upload / Drag-and-Drop**: Open the **Lab** tab in the left sidebar and click **Load Lab `.json`** (or drag-and-drop a `.json` file onto the drop zone).
2. **Direct URL Parameter**: Host your `.json` file on the same origin (for example inside your course's GitHub Pages fork under `labs/`) and link students directly with:
   ```
   https://<your-site>/Bioelectrical_Lab_Sim/?lab=./labs/lab1-dc-divider.json
   ```
3. **Download & Edit a Demo Lab**: In the **Lab** tab, click **`⬇ .json`** next to any built-in demo lab to download a ready-to-edit template.

---

## Lab JSON Schema (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "id": "my-course-lab-1",
  "title": "Lab 1: Intro DC Circuits & Voltage Divider",
  "course": "BME 301 — Bioinstrumentation",
  "author": "Prof. Example",
  "description": "Short overview shown at the top of the Lab tab.",
  "initialBoard": {
    "elvisMode": false,
    "loadCellsMode": false,
    "emgMode": false,
    "pulseOxMode": false,
    "usbIsolatorEnabled": false,
    "clearBoard": true,
    "defaultInstrument": "dmm"
  },
  "filters": {
    "allowedParts": ["arduino-nano", "led-red", "resistor-330-1pct", "resistor-10k-1pct"],
    "allowedSensors": [],
    "allowedInstruments": ["dmm"]
  },
  "steps": [
    {
      "id": "step-1",
      "title": "Step Title",
      "instruction": "Clear instructions for what the student should wire or measure.",
      "hint": "Optional collapsible hint shown when the student clicks Hint.",
      "checks": [
        { "id": "c1", "type": "power-on", "label": "Lab Power is ON" },
        { "id": "c2", "type": "part-placed", "partId": "arduino-nano", "label": "Arduino Nano placed" }
      ]
    }
  ]
}
```

### Kit Filtering (`filters`)
All three filter fields are optional. Omit a field or set it to `null` to show everything; pass an array of IDs to restrict the sidebar and bench rail to only the components needed for the lab (pass `[]` to hide all sensors). Instructors and students can temporarily reveal all parts and instruments at any time using the **Show All** toggle in the Lab tab.

- **Valid `allowedParts` IDs** (from `parts/manifest.json`):
  - Microcontrollers & ICs: `arduino-nano`, `opamp-dual-dip8`, `inamp-ad620`
  - Controls & Input: `pot-side-turn`, `pot-top-turn`, `pushbutton-4pin`
  - Diodes & Optoelectronics: `diode-1n4007`, `led-red`, `photoresistor`
  - Capacitors: `cap-100nf`, `cap-1uf`, `cap-10uf`
  - Resistors (1% Metal Film): `resistor-100-1pct`, `resistor-220-1pct`, `resistor-330-1pct`, `resistor-1k-1pct`, `resistor-2k-1pct`, `resistor-5.1k-1pct`, `resistor-10k-1pct`, `resistor-100k-1pct`, `resistor-1m-1pct`
- **Valid `allowedSensors` IDs** (from `js/sim/hardwareRegistry.js`):
  - `load-cells`, `emg`, `pulse-ox`, `adum3160`
- **Valid `allowedInstruments` IDs**:
  - `dmm`, `vps`, `fgen`, `arb`, `scope`, `bode`, `arduino`

---

## Live Automated Check Types (`steps[].checks[]`)

Every check requires `type` and `label` (plus an optional unique `id`):

| `type` | Parameters | What It Verifies Live |
|---|---|---|
| `power-on` | *(none)* | Lab Power is ON (`⚡ Power: ON`). |
| `board-mode` | `elvisMode?`, `loadCellsMode?`, `emgMode?`, `pulseOxMode?`, `usbIsolatorEnabled?` | Matches all specified board / hardware / isolator boolean states. |
| `part-placed` | `partId` *(or `partIds: []`)*, `minCount?` (default `1`) | At least `minCount` matching parts are placed on the breadboard. |
| `wire-count` | `min` | At least `min` jumper wires are placed on the breadboard. |
| `no-warnings` | *(none)* | Zero active connectivity/short-circuit warnings. |
| `led-lit` | `minBrightness?` (default `0.2`), `allowOvercurrent?` (default `false`) | At least one placed LED is forward-biased and glowing cleanly. |
| `part-prop` | `partId`, `prop`, `equals?`, `min?`, `max?` | A placed part's property (e.g., `lightMode: "led-ppg"`, `fingerPresent: true`, `wiper: 0.5`) matches. |
| `ic-powered` | `partId?` | Placed IC (e.g., `inamp-ad620`, `opamp-dual-dip8`) has valid DC power rails. |
| `instrument-open` | `instrumentId` | Specified bench instrument (`dmm`, `scope`, `bode`, `arduino`, etc.) is currently open/visible. |
| `dmm-reading` | `mode?` (`VDC`/`VAC`/`OHM`/`CONT`), `min?`, `max?`, `absValue?` | Live DMM measurement falls within `[min, max]`. |
| `bode-cutoff` | `minHz?`, `maxHz?` | Bode Analyzer sweep detected a valid `-3 dB` cutoff frequency `fc` within `[minHz, maxHz]`. |
| `scope-signal` | `channel` (`ch0`/`ch1`), `minVpp?`, `maxVpp?`, `minFreqHz?`, `maxFreqHz?`, `minRms?`, `maxRms?` | Oscilloscope channel has a valid waveform matching the specified bounds. |
| `arduino-running` | `requireLibrary?` (e.g. `"FIR.h"`), `minSerialLines?` | Arduino Nano sketch is running with zero compile errors, includes the required library, and has streamed at least `minSerialLines` lines. |
| `isolation-level` | `level` (`"safe"` or `"partial"`), `requireCheck?`, `minHpfHz?`, `maxHpfHz?` | Evaluates the live IEC 60601 Isolation Assessment verdict and detected high-pass cutoff frequency. |
| `manual-check` | *(none)* | Interactive student self-check box (saved locally per lab). |

---

## Included Demo Labs

- [`lab1-dc-divider.json`](./lab1-dc-divider.json) — Intro DC Circuits & Voltage Divider (5 parts, DMM only)
- [`lab2-rc-filter-bode.json`](./lab2-rc-filter-bode.json) — Analog RC Low-Pass Filter & Bode Plot (5 parts, ELVIS II + FGEN/Scope/Bode)
- [`lab3-optical-ppg.json`](./lab3-optical-ppg.json) — Optical Finger PPG with LED + Photoresistor (5 parts, Nano/DMM/Scope)
- [`lab4-isolated-emg-fir.json`](./lab4-isolated-emg-fir.json) — Safe Isolated Surface EMG with IEC 60601 + FIR DSP (5 parts, EMG + ADuM3160 + Nano)
