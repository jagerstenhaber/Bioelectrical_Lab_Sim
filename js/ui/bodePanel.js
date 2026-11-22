/**
 * NI ELVISmx Bode Analyzer Soft Front Panel
 * Zero-dependency ES2022+ module implementing the InstrumentPanel contract.
 */

import { createDefaultBodeConfig } from '../sim/acSolver.js';
import { clamp } from '../sim/linearAlgebra.js';
import { createRunStopFooter, formatFrequency } from './elvismxControls.js';

const BODE_TAB_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="M5.5 9 H10.5 C12.5 9 13.8 10.6 15 13 L18.5 16.5" />
    <line x1="5.5" y1="16.5" x2="18.5" y2="16.5" stroke-opacity="0.45" />
  </svg>
`;

const START_FREQ_OPTIONS = Object.freeze([
  { value: 1, label: '1 Hz' },
  { value: 10, label: '10 Hz' },
  { value: 100, label: '100 Hz' },
  { value: 1000, label: '1 kHz' }
]);

const STOP_FREQ_OPTIONS = Object.freeze([
  { value: 1000, label: '1 kHz' },
  { value: 10000, label: '10 kHz' },
  { value: 100000, label: '100 kHz' },
  { value: 1000000, label: '1 MHz' }
]);

const PTS_PER_DEC_OPTIONS = Object.freeze([10, 20, 30]);

const CUTOFF_DROP_DB = 20 * Math.log10(Math.SQRT2);

function formatCompactAxisFreq(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '';
  if (hz >= 1e6) {
    const v = hz / 1e6;
    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (hz >= 1e3) {
    const v = hz / 1e3;
    return Number.isInteger(v) ? `${v}k` : `${v.toFixed(1)}k`;
  }
  return Number.isInteger(hz) ? String(hz) : String(Number(hz.toFixed(1)));
}

function formatRangeFreq(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '---';
  if (hz >= 1e6) {
    const v = hz / 1e6;
    return Number.isInteger(v) ? `${v} MHz` : formatFrequency(hz);
  }
  if (hz >= 1e3) {
    const v = hz / 1e3;
    return Number.isInteger(v) ? `${v} kHz` : formatFrequency(hz);
  }
  return Number.isInteger(hz) ? `${hz} Hz` : formatFrequency(hz);
}

function formatDbValue(db) {
  if (!Number.isFinite(db)) return '---';
  if (Math.abs(db) < 0.05) return '0.0 dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function formatLinearGain(db) {
  if (!Number.isFinite(db)) return '---';
  const gain = Math.pow(10, db / 20);
  if (!Number.isFinite(gain)) return '---';
  if (gain >= 100) return `${gain.toFixed(0)}×`;
  if (gain >= 10) return `${gain.toFixed(1)}×`;
  if (gain >= 0.01) return `${gain.toFixed(2)}×`;
  return `${gain.toExponential(1)}×`;
}

function pickNearestValue(val, list, fallback) {
  if (!Number.isFinite(val)) return fallback;
  let best = list[0];
  let bestDist = Math.abs(list[0] - val);
  for (let i = 1; i < list.length; i++) {
    const dist = Math.abs(list[i] - val);
    if (dist < bestDist) {
      bestDist = dist;
      best = list[i];
    }
  }
  return best;
}

function computeDbGridBounds(passbandGainDb, minGainDb) {
  const hiRaw = Number.isFinite(passbandGainDb) ? passbandGainDb : 0;
  const loRaw = Number.isFinite(minGainDb) ? minGainDb : -40;
  const spanRaw = Math.max(15, hiRaw - loRaw);

  let step = 10;
  if (spanRaw > 140) step = 40;
  else if (spanRaw > 55) step = 20;

  let yMax = Math.ceil((hiRaw + step * 0.25) / step) * step;
  let yMin = Math.floor((loRaw - step * 0.25) / step) * step;
  if (yMax - yMin < step * 2) {
    yMin = yMax - step * 2;
  }

  return { yMin, yMax, step };
}

function interpolateBodeAtFreq(bodeResult, freqHz) {
  if (!bodeResult?.valid || !bodeResult.freqsHz?.length || !Number.isFinite(freqHz) || freqHz <= 0) {
    return null;
  }
  const { freqsHz, magDb, phaseDeg } = bodeResult;
  const n = freqsHz.length;
  if (n === 1) {
    return {
      freqHz: freqsHz[0],
      magDb: magDb[0],
      phaseDeg: phaseDeg[0]
    };
  }

  const clampedF = clamp(freqHz, freqsHz[0], freqsHz[n - 1]);
  const logTarget = Math.log10(clampedF);

  let hi = 1;
  while (hi < n - 1 && freqsHz[hi] < clampedF) {
    hi++;
  }
  const lo = Math.max(0, hi - 1);
  const f0 = freqsHz[lo];
  const f1 = freqsHz[hi];
  const log0 = Math.log10(Math.max(1e-9, f0));
  const log1 = Math.log10(Math.max(1e-9, f1));
  const t = log1 !== log0 ? clamp((logTarget - log0) / (log1 - log0), 0, 1) : 0;

  const m0 = magDb[lo];
  const m1 = magDb[hi];
  const interpMag = Number.isFinite(m0) && Number.isFinite(m1) ? m0 + t * (m1 - m0) : m0;

  let p0 = phaseDeg[lo];
  let p1 = phaseDeg[hi];
  let interpPhase = p0;
  if (Number.isFinite(p0) && Number.isFinite(p1)) {
    const diff = p1 - p0;
    if (diff > 180) p1 -= 360;
    else if (diff < -180) p1 += 360;
    interpPhase = p0 + t * (p1 - p0);
    while (interpPhase > 180) interpPhase -= 360;
    while (interpPhase < -180) interpPhase += 360;
  }

  return {
    freqHz: clampedF,
    magDb: interpMag,
    phaseDeg: interpPhase
  };
}

/**
 * Creates the Dark-Adapted NI ELVISmx Bode Analyzer instrument panel.
 *
 * @param {object} [options]
 * @param {object} [options.callbacks]
 * @returns {object} InstrumentPanel implementation
 */
export function createBodeInstrument({ callbacks = {} } = {}) {
  const cb = {
    onConfigChange: callbacks.onConfigChange || (() => {}),
    onStartBodeProbe: callbacks.onStartBodeProbe || (() => {}),
    onPowerToggle: callbacks.onPowerToggle || (() => {})
  };

  let mountContainer = null;
  let ac = null;
  let resizeObserver = null;
  let rafId = null;
  let els = null;
  let runStopFooter = null;

  let config = createDefaultBodeConfig();
  let running = true;
  let lastSnapshot = null;
  let frozenCapture = null;
  let hoverFreqHz = null;
  let lastPointerFreqHz = null;
  let isDraggingCursor = false;
  let canvasMetrics = { cssW: 420, cssH: 255, dpr: 1 };
  let plotBounds = { padLeft: 42, padRight: 12, padTop: 12, padBottom: 20, plotW: 366, plotH: 223 };

  function buildMarkup(containerEl) {
    const startOptsHtml = START_FREQ_OPTIONS.map(
      (o) => `<option value="${o.value}">${o.label}</option>`
    ).join('');
    const stopOptsHtml = STOP_FREQ_OPTIONS.map(
      (o) => `<option value="${o.value}">${o.label}</option>`
    ).join('');
    const ptsOptsHtml = PTS_PER_DEC_OPTIONS.map(
      (pts) => `<option value="${pts}">${pts}</option>`
    ).join('');

    containerEl.innerHTML = `
      <section class="elvis-sfp elvis-bode" aria-label="NI ELVISmx Bode Analyzer">
        <header class="elvis-sfp-header">
          <div class="elvis-sfp-title-wrap">
            <span class="elvis-sfp-badge">BODE</span>
            <h3 class="elvis-sfp-title">Bode Analyzer</h3>
          </div>
          <span class="elvis-sfp-badge">NI ELVISmx</span>
        </header>

        <div class="elvis-sfp-body">
          <div class="elvis-bode-crt">
            <div class="elvis-screen-meta elvis-bode-meta">
              <div class="elvis-bode-meta-left">
                <span class="elvis-run-pill is-running" data-bode-run-pill>● LIVE</span>
                <span class="elvis-bode-range-badge" data-bode-range-badge>10 Hz – 100 kHz</span>
              </div>
              <span class="elvis-bode-summary-pill" data-bode-summary-pill>Passband: ---</span>
            </div>

            <div class="elvis-bode-canvas-wrap">
              <canvas class="elvis-bode-canvas" data-bode-canvas></canvas>
              <div class="elvis-bode-overlay" data-bode-overlay hidden>
                <span class="elvis-bode-overlay-msg" data-bode-overlay-msg></span>
                <button type="button" class="elvis-inline-btn" data-bode-power-btn hidden>⚡ Turn Power ON</button>
              </div>
            </div>

            <div class="elvis-bode-readout" data-bode-readout>
              ---  |  ---  |  ---
            </div>
          </div>

          <div class="elvis-bode-controls bode-controls-col">
            <fieldset class="elvis-group">
              <legend class="elvis-group-legend">Sweep Range</legend>
              <div class="elvis-bode-row elvis-bode-sweep-row">
                <label class="elvis-field-stack">
                  <span>Start</span>
                  <select class="elvis-select-compact" data-bode-start aria-label="Start Frequency">
                    ${startOptsHtml}
                  </select>
                </label>
                <label class="elvis-field-stack">
                  <span>Stop</span>
                  <select class="elvis-select-compact" data-bode-stop aria-label="Stop Frequency">
                    ${stopOptsHtml}
                  </select>
                </label>
                <label class="elvis-field-stack">
                  <span>Pts/Dec</span>
                  <select class="elvis-select-compact" data-bode-pts aria-label="Points Per Decade">
                    ${ptsOptsHtml}
                  </select>
                </label>
              </div>
            </fieldset>

            <fieldset class="elvis-group">
              <legend class="elvis-group-legend">Channel Sources</legend>
              <div class="elvis-bode-row elvis-bode-sources-row">
                <div class="elvis-field-stack">
                  <span>Input (Stimulus / Ref)</span>
                  <div class="elvis-scope-source-row">
                    <select class="elvis-select-compact" data-bode-in-source aria-label="Bode Input Source">
                      <option value="AI0">ELVIS AI 0</option>
                      <option value="FGEN">ELVIS FGEN</option>
                      <option value="PROBE">Board Probe</option>
                    </select>
                    <button type="button" class="elvis-pick-btn" data-bode-in-pick hidden>📌 Pick</button>
                  </div>
                </div>
                <div class="elvis-field-stack">
                  <span>Output (Response)</span>
                  <div class="elvis-scope-source-row">
                    <select class="elvis-select-compact" data-bode-out-source aria-label="Bode Output Source">
                      <option value="AI1">ELVIS AI 1</option>
                      <option value="AI0">ELVIS AI 0</option>
                      <option value="PROBE">Board Probe</option>
                    </select>
                    <button type="button" class="elvis-pick-btn" data-bode-out-pick hidden>📌 Pick</button>
                  </div>
                </div>
              </div>
            </fieldset>

            <fieldset class="elvis-group">
              <legend class="elvis-group-legend">Sweep Control</legend>
              <div data-bode-runstop-slot></div>
            </fieldset>
          </div>
        </div>
      </section>
    `;

    runStopFooter = createRunStopFooter({
      onRun: () => {
        if (running) return;
        running = true;
        if (lastSnapshot) {
          frozenCapture = buildCaptureFromSnapshot(lastSnapshot);
        }
        syncControlsFromConfig(lastSnapshot?.activeProbeTarget || null);
        redrawCurrentState();
        cb.onConfigChange({ ...createDefaultBodeConfig(config), running: true }, { affectsCircuit: true });
      },
      onStop: () => {
        if (!running) return;
        running = false;
        if (lastSnapshot && !frozenCapture) {
          frozenCapture = buildCaptureFromSnapshot(lastSnapshot);
        }
        syncControlsFromConfig(lastSnapshot?.activeProbeTarget || null);
        redrawCurrentState();
        cb.onConfigChange({ ...createDefaultBodeConfig(config), running: false }, { affectsCircuit: false });
      }
    });
    containerEl.querySelector('[data-bode-runstop-slot]').replaceWith(runStopFooter.el);

    els = {
      canvas: containerEl.querySelector('[data-bode-canvas]'),
      runPill: containerEl.querySelector('[data-bode-run-pill]'),
      rangeBadge: containerEl.querySelector('[data-bode-range-badge]'),
      summaryPill: containerEl.querySelector('[data-bode-summary-pill]'),
      overlay: containerEl.querySelector('[data-bode-overlay]'),
      overlayMsg: containerEl.querySelector('[data-bode-overlay-msg]'),
      powerBtn: containerEl.querySelector('[data-bode-power-btn]'),
      readout: containerEl.querySelector('[data-bode-readout]'),
      startSelect: containerEl.querySelector('[data-bode-start]'),
      stopSelect: containerEl.querySelector('[data-bode-stop]'),
      ptsSelect: containerEl.querySelector('[data-bode-pts]'),
      inSource: containerEl.querySelector('[data-bode-in-source]'),
      outSource: containerEl.querySelector('[data-bode-out-source]'),
      inPick: containerEl.querySelector('[data-bode-in-pick]'),
      outPick: containerEl.querySelector('[data-bode-out-pick]')
    };
  }

  function resizeCanvasIfNeeded() {
    if (!els?.canvas) return;
    const rect = els.canvas.getBoundingClientRect();
    const cssW = Math.max(240, Math.round(rect.width || 420));
    const cssH = Math.max(190, Math.round(rect.height || 255));
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

  function buildCaptureFromSnapshot(snapshot = {}) {
    const powered = snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true;
    const bodeResult = snapshot?.bodeResult || snapshot?.result || null;
    return {
      powered,
      bodeResult
    };
  }

  function syncControlsFromConfig(activeProbeTarget = null) {
    if (!els) return;

    const powered = lastSnapshot?.powered !== undefined ? Boolean(lastSnapshot.powered) : true;
    els.runPill.classList.toggle('is-running', powered && running);
    els.runPill.classList.toggle('is-hold', powered && !running);
    els.runPill.classList.toggle('is-off', !powered);
    els.runPill.textContent = !powered ? '○ POWER OFF' : running ? '● LIVE' : '■ HOLD';
    runStopFooter?.setRunning(running);

    els.rangeBadge.textContent = `${formatRangeFreq(config.startFreqHz)} – ${formatRangeFreq(config.stopFreqHz)}`;

    const startVal = pickNearestValue(
      config.startFreqHz,
      START_FREQ_OPTIONS.map((o) => o.value),
      10
    );
    const stopVal = pickNearestValue(
      config.stopFreqHz,
      STOP_FREQ_OPTIONS.map((o) => o.value),
      100000
    );
    const ptsVal = pickNearestValue(config.stepsPerDecade, PTS_PER_DEC_OPTIONS, 20);

    els.startSelect.value = String(startVal);
    els.stopSelect.value = String(stopVal);
    els.ptsSelect.value = String(ptsVal);

    els.inSource.value = config.inputSource === 'AI1' ? 'AI0' : config.inputSource;
    els.outSource.value = config.outputSource === 'FGEN' ? 'AI1' : config.outputSource;

    const isInputProbing =
      activeProbeTarget === 'bode-in' ||
      activeProbeTarget === 'probe-bode-in' ||
      activeProbeTarget === 'bode-input';
    const isOutputProbing =
      activeProbeTarget === 'bode-out' ||
      activeProbeTarget === 'probe-bode-out' ||
      activeProbeTarget === 'bode-output';

    els.inPick.hidden = config.inputSource !== 'PROBE';
    els.inPick.textContent = config.inputProbeHole ? `📌 ${config.inputProbeHole}` : '📌 Pick';
    els.inPick.classList.toggle('is-probing', isInputProbing);

    els.outPick.hidden = config.outputSource !== 'PROBE';
    els.outPick.textContent = config.outputProbeHole ? `📌 ${config.outputProbeHole}` : '📌 Pick';
    els.outPick.classList.toggle('is-probing', isOutputProbing);
  }

  function getActiveCursorFreq(bodeResult) {
    if (!bodeResult?.valid) return null;
    const minF = bodeResult.startFreqHz || config.startFreqHz;
    const maxF = bodeResult.stopFreqHz || config.stopFreqHz;
    const candidate = hoverFreqHz ?? config.cursorFreqHz ?? lastPointerFreqHz;
    if (Number.isFinite(candidate) && candidate > 0) {
      return clamp(candidate, minF, maxF);
    }
    if (bodeResult.cutoffs?.length > 0 && Number.isFinite(bodeResult.cutoffs[0].freqHz)) {
      return clamp(bodeResult.cutoffs[0].freqHz, minF, maxF);
    }
    return Math.sqrt(minF * maxF);
  }

  function updateHeaderAndReadout(capture) {
    if (!els) return;
    const powered = capture?.powered !== undefined ? Boolean(capture.powered) : true;
    const res = capture?.bodeResult || null;

    els.runPill.classList.toggle('is-running', powered && running);
    els.runPill.classList.toggle('is-hold', powered && !running);
    els.runPill.classList.toggle('is-off', !powered);
    els.runPill.textContent = !powered ? '○ POWER OFF' : running ? '● LIVE' : '■ HOLD';

    if (!powered) {
      els.summaryPill.textContent = 'Power OFF';
      els.overlay.hidden = false;
      els.overlayMsg.textContent = 'Lab Power is OFF';
      els.powerBtn.hidden = false;
      els.readout.textContent = '---  |  ---  |  ---';
      return;
    }

    if (!res || !res.valid) {
      els.summaryPill.textContent = 'No Valid Sweep';
      els.overlay.hidden = false;
      els.overlayMsg.textContent =
        res?.reason ||
        'Connect ELVIS FGEN (Row 33) or place an FGEN Board Probe to inject the sweep signal.';
      els.powerBtn.hidden = true;
      els.readout.textContent = '---  |  ---  |  ---';
      return;
    }

    els.overlay.hidden = true;
    els.powerBtn.hidden = true;

    const passbandStr = formatDbValue(res.passbandGainDb);
    if (res.cutoffs?.length > 0) {
      const fcLabels = res.cutoffs.slice(0, 2).map((c) => formatFrequency(c.freqHz)).join(', ');
      els.summaryPill.textContent = `Passband: ${passbandStr} · fc: ${fcLabels}`;
    } else {
      els.summaryPill.textContent = `Passband: ${passbandStr} · No −3 dB fc`;
    }

    const cursorFreq = getActiveCursorFreq(res);
    const sample = cursorFreq ? interpolateBodeAtFreq(res, cursorFreq) : null;
    if (sample) {
      const fText = formatFrequency(sample.freqHz);
      const dbText = formatDbValue(sample.magDb);
      const linText = formatLinearGain(sample.magDb);
      const phaseText = Number.isFinite(sample.phaseDeg)
        ? `${sample.phaseDeg.toFixed(1)}°`
        : '---';
      els.readout.textContent = `${fText}  |  ${dbText} (${linText})  |  ${phaseText}`;
    } else {
      els.readout.textContent = '---  |  ---  |  ---';
    }
  }

  function drawBodeCanvas(capture) {
    if (!els?.canvas) return;
    resizeCanvasIfNeeded();

    const ctx = els.canvas.getContext('2d');
    if (!ctx) return;

    const { cssW, cssH, dpr } = canvasMetrics;
    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Pitch-black CRT background + radial dark-green phosphor glow
    ctx.fillStyle = '#030806';
    ctx.fillRect(0, 0, cssW, cssH);

    const grad = ctx.createRadialGradient(
      cssW * 0.5,
      cssH * 0.5,
      10,
      cssW * 0.5,
      cssH * 0.5,
      Math.max(cssW, cssH) * 0.72
    );
    grad.addColorStop(0, 'rgba(20, 83, 45, 0.16)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);

    const padLeft = 42;
    const padRight = 12;
    const padTop = 10;
    const padBottom = 18;
    const paneGap = 12;
    const plotW = Math.max(60, cssW - padLeft - padRight);
    const totalPlotH = Math.max(80, cssH - padTop - padBottom - paneGap);
    const magH = Math.round(totalPlotH * 0.58);
    const phaseH = Math.max(30, totalPlotH - magH);
    const magTop = padTop;
    const phaseTop = padTop + magH + paneGap;

    plotBounds = { padLeft, padRight, padTop, padBottom, plotW, plotH: totalPlotH + paneGap };

    const res = capture?.bodeResult || null;
    const startF = Math.max(1, res?.valid ? res.startFreqHz : config.startFreqHz);
    const stopF = Math.max(startF * 10, res?.valid ? res.stopFreqHz : config.stopFreqHz);
    const logStart = Math.log10(startF);
    const logStop = Math.log10(stopF);
    const logSpan = Math.max(1e-6, logStop - logStart);

    const freqToX = (f) => {
      const lf = Math.log10(Math.max(1e-9, f));
      return padLeft + ((lf - logStart) / logSpan) * plotW;
    };

    const { yMin: dbMin, yMax: dbMax, step: dbStep } = computeDbGridBounds(
      res?.valid ? res.passbandGainDb : 0,
      res?.valid ? res.minGainDb : -40
    );
    const dbSpan = Math.max(1, dbMax - dbMin);
    const dbToY = (db) => magTop + ((dbMax - db) / dbSpan) * magH;

    const phaseToY = (deg) => phaseTop + ((180 - deg) / 360) * phaseH;

    // 2. Log-Frequency Gridlines (both panes)
    const minExp = Math.floor(logStart);
    const maxExp = Math.ceil(logStop);

    // Minor sub-decade lines (2..9)
    ctx.strokeStyle = 'rgba(20, 83, 45, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let exp = minExp; exp <= maxExp; exp++) {
      const base = Math.pow(10, exp);
      for (let m = 2; m <= 9; m++) {
        const f = base * m;
        if (f <= startF || f >= stopF) continue;
        const x = Math.round(freqToX(f)) + 0.5;
        ctx.moveTo(x, magTop);
        ctx.lineTo(x, magTop + magH);
        ctx.moveTo(x, phaseTop);
        ctx.lineTo(x, phaseTop + phaseH);
      }
    }
    ctx.stroke();

    // Major decade lines + frequency labels
    ctx.strokeStyle = '#14532d';
    ctx.lineWidth = 1;
    ctx.font = "700 9.5px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let exp = minExp; exp <= maxExp; exp++) {
      const f = Math.pow(10, exp);
      if (f < startF * 0.999 || f > stopF * 1.001) continue;
      const x = Math.round(freqToX(f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, magTop);
      ctx.lineTo(x, magTop + magH);
      ctx.moveTo(x, phaseTop);
      ctx.lineTo(x, phaseTop + phaseH);
      ctx.stroke();

      const label = formatCompactAxisFreq(f);
      const labelX = clamp(x, padLeft + 10, padLeft + plotW - 10);
      ctx.fillText(label, labelX, phaseTop + phaseH + 4);
    }

    // 3. Top Pane Horizontal dB Grid & Labels
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = dbMin; db <= dbMax + 0.001; db += dbStep) {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.strokeStyle = db === 0 ? '#166534' : '#14532d';
      ctx.lineWidth = db === 0 ? 1.15 : 0.9;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = db === 0 ? '#94a3b8' : '#64748b';
      ctx.fillText(`${Math.round(db)}`, padLeft - 5, y);
    }

    // Top Pane Border & Label
    ctx.strokeStyle = '#1e3a2f';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 0.5, magTop + 0.5, plotW - 1, magH - 1);

    ctx.fillStyle = 'rgba(34, 243, 255, 0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('MAG (dB)', padLeft + 6, magTop + 4);

    // 4. Bottom Pane Horizontal Phase Grid & Labels (+180, +90, 0, -90, -180)
    const phaseTicks = [180, 90, 0, -90, -180];
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const deg of phaseTicks) {
      const y = Math.round(phaseToY(deg)) + 0.5;
      ctx.strokeStyle = deg === 0 ? '#166534' : '#14532d';
      ctx.lineWidth = deg === 0 ? 1.15 : 0.9;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = deg === 0 ? '#94a3b8' : '#64748b';
      const degLabel = deg > 0 ? `+${deg}°` : `${deg}°`;
      ctx.fillText(degLabel, padLeft - 5, y);
    }

    // Bottom Pane Border & Label
    ctx.strokeStyle = '#1e3a2f';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 0.5, phaseTop + 0.5, plotW - 1, phaseH - 1);

    ctx.fillStyle = 'rgba(34, 255, 102, 0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('PHASE (°)', padLeft + 6, phaseTop + 4);

    // 5. Plot Valid Bode Sweep Curves
    if (capture?.powered !== false && res?.valid && res.freqsHz?.length >= 2) {
      const n = res.freqsHz.length;

      // Magnitude Pane Clipped Drawing
      ctx.save();
      ctx.beginPath();
      ctx.rect(padLeft, magTop, plotW, magH);
      ctx.clip();

      // Subtle dashed -3 dB threshold line
      const minus3Db = res.passbandGainDb - CUTOFF_DROP_DB;
      if (minus3Db >= dbMin && minus3Db <= dbMax) {
        const y3 = dbToY(minus3Db);
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
        ctx.lineWidth = 1.1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padLeft, y3);
        ctx.lineTo(padLeft + plotW, y3);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = 'rgba(251, 191, 36, 0.78)';
        ctx.font = "700 9px 'JetBrains Mono', ui-monospace, monospace";
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('−3 dB', padLeft + plotW - 4, Math.max(magTop + 11, y3 - 2));
      }

      // Bright Cyan Magnitude Curve
      ctx.save();
      ctx.strokeStyle = '#22f3ff';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(34, 243, 255, 0.45)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      let startedMag = false;
      for (let i = 0; i < n; i++) {
        const f = res.freqsHz[i];
        const m = res.magDb[i];
        if (!Number.isFinite(f) || !Number.isFinite(m)) {
          startedMag = false;
          continue;
        }
        const x = freqToX(f);
        const y = dbToY(m);
        if (!startedMag) {
          ctx.moveTo(x, y);
          startedMag = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();

      // Glowing Amber Marker Dot + Frequency Label at each detected -3 dB cutoff
      if (Array.isArray(res.cutoffs) && res.cutoffs.length > 0) {
        for (const c of res.cutoffs) {
          if (!Number.isFinite(c?.freqHz)) continue;
          const cx = freqToX(c.freqHz);
          const cy = dbToY(minus3Db);
          if (cx < padLeft - 4 || cx > padLeft + plotW + 4) continue;

          ctx.save();
          ctx.fillStyle = '#fbbf24';
          ctx.shadowColor = 'rgba(251, 191, 36, 0.85)';
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fef3c7';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.restore();

          const fcText = `fc ${formatFrequency(c.freqHz)}`;
          ctx.font = "700 9.5px 'JetBrains Mono', ui-monospace, monospace";
          const textW = ctx.measureText(fcText).width;
          const preferLeft = cx > padLeft + plotW - textW - 14;
          const lx = preferLeft ? cx - 7 : cx + 7;
          const ly = clamp(cy - 8, magTop + 10, magTop + magH - 10);

          ctx.fillStyle = 'rgba(3, 8, 6, 0.85)';
          const boxX = preferLeft ? lx - textW - 4 : lx - 2;
          ctx.fillRect(boxX, ly - 6, textW + 6, 13);

          ctx.fillStyle = '#fbbf24';
          ctx.textAlign = preferLeft ? 'right' : 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(fcText, lx, ly);
        }
      }

      ctx.restore(); // end Mag clip

      // Phase Pane Clipped Drawing
      ctx.save();
      ctx.beginPath();
      ctx.rect(padLeft, phaseTop, plotW, phaseH);
      ctx.clip();

      ctx.save();
      ctx.strokeStyle = '#22ff66';
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(34, 255, 102, 0.4)';
      ctx.shadowBlur = 5;
      ctx.beginPath();
      let prevP = null;
      for (let i = 0; i < n; i++) {
        const f = res.freqsHz[i];
        const p = res.phaseDeg[i];
        if (!Number.isFinite(f) || !Number.isFinite(p)) {
          prevP = null;
          continue;
        }
        const x = freqToX(f);
        const y = phaseToY(p);
        if (prevP === null || Math.abs(p - prevP) > 270) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevP = p;
      }
      ctx.stroke();
      ctx.restore();

      ctx.restore(); // end Phase clip

      // 6. Interactive Frequency Cursor Line across both panes
      const cursorFreq = getActiveCursorFreq(res);
      if (cursorFreq) {
        const cx = clamp(freqToX(cursorFreq), padLeft, padLeft + plotW);
        ctx.save();
        ctx.strokeStyle = 'rgba(34, 243, 255, 0.88)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, magTop);
        ctx.lineTo(cx, magTop + magH);
        ctx.moveTo(cx, phaseTop);
        ctx.lineTo(cx, phaseTop + phaseH);
        ctx.stroke();
        ctx.restore();

        const sample = interpolateBodeAtFreq(res, cursorFreq);
        if (sample) {
          const my = clamp(dbToY(sample.magDb), magTop + 2, magTop + magH - 2);
          const py = clamp(phaseToY(sample.phaseDeg), phaseTop + 2, phaseTop + phaseH - 2);

          ctx.fillStyle = '#22f3ff';
          ctx.beginPath();
          ctx.arc(cx, my, 3.2, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#22ff66';
          ctx.beginPath();
          ctx.arc(cx, py, 3.0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.restore(); // end DPR scale

    updateHeaderAndReadout(capture);
  }

  function redrawCurrentState() {
    if (!frozenCapture && lastSnapshot) {
      frozenCapture = buildCaptureFromSnapshot(lastSnapshot);
    }
    drawBodeCanvas(frozenCapture || { powered: true, bodeResult: null });
  }

  function pointerClientXToFreq(clientX) {
    if (!els?.canvas) return null;
    const rect = els.canvas.getBoundingClientRect();
    if (!rect.width) return null;

    const scaleX = rect.width / Math.max(1, canvasMetrics.cssW);
    const localX = (clientX - rect.left) / scaleX;
    const frac = clamp((localX - plotBounds.padLeft) / Math.max(1, plotBounds.plotW), 0, 1);

    const res = frozenCapture?.bodeResult;
    const startF = Math.max(1, res?.valid ? res.startFreqHz : config.startFreqHz);
    const stopF = Math.max(startF * 10, res?.valid ? res.stopFreqHz : config.stopFreqHz);
    const logStart = Math.log10(startF);
    const logStop = Math.log10(stopF);
    return Math.pow(10, logStart + frac * (logStop - logStart));
  }

  function emitConfigChange({ affectsCircuit = true } = {}) {
    cb.onConfigChange({ ...createDefaultBodeConfig(config), running }, { affectsCircuit });
  }

  function bindEvents() {
    ac = new AbortController();
    const { signal } = ac;

    const applyRangeChange = (mutator) => {
      const draft = createDefaultBodeConfig(config);
      mutator(draft);
      config = createDefaultBodeConfig(draft);
      syncControlsFromConfig(lastSnapshot?.activeProbeTarget || null);
      emitConfigChange({ affectsCircuit: true });
    };

    els.startSelect.addEventListener('change', () => {
      const val = Number(els.startSelect.value);
      applyRangeChange((d) => {
        d.startFreqHz = val;
        if (d.stopFreqHz <= d.startFreqHz) {
          const bigger = STOP_FREQ_OPTIONS.find((o) => o.value > d.startFreqHz);
          d.stopFreqHz = bigger ? bigger.value : d.startFreqHz * 10;
        }
      });
    }, { signal });

    els.stopSelect.addEventListener('change', () => {
      const val = Number(els.stopSelect.value);
      applyRangeChange((d) => {
        d.stopFreqHz = val;
        if (d.startFreqHz >= d.stopFreqHz) {
          const smaller = [...START_FREQ_OPTIONS].reverse().find((o) => o.value < d.stopFreqHz);
          d.startFreqHz = smaller ? smaller.value : Math.max(1, d.stopFreqHz / 10);
        }
      });
    }, { signal });

    els.ptsSelect.addEventListener('change', () => {
      const val = Number(els.ptsSelect.value);
      applyRangeChange((d) => {
        d.stepsPerDecade = val;
      });
    }, { signal });

    els.inSource.addEventListener('change', () => {
      applyRangeChange((d) => {
        d.inputSource = els.inSource.value;
      });
    }, { signal });

    els.outSource.addEventListener('change', () => {
      applyRangeChange((d) => {
        d.outputSource = els.outSource.value;
      });
    }, { signal });

    els.inPick.addEventListener('click', () => {
      cb.onStartBodeProbe('input');
    }, { signal });

    els.outPick.addEventListener('click', () => {
      cb.onStartBodeProbe('output');
    }, { signal });

    els.powerBtn.addEventListener('click', () => {
      cb.onPowerToggle(true);
    }, { signal });

    // Interactive hover / drag frequency cursor on canvas
    els.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const freq = pointerClientXToFreq(e.clientX);
      if (!freq) return;
      isDraggingCursor = true;
      hoverFreqHz = freq;
      lastPointerFreqHz = freq;
      config = createDefaultBodeConfig({ ...config, cursorFreqHz: freq });
      els.canvas.classList.add('is-dragging-cursor');
      try {
        els.canvas.setPointerCapture?.(e.pointerId);
      } catch (_) {
        // Ignore synthetic events without pointerId
      }
      redrawCurrentState();
    }, { signal });

    els.canvas.addEventListener('pointermove', (e) => {
      if (isDraggingCursor) return;
      const freq = pointerClientXToFreq(e.clientX);
      if (!freq) return;
      hoverFreqHz = freq;
      lastPointerFreqHz = freq;
      redrawCurrentState();
    }, { signal });

    els.canvas.addEventListener('pointerleave', () => {
      if (isDraggingCursor) return;
      hoverFreqHz = null;
      redrawCurrentState();
    }, { signal });

    window.addEventListener('pointermove', (e) => {
      if (!isDraggingCursor) return;
      const freq = pointerClientXToFreq(e.clientX);
      if (!freq) return;
      hoverFreqHz = freq;
      lastPointerFreqHz = freq;
      config = createDefaultBodeConfig({ ...config, cursorFreqHz: freq });
      redrawCurrentState();
    }, { signal });

    const endDrag = () => {
      if (!isDraggingCursor) return;
      isDraggingCursor = false;
      hoverFreqHz = null;
      els?.canvas?.classList.remove('is-dragging-cursor');
      emitConfigChange({ affectsCircuit: false });
    };
    window.addEventListener('pointerup', endDrag, { signal });
    window.addEventListener('pointercancel', endDrag, { signal });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        redrawCurrentState();
      });
      resizeObserver.observe(els.canvas);
    }
  }

  function mount(containerEl) {
    if (!containerEl) {
      throw new Error('createBodeInstrument.mount requires containerEl');
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
    const rawCfg = snapshot?.config || snapshot?.bodeConfig;
    if (rawCfg && typeof rawCfg === 'object') {
      config = createDefaultBodeConfig(rawCfg);
      if (typeof rawCfg.running === 'boolean') {
        running = rawCfg.running;
      }
    }
    if (typeof snapshot?.running === 'boolean') {
      running = snapshot.running;
    }

    const forceCapture = Boolean(snapshot?.forceCapture);
    const wasPowered = frozenCapture?.powered;
    const isNowPowered = snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true;
    if (running || forceCapture || !frozenCapture || (!isNowPowered || (wasPowered === false && isNowPowered))) {
      frozenCapture = buildCaptureFromSnapshot(snapshot);
    }
    if (!els) return;

    syncControlsFromConfig(snapshot?.activeProbeTarget || null);
    drawBodeCanvas(frozenCapture);
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

  function onVisibilityChange(visible, _mode) {
    if (visible) {
      onLayoutChange();
    }
  }

  function destroy() {
    isDraggingCursor = false;
    hoverFreqHz = null;
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
    id: 'bode',
    label: 'Bode',
    title: 'Bode Analyzer',
    icon: BODE_TAB_ICON_SVG,
    preferredWidth: 'wide',
    computerTile: true,
    computerSlot: 'primary',
    computerLayout: 'focus-with-drawer',
    excludedAuxIds: ['fgen', 'arb'],
    mount,
    update,
    onLayoutChange,
    onVisibilityChange,
    resetFrozen,
    destroy
  };
}
