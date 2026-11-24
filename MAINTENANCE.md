# Maintenance & Long-Term Evolution Guide

This document is the primary technical reference for maintaining, extending, and debugging **Bioelectrical Lab Sim** over future semesters.

---

## 1. Non-Negotiable Architectural Invariants

1. **100% Zero-Build Static ES2022+ Modules**
   - The app runs directly on **GitHub Pages** and via local `file://` or `python3 -m http.server` without any bundler (`webpack`, `vite`, `rollup`), transpiler, or runtime npm dependencies.
   - Always use relative `./` or `../` paths with explicit `.js` extensions in `import` statements and `fetch()` calls.
2. **Pure Zero-DOM Simulation Engine (`js/sim/*`)**
   - Every file under `js/sim/` (`linearAlgebra.js`, `circuitElements.js`, `dcSolver.js`, `transientSolver.js`, `acSolver.js`, `emgModel.js`, `ppgModel.js`, `arbModel.js`, `hardwareRegistry.js`, `isolationAnalyzer.js`, `labEvaluator.js`, `arduinoLibraries.js`, `arduinoRuntime.js`) **must never reference `window`, `document`, or DOM/SVG APIs**.
   - All `js/sim/*` modules must run directly in Node 20+ via `npm test` (`node --test`).
3. **Dual-Source Offline `file://` Parity**
   - Browser `fetch('./parts/...')` and `fetch('./labs/...')` succeed over HTTP(S), but browsers block `fetch()` over `file://`.
   - Therefore:
     - Every part in `parts/manifest.json` and `parts/<part-id>/{part.json,graphic.svg}` **must** be mirrored in `OFFLINE_PARTS_CATALOG` inside [`js/partsLoader.js`](./js/partsLoader.js).
     - Every built-in demo lab in `labs/manifest.json` and `labs/<lab-id>.json` **must** be mirrored in `OFFLINE_DEMO_LAB_MANIFEST` and `OFFLINE_DEMO_LABS` inside [`js/labLoader.js`](./js/labLoader.js).
   - Running `npm run audit` (`node scripts/audit-repo.mjs`) automatically verifies 100% parity between disk files and offline mirrors.
4. **Two-Tier Render Path (Never Destroy Static SVG on Fast Ticks)**
   - **Topology Change (`app.recalculateAndRender()`)**: Runs when parts/wires/board modes are added, moved, rotated, or deleted. Rebuilds `this.connectivity` and static `#layer-wires` / `#layer-parts` SVG DOM.
   - **Fast Simulation Tick (`bench.runSimulation()` / `app.recomputeSimulation()`)**: Runs on slider drags, pushbutton holds, FGEN/ARB/VPS/Scope/Bode changes, and Arduino GPIO/PWM ticks. Updates **only** `#layer-runtime-overlay`, instrument canvases, inspector telemetry, and live lab checkoffs without touching static breadboard SVG nodes.
5. **Backward-Compatible Circuit Persistence (`js/persistence.js`)**
   - `parseCircuitState()` must continue accepting legacy `v4` (`glowing-waddle`) and `v5` circuit JSON files.
   - `BenchController.normalizeSimConfig()` and `simStateExtras` must preserve unknown future keys across load/save cycles.
6. **Viewport & Layout Budget (`1280×720`)**
   - At `1280×720` desktop/laptop resolution, the outer document must have **`0px` horizontal and vertical scroll** (`documentElement.scrollWidth <= innerWidth` and `scrollHeight <= innerHeight`).
   - Any element toggled via the HTML `hidden` attribute that has an explicit CSS `display: flex | inline-flex | grid` rule **must** have a matching `.selector[hidden] { display: none; }` rule.

---

## 2. Cookbook A: Adding a New Breadboard Part

Use the **`part-builder`** skill (`.agents/skills/part-builder/SKILL.md`) or follow these exact steps:

### Step 1: Choose the Placement Mode & Coordinates
- **Breadboard pitch**: `PITCH = 16` SVG units (`16px` per `0.1"` hole spacing).
- **`"placement": "two-lead"`** (Resistors, Capacitors, Diodes, LEDs, Photoresistors):
  - `pins`: `[{ "id": "P1", "label": "Lead 1" }, { "id": "P2", "label": "Lead 2" }]` (use `"Anode (+)"` / `"Cathode (-)"` for polarized parts).
  - `defaultSpan`: integer hole spacing on placement (typically `4` for axial parts, `2` for radial caps/LEDs/LDRs).
  - `leadAttachOffset`: half-width of the component body in SVG units where the dynamic metal leads attach along the local X axis (`-leadAttachOffset` for `P1`, `+leadAttachOffset` for `P2`).
  - `graphic.svg`: centered at `(0, 0)` inside `svgViewBox` (e.g. `"-26 -12 52 24"`).
- **`"placement": "footprint"`** (DIP ICs, Arduino Nano, Potentiometers, Pushbuttons):
  - `pins`: array of `{ "id": "...", "label": "...", "dx": <int>, "dy": <int> }` in integer hole grid offsets relative to `anchorHoleId` (`(0,0)` is top-left pin 1).
  - For DIP ICs straddling the center trough (`e` row to `f` row), the vertical step across the trough is **`dy: 3`** (`3 × 16 = 48` SVG units).
  - `graphic.svg`: written in top-left SVG coordinates matching `svgViewBox="0 0 <width> <height>"`, with `pin1Offset: { "x": ..., "y": ... }` specifying the pixel offset from the SVG's top-left corner to Pin 1 `(dx=0, dy=0)`.

### Step 2: Create `parts/<part-id>/part.json` and `parts/<part-id>/graphic.svg`
- Required `part.json` fields:
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

### Step 3: Register in `parts/manifest.json` & `js/partsLoader.js`
1. Add `"<part-id>"` to the `"parts"` array in [`parts/manifest.json`](./parts/manifest.json).
2. Add the matching entry (including `svgInnerMarkup`: the inner content of `graphic.svg` without the outer `<svg>` wrapper) to `OFFLINE_PARTS_CATALOG` in [`js/partsLoader.js`](./js/partsLoader.js).

### Step 4: Electrical Solver Behavior (If Needed)
- **Passive Resistor (`unit: "Ohm"`) or Capacitor (`unit: "F"`)**: Automatically recognized by [`js/sim/circuitElements.js`](./js/sim/circuitElements.js) using `partDef.value` and `partDef.unit`! No solver code changes are needed.
- **New Active / Non-Linear Component**: Update `extractCircuitElements()` in [`js/sim/circuitElements.js`](./js/sim/circuitElements.js) and stamp its MNA contribution across `dcSolver.js`, `transientSolver.js`, and `acSolver.js`.

### Step 5: Verify
Run `npm run audit && npm test`.

---

## 3. Cookbook B: Authoring or Updating a Guided Lab (`.json`)

Use the **`lab-builder`** skill (`.agents/skills/lab-builder/SKILL.md`) or see [`labs/README.md`](./labs/README.md).

1. **Create or Edit `labs/<lab-id>.json`** following `schemaVersion: 1`:
   - `initialBoard`: `{ elvisMode, loadCellsMode, emgMode, pulseOxMode, usbIsolatorEnabled, clearBoard, defaultInstrument }`
   - `filters`: `{ allowedParts: [...], allowedSensors: [...], allowedInstruments: [...] }` (use `null` to allow all, or `[]` to hide all external sensors).
   - `steps`: array of `{ id, title, instruction, hint, checks: [...] }` using any of the 15 check types (`power-on`, `board-mode`, `part-placed`, `wire-count`, `no-warnings`, `led-lit`, `part-prop`, `ic-powered`, `instrument-open`, `dmm-reading`, `bode-cutoff`, `scope-signal`, `arduino-running`, `isolation-level`, `manual-check`).
2. **If Adding to the Built-In Demo Labs Menu**:
   - Add metadata entry to [`labs/manifest.json`](./labs/manifest.json).
   - Mirror the manifest entry in `OFFLINE_DEMO_LAB_MANIFEST` and the lab object in `OFFLINE_DEMO_LABS` inside [`js/labLoader.js`](./js/labLoader.js).
3. **Verify**:
   - Run `npm run audit && npm test` (automatically validates JSON schema, checks every `allowedParts`/`allowedSensors`/`allowedInstruments` ID against the registries, and verifies offline mirror parity).

---

## 4. Cookbook C: Adding an External Sensor or IEC 60601 Isolation Rule

### Adding a New External Sensor or Safety Module
1. **Declarative Metadata**: Register the module in `HARDWARE_MODULES` inside [`js/sim/hardwareRegistry.js`](./js/sim/hardwareRegistry.js) with `id`, `category` (`'sensor'` or `'safety'`), `boardFlag` or `simConfigFlag`, and `controls` (`range` / `toggle`). The left sidebar **Sensors** tab (`js/ui/sidebarManager.js`) and Bench Stimulus tray (`js/ui/workspaceManager.js`) render from this registry.
2. **Terminal Holes & SVG Artwork**: If the sensor mounts terminals around the breadboard, add its hole definitions in [`js/breadboard.js`](./js/breadboard.js) and its SVG rendering in `renderExternalSensorsMarkup()` inside [`js/boardRenderer.js`](./js/boardRenderer.js).
3. **Physics Stamping**: Stamp its electrical model in [`js/sim/circuitElements.js`](./js/sim/circuitElements.js).

### Adding or Tuning an IEC 60601 Isolation Check
1. Open [`js/sim/isolationAnalyzer.js`](./js/sim/isolationAnalyzer.js).
2. Patient-applied sensors are declared in `PATIENT_APPLIED_SENSOR_SPECS` (e.g., 3-Pad Surface EMG terminals `EMG_RED1`, `EMG_RED2`, `EMG_BLK`).
3. Barrier checks are registered in `ISOLATION_BARRIER_CHECKS`:
   - `galvanic-host-isolation` (verifies `ADuM3160` USB isolation when Nano is connected and checks for any wire bridging the isolated patient domain to mains-referenced ELVIS II ground).
   - `secondary-highpass-blocking` (verifies an un-bypassed series high-pass capacitor blocks DC fault paths between patient electrodes / amplifier output and downstream acquisition pins, computing $f_c = 1/(2\pi R_{\text{eq}} C_{\text{eq}})$ including parallel bias dividers).
   - `patient-rail-fault` (verifies no patient electrode is tied directly to a low-impedance DC power rail).
   - `lead-current-limiting` (advisory check for $\ge 10\text{ k}\Omega$ series patient lead protection resistors).
4. Add unit tests in [`tests/isolationAnalyzer.test.js`](./tests/isolationAnalyzer.test.js).

---

## 5. Cookbook D: Adding an Arduino `#include <...>` Library or Built-In Sketch

1. **Add a Library**: Open [`js/sim/arduinoLibraries.js`](./js/sim/arduinoLibraries.js) and register a new header entry in `ARDUINO_LIBRARY_REGISTRY` (follow the `FIR.h` pattern: pure JS preamble injected when `#include <Header.h>` is parsed by `transpileArduinoSketch`).
2. **Add an Example Sketch**: Append a new `{ id, name, description, code }` entry to `ARDUINO_EXAMPLE_SKETCHES` in [`js/sim/arduinoRuntime.js`](./js/sim/arduinoRuntime.js).
3. **Verify**: Add transpiler/runner tests in [`tests/arduinoRuntime.test.js`](./tests/arduinoRuntime.test.js) and run `npm test`.

---

## 6. Common Failure Modes & Diagnostic Playbook

| Symptom | Root Cause to Check | Verification Tool |
|---|---|---|
| Part or Lab loads on `http://localhost` but fails on `file://` | `parts/manifest.json` or `labs/manifest.json` was updated without updating `OFFLINE_PARTS_CATALOG` (`js/partsLoader.js`) or `OFFLINE_DEMO_LABS` (`js/labLoader.js`). | `npm run audit` (`scripts/audit-repo.mjs`) |
| Capacitor / RC filter attenuates on Scope or Bode, but Arduino `analogRead(A0)` sees unfiltered signal | Circuit must step through `createLiveCircuitStepper` (`js/sim/transientSolver.js`) during live Arduino execution rather than memoryless `solveDcCircuit()`. | `tests/presets.test.js` (`arb-ekg-fir`, `emg-isolated-safe`) |
| Coarse Scope timebase (`200 ms/div`) under-attenuates a fast RC filter (`1.59 kHz`) | Outer sample step `dt` is too large relative to $RC$; verify Backward-Euler sub-stepping (`MAX_SUBSTEPS = 16`) in `solveTransientCircuit()`. | `tests/transientSolver.test.js` (Test 7) |
| Setting `el.hidden = true` in JS does not hide a button or card in the UI | A CSS class on `el` defines `display: flex`, `inline-flex`, or `grid`, which overrides the browser's user-agent `[hidden]` rule. Add `.my-class[hidden] { display: none; }`. | `npm run audit` + Headless Chromium `getComputedStyle(el).display` |
| Duplicate SVG gradient/clip appearance when multiple parts are rendered | SVG `<defs>` IDs inside `graphic.svg` must be namespaced per instance (`namespaceSvgIds` in `js/app.js`). | Inspect `#catalog-list` & `#layer-parts` in Chromium |
| Outer page scrollbar appears at `1280×720` | A new toolbar button, dock tab, or sidebar header item wrapped to a second line. Keep `.topbar` at `47px`, `.sidebar-header` 1-row, and `.dock-tabs` 1-row. | Headless Chromium audit (`verify-ui` skill) |
