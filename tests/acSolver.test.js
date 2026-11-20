import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import {
  DEFAULT_BODE_CONFIG,
  createDefaultBodeConfig,
  findCutoffFrequencies,
  solveBodeSweep
} from '../js/sim/acSolver.js';

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

/**
 * Helper to log-interpolate magnitude/phase at an arbitrary frequency from sweep arrays.
 */
function interpolateAtFreq(freqsHz, values, targetFreqHz) {
  const logTarget = Math.log10(targetFreqHz);
  for (let i = 1; i < freqsHz.length; i++) {
    const f0 = freqsHz[i - 1];
    const f1 = freqsHz[i];
    if (targetFreqHz >= f0 && targetFreqHz <= f1) {
      const t = (logTarget - Math.log10(f0)) / (Math.log10(f1) - Math.log10(f0));
      return values[i - 1] + t * (values[i] - values[i - 1]);
    }
  }
  return null;
}

test('Helper APIs: DEFAULT_BODE_CONFIG, createDefaultBodeConfig, findCutoffFrequencies', () => {
  assert.equal(DEFAULT_BODE_CONFIG.startFreqHz, 10);
  assert.equal(DEFAULT_BODE_CONFIG.stopFreqHz, 100000);
  assert.equal(DEFAULT_BODE_CONFIG.stepsPerDecade, 20);
  assert.equal(DEFAULT_BODE_CONFIG.inputSource, 'AI0');
  assert.equal(DEFAULT_BODE_CONFIG.outputSource, 'AI1');

  const clamped = createDefaultBodeConfig({
    startFreqHz: 0.1,
    stopFreqHz: 5e6,
    stepsPerDecade: 100
  });
  assert.equal(clamped.startFreqHz, 1);
  assert.equal(clamped.stopFreqHz, 1e6);
  assert.equal(clamped.stepsPerDecade, 40);

  const invertedRange = createDefaultBodeConfig({
    startFreqHz: 5000,
    stopFreqHz: 1000
  });
  assert.ok(invertedRange.stopFreqHz > invertedRange.startFreqHz);

  const cutoffs = findCutoffFrequencies([10, 100, 1000, 10000], [-20, -3.0103, 0, -3.0103], 0);
  assert.equal(cutoffs.length, 2);
  assert.equal(cutoffs[0].direction, 'rising');
  assertApprox(cutoffs[0].freqHz, 100, 0.1);
  assert.equal(cutoffs[1].direction, 'falling');
  assertApprox(cutoffs[1].freqHz, 10000, 0.1);
});

test('1. RC Low-Pass Filter (1 kΩ + 100 nF, fc = 1591.5 Hz)', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // FGEN (ELV_33A) -> e10 (also AI0+ ELV_1A) -> 1k (a10..a14) -> Vout (strip 14, AI1+ ELV_3A) -> 100nF (b14..b18) -> GND (ELV_49A)
  const placedParts = [
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd10', colorName: 'Green' },
    { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'd14', colorName: 'Blue' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const res = solveBodeSweep({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    bodeConfig: {
      startFreqHz: 10,
      stopFreqHz: 100000,
      stepsPerDecade: 20,
      inputSource: 'AI0',
      outputSource: 'AI1'
    }
  });

  assert.equal(res.valid, true);
  assert.equal(res.powered, true);
  assert.equal(res.freqsHz.length, 81);
  assertApprox(res.passbandGainDb, 0, 0.1, 'RC LPF passbandGainDb');

  const falling = res.cutoffs.find((c) => c.direction === 'falling');
  assert.ok(falling, 'expected falling -3dB cutoff');
  assertApprox(falling.freqHz, 1591.55, 25, 'RC LPF -3dB cutoff');

  const gain15k9 = interpolateAtFreq(res.freqsHz, res.magDb, 15915.5);
  assertApprox(gain15k9, -20.0, 0.6, 'RC LPF gain at 10*fc (~15.9 kHz)');

  const phaseAtFc = interpolateAtFreq(res.freqsHz, res.phaseDeg, 1591.55);
  assertApprox(phaseAtFc, -45.0, 3.0, 'RC LPF phase at fc');
});

test('2. RC High-Pass Filter (100 nF + 1 kΩ, fc = 1591.5 Hz)', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // FGEN (ELV_33A) -> e10 (AI0+) -> 100nF (a10..a14) -> Vout (strip 14, AI1+) -> 1k (b14..b18) -> GND (ELV_49A)
  const placedParts = [
    { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd10', colorName: 'Green' },
    { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'd14', colorName: 'Blue' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const res = solveBodeSweep({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    bodeConfig: {
      startFreqHz: 10,
      stopFreqHz: 100000,
      stepsPerDecade: 20,
      inputSource: 'AI0',
      outputSource: 'AI1'
    }
  });

  assert.equal(res.valid, true);
  assertApprox(res.passbandGainDb, 0, 0.1, 'RC HPF passbandGainDb');

  const rising = res.cutoffs.find((c) => c.direction === 'rising');
  assert.ok(rising, 'expected rising -3dB cutoff');
  assertApprox(rising.freqHz, 1591.55, 25, 'RC HPF -3dB cutoff');

  const phaseAtFc = interpolateAtFreq(res.freqsHz, res.phaseDeg, 1591.55);
  assertApprox(phaseAtFc, 45.0, 3.0, 'RC HPF phase at fc');
});

test('3. Inverting Op-Amp (1 kΩ in, 10 kΩ feedback, ±15 V rails) gives flat +20 dB and |phase| ≈ 180°', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // Op-amp at e20 (rotation 90):
  //   VCC -> e20, OUT1 -> f20, IN1- -> f21, IN1+ -> f22, GND (V-) -> f23
  const placedParts = [
    { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
    { id: 'rin', partId: 'resistor-1k-1pct', pinHoles: { P1: 'g15', P2: 'g21' } },
    { id: 'rf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'h21', P2: 'h20' } }
  ];
  const wires = [
    { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' },   // +15V -> VCC
    { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' },  // -15V -> GND (V-)
    { id: 'w_inp', holeA: 'ELV_49A', holeB: 'j22', colorName: 'Black' }, // GND -> IN1+
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'j15', colorName: 'Yellow' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'i15', colorName: 'Green' },
    { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'j20', colorName: 'Blue' }
  ];

  const res = solveBodeSweep({
    breadboard: bb,
    placedParts,
    wires,
    catalogMap: CATALOG,
    bodeConfig: {
      startFreqHz: 10,
      stopFreqHz: 10000,
      stepsPerDecade: 20,
      inputSource: 'AI0',
      outputSource: 'AI1'
    }
  });

  assert.equal(res.valid, true);
  assert.equal(res.cutoffs.length, 0, 'pure resistive inverting amp has no cutoff');
  for (let i = 0; i < res.freqsHz.length; i++) {
    assertApprox(res.magDb[i], 20.0, 0.2, `inverting amp gain at ${res.freqsHz[i].toFixed(1)} Hz`);
    assertApprox(
      Math.abs(res.phaseDeg[i]),
      180.0,
      2.0,
      `inverting amp |phase| at ${res.freqsHz[i].toFixed(1)} Hz`
    );
  }
});

test('4. Active Inverting RC Low-Pass Filter (1 kΩ in, 10 kΩ || 100 nF feedback -> 20 dB DC gain, fc = 159.15 Hz)', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
    { id: 'rin', partId: 'resistor-1k-1pct', pinHoles: { P1: 'g15', P2: 'g21' } },
    { id: 'rf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'h21', P2: 'h20' } },
    { id: 'cf', partId: 'cap-100nf', pinHoles: { P1: 'i21', P2: 'i20' } }
  ];
  const wires = [
    { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' },
    { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' },
    { id: 'w_inp', holeA: 'ELV_49A', holeB: 'j22', colorName: 'Black' },
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'j15', colorName: 'Yellow' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'i15', colorName: 'Green' },
    { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'j20', colorName: 'Blue' }
  ];

  const res = solveBodeSweep({
    breadboard: bb,
    placedParts,
    wires,
    catalogMap: CATALOG,
    bodeConfig: {
      startFreqHz: 1,
      stopFreqHz: 10000,
      stepsPerDecade: 20,
      inputSource: 'AI0',
      outputSource: 'AI1'
    }
  });

  assert.equal(res.valid, true);
  assertApprox(res.passbandGainDb, 20.0, 0.2, 'Active LPF passband gain');

  const falling = res.cutoffs.find((c) => c.direction === 'falling');
  assert.ok(falling, 'expected falling -3dB cutoff');
  assertApprox(falling.freqHz, 159.15, 8.0, 'Active LPF -3dB cutoff');
});

test('5. Power OFF and Unwired Output return { valid: false } with student-friendly reason', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd10', colorName: 'Green' },
    { id: 'w_gnd', holeA: 'e14', holeB: 'ELV_49A', colorName: 'Black' }
    // AI1 intentionally left unwired
  ];

  // 5a. Power OFF
  const offRes = solveBodeSweep({
    breadboard: bb,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { powered: false }
  });
  assert.equal(offRes.valid, false);
  assert.equal(offRes.powered, false);
  assert.ok(typeof offRes.reason === 'string' && offRes.reason.toLowerCase().includes('power'));

  // 5b. Unwired AI1 output
  const unwiredOutRes = solveBodeSweep({
    breadboard: bb,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { powered: true },
    bodeConfig: { inputSource: 'AI0', outputSource: 'AI1' }
  });
  assert.equal(unwiredOutRes.valid, false);
  assert.equal(unwiredOutRes.powered, true);
  assert.ok(
    typeof unwiredOutRes.reason === 'string' && unwiredOutRes.reason.includes('AI 1+'),
    `expected AI 1+ mention in reason, got: ${unwiredOutRes.reason}`
  );

  // 5c. Missing FGEN stimulus
  const noFgenRes = solveBodeSweep({
    breadboard: bb,
    placedParts,
    wires: [{ id: 'w_gnd', holeA: 'e14', holeB: 'ELV_49A', colorName: 'Black' }],
    catalogMap: CATALOG,
    simConfig: { powered: true }
  });
  assert.equal(noFgenRes.valid, false);
  assert.ok(typeof noFgenRes.reason === 'string' && noFgenRes.reason.includes('FGEN'));
});

test('6. Performance check: 81-point Bode sweep completes in < 80 ms', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
    { id: 'rin', partId: 'resistor-1k-1pct', pinHoles: { P1: 'g15', P2: 'g21' } },
    { id: 'rf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'h21', P2: 'h20' } },
    { id: 'cf', partId: 'cap-100nf', pinHoles: { P1: 'i21', P2: 'i20' } }
  ];
  const wires = [
    { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' },
    { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' },
    { id: 'w_inp', holeA: 'ELV_49A', holeB: 'j22', colorName: 'Black' },
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'j15', colorName: 'Yellow' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'i15', colorName: 'Green' },
    { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'j20', colorName: 'Blue' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  // Warm up JIT once
  solveBodeSweep({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    bodeConfig: { startFreqHz: 10, stopFreqHz: 100000, stepsPerDecade: 20 }
  });

  const t0 = performance.now();
  const res = solveBodeSweep({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    bodeConfig: { startFreqHz: 10, stopFreqHz: 100000, stepsPerDecade: 20 }
  });
  const elapsedMs = performance.now() - t0;

  assert.equal(res.valid, true);
  assert.equal(res.freqsHz.length, 81);
  assert.ok(elapsedMs < 80, `81-point sweep took ${elapsedMs.toFixed(2)} ms (expected < 80 ms)`);
});

test('7. solveBodeSweep stamps EMG electrode impedances cleanly when emgMode is enabled alongside a filter', () => {
  const bb = new BreadboardModel({ elvisMode: true, emgMode: true });
  // FGEN (ELV_33A, AI0+ ELV_1A) -> 100nF (a10..a14) -> Vout (strip 14, AI1+ ELV_3A) -> EMG_RED1 (5 kΩ to EMG_BLK -> GND)
  // Also connect EMG_RED2 to strip 16 -> 1k -> GND so all EMG nodes participate in the MNA sweep cleanly
  const placedParts = [
    { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'r_load', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a16', P2: 'a18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd10', colorName: 'Green' },
    { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'd14', colorName: 'Blue' },
    { id: 'w_emg_r1', holeA: 'EMG_RED1_A', holeB: 'e14', colorName: 'Red' },
    { id: 'w_emg_r2', holeA: 'EMG_RED2_A', holeB: 'e16', colorName: 'Red' },
    { id: 'w_emg_blk', holeA: 'EMG_BLK_A', holeB: 'ELV_49A', colorName: 'Black' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49B', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const res = solveBodeSweep({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      emg: { flexEffort: 0.5, burstMode: 'continuous', humMvpp: 0, electrodeMismatch: 0.05 }
    },
    bodeConfig: {
      startFreqHz: 10,
      stopFreqHz: 100000,
      stepsPerDecade: 20,
      inputSource: 'AI0',
      outputSource: 'AI1'
    }
  });

  assert.equal(res.valid, true, `Expected valid Bode sweep with emgMode, got reason: ${res.reason}`);
  assert.equal(res.freqsHz.length, 81);
  assertApprox(res.passbandGainDb, 0, 0.2, 'EMG HPF passbandGainDb');

  // fc = 1 / (2 * pi * 5000 Ω * 100 nF) ≈ 318.31 Hz (since EMG_RED1 impedance is 5 kΩ to BLK/GND)
  const rising = res.cutoffs.find((c) => c.direction === 'rising');
  assert.ok(rising, 'expected rising -3dB cutoff shaped by 5 kΩ EMG electrode impedance');
  assertApprox(rising.freqHz, 318.31, 15, 'EMG HPF -3dB cutoff via 5 kΩ electrode impedance');
});

