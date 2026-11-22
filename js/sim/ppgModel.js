import { clamp } from './linearAlgebra.js';

/**
 * Pure, zero-DOM optical PPG & Dual-LED Pulse-Ox simulation model.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 *
 * Models:
 * 1. Arterial photoplethysmography (PPG) pulse waveform with systolic peak,
 *    dicrotic notch, and diastolic secondary peak.
 * 2. Breadboard LDR optical coupling (`lightMode: 'led-ppg'`) where an active
 *    breadboard LED illuminates a finger/tissue path to modulate LDR resistance.
 * 3. True Dual-LED (660 nm Red / 940 nm IR) Finger-Clip Pulse-Ox photodiode
 *    photocurrent using Beer-Lambert R-curve modulation from SpO2 and perfusion.
 */

export const DEFAULT_PPG_PROPS = Object.freeze({
  lightLevel: 0.5,
  lightMode: 'manual',
  fingerPresent: false,
  bpm: 72,
  perfusion: 0.5
});

export const DEFAULT_PULSE_OX_CONFIG = Object.freeze({
  fingerPresent: true,
  bpm: 72,
  spo2: 98,
  perfusion: 0.6
});

/**
 * Shortest signed phase distance in [-0.5, 0.5] on the unit circle [0, 1).
 * @param {number} p
 * @param {number} center
 * @returns {number}
 */
function circularPhaseDiff(p, center) {
  let d = p - center;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/**
 * Unnormalized periodic PPG pulse shape over phase p in [0, 1).
 * @param {number} p
 * @returns {number}
 */
function rawPpgShape(p) {
  const systolic = 0.95 * Math.exp(-0.5 * (circularPhaseDiff(p, 0.18) / 0.068) ** 2);
  const dicroticNotch = 0.015 * Math.exp(-0.5 * (circularPhaseDiff(p, 0.335) / 0.038) ** 2);
  const diastolic = 0.34 * Math.exp(-0.5 * (circularPhaseDiff(p, 0.44) / 0.11) ** 2);
  const runoff = 0.12 * Math.exp(-0.5 * (circularPhaseDiff(p, 0.65) / 0.18) ** 2);
  return systolic - dicroticNotch + diastolic + runoff;
}

const PPG_RAW_SAMPLE_COUNT = 1024;
let rawPpgMin = Infinity;
let rawPpgMax = -Infinity;
for (let i = 0; i < PPG_RAW_SAMPLE_COUNT; i++) {
  const val = rawPpgShape(i / PPG_RAW_SAMPLE_COUNT);
  if (val < rawPpgMin) rawPpgMin = val;
  if (val > rawPpgMax) rawPpgMax = val;
}
const rawPpgSpan = rawPpgMax > rawPpgMin ? rawPpgMax - rawPpgMin : 1;

/**
 * Normalizes photoresistor optical/PPG properties.
 * @param {object} [overrides]
 * @returns {{ lightLevel: number, lightMode: 'manual'|'led-ppg', fingerPresent: boolean, bpm: number, perfusion: number }}
 */
export function createDefaultPpgProps(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};
  const lightLevel = Number.isFinite(Number(safe.lightLevel))
    ? clamp(Number(safe.lightLevel), 0, 1)
    : DEFAULT_PPG_PROPS.lightLevel;
  const lightMode = safe.lightMode === 'led-ppg' ? 'led-ppg' : DEFAULT_PPG_PROPS.lightMode;
  const fingerPresent = Boolean(safe.fingerPresent);
  const bpm = Number.isFinite(Number(safe.bpm))
    ? clamp(Number(safe.bpm), 45, 160)
    : DEFAULT_PPG_PROPS.bpm;
  const perfusion = Number.isFinite(Number(safe.perfusion))
    ? clamp(Number(safe.perfusion), 0.2, 1.0)
    : DEFAULT_PPG_PROPS.perfusion;

  return {
    lightLevel,
    lightMode,
    fingerPresent,
    bpm,
    perfusion
  };
}

/**
 * Normalizes True Pulse-Ox (Red 660 nm / IR 940 nm) physiological parameters.
 * @param {object} [overrides]
 * @returns {{ fingerPresent: boolean, bpm: number, spo2: number, perfusion: number }}
 */
export function createDefaultPulseOxConfig(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};
  const fingerPresent =
    safe.fingerPresent !== undefined
      ? Boolean(safe.fingerPresent)
      : DEFAULT_PULSE_OX_CONFIG.fingerPresent;
  const bpm = Number.isFinite(Number(safe.bpm))
    ? clamp(Number(safe.bpm), 45, 160)
    : DEFAULT_PULSE_OX_CONFIG.bpm;
  const spo2 = Number.isFinite(Number(safe.spo2))
    ? clamp(Number(safe.spo2), 70, 100)
    : DEFAULT_PULSE_OX_CONFIG.spo2;
  const perfusion = Number.isFinite(Number(safe.perfusion))
    ? clamp(Number(safe.perfusion), 0.2, 1.0)
    : DEFAULT_PULSE_OX_CONFIG.perfusion;

  return {
    fingerPresent,
    bpm,
    spo2,
    perfusion
  };
}

/**
 * Evaluates a realistic periodic arterial PPG waveform in [0, 1] at time tSec.
 * Features a sharp systolic peak (~1.0), dicrotic notch (~0.28), and diastolic peak (~0.39).
 * @param {number} tSec
 * @param {number} [bpm=72]
 * @returns {number}
 */
export function evaluatePpgPulse(tSec, bpm = 72) {
  const safeBpm = Number.isFinite(Number(bpm)) ? clamp(Number(bpm), 45, 160) : 72;
  const f = safeBpm / 60;
  const t = Number.isFinite(Number(tSec)) ? Number(tSec) : 0;
  const p = (((t * f) % 1) + 1) % 1;
  return clamp((rawPpgShape(p) - rawPpgMin) / rawPpgSpan, 0, 1);
}

/**
 * Exact DC average of `evaluatePpgPulse` over one full cardiac cycle (1024 phase samples).
 */
export const PPG_PULSE_DC_MEAN = (() => {
  let sum = 0;
  for (let i = 0; i < PPG_RAW_SAMPLE_COUNT; i++) {
    const p = i / PPG_RAW_SAMPLE_COUNT;
    sum += clamp((rawPpgShape(p) - rawPpgMin) / rawPpgSpan, 0, 1);
  }
  return sum / PPG_RAW_SAMPLE_COUNT;
})();

/**
 * Evaluates the effective optical illumination [0..1] reaching a photoresistor,
 * supporting both manual ambient slider mode and optical LED -> finger -> LDR PPG coupling.
 * @param {object} props
 * @param {number} ledBrightness
 * @param {number | null} [tSec=null]
 * @returns {{ effectiveLight: number, opticalLinked: boolean, pulseActive: boolean, ledBrightness: number }}
 */
export function evaluatePhotoresistorLight(props, ledBrightness, tSec = null) {
  const p = createDefaultPpgProps(props);
  const led = clamp(Number(ledBrightness) || 0, 0, 1);

  if (p.lightMode !== 'led-ppg') {
    return {
      effectiveLight: p.lightLevel,
      opticalLinked: false,
      pulseActive: false,
      ledBrightness: led
    };
  }

  if (led <= 0.02) {
    return {
      effectiveLight: 0.04,
      opticalLinked: false,
      pulseActive: false,
      ledBrightness: led
    };
  }

  if (!p.fingerPresent) {
    return {
      effectiveLight: clamp(0.05 + 0.9 * led, 0.02, 0.98),
      opticalLinked: true,
      pulseActive: false,
      ledBrightness: led
    };
  }

  const dcLight = clamp(0.08 + 0.42 * led, 0.05, 0.85);
  if (tSec == null || !Number.isFinite(tSec)) {
    return {
      effectiveLight: dcLight,
      opticalLinked: true,
      pulseActive: true,
      ledBrightness: led
    };
  }

  const pulse = evaluatePpgPulse(tSec, p.bpm) - PPG_PULSE_DC_MEAN;
  const acMod = 0.14 * p.perfusion * led * pulse;
  const effectiveLight = clamp(dcLight - acMod, 0.02, 0.98);

  return {
    effectiveLight,
    opticalLinked: true,
    pulseActive: true,
    ledBrightness: led
  };
}

/**
 * Evaluates the photodiode reverse photocurrent (in Amps) for the Dual-LED (660 nm / 940 nm)
 * True Pulse-Ox finger-clip sensor.
 * @param {object} pulseOxConfig
 * @param {number} redCurrentMa
 * @param {number} irCurrentMa
 * @param {number | null} [tSec=null]
 * @returns {{ iPhAmps: number, iRedDcAmps: number, iIrDcAmps: number, redDrive: number, irDrive: number, redLit: boolean, irLit: boolean, ratioR: number, fingerPresent: boolean }}
 */
export function evaluatePulseOxPhotocurrent(pulseOxConfig, redCurrentMa, irCurrentMa, tSec = null) {
  const cfg = createDefaultPulseOxConfig(pulseOxConfig);
  const redMa = Math.max(0, Number(redCurrentMa) || 0);
  const irMa = Math.max(0, Number(irCurrentMa) || 0);

  const redDrive = redMa < 0.05 ? 0 : Math.min(1.4, redMa / 15);
  const irDrive = irMa < 0.05 ? 0 : Math.min(1.4, irMa / 15);
  const ratioR = Math.min(1.8, Math.max(0.35, (110 - cfg.spo2) / 25));
  const I_DARK = 0.02e-6;

  if (!cfg.fingerPresent) {
    const iRedDcAmps = 28e-6 * redDrive;
    const iIrDcAmps = 30e-6 * irDrive;
    const iPhAmps = I_DARK + iRedDcAmps + iIrDcAmps;
    return {
      iPhAmps,
      iRedDcAmps,
      iIrDcAmps,
      redDrive,
      irDrive,
      redLit: redDrive > 0.01,
      irLit: irDrive > 0.01,
      ratioR,
      fingerPresent: cfg.fingerPresent
    };
  }

  const iRedDcAmps = 14e-6 * redDrive;
  const iIrDcAmps = 16e-6 * irDrive;
  const mIr = 0.12 * cfg.perfusion;
  const mRed = Math.min(0.35, ratioR * mIr);

  let iPhAmps;
  if (tSec == null || !Number.isFinite(tSec)) {
    iPhAmps = I_DARK + iRedDcAmps + iIrDcAmps;
  } else {
    const pulse = evaluatePpgPulse(tSec, cfg.bpm) - PPG_PULSE_DC_MEAN;
    const iRed = Math.max(0, iRedDcAmps * (1 - mRed * pulse));
    const iIr = Math.max(0, iIrDcAmps * (1 - mIr * pulse));
    iPhAmps = I_DARK + iRed + iIr;
  }

  return {
    iPhAmps,
    iRedDcAmps,
    iIrDcAmps,
    redDrive,
    irDrive,
    redLit: redDrive > 0.01,
    irLit: irDrive > 0.01,
    ratioR,
    fingerPresent: cfg.fingerPresent
  };
}
