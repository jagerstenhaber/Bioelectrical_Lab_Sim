# Bioelectrical Lab Sim

An interactive, zero-build browser simulator for undergraduate bioelectrical engineering labs—evolved from `glowing-waddle`. Build circuits on an 830-point solderless breadboard, toggle an **NI ELVIS II** prototyping board layout, wire external **Load Cells** (full-bridge & half-bridge) and **3-Pad Surface EMG** electrodes, inspect real-time net connectivity & short-circuit warnings, calculate RC filter cutoffs, and export clean SVG diagrams for lab reports.

## Roadmap

1. **Circuit Sim (Phase 1 Complete)**
   - [x] **Milestone 1 (DC MNA Solver + Virtual DMM)**: Real-time Modified Nodal Analysis DC solver with active-net pruning, floating Virtual Multimeter (`DC V`, `Ohm`, `Continuity`, `COM → GND`), live NI ELVIS II & Arduino DC supplies, interactive potentiometer / push button / photoresistor / load cell force controls, live LED glow & overcurrent/polarity diagnostics, and 4 classroom demo presets.
   - [x] **Milestone 2 (AC/Transient + FGEN + Oscilloscope)**: Time-domain Backward-Euler MNA solver for capacitors/RC filters/op-amps/AD620/diodes, NI ELVIS II Function Generator (`FGEN`), virtual 2-channel Oscilloscope (`AI 0` / `AI 1` / `FGEN` / board probes, AC/DC coupling, edge trigger, cursors, Autoscale), DMM `AC V` (`V~`), Option C collapsible right dock & Full Bench workspace, and 2 AC lab demo presets (`rc-lowpass`, `opamp-ac-amp`).
   - [x] **Milestone 3 (Bode Analyzer & Dynamic 3-Pad EMG)**: Complex small-signal AC frequency-sweep solver & NI ELVISmx Bode Analyzer (dual-pane magnitude/phase CRT, auto `-3 dB` cutoff markers, interactive frequency cursor), dynamic 3-pad surface EMG generator (contraction bursts, 60 Hz common-mode mains hum, electrode impedance mismatch), and the `emg-ad620` classroom demo preset.
2. **Arduino Sim (Phase 2 Complete)**
   - [x] **Arduino Nano Programming Simulator**: Zero-dependency Arduino C++ subset transpiler & sandboxed async runner (`pinMode`, `digitalWrite`, `digitalRead`, `analogRead`, `analogWrite` PWM, `delay`, `millis`, `Serial` I/O, `map`/`constrain`/math helpers), dark-adapted Nano IDE (`Serial Monitor`, 4-channel `Serial Plotter`, live `Pin Monitor`), onboard `PWR` / `L` (`D13`) / `TX` LED overlays, and 2 live classroom presets (`arduino-button-led`, `arduino-pot-pwm`).
3. **Additional Sensors** — Expanded bioelectrical transducer models (ECG/EKG, pulse oximetry, thermistor, force/strain gauges, and bridge excitation sources).

## Architecture

The application is 100% static HTML, CSS, and native ES2022+ modules (no build step or bundler required, ready for GitHub Pages):

```text
Bioelectrical_Lab_Sim/
├── index.html                 # Application shell, toolbar, parts sidebar, workspace & right instrument dock
├── css/
│   ├── styles.css             # Layout, breadboard, SVG component & palette styling
│   ├── elvismx.css            # Dark-adapted NI ELVISmx soft front panels & Option C workspace layout
│   └── arduino.css            # Dark-adapted Arduino Nano IDE, Serial Monitor/Plotter & 5-tab dock styling
├── js/
│   ├── app.js                 # Main UI controller, drag-and-drop, wire drawing, probing, zoom/pan
│   ├── breadboard.js          # 830-point breadboard, NI ELVIS II connector, and external sensor model
│   ├── boardRenderer.js       # Pure SVG rendering helpers for boards, external sensors, and wire paths
│   ├── connectivity.js        # Disjoint-Set net analyzer, pin occupancy tracking, and short detection
│   ├── partsLoader.js         # Dynamic catalog loader from ./parts/ with file:// offline fallback
│   ├── presets.js             # Classroom demo circuits (Starter, LED, Pot, Load Cell, RC Low-Pass, Op-Amp, 3-Pad EMG, Arduino Button/PWM)
│   ├── rcCalculator.js        # Floating RC filter calculator (f_c = 1 / 2πRC) & pure solver helper
│   ├── persistence.js         # v5/v4 JSON serialization, localStorage, and clean SVG export
│   ├── controllers/
│   │   └── benchController.js # Virtual bench orchestration, instrument lifecycle, probes, presets & persistence bridge
│   ├── sim/
│   │   ├── linearAlgebra.js   # Real/complex linear solvers, waveform evaluation, metrics, and trigger primitives
│   │   ├── circuitElements.js # Shared MNA element extraction, active-net pruning, and stamping primitives
│   │   ├── dcSolver.js        # Zero-DOM Modified Nodal Analysis DC solver & passive Ohmmeter
│   │   ├── transientSolver.js # Zero-DOM Backward-Euler transient MNA solver for AC/RC/Op-Amp/EMG circuits
│   │   ├── acSolver.js        # Zero-DOM complex MNA small-signal AC frequency-sweep (Bode Analyzer) solver
│   │   ├── emgModel.js        # Physiological 3-pad surface EMG MUAP burst + 60 Hz common-mode interference model
│   │   └── arduinoRuntime.js  # Zero-dependency Arduino Nano C++ subset transpiler, sandboxed runner & Serial Plotter parser
│   └── ui/
│       ├── elvismxControls.js # Shared NI ELVISmx dials, bar graph, Run/Stop footer & scale formatters
│       ├── workspaceManager.js# Collapsible tabbed right instrument dock, Full Bench wide switcher & stimulus controls
│       ├── dmmPanel.js        # NI ELVISmx Virtual Multimeter (DC V, AC V, Ohm, Continuity)
│       ├── fgenPanel.js       # NI ELVISmx Function Generator (Sine/Triangle/Square, quick freqs, probe)
│       ├── scopePanel.js      # NI ELVISmx 2-Channel Oscilloscope (CRT canvas, trigger, cursors, Autoscale)
│       ├── bodePanel.js       # NI ELVISmx Bode Analyzer (dual-pane Gain/Phase CRT, -3 dB cutoffs, cursor)
│       ├── arduinoPanel.js    # Arduino Nano IDE (editor, Serial Monitor, Serial Plotter & Pin Monitor)
│       └── runtimeOverlay.js  # SVG LED glow, Nano onboard LEDs, probe markers, and inspector telemetry
├── parts/
│   ├── manifest.json          # Registry of available component folders
│   └── <part-id>/             # Component metadata (part.json) + vector artwork (graphic.svg)
└── tests/                     # Zero-dependency Node test suite (`npm test` / `node --test`)
```

## Hosting & Local Development

### GitHub Pages
Because all module imports and asset fetches use relative `./` paths with zero build tooling, the repository can be served directly from any static host or GitHub Pages branch.

### Local Static Server
```bash
python3 -m http.server 8000
# Open http://localhost:8000
```

## Verification & Testing

Check JavaScript module syntax across all files:
```bash
node --check js/*.js
```

Run Node's built-in test runner when test suites are present:
```bash
node --test
```
