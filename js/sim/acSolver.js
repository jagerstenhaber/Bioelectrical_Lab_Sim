import { analyzeCircuit } from '../connectivity.js';
import { clamp, solveComplexLinearSystem } from './linearAlgebra.js';
import { solveDcCircuit } from './dcSolver.js';
import {
  SOLVER_CONSTANTS,
  buildNodeIndexMap,
  buildStripToNetMap,
  collectActiveNets,
  computeNonFloatingNets,
  computeOpAmpAcGain,
  createDefaultSimConfig,
  createZeroMatrix,
  extractCircuitElements,
  getNetIdForHole,
  isElvisStripConnected,
  stampComplexAdmittance,
  stampComplexNortonSource
} from './circuitElements.js';

/**
 * Pure, zero-DOM Complex MNA Small-Signal AC Frequency-Sweep (Bode Analyzer) Solver.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

export const DEFAULT_BODE_CONFIG = Object.freeze({
  startFreqHz: 10,
  stopFreqHz: 100000,
  stepsPerDecade: 20,
  inputSource: 'AI0',
  outputSource: 'AI1',
  inputProbeHole: null,
  outputProbeHole: null,
  cursorFreqHz: null
});

const VALID_SOURCES = new Set(['AI0', 'AI1', 'FGEN', 'PROBE']);
const CUTOFF_DROP_DB = 20 * Math.log10(Math.SQRT2); // ~3.0103 dB

/**
 * Returns a fresh normalized and clamped Bode Analyzer configuration object.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createDefaultBodeConfig(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};

  const startFreqHz = Number.isFinite(safe.startFreqHz)
    ? clamp(safe.startFreqHz, 1, 1e5)
    : DEFAULT_BODE_CONFIG.startFreqHz;

  let stopFreqHz = Number.isFinite(safe.stopFreqHz)
    ? clamp(safe.stopFreqHz, 10, 1e6)
    : DEFAULT_BODE_CONFIG.stopFreqHz;
  if (stopFreqHz <= startFreqHz) {
    stopFreqHz = clamp(startFreqHz * 10, 10, 1e6);
  }

  const stepsPerDecade = Number.isFinite(safe.stepsPerDecade)
    ? Math.round(clamp(safe.stepsPerDecade, 5, 40))
    : DEFAULT_BODE_CONFIG.stepsPerDecade;

  const inputSource = VALID_SOURCES.has(safe.inputSource)
    ? safe.inputSource
    : DEFAULT_BODE_CONFIG.inputSource;

  const outputSource = VALID_SOURCES.has(safe.outputSource)
    ? safe.outputSource
    : DEFAULT_BODE_CONFIG.outputSource;

  const normalizeHole = (h) =>
    typeof h === 'string' && h.trim().length > 0 ? h.trim() : null;

  const cursorFreqHz =
    Number.isFinite(safe.cursorFreqHz) && safe.cursorFreqHz > 0 ? safe.cursorFreqHz : null;

  return {
    startFreqHz,
    stopFreqHz,
    stepsPerDecade,
    inputSource,
    outputSource,
    inputProbeHole: normalizeHole(safe.inputProbeHole),
    outputProbeHole: normalizeHole(safe.outputProbeHole),
    cursorFreqHz
  };
}

/**
 * Finds all -3.0103 dB cutoff crossing frequencies below passbandGainDb using
 * log-frequency linear interpolation.
 * @param {Array<number> | Float64Array} freqsHz
 * @param {Array<number> | Float64Array} magDb
 * @param {number} passbandGainDb
 * @returns {Array<{ freqHz: number, direction: 'falling' | 'rising' }>}
 */
export function findCutoffFrequencies(freqsHz, magDb, passbandGainDb) {
  if (
    !freqsHz ||
    !magDb ||
    freqsHz.length < 2 ||
    freqsHz.length !== magDb.length ||
    !Number.isFinite(passbandGainDb)
  ) {
    return [];
  }

  const targetDb = passbandGainDb - CUTOFF_DROP_DB;
  const cutoffs = [];

  for (let i = 1; i < freqsHz.length; i++) {
    const f0 = freqsHz[i - 1];
    const f1 = freqsHz[i];
    const m0 = magDb[i - 1];
    const m1 = magDb[i];

    if (
      !Number.isFinite(f0) ||
      !Number.isFinite(f1) ||
      f0 <= 0 ||
      f1 <= 0 ||
      !Number.isFinite(m0) ||
      !Number.isFinite(m1)
    ) {
      continue;
    }

    const d0 = m0 - targetDb;
    const d1 = m1 - targetDb;
    const isFalling = (d0 > 0 && d1 <= 0) || (i === 1 && d0 === 0 && d1 < 0);
    const isRising = (d0 < 0 && d1 >= 0) || (i === 1 && d0 === 0 && d1 > 0);

    if (!isFalling && !isRising) continue;

    const denom = m1 - m0;
    const t = denom !== 0 ? clamp((targetDb - m0) / denom, 0, 1) : 0.5;
    const logF0 = Math.log10(f0);
    const logF1 = Math.log10(f1);
    const freqHz = Math.pow(10, logF0 + t * (logF1 - logF0));

    cutoffs.push({
      freqHz,
      direction: isFalling ? 'falling' : 'rising'
    });
  }

  return cutoffs;
}

function makeInvalidResult(powered, reason, bode) {
  return {
    valid: false,
    powered,
    reason,
    freqsHz: [],
    magDb: [],
    phaseDeg: [],
    passbandGainDb: null,
    minGainDb: null,
    cutoffs: [],
    startFreqHz: bode.startFreqHz,
    stopFreqHz: bode.stopFreqHz
  };
}

/**
 * Runs a small-signal AC frequency sweep (Bode Analyzer) by linearizing nonlinear devices
 * around the DC operating point and solving complex MNA across log-spaced frequencies.
 *
 * @param {object} params
 * @param {import('../breadboard.js').BreadboardModel} params.breadboard
 * @param {object} [params.connectivity]
 * @param {Array<object>} [params.placedParts]
 * @param {Array<object>} [params.wires]
 * @param {Map<string, object>} params.catalogMap
 * @param {object} [params.simConfig]
 * @param {object} [params.bodeConfig]
 */
export function solveBodeSweep({
  breadboard,
  connectivity,
  placedParts = [],
  wires = [],
  catalogMap,
  simConfig = {},
  bodeConfig = {}
}) {
  const config = createDefaultSimConfig(simConfig);
  const bode = createDefaultBodeConfig(bodeConfig);

  if (!config.powered) {
    return makeInvalidResult(
      false,
      'Lab Power is OFF — turn Power ON to run a Bode frequency sweep.',
      bode
    );
  }

  const conn = connectivity || analyzeCircuit(breadboard, placedParts, wires, catalogMap);

  const bodeSimConfig = config.arb?.running
    ? { ...config, arb: { ...config.arb, running: false } }
    : config;

  // 3. Establish DC operating point (determines IC powered flags and diode conduction states)
  const dcOp = solveDcCircuit({
    breadboard,
    connectivity: conn,
    placedParts,
    wires,
    catalogMap,
    simConfig: bodeSimConfig
  });

  const elements = extractCircuitElements({
    breadboard,
    connectivity: conn,
    placedParts,
    catalogMap,
    config: bodeSimConfig,
    includeUnwiredElvisSources: true
  });
  const stripToNet = elements.stripToNet || buildStripToNetMap(conn);

  // Sync linearized operating-point states onto extracted elements
  for (const d of elements.diodes) {
    if (d.isPulseOxLed === 'red') {
      d.state = dcOp.pulseOxResult?.redLit ? 'on' : 'off';
    } else if (d.isPulseOxLed === 'ir') {
      d.state = dcOp.pulseOxResult?.irLit ? 'on' : 'off';
    } else {
      const res = dcOp.partResults?.get(d.inst.id);
      d.state = res?.conducting ? 'on' : 'off';
    }
  }
  for (const op of elements.opamps) {
    const res = dcOp.partResults?.get(op.inst.id);
    op.powered = Boolean(res?.powered);
    op.vVcc = res?.vVcc ?? null;
    op.vGnd = res?.vGnd ?? null;
  }
  for (const ia of elements.inamps) {
    const res = dcOp.partResults?.get(ia.inst.id);
    ia.powered = Boolean(res?.powered);
    ia.vVsP = res?.vVsP ?? null;
    ia.vVsN = res?.vVsN ?? null;
  }

  // 4. Resolve Bode stimulus net (ELV_33A if elvisMode & wired, or config.fgen.probeHole)
  const elvisFgenNet =
    breadboard.elvisMode && isElvisStripConnected(breadboard, conn, 'ELVIS_ROW_33')
      ? getNetIdForHole(breadboard, stripToNet, 'ELV_33A')
      : null;
  const probeFgenNet = config.fgen?.probeHole
    ? getNetIdForHole(breadboard, stripToNet, config.fgen.probeHole)
    : null;

  const stimulusNetIds = new Set();
  if (elvisFgenNet) stimulusNetIds.add(elvisFgenNet);
  if (probeFgenNet) stimulusNetIds.add(probeFgenNet);

  if (stimulusNetIds.size === 0) {
    return makeInvalidResult(
      true,
      'Connect ELVIS FGEN (Row 33) or place an FGEN Board Probe to inject the sweep signal.',
      bode
    );
  }

  elements.fgenNetIds = stimulusNetIds;
  const primaryStimulusNet = elvisFgenNet || probeFgenNet;

  // Determine AC non-floating nets (capacitors, conducting diodes, and powered ICs conduct AC)
  const nonFloatingAcNets = computeNonFloatingNets(elements, {
    includeCapacitors: true,
    includeConductingDiodes: true,
    includePoweredIcs: true,
    includeFgen: true,
    includeArb: false
  });

  // 5. Resolve Input and Output channels
  const resolveChannel = (sourceType, probeHole, roleLabel) => {
    if (sourceType === 'FGEN') {
      return { valid: true, posNet: primaryStimulusNet, negNet: null };
    }

    if (sourceType === 'AI0' || sourceType === 'AI1') {
      const label = sourceType === 'AI0' ? 'AI 0' : 'AI 1';
      const posStrip = sourceType === 'AI0' ? 'ELVIS_ROW_1' : 'ELVIS_ROW_3';
      const posHole = sourceType === 'AI0' ? 'ELV_1A' : 'ELV_3A';
      const negStrip = sourceType === 'AI0' ? 'ELVIS_ROW_2' : 'ELVIS_ROW_4';
      const negHole = sourceType === 'AI0' ? 'ELV_2A' : 'ELV_4A';

      if (!breadboard.elvisMode) {
        return { valid: false, reason: `ELVIS ${label} (${roleLabel}) requires NI ELVIS II mode.` };
      }
      if (!isElvisStripConnected(breadboard, conn, posStrip)) {
        return {
          valid: false,
          reason: `Nothing wired to ELVIS ${label}+ (${roleLabel}) — connect ${label}+ to your circuit.`
        };
      }
      const posNet = getNetIdForHole(breadboard, stripToNet, posHole);
      if (!posNet || !nonFloatingAcNets.has(posNet)) {
        return {
          valid: false,
          reason: `ELVIS ${label}+ (${roleLabel}) is on a floating net — check your wiring and ground reference.`
        };
      }

      if (isElvisStripConnected(breadboard, conn, negStrip)) {
        const negNet = getNetIdForHole(breadboard, stripToNet, negHole);
        if (!negNet || !nonFloatingAcNets.has(negNet)) {
          return {
            valid: false,
            reason: `ELVIS ${label}- (${roleLabel}) is connected to a floating net.`
          };
        }
        return { valid: true, posNet, negNet };
      }

      return { valid: true, posNet, negNet: null };
    }

    if (sourceType === 'PROBE') {
      if (!probeHole) {
        return { valid: false, reason: `No ${roleLabel} probe hole selected.` };
      }
      if (!breadboard.getHole(probeHole)) {
        return { valid: false, reason: `Unknown ${roleLabel} probe hole: ${probeHole}.` };
      }
      const posNet = getNetIdForHole(breadboard, stripToNet, probeHole);
      if (!posNet || !nonFloatingAcNets.has(posNet)) {
        return {
          valid: false,
          reason: `${roleLabel} probe (${probeHole}) is on a floating net.`
        };
      }
      return { valid: true, posNet, negNet: null };
    }

    return { valid: false, reason: `Unknown ${roleLabel} source: ${sourceType}` };
  };

  const inChan = resolveChannel(bode.inputSource, bode.inputProbeHole, 'Input');
  if (!inChan.valid) {
    return makeInvalidResult(true, inChan.reason, bode);
  }

  const outChan = resolveChannel(bode.outputSource, bode.outputProbeHole, 'Output');
  if (!outChan.valid) {
    return makeInvalidResult(true, outChan.reason, bode);
  }

  // 6. Generate logarithmically spaced sweep frequencies
  const decades = Math.log10(bode.stopFreqHz / bode.startFreqHz);
  const numPoints = Math.max(2, Math.round(decades * bode.stepsPerDecade) + 1);
  const freqsHz = new Array(numPoints);
  const logStart = Math.log10(bode.startFreqHz);
  const logStop = Math.log10(bode.stopFreqHz);
  for (let k = 0; k < numPoints; k++) {
    const frac = numPoints > 1 ? k / (numPoints - 1) : 0;
    freqsHz[k] = Math.pow(10, logStart + frac * (logStop - logStart));
  }

  // Collect and index pruned active nets
  const extraNets = [inChan.posNet, inChan.negNet, outChan.posNet, outChan.negNet].filter(Boolean);
  const activeNetSet = collectActiveNets(elements, extraNets);
  const allNetIds = Array.from(conn.nets.keys());
  const netIds = allNetIds.filter((id) => activeNetSet.has(id));
  const netIndex = buildNodeIndexMap(netIds);
  const n = netIds.length;

  // Pre-assemble frequency-independent real conductance matrix ArBase and RHS (brBase, biBase)
  const ArBase = createZeroMatrix(n);
  const Ai = createZeroMatrix(n);
  const brBase = new Float64Array(n);
  const biBase = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    ArBase[i][i] += SOLVER_CONSTANTS.G_MIN;
  }

  // Reference grounds and DC rails act as 0 + 0j V AC shorts via their internal resistances
  for (const netId of elements.groundNets) {
    stampComplexNortonSource(
      ArBase,
      Ai,
      brBase,
      biBase,
      netIndex.get(netId),
      0,
      0,
      SOLVER_CONSTANTS.R_GROUND_INT
    );
  }
  for (const src of elements.dcSources) {
    stampComplexNortonSource(
      ArBase,
      Ai,
      brBase,
      biBase,
      netIndex.get(src.netId),
      0,
      0,
      src.rInt
    );
  }
  for (const pullup of elements.arduinoPullups || []) {
    stampComplexNortonSource(
      ArBase,
      Ai,
      brBase,
      biBase,
      netIndex.get(pullup.netId),
      0,
      0,
      SOLVER_CONSTANTS.R_ARDUINO_PULLUP
    );
  }
  for (const pwm of elements.arduinoPwmSources || []) {
    stampComplexNortonSource(
      ArBase,
      Ai,
      brBase,
      biBase,
      netIndex.get(pwm.netId),
      0,
      0,
      SOLVER_CONSTANTS.R_ARDUINO_GPIO
    );
  }

  // Stimulus FGEN net stamped as 1.0 + 0j V with R_FGEN_OUT
  for (const netId of stimulusNetIds) {
    stampComplexNortonSource(
      ArBase,
      Ai,
      brBase,
      biBase,
      netIndex.get(netId),
      1.0,
      0.0,
      SOLVER_CONSTANTS.R_FGEN_OUT
    );
  }

  // Passive resistors, pots, switches, photoresistors, load-cell bridges
  for (const r of elements.passiveResistors) {
    stampComplexAdmittance(ArBase, Ai, netIndex.get(r.netA), netIndex.get(r.netB), 1 / r.ohms, 0);
  }

  // Dynamic resistors (LED-PPG photoresistors linearized around DC operating-point resistance)
  for (const dr of elements.dynamicResistors || []) {
    const rOhms = dcOp.partResults?.get(dr.instanceId)?.resistanceOhms || dr.ohms;
    stampComplexAdmittance(ArBase, Ai, netIndex.get(dr.netA), netIndex.get(dr.netB), 1 / rOhms, 0);
  }

  // 3-pad surface EMG electrode impedances (RED1/RED2 referenced to BLK)
  if (elements.emgSensor) {
    const { netRed1, netRed2, netBlk, rRed1Ohms, rRed2Ohms } = elements.emgSensor;
    stampComplexAdmittance(ArBase, Ai, netIndex.get(netRed1), netIndex.get(netBlk), 1 / rRed1Ohms, 0);
    stampComplexAdmittance(ArBase, Ai, netIndex.get(netRed2), netIndex.get(netBlk), 1 / rRed2Ohms, 0);
  }

  // Pulse-Ox photodiode shunt conductance
  if (elements.pulseOxSensor) {
    const { netPdA, netPdK, rShuntOhms } = elements.pulseOxSensor;
    stampComplexAdmittance(ArBase, Ai, netIndex.get(netPdA), netIndex.get(netPdK), 1 / rShuntOhms, 0);
  }

  // Linearized diodes / LEDs around DC operating point
  for (const d of elements.diodes) {
    const rDyn = d.state === 'on' ? d.rOn : d.rOff;
    stampComplexAdmittance(ArBase, Ai, netIndex.get(d.net1), netIndex.get(d.net2), 1 / rDyn, 0);
  }

  // Powered Dual Op-Amps (input impedance + frequency-dependent single-pole VCVS A_OL(j*omega))
  const gOutIc = 1 / SOLVER_CONSTANTS.R_IC_OUT;
  const gInIc = 1 / SOLVER_CONSTANTS.R_IC_INPUT;
  const activeOpAmpStages = [];
  for (const op of elements.opamps) {
    if (!op.powered) continue;
    for (const st of op.stages) {
      const idxP = netIndex.get(st.netInP);
      const idxN = netIndex.get(st.netInN);
      const idxO = netIndex.get(st.netOut);
      stampComplexAdmittance(ArBase, Ai, idxP, idxN, gInIc, 0);
      if (idxO != null && idxP != null && idxN != null) {
        ArBase[idxO][idxO] += gOutIc;
        activeOpAmpStages.push({ op, idxP, idxN, idxO });
      }
    }
  }

  // Powered AD620 In-Amps (input impedance + linear VCVS on complex phasor V = xr + j*xi)
  for (const ia of elements.inamps) {
    if (!ia.powered) continue;
    const idxP = netIndex.get(ia.netInP);
    const idxN = netIndex.get(ia.netInN);
    const idxO = netIndex.get(ia.netOut);
    const idxRef = netIndex.get(ia.netRef);
    const refConnected = Boolean(ia.netRef && nonFloatingAcNets.has(ia.netRef) && idxRef != null);

    stampComplexAdmittance(ArBase, Ai, idxP, idxN, gInIc, 0);
    if (idxO != null && idxP != null && idxN != null) {
      ArBase[idxO][idxO] += gOutIc;
      ArBase[idxO][idxP] -= gOutIc * ia.gain;
      ArBase[idxO][idxN] += gOutIc * ia.gain;
      if (refConnected) {
        ArBase[idxO][idxRef] -= gOutIc;
      }
    }
  }

  const activeCapacitors = elements.capacitors.filter(
    (c) => c.capacitance > 0 && c.net1 && c.net2 && c.net1 !== c.net2
  );

  const inPosIdx = netIndex.get(inChan.posNet);
  const inNegIdx = inChan.negNet ? netIndex.get(inChan.negNet) : null;
  const outPosIdx = netIndex.get(outChan.posNet);
  const outNegIdx = outChan.negNet ? netIndex.get(outChan.negNet) : null;

  const magDb = new Array(numPoints);
  const phaseDeg = new Array(numPoints);
  const Ar = activeOpAmpStages.length > 0 ? createZeroMatrix(n) : null;

  // 7. Frequency sweep
  for (let k = 0; k < numPoints; k++) {
    const f = freqsHz[k];
    const omega = 2 * Math.PI * f;

    for (let i = 0; i < n; i++) {
      Ai[i].fill(0);
    }

    let ArStep = ArBase;
    if (activeOpAmpStages.length > 0) {
      for (let i = 0; i < n; i++) {
        Ar[i].set(ArBase[i]);
      }
      ArStep = Ar;
      for (const st of activeOpAmpStages) {
        const { real: aReal, imag: aImag } = computeOpAmpAcGain(st.op, f);
        const gReal = gOutIc * aReal;
        const gImag = gOutIc * aImag;
        ArStep[st.idxO][st.idxP] -= gReal;
        ArStep[st.idxO][st.idxN] += gReal;
        Ai[st.idxO][st.idxP] -= gImag;
        Ai[st.idxO][st.idxN] += gImag;
      }
    }

    for (const c of activeCapacitors) {
      stampComplexAdmittance(
        ArStep,
        Ai,
        netIndex.get(c.net1),
        netIndex.get(c.net2),
        0,
        omega * c.capacitance
      );
    }

    const sol = solveComplexLinearSystem(ArStep, Ai, brBase, biBase);
    if (!sol) {
      return makeInvalidResult(
        true,
        'AC solver encountered a singular circuit matrix.',
        bode
      );
    }

    const inR = sol.real[inPosIdx] - (inNegIdx != null ? sol.real[inNegIdx] : 0);
    const inI = sol.imag[inPosIdx] - (inNegIdx != null ? sol.imag[inNegIdx] : 0);
    const outR = sol.real[outPosIdx] - (outNegIdx != null ? sol.real[outNegIdx] : 0);
    const outI = sol.imag[outPosIdx] - (outNegIdx != null ? sol.imag[outNegIdx] : 0);

    const denom = inR * inR + inI * inI;
    if (!Number.isFinite(denom) || denom < 1e-24) {
      return makeInvalidResult(
        true,
        'Input channel AC amplitude is zero — ensure the input channel receives the sweep stimulus.',
        bode
      );
    }

    const hr = (outR * inR + outI * inI) / denom;
    const hi = (outI * inR - outR * inI) / denom;
    const mag = Math.hypot(hr, hi);

    magDb[k] = 20 * Math.log10(Math.max(1e-6, mag));
    phaseDeg[k] = Math.atan2(hi, hr) * (180 / Math.PI);
  }

  // 8. Passband gain, min gain, and -3 dB cutoff frequencies
  let passbandGainDb = -Infinity;
  let minGainDb = Infinity;
  for (let k = 0; k < numPoints; k++) {
    const g = magDb[k];
    if (!Number.isFinite(g)) continue;
    if (g > passbandGainDb) passbandGainDb = g;
    if (g < minGainDb) minGainDb = g;
  }
  if (!Number.isFinite(passbandGainDb)) passbandGainDb = 0;
  if (!Number.isFinite(minGainDb)) minGainDb = 0;

  const cutoffs = findCutoffFrequencies(freqsHz, magDb, passbandGainDb);

  // 9. Return complete Bode sweep result
  return {
    valid: true,
    powered: true,
    reason: null,
    freqsHz,
    magDb,
    phaseDeg,
    passbandGainDb,
    minGainDb,
    cutoffs,
    startFreqHz: bode.startFreqHz,
    stopFreqHz: bode.stopFreqHz
  };
}
