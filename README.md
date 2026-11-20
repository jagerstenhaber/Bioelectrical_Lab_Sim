# Bioelectrical Lab Sim

An interactive, zero-build browser simulator for undergraduate bioelectrical engineering labs—evolved from `glowing-waddle`. Build circuits on an 830-point solderless breadboard, toggle an **NI ELVIS II** prototyping board layout, wire external **Load Cells** (full-bridge & half-bridge) and **3-Pad Surface EMG** electrodes, inspect real-time net connectivity & short-circuit warnings, calculate RC filter cutoffs, and export clean SVG diagrams for lab reports.

## Roadmap

1. **Circuit Sim** — Interactive DC/AC nodal circuit solver, virtual DMM / oscilloscope / function generator probes, and gain/filter frequency verification.
2. **Arduino Sim** — Simulated Arduino Nano microcontroller execution (digital/analog I/O, PWM, ADC sampling, and Serial plotter integration).
3. **Additional Sensors** — Expanded bioelectrical transducer models (ECG/EKG, pulse oximetry, force/strain gauges, and bridge excitation sources).

## Architecture

The application is 100% static HTML, CSS, and native ES2022+ modules (no build step or bundler required, ready for GitHub Pages):

```text
Bioelectrical_Lab_Sim/
├── index.html              # Application shell, toolbar, parts sidebar, workspace, RC calculator panel
├── css/
│   └── styles.css          # Layout, breadboard, SVG component, and floating palette styling
├── js/
│   ├── app.js              # Main UI controller, drag-and-drop, wire drawing, zoom/pan, and shortcuts
│   ├── breadboard.js       # 830-point breadboard, NI ELVIS II connector, and external sensor grid model
│   ├── boardRenderer.js    # Pure SVG rendering helpers for boards, external sensors, and wire paths
│   ├── connectivity.js     # Disjoint-Set net analyzer, pin occupancy tracking, and short-circuit detection
│   ├── partsLoader.js      # Dynamic catalog loader from ./parts/ with file:// offline fallback
│   ├── rcCalculator.js     # Floating RC filter calculator (f_c = 1 / 2πRC) & pure solver helper
│   └── persistence.js      # v5/v4 JSON serialization, localStorage, starter circuit, and SVG export
└── parts/
    ├── manifest.json       # Registry of available component folders
    └── <part-id>/          # Component metadata (part.json) + vector artwork (graphic.svg)
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
