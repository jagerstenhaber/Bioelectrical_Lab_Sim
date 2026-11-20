import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import {
  DEFAULT_FGEN_CONFIG,
  createDefaultFgenConfig,
  evaluateWaveform,
  getWaveformDcMean,
  computeWaveformMetrics,
  findTriggerIndex
} from '../js/sim/linearAlgebra.js';
import { solveDcCircuit } from '../js/sim/dcSolver.js';
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

test('1. Waveform evaluation, computeWaveformMetrics, and findTriggerIndex', () => {
  assert.equal(DEFAULT_FGEN_CONFIG.waveform, 'sine');
  const cfg = createDefaultFgenConfig({ waveform: 'square', dutyCycle: 25, amplitudeVpp: 4.0, dcOffsetV: 1.0 });
  assert.equal(cfg.dutyCycle, 25);

  // Sine waveform at quarter periods
  const sine = { waveform: 'sine', frequencyHz: 100, amplitudeVpp: 2.0, dcOffsetV: 0.5 };
  assertApprox(evaluateWaveform(sine, 0), 0.5, 1e-9, 'sine t=0');
  assertApprox(evaluateWaveform(sine, 0.0025), 1.5, 1e-9, 'sine peak');
  assertApprox(evaluateWaveform(sine, 0.0075), -0.5, 1e-9, 'sine trough');

  // Triangle waveform at quarter periods
  const tri = { waveform: 'triangle', frequencyHz: 100, amplitudeVpp: 4.0, dcOffsetV: 0.0 };
  assertApprox(evaluateWaveform(tri, 0), 0.0, 1e-9, 'tri t=0');
  assertApprox(evaluateWaveform(tri, 0.0025), 2.0, 1e-9, 'tri peak');
  assertApprox(evaluateWaveform(tri, 0.005), 0.0, 1e-6, 'tri mid');
  assertApprox(evaluateWaveform(tri, 0.0075), -2.0, 1e-9, 'tri trough');

  // Square waveform with 25% duty cycle
  const sq = { waveform: 'square', frequencyHz: 100, amplitudeVpp: 2.0, dcOffsetV: 1.0, dutyCycle: 25 };
  assertApprox(evaluateWaveform(sq, 0.001), 2.0, 1e-9, 'square high (<25%)');
  assertApprox(evaluateWaveform(sq, 0.003), 0.0, 1e-9, 'square low (>25%)');
  assertApprox(evaluateWaveform(sq, 0.009), 0.0, 1e-9, 'square low (90%)');

  // Metrics on a 500 Hz, 2 Vpp sine on +2.5 V DC offset over 5 periods (2000 samples)
  const numSamples = 2000;
  const duration = 5 / 500;
  const dt = duration / (numSamples - 1);
  const samples = new Float64Array(numSamples);
  const fgenTest = { waveform: 'sine', frequencyHz: 500, amplitudeVpp: 2.0, dcOffsetV: 2.5 };
  for (let i = 0; i < numSamples; i++) {
    samples[i] = evaluateWaveform(fgenTest, i * dt);
  }
  const metrics = computeWaveformMetrics(samples, dt);
  assertApprox(metrics.vMin, 1.5, 0.01, 'metrics vMin');
  assertApprox(metrics.vMax, 3.5, 0.01, 'metrics vMax');
  assertApprox(metrics.vpp, 2.0, 0.01, 'metrics vpp');
  assertApprox(metrics.vAvg, 2.5, 0.01, 'metrics vAvg');
  assertApprox(metrics.vRmsAc, 1 / Math.sqrt(2), 0.01, 'metrics vRmsAc');
  assertApprox(metrics.vRms, Math.sqrt(2.5 * 2.5 + 0.5), 0.01, 'metrics vRms');
  assertApprox(metrics.freqHz, 500, 1.0, 'metrics freqHz');

  // DC flat signal should return freqHz = null
  const dcSamples = new Float64Array(100).fill(3.3);
  assert.equal(computeWaveformMetrics(dcSamples, 1e-4).freqHz, null);

  // Trigger search: rising & falling crossings around 2.5 V
  const trigRise = findTriggerIndex(samples, { level: 2.5, slope: 'rising' });
  const trigFall = findTriggerIndex(samples, { level: 2.5, slope: 'falling' });
  assert.ok(trigRise > 0, 'rising trigger found');
  assert.ok(trigFall > 0, 'falling trigger found');
  assert.ok(samples[trigRise] >= 2.5 && samples[trigRise - 1] < 2.5, 'rising trigger edge');
  assert.ok(samples[trigFall] <= 2.5 && samples[trigFall - 1] > 2.5, 'falling trigger edge');
  assert.equal(findTriggerIndex(samples, { level: 10.0, slope: 'rising' }), -1);
});

test('2. RC Low-Pass Filter (1 kΩ + 100 nF, fc = 1591.5 Hz) frequency roll-off', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // FGEN (ELV_33A) -> 1k (a10..a14) -> Vout (strip 14) -> 100nF (b14..b18) -> GND (ELV_49A)
  const placedParts = [
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const runAtFreq = (frequencyHz) => {
    const duration = 3 / frequencyHz;
    const sim = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: {
        powered: true,
        fgen: {
          enabled: true,
          waveform: 'sine',
          frequencyHz,
          amplitudeVpp: 2.0,
          dcOffsetV: 0.0
        }
      },
      totalDurationSec: duration,
      numSamples: 400,
      warmupCycles: 3,
      probeHoles: ['c14']
    });
    const inTrace = sim.getChannelTrace({ type: 'FGEN' });
    const outTrace = sim.getHoleTrace('c14');
    assert.equal(inTrace.valid, true);
    assert.equal(outTrace.valid, true);
    const inM = computeWaveformMetrics(inTrace.samples, sim.dt);
    const outM = computeWaveformMetrics(outTrace.samples, sim.dt);
    return outM.vpp / inM.vpp;
  };

  const ratioLow = runAtFreq(100);
  const ratioCutoff = runAtFreq(1592);
  const ratioHigh = runAtFreq(16000);

  assert.ok(ratioLow > 0.96, `100 Hz passband ratio expected > 0.96, got ${ratioLow}`);
  assertApprox(ratioCutoff, 0.707, 0.04, '1592 Hz -3dB cutoff ratio');
  assert.ok(ratioHigh < 0.14, `16 kHz stopband ratio expected < 0.14, got ${ratioHigh}`);
});

test('3. RC High-Pass Filter (100 nF + 1 kΩ) blocks +2.5 V DC offset and passes 10 kHz AC', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // FGEN (ELV_33A) -> 100nF (a10..a14) -> Vout (strip 14) -> 1k (b14..b18) -> GND (ELV_49A)
  const placedParts = [
    { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  // Also check DC solver stamps FGEN dcOffsetV = +2.5V with 50 ohm source impedance
  const dcSim = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      fgen: { enabled: true, waveform: 'sine', frequencyHz: 10000, amplitudeVpp: 2.0, dcOffsetV: 2.5 }
    }
  });
  assertApprox(dcSim.getHoleVoltage('ELV_33A'), 2.5, 0.01, 'DC solver FGEN dcOffsetV');

  const frequencyHz = 10000;
  const sim = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      fgen: {
        enabled: true,
        waveform: 'sine',
        frequencyHz,
        amplitudeVpp: 2.0,
        dcOffsetV: 2.5
      }
    },
    totalDurationSec: 3 / frequencyHz,
    numSamples: 400,
    warmupCycles: 4,
    probeHoles: ['c14']
  });

  const outTrace = sim.getHoleTrace('c14');
  assert.equal(outTrace.valid, true);
  const metrics = computeWaveformMetrics(outTrace.samples, sim.dt);
  assert.ok(Math.abs(metrics.vAvg) < 0.1, `Expected DC offset blocked (|vAvg| < 0.1), got ${metrics.vAvg}`);
  assert.ok(metrics.vpp > 1.85, `Expected 10 kHz AC passed (vpp > 1.85), got ${metrics.vpp}`);
});

test('4. Half-Wave Diode Rectifier (FGEN 4 Vpp 200 Hz sine -> 1N4007 -> 1 kΩ -> GND)', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    { id: 'd1', partId: 'diode-1n4007', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const frequencyHz = 200;
  const sim = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      fgen: {
        enabled: true,
        waveform: 'sine',
        frequencyHz,
        amplitudeVpp: 4.0,
        dcOffsetV: 0.0
      }
    },
    totalDurationSec: 2 / frequencyHz,
    numSamples: 400,
    warmupCycles: 1,
    probeHoles: ['c14']
  });

  const outTrace = sim.getHoleTrace('c14');
  assert.equal(outTrace.valid, true);
  const metrics = computeWaveformMetrics(outTrace.samples, sim.dt);
  // With 2V peak and 50 ohm FGEN + 2 ohm diode + 0.68 Vf into 1k: Vpeak ≈ (2 - 0.68) * 1000 / 1052 ≈ 1.255V
  assertApprox(metrics.vMax, 1.32, 0.15, 'half-wave positive peak');
  assert.ok(metrics.vMin >= -0.05, `negative cycle should clip near 0V (>= -0.05), got ${metrics.vMin}`);
});

test('5. Dual Op-Amp Non-Inverting Amplifier (G=11) & ±15V Rail Clipping', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // Op-amp at e20 (rot=90): VCC=e20, OUT1=f20, IN1-=f21, IN1+=f22, GND=f23
  const placedParts = [
    { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
    { id: 'rf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'g20', P2: 'g21' } },
    { id: 'rg', partId: 'resistor-1k-1pct', pinHoles: { P1: 'h21', P2: 'h30' } }
  ];
  const wires = [
    { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' },
    { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' },
    { id: 'w_gnd', holeA: 'ELV_49A', holeB: 'j30', colorName: 'Black' },
    { id: 'w_vin', holeA: 'ELV_33A', holeB: 'j22', colorName: 'Yellow' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  // 5a. Linear region: 1.0 Vpp -> 11.0 Vpp
  {
    const sim = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: {
        powered: true,
        fgen: { enabled: true, waveform: 'sine', frequencyHz: 100, amplitudeVpp: 1.0, dcOffsetV: 0.0 }
      },
      totalDurationSec: 0.02,
      numSamples: 400,
      warmupCycles: 1,
      probeHoles: ['j20']
    });
    const outM = computeWaveformMetrics(sim.getHoleTrace('j20').samples, sim.dt);
    assertApprox(outM.vpp, 11.0, 0.4, 'non-inverting G=11 Vpp');
  }

  // 5b. Rail clipping: 4.0 Vpp -> 44 Vpp ideal, clipped to ±14.5 V (or Vss+0.05..Vcc-0.5)
  {
    const sim = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: {
        powered: true,
        fgen: { enabled: true, waveform: 'sine', frequencyHz: 100, amplitudeVpp: 4.0, dcOffsetV: 0.0 }
      },
      totalDurationSec: 0.02,
      numSamples: 400,
      warmupCycles: 1,
      probeHoles: ['j20']
    });
    const outM = computeWaveformMetrics(sim.getHoleTrace('j20').samples, sim.dt);
    assertApprox(outM.vpp, 29.0, 0.6, 'rail-clipped Vpp');
    assert.ok(outM.vMax <= 14.6, `expected vMax <= 14.6, got ${outM.vMax}`);
    assert.ok(outM.vMin >= -15.05, `expected vMin >= -15.05, got ${outM.vMin}`);
  }
});

test('6. Channel source resolution (AI0 diff vs single-ended fallback, FGEN, PROBE, unwired AI0) & performance', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const baseWires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];

  // 6a. Unwired AI 0 -> valid: false with helpful reason
  {
    const conn = analyzeCircuit(bb, placedParts, baseWires, CATALOG);
    const sim = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires: baseWires,
      catalogMap: CATALOG,
      simConfig: { powered: true, fgen: { enabled: true, frequencyHz: 500, amplitudeVpp: 2.0 } },
      totalDurationSec: 0.004,
      numSamples: 400
    });
    const ai0 = sim.getChannelTrace({ type: 'AI0' });
    assert.equal(ai0.valid, false);
    assert.match(ai0.reason, /AI 0\+/);

    // PROBE source works directly
    const probe = sim.getChannelTrace({ type: 'PROBE', holeId: 'c14' });
    assert.equal(probe.valid, true);
    assert.equal(probe.samples.length, 400);

    // Floating hole PROBE gives valid: false
    const floatingProbe = sim.getChannelTrace({ type: 'PROBE', holeId: 'a55' });
    assert.equal(floatingProbe.valid, false);
  }

  // 6b. AI 0+ wired without AI 0- -> single-ended fallback
  {
    const wires = [...baseWires, { id: 'w_ai0p', holeA: 'ELV_1A', holeB: 'c14', colorName: 'Blue' }];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    const sim = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: { powered: true, fgen: { enabled: true, frequencyHz: 500, amplitudeVpp: 2.0 } },
      totalDurationSec: 0.004,
      numSamples: 400
    });
    const ai0 = sim.getChannelTrace({ type: 'AI0' });
    assert.equal(ai0.valid, true);
    assert.equal(ai0.singleEndedFallback, true);
    const m = computeWaveformMetrics(ai0.samples, sim.dt);
    assert.ok(m.vpp > 1.7);
  }

  // 6c. AI 0+ and AI 0- both wired -> differential measurement (across resistor R1: input - output)
  {
    const wires = [
      ...baseWires,
      { id: 'w_ai0p', holeA: 'ELV_1A', holeB: 'c10', colorName: 'Blue' },
      { id: 'w_ai0n', holeA: 'ELV_2A', holeB: 'c14', colorName: 'Green' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

    const tStart = performance.now();
    const sim = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: { powered: true, fgen: { enabled: true, frequencyHz: 1592, amplitudeVpp: 2.0 } },
      totalDurationSec: 0.002,
      numSamples: 400
    });
    const elapsedMs = performance.now() - tStart;

    const ai0 = sim.getChannelTrace({ type: 'AI0' });
    assert.equal(ai0.valid, true);
    assert.equal(ai0.singleEndedFallback, false);
    const diffM = computeWaveformMetrics(ai0.samples, sim.dt);
    // Across R at cutoff fc: |Vr| / |Vin| ≈ 0.707 -> ~1.41 Vpp
    assertApprox(diffM.vpp, 1.414, 0.12, 'differential AI0 across R at fc');
    assert.ok(elapsedMs < 150, `Expected 400-sample transient solve < 150 ms, took ${elapsedMs.toFixed(1)} ms`);
  }
});

test('7. RC Low-Pass Filter maintains accurate -3 dB attenuation at coarse 40 ms window (2 ms/div, 600 samples) via sub-stepping', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const sim = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      fgen: {
        enabled: true,
        waveform: 'sine',
        frequencyHz: 1592,
        amplitudeVpp: 4.0,
        dcOffsetV: 0.0
      }
    },
    totalDurationSec: 0.04,
    numSamples: 600,
    warmupCycles: 3,
    probeHoles: ['c14']
  });

  const inTrace = sim.getChannelTrace({ type: 'FGEN' });
  const outTrace = sim.getHoleTrace('c14');
  assert.equal(inTrace.valid, true);
  assert.equal(outTrace.valid, true);

  const inM = computeWaveformMetrics(inTrace.samples, sim.dt);
  const outM = computeWaveformMetrics(outTrace.samples, sim.dt);
  assertApprox(outM.vpp / inM.vpp, 0.707, 0.05, '40ms coarse window -3dB ratio');
});

test('8. getWaveformDcMean computes accurate DC mean for asymmetric square wave (dutyCycle = 75%)', () => {
  const fgen = createDefaultFgenConfig({
    enabled: true,
    waveform: 'square',
    frequencyHz: 1000,
    amplitudeVpp: 4.0,
    dcOffsetV: 1.0,
    dutyCycle: 75
  });
  // High (75%): 1.0 + 2.0 = +3.0 V; Low (25%): 1.0 - 2.0 = -1.0 V -> mean = 0.75*3 + 0.25*(-1) = +2.0 V
  assertApprox(getWaveformDcMean(fgen), 2.0, 1e-9, '75% duty square DC mean');

  // Verify symmetric sine/triangle/50%-square keep dcOffsetV
  assertApprox(getWaveformDcMean({ waveform: 'sine', amplitudeVpp: 4.0, dcOffsetV: 1.25 }), 1.25, 1e-9);
  assertApprox(getWaveformDcMean({ waveform: 'triangle', amplitudeVpp: 4.0, dcOffsetV: -0.75 }), -0.75, 1e-9);
  assertApprox(
    getWaveformDcMean({ waveform: 'square', amplitudeVpp: 4.0, dcOffsetV: 1.0, dutyCycle: 50 }),
    1.0,
    1e-9
  );
});

test('9. Asymmetric square wave (4 Vpp, 0 V offset, 75% duty) RC LPF settles around +1.0 V DC mean (no double shift)', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // FGEN (ELV_33A) -> 10k (a10..a14) -> Vout (strip 14) -> 10uF (b14..b18) -> GND (ELV_49A)
  // fc = 1 / (2*pi*10k*10uF) ≈ 1.59 Hz; at f = 500 Hz the LPF strongly averages to true DC mean (+1.0 V)
  const placedParts = [
    { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
    { id: 'c1', partId: 'cap-10uf', pinHoles: { P1: 'b14', P2: 'b18' } }
  ];
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
    { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const frequencyHz = 500;
  const sim = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      fgen: {
        enabled: true,
        waveform: 'square',
        frequencyHz,
        amplitudeVpp: 4.0,
        dcOffsetV: 0.0,
        dutyCycle: 75
      }
    },
    totalDurationSec: 3 / frequencyHz,
    numSamples: 400,
    warmupCycles: 2,
    probeHoles: ['c14']
  });

  const outTrace = sim.getHoleTrace('c14');
  assert.equal(outTrace.valid, true);
  const metrics = computeWaveformMetrics(outTrace.samples, sim.dt);
  // True DC mean = 0.75*(+2.0) + 0.25*(-2.0) = +1.0 V (NOT +2.0 V)
  assertApprox(metrics.vAvg, 1.0, 0.15, '75% duty square RC LPF DC mean');
});


