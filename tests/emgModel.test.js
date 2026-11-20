import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import {
  DEFAULT_EMG_CONFIG,
  EMG_IMPEDANCE_OHMS,
  createDefaultEmgConfig,
  evaluateEmgSignals
} from '../js/sim/emgModel.js';
import { computeWaveformMetrics } from '../js/sim/linearAlgebra.js';
import { solveDcCircuit, createDefaultSimConfig } from '../js/sim/dcSolver.js';
import { solveTransientCircuit } from '../js/sim/transientSolver.js';

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

test('1. createDefaultEmgConfig clamps out-of-range fields and provides clean defaults', () => {
  assert.equal(Object.isFrozen(DEFAULT_EMG_CONFIG), true);
  assert.equal(Object.isFrozen(EMG_IMPEDANCE_OHMS), true);
  assert.deepEqual(EMG_IMPEDANCE_OHMS, { red1: 5000, red2Base: 5000, blk: 2000 });

  const def = createDefaultEmgConfig();
  assert.deepEqual(def, {
    flexEffort: 0.5,
    burstMode: 'burst',
    humMvpp: 0,
    electrodeMismatch: 0.05
  });

  const clampedHigh = createDefaultEmgConfig({
    flexEffort: 2.5,
    burstMode: 'invalid-mode',
    humMvpp: 200,
    electrodeMismatch: 1.5
  });
  assert.deepEqual(clampedHigh, {
    flexEffort: 1,
    burstMode: 'burst',
    humMvpp: 50,
    electrodeMismatch: 0.5
  });

  const clampedLow = createDefaultEmgConfig({
    flexEffort: -0.4,
    burstMode: 'continuous',
    humMvpp: -10,
    electrodeMismatch: -0.2
  });
  assert.deepEqual(clampedLow, {
    flexEffort: 0,
    burstMode: 'continuous',
    humMvpp: 0,
    electrodeMismatch: 0
  });

  const simCfg = createDefaultSimConfig({ emg: { flexEffort: 0.8, humMvpp: 15 } });
  assert.equal(simCfg.emg.flexEffort, 0.8);
  assert.equal(simCfg.emg.humMvpp, 15);
  assert.equal(simCfg.emg.burstMode, 'burst');
});

test('2. evaluateEmgSignals: rest baseline, continuous flex, burst alternation, and 60 Hz common-mode hum', () => {
  const sampleSeries = (cfg, durationSec = 0.18, numSamples = 900) => {
    const dt = durationSec / (numSamples - 1);
    const diff = new Float64Array(numSamples);
    const cm = new Float64Array(numSamples);
    const red1 = new Float64Array(numSamples);
    const red2 = new Float64Array(numSamples);
    const env = new Float64Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const s = evaluateEmgSignals(cfg, i * dt);
      diff[i] = s.vDiff;
      cm[i] = s.vCommonMode;
      red1[i] = s.vRed1;
      red2[i] = s.vRed2;
      env[i] = s.envelope;
    }
    return { dt, diff, cm, red1, red2, env };
  };

  // Determinism check
  assert.deepEqual(
    evaluateEmgSignals({ flexEffort: 0.75, burstMode: 'burst', humMvpp: 12 }, 0.087),
    evaluateEmgSignals({ flexEffort: 0.75, burstMode: 'burst', humMvpp: 12 }, 0.087)
  );

  // Rest baseline (flexEffort = 0): tiny < 0.15 mVpp noise
  const rest = sampleSeries({ flexEffort: 0, burstMode: 'continuous', humMvpp: 0 });
  const restMetrics = computeWaveformMetrics(rest.diff, rest.dt);
  assert.ok(
    restMetrics.vpp < 0.00015,
    `Expected rest baseline < 0.15 mVpp, got ${(restMetrics.vpp * 1000).toFixed(4)} mVpp`
  );

  // Full flex (flexEffort = 1.0, continuous): 2.0-4.0 mVpp differential EMG
  const flex = sampleSeries({ flexEffort: 1.0, burstMode: 'continuous', humMvpp: 0 }, 0.25, 1200);
  const flexMetrics = computeWaveformMetrics(flex.diff, flex.dt);
  assert.ok(
    flexMetrics.vpp >= 0.002 && flexMetrics.vpp <= 0.004,
    `Expected full-flex EMG 2.0–4.0 mVpp, got ${(flexMetrics.vpp * 1000).toFixed(3)} mVpp`
  );

  // Burst mode: quiet baseline during rest interval (t = 0.015s) vs strong contraction peak (t = 0.09s)
  const burst = sampleSeries({ flexEffort: 1.0, burstMode: 'burst', humMvpp: 0 }, 0.18, 900);
  let restWindowPeak = 0;
  let activeWindowPeak = 0;
  for (let i = 0; i < burst.diff.length; i++) {
    const t = i * burst.dt;
    if (t <= 0.04 || t >= 0.14) {
      restWindowPeak = Math.max(restWindowPeak, Math.abs(burst.diff[i]));
    } else if (t >= 0.07 && t <= 0.11) {
      activeWindowPeak = Math.max(activeWindowPeak, Math.abs(burst.diff[i]));
    }
  }
  assert.ok(
    restWindowPeak < 0.0001,
    `Expected quiet rest window < 0.1 mV peak, got ${(restWindowPeak * 1000).toFixed(4)} mV`
  );
  assert.ok(
    activeWindowPeak > 0.0008,
    `Expected contraction burst peak > 0.8 mV, got ${(activeWindowPeak * 1000).toFixed(3)} mV`
  );

  // Common-mode 60 Hz hum: humMvpp = 20 adds exact 20 mVpp on red1 & red2 while leaving vDiff untouched
  const humSeries = sampleSeries({ flexEffort: 0, burstMode: 'continuous', humMvpp: 20 }, 0.1, 1000);
  const cmMetrics = computeWaveformMetrics(humSeries.cm, humSeries.dt);
  const r1Metrics = computeWaveformMetrics(humSeries.red1, humSeries.dt);
  const r2Metrics = computeWaveformMetrics(humSeries.red2, humSeries.dt);
  const humDiffMetrics = computeWaveformMetrics(humSeries.diff, humSeries.dt);

  assertApprox(cmMetrics.vpp, 0.02, 1e-4, '20 mVpp common-mode hum');
  assertApprox(r1Metrics.vpp, 0.02, 3e-4, 'vRed1 carries 20 mVpp hum');
  assertApprox(r2Metrics.vpp, 0.02, 3e-4, 'vRed2 carries 20 mVpp hum');
  assert.ok(
    humDiffMetrics.vpp < 0.00015,
    `Expected vDiff unaffected by 60 Hz hum, got ${(humDiffMetrics.vpp * 1000).toFixed(4)} mVpp`
  );
});

test('3. Full Circuit Integration (3-Pad EMG -> AD620 G=495 on ±15V ELVIS rails) + Common-Mode Rejection', () => {
  const bb = new BreadboardModel({ elvisMode: true, emgMode: true });
  // AD620 at e28 with rotation 90 in ELVIS mode:
  //   RG2 (0,0)->e28, VS+ (1,0)->e29, OUT (2,0)->e30, REF (3,0)->e31
  //   RG1 (0,3)->f28, IN- (1,3)->f29, IN+ (2,3)->f30, VS- (3,3)->f31
  const placedParts = [
    { id: 'ia1', partId: 'inamp-ad620', anchorHoleId: 'e28', rotation: 90 },
    { id: 'rg1', partId: 'resistor-100-1pct', pinHoles: { P1: 'a28', P2: 'j28' } }
  ];
  const wires = [
    { id: 'w_vsp', holeA: 'ELV_51A', holeB: 'b29', colorName: 'Red' },
    { id: 'w_vsn', holeA: 'ELV_52A', holeB: 'g31', colorName: 'Blue' },
    { id: 'w_ref', holeA: 'ELV_49A', holeB: 'b31', colorName: 'Black' },
    { id: 'w_emg_blk', holeA: 'EMG_BLK_A', holeB: 'ELV_49B', colorName: 'Black' },
    { id: 'w_emg_r1', holeA: 'EMG_RED1_A', holeB: 'g30', colorName: 'Red' }, // -> IN+
    { id: 'w_emg_r2', holeA: 'EMG_RED2_A', holeB: 'g29', colorName: 'Red' } // -> IN-
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
  assert.deepEqual(conn.warnings, []);

  // DC bias path: EMG_BLK -> GND gives 0V DC on RED1, RED2, and AD620 OUT
  const dcSim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { powered: true }
  });
  assert.equal(dcSim.converged, true);
  assert.equal(dcSim.partResults.get('ia1').powered, true);
  assertApprox(dcSim.partResults.get('ia1').gain, 495, 1e-6, 'AD620 gain');
  assertApprox(dcSim.getHoleVoltage('EMG_RED1_B'), 0, 1e-4, 'DC bias RED1');
  assertApprox(dcSim.getHoleVoltage('EMG_RED2_B'), 0, 1e-4, 'DC bias RED2');
  assertApprox(dcSim.getHoleVoltage('b30'), 0, 1e-3, 'DC bias AD620 OUT');

  // 3a. Full flex (flexEffort = 1.0, continuous, humMvpp = 0): AD620 OUT ~1.0-2.0 Vpp (> 0.7 Vpp)
  const simFlex = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      emg: { flexEffort: 1.0, burstMode: 'continuous', humMvpp: 0, electrodeMismatch: 0.05 }
    },
    totalDurationSec: 0.2,
    numSamples: 600,
    probeHoles: ['b30', 'EMG_RED1_B']
  });
  const flexOutTrace = simFlex.getHoleTrace('b30');
  assert.equal(flexOutTrace.valid, true);
  const flexOutMetrics = computeWaveformMetrics(flexOutTrace.samples, simFlex.dt);
  assert.ok(
    flexOutMetrics.vpp > 0.7 && flexOutMetrics.vpp < 2.2,
    `Expected AD620 amplified EMG 0.7–2.2 Vpp, got ${flexOutMetrics.vpp.toFixed(3)} Vpp`
  );

  // 3b. Rest (flexEffort = 0, humMvpp = 0): AD620 OUT drops to < 0.08 Vpp
  const simRest = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      emg: { flexEffort: 0, burstMode: 'continuous', humMvpp: 0, electrodeMismatch: 0.05 }
    },
    totalDurationSec: 0.2,
    numSamples: 600,
    probeHoles: ['b30']
  });
  const restOutMetrics = computeWaveformMetrics(simRest.getHoleTrace('b30').samples, simRest.dt);
  assert.ok(
    restOutMetrics.vpp < 0.08,
    `Expected rest AD620 output < 0.08 Vpp, got ${restOutMetrics.vpp.toFixed(4)} Vpp`
  );

  // 3c. Common-Mode Rejection Demo: humMvpp = 20 (20 mVpp 60 Hz hum) with flexEffort = 0
  const simHum = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      emg: { flexEffort: 0, burstMode: 'continuous', humMvpp: 20, electrodeMismatch: 0.05 }
    },
    totalDurationSec: 0.1,
    numSamples: 600,
    probeHoles: ['b30', 'EMG_RED1_B']
  });
  const red1HumTrace = simHum.getHoleTrace('EMG_RED1_B');
  const outHumTrace = simHum.getHoleTrace('b30');
  assert.equal(red1HumTrace.valid, true);
  assert.equal(outHumTrace.valid, true);

  const red1HumMetrics = computeWaveformMetrics(red1HumTrace.samples, simHum.dt);
  const outHumMetrics = computeWaveformMetrics(outHumTrace.samples, simHum.dt);

  assertApprox(red1HumMetrics.vpp, 0.02, 1e-3, 'Single-ended EMG_RED1 carries ~20 mVpp 60 Hz hum');
  assert.ok(
    outHumMetrics.vpp < 0.15,
    `Expected AD620 CMRR to reject 20 mVpp common-mode hum (< 0.15 Vpp), got ${outHumMetrics.vpp.toFixed(4)} Vpp`
  );
});
