import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBarGraphPercent } from '../js/ui/elvismxControls.js';

test('computeBarGraphPercent handles VDC auto-ranging, negative values, zero, and non-finite inputs', () => {
  assert.deepEqual(computeBarGraphPercent(0, 'VDC'), { percent: 0, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(0.005, 'VDC'), { percent: 50, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(-0.005, 'VDC'), { percent: 50, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(0.05, 'VDC'), { percent: 50, scaleLabel: '100 mV' });
  assert.deepEqual(computeBarGraphPercent(0.5, 'VDC'), { percent: 50, scaleLabel: '1 V' });
  assert.deepEqual(computeBarGraphPercent(2.5, 'VDC'), { percent: 50, scaleLabel: '5 V' });
  assert.deepEqual(computeBarGraphPercent(-12, 'VDC'), { percent: 80, scaleLabel: '15 V' });
  assert.deepEqual(computeBarGraphPercent(24, 'VDC'), { percent: 80, scaleLabel: '30 V' });
  assert.deepEqual(computeBarGraphPercent(60, 'VDC'), { percent: 100, scaleLabel: '30 V' });

  // Non-finite / missing inputs
  assert.deepEqual(computeBarGraphPercent(NaN, 'VDC'), { percent: 0, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(Infinity, 'VDC'), { percent: 0, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(null, 'VDC'), { percent: 0, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(undefined, 'VDC'), { percent: 0, scaleLabel: '10 mV' });
});

test('computeBarGraphPercent handles OHM auto-ranging, zero, OL, negative, and non-finite inputs', () => {
  assert.deepEqual(computeBarGraphPercent(0, 'OHM'), { percent: 0, scaleLabel: '100 Ω' });
  assert.deepEqual(computeBarGraphPercent(50, 'OHM'), { percent: 50, scaleLabel: '100 Ω' });
  assert.deepEqual(computeBarGraphPercent(500, 'OHM'), { percent: 50, scaleLabel: '1 kΩ' });
  assert.deepEqual(computeBarGraphPercent(5000, 'OHM'), { percent: 50, scaleLabel: '10 kΩ' });
  assert.deepEqual(computeBarGraphPercent(50000, 'OHM'), { percent: 50, scaleLabel: '100 kΩ' });
  assert.deepEqual(computeBarGraphPercent(500000, 'OHM'), { percent: 50, scaleLabel: '1 MΩ' });
  assert.deepEqual(computeBarGraphPercent(5000000, 'OHM'), { percent: 50, scaleLabel: '10 MΩ' });
  assert.deepEqual(computeBarGraphPercent(15000000, 'OHM'), { percent: 100, scaleLabel: '10 MΩ' });

  // OL / negative / non-finite
  assert.deepEqual(computeBarGraphPercent(2.5e7, 'OHM'), { percent: 0, scaleLabel: 'OL' });
  assert.deepEqual(computeBarGraphPercent(-5, 'OHM'), { percent: 0, scaleLabel: 'OL' });
  assert.deepEqual(computeBarGraphPercent(Infinity, 'OHM'), { percent: 0, scaleLabel: 'OL' });
  assert.deepEqual(computeBarGraphPercent(NaN, 'OHM'), { percent: 0, scaleLabel: 'OL' });
  assert.deepEqual(computeBarGraphPercent(null, 'OHM'), { percent: 0, scaleLabel: 'OL' });
});

test('computeBarGraphPercent handles CONT mode truthy/falsy values', () => {
  assert.deepEqual(computeBarGraphPercent(true, 'CONT'), { percent: 100, scaleLabel: 'SHORT' });
  assert.deepEqual(computeBarGraphPercent(1, 'CONT'), { percent: 100, scaleLabel: 'SHORT' });
  assert.deepEqual(computeBarGraphPercent(false, 'CONT'), { percent: 0, scaleLabel: 'OPEN' });
  assert.deepEqual(computeBarGraphPercent(0, 'CONT'), { percent: 0, scaleLabel: 'OPEN' });
  assert.deepEqual(computeBarGraphPercent(null, 'CONT'), { percent: 0, scaleLabel: 'OPEN' });
  assert.deepEqual(computeBarGraphPercent(undefined, 'CONT'), { percent: 0, scaleLabel: 'OPEN' });
});
