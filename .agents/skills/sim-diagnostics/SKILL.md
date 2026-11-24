---
name: sim-diagnostics
description: Playbook for diagnosing, testing, and fixing circuit solver, multi-frequency RC filtering, bioelectrical sensor (EMG/PPG/Pulse-Ox/ARB EKG), Arduino runtime, and IEC 60601 isolation issues.
---

# Circuit & Bioelectrical Simulation Diagnostics (`sim-diagnostics`)

Use this skill whenever investigating unexpected voltage/frequency readings, filter attenuation behavior, Arduino `analogRead()` discrepancies, or IEC 60601 isolation assessment verdicts.

## 1. Solver Architecture Quick Map

- **Element Extraction & Active-Net Pruning**: `js/sim/circuitElements.js`
  - Converts breadboard nets, placed parts, external sensors, and bench supplies into compact active MNA nodes (ground net = node `0`).
- **DC Operating Point & Passive Ohmmeter**: `js/sim/dcSolver.js`
  - Newton-Raphson iteration for non-linear diodes, LEDs, op-amp rail clipping, and AD620 instrumentation amplifier gain ($G = 1 + 49.4\text{ k}\Omega / R_G$).
  - Supports instantaneous `timeSec` sampling for purely resistive time-varying circuits, **but capacitors are open-circuits in pure DC**.
- **Time-Domain Transient & Live Stepper**: `js/sim/transientSolver.js`
  - `solveTransientCircuit()`: Used by the **Oscilloscope** and **DMM AC V**. Uses Backward-Euler companion models ($G_C = C / \Delta t_{\text{sub}}$) with automatic sub-stepping (`MAX_SUBSTEPS = 16`) so fast RC filters remain accurate even on coarse `200 ms/div` physiological windows.
  - `createLiveCircuitStepper()`: Stateful real-time Backward-Euler stepper used by `BenchController._solveArduinoInstantAt(tSec)` whenever a circuit contains capacitors so Arduino `analogRead()` sees true RC low-pass and high-pass filtering!
- **Small-Signal AC Frequency Sweep (Bode)**: `js/sim/acSolver.js`
  - Linearizes around the DC operating point (`solveDcCircuit`) and solves complex MNA ($\mathbf{Y}(j\omega)\mathbf{V} = \mathbf{I}$) with $Y_C = j\omega C$.

## 2. Common Diagnostic Checklists

### A. "My RC Filter isn't attenuating an ARB / EKG / EMG signal as expected"
1. **Check Signal Spectral Bandwidth**:
   - In `js/sim/arbModel.js`, the synthesized Lead-II EKG QRS complex uses physiological Gaussian widths (`Q: 0.0095`, `R: 0.0075`, `S: 0.0105` of the beat period with an `85 Hz` minimum effective QRS rate floor).
   - A `15.9 Hz` low-pass filter (`10 kΩ + 1 µF`) should attenuate the sharp R-peak by **>35%** while a `159 Hz` low-pass filter (`10 kΩ + 100 nF`) passes the QRS (>85%) while attenuating high-frequency noise.
2. **Check Scope vs Arduino Path**:
   - If the Scope shows attenuation but Arduino Serial Plotter does not, verify `BenchController._circuitHasCapacitors()` is returning `true` (checks `def?.unit === 'F'`) and routing `readArduinoPinVoltage()` through `this.arduinoLiveStepper.stepToTime(tSec)`.
3. **Check Sub-Stepping on Slow Scope Timebases**:
   - At `200 ms/div` (`4.0 s` capture across 600 samples, outer `dt ≈ 6.68 ms`), ensure `substeps` in `js/sim/transientSolver.js` subdivides `dt` when active waveforms have higher-frequency content or fast $RC$ time constants.

### B. "IEC 60601 Isolation Assessment reports Partial or Hazard unexpectedly"
1. Open `js/sim/isolationAnalyzer.js` and inspect the 4 checks in `ISOLATION_BARRIER_CHECKS`:
   - **`galvanic-host-isolation`**:
     - If an Arduino Nano is connected to the patient circuit, `simConfig.usbIsolatorEnabled` (`ADuM3160`) **must** be `true`.
     - If NI ELVIS II mode is enabled (`breadboard.elvisMode`), there must be **zero conductive path** (even through ground rails) between the patient/Nano domain and mains-referenced ELVIS II ground (`ELV_49A..53D`). Any wire bridging the two domains is flagged in `offendingWireIds`.
   - **`secondary-highpass-blocking`**:
     - Requires a series blocking capacitor (`unit === 'F'`) separating the patient electrodes (or the AD620 output) from the downstream acquisition pin (`A0..A7` or `AI 0..1`).
     - Verify no parallel wire or resistor bypasses both terminals of the series capacitor.
     - Note: When two `10 kΩ` resistors form a `+2.5 V` virtual-ground divider on the downstream side of a `1 µF` capacitor, their Thévenin AC resistance to rails is $10\text{ k}\Omega \parallel 10\text{ k}\Omega = 5\text{ k}\Omega$, giving $f_c = 1 / (2\pi \times 5\text{ k}\Omega \times 1\text{ \mu F}) \approx 31.8\text{ Hz}$.
   - **`patient-rail-fault`**:
     - Checks that no patient electrode (`EMG_RED1`, `EMG_RED2`, `EMG_BLK`) is shorted directly to a low-impedance DC supply rail (`+5V`, `+15V`, `-15V`, etc.).

### C. "Photoresistor PPG mode isn't generating a pulse"
1. In `js/sim/ppgModel.js` and `js/sim/circuitElements.js`, `photoresistor` in `lightMode: "led-ppg"` requires:
   - `props.fingerPresent !== false`, **AND**
   - At least one placed `led-red` on the breadboard that is forward-biased and conducting (`ledBrightness > 0.05` in `dcResult`).
   - If the Red LED is unpowered or reverse-biased, the photoresistor remains dark (`~85 kΩ`) with zero AC PPG ripple by design.

## 3. Targeted Test Commands

Run a specific solver or diagnostic test file directly with Node:

```bash
node --test tests/transientSolver.test.js
node --test tests/isolationAnalyzer.test.js
node --test tests/arbModel.test.js
node --test tests/ppgPulseOx.test.js
node --test tests/presets.test.js
```
