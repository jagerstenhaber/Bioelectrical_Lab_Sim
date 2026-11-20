import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCOPE_CONFIG,
  createDefaultScopeConfig,
  computeAutoscale,
  formatCursorDelta
} from '../js/ui/scopePanel.js';

test('createDefaultScopeConfig returns deep-cloned normalized config and respects overrides', () => {
  const cfgA = createDefaultScopeConfig();
  const cfgB = createDefaultScopeConfig();

  assert.deepEqual(cfgA, DEFAULT_SCOPE_CONFIG);
  assert.notEqual(cfgA, cfgB);
  assert.notEqual(cfgA.trigger, cfgB.trigger);
  assert.notEqual(cfgA.ch0, cfgB.ch0);
  assert.notEqual(cfgA.ch1, cfgB.ch1);

  // Mutating returned config never affects DEFAULT_SCOPE_CONFIG or another instance
  cfgA.ch0.voltsPerDiv = 5;
  cfgA.trigger.level = 2.5;
  assert.equal(DEFAULT_SCOPE_CONFIG.ch0.voltsPerDiv, 1);
  assert.equal(DEFAULT_SCOPE_CONFIG.trigger.level, 0);
  assert.equal(cfgB.ch0.voltsPerDiv, 1);

  // Normalization & clamping on invalid/partial overrides
  const custom = createDefaultScopeConfig({
    running: false,
    timePerDiv: 0.0012, // snaps to nearest valid step (0.001)
    cursorsOn: true,
    cursor1Frac: -0.4,
    cursor2Frac: 1.8,
    trigger: { source: 'INVALID', slope: 'falling', level: 42 },
    ch0: { enabled: false, source: 'FGEN', coupling: 'AC', voltsPerDiv: 0.45, vPos: -9 },
    ch1: { enabled: true, source: 'PROBE', probeHole: ' f22 ', voltsPerDiv: 2, vPos: 2.5 }
  });

  assert.equal(custom.running, false);
  assert.equal(custom.timePerDiv, 0.001);
  assert.equal(custom.cursorsOn, true);
  assert.equal(custom.cursor1Frac, 0);
  assert.equal(custom.cursor2Frac, 1);
  assert.equal(custom.trigger.source, 'CH0');
  assert.equal(custom.trigger.slope, 'falling');
  assert.equal(custom.trigger.level, 15);
  assert.equal(custom.ch0.enabled, false);
  assert.equal(custom.ch0.source, 'FGEN');
  assert.equal(custom.ch0.coupling, 'AC');
  assert.equal(custom.ch0.voltsPerDiv, 0.5);
  assert.equal(custom.ch0.vPos, -4);
  assert.equal(custom.ch1.enabled, true);
  assert.equal(custom.ch1.source, 'PROBE');
  assert.equal(custom.ch1.probeHole, 'f22');
  assert.equal(custom.ch1.voltsPerDiv, 2);
  assert.equal(custom.ch1.vPos, 2.5);
});

test('computeAutoscale picks clean 1-2-5 scales for 100 Hz 2 Vpp, 1.59 kHz 4 Vpp, and DC-only fallback', () => {
  // 100 Hz, 2 Vpp centered at 0 V -> ~0.5 V/div (4 div peak-to-peak), timePerDiv ~ 2 ms/div (2 cycles across 10 div)
  const auto100 = computeAutoscale({
    ch0Metrics: { vMin: -1.0, vMax: 1.0, vpp: 2.0, vAvg: 0.0, freqHz: 100 },
    ch1Metrics: null,
    fgenFreqHz: 100
  });
  assert.equal(auto100.ch0VoltsPerDiv, 0.5);
  assert.equal(auto100.ch1VoltsPerDiv, 1);
  assert.equal(auto100.timePerDiv, 0.002);
  assert.equal(auto100.triggerLevel, 0);

  // 1.59 kHz, 4 Vpp centered at +1.5 V (maxAbs = 3.5 V) -> 1 V/div, timePerDiv = 200 µs/div (3.18 cycles)
  const auto1590 = computeAutoscale({
    ch0Metrics: { vMin: -0.5, vMax: 3.5, vpp: 4.0, vAvg: 1.5, freqHz: 1592 },
    ch1Metrics: { vMin: -1.4, vMax: 1.4, vpp: 2.8, vAvg: 0.0, freqHz: 1592 },
    fgenFreqHz: 1592
  });
  assert.equal(auto1590.ch0VoltsPerDiv, 1);
  assert.equal(auto1590.ch1VoltsPerDiv, 1);
  assert.equal(auto1590.timePerDiv, 0.0002);
  assert.equal(auto1590.triggerLevel, 1.5);

  // DC-only fallback (no frequency detected, flat +5 V rail)
  const autoDc = computeAutoscale({
    ch0Metrics: { vMin: 5.0, vMax: 5.0, vpp: 0.0, vAvg: 5.0, freqHz: null },
    ch1Metrics: null,
    fgenFreqHz: null
  });
  assert.equal(autoDc.ch0VoltsPerDiv, 2);
  assert.equal(autoDc.ch1VoltsPerDiv, 1);
  assert.equal(autoDc.timePerDiv, DEFAULT_SCOPE_CONFIG.timePerDiv);
  assert.equal(autoDc.triggerLevel, 5);
});

test('formatCursorDelta formats ΔT and 1/ΔT across ns, µs, ms, s, and invalid inputs', () => {
  assert.deepEqual(formatCursorDelta(0.0025), {
    dtText: '2.50 ms',
    freqText: '400.0 Hz'
  });

  assert.deepEqual(formatCursorDelta(0.00042), {
    dtText: '420 µs',
    freqText: '2.38 kHz'
  });

  assert.deepEqual(formatCursorDelta(-0.0005), {
    dtText: '500 µs',
    freqText: '2.00 kHz'
  });

  assert.deepEqual(formatCursorDelta(1.25), {
    dtText: '1.250 s',
    freqText: '0.8 Hz'
  });

  assert.deepEqual(formatCursorDelta(0), {
    dtText: '0.00 ms',
    freqText: '---'
  });

  assert.deepEqual(formatCursorDelta(NaN), {
    dtText: '---',
    freqText: '---'
  });
});
