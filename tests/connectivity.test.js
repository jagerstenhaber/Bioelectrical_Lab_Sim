import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = path.resolve(__dirname, '../parts');

function loadPartDef(partId) {
  const raw = fs.readFileSync(path.join(PARTS_DIR, partId, 'part.json'), 'utf8');
  return JSON.parse(raw);
}

function buildCatalogMap(partIds) {
  const map = new Map();
  for (const id of partIds) {
    map.set(id, loadPartDef(id));
  }
  return map;
}

const CATALOG = buildCatalogMap([
  'arduino-nano',
  'opamp-dual-dip8',
  'inamp-ad620',
  'pushbutton-4pin',
  'resistor-1k-1pct'
]);

test('Two strips connected by a jumper wire merge into one net', () => {
  const bb = new BreadboardModel();
  const wires = [
    { id: 'w1', holeA: 'a1', holeB: 'a5', colorName: 'Blue' }
  ];

  const result = analyzeCircuit(bb, [], wires, CATALOG);
  const netA1 = result.getNetForHole('a1');
  const netE1 = result.getNetForHole('e1');
  const netC5 = result.getNetForHole('c5');
  const netA2 = result.getNetForHole('a2');

  assert.ok(netA1);
  assert.equal(netA1, netE1);
  assert.equal(netA1, netC5);
  assert.notEqual(netA1, netA2);
  assert.equal(netA1.strips.has('TERM_TOP_1'), true);
  assert.equal(netA1.strips.has('TERM_TOP_5'), true);
  assert.equal(netA1.wires.has('w1'), true);
  assert.equal(result.warnings.length, 0);
});

test('Direct power-to-ground short circuit triggers warning and sets net.isShorted for Arduino Nano 5V-to-GND', () => {
  const bb = new BreadboardModel();
  // Arduino Nano at d2: 5V (dx=11, dy=6) -> h13, GND_TOP (dx=11, dy=0) -> d13
  const placedParts = [
    { id: 'nano1', partId: 'arduino-nano', anchorHoleId: 'd2', rotation: 0 }
  ];
  const wires = [
    { id: 'w1', holeA: 'j13', holeB: 'a13', colorName: 'Red' }
  ];

  const result = analyzeCircuit(bb, placedParts, wires, CATALOG);
  assert.equal(result.getPinHole('nano1', '5V').id, 'h13');
  assert.equal(result.getPinHole('nano1', 'GND_TOP').id, 'd13');

  const net = result.getNetForHole('j13');
  assert.equal(net.isShorted, true);
  assert.equal(net.hasPower, true);
  assert.equal(net.hasGround, true);
  assert.ok(
    result.warnings.some((w) => w.netId === net.id && /Short circuit detected!/i.test(w.message))
  );
});

test('Direct power-to-ground short circuit triggers warning and sets net.isShorted for ELVIS +15V-to-GROUND', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // ELVIS Row 51 is +15V, Row 49 is GROUND
  const wires = [
    { id: 'w1', holeA: 'ELV_51A', holeB: 'ELV_49A', colorName: 'Black' }
  ];

  const result = analyzeCircuit(bb, [], wires, CATALOG);
  const net = result.getNetForHole('ELV_51A');

  assert.equal(net.isShorted, true);
  assert.equal(net.hasPower, true);
  assert.equal(net.hasGround, true);
  assert.equal(net.powerLabels.has('ELVIS +15V'), true);
  assert.ok(
    result.warnings.some(
      (w) => w.netId === net.id && /Short circuit detected!.*ELVIS \+15V/i.test(w.message)
    )
  );
});

test('Voltage conflict (ELVIS +5V wired to +15V) triggers warning', () => {
  const bb = new BreadboardModel({ elvisMode: true });
  // ELVIS Row 54 is +5V, Row 51 is +15V
  const wires = [
    { id: 'w1', holeA: 'ELV_54B', holeB: 'ELV_51B', colorName: 'Orange' }
  ];

  const result = analyzeCircuit(bb, [], wires, CATALOG);
  const net = result.getNetForHole('ELV_54B');

  assert.equal(net.isShorted, true);
  assert.equal(net.powerLabels.has('ELVIS +5V'), true);
  assert.equal(net.powerLabels.has('ELVIS +15V'), true);
  assert.ok(
    result.warnings.some(
      (w) => w.netId === net.id && /Voltage conflict!/i.test(w.message)
    )
  );
});

test('Self-shorted 2-lead resistor (both leads in same strip) triggers warning', () => {
  const bb = new BreadboardModel();
  const placedParts = [
    {
      id: 'r1',
      partId: 'resistor-1k-1pct',
      pinHoles: { P1: 'a10', P2: 'e10' }
    }
  ];

  const result = analyzeCircuit(bb, placedParts, [], CATALOG);
  const net = result.getNetForHole('a10');

  assert.equal(net.isShorted, true);
  assert.ok(
    result.warnings.some(
      (w) => w.netId === net.id && /Component shorted to itself!/i.test(w.message)
    )
  );
});

test('DIP-8 IC placed without straddling the trough triggers IC placement error warning', () => {
  const bb = new BreadboardModel();
  // Placed at a20 (gridY=3) so dy=0 -> row a (gridY=3) and dy=3 -> row d (gridY=6), both in TERM_TOP_20..23
  const badPlaced = [
    { id: 'ic1', partId: 'opamp-dual-dip8', anchorHoleId: 'a20', rotation: 0 }
  ];

  const badResult = analyzeCircuit(bb, badPlaced, [], CATALOG);
  const net = badResult.getNetForHole('a20');
  assert.equal(net.isShorted, true);
  assert.ok(
    badResult.warnings.some((w) => /IC placement error!.*straddle the center trough/i.test(w.message))
  );

  // Placed properly at e20 (straddling trough from e to f) produces no IC placement error
  const goodPlaced = [
    { id: 'ic1', partId: 'opamp-dual-dip8', anchorHoleId: 'e20', rotation: 0 }
  ];
  const goodResult = analyzeCircuit(bb, goodPlaced, [], CATALOG);
  assert.equal(goodResult.warnings.length, 0);
});

test('Crowded hole (two wires/leads in exact same hole) triggers crowded hole warning', () => {
  const bb = new BreadboardModel();
  const wires = [
    { id: 'w1', holeA: 'a15', holeB: 'a16', colorName: 'Green' },
    { id: 'w2', holeA: 'a15', holeB: 'a18', colorName: 'Yellow' }
  ];

  const result = analyzeCircuit(bb, [], wires, CATALOG);
  assert.equal(result.getOccupants('a15').length, 2);
  assert.ok(
    result.warnings.some((w) => /Crowded hole \(a15\): 2 leads\/wires share one hole/i.test(w.message))
  );
});

test('Pushbutton internal nets ([P1,P3], [P2,P4]) union properly without false IC placement errors', () => {
  const bb = new BreadboardModel();
  // Placed straddling trough at e34: P1=e34, P2=e36, P3=f34, P4=f36
  const placedParts = [
    { id: 'sw1', partId: 'pushbutton-4pin', anchorHoleId: 'e34', rotation: 0 }
  ];

  const result = analyzeCircuit(bb, placedParts, [], CATALOG);

  assert.equal(result.getPinHole('sw1', 'P1').id, 'e34');
  assert.equal(result.getPinHole('sw1', 'P2').id, 'e36');
  assert.equal(result.getPinHole('sw1', 'P3').id, 'f34');
  assert.equal(result.getPinHole('sw1', 'P4').id, 'f36');

  const netLeft = result.getNetForHole('a34');
  const netRight = result.getNetForHole('a36');
  assert.equal(netLeft, result.getNetForHole('j34'));
  assert.equal(netRight, result.getNetForHole('j36'));
  assert.notEqual(netLeft, netRight);
  assert.equal(result.warnings.length, 0);

  // Even when placed on one side of the trough (a34 -> P1=a34, P3=d34), internalNets prevent false IC errors
  const oneSideParts = [
    { id: 'sw2', partId: 'pushbutton-4pin', anchorHoleId: 'a34', rotation: 0 }
  ];
  const oneSideResult = analyzeCircuit(bb, oneSideParts, [], CATALOG);
  assert.equal(oneSideResult.warnings.length, 0);
});
