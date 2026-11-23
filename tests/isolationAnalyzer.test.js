import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import {
  ISOLATION_BARRIER_CHECKS,
  PATIENT_APPLIED_SENSOR_SPECS,
  analyzeCircuitIsolation
} from '../js/sim/isolationAnalyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = path.resolve(__dirname, '../parts');

function loadPartDef(partId) {
  const raw = fs.readFileSync(path.join(PARTS_DIR, partId, 'part.json'), 'utf8');
  return JSON.parse(raw);
}

function buildCatalogMap() {
  const map = new Map();
  for (const id of [
    'arduino-nano',
    'inamp-ad620',
    'opamp-dual-dip8',
    'resistor-100-1pct',
    'resistor-10k-1pct',
    'cap-100nf',
    'cap-10uf'
  ]) {
    map.set(id, loadPartDef(id));
  }
  // Include a synthetic 1 µF non-polarized film/ceramic capacitor for 15.9 Hz HPF verification
  map.set('cap-1uf', {
    id: 'cap-1uf',
    name: '1 µF Capacitor',
    shortLabel: '1 µF',
    category: 'Capacitors',
    value: 1e-6,
    unit: 'F',
    placement: 'two-lead',
    pins: [
      { id: 'P1', label: 'Lead 1' },
      { id: 'P2', label: 'Lead 2' }
    ]
  });
  return map;
}

const CATALOG = buildCatalogMap();

function findCheck(result, id) {
  return result.checks.find((c) => c.id === id);
}

function buildEmgNanoAd620Base({ elvisMode = false } = {}) {
  const breadboard = new BreadboardModel({
    elvisMode,
    emgMode: true,
    sensorPosition: 'right'
  });

  // Nano at d2 (rot 0 when standard, rot 90 when ELVIS):
  //   A0 = h5 (strip f5..j5), 5V = h13 (f13..j13), GND_BOT = h15 (f15..j15)
  // AD620 at e28 (rot 0 when standard, rot 90 when ELVIS):
  //   RG2 -> e28, VS+ -> e29, OUT -> e30, REF -> e31
  //   RG1 -> f28, IN- -> f29, IN+ -> f30, VS- -> f31
  const rot = elvisMode ? 90 : 0;
  const placedParts = [
    { id: 'nano1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: rot },
    { id: 'ad620', partId: 'inamp-ad620', anchorHoleId: 'e28', rotation: rot },
    { id: 'rg100', partId: 'resistor-100-1pct', pinHoles: { P1: 'a28', P2: 'j28' } }
  ];

  const wires = [
    { id: 'w_vcc', holeA: 'j13', holeB: 'BP13', colorName: 'Red' },
    { id: 'w_gnd', holeA: 'j15', holeB: 'BN15', colorName: 'Black' },
    { id: 'w_vs_pos', holeA: 'BP29', holeB: 'a29', colorName: 'Red' },
    { id: 'w_vs_neg', holeA: 'j31', holeB: 'BN31', colorName: 'Black' },
    { id: 'w_emg_p', holeA: 'EMG_RED1_A', holeB: 'g30', colorName: 'Red' },
    { id: 'w_emg_n', holeA: 'EMG_RED2_A', holeB: 'g29', colorName: 'Orange' },
    { id: 'w_emg_ref', holeA: 'EMG_BLK_A', holeB: 'BN27', colorName: 'Black' }
  ];

  return { breadboard, placedParts, wires };
}

test('Registry exports expected patient-applied sensor specs and barrier checks', () => {
  assert.ok(Array.isArray(PATIENT_APPLIED_SENSOR_SPECS));
  assert.ok(PATIENT_APPLIED_SENSOR_SPECS.some((s) => s.id === 'emg' && s.boardFlag === 'emgMode'));
  assert.equal(ISOLATION_BARRIER_CHECKS.length, 4);
  assert.deepEqual(
    ISOLATION_BARRIER_CHECKS.map((c) => c.id),
    [
      'galvanic-host-isolation',
      'secondary-highpass-blocking',
      'patient-rail-fault',
      'lead-current-limiting'
    ]
  );
});

test('1. Inactive when emgMode is false (level === inactive)', () => {
  const breadboard = new BreadboardModel({ emgMode: false });
  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts: [{ id: 'nano1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 }],
    wires: [],
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: false }
  });

  assert.equal(result.active, false);
  assert.equal(result.level, 'inactive');
  assert.equal(result.passedRequired, 0);
  assert.equal(result.totalRequired, 0);
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.offendingWireIds, []);
  assert.equal(result.detectedHpfCutoffHz, null);
});

test('2. EMG + Nano without ADuM3160 and without HPF returns hazard', () => {
  const { breadboard, placedParts, wires } = buildEmgNanoAd620Base();
  // Direct DC wire from AD620 OUT (b30) to Nano A0 (j5)
  wires.push({ id: 'w_out_a0', holeA: 'b30', holeB: 'j5', colorName: 'Green' });

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: false }
  });

  assert.equal(result.active, true);
  assert.equal(result.level, 'hazard');
  assert.equal(result.hasUsbIsolator, false);
  assert.equal(findCheck(result, 'galvanic-host-isolation').status, 'fail');
  assert.equal(findCheck(result, 'secondary-highpass-blocking').status, 'fail');
  assert.equal(findCheck(result, 'patient-rail-fault').status, 'pass');
  assert.equal(result.passedRequired, 1);
  assert.equal(result.totalRequired, 3);
});

test('3. EMG + Nano + ADuM3160 only (no HPF) returns partial', () => {
  const { breadboard, placedParts, wires } = buildEmgNanoAd620Base();
  wires.push({ id: 'w_out_a0', holeA: 'b30', holeB: 'j5', colorName: 'Green' });

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: true }
  });

  assert.equal(result.active, true);
  assert.equal(result.level, 'partial');
  assert.equal(result.hasUsbIsolator, true);
  assert.equal(findCheck(result, 'galvanic-host-isolation').status, 'pass');
  assert.equal(findCheck(result, 'secondary-highpass-blocking').status, 'fail');
  assert.equal(findCheck(result, 'patient-rail-fault').status, 'pass');
  assert.equal(result.passedRequired, 2);
});

test('4. EMG + Nano + post-AD620 1 uF + 10 kOhm HPF only (no ADuM3160) returns partial with fc ~ 15.9 Hz', () => {
  const { breadboard, placedParts, wires } = buildEmgNanoAd620Base();

  // Series 1 uF cap from AD620 OUT (c30) to strip 35 (c35), 10 kOhm to GND (d35 -> BN35 via wire), and a35 -> A0 (j5)
  placedParts.push(
    { id: 'c_hpf', partId: 'cap-1uf', pinHoles: { P1: 'c30', P2: 'c35' } },
    { id: 'r_hpf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'd35', P2: 'd39' } }
  );
  wires.push(
    { id: 'w_hpf_gnd', holeA: 'e39', holeB: 'BN39', colorName: 'Black' },
    { id: 'w_out_a0', holeA: 'a35', holeB: 'j5', colorName: 'Green' }
  );

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: false }
  });

  assert.equal(result.level, 'partial');
  assert.equal(findCheck(result, 'galvanic-host-isolation').status, 'fail');
  assert.equal(findCheck(result, 'secondary-highpass-blocking').status, 'pass');
  assert.ok(result.detectedHpfCutoffHz !== null);
  assert.ok(
    Math.abs(result.detectedHpfCutoffHz - 15.915) <= 0.5,
    `Expected fc ≈ 15.9 Hz, got ${result.detectedHpfCutoffHz}`
  );
});

test('5. EMG + Nano + ADuM3160 + post-AD620 1 uF + 10 kOhm HPF returns safe (including virtual-ground 10k || 10k = 5k -> fc ~ 31.8 Hz)', () => {
  // Part A: Single 10 kOhm shunt to GND -> fc ≈ 15.9 Hz
  {
    const { breadboard, placedParts, wires } = buildEmgNanoAd620Base();
    placedParts.push(
      { id: 'c_hpf', partId: 'cap-1uf', pinHoles: { P1: 'c30', P2: 'c35' } },
      { id: 'r_hpf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'd35', P2: 'd39' } }
    );
    wires.push(
      { id: 'w_hpf_gnd', holeA: 'e39', holeB: 'BN39', colorName: 'Black' },
      { id: 'w_out_a0', holeA: 'a35', holeB: 'j5', colorName: 'Green' }
    );

    const result = analyzeCircuitIsolation({
      breadboard,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: { usbIsolatorEnabled: true }
    });

    assert.equal(result.level, 'safe');
    assert.equal(result.passedRequired, 3);
    assert.equal(result.totalRequired, 3);
    assert.ok(Math.abs(result.detectedHpfCutoffHz - 15.915) <= 0.5);
  }

  // Part B: Virtual-ground divider bias (10 kOhm to 5V + 10 kOhm to GND => R_eq = 5 kOhm => fc ≈ 31.83 Hz)
  {
    const { breadboard, placedParts, wires } = buildEmgNanoAd620Base();
    placedParts.push(
      { id: 'c_hpf', partId: 'cap-1uf', pinHoles: { P1: 'c30', P2: 'c35' } },
      { id: 'r_top', partId: 'resistor-10k-1pct', pinHoles: { P1: 'd35', P2: 'd39' } },
      { id: 'r_bot', partId: 'resistor-10k-1pct', pinHoles: { P1: 'e35', P2: 'e43' } }
    );
    wires.push(
      { id: 'w_bias_5v', holeA: 'a39', holeB: 'BP39', colorName: 'Red' },
      { id: 'w_bias_gnd', holeA: 'a43', holeB: 'BN43', colorName: 'Black' },
      { id: 'w_out_a0', holeA: 'a35', holeB: 'j5', colorName: 'Green' }
    );

    const result = analyzeCircuitIsolation({
      breadboard,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: { usbIsolatorEnabled: true }
    });

    assert.equal(result.level, 'safe');
    assert.equal(findCheck(result, 'secondary-highpass-blocking').status, 'pass');
    assert.ok(
      Math.abs(result.detectedHpfCutoffHz - 31.831) <= 0.5,
      `Expected fc ≈ 31.8 Hz for 10k || 10k, got ${result.detectedHpfCutoffHz}`
    );
  }
});

test('6. EMG + Nano + ADuM3160 + pre-amp input AC-coupling capacitors returns safe', () => {
  const breadboard = new BreadboardModel({
    elvisMode: false,
    emgMode: true,
    sensorPosition: 'right'
  });

  const placedParts = [
    { id: 'nano1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 },
    { id: 'ad620', partId: 'inamp-ad620', anchorHoleId: 'e28', rotation: 0 },
    { id: 'rg100', partId: 'resistor-100-1pct', pinHoles: { P1: 'a28', P2: 'j28' } },
    // Pre-amp series AC-coupling caps on both EMG differential inputs
    { id: 'c_in_p', partId: 'cap-1uf', pinHoles: { P1: 'g24', P2: 'g30' } },
    { id: 'c_in_n', partId: 'cap-1uf', pinHoles: { P1: 'h25', P2: 'h29' } },
    // Input bias return resistors (10 kOhm) to GND
    { id: 'r_bias_p', partId: 'resistor-10k-1pct', pinHoles: { P1: 'i30', P2: 'i34' } },
    { id: 'r_bias_n', partId: 'resistor-10k-1pct', pinHoles: { P1: 'j29', P2: 'j35' } }
  ];

  const wires = [
    { id: 'w_vcc', holeA: 'j13', holeB: 'BP13', colorName: 'Red' },
    { id: 'w_gnd', holeA: 'j15', holeB: 'BN15', colorName: 'Black' },
    { id: 'w_vs_pos', holeA: 'BP29', holeB: 'a29', colorName: 'Red' },
    { id: 'w_vs_neg', holeA: 'j31', holeB: 'BN31', colorName: 'Black' },
    { id: 'w_emg_p', holeA: 'EMG_RED1_A', holeB: 'j24', colorName: 'Red' },
    { id: 'w_emg_n', holeA: 'EMG_RED2_A', holeB: 'j25', colorName: 'Orange' },
    { id: 'w_emg_ref', holeA: 'EMG_BLK_A', holeB: 'BN27', colorName: 'Black' },
    { id: 'w_bias_gnd_p', holeA: 'j34', holeB: 'BN34', colorName: 'Black' },
    { id: 'w_bias_gnd_n', holeA: 'f35', holeB: 'BN35', colorName: 'Black' },
    { id: 'w_out_a0', holeA: 'b30', holeB: 'j5', colorName: 'Green' }
  ];

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: true }
  });

  assert.equal(result.level, 'safe');
  assert.equal(findCheck(result, 'secondary-highpass-blocking').status, 'pass');
  assert.ok(Math.abs(result.detectedHpfCutoffHz - 15.915) <= 0.5);
});

test('7. Bypassed HPF capacitor (parallel wire shorting capacitor leads) fails secondary-highpass-blocking', () => {
  const { breadboard, placedParts, wires } = buildEmgNanoAd620Base();
  placedParts.push(
    { id: 'c_hpf', partId: 'cap-1uf', pinHoles: { P1: 'c30', P2: 'c35' } },
    { id: 'r_hpf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'd35', P2: 'd39' } }
  );
  wires.push(
    { id: 'w_hpf_gnd', holeA: 'e39', holeB: 'BN39', colorName: 'Black' },
    { id: 'w_out_a0', holeA: 'a35', holeB: 'j5', colorName: 'Green' },
    // Short across c_hpf leads!
    { id: 'w_bypass_cap', holeA: 'b30', holeB: 'b35', colorName: 'Yellow' }
  );

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: true }
  });

  const hpfCheck = findCheck(result, 'secondary-highpass-blocking');
  assert.equal(hpfCheck.status, 'fail');
  assert.match(hpfCheck.summary, /Bypassed/i);
  assert.equal(result.level, 'partial');
  assert.equal(result.detectedHpfCutoffHz, null);
});

test('8. Bridged isolation barrier (Nano + ADuM3160 + ELVIS II + jumper from Nano GND to ELV_53A) returns hazard with offendingWireIds', () => {
  const { breadboard, placedParts, wires } = buildEmgNanoAd620Base({ elvisMode: true });
  placedParts.push(
    { id: 'c_hpf', partId: 'cap-1uf', pinHoles: { P1: 'c30', P2: 'c35' } },
    { id: 'r_hpf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'd35', P2: 'd39' } }
  );
  wires.push(
    { id: 'w_hpf_gnd', holeA: 'e39', holeB: 'BN39', colorName: 'Black' },
    { id: 'w_out_a0', holeA: 'a35', holeB: 'j5', colorName: 'Green' },
    // Bridging wire: Nano GND_BOT (strip f15..j15) -> ELVIS GROUND (ELV_53A)
    { id: 'w_bridge_gnd', holeA: 'i15', holeB: 'ELV_53A', colorName: 'Black' }
  );

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: true }
  });

  const galvanicCheck = findCheck(result, 'galvanic-host-isolation');
  assert.equal(result.level, 'hazard');
  assert.equal(galvanicCheck.status, 'fail');
  assert.match(galvanicCheck.summary, /Bridged/i);
  assert.ok(result.offendingWireIds.includes('w_bridge_gnd'));
  assert.ok(galvanicCheck.offendingWireIds.includes('w_bridge_gnd'));
});

test('8b. Patient electrode (EMG_BLK) tied to mains ELVIS GROUND still fails as bridged even if Nano GND is separate', () => {
  const { breadboard, placedParts, wires } = buildEmgNanoAd620Base({ elvisMode: true });
  // Remove EMG_BLK -> BN27 and instead tie EMG_BLK directly to mains ELVIS GROUND (ELV_53A)
  const filteredWires = wires.filter((w) => w.id !== 'w_emg_ref');
  filteredWires.push({ id: 'w_emg_elvis_gnd', holeA: 'EMG_BLK_A', holeB: 'ELV_53A', colorName: 'Black' });

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires: filteredWires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: true }
  });

  const galvanicCheck = findCheck(result, 'galvanic-host-isolation');
  assert.equal(result.level, 'hazard');
  assert.equal(galvanicCheck.status, 'fail');
  assert.match(galvanicCheck.summary, /Bridged/i);
  assert.ok(result.offendingWireIds.includes('w_emg_elvis_gnd'));
});

test('9. Direct power-rail short (+5V wired to EMG_RED1) returns hazard and fails patient-rail-fault', () => {
  const { breadboard, placedParts, wires } = buildEmgNanoAd620Base();
  placedParts.push(
    { id: 'c_hpf', partId: 'cap-1uf', pinHoles: { P1: 'c30', P2: 'c35' } },
    { id: 'r_hpf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'd35', P2: 'd39' } }
  );
  wires.push(
    { id: 'w_hpf_gnd', holeA: 'e39', holeB: 'BN39', colorName: 'Black' },
    { id: 'w_out_a0', holeA: 'a35', holeB: 'j5', colorName: 'Green' },
    // Short +5V rail (BP21) directly to EMG_RED1_B!
    { id: 'w_rail_fault', holeA: 'BP21', holeB: 'EMG_RED1_B', colorName: 'Red' }
  );

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: true }
  });

  const railCheck = findCheck(result, 'patient-rail-fault');
  assert.equal(result.level, 'hazard');
  assert.equal(railCheck.status, 'fail');
  assert.match(railCheck.summary, /Power-Rail Fault/i);
});

test('Bonus lead-current-limiting check passes when >=10 kOhm series resistors protect both EMG leads', () => {
  const breadboard = new BreadboardModel({
    elvisMode: false,
    emgMode: true,
    sensorPosition: 'right'
  });

  const placedParts = [
    { id: 'nano1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 },
    { id: 'ad620', partId: 'inamp-ad620', anchorHoleId: 'e28', rotation: 0 },
    { id: 'rg100', partId: 'resistor-100-1pct', pinHoles: { P1: 'a28', P2: 'j28' } },
    // 10 kOhm series protection on RED1 and RED2 before AD620 inputs
    { id: 'r_prot_1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'g22', P2: 'g30' } },
    { id: 'r_prot_2', partId: 'resistor-10k-1pct', pinHoles: { P1: 'h23', P2: 'h29' } },
    // Post-amp HPF
    { id: 'c_hpf', partId: 'cap-1uf', pinHoles: { P1: 'c30', P2: 'c35' } },
    { id: 'r_hpf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'd35', P2: 'd39' } }
  ];

  const wires = [
    { id: 'w_vcc', holeA: 'j13', holeB: 'BP13', colorName: 'Red' },
    { id: 'w_gnd', holeA: 'j15', holeB: 'BN15', colorName: 'Black' },
    { id: 'w_emg_p', holeA: 'EMG_RED1_A', holeB: 'i22', colorName: 'Red' },
    { id: 'w_emg_n', holeA: 'EMG_RED2_A', holeB: 'i23', colorName: 'Orange' },
    { id: 'w_emg_ref', holeA: 'EMG_BLK_A', holeB: 'BN27', colorName: 'Black' },
    { id: 'w_hpf_gnd', holeA: 'e39', holeB: 'BN39', colorName: 'Black' },
    { id: 'w_out_a0', holeA: 'a35', holeB: 'j5', colorName: 'Green' }
  ];

  const result = analyzeCircuitIsolation({
    breadboard,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { usbIsolatorEnabled: true }
  });

  assert.equal(result.level, 'safe');
  assert.equal(findCheck(result, 'lead-current-limiting').status, 'pass');
});
