import test from 'node:test';
import assert from 'node:assert/strict';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import { createBenchController, normalizeSimConfig } from '../js/controllers/benchController.js';
import { LAB_PRESETS } from '../js/presets.js';

function createFakeCatalogMap() {
  return new Map([
    ['arduino-nano', { id: 'arduino-nano', name: 'Arduino Nano', placement: 'footprint', pins: [] }],
    ['resistor-10k-1pct', { id: 'resistor-10k-1pct', name: '10k Resistor', placement: 'two-lead', pins: [] }],
    ['resistor-1k-1pct', { id: 'resistor-1k-1pct', name: '1k Resistor', placement: 'two-lead', pins: [] }],
    ['resistor-330-1pct', { id: 'resistor-330-1pct', name: '330 Resistor', placement: 'two-lead', pins: [] }],
    ['pot-side-turn', { id: 'pot-side-turn', name: 'Potentiometer', placement: 'footprint', pins: [] }],
    ['led-red', { id: 'led-red', name: 'Red LED', placement: 'two-lead', pins: [] }],
    ['cap-100nf', { id: 'cap-100nf', name: '100 nF Cap', placement: 'two-lead', pins: [] }],
    ['opamp-dual-dip8', { id: 'opamp-dual-dip8', name: 'Dual Op-Amp', placement: 'footprint', pins: [] }],
    ['inamp-ad620', { id: 'inamp-ad620', name: 'AD620', placement: 'footprint', pins: [] }]
  ]);
}

test('normalizeSimConfig clamps invalid values and preserves unknown future keys', () => {
  const normalized = normalizeSimConfig({
    powered: false,
    elvisSupplyPos: 99,
    elvisSupplyNeg: -99,
    loadCellForceGrams: 5000,
    futureBodeSetting: { startHz: 10, stopHz: 10000 },
    arduinoPinStates: { D2: true }
  });

  assert.equal(normalized.powered, false);
  assert.equal(normalized.elvisSupplyPos, 15);
  assert.equal(normalized.elvisSupplyNeg, -15);
  assert.equal(normalized.loadCellForceGrams, 1000);
  assert.deepEqual(normalized.arduinoPinStates, { D2: true });
  assert.deepEqual(normalized.futureBodeSetting, { startHz: 10, stopHz: 10000 });
});

test('BenchController handles probe picking, pruning, fast simulation tick, and persistence preservation', () => {
  const breadboard = new BreadboardModel({ elvisMode: true });
  const catalogMap = createFakeCatalogMap();
  let placedParts = [];
  let wires = [
    { id: 'w1', holeA: 'ELV_51D', holeB: 'a20', color: '#ef4444', colorName: 'Red' },
    { id: 'w2', holeA: 'ELV_53D', holeB: 'a21', color: '#1e293b', colorName: 'Black' }
  ];
  let connectivity = analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  let interactionMode = 'probe-red';
  let saveCalls = 0;
  let warnCalls = 0;

  const bench = createBenchController({
    getBoardContext: () => ({
      breadboard,
      connectivity,
      placedParts,
      wires,
      catalogMap,
      runtimeOverlayLayer: null
    }),
    getInteractionMode: () => interactionMode,
    setInteractionMode: (mode) => {
      interactionMode = mode;
    },
    onWarningsAndStatusRefresh: () => {
      warnCalls++;
    },
    onSave: () => {
      saveCalls++;
    }
  });

  // Handle probe-red hole pick
  assert.equal(bench.handleProbeHolePicked('probe-red', { id: 'e20' }), true);
  assert.equal(bench.dmmState.probeRed, 'e20');
  assert.equal(interactionMode, 'build');
  assert.ok(bench.dcResult);
  assert.ok(Math.abs(bench.dcResult.getHoleVoltage('e20') - 15) < 1e-6);
  assert.equal(warnCalls, 1);
  assert.equal(saveCalls, 1);

  // Handle remaining probe modes
  assert.equal(bench.handleProbeHolePicked('probe-black', { id: 'e21' }), true);
  assert.equal(bench.dmmState.probeBlack, 'e21');
  assert.equal(bench.handleProbeHolePicked('probe-fgen', { id: 'f10' }), true);
  assert.equal(bench.simConfig.fgen.probeHole, 'f10');
  assert.equal(bench.handleProbeHolePicked('probe-scope-ch0', { id: 'f11' }), true);
  assert.equal(bench.scopeState.ch0.probeHole, 'f11');
  assert.equal(bench.handleProbeHolePicked('probe-scope-ch1', { id: 'f12' }), true);
  assert.equal(bench.scopeState.ch1.probeHole, 'f12');
  assert.equal(bench.handleProbeHolePicked('build', { id: 'a1' }), false);

  // Prune invalid probes when switching off ELVIS mode
  bench.dmmState.probeRed = 'ELV_51D';
  breadboard.configure({ elvisMode: false });
  bench.pruneInvalidProbes();
  assert.equal(bench.dmmState.probeRed, null);

  // Unknown future keys survive applySimState -> getSimStateSnapshot round-trip
  bench.applySimState({
    simConfig: { powered: false, futureSimKey: 42 },
    futureIdeBuffer: 'void setup() {}',
    futureBodeConfig: { pointsPerDecade: 10 }
  });
  const snap = bench.getSimStateSnapshot();
  assert.equal(snap.simConfig.powered, false);
  assert.equal(snap.simConfig.futureSimKey, 42);
  assert.equal(snap.futureIdeBuffer, 'void setup() {}');
  assert.deepEqual(snap.futureBodeConfig, { pointsPerDecade: 10 });
});

test('BenchController loadPreset resets topology and loads preset state cleanly', () => {
  const breadboard = new BreadboardModel({ elvisMode: false });
  let resetPayload = null;
  const presetSelect = { value: '' };

  const bench = createBenchController({
    presetSelect,
    getBoardContext: () => ({ breadboard }),
    onCircuitTopologyReset: (payload) => {
      resetPayload = payload;
    }
  });

  bench.loadPreset(LAB_PRESETS[4].id); // rc-lowpass
  assert.ok(resetPayload);
  assert.equal(resetPayload.boardConfig.elvisMode, true);
  assert.equal(presetSelect.value, 'rc-lowpass');
  assert.equal(bench.simConfig.fgen.enabled, true);
  assert.equal(bench.simConfig.fgen.frequencyHz, 1592);
});
