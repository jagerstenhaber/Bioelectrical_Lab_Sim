import { clamp } from './linearAlgebra.js';
import { PPG_PULSE_DC_MEAN, evaluatePpgPulse } from './ppgModel.js';

/**
 * Pure, zero-DOM NI ELVISmx Arbitrary Waveform Generator (ARB) waveform model.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 *
 * Provides dual-channel (AO 0 / AO 1) periodic arbitrary waveform generation with
 * built-in physiological EKG / Arterial PPG / reference waveforms, linear sample
 * interpolation, custom CSV/TSV waveform parsing, and exact DC/frequency helpers.
 */

export const ARB_MAX_SAMPLES = 4096;
export const ARB_MIN_RATE_HZ = 100;
export const ARB_MAX_RATE_HZ = 20000;
export const ARB_MIN_GAIN = 0.01;
export const ARB_MAX_GAIN = 10.0;
export const ARB_MIN_OFFSET_V = -5.0;
export const ARB_MAX_OFFSET_V = 5.0;
export const ARB_MIN_VOLT = -10.0;
export const ARB_MAX_VOLT = 10.0;

/**
 * Evaluates a single Gaussian bump centered at `center` with std-dev `width` and `amp`.
 * @param {number} p
 * @param {number} center
 * @param {number} width
 * @param {number} amp
 * @returns {number}
 */
function gaussian(p, center, width, amp) {
  const z = (p - center) / width;
  return amp * Math.exp(-0.5 * z * z);
}

/**
 * Evaluates realistic Lead II P-QRS-T morphology over normalized beat phase p in [0, 1).
 * Zero-baseline aligned (tends to 0 at p=0 and p=1).
 * @param {number} p
 * @returns {number}
 */
function evaluateLeadIiEkgPhase(p) {
  return (
    gaussian(p, 0.2, 0.028, 0.14) + // P wave
    gaussian(p, 0.32, 0.011, -0.12) + // Q dip
    gaussian(p, 0.35, 0.016, 1.0) + // R peak (~30 ms FWHM @ 72 BPM)
    gaussian(p, 0.38, 0.013, -0.22) + // S dip
    gaussian(p, 0.56, 0.048, 0.28) // T wave
  );
}

/**
 * Generates N samples of a periodic Lead II EKG complex.
 * @param {number} points
 * @returns {Float64Array}
 */
function buildEkgBuffer(points) {
  const out = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    out[i] = evaluateLeadIiEkgPhase(i / points);
  }
  return out;
}

const BUILT_IN_DEFS = [
  {
    id: 'ekg-nsr-72',
    name: 'EKG Normal (72 BPM)',
    points: 833,
    generator: () => buildEkgBuffer(833)
  },
  {
    id: 'ekg-nsr-60',
    name: 'EKG Normal (60 BPM)',
    points: 1000,
    generator: () => buildEkgBuffer(1000)
  },
  {
    id: 'ekg-hum60',
    name: 'EKG + 60 Hz Hum',
    points: 833,
    generator: () => {
      const points = 833;
      const out = new Float64Array(points);
      for (let i = 0; i < points; i++) {
        const p = i / points;
        out[i] = evaluateLeadIiEkgPhase(p) + 0.25 * Math.sin(2 * Math.PI * 50 * p);
      }
      return out;
    }
  },
  {
    id: 'ekg-wander',
    name: 'EKG + Baseline Wander',
    points: 2500,
    generator: () => {
      const points = 2500;
      const out = new Float64Array(points);
      for (let i = 0; i < points; i++) {
        const p = i / points;
        const beatPhase = (p * 3) % 1;
        out[i] =
          evaluateLeadIiEkgPhase(beatPhase) +
          0.22 * Math.sin(2 * Math.PI * p) +
          0.08 * Math.sin(2 * Math.PI * 150 * p);
      }
      return out;
    }
  },
  {
    id: 'ekg-tachy',
    name: 'EKG Tachy (120 BPM)',
    points: 500,
    generator: () => buildEkgBuffer(500)
  },
  {
    id: 'ppg-arterial',
    name: 'Arterial PPG Pulse',
    points: 833,
    generator: () => {
      const points = 833;
      const out = new Float64Array(points);
      const periodSec = 60 / 72; // 0.8333 s @ 72 BPM
      for (let i = 0; i < points; i++) {
        const tSec = (i / points) * periodSec;
        out[i] = clamp(evaluatePpgPulse(tSec, 72) - PPG_PULSE_DC_MEAN, -0.5, 0.5);
      }
      return out;
    }
  },
  {
    id: 'sine-10hz',
    name: '10 Hz Sine',
    points: 1000,
    generator: () => {
      const points = 1000;
      const out = new Float64Array(points);
      for (let i = 0; i < points; i++) {
        const p = i / points;
        out[i] = Math.sin(2 * Math.PI * 10 * p);
      }
      return out;
    }
  }
];

const BUILT_IN_MAP = new Map();
const BUILT_IN_CACHE = new Map();

export const ARB_BUILT_IN_WAVEFORMS = Object.freeze(
  BUILT_IN_DEFS.map((def) => {
    const entry = Object.freeze({
      id: def.id,
      name: def.name,
      points: def.points
    });
    BUILT_IN_MAP.set(def.id, def);
    return entry;
  })
);

function getBuiltInSamples(waveformId) {
  if (!waveformId || !BUILT_IN_MAP.has(waveformId)) return null;
  let cached = BUILT_IN_CACHE.get(waveformId);
  if (!cached) {
    cached = BUILT_IN_MAP.get(waveformId).generator();
    BUILT_IN_CACHE.set(waveformId, cached);
  }
  return cached;
}

export const DEFAULT_ARB_CONFIG = Object.freeze({
  running: false,
  updateRateHz: 1000,
  ao0: Object.freeze({
    enabled: true,
    waveformId: 'ekg-nsr-72',
    gain: 1.0,
    offsetV: 0.0,
    probeHole: null,
    customName: '',
    customSamples: null
  }),
  ao1: Object.freeze({
    enabled: false,
    waveformId: '',
    gain: 1.0,
    offsetV: 0.0,
    probeHole: null,
    customName: '',
    customSamples: null
  })
});

const NORMALIZED_CUSTOM_SAMPLES = new WeakSet();

function normalizeCustomSamples(rawSamples) {
  if (!rawSamples || typeof rawSamples.length !== 'number') return null;
  if (rawSamples.length === 0) return null;

  if (NORMALIZED_CUSTOM_SAMPLES.has(rawSamples)) {
    return rawSamples;
  }

  if (rawSamples instanceof Float64Array) {
    if (rawSamples.length <= ARB_MAX_SAMPLES) {
      let clean = true;
      for (let i = 0; i < rawSamples.length; i++) {
        const v = rawSamples[i];
        if (!Number.isFinite(v) || v < ARB_MIN_VOLT || v > ARB_MAX_VOLT) {
          clean = false;
          break;
        }
      }
      if (clean) {
        NORMALIZED_CUSTOM_SAMPLES.add(rawSamples);
        return rawSamples;
      }
    }
  }

  const len = Math.min(ARB_MAX_SAMPLES, rawSamples.length);
  const out = new Array(len);
  let validCount = 0;
  for (let i = 0; i < len; i++) {
    const val = Number(rawSamples[i]);
    if (Number.isFinite(val)) {
      out[validCount++] = clamp(val, ARB_MIN_VOLT, ARB_MAX_VOLT);
    }
  }
  if (validCount === 0) return null;
  const result = Object.freeze(validCount === len ? out : out.slice(0, validCount));
  NORMALIZED_CUSTOM_SAMPLES.add(result);
  return result;
}

function normalizeArbChannel(raw, defaults) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const enabled = safe.enabled !== undefined ? Boolean(safe.enabled) : defaults.enabled;
  const waveformId = typeof safe.waveformId === 'string' ? safe.waveformId.trim() : defaults.waveformId;
  const gain = Number.isFinite(Number(safe.gain))
    ? clamp(Number(safe.gain), ARB_MIN_GAIN, ARB_MAX_GAIN)
    : defaults.gain;
  const offsetV = Number.isFinite(Number(safe.offsetV))
    ? clamp(Number(safe.offsetV), ARB_MIN_OFFSET_V, ARB_MAX_OFFSET_V)
    : defaults.offsetV;
  const probeHole =
    typeof safe.probeHole === 'string' && safe.probeHole.trim().length > 0
      ? safe.probeHole.trim()
      : null;
  const customName = typeof safe.customName === 'string' ? safe.customName.trim() : '';
  const customSamples = normalizeCustomSamples(safe.customSamples);

  return {
    enabled,
    waveformId,
    gain,
    offsetV,
    probeHole,
    customName,
    customSamples
  };
}

/**
 * Returns a fresh normalized and clamped dual-channel ARB configuration object.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createDefaultArbConfig(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};
  const running = safe.running !== undefined ? Boolean(safe.running) : DEFAULT_ARB_CONFIG.running;
  const updateRateHz = Number.isFinite(Number(safe.updateRateHz))
    ? clamp(Number(safe.updateRateHz), ARB_MIN_RATE_HZ, ARB_MAX_RATE_HZ)
    : DEFAULT_ARB_CONFIG.updateRateHz;

  return {
    running,
    updateRateHz,
    ao0: normalizeArbChannel(safe.ao0, DEFAULT_ARB_CONFIG.ao0),
    ao1: normalizeArbChannel(safe.ao1, DEFAULT_ARB_CONFIG.ao1)
  };
}

const EMPTY_SAMPLES = new Float64Array(0);
const CUSTOM_BUFFER_CACHE = new WeakMap();

/**
 * Resolves the sample buffer, display name, and sample count for a single ARB channel.
 * @param {object} chCfg
 * @returns {{ samples: Float64Array, name: string, count: number }}
 */
export function getArbChannelSamples(chCfg) {
  if (!chCfg || typeof chCfg !== 'object' || !chCfg.waveformId) {
    return { samples: EMPTY_SAMPLES, name: '< empty >', count: 0 };
  }

  if (chCfg.waveformId === 'custom') {
    const raw = chCfg.customSamples;
    if (!raw || raw.length === 0) {
      return { samples: EMPTY_SAMPLES, name: '< empty >', count: 0 };
    }
    let samples;
    if (raw instanceof Float64Array) {
      samples = raw;
    } else if (Array.isArray(raw)) {
      samples = CUSTOM_BUFFER_CACHE.get(raw);
      if (!samples) {
        const len = Math.min(ARB_MAX_SAMPLES, raw.length);
        samples = new Float64Array(len);
        for (let i = 0; i < len; i++) {
          const val = Number(raw[i]);
          samples[i] = Number.isFinite(val) ? clamp(val, ARB_MIN_VOLT, ARB_MAX_VOLT) : 0;
        }
        CUSTOM_BUFFER_CACHE.set(raw, samples);
      }
    } else {
      return { samples: EMPTY_SAMPLES, name: '< empty >', count: 0 };
    }
    if (samples.length === 0) {
      return { samples: EMPTY_SAMPLES, name: '< empty >', count: 0 };
    }
    return {
      samples,
      name: chCfg.customName || 'Custom CSV',
      count: samples.length
    };
  }

  const def = BUILT_IN_MAP.get(chCfg.waveformId);
  if (!def) {
    return { samples: EMPTY_SAMPLES, name: '< empty >', count: 0 };
  }
  const samples = getBuiltInSamples(chCfg.waveformId);
  return {
    samples,
    name: def.name,
    count: samples.length
  };
}

/**
 * Evaluates instantaneous ARB channel output voltage (in Volts) at time tSec using
 * smooth periodic linear interpolation across the sample buffer.
 * @param {object} arbCfg
 * @param {'ao0' | 'ao1'} channelKey
 * @param {number} tSec
 * @returns {number}
 */
export function evaluateArbChannel(arbCfg, channelKey, tSec) {
  if (!arbCfg?.running) return 0;
  const ch = arbCfg[channelKey];
  if (!ch?.enabled) return 0;
  const { samples, count } = getArbChannelSamples(ch);
  if (count === 0) return 0;

  const rate = Number.isFinite(Number(arbCfg.updateRateHz))
    ? clamp(Number(arbCfg.updateRateHz), ARB_MIN_RATE_HZ, ARB_MAX_RATE_HZ)
    : DEFAULT_ARB_CONFIG.updateRateHz;
  const t = Number.isFinite(Number(tSec)) ? Number(tSec) : 0;
  const pos = (((t * rate) % count) + count) % count;

  let rawVal;
  if (count === 1) {
    rawVal = samples[0];
  } else {
    const idx0 = Math.floor(pos) % count;
    const frac = pos - Math.floor(pos);
    const idx1 = (idx0 + 1) % count;
    rawVal = samples[idx0] + frac * (samples[idx1] - samples[idx0]);
  }

  const gain = Number.isFinite(Number(ch.gain))
    ? clamp(Number(ch.gain), ARB_MIN_GAIN, ARB_MAX_GAIN)
    : 1.0;
  const offsetV = Number.isFinite(Number(ch.offsetV))
    ? clamp(Number(ch.offsetV), ARB_MIN_OFFSET_V, ARB_MAX_OFFSET_V)
    : 0.0;

  return clamp(rawVal * gain + offsetV, ARB_MIN_VOLT, ARB_MAX_VOLT);
}

/**
 * Computes the exact periodic DC mean voltage for an ARB channel.
 * Returns 0 when ARB is stopped, channel is disabled, or buffer is empty.
 * @param {object} arbCfg
 * @param {'ao0' | 'ao1'} channelKey
 * @returns {number}
 */
export function getArbChannelDcMean(arbCfg, channelKey) {
  if (!arbCfg?.running) return 0;
  const ch = arbCfg[channelKey];
  if (!ch?.enabled) return 0;
  const { samples, count } = getArbChannelSamples(ch);
  if (count === 0) return 0;

  const gain = Number.isFinite(Number(ch.gain))
    ? clamp(Number(ch.gain), ARB_MIN_GAIN, ARB_MAX_GAIN)
    : 1.0;
  const offsetV = Number.isFinite(Number(ch.offsetV))
    ? clamp(Number(ch.offsetV), ARB_MIN_OFFSET_V, ARB_MAX_OFFSET_V)
    : 0.0;

  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += clamp(samples[i] * gain + offsetV, ARB_MIN_VOLT, ARB_MAX_VOLT);
  }
  return sum / count;
}

/**
 * Returns the fundamental repeat frequency (Hz) of an ARB channel, or null if inactive.
 * Pass `{ ignoreRunning: true }` to compute the planned repeat frequency while ARB is stopped.
 * @param {object} arbCfg
 * @param {'ao0' | 'ao1'} channelKey
 * @param {{ ignoreRunning?: boolean }} [options]
 * @returns {number | null}
 */
export function getArbChannelFreqHz(arbCfg, channelKey, { ignoreRunning = false } = {}) {
  if (!arbCfg) return null;
  if (!ignoreRunning && !arbCfg.running) return null;
  const ch = arbCfg[channelKey];
  if (!ch?.enabled) return null;
  const { count } = getArbChannelSamples(ch);
  if (count === 0) return null;
  const rate = Number.isFinite(Number(arbCfg.updateRateHz))
    ? clamp(Number(arbCfg.updateRateHz), ARB_MIN_RATE_HZ, ARB_MAX_RATE_HZ)
    : DEFAULT_ARB_CONFIG.updateRateHz;
  return rate / count;
}

/**
 * Returns the highest effective bandwidth (Hz) across active ARB channels so the transient
 * solver sub-stepping resolves sharp QRS R-peaks and 60 Hz powerline hum accurately.
 * @param {object} arbCfg
 * @returns {number}
 */
export function getArbEffectiveBandwidthHz(arbCfg) {
  if (!arbCfg?.running) return 0;
  let maxBw = 0;
  for (const key of ['ao0', 'ao1']) {
    const ch = arbCfg[key];
    if (!ch?.enabled) continue;
    const { count } = getArbChannelSamples(ch);
    if (count === 0) continue;
    const freqHz = getArbChannelFreqHz(arbCfg, key) || 0;
    const id = typeof ch.waveformId === 'string' ? ch.waveformId : '';
    let bw;
    if (id === 'ekg-wander') {
      bw = Math.max(60, 150 * freqHz);
    } else if (id.startsWith('ekg-')) {
      bw = Math.max(60, 50 * freqHz);
    } else if (id === 'ppg-arterial') {
      bw = Math.max(15, 12 * freqHz);
    } else {
      bw = Math.max(10, 10 * freqHz);
    }
    if (bw > maxBw) maxBw = bw;
  }
  return maxBw;
}

/**
 * Parses 1-column voltages OR 2-column (time, voltage) CSV/TSV/whitespace waveform text.
 * Skips blank lines, `#`/`//` comments, and non-numeric header rows; caps at 4096 samples.
 * @param {string} text
 * @param {string} [fileName='custom.csv']
 * @returns {{ ok: true, name: string, samples: Array<number>, count: number, truncated: boolean } | { ok: false, error: string }}
 */
export function parseArbCsvText(text, fileName = 'custom.csv') {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'CSV waveform input is empty.' };
  }

  const lines = text.split(/\r?\n/);
  const samples = [];
  let sawNonNumericLine = false;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // Strip inline comments after '#' or '//' if any
    const hashIdx = line.indexOf('#');
    const slashIdx = line.indexOf('//');
    let commentIdx = -1;
    if (hashIdx >= 0 && slashIdx >= 0) {
      commentIdx = Math.min(hashIdx, slashIdx);
    } else if (hashIdx >= 0) {
      commentIdx = hashIdx;
    } else if (slashIdx >= 0) {
      commentIdx = slashIdx;
    }
    if (commentIdx >= 0) line = line.slice(0, commentIdx).trim();
    if (!line) continue;

    // Split on comma, semicolon, tab, or whitespace
    const tokens = line.split(/[\s,;]+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // Parse 1-column (voltage) or 2-column (time, voltage)
    let vVal;
    if (tokens.length === 1) {
      vVal = Number(tokens[0]);
      if (!Number.isFinite(vVal)) {
        sawNonNumericLine = true;
        continue;
      }
    } else {
      const tVal = Number(tokens[0]);
      const yVal = Number(tokens[1]);
      if (!Number.isFinite(tVal) || !Number.isFinite(yVal)) {
        sawNonNumericLine = true;
        continue;
      }
      vVal = yVal;
    }

    if (samples.length >= ARB_MAX_SAMPLES) {
      truncated = true;
      break;
    }
    samples.push(clamp(vVal, ARB_MIN_VOLT, ARB_MAX_VOLT));
  }

  if (samples.length === 0) {
    return {
      ok: false,
      error: sawNonNumericLine
        ? 'No numeric voltage samples found in CSV/TSV file.'
        : 'CSV waveform input contains no data rows.'
    };
  }

  const cleanName =
    typeof fileName === 'string' && fileName.trim().length > 0 ? fileName.trim() : 'custom.csv';

  return {
    ok: true,
    name: cleanName,
    samples,
    count: samples.length,
    truncated
  };
}
