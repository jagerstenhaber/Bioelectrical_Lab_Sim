import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import {
  DEFAULT_SIM_CONFIG,
  createDefaultSimConfig,
  getDefaultPartProps,
  getPhotoresistorOhms,
  solveLinearSystem,
  solveDcCircuit,
  measureResistance
} from '../js/sim/dcSolver.js';

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

test('Helper APIs: DEFAULT_SIM_CONFIG, getDefaultPartProps, getPhotoresistorOhms, solveLinearSystem', () => {
  assert.equal(DEFAULT_SIM_CONFIG.powered, true);
  assert.equal(DEFAULT_SIM_CONFIG.elvisSupplyPos, 5.0);
  assert.equal(DEFAULT_SIM_CONFIG.elvisSupplyNeg, -5.0);
  assert.equal(DEFAULT_SIM_CONFIG.loadCellForceGrams, 0);

  assert.deepEqual(getDefaultPartProps('pot-side-turn'), { wiper: 0.5, resistance: 10000 });
  assert.deepEqual(getDefaultPartProps('pot-top-turn'), { wiper: 0.5, resistance: 10000 });
  assert.deepEqual(getDefaultPartProps('pushbutton-4pin'), { pressed: false });
  assert.deepEqual(getDefaultPartProps('photoresistor'), {
    lightLevel: 0.5,
    lightMode: 'manual',
    fingerPresent: false,
    bpm: 72,
    perfusion: 0.5
  });
  assert.deepEqual(getDefaultPartProps('resistor-1k-1pct'), {});

  assertApprox(getPhotoresistorOhms(0), 100000, 1e-6, 'dark LDR');
  assertApprox(getPhotoresistorOhms(1), 500, 1e-6, 'bright LDR');
  assertApprox(getPhotoresistorOhms(0.5), Math.sqrt(100000 * 500), 1e-6, 'mid LDR');

  const sol = solveLinearSystem(
    [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2]
    ],
    [8, -11, -3]
  );
  assert.ok(sol);
  assertApprox(sol[0], 2, 1e-9);
  assertApprox(sol[1], 3, 1e-9);
  assertApprox(sol[2], -1, 1e-9);

  assert.equal(
    solveLinearSystem(
      [
        [1, 2],
        [2, 4]
      ],
      [3, 6]
    ),
    null
  );
});

test('1. Voltage divider (5V -> 10k -> mid -> 10k -> GND) gives 2.50 V ± 0.01 V', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // ELVIS Row 54 = +5V (ELV_54A), Row 49 = GROUND (ELV_49A)
  const placedParts = [
    { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } },
    { id: 'r2', partId: 'resistor-10k-1pct', pinHoles: { P1: 'b15', P2: 'b20' } }
  ];
  const wires = [
    { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
    { id: 'w2', holeA: 'e20', holeB: 'ELV_49A', colorName: 'Black' }
  ];

  const connectivity = analyzeCircuit(bb, placedParts, wires, CATALOG);
  const sim = solveDcCircuit({ breadboard: bb, connectivity, placedParts, wires, catalogMap: CATALOG });

  assert.equal(sim.converged, true);
  assertApprox(sim.getHoleVoltage('c15'), 2.5, 0.01, 'divider midpoint');

  const diff = sim.getVoltageDiff('c15', 'ELV_49A');
  assert.equal(diff.valid, true);
  assertApprox(diff.volts, 2.5, 0.01);

  const r1Res = sim.partResults.get('r1');
  assertApprox(r1Res.currentMa, 0.25, 0.01, 'divider current mA');
});

test('2. Potentiometer sweep (wiper = 0.25, 0.5, 0.75) gives 1.25 V, 2.50 V, 3.75 V', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // In ELVIS mode (90 CW), pot-side-turn at e20 with rotation 90:
  // P1(0,0)->e20, WIPER(0,2)->e22, P3(0,4)->e24 (columns 20, 22, 24)
  for (const [wiper, expectedV] of [
    [0.25, 1.25],
    [0.5, 2.5],
    [0.75, 3.75]
  ]) {
    const placedParts = [
      {
        id: 'pot1',
        partId: 'pot-side-turn',
        anchorHoleId: 'e20',
        rotation: 90,
        props: { wiper, resistance: 10000 }
      }
    ];
    // Connect P1 (strip 20) to GND, P3 (strip 24) to +5V so V(WIPER) = alpha * 5V
    const wires = [
      { id: 'w_gnd', holeA: 'a20', holeB: 'ELV_49A', colorName: 'Black' },
      { id: 'w_vcc', holeA: 'a24', holeB: 'ELV_54A', colorName: 'Red' }
    ];

    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    assert.equal(sim.converged, true);
    assertApprox(sim.getHoleVoltage('a22'), expectedV, 0.01, `pot wiper=${wiper}`);
    assertApprox(sim.partResults.get('pot1').vWiper, expectedV, 0.01);
  }
});

test('3. LED + 330 Ω on 5V, direct LED overcurrent warning, and reversed LED', () => {
  const bb = new BreadboardModel({ elvisMode: true });

  // 3a. LED + 330 Ω current-limiting resistor on 5V
  {
    const placedParts = [
      { id: 'r1', partId: 'resistor-330-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
      { id: 'led1', partId: 'led-red', pinHoles: { P1: 'b14', P2: 'b18' } }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w2', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    assert.equal(sim.converged, true);
    const ledRes = sim.partResults.get('led1');
    // Expected I = (5 - 1.9) / (330 + 10 + 0.05) ≈ 9.12 mA
    assertApprox(ledRes.currentMa, 9.12, 0.15, 'LED + 330R current');
    assert.ok(ledRes.ledBrightness > 0.5 && ledRes.ledBrightness < 1);
    assert.equal(ledRes.overcurrent, false);
    assert.equal(ledRes.reverseBiased, false);
    assert.equal(sim.diagnostics.length, 0);
  }

  // 3b. LED directly on 5V -> overcurrent warning
  {
    const placedParts = [
      { id: 'led1', partId: 'led-red', pinHoles: { P1: 'b14', P2: 'b18' } }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e14', colorName: 'Red' },
      { id: 'w2', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    const ledRes = sim.partResults.get('led1');
    assert.equal(ledRes.overcurrent, true);
    assert.ok(ledRes.currentMa > 25);
    assert.ok(sim.diagnostics.some((d) => d.code === 'LED_OVERCURRENT' && d.severity === 'warning'));
  }

  // 3c. Reversed LED -> 0 mA, reverseBiased = true
  {
    const placedParts = [
      { id: 'r1', partId: 'resistor-330-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
      { id: 'led1', partId: 'led-red', pinHoles: { P1: 'b18', P2: 'b14' } } // Cathode to + side
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w2', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    const ledRes = sim.partResults.get('led1');
    assert.equal(ledRes.currentMa, 0);
    assert.equal(ledRes.reverseBiased, true);
    assert.equal(ledRes.ledBrightness, 0);
  }
});

test('4. 1N4007 Diode + 1 kΩ resistor forward drop (~0.68 V) vs reverse-biased (~0 V)', () => {
  const bb = new BreadboardModel({ elvisMode: true });

  // Forward biased: +5V -> Diode -> mid -> 1k -> GND
  {
    const placedParts = [
      { id: 'd1', partId: 'diode-1n4007', pinHoles: { P1: 'a10', P2: 'a14' } },
      { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'b14', P2: 'b18' } }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w2', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    assert.equal(sim.converged, true);
    const vMid = sim.getHoleVoltage('c14');
    const dRes = sim.partResults.get('d1');
    assertApprox(dRes.voltageDrop, 0.688, 0.02, '1N4007 forward drop');
    assertApprox(vMid, 4.311, 0.02, '1k resistor drop');
    assert.equal(dRes.conducting, true);
  }

  // Reverse biased: +5V -> Diode (reversed) -> mid -> 1k -> GND
  {
    const placedParts = [
      { id: 'd1', partId: 'diode-1n4007', pinHoles: { P1: 'a14', P2: 'a10' } },
      { id: 'r1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'b14', P2: 'b18' } }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w2', holeA: 'e18', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    assert.equal(sim.converged, true);
    assertApprox(sim.getHoleVoltage('c14'), 0, 1e-3, 'reverse-biased resistor voltage');
    assert.equal(sim.partResults.get('d1').reverseBiased, true);
  }
});

test('5. Push button open vs pressed and Photoresistor dark vs bright voltage divider', () => {
  const bb = new BreadboardModel({ elvisMode: true });

  // Pushbutton in ELVIS mode with rotation 90 at e34:
  // P1(0,0)->e34, P2(0,2)->e36, P3(-3,0)->h34, P4(-3,2)->h36
  // +5V -> Pair A (strip 34), Pair B (strip 36) -> 10k pull-down -> GND
  for (const [pressed, expectedV] of [
    [false, 0],
    [true, 5.0]
  ]) {
    const placedParts = [
      { id: 'sw1', partId: 'pushbutton-4pin', anchorHoleId: 'e34', rotation: 90, props: { pressed } },
      { id: 'r_pd', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a36', P2: 'a40' } }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'a34', colorName: 'Red' },
      { id: 'w2', holeA: 'e40', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    assertApprox(sim.getHoleVoltage('b36'), expectedV, 0.01, `pushbutton pressed=${pressed}`);
  }

  // Photoresistor voltage divider: +5V -> 10k -> mid -> LDR -> GND
  // Dark (0): LDR = 100k -> Vmid = 5 * 100k / 110k = 4.545 V
  // Bright (1): LDR = 500 -> Vmid = 5 * 500 / 10500 = 0.238 V
  for (const [lightLevel, expectedV] of [
    [0, (5 * 100000) / 110000],
    [1, (5 * 500) / 10500]
  ]) {
    const placedParts = [
      { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a15' } },
      { id: 'ldr1', partId: 'photoresistor', pinHoles: { P1: 'b15', P2: 'b20' }, props: { lightLevel } }
    ];
    const wires = [
      { id: 'w1', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w2', holeA: 'e20', holeB: 'ELV_49A', colorName: 'Black' }
    ];
    const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
    assertApprox(sim.getHoleVoltage('c15'), expectedV, 0.02, `LDR light=${lightLevel}`);
  }
});

test('6. Dual Op-Amp: follower, non-inverting (G=11), inverting (G=-10), rail clamping, unpowered diagnostic', () => {
  // Use standard board + ELVIS dual rails (±15V) with op-amp straddling trough at e20 (rot=0):
  // Top row (e): VCC=e20, OUT2=e21, IN2-=e22, IN2+=e23
  // Bot row (f): OUT1=f20, IN1-=f21, IN1+=f22, GND=f23
  const bb = new BreadboardModel({ elvisMode: true });

  // 6a. Voltage follower on Stage 1: Vin = 2.5V (via 10k/10k divider from +5V), ±15V rails
  {
    const placedParts = [
      { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
      { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a10', P2: 'a14' } },
      { id: 'r2', partId: 'resistor-10k-1pct', pinHoles: { P1: 'b14', P2: 'b16' } }
    ];
    // Wait: let's inspect exact pin holes via analyzeCircuit to avoid rotation guesswork!
    // In ELVIS mode (90° CW): anchor e20 -> gridX = 17-7 = 10, gridY = 19.
    // Let's use connectivity.getPinHole or just standard horizontal breadboard with Nano or ELVIS with rotation 90!
    // Actually rotation 90 in ELVIS mode:
    //   dx=0,dy=0 (VCC) -> (0,0) -> e20
    //   dx=3,dy=3 (GND) -> (-3,3) -> h23 (row h is gridX = 17-12 = 5? Wait: e is 7, f is 10 (gap of 3!), h is 12!)
    //Aha! On the breadboard, e is gridY=7, f is gridY=10 -> delta = 3! In ELVIS mode, e is gridX=10, f is gridX=7 -> deltaX = -3!
    // So in ELVIS mode (rotation 90): (dx, dy) -> rotated (-dy, dx):
    //   VCC (0,0)  -> (-0, 0)  -> e20
    //   OUT2 (1,0) -> (0, 1)   -> e21
    //   IN2- (2,0) -> (0, 2)   -> e22
    //   IN2+ (3,0) -> (0, 3)   -> e23
    //   OUT1 (0,3) -> (-3, 0)  -> f20
    //   IN1- (1,3) -> (-3, 1)  -> f21
    //   IN1+ (2,3) -> (-3, 2)  -> f22
    //   GND  (3,3) -> (-3, 3)  -> f23
    const wires = [
      { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' }, // +15V -> VCC
      { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' }, // -15V -> GND (V-)
      { id: 'w_5v', holeA: 'ELV_54A', holeB: 'e10', colorName: 'Red' },
      { id: 'w_gnd', holeA: 'ELV_49A', holeB: 'e16', colorName: 'Black' },
      { id: 'w_in', holeA: 'c14', holeB: 'j22', colorName: 'Green' }, // 2.5V -> IN1+
      { id: 'w_fb', holeA: 'g20', holeB: 'g21', colorName: 'Yellow' } // OUT1 -> IN1-
    ];
    const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
    assert.equal(conn.getPinHole('op1', 'VCC').id, 'e20');
    assert.equal(conn.getPinHole('op1', 'OUT1').id, 'f20');
    assert.equal(conn.getPinHole('op1', 'IN1-').id, 'f21');
    assert.equal(conn.getPinHole('op1', 'IN1+').id, 'f22');
    assert.equal(conn.getPinHole('op1', 'GND').id, 'f23');

    const sim = solveDcCircuit({ breadboard: bb, connectivity: conn, placedParts, wires, catalogMap: CATALOG });
    assert.equal(sim.converged, true);
    assertApprox(sim.getHoleVoltage('j20'), 2.5, 0.01, 'follower Vout');
  }

  // 6b. Non-inverting amplifier: G = 1 + 10k / 1k = 11 on ±15V ELVIS rails, Vin = 1.0V (via SUPPLY+ = 1.0V) -> Vout = 11.0V
  {
    const placedParts = [
      { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
      { id: 'rf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'g20', P2: 'g21' } }, // OUT1 to IN1-
      { id: 'rg', partId: 'resistor-1k-1pct', pinHoles: { P1: 'h21', P2: 'h30' } }   // IN1- to GND
    ];
    const wires = [
      { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' },    // +15V -> VCC
      { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' },   // -15V -> GND (V-)
      { id: 'w_gnd', holeA: 'ELV_49A', holeB: 'j30', colorName: 'Black' },  // GND -> rg bottom
      { id: 'w_vin', holeA: 'ELV_48A', holeB: 'j22', colorName: 'Green' }   // SUPPLY+ -> IN1+
    ];

    const sim11 = solveDcCircuit({
      breadboard: bb,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: { elvisSupplyPos: 1.0 }
    });
    assert.equal(sim11.converged, true);
    assertApprox(sim11.getHoleVoltage('j20'), 11.0, 0.05, 'non-inverting G=11');
    assert.equal(sim11.partResults.get('op1').stages[0].saturated, false);

    // 6c. Rail saturation clamping: Vin = 2.0V -> 11*2 = 22V -> clamps at +14.5V (Vcc - 0.5V)
    const simSat = solveDcCircuit({
      breadboard: bb,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: { elvisSupplyPos: 2.0 }
    });
    assert.equal(simSat.converged, true);
    assertApprox(simSat.getHoleVoltage('j20'), 14.5, 0.05, 'positive rail clamp');
    assert.equal(simSat.partResults.get('op1').stages[0].state, 'high');
    assert.equal(simSat.partResults.get('op1').stages[0].saturated, true);
  }

  // 6d. Inverting amplifier: G = -10k / 1k = -10 on ±15V ELVIS rails, Vin = 1.0V -> Vout = -10.0V
  {
    const placedParts = [
      { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 },
      { id: 'rin', partId: 'resistor-1k-1pct', pinHoles: { P1: 'g15', P2: 'g21' } }, // Vin -> IN1-
      { id: 'rf', partId: 'resistor-10k-1pct', pinHoles: { P1: 'h21', P2: 'h20' } } // IN1- -> OUT1
    ];
    const wires = [
      { id: 'w_vcc', holeA: 'ELV_51A', holeB: 'a20', colorName: 'Red' },    // +15V -> VCC
      { id: 'w_vee', holeA: 'ELV_52A', holeB: 'j23', colorName: 'Blue' },   // -15V -> GND (V-)
      { id: 'w_inp', holeA: 'ELV_49A', holeB: 'j22', colorName: 'Black' },  // GND -> IN1+
      { id: 'w_vin', holeA: 'ELV_48A', holeB: 'j15', colorName: 'Green' }   // SUPPLY+ (1V) -> Rin
    ];
    const simInv = solveDcCircuit({
      breadboard: bb,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: { elvisSupplyPos: 1.0 }
    });
    assert.equal(simInv.converged, true);
    assertApprox(simInv.getHoleVoltage('j20'), -10.0, 0.05, 'inverting G=-10');
  }

  // 6e. Unpowered op-amp diagnostic when VCC/GND are disconnected
  {
    const placedParts = [
      { id: 'op1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 90 }
    ];
    const simUnpow = solveDcCircuit({ breadboard: bb, placedParts, wires: [], catalogMap: CATALOG });
    assert.equal(simUnpow.partResults.get('op1').powered, false);
    assert.ok(simUnpow.diagnostics.some((d) => d.code === 'IC_UNPOWERED'));
  }
});

test('7. AD620 In-Amp with Rg=100 Ω (G≈495) amplifying Full-Bridge Load Cell at 5V excitation & 500 g load', () => {
  const bb = new BreadboardModel({ elvisMode: true, loadCellsMode: true });
  // AD620 at e28 with rotation 90 in ELVIS mode:
  //   RG2 (0,0) -> e28, VS+ (1,0) -> e29, OUT (2,0) -> e30, REF (3,0) -> e31
  //   RG1 (0,3) -> f28, IN- (1,3) -> f29, IN+ (2,3) -> f30, VS- (3,3) -> f31
  const placedParts = [
    { id: 'ia1', partId: 'inamp-ad620', anchorHoleId: 'e28', rotation: 90 },
    { id: 'rg1', partId: 'resistor-100-1pct', pinHoles: { P1: 'a28', P2: 'j28' } } // across RG2 (strip 28 top) & RG1 (strip 28 bot)
  ];
  const wires = [
    // Power AD620 from ±15V ELVIS rails, REF to GROUND
    { id: 'w_vsp', holeA: 'ELV_51A', holeB: 'b29', colorName: 'Red' },
    { id: 'w_vsn', holeA: 'ELV_52A', holeB: 'g31', colorName: 'Blue' },
    { id: 'w_ref', holeA: 'ELV_49A', holeB: 'b31', colorName: 'Black' },
    // Excite Full-Bridge Load Cell with +5V (ELV_54A) & GROUND (ELV_49B)
    { id: 'w_exc_p', holeA: 'ELV_54A', holeB: 'LC_FB_RED_A', colorName: 'Red' },
    { id: 'w_exc_n', holeA: 'ELV_49B', holeB: 'LC_FB_BLK_A', colorName: 'Black' },
    // Connect GRN (SIG+) -> IN+ (strip 30 bot) and WHT (SIG-) -> IN- (strip 29 bot)
    { id: 'w_sig_p', holeA: 'LC_FB_GRN_A', holeB: 'g30', colorName: 'Green' },
    { id: 'w_sig_n', holeA: 'LC_FB_WHT_A', holeB: 'g29', colorName: 'White' }
  ];

  const sim = solveDcCircuit({
    breadboard: bb,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig: { loadCellForceGrams: 500 }
  });

  assert.equal(sim.converged, true);
  const iaRes = sim.partResults.get('ia1');
  assert.equal(iaRes.powered, true);
  assertApprox(iaRes.gain, 495, 1e-6, 'AD620 gain');
  // With 500g load: delta = 0.001, V(SIG+) = 2.5025V, V(SIG-) = 2.4975V -> Vdiff = 5.0 mV -> Vout = 495 * 0.005 = 2.475 V
  assertApprox(iaRes.vInP - iaRes.vInN, 0.005, 0.0001, 'bridge differential voltage');
  assertApprox(iaRes.vOut, 2.475, 0.02, 'AD620 amplified output');
  assertApprox(sim.getHoleVoltage('b30'), 2.475, 0.02, 'OUT hole voltage');
});

test('8. Polarized 10 µF capacitor reverse-polarity warning', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const placedParts = [
    // P1 = Anode (+), P2 = Cathode (-): wire P1 to GND and P2 to +5V -> reverse biased
    { id: 'c1', partId: 'cap-10uf', pinHoles: { P1: 'a10', P2: 'a14' } }
  ];
  const wires = [
    { id: 'w1', holeA: 'ELV_49A', holeB: 'e10', colorName: 'Black' },
    { id: 'w2', holeA: 'ELV_54A', holeB: 'e14', colorName: 'Red' }
  ];

  const sim = solveDcCircuit({ breadboard: bb, placedParts, wires, catalogMap: CATALOG });
  const capRes = sim.partResults.get('c1');
  assert.equal(capRes.reverseBiased, true);
  assert.ok(sim.diagnostics.some((d) => d.code === 'CAP_REVERSE_POLARITY' && d.severity === 'warning'));
});

test('9. measureResistance: single 10 kΩ, two 10 kΩ in parallel (5 kΩ), same-strip continuity, open circuit', () => {
  const bb = new BreadboardModel();

  // Single 10k resistor
  {
    const placedParts = [
      { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a1', P2: 'a5' } }
    ];
    const m = measureResistance({
      breadboard: bb,
      placedParts,
      wires: [],
      catalogMap: CATALOG,
      holeA: 'e1',
      holeB: 'e5'
    });
    assert.equal(m.valid, true);
    assert.equal(m.open, false);
    assert.equal(m.continuity, false);
    assertApprox(m.ohms, 10000, 1e-2, 'single 10k');
  }

  // Two 10k resistors in parallel -> 5 kΩ
  {
    const placedParts = [
      { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'a1', P2: 'a5' } },
      { id: 'r2', partId: 'resistor-10k-1pct', pinHoles: { P1: 'b1', P2: 'b5' } }
    ];
    const m = measureResistance({
      breadboard: bb,
      placedParts,
      wires: [],
      catalogMap: CATALOG,
      holeA: 'e1',
      holeB: 'e5'
    });
    assert.equal(m.valid, true);
    assert.equal(m.open, false);
    assertApprox(m.ohms, 5000, 1e-2, 'parallel 10k || 10k');
  }

  // Same strip continuity -> 0 Ω, continuity = true
  {
    const m = measureResistance({
      breadboard: bb,
      placedParts: [],
      wires: [],
      catalogMap: CATALOG,
      holeA: 'a1',
      holeB: 'e1'
    });
    assert.deepEqual(m, { valid: true, ohms: 0, open: false, continuity: true });
  }

  // Open circuit -> Infinity, open = true, continuity = false
  {
    const m = measureResistance({
      breadboard: bb,
      placedParts: [],
      wires: [],
      catalogMap: CATALOG,
      holeA: 'a1',
      holeB: 'a10'
    });
    assert.deepEqual(m, { valid: true, ohms: Infinity, open: true, continuity: false });
  }
});

test('10. Unwired NI ELVIS II supply strips (+5V, +15V, -15V, SUPPLY +, SUPPLY -, GROUND, AIGND) return exact voltages with zero wires', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  const sim = solveDcCircuit({
    breadboard: bb,
    placedParts: [],
    wires: [],
    catalogMap: CATALOG,
    simConfig: { elvisSupplyPos: 7.25, elvisSupplyNeg: -3.5 }
  });

  assert.equal(sim.converged, true);
  assertApprox(sim.getHoleVoltage('ELV_54A'), 5.0, 1e-6, '+5V');
  assertApprox(sim.getHoleVoltage('ELV_51A'), 15.0, 1e-6, '+15V');
  assertApprox(sim.getHoleVoltage('ELV_52A'), -15.0, 1e-6, '-15V');
  assertApprox(sim.getHoleVoltage('ELV_48A'), 7.25, 1e-6, 'SUPPLY +');
  assertApprox(sim.getHoleVoltage('ELV_50A'), -3.5, 1e-6, 'SUPPLY -');
  assertApprox(sim.getHoleVoltage('ELV_49A'), 0.0, 1e-6, 'GROUND');
  assertApprox(sim.getHoleVoltage('ELV_18A'), 0.0, 1e-6, 'AIGND');

  // Unwired breadboard strip should still be floating
  assert.equal(sim.getHoleVoltage('a1'), null);
  const diffFloating = sim.getVoltageDiff('a1', 'ELV_49A');
  assert.equal(diffFloating.valid, false);
  assert.match(diffFloating.floatingReason, /floating/i);
});

test('11. createDefaultSimConfig isolates arduinoPinStates and active-net pruning keeps empty strips in floatingNets', () => {
  assert.equal(Object.isFrozen(DEFAULT_SIM_CONFIG.arduinoPinStates), true);

  const cfgA = createDefaultSimConfig();
  const cfgB = createDefaultSimConfig({ arduinoPinStates: { D5: { mode: 'OUTPUT', voltage: 5.0 } } });
  cfgA.arduinoPinStates.D2 = { mode: 'OUTPUT', voltage: 3.3 };

  assert.equal(DEFAULT_SIM_CONFIG.arduinoPinStates.D2, undefined);
  assert.equal(cfgB.arduinoPinStates.D2, undefined);
  assert.deepEqual(cfgB.arduinoPinStates.D5, { mode: 'OUTPUT', voltage: 5.0 });

  // Verify per-instance & flat Arduino GPIO pin states plus active-net pruning
  const bb = new BreadboardModel();
  const baseParts = [{ id: 'nano_1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 }];
  const baseConn = analyzeCircuit(bb, baseParts, [], CATALOG);
  const d2Hole = baseConn.getPinHole('nano_1', 'D2');
  const d5Hole = baseConn.getPinHole('nano_1', 'D5');
  const gndTopHole = baseConn.getPinHole('nano_1', 'GND_TOP');

  // Wire D2 -> 1k -> GND_TOP (both on top half a-e), and leave empty strips (e.g. a55) untouched
  const partsWithLoad = [
    ...baseParts,
    { id: 'r_load', partId: 'resistor-1k-1pct', pinHoles: { P1: `a${d2Hole.col}`, P2: `a${gndTopHole.col}` } }
  ];
  const sim = solveDcCircuit({
    breadboard: bb,
    placedParts: partsWithLoad,
    wires: [],
    catalogMap: CATALOG,
    simConfig: {
      arduinoPinStates: {
        nano_1: { D2: { mode: 'OUTPUT', voltage: 5.0 } },
        D5: { mode: 'OUTPUT', voltage: 3.3 }
      }
    }
  });

  assert.equal(sim.converged, true);
  assertApprox(sim.getHoleVoltage(d2Hole.id), 5.0 * (1000 / 1025), 0.02, 'per-instance Nano D2 loaded voltage');
  assertApprox(sim.getHoleVoltage(d5Hole.id), 3.3, 1e-4, 'flat Nano D5 unloaded voltage');
  assertApprox(sim.getHoleVoltage(gndTopHole.id), 0.0, 1e-4, 'Nano GND_TOP');

  // Untouched breadboard strip must remain in floatingNets with null voltage
  const emptyNet = analyzeCircuit(bb, partsWithLoad, [], CATALOG).getNetForHole('a55');
  assert.ok(emptyNet);
  assert.equal(sim.floatingNets.has(emptyNet.id), true);
  assert.equal(sim.nodeVoltages.get(emptyNet.id), null);
  assert.equal(sim.getHoleVoltage('a55'), null);
});

test('12. Arduino INPUT_PULLUP (with pushbutton to GND), PWM DC average (330 Ω + LED), and INPUT high-Z mode', () => {
  const bb = new BreadboardModel();
  const baseParts = [{ id: 'nano_1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 }];
  const baseConn = analyzeCircuit(bb, baseParts, [], CATALOG);
  const d2Hole = baseConn.getPinHole('nano_1', 'D2');
  const d4Hole = baseConn.getPinHole('nano_1', 'D4');
  const d9Hole = baseConn.getPinHole('nano_1', 'D9');
  const gndTopHole = baseConn.getPinHole('nano_1', 'GND_TOP');
  const fiveVHole = baseConn.getPinHole('nano_1', '5V');

  // 12a & 12b: INPUT_PULLUP on D2 -> pushbutton-4pin -> GND (released vs pressed)
  for (const [pressed, checkFn] of [
    [false, (v) => assertApprox(v, 5.0, 0.01, 'INPUT_PULLUP released')],
    [true, (v) => assert.ok(v >= 0 && v < 0.05, `INPUT_PULLUP pressed expected < 0.05 V, got ${v}`)]
  ]) {
    const placedParts = [
      ...baseParts,
      { id: 'sw1', partId: 'pushbutton-4pin', anchorHoleId: 'e34', rotation: 0, props: { pressed } }
    ];
    const wires = [
      { id: 'w_d2_sw', holeA: `a${d2Hole.col}`, holeB: 'a34', colorName: 'Green' },
      { id: 'w_sw_gnd', holeA: 'a36', holeB: `a${gndTopHole.col}`, colorName: 'Black' }
    ];
    const sim = solveDcCircuit({
      breadboard: bb,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: {
        arduinoPinStates: {
          nano_1: {
            D2: { mode: 'INPUT_PULLUP' },
            D4: { mode: 'INPUT' }
          }
        }
      }
    });
    assert.equal(sim.converged, true);
    checkFn(sim.getHoleVoltage(d2Hole.id));
    // Unwired INPUT pin remains high-Z (floating)
    assert.equal(sim.getHoleVoltage(d4Hole.id), null);
  }

  // 12c: PWM on D9 (dutyCycle: 128 -> ~2.51 V DC average) driving 330 Ω + red LED,
  // plus INPUT on D4 reading midpoint of a 10k/10k divider without loading it
  {
    const placedParts = [
      ...baseParts,
      { id: 'r_led', partId: 'resistor-330-1pct', pinHoles: { P1: `a${d9Hole.col}`, P2: 'a25' } },
      { id: 'led1', partId: 'led-red', pinHoles: { P1: 'b25', P2: 'b29' } },
      { id: 'r_div1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'j40', P2: 'j45' } },
      { id: 'r_div2', partId: 'resistor-10k-1pct', pinHoles: { P1: 'i45', P2: 'i50' } }
    ];
    const wires = [
      { id: 'w_led_gnd', holeA: 'e29', holeB: `a${gndTopHole.col}`, colorName: 'Black' },
      { id: 'w_div_5v', holeA: `i${fiveVHole.col}`, holeB: 'f40', colorName: 'Red' },
      { id: 'w_div_gnd', holeA: 'f50', holeB: `a${gndTopHole.col}`, colorName: 'Black' },
      { id: 'w_d4_mid', holeA: `a${d4Hole.col}`, holeB: 'f45', colorName: 'Blue' }
    ];
    const sim = solveDcCircuit({
      breadboard: bb,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig: {
        arduinoPinStates: {
          nano_1: {
            D9: { mode: 'PWM', dutyCycle: 128, freqHz: 490 },
            D4: { mode: 'INPUT' }
          }
        }
      }
    });
    assert.equal(sim.converged, true);
    const expectedVavg = 5.0 * (128 / 255); // ~2.5098 V
    const expectedI = (expectedVavg - 1.9) / (25 + 330 + 10); // ~1.67 mA
    const ledRes = sim.partResults.get('led1');
    assert.equal(ledRes.conducting, true);
    assertApprox(ledRes.currentMa, expectedI * 1000, 0.05, 'PWM 128 driving 330R + LED current');
    assertApprox(sim.getHoleVoltage(d9Hole.id), expectedVavg - 25 * expectedI, 0.02, 'PWM D9 pin voltage');
    assertApprox(sim.getHoleVoltage(d4Hole.id), 2.5, 0.01, 'INPUT D4 reads unloaded 2.5V divider');
  }
});

test('13. vpsEnabled: false puts ELVIS SUPPLY+/SUPPLY- in 0.0 V standby while fixed rails stay active; vpsEnabled: true restores them', () => {
  assert.equal(DEFAULT_SIM_CONFIG.vpsEnabled, true);
  assert.equal(createDefaultSimConfig().vpsEnabled, true);
  assert.equal(createDefaultSimConfig({ vpsEnabled: false }).vpsEnabled, false);

  const bb = new BreadboardModel({ elvisMode: true });
  const simStandby = solveDcCircuit({
    breadboard: bb,
    placedParts: [],
    wires: [],
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      vpsEnabled: false,
      elvisSupplyPos: 3.0,
      elvisSupplyNeg: -2.5
    }
  });

  assert.equal(simStandby.converged, true);
  assertApprox(simStandby.getHoleVoltage('ELV_48A'), 0.0, 1e-6, 'VPS standby SUPPLY +');
  assertApprox(simStandby.getHoleVoltage('ELV_50A'), 0.0, 1e-6, 'VPS standby SUPPLY -');
  assertApprox(simStandby.getHoleVoltage('ELV_54A'), 5.0, 1e-6, 'fixed +5V active');
  assertApprox(simStandby.getHoleVoltage('ELV_51A'), 15.0, 1e-6, 'fixed +15V active');
  assertApprox(simStandby.getHoleVoltage('ELV_52A'), -15.0, 1e-6, 'fixed -15V active');

  const simActive = solveDcCircuit({
    breadboard: bb,
    placedParts: [],
    wires: [],
    catalogMap: CATALOG,
    simConfig: {
      powered: true,
      vpsEnabled: true,
      elvisSupplyPos: 3.0,
      elvisSupplyNeg: -2.5
    }
  });

  assert.equal(simActive.converged, true);
  assertApprox(simActive.getHoleVoltage('ELV_48A'), 3.0, 1e-6, 'VPS enabled SUPPLY +');
  assertApprox(simActive.getHoleVoltage('ELV_50A'), -2.5, 1e-6, 'VPS enabled SUPPLY -');
  assertApprox(simActive.getHoleVoltage('ELV_54A'), 5.0, 1e-6, 'fixed +5V active');
  assertApprox(simActive.getHoleVoltage('ELV_51A'), 15.0, 1e-6, 'fixed +15V active');
  assertApprox(simActive.getHoleVoltage('ELV_52A'), -15.0, 1e-6, 'fixed -15V active');
});

test('14. solveDcCircuit({ timeSec }) live-samples 3-Pad EMG -> AD620 (G=495, REF=+2.5V via SUPPLY+) and FGEN sine', () => {
  const bb = new BreadboardModel({ elvisMode: true, emgMode: true });
  const placedParts = [
    { id: 'ia1', partId: 'inamp-ad620', anchorHoleId: 'e28', rotation: 90 },
    { id: 'rg1', partId: 'resistor-100-1pct', pinHoles: { P1: 'a28', P2: 'j28' } }
  ];
  const wires = [
    { id: 'w_vsp', holeA: 'ELV_51A', holeB: 'b29', colorName: 'Red' },
    { id: 'w_vsn', holeA: 'ELV_52A', holeB: 'g31', colorName: 'Blue' },
    { id: 'w_ref', holeA: 'ELV_48A', holeB: 'b31', colorName: 'Orange' },
    { id: 'w_emg_blk', holeA: 'EMG_BLK_A', holeB: 'ELV_49B', colorName: 'Black' },
    { id: 'w_emg_r1', holeA: 'EMG_RED1_A', holeB: 'g30', colorName: 'Red' },
    { id: 'w_emg_r2', holeA: 'EMG_RED2_A', holeB: 'g29', colorName: 'Red' }
  ];
  const conn = analyzeCircuit(bb, placedParts, wires, CATALOG);
  const fHz = 100;
  const simConfig = {
    powered: true,
    vpsEnabled: true,
    elvisSupplyPos: 2.5,
    emg: { flexEffort: 1.0, burstMode: 'burst', humMvpp: 0, electrodeMismatch: 0.05 },
    fgen: {
      enabled: true,
      waveform: 'sine',
      frequencyHz: fHz,
      amplitudeVpp: 4.0,
      dcOffsetV: 0.5
    }
  };

  // Default DC steady state (timeSec = null): EMG at 0V diff -> AD620 OUT = +2.50 V; FGEN at DC mean (+0.50 V)
  const simDc = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig
  });
  assert.equal(simDc.converged, true);
  assertApprox(simDc.getHoleVoltage('b30'), 2.5, 1e-3, 'DC steady-state AD620 OUT');
  assertApprox(simDc.getHoleVoltage('ELV_33A'), 0.5, 1e-6, 'DC steady-state FGEN mean');

  // Rest interval (timeSec = 0.01 s): envelope = 0 -> AD620 OUT ≈ 2.50 V
  const simRest = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig,
    timeSec: 0.01
  });
  assert.equal(simRest.converged, true);
  assertApprox(simRest.getHoleVoltage('b30'), 2.5, 0.04, 'EMG rest interval AD620 OUT');

  // Burst peak scan across 0.06..0.11 s: strong amplified EMG deflection (|V - 2.50| > 0.25 V)
  let maxDeflection = 0;
  for (let t = 0.06; t <= 0.11 + 1e-9; t += 0.002) {
    const simBurst = solveDcCircuit({
      breadboard: bb,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap: CATALOG,
      simConfig,
      timeSec: t
    });
    assert.equal(simBurst.converged, true);
    const vOut = simBurst.getHoleVoltage('b30');
    maxDeflection = Math.max(maxDeflection, Math.abs(vOut - 2.5));
  }
  assert.ok(
    maxDeflection > 0.25,
    `Expected live EMG burst peak deflection |V - 2.50| > 0.25 V, got ${maxDeflection.toFixed(4)} V`
  );

  // FGEN sine peak at t = 1 / (4 * f): offset (0.5 V) + amplitudeVpp / 2 (2.0 V) = +2.5 V (+Vpk)
  const simFgenPeak = solveDcCircuit({
    breadboard: bb,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap: CATALOG,
    simConfig,
    timeSec: 1 / (4 * fHz)
  });
  assert.equal(simFgenPeak.converged, true);
  assertApprox(simFgenPeak.getHoleVoltage('ELV_33A'), 2.5, 1e-6, 'FGEN sine sampled at t = 1/(4*f)');
});


