import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import {
  ARB_BUILT_IN_WAVEFORMS,
  DEFAULT_ARB_CONFIG,
  createDefaultArbConfig,
  evaluateArbChannel,
  getArbChannelDcMean,
  getArbChannelFreqHz,
  getArbChannelSamples,
  getArbEffectiveBandwidthHz,
  parseArbCsvText
} from '../js/sim/arbModel.js';
import {
  DEFAULT_SIM_CONFIG,
  SOLVER_CONSTANTS,
  getSlowestStimulusFreqHz,
  hasTimeVaryingStimulus
} from '../js/sim/circuitElements.js';
import { computeWaveformMetrics } from '../js/sim/linearAlgebra.js';
import { solveDcCircuit, createDefaultSimConfig } from '../js/sim/dcSolver.js';
import { createLiveCircuitStepper, solveTransientCircuit } from '../js/sim/transientSolver.js';
import { solveBodeSweep } from '../js/sim/acSolver.js';

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

test('1. createDefaultArbConfig cloning, clamping, and simConfig integration', () => {
  assert.equal(Object.isFrozen(DEFAULT_ARB_CONFIG), true);
  assert.equal(Object.isFrozen(ARB_BUILT_IN_WAVEFORMS), true);
  assert.equal(SOLVER_CONSTANTS.R_ARB_OUT, 10);

  const def = createDefaultArbConfig();
  assert.equal(def.running, false);
  assert.equal(def.updateRateHz, 1000);
  assert.equal(def.ao0.enabled, true);
  assert.equal(def.ao0.waveformId, 'ekg-nsr-72');
  assert.equal(def.ao0.gain, 1.0);
  assert.equal(def.ao0.offsetV, 0.0);
  assert.equal(def.ao0.probeHole, null);
  assert.equal(def.ao1.enabled, false);
  assert.equal(def.ao1.waveformId, '');

  // Verify clamping & deep cloning of customSamples (max 4096 samples, clamped to ±10 V)
  const oversizedSamples = Array.from({ length: 5000 }, (_, i) => (i % 2 === 0 ? 25 : -25));
  const customCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 50000,
    ao0: {
      enabled: true,
      waveformId: 'custom',
      gain: 25,
      offsetV: -9,
      probeHole: ' e12 ',
      customName: ' my_wave.csv ',
      customSamples: oversizedSamples
    },
    ao1: {
      enabled: true,
      waveformId: 'sine-10hz',
      gain: 0.0001,
      offsetV: 12
    }
  });

  assert.equal(customCfg.running, true);
  assert.equal(customCfg.updateRateHz, 20000);
  assert.equal(customCfg.ao0.gain, 10.0);
  assert.equal(customCfg.ao0.offsetV, -5.0);
  assert.equal(customCfg.ao0.probeHole, 'e12');
  assert.equal(customCfg.ao0.customName, 'my_wave.csv');
  assert.equal(customCfg.ao0.customSamples.length, 4096);
  assert.equal(customCfg.ao0.customSamples[0], 10);
  assert.equal(customCfg.ao0.customSamples[1], -10);

  // Mutating original input array must not mutate cloned config
  oversizedSamples[0] = 0;
  assert.equal(customCfg.ao0.customSamples[0], 10);

  assert.equal(customCfg.ao1.gain, 0.01);
  assert.equal(customCfg.ao1.offsetV, 5.0);

  const lowRateCfg = createDefaultArbConfig({ updateRateHz: 10 });
  assert.equal(lowRateCfg.updateRateHz, 100);

  // Also ensure createDefaultSimConfig includes isolated arb config
  const simCfg = createDefaultSimConfig({ arb: { running: true, ao0: { gain: 2.5 } } });
  assert.equal(simCfg.arb.running, true);
  assert.equal(simCfg.arb.ao0.gain, 2.5);
  assert.equal(simCfg.arb.ao0.waveformId, 'ekg-nsr-72');
});

test('2. Built-in EKG, PPG, and Sine waveforms: morphology, BPM scaling, gain/offset ±10V clamping', () => {
  // Stopped ARB always evaluates to 0 V and 0 DC mean, while ignoreRunning exposes planned freq
  const stoppedCfg = createDefaultArbConfig({ running: false });
  assert.equal(evaluateArbChannel(stoppedCfg, 'ao0', 0.29), 0);
  assert.equal(getArbChannelDcMean(stoppedCfg, 'ao0'), 0);
  assert.equal(getArbChannelFreqHz(stoppedCfg, 'ao0'), null);
  assertApprox(
    getArbChannelFreqHz(stoppedCfg, 'ao0', { ignoreRunning: true }),
    1000 / 833,
    1e-6,
    'planned freq when stopped'
  );
  assert.equal(getArbEffectiveBandwidthHz(stoppedCfg), 0);

  // Normal Sinus EKG (72 BPM @ 1k S/s -> 833 pts)
  const nsrCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 1000,
    ao0: { enabled: true, waveformId: 'ekg-nsr-72', gain: 1.0, offsetV: 0.0 }
  });
  const nsrMeta = getArbChannelSamples(nsrCfg.ao0);
  assert.equal(nsrMeta.count, 833);
  assertApprox(getArbChannelFreqHz(nsrCfg, 'ao0'), 1000 / 833, 1e-6, '72 BPM ~ 1.2 Hz');
  assert.ok(getArbEffectiveBandwidthHz(nsrCfg) >= 85, 'EKG bandwidth >= 85 Hz');

  // Check P, Q, R, S, T morphology landmarks (1 beat = 0.833 s)
  const vBaseline = evaluateArbChannel(nsrCfg, 'ao0', 0.0);
  const vP = evaluateArbChannel(nsrCfg, 'ao0', 0.20 * 0.833);
  const vQ = evaluateArbChannel(nsrCfg, 'ao0', 0.315 * 0.833);
  const vR = evaluateArbChannel(nsrCfg, 'ao0', 0.35 * 0.833);
  const vS = evaluateArbChannel(nsrCfg, 'ao0', 0.386 * 0.833);
  const vT = evaluateArbChannel(nsrCfg, 'ao0', 0.56 * 0.833);

  assertApprox(vBaseline, 0, 1e-3, 'zero baseline');
  assert.ok(vP > 0.10 && vP < 0.18, `P wave expected ~0.14 V, got ${vP}`);
  assert.ok(vQ < 0, `Q dip expected negative, got ${vQ}`);
  assert.ok(vR > 0.95 && vR <= 1.02, `R peak expected ~1.0 V, got ${vR}`);
  assert.ok(vS < -0.08, `S dip expected negative, got ${vS}`);
  assert.ok(vT > 0.24 && vT < 0.32, `T wave expected ~0.28 V, got ${vT}`);

  // Update Rate frequency scaling: 2k S/s doubles frequency -> 144 BPM (2.4 Hz)
  const fastCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 2000,
    ao0: { enabled: true, waveformId: 'ekg-nsr-72' }
  });
  assertApprox(getArbChannelFreqHz(fastCfg, 'ao0'), 2000 / 833, 1e-6, '2k S/s -> 144 BPM');
  const vRAt2k = evaluateArbChannel(fastCfg, 'ao0', 0.35 * (0.833 / 2));
  assert.ok(vRAt2k > 0.95, `R peak shifts to half-period at 2k S/s, got ${vRAt2k}`);

  // Tachycardia EKG (120 BPM @ 1k S/s -> 500 pts -> 2.0 Hz)
  const tachyCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 1000,
    ao0: { enabled: true, waveformId: 'ekg-tachy' }
  });
  assert.equal(getArbChannelSamples(tachyCfg.ao0).count, 500);
  assertApprox(getArbChannelFreqHz(tachyCfg, 'ao0'), 2.0, 1e-9, '120 BPM = 2.0 Hz');

  // EKG + 60 Hz hum has exact 60 Hz ripple component + higher peak than pure NSR
  const humCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 1000,
    ao0: { enabled: true, waveformId: 'ekg-hum60' }
  });
  const humMeta = getArbChannelSamples(humCfg.ao0);
  assert.equal(humMeta.count, 833);
  // At p=0.005 (quarter cycle of 50-cycle hum: sin(2π * 50 * 0.005) = +1), EKG baseline ~ 0 -> ~+0.25 V
  assertApprox(evaluateArbChannel(humCfg, 'ao0', 0.005 * 0.833), 0.25, 0.02, '60 Hz hum quarter-cycle');

  // Gain + Offset clamping to ±10 V
  const clampCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 1000,
    ao0: { enabled: true, waveformId: 'ekg-nsr-72', gain: 10.0, offsetV: 5.0 }
  });
  assert.equal(evaluateArbChannel(clampCfg, 'ao0', 0.35 * 0.833), 10.0);
  assertApprox(evaluateArbChannel(clampCfg, 'ao0', 0.0), 5.0, 1e-6, 'offset baseline near 5V');

  // Arterial PPG normalized to [-0.5, +0.5] and 10 Hz sine
  const ppgCfg = createDefaultArbConfig({
    running: true,
    ao0: { enabled: true, waveformId: 'ppg-arterial' }
  });
  const ppgSamples = getArbChannelSamples(ppgCfg.ao0).samples;
  let ppgMin = Infinity;
  let ppgMax = -Infinity;
  for (const v of ppgSamples) {
    if (v < ppgMin) ppgMin = v;
    if (v > ppgMax) ppgMax = v;
  }
  assert.ok(ppgMin >= -0.5 && ppgMin < -0.1, `PPG min expected in [-0.5, -0.1), got ${ppgMin}`);
  assert.ok(ppgMax > 0.4 && ppgMax <= 0.5, `PPG max expected in (0.4, 0.5], got ${ppgMax}`);

  const sineCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 1000,
    ao0: { enabled: true, waveformId: 'sine-10hz', gain: 2.0, offsetV: 1.5 }
  });
  assertApprox(getArbChannelFreqHz(sineCfg, 'ao0'), 1.0, 1e-9, '1000-pt buffer repeat rate @ 1k S/s');
  assertApprox(getArbChannelDcMean(sineCfg, 'ao0'), 1.5, 1e-6, '10 Hz Sine DC mean');
  assertApprox(evaluateArbChannel(sineCfg, 'ao0', 0.025), 3.5, 1e-3, '10 Hz Sine first peak at 25 ms');
  assertApprox(evaluateArbChannel(sineCfg, 'ao0', 0.075), -0.5, 1e-3, '10 Hz Sine first trough at 75 ms');
});

test('3. parseArbCsvText parses 1-column, 2-column CSV/TSV with headers/comments, and rejects invalid/empty input', () => {
  // 1-column CSV with header & comments
  const oneCol = parseArbCsvText(
    '# Custom EKG snippet\nvoltage\n0.0\n0.5\n1.0\n-0.25\n15.0\n',
    'lead2.csv'
  );
  assert.equal(oneCol.ok, true);
  assert.equal(oneCol.name, 'lead2.csv');
  assert.equal(oneCol.count, 5);
  assert.deepEqual(oneCol.samples, [0.0, 0.5, 1.0, -0.25, 10.0]);

  // 2-column time,voltage CSV/TSV with header & inline # and // comments
  const twoCol = parseArbCsvText(
    'time_s\tvoltage_v\n0.000\t-1.2 // baseline\n0.001, 0.8 # peak\n0.002; 0.3\n0.003   -12.5\n',
    'two_col.tsv'
  );
  assert.equal(twoCol.ok, true);
  assert.equal(twoCol.name, 'two_col.tsv');
  assert.equal(twoCol.truncated, false);
  assert.deepEqual(twoCol.samples, [-1.2, 0.8, 0.3, -10.0]);

  // Truncation flag when input exceeds 4096 samples
  const hugeCsv = Array.from({ length: 4200 }, (_, i) => (i % 10) * 0.1).join('\n');
  const truncRes = parseArbCsvText(hugeCsv, 'huge.csv');
  assert.equal(truncRes.ok, true);
  assert.equal(truncRes.count, 4096);
  assert.equal(truncRes.truncated, true);

  // Invalid / empty inputs
  const emptyRes = parseArbCsvText('   \n  \n');
  assert.equal(emptyRes.ok, false);
  assert.ok(emptyRes.error.length > 0);

  const headerOnlyRes = parseArbCsvText('time,voltage\nfoo,bar\n');
  assert.equal(headerOnlyRes.ok, false);
  assert.ok(headerOnlyRes.error.length > 0);
});

test('4. Full circuit integration: AO 0 ekg-hum60 -> 1k + 4.7uF RC LPF (DC, Transient, and Bode AC compatibility)', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const testCatalog = new Map(CATALOG);
  testCatalog.set('cap-4u7', { ...CATALOG.get('cap-10uf'), id: 'cap-4u7', value: 4.7e-6 });
  // AO 0 (ELV_31A) -> e10 -> 1 kΩ (a10..a14) -> Vout (strip 14, AI0+ ELV_1A) -> 4.7 µF (b14..b18) -> GND (ELV_49A)
  const placedParts = [
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'c1', partId: 'cap-4u7', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_ao0', holeA: 'ELV_31A', holeB: 'e10', colorName: 'Orange' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd14', colorName: 'Green' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, testCatalog);
  assert.deepEqual(conn.warnings, []);

  const arbConfig = {
    running: true,
    updateRateHz: 1000,
    ao0: {
      enabled: true,
      waveformId: 'ekg-hum60',
      gain: 1.0,
      offsetV: 2.0
    }
  };

  // 4a. DC solver steady-state (timeSec = null): capacitor open, node voltages equal DC mean (~2.0 V + tiny EKG mean)
  const expectedDcMean = getArbChannelDcMean(createDefaultArbConfig(arbConfig), 'ao0');
  const dcSteady = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: testCatalog,
    simConfig: { powered: true, arb: arbConfig }
  });
  assert.equal(dcSteady.converged, true);
  assertApprox(dcSteady.getHoleVoltage('ELV_31A'), expectedDcMean, 1e-4, 'AO0 DC mean');
  assertApprox(dcSteady.getHoleVoltage('ELV_1A'), expectedDcMean, 1e-4, 'LPF output DC mean');

  // 4b. DC solver live-sampling (timeSec = R-peak time): samples live EKG+hum (~3.0 V at R-peak)
  const rPeakTime = 0.35 * (833 / 1000);
  const expectedLiveR = evaluateArbChannel(createDefaultArbConfig(arbConfig), 'ao0', rPeakTime);
  const dcLive = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: testCatalog,
    simConfig: { powered: true, arb: arbConfig },
    timeSec: rPeakTime
  });
  assertApprox(dcLive.getHoleVoltage('ELV_31A'), expectedLiveR, 1e-3, 'AO0 live R-peak sample');
  assert.ok(dcLive.getHoleVoltage('ELV_31A') > 2.75, 'Live R-peak > 2.75 V');

  // 4c. Transient solver over 1.0 s (fc = 1/(2π*1k*4.7uF) ≈ 33.86 Hz):
  // AO0 input has 0.50 Vpp 60 Hz hum + ~1.0 V R-peak; filtered Vout strongly attenuates 60 Hz hum while preserving EKG peak!
  const sim = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: testCatalog,
    simConfig: { powered: true, arb: arbConfig },
    totalDurationSec: 1.0,
    numSamples: 600 // should auto-bump to 900 for crisp EKG R-peaks!
  });
  assert.equal(sim.numSamples, 900);

  const ao0Trace = sim.getChannelTrace({ type: 'AO0' });
  const outTrace = sim.getChannelTrace({ type: 'AI0' });
  const ao1Trace = sim.getChannelTrace({ type: 'AO1' });
  assert.equal(ao0Trace.valid, true);
  assert.equal(outTrace.valid, true);
  assert.equal(ao1Trace.valid, false); // AO1 disabled

  // Check baseline 60 Hz ripple region (t in [0.68, 0.80] s where EKG beat is quiet near 0 relative to offset)
  const measureWindowVpp = (samples, times, tMin, tMax) => {
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= tMin && times[i] <= tMax) {
        if (samples[i] < minV) minV = samples[i];
        if (samples[i] > maxV) maxV = samples[i];
      }
    }
    return { minV, maxV, vpp: maxV - minV };
  };

  const inHumWin = measureWindowVpp(ao0Trace.samples, sim.times, 0.65, 0.80);
  const outHumWin = measureWindowVpp(outTrace.samples, sim.times, 0.65, 0.80);
  assertApprox(inHumWin.vpp, 0.5, 0.04, 'AO0 60 Hz hum (~0.50 Vpp)');
  assert.ok(
    outHumWin.vpp < inHumWin.vpp * 0.65,
    `Expected RC LPF (fc=33.9 Hz) to attenuate 60 Hz hum: in=${inHumWin.vpp.toFixed(3)} Vpp, out=${outHumWin.vpp.toFixed(3)} Vpp`
  );

  // R-peak around t ~ 0.29 s should stay clearly prominent above baseline on both input and filtered output
  const inPeakWin = measureWindowVpp(ao0Trace.samples, sim.times, 0.24, 0.36);
  const outPeakWin = measureWindowVpp(outTrace.samples, sim.times, 0.24, 0.36);
  assert.ok(inPeakWin.maxV > 2.85, `Expected AO0 R-peak > 2.85 V, got ${inPeakWin.maxV}`);
  assert.ok(outPeakWin.maxV > 2.45, `Expected filtered EKG R-peak > 2.45 V, got ${outPeakWin.maxV}`);

  // 4d. Bode AC sweep with FGEN probeHole at e10 & active ARB on AO0 (which also connects to e10 -> acSolver ignores ARB!)
  // Wait: if AO0 is wired to e10, in acSolver includeArb=false keeps ARB from seeding extra floating nets,
  // and if FGEN injects via probeHole at e10 while AO0 is disconnected (or ARB stopped), Bode measures fc ~ 33.86 Hz cleanly.
  const bodeRes = solveBodeSweep({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: testCatalog,
    simConfig: {
      powered: true,
      arb: { running: false },
      fgen: { enabled: true, probeHole: 'e10' }
    },
    bodeConfig: {
      startFreqHz: 5,
      stopFreqHz: 500,
      stepsPerDecade: 20,
      inputSource: 'FGEN',
      outputSource: 'AI0'
    }
  });
  assert.equal(bodeRes.valid, true);
  assert.equal(bodeRes.cutoffs.length, 1);
  assertApprox(bodeRes.cutoffs[0].freqHz, 33.86, 2.0, 'RC LPF -3 dB cutoff with Bode sweep');

  // Verify solveBodeSweep also succeeds when ARB is running on an isolated pin while FGEN sweeps RC LPF
  const wiresIsolatedArb = [
    ...wires,
    { id: 'w_ao1_iso', holeA: 'ELV_32A', holeB: 'j40', colorName: 'Purple' }
  ];
  const bodeWithRunningArb = solveBodeSweep({
    breadboard: bb,
    placedParts,
    wires: wiresIsolatedArb,
    catalogMap: testCatalog,
    simConfig: {
      powered: true,
      arb: {
        running: true,
        ao0: { enabled: false, waveformId: '' },
        ao1: { enabled: true, waveformId: 'sine-10hz' }
      },
      fgen: { enabled: true, probeHole: 'e10' }
    },
    bodeConfig: {
      startFreqHz: 5,
      stopFreqHz: 500,
      stepsPerDecade: 20,
      inputSource: 'FGEN',
      outputSource: 'AI0'
    }
  });
  assert.equal(bodeWithRunningArb.valid, true);
  assertApprox(bodeWithRunningArb.cutoffs[0].freqHz, 33.86, 2.0, 'Bode sweep ignores running ARB');
});

test('5. hasTimeVaryingStimulus and getSlowestStimulusFreqHz with active/stopped ARB', () => {
  const bb = new BreadboardModel({ elvisMode: true });

  // Stopped ARB -> false / null
  const stoppedSimCfg = {
    fgen: { enabled: false },
    arb: {
      running: false,
      ao0: { enabled: true, waveformId: 'ekg-nsr-72' },
      ao1: { enabled: false, waveformId: '' }
    }
  };
  assert.equal(hasTimeVaryingStimulus({ breadboard: bb, simConfig: stoppedSimCfg }), false);
  assert.equal(getSlowestStimulusFreqHz({ breadboard: bb, simConfig: stoppedSimCfg }), null);

  // Active AO0 (ekg-nsr-72 @ 1k S/s -> ~1.2005 Hz) -> true & ~1.2005 Hz
  const ao0SimCfg = {
    fgen: { enabled: false },
    arb: {
      running: true,
      updateRateHz: 1000,
      ao0: { enabled: true, waveformId: 'ekg-nsr-72' },
      ao1: { enabled: false, waveformId: '' }
    }
  };
  assert.equal(hasTimeVaryingStimulus({ breadboard: bb, simConfig: ao0SimCfg }), true);
  assertApprox(
    getSlowestStimulusFreqHz({ breadboard: bb, simConfig: ao0SimCfg }),
    1000 / 833,
    1e-6,
    'AO0 72 BPM slowest freq'
  );

  // Active AO0 (10 Hz) + AO1 (ekg-wander: 2500 pts @ 1k S/s -> 0.4 Hz) -> slowest is 0.4 Hz
  const dualArbCfg = {
    fgen: { enabled: true, frequencyHz: 100 },
    arb: {
      running: true,
      updateRateHz: 1000,
      ao0: { enabled: true, waveformId: 'sine-10hz' },
      ao1: { enabled: true, waveformId: 'ekg-wander' }
    }
  };
  assert.equal(hasTimeVaryingStimulus({ breadboard: bb, simConfig: dualArbCfg }), true);
  assertApprox(
    getSlowestStimulusFreqHz({ breadboard: bb, simConfig: dualArbCfg }),
    0.4,
    1e-9,
    'AO1 ekg-wander 0.4 Hz slowest freq'
  );

  // Running ARB with both channels disabled or empty -> false / null
  const emptyArbCfg = {
    fgen: { enabled: false },
    arb: {
      running: true,
      ao0: { enabled: false, waveformId: 'ekg-nsr-72' },
      ao1: { enabled: true, waveformId: '' }
    }
  };
  assert.equal(hasTimeVaryingStimulus({ breadboard: bb, simConfig: emptyArbCfg }), false);
  assert.equal(getSlowestStimulusFreqHz({ breadboard: bb, simConfig: emptyArbCfg }), null);
});

test('6. Unwired ELVIS AO 0 non-floating, stale probeHole ignored in ELVIS mode, & 500 ms/div 60 Hz hum anti-aliasing', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // Completely unwired breadboard with a stale probeHole='a10' from Standard mode
  const placedParts = [{ id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } }];
  const wires = [{ id: 'w_gnd', holeA: 'e14', holeB: 'ELV_49A', colorName: 'Black' }];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const arbCfg = {
    running: true,
    updateRateHz: 1000,
    ao0: {
      enabled: true,
      waveformId: 'ekg-hum60',
      gain: 1.0,
      offsetV: 0.0,
      probeHole: 'a10' // stale Standard-mode probeHole must NOT drive a10 in ELVIS mode!
    }
  };

  // DC live solve at R-peak: unwired ELV_31A is non-floating (~0.98V), while a10 stays 0 V (pulled to GND via R1)
  const rPeakTime = 0.35 * (833 / 1000);
  const dcLive = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { powered: true, arb: arbCfg },
    timeSec: rPeakTime
  });
  assert.ok(dcLive.getHoleVoltage('ELV_31A') > 0.9, 'Unwired ELVIS AO 0 is non-floating and driven');
  assertApprox(dcLive.getHoleVoltage('a10'), 0.0, 1e-6, 'Stale probeHole ignored in ELVIS mode');

  // 500 ms/div Scope capture = 10 s window (10 div * 0.5 s/div * 2):
  // must capture >= 1200 samples (2400 cap) so 60 Hz hum + R-peaks do not alias!
  const simLong = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { powered: true, arb: arbCfg },
    totalDurationSec: 10.0,
    numSamples: 600
  });
  assert.ok(
    simLong.numSamples >= 1200,
    `Expected >= 1200 samples for 10 s 60 Hz EKG capture, got ${simLong.numSamples}`
  );
  const ao0Long = simLong.getChannelTrace({ type: 'AO0' });
  assert.equal(ao0Long.valid, true);
  const metrics = computeWaveformMetrics(ao0Long.samples, simLong.dt);
  assert.ok(metrics.vMax > 0.95, `Expected crisp un-aliased R-peak > 0.95 V over 10 s, got ${metrics.vMax}`);
  assert.ok(metrics.vMin < -0.25, `Expected 60 Hz hum trough < -0.25 V over 10 s, got ${metrics.vMin}`);

  // Also verify ekg-wander bandwidth covers sharpened QRS + 60 Hz hum across 2500 pts
  const wanderCfg = createDefaultArbConfig({
    running: true,
    updateRateHz: 1000,
    ao0: { enabled: true, waveformId: 'ekg-wander' }
  });
  assert.ok(getArbEffectiveBandwidthHz(wanderCfg) >= 85);
  assert.equal(DEFAULT_SIM_CONFIG.usbIsolatorEnabled, false);
  assert.equal(createDefaultSimConfig({ usbIsolatorEnabled: true }).usbIsolatorEnabled, true);
});

test('7. Multi-frequency RC LPF QRS attenuation (fc = 159 Hz, 15.9 Hz, 1.59 Hz) in transient & createLiveCircuitStepper', () => {
  const buildLpfCircuit = (rOhms, cFarads) => {
    const bb = new BreadboardModel({ elvisMode: true });
    const testCatalog = new Map(CATALOG);
    testCatalog.set('test-r', { ...CATALOG.get('resistor-1k-1pct'), id: 'test-r', value: rOhms });
    testCatalog.set('test-c', { ...CATALOG.get('cap-10uf'), id: 'test-c', value: cFarads });
    const placedParts = [
      { id: 'r1', partId: 'test-r', pinHoles: { P1: 'a10', P2: 'a14' } },
      { id: 'c1', partId: 'test-c', pinHoles: { P1: 'b14', P2: 'b18' } }
    ];
    const wires = [
      { id: 'w_ao0', holeA: 'ELV_31A', holeB: 'e10', colorName: 'Orange' },
      { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd14', colorName: 'Green' },
      { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, testCatalog);
    assert.deepEqual(conn.warnings, []);
    return { bb, testCatalog, placedParts, wires, conn };
  };

  const simConfig = {
    powered: true,
    arb: {
      running: true,
      updateRateHz: 1000,
      ao0: { enabled: true, waveformId: 'ekg-nsr-72', gain: 1.0, offsetV: 0.0 }
    }
  };

  const sampleStepperWindow = (stepper, conn, outHoleId, startSec, endSec, stepSec) => {
    const outNet = conn.stripToNet ? null : null;
    void outNet;
    const samples = [];
    for (let t = startSec; t <= endSec + 1e-9; t += stepSec) {
      const snap = stepper.stepToTime(t);
      const hole = conn.breadboard.getHole(outHoleId);
      const netId = hole ? findHoleNetId(conn, hole.stripId) : null;
      samples.push(netId ? snap.nodeVoltages.get(netId) : NaN);
    }
    return samples;
  };

  const findHoleNetId = (conn, stripId) => {
    for (const [netId, net] of conn.nets.entries()) {
      if (net.strips.has(stripId)) return netId;
    }
    return null;
  };

  const cases = [
    { label: 'fc=159 Hz (1k + 1uF)', rOhms: 1000, cFarads: 1e-6, minPct: 0.90, maxPct: 1.02 },
    { label: 'fc=15.9 Hz (10k + 1uF)', rOhms: 10000, cFarads: 1e-6, minPct: 0.35, maxPct: 0.70 },
    { label: 'fc=1.59 Hz (100k + 1uF)', rOhms: 100000, cFarads: 1e-6, minPct: 0.0, maxPct: 0.22 }
  ];

  for (const tc of cases) {
    const { bb, testCatalog, placedParts, wires, conn } = buildLpfCircuit(tc.rOhms, tc.cFarads);
    const tr = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: testCatalog,
      simConfig,
      totalDurationSec: 0.85,
      numSamples: 600
    });
    const inTrace = tr.getChannelTrace({ type: 'AO0' });
    const outTrace = tr.getChannelTrace({ type: 'AI0' });
    assert.equal(inTrace.valid, true);
    assert.equal(outTrace.valid, true);
    const inMax = Math.max(...inTrace.samples);
    const outMax = Math.max(...outTrace.samples);
    const ratioTransient = outMax / inMax;
    assert.ok(
      ratioTransient >= tc.minPct && ratioTransient <= tc.maxPct,
      `${tc.label} transient R-peak ratio expected in [${tc.minPct}, ${tc.maxPct}], got ${ratioTransient.toFixed(3)}`
    );

    // Verify createLiveCircuitStepper matches transient R-peak ratio closely
    const tCreateStart = performance.now();
    const stepper = createLiveCircuitStepper({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: testCatalog,
      simConfig
    });
    const createMs = performance.now() - tCreateStart;
    assert.equal(stepper.hasCapacitors, true);
    assert.ok(createMs < 150, `createLiveCircuitStepper creation took ${createMs.toFixed(2)} ms`);

    const ao0Net = findHoleNetId(conn, bb.getHole('ELV_31A').stripId);
    const outNet = findHoleNetId(conn, bb.getHole('ELV_1A').stripId);
    let stepInMax = -Infinity;
    let stepOutMax = -Infinity;
    let stepCalls = 0;
    const tStepStart = performance.now();
    // Run across ~1 beat (0..0.85s at 5 ms Arduino sampling rate = 200 Hz)
    for (let t = 0.005; t <= 0.85; t += 0.005) {
      const snap = stepper.stepToTime(t);
      stepCalls += 1;
      const vIn = snap.nodeVoltages.get(ao0Net);
      const vOut = snap.nodeVoltages.get(outNet);
      if (vIn > stepInMax) stepInMax = vIn;
      if (vOut > stepOutMax) stepOutMax = vOut;
    }
    const avgStepMs = (performance.now() - tStepStart) / stepCalls;
    assert.ok(avgStepMs < 5, `Average stepToTime took ${avgStepMs.toFixed(3)} ms`);
    const ratioStepper = stepOutMax / stepInMax;
    assert.ok(
      ratioStepper >= tc.minPct && ratioStepper <= tc.maxPct,
      `${tc.label} stepper R-peak ratio expected in [${tc.minPct}, ${tc.maxPct}], got ${ratioStepper.toFixed(3)}`
    );
    assertApprox(ratioStepper, ratioTransient, 0.06, `${tc.label} stepper vs transient ratio`);
  }
  void sampleStepperWindow;
});

test('8. RC High-Pass Filter (1 uF + 10 kΩ, fc = 15.9 Hz) blocks +2.0 V DC offset and passes QRS R-peaks in transient & stepper', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const testCatalog = new Map(CATALOG);
  testCatalog.set('cap-1u', { ...CATALOG.get('cap-10uf'), id: 'cap-1u', value: 1e-6 });

  // Series 1 uF (e10 -> e14) then 10 kΩ shunt to GND (a14 -> a18)
  const placedParts = [
    { id: 'c1', partId: 'cap-1u', pinHoles: { P1: 'e10', P2: 'e14' } },
    { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a14', P2: 'a18' } }
  ];
  const wires = [
    { id: 'w_ao0', holeA: 'ELV_31A', holeB: 'd10', colorName: 'Orange' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd14', colorName: 'Green' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, testCatalog);
  assert.deepEqual(conn.warnings, []);

  const simConfig = {
    powered: true,
    arb: {
      running: true,
      updateRateHz: 1000,
      ao0: { enabled: true, waveformId: 'ekg-nsr-72', gain: 1.0, offsetV: 2.0 }
    }
  };

  // Transient solver over 2 beats
  const tr = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: testCatalog,
    simConfig,
    totalDurationSec: 1.666,
    numSamples: 900,
    warmupCycles: 4
  });
  const outTrace = tr.getChannelTrace({ type: 'AI0' });
  assert.equal(outTrace.valid, true);
  const trMetrics = computeWaveformMetrics(outTrace.samples, tr.dt);
  assertApprox(trMetrics.vAvg, 0.0, 0.05, 'HPF transient DC mean blocked near 0 V');
  assert.ok(trMetrics.vMax > 0.55, `HPF transient QRS R-peak passed cleanly (> 0.55 V), got ${trMetrics.vMax.toFixed(3)}`);

  // Live stepper over 1.2 s after settling
  const stepper = createLiveCircuitStepper({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: testCatalog,
    simConfig
  });
  const outStripId = bb.getHole('ELV_1A').stripId;
  let outNet = null;
  for (const [netId, net] of conn.nets.entries()) {
    if (net.strips.has(outStripId)) {
      outNet = netId;
      break;
    }
  }
  assert.ok(outNet);

  // Settle for 0.833 s (1 beat) then measure second beat
  for (let t = 0.005; t <= 0.833; t += 0.005) {
    stepper.stepToTime(t);
  }
  const secondBeatSamples = [];
  for (let t = 0.838; t <= 1.671; t += 0.005) {
    const snap = stepper.stepToTime(t);
    secondBeatSamples.push(snap.nodeVoltages.get(outNet));
  }
  const stepMetrics = computeWaveformMetrics(Float64Array.from(secondBeatSamples), 0.005);
  assertApprox(stepMetrics.vAvg, 0.0, 0.05, 'HPF stepper DC mean blocked near 0 V');
  assert.ok(stepMetrics.vMax > 0.55, `HPF stepper QRS R-peak passed cleanly (> 0.55 V), got ${stepMetrics.vMax.toFixed(3)}`);

  // Verify syncArduinoPinStates preserves capacitor state and updates Nano pin sources cleanly
  stepper.syncArduinoPinStates({ D13: { mode: 'OUTPUT', voltage: 5.0 } });
  const postSync = stepper.stepToTime(1.676);
  assert.equal(postSync.powered, true);
  assert.ok(Number.isFinite(postSync.nodeVoltages.get(outNet)));
});

test('9. ekg-hum60 through 15.9 Hz RC LPF (10 kΩ + 1 uF) attenuates 60 Hz hum >= 3x while preserving QRS', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const testCatalog = new Map(CATALOG);
  testCatalog.set('cap-1u', { ...CATALOG.get('cap-10uf'), id: 'cap-1u', value: 1e-6 });

  const placedParts = [
    { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'c1', partId: 'cap-1u', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_ao0', holeA: 'ELV_31A', holeB: 'e10', colorName: 'Orange' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd14', colorName: 'Green' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, testCatalog);
  assert.deepEqual(conn.warnings, []);

  const simConfig = {
    powered: true,
    arb: {
      running: true,
      updateRateHz: 1000,
      ao0: { enabled: true, waveformId: 'ekg-hum60', gain: 1.0, offsetV: 0.0 }
    }
  };

  const tr = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: testCatalog,
    simConfig,
    totalDurationSec: 0.9,
    numSamples: 900
  });
  const ao0 = tr.getChannelTrace({ type: 'AO0' });
  const ai0 = tr.getChannelTrace({ type: 'AI0' });
  assert.equal(ao0.valid, true);
  assert.equal(ai0.valid, true);

  const windowStats = (samples, times, tMin, tMax) => {
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= tMin && times[i] <= tMax) {
        if (samples[i] < minV) minV = samples[i];
        if (samples[i] > maxV) maxV = samples[i];
      }
    }
    return { minV, maxV, vpp: maxV - minV };
  };

  // Quiet diastolic baseline region [0.65, 0.80] s: 60 Hz hum should be attenuated >= 3x
  const inBase = windowStats(ao0.samples, tr.times, 0.65, 0.80);
  const outBase = windowStats(ai0.samples, tr.times, 0.65, 0.80);
  const humAttenuation = inBase.vpp / Math.max(1e-6, outBase.vpp);
  assert.ok(
    humAttenuation >= 3.0,
    `Expected >= 3x 60 Hz hum attenuation at fc=15.9 Hz, got ${humAttenuation.toFixed(2)}x (in=${inBase.vpp.toFixed(3)}, out=${outBase.vpp.toFixed(3)})`
  );

  // QRS R-peak region [0.24, 0.36] s: peak clearly exceeds filtered baseline ripple
  const outQrs = windowStats(ai0.samples, tr.times, 0.24, 0.36);
  assert.ok(
    outQrs.maxV > outBase.maxV * 3.0 && outQrs.maxV > 0.35,
    `Expected QRS complex clearly distinguishable above hum: qrsMax=${outQrs.maxV.toFixed(3)}, baseMax=${outBase.maxV.toFixed(3)}`
  );
});
