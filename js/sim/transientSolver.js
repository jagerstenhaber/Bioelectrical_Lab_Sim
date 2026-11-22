import { analyzeCircuit } from '../connectivity.js';
import {
  createDefaultFgenConfig,
  evaluateWaveform,
  solveLinearSystem
} from './linearAlgebra.js';
import { evaluateEmgSignals } from './emgModel.js';
import { evaluatePhotoresistorLight, evaluatePulseOxPhotocurrent } from './ppgModel.js';
import {
  createDefaultArbConfig,
  evaluateArbChannel,
  getArbChannelFreqHz,
  getArbChannelSamples,
  getArbEffectiveBandwidthHz
} from './arbModel.js';
import {
  SOLVER_CONSTANTS,
  buildNodeIndexMap,
  collectActiveNets,
  computeNonFloatingNets,
  createDefaultSimConfig,
  createZeroMatrix,
  extractCircuitElements,
  getNetIdForHole,
  getPhotoresistorOhms,
  isElvisStripConnected,
  stampConductance,
  stampCurrentSource,
  stampDiode,
  stampInAmp,
  stampNortonSource,
  stampOpAmpStage,
  updateIcPowerStates,
  updateNonlinearStates
} from './circuitElements.js';
import { solveDcCircuit } from './dcSolver.js';

/**
 * Pure, zero-DOM Backward-Euler Companion-Model Transient MNA Circuit Solver.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

const MAX_STEP_ITERATIONS = 12;

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
  const arb = createDefaultArbConfig(config.arb);
  config.fgen = fgen;
  config.arb = arb;

  const powered = config.powered !== false;
  const requestedCount = Math.max(2, Math.floor(Number.isFinite(numSamples) ? numSamples : 400));
  let count = requestedCount;
  const hasActiveEkgArb =
    arb.running &&
    ['ao0', 'ao1'].some((chKey) => {
      const ch = arb[chKey];
      return (
        ch?.enabled &&
        typeof ch.waveformId === 'string' &&
        ch.waveformId.startsWith('ekg-') &&
        getArbChannelSamples(ch).count > 0
      );
    });
  if (hasActiveEkgArb && count >= 500 && count < 900) {
    count = 900;
  }

  const ao0Freq = getArbChannelFreqHz(arb, 'ao0');
  const ao1Freq = getArbChannelFreqHz(arb, 'ao1');
  const defaultDuration =
    fgen.enabled && fgen.frequencyHz > 0
      ? 2 / fgen.frequencyHz
      : ao0Freq || ao1Freq
      ? 2 / (ao0Freq || ao1Freq)
      : fgen.frequencyHz > 0
      ? 2 / fgen.frequencyHz
      : 0.02;
  const duration =
    Number.isFinite(totalDurationSec) && totalDurationSec > 0 ? totalDurationSec : defaultDuration;

  const arbBw = getArbEffectiveBandwidthHz(arb);
  if (arbBw > 0) {
    const maxCap = requestedCount >= 450 ? 2400 : 1200;
    const minSamplesForBw = Math.min(maxCap, Math.ceil(duration * arbBw * 4));
    if (minSamplesForBw > count) {
      count = minSamplesForBw;
    }
  }
  const dt = duration / (count - 1);

  const conn = connectivity || analyzeCircuit(breadboard, placedParts, wires, catalogMap);
  const elements = extractCircuitElements({
    breadboard,
    connectivity: conn,
    placedParts,
    catalogMap,
    config: { ...config, powered },
    includeUnwiredElvisSources: true
  });
  const { stripToNet } = elements;
  const activeCapacitors = elements.capacitors.filter(
    (c) => c.capacitance > 0 && c.net1 && c.net2 && c.net1 !== c.net2
  );

  // Collect extra probe / ELVIS instrument nets so active pruning keeps them in the MNA system
  const extraNetIds = [];
  if (breadboard.elvisMode) {
    for (const stripId of [
      'ELVIS_ROW_1',
      'ELVIS_ROW_2',
      'ELVIS_ROW_3',
      'ELVIS_ROW_4',
      'ELVIS_ROW_31',
      'ELVIS_ROW_32',
      'ELVIS_ROW_33'
    ]) {
      const netId = stripToNet.get(stripId);
      if (netId) extraNetIds.push(netId);
    }
  }
  if (fgen.probeHole) {
    const fgenNet = getNetIdForHole(breadboard, stripToNet, fgen.probeHole);
    if (fgenNet) extraNetIds.push(fgenNet);
  }
  if (!breadboard.elvisMode && arb.ao0.probeHole) {
    const ao0Net = getNetIdForHole(breadboard, stripToNet, arb.ao0.probeHole);
    if (ao0Net) extraNetIds.push(ao0Net);
  }
  if (!breadboard.elvisMode && arb.ao1.probeHole) {
    const ao1Net = getNetIdForHole(breadboard, stripToNet, arb.ao1.probeHole);
    if (ao1Net) extraNetIds.push(ao1Net);
  }
  if (Array.isArray(probeHoles)) {
    for (const holeId of probeHoles) {
      const pNet = getNetIdForHole(breadboard, stripToNet, holeId);
      if (pNet) extraNetIds.push(pNet);
    }
  }

  const allNetIds = Array.from(conn.nets.keys());
  const activeNetSet = collectActiveNets(elements, extraNetIds);
  const netIds = allNetIds.filter((id) => activeNetSet.has(id));
  const netIndex = buildNodeIndexMap(netIds);
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
        fgen
      }
    });

    for (const c of activeCapacitors) {
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
    const initReachable = computeNonFloatingNets(elements, {
      includeCapacitors: true,
      includeConductingDiodes: true,
      includePoweredIcs: true
    });
    updateIcPowerStates(elements, initReachable, xPrev, netIndex);

    let maxLedBrightness = 0;
    if (dcInit.partResults) {
      for (const res of dcInit.partResults.values()) {
        if (res?.partId === 'led-red' && Number.isFinite(res.ledBrightness)) {
          if (res.ledBrightness > maxLedBrightness) maxLedBrightness = res.ledBrightness;
        }
      }
    }
    const { redCurrentMa, irCurrentMa } = dcInit.pulseOxResult || { redCurrentMa: 0, irCurrentMa: 0 };

    const hasNonlinear =
      elements.diodes.length > 0 || elements.opamps.length > 0 || elements.inamps.length > 0;

    // Pre-allocate reusable MNA matrix & RHS vector
    const ABase = createZeroMatrix(n);
    const bBase = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      ABase[i][i] += SOLVER_CONSTANTS.G_MIN;
    }
    for (const netId of elements.groundNets) {
      stampNortonSource(ABase, bBase, netIndex.get(netId), 0, SOLVER_CONSTANTS.R_GROUND_INT);
    }
    for (const src of elements.dcSources) {
      stampNortonSource(ABase, bBase, netIndex.get(src.netId), src.voltage, src.rInt);
    }
    for (const pullup of elements.arduinoPullups) {
      stampNortonSource(ABase, bBase, netIndex.get(pullup.netId), 5.0, SOLVER_CONSTANTS.R_ARDUINO_PULLUP);
    }
    for (const pwm of elements.arduinoPwmSources) {
      const idx = netIndex.get(pwm.netId);
      if (idx != null) {
        ABase[idx][idx] += 1 / SOLVER_CONSTANTS.R_ARDUINO_GPIO;
      }
    }
    for (const r of elements.passiveResistors) {
      stampConductance(ABase, netIndex.get(r.netA), netIndex.get(r.netB), 1 / r.ohms);
    }
    if (elements.emgSensor) {
      const { netRed1, netRed2, netBlk, rRed1Ohms, rRed2Ohms } = elements.emgSensor;
      stampConductance(ABase, netIndex.get(netRed1), netIndex.get(netBlk), 1 / rRed1Ohms);
      stampConductance(ABase, netIndex.get(netRed2), netIndex.get(netBlk), 1 / rRed2Ohms);
    }
    if (elements.pulseOxSensor) {
      const { netPdA, netPdK, rShuntOhms } = elements.pulseOxSensor;
      stampConductance(ABase, netIndex.get(netPdA), netIndex.get(netPdK), 1 / rShuntOhms);
    }
    for (const netId of elements.fgenNetIds) {
      const idx = netIndex.get(netId);
      if (idx != null) {
        ABase[idx][idx] += 1 / SOLVER_CONSTANTS.R_FGEN_OUT;
      }
    }
    for (const arbSrc of elements.arbSources || []) {
      if (!arbSrc.enabled) continue;
      for (const netId of arbSrc.netIds) {
        const idx = netIndex.get(netId);
        if (idx != null) {
          ABase[idx][idx] += 1 / SOLVER_CONSTANTS.R_ARB_OUT;
        }
      }
    }
    for (const op of elements.opamps) {
      for (const st of op.stages) {
        stampConductance(
          ABase,
          netIndex.get(st.netInP),
          netIndex.get(st.netInN),
          1 / SOLVER_CONSTANTS.R_IC_INPUT
        );
      }
    }
    for (const ia of elements.inamps) {
      stampConductance(
        ABase,
        netIndex.get(ia.netInP),
        netIndex.get(ia.netInN),
        1 / SOLVER_CONSTANTS.R_IC_INPUT
      );
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
        const gFgen = 1 / SOLVER_CONSTANTS.R_FGEN_OUT;
        for (const netId of elements.fgenNetIds) {
          stampCurrentSource(b, netIndex.get(netId), null, vFgen * gFgen);
        }
      }

      if (arb.running && (elements.arbSources?.length || 0) > 0) {
        const gArb = 1 / SOLVER_CONSTANTS.R_ARB_OUT;
        for (const arbSrc of elements.arbSources) {
          if (!arbSrc.enabled) continue;
          const vArb = evaluateArbChannel(arb, arbSrc.channel, tSec);
          for (const netId of arbSrc.netIds) {
            stampCurrentSource(b, netIndex.get(netId), null, vArb * gArb);
          }
        }
      }

      if (elements.arduinoPwmSources.length > 0) {
        const gGpio = 1 / SOLVER_CONSTANTS.R_ARDUINO_GPIO;
        for (const pwm of elements.arduinoPwmSources) {
          let vPwm;
          if (pwm.duty <= 0) {
            vPwm = 0.0;
          } else if (pwm.duty >= 1) {
            vPwm = 5.0;
          } else {
            const phase = (((tSec * pwm.freqHz) % 1) + 1) % 1;
            vPwm = phase < pwm.duty ? 5.0 : 0.0;
          }
          stampCurrentSource(b, netIndex.get(pwm.netId), null, vPwm * gGpio);
        }
      }

      if (elements.emgSensor) {
        const { netRed1, netRed2, netBlk, rRed1Ohms, rRed2Ohms, config: emgCfg } = elements.emgSensor;
        const { vRed1, vRed2 } = evaluateEmgSignals(emgCfg, tSec);
        const idxRed1 = netIndex.get(netRed1);
        const idxRed2 = netIndex.get(netRed2);
        const idxBlk = netIndex.get(netBlk);
        stampCurrentSource(b, idxRed1, idxBlk, vRed1 / rRed1Ohms);
        stampCurrentSource(b, idxRed2, idxBlk, vRed2 / rRed2Ohms);
      }

      for (const dr of elements.dynamicResistors || []) {
        const ev = evaluatePhotoresistorLight(dr.props, maxLedBrightness, tSec);
        const ohms = getPhotoresistorOhms(ev.effectiveLight);
        stampConductance(A, netIndex.get(dr.netA), netIndex.get(dr.netB), 1 / ohms);
      }

      if (elements.pulseOxSensor) {
        const { netPdA, netPdK, config: poxCfg } = elements.pulseOxSensor;
        const poxEv = evaluatePulseOxPhotocurrent(poxCfg, redCurrentMa, irCurrentMa, tSec);
        stampCurrentSource(b, netIndex.get(netPdA), netIndex.get(netPdK), poxEv.iPhAmps);
      }

      for (const c of activeCapacitors) {
        const idx1 = netIndex.get(c.net1);
        const idx2 = netIndex.get(c.net2);
        if (idx1 == null || idx2 == null || idx1 === idx2) continue;
        const gEq = c.capacitance / stepDt;
        const iEq = gEq * c.vPrev;
        stampConductance(A, idx1, idx2, gEq);
        stampCurrentSource(b, idx1, idx2, iEq);
      }

      for (const d of elements.diodes) {
        stampDiode(A, b, d, netIndex);
      }

      for (const op of elements.opamps) {
        if (!op.powered) continue;
        for (const st of op.stages) {
          stampOpAmpStage(A, b, op, st, netIndex, { stampInput: false });
        }
      }

      for (const ia of elements.inamps) {
        if (!ia.powered) continue;
        stampInAmp(A, b, ia, netIndex, nonFloatingRefNets, { stampInput: false });
      }

      return solveLinearSystem(A, b);
    };

    const stepSolver = (tSec, stepDt) => {
      let refReachable = computeNonFloatingNets(elements, {
        includeCapacitors: true,
        includeConductingDiodes: true,
        includePoweredIcs: true
      });
      let x = solveAtTime(tSec, stepDt, refReachable);
      if (!x) return xPrev;

      if (hasNonlinear) {
        for (let iter = 0; iter < MAX_STEP_ITERATIONS; iter++) {
          refReachable = computeNonFloatingNets(elements, {
            includeCapacitors: true,
            includeConductingDiodes: true,
            includePoweredIcs: true
          });

          if (updateIcPowerStates(elements, refReachable, x, netIndex)) {
            refReachable = computeNonFloatingNets(elements, {
              includeCapacitors: true,
              includeConductingDiodes: true,
              includePoweredIcs: true
            });
            const nextX = solveAtTime(tSec, stepDt, refReachable);
            if (!nextX) break;
            x = nextX;
            continue;
          }

          if (!updateNonlinearStates(elements, refReachable, x, netIndex)) {
            break;
          }

          refReachable = computeNonFloatingNets(elements, {
            includeCapacitors: true,
            includeConductingDiodes: true,
            includePoweredIcs: true
          });
          const nextX = solveAtTime(tSec, stepDt, refReachable);
          if (!nextX) break;
          x = nextX;
        }
      }

      for (const c of activeCapacitors) {
        const idx1 = netIndex.get(c.net1);
        const idx2 = netIndex.get(c.net2);
        if (idx1 != null && idx2 != null) {
          c.vPrev = x[idx1] - x[idx2];
        }
      }

      xPrev = x;
      return x;
    };

    let maxPwmFreqHz = 0;
    let minPwmFreqHz = Infinity;
    for (const pwm of elements.arduinoPwmSources) {
      if (pwm.duty > 0 && pwm.duty < 1 && pwm.freqHz > 0) {
        if (pwm.freqHz > maxPwmFreqHz) maxPwmFreqHz = pwm.freqHz;
        if (pwm.freqHz < minPwmFreqHz) minPwmFreqHz = pwm.freqHz;
      }
    }

    const maxStimFreqHz = Math.max(
      fgen.enabled && fgen.frequencyHz > 0 ? fgen.frequencyHz : 0,
      getArbEffectiveBandwidthHz(arb),
      elements.emgSensor ? 250 : 0,
      maxPwmFreqHz
    );
    const subSteps =
      maxStimFreqHz > 0
        ? Math.min(8, Math.max(1, Math.ceil(dt * maxStimFreqHz * 32)))
        : 1;
    const subDt = dt / subSteps;

    // 2. Warm-up cycles ending at t = -dt so step = 0 is a single clean step to t = 0
    const hasFgenWarmup = fgen.enabled && fgen.frequencyHz > 0;
    const hasArbWarmup = Boolean((elements.arbSources?.length || 0) > 0 && (ao0Freq || ao1Freq));
    const hasEmgWarmup = Boolean(elements.emgSensor && elements.capacitors.length > 0);
    const hasPwmWarmup = maxPwmFreqHz > 0;
    if (
      activeCapacitors.length > 0 &&
      warmupCycles > 0 &&
      (hasFgenWarmup || hasArbWarmup || hasEmgWarmup || hasPwmWarmup)
    ) {
      const periodSec = Math.max(
        hasFgenWarmup ? 1 / fgen.frequencyHz : 0,
        ao0Freq ? 1 / ao0Freq : 0,
        ao1Freq ? 1 / ao1Freq : 0,
        hasEmgWarmup ? 1 / 60 : 0,
        hasPwmWarmup ? 1 / minPwmFreqHz : 0
      );
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
    const nonFloatingNets = computeNonFloatingNets(elements, {
      includeCapacitors: true,
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
      case 'AO0':
      case 'AO1': {
        const isAo0 = sourceSpec.type === 'AO0';
        const ch = isAo0 ? arb.ao0 : arb.ao1;
        const label = isAo0 ? 'AO 0' : 'AO 1';
        const elvisHole = isAo0 ? 'ELV_31A' : 'ELV_32A';
        if (!powered) {
          return { valid: false, samples: null, reason: 'Circuit power supply is off' };
        }
        if (!arb.running) {
          return { valid: false, samples: null, reason: 'ARB output is stopped' };
        }
        if (!ch?.enabled || getArbChannelSamples(ch).count === 0) {
          return { valid: false, samples: null, reason: `${label} output is disabled or empty` };
        }
        if (breadboard.elvisMode) {
          return getHoleTrace(elvisHole);
        }
        if (!breadboard.elvisMode && ch.probeHole) {
          return getHoleTrace(ch.probeHole);
        }
        return { valid: false, samples: null, reason: `No ${label} output node available` };
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
