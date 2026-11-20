import { analyzeCircuit } from '../connectivity.js';
import {
  DEFAULT_FGEN_CONFIG,
  clamp,
  createDefaultFgenConfig,
  evaluateWaveform,
  getWaveformDcMean,
  solveLinearSystem
} from './linearAlgebra.js';
import {
  DEFAULT_SIM_CONFIG,
  createDefaultSimConfig,
  getDefaultPartProps,
  getPhotoresistorOhms,
  solveDcCircuit
} from './dcSolver.js';

/**
 * Pure, zero-DOM Backward-Euler Companion-Model Transient MNA Circuit Solver.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

const R_SOURCE_INT = 0.05;
const R_GROUND_INT = 1e-4;
const R_ARDUINO_GPIO = 25;
const R_FGEN_OUT = 50;
const G_MIN = 1e-11;
const R_SWITCH_CLOSED = 0.1;
const R_SWITCH_OPEN = 1e9;
const R_IC_INPUT = 1e7;
const R_IC_OUT = 20;
const OPAMP_A_OL = 1e5;
const MAX_STEP_ITERATIONS = 12;

const DIODE_PARAMS = Object.freeze({
  'diode-1n4007': { vf: 0.68, rOn: 2, rOff: 1e8 },
  'led-red': { vf: 1.9, rOn: 10, rOff: 1e8 }
});

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

function resolvePartProps(inst) {
  return {
    ...getDefaultPartProps(inst.partId),
    ...(inst.props && typeof inst.props === 'object' ? inst.props : {})
  };
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
 * Checks whether an NI ELVIS II strip has at least one external wire or component pin attached,
 * or is merged with another strip via a wire.
 */
function isElvisStripConnected(breadboard, connectivity, stripId) {
  if (!breadboard.elvisMode) return false;
  const holes = breadboard.strips.get(stripId);
  if (!holes || holes.length === 0) return false;
  for (const h of holes) {
    const occs = connectivity.getOccupants(h.id);
    if (occs && occs.length > 0) return true;
  }
  return false;
}

function buildTransientElements({ breadboard, connectivity, placedParts, catalogMap, config, stripToNet }) {
  const groundNets = new Set();
  const staticSources = []; // { netId, voltage, rInt }
  const fgenNetIds = new Set();
  const passiveResistors = []; // { netA, netB, ohms, conductive? }
  const capacitors = []; // { inst, capacitance, net1, net2, vPrev }
  const diodes = []; // { net1, net2, vf, rOn, rOff, state }
  const opamps = []; // { netVcc, netGnd, powered, vVcc, vGnd, stages }
  const inamps = []; // { netVsP, netVsN, netInP, netInN, netOut, netRef, netRg1, netRg2, powered, vVsP, vVsN, gain, state }
  const potMetas = [];

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
          staticSources.push({ netId, voltage: 5.0, rInt: R_SOURCE_INT });
          break;
        case '+15V':
          staticSources.push({ netId, voltage: 15.0, rInt: R_SOURCE_INT });
          break;
        case '-15V':
          staticSources.push({ netId, voltage: -15.0, rInt: R_SOURCE_INT });
          break;
        case 'SUPPLY +':
          staticSources.push({ netId, voltage: supplyPos, rInt: R_SOURCE_INT });
          break;
        case 'SUPPLY -':
          staticSources.push({ netId, voltage: supplyNeg, rInt: R_SOURCE_INT });
          break;
        default:
          break;
      }
    }
  }

  if (config.powered && config.fgen?.enabled) {
    if (breadboard.elvisMode) {
      const elvisFgenNet = stripToNet.get('ELVIS_ROW_33');
      if (elvisFgenNet) fgenNetIds.add(elvisFgenNet);
    }
    if (config.fgen.probeHole) {
      const probeNet = getNetIdForHole(breadboard, stripToNet, config.fgen.probeHole);
      if (probeNet) fgenNetIds.add(probeNet);
    }
  }

  const loadCellResistors = getLoadCellResistors(breadboard, stripToNet, config.loadCellForceGrams);
  for (const r of loadCellResistors) {
    passiveResistors.push(r);
  }

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
            staticSources.push({ netId, voltage: 5.0, rInt: R_SOURCE_INT });
          } else if (pin.id === '3V3') {
            staticSources.push({ netId, voltage: 3.3, rInt: R_SOURCE_INT });
          } else {
            const state = instPinStates?.[pin.id] ?? pinStates[pin.id];
            if (state && state.mode === 'OUTPUT' && Number.isFinite(state.voltage)) {
              staticSources.push({ netId, voltage: state.voltage, rInt: R_ARDUINO_GPIO });
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
        passiveResistors.push({ netA: net1, netB: net2, ohms });
      }
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

      if (net1 && netW) passiveResistors.push({ netA: net1, netB: netW, ohms: r1 });
      if (netW && net3) passiveResistors.push({ netA: netW, netB: net3, ohms: r2 });
      potMetas.push({ totalR, net1, netW, net3 });
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
        passiveResistors.push({ netA, netB, ohms, conductive: pressed });
      }
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
        passiveResistors.push({ netA: net1, netB: net2, ohms });
      }
      continue;
    }

    if (partDef.unit === 'F' && Number.isFinite(partDef.value) && partDef.value > 0) {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      if (net1 && net2 && net1 !== net2) {
        capacitors.push({
          inst,
          capacitance: partDef.value,
          net1,
          net2,
          vPrev: 0
        });
      }
      continue;
    }

    if (inst.partId === 'diode-1n4007' || inst.partId === 'led-red') {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      const params = DIODE_PARAMS[inst.partId];
      diodes.push({
        net1,
        net2,
        vf: params.vf,
        rOn: params.rOn,
        rOff: params.rOff,
        state: 'off',
        everConducted: false
      });
      continue;
    }

    if (inst.partId === 'opamp-dual-dip8') {
      const getPinNet = (pinId) => {
        const h = connectivity.getPinHole(inst.id, pinId);
        return h ? stripToNet.get(h.stripId) : null;
      };
      opamps.push({
        netVcc: getPinNet('VCC'),
        netGnd: getPinNet('GND'),
        powered: false,
        vVcc: null,
        vGnd: null,
        stages: [
          { netInP: getPinNet('IN1+'), netInN: getPinNet('IN1-'), netOut: getPinNet('OUT1'), state: 'linear' },
          { netInP: getPinNet('IN2+'), netInN: getPinNet('IN2-'), netOut: getPinNet('OUT2'), state: 'linear' }
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
        gain: 1,
        state: 'linear'
      });
    }
  }

  for (const inamp of inamps) {
    if (!inamp.netRg1 || !inamp.netRg2 || inamp.netRg1 === inamp.netRg2) {
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
    for (const meta of potMetas) {
      if (meta.net1 && meta.net3 && meta.netW) {
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
    inamp.gain = gParallel > 0 ? 1 + 49400 / (1 / gParallel) : 1;
  }

  return {
    groundNets,
    staticSources,
    fgenNetIds,
    passiveResistors,
    capacitors,
    diodes,
    opamps,
    inamps
  };
}

function collectTransientActiveNets(elements, extraNetIds) {
  const active = new Set();
  const add = (netId) => {
    if (netId) active.add(netId);
  };

  for (const netId of extraNetIds) add(netId);
  for (const netId of elements.groundNets) add(netId);
  for (const src of elements.staticSources) add(src.netId);
  for (const netId of elements.fgenNetIds) add(netId);
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
 * Computes nets with a non-floating path (through resistors, capacitors, conducting diodes, or IC outputs)
 * to ground or active voltage sources during transient simulation.
 */
function computeTransientNonFloatingNets(
  elements,
  { includeConductingDiodes = false, includeEverConductedDiodes = false, includePoweredIcs = false } = {}
) {
  const seeds = new Set();
  for (const g of elements.groundNets) seeds.add(g);
  for (const s of elements.staticSources) seeds.add(s.netId);
  for (const f of elements.fgenNetIds) seeds.add(f);

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
  for (const c of elements.capacitors) {
    addAdjacencyEdge(adj, c.net1, c.net2);
  }
  if (includeConductingDiodes || includeEverConductedDiodes) {
    for (const d of elements.diodes) {
      if (
        (includeConductingDiodes && d.state === 'on') ||
        (includeEverConductedDiodes && d.everConducted)
      ) {
        addAdjacencyEdge(adj, d.net1, d.net2);
      }
    }
  }

  return runReachabilityBfs(seeds, adj);
}

/**
 * Solves time-domain circuit behavior using Backward-Euler companion models for capacitors
 * and warm-started piecewise-linear MNA for diodes and active ICs.
 *
 * @param {object} params
 * @param {import('../breadboard.js').BreadboardModel} params.breadboard
 * @param {object} [params.connectivity]
 * @param {Array<object>} [params.placedParts]
 * @param {Array<object>} [params.wires]
 * @param {Map<string, object>} params.catalogMap
 * @param {object} [params.simConfig]
 * @param {number} [params.totalDurationSec]
 * @param {number} [params.numSamples=400]
 * @param {number} [params.warmupCycles=2]
 * @param {Array<string>} [params.probeHoles]
 */
export function solveTransientCircuit({
  breadboard,
  connectivity,
  placedParts = [],
  wires = [],
  catalogMap,
  simConfig = {},
  totalDurationSec,
  numSamples = 400,
  warmupCycles = 2,
  probeHoles = []
}) {
  const config = createDefaultSimConfig(simConfig);
  const fgen = createDefaultFgenConfig(config.fgen);
  config.fgen = fgen;

  const powered = config.powered !== false;
  const count = Math.max(2, Math.floor(Number.isFinite(numSamples) ? numSamples : 400));
  const defaultDuration = fgen.frequencyHz > 0 ? 2 / fgen.frequencyHz : 0.02;
  const duration =
    Number.isFinite(totalDurationSec) && totalDurationSec > 0 ? totalDurationSec : defaultDuration;
  const dt = duration / (count - 1);

  const conn = connectivity || analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  const stripToNet = buildStripToNetMap(conn);
  const elements = buildTransientElements({
    breadboard,
    connectivity: conn,
    placedParts,
    catalogMap,
    config: { ...config, powered },
    stripToNet
  });

  // Collect extra probe / ELVIS instrument nets so active pruning keeps them in the MNA system
  const extraNetIds = [];
  if (breadboard.elvisMode) {
    for (const stripId of ['ELVIS_ROW_1', 'ELVIS_ROW_2', 'ELVIS_ROW_3', 'ELVIS_ROW_4', 'ELVIS_ROW_33']) {
      const netId = stripToNet.get(stripId);
      if (netId) extraNetIds.push(netId);
    }
  }
  if (fgen.probeHole) {
    const fgenNet = getNetIdForHole(breadboard, stripToNet, fgen.probeHole);
    if (fgenNet) extraNetIds.push(fgenNet);
  }
  if (Array.isArray(probeHoles)) {
    for (const holeId of probeHoles) {
      const pNet = getNetIdForHole(breadboard, stripToNet, holeId);
      if (pNet) extraNetIds.push(pNet);
    }
  }

  const allNetIds = Array.from(conn.nets.keys());
  const activeNetSet = collectTransientActiveNets(elements, extraNetIds);
  const netIds = allNetIds.filter((id) => activeNetSet.has(id));
  const netIndex = new Map();
  netIds.forEach((id, i) => netIndex.set(id, i));
  const n = netIds.length;

  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    times[i] = i * dt;
  }

  const nodeTraces = new Map();
  for (const netId of netIds) {
    nodeTraces.set(netId, new Float64Array(count));
  }

  let floatingNets = new Set(allNetIds);

  if (powered && n > 0) {
    // 1. Initialize capacitors from DC operating point using FGEN DC mean
    const dcInit = solveDcCircuit({
      breadboard,
      connectivity: conn,
      placedParts,
      wires,
      catalogMap,
      simConfig: {
        ...config,
        powered,
        fgen: {
          ...fgen,
          dcOffsetV: fgen.enabled ? getWaveformDcMean(fgen) : fgen.dcOffsetV
        }
      }
    });

    for (const c of elements.capacitors) {
      const v1 = dcInit.nodeVoltages.get(c.net1);
      const v2 = dcInit.nodeVoltages.get(c.net2);
      c.vPrev = Number.isFinite(v1) && Number.isFinite(v2) ? v1 - v2 : 0;
    }

    // Seed nonlinear IC and diode states from the t = 0 operating point
    let xPrev = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = dcInit.nodeVoltages.get(netIds[i]);
      xPrev[i] = Number.isFinite(v) ? v : 0;
    }

    // Initialize IC power flags from DC solve so step 0 starts warm
    const initReachable = computeTransientNonFloatingNets(elements, {
      includeConductingDiodes: true,
      includePoweredIcs: true
    });
    for (const op of elements.opamps) {
      const vccOk = Boolean(op.netVcc && initReachable.has(op.netVcc));
      const gndOk = Boolean(op.netGnd && initReachable.has(op.netGnd));
      const vVcc = vccOk ? xPrev[netIndex.get(op.netVcc)] : null;
      const vGnd = gndOk ? xPrev[netIndex.get(op.netGnd)] : null;
      op.powered = Boolean(vccOk && gndOk && vVcc - vGnd >= 2.0);
      op.vVcc = vVcc;
      op.vGnd = vGnd;
    }
    for (const ia of elements.inamps) {
      const vsPOk = Boolean(ia.netVsP && initReachable.has(ia.netVsP));
      const vsNOk = Boolean(ia.netVsN && initReachable.has(ia.netVsN));
      const vVsP = vsPOk ? xPrev[netIndex.get(ia.netVsP)] : null;
      const vVsN = vsNOk ? xPrev[netIndex.get(ia.netVsN)] : null;
      ia.powered = Boolean(vsPOk && vsNOk && vVsP - vVsN >= 4.0);
      ia.vVsP = vVsP;
      ia.vVsN = vVsN;
    }

    const hasNonlinear =
      elements.diodes.length > 0 || elements.opamps.length > 0 || elements.inamps.length > 0;

    // Pre-allocate reusable MNA matrix & RHS vector
    const ABase = createZeroMatrix(n);
    const bBase = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      ABase[i][i] += G_MIN;
    }
    for (const netId of elements.groundNets) {
      stampVoltageSourceToGround(ABase, bBase, netIndex.get(netId), 0, R_GROUND_INT);
    }
    for (const src of elements.staticSources) {
      stampVoltageSourceToGround(ABase, bBase, netIndex.get(src.netId), src.voltage, src.rInt);
    }
    for (const r of elements.passiveResistors) {
      stampConductance(ABase, netIndex.get(r.netA), netIndex.get(r.netB), 1 / r.ohms);
    }
    for (const netId of elements.fgenNetIds) {
      const idx = netIndex.get(netId);
      if (idx != null) {
        ABase[idx][idx] += 1 / R_FGEN_OUT;
      }
    }
    for (const op of elements.opamps) {
      for (const st of op.stages) {
        stampConductance(ABase, netIndex.get(st.netInP), netIndex.get(st.netInN), 1 / R_IC_INPUT);
      }
    }
    for (const ia of elements.inamps) {
      stampConductance(ABase, netIndex.get(ia.netInP), netIndex.get(ia.netInN), 1 / R_IC_INPUT);
    }

    const A = createZeroMatrix(n);
    const b = new Float64Array(n);

    const solveAtTime = (tSec, stepDt, nonFloatingRefNets) => {
      for (let i = 0; i < n; i++) {
        A[i].set(ABase[i]);
      }
      b.set(bBase);

      if (fgen.enabled && elements.fgenNetIds.size > 0) {
        const vFgen = evaluateWaveform(fgen, tSec);
        const gFgen = 1 / R_FGEN_OUT;
        for (const netId of elements.fgenNetIds) {
          const idx = netIndex.get(netId);
          if (idx != null) {
            b[idx] += vFgen * gFgen;
          }
        }
      }

      for (const c of elements.capacitors) {
        const idx1 = netIndex.get(c.net1);
        const idx2 = netIndex.get(c.net2);
        if (idx1 == null || idx2 == null || idx1 === idx2) continue;
        const gEq = c.capacitance / stepDt;
        const iEq = gEq * c.vPrev;
        stampConductance(A, idx1, idx2, gEq);
        b[idx1] += iEq;
        b[idx2] -= iEq;
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

    const stepSolver = (tSec, stepDt) => {
      let refReachable = computeTransientNonFloatingNets(elements, {
        includeConductingDiodes: true,
        includePoweredIcs: true
      });
      let x = solveAtTime(tSec, stepDt, refReachable);
      if (!x) return xPrev;

      if (hasNonlinear) {
        for (let iter = 0; iter < MAX_STEP_ITERATIONS; iter++) {
          let stateChanged = false;
          let powerChanged = false;

          refReachable = computeTransientNonFloatingNets(elements, {
            includeConductingDiodes: true,
            includePoweredIcs: true
          });

          for (const op of elements.opamps) {
            const vccOk = Boolean(op.netVcc && refReachable.has(op.netVcc));
            const gndOk = Boolean(op.netGnd && refReachable.has(op.netGnd));
            const vVcc = vccOk ? x[netIndex.get(op.netVcc)] : null;
            const vGnd = gndOk ? x[netIndex.get(op.netGnd)] : null;
            const nextPowered = Boolean(vccOk && gndOk && vVcc - vGnd >= 2.0);
            if (nextPowered !== op.powered) powerChanged = true;
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
            if (nextPowered !== ia.powered) powerChanged = true;
            ia.powered = nextPowered;
            ia.vVsP = vVsP;
            ia.vVsN = vVsN;
          }

          if (powerChanged) {
            refReachable = computeTransientNonFloatingNets(elements, {
              includeConductingDiodes: true,
              includePoweredIcs: true
            });
            const nextX = solveAtTime(tSec, stepDt, refReachable);
            if (!nextX) break;
            x = nextX;
            continue;
          }

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

          if (!stateChanged) break;

          refReachable = computeTransientNonFloatingNets(elements, {
            includeConductingDiodes: true,
            includePoweredIcs: true
          });
          const nextX = solveAtTime(tSec, stepDt, refReachable);
          if (!nextX) break;
          x = nextX;
        }
      }

      for (const c of elements.capacitors) {
        const idx1 = netIndex.get(c.net1);
        const idx2 = netIndex.get(c.net2);
        if (idx1 != null && idx2 != null) {
          c.vPrev = x[idx1] - x[idx2];
        }
      }

      xPrev = x;
      return x;
    };

    const subSteps =
      fgen.enabled && fgen.frequencyHz > 0
        ? Math.min(8, Math.max(1, Math.ceil(dt * fgen.frequencyHz * 32)))
        : 1;
    const subDt = dt / subSteps;

    // 2. Warm-up cycles ending at t = -dt so step = 0 is a single clean step to t = 0
    if (fgen.enabled && elements.capacitors.length > 0 && warmupCycles > 0 && fgen.frequencyHz > 0) {
      const periodSec = 1 / fgen.frequencyHz;
      const samplesPerPeriod = Math.max(16, Math.min(80, Math.round(periodSec / subDt)));
      const warmupSteps = Math.min(240, Math.max(1, Math.round(warmupCycles * samplesPerPeriod)));
      const warmupDt = (warmupCycles * periodSec) / warmupSteps;

      for (let w = 1; w <= warmupSteps; w++) {
        const tWarm = -(warmupSteps - w + 1) * warmupDt;
        stepSolver(tWarm, warmupDt);
      }
    }

    // 3. Solve capture window [0 .. totalDurationSec]
    for (let step = 0; step < count; step++) {
      let x;
      if (subSteps === 1) {
        x = stepSolver(times[step], dt);
      } else {
        const tEnd = times[step];
        const tStart = tEnd - dt;
        for (let s = 1; s <= subSteps; s++) {
          x = stepSolver(tStart + s * subDt, subDt);
        }
      }

      for (const d of elements.diodes) {
        if (d.state === 'on') {
          d.everConducted = true;
        }
      }

      for (let i = 0; i < n; i++) {
        nodeTraces.get(netIds[i])[step] = x[i];
      }
    }

    // Determine final floating nets (using everConducted so rectifiers aren't falsely marked floating)
    const nonFloatingNets = computeTransientNonFloatingNets(elements, {
      includeEverConductedDiodes: true,
      includePoweredIcs: true
    });
    floatingNets = new Set();
    for (const netId of allNetIds) {
      if (!activeNetSet.has(netId) || !nonFloatingNets.has(netId)) {
        floatingNets.add(netId);
      }
    }
  }

  const getHoleTrace = (holeId) => {
    if (!holeId) {
      return { valid: false, samples: null, reason: 'Missing probe hole' };
    }
    const hole = breadboard.getHole(holeId);
    if (!hole) {
      return { valid: false, samples: null, reason: `Unknown hole ID: ${holeId}` };
    }
    if (!powered) {
      return { valid: false, samples: null, reason: 'Circuit power supply is off' };
    }
    const netId = stripToNet.get(hole.stripId);
    if (!netId || floatingNets.has(netId)) {
      return { valid: false, samples: null, reason: `Probe (${holeId}) is on a floating net` };
    }
    const samples = nodeTraces.get(netId);
    if (!samples) {
      return { valid: false, samples: null, reason: `No trace computed for ${holeId}` };
    }
    return { valid: true, samples, reason: null };
  };

  const getDiffTrace = (holePos, holeNeg) => {
    if (!holePos || !holeNeg) {
      return { valid: false, samples: null, reason: 'Missing probe hole' };
    }
    if (!powered) {
      return { valid: false, samples: null, reason: 'Circuit power supply is off' };
    }
    const posRes = getHoleTrace(holePos);
    if (!posRes.valid) return posRes;
    const negRes = getHoleTrace(holeNeg);
    if (!negRes.valid) return negRes;

    const diff = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      diff[i] = posRes.samples[i] - negRes.samples[i];
    }
    return { valid: true, samples: diff, reason: null };
  };

  const resolveElvisAiChannel = (label, posStrip, posHole, negStrip, negHole) => {
    if (!breadboard.elvisMode) {
      return { valid: false, samples: null, reason: `ELVIS ${label} requires NI ELVIS II mode` };
    }
    if (!powered) {
      return { valid: false, samples: null, reason: 'Circuit power supply is off' };
    }
    if (!isElvisStripConnected(breadboard, conn, posStrip)) {
      return { valid: false, samples: null, reason: `Nothing wired to ELVIS ${label}+` };
    }
    const posRes = getHoleTrace(posHole);
    if (!posRes.valid) {
      return { valid: false, samples: null, reason: `ELVIS ${label}+ is floating` };
    }

    const negConnected = isElvisStripConnected(breadboard, conn, negStrip);
    if (negConnected) {
      const negRes = getHoleTrace(negHole);
      if (!negRes.valid) {
        return { valid: false, samples: null, reason: `ELVIS ${label}- is connected to a floating net` };
      }
      const diff = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        diff[i] = posRes.samples[i] - negRes.samples[i];
      }
      return { valid: true, samples: diff, singleEndedFallback: false, reason: null };
    }

    return {
      valid: true,
      samples: posRes.samples,
      singleEndedFallback: true,
      reason: null
    };
  };

  const getChannelTrace = (sourceSpec) => {
    if (!sourceSpec || !sourceSpec.type) {
      return { valid: false, samples: null, reason: 'No channel source specified' };
    }
    switch (sourceSpec.type) {
      case 'AI0':
        return resolveElvisAiChannel('AI 0', 'ELVIS_ROW_1', 'ELV_1A', 'ELVIS_ROW_2', 'ELV_2A');
      case 'AI1':
        return resolveElvisAiChannel('AI 1', 'ELVIS_ROW_3', 'ELV_3A', 'ELVIS_ROW_4', 'ELV_4A');
      case 'FGEN': {
        if (!powered) {
          return { valid: false, samples: null, reason: 'Circuit power supply is off' };
        }
        if (!fgen.enabled) {
          return { valid: false, samples: null, reason: 'FGEN output is disabled' };
        }
        if (breadboard.elvisMode) {
          const elvisRes = getHoleTrace('ELV_33A');
          if (elvisRes.valid) return elvisRes;
        }
        if (fgen.probeHole) {
          return getHoleTrace(fgen.probeHole);
        }
        return { valid: false, samples: null, reason: 'No FGEN output node available' };
      }
      case 'PROBE':
        return getHoleTrace(sourceSpec.holeId);
      default:
        return { valid: false, samples: null, reason: `Unknown source type: ${sourceSpec.type}` };
    }
  };

  return {
    powered,
    dt,
    totalDurationSec: duration,
    numSamples: count,
    times,
    nodeTraces,
    floatingNets,
    getHoleTrace,
    getChannelTrace,
    getDiffTrace
  };
}
