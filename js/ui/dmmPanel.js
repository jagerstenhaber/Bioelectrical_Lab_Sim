/**
 * NI ELVISmx Digital Multimeter (DMM) Soft Front Panel
 * Zero-dependency ES2022+ module implementing the InstrumentPanel contract.
 */

import {
  computeBarGraphPercent,
  createBarGraphElement,
  createRunStopFooter
} from './elvismxControls.js';

const VOLT_NEAR_ZERO = 5e-6;

/**
 * Formats a DC voltage reading for the DMM LCD readout.
 * - Returns '+0.000 V' when |V| < 5e-6 V
 * - Uses mV for 5e-6 <= |V| < 0.999995 V
 * - Uses V for |V| >= 0.999995 V
 * @param {number} volts
 * @returns {string}
 */
export function formatVoltage(volts) {
  if (!Number.isFinite(volts)) return '---';
  const absV = Math.abs(volts);
  if (absV < VOLT_NEAR_ZERO) {
    return '+0.000 V';
  }
  const sign = volts >= 0 ? '+' : '-';
  if (absV < 0.999995) {
    const mv = absV * 1000;
    return `${sign}${mv.toFixed(2)} mV`;
  }
  return `${sign}${absV.toFixed(3)} V`;
}

/**
 * Formats an AC RMS voltage reading for the DMM LCD readout (unsigned magnitude).
 * - Returns '0.000 V' when Vrms < 5e-6 V
 * - Uses mV for 5e-6 <= Vrms < 0.999995 V
 * - Uses V for Vrms >= 0.999995 V
 * @param {number} voltsRms
 * @returns {string}
 */
export function formatAcVoltage(voltsRms) {
  if (!Number.isFinite(voltsRms)) return '---';
  const absV = Math.abs(voltsRms);
  if (absV < VOLT_NEAR_ZERO) {
    return '0.000 V';
  }
  if (absV < 0.999995) {
    const mv = absV * 1000;
    return `${mv.toFixed(1)} mV`;
  }
  return `${absV.toFixed(3)} V`;
}

/**
 * Formats a resistance reading for the DMM LCD readout.
 * @param {number} ohms
 * @returns {string}
 */
export function formatResistance(ohms) {
  if (!Number.isFinite(ohms) || ohms > 2e7 || ohms < 0) {
    return 'OL';
  }
  if (ohms < 1000) {
    return `${ohms.toFixed(1)} Ω`;
  }
  if (ohms < 1e6) {
    return `${(ohms / 1000).toFixed(2)} kΩ`;
  }
  return `${(ohms / 1e6).toFixed(2)} MΩ`;
}

function getNumericDisplayAndUnit(formatted) {
  const parts = String(formatted).trim().split(/\s+/);
  if (parts.length >= 2) {
    return { value: parts[0], unit: parts.slice(1).join(' ') };
  }
  return { value: formatted, unit: '' };
}

const DMM_TAB_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="2" width="16" height="20" rx="2.5" />
    <rect x="7" y="5" width="10" height="5" rx="1" />
    <circle cx="12" cy="15" r="3" />
    <line x1="12" y1="15" x2="14" y2="13" />
  </svg>
`;

const MODE_ICON_VDC = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.5 6.5 L8.5 16.5 L12.5 6.5" />
    <line x1="14" y1="9.5" x2="20.5" y2="9.5" />
    <line x1="14" y1="13.5" x2="15.7" y2="13.5" />
    <line x1="16.9" y1="13.5" x2="18.1" y2="13.5" />
    <line x1="19.3" y1="13.5" x2="20.5" y2="13.5" />
  </svg>
`;

const MODE_ICON_VAC = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 6.5 L8 16.5 L12 6.5" />
    <path d="M13.5 11.8 C14.5 8.5 16 8.5 17 11.8 C18 15.1 19.5 15.1 20.5 11.8" />
  </svg>
`;

const MODE_ICON_OHM = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 17.5 H8.5 C6.8 15.6 6 13.5 6 11.2 C6 7.4 8.7 4.8 12 4.8 C15.3 4.8 18 7.4 18 11.2 C18 13.5 17.2 15.6 15.5 17.5 H19" />
  </svg>
`;

const MODE_ICON_CONT = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <circle cx="6.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M10.2 9.2 A4.2 4.2 0 0 1 10.2 14.8" />
    <path d="M13.3 7.1 A7.2 7.2 0 0 1 13.3 16.9" />
    <path d="M16.4 5.1 A10.2 10.2 0 0 1 16.4 18.9" />
  </svg>
`;

/**
 * Creates the Dark-Adapted NI ELVISmx Digital Multimeter (DMM) instrument panel.
 *
 * @param {object} [options]
 * @param {object} [options.callbacks]
 * @returns {object} InstrumentPanel implementation
 */
export function createDmmInstrument({ callbacks = {} } = {}) {
  const cb = {
    onModeChange: callbacks.onModeChange || (() => {}),
    onStartProbe: callbacks.onStartProbe || (() => {}),
    onComToGnd: callbacks.onComToGnd || (() => {}),
    onClearProbes: callbacks.onClearProbes || (() => {}),
    onPowerToggle: callbacks.onPowerToggle || (() => {}),
    onRunStateChange: callbacks.onRunStateChange || (() => {})
  };

  let mountContainer = null;
  let ac = null;
  let barGraph = null;
  let runStopFooter = null;
  let els = null;

  let running = true;
  let lastSnapshot = null;
  let frozenDisplay = null;
  let frozenMeta = null;

  function renderMarkup(containerEl) {
    containerEl.innerHTML = `
      <section class="elvis-sfp elvis-dmm" aria-label="NI ELVISmx Digital Multimeter">
        <header class="elvis-sfp-header">
          <div class="elvis-sfp-title-wrap">
            <span class="elvis-sfp-badge">DMM</span>
            <h3 class="elvis-sfp-title">Digital Multimeter</h3>
          </div>
          <span class="elvis-sfp-badge">NI ELVISmx</span>
        </header>

        <div class="elvis-sfp-body">
          <div class="elvis-screen" data-dmm-screen>
            <div class="elvis-screen-meta">
              <span class="elvis-run-pill is-running" data-dmm-run-pill>● RUNNING</span>
              <span class="elvis-screen-probes" data-dmm-probes>Red: —  |  COM: —</span>
            </div>

            <div class="elvis-lcd-main">
              <div class="elvis-lcd-reading">
                <span class="elvis-lcd-value" data-dmm-value>---</span>
                <span class="elvis-lcd-unit" data-dmm-unit>V</span>
              </div>
              <span class="elvis-lcd-mode-badge" data-dmm-mode-badge>DC</span>
            </div>

            <div data-dmm-bargraph-slot></div>

            <div class="elvis-screen-notice" data-dmm-notice hidden>
              <span class="elvis-notice-text" data-dmm-notice-text></span>
              <button type="button" class="elvis-inline-btn" data-dmm-inline-power hidden></button>
            </div>
          </div>

          <fieldset class="elvis-group">
            <legend class="elvis-group-legend">Measurement Settings</legend>
            <div class="elvis-mode-bar" role="group" aria-label="Multimeter Measurement Mode">
              <button type="button" class="elvis-mode-btn is-active" data-dmm-mode="VDC" title="DC Voltage (V⎓)">
                <span class="elvis-mode-icon" aria-hidden="true">${MODE_ICON_VDC}</span>
                <span class="elvis-mode-label">DC V</span>
              </button>
              <button type="button" class="elvis-mode-btn" data-dmm-mode="VAC" title="AC RMS Voltage (V~)">
                <span class="elvis-mode-icon" aria-hidden="true">${MODE_ICON_VAC}</span>
                <span class="elvis-mode-label">AC V</span>
              </button>
              <button type="button" class="elvis-mode-btn" data-dmm-mode="OHM" title="Resistance (Ω)">
                <span class="elvis-mode-icon" aria-hidden="true">${MODE_ICON_OHM}</span>
                <span class="elvis-mode-label">Ohm</span>
              </button>
              <button type="button" class="elvis-mode-btn" data-dmm-mode="CONT" title="Continuity Beeper">
                <span class="elvis-mode-icon" aria-hidden="true">${MODE_ICON_CONT}</span>
                <span class="elvis-mode-label">Cont</span>
              </button>
            </div>
          </fieldset>

          <fieldset class="elvis-group">
            <legend class="elvis-group-legend">Probe Connections</legend>
            <div class="elvis-probe-grid">
              <button type="button" class="elvis-probe-btn is-red" data-dmm-probe="red" title="Place Red (+) probe on breadboard">
                <span class="elvis-jack-label">
                  <span class="elvis-jack-dot is-red" aria-hidden="true"></span>
                  <span>Red (+)</span>
                </span>
                <span class="elvis-jack-hole" data-dmm-hole-red>—</span>
              </button>
              <button type="button" class="elvis-probe-btn is-black" data-dmm-probe="black" title="Place Black (COM) probe on breadboard">
                <span class="elvis-jack-label">
                  <span class="elvis-jack-dot is-black" aria-hidden="true"></span>
                  <span>COM (−)</span>
                </span>
                <span class="elvis-jack-hole" data-dmm-hole-black>—</span>
              </button>
              <button type="button" class="elvis-probe-btn is-utility" data-dmm-com-gnd title="Snap Black (COM) probe to Ground">COM → GND</button>
              <button type="button" class="elvis-probe-btn is-muted" data-dmm-clear title="Clear both DMM probes">Clear</button>
            </div>
          </fieldset>

          <fieldset class="elvis-group">
            <legend class="elvis-group-legend">Instrument Control</legend>
            <div data-dmm-runstop-slot></div>
          </fieldset>
        </div>
      </section>
    `;

    barGraph = createBarGraphElement(30);
    const barSlot = containerEl.querySelector('[data-dmm-bargraph-slot]');
    barSlot.replaceWith(barGraph.el);

    runStopFooter = createRunStopFooter({
      onRun: () => setRunning(true),
      onStop: () => setRunning(false)
    });
    const runStopSlot = containerEl.querySelector('[data-dmm-runstop-slot]');
    runStopSlot.replaceWith(runStopFooter.el);

    els = {
      screen: containerEl.querySelector('[data-dmm-screen]'),
      runPill: containerEl.querySelector('[data-dmm-run-pill]'),
      probes: containerEl.querySelector('[data-dmm-probes]'),
      value: containerEl.querySelector('[data-dmm-value]'),
      unit: containerEl.querySelector('[data-dmm-unit]'),
      modeBadge: containerEl.querySelector('[data-dmm-mode-badge]'),
      noticeWrap: containerEl.querySelector('[data-dmm-notice]'),
      noticeText: containerEl.querySelector('[data-dmm-notice-text]'),
      inlinePowerBtn: containerEl.querySelector('[data-dmm-inline-power]'),
      modeBtns: Array.from(containerEl.querySelectorAll('[data-dmm-mode]')),
      probeRedBtn: containerEl.querySelector('[data-dmm-probe="red"]'),
      probeBlackBtn: containerEl.querySelector('[data-dmm-probe="black"]'),
      holeRed: containerEl.querySelector('[data-dmm-hole-red]'),
      holeBlack: containerEl.querySelector('[data-dmm-hole-black]'),
      comGndBtn: containerEl.querySelector('[data-dmm-com-gnd]'),
      clearBtn: containerEl.querySelector('[data-dmm-clear]')
    };
  }

  function setNotice(text, inlineAction = null, { isDanger = false } = {}) {
    if (!els) return;
    if (!text) {
      els.noticeWrap.hidden = true;
      els.noticeWrap.classList.remove('is-danger');
      els.noticeText.textContent = '';
      els.inlinePowerBtn.hidden = true;
      els.inlinePowerBtn.classList.remove('is-danger-action');
      return;
    }
    els.noticeWrap.hidden = false;
    els.noticeWrap.classList.toggle('is-danger', Boolean(isDanger));
    els.noticeText.textContent = text;
    if (inlineAction) {
      els.inlinePowerBtn.hidden = false;
      els.inlinePowerBtn.textContent = inlineAction.label;
      els.inlinePowerBtn.dataset.targetPower = String(inlineAction.targetPower);
      els.inlinePowerBtn.classList.toggle('is-danger-action', Boolean(inlineAction.danger));
    } else {
      els.inlinePowerBtn.hidden = true;
      els.inlinePowerBtn.classList.remove('is-danger-action');
    }
  }

  function computeDisplayFromSnapshot(snapshot) {
    const {
      mode = 'VDC',
      powered = true,
      probeRed = null,
      probeBlack = null,
      voltageResult = null,
      acVoltageResult = null,
      resistanceResult = null,
      hasShortCircuit = false,
      transientNotice = null
    } = snapshot || {};

    const missingProbes = !probeRed || !probeBlack;
    let valueText = '---';
    let unitText = '';
    let screenClass = '';
    let barPercent = 0;
    let barActive = false;
    let notice = null;

    let isPowerNotice = false;

    if (mode === 'VDC') {
      if (!powered) {
        valueText = 'OFF';
        screenClass = 'is-warning';
        isPowerNotice = true;
        notice = {
          text: 'POWER OFF — Turn Power ON to measure DC voltage',
          inlineAction: { label: '⚡ Turn Power ON', targetPower: true },
          isDanger: false
        };
      } else if (hasShortCircuit) {
        if (!missingProbes && voltageResult && voltageResult.valid && Number.isFinite(voltageResult.volts)) {
          const parsed = getNumericDisplayAndUnit(formatVoltage(voltageResult.volts));
          valueText = parsed.value;
          unitText = parsed.unit || 'V';
          barPercent = computeBarGraphPercent(voltageResult.volts, 'VDC').percent;
          barActive = true;
        } else if (!missingProbes && voltageResult && !voltageResult.valid) {
          valueText = 'FLOATING';
        }
        screenClass = 'is-warning';
        notice = {
          text: 'SHORT CIRCUIT — Supply rails shorted to GND',
          inlineAction: null,
          isDanger: true
        };
      } else if (missingProbes) {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      } else if (voltageResult && !voltageResult.valid) {
        valueText = 'FLOATING';
        screenClass = 'is-floating';
        notice = {
          text: voltageResult.floatingReason || 'Probe is on a floating net',
          inlineAction: null,
          isDanger: false
        };
      } else if (voltageResult && voltageResult.valid && Number.isFinite(voltageResult.volts)) {
        const parsed = getNumericDisplayAndUnit(formatVoltage(voltageResult.volts));
        valueText = parsed.value;
        unitText = parsed.unit || 'V';
        barPercent = computeBarGraphPercent(voltageResult.volts, 'VDC').percent;
        barActive = true;
      } else {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      }
    } else if (mode === 'VAC') {
      if (!powered) {
        valueText = 'OFF';
        screenClass = 'is-warning';
        isPowerNotice = true;
        notice = {
          text: 'POWER OFF — Turn Power ON to measure AC voltage',
          inlineAction: { label: '⚡ Turn Power ON', targetPower: true },
          isDanger: false
        };
      } else if (hasShortCircuit) {
        if (!missingProbes && acVoltageResult && acVoltageResult.valid && Number.isFinite(acVoltageResult.voltsRms)) {
          const parsed = getNumericDisplayAndUnit(formatAcVoltage(acVoltageResult.voltsRms));
          valueText = parsed.value;
          unitText = parsed.unit || 'V';
          barPercent = computeBarGraphPercent(Math.abs(acVoltageResult.voltsRms), 'VAC').percent;
          barActive = true;
        } else if (!missingProbes && acVoltageResult && !acVoltageResult.valid) {
          valueText = 'FLOATING';
        }
        screenClass = 'is-warning';
        notice = {
          text: 'SHORT CIRCUIT — Supply rails shorted to GND',
          inlineAction: null,
          isDanger: true
        };
      } else if (missingProbes) {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      } else if (acVoltageResult && !acVoltageResult.valid) {
        valueText = 'FLOATING';
        screenClass = 'is-floating';
        notice = {
          text: acVoltageResult.floatingReason || 'Probe is on a floating net',
          inlineAction: null,
          isDanger: false
        };
      } else if (acVoltageResult && acVoltageResult.valid && Number.isFinite(acVoltageResult.voltsRms)) {
        const absRms = Math.abs(acVoltageResult.voltsRms);
        const parsed = getNumericDisplayAndUnit(formatAcVoltage(absRms));
        valueText = parsed.value;
        unitText = parsed.unit || 'V';
        barPercent = computeBarGraphPercent(absRms, 'VAC').percent;
        barActive = true;
      } else {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      }
    } else if (mode === 'OHM') {
      unitText = 'Ω';
      if (powered) {
        valueText = 'PWR ON';
        unitText = '';
        screenClass = 'is-warning';
        isPowerNotice = true;
        notice = {
          text: 'Turn Power OFF before measuring resistance!',
          inlineAction: { label: 'Turn Power OFF', targetPower: false, danger: true },
          isDanger: false
        };
      } else if (missingProbes) {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      } else if (resistanceResult && resistanceResult.valid) {
        const formatted = formatResistance(resistanceResult.ohms);
        if (formatted === 'OL') {
          valueText = 'OL';
          unitText = 'MΩ';
          barPercent = 0;
          barActive = false;
        } else {
          const parsed = getNumericDisplayAndUnit(formatted);
          valueText = parsed.value;
          unitText = parsed.unit || 'Ω';
          barPercent = computeBarGraphPercent(resistanceResult.ohms, 'OHM').percent;
          barActive = true;
        }
      } else {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      }
    } else if (mode === 'CONT') {
      if (powered) {
        valueText = 'PWR ON';
        screenClass = 'is-warning';
        isPowerNotice = true;
        notice = {
          text: 'Turn Power OFF before measuring continuity!',
          inlineAction: { label: 'Turn Power OFF', targetPower: false, danger: true },
          isDanger: false
        };
      } else if (missingProbes) {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      } else if (resistanceResult && resistanceResult.valid) {
        if (resistanceResult.continuity) {
          valueText = 'BEEP';
          unitText = formatResistance(resistanceResult.ohms);
          screenClass = 'is-beep';
          barPercent = computeBarGraphPercent(true, 'CONT').percent;
          barActive = true;
        } else {
          valueText = 'OPEN';
          unitText = resistanceResult.open ? 'OL' : formatResistance(resistanceResult.ohms);
          barPercent = computeBarGraphPercent(false, 'CONT').percent;
          barActive = false;
        }
      } else {
        valueText = '---';
        notice = {
          text: 'Click Red (+) & Black (COM) below to probe any holes',
          inlineAction: null,
          isDanger: false
        };
      }
    }

    if (transientNotice && !((mode === 'VDC' || mode === 'VAC') && hasShortCircuit && powered)) {
      const keepInlineAction =
        !powered && (mode === 'VDC' || mode === 'VAC')
          ? { label: '⚡ Turn Power ON', targetPower: true }
          : powered && (mode === 'OHM' || mode === 'CONT')
          ? { label: 'Turn Power OFF', targetPower: false, danger: true }
          : null;
      notice = {
        text: transientNotice,
        inlineAction: keepInlineAction,
        isDanger: false
      };
    }

    return {
      mode,
      valueText,
      unitText,
      screenClass,
      barPercent,
      barActive,
      notice,
      isPowerNotice
    };
  }

  function buildFrozenMeta(snapshot, display) {
    return {
      mode: snapshot?.mode || 'VDC',
      probeRed: snapshot?.probeRed || null,
      probeBlack: snapshot?.probeBlack || null,
      powered: snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true,
      isPowerNotice: Boolean(display?.isPowerNotice)
    };
  }

  function applyDisplay(display, snapshot) {
    if (!els) return;

    const mode = display.mode || snapshot?.mode || 'VDC';
    const probeRed = snapshot?.probeRed || null;
    const probeBlack = snapshot?.probeBlack || null;
    const activeProbeTarget = snapshot?.activeProbeTarget || null;

    // Run / Hold badge & footer buttons
    els.runPill.classList.toggle('is-running', running);
    els.runPill.classList.toggle('is-hold', !running);
    els.runPill.textContent = running ? '● RUNNING' : '■ HOLD';
    runStopFooter.setRunning(running);

    // Mode buttons & mode badge
    for (const btn of els.modeBtns) {
      btn.classList.toggle('is-active', btn.dataset.dmmMode === mode);
    }
    els.modeBadge.textContent =
      mode === 'VDC' ? 'DC' : mode === 'VAC' ? 'AC' : mode === 'OHM' ? 'OHM' : 'CONT';

    // Probe connections & live summary
    els.probeRedBtn.classList.toggle('is-probing', activeProbeTarget === 'red');
    els.probeBlackBtn.classList.toggle('is-probing', activeProbeTarget === 'black');
    els.holeRed.textContent = probeRed || '—';
    els.holeBlack.textContent = probeBlack || '—';
    els.probes.textContent = `Red: ${probeRed || '—'}  |  COM: ${probeBlack || '—'}`;

    // Screen state & digits
    els.screen.classList.remove('is-warning', 'is-beep', 'is-floating');
    if (display.screenClass) {
      els.screen.classList.add(display.screenClass);
    }
    els.value.textContent = display.valueText;
    els.unit.textContent = display.unitText;
    barGraph.update(display.barPercent, display.barActive);

    if (display.notice) {
      setNotice(display.notice.text, display.notice.inlineAction, {
        isDanger: display.notice.isDanger
      });
    } else {
      setNotice(null);
    }
  }

  function setRunning(nextRunning, { notify = true, resetFrozen = false } = {}) {
    const prevRunning = running;
    const next = Boolean(nextRunning);
    running = next;

    if (resetFrozen) {
      frozenDisplay = null;
      frozenMeta = null;
    }

    if (!running) {
      if (!resetFrozen && !frozenDisplay && lastSnapshot) {
        frozenDisplay = computeDisplayFromSnapshot(lastSnapshot);
        frozenMeta = buildFrozenMeta(lastSnapshot, frozenDisplay);
      }
      if (els) {
        if (frozenDisplay) {
          applyDisplay(frozenDisplay, lastSnapshot);
        } else {
          els.runPill.classList.remove('is-running');
          els.runPill.classList.add('is-hold');
          els.runPill.textContent = '■ HOLD';
          runStopFooter.setRunning(false);
        }
      }
    } else {
      frozenDisplay = null;
      frozenMeta = null;
      if (els && lastSnapshot) {
        update(lastSnapshot);
      } else if (els) {
        els.runPill.classList.add('is-running');
        els.runPill.classList.remove('is-hold');
        els.runPill.textContent = '● RUNNING';
        runStopFooter.setRunning(true);
      }
    }

    if (notify && next !== prevRunning) {
      cb.onRunStateChange(running);
    }
  }

  function mount(containerEl) {
    if (!containerEl) {
      throw new Error('createDmmInstrument.mount requires containerEl');
    }
    destroy();
    mountContainer = containerEl;
    renderMarkup(containerEl);

    ac = new AbortController();
    const { signal } = ac;

    for (const btn of els.modeBtns) {
      btn.addEventListener('click', () => {
        cb.onModeChange(btn.dataset.dmmMode);
      }, { signal });
    }

    els.probeRedBtn.addEventListener('click', () => cb.onStartProbe('red'), { signal });
    els.probeBlackBtn.addEventListener('click', () => cb.onStartProbe('black'), { signal });
    els.comGndBtn.addEventListener('click', () => cb.onComToGnd(), { signal });
    els.clearBtn.addEventListener('click', () => cb.onClearProbes(), { signal });

    els.inlinePowerBtn.addEventListener('click', () => {
      const next = els.inlinePowerBtn.dataset.targetPower === 'true';
      cb.onPowerToggle(next);
    }, { signal });

    if (lastSnapshot) {
      update(lastSnapshot);
    } else {
      applyDisplay(computeDisplayFromSnapshot({}), {});
    }
  }

  function update(snapshot = {}) {
    lastSnapshot = snapshot;
    if (!els) return;

    if (!running) {
      const nextMode = snapshot?.mode || 'VDC';
      const nextRed = snapshot?.probeRed || null;
      const nextBlack = snapshot?.probeBlack || null;
      const nextPowered = snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true;

      if (!frozenDisplay || !frozenMeta) {
        frozenDisplay = computeDisplayFromSnapshot(snapshot);
        frozenMeta = buildFrozenMeta(snapshot, frozenDisplay);
      } else if (
        nextMode !== frozenMeta.mode ||
        nextRed !== frozenMeta.probeRed ||
        nextBlack !== frozenMeta.probeBlack
      ) {
        running = true;
        frozenDisplay = null;
        frozenMeta = null;
        runStopFooter.setRunning(true);
        cb.onRunStateChange(true);
        const liveDisplay = computeDisplayFromSnapshot(snapshot);
        frozenDisplay = liveDisplay;
        frozenMeta = buildFrozenMeta(snapshot, liveDisplay);
        applyDisplay(liveDisplay, snapshot);
        return;
      } else if (frozenMeta.isPowerNotice && nextPowered !== frozenMeta.powered) {
        frozenDisplay = computeDisplayFromSnapshot(snapshot);
        frozenMeta = buildFrozenMeta(snapshot, frozenDisplay);
      }

      let displayToApply = frozenDisplay;
      if (
        snapshot?.transientNotice &&
        !((frozenDisplay.mode === 'VDC' || frozenDisplay.mode === 'VAC') && snapshot.hasShortCircuit && nextPowered)
      ) {
        const keepInlineAction =
          !nextPowered && (frozenDisplay.mode === 'VDC' || frozenDisplay.mode === 'VAC')
            ? { label: '⚡ Turn Power ON', targetPower: true }
            : nextPowered && (frozenDisplay.mode === 'OHM' || frozenDisplay.mode === 'CONT')
            ? { label: 'Turn Power OFF', targetPower: false, danger: true }
            : null;
        displayToApply = {
          ...frozenDisplay,
          notice: {
            text: snapshot.transientNotice,
            inlineAction: keepInlineAction,
            isDanger: false
          }
        };
      }

      applyDisplay(displayToApply, snapshot);
      return;
    }

    const display = computeDisplayFromSnapshot(snapshot);
    frozenDisplay = display;
    frozenMeta = buildFrozenMeta(snapshot, display);
    applyDisplay(display, snapshot);
  }

  function onLayoutChange(_mode) {
    // Panel adapts via CSS in both dock and computer grid layouts.
  }

  function destroy() {
    if (ac) {
      ac.abort();
      ac = null;
    }
    if (runStopFooter) {
      runStopFooter.destroy();
      runStopFooter = null;
    }
    barGraph = null;
    els = null;
    if (mountContainer) {
      mountContainer.innerHTML = '';
      mountContainer = null;
    }
  }

  return {
    id: 'dmm',
    label: 'DMM',
    title: 'Digital Multimeter',
    icon: DMM_TAB_ICON_SVG,
    preferredWidth: 'compact',
    computerTile: true,
    mount,
    update,
    onLayoutChange,
    setRunning,
    isRunning: () => running,
    destroy
  };
}
