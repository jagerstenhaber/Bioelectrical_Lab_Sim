/**
 * Pure SVG Rendering Helpers for the 830-Point Breadboard, NI ELVIS II Board,
 * External Sensor Modules (Load Cells & 3-Pad EMG), and Jumper Wire Paths.
 */

import {
  PITCH,
  BOARD_ORIGIN_X,
  BOARD_ORIGIN_Y,
  ROW_GRID_Y,
  TERMINAL_ROWS_TOP,
  TERMINAL_ROWS_BOT,
  ELVIS_START_GRID_X,
  ELVIS_UPPER_START_GRID_Y,
  ELVIS_LOWER_START_GRID_Y,
  ELVIS_UPPER_ROWS,
  ELVIS_LOWER_ROWS,
  ELVIS_UPPER_BRACKETS,
  ELVIS_LOWER_BRACKETS,
  LOAD_CELL_FULL_BRIDGE_ROWS,
  LOAD_CELL_HALF_BRIDGE_1_ROWS,
  LOAD_CELL_HALF_BRIDGE_2_ROWS,
  EMG_PAD_ROWS
} from './breadboard.js';

/**
 * Computes an SVG path string for a jumper wire between (x1, y1) and (x2, y2).
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {'curved' | 'curved-alt' | 'straight'} [style='curved']
 * @returns {string}
 */
export function computeWirePath(x1, y1, x2, y2, style = 'curved') {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 1 || style === 'straight') {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const bow = Math.min(26, Math.max(8, dist * 0.14));
  const nx = -dy / dist;
  const ny = dx / dist;
  const dir = style === 'curved-alt' ? -1 : 1;
  const cx = mx + nx * bow * dir;
  const cy = my + ny * bow * dir;

  return `M ${x1} ${y1} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x2} ${y2}`;
}

/**
 * Standard Horizontal 830-Point Breadboard (63 columns wide x 18 grid units tall)
 */
export function renderHorizontalBoardMarkup(_breadboard) {
  const baseW = BOARD_ORIGIN_X * 2 + 62 * PITCH;
  const baseH = BOARD_ORIGIN_Y * 2 + 17 * PITCH;

  const topRailY = BOARD_ORIGIN_Y + ROW_GRID_Y.TP * PITCH;
  const botRailY = BOARD_ORIGIN_Y + ROW_GRID_Y.BP * PITCH;
  const termTopY = BOARD_ORIGIN_Y + ROW_GRID_Y.a * PITCH;
  const termBotY = BOARD_ORIGIN_Y + ROW_GRID_Y.j * PITCH;
  const ravineCenterY = BOARD_ORIGIN_Y + 8.5 * PITCH;
  const leftEdgeX = BOARD_ORIGIN_X - 24;
  const rightEdgeX = BOARD_ORIGIN_X + 62 * PITCH + 24;

  const powerLinesMarkup = `
    <line x1="${BOARD_ORIGIN_X + 2 * PITCH - 6}" y1="${topRailY - 9}" x2="${BOARD_ORIGIN_X + 60 * PITCH + 6}" y2="${topRailY - 9}" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="${BOARD_ORIGIN_X + 2 * PITCH - 6}" y1="${topRailY + PITCH + 9}" x2="${BOARD_ORIGIN_X + 60 * PITCH + 6}" y2="${topRailY + PITCH + 9}" stroke="#3b82f6" stroke-width="2.2" stroke-linecap="round"/>

    <line x1="${BOARD_ORIGIN_X + 2 * PITCH - 6}" y1="${botRailY - 9}" x2="${BOARD_ORIGIN_X + 60 * PITCH + 6}" y2="${botRailY - 9}" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="${BOARD_ORIGIN_X + 2 * PITCH - 6}" y1="${botRailY + PITCH + 9}" x2="${BOARD_ORIGIN_X + 60 * PITCH + 6}" y2="${botRailY + PITCH + 9}" stroke="#3b82f6" stroke-width="2.2" stroke-linecap="round"/>
  `;

  let colLabelsMarkup = '';
  for (let col = 1; col <= 63; col++) {
    if (col === 1 || col % 5 === 0 || col === 63) {
      const cx = BOARD_ORIGIN_X + (col - 1) * PITCH;
      colLabelsMarkup += `
        <text x="${cx}" y="${termTopY - 11}" class="bb-label-col">${col}</text>
        <text x="${cx}" y="${termBotY + 17}" class="bb-label-col">${col}</text>
      `;
    }
  }

  let rowLabelsMarkup = '';
  for (const row of [...TERMINAL_ROWS_TOP, ...TERMINAL_ROWS_BOT]) {
    const ry = BOARD_ORIGIN_Y + ROW_GRID_Y[row] * PITCH + 3.5;
    rowLabelsMarkup += `
      <text x="${BOARD_ORIGIN_X - 16}" y="${ry}" class="bb-label-row">${row}</text>
      <text x="${BOARD_ORIGIN_X + 62 * PITCH + 16}" y="${ry}" class="bb-label-row">${row}</text>
    `;
  }

  return `
    <!-- 830-Point Breadboard Outer ABS Plastic Body -->
    <rect x="16" y="12" width="${baseW - 32}" height="${baseH - 24}" rx="12"
          fill="#f8fafc" stroke="#cbd5e1" stroke-width="2" filter="url(#boardShadow)"/>

    <!-- Subtle Recessed Rail Separation Grooves -->
    <line x1="20" y1="${BOARD_ORIGIN_Y + 2 * PITCH}" x2="${baseW - 20}" y2="${BOARD_ORIGIN_Y + 2 * PITCH}"
          stroke="#e2e8f0" stroke-width="2.5"/>
    <line x1="20" y1="${BOARD_ORIGIN_Y + 15 * PITCH}" x2="${baseW - 20}" y2="${BOARD_ORIGIN_Y + 15 * PITCH}"
          stroke="#e2e8f0" stroke-width="2.5"/>

    <!-- Central DIP IC Channel (0.3" Ravine) -->
    <rect x="20" y="${ravineCenterY - 13}" width="${baseW - 40}" height="26" rx="2.5"
          fill="#e2e8f0" stroke="#cbd5e1" stroke-width="1"/>
    <line x1="22" y1="${ravineCenterY}" x2="${baseW - 22}" y2="${ravineCenterY}"
          stroke="#cbd5e1" stroke-width="1" stroke-dasharray="6 6"/>

    <!-- Power Rail + / - Symbols -->
    <text x="${leftEdgeX}" y="${topRailY + 4}" class="bb-rail-plus">+</text>
    <text x="${leftEdgeX}" y="${topRailY + PITCH + 4}" class="bb-rail-minus">−</text>
    <text x="${rightEdgeX}" y="${topRailY + 4}" class="bb-rail-plus">+</text>
    <text x="${rightEdgeX}" y="${topRailY + PITCH + 4}" class="bb-rail-minus">−</text>

    <text x="${leftEdgeX}" y="${botRailY + 4}" class="bb-rail-plus">+</text>
    <text x="${leftEdgeX}" y="${botRailY + PITCH + 4}" class="bb-rail-minus">−</text>
    <text x="${rightEdgeX}" y="${botRailY + 4}" class="bb-rail-plus">+</text>
    <text x="${rightEdgeX}" y="${botRailY + PITCH + 4}" class="bb-rail-minus">−</text>

    ${powerLinesMarkup}
    ${colLabelsMarkup}
    ${rowLabelsMarkup}
  `;
}

/**
 * Vertical NI ELVIS II Mode:
 * - Rotates the 830-point breadboard 90° clockwise (gridX = 0..17, gridY = 0..62)
 * - Renders the Upper (Rows 1–27) and Lower (Rows 28–54) 4-column x 27-row connector blocks
 *   stacked vertically on the left (gridX = -8..-4) with brackets and labels.
 */
export function renderVerticalElvisBoardMarkup(_breadboard) {
  const bbLeftX = BOARD_ORIGIN_X - 28;
  const bbRightX = BOARD_ORIGIN_X + 17 * PITCH + 28;
  const bbTopY = BOARD_ORIGIN_Y - 30;
  const bbBotY = BOARD_ORIGIN_Y + 62 * PITCH + 30;
  const bbWidth = bbRightX - bbLeftX;
  const bbHeight = bbBotY - bbTopY;

  const ravineCenterX = BOARD_ORIGIN_X + 8.5 * PITCH;

  // In 90° CW rotation:
  // Left rails: BN (gridX=0, -), BP (gridX=1, +)
  // Left terminal rows: j..f (gridX=3..7)
  // Right terminal rows: e..a (gridX=10..14)
  // Right rails: TN (gridX=16, -), TP (gridX=17, +)
  const leftNegX = BOARD_ORIGIN_X + 0 * PITCH;
  const leftPosX = BOARD_ORIGIN_X + 1 * PITCH;
  const rightNegX = BOARD_ORIGIN_X + 16 * PITCH;
  const rightPosX = BOARD_ORIGIN_X + 17 * PITCH;

  const railStartY = BOARD_ORIGIN_Y + 2 * PITCH - 6;
  const railEndY = BOARD_ORIGIN_Y + 60 * PITCH + 6;

  const powerLinesMarkup = `
    <line x1="${leftNegX - 9}" y1="${railStartY}" x2="${leftNegX - 9}" y2="${railEndY}" stroke="#3b82f6" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="${leftPosX + 9}" y1="${railStartY}" x2="${leftPosX + 9}" y2="${railEndY}" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round"/>

    <line x1="${rightNegX - 9}" y1="${railStartY}" x2="${rightNegX - 9}" y2="${railEndY}" stroke="#3b82f6" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="${rightPosX + 9}" y1="${railStartY}" x2="${rightPosX + 9}" y2="${railEndY}" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round"/>
  `;

  // Row numbers 1..63 along the vertical terminal strips
  const termLeftLabelX = BOARD_ORIGIN_X + 3 * PITCH - 13;
  const termRightLabelX = BOARD_ORIGIN_X + 14 * PITCH + 13;
  let stripNumLabels = '';
  for (let col = 1; col <= 63; col++) {
    if (col === 1 || col % 5 === 0 || col === 63) {
      const ry = BOARD_ORIGIN_Y + (col - 1) * PITCH + 3;
      stripNumLabels += `
        <text x="${termLeftLabelX}" y="${ry}" class="bb-label-col">${col}</text>
        <text x="${termRightLabelX}" y="${ry}" class="bb-label-col">${col}</text>
      `;
    }
  }

  // Column letters (j..f and e..a) at top and bottom of vertical breadboard
  let colLetterLabels = '';
  for (const row of [...TERMINAL_ROWS_TOP, ...TERMINAL_ROWS_BOT]) {
    const gx = 17 - ROW_GRID_Y[row];
    const cx = BOARD_ORIGIN_X + gx * PITCH;
    colLetterLabels += `
      <text x="${cx}" y="${BOARD_ORIGIN_Y - 12}" class="bb-label-row">${row}</text>
      <text x="${cx}" y="${BOARD_ORIGIN_Y + 62 * PITCH + 18}" class="bb-label-row">${row}</text>
    `;
  }

  // Render Upper (1–27) and Lower (28–54) NI ELVIS II 4x27 Connector Blocks on the left
  const elvisFirstHoleX = BOARD_ORIGIN_X + ELVIS_START_GRID_X * PITCH;
  const elvisBlockWidth = 3 * PITCH + 22;
  const elvisBlockHeight = 26 * PITCH + 22;
  const colLetters = ['A', 'B', 'C', 'D'];

  const renderElvisBlock = (rows, brackets, startGridY, blockTitle) => {
    const topY = BOARD_ORIGIN_Y + startGridY * PITCH;
    let colHeaderMarkup = '';
    for (let c = 0; c < 4; c++) {
      const cx = elvisFirstHoleX + c * PITCH;
      colHeaderMarkup += `<text x="${cx}" y="${topY - 13}" class="elvis-col-letter">${colLetters[c]}</text>`;
    }

    let rowsMarkup = '';
    rows.forEach((r, idx) => {
      const ry = topY + idx * PITCH;
      const colorClass =
        r.role === 'power'
          ? 'elvis-sig-power'
          : r.role === 'ground'
          ? 'elvis-sig-ground'
          : r.role === 'signal'
          ? 'elvis-sig-gen'
          : 'elvis-sig-default';

      rowsMarkup += `
        ${r.label ? `<text x="${elvisFirstHoleX - 28}" y="${ry + 3.2}" class="elvis-row-signal ${colorClass}">${r.label}</text>` : ''}
        <text x="${elvisFirstHoleX - 13}" y="${ry + 3.2}" class="elvis-row-num">${r.rowNum}</text>
      `;
    });

    // Render left-side silkscreen section brackets
    const bracketX = elvisFirstHoleX - 132;
    const tickRightX = elvisFirstHoleX - 124;
    let bracketsMarkup = '';
    for (const b of brackets) {
      const startIdx = b.startRow - rows[0].rowNum;
      const endIdx = b.endRow - rows[0].rowNum;
      const y1 = topY + startIdx * PITCH - 4.5;
      const y2 = topY + endIdx * PITCH + 4.5;
      const midY = (y1 + y2) / 2;

      bracketsMarkup += `
        <path d="M ${tickRightX} ${y1} L ${bracketX} ${y1} L ${bracketX} ${y2} L ${tickRightX} ${y2}"
              fill="none" stroke="#86efac" stroke-width="1.3" stroke-linecap="round"/>
        <text x="${bracketX - 6}" y="${midY + 3}" class="elvis-bracket-label">${b.title}</text>
      `;
    }

    return `
      <text x="${elvisFirstHoleX + 1.5 * PITCH}" y="${topY - 25}" class="elvis-block-title">${blockTitle}</text>
      <rect x="${elvisFirstHoleX - 11}" y="${topY - 11}" width="${elvisBlockWidth}" height="${elvisBlockHeight}" rx="4"
            fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5"/>
      ${colHeaderMarkup}
      ${rowsMarkup}
      ${bracketsMarkup}
    `;
  };

  return `
    <!-- NI ELVIS II Green Prototyping Board Outer PCB -->
    <rect x="-318" y="${bbTopY - 14}" width="${bbRightX + 332}" height="${bbHeight + 28}" rx="18"
          fill="#0f5132" stroke="#0a3622" stroke-width="3" filter="url(#boardShadow)"/>
    <rect x="-310" y="${bbTopY - 6}" width="${bbRightX + 316}" height="${bbHeight + 12}" rx="14"
          fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.2"/>

    <text x="-296" y="${bbTopY + 14}" fill="#ffffff" font-family="sans-serif" font-weight="800" font-size="11.5" letter-spacing="0.06em">
      NI ELVIS II SERIES PROTOTYPING BOARD
    </text>

    <!-- Left Stacked 5x27 NI ELVIS II Connector Blocks -->
    ${renderElvisBlock(ELVIS_UPPER_ROWS, ELVIS_UPPER_BRACKETS, ELVIS_UPPER_START_GRID_Y, 'UPPER CONNECTOR (ROWS 1–27)')}
    ${renderElvisBlock(ELVIS_LOWER_ROWS, ELVIS_LOWER_BRACKETS, ELVIS_LOWER_START_GRID_Y, 'LOWER CONNECTOR (ROWS 28–54)')}

    <!-- Vertical 830-Point Breadboard Molded Body -->
    <rect x="${bbLeftX}" y="${bbTopY}" width="${bbWidth}" height="${bbHeight}" rx="12"
          fill="#f8fafc" stroke="#cbd5e1" stroke-width="2" filter="url(#boardShadow)"/>

    <!-- Vertical Recessed Rail Separation Grooves -->
    <line x1="${BOARD_ORIGIN_X + 2 * PITCH}" y1="${bbTopY + 4}" x2="${BOARD_ORIGIN_X + 2 * PITCH}" y2="${bbBotY - 4}"
          stroke="#e2e8f0" stroke-width="2.5"/>
    <line x1="${BOARD_ORIGIN_X + 15 * PITCH}" y1="${bbTopY + 4}" x2="${BOARD_ORIGIN_X + 15 * PITCH}" y2="${bbBotY - 4}"
          stroke="#e2e8f0" stroke-width="2.5"/>

    <!-- Vertical Central DIP IC Channel (0.3" Ravine) -->
    <rect x="${ravineCenterX - 13}" y="${bbTopY + 4}" width="26" height="${bbHeight - 8}" rx="2.5"
          fill="#e2e8f0" stroke="#cbd5e1" stroke-width="1"/>
    <line x1="${ravineCenterX}" y1="${bbTopY + 8}" x2="${ravineCenterX}" y2="${bbBotY - 8}"
          stroke="#cbd5e1" stroke-width="1" stroke-dasharray="6 6"/>

    <!-- Vertical Power Rail + / - Symbols -->
    <text x="${leftNegX}" y="${BOARD_ORIGIN_Y - 12}" class="bb-rail-minus">−</text>
    <text x="${leftPosX}" y="${BOARD_ORIGIN_Y - 12}" class="bb-rail-plus">+</text>
    <text x="${leftNegX}" y="${BOARD_ORIGIN_Y + 62 * PITCH + 18}" class="bb-rail-minus">−</text>
    <text x="${leftPosX}" y="${BOARD_ORIGIN_Y + 62 * PITCH + 18}" class="bb-rail-plus">+</text>

    <text x="${rightNegX}" y="${BOARD_ORIGIN_Y - 12}" class="bb-rail-minus">−</text>
    <text x="${rightPosX}" y="${BOARD_ORIGIN_Y - 12}" class="bb-rail-plus">+</text>
    <text x="${rightNegX}" y="${BOARD_ORIGIN_Y + 62 * PITCH + 18}" class="bb-rail-minus">−</text>
    <text x="${rightPosX}" y="${BOARD_ORIGIN_Y + 62 * PITCH + 18}" class="bb-rail-plus">+</text>

    ${powerLinesMarkup}
    ${stripNumLabels}
    ${colLetterLabels}
  `;
}

/**
 * Renders the External Sensor Transducer Modules & 3-Hole Terminal Blocks:
 * - Defaults to 'top' (above the breadboard) in Non-ELVIS Horizontal Mode
 * - Defaults to 'right' (right of the vertical breadboard) in NI ELVIS II Mode
 * - Click any sensor module and press [R] to rotate its position around the board (Top -> Right -> Bottom -> Left)
 */
export function renderExternalSensorsMarkup(breadboard, { isSensorSelected = false } = {}) {
  if (!breadboard.loadCellsMode && !breadboard.emgMode) return '';

  const ext = breadboard.getExternalSensorsLayout();
  const selStroke = isSensorSelected
    ? `stroke="#38bdf8" stroke-width="2.2" stroke-dasharray="4 2"`
    : `stroke="#64748b" stroke-width="1.4"`;
  const colLetters = ['A', 'B', 'C'];

  // =========================================================================
  // HORIZONTAL ROW ORIENTATION ('top' or 'bottom' of the breadboard)
  // =========================================================================
  if (ext.orientation === 'horizontal-row') {
    const isTop = ext.side === 'top';
    const firstHoleY = BOARD_ORIGIN_Y + ext.startGridY * PITCH;
    const lastHoleY = firstHoleY + 2 * PITCH;
    const blockH = 2 * PITCH + 20;

    const renderTerminalColsBlock = (rows, startGridX, title) => {
      const leftX = BOARD_ORIGIN_X + startGridX * PITCH;
      const blockW = (rows.length - 1) * PITCH + 22;

      let rowHeaders = '';
      for (let c = 0; c < 3; c++) {
        rowHeaders += `<text x="${leftX - 15}" y="${firstHoleY + c * PITCH + 3}" class="sensor-col-letter">${colLetters[c]}</text>`;
      }

      let colLabels = '';
      rows.forEach((r, idx) => {
        const cx = leftX + idx * PITCH;
        const labelY = isTop ? lastHoleY + 18 : firstHoleY - 13;
        colLabels += `
          <text x="${cx}" y="${labelY}" class="sensor-row-label" text-anchor="middle" style="font-size:6.4px">${r.short}</text>
        `;
      });

      const titleY = isTop ? lastHoleY + 29 : firstHoleY - 23;
      return `
        <g class="external-sensor-selectable">
          <text x="${leftX + ((rows.length - 1) * PITCH) / 2}" y="${titleY}" class="sensor-block-title">${title}</text>
          <rect x="${leftX - 11}" y="${firstHoleY - 10}" width="${blockW}" height="${blockH}" rx="4"
                fill="#f1f5f9" ${selStroke}/>
          ${rowHeaders}
          ${colLabels}
        </g>
      `;
    };

    let markup = '';
    const wireAttachY = isTop ? firstHoleY - 6 : lastHoleY + 6;

    if (breadboard.loadCellsMode) {
      const fbLeftX = BOARD_ORIGIN_X + ext.fbStartGridX * PITCH;
      const hb1LeftX = BOARD_ORIGIN_X + ext.hb1StartGridX * PITCH;
      const hb2LeftX = BOARD_ORIGIN_X + ext.hb2StartGridX * PITCH;

      markup += renderTerminalColsBlock(LOAD_CELL_FULL_BRIDGE_ROWS, ext.fbStartGridX, 'FULL-BRIDGE');
      markup += renderTerminalColsBlock(LOAD_CELL_HALF_BRIDGE_1_ROWS, ext.hb1StartGridX, 'HALF-BRIDGE #1');
      markup += renderTerminalColsBlock(LOAD_CELL_HALF_BRIDGE_2_ROWS, ext.hb2StartGridX, 'HALF-BRIDGE #2');

      // 1A. Rectangular Bar Full-Bridge Load Cell above/below its 4 columns
      const barW = 118;
      const barH = 36;
      const barX = fbLeftX + 1.5 * PITCH - barW / 2;
      const barY = isTop ? firstHoleY - 78 : lastHoleY + 42;
      const cableExitY = isTop ? barY + barH : barY;

      let fbWires = '';
      LOAD_CELL_FULL_BRIDGE_ROWS.forEach((r, idx) => {
        const wx = fbLeftX + idx * PITCH;
        const sx = barX + 32 + idx * 18;
        const midY = (cableExitY + wireAttachY) / 2;
        if (r.wireColor === '#f8fafc') {
          fbWires += `<path d="M ${sx} ${cableExitY} C ${sx} ${midY}, ${wx} ${midY}, ${wx} ${wireAttachY}" fill="none" stroke="#334155" stroke-width="4.2" stroke-linecap="round"/>`;
        }
        fbWires += `<path d="M ${sx} ${cableExitY} C ${sx} ${midY}, ${wx} ${midY}, ${wx} ${wireAttachY}" fill="none" stroke="${r.wireColor}" stroke-width="2.6" stroke-linecap="round"/>`;
      });

      markup += `
        <g class="external-sensor-group external-sensor-selectable">
          ${fbWires}
          <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="4" fill="#cbd5e1" stroke="${isSensorSelected ? '#38bdf8' : '#475569'}" stroke-width="1.5"/>
          <rect x="${barX + 2}" y="${barY + 2}" width="${barW - 4}" height="6" rx="2" fill="rgba(255,255,255,0.45)"/>
          <circle cx="${barX + 12}" cy="${barY + 10}" r="3.3" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
          <circle cx="${barX + 12}" cy="${barY + 26}" r="3.3" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
          <circle cx="${barX + barW - 12}" cy="${barY + 10}" r="3.3" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
          <circle cx="${barX + barW - 12}" cy="${barY + 26}" r="3.3" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
          <circle cx="${barX + 48}" cy="${barY + 18}" r="9" fill="#0f172a" stroke="#64748b" stroke-width="1"/>
          <circle cx="${barX + 70}" cy="${barY + 18}" r="9" fill="#0f172a" stroke="#64748b" stroke-width="1"/>
          <rect x="${barX + 48}" y="${barY + 14.5}" width="22" height="7" fill="#0f172a"/>
          <rect x="${barX + 42}" y="${barY - 1.5}" width="34" height="4" rx="1.5" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.7"/>
          <rect x="${barX + 42}" y="${barY + barH - 2.5}" width="34" height="4" rx="1.5" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.7"/>
          <polygon points="${barX + 92},${barY + 8} ${barX + 100},${barY + 18} ${barX + 92},${barY + 28} ${barX + 84},${barY + 18}"
                   fill="rgba(15,23,42,0.75)" stroke="#38bdf8" stroke-width="1.1"/>
          <text x="${barX + barW / 2}" y="${isTop ? barY - 6 : barY + barH + 11}" class="sensor-diagram-caption" text-anchor="middle">RECTANGULAR FULL-BRIDGE</text>
        </g>
      `;

      // 1B. Pair of E-Shaped Half-Bridge Load Cells above/below their 3 columns
      const renderEShapedHoriz = (rows, leftX, cellTitle) => {
        const eW = 86;
        const eH = 38;
        const eX = leftX + PITCH - eW / 2;
        const eY = isTop ? firstHoleY - 78 : lastHoleY + 42;
        const eCableY = isTop ? eY + eH : eY;

        let hbWires = '';
        rows.forEach((r, idx) => {
          const wx = leftX + idx * PITCH;
          const sx = eX + 25 + idx * 18;
          const midY = (eCableY + wireAttachY) / 2;
          if (r.wireColor === '#f8fafc') {
            hbWires += `<path d="M ${sx} ${eCableY} C ${sx} ${midY}, ${wx} ${midY}, ${wx} ${wireAttachY}" fill="none" stroke="#334155" stroke-width="4.2" stroke-linecap="round"/>`;
          }
          hbWires += `<path d="M ${sx} ${eCableY} C ${sx} ${midY}, ${wx} ${midY}, ${wx} ${wireAttachY}" fill="none" stroke="${r.wireColor}" stroke-width="2.6" stroke-linecap="round"/>`;
        });

        return `
          <g class="external-sensor-group external-sensor-selectable">
            ${hbWires}
            <rect x="${eX}" y="${eY}" width="${eW}" height="${eH}" rx="4" fill="#cbd5e1" stroke="${isSensorSelected ? '#38bdf8' : '#475569'}" stroke-width="1.5"/>
            <path d="M ${eX + 16} ${eY + 5.5} H ${eX + eW - 9} V ${eY + 13} H ${eX + 16} Z" fill="#0f172a" stroke="#64748b" stroke-width="0.9"/>
            <path d="M ${eX + 16} ${eY + 25} H ${eX + eW - 9} V ${eY + 32.5} H ${eX + 16} Z" fill="#0f172a" stroke="#64748b" stroke-width="0.9"/>
            <rect x="${eX + eW - 15}" y="${eY + 5.5}" width="6" height="27" fill="#0f172a"/>
            <rect x="${eX + 22}" y="${eY + 15.5}" width="14" height="7" rx="1" fill="#f59e0b" stroke="#78350f" stroke-width="0.8"/>
            <rect x="${eX + 40}" y="${eY + 15.5}" width="14" height="7" rx="1" fill="#f59e0b" stroke="#78350f" stroke-width="0.8"/>
            <circle cx="${eX + 63}" cy="${eY + 19}" r="4.2" fill="#475569" stroke="#f8fafc" stroke-width="1"/>
            <text x="${eX + eW / 2}" y="${isTop ? eY - 6 : eY + eH + 11}" class="sensor-diagram-caption" text-anchor="middle">${cellTitle}</text>
          </g>
        `;
      };

      markup += renderEShapedHoriz(LOAD_CELL_HALF_BRIDGE_1_ROWS, hb1LeftX, 'E-HALF-BRIDGE #1');
      markup += renderEShapedHoriz(LOAD_CELL_HALF_BRIDGE_2_ROWS, hb2LeftX, 'E-HALF-BRIDGE #2');
    }

    if (breadboard.emgMode) {
      const emgLeftX = BOARD_ORIGIN_X + ext.emgStartGridX * PITCH;
      markup += renderTerminalColsBlock(EMG_PAD_ROWS, ext.emgStartGridX, '3-PAD EMG');

      const cardW = 122;
      const cardH = 48;
      const cardX = emgLeftX + PITCH - cardW / 2;
      const cardY = isTop ? firstHoleY - 84 : lastHoleY + 40;
      const exitY = isTop ? cardY + cardH : cardY;

      const pads = [
        { cx: cardX + 23, cy: cardY + 21, color: '#ef4444', ring: '#fca5a5', label: 'RED 1' },
        { cx: cardX + 61, cy: cardY + 21, color: '#dc2626', ring: '#fca5a5', label: 'RED 2' },
        { cx: cardX + 99, cy: cardY + 21, color: '#1e293b', ring: '#94a3b8', label: 'BLACK' }
      ];

      let emgWires = '';
      EMG_PAD_ROWS.forEach((r, idx) => {
        const wx = emgLeftX + idx * PITCH;
        const pad = pads[idx];
        const midY = (exitY + wireAttachY) / 2;
        emgWires += `
          <line x1="${pad.cx}" y1="${pad.cy}" x2="${pad.cx}" y2="${exitY}" stroke="${r.wireColor}" stroke-width="2.2" opacity="0.85"/>
          <path d="M ${pad.cx} ${exitY} C ${pad.cx} ${midY}, ${wx} ${midY}, ${wx} ${wireAttachY}"
                fill="none" stroke="${r.wireColor}" stroke-width="2.8" stroke-linecap="round"/>
        `;
      });

      let padsSvg = '';
      for (const p of pads) {
        padsSvg += `
          <circle cx="${p.cx}" cy="${p.cy}" r="13.5" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.3"/>
          <circle cx="${p.cx}" cy="${p.cy}" r="7.6" fill="${p.color}" stroke="${p.ring}" stroke-width="1.1"/>
          <circle cx="${p.cx}" cy="${p.cy}" r="2.9" fill="#e2e8f0" stroke="#475569" stroke-width="0.8"/>
          <text x="${p.cx}" y="${p.cy + 21}" class="sensor-pad-label" text-anchor="middle">${p.label}</text>
        `;
      }

      markup += `
        <g class="external-sensor-group external-sensor-selectable">
          <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="8"
                fill="rgba(15, 23, 42, 0.82)" stroke="${isSensorSelected ? '#38bdf8' : '#475569'}" stroke-width="1.4"/>
          <text x="${cardX + cardW / 2}" y="${isTop ? cardY - 5 : cardY + cardH + 11}" class="sensor-diagram-caption" text-anchor="middle">3-PAD SURFACE EMG</text>
          ${emgWires}
          ${padsSvg}
        </g>
      `;
    }

    return markup;
  }

  // =========================================================================
  // VERTICAL STACK ORIENTATION ('left' or 'right' of the breadboard)
  // =========================================================================
  const firstHoleX = BOARD_ORIGIN_X + ext.startGridX * PITCH;
  const lastHoleX = firstHoleX + 2 * PITCH;
  const blockW = 2 * PITCH + 20;
  const isRight = ext.side === 'right';

  const renderTerminalRowsBlock = (rows, startGridY, title) => {
    const topY = BOARD_ORIGIN_Y + startGridY * PITCH;
    const blockH = (rows.length - 1) * PITCH + 20;

    let colHeaders = '';
    for (let c = 0; c < 3; c++) {
      colHeaders += `<text x="${firstHoleX + c * PITCH}" y="${topY - 12}" class="sensor-col-letter">${colLetters[c]}</text>`;
    }

    let rowLabels = '';
    rows.forEach((r, idx) => {
      const ry = topY + idx * PITCH;
      const labelX = isRight ? firstHoleX - 13 : lastHoleX + 13;
      const anchor = isRight ? 'end' : 'start';
      rowLabels += `
        <text x="${labelX}" y="${ry + 3}" class="sensor-row-label" text-anchor="${anchor}">${r.short}</text>
      `;
    });

    return `
      <g class="external-sensor-selectable">
        <text x="${firstHoleX + PITCH}" y="${topY - 22}" class="sensor-block-title">${title}</text>
        <rect x="${firstHoleX - 10}" y="${topY - 10}" width="${blockW}" height="${blockH}" rx="4"
              fill="#f1f5f9" ${selStroke}/>
        ${colHeaders}
        ${rowLabels}
      </g>
    `;
  };

  let markup = '';

  // -------------------------------------------------------------------------
  // 1. Load Cells: Rectangular Full-Bridge + Pair of E-Shaped Half-Bridges
  // -------------------------------------------------------------------------
  if (breadboard.loadCellsMode) {
    const fbTopY = BOARD_ORIGIN_Y + ext.fbStartGridY * PITCH;
    const hb1TopY = BOARD_ORIGIN_Y + ext.hb1StartGridY * PITCH;
    const hb2TopY = BOARD_ORIGIN_Y + ext.hb2StartGridY * PITCH;

    markup += renderTerminalRowsBlock(LOAD_CELL_FULL_BRIDGE_ROWS, ext.fbStartGridY, 'FULL-BRIDGE');
    markup += renderTerminalRowsBlock(LOAD_CELL_HALF_BRIDGE_1_ROWS, ext.hb1StartGridY, 'HALF-BRIDGE #1');
    markup += renderTerminalRowsBlock(LOAD_CELL_HALF_BRIDGE_2_ROWS, ext.hb2StartGridY, 'HALF-BRIDGE #2');

    // Device Illustrations sit outward from the terminal strip
    const devX = isRight ? lastHoleX + 76 : firstHoleX - 208;
    const wireAttachX = isRight ? lastHoleX + 6 : firstHoleX - 6;

    // 1A. Rectangular Bar Full-Bridge Load Cell Diagram (4-Wire)
    const barY = fbTopY + 4;
    const barW = 122;
    const barH = 38;
    const cableExitX = isRight ? devX : devX + barW;

    let fbWires = '';
    LOAD_CELL_FULL_BRIDGE_ROWS.forEach((r, idx) => {
      const wy = fbTopY + idx * PITCH;
      const startY = barY + 9 + idx * 6.5;
      const midX = (cableExitX + wireAttachX) / 2;
      if (r.wireColor === '#f8fafc') {
        fbWires += `<path d="M ${cableExitX} ${startY} C ${midX} ${startY}, ${midX} ${wy}, ${wireAttachX} ${wy}" fill="none" stroke="#334155" stroke-width="4.2" stroke-linecap="round"/>`;
      }
      fbWires += `<path d="M ${cableExitX} ${startY} C ${midX} ${startY}, ${midX} ${wy}, ${wireAttachX} ${wy}" fill="none" stroke="${r.wireColor}" stroke-width="2.6" stroke-linecap="round"/>`;
    });

    markup += `
      <g class="external-sensor-group external-sensor-selectable">
        ${fbWires}
        <!-- Rectangular Aluminum Bar Full-Bridge Load Cell Body -->
        <rect x="${devX}" y="${barY}" width="${barW}" height="${barH}" rx="4" fill="#cbd5e1" stroke="${isSensorSelected ? '#38bdf8' : '#475569'}" stroke-width="1.5"/>
        <rect x="${devX + 2}" y="${barY + 2}" width="${barW - 4}" height="6" rx="2" fill="rgba(255,255,255,0.45)"/>
        <!-- Mounting Bolt Holes on Left & Right Ends -->
        <circle cx="${devX + 12}" cy="${barY + 11}" r="3.5" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
        <circle cx="${devX + 12}" cy="${barY + 27}" r="3.5" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
        <circle cx="${devX + barW - 12}" cy="${barY + 11}" r="3.5" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
        <circle cx="${devX + barW - 12}" cy="${barY + 27}" r="3.5" fill="#1e293b" stroke="#64748b" stroke-width="1"/>
        <!-- Central Binocular Keyhole Flexure Cutout -->
        <circle cx="${devX + 50}" cy="${barY + 19}" r="9.5" fill="#0f172a" stroke="#64748b" stroke-width="1"/>
        <circle cx="${devX + 72}" cy="${barY + 19}" r="9.5" fill="#0f172a" stroke="#64748b" stroke-width="1"/>
        <rect x="${devX + 50}" y="${barY + 15.5}" width="22" height="7" fill="#0f172a"/>
        <!-- White Silicone Strain Gauge Patch on Top & Bottom Flexure Necks -->
        <rect x="${devX + 44}" y="${barY - 1.5}" width="34" height="4" rx="1.5" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.7"/>
        <rect x="${devX + 44}" y="${barY + barH - 2.5}" width="34" height="4" rx="1.5" fill="#f8fafc" stroke="#94a3b8" stroke-width="0.7"/>
        <!-- Wheatstone Full-Bridge Diamond Symbol -->
        <polygon points="${devX + 94},${barY + 9} ${devX + 103},${barY + 19} ${devX + 94},${barY + 29} ${devX + 85},${barY + 19}"
                 fill="rgba(15,23,42,0.75)" stroke="#38bdf8" stroke-width="1.1"/>
        <text x="${devX + barW / 2}" y="${barY - 6}" class="sensor-diagram-caption" text-anchor="middle">RECTANGULAR FULL-BRIDGE</text>
      </g>
    `;

    // 1B. Pair of E-Shaped Half-Bridge Load Cells (2 x 3-Wire)
    const renderEShapedCell = (rows, topY, cellTitle) => {
      const eW = 86;
      const eH = 40;
      const eX = isRight ? devX + 10 : devX + 26;
      const eY = topY - 4;
      const eCableX = isRight ? eX : eX + eW;

      let hbWires = '';
      rows.forEach((r, idx) => {
        const wy = topY + idx * PITCH;
        const sy = eY + 11 + idx * 9;
        const midX = (eCableX + wireAttachX) / 2;
        if (r.wireColor === '#f8fafc') {
          hbWires += `<path d="M ${eCableX} ${sy} C ${midX} ${sy}, ${midX} ${wy}, ${wireAttachX} ${wy}" fill="none" stroke="#334155" stroke-width="4.2" stroke-linecap="round"/>`;
        }
        hbWires += `<path d="M ${eCableX} ${sy} C ${midX} ${sy}, ${midX} ${wy}, ${wireAttachX} ${wy}" fill="none" stroke="${r.wireColor}" stroke-width="2.6" stroke-linecap="round"/>`;
      });

      // E-shaped stamped steel frame: outer rectangle with upper & lower U-slots forming an 'E' tongue
      return `
        <g class="external-sensor-group external-sensor-selectable">
          ${hbWires}
          <!-- Stamped Steel E-Frame Outer Body -->
          <rect x="${eX}" y="${eY}" width="${eW}" height="${eH}" rx="4" fill="#cbd5e1" stroke="${isSensorSelected ? '#38bdf8' : '#475569'}" stroke-width="1.5"/>
          <!-- Upper & Lower Cutout Slots forming the E-Shaped Cantilever Beam -->
          <path d="M ${eX + 16} ${eY + 6} H ${eX + eW - 9} V ${eY + 14} H ${eX + 16} Z" fill="#0f172a" stroke="#64748b" stroke-width="0.9"/>
          <path d="M ${eX + 16} ${eY + 26} H ${eX + eW - 9} V ${eY + 34} H ${eX + 16} Z" fill="#0f172a" stroke="#64748b" stroke-width="0.9"/>
          <rect x="${eX + eW - 15}" y="${eY + 6}" width="6" height="28" fill="#0f172a"/>
          <!-- Active & Dummy Strain Gauges on Central E-Tongue (R1 / R2 Half-Bridge) -->
          <rect x="${eX + 22}" y="${eY + 16.5}" width="14" height="7" rx="1" fill="#f59e0b" stroke="#78350f" stroke-width="0.8"/>
          <rect x="${eX + 40}" y="${eY + 16.5}" width="14" height="7" rx="1" fill="#f59e0b" stroke="#78350f" stroke-width="0.8"/>
          <!-- Load Button Boss on Tip of E-Tongue -->
          <circle cx="${eX + 63}" cy="${eY + 20}" r="4.5" fill="#475569" stroke="#f8fafc" stroke-width="1"/>
          <text x="${eX + eW / 2}" y="${eY - 4}" class="sensor-diagram-caption" text-anchor="middle">${cellTitle}</text>
        </g>
      `;
    };

    markup += renderEShapedCell(LOAD_CELL_HALF_BRIDGE_1_ROWS, hb1TopY, 'E-SHAPE HALF-BRIDGE #1');
    markup += renderEShapedCell(LOAD_CELL_HALF_BRIDGE_2_ROWS, hb2TopY, 'E-SHAPE HALF-BRIDGE #2');
  }

  // -------------------------------------------------------------------------
  // 2. 3-Pad EMG Sensor (Two Red Muscle Electrodes + One Black Common/Ref)
  // -------------------------------------------------------------------------
  if (breadboard.emgMode) {
    const emgTopY = BOARD_ORIGIN_Y + ext.emgStartGridY * PITCH;
    markup += renderTerminalRowsBlock(EMG_PAD_ROWS, ext.emgStartGridY, '3-PAD EMG');

    const devX = isRight ? lastHoleX + 76 : firstHoleX - 208;
    const wireAttachX = isRight ? lastHoleX + 6 : firstHoleX - 6;
    const cardW = 128;
    const cardH = 54;
    const cardY = emgTopY - 10;

    // Electrode pad centers inside the card: RED 1 (left), RED 2 (middle), BLACK COM (right)
    const pads = [
      { cx: devX + 25, cy: cardY + 25, color: '#ef4444', ring: '#fca5a5', label: 'RED 1', sub: 'MID +' },
      { cx: devX + 64, cy: cardY + 25, color: '#dc2626', ring: '#fca5a5', label: 'RED 2', sub: 'END −' },
      { cx: devX + 103, cy: cardY + 25, color: '#1e293b', ring: '#94a3b8', label: 'BLACK', sub: 'COM' }
    ];

    let emgWires = '';
    EMG_PAD_ROWS.forEach((r, idx) => {
      const wy = emgTopY + idx * PITCH;
      const pad = pads[idx];
      const exitX = isRight ? devX : devX + cardW;
      const exitY = cardY + 13 + idx * 14;
      const midX = (exitX + wireAttachX) / 2;
      emgWires += `
        <line x1="${pad.cx}" y1="${pad.cy}" x2="${exitX}" y2="${exitY}" stroke="${r.wireColor}" stroke-width="2.2" opacity="0.85"/>
        <path d="M ${exitX} ${exitY} C ${midX} ${exitY}, ${midX} ${wy}, ${wireAttachX} ${wy}"
              fill="none" stroke="${r.wireColor}" stroke-width="2.8" stroke-linecap="round"/>
      `;
    });

    let padsSvg = '';
    for (const p of pads) {
      padsSvg += `
        <!-- Adhesive Foam Pad -->
        <circle cx="${p.cx}" cy="${p.cy}" r="14.5" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.3"/>
        <!-- Colored Electrode Snap Cap -->
        <circle cx="${p.cx}" cy="${p.cy}" r="8.2" fill="${p.color}" stroke="${p.ring}" stroke-width="1.1"/>
        <!-- Metallic Snap Stud -->
        <circle cx="${p.cx}" cy="${p.cy}" r="3.1" fill="#e2e8f0" stroke="#475569" stroke-width="0.8"/>
        <text x="${p.cx}" y="${p.cy + 23}" class="sensor-pad-label" text-anchor="middle">${p.label}</text>
      `;
    }

    markup += `
      <g class="external-sensor-group external-sensor-selectable">
        <rect x="${devX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="8"
              fill="rgba(15, 23, 42, 0.82)" stroke="${isSensorSelected ? '#38bdf8' : '#475569'}" stroke-width="1.4"/>
        <text x="${devX + cardW / 2}" y="${cardY - 5}" class="sensor-diagram-caption" text-anchor="middle">3-PAD SURFACE EMG ELECTRODES</text>
        ${emgWires}
        ${padsSvg}
      </g>
    `;
  }

  return markup;
}
