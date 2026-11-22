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
  assert.equal(normalized.elvisSupplyPos, 12);
  assert.equal(normalized.elvisSupplyNeg, -12);
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
  bench.destroy();
});

test('BenchController persists arduinoState code, stops runner when power off or Nano removed, and cleans up on destroy()', () => {
  const breadboard = new BreadboardModel({ elvisMode: false });
  const catalogMap = createFakeCatalogMap();
  let placedParts = [];
  const wires = [];
  let connectivity = analyzeCircuit(breadboard, placedParts, wires, catalogMap);

  const bench = createBenchController({
    getBoardContext: () => ({
      breadboard,
      connectivity,
      placedParts,
      wires,
      catalogMap,
      runtimeOverlayLayer: null
    })
  });

  // Restore saved Arduino code via applySimState
  const customCode = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(50); }';
  bench.applySimState({
    simConfig: { powered: true },
    arduinoState: { code: customCode }
  });
  assert.equal(bench.arduinoCode, customCode);
  assert.equal(bench.arduinoRunner.getState().running, false);

  // Without a placed Arduino Nano, startArduinoSketch refuses to run
  const noNanoRes = bench.startArduinoSketch(customCode, { save: false });
  assert.equal(noNanoRes.ok, false);

  // With a placed Arduino Nano and power ON, startArduinoSketch runs and setSimPower(false) stops it
  placedParts = [{ id: 'nano_1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 }];
  connectivity = analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  const started = bench.startArduinoSketch(customCode, { save: false });
  assert.equal(started.ok, true);
  assert.equal(bench.arduinoRunner.getState().running, true);

  bench.setSimPower(false);
  assert.equal(bench.arduinoRunner.getState().running, false);

  // Removing Nano while running stops runner and clears arduinoPinStates
  bench.setSimPower(true);
  bench.startArduinoSketch(customCode, { save: false });
  assert.equal(bench.arduinoRunner.getState().running, true);
  placedParts = [];
  connectivity = analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  bench.runSimulation();
  assert.equal(bench.arduinoRunner.getState().running, false);
  assert.deepEqual(bench.simConfig.arduinoPinStates, {});

  // getSimStateSnapshot always serializes empty arduinoPinStates: {} (Blocker #4)
  bench.simConfig.arduinoPinStates = { D9: { mode: 'PWM', dutyCycle: 128, freqHz: 490 } };
  const snap = bench.getSimStateSnapshot();
  assert.equal(snap.arduinoState.code, customCode);
  assert.deepEqual(snap.simConfig.arduinoPinStates, {});

  // Compile error clears arduinoPinStates cleanly
  placedParts = [{ id: 'nano_1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 }];
  connectivity = analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  bench.simConfig.arduinoPinStates = { D13: { mode: 'OUTPUT', voltage: 5 } };
  const badCompile = bench.startArduinoSketch('void setup() { bad syntax !!!', { save: false });
  assert.equal(badCompile.ok, false);
  assert.deepEqual(bench.simConfig.arduinoPinStates, {});

  // applySimState resets arduinoPinStates to {} even if saved state contained pin states
  bench.applySimState({
    simConfig: { powered: true, arduinoPinStates: { D13: { mode: 'OUTPUT', voltage: 5 } } },
    arduinoState: { code: customCode }
  });
  assert.deepEqual(bench.simConfig.arduinoPinStates, {});

  bench.destroy();
});

test('normalizeSimConfig preserves vpsEnabled and BenchController handles [V] shortcut & live EMG/FGEN readArduinoPinVoltage()', () => {
  assert.equal(normalizeSimConfig({}).vpsEnabled, true);
  assert.equal(normalizeSimConfig({ vpsEnabled: false }).vpsEnabled, false);

  const toggledTabs = [];
  const bb = new BreadboardModel({ elvisMode: true, emgMode: true, sensorPosition: 'right' });
  const catalogMap = new Map([
    [
      'arduino-nano',
      {
        id: 'arduino-nano',
        name: 'Arduino Nano',
        placement: 'footprint',
        pins: [
          { id: 'A0', label: 'A0', dx: 3, dy: 6, role: 'analog' },
          { id: 'D9', label: 'D9', dx: 4, dy: 6, role: 'digital' },
          { id: 'GND_BOT', label: 'GND', dx: 13, dy: 6, role: 'ground' }
        ],
        internalNets: []
      }
    ]
  ]);
  const placedParts = [{ id: 'nano_1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 90 }];
  // Wire FGEN (ELV_33D) directly to A0 (j5) and Nano GND_BOT (j15) to ELVIS GROUND (ELV_53D)
  const wires = [
    { id: 'w_fgen', holeA: 'ELV_33D', holeB: 'j5', colorName: 'Orange' },
    { id: 'w_gnd', holeA: 'j15', holeB: 'ELV_53D', colorName: 'Black' }
  ];
  const connectivity = analyzeCircuit(bb, placedParts, wires, catalogMap);

  const bench = createBenchController({
    getBoardContext: () => ({
      breadboard: bb,
      connectivity,
      placedParts,
      wires,
      catalogMap,
      runtimeOverlayLayer: null
    })
  });
  bench.workspaceManager = {
    toggleDock(tabId) {
      toggledTabs.push(tabId);
    },
    isInstrumentVisible() {
      return false;
    }
  };

  assert.equal(bench.handleKeydownShortcut('v'), true);
  assert.deepEqual(toggledTabs, ['vps']);

  // Enable 1 Hz sine FGEN: 2.0 Vpp, +2.5 V DC offset -> at t=0 s, v = 2.5 V; at t=0.25 s, v = 3.5 V
  bench.simConfig.powered = true;
  bench.simConfig.fgen = {
    enabled: true,
    waveform: 'sine',
    frequencyHz: 1,
    amplitudeVpp: 2.0,
    dcOffsetV: 2.5,
    dutyCycle: 50,
    probeHole: null
  };

  let fakeElapsedMs = 0;
  let fakeRunning = true;
  bench.arduinoRunner = {
    getElapsedMs: () => fakeElapsedMs,
    getState: () => ({ running: fakeRunning, elapsedMs: fakeElapsedMs, pinStates: {} }),
    stop() {},
    reset() {}
  };

  // Decouple arduinoDcDirty from lastInstantSolve: readArduinoPinVoltage must NOT clear arduinoDcDirty
  bench.arduinoDcDirty = true;
  const vAt0 = bench.readArduinoPinVoltage('A0');
  assert.ok(Math.abs(vAt0 - 2.5) < 0.05, `Expected ~2.5 V at t=0 s, got ${vAt0}`);
  assert.equal(bench.arduinoDcDirty, true);

  fakeElapsedMs = 250; // 0.25 s -> +1.0 V peak -> 3.5 V
  const vAtQuarter = bench.readArduinoPinVoltage('A0');
  assert.ok(Math.abs(vAtQuarter - 3.5) < 0.05, `Expected ~3.5 V at t=0.25 s, got ${vAtQuarter}`);

  // Important #5: getArduinoPinVoltages uses lastInstantSolve.result when runner is active with EMG/FGEN
  const livePins = bench.getArduinoPinVoltages();
  assert.ok(Math.abs(livePins.A0 - 3.5) < 0.05, `Expected live Pin Monitor A0 ~3.5 V, got ${livePins.A0}`);

  // runFastArduinoTick clears arduinoDcDirty, re-solves dcResult, and invalidates lastInstantSolve
  bench.runFastArduinoTick();
  assert.equal(bench.arduinoDcDirty, false);
  assert.deepEqual(bench.lastInstantSolve, { tSec: null, result: null });
  assert.ok(bench.dcResult);

  // When power is OFF, readArduinoPinVoltage returns 0 and cache clears on resetTransientAndBode
  bench.simConfig.powered = false;
  assert.equal(bench.readArduinoPinVoltage('A0'), 0);
  bench.resetTransientAndBode();
  assert.deepEqual(bench.lastInstantSolve, { tSec: null, result: null });

  bench.arduinoRunner = null;
  bench.workspaceManager = null;
  bench.destroy();
});
