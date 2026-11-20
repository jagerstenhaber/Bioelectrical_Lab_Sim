import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPE_VOLTS_PER_DIV,
  SCOPE_TIME_PER_DIV,
  formatFrequency,
  formatVoltsPerDiv,
  formatTimePerDiv,
  computeBarGraphPercent
} from '../js/ui/elvismxControls.js';

test('SCOPE_VOLTS_PER_DIV and SCOPE_TIME_PER_DIV expose frozen 1-2-5 scale steps', () => {
  assert.ok(Object.isFrozen(SCOPE_VOLTS_PER_DIV));
  assert.ok(Object.isFrozen(SCOPE_TIME_PER_DIV));
  assert.deepEqual([...SCOPE_VOLTS_PER_DIV], [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]);
  assert.deepEqual([...SCOPE_TIME_PER_DIV], [5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1]);
});

test('formatFrequency formats Hz, kHz, MHz, and invalid inputs cleanly', () => {
  assert.equal(formatFrequency(0.5), '0.50 Hz');
  assert.equal(formatFrequency(5), '5.00 Hz');
  assert.equal(formatFrequency(100), '100.0 Hz');
  assert.equal(formatFrequency(1592), '1.592 kHz');
  assert.equal(formatFrequency(10000), '10.00 kHz');
  assert.equal(formatFrequency(250000), '250.0 kHz');
  assert.equal(formatFrequency(1e6), '1.00 MHz');

  assert.equal(formatFrequency(NaN), '---');
  assert.equal(formatFrequency(-5), '---');
  assert.equal(formatFrequency(null), '---');
});

test('formatVoltsPerDiv formats mV and V steps cleanly', () => {
  assert.equal(formatVoltsPerDiv(0.01), '10 mV');
  assert.equal(formatVoltsPerDiv(0.02), '20 mV');
  assert.equal(formatVoltsPerDiv(0.2), '200 mV');
  assert.equal(formatVoltsPerDiv(0.5), '500 mV');
  assert.equal(formatVoltsPerDiv(1), '1 V');
  assert.equal(formatVoltsPerDiv(5), '5 V');
  assert.equal(formatVoltsPerDiv(10), '10 V');

  assert.equal(formatVoltsPerDiv(NaN), '---');
  assert.equal(formatVoltsPerDiv(-1), '---');
});

test('formatTimePerDiv formats µs, ms, and s steps cleanly', () => {
  assert.equal(formatTimePerDiv(5e-5), '50 µs');
  assert.equal(formatTimePerDiv(1e-4), '100 µs');
  assert.equal(formatTimePerDiv(5e-4), '500 µs');
  assert.equal(formatTimePerDiv(1e-3), '1 ms');
  assert.equal(formatTimePerDiv(2e-2), '20 ms');
  assert.equal(formatTimePerDiv(0.1), '100 ms');
  assert.equal(formatTimePerDiv(1), '1 s');

  assert.equal(formatTimePerDiv(NaN), '---');
  assert.equal(formatTimePerDiv(-0.01), '---');
});

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

test('computeBarGraphPercent handles VAC auto-ranging identically to VDC', () => {
  assert.deepEqual(computeBarGraphPercent(0, 'VAC'), { percent: 0, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(0.005, 'VAC'), { percent: 50, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(0.707, 'VAC'), { percent: 70.7, scaleLabel: '1 V' });
  assert.deepEqual(computeBarGraphPercent(1.414, 'VAC'), { percent: 28.28, scaleLabel: '5 V' });
  assert.deepEqual(computeBarGraphPercent(-12, 'VAC'), { percent: 80, scaleLabel: '15 V' });
  assert.deepEqual(computeBarGraphPercent(45, 'VAC'), { percent: 100, scaleLabel: '30 V' });
  assert.deepEqual(computeBarGraphPercent(NaN, 'VAC'), { percent: 0, scaleLabel: '10 mV' });
  assert.deepEqual(computeBarGraphPercent(null, 'VAC'), { percent: 0, scaleLabel: '10 mV' });
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
