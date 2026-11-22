/**
 * Pure, zero-DOM linear algebra and waveform/trigger primitives.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

export const DEFAULT_FGEN_CONFIG = Object.freeze({
  enabled: false,
  waveform: 'sine',
  frequencyHz: 100,
  amplitudeVpp: 2.0,
  dcOffsetV: 0.0,
  dutyCycle: 50,
  probeHole: null
});

const VALID_WAVEFORMS = new Set(['sine', 'triangle', 'square']);

/**
 * Clamps a finite numeric value to [min, max], returning min if non-finite.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Returns a fresh normalized FGEN configuration object.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createDefaultFgenConfig(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};
  const waveform = VALID_WAVEFORMS.has(safe.waveform)
    ? safe.waveform
    : DEFAULT_FGEN_CONFIG.waveform;
  const frequencyHz = Number.isFinite(safe.frequencyHz)
    ? clamp(safe.frequencyHz, 0.5, 50000)
    : DEFAULT_FGEN_CONFIG.frequencyHz;
  const amplitudeVpp = Number.isFinite(safe.amplitudeVpp)
    ? clamp(safe.amplitudeVpp, 0, 10)
    : DEFAULT_FGEN_CONFIG.amplitudeVpp;
  const dcOffsetV = Number.isFinite(safe.dcOffsetV)
    ? clamp(safe.dcOffsetV, -5, 5)
    : DEFAULT_FGEN_CONFIG.dcOffsetV;
  const dutyCycle = Number.isFinite(safe.dutyCycle)
    ? clamp(safe.dutyCycle, 10, 90)
    : DEFAULT_FGEN_CONFIG.dutyCycle;
  const probeHole =
    typeof safe.probeHole === 'string' && safe.probeHole.trim().length > 0
      ? safe.probeHole.trim()
      : null;

  return {
    enabled: safe.enabled !== undefined ? Boolean(safe.enabled) : DEFAULT_FGEN_CONFIG.enabled,
    waveform,
    frequencyHz,
    amplitudeVpp,
    dcOffsetV,
    dutyCycle,
    probeHole
  };
}

/**
 * Solves linear system A * x = b using Gaussian elimination with partial pivoting.
 * Does not mutate the caller's A or b inputs.
 * @param {Array<Array<number> | Float64Array>} A
 * @param {Array<number> | Float64Array} b
 * @returns {Array<number> | null} Solution vector x, or null if singular
 */
export function solveLinearSystem(A, b) {
  const n = b.length;
  if (n === 0) return [];

  const M = new Array(n);
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    M[i] = Float64Array.from(A[i]);
    rhs[i] = b[i];
  }

  for (let k = 0; k < n; k++) {
    let pivotRow = k;
    let maxVal = Math.abs(M[k][k]);
    for (let i = k + 1; i < n; i++) {
      const val = Math.abs(M[i][k]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = i;
      }
    }

    if (maxVal < 1e-18 || !Number.isFinite(maxVal)) {
      return null;
    }

    if (pivotRow !== k) {
      const tmpRow = M[k];
      M[k] = M[pivotRow];
      M[pivotRow] = tmpRow;
      const tmpRhs = rhs[k];
      rhs[k] = rhs[pivotRow];
      rhs[pivotRow] = tmpRhs;
    }

    const pivot = M[k][k];
    const rowK = M[k];
    for (let i = k + 1; i < n; i++) {
      const rowI = M[i];
      const factor = rowI[k] / pivot;
      if (factor === 0) continue;
      rowI[k] = 0;
      for (let j = k + 1; j < n; j++) {
        rowI[j] -= factor * rowK[j];
      }
      rhs[i] -= factor * rhs[k];
    }
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = rhs[i];
    const rowI = M[i];
    for (let j = i + 1; j < n; j++) {
      sum -= rowI[j] * x[j];
    }
    x[i] = sum / rowI[i];
  }

  return Array.from(x);
}

/**
 * Solves complex linear system (Ar + j*Ai) * (xr + j*xi) = (br + j*bi) using
 * Gaussian elimination with partial pivoting by complex magnitude |z| = Math.hypot(r, i).
 * Does not mutate the caller's input matrices or vectors.
 * @param {Array<Array<number> | Float64Array>} Ar
 * @param {Array<Array<number> | Float64Array>} Ai
 * @param {Array<number> | Float64Array} br
 * @param {Array<number> | Float64Array} bi
 * @returns {{ real: Array<number>, imag: Array<number> } | null}
 */
export function solveComplexLinearSystem(Ar, Ai, br, bi) {
  const n = br?.length || 0;
  if (n === 0) return { real: [], imag: [] };

  const Mr = new Array(n);
  const Mi = new Array(n);
  const rhsR = new Float64Array(n);
  const rhsI = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    Mr[i] = Float64Array.from(Ar[i]);
    Mi[i] = Ai && Ai[i] ? Float64Array.from(Ai[i]) : new Float64Array(n);
    rhsR[i] = br[i];
    rhsI[i] = bi ? bi[i] : 0;
  }

  for (let k = 0; k < n; k++) {
    let pivotRow = k;
    let maxMag = Math.hypot(Mr[k][k], Mi[k][k]);
    for (let i = k + 1; i < n; i++) {
      const mag = Math.hypot(Mr[i][k], Mi[i][k]);
      if (mag > maxMag) {
        maxMag = mag;
        pivotRow = i;
      }
    }

    if (maxMag < 1e-18 || !Number.isFinite(maxMag)) {
      return null;
    }

    if (pivotRow !== k) {
      const tmpR = Mr[k];
      Mr[k] = Mr[pivotRow];
      Mr[pivotRow] = tmpR;
      const tmpI = Mi[k];
      Mi[k] = Mi[pivotRow];
      Mi[pivotRow] = tmpI;
      const tmpRhsR = rhsR[k];
      rhsR[k] = rhsR[pivotRow];
      rhsR[pivotRow] = tmpRhsR;
      const tmpRhsI = rhsI[k];
      rhsI[k] = rhsI[pivotRow];
      rhsI[pivotRow] = tmpRhsI;
    }

    const pr = Mr[k][k];
    const pi = Mi[k][k];
    const denom = pr * pr + pi * pi;
    if (denom === 0 || !Number.isFinite(denom)) {
      return null;
    }

    const rowKr = Mr[k];
    const rowKi = Mi[k];
    for (let i = k + 1; i < n; i++) {
      const rowIr = Mr[i];
      const rowIi = Mi[i];
      const ir = rowIr[k];
      const ii = rowIi[k];
      if (ir === 0 && ii === 0) continue;

      const fr = (ir * pr + ii * pi) / denom;
      const fi = (ii * pr - ir * pi) / denom;
      rowIr[k] = 0;
      rowIi[k] = 0;

      for (let j = k + 1; j < n; j++) {
        const kr = rowKr[j];
        const ki = rowKi[j];
        rowIr[j] -= fr * kr - fi * ki;
        rowIi[j] -= fr * ki + fi * kr;
      }

      const rkR = rhsR[k];
      const rkI = rhsI[k];
      rhsR[i] -= fr * rkR - fi * rkI;
      rhsI[i] -= fr * rkI + fi * rkR;
    }
  }

  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sumR = rhsR[i];
    let sumI = rhsI[i];
    const rowIr = Mr[i];
    const rowIi = Mi[i];
    for (let j = i + 1; j < n; j++) {
      const ar = rowIr[j];
      const ai = rowIi[j];
      sumR -= ar * xr[j] - ai * xi[j];
      sumI -= ar * xi[j] + ai * xr[j];
    }

    const pr = rowIr[i];
    const pi = rowIi[i];
    const denom = pr * pr + pi * pi;
    if (denom === 0 || !Number.isFinite(denom)) {
      return null;
    }

    xr[i] = (sumR * pr + sumI * pi) / denom;
    xi[i] = (sumI * pr - sumR * pi) / denom;
    if (!Number.isFinite(xr[i]) || !Number.isFinite(xi[i])) {
      return null;
    }
  }

  return { real: Array.from(xr), imag: Array.from(xi) };
}

/**
 * Computes the analytical DC mean voltage of an FGEN waveform configuration.
 * Accounts for asymmetric square-wave duty cycles.
 * @param {object} fgen
 * @returns {number}
 */
export function getWaveformDcMean(fgen) {
  const cfg = fgen || DEFAULT_FGEN_CONFIG;
  const dcOffsetV = Number.isFinite(cfg.dcOffsetV) ? cfg.dcOffsetV : DEFAULT_FGEN_CONFIG.dcOffsetV;
  if (cfg.waveform === 'square') {
    const amplitudeVpp = Number.isFinite(cfg.amplitudeVpp)
      ? cfg.amplitudeVpp
      : DEFAULT_FGEN_CONFIG.amplitudeVpp;
    const dutyCycle = Number.isFinite(cfg.dutyCycle)
      ? clamp(cfg.dutyCycle, 10, 90)
      : DEFAULT_FGEN_CONFIG.dutyCycle;
    return dcOffsetV + (dutyCycle / 50 - 1) * (amplitudeVpp / 2);
  }
  return dcOffsetV;
}

/**
 * Evaluates instantaneous FGEN voltage in Volts at time tSec.
 * @param {object} fgen
 * @param {number} tSec
 * @returns {number}
 */
export function evaluateWaveform(fgen, tSec) {
  const cfg = fgen || DEFAULT_FGEN_CONFIG;
  const freq = Number.isFinite(cfg.frequencyHz) ? cfg.frequencyHz : DEFAULT_FGEN_CONFIG.frequencyHz;
  const vpp = Number.isFinite(cfg.amplitudeVpp) ? cfg.amplitudeVpp : DEFAULT_FGEN_CONFIG.amplitudeVpp;
  const offset = Number.isFinite(cfg.dcOffsetV) ? cfg.dcOffsetV : DEFAULT_FGEN_CONFIG.dcOffsetV;
  const dutyCycle = Number.isFinite(cfg.dutyCycle) ? cfg.dutyCycle : DEFAULT_FGEN_CONFIG.dutyCycle;
  const t = Number.isFinite(tSec) ? tSec : 0;
  const halfAmp = vpp / 2;

  switch (cfg.waveform) {
    case 'triangle':
      return offset + halfAmp * (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freq * t));
    case 'square': {
      const phase = ((t * freq) % 1 + 1) % 1;
      const duty = clamp(dutyCycle / 100, 0.05, 0.95);
      return offset + halfAmp * (phase < duty ? 1 : -1);
    }
    case 'sine':
    default:
      return offset + halfAmp * Math.sin(2 * Math.PI * freq * t);
  }
}

/**
 * Computes summary waveform metrics from an evenly sampled voltage array.
 * @param {Array<number> | Float64Array} samples
 * @param {number} dtSec
 * @returns {{ vMin: number, vMax: number, vpp: number, vAvg: number, vRms: number, vRmsAc: number, freqHz: number | null }}
 */
export function computeWaveformMetrics(samples, dtSec) {
  const n = samples?.length || 0;
  if (n === 0) {
    return { vMin: 0, vMax: 0, vpp: 0, vAvg: 0, vRms: 0, vRmsAc: 0, freqHz: null };
  }

  let vMin = Infinity;
  let vMax = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
    sum += v;
    sumSq += v * v;
    count++;
  }

  if (count === 0) {
    return { vMin: 0, vMax: 0, vpp: 0, vAvg: 0, vRms: 0, vRmsAc: 0, freqHz: null };
  }

  const vpp = vMax - vMin;
  let vAvg = sum / count;
  let vRms = Math.sqrt(sumSq / count);

  let sumAcSq = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    const diff = v - vAvg;
    sumAcSq += diff * diff;
  }
  let vRmsAc = Math.sqrt(sumAcSq / count);

  let freqHz = null;
  if (Number.isFinite(dtSec) && dtSec > 0 && vpp >= 1e-4 && n >= 2) {
    const mid = (vMin + vMax) / 2;
    const hyst = 0.1 * vpp;
    const lowThresh = mid - hyst;
    const highThresh = mid + hyst;

    let armed = Number.isFinite(samples[0]) && samples[0] <= lowThresh;
    let pendingMidCrossIdx = null;
    const crossings = [];
    const crossingIndices = [];

    for (let i = 1; i < n; i++) {
      const prev = samples[i - 1];
      const curr = samples[i];
      if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;

      if (!armed) {
        if (curr <= lowThresh) {
          armed = true;
          pendingMidCrossIdx = null;
        }
      } else {
        if (curr <= lowThresh) {
          pendingMidCrossIdx = null;
        }
        if (prev < mid && curr >= mid) {
          const denom = curr - prev;
          const frac = denom !== 0 ? (mid - prev) / denom : 0;
          pendingMidCrossIdx = (i - 1) + frac;
        }
        if (curr >= highThresh && pendingMidCrossIdx !== null) {
          crossings.push(pendingMidCrossIdx * dtSec);
          crossingIndices.push(pendingMidCrossIdx);
          pendingMidCrossIdx = null;
          armed = false;
        }
      }
    }

    if (crossings.length >= 2) {
      const avgPeriod = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
      if (avgPeriod > 0 && Number.isFinite(avgPeriod)) {
        freqHz = 1 / avgPeriod;
      }

      // Compute average and RMS over exact integer-cycle span to avoid partial-cycle drift
      const startIdx = Math.max(0, Math.min(n - 1, Math.round(crossingIndices[0])));
      const endIdx = Math.max(
        0,
        Math.min(n - 1, Math.round(crossingIndices[crossingIndices.length - 1]))
      );
      if (endIdx > startIdx) {
        let cycSum = 0;
        let cycSumSq = 0;
        let cycCount = 0;
        for (let i = startIdx; i < endIdx; i++) {
          const v = samples[i];
          if (!Number.isFinite(v)) continue;
          cycSum += v;
          cycSumSq += v * v;
          cycCount++;
        }
        if (cycCount > 0) {
          vAvg = cycSum / cycCount;
          vRms = Math.sqrt(cycSumSq / cycCount);
          let cycSumAcSq = 0;
          for (let i = startIdx; i < endIdx; i++) {
            const v = samples[i];
            if (!Number.isFinite(v)) continue;
            const diff = v - vAvg;
            cycSumAcSq += diff * diff;
          }
          vRmsAc = Math.sqrt(cycSumAcSq / cycCount);
        }
      }
    }
  }

  return { vMin, vMax, vpp, vAvg, vRms, vRmsAc, freqHz };
}

/**
 * Searches for the first edge crossing matching slope ('rising' or 'falling') around level
 * with small hysteresis; returns sample index or -1 if no trigger is found.
 * @param {Array<number> | Float64Array} samples
 * @param {object} [options]
 * @param {number} [options.level=0]
 * @param {'rising' | 'falling'} [options.slope='rising']
 * @param {number} [options.startIdx=0]
 * @param {number} [options.endIdx]
 * @returns {number}
 */
export function findTriggerIndex(samples, { level = 0, slope = 'rising', startIdx = 0, endIdx } = {}) {
  const n = samples?.length || 0;
  if (n < 2) return -1;

  const start = Math.max(0, Math.floor(Number.isFinite(startIdx) ? startIdx : 0));
  const end = Math.min(n - 1, Math.floor(Number.isFinite(endIdx) ? endIdx : n - 1));
  if (end - start < 1) return -1;

  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = start; i <= end; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return -1;

  const vpp = vMax - vMin;
  const hyst = Math.max(1e-6, 0.02 * vpp);
  const falling = slope === 'falling';

  let armed = Number.isFinite(samples[start])
    ? (falling ? samples[start] >= level + hyst : samples[start] <= level - hyst)
    : false;

  for (let i = start + 1; i <= end; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;

    if (!armed) {
      if (falling ? curr >= level + hyst : curr <= level - hyst) {
        armed = true;
      }
      continue;
    }

    if (falling) {
      if (prev > level && curr <= level) {
        return i;
      }
    } else {
      if (prev < level && curr >= level) {
        return i;
      }
    }
  }

  return -1;
}
