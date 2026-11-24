# Bioelectrical Lab Sim

An interactive, zero-build browser simulator for undergraduate bioelectrical engineering and biomedical instrumentation labs—evolved from `glowing-waddle`. Build circuits on an 830-point solderless breadboard, toggle an **NI ELVIS II** prototyping board layout, wire external **Load Cells** (full-bridge & half-bridge), **3-Pad Surface EMG** electrodes, **True Dual-LED Photodiode Pulse-Ox** (or optical **LED + Photoresistor PPG**), and an inline **ADuM3160 USB Isolator**, assess **IEC 60601** dual-layer patient isolation, run virtual **NI ELVISmx** bench instruments (`DMM`, `VPS`, `FGEN`, `ARB` EKG, `Scope`, `Bode`), program an **Arduino Nano** with `#include <FIR.h>` digital filters, and load professor-customizable **Guided Labs (`.json`)** with live automated checkoffs and filtered component kits.

---

## Completed Milestones

1. **Circuit & Virtual Bench Simulator (Phase 1)**
   - [x] **Milestone 1 (DC MNA Solver + Virtual DMM)**: Real-time Modified Nodal Analysis DC solver with active-net pruning, Virtual Multimeter (`DC V`, `Ohm`, `Continuity`, `COM → GND`), live NI ELVIS II & Arduino DC supplies, interactive potentiometer / push button / photoresistor / load cell force controls, and live LED glow & overcurrent/polarity diagnostics.
   - [x] **Milestone 2 (Transient MNA + FGEN + Oscilloscope)**: Time-domain Backward-Euler MNA solver for capacitors/RC filters/op-amps/AD620/diodes, NI ELVIS II Function Generator (`FGEN`), virtual 2-channel Oscilloscope (`AI 0` / `AI 1` / `AO 0` / `AO 1` / `FGEN` / board probes, AC/DC coupling, edge trigger, cursors, Autoscale), DMM `AC V` (`V~`), and collapsible right dock & Full Bench workspace.
   - [x] **Milestone 3 (Bode Analyzer & Dynamic 3-Pad EMG)**: Complex small-signal AC frequency-sweep solver & NI ELVISmx Bode Analyzer (dual-pane magnitude/phase CRT, auto `-3 dB` cutoff markers, interactive frequency cursor), and dynamic 3-pad surface EMG generator (contraction bursts, 60 Hz common-mode mains hum, electrode impedance mismatch).
2. **Arduino Nano Simulator & DSP (Phase 2)**
   - [x] **Arduino Nano Programming Simulator**: Zero-dependency Arduino C++ subset transpiler & sandboxed async runner (`pinMode`, `digitalWrite`, `digitalRead`, `analogRead`, `analogWrite` PWM, `delay`, `millis`, `Serial` I/O), extensible library registry (`js/sim/arduinoLibraries.js` with `#include <FIR.h>` digital filtering), live stateful Backward-Euler capacitor stepping (`createLiveCircuitStepper`), dark-adapted Nano IDE (`Serial Monitor`, 4-channel `Serial Plotter`, live `Pin Monitor`), and NI ELVISmx Variable Power Supplies (`VPS` tab).
3. **Bioelectrical Transducers, ARB EKG & IEC 60601 Isolation (Phase 3)**
   - [x] **Milestone 3A (Workspace Reorganization)**: Single-row `47px` topbar, `Parts | Sensors | Lab` left sidebar, and Solo Focus modes for Nano IDE and Bode Analyzer with optional `[◫ Side Bench]` drawer.
   - [x] **Milestone 3B (Optical PPG & True Dual-LED Pulse-Ox)**: LED-coupled Photoresistor (`Manual Light` | `LED + Finger PPG`) requiring a lit Red LED on the breadboard, standalone 5-lead True Dual-LED Photodiode Pulse-Ox (`660 nm` Red + `940 nm` IR + Beer-Lambert $\text{SpO}_2$ physics), and slow physiological Scope timebases (`200 ms/div`, `500 ms/div`).
   - [x] **Milestone 3C (NI ELVISmx Arbitrary Waveform Generator — ARB)**: Dual-channel `AO 0` / `AO 1` ARB with built-in lead-II **EKG (QRS)** synthesis (`BPM`, `60 Hz Hum`, `Baseline Wander`, `Gain`), custom `.csv`/`.txt` waveform upload, and `arb-ekg-fir` preset.
   - [x] **Milestone 3D (Multi-Frequency RC Filtering & IEC 60601 Isolation Assessment)**: Physiological QRS bandwidth (`~18–85 Hz`), real-time stateful RC filtering on `analogRead()`, `1 µF` film capacitor (`cap-1uf`), inline **ADuM3160 USB Isolator**, and extensible **IEC 60601 Isolation Assessment** engine (`js/sim/isolationAnalyzer.js`) verifying galvanic host USB isolation + secondary high-pass DC-blocking barriers.
4. **Extensible Guided Labs & Kit Filtering (Phase 4)**
   - [x] **Guided Lab Engine (`labs/*.json`)**: Externally loadable `.json` lab guides (file picker, drag-and-drop, or `?lab=./labs/<file>.json` URL parameter), 15 live auto-evaluating check types (`dmm-reading`, `bode-cutoff`, `scope-signal`, `arduino-running`, `isolation-level`, `led-lit`, `part-prop`, etc.), component/sensor/instrument kit filtering with instructor `Show All` override, and 4 downloadable demo labs.

---

## Architecture

The application is **100% static HTML, CSS, and native ES2022+ modules** (zero build step, zero bundler, zero runtime npm dependencies—ready for GitHub Pages and offline `file://` usage):

```text
Bioelectrical_Lab_Sim/
├── index.html                 # Application shell, single-row topbar, 3-tab sidebar, workspace & right dock
├── AGENTS.md                  # AI & subagent roster, skills index, and task routing playbook
├── MAINTENANCE.md             # Long-term architectural invariants, extension cookbooks & QA checklists
├── css/
│   ├── styles.css             # Layout, breadboard, SVG components, Sensors/Lab tabs & safety pill styling
│   ├── elvismx.css            # Dark-adapted NI ELVISmx soft front panels & Option C workspace layout
│   └── arduino.css            # Dark-adapted Arduino Nano IDE, Serial Monitor/Plotter & 7-tab dock styling
├── js/
│   ├── app.js                 # Main UI controller, drag-and-drop, wire drawing, probing, zoom/pan & lab wiring
│   ├── breadboard.js          # 830-point breadboard, NI ELVIS II connector, and external sensor terminal model
│   ├── boardRenderer.js       # Pure SVG rendering helpers for boards, external sensors, ADuM3160 & wire paths
│   ├── connectivity.js        # Disjoint-Set net analyzer, pin occupancy tracking, and short detection
│   ├── partsLoader.js         # Dynamic catalog loader from ./parts/ with file:// offline fallback
│   ├── labLoader.js           # Guided lab loader from ./labs/ or ?lab= URL with file:// offline fallback
│   ├── presets.js             # 14 classroom demo circuits
│   ├── rcCalculator.js        # Floating RC filter calculator (f_c = 1 / 2πRC) & pure solver helper
│   ├── persistence.js         # v5/v4 JSON serialization, localStorage, and clean SVG export
│   ├── controllers/
│   │   └── benchController.js # Virtual bench orchestration, instrument lifecycle, probes, presets & lab context
│   ├── sim/
│   │   ├── linearAlgebra.js   # Real/complex linear solvers, waveform evaluation, metrics, and trigger primitives
│   │   ├── circuitElements.js # Shared MNA element extraction, active-net pruning, and stamping primitives
│   │   ├── dcSolver.js        # Zero-DOM Modified Nodal Analysis DC solver, passive Ohmmeter & timeSec sampling
│   │   ├── transientSolver.js # Zero-DOM Backward-Euler transient solver & createLiveCircuitStepper
│   │   ├── acSolver.js        # Zero-DOM complex MNA small-signal AC frequency-sweep (Bode Analyzer) solver
│   │   ├── emgModel.js        # Physiological 3-pad surface EMG MUAP burst + 60 Hz common-mode interference model
│   │   ├── ppgModel.js        # Optical LED-coupled LDR PPG & dual-wavelength Beer-Lambert SpO2 model
│   │   ├── arbModel.js        # NI ELVISmx ARB synthesis (Lead-II EKG QRS + 60 Hz hum + CSV parser)
│   │   ├── hardwareRegistry.js# Declarative external sensor & safety hardware registry
│   │   ├── isolationAnalyzer.js# Extensible IEC 60601 patient isolation graph analyzer
│   │   ├── labEvaluator.js    # Zero-DOM Lab Guidance JSON validator & 15-type live check evaluator
│   │   ├── arduinoLibraries.js# Extensible Arduino library registry (built-in #include <FIR.h>)
│   │   └── arduinoRuntime.js  # Zero-dependency Arduino Nano C++ subset transpiler & sandboxed async runner
│   └── ui/
│       ├── elvismxControls.js # Shared NI ELVISmx dials, bar graph, Run/Stop footer & scale formatters
│       ├── workspaceLayout.js # Pure layout visibility model (Full Bench, Solo Focus Nano/Bode, Side Bench)
│       ├── workspaceManager.js# Collapsible tabbed right instrument dock, Full Bench switcher & kit filtering
│       ├── sidebarManager.js  # Left sidebar segmented tabs (Parts | Sensors | Lab), sensor cards & IEC 60601 card
│       ├── labPanel.js        # Guided Lab tab UI (.json upload/dropzone, demo labs, live checklist & hints)
│       ├── dmmPanel.js        # NI ELVISmx Virtual Multimeter (DC V, AC V, Ohm, Continuity)
│       ├── vpsPanel.js        # NI ELVISmx Variable Power Supplies (SUPPLY + / SUPPLY -, Enable/Standby)
│       ├── fgenPanel.js       # NI ELVISmx Function Generator (Sine/Triangle/Square, quick freqs, probe)
│       ├── arbPanel.js        # NI ELVISmx Arbitrary Waveform Generator (AO 0 / AO 1, EKG QRS, CSV upload)
│       ├── scopePanel.js      # NI ELVISmx 2-Channel Oscilloscope (CRT canvas, trigger, cursors, Autoscale)
│       ├── bodePanel.js       # NI ELVISmx Bode Analyzer (dual-pane Gain/Phase CRT, -3 dB cutoffs, cursor)
│       ├── arduinoPanel.js    # Arduino Nano IDE (editor, Serial Monitor, Serial Plotter & Pin Monitor)
│       └── runtimeOverlay.js  # SVG LED glow, PPG pulse halo, bridged-wire hazard halo & inspector telemetry
├── parts/
│   ├── manifest.json          # Registry of available component folders (21 parts)
│   └── <part-id>/             # Component metadata (part.json) + vector artwork (graphic.svg)
├── labs/
│   ├── manifest.json          # Registry of downloadable demo labs (4 guided labs)
│   ├── README.md              # Professor authoring guide for custom .json lab files
│   └── <lab-id>.json          # Standalone guided lab definitions
├── scripts/
│   └── audit-repo.mjs         # Automated parity & integrity auditor (parts, labs, presets, syntax)
├── tests/                     # Zero-dependency Node test suite (160+ tests via `npm test`)
└── .agents/                   # Repository-tracked specialized AI agents & reusable maintenance skills
```

---

## Hosting & Local Development

### GitHub Pages
Because all module imports and asset fetches use relative `./` paths with zero build tooling, the repository can be served directly from any static host or GitHub Pages branch (`main`).

### Local Static Server
```bash
python3 -m http.server 8000
# Open http://localhost:8000
# Or deep-link directly into a guided lab:
# http://localhost:8000/?lab=./labs/lab1-dc-divider.json
```

---

## Verification, Auditing & Maintenance

Run the full unit, physics, preset, isolation, and lab-schema test suite:
```bash
npm test
```

Run the repository parity and syntax auditor (verifies `parts/manifest.json` ↔ `js/partsLoader.js`, `labs/manifest.json` ↔ `js/labLoader.js`, preset hole validity, and ES module syntax across all files):
```bash
npm run audit
```

See [**MAINTENANCE.md**](./MAINTENANCE.md) for step-by-step extension cookbooks (adding parts, authoring labs, adding sensors/IEC 60601 rules, or extending Arduino libraries) and [**AGENTS.md**](./AGENTS.md) for the repository's specialized AI agents and skills.
