---
name: part-builder
description: Step-by-step workflow and templates for creating a new breadboard part (two-lead or footprint) in Bioelectrical Lab Sim while preserving offline file:// parity and solver integration.
---

# Part Builder Skill (`part-builder`)

Use this skill whenever the user asks to add a new resistor, capacitor, diode, LED, sensor part, potentiometer, or DIP IC to the breadboard parts catalog.

## 1. Decide Placement Type & Pin Geometry

- **Grid Pitch**: `PITCH = 16` SVG units (`16px` per hole).
- **`"placement": "two-lead"`** (axial/radial 2-terminal components whose leads stretch between any two holes `P1` and `P2`):
  - `pins`:
    ```json
    [
      { "id": "P1", "label": "Lead 1" },
      { "id": "P2", "label": "Lead 2" }
    ]
    ```
    *(For polarized parts like diodes, LEDs, or electrolytic caps, use `"Anode (+)"` for `P1` and `"Cathode (-)"` for `P2`.)*
  - `defaultSpan`: integer hole spacing on initial placement (`4` for axial resistors/diodes, `2` for radial caps/LEDs/LDRs).
  - `leadAttachOffset`: positive number in SVG units indicating where the dynamic metal leads attach to the component body along the local X-axis (`-leadAttachOffset` on the left, `+leadAttachOffset` on the right).
  - `svgViewBox`: centered around `(0, 0)`, e.g. `"-24 -9 48 18"`.
- **`"placement": "footprint"`** (fixed multi-pin packages like DIP-8 ICs, Arduino Nano, potentiometers, pushbuttons):
  - `pins`: array of `{ "id": "<PIN_ID>", "label": "<Human Label>", "dx": <int>, "dy": <int> }` in integer hole steps relative to Pin 1 (`dx: 0, dy: 0`).
  - **DIP Trough Rule**: To straddle the breadboard center trough (`row e` to `row f`), bottom-row pins have `dy: 3` (`3 × 16 = 48` SVG units) and top-row pins have `dy: 0`.
  - `pin1Offset`: `{ "x": <number>, "y": <number> }` giving the exact coordinates of Pin 1 inside `svgViewBox="0 0 <W> <H>"`.

## 2. Create `parts/<part-id>/part.json` and `parts/<part-id>/graphic.svg`

### Example A: `two-lead` 1% Metal Film Resistor (`parts/resistor-4.7k-1pct/part.json`)
```json
{
  "id": "resistor-4.7k-1pct",
  "name": "4.7 kΩ Resistor (1%)",
  "shortLabel": "4.7 kΩ",
  "category": "Resistors (1% Metal Film)",
  "description": "4.7 kΩ 1% 5-band metal film resistor (Yellow-Violet-Black-Brown-Brown)",
  "placement": "two-lead",
  "defaultSpan": 4,
  "value": 4700,
  "unit": "Ohm",
  "tolerance": "1%",
  "bands": ["yellow", "violet", "black", "brown", "brown"],
  "svgViewBox": "-24 -9 48 18",
  "leadAttachOffset": 17,
  "pins": [
    { "id": "P1", "label": "Lead 1" },
    { "id": "P2", "label": "Lead 2" }
  ]
}
```

### Example B: `two-lead` Film Capacitor (`parts/cap-470nf/part.json`)
```json
{
  "id": "cap-470nf",
  "name": "470 nF Film Capacitor (474)",
  "shortLabel": "470nF (474)",
  "category": "Capacitors",
  "description": "470 nF (0.47 µF) non-polarized film capacitor (marking 474)",
  "placement": "two-lead",
  "defaultSpan": 2,
  "value": 4.7e-7,
  "unit": "F",
  "marking": "474",
  "svgViewBox": "-16 -12 32 24",
  "leadAttachOffset": 12,
  "pins": [
    { "id": "P1", "label": "Lead 1" },
    { "id": "P2", "label": "Lead 2" }
  ]
}
```

> **SVG Rule**: Avoid duplicate static `<defs>` IDs across multiple files, or let `namespaceSvgIds()` in `js/app.js` namespace them automatically. Keep `graphic.svg` crisp and self-contained.

## 3. Register in BOTH `parts/manifest.json` AND `js/partsLoader.js`

1. Add `"<part-id>"` in logical category order inside `parts/manifest.json`.
2. Add the complete object (with `svgInnerMarkup` containing the inner markup of `graphic.svg` without the outer `<svg ...>...</svg>` tag) to `OFFLINE_PARTS_CATALOG` in `js/partsLoader.js`.
   - **Why?** Browsers block `fetch('./parts/...')` when `index.html` is opened directly via `file://`. `npm run audit` will fail if `parts/manifest.json` and `OFFLINE_PARTS_CATALOG` diverge!

## 4. Check Electrical Solver Support (`js/sim/circuitElements.js`)

- Passive resistors (`"unit": "Ohm"`, numeric `"value"`) and passive capacitors (`"unit": "F"`, numeric `"value"`) are **automatically extracted and stamped** in DC, Transient, and AC Bode solvers.
- If the part has custom interactive properties (like a thermistor or new IC), add its default props in `getDefaultPartProps()` (`js/sim/dcSolver.js`), inspector controls in `buildSimInspectorHtml()` (`js/ui/runtimeOverlay.js`), and MNA stamps in `js/sim/circuitElements.js`.

## 5. Run Verification

```bash
npm run audit
npm test
```
