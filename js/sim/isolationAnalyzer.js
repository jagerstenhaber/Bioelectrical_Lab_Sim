import { analyzeCircuit } from '../connectivity.js';
import { solveLinearSystem } from './linearAlgebra.js';

/**
 * Pure, zero-DOM IEC 60601 Bioelectrical Isolation & Single-Fault Safety Analyzer.
 * Evaluates galvanic host/mains isolation, secondary high-pass / DC-blocking stages,
 * patient-electrode DC rail faults, and optional series lead-protection resistors.
 *
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

/**
 * Extensible registry of patient-applied electrode groups mounted on the bench.
 * Future direct-patient sensors (e.g., 3-lead/12-lead ECG) can be registered here.
 */
export const PATIENT_APPLIED_SENSOR_SPECS = Object.freeze([
  Object.freeze({
    id: 'emg',
    label: '3-Pad Surface EMG',
    boardFlag: 'emgMode',
    signalStrips: Object.freeze(['SENSOR_EMG_RED1', 'SENSOR_EMG_RED2']),
    refStrips: Object.freeze(['SENSOR_EMG_BLK'])
  })
]);

const NANO_ISOLATION_PIN_IDS = Object.freeze(['GND_TOP', 'GND_BOT', '5V', '3V3', 'VIN']);
const NANO_RECORDING_PIN_RE = /^(?:A[0-7]|D(?:[0-9]|1[0-3]))$/;

const ELVIS_MAINS_STRIP_IDS = Object.freeze([
  'ELVIS_ROW_18', // AIGND
  'ELVIS_ROW_48', // SUPPLY +
  'ELVIS_ROW_49', // GROUND
  'ELVIS_ROW_50', // SUPPLY -
  'ELVIS_ROW_51', // +15V
  'ELVIS_ROW_52', // -15V
  'ELVIS_ROW_53', // GROUND
  'ELVIS_ROW_54' // +5V
]);

const ELVIS_POWER_STRIP_IDS = Object.freeze([
  'ELVIS_ROW_48', // SUPPLY +
  'ELVIS_ROW_50', // SUPPLY -
  'ELVIS_ROW_51', // +15V
  'ELVIS_ROW_52', // -15V
  'ELVIS_ROW_54' // +5V
]);

const ELVIS_AI_POS_STRIP_IDS = Object.freeze([
  'ELVIS_ROW_1',  // AI 0+
  'ELVIS_ROW_3',  // AI 1+
  'ELVIS_ROW_5',  // AI 2+
  'ELVIS_ROW_7',  // AI 3+
  'ELVIS_ROW_9',  // AI 4+
  'ELVIS_ROW_11', // AI 5+
  'ELVIS_ROW_13', // AI 6+
  'ELVIS_ROW_15'  // AI 7+
]);

const LOW_RESISTANCE_BYPASS_OHMS = 100;
const LEAD_PROTECTION_MIN_OHMS = 10000;

function lookupPartDef(catalogMap, partId) {
  if (!catalogMap || !partId) return null;
  if (typeof catalogMap.get === 'function') {
    return catalogMap.get(partId) || null;
  }
  return catalogMap[partId] || null;
}

function buildStripToNetMap(connectivity) {
  const stripToNet = new Map();
  if (!connectivity?.nets) return stripToNet;
  for (const [netId, net] of connectivity.nets.entries()) {
    for (const stripId of net.strips) {
      stripToNet.set(stripId, netId);
    }
  }
  return stripToNet;
}

function formatCutoffHz(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '';
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  if (hz >= 10) return `${hz.toFixed(1)} Hz`;
  return `${hz.toFixed(2)} Hz`;
}

function addUndirectedEdge(adj, a, b, meta = null) {
  if (!a || !b || a === b) return;
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a).push({ to: b, meta });
  adj.get(b).push({ to: a, meta });
}

function bfsReachable(startNodes, adj, { blockedNodes = null } = {}) {
  const visited = new Set();
  const queue = [];

  for (const start of startNodes) {
    if (!start || blockedNodes?.has(start) || visited.has(start)) continue;
    visited.add(start);
    queue.push(start);
  }

  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    const neighbors = adj.get(curr);
    if (!neighbors) continue;
    for (const edge of neighbors) {
      const next = edge.to;
      if (blockedNodes?.has(next) || visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }

  return visited;
}

function canReachAnyAvoid(startNode, targetSet, adj, forbiddenNode, stopSet = null) {
  if (!startNode || startNode === forbiddenNode) return false;
  if (targetSet.has(startNode)) return true;

  const visited = new Set([startNode]);
  const queue = [startNode];
  let head = 0;

  while (head < queue.length) {
    const curr = queue[head++];
    if (stopSet?.has(curr) && !targetSet.has(curr)) continue;

    const neighbors = adj.get(curr);
    if (!neighbors) continue;

    for (const edge of neighbors) {
      const next = edge.to;
      if (next === forbiddenNode || visited.has(next)) continue;
      if (targetSet.has(next)) return true;
      if (stopSet?.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }

  return false;
}

/**
 * Extracts passive resistor edges, capacitors, and active IC amplifier stages
 * in a lightweight graph representation for isolation and HPF analysis.
 */
function extractSignalComponents(context) {
  const { breadboard, placedParts, catalogMap, connectivity, stripToNet } = context;

  const passiveResistors = [];
  const capacitors = [];
  const ampStages = [];
  const ampOutputNets = new Set();
  const activeIcNets = new Set();

  for (const inst of placedParts) {
    const partDef = lookupPartDef(catalogMap, inst.partId);
    if (!partDef) continue;

    if (partDef.unit === 'Ω' && Number.isFinite(partDef.value)) {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      const ohms = Math.max(1e-6, partDef.value);
      if (net1 && net2) {
        passiveResistors.push({
          instanceId: inst.id,
          net1,
          net2,
          strip1: h1.stripId,
          strip2: h2.stripId,
          ohms
        });
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

      const props = inst.props && typeof inst.props === 'object' ? inst.props : {};
      const totalR = Math.max(1, Number.isFinite(props.resistance) ? props.resistance : 10000);
      const rawAlpha = Number.isFinite(props.wiper) ? props.wiper : 0.5;
      const alpha = Math.min(0.999, Math.max(0.001, rawAlpha));

      if (net1 && netW) {
        passiveResistors.push({
          instanceId: inst.id,
          net1,
          net2: netW,
          strip1: h1.stripId,
          strip2: hW.stripId,
          ohms: alpha * totalR
        });
      }
      if (netW && net3) {
        passiveResistors.push({
          instanceId: inst.id,
          net1: netW,
          net2: net3,
          strip1: hW.stripId,
          strip2: h3.stripId,
          ohms: (1 - alpha) * totalR
        });
      }
      continue;
    }

    if (inst.partId === 'pushbutton-4pin') {
      const pressed = Boolean(inst.props?.pressed);
      if (pressed) {
        const hA = connectivity.getPinHole(inst.id, 'P1') || connectivity.getPinHole(inst.id, 'P3');
        const hB = connectivity.getPinHole(inst.id, 'P2') || connectivity.getPinHole(inst.id, 'P4');
        const net1 = hA ? stripToNet.get(hA.stripId) : null;
        const net2 = hB ? stripToNet.get(hB.stripId) : null;
        if (net1 && net2) {
          passiveResistors.push({
            instanceId: inst.id,
            net1,
            net2,
            strip1: hA.stripId,
            strip2: hB.stripId,
            ohms: 0.1
          });
        }
      }
      continue;
    }

    if (partDef.unit === 'F' && Number.isFinite(partDef.value)) {
      const h1 = connectivity.getPinHole(inst.id, 'P1');
      const h2 = connectivity.getPinHole(inst.id, 'P2');
      const net1 = h1 ? stripToNet.get(h1.stripId) : null;
      const net2 = h2 ? stripToNet.get(h2.stripId) : null;
      capacitors.push({
        inst,
        partDef,
        capacitance: partDef.value,
        net1,
        net2,
        h1,
        h2
      });
      continue;
    }

    const getPinNet = (pinId) => {
      const h = connectivity.getPinHole(inst.id, pinId);
      return h ? stripToNet.get(h.stripId) : null;
    };

    if (inst.partId === 'inamp-ad620') {
      const netInP = getPinNet('IN+');
      const netInN = getPinNet('IN-');
      const netOut = getPinNet('OUT');
      for (const pin of partDef.pins || []) {
        const n = getPinNet(pin.id);
        if (n) activeIcNets.add(n);
      }
      if (netOut) ampOutputNets.add(netOut);
      if (netInP && netOut) ampStages.push({ netIn: netInP, netOut, partId: inst.partId });
      if (netInN && netOut) ampStages.push({ netIn: netInN, netOut, partId: inst.partId });
      continue;
    }

    if (inst.partId === 'opamp-dual-dip8') {
      for (const pin of partDef.pins || []) {
        const n = getPinNet(pin.id);
        if (n) activeIcNets.add(n);
      }
      const pairs = [
        ['IN1+', 'OUT1'],
        ['IN1-', 'OUT1'],
        ['IN2+', 'OUT2'],
        ['IN2-', 'OUT2']
      ];
      for (const [inPin, outPin] of pairs) {
        const netIn = getPinNet(inPin);
        const netOut = getPinNet(outPin);
        if (netOut) ampOutputNets.add(netOut);
        if (netIn && netOut) ampStages.push({ netIn, netOut, partId: inst.partId });
      }
      continue;
    }

    if (inst.partId === 'arduino-nano') {
      for (const pin of partDef.pins || []) {
        const n = getPinNet(pin.id);
        if (n) activeIcNets.add(n);
      }
    }
  }

  // Also include passive resistors in connectivity's power/ground rails check?
  // Already in `passiveResistors` from placed parts.
  void breadboard;

  return {
    passiveResistors,
    capacitors,
    ampStages,
    ampOutputNets,
    activeIcNets
  };
}

/**
 * Computes effective passive resistance (in Ohms) between `sourceNet` and `targetNets`
 * over `passiveResistors`, solving `G * v = e_source` with `targetNets` clamped to 0 V.
 * Returns `null` if `sourceNet` has no resistive path to any net in `targetNets`.
 */
function computeEffectiveResistanceToTargets(sourceNet, targetNets, passiveResistors) {
  if (!sourceNet || !targetNets || targetNets.size === 0) return null;
  if (targetNets.has(sourceNet)) return 0;

  const adj = new Map();
  for (const r of passiveResistors) {
    if (!r.net1 || !r.net2 || r.net1 === r.net2 || !Number.isFinite(r.ohms) || r.ohms <= 0) {
      continue;
    }
    addUndirectedEdge(adj, r.net1, r.net2, r);
  }

  // Find connected component of sourceNet without crossing targetNets
  const unknownNets = [];
  const unknownSet = new Set();
  const visited = new Set([sourceNet]);
  const queue = [sourceNet];
  let touchesTarget = false;
  let head = 0;

  while (head < queue.length) {
    const curr = queue[head++];
    if (!targetNets.has(curr)) {
      unknownSet.add(curr);
      unknownNets.push(curr);
    }
    const neighbors = adj.get(curr);
    if (!neighbors) continue;
    for (const { to } of neighbors) {
      if (targetNets.has(to)) {
        touchesTarget = true;
        continue;
      }
      if (!visited.has(to)) {
        visited.add(to);
        queue.push(to);
      }
    }
  }

  if (!touchesTarget || unknownNets.length === 0) return null;

  const n = unknownNets.length;
  const idxMap = new Map();
  for (let i = 0; i < n; i++) {
    idxMap.set(unknownNets[i], i);
  }

  const G = Array.from({ length: n }, () => new Float64Array(n));
  const rhs = new Float64Array(n);
  rhs[idxMap.get(sourceNet)] = 1;

  for (const r of passiveResistors) {
    if (!r.net1 || !r.net2 || r.net1 === r.net2 || !Number.isFinite(r.ohms) || r.ohms <= 0) {
      continue;
    }
    const inComp1 = unknownSet.has(r.net1);
    const inComp2 = unknownSet.has(r.net2);
    const isRef1 = targetNets.has(r.net1);
    const isRef2 = targetNets.has(r.net2);

    if (!((inComp1 || isRef1) && (inComp2 || isRef2))) continue;
    if (!inComp1 && !inComp2) continue;

    const g = 1 / r.ohms;
    const i1 = inComp1 ? idxMap.get(r.net1) : -1;
    const i2 = inComp2 ? idxMap.get(r.net2) : -1;

    if (i1 >= 0) G[i1][i1] += g;
    if (i2 >= 0) G[i2][i2] += g;
    if (i1 >= 0 && i2 >= 0) {
      G[i1][i2] -= g;
      G[i2][i1] -= g;
    }
  }

  const voltages = solveLinearSystem(G, rhs);
  if (!voltages) return null;

  const rEq = voltages[idxMap.get(sourceNet)];
  return Number.isFinite(rEq) && rEq >= 0 ? rEq : null;
}

/**
 * Evaluates Check 1: Primary Galvanic Isolation (Host / Mains).
 */
function evaluateGalvanicHostIsolation(context) {
  const { breadboard, placedParts, wires, catalogMap, connectivity, simConfig, stripToNet, elements } =
    context;

  const nanoParts = placedParts.filter((p) => p.partId === 'arduino-nano');
  const hasNano = nanoParts.length > 0;
  const hasUsbIsolator = Boolean(simConfig?.usbIsolatorEnabled);
  const hasElvis = Boolean(breadboard?.elvisMode);

  if (hasNano && hasUsbIsolator && hasElvis) {
    const isolatedBoundaryStrips = new Set();
    const isolatedBoundaryNets = new Set();

    for (const nano of nanoParts) {
      for (const pinId of NANO_ISOLATION_PIN_IDS) {
        const hole = connectivity.getPinHole(nano.id, pinId);
        if (hole) {
          isolatedBoundaryStrips.add(hole.stripId);
          const netId = stripToNet.get(hole.stripId);
          if (netId) isolatedBoundaryNets.add(netId);
        }
      }
    }

    // Patient-applied electrodes (signal & reference) must also remain isolated from mains ELVIS rails
    for (const spec of context.activeSensorSpecs || []) {
      for (const stripId of [...(spec.signalStrips || []), ...(spec.refStrips || [])]) {
        if (!breadboard.strips.has(stripId)) continue;
        isolatedBoundaryStrips.add(stripId);
        const netId = stripToNet.get(stripId);
        if (netId) isolatedBoundaryNets.add(netId);
      }
    }

    const elvisMainsStrips = new Set();
    const elvisMainsNets = new Set();
    for (const stripId of ELVIS_MAINS_STRIP_IDS) {
      if (!breadboard.strips.has(stripId)) continue;
      elvisMainsStrips.add(stripId);
      const netId = stripToNet.get(stripId);
      if (netId) elvisMainsNets.add(netId);
    }

    // Check direct net sharing OR low-resistance (< 100 Ω) path between isolated boundary & ELVIS mains
    let bridged = false;
    for (const netId of isolatedBoundaryNets) {
      if (elvisMainsNets.has(netId)) {
        bridged = true;
        break;
      }
    }
    if (!bridged) {
      for (const netId of isolatedBoundaryNets) {
        const rEq = computeEffectiveResistanceToTargets(
          netId,
          elvisMainsNets,
          elements.passiveResistors
        );
        if (rEq !== null && rEq < LOW_RESISTANCE_BYPASS_OHMS - 1e-6) {
          bridged = true;
          break;
        }
      }
    }

    if (bridged) {
      // Build strip-level adjacency graph to trace exact placed wires bridging the barrier
      const stripAdj = new Map();

      for (const wire of wires) {
        if (!wire) continue;
        const hA = breadboard.getHole(wire.holeA);
        const hB = breadboard.getHole(wire.holeB);
        if (hA && hB && hA.stripId !== hB.stripId) {
          addUndirectedEdge(stripAdj, hA.stripId, hB.stripId, { kind: 'wire', wireId: wire.id });
        }
      }

      for (const inst of placedParts) {
        const partDef = lookupPartDef(catalogMap, inst.partId);
        if (!partDef || !Array.isArray(partDef.internalNets)) continue;
        for (const group of partDef.internalNets) {
          const strips = [];
          for (const pinId of group) {
            const h = connectivity.getPinHole(inst.id, pinId);
            if (h) strips.push(h.stripId);
          }
          for (let i = 1; i < strips.length; i++) {
            addUndirectedEdge(stripAdj, strips[0], strips[i], { kind: 'internal' });
          }
        }
      }

      // Low-resistance (< 100 Ω) parts can also form part of a bridging path
      for (const r of elements.passiveResistors) {
        if (r.ohms < LOW_RESISTANCE_BYPASS_OHMS - 1e-6 && r.strip1 && r.strip2) {
          addUndirectedEdge(stripAdj, r.strip1, r.strip2, { kind: 'low-r' });
        }
      }

      const offendingWireIds = [];
      const seenWireIds = new Set();

      for (const wire of wires) {
        if (!wire) continue;
        const hA = breadboard.getHole(wire.holeA);
        const hB = breadboard.getHole(wire.holeB);
        if (!hA || !hB || hA.stripId === hB.stripId) continue;

        const sA = hA.stripId;
        const sB = hB.stripId;

        const aToIsoBToElvis =
          canReachAnyAvoid(sA, isolatedBoundaryStrips, stripAdj, sB, elvisMainsStrips) &&
          canReachAnyAvoid(sB, elvisMainsStrips, stripAdj, sA, isolatedBoundaryStrips);

        const bToIsoAToElvis =
          canReachAnyAvoid(sB, isolatedBoundaryStrips, stripAdj, sA, elvisMainsStrips) &&
          canReachAnyAvoid(sA, elvisMainsStrips, stripAdj, sB, isolatedBoundaryStrips);

        if ((aToIsoBToElvis || bToIsoAToElvis) && !seenWireIds.has(wire.id)) {
          seenWireIds.add(wire.id);
          offendingWireIds.push(wire.id);
        }
      }

      return {
        status: 'fail',
        summary: 'Isolation Barrier Bridged',
        detail:
          'A jumper or low-resistance connection bridges the ADuM3160-isolated Arduino Nano or patient electrodes to mains-referenced NI ELVIS II ground/rails, defeating galvanic isolation.',
        offendingWireIds,
        bridged: true
      };
    }

    return {
      status: 'pass',
      summary: 'ADuM3160 USB Isolator Active (2.5 kVrms)',
      detail:
        'ADuM3160 provides 2.5 kVrms galvanic USB isolation between the host PC and Arduino Nano with no bridge to mains-referenced bench rails.',
      offendingWireIds: [],
      bridged: false
    };
  }

  if (hasNano && hasUsbIsolator) {
    return {
      status: 'pass',
      summary: 'ADuM3160 USB Isolator Active (2.5 kVrms)',
      detail:
        'ADuM3160 provides 2.5 kVrms galvanic USB isolation between the host PC and Arduino Nano acquisition domain.',
      offendingWireIds: [],
      bridged: false
    };
  }

  if (hasNano && !hasUsbIsolator) {
    return {
      status: 'fail',
      summary: 'Unisolated USB Connection',
      detail:
        'Arduino Nano USB shares a direct galvanic ground path to the host PC. Insert the ADuM3160 USB Isolator (Sensors & Safety tab) on the Arduino Nano USB line.',
      offendingWireIds: [],
      bridged: false
    };
  }

  if (hasElvis) {
    return {
      status: 'warn',
      summary: 'Mains-Referenced ELVIS Bench',
      detail:
        'NI ELVIS II supplies and ground are mains-referenced. Use an isolated Arduino Nano + ADuM3160 USB Isolator path before connecting live human electrodes.',
      offendingWireIds: [],
      bridged: false
    };
  }

  return {
    status: 'warn',
    summary: 'No Isolated Acquisition Stage',
    detail:
      'No isolated acquisition stage detected. Add an Arduino Nano with the ADuM3160 USB Isolator enabled for primary host galvanic isolation.',
    offendingWireIds: [],
    bridged: false
  };
}

/**
 * Evaluates Check 2: Secondary High-Pass / DC-Blocking Stage.
 */
function evaluateSecondaryHighpassBlocking(context) {
  const {
    breadboard,
    placedParts,
    catalogMap,
    connectivity,
    simConfig,
    stripToNet,
    activeSensorSpecs,
    elements
  } = context;

  const railNets = new Set();
  for (const [netId, net] of connectivity.nets.entries()) {
    if (net.hasGround || net.hasPower) {
      railNets.add(netId);
    }
  }

  // Also include Nano VIN / ELVIS power strips in case powered flag differs
  for (const inst of placedParts) {
    if (inst.partId !== 'arduino-nano') continue;
    for (const pinId of NANO_ISOLATION_PIN_IDS) {
      const h = connectivity.getPinHole(inst.id, pinId);
      const n = h ? stripToNet.get(h.stripId) : null;
      if (n) railNets.add(n);
    }
  }
  if (breadboard.elvisMode) {
    for (const stripId of ELVIS_MAINS_STRIP_IDS) {
      const n = stripToNet.get(stripId);
      if (n) railNets.add(n);
    }
  }

  // Patient signal nets (e.g. SENSOR_EMG_RED1, SENSOR_EMG_RED2)
  const patientNets = new Set();
  for (const spec of activeSensorSpecs) {
    for (const stripId of spec.signalStrips) {
      const netId = stripToNet.get(stripId);
      if (netId && !railNets.has(netId)) {
        patientNets.add(netId);
      }
    }
  }

  // Recording / output nets (wired Nano A0..A7/D0..D13, wired ELVIS AI 0+..AI 7+, or active DMM Red probe)
  const wiredRecordingNets = new Set();
  for (const inst of placedParts) {
    if (inst.partId !== 'arduino-nano') continue;
    const partDef = lookupPartDef(catalogMap, inst.partId);
    for (const pin of partDef?.pins || []) {
      if (!NANO_RECORDING_PIN_RE.test(pin.id)) continue;
      const hole = connectivity.getPinHole(inst.id, pin.id);
      if (!hole) continue;
      const net = connectivity.getNetForHole(hole.id);
      if (!net) continue;
      if (net.wires.size > 0 || net.pins.length > 1) {
        wiredRecordingNets.add(net.id);
      }
    }
  }

  if (breadboard.elvisMode) {
    for (const stripId of ELVIS_AI_POS_STRIP_IDS) {
      const netId = stripToNet.get(stripId);
      if (!netId) continue;
      const net = connectivity.nets.get(netId);
      if (net && (net.wires.size > 0 || net.pins.some((p) => p.kind === 'pin'))) {
        wiredRecordingNets.add(netId);
      }
    }
  }

  const dmmProbeRed = simConfig?.dmmProbeRed ?? simConfig?.dmm?.probeRed ?? null;
  if (typeof dmmProbeRed === 'string' && dmmProbeRed.length > 0) {
    const hole = breadboard.getHole(dmmProbeRed);
    const netId = hole ? stripToNet.get(hole.stripId) : null;
    if (netId) wiredRecordingNets.add(netId);
  }

  // Build DC-only signal graph (resistors + active amp stages, no capacitors, no rail crossings)
  const dcSignalAdj = new Map();
  for (const r of elements.passiveResistors) {
    if (!r.net1 || !r.net2 || r.net1 === r.net2 || r.ohms >= 1e8) continue;
    if (railNets.has(r.net1) || railNets.has(r.net2)) continue;
    addUndirectedEdge(dcSignalAdj, r.net1, r.net2, { kind: 'resistor', r });
  }
  for (const st of elements.ampStages) {
    if (!st.netIn || !st.netOut || st.netIn === st.netOut) continue;
    if (railNets.has(st.netIn) || railNets.has(st.netOut)) continue;
    addUndirectedEdge(dcSignalAdj, st.netIn, st.netOut, { kind: 'amp', st });
  }

  // Identify bypassed vs non-bypassed capacitors
  const nonBypassedCaps = [];
  const bypassedCaps = [];

  for (const cap of elements.capacitors) {
    if (!cap.net1 || !cap.net2) continue;
    if (cap.net1 === cap.net2) {
      bypassedCaps.push(cap);
      continue;
    }
    const rParallel = computeEffectiveResistanceToTargets(
      cap.net1,
      new Set([cap.net2]),
      elements.passiveResistors
    );
    if (rParallel !== null && rParallel < LOW_RESISTANCE_BYPASS_OHMS - 1e-6) {
      bypassedCaps.push(cap);
    } else {
      nonBypassedCaps.push(cap);
    }
  }

  // Build full signal-chain graph (DC graph + non-bypassed non-rail capacitors)
  const fullSignalAdj = new Map();
  for (const [k, edges] of dcSignalAdj.entries()) {
    fullSignalAdj.set(k, [...edges]);
  }
  for (const cap of nonBypassedCaps) {
    if (railNets.has(cap.net1) || railNets.has(cap.net2)) continue;
    addUndirectedEdge(fullSignalAdj, cap.net1, cap.net2, { kind: 'cap', cap });
  }

  const reachableFromPatientFull = bfsReachable(patientNets, fullSignalAdj, {
    blockedNodes: railNets
  });
  const reachableFromPatientDc = bfsReachable(patientNets, dcSignalAdj, {
    blockedNodes: railNets
  });

  // Determine effective target recording nets (fallback if no Nano/ELVIS AI/DMM output wired yet)
  let targetRecordingNets = wiredRecordingNets;
  if (targetRecordingNets.size === 0) {
    const fallbackTargets = new Set();
    for (const cap of nonBypassedCaps) {
      if (railNets.has(cap.net1) || railNets.has(cap.net2)) continue;
      if (reachableFromPatientDc.has(cap.net1) && !reachableFromPatientDc.has(cap.net2)) {
        fallbackTargets.add(cap.net2);
      } else if (reachableFromPatientDc.has(cap.net2) && !reachableFromPatientDc.has(cap.net1)) {
        fallbackTargets.add(cap.net1);
      }
    }
    if (fallbackTargets.size === 0) {
      for (const outNet of elements.ampOutputNets) {
        if (!railNets.has(outNet)) fallbackTargets.add(outNet);
      }
    }
    targetRecordingNets = fallbackTargets;
  }

  // Check whether removing all series capacitors disconnects target recording nets from patient DC path
  let anyRecordingHasDcPath = false;
  for (const recNet of targetRecordingNets) {
    if (reachableFromPatientDc.has(recNet)) {
      anyRecordingHasDcPath = true;
      break;
    }
  }

  const validHpfStages = [];
  if (!anyRecordingHasDcPath && targetRecordingNets.size > 0) {
    for (const cap of nonBypassedCaps) {
      if (railNets.has(cap.net1) || railNets.has(cap.net2)) continue;

      const orientations = [
        [cap.net1, cap.net2],
        [cap.net2, cap.net1]
      ];
      for (const [netA, netB] of orientations) {
        // Upstream side netA must be reachable from patient electrodes without crossing netB
        const upstreamReach = bfsReachable(patientNets, fullSignalAdj, {
          blockedNodes: new Set([...railNets, netB])
        });
        if (!upstreamReach.has(netA)) continue;

        // Downstream side netB must NOT have an unblocked DC path from patient electrodes
        if (reachableFromPatientDc.has(netB)) continue;

        // Downstream side netB reaches target recording net through signal chain (allowing cascaded stages) without crossing netA
        const downstreamReach = bfsReachable([netB], fullSignalAdj, {
          blockedNodes: new Set([...railNets, netA])
        });
        let reachesTarget = false;
        for (const recNet of targetRecordingNets) {
          if (downstreamReach.has(recNet)) {
            reachesTarget = true;
            break;
          }
        }

        const rEq = computeEffectiveResistanceToTargets(netB, railNets, elements.passiveResistors);
        const hasBiasToRail = rEq !== null && rEq > 0;

        // Accept when downstream reaches a wired output OR (when unwired) has a bias/shunt resistor to GND/Vref
        if (reachesTarget || (wiredRecordingNets.size === 0 && hasBiasToRail)) {
          validHpfStages.push({
            cap,
            netA,
            netB,
            rEq: hasBiasToRail ? rEq : null
          });
          break;
        }
      }
    }
  }

  if (validHpfStages.length > 0) {
    // Combine any capacitors directly in parallel across the same {netA, netB} pair
    const primary =
      validHpfStages.find((stage) => Number.isFinite(stage.rEq) && stage.rEq > 0) ||
      validHpfStages[0];
    let cTotal = 0;
    for (const stage of validHpfStages) {
      if (
        (stage.netA === primary.netA && stage.netB === primary.netB) ||
        (stage.netA === primary.netB && stage.netB === primary.netA)
      ) {
        cTotal += stage.cap.capacitance;
      }
    }
    if (cTotal <= 0) cTotal = primary.cap.capacitance;

    let detectedHpfCutoffHz = null;
    if (Number.isFinite(primary.rEq) && primary.rEq > 0 && cTotal > 0) {
      detectedHpfCutoffHz = 1 / (2 * Math.PI * primary.rEq * cTotal);
    }

    const fmtHz = detectedHpfCutoffHz ? formatCutoffHz(detectedHpfCutoffHz) : '';
    return {
      status: 'pass',
      summary: detectedHpfCutoffHz
        ? `High-Pass Filter Detected (fc ≈ ${fmtHz})`
        : 'Series AC-Coupling Capacitor Detected',
      detail: detectedHpfCutoffHz
        ? `Series AC-coupling capacitor (${(cTotal * 1e6).toPrecision(3)} µF) with effective bias resistance ${(primary.rEq / 1000).toFixed(2)} kΩ blocks DC fault currents (f_c ≈ ${fmtHz}).`
        : 'Series AC-coupling capacitor isolates downstream recording stages from DC fault paths.',
      detectedHpfCutoffHz
    };
  }

  // Check if a capacitor on the signal path was bypassed
  const bypassedOnSignalPath = bypassedCaps.some((cap) => {
    if (railNets.has(cap.net1) || railNets.has(cap.net2)) return false;
    return reachableFromPatientFull.has(cap.net1) || reachableFromPatientFull.has(cap.net2);
  });

  if (bypassedOnSignalPath) {
    return {
      status: 'fail',
      summary: 'High-Pass Capacitor Bypassed',
      detail:
        'A jumper wire or low-resistance (< 100 Ω) path shorts across the coupling capacitor, restoring a direct DC path from patient electrodes to the acquisition stage.',
      detectedHpfCutoffHz: null
    };
  }

  return {
    status: 'fail',
    summary: 'No Secondary High-Pass Stage',
    detail:
      'Add a series AC-coupling / high-pass capacitor (e.g., 1 µF + 10 kΩ to GND/Vref, fc ≈ 15.9 Hz) in the signal path for IEC 60601 single-fault DC blocking.',
    detectedHpfCutoffHz: null
  };
}

/**
 * Evaluates Check 3: Patient Electrode DC Rail Fault Check.
 */
function evaluatePatientRailFault(context) {
  const { breadboard, placedParts, connectivity, stripToNet, activeSensorSpecs, elements } =
    context;

  const powerRailNets = new Set();
  const railLabelByNet = new Map();

  for (const [netId, net] of connectivity.nets.entries()) {
    if (net.hasPower) {
      powerRailNets.add(netId);
      if (net.powerLabels?.size > 0) {
        railLabelByNet.set(netId, Array.from(net.powerLabels).join(' / '));
      }
    }
  }

  for (const inst of placedParts) {
    if (inst.partId !== 'arduino-nano') continue;
    for (const pinId of ['5V', '3V3', 'VIN']) {
      const h = connectivity.getPinHole(inst.id, pinId);
      const netId = h ? stripToNet.get(h.stripId) : null;
      if (netId) {
        powerRailNets.add(netId);
        if (!railLabelByNet.has(netId)) {
          railLabelByNet.set(netId, `Nano ${pinId}`);
        }
      }
    }
  }

  if (breadboard.elvisMode) {
    for (const stripId of ELVIS_POWER_STRIP_IDS) {
      const netId = stripToNet.get(stripId);
      if (netId) {
        powerRailNets.add(netId);
        if (!railLabelByNet.has(netId)) {
          const holes = breadboard.getStripHoles(stripId);
          const label = holes?.[0]?.elvisLabel || stripId;
          railLabelByNet.set(netId, `ELVIS ${label}`);
        }
      }
    }
  }

  const faultedElectrodes = [];
  for (const spec of activeSensorSpecs) {
    for (const stripId of spec.signalStrips) {
      const electrodeNet = stripToNet.get(stripId);
      if (!electrodeNet) continue;

      if (powerRailNets.has(electrodeNet)) {
        faultedElectrodes.push({
          stripId,
          railLabel: railLabelByNet.get(electrodeNet) || 'DC Supply Rail'
        });
        continue;
      }

      const rEq = computeEffectiveResistanceToTargets(
        electrodeNet,
        powerRailNets,
        elements.passiveResistors
      );
      if (rEq !== null && rEq < LOW_RESISTANCE_BYPASS_OHMS - 1e-6) {
        faultedElectrodes.push({
          stripId,
          railLabel: 'DC Supply Rail (< 100 Ω)'
        });
      }
    }
  }

  if (faultedElectrodes.length > 0) {
    const desc = faultedElectrodes
      .map((f) => `${f.stripId.replace(/^SENSOR_/, '')} → ${f.railLabel}`)
      .join(', ');
    return {
      status: 'fail',
      summary: 'Direct Power-Rail Fault on Patient Electrode!',
      detail: `Patient electrode connected directly to a DC supply rail (${desc}). Remove the power-rail short immediately.`
    };
  }

  return {
    status: 'pass',
    summary: 'No Direct Power-Rail Shorts',
    detail: 'No patient-applied signal electrode is shorted or low-resistance coupled (< 100 Ω) to a DC supply rail.'
  };
}

/**
 * Evaluates Check 4: Patient-Lead Series Protection (Bonus).
 */
function evaluateLeadCurrentLimiting(context) {
  const { connectivity, stripToNet, activeSensorSpecs, elements } = context;

  const signalStrips = [];
  for (const spec of activeSensorSpecs) {
    for (const stripId of spec.signalStrips) {
      signalStrips.push(stripId);
    }
  }

  if (signalStrips.length === 0) {
    return {
      status: 'info',
      summary: 'Optional: Add ≥10 kΩ Series Lead Resistors',
      detail:
        'Placing ≥10 kΩ series resistors directly on patient signal leads limits fault current per IEC 60601 auxiliary current limits.'
    };
  }

  const allLeadsProtected = signalStrips.every((stripId) => {
    const electrodeNet = stripToNet.get(stripId);
    if (!electrodeNet) return false;
    const net = connectivity.nets.get(electrodeNet);
    if (!net) return false;

    // Must not sit directly on an active IC pin
    if (elements.activeIcNets.has(electrodeNet)) return false;

    // Must have at least one >= 10 kΩ series resistor directly attached to the electrode net
    const hasSeriesTenK = elements.passiveResistors.some(
      (r) =>
        r.net1 !== r.net2 &&
        r.ohms >= LEAD_PROTECTION_MIN_OHMS - 1e-6 &&
        (r.net1 === electrodeNet || r.net2 === electrodeNet)
    );
    if (!hasSeriesTenK) return false;

    // Must not have any < 10 kΩ path from electrodeNet to an active IC pin
    if (elements.activeIcNets.size > 0) {
      const rToIc = computeEffectiveResistanceToTargets(
        electrodeNet,
        elements.activeIcNets,
        elements.passiveResistors
      );
      if (rToIc !== null && rToIc < LEAD_PROTECTION_MIN_OHMS - 1e-6) {
        return false;
      }
    }

    return true;
  });

  if (allLeadsProtected) {
    return {
      status: 'pass',
      summary: '≥10 kΩ Series Lead Protection Present',
      detail:
        'Both patient signal leads are series-protected by ≥10 kΩ current-limiting resistors before any active IC stage (IEC 60601 auxiliary current limiting).'
    };
  }

  return {
    status: 'info',
    summary: 'Optional: Add ≥10 kΩ Series Lead Resistors',
    detail:
      'Add ≥10 kΩ series resistors directly on both RED 1 and RED 2 patient leads before active IC pins for IEC 60601 single-fault patient-lead current limiting.'
  };
}

/**
 * Extensible registry of isolation barrier checks.
 * Future checks (optocouplers, isolation amplifiers, battery packs) plug into this list.
 */
export const ISOLATION_BARRIER_CHECKS = Object.freeze([
  Object.freeze({
    id: 'galvanic-host-isolation',
    required: true,
    category: 'primary',
    title: 'Primary Galvanic Isolation (Host / Mains)',
    evaluate: evaluateGalvanicHostIsolation
  }),
  Object.freeze({
    id: 'secondary-highpass-blocking',
    required: true,
    category: 'secondary',
    title: 'Secondary High-Pass / DC-Blocking Stage',
    evaluate: evaluateSecondaryHighpassBlocking
  }),
  Object.freeze({
    id: 'patient-rail-fault',
    required: true,
    category: 'fault',
    title: 'Patient Electrode DC Rail Fault Check',
    evaluate: evaluatePatientRailFault
  }),
  Object.freeze({
    id: 'lead-current-limiting',
    required: false,
    category: 'bonus',
    title: 'Patient-Lead Series Protection (Bonus)',
    evaluate: evaluateLeadCurrentLimiting
  })
]);

/**
 * Assesses IEC 60601 primary galvanic isolation, secondary AC-coupling / high-pass DC blocking,
 * patient rail fault hazards, and optional series lead protection for mounted patient sensors.
 *
 * @param {object} params
 * @param {import('../breadboard.js').BreadboardModel} params.breadboard
 * @param {Array<object>} [params.placedParts]
 * @param {Array<object>} [params.wires]
 * @param {Map<string, object>} [params.catalogMap]
 * @param {object | null} [params.connectivity]
 * @param {object} [params.simConfig]
 * @param {object | null} [params.dcResult]
 * @returns {{
 *   active: boolean,
 *   level: 'inactive' | 'safe' | 'partial' | 'hazard',
 *   passedRequired: number,
 *   totalRequired: number,
 *   summary: string,
 *   checks: Array<object>,
 *   offendingWireIds: Array<string>,
 *   detectedHpfCutoffHz: number | null,
 *   hasUsbIsolator: boolean
 * }}
 */
export function analyzeCircuitIsolation({
  breadboard,
  placedParts = [],
  wires = [],
  catalogMap = new Map(),
  connectivity = null,
  simConfig = {},
  dcResult = null
} = {}) {
  const hasUsbIsolator = Boolean(simConfig?.usbIsolatorEnabled);

  const activeSensorSpecs = breadboard
    ? PATIENT_APPLIED_SENSOR_SPECS.filter((spec) => Boolean(breadboard?.[spec.boardFlag]))
    : [];

  if (activeSensorSpecs.length === 0) {
    return {
      active: false,
      level: 'inactive',
      passedRequired: 0,
      totalRequired: 0,
      summary: 'No patient-applied electrodes mounted',
      checks: [],
      offendingWireIds: [],
      detectedHpfCutoffHz: null,
      hasUsbIsolator
    };
  }

  const safeParts = Array.isArray(placedParts) ? placedParts : [];
  const safeWires = Array.isArray(wires) ? wires : [];
  const conn = connectivity || analyzeCircuit(breadboard, safeParts, safeWires, catalogMap);
  const stripToNet = buildStripToNetMap(conn);

  const context = {
    breadboard,
    placedParts: safeParts,
    wires: safeWires,
    catalogMap,
    connectivity: conn,
    simConfig: simConfig || {},
    dcResult,
    stripToNet,
    activeSensorSpecs,
    elements: null
  };

  context.elements = extractSignalComponents(context);

  const checks = [];
  const offendingWireSet = new Set();
  let detectedHpfCutoffHz = null;

  for (const checkDef of ISOLATION_BARRIER_CHECKS) {
    const outcome = checkDef.evaluate(context);
    const checkResult = {
      id: checkDef.id,
      required: checkDef.required,
      category: checkDef.category,
      title: checkDef.title,
      ...outcome
    };
    checks.push(checkResult);

    if (Array.isArray(outcome.offendingWireIds)) {
      for (const wireId of outcome.offendingWireIds) {
        offendingWireSet.add(wireId);
      }
    }
    if (
      detectedHpfCutoffHz === null &&
      Number.isFinite(outcome.detectedHpfCutoffHz) &&
      outcome.detectedHpfCutoffHz > 0
    ) {
      detectedHpfCutoffHz = outcome.detectedHpfCutoffHz;
    }
  }

  const offendingWireIds = Array.from(offendingWireSet);
  const requiredChecks = checks.filter((c) => c.required);
  const totalRequired = requiredChecks.length;
  const passedRequired = requiredChecks.filter((c) => c.status === 'pass').length;

  const galvanicCheck = checks.find((c) => c.id === 'galvanic-host-isolation');
  const hpfCheck = checks.find((c) => c.id === 'secondary-highpass-blocking');
  const railCheck = checks.find((c) => c.id === 'patient-rail-fault');

  let level = 'hazard';
  if (railCheck?.status === 'fail' || offendingWireIds.length > 0 || galvanicCheck?.bridged) {
    level = 'hazard';
  } else if (passedRequired === totalRequired) {
    level = 'safe';
  } else if (galvanicCheck?.status === 'pass' || hpfCheck?.status === 'pass') {
    level = 'partial';
  } else {
    level = 'hazard';
  }

  let summary;
  if (level === 'hazard') {
    if (railCheck?.status === 'fail') {
      summary = 'Hazard: Patient Electrode Rail Fault';
    } else if (offendingWireIds.length > 0 || galvanicCheck?.bridged) {
      summary = 'Hazard: Isolation Barrier Bridged';
    } else {
      summary = 'Hazard: Unisolated Patient Circuit';
    }
  } else if (level === 'partial') {
    summary = 'Partial Protection (Single-Fault Risk)';
  } else {
    summary = 'IEC 60601 Dual-Layer Protection Active';
  }

  return {
    active: true,
    level,
    passedRequired,
    totalRequired,
    summary,
    checks,
    offendingWireIds,
    detectedHpfCutoffHz,
    hasUsbIsolator
  };
}
