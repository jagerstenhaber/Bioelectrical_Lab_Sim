import { analyzeCircuit } from '../connectivity.js';
import { clamp, solveLinearSystem } from './linearAlgebra.js';
import {
  DEFAULT_SIM_CONFIG,
  SOLVER_CONSTANTS,
  addAdjacencyEdge,
  buildNodeIndexMap,
  buildStripToNetMap,
  collectActiveNets,
  computeNonFloatingNets,
  createDefaultSimConfig,
  createZeroMatrix,
  extractCircuitElements,
  getDefaultPartProps,
  getNetIdForHole,
  getPhotoresistorOhms,
  runReachabilityBfs,
  stampConductance,
  stampDiode,
  stampInAmp,
  stampNortonSource,
  stampOpAmpStage,
  updateIcPowerStates,
  updateNonlinearStates
} from './circuitElements.js';

export {
  DEFAULT_SIM_CONFIG,
  createDefaultSimConfig,
  getDefaultPartProps,
  getPhotoresistorOhms,
  solveLinearSystem
};

/**
 * Pure, zero-DOM Modified Nodal Analysis (MNA) DC Circuit Solver.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

const MAX_ITERATIONS = 35;

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

  const elements = extractCircuitElements({
    breadboard,
    connectivity: conn,
    placedParts,
    catalogMap,
    config: { ...config, powered },
    includeUnwiredElvisSources: true
  });
  const { stripToNet } = elements;

  const allNetIds = Array.from(conn.nets.keys());
  const activeNetSet = collectActiveNets(elements);
  const netIds = allNetIds.filter((id) => activeNetSet.has(id));
  const netIndex = buildNodeIndexMap(netIds);
  const n = netIds.length;

  const diagnostics = [];

  const solveCurrentState = (nonFloatingRefNets) => {
    const A = createZeroMatrix(n);
    const b = new Float64Array(n);

    // G_min to 0V on every net prevents singular matrices on floating islands
    for (let i = 0; i < n; i++) {
      A[i][i] += SOLVER_CONSTANTS.G_MIN;
    }

    if (powered) {
      for (const netId of elements.groundNets) {
        stampNortonSource(A, b, netIndex.get(netId), 0, SOLVER_CONSTANTS.R_GROUND_INT);
      }
      for (const src of elements.dcSources) {
        stampNortonSource(A, b, netIndex.get(src.netId), src.voltage, src.rInt);
      }
      for (const pullup of elements.arduinoPullups) {
        stampNortonSource(A, b, netIndex.get(pullup.netId), 5.0, SOLVER_CONSTANTS.R_ARDUINO_PULLUP);
      }
      for (const pwm of elements.arduinoPwmSources) {
        stampNortonSource(A, b, netIndex.get(pwm.netId), 5.0 * pwm.duty, SOLVER_CONSTANTS.R_ARDUINO_GPIO);
      }
      for (const netId of elements.fgenNetIds) {
        stampNortonSource(A, b, netIndex.get(netId), elements.fgenDcMean, SOLVER_CONSTANTS.R_FGEN_OUT);
      }
    }

    for (const r of elements.passiveResistors) {
      stampConductance(A, netIndex.get(r.netA), netIndex.get(r.netB), 1 / r.ohms);
    }

    if (elements.emgSensor) {
      const { netRed1, netRed2, netBlk, rRed1Ohms, rRed2Ohms } = elements.emgSensor;
      stampConductance(A, netIndex.get(netRed1), netIndex.get(netBlk), 1 / rRed1Ohms);
      stampConductance(A, netIndex.get(netRed2), netIndex.get(netBlk), 1 / rRed2Ohms);
    }

    for (const c of elements.capacitors) {
      stampConductance(A, netIndex.get(c.net1), netIndex.get(c.net2), 1 / SOLVER_CONSTANTS.R_CAP_DC);
    }

    for (const d of elements.diodes) {
      stampDiode(A, b, d, netIndex);
    }

    for (const op of elements.opamps) {
      if (!op.powered) continue;
      for (const st of op.stages) {
        stampOpAmpStage(A, b, op, st, netIndex, { stampInput: true });
      }
    }

    for (const ia of elements.inamps) {
      if (!ia.powered) continue;
      stampInAmp(A, b, ia, netIndex, nonFloatingRefNets, { stampInput: true });
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
    let refReachable = computeNonFloatingNets(elements);
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

        // 1. Update Op-Amp & AD620 power-supply states from latest node voltages
        refReachable = computeNonFloatingNets(elements, {
          includeConductingDiodes: true,
          includePoweredIcs: true
        });
        let stateChanged = updateIcPowerStates(elements, refReachable, x, netIndex);

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
        }

        // 2. Check diode, Op-Amp, and AD620 piecewise-linear transitions
        stateChanged = updateNonlinearStates(elements, refReachable, x, netIndex);
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

  const elements = extractCircuitElements({
    breadboard,
    connectivity: conn,
    placedParts,
    catalogMap,
    config: { ...config, powered: false },
    includeUnwiredElvisSources: true
  });

  // Check passive ohmic reachability from netA to netB
  const adj = new Map();
  for (const r of elements.passiveResistors) {
    if (r.conductive === false || r.ohms >= 1e8) continue;
    addAdjacencyEdge(adj, r.netA, r.netB);
  }
  if (elements.emgSensor) {
    addAdjacencyEdge(adj, elements.emgSensor.netRed1, elements.emgSensor.netBlk);
    addAdjacencyEdge(adj, elements.emgSensor.netRed2, elements.emgSensor.netBlk);
  }
  const reachable = runReachabilityBfs([netA], adj);
  if (!reachable.has(netB)) {
    return { valid: true, ohms: Infinity, open: true, continuity: false };
  }

  const activeNetSet = collectActiveNets(elements, [netA, netB]);
  const netIds = Array.from(conn.nets.keys()).filter((id) => activeNetSet.has(id));
  const netIndex = buildNodeIndexMap(netIds);
  const n = netIds.length;

  const A = createZeroMatrix(n);
  const b = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    A[i][i] += SOLVER_CONSTANTS.G_MIN;
  }

  for (const r of elements.passiveResistors) {
    if (r.conductive === false || r.ohms >= 1e8) continue;
    stampConductance(A, netIndex.get(r.netA), netIndex.get(r.netB), 1 / r.ohms);
  }
  if (elements.emgSensor) {
    const { netRed1, netRed2, netBlk, rRed1Ohms, rRed2Ohms } = elements.emgSensor;
    stampConductance(A, netIndex.get(netRed1), netIndex.get(netBlk), 1 / rRed1Ohms);
    stampConductance(A, netIndex.get(netRed2), netIndex.get(netBlk), 1 / rRed2Ohms);
  }

  const idxA = netIndex.get(netA);
  const idxB = netIndex.get(netB);
  const testCurrentA = 1e-3; // 1 mA test current
  stampNortonSource(A, b, idxB, 0, 1e-9); // Reference netB at 0 V
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
