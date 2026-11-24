---
name: lab-builder
description: Step-by-step workflow and schema reference for authoring or customizing guided lab .json files with live automated checkoffs and filtered component kits.
---

# Guided Lab Builder Skill (`lab-builder`)

Use this skill whenever a professor, instructor, or developer asks to create a new guided lab assignment (`labs/<lab-id>.json`), customize an existing lab, or add automated circuit/instrument/IEC-60601 checks.

## 1. Guided Lab JSON Schema (`schemaVersion: 1`)

Every lab is a standalone `.json` file validated by `validateAndParseLabJson()` in `js/sim/labEvaluator.js`:

```json
{
  "schemaVersion": 1,
  "id": "lab-custom-id",
  "title": "Lab Title Shown in Sidebar",
  "course": "Course Name / Number",
  "author": "Instructor Name",
  "description": "1–2 sentence overview of the lab learning goals.",
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
      "title": "Short Action-Oriented Step Title",
      "instruction": "Clear student instructions explaining what to wire, configure, or measure.",
      "hint": "Optional collapsible hint with formula or pinout tip.",
      "checks": [
        { "id": "c-pwr", "type": "power-on", "label": "Lab Power is ON" },
        { "id": "c-nano", "type": "part-placed", "partId": "arduino-nano", "label": "Arduino Nano placed" }
      ]
    }
  ]
}
```

## 2. Valid Kit Filter IDs (`filters`)

Set any filter to `null` (or omit it) to show all items, or pass an array of valid IDs:

- **`allowedParts`** (`parts/manifest.json`):
  `arduino-nano`, `opamp-dual-dip8`, `inamp-ad620`, `pot-side-turn`, `pot-top-turn`, `pushbutton-4pin`, `diode-1n4007`, `led-red`, `photoresistor`, `cap-100nf`, `cap-1uf`, `cap-10uf`, `resistor-100-1pct`, `resistor-220-1pct`, `resistor-330-1pct`, `resistor-1k-1pct`, `resistor-2k-1pct`, `resistor-5.1k-1pct`, `resistor-10k-1pct`, `resistor-100k-1pct`, `resistor-1m-1pct`
- **`allowedSensors`** (`js/sim/hardwareRegistry.js`):
  `load-cells`, `emg`, `pulse-ox`, `adum3160` *(use `[]` to hide all external sensors)*
- **`allowedInstruments`**:
  `dmm`, `vps`, `fgen`, `arb`, `scope`, `bode`, `arduino`

## 3. All 15 Live Declarative Check Types (`steps[].checks[]`)

1. **`power-on`**: `{ "type": "power-on", "label": "Lab Power is ON" }`
2. **`board-mode`**: `{ "type": "board-mode", "elvisMode": false, "emgMode": true, "usbIsolatorEnabled": true, "label": "..." }`
3. **`part-placed`**: `{ "type": "part-placed", "partId": "resistor-10k-1pct", "minCount": 2, "label": "Two 10 kΩ resistors placed" }` *(or `"partIds": ["cap-100nf", "cap-1uf"]`)*
4. **`wire-count`**: `{ "type": "wire-count", "min": 3, "label": "At least 3 jumper wires placed" }`
5. **`no-warnings`**: `{ "type": "no-warnings", "label": "Zero shorts or wiring warnings" }`
6. **`led-lit`**: `{ "type": "led-lit", "minBrightness": 0.25, "label": "Red LED conducting safely" }`
7. **`part-prop`**: `{ "type": "part-prop", "partId": "photoresistor", "prop": "lightMode", "equals": "led-ppg", "label": "Photoresistor in LED + Finger PPG mode" }` *(also supports `min`/`max` for numeric props like `wiper`)*
8. **`ic-powered`**: `{ "type": "ic-powered", "partId": "inamp-ad620", "label": "AD620 power rails connected" }`
9. **`instrument-open`**: `{ "type": "instrument-open", "instrumentId": "bode", "label": "Bode Analyzer is open" }`
10. **`dmm-reading`**: `{ "type": "dmm-reading", "mode": "VDC", "min": 2.35, "max": 2.65, "label": "DMM reads 2.50 V (±0.15 V)" }` *(Note: `OHM` and `CONT` require Lab Power OFF; `VDC` and `VAC` require Lab Power ON)*
11. **`bode-cutoff`**: `{ "type": "bode-cutoff", "minHz": 1350, "maxHz": 1850, "label": "Measured -3 dB cutoff fc ≈ 1.59 kHz" }`
12. **`scope-signal`**: `{ "type": "scope-signal", "channel": "ch1", "minVpp": 2.4, "maxVpp": 3.2, "minFreqHz": 1400, "maxFreqHz": 1800, "label": "CH 1 shows ~2.83 Vpp filtered sine" }`
13. **`arduino-running`**: `{ "type": "arduino-running", "requireLibrary": "FIR.h", "minSerialLines": 5, "label": "Sketch running with #include <FIR.h>" }`
14. **`isolation-level`**: `{ "type": "isolation-level", "level": "safe", "maxHpfHz": 60, "label": "IEC 60601 Safe Isolation achieved (fc ≤ 60 Hz)" }`
15. **`manual-check`**: `{ "type": "manual-check", "label": "I recorded the cutoff frequency in my lab notebook" }`

## 4. Registering a Built-In Demo Lab vs Standalone Custom File

- **Standalone Professor File**: Save as any `.json` file and load via the **Lab** tab (`Choose Lab .json File` or drag-and-drop), or host in `labs/<file>.json` and share via `?lab=./labs/<file>.json`.
- **Built-In Demo Lab (shown in the Lab tab launcher list)**:
  1. Save `labs/<lab-id>.json`.
  2. Add entry to `labs/manifest.json`.
  3. Mirror the manifest entry in `OFFLINE_DEMO_LAB_MANIFEST` and the lab object in `OFFLINE_DEMO_LABS` inside `js/labLoader.js`.

## 5. Run Verification

```bash
npm run audit
npm test
```
