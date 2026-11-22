import { clamp } from './linearAlgebra.js';

/**
 * Pure, zero-DOM physiological 3-pad surface EMG signal generator.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 *
 * Models differential Motor-Unit Action Potential (MUAP) activity across
 * EMG_RED1 (MID / +) and EMG_RED2 (END / −) referenced to EMG_BLK (COM / REF),
 * plus optional 60 Hz common-mode mains interference and skin-electrode impedance mismatch.
 */

export const DEFAULT_EMG_CONFIG = Object.freeze({
  flexEffort: 0.5, // 0..1 (0 = relaxed baseline noise, 1 = max voluntary contraction)
  burstMode: 'burst', // 'burst' (periodic contraction bursts) | 'continuous'
  humMvpp: 0, // 0..50 mVpp common-mode 60 Hz mains interference
  electrodeMismatch: 0.05 // 0..0.5 fractional skin-electrode impedance mismatch (5 kΩ vs 5k*(1+m))
});

export const EMG_IMPEDANCE_OHMS = Object.freeze({
  red1: 5000,
  red2Base: 5000,
  blk: 2000
});

const VALID_BURST_MODES = new Set(['burst', 'continuous']);

// Burst timing: 0.18 s period with a crisp 0.09 s raised-cosine contraction burst + 0.09 s rest
const BURST_PERIOD_SEC = 0.18;
const BURST_ACTIVE_SEC = 0.09;
const BURST_START_SEC = (BURST_PERIOD_SEC - BURST_ACTIVE_SEC) / 2; // 0.045 s..0.135 s

// Incommensurate MUAP sinusoids (37 Hz – 247 Hz) peaking around 70–140 Hz
// Sum peak-to-peak across typical windows is ~9.42; scaled by 0.000315 V -> ~3.0 mVpp at flexEffort = 1
const MUAP_COMPONENTS = Object.freeze([
  [37.3, 0.35, 0.41],
  [53.1, 0.55, 1.73],
  [71.7, 0.85, 2.89],
  [88.9, 1.0, 0.95],
  [107.3, 0.98, 4.12],
  [127.1, 0.92, 5.27],
  [146.7, 0.78, 2.14],
  [169.3, 0.58, 3.68],
  [193.7, 0.42, 0.22],
  [219.1, 0.28, 5.71],
  [246.7, 0.18, 1.34]
]);

// Resting baseline noise components (sum pp ~4.88; scaled by 0.000012 V -> ~0.059 mVpp)
const BASELINE_NOISE_COMPONENTS = Object.freeze([
  [43.7, 0.45, 2.31],
  [79.3, 0.7, 0.67],
  [131.9, 0.85, 4.88],
  [181.1, 0.65, 1.52],
  [233.3, 0.4, 3.91]
]);

const MUAP_SCALE_VOLTS = 0.000315;
const BASELINE_SCALE_VOLTS = 0.000012;

/**
 * Returns a fresh normalized 3-pad EMG configuration object with clamped numeric fields.
 * @param {object} [overrides]
 * @returns {{ flexEffort: number, burstMode: 'burst'|'continuous', humMvpp: number, electrodeMismatch: number }}
 */
export function createDefaultEmgConfig(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};
  const flexEffort = Number.isFinite(safe.flexEffort)
    ? clamp(safe.flexEffort, 0, 1)
    : DEFAULT_EMG_CONFIG.flexEffort;
  const burstMode = VALID_BURST_MODES.has(safe.burstMode)
    ? safe.burstMode
    : DEFAULT_EMG_CONFIG.burstMode;
  const humMvpp = Number.isFinite(safe.humMvpp)
    ? clamp(safe.humMvpp, 0, 50)
    : DEFAULT_EMG_CONFIG.humMvpp;
  const electrodeMismatch = Number.isFinite(safe.electrodeMismatch)
    ? clamp(safe.electrodeMismatch, 0, 0.5)
    : DEFAULT_EMG_CONFIG.electrodeMismatch;

  return {
    flexEffort,
    burstMode,
    humMvpp,
    electrodeMismatch
  };
}

/**
 * Evaluates the deterministic contraction envelope [0..1] at time tSec.
 * @param {object} emgConfig
 * @param {number} tSec
 * @returns {number}
 */
export function evaluateEmgEnvelope(emgConfig, tSec) {
  const cfg = createDefaultEmgConfig(emgConfig);
  const t = Number.isFinite(tSec) ? tSec : 0;

  if (cfg.burstMode === 'continuous') {
    return cfg.flexEffort;
  }

  // Wrap phase cleanly for negative warm-up times as well as t >= 0
  const phaseSec = ((t % BURST_PERIOD_SEC) + BURST_PERIOD_SEC) % BURST_PERIOD_SEC;
  const u = (phaseSec - BURST_START_SEC) / BURST_ACTIVE_SEC;
  if (u <= 0 || u >= 1) {
    return 0;
  }
  const raisedCosine = 0.5 * (1 - Math.cos(2 * Math.PI * u));
  return cfg.flexEffort * raisedCosine;
}

/**
 * Evaluates instantaneous deterministic 3-pad surface EMG voltages (in Volts) at time tSec.
 * @param {object} emgConfig
 * @param {number} tSec
 * @returns {{ vDiff: number, vCommonMode: number, vRed1: number, vRed2: number, envelope: number }}
 */
export function evaluateEmgSignals(emgConfig, tSec) {
  const cfg = createDefaultEmgConfig(emgConfig);
  const t = Number.isFinite(tSec) ? tSec : 0;
  const envelope = evaluateEmgEnvelope(cfg, t);

  let muapSum = 0;
  for (let i = 0; i < MUAP_COMPONENTS.length; i++) {
    const [freq, amp, phase] = MUAP_COMPONENTS[i];
    muapSum += amp * Math.sin(2 * Math.PI * freq * t + phase);
  }

  let noiseSum = 0;
  for (let i = 0; i < BASELINE_NOISE_COMPONENTS.length; i++) {
    const [freq, amp, phase] = BASELINE_NOISE_COMPONENTS[i];
    noiseSum += amp * Math.sin(2 * Math.PI * freq * t + phase);
  }

  const vDiff = envelope * (muapSum * MUAP_SCALE_VOLTS) + noiseSum * BASELINE_SCALE_VOLTS;
  const vCommonMode = (cfg.humMvpp / 2000) * Math.sin(2 * Math.PI * 60 * t);
  const vRed1 = vCommonMode + vDiff / 2;
  const vRed2 = vCommonMode - vDiff / 2;

  return {
    vDiff,
    vCommonMode,
    vRed1,
    vRed2,
    envelope
  };
}
