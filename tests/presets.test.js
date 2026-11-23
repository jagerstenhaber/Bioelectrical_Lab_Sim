import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import { solveDcCircuit } from '../js/sim/dcSolver.js';
import { solveTransientCircuit, createLiveCircuitStepper } from '../js/sim/transientSolver.js';
import { analyzeCircuitIsolation } from '../js/sim/isolationAnalyzer.js';
import { computeWaveformMetrics } from '../js/sim/linearAlgebra.js';
import { createArduinoRunner, ARDUINO_EXAMPLE_SKETCHES } from '../js/sim/arduinoRuntime.js';
import { LAB_PRESETS, buildPresetCircuit } from '../js/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = path.resolve(__dirname, '../parts');

function loadFullCatalog() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, 'manifest.json'), 'utf8'));
  const map = new Map();
  for (const partId of manifest.parts) {
    const def = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, partId, 'part.json'), 'utf8'));
    map.set(partId, def);
  }
  return map;
}

const CATALOG = loadFullCatalog();

function assertApprox(actual, expected, tolerance, label = '') {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label ? `${label}: ` : ''}expected ${expected} ± ${tolerance}, got ${actual}`
  );
}

test('All LAB_PRESETS build cleanly with zero connectivity warnings and valid pin holes', () => {
  assert.equal(LAB_PRESETS.length, 14);

  for (const meta of LAB_PRESETS) {
    let seq = 1;
    const generateId = (prefix = 'item') => `${prefix}_${seq++}`;
    const preset = buildPresetCircuit(meta.id, { generateId });

    assert.ok(preset.boardConfig, `${meta.id}: missing boardConfig`);
    assert.ok(Array.isArray(preset.placedParts), `${meta.id}: missing placedParts`);
    assert.ok(Array.isArray(preset.wires), `${meta.id}: missing wires`);
    assert.ok(preset.simConfig, `${meta.id}: missing simConfig`);
    assert.ok(preset.defaultDmm, `${meta.id}: missing defaultDmm`);

    const bb = new BreadboardModel(preset.boardConfig);
    const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);

    assert.deepEqual(
      conn.warnings,
      [],
      `${meta.id}: expected 0 connectivity warnings, got: ${JSON.stringify(conn.warnings)}`
    );

    // Verify every placed part's pins land on valid holes
    for (const inst of preset.placedParts) {
      const def = CATALOG.get(inst.partId);
      assert.ok(def, `${meta.id}: unknown partId ${inst.partId}`);

      if (def.placement === 'two-lead') {
        const h1 = conn.getPinHole(inst.id, 'P1');
        const h2 = conn.getPinHole(inst.id, 'P2');
        assert.ok(h1, `${meta.id}: ${inst.partId} P1 invalid hole ${inst.pinHoles?.P1}`);
        assert.ok(h2, `${meta.id}: ${inst.partId} P2 invalid hole ${inst.pinHoles?.P2}`);
      } else if (def.placement === 'footprint') {
        for (const pin of def.pins) {
          const h = conn.getPinHole(inst.id, pin.id);
          assert.ok(h, `${meta.id}: ${inst.partId} pin ${pin.id} did not land on a valid hole`);
        }
      }
    }

    // Verify every wire endpoint is a valid hole
    for (const wire of preset.wires) {
      assert.ok(bb.getHole(wire.holeA), `${meta.id}: invalid wire holeA ${wire.holeA}`);
      assert.ok(bb.getHole(wire.holeB), `${meta.id}: invalid wire holeB ${wire.holeB}`);
    }

    // Verify DMM default probe holes are valid
    if (preset.defaultDmm.probeRed) {
      assert.ok(
        bb.getHole(preset.defaultDmm.probeRed),
        `${meta.id}: invalid defaultDmm.probeRed ${preset.defaultDmm.probeRed}`
      );
    }
    if (preset.defaultDmm.probeBlack) {
      assert.ok(
        bb.getHole(preset.defaultDmm.probeBlack),
        `${meta.id}: invalid defaultDmm.probeBlack ${preset.defaultDmm.probeBlack}`
      );
    }

    const sim = solveDcCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts: preset.placedParts,
      wires: preset.wires,
      catalogMap: CATALOG,
      simConfig: preset.simConfig
    });
    assert.equal(sim.converged, true, `${meta.id}: DC solver did not converge`);
  }
});

test('starter preset works in both standard and ELVIS modes', () => {
  for (const elvisMode of [false, true]) {
    const preset = buildPresetCircuit('starter', { elvisMode });
    assert.equal(preset.boardConfig.elvisMode, elvisMode);
    assert.deepEqual(preset.defaultDmm, {
      open: false,
      mode: 'VDC',
      probeRed: null,
      probeBlack: null
    });
    const bb = new BreadboardModel(preset.boardConfig);
    const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
    assert.deepEqual(conn.warnings, []);
    const sim = solveDcCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts: preset.placedParts,
      wires: preset.wires,
      catalogMap: CATALOG,
      simConfig: preset.simConfig
    });
    assert.equal(sim.converged, true);
    const diff = sim.getVoltageDiff('b22', 'BN19');
    assert.equal(diff.valid, true);
    assertApprox(diff.volts, 5.0, 0.05, `starter elvisMode=${elvisMode} VCC`);
  }
});

test('led-demo preset: LED conducts cleanly at ~9.1 mA with ledBrightness > 0.5 and no overcurrent', () => {
  const preset = buildPresetCircuit('led-demo');
  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const sim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig
  });

  const ledInst = preset.placedParts.find((p) => p.partId === 'led-red');
  assert.ok(ledInst);
  const ledRes = sim.partResults.get(ledInst.id);
  assert.equal(ledRes.conducting, true);
  assert.equal(ledRes.overcurrent, false);
  assert.ok(ledRes.ledBrightness > 0.5, `expected ledBrightness > 0.5, got ${ledRes.ledBrightness}`);
  assertApprox(ledRes.currentMa, 9.1, 0.3, 'LED current (mA)');

  const diff = sim.getVoltageDiff(preset.defaultDmm.probeRed, preset.defaultDmm.probeBlack);
  assert.equal(diff.valid, true);
  assertApprox(diff.volts, 1.99, 0.1, 'LED forward anode voltage');
});

test('pot-divider preset: DMM reads 2.50 V ± 0.05 V at 50% wiper, 4.00 V at 80%, and 1.00 V at 20%', () => {
  const preset = buildPresetCircuit('pot-divider');
  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const sim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig
  });

  const diff = sim.getVoltageDiff(preset.defaultDmm.probeRed, preset.defaultDmm.probeBlack);
  assert.equal(diff.valid, true);
  assertApprox(diff.volts, 2.5, 0.05, 'pot-divider DMM reading at wiper=0.5');

  const potInst = preset.placedParts.find((p) => p.partId === 'pot-side-turn');
  assert.ok(potInst);

  for (const [wiper, expectedV] of [
    [0.8, 4.0],
    [0.2, 1.0]
  ]) {
    potInst.props.wiper = wiper;
    const sweptSim = solveDcCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts: preset.placedParts,
      wires: preset.wires,
      catalogMap: CATALOG,
      simConfig: preset.simConfig
    });
    const sweptDiff = sweptSim.getVoltageDiff(preset.defaultDmm.probeRed, preset.defaultDmm.probeBlack);
    assert.equal(sweptDiff.valid, true);
    assertApprox(sweptDiff.volts, expectedV, 0.05, `pot-divider DMM reading at wiper=${wiper}`);
  }
});

test('loadcell-ad620 preset: AD620 powered with gain ≈ 495 and DMM reads 2.475 V ± 0.15 V at 500 g', () => {
  const preset = buildPresetCircuit('loadcell-ad620');
  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const sim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig
  });

  const iaInst = preset.placedParts.find((p) => p.partId === 'inamp-ad620');
  assert.ok(iaInst);
  const iaRes = sim.partResults.get(iaInst.id);
  assert.equal(iaRes.powered, true);
  assertApprox(iaRes.gain, 495, 1e-6, 'AD620 gain');

  const diff = sim.getVoltageDiff(preset.defaultDmm.probeRed, preset.defaultDmm.probeBlack);
  assert.equal(diff.valid, true);
  assertApprox(diff.volts, 2.475, 0.15, 'AD620 output DMM reading');
});

test('rc-lowpass preset: transient solver shows CH0 Vpp ≈ 4.0 V and CH1 Vpp ≈ 2.83 V (-3 dB at fc = 1592 Hz)', () => {
  const preset = buildPresetCircuit('rc-lowpass');
  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const totalDurationSec = preset.defaultScope.timePerDiv * 10 * 2;
  const transient = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig,
    totalDurationSec,
    numSamples: 600
  });

  const ch0 = transient.getChannelTrace({ type: 'AI0' });
  const ch1 = transient.getChannelTrace({ type: 'AI1' });
  assert.equal(ch0.valid, true);
  assert.equal(ch1.valid, true);

  const m0 = computeWaveformMetrics(ch0.samples, transient.dt);
  const m1 = computeWaveformMetrics(ch1.samples, transient.dt);
  assertApprox(m0.vpp, 4.0, 0.2, 'RC Low-Pass CH0 (AI0) Vpp');
  assertApprox(m1.vpp, 2.83, 0.2, 'RC Low-Pass CH1 (AI1) Vpp');

  // Verify default DMM VAC probes also read ~1.00 Vrms at fc
  const dmmTrace = transient.getDiffTrace(preset.defaultDmm.probeRed, preset.defaultDmm.probeBlack);
  assert.equal(dmmTrace.valid, true);
  const mDmm = computeWaveformMetrics(dmmTrace.samples, transient.dt);
  assertApprox(mDmm.vRmsAc, 1.0, 0.1, 'RC Low-Pass DMM Vrms');
});

test('opamp-ac-amp preset: transient solver shows CH0 Vpp ≈ 1.5 V and CH1 Vpp ≈ 15.0 V (G = -10)', () => {
  const preset = buildPresetCircuit('opamp-ac-amp');
  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const totalDurationSec = preset.defaultScope.timePerDiv * 10 * 2;
  const transient = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig,
    totalDurationSec,
    numSamples: 600
  });

  const ch0 = transient.getChannelTrace({ type: 'AI0' });
  const ch1 = transient.getChannelTrace({ type: 'AI1' });
  assert.equal(ch0.valid, true);
  assert.equal(ch1.valid, true);

  const m0 = computeWaveformMetrics(ch0.samples, transient.dt);
  const m1 = computeWaveformMetrics(ch1.samples, transient.dt);
  assertApprox(m0.vpp, 1.5, 0.15, 'Inverting Op-Amp CH0 (AI0) Vpp');
  assertApprox(m1.vpp, 15.0, 0.8, 'Inverting Op-Amp CH1 (AI1) Vpp');
});

test('emg-ad620 preset: AD620 (G=495) amplifies EMG on CH0 while raw CH1 shows ~15 mVpp 60 Hz hum', () => {
  const preset = buildPresetCircuit('emg-ad620');
  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const dcSim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig
  });
  const iaInst = preset.placedParts.find((p) => p.partId === 'inamp-ad620');
  assert.ok(iaInst);
  const iaRes = dcSim.partResults.get(iaInst.id);
  assert.equal(iaRes.powered, true);
  assertApprox(iaRes.gain, 495, 1e-6, 'emg-ad620 AD620 gain');

  const totalDurationSec = preset.defaultScope.timePerDiv * 10; // 0.2 s (20 ms/div * 10 div)
  const transient = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig,
    totalDurationSec,
    numSamples: 600
  });

  const ch0 = transient.getChannelTrace({ type: 'AI0' });
  const ch1 = transient.getChannelTrace({ type: 'AI1' });
  assert.equal(ch0.valid, true);
  assert.equal(ch1.valid, true);

  const m0 = computeWaveformMetrics(ch0.samples, transient.dt);
  const m1 = computeWaveformMetrics(ch1.samples, transient.dt);
  assert.ok(m0.vpp > 0.5, `Expected amplified CH0 EMG Vpp > 0.5 V, got ${m0.vpp.toFixed(3)} V`);
  assert.ok(
    m1.vpp > 0.01 && m1.vpp < 0.03,
    `Expected raw CH1 hum Vpp between 10 mV and 30 mV, got ${(m1.vpp * 1000).toFixed(2)} mV`
  );
});

async function waitForCondition(predicate, timeoutMs = 1500, intervalMs = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test('arduino-button-led preset: INPUT_PULLUP D2 reads pushbutton press and drives D9 LED cleanly', async () => {
  const preset = buildPresetCircuit('arduino-button-led');
  assert.equal(preset.defaultArduino.sketchId, 'button-led');
  assert.equal(preset.defaultArduino.open, true);
  assert.equal(preset.defaultArduino.autoRun, true);
  assert.equal(preset.defaultArduino.drawerTab, 'serial');

  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const nano = preset.placedParts.find((p) => p.partId === 'arduino-nano');
  const button = preset.placedParts.find((p) => p.partId === 'pushbutton-4pin');
  const led = preset.placedParts.find((p) => p.partId === 'led-red');
  assert.ok(nano && button && led);

  const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === preset.defaultArduino.sketchId);
  assert.ok(sketch);

  const simConfig = { ...preset.simConfig, arduinoPinStates: {} };
  let dcSim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig
  });

  const readPinVoltage = (pinId) => {
    const pinHole = conn.getPinHole(nano.id, pinId);
    const gndHole = conn.getPinHole(nano.id, 'GND_BOT') || conn.getPinHole(nano.id, 'GND_TOP');
    if (!pinHole || !dcSim) return 0;
    const vPin = dcSim.getHoleVoltage(pinHole.id);
    const vGnd = gndHole ? dcSim.getHoleVoltage(gndHole.id) : 0;
    return Number.isFinite(vPin) ? vPin - (Number.isFinite(vGnd) ? vGnd : 0) : 0;
  };

  const runner = createArduinoRunner({
    clockScale: 10,
    readPinVoltage,
    onPinStateChange: (_pinId, _pinState, allPinStates) => {
      simConfig.arduinoPinStates = { ...allPinStates };
      dcSim = solveDcCircuit({
        breadboard: bb,
        connectivity: conn,
        placedParts: preset.placedParts,
        wires: preset.wires,
        catalogMap: CATALOG,
        simConfig
      });
    }
  });

  const startRes = runner.start(sketch.code);
  assert.equal(startRes.ok, true);

  const idleOk = await waitForCondition(
    () =>
      runner.getState().pinStates.D2.mode === 'INPUT_PULLUP' &&
      runner.getState().pinStates.D9.mode === 'OUTPUT' &&
      runner.getState().pinStates.D9.voltage === 0 &&
      runner.getState().serialLines.includes('Button + LED ready')
  );
  assert.equal(idleOk, true, 'Expected D2 INPUT_PULLUP and D9 LOW when button unpressed');
  assert.equal(dcSim.partResults.get(led.id).conducting, false);

  // Press the pushbutton on the breadboard -> pulls D2 to GND
  button.props.pressed = true;
  dcSim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig
  });

  const pressedOk = await waitForCondition(
    () =>
      runner.getState().pinStates.D9.voltage === 5 &&
      runner.getState().serialLines.includes('Button pressed')
  );
  runner.stop();

  assert.equal(pressedOk, true, 'Expected D9 HIGH and Serial log when button pressed');
  const ledRes = dcSim.partResults.get(led.id);
  assert.equal(ledRes.conducting, true);
  assert.equal(ledRes.overcurrent, false);
  assertApprox(ledRes.currentMa, 8.5, 0.4, 'arduino-button-led LED current (mA)');
});

test('arduino-pot-pwm preset: Pot at 50% -> analogRead(A0) ≈ 512, D9 PWM duty ≈ 127, LED conducts & Scope sees 490 Hz 5 Vpp square', async () => {
  const preset = buildPresetCircuit('arduino-pot-pwm');
  assert.equal(preset.defaultArduino.sketchId, 'pot-plotter');
  assert.equal(preset.defaultArduino.open, true);
  assert.equal(preset.defaultArduino.autoRun, true);
  assert.equal(preset.defaultArduino.drawerTab, 'plotter');

  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const nano = preset.placedParts.find((p) => p.partId === 'arduino-nano');
  const led = preset.placedParts.find((p) => p.partId === 'led-red');
  assert.ok(nano && led);

  const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === preset.defaultArduino.sketchId);
  assert.ok(sketch);

  const simConfig = { ...preset.simConfig, arduinoPinStates: {} };
  let dcSim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig
  });

  const readPinVoltage = (pinId) => {
    const pinHole = conn.getPinHole(nano.id, pinId);
    const gndHole = conn.getPinHole(nano.id, 'GND_BOT') || conn.getPinHole(nano.id, 'GND_TOP');
    if (!pinHole || !dcSim) return 0;
    const vPin = dcSim.getHoleVoltage(pinHole.id);
    const vGnd = gndHole ? dcSim.getHoleVoltage(gndHole.id) : 0;
    return Number.isFinite(vPin) ? vPin - (Number.isFinite(vGnd) ? vGnd : 0) : 0;
  };

  assertApprox(readPinVoltage('A0'), 2.5, 0.05, 'Pot wiper voltage at A0');

  const runner = createArduinoRunner({
    clockScale: 10,
    readPinVoltage,
    onPinStateChange: (_pinId, _pinState, allPinStates) => {
      simConfig.arduinoPinStates = { ...allPinStates };
      dcSim = solveDcCircuit({
        breadboard: bb,
        connectivity: conn,
        placedParts: preset.placedParts,
        wires: preset.wires,
        catalogMap: CATALOG,
        simConfig
      });
    }
  });

  const startRes = runner.start(sketch.code);
  assert.equal(startRes.ok, true);

  const ready = await waitForCondition(() => {
    const st = runner.getState();
    return st.pinStates.D9.mode === 'PWM' && st.plotterSeries.length >= 1;
  });
  const state = runner.getState();
  runner.stop();

  assert.equal(ready, true);
  assert.equal(state.pinStates.D9.mode, 'PWM');
  assert.equal(state.pinStates.D9.freqHz, 490);
  assertApprox(state.pinStates.D9.dutyCycle, 127, 2, 'D9 PWM dutyCycle');
  assertApprox(state.plotterSeries[0].channels[0].value, 512, 4, 'Plotter ADC channel');

  // Verify LED conducts cleanly in DC average model (2.5 V average across 330 Ω + red LED)
  const ledRes = dcSim.partResults.get(led.id);
  assert.equal(ledRes.conducting, true);
  assert.equal(ledRes.overcurrent, false);

  // Verify Scope CH0 PROBE on a30 sees 490 Hz 5.0 Vpp PWM square wave
  const totalDurationSec = preset.defaultScope.timePerDiv * 10 * 2;
  const transient = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig,
    totalDurationSec,
    numSamples: 600
  });

  const ch0 = transient.getChannelTrace({
    type: preset.defaultScope.ch0.source,
    holeId: preset.defaultScope.ch0.probeHole
  });
  assert.equal(ch0.valid, true);
  const metrics = computeWaveformMetrics(ch0.samples, transient.dt);
  assertApprox(metrics.vpp, 5.0, 0.25, 'Scope CH0 PWM Vpp');
  assertApprox(metrics.freqHz, 490, 25, 'Scope CH0 PWM frequency (Hz)');
});

test('arduino-emg-fir preset: AD620 biased at +2.50 V via SUPPLY+ and live ArduinoRunner samples EMG bursts through #include <FIR.h>', async () => {
  const preset = buildPresetCircuit('arduino-emg-fir');
  assert.equal(preset.boardConfig.elvisMode, true);
  assert.equal(preset.boardConfig.emgMode, true);
  assert.equal(preset.simConfig.vpsEnabled, true);
  assert.equal(preset.simConfig.elvisSupplyPos, 2.5);
  assert.equal(preset.simConfig.elvisSupplyNeg, -2.5);
  assert.equal(preset.defaultArduino.sketchId, 'fir-emg-filter');
  assert.equal(preset.defaultArduino.open, true);
  assert.equal(preset.defaultArduino.autoRun, true);
  assert.equal(preset.defaultArduino.drawerTab, 'plotter');

  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const nano = preset.placedParts.find((p) => p.partId === 'arduino-nano');
  const ad620 = preset.placedParts.find((p) => p.partId === 'inamp-ad620');
  assert.ok(nano && ad620);
  const a0Hole = conn.getPinHole(nano.id, 'A0');
  const gndHole = conn.getPinHole(nano.id, 'GND_BOT') || conn.getPinHole(nano.id, 'GND_TOP');
  const refHole = conn.getPinHole(ad620.id, 'REF');
  assert.ok(a0Hole && gndHole && refHole);

  const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === preset.defaultArduino.sketchId);
  assert.ok(sketch);

  const simConfig = { ...preset.simConfig, arduinoPinStates: {} };
  const initialDc = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig
  });
  assert.equal(initialDc.converged, true);
  assert.equal(initialDc.partResults.get(ad620.id).powered, true);
  assertApprox(initialDc.partResults.get(ad620.id).gain, 495, 1e-6, 'arduino-emg-fir AD620 gain');
  assertApprox(initialDc.getHoleVoltage(refHole.id), 2.5, 0.01, 'AD620 REF biased at +2.50 V via SUPPLY+');

  // Sweep virtual time across burst window via solveDcCircuit({ ..., timeSec })
  let lastSolvedT = -1;
  let lastSolvedDc = null;
  let sampleStep = 0;

  const runner = createArduinoRunner({
    clockScale: 20,
    readPinVoltage(pinId) {
      const targetHole = conn.getPinHole(nano.id, pinId);
      if (!targetHole) return 0;
      const tSec = sampleStep * 0.015;
      sampleStep += 1;
      if (!lastSolvedDc || Math.abs(tSec - lastSolvedT) > 0.0004) {
        lastSolvedDc = solveDcCircuit({
          breadboard: bb,
          connectivity: conn,
          placedParts: preset.placedParts,
          wires: preset.wires,
          catalogMap: CATALOG,
          simConfig,
          timeSec: tSec
        });
        lastSolvedT = tSec;
      }
      const vPin = lastSolvedDc.getHoleVoltage(targetHole.id);
      const vGnd = lastSolvedDc.getHoleVoltage(gndHole.id);
      return Number.isFinite(vPin) ? vPin - (Number.isFinite(vGnd) ? vGnd : 0) : 0;
    }
  });

  const startRes = runner.start(sketch.code);
  assert.equal(startRes.ok, true, startRes.error);

  const collected = await waitForCondition(
    () => runner.getState().plotterSeries.length >= 25,
    2500,
    10
  );
  const state = runner.getState();
  runner.stop();

  assert.equal(collected, true, `Expected >= 25 Serial Plotter points, got ${state.plotterSeries.length}`);
  assert.ok(state.serialLines.some((l) => /EMG FIR Gain:\s*1\.00/.test(l)));

  const rawValues = state.plotterSeries.map((p) => p.channels.find((c) => c.label === 'Raw_EMG')?.value);
  const filteredValues = state.plotterSeries.map((p) => p.channels.find((c) => c.label === 'Filtered_EMG')?.value);

  assert.equal(rawValues.every(Number.isFinite), true);
  assert.equal(filteredValues.every(Number.isFinite), true);

  const rawMin = Math.min(...rawValues);
  const rawMax = Math.max(...rawValues);
  const filtMin = Math.min(...filteredValues);
  const filtMax = Math.max(...filteredValues);

  assert.ok(rawMax - rawMin > 10, `Expected non-constant Raw_EMG readings, got range ${rawMin}..${rawMax}`);
  assert.ok(filtMax - filtMin > 2, `Expected non-constant Filtered_EMG readings, got range ${filtMin}..${filtMax}`);
});

test('ppg-ldr preset: LED glows brightly (> 0.5), Photoresistor is optically PPG-linked, and Nano A0 sees pulsatile PPG voltage swing', async () => {
  const preset = buildPresetCircuit('ppg-ldr');
  assert.equal(preset.boardConfig.elvisMode, false);
  assert.equal(preset.boardConfig.pulseOxMode, false);
  assert.equal(preset.defaultArduino.open, true);
  assert.equal(preset.defaultArduino.autoRun, true);
  assert.equal(preset.defaultArduino.sketchId, 'ppg-ldr-plotter');
  assert.equal(preset.defaultArduino.drawerTab, 'plotter');

  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const nano = preset.placedParts.find((p) => p.partId === 'arduino-nano');
  const led = preset.placedParts.find((p) => p.partId === 'led-red');
  const ldr = preset.placedParts.find((p) => p.partId === 'photoresistor');
  assert.ok(nano && led && ldr);

  const a0Hole = conn.getPinHole(nano.id, 'A0');
  const gndHole = conn.getPinHole(nano.id, 'GND_BOT') || conn.getPinHole(nano.id, 'GND_TOP');
  assert.ok(a0Hole && gndHole);

  const dc = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig
  });
  assert.equal(dc.converged, true);

  const ledRes = dc.partResults.get(led.id);
  assert.equal(ledRes.conducting, true);
  assert.equal(ledRes.overcurrent, false);
  assert.ok(ledRes.ledBrightness > 0.5, `expected ledBrightness > 0.5, got ${ledRes.ledBrightness}`);

  const ldrRes = dc.partResults.get(ldr.id);
  assert.equal(ldrRes.opticalLinked, true);
  assert.equal(ldrRes.pulseActive, true);

  // Sample solveDcCircuit({ timeSec }) across a full cardiac cycle (72 BPM = 0.833 s) at Nano A0
  const voltages = [];
  for (let i = 0; i < 25; i += 1) {
    const tSec = (i / 25) * (60 / 72);
    const stepDc = solveDcCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts: preset.placedParts,
      wires: preset.wires,
      catalogMap: CATALOG,
      simConfig: preset.simConfig,
      timeSec: tSec
    });
    const vA0 = stepDc.getHoleVoltage(a0Hole.id) - stepDc.getHoleVoltage(gndHole.id);
    voltages.push(vA0);
  }
  const vMin = Math.min(...voltages);
  const vMax = Math.max(...voltages);
  const vpp = vMax - vMin;
  assert.ok(vMin > 0.5 && vMax < 4.8, `Expected valid divider voltage at A0, got ${vMin.toFixed(3)}..${vMax.toFixed(3)} V`);
  assert.ok(vpp > 0.1, `Expected pulsatile PPG voltage swing at A0 > 0.10 V, got ${vpp.toFixed(4)} V`);

  // Verify ppg-ldr-plotter sketch compiles and plots raw + smooth channels
  const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === preset.defaultArduino.sketchId);
  assert.ok(sketch);
  let idx = 0;
  const runner = createArduinoRunner({
    clockScale: 20,
    readPinVoltage: () => voltages[idx++ % voltages.length]
  });
  const startRes = runner.start(sketch.code);
  assert.equal(startRes.ok, true, startRes.error);
  const gotPoints = await waitForCondition(() => runner.getState().plotterSeries.length >= 12, 1500, 10);
  const st = runner.getState();
  runner.stop();
  assert.equal(gotPoints, true);
  assert.equal(st.plotterSeries[0].channels.length, 2);
});

test('pulseox-tia preset: Red & IR LEDs lit, Op-Amp TIA powered, and Scope AI0 captures +1.0..4.5 V DC bias + pulsatile PPG (Vpp > 0.08 V)', () => {
  const preset = buildPresetCircuit('pulseox-tia');
  assert.equal(preset.boardConfig.elvisMode, true);
  assert.equal(preset.boardConfig.pulseOxMode, true);
  assert.equal(preset.boardConfig.sensorPosition, 'right');
  assert.equal(preset.defaultScope.open, true);
  assert.equal(preset.defaultScope.running, true);
  assert.equal(preset.defaultScope.ch0.source, 'AI0');

  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const opamp = preset.placedParts.find((p) => p.partId === 'opamp-dual-dip8');
  assert.ok(opamp);

  const dc = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig
  });
  assert.equal(dc.converged, true);
  assert.ok(dc.pulseOxResult);
  assert.equal(dc.pulseOxResult.redLit, true);
  assert.equal(dc.pulseOxResult.irLit, true);
  assert.ok(dc.pulseOxResult.redCurrentMa > 5 && dc.pulseOxResult.redCurrentMa < 20);
  assert.ok(dc.pulseOxResult.irCurrentMa > 5 && dc.pulseOxResult.irCurrentMa < 20);
  assert.equal(dc.partResults.get(opamp.id).powered, true);

  const totalDurationSec = preset.defaultScope.timePerDiv * 10;
  const transient = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig,
    totalDurationSec,
    numSamples: 300
  });

  const ch0 = transient.getChannelTrace({ type: 'AI0' });
  assert.equal(ch0.valid, true);
  const metrics = computeWaveformMetrics(ch0.samples, transient.dt);
  assert.ok(
    metrics.vAvg >= 1.0 && metrics.vAvg <= 4.5,
    `Expected TIA AI0 DC bias in 1.0..4.5 V, got ${metrics.vAvg.toFixed(3)} V`
  );
  assert.ok(
    metrics.vpp > 0.08,
    `Expected TIA AI0 pulsatile PPG Vpp > 0.08 V, got ${metrics.vpp.toFixed(4)} V`
  );
});

test('arb-ekg-fir preset: AO 0 drives EKG + 60 Hz hum to Nano A0 & Scope AI0, and #include <FIR.h> outputs smooth Serial Plotter points', async () => {
  const preset = buildPresetCircuit('arb-ekg-fir');
  assert.equal(preset.boardConfig.elvisMode, true);
  assert.equal(preset.simConfig.powered, true);
  assert.equal(preset.simConfig.arb.running, true);
  assert.equal(preset.simConfig.arb.ao0.enabled, true);
  assert.equal(preset.simConfig.arb.ao0.waveformId, 'ekg-hum60');
  assert.equal(preset.simConfig.arb.ao0.gain, 1.5);
  assert.equal(preset.simConfig.arb.ao0.offsetV, 2.0);
  assert.equal(preset.defaultArduino.open, true);
  assert.equal(preset.defaultArduino.autoRun, true);
  assert.equal(preset.defaultArduino.sketchId, 'ekg-fir-filter');
  assert.equal(preset.defaultArduino.drawerTab, 'plotter');

  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const nano = preset.placedParts.find((p) => p.partId === 'arduino-nano');
  assert.ok(nano);
  const a0Hole = conn.getPinHole(nano.id, 'A0');
  const gndHole = conn.getPinHole(nano.id, 'GND_BOT') || conn.getPinHole(nano.id, 'GND_TOP');
  assert.ok(a0Hole && gndHole);

  // Verify transient trace on Scope AI0 captures EKG + 60 Hz hum with prominent R-peak swing
  const totalDurationSec = 1.0;
  const transient = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig,
    totalDurationSec,
    numSamples: 600
  });
  const ai0 = transient.getChannelTrace({ type: 'AI0' });
  assert.equal(ai0.valid, true);
  const metrics = computeWaveformMetrics(ai0.samples, transient.dt);
  assert.ok(
    metrics.vMax > 3.2 && metrics.vMin < 1.8 && metrics.vpp > 1.5,
    `Expected clear EKG R-peak swing on Scope AI0, got min=${metrics.vMin.toFixed(3)} max=${metrics.vMax.toFixed(3)} vpp=${metrics.vpp.toFixed(3)}`
  );

  // Verify live ArduinoRunner runs #include <FIR.h> over sampled AO0->A0 voltages
  const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === preset.defaultArduino.sketchId);
  assert.ok(sketch);

  let sampleIdx = 0;
  const runner = createArduinoRunner({
    clockScale: 20,
    readPinVoltage(pinId) {
      if (pinId !== 'A0') return 0;
      const tSec = sampleIdx * 0.005; // 200 Hz matching delay(5)
      sampleIdx += 1;
      const dcStep = solveDcCircuit({
        breadboard: bb,
        connectivity: conn,
        placedParts: preset.placedParts,
        wires: preset.wires,
        catalogMap: CATALOG,
        simConfig: preset.simConfig,
        timeSec: tSec
      });
      const vPin = dcStep.getHoleVoltage(a0Hole.id);
      const vGnd = dcStep.getHoleVoltage(gndHole.id);
      return Number.isFinite(vPin) ? vPin - (Number.isFinite(vGnd) ? vGnd : 0) : 0;
    }
  });

  const startRes = runner.start(sketch.code);
  assert.equal(startRes.ok, true, startRes.error);

  const collected = await waitForCondition(
    () => runner.getState().plotterSeries.length >= 180,
    4000,
    10
  );
  const state = runner.getState();
  runner.stop();

  assert.equal(collected, true, `Expected >= 180 plotter points, got ${state.plotterSeries.length}`);
  const rawSeries = state.plotterSeries.map((pt) => pt.channels[0]?.value);
  const filtSeries = state.plotterSeries.map((pt) => pt.channels[1]?.value);
  assert.equal(rawSeries.every(Number.isFinite), true);
  assert.equal(filtSeries.every(Number.isFinite), true);

  const rawMin = Math.min(...rawSeries);
  const rawMax = Math.max(...rawSeries);
  const filtMin = Math.min(...filtSeries);
  const filtMax = Math.max(...filtSeries);
  assert.ok(rawMax - rawMin > 200, `Expected clear raw ADC EKG swing, got ${rawMin}..${rawMax}`);
  assert.ok(filtMax - filtMin > 120, `Expected preserved filtered R-peak swing, got ${filtMin}..${filtMax}`);

  // In the quiet diastolic segment (samples 120..160 -> t ~ 0.60..0.80 s), 60 Hz hum ripple should be attenuated
  const quietRaw = rawSeries.slice(120, 160);
  const quietFilt = filtSeries.slice(120, 160);
  const quietRawSpan = Math.max(...quietRaw) - Math.min(...quietRaw);
  const quietFiltSpan = Math.max(...quietFilt) - Math.min(...quietFilt);
  assert.ok(
    quietFiltSpan < quietRawSpan * 0.45,
    `Expected FIR filter to attenuate 60 Hz hum in baseline: rawSpan=${quietRawSpan.toFixed(1)}, filtSpan=${quietFiltSpan.toFixed(1)}`
  );
});

test('emg-isolated-safe preset: IEC 60601 safe (fc ≈ 31.8 Hz), live capacitor stepper feeds AC EMG around +2.5 V to A0, and toggling usbIsolatorEnabled drops to partial', () => {
  const preset = buildPresetCircuit('emg-isolated-safe');
  assert.equal(preset.boardConfig.elvisMode, false);
  assert.equal(preset.boardConfig.emgMode, true);
  assert.equal(preset.boardConfig.sensorPosition, 'top');
  assert.equal(preset.simConfig.powered, true);
  assert.equal(preset.simConfig.usbIsolatorEnabled, true);
  assert.equal(preset.defaultArduino.open, true);
  assert.equal(preset.defaultArduino.autoRun, true);
  assert.equal(preset.defaultArduino.sketchId, 'fir-emg-filter');
  assert.equal(preset.defaultArduino.drawerTab, 'plotter');

  const bb = new BreadboardModel(preset.boardConfig);
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  const dc = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    simConfig: preset.simConfig
  });
  assert.equal(dc.converged, true);

  const isoSafe = analyzeCircuitIsolation({
    breadboard: bb,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    connectivity: conn,
    simConfig: preset.simConfig,
    dcResult: dc
  });
  assert.equal(isoSafe.active, true);
  assert.equal(isoSafe.level, 'safe');
  assert.equal(isoSafe.hasUsbIsolator, true);
  assertApprox(isoSafe.detectedHpfCutoffHz, 31.83, 2.0, 'emg-isolated-safe HPF cutoff (Hz)');

  // Verify live capacitor stepper delivers filtered AC EMG bursts centered around +2.5 V at Nano A0
  const nano = preset.placedParts.find((p) => p.partId === 'arduino-nano');
  assert.ok(nano);
  const a0Hole = conn.getPinHole(nano.id, 'A0');
  const gndHole = conn.getPinHole(nano.id, 'GND_BOT') || conn.getPinHole(nano.id, 'GND_TOP');
  assert.ok(a0Hole && gndHole);
  const a0Net = conn.getNetForHole(a0Hole.id).id;
  const gndNet = conn.getNetForHole(gndHole.id).id;

  const stepper = createLiveCircuitStepper({
    breadboard: bb,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    connectivity: conn,
    simConfig: preset.simConfig
  });
  assert.equal(stepper.hasCapacitors, true);

  const samples = [];
  for (let i = 0; i <= 60; i += 1) {
    const tSec = i * 0.008;
    const step = stepper.stepToTime(tSec);
    const vA0 = step.nodeVoltages.get(a0Net) - step.nodeVoltages.get(gndNet);
    assert.ok(Number.isFinite(vA0), `Expected finite A0 voltage at t=${tSec}`);
    samples.push(vA0);
  }
  const vMin = Math.min(...samples);
  const vMax = Math.max(...samples);
  const vAvg = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  assertApprox(vAvg, 2.5, 0.15, 'emg-isolated-safe A0 bias (V)');
  assert.ok(vMax - vMin > 0.25, `Expected live AC EMG burst swing at A0 > 0.25 Vpp, got ${(vMax - vMin).toFixed(3)} V`);

  // Toggling usbIsolatorEnabled: false drops isolation level from 'safe' to 'partial'
  const isoPartial = analyzeCircuitIsolation({
    breadboard: bb,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap: CATALOG,
    connectivity: conn,
    simConfig: { ...preset.simConfig, usbIsolatorEnabled: false },
    dcResult: dc
  });
  assert.equal(isoPartial.level, 'partial');
  assert.equal(isoPartial.hasUsbIsolator, false);
});






