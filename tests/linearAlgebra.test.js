import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solveLinearSystem,
  solveComplexLinearSystem
} from '../js/sim/linearAlgebra.js';
import {
  SOLVER_CONSTANTS,
  computeLoadCellBridgeOhms,
  createZeroMatrix,
  stampComplexAdmittance,
  stampComplexNortonSource
} from '../js/sim/circuitElements.js';

function assertApprox(actual, expected, tolerance, label = '') {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label ? `${label}: ` : ''}expected ${expected} ± ${tolerance}, got ${actual}`
  );
}

test('solveComplexLinearSystem solves a 2x2 complex system and does not mutate inputs', () => {
  // (1 + 2j) x0 + (3 - 1j) x1 = 9 + 8j
  // (2 - 1j) x0 + (1 + 1j) x1 = 2 - 1j
  // Exact solution: x0 = 2 - 1j, x1 = 1 + 2j
  const Ar = [
    [1, 3],
    [2, 1]
  ];
  const Ai = [
    [2, -1],
    [-1, 1]
  ];
  const br = [9, 2];
  const bi = [8, -1];

  const ArSnapshot = structuredClone(Ar);
  const AiSnapshot = structuredClone(Ai);
  const brSnapshot = [...br];
  const biSnapshot = [...bi];

  const sol = solveComplexLinearSystem(Ar, Ai, br, bi);
  assert.ok(sol, 'expected non-null complex solution');
  assertApprox(sol.real[0], 2, 1e-12, 'x0 real');
  assertApprox(sol.imag[0], -1, 1e-12, 'x0 imag');
  assertApprox(sol.real[1], 1, 1e-12, 'x1 real');
  assertApprox(sol.imag[1], 2, 1e-12, 'x1 imag');

  assert.deepEqual(Ar, ArSnapshot);
  assert.deepEqual(Ai, AiSnapshot);
  assert.deepEqual(br, brSnapshot);
  assert.deepEqual(bi, biSnapshot);
});

test('solveComplexLinearSystem solves exact RC voltage divider at wRC = 1 (0.5 - 0.5j, -45 deg)', () => {
  // Norton source Vin = 1 + 0j with tiny series resistance Rsrc = 1e-9 -> node 0
  // Resistor R = 1000 Ω between node 0 and node 1
  // Capacitor C = 1e-6 F between node 1 and ground, omega = 1000 rad/s (omega * R * C = 1)
  const Ar = createZeroMatrix(2);
  const Ai = createZeroMatrix(2);
  const br = new Float64Array(2);
  const bi = new Float64Array(2);

  const gR = 1 / 1000;
  const omegaC = 1000 * 1e-6; // 1e-3 S
  stampComplexNortonSource(Ar, Ai, br, bi, 0, 1, 0, 1e-9);
  stampComplexAdmittance(Ar, Ai, 0, 1, gR, 0);
  // Shunt capacitor to ground: stamp directly on node 1 diagonal
  Ai[1][1] += omegaC;

  const sol = solveComplexLinearSystem(Ar, Ai, br, bi);
  assert.ok(sol, 'expected non-null RC divider solution');
  assertApprox(sol.real[0], 1, 1e-8, 'Vin real');
  assertApprox(sol.imag[0], 0, 1e-8, 'Vin imag');

  const vOutR = sol.real[1];
  const vOutI = sol.imag[1];
  assertApprox(vOutR, 0.5, 1e-8, 'Vout real');
  assertApprox(vOutI, -0.5, 1e-8, 'Vout imag');

  const mag = Math.hypot(vOutR, vOutI);
  const phaseDeg = (Math.atan2(vOutI, vOutR) * 180) / Math.PI;
  assertApprox(mag, Math.SQRT1_2, 1e-8, '|H(jw)| at wRC=1');
  assertApprox(phaseDeg, -45, 1e-6, 'phase(deg) at wRC=1');
});

test('solveComplexLinearSystem solves a 3x3 complex system requiring partial pivoting', () => {
  // Zero diagonal entry at [0][0] forces complex magnitude pivoting
  // [0,      1+j,   2-j] [1]   [2-3j]
  // [2+j,    0,     1  ] [j] = [4+0j]
  // [1-j,    2,     3j ] [2-j] [4+7j]
  const Ar = [
    [0, 1, 2],
    [2, 0, 1],
    [1, 2, 0]
  ];
  const Ai = [
    [0, 1, -1],
    [1, 0, 0],
    [-1, 0, 3]
  ];
  const br = [2, 4, 4];
  const bi = [-3, 0, 7];

  const sol = solveComplexLinearSystem(Ar, Ai, br, bi);
  assert.ok(sol, 'expected non-null 3x3 complex solution');
  assertApprox(sol.real[0], 1, 1e-12, 'x0 real');
  assertApprox(sol.imag[0], 0, 1e-12, 'x0 imag');
  assertApprox(sol.real[1], 0, 1e-12, 'x1 real');
  assertApprox(sol.imag[1], 1, 1e-12, 'x1 imag');
  assertApprox(sol.real[2], 2, 1e-12, 'x2 real');
  assertApprox(sol.imag[2], -1, 1e-12, 'x2 imag');
});

test('solveComplexLinearSystem returns null for singular matrices and [] for empty input', () => {
  const empty = solveComplexLinearSystem([], [], [], []);
  assert.deepEqual(empty, { real: [], imag: [] });

  // Row 1 = [1, 2+j]; Row 2 = (1+j)*Row 1 = [1+j, 1+3j] -> linearly dependent in C^2
  const singular = solveComplexLinearSystem(
    [
      [1, 2],
      [1, 1]
    ],
    [
      [0, 1],
      [1, 3]
    ],
    [1, 1],
    [0, 1]
  );
  assert.equal(singular, null);

  // Zero column matrix
  assert.equal(
    solveComplexLinearSystem(
      [
        [0, 1],
        [0, 2]
      ],
      [
        [0, 0],
        [0, 0]
      ],
      [1, 2],
      [0, 0]
    ),
    null
  );

  // Sanity check exported real solver & shared constants
  assert.deepEqual(solveLinearSystem([[2, 0], [0, 4]], [6, 8]), [3, 2]);
  assert.equal(SOLVER_CONSTANTS.AD620_GAIN_OHMS, 49400);
  const lc = computeLoadCellBridgeOhms(1000);
  assertApprox(lc.rMinus, 998, 1e-9);
  assertApprox(lc.rPlus, 1002, 1e-9);
});
