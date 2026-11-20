import test from 'node:test';
import assert from 'node:assert/strict';

import { solveRcFilter } from '../js/rcCalculator.js';

test('solveRcFilter computes cutoff frequency f_c from R and C', () => {
  const rSi = 10_000; // 10 kOhm
  const cSi = 100e-9; // 100 nF
  const expectedF = 1 / (2 * Math.PI * rSi * cSi);

  const explicit = solveRcFilter({ rSi, cSi, targetKey: 'F' });
  const inferred = solveRcFilter({ rSi, cSi });

  assert.ok(Math.abs(explicit - expectedF) < 1e-9);
  assert.ok(Math.abs(inferred - expectedF) < 1e-9);
  assert.ok(Math.abs(explicit - 159.15494309189535) < 1e-9);
});

test('solveRcFilter computes resistance R from f_c and C', () => {
  const fSi = 1000; // 1 kHz
  const cSi = 10e-9; // 10 nF
  const expectedR = 1 / (2 * Math.PI * fSi * cSi);

  const explicit = solveRcFilter({ fSi, cSi, targetKey: 'R' });
  const inferred = solveRcFilter({ fSi, cSi });

  assert.ok(Math.abs(explicit - expectedR) < 1e-9);
  assert.ok(Math.abs(inferred - expectedR) < 1e-9);
});

test('solveRcFilter computes capacitance C from f_c and R', () => {
  const fSi = 500; // 500 Hz
  const rSi = 3300; // 3.3 kOhm
  const expectedC = 1 / (2 * Math.PI * fSi * rSi);

  const explicit = solveRcFilter({ fSi, rSi, targetKey: 'C' });
  const inferred = solveRcFilter({ fSi, rSi });

  assert.ok(Math.abs(explicit - expectedC) < 1e-15);
  assert.ok(Math.abs(inferred - expectedC) < 1e-15);
});

test('solveRcFilter returns null for invalid or missing inputs', () => {
  assert.equal(solveRcFilter(), null);
  assert.equal(solveRcFilter({ rSi: 1000 }), null);
  assert.equal(solveRcFilter({ rSi: 0, cSi: 1e-6 }), null);
  assert.equal(solveRcFilter({ rSi: -100, cSi: 1e-6 }), null);
  assert.equal(solveRcFilter({ rSi: Number.NaN, cSi: 1e-6 }), null);
  assert.equal(solveRcFilter({ rSi: Number.POSITIVE_INFINITY, cSi: 1e-6 }), null);
  assert.equal(solveRcFilter({ rSi: '1000', cSi: 1e-6 }), null);
  // All three provided with no targetKey cannot infer a single missing variable
  assert.equal(solveRcFilter({ rSi: 1000, cSi: 1e-6, fSi: 159.15 }), null);
  assert.equal(solveRcFilter({ rSi: 1000, cSi: 1e-6, targetKey: 'X' }), null);
});
