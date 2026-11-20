import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import { solveDcCircuit } from '../js/sim/dcSolver.js';
import { solveTransientCircuit } from '../js/sim/transientSolver.js';
import { computeWaveformMetrics } from '../js/sim/linearAlgebra.js';
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
  assert.equal(LAB_PRESETS.length, 6);

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

