import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BreadboardModel,
  BOARD_ORIGIN_X,
  BOARD_ORIGIN_Y,
  PITCH,
  ROW_GRID_Y,
  ELVIS_UPPER_ROWS,
  ELVIS_LOWER_ROWS,
  STANDARD_BOARD_VIEWBOX,
  getRotatedPinOffset,
  getPowerRailColumns,
  computeEffectiveMaxZoom
} from '../js/breadboard.js';

const DIP8_PART = {
  id: 'test-dip8',
  name: 'Test DIP-8 IC',
  placement: 'footprint',
  pins: [
    { id: 'P8', dx: 0, dy: 0 },
    { id: 'P7', dx: 1, dy: 0 },
    { id: 'P6', dx: 2, dy: 0 },
    { id: 'P5', dx: 3, dy: 0 },
    { id: 'P1', dx: 0, dy: 3 },
    { id: 'P2', dx: 1, dy: 3 },
    { id: 'P3', dx: 2, dy: 3 },
    { id: 'P4', dx: 3, dy: 3 }
  ]
};

test('Standard horizontal mode builds 830 tie points with proper strip grouping', () => {
  const bb = new BreadboardModel();

  assert.equal(bb.elvisMode, false);
  assert.equal(bb.holes.size, 830);

  let railCount = 0;
  let terminalCount = 0;
  for (const hole of bb.holes.values()) {
    if (hole.type === 'rail') railCount++;
    else if (hole.type === 'terminal') terminalCount++;
  }
  assert.equal(railCount, 200);
  assert.equal(terminalCount, 630);

  // Power rails: 4 rails x 50 columns
  const railCols = getPowerRailColumns();
  assert.equal(railCols.length, 50);

  for (const railId of ['RAIL_TP_ALL', 'RAIL_TN_ALL', 'RAIL_BP_ALL', 'RAIL_BN_ALL']) {
    const strip = bb.getStripHoles(railId);
    assert.equal(strip.length, 50);
  }
  assert.equal(bb.getHole('TP3').stripId, 'RAIL_TP_ALL');
  assert.equal(bb.getHole('BN61').stripId, 'RAIL_BN_ALL');
  assert.equal(bb.getHole('TP1'), null); // gap before first 5-hole group

  // Terminal strips: 63 columns, 5 holes top (a-e) and 5 holes bottom (f-j)
  const top1 = bb.getStripHoles('TERM_TOP_1');
  const bot1 = bb.getStripHoles('TERM_BOT_1');
  assert.deepEqual(top1.map((h) => h.id), ['a1', 'b1', 'c1', 'd1', 'e1']);
  assert.deepEqual(bot1.map((h) => h.id), ['f1', 'g1', 'h1', 'i1', 'j1']);

  assert.equal(bb.getHole('c63').stripId, 'TERM_TOP_63');
  assert.equal(bb.getHole('h63').stripId, 'TERM_BOT_63');
  assert.equal(bb.strips.size, 4 + 63 + 63);
});

test('NI ELVIS II mode adds 216 ELVIS holes and rotates breadboard 90 degrees CW', () => {
  const bb = new BreadboardModel({ elvisMode: true });

  assert.equal(bb.holes.size, 830 + 216);

  const elvisHoles = Array.from(bb.holes.values()).filter((h) => h.type === 'elvis');
  assert.equal(elvisHoles.length, 216);
  assert.equal(ELVIS_UPPER_ROWS.length, 27);
  assert.equal(ELVIS_LOWER_ROWS.length, 27);

  // Upper block rows 1-27, cols A-D
  const upperRow1 = bb.getStripHoles('ELVIS_ROW_1');
  assert.deepEqual(upperRow1.map((h) => h.id), ['ELV_1A', 'ELV_1B', 'ELV_1C', 'ELV_1D']);
  assert.equal(upperRow1[0].elvisLabel, 'AI 0+');
  assert.equal(upperRow1[0].gridX, -7);
  assert.equal(upperRow1[0].gridY, 2);

  // Lower block rows 28-54, cols A-D
  const lowerRow54 = bb.getStripHoles('ELVIS_ROW_54');
  assert.deepEqual(lowerRow54.map((h) => h.id), ['ELV_54A', 'ELV_54B', 'ELV_54C', 'ELV_54D']);
  assert.equal(lowerRow54[3].elvisLabel, '+5V');
  assert.equal(lowerRow54[3].gridX, -4);
  assert.equal(lowerRow54[3].gridY, 60);

  // Verify 90 deg CW rotation via mapBbToGrid
  const stdBb = new BreadboardModel({ elvisMode: false });
  assert.deepEqual(stdBb.mapBbToGrid(1, ROW_GRID_Y['a']), { gridX: 0, gridY: 3 });
  assert.deepEqual(bb.mapBbToGrid(1, ROW_GRID_Y['a']), { gridX: 14, gridY: 0 });
  assert.deepEqual(bb.mapBbToGrid(63, ROW_GRID_Y['TP']), { gridX: 17, gridY: 62 });
  assert.deepEqual(bb.mapBbToGrid(63, ROW_GRID_Y['BN']), { gridX: 0, gridY: 62 });

  const holeA1 = bb.getHole('a1');
  assert.equal(holeA1.gridX, 14);
  assert.equal(holeA1.gridY, 0);
  assert.equal(bb.getHoleAtGrid(14, 0), holeA1);
});

test('External sensors add Load Cell (30) and EMG (9) holes and rotateSensorPosition cycles sides', () => {
  const bb = new BreadboardModel({ loadCellsMode: true });
  const lcSensorHoles = Array.from(bb.holes.values()).filter((h) => h.type === 'sensor');
  assert.equal(lcSensorHoles.length, 30); // Full-Bridge (4x3=12) + HB1 (3x3=9) + HB2 (3x3=9)
  assert.equal(bb.holes.size, 860);

  assert.equal(bb.getStripHoles('SENSOR_LC_FB_RED').length, 3);
  assert.equal(bb.getStripHoles('SENSOR_LC_HB1_WHT').length, 3);
  assert.equal(bb.getStripHoles('SENSOR_LC_HB2_BLK').length, 3);

  bb.setEmgMode(true);
  const allSensorHoles = Array.from(bb.holes.values()).filter((h) => h.type === 'sensor');
  assert.equal(allSensorHoles.length, 39); // 30 + 3x3=9 EMG holes
  assert.equal(bb.holes.size, 869);
  assert.equal(bb.getStripHoles('SENSOR_EMG_RED1').length, 3);

  const emgOnly = new BreadboardModel({ emgMode: true });
  assert.equal(
    Array.from(emgOnly.holes.values()).filter((h) => h.type === 'sensor').length,
    9
  );
  assert.equal(emgOnly.holes.size, 839);

  // rotateSensorPosition cycles top -> right -> bottom -> left -> top
  assert.equal(bb.getEffectiveSensorSide(), 'top');
  assert.equal(bb.rotateSensorPosition(), 'right');
  assert.equal(bb.rotateSensorPosition(), 'bottom');
  assert.equal(bb.rotateSensorPosition(), 'left');
  assert.equal(bb.rotateSensorPosition(), 'top');

  // Verify sensor layout orientation updates with rotation
  assert.equal(bb.getExternalSensorsLayout().orientation, 'horizontal-row');
  bb.rotateSensorPosition(); // -> right
  assert.equal(bb.getExternalSensorsLayout().orientation, 'vertical-stack');
});

test('getRotatedPinOffset rotates offsets in 90-degree clockwise increments', () => {
  const pin = { dx: 2, dy: 3 };

  assert.deepEqual(getRotatedPinOffset(pin, 0), { dx: 2, dy: 3 });
  assert.deepEqual(getRotatedPinOffset(pin, 90), { dx: -3, dy: 2 });
  assert.deepEqual(getRotatedPinOffset(pin, 180), { dx: -2, dy: -3 });
  assert.deepEqual(getRotatedPinOffset(pin, 270), { dx: 3, dy: -2 });
  assert.deepEqual(getRotatedPinOffset(pin, 360), { dx: 2, dy: 3 });
  assert.deepEqual(getRotatedPinOffset(pin, -90), { dx: 3, dy: -2 });
});

test('isFootprintValidAt and findBestFootprintAnchor work for DIP-8 IC straddling the trough', () => {
  const bb = new BreadboardModel();

  // Row 'e' (gridY = 7) puts dy=0 on row 'e' (gridY=7) and dy=3 on row 'f' (gridY=10)
  assert.equal(bb.isFootprintValidAt(DIP8_PART, 19, ROW_GRID_Y['e'], 0), true);

  // Row 'c' (gridY = 5) puts dy=3 on gridY=8 (center trough, no holes)
  assert.equal(bb.isFootprintValidAt(DIP8_PART, 19, ROW_GRID_Y['c'], 0), false);

  // Out of horizontal bounds (col 61 -> gridX=60, dx=3 -> gridX=63)
  assert.equal(bb.isFootprintValidAt(DIP8_PART, 60, ROW_GRID_Y['e'], 0), false);

  // Find anchor when targeting col 20, row e
  const targetX = BOARD_ORIGIN_X + 19 * PITCH;
  const targetY = BOARD_ORIGIN_Y + ROW_GRID_Y['e'] * PITCH;
  const exact = bb.findBestFootprintAnchor(DIP8_PART, targetX, targetY, 0);
  assert.deepEqual(exact, {
    gridX: 19,
    gridY: 7,
    anchorHoleId: 'e20'
  });

  // When dragged slightly inside the upper edge of the trough (gridY = 8.2), snaps to row 'e' (e20)
  const troughTargetY = BOARD_ORIGIN_Y + 8.2 * PITCH;
  const snapped = bb.findBestFootprintAnchor(DIP8_PART, targetX, troughTargetY, 0);
  assert.deepEqual(snapped, {
    gridX: 19,
    gridY: 7,
    anchorHoleId: 'e20'
  });

  // In NI ELVIS II vertical mode (90 deg rotation), straddling e -> f at row 20
  const elvisBb = new BreadboardModel({ elvisMode: true });
  const e20 = elvisBb.getHole('e20');
  assert.equal(elvisBb.isFootprintValidAt(DIP8_PART, e20.gridX, e20.gridY, 90), true);
  const elvisAnchor = elvisBb.findBestFootprintAnchor(DIP8_PART, e20.x, e20.y, 90);
  assert.deepEqual(elvisAnchor, {
    gridX: e20.gridX,
    gridY: e20.gridY,
    anchorHoleId: 'e20'
  });
});

test('computeEffectiveMaxZoom matches physical max zoom across standard, NI ELVIS II, and sensor layouts', () => {
  const viewport = { width: 980, height: 580 };
  const stdBb = new BreadboardModel({ elvisMode: false });
  const stdVb = stdBb.getBoardViewBox();

  assert.equal(stdVb.width, STANDARD_BOARD_VIEWBOX.width);
  assert.equal(stdVb.height, STANDARD_BOARD_VIEWBOX.height);

  // Standard breadboard keeps baseMaxZoom (2.6)
  const stdMaxZoom = computeEffectiveMaxZoom(stdVb, viewport, 2.6);
  assert.equal(stdMaxZoom, 2.6);

  // NI ELVIS II mode scales proportionally (~4.3x at 980x580) so screen px per SVG unit matches standard mode
  const elvisBb = new BreadboardModel({ elvisMode: true });
  const elvisVb = elvisBb.getBoardViewBox();
  const elvisMaxZoom = computeEffectiveMaxZoom(elvisVb, viewport, 2.6);
  assert.ok(elvisMaxZoom > 4.0 && elvisMaxZoom < 5.0, `Expected ~4.3x max zoom, got ${elvisMaxZoom}`);

  const stdPxPerSvgUnit =
    Math.min(viewport.width / stdVb.width, viewport.height / stdVb.height) * stdMaxZoom;
  const elvisPxPerSvgUnit =
    Math.min(viewport.width / elvisVb.width, viewport.height / elvisVb.height) * elvisMaxZoom;
  const relDiff = Math.abs(elvisPxPerSvgUnit - stdPxPerSvgUnit) / stdPxPerSvgUnit;
  assert.ok(relDiff < 0.001, `Expected physical pixel scale within 0.1%, diff=${relDiff}`);

  // Caps cleanly at 8.0 for oversized/extreme viewBoxes and falls back cleanly on invalid input
  const hugeMaxZoom = computeEffectiveMaxZoom({ width: 10000, height: 10000 }, viewport, 2.6);
  assert.equal(hugeMaxZoom, 8.0);
  assert.equal(computeEffectiveMaxZoom(null, viewport, 2.6), 2.6);
  assert.equal(computeEffectiveMaxZoom(stdVb, { width: 0, height: 580 }, 2.6), 2.6);
});

