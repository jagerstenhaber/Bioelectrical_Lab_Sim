import {
  DEFAULT_FGEN_CONFIG,
  clamp,
  createDefaultFgenConfig,
  getWaveformDcMean
} from './linearAlgebra.js';
import {
  DEFAULT_EMG_CONFIG,
  EMG_IMPEDANCE_OHMS,
  createDefaultEmgConfig
} from './emgModel.js';

/**
 * Shared, zero-DOM circuit element extraction, active-net pruning, reachability,
 * nonlinear IC/diode physics, and real/complex MNA stamping primitives.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

export const DIODE_PARAMS = Object.freeze({
  'diode-1n4007': Object.freeze({ vf: 0.68, rOn: 2, rOff: 1e8 }),
  'led-red': Object.freeze({ vf: 1.9, rOn: 10, rOff: 1e8 })
});

export const SOLVER_CONSTANTS = Object.freeze({
  R_SOURCE_INT: 0.05,
  R_GROUND_INT: 1e-4,
  R_ARDUINO_GPIO: 25,
  R_ARDUINO_PULLUP: 40000,
  R_FGEN_OUT: 50,
  G_MIN: 1e-11,
  R_CAP_DC: 1e9,
  R_SWITCH_CLOSED: 0.1,
  R_SWITCH_OPEN: 1e9,
  R_IC_INPUT: 1e7,
  R_IC_OUT: 20,
  OPAMP_A_OL: 1e5,
  AD620_GAIN_OHMS: 49400,
  DIODE_PARAMS
});

export const DEFAULT_SIM_CONFIG = Object.freeze({
  powered: true,
  vpsEnabled: true,
  elvisSupplyPos: 5.0,
  elvisSupplyNeg: -5.0,
  loadCellForceGrams: 0,
  arduinoPinStates: Object.freeze({}),
  fgen: DEFAULT_FGEN_CONFIG,
  emg: DEFAULT_EMG_CONFIG
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
    vpsEnabled: safeOverrides.vpsEnabled !== undefined ? Boolean(safeOverrides.vpsEnabled) : true,
    arduinoPinStates: { ...rawPinStates },
    fgen: createDefaultFgenConfig(safeOverrides.fgen),
    emg: createDefaultEmgConfig(safeOverrides.emg)
  };
}

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

/**
 * Merges placed-part instance properties with catalog defaults.
 * @param {object} inst
 * @returns {object}
 */
export function resolvePartProps(inst) {
  return {
    ...getDefaultPartProps(inst.partId),
    ...(inst.props && typeof inst.props === 'object' ? inst.props : {})
  };
}

/**
 * Allocates an n x n Float64Array matrix initialized to zero.
 * @param {number} n
 * @returns {Array<Float64Array>}
 */
export function createZeroMatrix(n) {
  const A = new Array(n);
  for (let i = 0; i < n; i++) {
    A[i] = new Float64Array(n);
  }
  return A;
}

/**
 * Builds a lookup map from breadboard stripId to connectivity netId.
 * @param {object} connectivity
 * @returns {Map<string, string>}
 */
export function buildStripToNetMap(connectivity) {
  const stripToNet = new Map();
  for (const [netId, net] of connectivity.nets.entries()) {
    for (const stripId of net.strips) {
      stripToNet.set(stripId, netId);
    }
  }
  return stripToNet;
}

/**
 * Resolves the connectivity netId for a given breadboard holeId.
 * @param {import('../breadboard.js').BreadboardModel} breadboard
 * @param {Map<string, string>} stripToNet
 * @param {string} holeId
 * @returns {string | null}
 */
export function getNetIdForHole(breadboard, stripToNet, holeId) {
  if (!holeId) return null;
  const hole = breadboard.getHole(holeId);
  if (!hole) return null;
  return stripToNet.get(hole.stripId) || null;
}

/**
 * Checks whether an NI ELVIS II strip has at least one external wire or component pin attached.
 * @param {import('../breadboard.js').BreadboardModel} breadboard
 * @param {object} connectivity
 * @param {string} stripId
 * @returns {boolean}
 */
export function isElvisStripConnected(breadboard, connectivity, stripId) {
  if (!breadboard.elvisMode) return false;
  const holes = breadboard.strips.get(stripId);
  if (!holes || holes.length === 0) return false;
  for (const h of holes) {
    const occs = connectivity.getOccupants(h.id);
    if (occs && occs.length > 0) return true;
  }
  return false;
}

function isSensorStripConnected(breadboard, connectivity, stripId) {
  const holes = breadboard.strips.get(stripId);
  if (!holes || holes.length === 0) return false;
  for (const h of holes) {
    const occs = connectivity.getOccupants(h.id);
    if (occs && occs.length > 0) return true;
  }
  return false;
}

/**
 * Computes strain-gauge bridge arm resistances { rMinus, rPlus } for R0 = 1000 Ω
 * and delta = clamp(loadCellForceGrams, -2000, 2000) / 1000 * 0.002.
 * @param {number} loadCellForceGrams
 * @returns {{ rMinus: number, rPlus: number }}
 */
export function computeLoadCellBridgeOhms(loadCellForceGrams) {
  const R0 = 1000;
  const force = Number.isFinite(loadCellForceGrams) ? clamp(loadCellForceGrams, -2000, 2000) : 0;
  const delta = (force / 1000) * 0.002;
  return {
    rMinus: R0 * (1 - delta),
    rPlus: R0 * (1 + delta)
  };
}

function getLoadCellResistors(breadboard, stripToNet, loadCellForceGrams) {
  if (!breadboard.loadCellsMode) return [];
  const { rMinus, rPlus } = computeLoadCellBridgeOhms(loadCellForceGrams);
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

/**
 * Computes AD620 gain-setting parallel resistance Rg and voltage gain G = 1 + 49.4kΩ / Rg.
 * @param {object} inamp
 * @param {Array<object>} passiveResistors
 * @param {Map<string, object>} partMeta
 * @param {object} connectivity
 * @returns {{ rgOhms: number, gain: number }}
 */
export function computeAd620Gain(inamp, passiveResistors, partMeta, connectivity) {
  if (!inamp.netRg1 || !inamp.netRg2 || inamp.netRg1 === inamp.netRg2) {
    return { rgOhms: Infinity, gain: 1 };
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
    const rgOhms = 1 / gParallel;
    return { rgOhms, gain: 1 + SOLVER_CONSTANTS.AD620_GAIN_OHMS / rgOhms };
  }
  return { rgOhms: Infinity, gain: 1 };
}

/**
 * Extracts grounds, DC sources, FGEN target nets, passive elements, capacitors, diodes/LEDs,
 * Dual Op-Amps, AD620 In-Amps, Load Cell bridge networks, and part metadata.
 * @param {object} params
 * @param {import('../breadboard.js').BreadboardModel} params.breadboard
 * @param {object} params.connectivity
 * @param {Array<object>} [params.placedParts]
 * @param {Map<string, object>} params.catalogMap
 * @param {object} [params.config]
 * @param {boolean} [params.includeUnwiredElvisSources=true]
 */
export function extractCircuitElements({
  breadboard,
  connectivity,
  placedParts = [],
  catalogMap,
  config = DEFAULT_SIM_CONFIG,
  includeUnwiredElvisSources = true
}) {
  const stripToNet = buildStripToNetMap(connectivity);
  const groundNets = new Set();
  const dcSources = []; // { netId, voltage, rInt, label }
  const arduinoPullups = []; // { netId, pinId, instanceId }
  const arduinoPwmSources = []; // { netId, duty, freqHz, pinId, instanceId }
  const fgenNetIds = new Set();
  const passiveResistors = []; // { netA, netB, ohms, instanceId?, conductive? }
  const capacitors = []; // { inst, partDef, capacitance, net1, net2, polarized, h1, h2, vPrev }
  const diodes = []; // { inst, partDef, net1, net2, vf, rOn, rOff, isLed, state, everConducted }
  const opamps = []; // { inst, partDef, netVcc, netGnd, stages, powered, vVcc, vGnd }
  const inamps = []; // { inst, partDef, netVsP, netVsN, netInP, netInN, netOut, netRef, netRg1, netRg2, powered, vVsP, vVsN, rgOhms, gain, state }
  const partMeta = new Map();

  // 1. NI ELVIS II strip sources and reference grounds
  if (breadboard.elvisMode && config.powered) {
    const vpsActive = config.vpsEnabled !== false;
    const supplyPos = vpsActive
      ? (Number.isFinite(config.elvisSupplyPos)
          ? config.elvisSupplyPos
          : DEFAULT_SIM_CONFIG.elvisSupplyPos)
      : 0.0;
    const supplyNeg = vpsActive
      ? (Number.isFinite(config.elvisSupplyNeg)
          ? config.elvisSupplyNeg
          : DEFAULT_SIM_CONFIG.elvisSupplyNeg)
      : 0.0;

    for (const [stripId, holes] of breadboard.strips.entries()) {
      const firstHole = holes[0];
      if (!firstHole || firstHole.type !== 'elvis') continue;
      if (!includeUnwiredElvisSources && !isElvisStripConnected(breadboard, connectivity, stripId)) {
        continue;
      }
      const netId = stripToNet.get(stripId);
      if (!netId) continue;

      switch (firstHole.elvisLabel) {
        case 'GROUND':
        case 'AIGND':
          groundNets.add(netId);
          break;
        case '+5V':
          dcSources.push({ netId, voltage: 5.0, rInt: SOLVER_CONSTANTS.R_SOURCE_INT, label: 'ELVIS +5V' });
          break;
        case '+15V':
          dcSources.push({ netId, voltage: 15.0, rInt: SOLVER_CONSTANTS.R_SOURCE_INT, label: 'ELVIS +15V' });
          break;
        case '-15V':
          dcSources.push({ netId, voltage: -15.0, rInt: SOLVER_CONSTANTS.R_SOURCE_INT, label: 'ELVIS -15V' });
          break;
        case 'SUPPLY +':
          dcSources.push({ netId, voltage: supplyPos, rInt: SOLVER_CONSTANTS.R_SOURCE_INT, label: 'ELVIS SUPPLY +' });
          break;
        case 'SUPPLY -':
          dcSources.push({ netId, voltage: supplyNeg, rInt: SOLVER_CONSTANTS.R_SOURCE_INT, label: 'ELVIS SUPPLY -' });
          break;
        default:
          break;
      }
    }
  }

  // 1b. Function Generator (FGEN) target nets
  const fgenDcMean = config.fgen?.enabled ? getWaveformDcMean(config.fgen) : 0;
  if (config.powered && config.fgen?.enabled) {
    if (breadboard.elvisMode) {
      const elvisFgenNet = stripToNet.get('ELVIS_ROW_33');
      if (elvisFgenNet) fgenNetIds.add(elvisFgenNet);
    }
    if (config.fgen.probeHole) {
      const probeFgenNet = getNetIdForHole(breadboard, stripToNet, config.fgen.probeHole);
      if (probeFgenNet) fgenNetIds.add(probeFgenNet);
    }
  }

  // 2. External load cell bridge resistors (Full-Bridge & Half-Bridge #1/#2)
  const loadCellResistors = getLoadCellResistors(breadboard, stripToNet, config.loadCellForceGrams);
  for (const r of loadCellResistors) {
    passiveResistors.push(r);
  }

  // 2b. External 3-pad surface EMG sensor (RED1 MID/+, RED2 END/-, BLK COM/REF)
  let emgSensor = null;
  if (breadboard.emgMode) {
    const emgConnected =
      isSensorStripConnected(breadboard, connectivity, 'SENSOR_EMG_RED1') ||
      isSensorStripConnected(breadboard, connectivity, 'SENSOR_EMG_RED2') ||
      isSensorStripConnected(breadboard, connectivity, 'SENSOR_EMG_BLK');

    if (emgConnected) {
      const netRed1 = stripToNet.get('SENSOR_EMG_RED1') || null;
      const netRed2 = stripToNet.get('SENSOR_EMG_RED2') || null;
      const netBlk = stripToNet.get('SENSOR_EMG_BLK') || null;
      if (netRed1 && netRed2 && netBlk) {
        const emgCfg = createDefaultEmgConfig(config.emg);
        emgSensor = {
          netRed1,
          netRed2,
          netBlk,
          rRed1Ohms: EMG_IMPEDANCE_OHMS.red1,
          rRed2Ohms: EMG_IMPEDANCE_OHMS.red2Base * (1 + emgCfg.electrodeMismatch),
          config: emgCfg
        };
      }
    }
  }

  // 3. Placed parts
  const pinStates =
    config.arduinoPinStates && typeof config.arduinoPinStates === 'object'
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
            dcSources.push({ netId, voltage: 5.0, rInt: SOLVER_CONSTANTS.R_SOURCE_INT, label: 'Nano 5V' });
          } else if (pin.id === '3V3') {
            dcSources.push({ netId, voltage: 3.3, rInt: SOLVER_CONSTANTS.R_SOURCE_INT, label: 'Nano 3V3' });
          } else {
            const state = instPinStates?.[pin.id] ?? pinStates[pin.id];
            if (!state || typeof state !== 'object') continue;
            if (state.mode === 'OUTPUT' && Number.isFinite(state.voltage)) {
              dcSources.push({
                netId,
                voltage: state.voltage,
                rInt: SOLVER_CONSTANTS.R_ARDUINO_GPIO,
                label: `Nano ${pin.id}`
              });
            } else if (state.mode === 'INPUT_PULLUP') {
              arduinoPullups.push({
                netId,
                pinId: pin.id,
                instanceId: inst.id
              });
            } else if (state.mode === 'PWM') {
              const rawDuty = Number.isFinite(state.dutyCycle) ? state.dutyCycle : 0;
              const duty = clamp(rawDuty, 0, 255) / 255;
              const freqHz = Number.isFinite(state.freqHz) && state.freqHz > 0 ? state.freqHz : 490;
              arduinoPwmSources.push({
                netId,
                duty,
                freqHz,
                pinId: pin.id,
                instanceId: inst.id
              });
            }
            // mode === 'INPUT': high-Z (no source or pull-up stamped)
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
      const ohms = pressed ? SOLVER_CONSTANTS.R_SWITCH_CLOSED : SOLVER_CONSTANTS.R_SWITCH_OPEN;

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
      capacitors.push({
        inst,
        partDef,
        capacitance: partDef.value,
        net1,
        net2,
        polarized: Boolean(partDef.polarized),
        h1,
        h2,
        vPrev: 0
      });
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

  for (const inamp of inamps) {
    const { rgOhms, gain } = computeAd620Gain(inamp, passiveResistors, partMeta, connectivity);
    inamp.rgOhms = rgOhms;
    inamp.gain = gain;
  }

  return {
    stripToNet,
    groundNets,
    dcSources,
    arduinoPullups,
    arduinoPwmSources,
    fgenNetIds,
    fgenDcMean,
    passiveResistors,
    emgSensor,
    capacitors,
    diodes,
    opamps,
    inamps,
    partMeta
  };
}

/**
 * Collects active net IDs referenced by grounds, sources, components, or extra probe nets
 * so untouched breadboard strips can be pruned before MNA assembly.
 * @param {object} elements
 * @param {Iterable<string>} [extraNetIds]
 * @returns {Set<string>}
 */
export function collectActiveNets(elements, extraNetIds = []) {
  const active = new Set();
  const add = (netId) => {
    if (netId) active.add(netId);
  };

  for (const netId of extraNetIds) add(netId);
  for (const netId of elements.groundNets) add(netId);
  for (const src of elements.dcSources) add(src.netId);
  for (const pullup of elements.arduinoPullups || []) add(pullup.netId);
  for (const pwm of elements.arduinoPwmSources || []) add(pwm.netId);
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
  if (elements.emgSensor) {
    add(elements.emgSensor.netRed1);
    add(elements.emgSensor.netRed2);
    add(elements.emgSensor.netBlk);
  }

  return active;
}

/**
 * Builds a dense Map<netId, matrixIndex> for the given iterable of active net IDs.
 * @param {Iterable<string>} activeNets
 * @returns {Map<string, number>}
 */
export function buildNodeIndexMap(activeNets) {
  const netIndex = new Map();
  let idx = 0;
  for (const netId of activeNets) {
    if (netId && !netIndex.has(netId)) {
      netIndex.set(netId, idx++);
    }
  }
  return netIndex;
}

/**
 * Stamps a real conductance g between node indices idx1 and idx2 into matrix A.
 * @param {Array<Float64Array | Array<number>>} A
 * @param {number | null | undefined} idx1
 * @param {number | null | undefined} idx2
 * @param {number} g
 */
export function stampConductance(A, idx1, idx2, g) {
  if (idx1 == null || idx2 == null || idx1 === idx2 || !Number.isFinite(g) || g <= 0) {
    return;
  }
  A[idx1][idx1] += g;
  A[idx2][idx2] += g;
  A[idx1][idx2] -= g;
  A[idx2][idx1] -= g;
}

/**
 * Stamps a Norton equivalent voltage source (voltage V with series resistance rInt)
 * connected from ground to node index idx.
 * @param {Array<Float64Array | Array<number>>} A
 * @param {Float64Array | Array<number>} b
 * @param {number | null | undefined} idx
 * @param {number} voltage
 * @param {number} rInt
 */
export function stampNortonSource(A, b, idx, voltage, rInt) {
  if (idx == null || !Number.isFinite(voltage) || !Number.isFinite(rInt) || rInt <= 0) {
    return;
  }
  const g = 1 / rInt;
  A[idx][idx] += g;
  b[idx] += voltage * g;
}

/**
 * Stamps an independent real current source injecting +current into idx1 and -current into idx2.
 * Pass null for either terminal when referencing ground.
 * @param {Float64Array | Array<number>} b
 * @param {number | null | undefined} idx1
 * @param {number | null | undefined} idx2
 * @param {number} current
 */
export function stampCurrentSource(b, idx1, idx2, current) {
  if (!Number.isFinite(current) || current === 0) return;
  if (idx1 != null && idx2 != null && idx1 === idx2) return;
  if (idx1 != null) b[idx1] += current;
  if (idx2 != null) b[idx2] -= current;
}

/**
 * Stamps a complex two-terminal admittance Y = g + j*bSusceptance between idx1 and idx2.
 * @param {Array<Float64Array | Array<number>>} Ar
 * @param {Array<Float64Array | Array<number>>} Ai
 * @param {number | null | undefined} idx1
 * @param {number | null | undefined} idx2
 * @param {number} g
 * @param {number} bSusceptance
 */
export function stampComplexAdmittance(Ar, Ai, idx1, idx2, g, bSusceptance) {
  if (
    idx1 == null ||
    idx2 == null ||
    idx1 === idx2 ||
    !Number.isFinite(g) ||
    !Number.isFinite(bSusceptance)
  ) {
    return;
  }
  if (g !== 0) {
    Ar[idx1][idx1] += g;
    Ar[idx2][idx2] += g;
    Ar[idx1][idx2] -= g;
    Ar[idx2][idx1] -= g;
  }
  if (bSusceptance !== 0) {
    Ai[idx1][idx1] += bSusceptance;
    Ai[idx2][idx2] += bSusceptance;
    Ai[idx1][idx2] -= bSusceptance;
    Ai[idx2][idx1] -= bSusceptance;
  }
}

/**
 * Stamps a complex Norton voltage source V = vr + j*vi with real internal resistance rInt
 * from ground to node index idx.
 * @param {Array<Float64Array | Array<number>>} Ar
 * @param {Array<Float64Array | Array<number>>} Ai
 * @param {Float64Array | Array<number>} br
 * @param {Float64Array | Array<number>} bi
 * @param {number | null | undefined} idx
 * @param {number} vr
 * @param {number} vi
 * @param {number} rInt
 */
export function stampComplexNortonSource(Ar, Ai, br, bi, idx, vr, vi, rInt) {
  if (
    idx == null ||
    !Number.isFinite(vr) ||
    !Number.isFinite(vi) ||
    !Number.isFinite(rInt) ||
    rInt <= 0
  ) {
    return;
  }
  const g = 1 / rInt;
  Ar[idx][idx] += g;
  br[idx] += vr * g;
  bi[idx] += vi * g;
}

export function addAdjacencyEdge(adj, netA, netB) {
  if (!netA || !netB || netA === netB) return;
  if (!adj.has(netA)) adj.set(netA, new Set());
  if (!adj.has(netB)) adj.set(netB, new Set());
  adj.get(netA).add(netB);
  adj.get(netB).add(netA);
}

export function runReachabilityBfs(seedNetIds, adjacency) {
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
 * Computes the set of nets reachable from ground or active sources through conductive paths.
 * @param {object} elements
 * @param {object} [options]
 * @returns {Set<string>}
 */
export function computeNonFloatingNets(
  elements,
  {
    includeCapacitors = false,
    includeConductingDiodes = false,
    includeEverConductedDiodes = false,
    includePoweredIcs = false,
    includeFgen = true
  } = {}
) {
  const seeds = new Set();
  for (const g of elements.groundNets) seeds.add(g);
  for (const s of elements.dcSources) seeds.add(s.netId);
  for (const pullup of elements.arduinoPullups || []) seeds.add(pullup.netId);
  for (const pwm of elements.arduinoPwmSources || []) seeds.add(pwm.netId);
  if (includeFgen) {
    for (const f of elements.fgenNetIds) seeds.add(f);
  }

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
  if (elements.emgSensor) {
    addAdjacencyEdge(adj, elements.emgSensor.netRed1, elements.emgSensor.netBlk);
    addAdjacencyEdge(adj, elements.emgSensor.netRed2, elements.emgSensor.netBlk);
  }

  if (includeCapacitors) {
    for (const c of elements.capacitors) {
      if (c.capacitance > 0) {
        addAdjacencyEdge(adj, c.net1, c.net2);
      }
    }
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
 * Updates powered/rail voltages on Dual Op-Amps and AD620 In-Amps from latest node voltages.
 * @returns {boolean} True if any IC's powered state changed
 */
export function updateIcPowerStates(elements, nonFloatingNets, x, netIndex) {
  let powerChanged = false;

  for (const op of elements.opamps) {
    const vccOk = Boolean(op.netVcc && nonFloatingNets.has(op.netVcc));
    const gndOk = Boolean(op.netGnd && nonFloatingNets.has(op.netGnd));
    const vVcc = vccOk ? x[netIndex.get(op.netVcc)] : null;
    const vGnd = gndOk ? x[netIndex.get(op.netGnd)] : null;
    const nextPowered = Boolean(vccOk && gndOk && vVcc - vGnd >= 2.0);
    if (nextPowered !== op.powered) powerChanged = true;
    op.powered = nextPowered;
    op.vVcc = vVcc;
    op.vGnd = vGnd;
  }

  for (const ia of elements.inamps) {
    const vsPOk = Boolean(ia.netVsP && nonFloatingNets.has(ia.netVsP));
    const vsNOk = Boolean(ia.netVsN && nonFloatingNets.has(ia.netVsN));
    const vVsP = vsPOk ? x[netIndex.get(ia.netVsP)] : null;
    const vVsN = vsNOk ? x[netIndex.get(ia.netVsN)] : null;
    const nextPowered = Boolean(vsPOk && vsNOk && vVsP - vVsN >= 4.0);
    if (nextPowered !== ia.powered) powerChanged = true;
    ia.powered = nextPowered;
    ia.vVsP = vVsP;
    ia.vVsN = vVsN;
  }

  return powerChanged;
}

/**
 * Evaluates piecewise-linear state transitions for diodes/LEDs, Dual Op-Amp rails, and AD620 rails.
 * @returns {boolean} True if any nonlinear device switched state
 */
export function updateNonlinearStates(elements, nonFloatingNets, x, netIndex) {
  let stateChanged = false;

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

      const vIdeal = SOLVER_CONSTANTS.OPAMP_A_OL * (x[idxP] - x[idxN]);
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

    const refNonFloating = Boolean(ia.netRef && nonFloatingNets.has(ia.netRef));
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

  return stateChanged;
}

/**
 * Stamps a piecewise-linear diode / LED companion model into (A, b).
 */
export function stampDiode(A, b, diode, netIndex) {
  const idx1 = netIndex.get(diode.net1);
  const idx2 = netIndex.get(diode.net2);
  if (idx1 == null || idx2 == null || idx1 === idx2) return;

  if (diode.state === 'on') {
    const gOn = 1 / diode.rOn;
    stampConductance(A, idx1, idx2, gOn);
    stampCurrentSource(b, idx1, idx2, gOn * diode.vf);
  } else {
    stampConductance(A, idx1, idx2, 1 / diode.rOff);
  }
}

/**
 * Stamps a Dual Op-Amp stage (optional input impedance + linear/clamped output) into (A, b).
 */
export function stampOpAmpStage(A, b, op, stage, netIndex, { stampInput = true } = {}) {
  const idxP = netIndex.get(stage.netInP);
  const idxN = netIndex.get(stage.netInN);
  const idxO = netIndex.get(stage.netOut);

  if (stampInput) {
    stampConductance(A, idxP, idxN, 1 / SOLVER_CONSTANTS.R_IC_INPUT);
  }

  if (idxO == null) return;
  const vMin = op.vGnd + 0.05;
  const vMax = op.vVcc >= op.vGnd + 0.55 ? op.vVcc - 0.5 : (op.vVcc + op.vGnd) / 2;
  const gOut = 1 / SOLVER_CONSTANTS.R_IC_OUT;

  if (stage.state === 'linear' && idxP != null && idxN != null) {
    A[idxO][idxO] += gOut;
    A[idxO][idxP] -= gOut * SOLVER_CONSTANTS.OPAMP_A_OL;
    A[idxO][idxN] += gOut * SOLVER_CONSTANTS.OPAMP_A_OL;
  } else if (stage.state === 'high') {
    stampNortonSource(A, b, idxO, vMax, SOLVER_CONSTANTS.R_IC_OUT);
  } else if (stage.state === 'low') {
    stampNortonSource(A, b, idxO, vMin, SOLVER_CONSTANTS.R_IC_OUT);
  } else {
    stampNortonSource(A, b, idxO, (vMin + vMax) / 2, SOLVER_CONSTANTS.R_IC_OUT);
  }
}

/**
 * Stamps an AD620 In-Amp (optional input impedance + linear/clamped output) into (A, b).
 */
export function stampInAmp(A, b, ia, netIndex, nonFloatingRefNets, { stampInput = true } = {}) {
  const idxP = netIndex.get(ia.netInP);
  const idxN = netIndex.get(ia.netInN);
  const idxO = netIndex.get(ia.netOut);

  if (stampInput) {
    stampConductance(A, idxP, idxN, 1 / SOLVER_CONSTANTS.R_IC_INPUT);
  }

  if (idxO == null) return;
  const vMin = ia.vVsN + 1.1;
  const vMax = ia.vVsP >= ia.vVsN + 2.2 ? ia.vVsP - 1.1 : (ia.vVsP + ia.vVsN) / 2;
  const gOut = 1 / SOLVER_CONSTANTS.R_IC_OUT;
  const idxRef = netIndex.get(ia.netRef);
  const refNonFloating = Boolean(ia.netRef && nonFloatingRefNets.has(ia.netRef));
  const vRefDefault = (ia.vVsP + ia.vVsN) / 2;

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
    stampNortonSource(A, b, idxO, vMax, SOLVER_CONSTANTS.R_IC_OUT);
  } else if (ia.state === 'low') {
    stampNortonSource(A, b, idxO, vMin, SOLVER_CONSTANTS.R_IC_OUT);
  } else {
    stampNortonSource(A, b, idxO, (vMin + vMax) / 2, SOLVER_CONSTANTS.R_IC_OUT);
  }
}
