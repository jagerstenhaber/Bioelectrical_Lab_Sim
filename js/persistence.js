/**
 * Circuit Persistence, Serialization, Starter Circuit & SVG Export Module
 * Supports Bioelectrical Lab Sim v5 format and backwards-compatible glowing-waddle v4 JSON payloads.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const STORAGE_KEY = 'bioelectrical_lab_sim_v1';

/**
 * Serializes the current breadboard configuration, placed parts, wires, and optional extras into a v5 JSON object.
 * @param {import('./breadboard.js').BreadboardModel} breadboard
 * @param {Array<object>} placedParts
 * @param {Array<object>} wires
 * @param {object} [extras]
 * @returns {object}
 */
export function serializeCircuitState(breadboard, placedParts, wires, extras = {}) {
  const payload = {
    version: 5,
    elvisMode: Boolean(breadboard?.elvisMode),
    loadCellsMode: Boolean(breadboard?.loadCellsMode),
    emgMode: Boolean(breadboard?.emgMode),
    pulseOxMode: Boolean(breadboard?.pulseOxMode),
    sensorPosition: breadboard?.sensorPosition || 'auto',
    placedParts: Array.isArray(placedParts) ? placedParts : [],
    wires: Array.isArray(wires) ? wires : []
  };

  if (extras && typeof extras === 'object') {
    if (extras.name !== undefined) payload.name = extras.name;
    if (extras.exportedAt !== undefined) payload.exportedAt = extras.exportedAt;
    if (extras.simState !== undefined) payload.simState = extras.simState;
    if (extras.props !== undefined) payload.props = extras.props;
  }

  return payload;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const VALID_WIRE_STYLES = new Set(['curved', 'curved-alt', 'straight']);
const VALID_SENSOR_POSITIONS = new Set(['auto', 'top', 'right', 'bottom', 'left']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates and normalizes both legacy glowing-waddle v4 and new v5 JSON payloads.
 * Returns null if the payload is invalid or missing required arrays.
 * @param {unknown} data
 * @returns {object | null}
 */
export function parseCircuitState(data) {
  if (!isPlainObject(data)) {
    return null;
  }
  if (!Array.isArray(data.placedParts) || !Array.isArray(data.wires)) {
    return null;
  }

  const usedPartIds = new Set();
  let synthPartSeq = 1;
  const normalizedParts = [];

  for (const part of data.placedParts) {
    if (!isPlainObject(part) || typeof part.partId !== 'string' || part.partId.length === 0) {
      return null;
    }

    const hasAnchor = typeof part.anchorHoleId === 'string' && part.anchorHoleId.length > 0;
    const hasPins =
      isPlainObject(part.pinHoles) &&
      typeof part.pinHoles.P1 === 'string' &&
      part.pinHoles.P1.length > 0 &&
      typeof part.pinHoles.P2 === 'string' &&
      part.pinHoles.P2.length > 0;

    if (!hasAnchor && !hasPins) {
      return null;
    }

    let id = typeof part.id === 'string' && part.id.length > 0 ? part.id : '';
    while (!id || usedPartIds.has(id)) {
      id = `${part.partId}_restored_${synthPartSeq++}`;
    }
    usedPartIds.add(id);

    const normalizedPart = hasAnchor
      ? {
          id,
          partId: part.partId,
          anchorHoleId: part.anchorHoleId,
          rotation: typeof part.rotation === 'number' && Number.isFinite(part.rotation) ? part.rotation : 0
        }
      : {
          id,
          partId: part.partId,
          pinHoles: {
            P1: part.pinHoles.P1,
            P2: part.pinHoles.P2
          }
        };

    if (isPlainObject(part.props)) {
      normalizedPart.props = { ...part.props };
    }

    normalizedParts.push(normalizedPart);
  }

  const usedWireIds = new Set();
  let synthWireSeq = 1;
  const normalizedWires = [];

  for (const wire of data.wires) {
    if (
      !isPlainObject(wire) ||
      typeof wire.holeA !== 'string' ||
      wire.holeA.length === 0 ||
      typeof wire.holeB !== 'string' ||
      wire.holeB.length === 0
    ) {
      return null;
    }

    let id = typeof wire.id === 'string' && wire.id.length > 0 ? wire.id : '';
    while (!id || usedWireIds.has(id)) {
      id = `wire_restored_${synthWireSeq++}`;
    }
    usedWireIds.add(id);

    const color =
      typeof wire.color === 'string' && HEX_COLOR_RE.test(wire.color)
        ? wire.color
        : '#ef4444';
    const colorName =
      typeof wire.colorName === 'string' && wire.colorName.trim().length > 0
        ? wire.colorName
        : 'Wire';
    const style =
      typeof wire.style === 'string' && VALID_WIRE_STYLES.has(wire.style)
        ? wire.style
        : 'curved';

    normalizedWires.push({
      id,
      holeA: wire.holeA,
      holeB: wire.holeB,
      color,
      colorName,
      style
    });
  }

  const sensorPosition = VALID_SENSOR_POSITIONS.has(data.sensorPosition)
    ? data.sensorPosition
    : 'auto';

  const result = {
    version: Number.isFinite(Number(data.version)) ? Number(data.version) : 4,
    elvisMode: Boolean(data.elvisMode),
    loadCellsMode: Boolean(data.loadCellsMode),
    emgMode: Boolean(data.emgMode),
    pulseOxMode: Boolean(data.pulseOxMode),
    sensorPosition,
    placedParts: normalizedParts,
    wires: normalizedWires
  };

  if (isPlainObject(data.simState)) {
    result.simState = { ...data.simState };
  }
  if (isPlainObject(data.props)) {
    result.props = { ...data.props };
  }

  return result;
}

/**
 * Saves the current circuit state to localStorage under STORAGE_KEY.
 */
export function saveCircuitToLocalStorage(breadboard, placedParts, wires, extras = {}) {
  try {
    const payload = serializeCircuitState(breadboard, placedParts, wires, extras);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {
    // Ignore quota or storage unavailability errors
  }
}

/**
 * Loads and validates circuit state from localStorage.
 * Returns normalized state or null if absent/invalid.
 */
export function loadCircuitFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return parseCircuitState(data);
  } catch (_) {
    return null;
  }
}

/**
 * Triggers a browser file download of the current circuit as a .json file.
 */
export function downloadCircuitJson(breadboard, placedParts, wires, extras = {}) {
  const payload = serializeCircuitState(breadboard, placedParts, wires, {
    name: 'bioelectrical-circuit',
    exportedAt: new Date().toISOString(),
    ...extras
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'breadboard-circuit.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Exports a clean standalone SVG image of the breadboard and placed components.
 */
export function exportBreadboardSvg(svgEl) {
  const clone = svgEl.cloneNode(true);
  const vp = clone.querySelector('#viewport-root');
  if (vp) vp.removeAttribute('transform');
  const runtimeLayer = clone.querySelector('#layer-runtime-overlay');
  if (runtimeLayer) runtimeLayer.innerHTML = '';

  const styleEl = document.createElementNS(SVG_NS, 'style');
  styleEl.textContent = `
    .bb-label-col { font: 700 8.5px monospace; fill: #64748b; text-anchor: middle; }
    .bb-label-row { font: 700 9.5px monospace; fill: #475569; text-anchor: middle; }
    .bb-rail-plus { font: 800 13px monospace; fill: #ef4444; text-anchor: middle; }
    .bb-rail-minus { font: 800 13px monospace; fill: #3b82f6; text-anchor: middle; }
    .elvis-block-title, .sensor-block-title { font: 800 8.5px sans-serif; fill: #fde047; text-anchor: middle; paint-order: stroke; stroke: #0f172a; stroke-width: 2.2px; stroke-linejoin: round; }
    .elvis-col-letter, .sensor-col-letter { font: 700 7.5px monospace; fill: #e2e8f0; text-anchor: middle; paint-order: stroke; stroke: #0f172a; stroke-width: 2px; stroke-linejoin: round; }
    .elvis-row-num { font: 700 7.2px monospace; fill: #cbd5e1; text-anchor: end; }
    .elvis-row-signal, .sensor-row-label { font: 700 7.5px monospace; fill: #ffffff; paint-order: stroke; stroke: #0f172a; stroke-width: 2.2px; stroke-linejoin: round; }
    .sensor-diagram-caption { font: 800 7.5px sans-serif; fill: #38bdf8; paint-order: stroke; stroke: #0f172a; stroke-width: 2.2px; stroke-linejoin: round; }
    .sensor-pad-label { font: 700 6.8px monospace; fill: #e2e8f0; paint-order: stroke; stroke: #0f172a; stroke-width: 2px; stroke-linejoin: round; }
    .elvis-bracket-label { font: 700 7.5px sans-serif; fill: #bbf7d0; text-anchor: end; }
    .elvis-sig-power { fill: #fca5a5; }
    .elvis-sig-ground { fill: #93c5fd; }
    .elvis-sig-gen { fill: #fde047; }
    .part-floating-label { font: 700 7.5px monospace; fill: #0f172a; text-anchor: middle; paint-order: stroke; stroke: rgba(255, 255, 255, 0.94); stroke-width: 2.5px; stroke-linejoin: round; opacity: 1; }
    .bb-hole-hit, .footprint-pin-hit, .pin-drag-handle, .lead-handle-group { display: none; }
    .bb-hole-bevel { fill: #cbd5e1; stroke: #94a3b8; stroke-width: 0.6; }
    .bb-hole-socket { fill: #334155; }
  `;
  clone.prepend(styleEl);

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'breadboard-layout.svg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Generates the starter Arduino Nano + Dual Op-Amp demo circuit.
 * @param {boolean} elvisMode
 * @param {(prefix?: string) => string} generateId
 * @returns {{ placedParts: Array<object>, wires: Array<object> }}
 */
export function createStarterCircuit(elvisMode, generateId) {
  const rot = elvisMode ? 90 : 0;
  const placedParts = [
    {
      id: generateId('arduino-nano'),
      partId: 'arduino-nano',
      anchorHoleId: 'd2',
      rotation: rot
    },
    {
      id: generateId('opamp-dual-dip8'),
      partId: 'opamp-dual-dip8',
      anchorHoleId: 'e22',
      rotation: rot
    },
    {
      id: generateId('cap-100nf'),
      partId: 'cap-100nf',
      pinHoles: { P1: 'a22', P2: 'TN22' }
    },
    {
      id: generateId('resistor-10k-1pct'),
      partId: 'resistor-10k-1pct',
      pinHoles: { P1: 'h23', P2: 'h27' }
    },
    {
      id: generateId('resistor-1k-1pct'),
      partId: 'resistor-1k-1pct',
      pinHoles: { P1: 'g22', P2: 'g23' }
    }
  ];

  const wires = [
    { id: generateId('wire'), holeA: 'j13', holeB: 'BP13', color: '#ef4444', colorName: 'Red' },
    { id: generateId('wire'), holeA: 'BP19', holeB: 'TP19', color: '#ef4444', colorName: 'Red' },
    { id: generateId('wire'), holeA: 'TP21', holeB: 'b22', color: '#ef4444', colorName: 'Red' },
    { id: generateId('wire'), holeA: 'a13', holeB: 'TN13', color: '#1e293b', colorName: 'Black' },
    { id: generateId('wire'), holeA: 'j15', holeB: 'BN15', color: '#1e293b', colorName: 'Black' },
    { id: generateId('wire'), holeA: 'j25', holeB: 'BN25', color: '#1e293b', colorName: 'Black' }
  ];

  return { placedParts, wires };
}
