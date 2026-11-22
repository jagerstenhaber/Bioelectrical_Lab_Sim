/**
 * 830-Point Solderless Breadboard Model + Rotated NI ELVIS II Mode + External Sensors
 * - Standard Mode (elvisMode = false):
 *   Horizontal 830-point breadboard (63 columns left-to-right x 10 terminal rows + 4 power rails).
 * - NI ELVIS II Mode (elvisMode = true):
 *   Rotates the 830-point breadboard 90° clockwise to vertical orientation (63 rows top-to-bottom)
 *   and places the two 4-column x 27-row NI ELVIS II connector blocks stacked vertically on the left
 *   (Upper block: Rows 1–27, Lower block: Rows 28–54) with official brackets and labels.
 * - External Sensor Toggles (loadCellsMode, emgMode):
 *   Adds wireable 3-hole terminal blocks and visual diagrams for:
 *   1. Load Cells: Rectangular Full-Bridge (4-wire) + Pair of E-Shaped Half-Bridges (2 x 3-wire)
 *   2. 3-Pad EMG: Two Red differential electrode leads + Black Common/Reference electrode lead
 */

export const PITCH = 16; // pixels per 0.1" breadboard grid pitch
export const BOARD_ORIGIN_X = 56;
export const BOARD_ORIGIN_Y = 44;

export const STANDARD_BOARD_VIEWBOX = Object.freeze({
  width: BOARD_ORIGIN_X * 2 + 62 * PITCH,
  height: BOARD_ORIGIN_Y * 2 + 17 * PITCH + 12
});

/**
 * Computes an effective max zoom factor so that physical screen pixels per
 * breadboard hole pitch (16 SVG units) in larger layouts (NI ELVIS II / sensors)
 * match standard 830-point breadboard mode at max zoom.
 */
export function computeEffectiveMaxZoom(curViewBox, viewportRect, baseMaxZoom = 2.6) {
  if (
    !curViewBox ||
    !viewportRect ||
    viewportRect.width <= 0 ||
    viewportRect.height <= 0 ||
    curViewBox.width <= 0 ||
    curViewBox.height <= 0
  ) {
    return baseMaxZoom;
  }
  const stdScale = Math.min(
    viewportRect.width / STANDARD_BOARD_VIEWBOX.width,
    viewportRect.height / STANDARD_BOARD_VIEWBOX.height
  );
  const curScale = Math.min(
    viewportRect.width / curViewBox.width,
    viewportRect.height / curViewBox.height
  );
  if (curScale <= 0 || !Number.isFinite(stdScale / curScale)) {
    return baseMaxZoom;
  }
  return Math.min(8.0, Math.max(baseMaxZoom, baseMaxZoom * (stdScale / curScale)));
}

export const TERMINAL_ROWS_TOP = ['a', 'b', 'c', 'd', 'e'];
export const TERMINAL_ROWS_BOT = ['f', 'g', 'h', 'i', 'j'];
export const ALL_TERMINAL_ROWS = [...TERMINAL_ROWS_TOP, ...TERMINAL_ROWS_BOT];

export const ROW_GRID_Y = {
  'TP': 0,  // Top + rail (in vertical ELVIS mode: Right + rail)
  'TN': 1,  // Top - rail (in vertical ELVIS mode: Right - rail)
  'a': 3,
  'b': 4,
  'c': 5,
  'd': 6,
  'e': 7,
  'f': 10,
  'g': 11,
  'h': 12,
  'i': 13,
  'j': 14,
  'BP': 16, // Bottom + rail (in vertical ELVIS mode: Left + rail)
  'BN': 17  // Bottom - rail (in vertical ELVIS mode: Left - rail)
};

export const GRID_Y_TO_ROW = Object.fromEntries(
  Object.entries(ROW_GRID_Y).map(([row, gy]) => [gy, row])
);

/**
 * In Vertical NI ELVIS II mode:
 * - The 830-point breadboard spans gridX = 0..17, gridY = 0..62 (63 rows tall).
 * - The two 4-column x 27-row ELVIS II connector blocks sit stacked on the left at gridX = -7..-4:
 *   - Upper Block (Rows 1–27):  gridY = 2..28
 *   - Lower Block (Rows 28–54): gridY = 34..60
 */
export const ELVIS_START_GRID_X = -7; // Columns -7, -6, -5, -4 (4 columns: A, B, C, D)
export const ELVIS_UPPER_START_GRID_Y = 2;  // Rows 1..27 -> gridY = 2..28
export const ELVIS_LOWER_START_GRID_Y = 34; // Rows 28..54 -> gridY = 34..60

export const ELVIS_UPPER_ROWS = [
  { rowNum: 1,  label: 'AI 0+',   role: 'analog' },
  { rowNum: 2,  label: 'AI 0-',   role: 'analog' },
  { rowNum: 3,  label: 'AI 1+',   role: 'analog' },
  { rowNum: 4,  label: 'AI 1-',   role: 'analog' },
  { rowNum: 5,  label: 'AI 2+',   role: 'analog' },
  { rowNum: 6,  label: 'AI 2-',   role: 'analog' },
  { rowNum: 7,  label: 'AI 3+',   role: 'analog' },
  { rowNum: 8,  label: 'AI 3-',   role: 'analog' },
  { rowNum: 9,  label: 'AI 4+',   role: 'analog' },
  { rowNum: 10, label: 'AI 4-',   role: 'analog' },
  { rowNum: 11, label: 'AI 5+',   role: 'analog' },
  { rowNum: 12, label: 'AI 5-',   role: 'analog' },
  { rowNum: 13, label: 'AI 6+',   role: 'analog' },
  { rowNum: 14, label: 'AI 6-',   role: 'analog' },
  { rowNum: 15, label: 'AI 7+',   role: 'analog' },
  { rowNum: 16, label: 'AI 7-',   role: 'analog' },
  { rowNum: 17, label: 'AISENSE', role: 'analog' },
  { rowNum: 18, label: 'AIGND',   role: 'ground' },
  { rowNum: 19, label: 'PFI0',    role: 'digital' },
  { rowNum: 20, label: 'PFI1',    role: 'digital' },
  { rowNum: 21, label: 'PFI2',    role: 'digital' },
  { rowNum: 22, label: 'PFI5',    role: 'digital' },
  { rowNum: 23, label: 'PFI6',    role: 'digital' },
  { rowNum: 24, label: 'PFI7',    role: 'digital' },
  { rowNum: 25, label: 'PFI10',   role: 'digital' },
  { rowNum: 26, label: 'PFI11',   role: 'digital' },
  { rowNum: 27, label: '',        role: 'blank' }
];

export const ELVIS_LOWER_ROWS = [
  { rowNum: 28, label: 'BASE',             role: 'analog' },
  { rowNum: 29, label: 'DUT+',             role: 'analog' },
  { rowNum: 30, label: 'DUT-',             role: 'analog' },
  { rowNum: 31, label: 'AO 0',             role: 'signal' },
  { rowNum: 32, label: 'AO 1',             role: 'signal' },
  { rowNum: 33, label: 'FGEN',             role: 'signal' },
  { rowNum: 34, label: 'SYNC',             role: 'digital' },
  { rowNum: 35, label: 'AM',               role: 'analog' },
  { rowNum: 36, label: 'FM',               role: 'analog' },
  { rowNum: 37, label: '',                 role: 'blank' },
  { rowNum: 38, label: 'BANANA A',         role: 'passive' },
  { rowNum: 39, label: 'BANANA B',         role: 'passive' },
  { rowNum: 40, label: 'BANANA C',         role: 'passive' },
  { rowNum: 41, label: 'BANANA D',         role: 'passive' },
  { rowNum: 42, label: 'BNC 1 +',          role: 'passive' },
  { rowNum: 43, label: 'BNC 1 -',          role: 'passive' },
  { rowNum: 44, label: 'BNC 2 +',          role: 'passive' },
  { rowNum: 45, label: 'BNC 2 -',          role: 'passive' },
  { rowNum: 46, label: 'SCREW TERMINAL 1', role: 'passive' },
  { rowNum: 47, label: 'SCREW TERMINAL 2', role: 'passive' },
  { rowNum: 48, label: 'SUPPLY +',         role: 'power' },
  { rowNum: 49, label: 'GROUND',           role: 'ground' },
  { rowNum: 50, label: 'SUPPLY -',         role: 'power' },
  { rowNum: 51, label: '+15V',             role: 'power' },
  { rowNum: 52, label: '-15V',             role: 'power' },
  { rowNum: 53, label: 'GROUND',           role: 'ground' },
  { rowNum: 54, label: '+5V',              role: 'power' }
];

export const ELVIS_UPPER_BRACKETS = [
  { startRow: 1,  endRow: 18, title: 'Analog Input Signals' },
  { startRow: 19, endRow: 26, title: 'Programmable Function I/O' }
];

export const ELVIS_LOWER_BRACKETS = [
  { startRow: 28, endRow: 30, title: 'DMM/Impedance Analyzer' },
  { startRow: 31, endRow: 32, title: 'Analog Outputs' },
  { startRow: 33, endRow: 36, title: 'Function Generator' },
  { startRow: 38, endRow: 47, title: 'User Configurable I/O' },
  { startRow: 48, endRow: 50, title: 'Variable Power Supplies' },
  { startRow: 51, endRow: 54, title: 'DC Power Supplies' }
];

/**
 * External Sensor Terminal Row Definitions:
 * 1. Load Cells:
 *    - Rectangular Full-Bridge (4 wires: RED EXC+, BLK EXC-, GRN SIG+, WHT SIG-)
 *    - Pair of E-Shaped Half-Bridges (2 x 3 wires: WHT -, RED SIG, BLK +)
 * 2. 3-Pad EMG:
 *    - RED 1 (IN+ / Muscle Mid), RED 2 (IN- / Muscle End), BLACK (COM / Reference)
 */
export const LOAD_CELL_FULL_BRIDGE_ROWS = [
  { key: 'LC_FB_RED', label: 'RED (EXC+)',  short: 'RED E+',  wireColor: '#ef4444', role: 'passive', groupTitle: 'Full-Bridge Load Cell' },
  { key: 'LC_FB_BLK', label: 'BLK (EXC-)',  short: 'BLK E-',  wireColor: '#1e293b', role: 'passive', groupTitle: 'Full-Bridge Load Cell' },
  { key: 'LC_FB_GRN', label: 'GRN (SIG+)',  short: 'GRN S+',  wireColor: '#22c55e', role: 'analog',  groupTitle: 'Full-Bridge Load Cell' },
  { key: 'LC_FB_WHT', label: 'WHT (SIG-)',  short: 'WHT S-',  wireColor: '#f8fafc', role: 'analog',  groupTitle: 'Full-Bridge Load Cell' }
];

export const LOAD_CELL_HALF_BRIDGE_1_ROWS = [
  { key: 'LC_HB1_WHT', label: 'WHT (HB1 -)',   short: 'WHT -',   wireColor: '#f8fafc', role: 'passive', groupTitle: 'E-Half-Bridge #1' },
  { key: 'LC_HB1_RED', label: 'RED (HB1 SIG)', short: 'RED SIG', wireColor: '#ef4444', role: 'analog',  groupTitle: 'E-Half-Bridge #1' },
  { key: 'LC_HB1_BLK', label: 'BLK (HB1 +)',   short: 'BLK +',   wireColor: '#1e293b', role: 'passive', groupTitle: 'E-Half-Bridge #1' }
];

export const LOAD_CELL_HALF_BRIDGE_2_ROWS = [
  { key: 'LC_HB2_WHT', label: 'WHT (HB2 -)',   short: 'WHT -',   wireColor: '#f8fafc', role: 'passive', groupTitle: 'E-Half-Bridge #2' },
  { key: 'LC_HB2_RED', label: 'RED (HB2 SIG)', short: 'RED SIG', wireColor: '#ef4444', role: 'analog',  groupTitle: 'E-Half-Bridge #2' },
  { key: 'LC_HB2_BLK', label: 'BLK (HB2 +)',   short: 'BLK +',   wireColor: '#1e293b', role: 'passive', groupTitle: 'E-Half-Bridge #2' }
];

export const EMG_PAD_ROWS = [
  { key: 'EMG_RED1', label: 'RED 1 (MID / +)', short: 'RED 1 (+)', wireColor: '#ef4444', role: 'analog',  groupTitle: '3-Pad EMG Sensor' },
  { key: 'EMG_RED2', label: 'RED 2 (END / -)', short: 'RED 2 (-)', wireColor: '#dc2626', role: 'analog',  groupTitle: '3-Pad EMG Sensor' },
  { key: 'EMG_BLK',  label: 'BLK (COM / REF)', short: 'BLK COM',   wireColor: '#1e293b', role: 'passive', groupTitle: '3-Pad EMG Sensor' }
];

/**
 * Rotates a pin's (dx, dy) offset around (0, 0) in 90-degree clockwise increments
 */
export function getRotatedPinOffset(pin, rotation = 0) {
  const norm = ((rotation % 360) + 360) % 360;
  const dx = pin.dx || 0;
  const dy = pin.dy || 0;
  if (norm === 90) {
    return { dx: -dy, dy: dx };
  }
  if (norm === 180) {
    return { dx: -dx, dy: -dy };
  }
  if (norm === 270) {
    return { dx: dy, dy: -dx };
  }
  return { dx, dy };
}

export function getPowerRailColumns() {
  const cols = [];
  for (let group = 0; group < 10; group++) {
    const startCol = 3 + group * 6;
    for (let i = 0; i < 5; i++) {
      cols.push(startCol + i);
    }
  }
  return cols;
}

export class BreadboardModel {
  constructor({ elvisMode = false, loadCellsMode = false, emgMode = false, sensorPosition = 'auto' } = {}) {
    this.elvisMode = elvisMode;
    this.loadCellsMode = loadCellsMode;
    this.emgMode = emgMode;
    this.sensorPosition = sensorPosition; // 'auto' | 'top' | 'right' | 'bottom' | 'left'
    this.holes = new Map();       // holeId -> Hole object
    this.gridLookup = new Map();  // `${gridX},${gridY}` -> Hole object
    this.strips = new Map();      // stripId -> Hole[]
    this.buildBoard();
  }

  configure({ elvisMode, loadCellsMode, emgMode, sensorPosition } = {}) {
    let changed = false;
    if (elvisMode !== undefined && this.elvisMode !== Boolean(elvisMode)) {
      this.elvisMode = Boolean(elvisMode);
      changed = true;
    }
    if (loadCellsMode !== undefined && this.loadCellsMode !== Boolean(loadCellsMode)) {
      this.loadCellsMode = Boolean(loadCellsMode);
      changed = true;
    }
    if (emgMode !== undefined && this.emgMode !== Boolean(emgMode)) {
      this.emgMode = Boolean(emgMode);
      changed = true;
    }
    if (sensorPosition !== undefined && this.sensorPosition !== sensorPosition) {
      this.sensorPosition = sensorPosition;
      changed = true;
    }
    if (changed) {
      this.buildBoard();
    }
    return changed;
  }

  setElvisMode(enabled) {
    this.configure({ elvisMode: enabled });
  }

  setLoadCellsMode(enabled) {
    this.configure({ loadCellsMode: enabled });
  }

  setEmgMode(enabled) {
    this.configure({ emgMode: enabled });
  }

  setSensorPosition(pos) {
    this.configure({ sensorPosition: pos });
  }

  rotateSensorPosition() {
    const order = ['top', 'right', 'bottom', 'left'];
    const current = this.getEffectiveSensorSide();
    const nextIdx = (order.indexOf(current) + 1) % order.length;
    this.sensorPosition = order[nextIdx];
    this.buildBoard();
    return this.sensorPosition;
  }

  getEffectiveSensorSide() {
    if (this.sensorPosition && this.sensorPosition !== 'auto') {
      return this.sensorPosition;
    }
    return this.elvisMode ? 'right' : 'top';
  }

  /**
   * Returns the grid placement of External Sensor terminal strips:
   * - Defaults to 'top' (above the breadboard) in Standard Horizontal Mode
   * - Defaults to 'right' (right of the vertical breadboard) in NI ELVIS II Mode
   * - Can be rotated around all 4 sides ('top' -> 'right' -> 'bottom' -> 'left') with [R]
   */
  getExternalSensorsLayout() {
    const side = this.getEffectiveSensorSide();

    if (side === 'top' || side === 'bottom') {
      const maxGy = this.elvisMode ? 62 : 17;
      const startGridY = side === 'top' ? -6 : maxGy + 4; // 3 vertical holes per strip: startGridY + 0, 1, 2
      let fbStartGridX = 18;
      let hb1StartGridX = 28;
      let hb2StartGridX = 37;
      let emgStartGridX = 47;

      if (this.elvisMode) {
        fbStartGridX = -6;
        hb1StartGridX = 1;
        hb2StartGridX = 7;
        emgStartGridX = this.loadCellsMode ? 13 : 6;
      } else if (this.loadCellsMode && !this.emgMode) {
        fbStartGridX = 22;
        hb1StartGridX = 33;
        hb2StartGridX = 43;
      } else if (!this.loadCellsMode && this.emgMode) {
        emgStartGridX = 32;
      }

      return {
        side,
        orientation: 'horizontal-row', // strips run vertically (3 holes tall), arranged side-by-side along X
        startGridY,
        fbStartGridX,
        hb1StartGridX,
        hb2StartGridX,
        emgStartGridX
      };
    }

    // 'left' or 'right' side: strips run horizontally (3 holes wide), stacked along Y
    const startGridX =
      side === 'right'
        ? (this.elvisMode ? 21 : 66)
        : (this.elvisMode ? -19 : -6);
    const fbStartGridY = this.elvisMode ? 3 : 0;
    const hb1StartGridY = this.elvisMode ? 10 : 5;
    const hb2StartGridY = this.elvisMode ? 15 : 9;
    const emgStartGridY = this.elvisMode
      ? (this.loadCellsMode ? 22 : 6)
      : (this.loadCellsMode ? 14 : 6);

    return {
      side,
      orientation: 'vertical-stack',
      startGridX,
      fbStartGridY,
      hb1StartGridY,
      hb2StartGridY,
      emgStartGridY
    };
  }

  /**
   * Maps a canonical breadboard (bbCol=1..63, rowOffset=0..17) to current (gridX, gridY)
   * - Horizontal Mode: gridX = bbCol - 1 (0..62), gridY = rowOffset (0..17)
   * - Vertical ELVIS Mode (90° CW): gridX = 17 - rowOffset (0..17), gridY = bbCol - 1 (0..62)
   */
  mapBbToGrid(bbCol, rowOffset) {
    if (this.elvisMode) {
      return {
        gridX: 17 - rowOffset,
        gridY: bbCol - 1
      };
    }
    return {
      gridX: bbCol - 1,
      gridY: rowOffset
    };
  }

  buildBoard() {
    this.holes.clear();
    this.gridLookup.clear();
    this.strips.clear();

    const railCols = getPowerRailColumns();
    const railDefs = [
      { row: 'TP', label: 'Power + Rail', polarity: 'pos' },
      { row: 'TN', label: 'Power - Rail', polarity: 'neg' },
      { row: 'BP', label: 'Power + Rail', polarity: 'pos' },
      { row: 'BN', label: 'Power - Rail', polarity: 'neg' }
    ];

    // 1. Create Power Rail holes (4 x 50 = 200 tie points)
    for (const rail of railDefs) {
      const rowOffset = ROW_GRID_Y[rail.row];
      for (const bbCol of railCols) {
        const { gridX, gridY } = this.mapBbToGrid(bbCol, rowOffset);
        const stripId = `RAIL_${rail.row}_ALL`;
        const holeId = `${rail.row}${bbCol}`;
        this.registerHole({
          id: holeId,
          row: rail.row,
          col: bbCol,
          gridX,
          gridY,
          x: BOARD_ORIGIN_X + gridX * PITCH,
          y: BOARD_ORIGIN_Y + gridY * PITCH,
          stripId,
          type: 'rail',
          polarity: rail.polarity,
          displayName: `${rail.label} (${holeId})`
        });
      }
    }

    // 2. Create Terminal Strip holes (63 x 10 = 630 tie points)
    for (let bbCol = 1; bbCol <= 63; bbCol++) {
      for (const row of TERMINAL_ROWS_TOP) {
        const rowOffset = ROW_GRID_Y[row];
        const { gridX, gridY } = this.mapBbToGrid(bbCol, rowOffset);
        const holeId = `${row}${bbCol}`;
        const stripId = `TERM_TOP_${bbCol}`;
        this.registerHole({
          id: holeId,
          row,
          col: bbCol,
          gridX,
          gridY,
          x: BOARD_ORIGIN_X + gridX * PITCH,
          y: BOARD_ORIGIN_Y + gridY * PITCH,
          stripId,
          type: 'terminal',
          polarity: null,
          displayName: `Strip ${bbCol}, Pin ${row.toUpperCase()} (${holeId})`
        });
      }

      for (const row of TERMINAL_ROWS_BOT) {
        const rowOffset = ROW_GRID_Y[row];
        const { gridX, gridY } = this.mapBbToGrid(bbCol, rowOffset);
        const holeId = `${row}${bbCol}`;
        const stripId = `TERM_BOT_${bbCol}`;
        this.registerHole({
          id: holeId,
          row,
          col: bbCol,
          gridX,
          gridY,
          x: BOARD_ORIGIN_X + gridX * PITCH,
          y: BOARD_ORIGIN_Y + gridY * PITCH,
          stripId,
          type: 'terminal',
          polarity: null,
          displayName: `Strip ${bbCol}, Pin ${row.toUpperCase()} (${holeId})`
        });
      }
    }

    // 3. Optional NI ELVIS II Left Connectors (Two stacked 4-col x 27-row strips = 216 tie points)
    if (this.elvisMode) {
      const colLetters = ['A', 'B', 'C', 'D'];

      const registerElvisBlock = (rows, startGridY) => {
        rows.forEach((rowDef, idx) => {
          const gridY = startGridY + idx;
          const stripId = `ELVIS_ROW_${rowDef.rowNum}`;
          const labelDesc = rowDef.label ? `[${rowDef.label}]` : '(Unlabeled / Blank)';
          for (let c = 0; c < 4; c++) {
            const gridX = ELVIS_START_GRID_X + c;
            const colLetter = colLetters[c];
            const holeId = `ELV_${rowDef.rowNum}${colLetter}`;
            this.registerHole({
              id: holeId,
              row: `ELV_${rowDef.rowNum}`,
              col: gridX + 1,
              gridX,
              gridY,
              x: BOARD_ORIGIN_X + gridX * PITCH,
              y: BOARD_ORIGIN_Y + gridY * PITCH,
              stripId,
              type: 'elvis',
              elvisLabel: rowDef.label,
              elvisRowNum: rowDef.rowNum,
              elvisRole: rowDef.role,
              polarity:
                rowDef.label === '-15V' || rowDef.label === 'SUPPLY -'
                  ? 'neg_supply'
                  : rowDef.role === 'power'
                  ? 'pos'
                  : rowDef.role === 'ground'
                  ? 'neg'
                  : null,
              displayName: `NI ELVIS II Row ${rowDef.rowNum} ${labelDesc} (${colLetter})`
            });
          }
        });
      };

      registerElvisBlock(ELVIS_UPPER_ROWS, ELVIS_UPPER_START_GRID_Y);
      registerElvisBlock(ELVIS_LOWER_ROWS, ELVIS_LOWER_START_GRID_Y);
    }

    // 4. Optional External Sensor Terminal Strips (Load Cells & 3-Pad EMG)
    const extLayout = this.getExternalSensorsLayout();
    const sensorCols = ['A', 'B', 'C'];

    const registerSensorRows = (rows, startCoord) => {
      rows.forEach((rowDef, idx) => {
        const stripId = `SENSOR_${rowDef.key}`;
        for (let c = 0; c < 3; c++) {
          const gridX =
            extLayout.orientation === 'horizontal-row'
              ? startCoord + idx
              : extLayout.startGridX + c;
          const gridY =
            extLayout.orientation === 'horizontal-row'
              ? extLayout.startGridY + c
              : startCoord + idx;
          const colLetter = sensorCols[c];
          const holeId = `${rowDef.key}_${colLetter}`;
          this.registerHole({
            id: holeId,
            row: rowDef.key,
            col: gridX + 1,
            gridX,
            gridY,
            x: BOARD_ORIGIN_X + gridX * PITCH,
            y: BOARD_ORIGIN_Y + gridY * PITCH,
            stripId,
            type: 'sensor',
            sensorLabel: `${rowDef.groupTitle}: ${rowDef.label}`,
            sensorRole: rowDef.role,
            polarity: null,
            displayName: `${rowDef.groupTitle} — ${rowDef.label} (${colLetter})`
          });
        }
      });
    };

    if (this.loadCellsMode) {
      if (extLayout.orientation === 'horizontal-row') {
        registerSensorRows(LOAD_CELL_FULL_BRIDGE_ROWS, extLayout.fbStartGridX);
        registerSensorRows(LOAD_CELL_HALF_BRIDGE_1_ROWS, extLayout.hb1StartGridX);
        registerSensorRows(LOAD_CELL_HALF_BRIDGE_2_ROWS, extLayout.hb2StartGridX);
      } else {
        registerSensorRows(LOAD_CELL_FULL_BRIDGE_ROWS, extLayout.fbStartGridY);
        registerSensorRows(LOAD_CELL_HALF_BRIDGE_1_ROWS, extLayout.hb1StartGridY);
        registerSensorRows(LOAD_CELL_HALF_BRIDGE_2_ROWS, extLayout.hb2StartGridY);
      }
    }

    if (this.emgMode) {
      const startCoord =
        extLayout.orientation === 'horizontal-row'
          ? extLayout.emgStartGridX
          : extLayout.emgStartGridY;
      registerSensorRows(EMG_PAD_ROWS, startCoord);
    }
  }

  registerHole(hole) {
    this.holes.set(hole.id, hole);
    this.gridLookup.set(`${hole.gridX},${hole.gridY}`, hole);
    if (!this.strips.has(hole.stripId)) {
      this.strips.set(hole.stripId, []);
    }
    this.strips.get(hole.stripId).push(hole);
  }

  getHole(holeId) {
    return this.holes.get(holeId) || null;
  }

  getHoleAtGrid(gridX, gridY) {
    return this.gridLookup.get(`${gridX},${gridY}`) || null;
  }

  getStripHoles(stripId) {
    return this.strips.get(stripId) || [];
  }

  findNearestHole(x, y, maxDistance = PITCH * 1.35) {
    let bestHole = null;
    let bestDistSq = maxDistance * maxDistance;

    for (const hole of this.holes.values()) {
      const dx = hole.x - x;
      const dy = hole.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestDistSq) {
        bestDistSq = d2;
        bestHole = hole;
      }
    }
    return bestHole;
  }

  findBestFootprintAnchor(partDef, targetX, targetY, rotation = 0) {
    const approxGridX = Math.round((targetX - BOARD_ORIGIN_X) / PITCH);
    const approxGridY = Math.round((targetY - BOARD_ORIGIN_Y) / PITCH);

    let bestCandidate = null;
    let bestScore = Infinity;

    for (let dGx = -4; dGx <= 4; dGx++) {
      for (let dGy = -5; dGy <= 5; dGy++) {
        const gridX = approxGridX + dGx;
        const gridY = approxGridY + dGy;
        if (this.isFootprintValidAt(partDef, gridX, gridY, rotation)) {
          const anchorHole = this.getHoleAtGrid(gridX, gridY);
          const anchorX = BOARD_ORIGIN_X + gridX * PITCH;
          const anchorY = BOARD_ORIGIN_Y + gridY * PITCH;
          const score = Math.hypot(anchorX - targetX, anchorY - targetY);
          if (score < bestScore) {
            bestScore = score;
            bestCandidate = {
              gridX,
              gridY,
              anchorHoleId: anchorHole ? anchorHole.id : null
            };
          }
        }
      }
    }
    return bestCandidate;
  }

  isFootprintValidAt(partDef, anchorGridX, anchorGridY, rotation = 0) {
    for (const pin of partDef.pins) {
      const { dx, dy } = getRotatedPinOffset(pin, rotation);
      const gx = anchorGridX + dx;
      const gy = anchorGridY + dy;
      if (!this.getHoleAtGrid(gx, gy)) {
        return false;
      }
    }
    return true;
  }

  getBoardViewBox() {
    const hasSensors = this.loadCellsMode || this.emgMode;
    const side = this.getEffectiveSensorSide();

    let minX = this.elvisMode ? -325 : 0;
    let maxX = this.elvisMode
      ? BOARD_ORIGIN_X + 17 * PITCH + 54
      : BOARD_ORIGIN_X * 2 + 62 * PITCH;
    let minY = this.elvisMode ? -12 : -6;
    let maxY = this.elvisMode
      ? BOARD_ORIGIN_Y + 62 * PITCH + 46
      : BOARD_ORIGIN_Y * 2 + 17 * PITCH + 6;

    if (hasSensors) {
      if (side === 'top') {
        minY = Math.min(minY, -176);
      } else if (side === 'bottom') {
        const boardBotY = this.elvisMode
          ? BOARD_ORIGIN_Y + 62 * PITCH
          : BOARD_ORIGIN_Y + 17 * PITCH;
        maxY = Math.max(maxY, boardBotY + 230);
      } else if (side === 'left') {
        minX = Math.min(minX, this.elvisMode ? -580 : -295);
        if (!this.elvisMode && this.loadCellsMode && this.emgMode) {
          maxY = Math.max(maxY, BOARD_ORIGIN_Y + 17 * PITCH + 56);
        }
      } else if (side === 'right') {
        maxX = Math.max(
          maxX,
          this.elvisMode
            ? BOARD_ORIGIN_X + 23 * PITCH + 280
            : BOARD_ORIGIN_X + 68 * PITCH + 280
        );
        if (!this.elvisMode && this.loadCellsMode && this.emgMode) {
          maxY = Math.max(maxY, BOARD_ORIGIN_Y + 17 * PITCH + 56);
        }
      }
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }
}
