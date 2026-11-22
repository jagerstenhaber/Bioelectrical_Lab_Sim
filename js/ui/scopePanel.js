/**
 * NI ELVISmx 2-Channel Oscilloscope Soft Front Panel
 * Zero-dependency ES2022+ module implementing the InstrumentPanel contract.
 */

import {
  SCOPE_VOLTS_PER_DIV,
  SCOPE_TIME_PER_DIV,
  formatVoltsPerDiv,
  formatTimePerDiv,
  formatFrequency,
  createDialSpinbox,
  createRunStopFooter
} from './elvismxControls.js';
import {
  clamp,
  computeWaveformMetrics,
  findTriggerIndex
} from '../sim/linearAlgebra.js';

const SCOPE_TAB_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="M5 13 L8.5 13 L10.5 8 L13.5 16 L15.5 11 L19 11" />
  </svg>
`;

const VALID_SOURCES = new Set(['AI0', 'AI1', 'FGEN', 'PROBE']);
const VALID_COUPLINGS = new Set(['DC', 'AC']);
const VALID_TRIG_SOURCES = new Set(['CH0', 'CH1', 'AUTO']);
const VALID_TRIG_SLOPES = new Set(['rising', 'falling']);

const GRID_COLS = 10;
const GRID_ROWS = 8;

/**
 * Default frozen NI ELVISmx Oscilloscope configuration.
 */
export const DEFAULT_SCOPE_CONFIG = Object.freeze({
  running: true,
  timePerDiv: 0.002,
  cursorsOn: false,
  cursor1Frac: 0.25,
  cursor2Frac: 0.65,
  trigger: Object.freeze({ source: 'CH0', slope: 'rising', level: 0 }),
  ch0: Object.freeze({ enabled: true, source: 'AI0', probeHole: null, coupling: 'DC', voltsPerDiv: 1, vPos: 0 }),
  ch1: Object.freeze({ enabled: false, source: 'AI1', probeHole: null, coupling: 'DC', voltsPerDiv: 1, vPos: 0 })
});

function pickNearestStep(val, steps, fallback) {
  if (!Number.isFinite(val) || val <= 0) return fallback;
  let best = steps[0];
  let bestDist = Math.abs(steps[0] - val);
  for (let i = 1; i < steps.length; i++) {
    const dist = Math.abs(steps[i] - val);
    if (dist < bestDist) {
      bestDist = dist;
      best = steps[i];
    }
  }
  return best;
}

function normalizeChannelConfig(raw, defaults) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const source = VALID_SOURCES.has(safe.source) ? safe.source : defaults.source;
  const coupling = VALID_COUPLINGS.has(safe.coupling) ? safe.coupling : defaults.coupling;
  const probeHole =
    typeof safe.probeHole === 'string' && safe.probeHole.trim().length > 0
      ? safe.probeHole.trim()
      : null;
  const voltsPerDiv = pickNearestStep(Number(safe.voltsPerDiv), SCOPE_VOLTS_PER_DIV, defaults.voltsPerDiv);
  const vPos = Number.isFinite(Number(safe.vPos))
    ? clamp(Number(safe.vPos), -4, 4)
    : defaults.vPos;

  return {
    enabled: safe.enabled !== undefined ? Boolean(safe.enabled) : defaults.enabled,
    source,
    probeHole,
    coupling,
    voltsPerDiv,
    vPos
  };
}

/**
 * Returns a fresh, deep-cloned and normalized oscilloscope configuration object.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function createDefaultScopeConfig(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {};
  const rawTrig = safe.trigger && typeof safe.trigger === 'object' ? safe.trigger : {};

  const trigSource = VALID_TRIG_SOURCES.has(rawTrig.source)
    ? rawTrig.source
    : DEFAULT_SCOPE_CONFIG.trigger.source;
  const trigSlope = VALID_TRIG_SLOPES.has(rawTrig.slope)
    ? rawTrig.slope
    : DEFAULT_SCOPE_CONFIG.trigger.slope;
  const trigLevel = Number.isFinite(Number(rawTrig.level))
    ? clamp(Number(rawTrig.level), -15, 15)
    : DEFAULT_SCOPE_CONFIG.trigger.level;

  const cursor1Frac = Number.isFinite(Number(safe.cursor1Frac))
    ? clamp(Number(safe.cursor1Frac), 0, 1)
    : DEFAULT_SCOPE_CONFIG.cursor1Frac;
  const cursor2Frac = Number.isFinite(Number(safe.cursor2Frac))
    ? clamp(Number(safe.cursor2Frac), 0, 1)
    : DEFAULT_SCOPE_CONFIG.cursor2Frac;

  return {
    running: safe.running !== undefined ? Boolean(safe.running) : DEFAULT_SCOPE_CONFIG.running,
    timePerDiv: pickNearestStep(
      Number(safe.timePerDiv),
      SCOPE_TIME_PER_DIV,
      DEFAULT_SCOPE_CONFIG.timePerDiv
    ),
    cursorsOn: safe.cursorsOn !== undefined ? Boolean(safe.cursorsOn) : DEFAULT_SCOPE_CONFIG.cursorsOn,
    cursor1Frac,
    cursor2Frac,
    trigger: {
      source: trigSource,
      slope: trigSlope,
      level: trigLevel
    },
    ch0: normalizeChannelConfig(safe.ch0, DEFAULT_SCOPE_CONFIG.ch0),
    ch1: normalizeChannelConfig(safe.ch1, DEFAULT_SCOPE_CONFIG.ch1)
  };
}

function pickVoltsPerDivForMetrics(metrics, fallback = 1) {
  if (!metrics || typeof metrics !== 'object') return fallback;
  const vpp = Number.isFinite(metrics.vpp) ? Math.max(0, metrics.vpp) : 0;
  const vMin = Number.isFinite(metrics.vMin) ? metrics.vMin : 0;
  const vMax = Number.isFinite(metrics.vMax) ? metrics.vMax : 0;
  const maxAbs = Math.max(Math.abs(vMin), Math.abs(vMax));

  // Target ~4–6 vertical divisions peak-to-peak across the 8-div screen,
  // while keeping DC-offset peaks within ±3.8 divisions.
  let targetVPerDiv = 0;
  if (vpp > 1e-4) {
    targetVPerDiv = Math.max(vpp / 5.0, maxAbs / 3.8);
  } else if (maxAbs > 1e-4) {
    targetVPerDiv = maxAbs / 3.0;
  } else {
    return fallback;
  }

  for (const step of SCOPE_VOLTS_PER_DIV) {
    if (step >= targetVPerDiv - 1e-12) {
      return step;
    }
  }
  return SCOPE_VOLTS_PER_DIV[SCOPE_VOLTS_PER_DIV.length - 1];
}

/**
 * Computes clean 1-2-5 autoscale vertical, horizontal, and trigger settings
 * from active channel waveform metrics and optional FGEN frequency.
 *
 * @param {object} [params]
 * @param {object|null} [params.ch0Metrics]
 * @param {object|null} [params.ch1Metrics]
 * @param {number|null} [params.fgenFreqHz]
 * @returns {{ ch0VoltsPerDiv: number, ch1VoltsPerDiv: number, timePerDiv: number, triggerLevel: number }}
 */
export function computeAutoscale({ ch0Metrics = null, ch1Metrics = null, fgenFreqHz = null } = {}) {
  const ch0VoltsPerDiv = pickVoltsPerDivForMetrics(ch0Metrics, 1);
  const ch1VoltsPerDiv = pickVoltsPerDivForMetrics(ch1Metrics, 1);

  const detectedFreq =
    (Number.isFinite(ch0Metrics?.freqHz) && ch0Metrics.freqHz > 0 ? ch0Metrics.freqHz : null) ||
    (Number.isFinite(ch1Metrics?.freqHz) && ch1Metrics.freqHz > 0 ? ch1Metrics.freqHz : null) ||
    (Number.isFinite(fgenFreqHz) && fgenFreqHz > 0 ? fgenFreqHz : null);

  let timePerDiv = DEFAULT_SCOPE_CONFIG.timePerDiv;
  if (detectedFreq) {
    // 10 horizontal divisions total; target ~2.5 to 3 cycles across full screen
    const targetSpanSec = 2.8 / detectedFreq;
    const idealTimePerDiv = targetSpanSec / GRID_COLS;

    let bestStep = SCOPE_TIME_PER_DIV[0];
    let bestScore = Infinity;
    for (const step of SCOPE_TIME_PER_DIV) {
      const cycles = (step * GRID_COLS) * detectedFreq;
      // Prefer cycles in [2, 4] closest to 3; otherwise nearest log distance
      const inSweetSpot = cycles >= 2.0 && cycles <= 4.0;
      const dist = Math.abs(Math.log10(step / idealTimePerDiv));
      const score = inSweetSpot ? dist : dist + 10;
      if (score < bestScore) {
        bestScore = score;
        bestStep = step;
      }
    }
    timePerDiv = bestStep;
  }

  const trigMetrics =
    (ch0Metrics && Number.isFinite(ch0Metrics.vpp) && ch0Metrics.vpp > 1e-4 ? ch0Metrics : null) ||
    (ch1Metrics && Number.isFinite(ch1Metrics.vpp) && ch1Metrics.vpp > 1e-4 ? ch1Metrics : null) ||
    ch0Metrics ||
    ch1Metrics;

  let triggerLevel = 0;
  if (trigMetrics && Number.isFinite(trigMetrics.vAvg)) {
    triggerLevel = clamp(Number(trigMetrics.vAvg.toFixed(2)), -15, 15);
  }

  return {
    ch0VoltsPerDiv,
    ch1VoltsPerDiv,
    timePerDiv,
    triggerLevel
  };
}

/**
 * Formats cursor time delta ΔT and reciprocal frequency 1/ΔT.
 *
 * @param {number} dtSec
 * @returns {{ dtText: string, freqText: string }}
 */
export function formatCursorDelta(dtSec) {
  if (typeof dtSec !== 'number' || !Number.isFinite(dtSec)) {
    return { dtText: '---', freqText: '---' };
  }
  const absDt = Math.abs(dtSec);
  if (absDt < 1e-12) {
    return { dtText: '0.00 ms', freqText: '---' };
  }

  let dtText;
  if (absDt < 1e-6 - 1e-15) {
    dtText = `${(absDt * 1e9).toFixed(1)} ns`;
  } else if (absDt < 1e-3 - 1e-12) {
    dtText = `${(absDt * 1e6).toFixed(0)} µs`;
  } else if (absDt < 1 - 1e-9) {
    dtText = `${(absDt * 1e3).toFixed(2)} ms`;
  } else {
    dtText = `${absDt.toFixed(3)} s`;
  }

  const invHz = 1 / absDt;
  let freqText;
  if (!Number.isFinite(invHz) || invHz <= 0) {
    freqText = '---';
  } else if (invHz >= 1e6) {
    freqText = `${(invHz / 1e6).toFixed(2)} MHz`;
  } else if (invHz >= 1e3) {
    freqText = `${(invHz / 1e3).toFixed(2)} kHz`;
  } else {
    freqText = `${invHz.toFixed(1)} Hz`;
  }

  return { dtText, freqText };
}

function formatMetricVoltage(volts) {
  if (typeof volts !== 'number' || !Number.isFinite(volts)) return '---';
  const absV = Math.abs(volts);
  if (absV < 1e-4) return '0.00 V';
  if (absV < 1) return `${(volts * 1000).toFixed(1)} mV`;
  return `${volts.toFixed(2)} V`;
}

function formatSignedVolts(volts) {
  if (typeof volts !== 'number' || !Number.isFinite(volts)) return '---';
  if (Math.abs(volts) < 5e-4) return '+0.00 V';
  const sign = volts >= 0 ? '+' : '-';
  const absV = Math.abs(volts);
  if (absV < 1) return `${sign}${(absV * 1000).toFixed(0)} mV`;
  return `${sign}${absV.toFixed(2)} V`;
}

function formatCursorTime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '---';
  const absS = Math.abs(sec);
  if (absS < 1e-9) return '0.00 ms';
  if (absS < 1e-3) return `${(sec * 1e6).toFixed(0)} µs`;
  if (absS < 1) return `${(sec * 1e3).toFixed(2)} ms`;
  return `${sec.toFixed(3)} s`;
}

function cloneConfig(cfg) {
  return createDefaultScopeConfig(cfg);
}

function sampleAtTime(samples, tSec, dt) {
  if (!samples || samples.length === 0 || !Number.isFinite(dt) || dt <= 0) return null;
  const rawIdx = tSec / dt;
  if (rawIdx < 0 || rawIdx > samples.length - 1 + 0.25) return null;
  const idx = clamp(rawIdx, 0, samples.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(samples.length - 1, lo + 1);
  const alpha = idx - lo;
  const a = samples[lo];
  const b = samples[hi];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + (b - a) * alpha;
}

function prepareDisplayChannel(rawTrace, chConfig) {
  if (!chConfig?.enabled) {
    return {
      enabled: false,
      valid: false,
      samples: null,
      rawSamples: null,
      metrics: null,
      reason: null
    };
  }
  if (!rawTrace || !rawTrace.valid || !rawTrace.samples || rawTrace.samples.length === 0) {
    return {
      enabled: true,
      valid: false,
      samples: null,
      rawSamples: null,
      metrics: null,
      reason: rawTrace?.reason || 'No signal available'
    };
  }
  return {
    enabled: true,
    valid: true,
    samples: rawTrace.samples,
    rawSamples: rawTrace.samples,
    metrics: null,
    reason: null
  };
}

/**
 * Creates the Dark-Adapted NI ELVISmx 2-Channel Oscilloscope instrument panel.
 *
 * @param {object} [options]
 * @param {object} [options.callbacks]
 * @returns {object} InstrumentPanel implementation
 */
export function createScopeInstrument({ callbacks = {} } = {}) {
  const cb = {
    onConfigChange: callbacks.onConfigChange || (() => {}),
    onStartScopeProbe: callbacks.onStartScopeProbe || (() => {}),
    onAutoscale: callbacks.onAutoscale || (() => {}),
    onStartFgen: callbacks.onStartFgen || (() => {}),
    onPowerToggle: callbacks.onPowerToggle || (() => {})
  };

  let mountContainer = null;
  let ac = null;
  let resizeObserver = null;
  let rafId = null;
  let els = null;
  let runStopFooter = null;
  let dials = null;

  let config = createDefaultScopeConfig();
  let lastSnapshot = null;
  let frozenCapture = null;
  let activeDragCursor = null; // null | 1 | 2
  let canvasMetrics = { cssW: 420, cssH: 240, dpr: 1 };

  function buildMarkup(containerEl) {
    containerEl.innerHTML = `
      <section class="elvis-sfp elvis-scope" aria-label="NI ELVISmx 2-Channel Oscilloscope">
        <header class="elvis-sfp-header">
          <div class="elvis-sfp-title-wrap">
            <span class="elvis-sfp-badge">SCOPE</span>
            <h3 class="elvis-sfp-title">Oscilloscope</h3>
          </div>
          <span class="elvis-sfp-badge">NI ELVISmx</span>
        </header>

        <div class="elvis-sfp-body">
          <div class="elvis-scope-layout">
            <div class="elvis-scope-crt">
              <div class="elvis-screen-meta">
                <span class="elvis-run-pill is-running" data-scope-run-pill>● RUNNING</span>
                <span class="elvis-scope-status-text" data-scope-status>10×8 div</span>
                <div class="elvis-crt-quick-actions">
                  <button type="button" class="elvis-crt-btn" data-scope-quick-cursors aria-pressed="false" title="Toggle C1/C2 Cursors">Cursors</button>
                  <button type="button" class="elvis-crt-btn is-accent" data-scope-quick-autoscale title="Auto-scale Timebase &amp; Volts/Div">Autoscale</button>
                </div>
              </div>

              <div class="elvis-scope-canvas-wrap">
                <canvas class="elvis-scope-canvas" data-scope-canvas></canvas>
                <div class="elvis-scope-hint-pill" data-scope-hint-pill hidden>Signal slower than Time/Div — click Autoscale</div>
                <div class="elvis-scope-overlay" data-scope-overlay hidden>
                  <span class="elvis-scope-overlay-msg" data-scope-overlay-msg></span>
                  <div class="elvis-scope-overlay-actions">
                    <button type="button" class="elvis-inline-btn" data-scope-power-btn hidden>⚡ Turn Power ON</button>
                    <button type="button" class="elvis-inline-btn" data-scope-fgen-btn hidden>▶ Start FGEN</button>
                  </div>
                </div>
              </div>

              <div class="elvis-scope-readout-bar" data-scope-readout-bar>
                <div class="elvis-scope-meas-row">
                  <span class="elvis-scope-ch-tag is-ch0">CH 0</span>
                  <span class="elvis-scope-meas-vals" data-scope-meas-0>Vpp: --- | RMS: --- | Freq: ---</span>
                </div>
                <div class="elvis-scope-meas-row">
                  <span class="elvis-scope-ch-tag is-ch1">CH 1</span>
                  <span class="elvis-scope-meas-vals" data-scope-meas-1>OFF</span>
                </div>
                <div class="elvis-scope-cursor-row" data-scope-cursor-row hidden>
                  <span data-scope-cursor-vals>C1: --- | C2: --- | ΔT: --- | 1/ΔT: --- | ΔV: ---</span>
                </div>
              </div>
            </div>

            <div class="elvis-scope-controls">
              <div class="elvis-scope-ch-grid">
                <fieldset class="elvis-group elvis-scope-ch-box">
                  <legend class="elvis-group-legend">
                    <span class="elvis-ch-dot-0" aria-hidden="true"></span>
                    <span>Channel 0 Settings</span>
                  </legend>

                  <div class="elvis-scope-ch-top">
                    <label class="elvis-check-label">
                      <input type="checkbox" data-scope-ch-enabled="0" checked />
                      <span>Enabled</span>
                    </label>
                    <select class="elvis-select-compact" data-scope-ch-coupling="0" aria-label="CH 0 Coupling">
                      <option value="DC">DC</option>
                      <option value="AC">AC</option>
                    </select>
                  </div>

                  <div class="elvis-scope-source-row">
                    <select class="elvis-select-compact" data-scope-ch-source="0" aria-label="CH 0 Source">
                      <option value="AI0">ELVIS AI 0</option>
                      <option value="AI1">ELVIS AI 1</option>
                      <option value="FGEN">ELVIS FGEN</option>
                      <option value="PROBE">Board Probe</option>
                    </select>
                    <button type="button" class="elvis-pick-btn" data-scope-ch-pick="0" hidden>📌 Pick</button>
                  </div>

                  <div class="elvis-dial-grid elvis-scope-dial-pair">
                    <div data-scope-slot="ch0-vdiv"></div>
                    <div data-scope-slot="ch0-vpos"></div>
                  </div>
                </fieldset>

                <fieldset class="elvis-group elvis-scope-ch-box">
                  <legend class="elvis-group-legend">
                    <span class="elvis-ch-dot-1" aria-hidden="true"></span>
                    <span>Channel 1 Settings</span>
                  </legend>

                  <div class="elvis-scope-ch-top">
                    <label class="elvis-check-label">
                      <input type="checkbox" data-scope-ch-enabled="1" />
                      <span>Enabled</span>
                    </label>
                    <select class="elvis-select-compact" data-scope-ch-coupling="1" aria-label="CH 1 Coupling">
                      <option value="DC">DC</option>
                      <option value="AC">AC</option>
                    </select>
                  </div>

                  <div class="elvis-scope-source-row">
                    <select class="elvis-select-compact" data-scope-ch-source="1" aria-label="CH 1 Source">
                      <option value="AI0">ELVIS AI 0</option>
                      <option value="AI1" selected>ELVIS AI 1</option>
                      <option value="FGEN">ELVIS FGEN</option>
                      <option value="PROBE">Board Probe</option>
                    </select>
                    <button type="button" class="elvis-pick-btn" data-scope-ch-pick="1" hidden>📌 Pick</button>
                  </div>

                  <div class="elvis-dial-grid elvis-scope-dial-pair">
                    <div data-scope-slot="ch1-vdiv"></div>
                    <div data-scope-slot="ch1-vpos"></div>
                  </div>
                </fieldset>
              </div>

              <div class="elvis-scope-tb-trig-grid">
                <fieldset class="elvis-group">
                  <legend class="elvis-group-legend">Timebase</legend>
                  <div class="elvis-scope-tb-inner">
                    <div data-scope-slot="timebase"></div>
                  </div>
                </fieldset>

                <fieldset class="elvis-group">
                  <legend class="elvis-group-legend">Trigger</legend>
                  <div class="elvis-scope-trig-inner">
                    <div class="elvis-scope-trig-fields">
                      <label class="elvis-field-stack">
                        <span>Source</span>
                        <select class="elvis-select-compact" data-scope-trig-source>
                          <option value="CH0">CH 0</option>
                          <option value="CH1">CH 1</option>
                          <option value="AUTO">AUTO</option>
                        </select>
                      </label>
                      <label class="elvis-field-stack">
                        <span>Slope</span>
                        <select class="elvis-select-compact" data-scope-trig-slope>
                          <option value="rising">↗ Rising</option>
                          <option value="falling">↘ Falling</option>
                        </select>
                      </label>
                    </div>
                    <div data-scope-slot="trig-level"></div>
                  </div>
                </fieldset>
              </div>

              <fieldset class="elvis-group">
                <legend class="elvis-group-legend">Acquisition &amp; Cursors</legend>
                <div class="elvis-scope-footer-bar">
                  <label class="elvis-check-label">
                    <input type="checkbox" data-scope-cursors-on />
                    <span>Cursors On</span>
                  </label>
                  <button type="button" class="elvis-autoscale-btn" data-scope-autoscale>Autoscale</button>
                </div>
                <div data-scope-runstop-slot></div>
              </fieldset>
            </div>
          </div>
        </div>
      </section>
    `;

    dials = {
      ch0Vdiv: createDialSpinbox({
        label: 'Volts/Div',
        value: config.ch0.voltsPerDiv,
        options: SCOPE_VOLTS_PER_DIV,
        formatOption: formatVoltsPerDiv,
        onChange: (val) => updateConfig((draft) => { draft.ch0.voltsPerDiv = val; })
      }),
      ch0Vpos: createDialSpinbox({
        label: 'V-Pos',
        value: config.ch0.vPos,
        min: -4,
        max: 4,
        step: 0.25,
        unit: 'div',
        onChange: (val) => updateConfig((draft) => { draft.ch0.vPos = val; }, { affectsCircuit: false })
      }),
      ch1Vdiv: createDialSpinbox({
        label: 'Volts/Div',
        value: config.ch1.voltsPerDiv,
        options: SCOPE_VOLTS_PER_DIV,
        formatOption: formatVoltsPerDiv,
        onChange: (val) => updateConfig((draft) => { draft.ch1.voltsPerDiv = val; })
      }),
      ch1Vpos: createDialSpinbox({
        label: 'V-Pos',
        value: config.ch1.vPos,
        min: -4,
        max: 4,
        step: 0.25,
        unit: 'div',
        onChange: (val) => updateConfig((draft) => { draft.ch1.vPos = val; }, { affectsCircuit: false })
      }),
      timebase: createDialSpinbox({
        label: 'Time/Div',
        value: config.timePerDiv,
        options: SCOPE_TIME_PER_DIV,
        formatOption: formatTimePerDiv,
        onChange: (val) => updateConfig((draft) => { draft.timePerDiv = val; })
      }),
      trigLevel: createDialSpinbox({
        label: 'Level (V)',
        value: config.trigger.level,
        min: -15,
        max: 15,
        step: 0.1,
        unit: 'V',
        onChange: (val) => updateConfig((draft) => { draft.trigger.level = val; })
      })
    };

    containerEl.querySelector('[data-scope-slot="ch0-vdiv"]').replaceWith(dials.ch0Vdiv.el);
    containerEl.querySelector('[data-scope-slot="ch0-vpos"]').replaceWith(dials.ch0Vpos.el);
    containerEl.querySelector('[data-scope-slot="ch1-vdiv"]').replaceWith(dials.ch1Vdiv.el);
    containerEl.querySelector('[data-scope-slot="ch1-vpos"]').replaceWith(dials.ch1Vpos.el);
    containerEl.querySelector('[data-scope-slot="timebase"]').replaceWith(dials.timebase.el);
    containerEl.querySelector('[data-scope-slot="trig-level"]').replaceWith(dials.trigLevel.el);

    runStopFooter = createRunStopFooter({
      onRun: () => {
        if (config.running) return;
        updateConfig((draft) => { draft.running = true; });
      },
      onStop: () => {
        if (!config.running) return;
        updateConfig((draft) => { draft.running = false; }, { affectsCircuit: false });
      }
    });
    containerEl.querySelector('[data-scope-runstop-slot]').replaceWith(runStopFooter.el);

    els = {
      canvas: containerEl.querySelector('[data-scope-canvas]'),
      runPill: containerEl.querySelector('[data-scope-run-pill]'),
      status: containerEl.querySelector('[data-scope-status]'),
      quickCursorsBtn: containerEl.querySelector('[data-scope-quick-cursors]'),
      quickAutoscaleBtn: containerEl.querySelector('[data-scope-quick-autoscale]'),
      hintPill: containerEl.querySelector('[data-scope-hint-pill]'),
      overlay: containerEl.querySelector('[data-scope-overlay]'),
      overlayMsg: containerEl.querySelector('[data-scope-overlay-msg]'),
      powerBtn: containerEl.querySelector('[data-scope-power-btn]'),
      fgenBtn: containerEl.querySelector('[data-scope-fgen-btn]'),
      meas0: containerEl.querySelector('[data-scope-meas-0]'),
      meas1: containerEl.querySelector('[data-scope-meas-1]'),
      cursorRow: containerEl.querySelector('[data-scope-cursor-row]'),
      cursorVals: containerEl.querySelector('[data-scope-cursor-vals]'),
      ch0Enabled: containerEl.querySelector('[data-scope-ch-enabled="0"]'),
      ch1Enabled: containerEl.querySelector('[data-scope-ch-enabled="1"]'),
      ch0Coupling: containerEl.querySelector('[data-scope-ch-coupling="0"]'),
      ch1Coupling: containerEl.querySelector('[data-scope-ch-coupling="1"]'),
      ch0Source: containerEl.querySelector('[data-scope-ch-source="0"]'),
      ch1Source: containerEl.querySelector('[data-scope-ch-source="1"]'),
      ch0Pick: containerEl.querySelector('[data-scope-ch-pick="0"]'),
      ch1Pick: containerEl.querySelector('[data-scope-ch-pick="1"]'),
      trigSource: containerEl.querySelector('[data-scope-trig-source]'),
      trigSlope: containerEl.querySelector('[data-scope-trig-slope]'),
      cursorsOn: containerEl.querySelector('[data-scope-cursors-on]'),
      autoscaleBtn: containerEl.querySelector('[data-scope-autoscale]')
    };
  }

  function resizeCanvasIfNeeded() {
    if (!els?.canvas) return;
    const rect = els.canvas.getBoundingClientRect();
    const cssW = Math.max(240, Math.round(rect.width || 420));
    const cssH = Math.max(170, Math.round(rect.height || 235));
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(2.5, window.devicePixelRatio) : 1;

    if (
      canvasMetrics.cssW !== cssW ||
      canvasMetrics.cssH !== cssH ||
      canvasMetrics.dpr !== dpr ||
      els.canvas.width !== Math.round(cssW * dpr) ||
      els.canvas.height !== Math.round(cssH * dpr)
    ) {
      canvasMetrics = { cssW, cssH, dpr };
      els.canvas.width = Math.round(cssW * dpr);
      els.canvas.height = Math.round(cssH * dpr);
    }
  }

  function syncControlsFromConfig(activeProbeTarget = null) {
    if (!els || !dials) return;

    els.runPill.classList.toggle('is-running', config.running);
    els.runPill.classList.toggle('is-hold', !config.running);
    els.runPill.textContent = config.running ? '● RUNNING' : '■ STOPPED';
    runStopFooter.setRunning(config.running);

    els.ch0Enabled.checked = config.ch0.enabled;
    els.ch1Enabled.checked = config.ch1.enabled;
    els.ch0Coupling.value = config.ch0.coupling;
    els.ch1Coupling.value = config.ch1.coupling;
    els.ch0Source.value = config.ch0.source;
    els.ch1Source.value = config.ch1.source;

    const updatePickBtn = (btn, chCfg, chKey) => {
      const isProbe = chCfg.source === 'PROBE';
      btn.hidden = !isProbe;
      btn.textContent = chCfg.probeHole ? `📌 ${chCfg.probeHole}` : '📌 Pick';
      btn.classList.toggle('is-probing', activeProbeTarget === chKey);
    };
    updatePickBtn(els.ch0Pick, config.ch0, 'scope-ch0');
    updatePickBtn(els.ch1Pick, config.ch1, 'scope-ch1');

    dials.ch0Vdiv.setValue(config.ch0.voltsPerDiv);
    dials.ch0Vpos.setValue(config.ch0.vPos);
    dials.ch1Vdiv.setValue(config.ch1.voltsPerDiv);
    dials.ch1Vpos.setValue(config.ch1.vPos);
    dials.timebase.setValue(config.timePerDiv);
    dials.trigLevel.setValue(config.trigger.level);

    dials.ch0Vdiv.setDisabled(!config.ch0.enabled);
    dials.ch0Vpos.setDisabled(!config.ch0.enabled);
    dials.ch1Vdiv.setDisabled(!config.ch1.enabled);
    dials.ch1Vpos.setDisabled(!config.ch1.enabled);
    els.ch0Coupling.disabled = !config.ch0.enabled;
    els.ch1Coupling.disabled = !config.ch1.enabled;
    els.ch0Source.disabled = !config.ch0.enabled;
    els.ch1Source.disabled = !config.ch1.enabled;

    els.trigSource.value = config.trigger.source;
    els.trigSlope.value = config.trigger.slope;
    dials.trigLevel.setDisabled(config.trigger.source === 'AUTO');
    els.cursorsOn.checked = config.cursorsOn;
    if (els.quickCursorsBtn) {
      els.quickCursorsBtn.classList.toggle('is-active', config.cursorsOn);
      els.quickCursorsBtn.setAttribute('aria-pressed', String(config.cursorsOn));
    }
  }

  function buildCaptureFromSnapshot(snapshot) {
    const powered = snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true;
    const dt = Number.isFinite(snapshot?.dt) && snapshot.dt > 0 ? snapshot.dt : (config.timePerDiv * GRID_COLS) / 400;
    const ch0 = prepareDisplayChannel(snapshot?.ch0, config.ch0);
    const ch1 = prepareDisplayChannel(snapshot?.ch1, config.ch1);

    if (ch0.valid) {
      ch0.metrics = computeWaveformMetrics(ch0.rawSamples, dt);
    }
    if (ch1.valid) {
      ch1.metrics = computeWaveformMetrics(ch1.rawSamples, dt);
    }

    return {
      powered,
      dt,
      totalDurationSec: Number.isFinite(snapshot?.totalDurationSec) && snapshot.totalDurationSec > 0
        ? snapshot.totalDurationSec
        : config.timePerDiv * GRID_COLS,
      fgenEnabled: Boolean(
        snapshot?.fgenEnabled ?? (Number.isFinite(snapshot?.fgenFreqHz) && snapshot.fgenFreqHz > 0)
      ),
      fgenNotRunningHint: Boolean(snapshot?.fgenNotRunningHint),
      ch0,
      ch1
    };
  }

  function applyCouplingAndWindow(chCapture, chConfig, totalSamples, trigStartIdx, windowSampleCount) {
    if (!chCapture || !chCapture.valid || !chCapture.rawSamples) {
      return {
        valid: false,
        samples: null,
        metrics: chCapture?.metrics || null,
        reason: chCapture?.reason || null
      };
    }

    const src = chCapture.rawSamples;
    const vAvg = chCapture.metrics?.vAvg ?? 0;
    const useAc = chConfig?.coupling === 'AC';

    const outLen = Math.max(2, Math.min(windowSampleCount, src.length));
    const sliced = new Float64Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.min(src.length - 1, trigStartIdx + i);
      sliced[i] = useAc ? src[idx] - vAvg : src[idx];
    }

    return {
      valid: true,
      samples: sliced,
      metrics: chCapture.metrics,
      reason: null
    };
  }

  function getTriggerOffsetIndex(capture, windowSamples) {
    const trigSrc = config.trigger.source;
    if (trigSrc === 'AUTO') return 0;

    const ch = trigSrc === 'CH1' ? capture.ch1 : capture.ch0;
    const chCfg = trigSrc === 'CH1' ? config.ch1 : config.ch0;
    if (!ch?.valid || !ch.rawSamples || ch.rawSamples.length < 4) return 0;

    let searchSamples = ch.rawSamples;
    if (chCfg.coupling === 'AC' && ch.metrics) {
      const avg = ch.metrics.vAvg;
      searchSamples = ch.rawSamples.map((v) => v - avg);
    }

    const maxStart = Math.max(1, searchSamples.length - windowSamples);
    const trigIdx = findTriggerIndex(searchSamples, {
      level: config.trigger.level,
      slope: config.trigger.slope,
      startIdx: 0,
      endIdx: maxStart
    });

    return trigIdx > 0 ? trigIdx : 0;
  }

  function renderMeasurementsAndNotices(capture, viewCh0, viewCh1, sampleDt) {
    if (!els) return;

    const formatChLine = (chCfg, chState) => {
      if (!chCfg.enabled) return 'OFF';
      if (!chState.valid || !chState.metrics) {
        return chState.reason || 'NO SIGNAL';
      }
      const m = chState.metrics;
      const rmsVal = chCfg.coupling === 'AC' ? m.vRmsAc : m.vRms;
      const freqStr = m.freqHz ? formatFrequency(m.freqHz) : 'DC';
      return `Vpp: ${formatMetricVoltage(m.vpp)}  |  RMS: ${formatMetricVoltage(rmsVal)}  |  Freq: ${freqStr}`;
    };

    els.meas0.textContent = formatChLine(config.ch0, viewCh0);
    els.meas1.textContent = formatChLine(config.ch1, viewCh1);

    // Status line in top bezel
    const reasons = [];
    if (config.ch0.enabled && !capture.ch0.valid && capture.ch0.reason) {
      reasons.push(`CH0: ${capture.ch0.reason}`);
    }
    if (config.ch1.enabled && !capture.ch1.valid && capture.ch1.reason) {
      reasons.push(`CH1: ${capture.ch1.reason}`);
    }
    const tbLabel = `${formatTimePerDiv(config.timePerDiv)}/div`;
    els.status.textContent = reasons.length > 0 ? `${tbLabel} · ${reasons[0]}` : `${tbLabel} · 10×8 div`;

    // Non-blocking hint when active FGEN signal is slower than current Time/Div
    const isSlowSignal = (ch) =>
      Boolean(ch?.valid && ch.metrics && ch.metrics.freqHz === null && ch.metrics.vpp > 0.05);
    const showSlowHint = Boolean(
      capture.fgenEnabled &&
        capture.powered &&
        (isSlowSignal(viewCh0) || isSlowSignal(viewCh1))
    );
    if (els.hintPill) {
      els.hintPill.hidden = !showSlowHint;
    }

    // Educational Overlay
    if (!capture.powered) {
      els.overlay.hidden = false;
      els.overlayMsg.textContent = 'POWER OFF — Turn Lab Power ON';
      els.powerBtn.hidden = false;
      els.fgenBtn.hidden = true;
    } else if (capture.fgenNotRunningHint) {
      els.overlay.hidden = false;
      els.overlayMsg.textContent = 'Function Generator is Stopped';
      els.powerBtn.hidden = true;
      els.fgenBtn.hidden = false;
    } else {
      els.overlay.hidden = true;
      els.powerBtn.hidden = true;
      els.fgenBtn.hidden = true;
    }

    // Cursor readouts
    els.cursorRow.hidden = !config.cursorsOn;
    if (config.cursorsOn) {
      const spanSec = config.timePerDiv * GRID_COLS;
      const t1 = config.cursor1Frac * spanSec;
      const t2 = config.cursor2Frac * spanSec;
      const { dtText, freqText } = formatCursorDelta(t2 - t1);

      const primarySamples = viewCh0.valid
        ? viewCh0.samples
        : viewCh1.valid
        ? viewCh1.samples
        : null;
      const primaryTag = viewCh0.valid ? 'CH0' : viewCh1.valid ? 'CH1' : '';

      let dvText = '---';
      if (primarySamples) {
        const v1 = sampleAtTime(primarySamples, t1, sampleDt);
        const v2 = sampleAtTime(primarySamples, t2, sampleDt);
        if (v1 !== null && v2 !== null) {
          dvText = `${formatSignedVolts(v2 - v1)} (${primaryTag})`;
        }
      }

      els.cursorVals.textContent =
        `C1: ${formatCursorTime(t1)}  |  C2: ${formatCursorTime(t2)}  |  ΔT: ${dtText}  |  1/ΔT: ${freqText}  |  ΔV: ${dvText}`;
    }
  }

  function drawScopeCanvas(capture) {
    if (!els?.canvas) return;
    resizeCanvasIfNeeded();

    const ctx = els.canvas.getContext('2d');
    if (!ctx) return;

    const { cssW, cssH, dpr } = canvasMetrics;
    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Pitch-black CRT background
    ctx.fillStyle = '#030806';
    ctx.fillRect(0, 0, cssW, cssH);

    // Subtle radial CRT phosphor glow
    const grad = ctx.createRadialGradient(cssW * 0.5, cssH * 0.5, 10, cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.7);
    grad.addColorStop(0, 'rgba(20, 83, 45, 0.16)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    const padX = 8;
    const padY = 8;
    const plotW = cssW - padX * 2;
    const plotH = cssH - padY * 2;
    const centerX = padX + plotW / 2;
    const centerY = padY + plotH / 2;

    // 2. 10x8 Dark-green graticule
    ctx.strokeStyle = '#14532d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= GRID_COLS; c++) {
      const x = Math.round(padX + (c / GRID_COLS) * plotW) + 0.5;
      ctx.moveTo(x, padY);
      ctx.lineTo(x, padY + plotH);
    }
    for (let r = 0; r <= GRID_ROWS; r++) {
      const y = Math.round(padY + (r / GRID_ROWS) * plotH) + 0.5;
      ctx.moveTo(padX, y);
      ctx.lineTo(padX + plotW, y);
    }
    ctx.stroke();

    // Subtle center crosshairs + subdivision ticks
    ctx.strokeStyle = '#166534';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(padX, Math.round(centerY) + 0.5);
    ctx.lineTo(padX + plotW, Math.round(centerY) + 0.5);
    ctx.moveTo(Math.round(centerX) + 0.5, padY);
    ctx.lineTo(Math.round(centerX) + 0.5, padY + plotH);

    // 5 sub-ticks per division along center axes
    const subX = (plotW / GRID_COLS) / 5;
    const subY = (plotH / GRID_ROWS) / 5;
    for (let i = 0; i <= GRID_COLS * 5; i++) {
      const x = padX + i * subX;
      ctx.moveTo(x, centerY - 3);
      ctx.lineTo(x, centerY + 3);
    }
    for (let i = 0; i <= GRID_ROWS * 5; i++) {
      const y = padY + i * subY;
      ctx.moveTo(centerX - 3, y);
      ctx.lineTo(centerX + 3, y);
    }
    ctx.stroke();

    const pxPerDivY = plotH / GRID_ROWS;
    const activeCapture = capture || {
      powered: true,
      dt: (config.timePerDiv * GRID_COLS) / 400,
      totalDurationSec: config.timePerDiv * GRID_COLS,
      fgenNotRunningHint: false,
      ch0: { enabled: config.ch0.enabled, valid: false, rawSamples: null, metrics: null, reason: null },
      ch1: { enabled: config.ch1.enabled, valid: false, rawSamples: null, metrics: null, reason: null }
    };

    const windowDuration = config.timePerDiv * GRID_COLS;
    const windowSamples = Math.max(
      10,
      Math.round(windowDuration / Math.max(1e-9, activeCapture.dt || windowDuration / 400))
    );
    const trigIdx = getTriggerOffsetIndex(activeCapture, windowSamples);

    const viewCh0 = {
      ...activeCapture.ch0,
      ...applyCouplingAndWindow(activeCapture.ch0, config.ch0, windowSamples, trigIdx, windowSamples)
    };
    const viewCh1 = {
      ...activeCapture.ch1,
      ...applyCouplingAndWindow(activeCapture.ch1, config.ch1, windowSamples, trigIdx, windowSamples)
    };

    // Helper to convert voltage -> canvas Y
    const voltsToY = (v, voltsPerDiv, vPosDiv) => {
      const divOffset = v / voltsPerDiv + vPosDiv;
      return centerY - divOffset * pxPerDivY;
    };

    // Draw ground reference markers on left edge for enabled channels
    const drawGndMarker = (vPosDiv, color, label) => {
      const gy = clamp(centerY - vPosDiv * pxPerDivY, padY + 6, padY + plotH - 6);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(padX, gy);
      ctx.lineTo(padX + 7, gy - 4);
      ctx.lineTo(padX + 7, gy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.font = 'bold 9px monospace';
      ctx.fillText(label, padX + 9, gy + 3);
    };

    // 3. Draw Waveforms (Clipped to graticule)
    ctx.save();
    ctx.beginPath();
    ctx.rect(padX, padY, plotW, plotH);
    ctx.clip();

    const sampleDt = Math.max(1e-9, activeCapture.dt || (config.timePerDiv * GRID_COLS) / 400);
    const drawTrace = (samples, chCfg, strokeColor, glowColor) => {
      if (!samples || samples.length < 2) return;
      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.6;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 6;
      ctx.beginPath();

      const n = samples.length;
      const safeWindowDuration = Math.max(1e-9, windowDuration);
      for (let i = 0; i < n; i++) {
        const x = padX + Math.min(plotW, ((i * sampleDt) / safeWindowDuration) * plotW);
        const y = voltsToY(samples[i], chCfg.voltsPerDiv, chCfg.vPos);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };

    if (config.ch0.enabled && viewCh0.valid) {
      drawTrace(viewCh0.samples, config.ch0, '#22ff66', 'rgba(34, 255, 102, 0.45)');
    }
    if (config.ch1.enabled && viewCh1.valid) {
      drawTrace(viewCh1.samples, config.ch1, '#facc15', 'rgba(250, 204, 21, 0.45)');
    }

    // 4. Trigger level dashed reference & right-edge tick
    if (config.trigger.source !== 'AUTO') {
      const trigCfg = config.trigger.source === 'CH1' ? config.ch1 : config.ch0;
      const trigY = voltsToY(config.trigger.level, trigCfg.voltsPerDiv, trigCfg.vPos);
      if (trigY >= padY - 2 && trigY <= padY + plotH + 2) {
        const clampedTrigY = clamp(trigY, padY + 2, padY + plotH - 2);
        ctx.save();
        ctx.strokeStyle = 'rgba(251, 146, 60, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padX, clampedTrigY);
        ctx.lineTo(padX + plotW, clampedTrigY);
        ctx.stroke();
        ctx.restore();

        // Solid orange trigger arrow on right edge
        ctx.fillStyle = '#fb923c';
        ctx.beginPath();
        ctx.moveTo(padX + plotW, clampedTrigY);
        ctx.lineTo(padX + plotW - 8, clampedTrigY - 4.5);
        ctx.lineTo(padX + plotW - 8, clampedTrigY + 4.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 5. Draggable Vertical Cursors C1 & C2
    if (config.cursorsOn) {
      const drawCursor = (frac, label, color) => {
        const x = padX + clamp(frac, 0, 1) * plotW;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padY);
        ctx.lineTo(x, padY + plotH);
        ctx.stroke();
        ctx.restore();

        // Top pill handle
        const tagW = 22;
        const tagH = 14;
        const tagX = clamp(x - tagW / 2, padX + 2, padX + plotW - tagW - 2);
        ctx.fillStyle = color;
        ctx.fillRect(tagX, padY + 2, tagW, tagH);
        ctx.fillStyle = '#041016';
        ctx.font = 'bold 9.5px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, tagX + tagW / 2, padY + 12);
      };

      drawCursor(config.cursor1Frac, 'C1', '#22f3ff');
      drawCursor(config.cursor2Frac, 'C2', '#f472b6');
    }

    ctx.restore(); // end clip

    if (config.ch0.enabled) drawGndMarker(config.ch0.vPos, '#22ff66', '0');
    if (config.ch1.enabled) drawGndMarker(config.ch1.vPos, '#facc15', '1');

    ctx.restore(); // end dpr scale

    renderMeasurementsAndNotices(activeCapture, viewCh0, viewCh1, sampleDt);
  }

  function redrawCurrentState() {
    if (!frozenCapture && lastSnapshot) {
      frozenCapture = buildCaptureFromSnapshot(lastSnapshot);
    }
    drawScopeCanvas(frozenCapture);
  }

  function updateConfig(mutator, { notify = true, affectsCircuit = true } = {}) {
    const prevRunning = config.running;
    const draft = cloneConfig(config);
    mutator(draft);
    config = createDefaultScopeConfig(draft);

    if (prevRunning && !config.running && lastSnapshot) {
      frozenCapture = buildCaptureFromSnapshot(lastSnapshot);
    } else if (!prevRunning && config.running && lastSnapshot) {
      frozenCapture = buildCaptureFromSnapshot(lastSnapshot);
    }

    syncControlsFromConfig(lastSnapshot?.activeProbeTarget || null);
    redrawCurrentState();

    if (notify) {
      cb.onConfigChange(cloneConfig(config), { affectsCircuit });
    }
  }

  function getCanvasPointerFrac(clientX) {
    if (!els?.canvas) return 0.5;
    const rect = els.canvas.getBoundingClientRect();
    const padX = 8;
    const plotW = Math.max(1, rect.width - padX * 2);
    return clamp((clientX - rect.left - padX) / plotW, 0, 1);
  }

  function bindEvents() {
    ac = new AbortController();
    const { signal } = ac;

    const bindChannelControls = (idx, enabledEl, couplingEl, sourceEl, pickEl) => {
      const chKey = idx === 0 ? 'ch0' : 'ch1';
      enabledEl.addEventListener('change', () => {
        updateConfig((draft) => { draft[chKey].enabled = enabledEl.checked; });
      }, { signal });

      couplingEl.addEventListener('change', () => {
        updateConfig((draft) => { draft[chKey].coupling = couplingEl.value; }, { affectsCircuit: false });
      }, { signal });

      sourceEl.addEventListener('change', () => {
        updateConfig((draft) => { draft[chKey].source = sourceEl.value; });
      }, { signal });

      pickEl.addEventListener('click', () => {
        cb.onStartScopeProbe(idx);
      }, { signal });
    };

    bindChannelControls(0, els.ch0Enabled, els.ch0Coupling, els.ch0Source, els.ch0Pick);
    bindChannelControls(1, els.ch1Enabled, els.ch1Coupling, els.ch1Source, els.ch1Pick);

    els.trigSource.addEventListener('change', () => {
      updateConfig((draft) => { draft.trigger.source = els.trigSource.value; }, { affectsCircuit: false });
    }, { signal });

    els.trigSlope.addEventListener('change', () => {
      updateConfig((draft) => { draft.trigger.slope = els.trigSlope.value; }, { affectsCircuit: false });
    }, { signal });

    els.cursorsOn.addEventListener('change', () => {
      updateConfig((draft) => { draft.cursorsOn = els.cursorsOn.checked; }, { affectsCircuit: false });
    }, { signal });

    if (els.quickCursorsBtn) {
      els.quickCursorsBtn.addEventListener('click', () => {
        updateConfig((draft) => { draft.cursorsOn = !draft.cursorsOn; }, { affectsCircuit: false });
      }, { signal });
    }

    const triggerAutoscale = () => {
      if (typeof callbacks.onAutoscale === 'function') {
        cb.onAutoscale();
        return;
      }
      const capture = frozenCapture || (lastSnapshot ? buildCaptureFromSnapshot(lastSnapshot) : null);
      const auto = computeAutoscale({
        ch0Metrics: capture?.ch0?.metrics || null,
        ch1Metrics: capture?.ch1?.metrics || null,
        fgenFreqHz: lastSnapshot?.fgenFreqHz || null
      });
      updateConfig((draft) => {
        if (draft.ch0.enabled) draft.ch0.voltsPerDiv = auto.ch0VoltsPerDiv;
        if (draft.ch1.enabled) draft.ch1.voltsPerDiv = auto.ch1VoltsPerDiv;
        draft.timePerDiv = auto.timePerDiv;
        draft.trigger.level = auto.triggerLevel;
      });
    };

    els.autoscaleBtn.addEventListener('click', triggerAutoscale, { signal });
    els.quickAutoscaleBtn?.addEventListener('click', triggerAutoscale, { signal });

    els.powerBtn.addEventListener('click', () => cb.onPowerToggle(true), { signal });
    els.fgenBtn.addEventListener('click', () => cb.onStartFgen(), { signal });

    // Draggable C1 & C2 Cursors directly on canvas
    els.canvas.addEventListener('pointerdown', (e) => {
      if (!config.cursorsOn || e.button !== 0) return;
      const frac = getCanvasPointerFrac(e.clientX);
      const d1 = Math.abs(frac - config.cursor1Frac);
      const d2 = Math.abs(frac - config.cursor2Frac);
      if (Math.min(d1, d2) > 0.08) return;

      e.preventDefault();
      activeDragCursor = d1 <= d2 ? 1 : 2;
      els.canvas.classList.add('is-dragging-cursor');
      try {
        els.canvas.setPointerCapture?.(e.pointerId);
      } catch (_) {
        // Ignore if pointerId is synthetic
      }
      updateConfig((draft) => {
        if (activeDragCursor === 1) draft.cursor1Frac = frac;
        else draft.cursor2Frac = frac;
      }, { affectsCircuit: false });
    }, { signal });

    window.addEventListener('pointermove', (e) => {
      if (!activeDragCursor) return;
      const frac = getCanvasPointerFrac(e.clientX);
      updateConfig((draft) => {
        if (activeDragCursor === 1) draft.cursor1Frac = frac;
        else draft.cursor2Frac = frac;
      }, { affectsCircuit: false });
    }, { signal });

    const endCursorDrag = () => {
      if (!activeDragCursor) return;
      activeDragCursor = null;
      els.canvas?.classList.remove('is-dragging-cursor');
    };
    window.addEventListener('pointerup', endCursorDrag, { signal });
    window.addEventListener('pointercancel', endCursorDrag, { signal });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        redrawCurrentState();
      });
      resizeObserver.observe(els.canvas);
    }
  }

  function mount(containerEl) {
    if (!containerEl) {
      throw new Error('createScopeInstrument.mount requires containerEl');
    }
    destroy();
    mountContainer = containerEl;
    buildMarkup(containerEl);
    bindEvents();
    syncControlsFromConfig(lastSnapshot?.activeProbeTarget || null);
    redrawCurrentState();
  }

  function resetFrozen() {
    frozenCapture = null;
  }

  function update(snapshot = {}) {
    lastSnapshot = snapshot;
    if (snapshot?.config) {
      config = createDefaultScopeConfig(snapshot.config);
    }
    const forceCapture = Boolean(snapshot?.forceCapture);
    if (config.running || forceCapture || !frozenCapture) {
      frozenCapture = buildCaptureFromSnapshot(snapshot);
    }
    if (!els) return;

    syncControlsFromConfig(snapshot?.activeProbeTarget || null);
    drawScopeCanvas(frozenCapture);
  }

  function onLayoutChange(_mode) {
    if (typeof requestAnimationFrame === 'function') {
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        redrawCurrentState();
      });
    } else {
      redrawCurrentState();
    }
  }

  function onVisibilityChange(visible) {
    if (visible) {
      onLayoutChange();
    }
  }

  function destroy() {
    activeDragCursor = null;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (ac) {
      ac.abort();
      ac = null;
    }
    if (dials) {
      for (const dial of Object.values(dials)) {
        dial.destroy();
      }
      dials = null;
    }
    if (runStopFooter) {
      runStopFooter.destroy();
      runStopFooter = null;
    }
    els = null;
    if (mountContainer) {
      mountContainer.innerHTML = '';
      mountContainer = null;
    }
  }

  return {
    id: 'scope',
    label: 'Scope',
    title: 'Oscilloscope',
    icon: SCOPE_TAB_ICON_SVG,
    preferredWidth: 'wide',
    computerTile: true,
    computerSlot: 'primary',
    computerLayout: 'bench',
    mount,
    update,
    resetFrozen,
    onLayoutChange,
    onVisibilityChange,
    destroy
  };
}
