import test from 'node:test';
import assert from 'node:assert/strict';

import { BreadboardModel } from '../js/breadboard.js';
import {
  serializeCircuitState,
  parseCircuitState,
  createStarterCircuit
} from '../js/persistence.js';

test('serializeCircuitState serializes breadboard config, parts, wires, and optional extras as v5', () => {
  const bb = new BreadboardModel({
    elvisMode: true,
    loadCellsMode: true,
    emgMode: false,
    sensorPosition: 'bottom'
  });
  const placedParts = [
    { id: 'p1', partId: 'resistor-1k-1pct', pinHoles: { P1: 'a1', P2: 'a5' }, props: { tolerance: 1 } }
  ];
  const wires = [{ id: 'w1', holeA: 'e1', holeB: 'e5', color: '#ef4444', colorName: 'Red' }];
  const simState = { running: true, speed: 1 };
  const props = { author: 'lab-user' };

  const payload = serializeCircuitState(bb, placedParts, wires, {
    name: 'my-circuit',
    exportedAt: '2026-11-20T00:00:00.000Z',
    simState,
    props
  });

  assert.equal(payload.version, 5);
  assert.equal(payload.elvisMode, true);
  assert.equal(payload.loadCellsMode, true);
  assert.equal(payload.emgMode, false);
  assert.equal(payload.sensorPosition, 'bottom');
  assert.deepEqual(payload.placedParts, placedParts);
  assert.deepEqual(payload.wires, wires);
  assert.equal(payload.name, 'my-circuit');
  assert.equal(payload.exportedAt, '2026-11-20T00:00:00.000Z');
  assert.deepEqual(payload.simState, simState);
  assert.deepEqual(payload.props, props);

  // Fallback defaults when breadboard or arrays are missing
  const emptyPayload = serializeCircuitState(null, null, null);
  assert.equal(emptyPayload.version, 5);
  assert.equal(emptyPayload.elvisMode, false);
  assert.equal(emptyPayload.sensorPosition, 'auto');
  assert.deepEqual(emptyPayload.placedParts, []);
  assert.deepEqual(emptyPayload.wires, []);
});

test('parseCircuitState parses v4 legacy glowing-waddle JSON payloads', () => {
  const legacyV4 = {
    elvisMode: 1,
    placedParts: [
      { id: 'nano1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 },
      { id: 'r1', partId: 'resistor-10k-1pct', pinHoles: { P1: 'h23', P2: 'h27' } }
    ],
    wires: [{ id: 'w1', holeA: 'a1', holeB: 'b2' }],
    sensorPosition: 'diagonal' // invalid value should normalize to 'auto'
  };

  const parsed = parseCircuitState(legacyV4);
  assert.ok(parsed);
  assert.equal(parsed.version, 4);
  assert.equal(parsed.elvisMode, true);
  assert.equal(parsed.loadCellsMode, false);
  assert.equal(parsed.emgMode, false);
  assert.equal(parsed.sensorPosition, 'auto');
  assert.equal(parsed.placedParts.length, 2);
  assert.equal(parsed.wires.length, 1);
  assert.equal('simState' in parsed, false);
  assert.equal('props' in parsed, false);
});

test('parseCircuitState parses v5 payloads preserving part props and simState', () => {
  const v5Payload = {
    version: 5,
    elvisMode: false,
    loadCellsMode: false,
    emgMode: true,
    sensorPosition: 'left',
    placedParts: [
      {
        id: 'pot1',
        partId: 'pot-top-turn',
        anchorHoleId: 'e10',
        rotation: 0,
        props: { wiper: 0.5 }
      }
    ],
    wires: [{ id: 'w1', holeA: 'a10', holeB: 'TP10' }],
    props: { circuitNotes: 'EMG stage' },
    simState: { gain: 100, notch60Hz: true }
  };

  const parsed = parseCircuitState(v5Payload);
  assert.ok(parsed);
  assert.equal(parsed.version, 5);
  assert.equal(parsed.emgMode, true);
  assert.equal(parsed.sensorPosition, 'left');
  assert.deepEqual(parsed.placedParts[0].props, { wiper: 0.5 });
  assert.deepEqual(parsed.props, { circuitNotes: 'EMG stage' });
  assert.deepEqual(parsed.simState, { gain: 100, notch60Hz: true });
});

test('parseCircuitState returns null for malformed or null inputs', () => {
  assert.equal(parseCircuitState(null), null);
  assert.equal(parseCircuitState(undefined), null);
  assert.equal(parseCircuitState('{"placedParts":[]}'), null);
  assert.equal(parseCircuitState([]), null);
  assert.equal(parseCircuitState({}), null);
  assert.equal(parseCircuitState({ placedParts: 'bad', wires: [] }), null);
  assert.equal(parseCircuitState({ placedParts: [], wires: null }), null);

  // Invalid part entries
  assert.equal(
    parseCircuitState({ placedParts: [null], wires: [] }),
    null
  );
  assert.equal(
    parseCircuitState({ placedParts: [{ id: 'p1', anchorHoleId: 'a1' }], wires: [] }),
    null
  );
  assert.equal(
    parseCircuitState({ placedParts: [{ id: 'p1', partId: 'resistor-1k-1pct' }], wires: [] }),
    null
  );

  // Invalid wire entries
  assert.equal(
    parseCircuitState({ placedParts: [], wires: [{ holeA: 'a1' }] }),
    null
  );
  assert.equal(
    parseCircuitState({ placedParts: [], wires: [{ holeA: 123, holeB: 'a2' }] }),
    null
  );
});

test('createStarterCircuit builds starter parts and wires for standard and ELVIS modes', () => {
  let seq = 0;
  const genId = (prefix = 'id') => `${prefix}_${++seq}`;

  const stdStarter = createStarterCircuit(false, genId);
  assert.equal(stdStarter.placedParts.length, 5);
  assert.equal(stdStarter.wires.length, 6);
  assert.equal(stdStarter.placedParts[0].partId, 'arduino-nano');
  assert.equal(stdStarter.placedParts[0].rotation, 0);
  assert.equal(stdStarter.placedParts[1].partId, 'opamp-dual-dip8');
  assert.equal(stdStarter.placedParts[1].rotation, 0);
  assert.ok(stdStarter.placedParts[0].id.startsWith('arduino-nano_'));
  assert.ok(stdStarter.wires[0].id.startsWith('wire_'));

  const elvisStarter = createStarterCircuit(true, genId);
  assert.equal(elvisStarter.placedParts[0].rotation, 90);
  assert.equal(elvisStarter.placedParts[1].rotation, 90);

  // Round-trip through serialize -> parse
  const bb = new BreadboardModel({ elvisMode: true });
  const serialized = serializeCircuitState(bb, elvisStarter.placedParts, elvisStarter.wires);
  const parsed = parseCircuitState(serialized);
  assert.ok(parsed);
  assert.equal(parsed.elvisMode, true);
  assert.equal(parsed.placedParts.length, 5);
  assert.equal(parsed.wires.length, 6);
});
