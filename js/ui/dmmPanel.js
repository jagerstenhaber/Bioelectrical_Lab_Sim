/**
 * Floating Virtual Multimeter (DMM) & Lab Supply Panel
 * Zero-dependency ES2022+ module for classroom projector and student usability.
 */

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

function formatSupplyValue(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '0.0 V';
  if (Math.abs(num) < 0.05) return '0.0 V';
  return `${num > 0 ? '+' : ''}${num.toFixed(1)} V`;
}

/**
 * Initializes the draggable floating Virtual Multimeter (DMM) & Lab Supply panel.
 *
 * @param {object} options
 * @param {HTMLElement} options.panelEl
 * @param {HTMLElement} [options.headerEl]
 * @param {HTMLElement} [options.toggleBtn]
 * @param {HTMLElement} [options.closeBtn]
 * @param {HTMLElement} [options.canvasWrap]
 * @param {object} [options.callbacks]
 */
export function initDmmPanel({
  panelEl,
  headerEl,
  toggleBtn,
  closeBtn,
  canvasWrap,
  callbacks = {}
} = {}) {
  if (!panelEl) {
    throw new Error('initDmmPanel requires panelEl');
  }

  const cb = {
    onOpenChange: callbacks.onOpenChange || (() => {}),
    onModeChange: callbacks.onModeChange || (() => {}),
    onStartProbe: callbacks.onStartProbe || (() => {}),
    onComToGnd: callbacks.onComToGnd || (() => {}),
    onClearProbes: callbacks.onClearProbes || (() => {}),
    onPowerToggle: callbacks.onPowerToggle || (() => {}),
    onSupplyChange: callbacks.onSupplyChange || (() => {}),
    onLoadChange: callbacks.onLoadChange || (() => {})
  };

  let resolvedHeaderEl = headerEl;
  let resolvedCloseBtn = closeBtn;

  if (!panelEl.querySelector('.dmm-body')) {
    panelEl.innerHTML = `
      <div class="dmm-header">
        <div class="dmm-title-group">
          <span class="dmm-badge">DMM</span>
          <span class="dmm-title">Multimeter &amp; Supply</span>
        </div>
        <div class="dmm-header-actions">
          <button type="button" class="dmm-power-pill is-on" data-dmm-power title="Toggle circuit power">Power: ON</button>
          <button type="button" class="dmm-close-btn" data-dmm-close title="Close Multimeter">✕</button>
        </div>
      </div>
      <div class="dmm-body">
        <div class="dmm-lcd" data-dmm-lcd>
          <div class="dmm-lcd-main">
            <div class="dmm-lcd-reading">
              <span class="dmm-lcd-value" data-dmm-value>---</span>
              <span class="dmm-lcd-unit" data-dmm-unit>V</span>
            </div>
            <span class="dmm-lcd-mode-badge" data-dmm-mode-badge>DC</span>
          </div>
          <div class="dmm-lcd-probes" data-dmm-probes>Red: —  |  COM: —</div>
          <div class="dmm-lcd-notice" data-dmm-notice hidden>
            <span class="dmm-notice-text" data-dmm-notice-text></span>
            <button type="button" class="dmm-inline-btn" data-dmm-inline-power hidden></button>
          </div>
        </div>

        <div class="dmm-mode-row" role="group" aria-label="Multimeter Mode">
          <button type="button" class="dmm-mode-btn is-active" data-dmm-mode="VDC">DC V</button>
          <button type="button" class="dmm-mode-btn" data-dmm-mode="OHM">Ohm</button>
          <button type="button" class="dmm-mode-btn" data-dmm-mode="CONT">Cont</button>
        </div>

        <div class="dmm-probe-row">
          <button type="button" class="dmm-probe-btn is-red" data-dmm-probe="red">🔴 Red (+)</button>
          <button type="button" class="dmm-probe-btn is-black" data-dmm-probe="black">⚫ Black (COM)</button>
          <button type="button" class="dmm-probe-btn" data-dmm-com-gnd title="Snap Black (COM) probe to Ground">COM→GND</button>
          <button type="button" class="dmm-probe-btn is-muted" data-dmm-clear>Clear</button>
        </div>

        <div class="dmm-stimuli" data-dmm-stimuli hidden>
          <div class="dmm-stimuli-title">Lab Supply &amp; Stimulus</div>
          <div class="dmm-slider-row" data-dmm-supply-pos-row hidden>
            <div class="dmm-slider-label">
              <label for="dmm-supply-pos">SUPPLY +</label>
              <span class="dmm-slider-val" data-dmm-supply-pos-val>+5.0 V</span>
            </div>
            <input id="dmm-supply-pos" data-dmm-supply-pos type="range" min="0" max="12" step="0.1" value="5" />
          </div>
          <div class="dmm-slider-row" data-dmm-supply-neg-row hidden>
            <div class="dmm-slider-label">
              <label for="dmm-supply-neg">SUPPLY −</label>
              <span class="dmm-slider-val" data-dmm-supply-neg-val>-5.0 V</span>
            </div>
            <input id="dmm-supply-neg" data-dmm-supply-neg type="range" min="-12" max="0" step="0.1" value="-5" />
          </div>
          <div class="dmm-slider-row" data-dmm-load-row hidden>
            <div class="dmm-slider-label">
              <label for="dmm-load-force">Load Cell Force</label>
              <span class="dmm-slider-val" data-dmm-load-val>0 g</span>
            </div>
            <input id="dmm-load-force" data-dmm-load-force type="range" min="0" max="1000" step="10" value="0" />
          </div>
        </div>
      </div>
    `;
  }

  resolvedHeaderEl = resolvedHeaderEl || panelEl.querySelector('.dmm-header');
  resolvedCloseBtn = resolvedCloseBtn || panelEl.querySelector('[data-dmm-close]');

  const els = {
    lcd: panelEl.querySelector('[data-dmm-lcd]'),
    value: panelEl.querySelector('[data-dmm-value]'),
    unit: panelEl.querySelector('[data-dmm-unit]'),
    modeBadge: panelEl.querySelector('[data-dmm-mode-badge]'),
    probes: panelEl.querySelector('[data-dmm-probes]'),
    noticeWrap: panelEl.querySelector('[data-dmm-notice]'),
    noticeText: panelEl.querySelector('[data-dmm-notice-text]'),
    inlinePowerBtn: panelEl.querySelector('[data-dmm-inline-power]'),
    powerPill: panelEl.querySelector('[data-dmm-power]'),
    modeBtns: Array.from(panelEl.querySelectorAll('[data-dmm-mode]')),
    probeRedBtn: panelEl.querySelector('[data-dmm-probe="red"]'),
    probeBlackBtn: panelEl.querySelector('[data-dmm-probe="black"]'),
    comGndBtn: panelEl.querySelector('[data-dmm-com-gnd]'),
    clearBtn: panelEl.querySelector('[data-dmm-clear]'),
    stimuliWrap: panelEl.querySelector('[data-dmm-stimuli]'),
    supplyPosRow: panelEl.querySelector('[data-dmm-supply-pos-row]'),
    supplyPosInput: panelEl.querySelector('[data-dmm-supply-pos]'),
    supplyPosVal: panelEl.querySelector('[data-dmm-supply-pos-val]'),
    supplyNegRow: panelEl.querySelector('[data-dmm-supply-neg-row]'),
    supplyNegInput: panelEl.querySelector('[data-dmm-supply-neg]'),
    supplyNegVal: panelEl.querySelector('[data-dmm-supply-neg-val]'),
    loadRow: panelEl.querySelector('[data-dmm-load-row]'),
    loadInput: panelEl.querySelector('[data-dmm-load-force]'),
    loadVal: panelEl.querySelector('[data-dmm-load-val]')
  };

  let currentState = {
    mode: 'VDC',
    powered: true,
    elvisSupplyPos: 5.0,
    elvisSupplyNeg: -5.0,
    loadCellForceGrams: 0
  };

  const isOpen = () => !panelEl.hidden;

  const setOpen = (open, { notify = true } = {}) => {
    const nextOpen = Boolean(open);
    const prevOpen = isOpen();
    panelEl.hidden = !nextOpen;
    toggleBtn?.classList.toggle('active', nextOpen);
    if (notify && nextOpen !== prevOpen) {
      cb.onOpenChange(nextOpen);
    }
  };

  const setNotice = (text, inlineAction = null, { isDanger = false } = {}) => {
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
  };

  const updateView = ({
    mode = 'VDC',
    powered = true,
    probeRed = null,
    probeBlack = null,
    activeProbeTarget = null,
    voltageResult = null,
    resistanceResult = null,
    elvisMode = false,
    loadCellsMode = false,
    simConfig = {},
    hasShortCircuit = false,
    transientNotice = null
  } = {}) => {
    const supplyPos = Number.isFinite(simConfig?.elvisSupplyPos) ? simConfig.elvisSupplyPos : 5.0;
    const supplyNeg = Number.isFinite(simConfig?.elvisSupplyNeg) ? simConfig.elvisSupplyNeg : -5.0;
    const loadGrams = Number.isFinite(simConfig?.loadCellForceGrams) ? simConfig.loadCellForceGrams : 0;

    currentState = {
      mode,
      powered: Boolean(powered),
      elvisSupplyPos: supplyPos,
      elvisSupplyNeg: supplyNeg,
      loadCellForceGrams: loadGrams
    };

    // Power pill
    els.powerPill.classList.toggle('is-on', currentState.powered);
    els.powerPill.classList.toggle('is-off', !currentState.powered);
    els.powerPill.textContent = currentState.powered ? 'Power: ON' : 'Power: OFF';

    // Mode active buttons & compact mode badge
    for (const btn of els.modeBtns) {
      btn.classList.toggle('is-active', btn.dataset.dmmMode === mode);
    }
    if (els.modeBadge) {
      els.modeBadge.textContent = mode === 'VDC' ? 'DC' : mode === 'OHM' ? 'OHM' : 'CONT';
    }

    // Probe active pulsing state & status line
    els.probeRedBtn.classList.toggle('is-probing', activeProbeTarget === 'red');
    els.probeBlackBtn.classList.toggle('is-probing', activeProbeTarget === 'black');
    els.probes.textContent = `Red: ${probeRed || '—'}  |  COM: ${probeBlack || '—'}`;

    // Reset LCD state classes
    els.lcd.classList.remove('is-warning', 'is-beep', 'is-floating');

    const missingProbes = !probeRed || !probeBlack;
    let noticeShown = false;

    if (mode === 'VDC') {
      els.unit.textContent = '';
      if (!currentState.powered) {
        els.value.textContent = 'OFF';
        els.lcd.classList.add('is-warning');
        setNotice('POWER OFF — Turn Power ON to measure DC voltage', {
          label: '⚡ Turn Power ON',
          targetPower: true
        });
        noticeShown = true;
      } else if (hasShortCircuit) {
        els.value.textContent = missingProbes
          ? '---'
          : voltageResult && voltageResult.valid && Number.isFinite(voltageResult.volts)
          ? getNumericDisplayAndUnit(formatVoltage(voltageResult.volts)).value
          : voltageResult && !voltageResult.valid
          ? 'FLOATING'
          : '---';
        if (voltageResult && voltageResult.valid && Number.isFinite(voltageResult.volts)) {
          els.unit.textContent = getNumericDisplayAndUnit(formatVoltage(voltageResult.volts)).unit || 'V';
        }
        els.lcd.classList.add('is-warning');
        setNotice('SHORT CIRCUIT — Supply rails shorted to GND', null, { isDanger: true });
        noticeShown = true;
      } else if (missingProbes) {
        els.value.textContent = '---';
        setNotice('Click Red (+) & Black (COM) below to probe any holes');
        noticeShown = true;
      } else if (voltageResult && !voltageResult.valid) {
        els.value.textContent = 'FLOATING';
        els.lcd.classList.add('is-floating');
        setNotice(voltageResult.floatingReason || 'Probe is on a floating net');
        noticeShown = true;
      } else if (voltageResult && voltageResult.valid && Number.isFinite(voltageResult.volts)) {
        const formatted = formatVoltage(voltageResult.volts);
        const parsed = getNumericDisplayAndUnit(formatted);
        els.value.textContent = parsed.value;
        els.unit.textContent = parsed.unit || 'V';
        setNotice(null);
      } else {
        els.value.textContent = '---';
        setNotice('Click Red (+) & Black (COM) below to probe any holes');
        noticeShown = true;
      }
    } else if (mode === 'OHM') {
      els.unit.textContent = 'Ω';
      if (currentState.powered) {
        els.value.textContent = 'PWR ON';
        els.unit.textContent = '';
        els.lcd.classList.add('is-warning');
        setNotice('Turn Power OFF before measuring resistance!', {
          label: 'Turn Power OFF',
          targetPower: false,
          danger: true
        });
        noticeShown = true;
      } else if (missingProbes) {
        els.value.textContent = '---';
        setNotice('Click Red (+) & Black (COM) below to probe any holes');
        noticeShown = true;
      } else if (resistanceResult && resistanceResult.valid) {
        const formatted = formatResistance(resistanceResult.ohms);
        if (formatted === 'OL') {
          els.value.textContent = 'OL';
          els.unit.textContent = 'MΩ';
        } else {
          const parsed = getNumericDisplayAndUnit(formatted);
          els.value.textContent = parsed.value;
          els.unit.textContent = parsed.unit || 'Ω';
        }
        setNotice(null);
      } else {
        els.value.textContent = '---';
        setNotice('Click Red (+) & Black (COM) below to probe any holes');
        noticeShown = true;
      }
    } else if (mode === 'CONT') {
      els.unit.textContent = '';
      if (currentState.powered) {
        els.value.textContent = 'PWR ON';
        els.lcd.classList.add('is-warning');
        setNotice('Turn Power OFF before measuring continuity!', {
          label: 'Turn Power OFF',
          targetPower: false,
          danger: true
        });
        noticeShown = true;
      } else if (missingProbes) {
        els.value.textContent = '---';
        setNotice('Click Red (+) & Black (COM) below to probe any holes');
        noticeShown = true;
      } else if (resistanceResult && resistanceResult.valid) {
        if (resistanceResult.continuity) {
          els.value.textContent = 'BEEP';
          els.unit.textContent = formatResistance(resistanceResult.ohms);
          els.lcd.classList.add('is-beep');
        } else {
          els.value.textContent = 'OPEN';
          els.unit.textContent = resistanceResult.open ? 'OL' : formatResistance(resistanceResult.ohms);
        }
        setNotice(null);
      } else {
        els.value.textContent = '---';
        setNotice('Click Red (+) & Black (COM) below to probe any holes');
        noticeShown = true;
      }
    }

    if (transientNotice && !(mode === 'VDC' && hasShortCircuit && currentState.powered)) {
      const keepInlineAction =
        !currentState.powered && mode === 'VDC'
          ? { label: '⚡ Turn Power ON', targetPower: true }
          : currentState.powered && (mode === 'OHM' || mode === 'CONT')
          ? { label: 'Turn Power OFF', targetPower: false, danger: true }
          : null;
      setNotice(transientNotice, keepInlineAction);
    } else if (!noticeShown && !transientNotice) {
      setNotice(null);
    }

    // Contextual Supply & Load Cell controls
    const showStimuli = Boolean(elvisMode || loadCellsMode);
    els.stimuliWrap.hidden = !showStimuli;
    els.supplyPosRow.hidden = !elvisMode;
    els.supplyNegRow.hidden = !elvisMode;
    els.loadRow.hidden = !loadCellsMode;

    if (elvisMode) {
      if (document.activeElement !== els.supplyPosInput) {
        els.supplyPosInput.value = String(supplyPos);
      }
      els.supplyPosVal.textContent = formatSupplyValue(supplyPos);
      if (document.activeElement !== els.supplyNegInput) {
        els.supplyNegInput.value = String(supplyNeg);
      }
      els.supplyNegVal.textContent = formatSupplyValue(supplyNeg);
    }
    if (loadCellsMode) {
      if (document.activeElement !== els.loadInput) {
        els.loadInput.value = String(loadGrams);
      }
      els.loadVal.textContent = `${Math.round(loadGrams)} g`;
    }
  };

  // Event bindings via AbortController for clean teardown
  const ac = new AbortController();
  const { signal } = ac;

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => setOpen(!isOpen()), { signal });
  }
  if (resolvedCloseBtn) {
    resolvedCloseBtn.addEventListener('click', () => setOpen(false), { signal });
  }

  for (const btn of els.modeBtns) {
    btn.addEventListener(
      'click',
      () => {
        cb.onModeChange(btn.dataset.dmmMode);
      },
      { signal }
    );
  }

  els.probeRedBtn.addEventListener('click', () => cb.onStartProbe('red'), { signal });
  els.probeBlackBtn.addEventListener('click', () => cb.onStartProbe('black'), { signal });
  els.comGndBtn.addEventListener('click', () => cb.onComToGnd(), { signal });
  els.clearBtn.addEventListener('click', () => cb.onClearProbes(), { signal });

  els.powerPill.addEventListener(
    'click',
    () => cb.onPowerToggle(!currentState.powered),
    { signal }
  );

  els.inlinePowerBtn.addEventListener(
    'click',
    () => {
      const next = els.inlinePowerBtn.dataset.targetPower === 'true';
      cb.onPowerToggle(next);
    },
    { signal }
  );

  els.supplyPosInput.addEventListener(
    'input',
    () => {
      const pos = Number(els.supplyPosInput.value);
      currentState.elvisSupplyPos = pos;
      els.supplyPosVal.textContent = formatSupplyValue(pos);
      cb.onSupplyChange({ pos, neg: currentState.elvisSupplyNeg });
    },
    { signal }
  );

  els.supplyNegInput.addEventListener(
    'input',
    () => {
      const neg = Number(els.supplyNegInput.value);
      currentState.elvisSupplyNeg = neg;
      els.supplyNegVal.textContent = formatSupplyValue(neg);
      cb.onSupplyChange({ pos: currentState.elvisSupplyPos, neg });
    },
    { signal }
  );

  els.loadInput.addEventListener(
    'input',
    () => {
      const grams = Number(els.loadInput.value);
      currentState.loadCellForceGrams = grams;
      els.loadVal.textContent = `${Math.round(grams)} g`;
      cb.onLoadChange(grams);
    },
    { signal }
  );

  // Header drag-to-move, clamped inside canvasWrap
  let dragState = null;

  if (resolvedHeaderEl) {
    resolvedHeaderEl.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const rect = panelEl.getBoundingClientRect();
        const wrapRect = canvasWrap
          ? canvasWrap.getBoundingClientRect()
          : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        dragState = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          origX: rect.left - wrapRect.left,
          origY: rect.top - wrapRect.top,
          panelW: rect.width,
          panelH: rect.height,
          wrapW: wrapRect.width,
          wrapH: wrapRect.height
        };
      },
      { signal }
    );
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(
      'pointermove',
      (e) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startClientX;
        const dy = e.clientY - dragState.startClientY;
        const maxX = Math.max(8, dragState.wrapW - dragState.panelW - 8);
        const maxY = Math.max(8, dragState.wrapH - dragState.panelH - 8);
        const nx = Math.min(maxX, Math.max(8, dragState.origX + dx));
        const ny = Math.min(maxY, Math.max(8, dragState.origY + dy));
        panelEl.style.left = `${nx}px`;
        panelEl.style.top = `${ny}px`;
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
      },
      { signal }
    );

    window.addEventListener(
      'pointerup',
      () => {
        dragState = null;
      },
      { signal }
    );
  }

  return {
    setOpen,
    isOpen,
    updateView,
    destroy() {
      ac.abort();
    }
  };
}
