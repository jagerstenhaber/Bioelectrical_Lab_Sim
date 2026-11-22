/**
 * NI ELVISmx Function Generator (FGEN) Soft Front Panel
 * Zero-dependency ES2022+ module implementing the InstrumentPanel contract.
 */

import {
  createDialSpinbox,
  createRunStopFooter,
  formatFrequency
} from './elvismxControls.js';
import { clamp, createDefaultFgenConfig } from '../sim/linearAlgebra.js';

const FGEN_TAB_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M6 12 C8 7.5 10 7.5 12 12 C14 16.5 16 16.5 18 12" />
  </svg>
`;

const WAVE_ICON_SINE = `
  <svg viewBox="0 0 28 18" fill="none" stroke="#22c55e" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 9 C5 2.5 8 2.5 11 9 C14 15.5 17 15.5 20 9 C22 4.8 24 4.8 26 9" />
  </svg>
`;

const WAVE_ICON_TRIANGLE = `
  <svg viewBox="0 0 28 18" fill="none" stroke="#f59e0b" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="2,9 8,3 20,15 26,9" />
  </svg>
`;

const WAVE_ICON_SQUARE = `
  <svg viewBox="0 0 28 18" fill="none" stroke="#22f3ff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="2,9 2,3 14,3 14,15 26,15 26,9" />
  </svg>
`;

const QUICK_FREQ_CHIPS = Object.freeze([
  { label: '10 Hz', hz: 10 },
  { label: '60 Hz', hz: 60 },
  { label: '100 Hz', hz: 100 },
  { label: '1 kHz', hz: 1000 },
  { label: '1.59 kHz', hz: 1592 }
]);

const WAVEFORM_LABELS = Object.freeze({
  sine: 'Sine',
  triangle: 'Triangle',
  square: 'Square'
});

const WAVEFORM_BADGES = Object.freeze({
  sine: 'SINE',
  triangle: 'TRI',
  square: 'SQR'
});

function clampNum(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return clamp(num, min, max);
}

function normalizeFgenConfig(raw = {}) {
  const base = createDefaultFgenConfig(raw);
  return {
    ...base,
    frequencyHz: clamp(base.frequencyHz, 0.5, 50000),
    amplitudeVpp: clamp(base.amplitudeVpp, 0, 10),
    dcOffsetV: clamp(base.dcOffsetV, -5, 5)
  };
}

function splitFormattedFrequency(hz) {
  const formatted = formatFrequency(hz);
  const parts = formatted.split(/\s+/);
  if (parts.length >= 2) {
    return { value: parts[0], unit: parts.slice(1).join(' ') };
  }
  return { value: formatted, unit: '' };
}

/**
 * Creates the Dark-Adapted NI ELVISmx Function Generator (FGEN) instrument panel.
 *
 * @param {object} [options]
 * @param {object} [options.callbacks]
 * @returns {object} InstrumentPanel implementation
 */
export function createFgenInstrument({ callbacks = {} } = {}) {
  const cb = {
    onConfigChange: callbacks.onConfigChange || (() => {}),
    onRunStateChange: callbacks.onRunStateChange || (() => {}),
    onStartFgenProbe: callbacks.onStartFgenProbe || (() => {}),
    onClearFgenProbe: callbacks.onClearFgenProbe || (() => {})
  };

  let mountContainer = null;
  let ac = null;
  let freqDial = null;
  let ampDial = null;
  let offsetDial = null;
  let runStopFooter = null;
  let els = null;

  let currentConfig = normalizeFgenConfig();
  let currentEnv = {
    powered: true,
    elvisMode: false,
    elvisFgenWired: false,
    isProbing: false
  };
  let lastSnapshot = null;

  function renderMarkup(containerEl) {
    const chipsHtml = QUICK_FREQ_CHIPS.map(
      (chip) =>
        `<button type="button" class="elvis-freq-chip" data-fgen-freq-chip="${chip.hz}">${chip.label}</button>`
    ).join('');

    containerEl.innerHTML = `
      <section class="elvis-sfp elvis-fgen" aria-label="NI ELVISmx Function Generator">
        <header class="elvis-sfp-header">
          <div class="elvis-sfp-title-wrap">
            <span class="elvis-sfp-badge">FGEN</span>
            <h3 class="elvis-sfp-title">Function Generator</h3>
          </div>
          <span class="elvis-sfp-badge">NI ELVISmx</span>
        </header>

        <div class="elvis-sfp-body">
          <div class="elvis-screen" data-fgen-screen>
            <div class="elvis-screen-meta">
              <span class="elvis-run-pill is-hold" data-fgen-status-pill>■ STANDBY</span>
              <span class="elvis-screen-probes" data-fgen-terminal>No Output Wired</span>
            </div>

            <div class="elvis-lcd-main">
              <div class="elvis-lcd-reading">
                <span class="elvis-lcd-value" data-fgen-freq-val>100.0</span>
                <span class="elvis-lcd-unit" data-fgen-freq-unit>Hz</span>
              </div>
              <span class="elvis-lcd-mode-badge" data-fgen-wave-badge>SINE</span>
            </div>

            <div class="elvis-fgen-summary" data-fgen-summary>Sine · 2.00 Vpp (50 Ω out) · Offset 0.00 V</div>
          </div>

          <fieldset class="elvis-group">
            <legend class="elvis-group-legend">Waveform Settings</legend>

            <div class="elvis-wave-bar" role="group" aria-label="FGEN Waveform Type">
              <button type="button" class="elvis-mode-btn is-active" data-fgen-wave="sine" title="Sine Wave">
                <span class="elvis-mode-icon" aria-hidden="true">${WAVE_ICON_SINE}</span>
                <span class="elvis-mode-label">Sine</span>
              </button>
              <button type="button" class="elvis-mode-btn" data-fgen-wave="triangle" title="Triangle Wave">
                <span class="elvis-mode-icon" aria-hidden="true">${WAVE_ICON_TRIANGLE}</span>
                <span class="elvis-mode-label">Triangle</span>
              </button>
              <button type="button" class="elvis-mode-btn" data-fgen-wave="square" title="Square Wave">
                <span class="elvis-mode-icon" aria-hidden="true">${WAVE_ICON_SQUARE}</span>
                <span class="elvis-mode-label">Square</span>
              </button>
            </div>

            <div class="elvis-freq-chips" role="group" aria-label="Quick Lab Frequencies">
              ${chipsHtml}
            </div>

            <div class="elvis-dial-grid">
              <div data-fgen-dial-freq></div>
              <div class="elvis-dial-col" data-fgen-amp-col>
                <div data-fgen-dial-amp></div>
                <div class="elvis-dial-sub" data-fgen-vpk-helper>±1.00 Vpk</div>
              </div>
              <div data-fgen-dial-offset></div>
            </div>

            <div class="elvis-duty-row" data-fgen-duty-row hidden>
              <label class="elvis-duty-label-wrap">
                <span class="elvis-duty-label">Duty Cycle</span>
                <input class="elvis-duty-range" type="range" min="5" max="95" step="1" value="50" data-fgen-duty-range />
              </label>
              <div class="elvis-duty-num-wrap">
                <input class="elvis-dial-input elvis-duty-input" type="number" min="5" max="95" step="1" value="50" aria-label="Duty Cycle Percent" data-fgen-duty-input />
                <span class="elvis-dial-unit">%</span>
              </div>
            </div>
          </fieldset>

          <fieldset class="elvis-group">
            <legend class="elvis-group-legend">Output Connection</legend>
            <div class="elvis-fgen-conn-bar">
              <div class="elvis-fgen-conn-status" data-fgen-conn-status>
                Breadboard Mode — use Board Probe
              </div>
              <div class="elvis-fgen-conn-actions">
                <button type="button" class="elvis-probe-btn elvis-fgen-probe-btn" data-fgen-probe-btn title="Pick breadboard hole for FGEN output">
                  <span>📌 Board Probe</span>
                  <span class="elvis-jack-hole" data-fgen-probe-hole>Pick Hole</span>
                </button>
                <button type="button" class="elvis-probe-btn is-muted" data-fgen-probe-clear title="Clear FGEN board probe">Clear</button>
              </div>
            </div>
          </fieldset>

          <fieldset class="elvis-group">
            <legend class="elvis-group-legend">Instrument Control</legend>
            <div data-fgen-runstop-slot></div>
          </fieldset>
        </div>
      </section>
    `;

    freqDial = createDialSpinbox({
      label: 'Frequency',
      value: currentConfig.frequencyHz,
      min: 0.5,
      max: 50000,
      step: 0.1,
      unit: 'Hz',
      logScale: true,
      onChange: (hz) => {
        currentConfig = { ...currentConfig, frequencyHz: clampNum(hz, 0.5, 50000, 100) };
        syncScreenAndControls();
        cb.onConfigChange({ ...currentConfig });
      }
    });
    containerEl.querySelector('[data-fgen-dial-freq]').replaceWith(freqDial.el);

    ampDial = createDialSpinbox({
      label: 'Amplitude',
      value: currentConfig.amplitudeVpp,
      min: 0,
      max: 10,
      step: 0.1,
      unit: 'Vpp',
      onChange: (vpp) => {
        currentConfig = { ...currentConfig, amplitudeVpp: clampNum(vpp, 0, 10, 2.0) };
        syncScreenAndControls();
        cb.onConfigChange({ ...currentConfig });
      }
    });
    containerEl.querySelector('[data-fgen-dial-amp]').replaceWith(ampDial.el);

    offsetDial = createDialSpinbox({
      label: 'DC Offset',
      value: currentConfig.dcOffsetV,
      min: -5,
      max: 5,
      step: 0.1,
      unit: 'V',
      onChange: (dc) => {
        currentConfig = { ...currentConfig, dcOffsetV: clampNum(dc, -5, 5, 0.0) };
        syncScreenAndControls();
        cb.onConfigChange({ ...currentConfig });
      }
    });
    containerEl.querySelector('[data-fgen-dial-offset]').replaceWith(offsetDial.el);

    runStopFooter = createRunStopFooter({
      onRun: () => setEnabled(true),
      onStop: () => setEnabled(false)
    });
    containerEl.querySelector('[data-fgen-runstop-slot]').replaceWith(runStopFooter.el);

    els = {
      screen: containerEl.querySelector('[data-fgen-screen]'),
      statusPill: containerEl.querySelector('[data-fgen-status-pill]'),
      terminal: containerEl.querySelector('[data-fgen-terminal]'),
      freqVal: containerEl.querySelector('[data-fgen-freq-val]'),
      freqUnit: containerEl.querySelector('[data-fgen-freq-unit]'),
      waveBadge: containerEl.querySelector('[data-fgen-wave-badge]'),
      summary: containerEl.querySelector('[data-fgen-summary]'),
      waveBtns: Array.from(containerEl.querySelectorAll('[data-fgen-wave]')),
      freqChips: Array.from(containerEl.querySelectorAll('[data-fgen-freq-chip]')),
      vpkHelper: containerEl.querySelector('[data-fgen-vpk-helper]'),
      dutyRow: containerEl.querySelector('[data-fgen-duty-row]'),
      dutyRange: containerEl.querySelector('[data-fgen-duty-range]'),
      dutyInput: containerEl.querySelector('[data-fgen-duty-input]'),
      connStatus: containerEl.querySelector('[data-fgen-conn-status]'),
      probeBtn: containerEl.querySelector('[data-fgen-probe-btn]'),
      probeHoleTag: containerEl.querySelector('[data-fgen-probe-hole]'),
      probeClearBtn: containerEl.querySelector('[data-fgen-probe-clear]')
    };
  }

  function formatTerminalReadout() {
    if (currentEnv.elvisMode && currentConfig.probeHole) {
      return `ELVIS Row 33 + Probe: ${currentConfig.probeHole}`;
    }
    if (currentEnv.elvisMode) {
      return 'ELVIS FGEN (Row 33)';
    }
    if (currentConfig.probeHole) {
      return `Probe: ${currentConfig.probeHole}`;
    }
    return 'No Output Wired';
  }

  function syncScreenAndControls() {
    if (!els) return;

    const { enabled, waveform, frequencyHz, amplitudeVpp, dcOffsetV, dutyCycle, probeHole } =
      currentConfig;
    const { powered, elvisMode, elvisFgenWired, isProbing } = currentEnv;

    const isActiveOutput = enabled && powered;
    els.screen.classList.toggle('is-warning', !powered);

    els.statusPill.classList.toggle('is-running', isActiveOutput);
    els.statusPill.classList.toggle('is-hold', !isActiveOutput);
    els.statusPill.textContent = !powered
      ? '⚡ POWER OFF'
      : isActiveOutput
      ? '● OUTPUT ON'
      : '■ STANDBY';

    els.terminal.textContent = formatTerminalReadout();

    const freqParts = splitFormattedFrequency(frequencyHz);
    els.freqVal.textContent = freqParts.value;
    els.freqUnit.textContent = freqParts.unit;
    els.waveBadge.textContent = WAVEFORM_BADGES[waveform] || 'SINE';

    const vpk = amplitudeVpp / 2;
    const waveLabel = WAVEFORM_LABELS[waveform] || 'Sine';
    els.summary.textContent = `${waveLabel} · ${amplitudeVpp.toFixed(2)} Vpp (50 Ω out) · Offset ${dcOffsetV.toFixed(2)} V`;
    els.vpkHelper.textContent = `±${vpk.toFixed(2)} Vpk`;

    for (const btn of els.waveBtns) {
      const isSelected = btn.dataset.fgenWave === waveform;
      btn.classList.toggle('is-active', isSelected);
      btn.setAttribute('aria-pressed', String(isSelected));
    }

    for (const chip of els.freqChips) {
      const chipHz = Number(chip.dataset.fgenFreqChip);
      const isMatch = Math.abs(frequencyHz - chipHz) <= Math.max(0.05, chipHz * 0.002);
      chip.classList.toggle('is-active', isMatch);
    }

    freqDial?.setValue(frequencyHz);
    ampDial?.setValue(amplitudeVpp);
    offsetDial?.setValue(dcOffsetV);

    const isSquare = waveform === 'square';
    els.dutyRow.hidden = !isSquare;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    if (activeEl !== els.dutyRange) {
      els.dutyRange.value = String(Math.round(dutyCycle));
    }
    if (activeEl !== els.dutyInput) {
      els.dutyInput.value = String(Math.round(dutyCycle));
    }

    if (elvisMode) {
      els.connStatus.textContent = elvisFgenWired
        ? 'ELVIS Row 33 (FGEN) — Connected'
        : 'ELVIS Row 33 (FGEN) — Ready';
    } else if (probeHole) {
      els.connStatus.textContent = `Injecting at hole ${probeHole}`;
    } else {
      els.connStatus.textContent = 'Standard Board — pick a hole to inject';
    }

    els.probeBtn.classList.toggle('is-probing', Boolean(isProbing));
    els.probeHoleTag.textContent = probeHole || 'Pick Hole';
    els.probeClearBtn.disabled = !probeHole;

    runStopFooter?.setRunning(enabled);
  }

  function setEnabled(nextEnabled) {
    const enabled = Boolean(nextEnabled);
    if (currentConfig.enabled === enabled) {
      runStopFooter?.setRunning(enabled);
      return;
    }
    currentConfig = { ...currentConfig, enabled };
    syncScreenAndControls();
    cb.onRunStateChange(enabled);
  }

  function mount(containerEl) {
    if (!containerEl) {
      throw new Error('createFgenInstrument.mount requires containerEl');
    }
    destroy();
    mountContainer = containerEl;
    renderMarkup(containerEl);

    ac = new AbortController();
    const { signal } = ac;

    for (const btn of els.waveBtns) {
      btn.addEventListener('click', () => {
        const nextWave = btn.dataset.fgenWave;
        if (!WAVEFORM_LABELS[nextWave]) return;
        currentConfig = { ...currentConfig, waveform: nextWave };
        syncScreenAndControls();
        cb.onConfigChange({ ...currentConfig });
      }, { signal });
    }

    for (const chip of els.freqChips) {
      chip.addEventListener('click', () => {
        const hz = Number(chip.dataset.fgenFreqChip);
        if (!Number.isFinite(hz) || hz <= 0) return;
        currentConfig = { ...currentConfig, frequencyHz: hz };
        syncScreenAndControls();
        cb.onConfigChange({ ...currentConfig });
      }, { signal });
    }

    els.dutyRange.addEventListener('input', () => {
      const duty = clampNum(els.dutyRange.value, 5, 95, 50);
      currentConfig = { ...currentConfig, dutyCycle: duty };
      syncScreenAndControls();
      cb.onConfigChange({ ...currentConfig });
    }, { signal });

    const handleDutyInput = () => {
      if (els.dutyInput.value.trim() === '') return;
      const parsed = Number(els.dutyInput.value);
      if (!Number.isFinite(parsed)) return;
      const duty = clampNum(parsed, 5, 95, 50);
      currentConfig = { ...currentConfig, dutyCycle: duty };
      syncScreenAndControls();
      cb.onConfigChange({ ...currentConfig });
    };
    els.dutyInput.addEventListener('input', handleDutyInput, { signal });
    els.dutyInput.addEventListener('change', handleDutyInput, { signal });
    els.dutyInput.addEventListener('blur', () => {
      els.dutyInput.value = String(Math.round(currentConfig.dutyCycle));
    }, { signal });

    els.probeBtn.addEventListener('click', () => {
      cb.onStartFgenProbe();
    }, { signal });

    els.probeClearBtn.addEventListener('click', () => {
      cb.onClearFgenProbe();
    }, { signal });

    if (lastSnapshot) {
      update(lastSnapshot);
    } else {
      syncScreenAndControls();
    }
  }

  function update(snapshot = {}) {
    lastSnapshot = snapshot;
    const rawFgen = snapshot?.fgen && typeof snapshot.fgen === 'object' ? snapshot.fgen : snapshot;
    currentConfig = normalizeFgenConfig(rawFgen);
    currentEnv = {
      powered: snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true,
      elvisMode: Boolean(snapshot?.elvisMode),
      elvisFgenWired: Boolean(snapshot?.elvisFgenWired ?? snapshot?.elvisFgenConnected),
      isProbing: Boolean(snapshot?.isProbingFgen || snapshot?.activeProbeTarget === 'fgen')
    };
    syncScreenAndControls();
  }

  function onLayoutChange(_mode) {
    // Panel adapts cleanly via CSS in both dock and full-bench grid layouts.
  }

  function onVisibilityChange(_visible, _mode) {
    // No background timers to pause; re-sync controls on mount/update.
  }

  function destroy() {
    if (ac) {
      ac.abort();
      ac = null;
    }
    freqDial?.destroy();
    freqDial = null;
    ampDial?.destroy();
    ampDial = null;
    offsetDial?.destroy();
    offsetDial = null;
    runStopFooter?.destroy();
    runStopFooter = null;
    els = null;
    if (mountContainer) {
      mountContainer.innerHTML = '';
      mountContainer = null;
    }
  }

  return {
    id: 'fgen',
    label: 'FGEN',
    title: 'Function Generator',
    icon: FGEN_TAB_ICON_SVG,
    preferredWidth: 'compact',
    computerTile: true,
    computerSlot: 'aux',
    mount,
    update,
    onLayoutChange,
    onVisibilityChange,
    destroy
  };
}
