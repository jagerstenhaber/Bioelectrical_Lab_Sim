import { analyzeCircuit } from '../connectivity.js';
import {
  DEFAULT_FGEN_CONFIG,
  clamp,
  createDefaultFgenConfig,
  getWaveformDcMean,
  solveLinearSystem
} from './linearAlgebra.js';

export { solveLinearSystem };

/**
 * Pure, zero-DOM Modified Nodal Analysis (MNA) DC Circuit Solver.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

export const DEFAULT_SIM_CONFIG = Object.freeze({
  powered: true,
  elvisSupplyPos: 5.0,
  elvisSupplyNeg: -5.0,
  loadCellForceGrams: 0,
  arduinoPinStates: Object.freeze({}),
  fgen: DEFAULT_FGEN_CONFIG
});

/**
 * Returns a fresh simulation config object with isolated nested state copies.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createDefaultSimConfig(overrides = {}) {
  const safeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  const rawPinStates =
    safeOverrides.arduinoPinStates && typeof safeOverrides.arduinoPinStates === 'object'
      ? safeOverrides.arduinoPinStates
      : {};
  return {
    ...DEFAULT_SIM_CONFIG,
    ...safeOverrides,
    arduinoPinStates: { ...rawPinStates },
    fgen: createDefaultFgenConfig(safeOverrides.fgen)
  };
}

const R_SOURCE_INT = 0.05;
const R_GROUND_INT = 1e-4;
const R_ARDUINO_GPIO = 25;
const G_MIN = 1e-11;
const R_CAP_DC = 1e9;
const R_SWITCH_CLOSED = 0.1;
const R_SWITCH_OPEN = 1e9;
const R_IC_INPUT = 1e7;
const R_IC_OUT = 20;
const R_FGEN_OUT = 50;
const OPAMP_A_OL = 1e5;
const MAX_ITERATIONS = 35;

const DIODE_PARAMS = Object.freeze({
  'diode-1n4007': { vf: 0.68, rOn: 2, rOff: 1e8 },
  'led-red': { vf: 1.9, rOn: 10, rOff: 1e8 }
});

/**
 * Returns default interactive runtime properties for a given catalog partId.
 * @param {string} partId
 * @returns {object}
 */
export function getDefaultPartProps(partId) {
  switch (partId) {
    case 'pot-side-turn':
    case 'pot-top-turn':
      return { wiper: 0.5, resistance: 10000 };
    case 'pushbutton-4pin':
      return { pressed: false };
    case 'photoresistor':
      return { lightLevel: 0.5 };
    default:
      return {};
  }
}

/**
 * Computes photoresistor (CdS LDR) resistance in Ohms from normalized lightLevel [0..1].
 * Dark (0) = 100 kΩ, Bright (1) = 500 Ω.
 * @param {number} lightLevel
 * @returns {number}
 */
export function getPhotoresistorOhms(lightLevel) {
  const level = Number.isFinite(lightLevel) ? clamp(lightLevel, 0, 1) : 0.5;
  return 100000 * Math.pow(500 / 100000, level);
}

function createZeroMatrix(n) {
  const A = new Array(n);
  for (let i = 0; i < n; i++) {
    A[i] = new Float64Array(n);
  }
  return A;
}

function stampConductance(A, idxA, idxB, g) {
  if (idxA == null || idxB == null || idxA === idxB || !Number.isFinite(g) || g <= 0) {
    return;
  }
  A[idxA][idxA] += g;
  A[idxB][idxB] += g;
  A[idxA][idxB] -= g;
  A[idxB][idxA] -= g;
}

function stampGroundConductance(A, idx, g) {
  if (idx == null || !Number.isFinite(g) || g <= 0) return;
  A[idx][idx] += g;
}

function stampVoltageSourceToGround(A, b, idx, voltage, rInt) {
  if (idx == null || !Number.isFinite(voltage) || !Number.isFinite(rInt) || rInt <= 0) {
    return;
  }
  const g = 1 / rInt;
  A[idx][idx] += g;
  b[idx] += voltage * g;
}

function buildStripToNetMap(connectivity) {
  const stripToNet = new Map();
  for (const [netId, net] of connectivity.nets.entries()) {
    for (const stripId of net.strips) {
      stripToNet.set(stripId, netId);
    }
  }
  return stripToNet;
}

function getNetIdForHole(breadboard, stripToNet, holeId) {
  if (!holeId) return null;
  const hole = breadboard.getHole(holeId);
  if (!hole) return null;
  return stripToNet.get(hole.stripId) || null;
}

function getLoadCellResistors(breadboard, stripToNet, loadCellForceGrams) {
  if (!breadboard.loadCellsMode) return [];

  const R0 = 1000;
  const force = Number.isFinite(loadCellForceGrams) ? clamp(loadCellForceGrams, -2000, 2000) : 0;
  const delta = (force / 1000) * 0.002;
  const rMinus = R0 * (1 - delta);
  const rPlus = R0 * (1 + delta);

  const pairs = [
    ['SENSOR_LC_FB_RED', 'SENSOR_LC_FB_GRN', rMinus],
    ['SENSOR_LC_FB_GRN', 'SENSOR_LC_FB_BLK', rPlus],
    ['SENSOR_LC_FB_RED', 'SENSOR_LC_FB_WHT', rPlus],
    ['SENSOR_LC_FB_WHT', 'SENSOR_LC_FB_BLK', rMinus],
    ['SENSOR_LC_HB1_BLK', 'SENSOR_LC_HB1_RED', rMinus],
    ['SENSOR_LC_HB1_RED', 'SENSOR_LC_HB1_WHT', rPlus],
    ['SENSOR_LC_HB2_BLK', 'SENSOR_LC_HB2_RED', rMinus],
    ['SENSOR_LC_HB2_RED', 'SENSOR_LC_HB2_WHT', rPlus]
  ];

  const resistors = [];
  for (const [stripA, stripB, ohms] of pairs) {
    const netA = stripToNet.get(stripA);
    const netB = stripToNet.get(stripB);
    if (netA && netB) {
      resistors.push({ netA, netB, ohms });
    }
  }
  return resistors;
}

function resolvePartProps(inst) {
  return {
    ...getDefaultPartProps(inst.partId),
    ...(inst.props && typeof inst.props === 'object' ? inst.props : {})
  };
}

function addAdjacencyEdge(adj, netA, netB) {
  if (!netA || !netB || netA === netB) return;
  if (!adj.has(netA)) adj.set(netA, new Set());
  if (!adj.has(netB)) adj.set(netB, new Set());
  adj.get(netA).add(netB);
  adj.get(netB).add(netA);
}

function runReachabilityBfs(seedNetIds, adjacency) {
  const visited = new Set();
  const queue = [];
  for (const netId of seedNetIds) {
    if (netId && !visited.has(netId)) {
      visited.add(netId);
      queue.push(netId);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    const neighbors = adjacency.get(curr);
    if (!neighbors) continue;
    for (const nxt of neighbors) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return visited;
}

/**
 * Extracts active voltage sources, ground references, passive resistors, and nonlinear/IC models
 * from the breadboard, connectivity, placedParts, catalogMap, and simConfig.
 */
function buildCircuitElements({ breadboard, connectivity, placedParts, catalogMap, config, stripToNet }) {
  const groundNets = new Set();
  const voltageSources = []; // { netId, voltage, rInt, label }
  const passiveResistors = []; // { netA, netB, ohms, instanceId? }
  const capacitors = []; // { inst, partDef, net1, net2 }
  const diodes = []; // { inst, partDef, net1, net2, vf, rOn, rOff, isLed, state }
  const opamps = []; // { inst, partDef, netVcc, netGnd, stages, powered }
  const inamps = []; // { inst, partDef, netVsP, netVsN, netInP, netInN, netOut, netRef, netRg1, netRg2, powered, state, rgOhms, gain }
  const partMeta = new Map(); // instanceId -> extracted metadata for results

  // 1. NI ELVIS II strip sources and reference grounds (unwired strips included!)
  if (breadboard.elvisMode && config.powered) {
    const supplyPos = Number.isFinite(config.elvisSupplyPos)
      ? config.elvisSupplyPos
      : DEFAULT_SIM_CONFIG.elvisSupplyPos;
    const supplyNeg = Number.isFinite(config.elvisSupplyNeg)
      ? config.elvisSupplyNeg
      : DEFAULT_SIM_CONFIG.elvisSupplyNeg;

    for (const [stripId, holes] of breadboard.strips.entries()) {
      const firstHole = holes[0];
      if (!firstHole || firstHole.type !== 'elvis') continue;
      const netId = stripToNet.get(stripId);
      if (!netId) continue;

      switch (firstHole.elvisLabel) {
        case 'GROUND':
        case 'AIGND':
          groundNets.add(netId);
          break;
        case '+5V':
          voltageSources.push({ netId, voltage: 5.0, rInt: R_SOURCE_INT, label: 'ELVIS +5V' });
          break;
        case '+15V':
          voltageSources.push({ netId, voltage: 15.0, rInt: R_SOURCE_INT, label: 'ELVIS +15V' });
          break;
        case '-15V':
          voltageSources.push({ netId, voltage: -15.0, rInt: R_SOURCE_INT, label: 'ELVIS -15V' });
          break;
        case 'SUPPLY +':
          voltageSources.push({ netId, voltage: supplyPos, rInt: R_SOURCE_INT, label: 'ELVIS SUPPLY +' });
          break;
        case 'SUPPLY -':
          voltageSources.push({ netId, voltage: supplyNeg, rInt: R_SOURCE_INT, label: 'ELVIS SUPPLY -' });
          break;
        default:
          break;
      }
    }
  }

  // 1b. Function Generator (FGEN) DC mean source (50 Ω source resistance)
  if (config.powered && config.fgen?.enabled) {
    const fgenDcOffsetV = getWaveformDcMean(config.fgen);
    const fgenNets = new Set();
    if (breadboard.elvisMode) {
      const elvisFgenNet = stripToNet.get('ELVIS_ROW_33');
      if (elvisFgenNet) fgenNets.add(elvisFgenNet);
    }
    if (config.fgen.probeHole) {
      const probeFgenNet = getNetIdForHole(breadboard, stripToNet, config.fgen.probeHole);
      if (probeFgenNet) fgenNets.add(probeFgenNet);
    }
    for (const netId of fgenNets) {
      voltageSources.push({
        netId,
        voltage: fgenDcOffsetV,
        rInt: R_FGEN_OUT,
        label: 'FGEN'
      });
    }
  }

  // 2. External load cell bridge resistors
  const loadCellResistors = getLoadCellResistors(breadboard, stripToNet, config.loadCellForceGrams);
  for (const r of loadCellResistors) {
    passiveResistors.push(r);
  }

  // 3. Placed parts
  const pinStates = config.arduinoPinStates && typeof config.arduinoPinStates === 'object'
    ? config.arduinoPinStates
    : {};

  for (const inst of placedParts) {
    const partDef = catalogMap.get(inst.partId);
    if (!partDef) continue;
    const props = resolvePartProps(inst);

    if (inst.partId === 'arduino-nano') {
      if (config.powered) {
        const instPinStates =
          pinStates[inst.id] && typeof pinStates[inst.id] === 'object' ? pinStates[inst.id] : null;
        for (const pin of partDef.pins || []) {
          const hole = connectivity.getPinHole(inst.id, pin.id);
          if (!hole) continue;
          const netId = stripToNet.get(hole.stripId);
          if (!netId) continue;

          if (pin.role === 'ground') {
            groundNets.add(netId);
          } else if (pin.id === '5V') {
            voltageSources.push({ netId, voltage: 5.0, rInt: R_SOURCE_INT, label: 'Nano 5V' });
          } else if (pin.id === '3V3') {
            voltageSources.push({ netId, voltage: 3.3, rInt: R_SOURCE_INT, label: 'Nano 3V3' });
          } else {
            const state = instPinStates?.[pin.id] ?? pinStates[pin.id];
            if (state && state.mode === 'OUTPUT' && Number.isFinite(state.voltage)) {
              voltageSources.push({
                netId,
                voltage: state.voltage,
                rInt: R_ARDUINO_GPIO,
                label: `Nano ${pin.id}`
              });
            }
          }
        }
      }
      continue;
    }

    if (partDef.unit === 'Ω' && Number.isFinite(partDef.value)) {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      const ohms = Math.max(1e-6, partDef.value);
      if (net1 && net2) {
        passiveResistors.push({ netA: net1, netB: net2, ohms, instanceId: inst.id });
      }
      partMeta.set(inst.id, { kind: 'resistor', ohms, net1, net2 });
      continue;
    }

    if (inst.partId === 'pot-side-turn' || inst.partId === 'pot-top-turn') {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const hW = connectivity.getPinHole(inst.id, 'WIPER');
      const h3 = connectivity.getPinHole(inst.id, 'P3');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const netW = hW ? stripToNet.get(hW.stripId) : null;
      const net3 = h3 ? stripToNet.get(h3.stripId) : null;

      const totalR = Math.max(1, Number.isFinite(props.resistance) ? props.resistance : 10000);
      const alpha = clamp(Number.isFinite(props.wiper) ? props.wiper : 0.5, 0.001, 0.999);
      const r1 = alpha * totalR;
      const r2 = (1 - alpha) * totalR;

      if (net1 && netW) {
        passiveResistors.push({ netA: net1, netB: netW, ohms: r1, instanceId: inst.id, segment: 'P1-WIPER' });
      }
      if (netW && net3) {
        passiveResistors.push({ netA: netW, netB: net3, ohms: r2, instanceId: inst.id, segment: 'WIPER-P3' });
      }
      partMeta.set(inst.id, { kind: 'pot', totalR, alpha, r1, r2, net1, netW, net3 });
      continue;
    }

    if (inst.partId === 'pushbutton-4pin') {
      const hA = connectivity.getPinHole(inst.id, 'P1') || connectivity.getPinHole(inst.id, 'P3');
      const hB = connectivity.getPinHole(inst.id, 'P2') || connectivity.getPinHole(inst.id, 'P4');
      const netA = hA ? stripToNet.get(hA.stripId) : null;
      const netB = hB ? stripToNet.get(hB.stripId) : null;
      const pressed = Boolean(props.pressed);
      const ohms = pressed ? R_SWITCH_CLOSED : R_SWITCH_OPEN;

      if (netA && netB) {
        passiveResistors.push({
          netA,
          netB,
          ohms,
          instanceId: inst.id,
          conductive: pressed
        });
      }
      partMeta.set(inst.id, { kind: 'pushbutton', pressed, ohms, netA, netB });
      continue;
    }

    if (inst.partId === 'photoresistor') {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      const lightLevel = Number.isFinite(props.lightLevel) ? clamp(props.lightLevel, 0, 1) : 0.5;
      const ohms = getPhotoresistorOhms(lightLevel);

      if (net1 && net2) {
        passiveResistors.push({ netA: net1, netB: net2, ohms, instanceId: inst.id });
      }
      partMeta.set(inst.id, { kind: 'photoresistor', lightLevel, ohms, net1, net2 });
      continue;
    }

    if (partDef.unit === 'F' && Number.isFinite(partDef.value)) {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      capacitors.push({ inst, partDef, net1, net2, polarized: Boolean(partDef.polarized), h1, h2 });
      continue;
    }

    if (inst.partId === 'diode-1n4007' || inst.partId === 'led-red') {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      const params = DIODE_PARAMS[inst.partId];
      diodes.push({
        inst,
        partDef,
        net1,
        net2,
        vf: params.vf,
        rOn: params.rOn,
        rOff: params.rOff,
        isLed: inst.partId === 'led-red',
        state: 'off'
      });
      continue;
    }

    if (inst.partId === 'opamp-dual-dip8') {
      const getPinNet = (pinId) => {
        const h = connectivity.getPinHole(inst.id, pinId);
        return h ? stripToNet.get(h.stripId) : null;
      };
      opamps.push({
        inst,
        partDef,
        netVcc: getPinNet('VCC'),
        netGnd: getPinNet('GND'),
        powered: false,
        vVcc: null,
        vGnd: null,
        stages: [
          {
            stage: 1,
            netInP: getPinNet('IN1+'),
            netInN: getPinNet('IN1-'),
            netOut: getPinNet('OUT1'),
            state: 'linear'
          },
          {
            stage: 2,
            netInP: getPinNet('IN2+'),
            netInN: getPinNet('IN2-'),
            netOut: getPinNet('OUT2'),
            state: 'linear'
          }
        ]
      });
      continue;
    }

    if (inst.partId === 'inamp-ad620') {
      const getPinNet = (pinId) => {
        const h = connectivity.getPinHole(inst.id, pinId);
        return h ? stripToNet.get(h.stripId) : null;
      };
      inamps.push({
        inst,
        partDef,
        netVsP: getPinNet('VS+'),
        netVsN: getPinNet('VS-'),
        netInP: getPinNet('IN+'),
        netInN: getPinNet('IN-'),
        netOut: getPinNet('OUT'),
        netRef: getPinNet('REF'),
        netRg1: getPinNet('RG1'),
        netRg2: getPinNet('RG2'),
        powered: false,
        vVsP: null,
        vVsN: null,
        rgOhms: Infinity,
        gain: 1,
        state: 'linear'
      });
    }
  }

  // Compute AD620 Rg parallel equivalent resistance from passive resistors/pots between RG1 & RG2
  for (const inamp of inamps) {
    if (!inamp.netRg1 || !inamp.netRg2 || inamp.netRg1 === inamp.netRg2) {
      inamp.rgOhms = Infinity;
      inamp.gain = 1;
      continue;
    }
    let gParallel = 0;
    for (const r of passiveResistors) {
      if (r.conductive === false) continue;
      if (
        (r.netA === inamp.netRg1 && r.netB === inamp.netRg2) ||
        (r.netA === inamp.netRg2 && r.netB === inamp.netRg1)
      ) {
        if (r.ohms > 0 && r.ohms < 1e8) {
          gParallel += 1 / r.ohms;
        }
      }
    }
    // Also handle a pot placed across RG1 and RG2 with WIPER left unconnected to any other part/wire
    for (const meta of partMeta.values()) {
      if (meta.kind === 'pot' && meta.net1 && meta.net3 && meta.netW) {
        const acrossRg =
          (meta.net1 === inamp.netRg1 && meta.net3 === inamp.netRg2) ||
          (meta.net1 === inamp.netRg2 && meta.net3 === inamp.netRg1);
        const wiperNet = connectivity.nets.get(meta.netW);
        const wiperIsolated =
          meta.netW !== inamp.netRg1 &&
          meta.netW !== inamp.netRg2 &&
          wiperNet &&
          wiperNet.wires.size === 0 &&
          wiperNet.pins.length === 1;
        if (acrossRg && wiperIsolated) {
          gParallel += 1 / meta.totalR;
        }
      }
    }

    if (gParallel > 0) {
      inamp.rgOhms = 1 / gParallel;
      inamp.gain = 1 + 49400 / inamp.rgOhms;
    } else {
      inamp.rgOhms = Infinity;
      inamp.gain = 1;
    }
  }

  return {
    groundNets,
    voltageSources,
    passiveResistors,
    capacitors,
    diodes,
    opamps,
    inamps,
    partMeta
  };
}

/**
 * Collects only active nets referenced by grounds, voltage sources, components, load cells,
 * or optional probe nets so untouched breadboard strips can be pruned before MNA assembly.
 */
function collectActiveNets(elements, extraNetIds = []) {
  const active = new Set();
  const add = (netId) => {
    if (netId) active.add(netId);
  };

  for (const netId of extraNetIds) add(netId);
  for (const netId of elements.groundNets) add(netId);
  for (const src of elements.voltageSources) add(src.netId);
  for (const r of elements.passiveResistors) {
    add(r.netA);
    add(r.netB);
  }
  for (const c of elements.capacitors) {
    add(c.net1);
    add(c.net2);
  }
  for (const d of elements.diodes) {
    add(d.net1);
    add(d.net2);
  }
  for (const op of elements.opamps) {
    add(op.netVcc);
    add(op.netGnd);
    for (const st of op.stages) {
      add(st.netInP);
      add(st.netInN);
      add(st.netOut);
    }
  }
  for (const ia of elements.inamps) {
    add(ia.netVsP);
    add(ia.netVsN);
    add(ia.netInP);
    add(ia.netInN);
    add(ia.netOut);
    add(ia.netRef);
    add(ia.netRg1);
    add(ia.netRg2);
  }

  return active;
}

/**
 * Computes the set of nets reachable via conductive DC paths from ground or active sources.
 */
function computeNonFloatingNets(elements, { includeConductingDiodes = false, includePoweredIcs = false } = {}) {
  const seeds = new Set();
  for (const g of elements.groundNets) seeds.add(g);
  for (const s of elements.voltageSources) seeds.add(s.netId);

  if (includePoweredIcs) {
    for (const op of elements.opamps) {
      if (!op.powered) continue;
      for (const st of op.stages) {
        if (st.netOut) seeds.add(st.netOut);
      }
    }
    for (const ia of elements.inamps) {
      if (ia.powered && ia.netOut) {
        seeds.add(ia.netOut);
      }
    }
  }

  const adj = new Map();
  for (const r of elements.passiveResistors) {
    if (r.conductive === false || r.ohms >= 1e8) continue;
    addAdjacencyEdge(adj, r.netA, r.netB);
  }

  if (includeConductingDiodes) {
    for (const d of elements.diodes) {
      if (d.state === 'on') {
        addAdjacencyEdge(adj, d.net1, d.net2);
      }
    }
  }

  return runReachabilityBfs(seeds, adj);
}

/**
 * Solves the DC steady-state operating point of the breadboard circuit using MNA.
 * @param {object} params
 * @param {import('../breadboard.js').BreadboardModel} params.breadboard
 * @param {object} [params.connectivity]
 * @param {Array<object>} [params.placedParts]
 * @param {Array<object>} [params.wires]
 * @param {Map<string, object>} params.catalogMap
 * @param {object} [params.simConfig]
 */
export function solveDcCircuit({
  breadboard,
  connectivity,
  placedParts = [],
  wires = [],
  catalogMap,
  simConfig = {}
}) {
  const config = createDefaultSimConfig(simConfig);
  const powered = config.powered !== false;
  const conn = connectivity || analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  const stripToNet = buildStripToNetMap(conn);

  const elements = buildCircuitElements({
    breadboard,
    connectivity: conn,
    placedParts,
    catalogMap,
    config: { ...config, powered },
    stripToNet
  });

  const allNetIds = Array.from(conn.nets.keys());
  const activeNetSet = collectActiveNets(elements);
  const netIds = allNetIds.filter((id) => activeNetSet.has(id));
  const netIndex = new Map();
  netIds.forEach((id, i) => netIndex.set(id, i));
  const n = netIds.length;

  const diagnostics = [];

  // Helper to stamp and solve the current state of the network
  const solveCurrentState = (nonFloatingRefNets) => {
    const A = createZeroMatrix(n);
    const b = new Float64Array(n);

    // G_min to 0V on every net prevents singular matrices on floating islands
    for (let i = 0; i < n; i++) {
      A[i][i] += G_MIN;
    }

    if (powered) {
      for (const netId of elements.groundNets) {
        stampVoltageSourceToGround(A, b, netIndex.get(netId), 0, R_GROUND_INT);
      }
      for (const src of elements.voltageSources) {
        stampVoltageSourceToGround(A, b, netIndex.get(src.netId), src.voltage, src.rInt);
      }
    }

    for (const r of elements.passiveResistors) {
      stampConductance(A, netIndex.get(r.netA), netIndex.get(r.netB), 1 / r.ohms);
    }

    for (const c of elements.capacitors) {
      stampConductance(A, netIndex.get(c.net1), netIndex.get(c.net2), 1 / R_CAP_DC);
    }

    for (const d of elements.diodes) {
      const idx1 = netIndex.get(d.net1);
      const idx2 = netIndex.get(d.net2);
      if (idx1 == null || idx2 == null || idx1 === idx2) continue;

      if (d.state === 'on') {
        const gOn = 1 / d.rOn;
        stampConductance(A, idx1, idx2, gOn);
        b[idx1] += gOn * d.vf;
        b[idx2] -= gOn * d.vf;
      } else {
        stampConductance(A, idx1, idx2, 1 / d.rOff);
      }
    }

    for (const op of elements.opamps) {
      if (!op.powered) continue;
      const vMin = op.vGnd + 0.05;
      const vMax = op.vVcc >= op.vGnd + 0.55 ? op.vVcc - 0.5 : (op.vVcc + op.vGnd) / 2;
      const gOut = 1 / R_IC_OUT;

      for (const st of op.stages) {
        const idxP = netIndex.get(st.netInP);
        const idxN = netIndex.get(st.netInN);
        const idxO = netIndex.get(st.netOut);

        stampConductance(A, idxP, idxN, 1 / R_IC_INPUT);

        if (idxO == null) continue;
        if (st.state === 'linear' && idxP != null && idxN != null) {
          A[idxO][idxO] += gOut;
          A[idxO][idxP] -= gOut * OPAMP_A_OL;
          A[idxO][idxN] += gOut * OPAMP_A_OL;
        } else if (st.state === 'high') {
          stampVoltageSourceToGround(A, b, idxO, vMax, R_IC_OUT);
        } else if (st.state === 'low') {
          stampVoltageSourceToGround(A, b, idxO, vMin, R_IC_OUT);
        } else {
          // Input pins missing/invalid -> keep output softly pulled to mid-rail
          stampVoltageSourceToGround(A, b, idxO, (vMin + vMax) / 2, R_IC_OUT);
        }
      }
    }

    for (const ia of elements.inamps) {
      if (!ia.powered) continue;
      const vMin = ia.vVsN + 1.1;
      const vMax = ia.vVsP >= ia.vVsN + 2.2 ? ia.vVsP - 1.1 : (ia.vVsP + ia.vVsN) / 2;
      const gOut = 1 / R_IC_OUT;
      const idxP = netIndex.get(ia.netInP);
      const idxN = netIndex.get(ia.netInN);
      const idxO = netIndex.get(ia.netOut);
      const idxRef = netIndex.get(ia.netRef);
      const refNonFloating = Boolean(ia.netRef && nonFloatingRefNets.has(ia.netRef));
      const vRefDefault = (ia.vVsP + ia.vVsN) / 2;

      stampConductance(A, idxP, idxN, 1 / R_IC_INPUT);

      if (idxO == null) continue;
      if (ia.state === 'linear' && idxP != null && idxN != null) {
        A[idxO][idxO] += gOut;
        A[idxO][idxP] -= gOut * ia.gain;
        A[idxO][idxN] += gOut * ia.gain;
        if (refNonFloating && idxRef != null) {
          A[idxO][idxRef] -= gOut;
        } else {
          b[idxO] += gOut * vRefDefault;
        }
      } else if (ia.state === 'high') {
        stampVoltageSourceToGround(A, b, idxO, vMax, R_IC_OUT);
      } else if (ia.state === 'low') {
        stampVoltageSourceToGround(A, b, idxO, vMin, R_IC_OUT);
      } else {
        stampVoltageSourceToGround(A, b, idxO, (vMin + vMax) / 2, R_IC_OUT);
      }
    }

    return solveLinearSystem(A, b);
  };

  let iterations = 0;
  let converged = true;
  let x = new Array(n).fill(0);

  if (powered && n > 0) {
    const hasNonlinear =
      elements.diodes.length > 0 || elements.opamps.length > 0 || elements.inamps.length > 0;

    // Initial solve to establish supply rail voltages before active ICs enable
    let refReachable = computeNonFloatingNets(elements, {
      includeConductingDiodes: false,
      includePoweredIcs: false
    });
    const initX = solveCurrentState(refReachable);
    if (!initX) {
      converged = false;
    } else {
      x = initX;
    }

    if (!hasNonlinear) {
      iterations = 1;
    } else {
      for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        iterations = iter;
        let stateChanged = false;

        // 1. Update Op-Amp & AD620 power-supply states from latest node voltages
        refReachable = computeNonFloatingNets(elements, {
          includeConductingDiodes: true,
          includePoweredIcs: true
        });

        for (const op of elements.opamps) {
          const vccOk = Boolean(op.netVcc && refReachable.has(op.netVcc));
          const gndOk = Boolean(op.netGnd && refReachable.has(op.netGnd));
          const vVcc = vccOk ? x[netIndex.get(op.netVcc)] : null;
          const vGnd = gndOk ? x[netIndex.get(op.netGnd)] : null;
          const nextPowered = Boolean(vccOk && gndOk && vVcc - vGnd >= 2.0);
          if (nextPowered !== op.powered) stateChanged = true;
          op.powered = nextPowered;
          op.vVcc = vVcc;
          op.vGnd = vGnd;
        }

        for (const ia of elements.inamps) {
          const vsPOk = Boolean(ia.netVsP && refReachable.has(ia.netVsP));
          const vsNOk = Boolean(ia.netVsN && refReachable.has(ia.netVsN));
          const vVsP = vsPOk ? x[netIndex.get(ia.netVsP)] : null;
          const vVsN = vsNOk ? x[netIndex.get(ia.netVsN)] : null;
          const nextPowered = Boolean(vsPOk && vsNOk && vVsP - vVsN >= 4.0);
          if (nextPowered !== ia.powered) stateChanged = true;
          ia.powered = nextPowered;
          ia.vVsP = vVsP;
          ia.vVsN = vVsN;
        }

        // Solve with current active IC & diode states
        if (iter === 1 || stateChanged) {
          refReachable = computeNonFloatingNets(elements, {
            includeConductingDiodes: true,
            includePoweredIcs: true
          });
          const nextX = solveCurrentState(refReachable);
          if (!nextX) {
            converged = false;
            break;
          }
          x = nextX;
          stateChanged = false;
        }

        // 2. Check diode / LED transitions
        for (const d of elements.diodes) {
          const idx1 = netIndex.get(d.net1);
          const idx2 = netIndex.get(d.net2);
          if (idx1 == null || idx2 == null || idx1 === idx2) continue;

          const vDiff = x[idx1] - x[idx2];
          if (d.state === 'off') {
            if (vDiff > d.vf + 1e-6) {
              d.state = 'on';
              stateChanged = true;
            }
          } else {
            const current = (vDiff - d.vf) / d.rOn;
            if (current < -1e-9) {
              d.state = 'off';
              stateChanged = true;
            }
          }
        }

        // 3. Check Op-Amp rail clamping / linear recovery transitions
        for (const op of elements.opamps) {
          if (!op.powered) continue;
          const vMin = op.vGnd + 0.05;
          const vMax = op.vVcc >= op.vGnd + 0.55 ? op.vVcc - 0.5 : (op.vVcc + op.vGnd) / 2;

          for (const st of op.stages) {
            const idxP = netIndex.get(st.netInP);
            const idxN = netIndex.get(st.netInN);
            const idxO = netIndex.get(st.netOut);
            if (idxP == null || idxN == null || idxO == null) continue;

            const vIdeal = OPAMP_A_OL * (x[idxP] - x[idxN]);
            const vOut = x[idxO];

            if (st.state === 'linear') {
              if (vOut > vMax + 1e-5 || vIdeal > vMax + 1e-5) {
                st.state = 'high';
                stateChanged = true;
              } else if (vOut < vMin - 1e-5 || vIdeal < vMin - 1e-5) {
                st.state = 'low';
                stateChanged = true;
              }
            } else if (st.state === 'high') {
              if (vIdeal < vMax - 1e-4) {
                st.state = 'linear';
                stateChanged = true;
              }
            } else if (st.state === 'low') {
              if (vIdeal > vMin + 1e-4) {
                st.state = 'linear';
                stateChanged = true;
              }
            }
          }
        }

        // 4. Check AD620 In-Amp rail clamping / linear recovery transitions
        for (const ia of elements.inamps) {
          if (!ia.powered) continue;
          const vMin = ia.vVsN + 1.1;
          const vMax = ia.vVsP >= ia.vVsN + 2.2 ? ia.vVsP - 1.1 : (ia.vVsP + ia.vVsN) / 2;
          const idxP = netIndex.get(ia.netInP);
          const idxN = netIndex.get(ia.netInN);
          const idxO = netIndex.get(ia.netOut);
          if (idxP == null || idxN == null || idxO == null) continue;

          const refNonFloating = Boolean(ia.netRef && refReachable.has(ia.netRef));
          const vRef = refNonFloating ? x[netIndex.get(ia.netRef)] : (ia.vVsP + ia.vVsN) / 2;
          const vIdeal = ia.gain * (x[idxP] - x[idxN]) + vRef;
          const vOut = x[idxO];

          if (ia.state === 'linear') {
            if (vOut > vMax + 1e-5 || vIdeal > vMax + 1e-5) {
              ia.state = 'high';
              stateChanged = true;
            } else if (vOut < vMin - 1e-5 || vIdeal < vMin - 1e-5) {
              ia.state = 'low';
              stateChanged = true;
            }
          } else if (ia.state === 'high') {
            if (vIdeal < vMax - 1e-4) {
              ia.state = 'linear';
              stateChanged = true;
            }
          } else if (ia.state === 'low') {
            if (vIdeal > vMin + 1e-4) {
              ia.state = 'linear';
              stateChanged = true;
            }
          }
        }

        if (!stateChanged) {
          break;
        }

        // Re-solve immediately after state transitions for next iteration check
        refReachable = computeNonFloatingNets(elements, {
          includeConductingDiodes: true,
          includePoweredIcs: true
        });
        const nextX = solveCurrentState(refReachable);
        if (!nextX) {
          converged = false;
          break;
        }
        x = nextX;

        if (iter === MAX_ITERATIONS) {
          converged = false;
        }
      }
    }
  }

  // Final non-floating net calculation via BFS
  const nonFloatingNets = powered
    ? computeNonFloatingNets(elements, {
        includeConductingDiodes: true,
        includePoweredIcs: true
      })
    : new Set();

  const floatingNets = new Set();
  const nodeVoltages = new Map();
  const holeVoltages = new Map();

  for (const netId of allNetIds) {
    if (!powered || !activeNetSet.has(netId) || !nonFloatingNets.has(netId)) {
      floatingNets.add(netId);
      nodeVoltages.set(netId, null);
    } else {
      nodeVoltages.set(netId, x[netIndex.get(netId)]);
    }
  }

  for (const [holeId, hole] of breadboard.holes.entries()) {
    const netId = stripToNet.get(hole.stripId);
    const v = netId ? nodeVoltages.get(netId) ?? null : null;
    holeVoltages.set(holeId, v);
  }

  const getNetVoltage = (netId) => {
    if (!netId || floatingNets.has(netId)) return null;
    const v = nodeVoltages.get(netId);
    return Number.isFinite(v) ? v : null;
  };

  // Build per-part simulation results & diagnostics
  const partResults = new Map();

  for (const [instanceId, meta] of elements.partMeta.entries()) {
    if (meta.kind === 'resistor' || meta.kind === 'photoresistor') {
      const v1 = getNetVoltage(meta.net1);
      const v2 = getNetVoltage(meta.net2);
      const bothValid = v1 !== null && v2 !== null;
      const voltageDrop = bothValid ? v1 - v2 : null;
      const currentA = bothValid ? voltageDrop / meta.ohms : null;
      partResults.set(instanceId, {
        partId: meta.kind === 'photoresistor' ? 'photoresistor' : 'resistor',
        ...(meta.kind === 'photoresistor' ? { lightLevel: meta.lightLevel } : {}),
        resistanceOhms: meta.ohms,
        v1,
        v2,
        voltageDrop,
        currentA,
        currentMa: currentA !== null ? currentA * 1000 : null,
        powerMw: currentA !== null ? currentA * voltageDrop * 1000 : null,
        floating: !bothValid
      });
    } else if (meta.kind === 'pot') {
      const v1 = getNetVoltage(meta.net1);
      const vWiper = getNetVoltage(meta.netW);
      const v3 = getNetVoltage(meta.net3);
      partResults.set(instanceId, {
        partId: 'potentiometer',
        wiper: meta.alpha,
        resistanceOhms: meta.totalR,
        r1Ohms: meta.r1,
        r2Ohms: meta.r2,
        v1,
        vWiper,
        v3
      });
    } else if (meta.kind === 'pushbutton') {
      const vA = getNetVoltage(meta.netA);
      const vB = getNetVoltage(meta.netB);
      partResults.set(instanceId, {
        partId: 'pushbutton-4pin',
        pressed: meta.pressed,
        resistanceOhms: meta.ohms,
        vA,
        vB
      });
    }
  }

  for (const c of elements.capacitors) {
    const v1 = getNetVoltage(c.net1);
    const v2 = getNetVoltage(c.net2);
    const bothValid = v1 !== null && v2 !== null;
    const voltageDrop = bothValid ? v1 - v2 : null;
    const reverseBiased = Boolean(c.polarized && bothValid && v1 < v2 - 0.5);

    if (reverseBiased) {
      diagnostics.push({
        severity: 'warning',
        code: 'CAP_REVERSE_POLARITY',
        instanceId: c.inst.id,
        partId: c.inst.partId,
        message: `Reverse polarity on ${c.partDef.shortLabel || c.partDef.name} (${c.h1?.id || 'P1'} / ${c.h2?.id || 'P2'}): V(+) = ${v1.toFixed(2)}V < V(-) = ${v2.toFixed(2)}V.`
      });
    }

    partResults.set(c.inst.id, {
      partId: c.inst.partId,
      v1,
      v2,
      voltageDrop,
      reverseBiased
    });
  }

  for (const d of elements.diodes) {
    const v1 = getNetVoltage(d.net1);
    const v2 = getNetVoltage(d.net2);
    const bothValid = v1 !== null && v2 !== null;
    const voltageDrop = bothValid ? v1 - v2 : null;
    const conducting = Boolean(bothValid && d.state === 'on');
    const currentA = conducting ? Math.max(0, (voltageDrop - d.vf) / d.rOn) : 0;
    const currentMa = currentA * 1000;
    const reverseBiased = Boolean(bothValid && voltageDrop < -0.1);

    const entry = {
      partId: d.inst.partId,
      conducting,
      v1,
      v2,
      voltageDrop,
      currentA,
      currentMa,
      reverseBiased
    };

    if (d.isLed) {
      const ledBrightness = clamp((currentMa - 0.2) / 15, 0, 1);
      const overcurrent = currentMa > 25;
      entry.ledBrightness = ledBrightness;
      entry.overcurrent = overcurrent;

      if (overcurrent) {
        diagnostics.push({
          severity: 'warning',
          code: 'LED_OVERCURRENT',
          instanceId: d.inst.id,
          partId: d.inst.partId,
          message: `LED overcurrent (${currentMa.toFixed(1)} mA > 25 mA)! Add a current-limiting resistor (e.g., 330 Ω).`
        });
      }
    }

    partResults.set(d.inst.id, entry);
  }

  for (const op of elements.opamps) {
    const stages = op.stages.map((st) => {
      const vInP = getNetVoltage(st.netInP);
      const vInN = getNetVoltage(st.netInN);
      const vOut = getNetVoltage(st.netOut);
      return {
        stage: st.stage,
        state: op.powered ? st.state : 'unpowered',
        vInP,
        vInN,
        vOut,
        saturated: op.powered && (st.state === 'high' || st.state === 'low')
      };
    });

    if (powered && !op.powered) {
      diagnostics.push({
        severity: 'warning',
        code: 'IC_UNPOWERED',
        instanceId: op.inst.id,
        partId: op.inst.partId,
        message: `${op.partDef.shortLabel || 'Dual Op-Amp'} is unpowered (connect VCC and GND with V(VCC) - V(GND) >= 2.0 V).`
      });
    }

    partResults.set(op.inst.id, {
      partId: op.inst.partId,
      powered: op.powered,
      vVcc: op.vVcc,
      vGnd: op.vGnd,
      stages
    });
  }

  for (const ia of elements.inamps) {
    const vInP = getNetVoltage(ia.netInP);
    const vInN = getNetVoltage(ia.netInN);
    const vOut = getNetVoltage(ia.netOut);
    const refFloating = Boolean(!ia.netRef || floatingNets.has(ia.netRef));
    const vRef = ia.powered
      ? (refFloating ? (ia.vVsP + ia.vVsN) / 2 : getNetVoltage(ia.netRef))
      : getNetVoltage(ia.netRef);

    if (powered && !ia.powered) {
      diagnostics.push({
        severity: 'warning',
        code: 'IC_UNPOWERED',
        instanceId: ia.inst.id,
        partId: ia.inst.partId,
        message: `${ia.partDef.shortLabel || 'AD620 In-Amp'} is unpowered (connect +Vs and -Vs with V(+Vs) - V(-Vs) >= 4.0 V).`
      });
    } else if (powered && ia.powered && refFloating) {
      diagnostics.push({
        severity: 'warning',
        code: 'AD620_REF_FLOATING',
        instanceId: ia.inst.id,
        partId: ia.inst.partId,
        message: `AD620 REF pin is floating; defaulting V_ref to mid-supply (${vRef.toFixed(2)} V). Connect REF to GND or a reference voltage.`
      });
    }

    partResults.set(ia.inst.id, {
      partId: ia.inst.partId,
      powered: ia.powered,
      vVsP: ia.vVsP,
      vVsN: ia.vVsN,
      rgOhms: ia.rgOhms,
      gain: ia.gain,
      vInP,
      vInN,
      vRef,
      refFloating,
      vOut,
      state: ia.powered ? ia.state : 'unpowered',
      saturated: ia.powered && (ia.state === 'high' || ia.state === 'low')
    });
  }

  return {
    powered,
    converged,
    iterations,
    nodeVoltages,
    holeVoltages,
    floatingNets,
    partResults,
    diagnostics,
    getHoleVoltage(holeId) {
      if (!holeId || !breadboard.getHole(holeId)) return null;
      return holeVoltages.get(holeId) ?? null;
    },
    getVoltageDiff(holePos, holeNeg) {
      if (!holePos || !holeNeg) {
        return { valid: false, volts: null, floatingReason: 'Missing probe hole' };
      }
      const hPos = breadboard.getHole(holePos);
      const hNeg = breadboard.getHole(holeNeg);
      if (!hPos || !hNeg) {
        return { valid: false, volts: null, floatingReason: 'Unknown probe hole ID' };
      }
      if (!powered) {
        return { valid: false, volts: null, floatingReason: 'Circuit power supply is off' };
      }
      const netPos = stripToNet.get(hPos.stripId);
      const netNeg = stripToNet.get(hNeg.stripId);
      const posFloating = !netPos || floatingNets.has(netPos);
      const negFloating = !netNeg || floatingNets.has(netNeg);
      if (posFloating && negFloating) {
        return { valid: false, volts: null, floatingReason: 'Both probes are on floating nets' };
      }
      if (posFloating) {
        return { valid: false, volts: null, floatingReason: `Positive probe (${holePos}) is on a floating net` };
      }
      if (negFloating) {
        return { valid: false, volts: null, floatingReason: `Negative probe (${holeNeg}) is on a floating net` };
      }
      const vPos = nodeVoltages.get(netPos);
      const vNeg = nodeVoltages.get(netNeg);
      return {
        valid: true,
        volts: vPos - vNeg,
        floatingReason: null
      };
    }
  };
}

/**
 * Measures passive equivalent DC resistance between holeA and holeB with active voltage
 * sources disconnected (multimeter Ohmmeter / Continuity mode).
 * @param {object} params
 * @param {import('../breadboard.js').BreadboardModel} params.breadboard
 * @param {object} [params.connectivity]
 * @param {Array<object>} [params.placedParts]
 * @param {Array<object>} [params.wires]
 * @param {Map<string, object>} params.catalogMap
 * @param {string} params.holeA
 * @param {string} params.holeB
 * @param {object} [params.simConfig]
 * @returns {{ valid: boolean, ohms: number, open: boolean, continuity: boolean }}
 */
export function measureResistance({
  breadboard,
  connectivity,
  placedParts = [],
  wires = [],
  catalogMap,
  holeA,
  holeB,
  simConfig = {}
}) {
  if (!holeA || !holeB || !breadboard.getHole(holeA) || !breadboard.getHole(holeB)) {
    return { valid: false, ohms: Infinity, open: true, continuity: false };
  }

  const config = createDefaultSimConfig(simConfig);
  const conn = connectivity || analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  const stripToNet = buildStripToNetMap(conn);
  const netA = getNetIdForHole(breadboard, stripToNet, holeA);
  const netB = getNetIdForHole(breadboard, stripToNet, holeB);

  if (!netA || !netB) {
    return { valid: false, ohms: Infinity, open: true, continuity: false };
  }

  if (netA === netB) {
    return { valid: true, ohms: 0, open: false, continuity: true };
  }

  const elements = buildCircuitElements({
    breadboard,
    connectivity: conn,
    placedParts,
    catalogMap,
    config: { ...config, powered: false },
    stripToNet
  });

  // Check passive ohmic reachability from netA to netB
  const adj = new Map();
  for (const r of elements.passiveResistors) {
    if (r.conductive === false || r.ohms >= 1e8) continue;
    addAdjacencyEdge(adj, r.netA, r.netB);
  }
  const reachable = runReachabilityBfs([netA], adj);
  if (!reachable.has(netB)) {
    return { valid: true, ohms: Infinity, open: true, continuity: false };
  }

  const activeNetSet = collectActiveNets(elements, [netA, netB]);
  const netIds = Array.from(conn.nets.keys()).filter((id) => activeNetSet.has(id));
  const netIndex = new Map();
  netIds.forEach((id, i) => netIndex.set(id, i));
  const n = netIds.length;

  const A = createZeroMatrix(n);
  const b = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    A[i][i] += G_MIN;
  }

  for (const r of elements.passiveResistors) {
    if (r.conductive === false || r.ohms >= 1e8) continue;
    stampConductance(A, netIndex.get(r.netA), netIndex.get(r.netB), 1 / r.ohms);
  }

  const idxA = netIndex.get(netA);
  const idxB = netIndex.get(netB);
  const testCurrentA = 1e-3; // 1 mA test current
  stampGroundConductance(A, idxB, 1e9); // Reference netB at 0 V
  b[idxA] += testCurrentA;

  const x = solveLinearSystem(A, b);
  if (!x) {
    return { valid: true, ohms: Infinity, open: true, continuity: false };
  }

  const rawOhms = (x[idxA] - x[idxB]) / testCurrentA;
  if (!Number.isFinite(rawOhms) || rawOhms > 2e7) {
    return { valid: true, ohms: Infinity, open: true, continuity: false };
  }

  const ohms = Math.max(0, rawOhms);
  return {
    valid: true,
    ohms,
    open: false,
    continuity: ohms < 50
  };
}
