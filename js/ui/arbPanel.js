/**
 * NI ELVISmx Arbitrary Waveform Generator (ARB) Soft Front Panel
 * Zero-dependency ES2022+ module implementing the InstrumentPanel contract.
 */

import {
  ARB_BUILT_IN_WAVEFORMS,
  ARB_MIN_RATE_HZ,
  ARB_MAX_RATE_HZ,
  ARB_MIN_GAIN,
  ARB_MAX_GAIN,
  ARB_MIN_OFFSET_V,
  ARB_MAX_OFFSET_V,
  createDefaultArbConfig,
  getArbChannelSamples,
  getArbChannelFreqHz,
  parseArbCsvText
} from '../sim/arbModel.js';
import { clamp } from '../sim/linearAlgebra.js';
import { createRunStopFooter } from './elvismxControls.js';

const ARB_TAB_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="M5 13 L8 13 L9.3 10.5 L10.6 15.5 L12.2 6.8 L13.8 16.2 L15 12 L16.8 11 L19 13" />
  </svg>
`;

const QUICK_RATE_CHIPS = Object.freeze([
  { label: '500', hz: 500 },
  { label: '1k', hz: 1000 },
  { label: '1.5k', hz: 1500 },
  { label: '2k', hz: 2000 }
]);

const Y_SCALE_STEPS = [1, 2, 5, 10];
const CHANNEL_KEYS = ['ao0', 'ao1'];

function clampNum(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return clamp(num, min, max);
}

function formatUpdateRate(hz) {
  const rate = clampNum(hz, ARB_MIN_RATE_HZ, ARB_MAX_RATE_HZ, 1000);
  if (rate >= 1000) {
    return `${(rate / 1000).toFixed(1)}k S/s`;
  }
  return `${Math.round(rate)} S/s`;
}

function formatChannelCycleRate(freqHz) {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return null;
  const bpm = Math.round(freqHz * 60);
  const hzStr = freqHz < 10 ? freqHz.toFixed(2) : freqHz < 100 ? freqHz.toFixed(1) : String(Math.round(freqHz));
  if (bpm >= 30 && bpm <= 240) {
    return `${bpm} BPM · ${hzStr} Hz`;
  }
  return `${hzStr} Hz`;
}

function pickAutoYScale(peakVolts) {
  const absPeak = Number.isFinite(peakVolts) ? Math.abs(peakVolts) : 0;
  for (const step of Y_SCALE_STEPS) {
    if (absPeak <= step * 0.95) {
      return step;
    }
  }
  return Y_SCALE_STEPS[Y_SCALE_STEPS.length - 1];
}

function computeScaledBounds(samples, gain, offsetV) {
  if (!samples || samples.length === 0) return 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * gain + offsetV;
    if (Number.isFinite(v)) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

function formatTimeSpan(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
  return `${seconds.toFixed(2)} s`;
}

/**
 * Creates the Dark-Adapted NI ELVISmx Arbitrary Waveform Generator (ARB) instrument panel.
 *
 * @param {object} [options]
 * @param {object} [options.callbacks]
 * @returns {object} InstrumentPanel implementation
 */
export function createArbInstrument({ callbacks = {} } = {}) {
  const cb = {
    onConfigChange: callbacks.onConfigChange || (() => {}),
    onRunStateChange: callbacks.onRunStateChange || (() => {}),
    onStartProbe: callbacks.onStartProbe || (() => {}),
    onClearProbe: callbacks.onClearProbe || (() => {})
  };

  let mountContainer = null;
  let ac = null;
  let resizeObserver = null;
  let rafId = null;
  let runStopFooter = null;
  let els = null;

  let currentConfig = createDefaultArbConfig();
  let currentEnv = {
    powered: true,
    elvisMode: false,
    isProbingAo0: false,
    isProbingAo1: false
  };
  let csvErrorMessage = '';
  let lastSnapshot = null;
  let canvasMetrics = { cssW: 360, cssH: 112, dpr: 1 };

  function buildWaveformOptionsHtml() {
    const builtInHtml = ARB_BUILT_IN_WAVEFORMS.map(
      (wf) => `<option value="${wf.id}">${wf.name}</option>`
    ).join('');
    return `<option value="">&lt; empty &gt;</option>${builtInHtml}`;
  }

  function buildChannelRowMarkup(channelKey, label, dotClass) {
    const waveOptionsHtml = buildWaveformOptionsHtml();
    return `
      <div class="elvis-arb-ch-row" data-arb-row="${channelKey}">
        <div class="elvis-arb-ch-id">
          <span class="elvis-arb-ch-dot ${dotClass}" aria-hidden="true"></span>
          <span class="elvis-arb-ch-name">${label}</span>
          <input
            type="checkbox"
            class="elvis-arb-ch-check"
            data-arb-enabled="${channelKey}"
            aria-label="${label} Enabled"
            title="Enable ${label} output"
          />
        </div>

        <div class="elvis-arb-wave-wrap">
          <select class="elvis-select-compact elvis-arb-wave-select" data-arb-wave="${channelKey}" aria-label="${label} Waveform">
            ${waveOptionsHtml}
          </select>
          <button
            type="button"
            class="elvis-arb-load-btn"
            data-arb-load="${channelKey}"
            title="Load CSV/TXT waveform samples into ${label}"
            aria-label="Load CSV waveform for ${label}"
          >📂</button>
          <input
            type="file"
            accept=".csv,.txt"
            data-arb-file="${channelKey}"
            hidden
          />
        </div>

        <label class="elvis-arb-num-field" title="${label} Gain multiplier">
          <span>Gain</span>
          <input
            type="number"
            class="elvis-dial-input elvis-arb-num-input"
            data-arb-gain="${channelKey}"
            min="${ARB_MIN_GAIN}"
            max="${ARB_MAX_GAIN}"
            step="0.1"
            value="1"
            aria-label="${label} Gain"
          />
        </label>

        <label class="elvis-arb-num-field" title="DC Offset Voltage (e.g. +2.0 V for 0–5 V Arduino ADC)">
          <span>DC (V)</span>
          <input
            type="number"
            class="elvis-dial-input elvis-arb-num-input"
            data-arb-offset="${channelKey}"
            min="${ARB_MIN_OFFSET_V}"
            max="${ARB_MAX_OFFSET_V}"
            step="0.5"
            value="0"
            aria-label="${label} DC Offset Voltage"
          />
        </label>
      </div>
    `;
  }

  function renderMarkup(containerEl) {
    const chipsHtml = QUICK_RATE_CHIPS.map(
      (chip) =>
        `<button type="button" class="elvis-freq-chip elvis-arb-rate-chip" data-arb-rate-chip="${chip.hz}">${chip.label}</button>`
    ).join('');

    containerEl.innerHTML = `
      <section class="elvis-sfp elvis-arb" aria-label="NI ELVISmx Arbitrary Waveform Generator">
        <header class="elvis-sfp-header">
          <div class="elvis-sfp-title-wrap">
            <span class="elvis-sfp-badge">ARB</span>
            <h3 class="elvis-sfp-title">Arbitrary Waveform Generator</h3>
          </div>
          <span class="elvis-sfp-badge">NI ELVISMX</span>
        </header>

        <div class="elvis-sfp-body">
          <div class="elvis-screen elvis-arb-screen" data-arb-screen>
            <div class="elvis-arb-screen-head">
              <span class="elvis-arb-rate-readout" data-arb-rate-readout>Update Rate : 1.0k S/s</span>
              <span class="elvis-arb-status" data-arb-status-text>OFF</span>
            </div>

            <div class="elvis-arb-canvas-wrap">
              <canvas class="elvis-arb-canvas" data-arb-canvas></canvas>
            </div>

            <div class="elvis-arb-screen-foot">
              <span class="elvis-arb-points-readout" data-arb-points-readout>Waveform Points : 0</span>
              <span class="elvis-arb-freq-readout" data-arb-freq-readout>---</span>
            </div>
          </div>

          <fieldset class="elvis-group elvis-arb-wave-group">
            <legend class="elvis-group-legend">Waveform Settings</legend>

            <div class="elvis-arb-ch-list">
              ${buildChannelRowMarkup('ao0', 'AO 0', 'is-ao0')}
              ${buildChannelRowMarkup('ao1', 'AO 1', 'is-ao1')}
            </div>

            <div class="elvis-arb-error" data-arb-error hidden></div>

            <div class="elvis-arb-route-bar" data-arb-route-bar>
              <div class="elvis-arb-elvis-pill" data-arb-elvis-pill hidden>
                ELVIS II Routing: AO 0 (Row 31) · AO 1 (Row 32)
              </div>

              <div class="elvis-arb-probe-controls" data-arb-probe-controls>
                <div class="elvis-arb-probe-pair">
                  <button type="button" class="elvis-probe-btn elvis-arb-probe-btn" data-arb-probe="ao0" title="Place breadboard probe for AO 0">
                    <span class="elvis-arb-probe-label">
                      <span class="elvis-arb-ch-dot is-ao0" aria-hidden="true"></span>
                      <span data-arb-probe-text="ao0">Place AO 0 Probe</span>
                    </span>
                    <span class="elvis-jack-hole" data-arb-probe-hole="ao0" hidden></span>
                  </button>
                  <button type="button" class="elvis-arb-probe-clear" data-arb-probe-clear="ao0" title="Clear AO 0 Probe" hidden>✕</button>
                </div>

                <div class="elvis-arb-probe-pair">
                  <button type="button" class="elvis-probe-btn elvis-arb-probe-btn" data-arb-probe="ao1" title="Place breadboard probe for AO 1">
                    <span class="elvis-arb-probe-label">
                      <span class="elvis-arb-ch-dot is-ao1" aria-hidden="true"></span>
                      <span data-arb-probe-text="ao1">Place AO 1 Probe</span>
                    </span>
                    <span class="elvis-jack-hole" data-arb-probe-hole="ao1" hidden></span>
                  </button>
                  <button type="button" class="elvis-arb-probe-clear" data-arb-probe-clear="ao1" title="Clear AO 1 Probe" hidden>✕</button>
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset class="elvis-group elvis-arb-timing-group">
            <legend class="elvis-group-legend">Timing Settings</legend>
            <div class="elvis-arb-rate-row">
              <label class="elvis-arb-rate-input-wrap">
                <span class="elvis-arb-rate-label">Update Rate</span>
                <input
                  type="number"
                  class="elvis-dial-input elvis-arb-rate-input"
                  data-arb-rate
                  min="${ARB_MIN_RATE_HZ}"
                  max="${ARB_MAX_RATE_HZ}"
                  step="100"
                  value="1000"
                  aria-label="Update Rate in samples per second"
                />
                <span class="elvis-dial-unit">S/s</span>
              </label>

              <div class="elvis-arb-rate-chips" role="group" aria-label="Quick Update Rates">
                ${chipsHtml}
              </div>
            </div>
          </fieldset>

          <fieldset class="elvis-group elvis-arb-ctrl-group">
            <legend class="elvis-group-legend">Instrument Control</legend>
            <div data-arb-runstop-slot></div>
          </fieldset>
        </div>
      </section>
    `;

    runStopFooter = createRunStopFooter({
      onRun: () => setRunning(true),
      onStop: () => setRunning(false)
    });
    containerEl.querySelector('[data-arb-runstop-slot]').replaceWith(runStopFooter.el);

    els = {
      screen: containerEl.querySelector('[data-arb-screen]'),
      rateReadout: containerEl.querySelector('[data-arb-rate-readout]'),
      statusText: containerEl.querySelector('[data-arb-status-text]'),
      canvas: containerEl.querySelector('[data-arb-canvas]'),
      pointsReadout: containerEl.querySelector('[data-arb-points-readout]'),
      freqReadout: containerEl.querySelector('[data-arb-freq-readout]'),
      errorNotice: containerEl.querySelector('[data-arb-error]'),
      elvisPill: containerEl.querySelector('[data-arb-elvis-pill]'),
      probeControls: containerEl.querySelector('[data-arb-probe-controls]'),
      rateInput: containerEl.querySelector('[data-arb-rate]'),
      rateChips: Array.from(containerEl.querySelectorAll('[data-arb-rate-chip]')),
      channels: {
        ao0: {
          enabled: containerEl.querySelector('[data-arb-enabled="ao0"]'),
          wave: containerEl.querySelector('[data-arb-wave="ao0"]'),
          loadBtn: containerEl.querySelector('[data-arb-load="ao0"]'),
          fileInput: containerEl.querySelector('[data-arb-file="ao0"]'),
          gain: containerEl.querySelector('[data-arb-gain="ao0"]'),
          offset: containerEl.querySelector('[data-arb-offset="ao0"]'),
          probeBtn: containerEl.querySelector('[data-arb-probe="ao0"]'),
          probeText: containerEl.querySelector('[data-arb-probe-text="ao0"]'),
          probeHole: containerEl.querySelector('[data-arb-probe-hole="ao0"]'),
          probeClear: containerEl.querySelector('[data-arb-probe-clear="ao0"]')
        },
        ao1: {
          enabled: containerEl.querySelector('[data-arb-enabled="ao1"]'),
          wave: containerEl.querySelector('[data-arb-wave="ao1"]'),
          loadBtn: containerEl.querySelector('[data-arb-load="ao1"]'),
          fileInput: containerEl.querySelector('[data-arb-file="ao1"]'),
          gain: containerEl.querySelector('[data-arb-gain="ao1"]'),
          offset: containerEl.querySelector('[data-arb-offset="ao1"]'),
          probeBtn: containerEl.querySelector('[data-arb-probe="ao1"]'),
          probeText: containerEl.querySelector('[data-arb-probe-text="ao1"]'),
          probeHole: containerEl.querySelector('[data-arb-probe-hole="ao1"]'),
          probeClear: containerEl.querySelector('[data-arb-probe-clear="ao1"]')
        }
      }
    };
  }

  function resizeCanvasIfNeeded() {
    if (!els?.canvas) return;
    const rect = els.canvas.getBoundingClientRect();
    const cssW = Math.max(200, Math.round(rect.width || 360));
    const cssH = Math.max(70, Math.round(rect.height || 112));
    const dpr =
      typeof window !== 'undefined' && window.devicePixelRatio
        ? Math.min(2.5, window.devicePixelRatio)
        : 1;

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

  function drawPreviewCanvas() {
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

    const grad = ctx.createRadialGradient(
      cssW * 0.5,
      cssH * 0.5,
      8,
      cssW * 0.5,
      cssH * 0.5,
      Math.max(cssW, cssH) * 0.72
    );
    grad.addColorStop(0, 'rgba(14, 116, 144, 0.14)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    const padLeft = 32;
    const padRight = 8;
    const padTop = 7;
    const padBottom = 15;
    const plotW = Math.max(40, cssW - padLeft - padRight);
    const plotH = Math.max(30, cssH - padTop - padBottom);
    const midY = padTop + plotH / 2;

    const ao0Info = currentConfig.ao0.enabled ? getArbChannelSamples(currentConfig.ao0) : null;
    const ao1Info = currentConfig.ao1.enabled ? getArbChannelSamples(currentConfig.ao1) : null;

    const peak0 = ao0Info?.count > 0
      ? computeScaledBounds(ao0Info.samples, currentConfig.ao0.gain, currentConfig.ao0.offsetV)
      : 0;
    const peak1 = ao1Info?.count > 0
      ? computeScaledBounds(ao1Info.samples, currentConfig.ao1.gain, currentConfig.ao1.offsetV)
      : 0;
    const yMax = pickAutoYScale(Math.max(peak0, peak1, 0.1));

    const maxPoints = Math.max(ao0Info?.count || 0, ao1Info?.count || 0);
    const rateHz = clampNum(currentConfig.updateRateHz, ARB_MIN_RATE_HZ, ARB_MAX_RATE_HZ, 1000);
    const durationSec = maxPoints > 0 ? maxPoints / rateHz : 1.0;

    // 2. Dark teal graticule grid
    const cols = 8;
    const rows = 4;
    ctx.strokeStyle = 'rgba(20, 83, 45, 0.65)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const x = Math.round(padLeft + (c / cols) * plotW) + 0.5;
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
    }
    for (let r = 0; r <= rows; r++) {
      const y = Math.round(padTop + (r / rows) * plotH) + 0.5;
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
    }
    ctx.stroke();

    // Zero baseline
    ctx.strokeStyle = 'rgba(34, 243, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, Math.round(midY) + 0.5);
    ctx.lineTo(padLeft + plotW, Math.round(midY) + 0.5);
    ctx.stroke();

    // Axis labels (Amplitude V & Time s)
    ctx.font = "700 9px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${yMax}V`, padLeft - 4, padTop + 4);
    ctx.fillText('0', padLeft - 4, midY);
    ctx.fillText(`-${yMax}V`, padLeft - 4, padTop + plotH - 3);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('0 s', padLeft, padTop + plotH + 3);
    ctx.textAlign = 'center';
    ctx.fillText('Time (s)', padLeft + plotW / 2, padTop + plotH + 3);
    ctx.textAlign = 'right';
    ctx.fillText(formatTimeSpan(durationSec), padLeft + plotW, padTop + plotH + 3);

    // 3. Plot enabled channel traces
    const voltsToY = (v) => clamp(midY - (v / yMax) * (plotH / 2), padTop, padTop + plotH);

    const drawChannelTrace = (info, chCfg, strokeColor, glowColor) => {
      if (!info || !info.samples || info.samples.length === 0) return;
      const samples = info.samples;
      const n = samples.length;
      const gain = chCfg.gain;
      const offsetV = chCfg.offsetV;

      ctx.save();
      ctx.beginPath();
      ctx.rect(padLeft, padTop, plotW, plotH);
      ctx.clip();

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1.9;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 5;
      ctx.beginPath();

      const maxDrawSteps = Math.max(120, Math.min(n, Math.round(plotW * 2)));
      const stride = n > maxDrawSteps ? n / maxDrawSteps : 1;

      if (n === 1) {
        const y = voltsToY(samples[0] * gain + offsetV);
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + plotW, y);
      } else {
        for (let step = 0; step < maxDrawSteps; step++) {
          const idx = Math.min(n - 1, Math.round(step * stride));
          const x = padLeft + (idx / (n - 1)) * plotW;
          const y = voltsToY(samples[idx] * gain + offsetV);
          if (step === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }

      ctx.stroke();
      ctx.restore();
    };

    const hasAnyTrace = Boolean((ao0Info?.count || 0) > 0 || (ao1Info?.count || 0) > 0);
    if (ao1Info?.count > 0) {
      drawChannelTrace(ao1Info, currentConfig.ao1, '#facc15', 'rgba(250, 204, 21, 0.4)');
    }
    if (ao0Info?.count > 0) {
      drawChannelTrace(ao0Info, currentConfig.ao0, '#22ff66', 'rgba(34, 255, 102, 0.45)');
    }

    if (!hasAnyTrace) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
      ctx.font = "700 10.5px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No active waveform selected', padLeft + plotW / 2, midY);
    }

    ctx.restore();
  }

  function syncCustomOption(selectEl, chCfg) {
    if (!selectEl) return;
    let customOpt = selectEl.querySelector('option[value="custom"]');
    if (chCfg.waveformId === 'custom' || (Array.isArray(chCfg.customSamples) && chCfg.customSamples.length > 0) || (chCfg.customSamples instanceof Float64Array && chCfg.customSamples.length > 0)) {
      if (!customOpt) {
        customOpt = document.createElement('option');
        customOpt.value = 'custom';
        selectEl.appendChild(customOpt);
      }
      const labelName = chCfg.customName || 'Custom CSV';
      customOpt.textContent = `CSV: ${labelName}`;
    } else if (customOpt) {
      customOpt.remove();
    }
  }

  function syncScreenAndControls() {
    if (!els) return;

    const { powered, elvisMode, isProbingAo0, isProbingAo1 } = currentEnv;
    const isActive = Boolean(currentConfig.running && powered);
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;

    els.screen.classList.toggle('is-warning', !powered);
    els.rateReadout.textContent = `Update Rate : ${formatUpdateRate(currentConfig.updateRateHz)}`;

    els.statusText.classList.toggle('is-running', isActive);
    els.statusText.classList.toggle('is-off', !isActive);
    els.statusText.textContent = !powered ? 'POWER OFF' : isActive ? 'RUNNING' : 'OFF';

    // Points & frequency readouts
    const ao0Info = currentConfig.ao0.enabled ? getArbChannelSamples(currentConfig.ao0) : null;
    const ao1Info = currentConfig.ao1.enabled ? getArbChannelSamples(currentConfig.ao1) : null;
    const primaryInfo = ao0Info?.count > 0 ? ao0Info : ao1Info?.count > 0 ? ao1Info : null;
    const primaryKey = ao0Info?.count > 0 ? 'ao0' : ao1Info?.count > 0 ? 'ao1' : null;
    const pointsCount = primaryInfo?.count || 0;

    if (currentConfig.ao0.enabled && currentConfig.ao1.enabled) {
      els.pointsReadout.textContent = `Points : AO0 ${ao0Info?.count || 0} · AO1 ${ao1Info?.count || 0}`;
    } else {
      els.pointsReadout.textContent = `Waveform Points : ${pointsCount}`;
    }

    const freqHz = primaryKey
      ? getArbChannelFreqHz(currentConfig, primaryKey, { ignoreRunning: true })
      : null;
    const cycleLabel = formatChannelCycleRate(freqHz);
    els.freqReadout.textContent = cycleLabel || '---';
    els.freqReadout.classList.toggle('is-standby', !isActive);

    // Sync channel controls
    for (const key of CHANNEL_KEYS) {
      const chCfg = currentConfig[key];
      const chEls = els.channels[key];

      chEls.enabled.checked = Boolean(chCfg.enabled);
      syncCustomOption(chEls.wave, chCfg);
      chEls.wave.value = chCfg.waveformId || '';
      chEls.wave.title = chEls.wave.options[chEls.wave.selectedIndex]?.textContent || '';

      if (activeEl !== chEls.gain) {
        chEls.gain.value = String(Number(chCfg.gain.toFixed(2)));
      }
      if (activeEl !== chEls.offset) {
        chEls.offset.value = String(Number(chCfg.offsetV.toFixed(2)));
      }

      const isProbing = key === 'ao0' ? isProbingAo0 : isProbingAo1;
      chEls.probeBtn.classList.toggle('is-probing', Boolean(isProbing));
      if (chCfg.probeHole) {
        chEls.probeText.textContent = key === 'ao0' ? 'AO 0 Probe' : 'AO 1 Probe';
        chEls.probeHole.hidden = false;
        chEls.probeHole.textContent = chCfg.probeHole;
        chEls.probeClear.hidden = false;
      } else {
        chEls.probeText.textContent = key === 'ao0' ? 'Place AO 0 Probe' : 'Place AO 1 Probe';
        chEls.probeHole.hidden = true;
        chEls.probeHole.textContent = '';
        chEls.probeClear.hidden = true;
      }
    }

    // Output routing bar
    els.elvisPill.hidden = !elvisMode;
    els.probeControls.hidden = Boolean(elvisMode);

    // Rate input & quick chips
    if (activeEl !== els.rateInput) {
      els.rateInput.value = String(Math.round(currentConfig.updateRateHz));
    }
    for (const chip of els.rateChips) {
      const chipHz = Number(chip.dataset.arbRateChip);
      const isMatch = Math.abs(currentConfig.updateRateHz - chipHz) < 1;
      chip.classList.toggle('is-active', isMatch);
      chip.setAttribute('aria-pressed', String(isMatch));
    }

    // CSV error notice
    if (csvErrorMessage) {
      els.errorNotice.hidden = false;
      els.errorNotice.textContent = csvErrorMessage;
    } else {
      els.errorNotice.hidden = true;
      els.errorNotice.textContent = '';
    }

    runStopFooter?.setRunning(currentConfig.running);
    drawPreviewCanvas();
  }

  function scheduleDraw() {
    if (!els) return;
    if (typeof requestAnimationFrame === 'function') {
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        drawPreviewCanvas();
      });
    } else {
      drawPreviewCanvas();
    }
  }

  function emitConfigChange() {
    cb.onConfigChange(createDefaultArbConfig(currentConfig));
  }

  function setRunning(nextRunning, { notify = true } = {}) {
    const running = Boolean(nextRunning);
    if (currentConfig.running === running) {
      runStopFooter?.setRunning(running);
      return;
    }
    currentConfig = createDefaultArbConfig({ ...currentConfig, running });
    syncScreenAndControls();
    if (notify) {
      cb.onRunStateChange(currentConfig.running);
    }
  }

  function mount(containerEl) {
    if (!containerEl) {
      throw new Error('createArbInstrument.mount requires containerEl');
    }
    destroy();
    mountContainer = containerEl;
    renderMarkup(containerEl);

    ac = new AbortController();
    const { signal } = ac;

    for (const key of CHANNEL_KEYS) {
      const chEls = els.channels[key];

      chEls.enabled.addEventListener('change', () => {
        currentConfig = createDefaultArbConfig({
          ...currentConfig,
          [key]: { ...currentConfig[key], enabled: chEls.enabled.checked }
        });
        syncScreenAndControls();
        emitConfigChange();
      }, { signal });

      chEls.wave.addEventListener('change', () => {
        csvErrorMessage = '';
        const val = chEls.wave.value;
        currentConfig = createDefaultArbConfig({
          ...currentConfig,
          [key]: { ...currentConfig[key], waveformId: val }
        });
        syncScreenAndControls();
        emitConfigChange();
      }, { signal });

      chEls.loadBtn.addEventListener('click', () => {
        chEls.fileInput.value = '';
        chEls.fileInput.click();
      }, { signal });

      chEls.fileInput.addEventListener('change', async () => {
        const file = chEls.fileInput.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          if (signal.aborted) return;
          const parsed = parseArbCsvText(text, file.name);
          if (!parsed.ok) {
            csvErrorMessage = parsed.error || `Could not parse "${file.name}".`;
            syncScreenAndControls();
            return;
          }
          csvErrorMessage = '';
          currentConfig = createDefaultArbConfig({
            ...currentConfig,
            [key]: {
              ...currentConfig[key],
              enabled: true,
              waveformId: 'custom',
              customName: parsed.name || file.name,
              customSamples: parsed.samples
            }
          });
          syncScreenAndControls();
          emitConfigChange();
        } catch (err) {
          if (signal.aborted) return;
          csvErrorMessage = err?.message || `Failed to read "${file.name}".`;
          syncScreenAndControls();
        } finally {
          chEls.fileInput.value = '';
        }
      }, { signal });

      const commitGain = () => {
        if (chEls.gain.value.trim() === '') return;
        const val = Number(chEls.gain.value);
        if (!Number.isFinite(val)) return;
        currentConfig = createDefaultArbConfig({
          ...currentConfig,
          [key]: { ...currentConfig[key], gain: clampNum(val, ARB_MIN_GAIN, ARB_MAX_GAIN, 1) }
        });
        syncScreenAndControls();
        emitConfigChange();
      };
      chEls.gain.addEventListener('input', commitGain, { signal });
      chEls.gain.addEventListener('change', commitGain, { signal });
      chEls.gain.addEventListener('blur', () => {
        chEls.gain.value = String(Number(currentConfig[key].gain.toFixed(2)));
      }, { signal });

      const commitOffset = () => {
        if (chEls.offset.value.trim() === '') return;
        const val = Number(chEls.offset.value);
        if (!Number.isFinite(val)) return;
        currentConfig = createDefaultArbConfig({
          ...currentConfig,
          [key]: { ...currentConfig[key], offsetV: clampNum(val, ARB_MIN_OFFSET_V, ARB_MAX_OFFSET_V, 0) }
        });
        syncScreenAndControls();
        emitConfigChange();
      };
      chEls.offset.addEventListener('input', commitOffset, { signal });
      chEls.offset.addEventListener('change', commitOffset, { signal });
      chEls.offset.addEventListener('blur', () => {
        chEls.offset.value = String(Number(currentConfig[key].offsetV.toFixed(2)));
      }, { signal });

      chEls.probeBtn.addEventListener('click', () => {
        cb.onStartProbe(key);
      }, { signal });

      chEls.probeClear.addEventListener('click', () => {
        cb.onClearProbe(key);
      }, { signal });
    }

    const commitRate = () => {
      if (els.rateInput.value.trim() === '') return;
      const val = Number(els.rateInput.value);
      if (!Number.isFinite(val)) return;
      currentConfig = createDefaultArbConfig({
        ...currentConfig,
        updateRateHz: clampNum(val, ARB_MIN_RATE_HZ, ARB_MAX_RATE_HZ, 1000)
      });
      syncScreenAndControls();
      emitConfigChange();
    };
    els.rateInput.addEventListener('input', commitRate, { signal });
    els.rateInput.addEventListener('change', commitRate, { signal });
    els.rateInput.addEventListener('blur', () => {
      els.rateInput.value = String(Math.round(currentConfig.updateRateHz));
    }, { signal });

    for (const chip of els.rateChips) {
      chip.addEventListener('click', () => {
        const hz = Number(chip.dataset.arbRateChip);
        if (!Number.isFinite(hz)) return;
        currentConfig = createDefaultArbConfig({
          ...currentConfig,
          updateRateHz: clampNum(hz, ARB_MIN_RATE_HZ, ARB_MAX_RATE_HZ, 1000)
        });
        syncScreenAndControls();
        emitConfigChange();
      }, { signal });
    }

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleDraw();
      });
      resizeObserver.observe(els.canvas);
    }

    if (lastSnapshot) {
      update(lastSnapshot);
    } else {
      syncScreenAndControls();
      scheduleDraw();
    }
  }

  function update(snapshot = {}) {
    lastSnapshot = snapshot;
    csvErrorMessage = '';
    const rawArb =
      snapshot?.arbConfig && typeof snapshot.arbConfig === 'object'
        ? snapshot.arbConfig
        : snapshot?.arb && typeof snapshot.arb === 'object'
        ? snapshot.arb
        : snapshot;

    currentConfig = createDefaultArbConfig(rawArb);
    currentEnv = {
      powered: snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true,
      elvisMode: Boolean(snapshot?.elvisMode),
      isProbingAo0: Boolean(snapshot?.isProbingAo0 || snapshot?.activeProbeTarget === 'arb-ao0'),
      isProbingAo1: Boolean(snapshot?.isProbingAo1 || snapshot?.activeProbeTarget === 'arb-ao1')
    };

    syncScreenAndControls();
    scheduleDraw();
  }

  function onLayoutChange(_mode) {
    scheduleDraw();
  }

  function onVisibilityChange(visible, _mode) {
    if (visible) {
      scheduleDraw();
    }
  }

  function destroy() {
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
    id: 'arb',
    label: 'ARB',
    title: 'Arbitrary Waveform Generator',
    icon: ARB_TAB_ICON_SVG,
    preferredWidth: 'compact',
    computerTile: true,
    computerSlot: 'aux',
    mount,
    update,
    onLayoutChange,
    onVisibilityChange,
    setRunning,
    destroy
  };
}
