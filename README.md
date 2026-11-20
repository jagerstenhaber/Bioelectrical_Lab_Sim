# Bioelectrical Lab Sim

An interactive, zero-build browser simulator for undergraduate bioelectrical engineering labs—evolved from `glowing-waddle`. Build circuits on an 830-point solderless breadboard, toggle an **NI ELVIS II** prototyping board layout, wire external **Load Cells** (full-bridge & half-bridge) and **3-Pad Surface EMG** electrodes, inspect real-time net connectivity & short-circuit warnings, calculate RC filter cutoffs, and export clean SVG diagrams for lab reports.

## Roadmap

1. **Circuit Sim (In Progress)**
   - [x] **Milestone 1 (DC MNA Solver + Virtual DMM)**: Real-time Modified Nodal Analysis DC solver with active-net pruning, floating Virtual Multimeter (`DC V`, `Ohm`, `Continuity`, `COM → GND`), live NI ELVIS II & Arduino DC supplies, interactive potentiometer / push button / photoresistor / load cell force controls, live LED glow & overcurrent/polarity diagnostics, and 4 classroom demo presets.
   - [ ] **Milestone 2 (AC/Transient + FGEN + Oscilloscope)**: Time-domain solver for capacitors/RC filters/op-amps/AD620, NI ELVIS II Function Generator (`FGEN`), and virtual 2-channel Oscilloscope (`AI 0` / `AI 1` + probes).
   - [ ] **Milestone 3 (Bode Analyzer & Dynamic EMG/Sensor Signals)**: Frequency-sweep Bode plots and live simulated 3-pad EMG waveforms (muscle contraction bursts + 60 Hz hum).
2. **Arduino Sim** — Simulated Arduino Nano microcontroller execution (code editor, digital/analog I/O, PWM, ADC sampling, and Serial plotter bridged to the circuit solver).
3. **Additional Sensors** — Expanded bioelectrical transducer models (ECG/EKG, pulse oximetry, thermistor, force/strain gauges, and bridge excitation sources).

## Architecture

The application is 100% static HTML, CSS, and native ES2022+ modules (no build step or bundler required, ready for GitHub Pages):

```text
Bioelectrical_Lab_Sim/
├── index.html                 # Application shell, toolbar, parts sidebar, workspace, DMM & RC panels
├── css/
│   └── styles.css             # Layout, breadboard, SVG component, DMM instrument & palette styling
├── js/
│   ├── app.js                 # Main UI controller, drag-and-drop, wire drawing, probing, zoom/pan
│   ├── breadboard.js          # 830-point breadboard, NI ELVIS II connector, and external sensor model
│   ├── boardRenderer.js       # Pure SVG rendering helpers for boards, external sensors, and wire paths
│   ├── connectivity.js        # Disjoint-Set net analyzer, pin occupancy tracking, and short detection
│   ├── partsLoader.js         # Dynamic catalog loader from ./parts/ with file:// offline fallback
│   ├── presets.js             # Classroom demo circuits (Starter, LED, Pot Divider, Load Cell + AD620)
│   ├── rcCalculator.js        # Floating RC filter calculator (f_c = 1 / 2πRC) & pure solver helper
│   ├── persistence.js         # v5/v4 JSON serialization, localStorage, and clean SVG export
│   ├── sim/
│   │   └── dcSolver.js        # Zero-DOM Modified Nodal Analysis DC solver & passive Ohmmeter
│   └── ui/
│       ├── dmmPanel.js        # Draggable Virtual Multimeter & Lab Supply / Stimulus panel
│       └── runtimeOverlay.js  # SVG LED glow, probe markers, and inspector controls/telemetry
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
