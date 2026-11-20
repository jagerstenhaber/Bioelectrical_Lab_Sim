import test from 'node:test';
import assert from 'node:assert/strict';

import { formatVoltage, formatResistance } from '../js/ui/dmmPanel.js';

test('formatVoltage formats V, mV, negative values, near-zero, and non-finite inputs', () => {
  assert.equal(formatVoltage(4.985), '+4.985 V');
  assert.equal(formatVoltage(-12.34), '-12.340 V');
  assert.equal(formatVoltage(1.0), '+1.000 V');
  assert.equal(formatVoltage(-1.0), '-1.000 V');

  // Millivolt range
  assert.equal(formatVoltage(0.01), '+10.00 mV');
  assert.equal(formatVoltage(-0.2564), '-256.40 mV');
  assert.equal(formatVoltage(0.005), '+5.00 mV');

  // Near-zero, boundary residuals, and negative zero
  assert.equal(formatVoltage(0), '+0.000 V');
  assert.equal(formatVoltage(-0), '+0.000 V');
  assert.equal(formatVoltage(-1e-9), '+0.000 V');
  assert.equal(formatVoltage(1e-8), '+0.000 V');
  assert.equal(formatVoltage(1e-6), '+0.000 V');
  assert.equal(formatVoltage(-1e-6), '+0.000 V');
  assert.equal(formatVoltage(5e-6), '+0.01 mV');

  // mV -> V boundary (prevents +1000.00 mV)
  assert.equal(formatVoltage(0.999996), '+1.000 V');
  assert.equal(formatVoltage(-0.999996), '-1.000 V');
  assert.equal(formatVoltage(0.99999), '+999.99 mV');

  // Non-finite
  assert.equal(formatVoltage(NaN), '---');
  assert.equal(formatVoltage(Infinity), '---');
  assert.equal(formatVoltage(null), '---');
});

test('formatResistance formats Ω, kΩ, MΩ, and OL cases cleanly', () => {
  assert.equal(formatResistance(0), '0.0 Ω');
  assert.equal(formatResistance(330), '330.0 Ω');
  assert.equal(formatResistance(999.9), '999.9 Ω');

  assert.equal(formatResistance(1000), '1.00 kΩ');
  assert.equal(formatResistance(10000), '10.00 kΩ');
  assert.equal(formatResistance(47500), '47.50 kΩ');

  assert.equal(formatResistance(1000000), '1.00 MΩ');
  assert.equal(formatResistance(12340000), '12.34 MΩ');

  // OL threshold & non-finite
  assert.equal(formatResistance(Infinity), 'OL');
  assert.equal(formatResistance(NaN), 'OL');
  assert.equal(formatResistance(2.5e7), 'OL');
  assert.equal(formatResistance(-10), 'OL');
});
