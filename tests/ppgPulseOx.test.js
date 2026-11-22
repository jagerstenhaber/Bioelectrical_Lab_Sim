import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import { computeWaveformMetrics } from '../js/sim/linearAlgebra.js';
import {
  getPhotoresistorOhms,
  hasTimeVaryingStimulus,
  getSlowestStimulusFreqHz
} from '../js/sim/circuitElements.js';
import { solveDcCircuit, createDefaultSimConfig } from '../js/sim/dcSolver.js';
import { solveTransientCircuit } from '../js/sim/transientSolver.js';
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

test('1. Photoresistor manual mode remains backwards-compatible in DC and transient solves', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  for (const [lightLevel, expectedOhms] of [
    [0, 100000],
    [0.5, getPhotoresistorOhms(0.5)],
    [1, 500]
  ]) {
    const placedParts = [
      { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } },
      {
        id: 'ldr1',
        partId: 'photoresistor',
        pinHoles: { P1: 'b15', P2: 'b20' },
        props: { lightLevel, lightMode: 'manual', fingerPresent: true }
      }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w2', holeA: 'e20', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    const dc = solveDcCircuit({ breadboard: bb, connectivity: conn, placedParts, wires, catalogMap: CATALOG });
    const ldrRes = dc.partResults.get('ldr1');
    assertApprox(ldrRes.ohms, expectedOhms, 1e-3, `manual LDR light=${lightLevel}`);
    assert.equal(ldrRes.lightMode, 'manual');
    assert.equal(ldrRes.opticalLinked, false);
    assert.equal(ldrRes.pulseActive, false);

    const expectedV = 5.0 * (expectedOhms / (10000 + expectedOhms));
    assertApprox(dc.getHoleVoltage('c15'), expectedV, 0.02, `manual divider Vmid light=${lightLevel}`);

    const tr = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      totalDurationSec: 1.0,
      numSamples: 60,
      probeHoles: ['c15']
    });
    const metrics = computeWaveformMetrics(tr.getHoleTrace('c15').samples, tr.dt);
    assert.ok(metrics.vpp < 1e-6, `manual mode should have zero AC ripple, got ${metrics.vpp}`);
  }
});

test('2. Photoresistor led-ppg with NO lit LED stays dark (~75–90 kΩ) and has zero AC PPG ripple', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } },
    {
      id: 'ldr1',
      partId: 'photoresistor',
      pinHoles: { P1: 'b15', P2: 'b20' },
      props: { lightMode: 'led-ppg', fingerPresent: true, bpm: 72, perfusion: 0.8 }
    }
  ];
  const wires = [
    { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
    { id: 'w2', holeA: 'e20', holeB: 'ELV_49A', colorName: 'Black' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);

  const dc = solveDcCircuit({ breadboard: bb, connectivity: conn, placedParts, wires, catalogMap: CATALOG });
  const ldrRes = dc.partResults.get('ldr1');
  assert.ok(
    ldrRes.ohms >= 75000 && ldrRes.ohms <= 90000,
    `Expected unlit led-ppg LDR ~75–90 kΩ, got ${ldrRes.ohms.toFixed(1)} Ω`
  );
  assert.equal(ldrRes.opticalLinked, false);
  assert.equal(ldrRes.pulseActive, false);

  const dcT0 = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    timeSec: 0.15
  });
  const dcT1 = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    timeSec: 0.65
  });
  assertApprox(dcT0.getHoleVoltage('c15'), dcT1.getHoleVoltage('c15'), 1e-6, 'no lit LED timeSec DC');

  const tr = solveTransientCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    totalDurationSec: 2.0,
    numSamples: 120,
    probeHoles: ['c15']
  });
  const metrics = computeWaveformMetrics(tr.getHoleTrace('c15').samples, tr.dt);
  assert.ok(metrics.vpp < 1e-6, `Expected zero AC PPG ripple without lit LED, got ${metrics.vpp}`);
});

test('3. Photoresistor led-ppg tracks LED brightness and produces pulsatile PPG waveform in transient & timeSec DC', () => {
  const bb = new BreadboardModel({ elvisMode: true });

  const buildBoard = (ledResistorPartId) => {
    const placedParts = [
      // Lit Red LED circuit: +5V -> R_limit -> LED anode -> cathode -> GND
      { id: 'rLed', partId: ledResistorPartId, pinHoles: { P1: 'a30', P2: 'a33' } },
      { id: 'led1', partId: 'led-red', pinHoles: { P1: 'b33', P2: 'b36' } },
      // 5V -> 10k -> mid -> LDR -> GND
      { id: 'rDiv', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } },
      {
        id: 'ldr1',
        partId: 'photoresistor',
        pinHoles: { P1: 'b15', P2: 'b20' },
        props: { lightMode: 'led-ppg', fingerPresent: true, bpm: 72, perfusion: 0.8 }
      }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w2', holeA: 'e20', holeB: 'ELV_49A', colorName: 'Black' },
      { id: 'w3', holeA: 'ELV_54B', holeB: 'e30', colorName: 'Red' },
      { id: 'w4', holeA: 'e36', holeB: 'ELV_49B', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    return { placedParts, wires, conn };
  };

  // Brighter 330 Ω LED vs dimmer 4.7k/5.1k LED (using 5.1k-1pct in catalog)
  const brightBoard = buildBoard('resistor-330-1pct');
  const dimBoard = buildBoard('resistor-5.1k-1pct');

  const dcBright = solveDcCircuit({
    breadboard: bb,
    connectivity: brightBoard.conn,
    placedParts: brightBoard.placedParts,
    wires: brightBoard.wires,
    catalogMap: CATALOG
  });
  const dcDim = solveDcCircuit({
    breadboard: bb,
    connectivity: dimBoard.conn,
    placedParts: dimBoard.placedParts,
    wires: dimBoard.wires,
    catalogMap: CATALOG
  });

  const brightLdr = dcBright.partResults.get('ldr1');
  const dimLdr = dcDim.partResults.get('ldr1');
  assert.equal(brightLdr.opticalLinked, true);
  assert.equal(brightLdr.pulseActive, true);
  assert.ok(
    brightLdr.ledBrightness > dimLdr.ledBrightness,
    `Expected 330Ω LED brightness (${brightLdr.ledBrightness}) > 5.1kΩ (${dimLdr.ledBrightness})`
  );
  assert.ok(
    brightLdr.ohms < dimLdr.ohms,
    `Expected brighter LED to produce lower LDR ohms (${brightLdr.ohms}) < dimmer (${dimLdr.ohms})`
  );

  // Check pulsatile PPG waveform in solveTransientCircuit
  const tr = solveTransientCircuit({
    breadboard: bb,
    connectivity: brightBoard.conn,
    placedParts: brightBoard.placedParts,
    wires: brightBoard.wires,
    catalogMap: CATALOG,
    totalDurationSec: 2.5,
    numSamples: 250,
    probeHoles: ['c15']
  });
  const trTrace = tr.getHoleTrace('c15');
  assert.equal(trTrace.valid, true);
  const metrics = computeWaveformMetrics(trTrace.samples, tr.dt);
  assert.ok(
    metrics.vpp > 0.15,
    `Expected pulsatile PPG Vpp > 0.15 V on 5V/10k divider, got ${metrics.vpp.toFixed(4)} V`
  );

  // Check solveDcCircuit({ timeSec }) tracks the same pulsatile swing
  const dcSamples = [];
  for (let i = 0; i < 30; i++) {
    const t = (i / 30) * (60 / 72);
    const d = solveDcCircuit({
      breadboard: bb,
      connectivity: brightBoard.conn,
      placedParts: brightBoard.placedParts,
      wires: brightBoard.wires,
      catalogMap: CATALOG,
      timeSec: t
    });
    dcSamples.push(d.getHoleVoltage('c15'));
  }
  const dcVpp = Math.max(...dcSamples) - Math.min(...dcSamples);
  assert.ok(
    dcVpp > 0.15,
    `Expected solveDcCircuit({ timeSec }) Vpp > 0.15 V, got ${dcVpp.toFixed(4)} V`
  );
});

test('4. True Pulse-Ox: unpowered LEDs ~0 V, powered LEDs into Op-Amp TIA & 100k load produce +1..3.5 V + PPG pulse', () => {
  const bb = new BreadboardModel({ elvisMode: true, pulseOxMode: true });

  // 4a. Unpowered Pulse-Ox LEDs -> simple 100 kΩ load (PD_K -> +5V, PD_A -> 100k -> GND) & Op-Amp TIA
  {
    const placedParts = [
      { id: 'rLoad', partId: 'resistor-100k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } }
    ];
    const wires = [
      { id: 'w_pdk', holeA: 'POX_PD_K_A', holeB: 'ELV_54A', colorName: 'Red' }, // PD_K -> +5V
      { id: 'w_pda', holeA: 'POX_PD_A_A', holeB: 'e10', colorName: 'Blue' },
      { id: 'w_gnd', holeA: 'e15', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    const dc = solveDcCircuit({ breadboard: bb, connectivity: conn, placedParts, wires, catalogMap: CATALOG });
    assert.ok(dc.pulseOxResult);
    assertApprox(dc.pulseOxResult.redCurrentMa, 0, 1e-6);
    assertApprox(dc.pulseOxResult.irCurrentMa, 0, 1e-6);
    assert.equal(dc.pulseOxResult.redLit, false);
    assert.equal(dc.pulseOxResult.irLit, false);
    // 5V across 5MΩ PD shunt + 100kΩ load gives ~0.10 V dark leakage (no photovoltage)
    assert.ok(
      Math.abs(dc.getHoleVoltage('c10')) < 0.15,
      `Expected ~0.10 V dark shunt baseline across 100k load with unpowered LEDs, got ${dc.getHoleVoltage('c10')} V`
    );

    const trUnlit = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      totalDurationSec: 2.0,
      numSamples: 120,
      probeHoles: ['c10']
    });
    const unlitMetrics = computeWaveformMetrics(trUnlit.getHoleTrace('c10').samples, trUnlit.dt);
    assert.ok(unlitMetrics.vpp < 1e-6, `Expected zero PPG ripple with unpowered LEDs, got ${unlitMetrics.vpp}`);
  }

  // 4b. Powered Red & IR LEDs into simple 100 kΩ load (PD_K -> +5V, PD_A -> 100k -> GND)
  {
    const placedParts = [
      { id: 'rRed', partId: 'resistor-220-1pct', pinHoles: { P1: 'a5', P2: 'a8' } },
      { id: 'rIr', partId: 'resistor-220-1pct', pinHoles: { P1: 'a6', P2: 'a9' } },
      { id: 'rLoad', partId: 'resistor-100k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } }
    ];
    const wires = [
      { id: 'w_5v_red', holeA: 'ELV_54A', holeB: 'e5', colorName: 'Red' },
      { id: 'w_5v_ir', holeA: 'ELV_54B', holeB: 'e6', colorName: 'Red' },
      { id: 'w_red_a', holeA: 'e8', holeB: 'POX_RED_A_A', colorName: 'Red' },
      { id: 'w_ir_a', holeA: 'e9', holeB: 'POX_IR_A_A', colorName: 'Purple' },
      { id: 'w_led_k', holeA: 'POX_LED_K_A', holeB: 'ELV_49A', colorName: 'Black' },
      { id: 'w_pdk', holeA: 'POX_PD_K_A', holeB: 'ELV_54C', colorName: 'Yellow' }, // reverse-biased PD_K -> +5V
      { id: 'w_pda', holeA: 'POX_PD_A_A', holeB: 'e10', colorName: 'Blue' },
      { id: 'w_gnd', holeA: 'e15', holeB: 'ELV_49B', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    const dc = solveDcCircuit({ breadboard: bb, connectivity: conn, placedParts, wires, catalogMap: CATALOG });
    assert.equal(dc.pulseOxResult.redLit, true);
    assert.equal(dc.pulseOxResult.irLit, true);
    const vLoad = dc.getHoleVoltage('c10');
    assert.ok(
      vLoad >= 1.0 && vLoad <= 3.5,
      `Expected +1..3.5 V DC bias across 100k load, got ${vLoad.toFixed(3)} V`
    );

    const tr = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      totalDurationSec: 2.0,
      numSamples: 200,
      probeHoles: ['c10']
    });
    const metrics = computeWaveformMetrics(tr.getHoleTrace('c10').samples, tr.dt);
    assert.ok(metrics.vAvg >= 1.0 && metrics.vAvg <= 3.5, `load DC mean=${metrics.vAvg}`);
    assert.ok(metrics.vpp > 0.05, `Expected pulsatile PPG Vpp > 50 mV across 100k load, got ${metrics.vpp}`);
  }

  // 4c. Op-Amp Transimpedance Amplifier (100 kΩ feedback, PD_A -> GND, PD_K -> IN-, IN+ -> GND): unpowered ~0V vs powered +1..3.5V + pulse
  // Op-Amp DIP8 at e20 with rotation 90 in ELVIS mode:
  //   e20=VCC, e21=OUT2, e22=IN2-, e23=IN2+
  //   f20=OUT1, f21=IN1-, f22=IN1+, f23=GND
  {
    const placedPartsUnlit = [
      { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
      { id: 'rf', partId: 'resistor-100k-1pct', pinHoles: { P1: 'j20', P2: 'j21' } } // OUT1 -> IN1-
    ];
    const wiresUnlit = [
      { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' }, // +15V -> VCC
      { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' }, // -15V -> GND(V-)
      { id: 'w_inp', holeA: 'i22', holeB: 'ELV_49A', colorName: 'Black' }, // IN1+ -> 0V GND
      { id: 'w_pda', holeA: 'POX_PD_A_A', holeB: 'ELV_49B', colorName: 'Black' }, // PD_A -> GND
      { id: 'w_pdk', holeA: 'POX_PD_K_A', holeB: 'h21', colorName: 'Yellow' } // PD_K -> IN1-
    ];
    const connUnlit = analyzeCircuit(bb, placedPartsUnlit, wiresUnlit, CATALOG);
    const dcUnlit = solveDcCircuit({
      breadboard: bb,
      connectivity: connUnlit,
      placedParts: placedPartsUnlit,
      wires: wiresUnlit,
      catalogMap: CATALOG
    });
    assert.ok(
      Math.abs(dcUnlit.getHoleVoltage('h20')) < 0.01,
      `Expected ~0 V at TIA output with unpowered LEDs, got ${dcUnlit.getHoleVoltage('h20')} V`
    );

    const placedParts = [
      ...placedPartsUnlit,
      { id: 'rRed', partId: 'resistor-220-1pct', pinHoles: { P1: 'a5', P2: 'a8' } },
      { id: 'rIr', partId: 'resistor-220-1pct', pinHoles: { P1: 'a6', P2: 'a9' } }
    ];
    const wires = [
      ...wiresUnlit,
      { id: 'w_5v_red', holeA: 'ELV_54A', holeB: 'e5', colorName: 'Red' },
      { id: 'w_5v_ir', holeA: 'ELV_54B', holeB: 'e6', colorName: 'Red' },
      { id: 'w_red_a', holeA: 'e8', holeB: 'POX_RED_A_A', colorName: 'Red' },
      { id: 'w_ir_a', holeA: 'e9', holeB: 'POX_IR_A_A', colorName: 'Purple' },
      { id: 'w_led_k', holeA: 'POX_LED_K_A', holeB: 'ELV_49C', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    assert.deepEqual(conn.warnings, []);
    const dc = solveDcCircuit({ breadboard: bb, connectivity: conn, placedParts, wires, catalogMap: CATALOG });
    assert.equal(dc.partResults.get('op1').powered, true);
    const vOut = dc.getHoleVoltage('h20'); // OUT1
    assert.ok(
      vOut >= 1.0 && vOut <= 3.5,
      `Expected Op-Amp TIA output +1..3.5 V DC bias, got ${vOut.toFixed(3)} V`
    );

    const tr = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      totalDurationSec: 2.0,
      numSamples: 200,
      probeHoles: ['h20']
    });
    const outTrace = tr.getHoleTrace('h20');
    assert.equal(outTrace.valid, true);
    const metrics = computeWaveformMetrics(outTrace.samples, tr.dt);
    assert.ok(metrics.vAvg >= 1.0 && metrics.vAvg <= 3.5, `TIA DC mean=${metrics.vAvg}`);
    assert.ok(metrics.vpp > 0.05, `Expected TIA PPG Vpp > 50 mV, got ${metrics.vpp}`);
  }
});

test('5. Dual-wavelength SpO2 physics: lowering SpO2 from 98% to 78% increases Red/IR modulation ratio R', () => {
  const bb = new BreadboardModel({ elvisMode: true, pulseOxMode: true });

  const measureSingleLedModulation = (ledMode, spo2) => {
    const placedParts = [
      { id: 'rLed', partId: 'resistor-220-1pct', pinHoles: { P1: 'a5', P2: 'a8' } },
      { id: 'rLoad', partId: 'resistor-100k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } }
    ];
    const ledStripHole = ledMode === 'red' ? 'POX_RED_A_A' : 'POX_IR_A_A';
    const wires = [
      { id: 'w_5v', holeA: 'ELV_54A', holeB: 'e5', colorName: 'Red' },
      { id: 'w_led', holeA: 'e8', holeB: ledStripHole, colorName: 'Red' },
      { id: 'w_k', holeA: 'POX_LED_K_A', holeB: 'ELV_49A', colorName: 'Black' },
      { id: 'w_pdk', holeA: 'POX_PD_K_A', holeB: 'ELV_54B', colorName: 'Yellow' },
      { id: 'w_pda', holeA: 'POX_PD_A_A', holeB: 'e10', colorName: 'Blue' },
      { id: 'w_gnd', holeA: 'e15', holeB: 'ELV_49B', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    const tr = solveTransientCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: {
        powered: true,
        pulseOx: { fingerPresent: true, bpm: 72, spo2, perfusion: 0.7 }
      },
      totalDurationSec: 2.0,
      numSamples: 250,
      probeHoles: ['c10']
    });
    const metrics = computeWaveformMetrics(tr.getHoleTrace('c10').samples, tr.dt);
    // Subtract 5MΩ dark shunt offset (~0.098 V) to isolate the pure optical photocurrent DC bias
    const opticalDc = metrics.vAvg - (5.0 * 100e3) / (5e6 + 100e3);
    return metrics.vpp / opticalDc;
  };

  const r98 = measureSingleLedModulation('red', 98) / measureSingleLedModulation('ir', 98);
  const r78 = measureSingleLedModulation('red', 78) / measureSingleLedModulation('ir', 78);

  assert.ok(
    r78 > r98 * 1.8,
    `Expected SpO2 78% R (${r78.toFixed(3)}) to be significantly greater than SpO2 98% R (${r98.toFixed(3)})`
  );
  assertApprox(r98, (110 - 98) / 25, 0.08, 'measured Beer-Lambert R at 98% SpO2');
  assertApprox(r78, (110 - 78) / 25, 0.12, 'measured Beer-Lambert R at 78% SpO2');
});

test('6. hasTimeVaryingStimulus and getSlowestStimulusFreqHz across EMG, FGEN, PPG LDR, and Pulse-Ox', () => {
  const baseBb = new BreadboardModel();
  assert.equal(hasTimeVaryingStimulus({ breadboard: baseBb, placedParts: [], simConfig: createDefaultSimConfig() }), false);
  assert.equal(getSlowestStimulusFreqHz({ breadboard: baseBb, placedParts: [], simConfig: createDefaultSimConfig() }), null);

  // EMG only -> 20 Hz
  const emgBb = new BreadboardModel({ emgMode: true });
  assert.equal(hasTimeVaryingStimulus({ breadboard: emgBb, placedParts: [], simConfig: {} }), true);
  assert.equal(getSlowestStimulusFreqHz({ breadboard: emgBb, placedParts: [], simConfig: {} }), 20);

  // FGEN only -> fgen.frequencyHz
  assert.equal(
    hasTimeVaryingStimulus({ breadboard: baseBb, placedParts: [], simConfig: { fgen: { enabled: true, frequencyHz: 150 } } }),
    true
  );
  assert.equal(
    getSlowestStimulusFreqHz({ breadboard: baseBb, placedParts: [], simConfig: { fgen: { enabled: true, frequencyHz: 150 } } }),
    150
  );

  // PPG LDR (led-ppg + fingerPresent) with no led-red placed -> false / null
  const ppgOnlyParts = [
    { id: 'ldr1', partId: 'photoresistor', props: { lightMode: 'led-ppg', fingerPresent: true, bpm: 90 } }
  ];
  assert.equal(hasTimeVaryingStimulus({ breadboard: baseBb, placedParts: ppgOnlyParts, simConfig: {} }), false);
  assert.equal(getSlowestStimulusFreqHz({ breadboard: baseBb, placedParts: ppgOnlyParts, simConfig: {} }), null);

  // PPG LDR (led-ppg + fingerPresent) with led-red placed -> bpm / 60
  const ppgParts = [
    ...ppgOnlyParts,
    { id: 'led1', partId: 'led-red' }
  ];
  assert.equal(hasTimeVaryingStimulus({ breadboard: baseBb, placedParts: ppgParts, simConfig: {} }), true);
  assertApprox(getSlowestStimulusFreqHz({ breadboard: baseBb, placedParts: ppgParts, simConfig: {} }), 1.5, 1e-9);

  // PPG LDR without fingerPresent -> false / null
  const noFingerParts = [
    { id: 'ldr1', partId: 'photoresistor', props: { lightMode: 'led-ppg', fingerPresent: false, bpm: 90 } },
    { id: 'led1', partId: 'led-red' }
  ];
  assert.equal(hasTimeVaryingStimulus({ breadboard: baseBb, placedParts: noFingerParts, simConfig: {} }), false);
  assert.equal(getSlowestStimulusFreqHz({ breadboard: baseBb, placedParts: noFingerParts, simConfig: {} }), null);

  // Pulse-Ox with fingerPresent -> bpm / 60, without finger -> false
  const poxBb = new BreadboardModel({ pulseOxMode: true });
  assert.equal(
    hasTimeVaryingStimulus({ breadboard: poxBb, placedParts: [], simConfig: { pulseOx: { fingerPresent: true, bpm: 60 } } }),
    true
  );
  assertApprox(
    getSlowestStimulusFreqHz({ breadboard: poxBb, placedParts: [], simConfig: { pulseOx: { fingerPresent: true, bpm: 60 } } }),
    1.0,
    1e-9
  );
  assert.equal(
    hasTimeVaryingStimulus({ breadboard: poxBb, placedParts: [], simConfig: { pulseOx: { fingerPresent: false, bpm: 60 } } }),
    false
  );
  assert.equal(
    getSlowestStimulusFreqHz({ breadboard: poxBb, placedParts: [], simConfig: { pulseOx: { fingerPresent: false, bpm: 60 } } }),
    null
  );

  // Optional dcResult filtering: ignores unlit LDR and unlit Pulse-Ox, accepts active ones
  const dcUnlitPox = {
    partResults: new Map([['ldr1', { pulseActive: false }]]),
    pulseOxResult: { fingerPresent: true, redLit: false, irLit: false }
  };
  assert.equal(
    hasTimeVaryingStimulus({
      breadboard: poxBb,
      placedParts: ppgParts,
      simConfig: { pulseOx: { fingerPresent: true, bpm: 60 } },
      dcResult: dcUnlitPox
    }),
    false
  );
  assert.equal(
    getSlowestStimulusFreqHz({
      breadboard: poxBb,
      placedParts: ppgParts,
      simConfig: { pulseOx: { fingerPresent: true, bpm: 60 } },
      dcResult: dcUnlitPox
    }),
    null
  );

  const dcLitPox = {
    partResults: new Map([['ldr1', { pulseActive: true }]]),
    pulseOxResult: { fingerPresent: true, redLit: true, irLit: false }
  };
  assert.equal(
    hasTimeVaryingStimulus({
      breadboard: poxBb,
      placedParts: ppgParts,
      simConfig: { pulseOx: { fingerPresent: true, bpm: 60 } },
      dcResult: dcLitPox
    }),
    true
  );
  assertApprox(
    getSlowestStimulusFreqHz({
      breadboard: poxBb,
      placedParts: ppgParts,
      simConfig: { pulseOx: { fingerPresent: true, bpm: 60 } },
      dcResult: dcLitPox
    }),
    1.0,
    1e-9
  );

  // Combined FGEN (100 Hz) + EMG (20 Hz) + Pulse-Ox (72 BPM = 1.2 Hz) -> slowest is 1.2 Hz
  const combinedBb = new BreadboardModel({ emgMode: true, pulseOxMode: true });
  assertApprox(
    getSlowestStimulusFreqHz({
      breadboard: combinedBb,
      placedParts: ppgParts,
      simConfig: { fgen: { enabled: true, frequencyHz: 100 }, pulseOx: { fingerPresent: true, bpm: 72 } }
    }),
    1.2,
    1e-9
  );
});

test('7. solveBodeSweep handles LED-PPG photoresistor RC divider and Pulse-Ox TIA circuits cleanly', () => {
  // 7a. LED-PPG photoresistor in RC low-pass divider: FGEN -> LDR (led-ppg) -> Vout -> 100 nF -> GND
  {
    const bb = new BreadboardModel({ elvisMode: true });
    const placedParts = [
      { id: 'rLed', partId: 'resistor-330-1pct', pinHoles: { P1: 'a30', P2: 'a33' } },
      { id: 'led1', partId: 'led-red', pinHoles: { P1: 'b33', P2: 'b36' } },
      {
        id: 'ldr1',
        partId: 'photoresistor',
        pinHoles: { P1: 'a10', P2: 'a14' },
        props: { lightMode: 'led-ppg', fingerPresent: true, bpm: 72, perfusion: 0.7 }
      },
      { id: 'c1', partId: 'cap-100nf', pinHoles: { P1: 'b14', P2: 'b18' } }
    ];
    const wires = [
      { id: 'w_led_vcc', holeA: 'ELV_54A', holeB: 'e30', colorName: 'Red' },
      { id: 'w_led_gnd', holeA: 'e36', holeB: 'ELV_49A', colorName: 'Black' },
      { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'e10', colorName: 'Yellow' },
      { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'd10', colorName: 'Green' },
      { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'd14', colorName: 'Blue' },
      { id: 'w_gnd', holeA: 'e18', holeB: 'ELV_49B', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    const dcOp = solveDcCircuit({ breadboard: bb, connectivity: conn, placedParts, wires, catalogMap: CATALOG });
    const expectedFc = 1 / (2 * Math.PI * dcOp.partResults.get('ldr1').resistanceOhms * 100e-9);

    const bode = solveBodeSweep({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      bodeConfig: { startFreqHz: 10, stopFreqHz: 20000, stepsPerDecade: 20, inputSource: 'AI0', outputSource: 'AI1' }
    });
    assert.equal(bode.valid, true);
    assertApprox(bode.passbandGainDb, 0, 0.2, 'LED-PPG LDR RC passband gain');
    const falling = bode.cutoffs.find((c) => c.direction === 'falling');
    assert.ok(falling, 'expected falling -3dB cutoff on LED-PPG LDR RC filter');
    assertApprox(falling.freqHz, expectedFc, expectedFc * 0.1, 'LED-PPG LDR RC cutoff frequency');
  }

  // 7b. Pulse-Ox TIA circuit with FGEN injected into IN+ (non-inverting unity AC gain from IN+ to OUT1)
  {
    const bb = new BreadboardModel({ elvisMode: true, pulseOxMode: true });
    const placedParts = [
      { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
      { id: 'rRed', partId: 'resistor-220-1pct', pinHoles: { P1: 'a5', P2: 'a8' } },
      { id: 'rIr', partId: 'resistor-220-1pct', pinHoles: { P1: 'a6', P2: 'a9' } },
      { id: 'rf', partId: 'resistor-100k-1pct', pinHoles: { P1: 'j20', P2: 'j21' } } // OUT1 -> IN1-
    ];
    const wires = [
      { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' },
      { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' },
      { id: 'w_fgen', holeA: 'ELV_33A', holeB: 'i22', colorName: 'Yellow' }, // FGEN -> IN1+
      { id: 'w_ai0', holeA: 'ELV_1A', holeB: 'h22', colorName: 'Green' },
      { id: 'w_ai1', holeA: 'ELV_3A', holeB: 'h20', colorName: 'Blue' }, // OUT1 -> AI1+
      { id: 'w_pda', holeA: 'POX_PD_A_A', holeB: 'ELV_49B', colorName: 'Black' },
      { id: 'w_pdk', holeA: 'POX_PD_K_A', holeB: 'h21', colorName: 'Yellow' },
      { id: 'w_5v_red', holeA: 'ELV_54A', holeB: 'e5', colorName: 'Red' },
      { id: 'w_5v_ir', holeA: 'ELV_54B', holeB: 'e6', colorName: 'Red' },
      { id: 'w_red_a', holeA: 'e8', holeB: 'POX_RED_A_A', colorName: 'Red' },
      { id: 'w_ir_a', holeA: 'e9', holeB: 'POX_IR_A_A', colorName: 'Purple' },
      { id: 'w_led_k', holeA: 'POX_LED_K_A', holeB: 'ELV_49C', colorName: 'Black' }
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    const bode = solveBodeSweep({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      bodeConfig: { startFreqHz: 10, stopFreqHz: 10000, stepsPerDecade: 10, inputSource: 'AI0', outputSource: 'AI1' }
    });
    assert.equal(bode.valid, true);
    assert.ok(bode.magDb.every((m) => Number.isFinite(m)));
    assert.ok(bode.phaseDeg.every((p) => Number.isFinite(p)));
    // Non-inverting gain from IN1+ to OUT1 is 1 + Rf/R_PD_SHUNT = 1 + 100k/5M = 1.02 (~0.17 dB)
    assertApprox(bode.passbandGainDb, 20 * Math.log10(1 + 100e3 / 5e6), 0.15, 'Pulse-Ox TIA AC gain');
  }
});

