/**
 * NI ELVISmx Variable Power Supplies (VPS) Soft Front Panel
 * Zero-dependency ES2022+ module implementing the InstrumentPanel contract.
 */

import {
  createDialSpinbox,
  createRunStopFooter
} from './elvismxControls.js';

const VPS_TAB_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M8 9 V13 M6 11 H10" />
    <path d="M14 11 H18" />
    <line x1="7" y1="16" x2="17" y2="16" stroke-opacity="0.5" />
  </svg>
`;

const SUPPLY_POS_MIN = 0;
const SUPPLY_POS_MAX = 12;
const SUPPLY_NEG_MIN = -12;
const SUPPLY_NEG_MAX = 0;

function clampNum(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function formatVpsVoltage(volts, { showPlus = false } = {}) {
  if (!Number.isFinite(volts) || Math.abs(volts) < 0.005) {
    return '0.00 V';
  }
  const fixed = Math.abs(volts).toFixed(2);
  if (volts < 0) {
    return `-${fixed} V`;
  }
  return showPlus ? `+${fixed} V` : `${fixed} V`;
}

/**
 * Creates the Dark-Adapted NI ELVISmx Variable Power Supplies (VPS) instrument panel.
 *
 * @param {object} [options]
 * @param {object} [options.callbacks]
 * @returns {object} InstrumentPanel implementation
 */
export function createVpsInstrument({ callbacks = {} } = {}) {
  const cb = {
    onSupplyChange: callbacks.onSupplyChange || (() => {}),
    onRunStateChange: callbacks.onRunStateChange || (() => {}),
    onEnableElvisMode: callbacks.onEnableElvisMode || (() => {}),
    onPowerToggle: callbacks.onPowerToggle || (() => {})
  };

  let mountContainer = null;
  let ac = null;
  let negDial = null;
  let posDial = null;
  let runStopFooter = null;
  let els = null;

  let currentState = {
    powered: true,
    elvisMode: false,
    vpsEnabled: true,
    pos: 5.0,
    neg: -5.0
  };
  let lastSnapshot = null;

  function renderMarkup(containerEl) {
    containerEl.innerHTML = `
      <section class="elvis-sfp elvis-vps" aria-label="NI ELVISmx Variable Power Supplies">
        <header class="elvis-sfp-header">
          <div class="elvis-sfp-title-wrap">
            <span class="elvis-sfp-badge">VPS</span>
            <h3 class="elvis-sfp-title">Variable Power Supplies</h3>
          </div>
          <span class="elvis-sfp-badge">NI ELVISMX</span>
        </header>

        <div class="elvis-sfp-body">
          <div class="elvis-screen" data-vps-screen>
            <div class="elvis-screen-meta">
              <span class="elvis-run-pill is-running" data-vps-status-pill>● OUTPUT ON</span>
              <span class="elvis-screen-probes">Rows 48 / 50 (SUPPLY ±)</span>
            </div>

            <div class="elvis-vps-readouts" data-vps-readouts>
              <div class="elvis-vps-readout-col">
                <span class="elvis-vps-readout-label">SUPPLY −</span>
                <span class="elvis-vps-readout-val" data-vps-neg-readout>-5.00 V</span>
              </div>
              <div class="elvis-vps-readout-col">
                <span class="elvis-vps-readout-label">SUPPLY +</span>
                <span class="elvis-vps-readout-val" data-vps-pos-readout>+5.00 V</span>
              </div>
            </div>

            <div class="elvis-screen-notice" data-vps-notice hidden>
              <span class="elvis-notice-text" data-vps-notice-text></span>
              <button type="button" class="elvis-inline-btn" data-vps-notice-action hidden></button>
            </div>
          </div>

          <div class="elvis-vps-channels">
            <fieldset class="elvis-group elvis-vps-channel-card">
              <legend class="elvis-group-legend">Supply -</legend>
              <div data-vps-dial-neg></div>
              <button type="button" class="elvis-vps-reset-btn" data-vps-reset="neg" title="Reset Supply − to 0.00 V">RESET</button>
            </fieldset>

            <fieldset class="elvis-group elvis-vps-channel-card">
              <legend class="elvis-group-legend">Supply +</legend>
              <div data-vps-dial-pos></div>
              <button type="button" class="elvis-vps-reset-btn" data-vps-reset="pos" title="Reset Supply + to 0.00 V">RESET</button>
            </fieldset>
          </div>

          <fieldset class="elvis-group">
            <legend class="elvis-group-legend">Instrument Control</legend>
            <div data-vps-runstop-slot></div>
          </fieldset>
        </div>
      </section>
    `;

    negDial = createDialSpinbox({
      label: 'Voltage',
      value: currentState.neg,
      min: SUPPLY_NEG_MIN,
      max: SUPPLY_NEG_MAX,
      step: 0.1,
      unit: 'V',
      onChange: (val) => {
        currentState = {
          ...currentState,
          neg: clampNum(val, SUPPLY_NEG_MIN, SUPPLY_NEG_MAX, -5.0)
        };
        syncScreenAndControls();
        cb.onSupplyChange({ pos: currentState.pos, neg: currentState.neg });
      }
    });
    containerEl.querySelector('[data-vps-dial-neg]').replaceWith(negDial.el);

    posDial = createDialSpinbox({
      label: 'Voltage',
      value: currentState.pos,
      min: SUPPLY_POS_MIN,
      max: SUPPLY_POS_MAX,
      step: 0.1,
      unit: 'V',
      onChange: (val) => {
        currentState = {
          ...currentState,
          pos: clampNum(val, SUPPLY_POS_MIN, SUPPLY_POS_MAX, 5.0)
        };
        syncScreenAndControls();
        cb.onSupplyChange({ pos: currentState.pos, neg: currentState.neg });
      }
    });
    containerEl.querySelector('[data-vps-dial-pos]').replaceWith(posDial.el);

    runStopFooter = createRunStopFooter({
      onRun: () => setVpsEnabled(true),
      onStop: () => setVpsEnabled(false)
    });
    containerEl.querySelector('[data-vps-runstop-slot]').replaceWith(runStopFooter.el);

    els = {
      screen: containerEl.querySelector('[data-vps-screen]'),
      statusPill: containerEl.querySelector('[data-vps-status-pill]'),
      readouts: containerEl.querySelector('[data-vps-readouts]'),
      negReadout: containerEl.querySelector('[data-vps-neg-readout]'),
      posReadout: containerEl.querySelector('[data-vps-pos-readout]'),
      noticeWrap: containerEl.querySelector('[data-vps-notice]'),
      noticeText: containerEl.querySelector('[data-vps-notice-text]'),
      noticeActionBtn: containerEl.querySelector('[data-vps-notice-action]'),
      resetNegBtn: containerEl.querySelector('[data-vps-reset="neg"]'),
      resetPosBtn: containerEl.querySelector('[data-vps-reset="pos"]')
    };
  }

  function syncScreenAndControls() {
    if (!els) return;

    const { powered, elvisMode, vpsEnabled, pos, neg } = currentState;
    const isOutputActive = powered && elvisMode && vpsEnabled;

    let statusText = '● OUTPUT ON';
    let pillStateClass = 'is-running';
    if (!elvisMode) {
      statusText = 'ELVIS MODE OFF';
      pillStateClass = 'is-off';
    } else if (!powered) {
      statusText = '○ POWER OFF';
      pillStateClass = 'is-off';
    } else if (!vpsEnabled) {
      statusText = '■ STANDBY (0.00 V)';
      pillStateClass = 'is-hold';
    }

    els.statusPill.textContent = statusText;
    els.statusPill.classList.toggle('is-running', pillStateClass === 'is-running');
    els.statusPill.classList.toggle('is-hold', pillStateClass === 'is-hold');
    els.statusPill.classList.toggle('is-off', pillStateClass === 'is-off');

    els.screen.classList.toggle('is-warning', !elvisMode || !powered);
    els.readouts.classList.toggle('is-inactive', !isOutputActive);

    if (isOutputActive) {
      els.negReadout.textContent = formatVpsVoltage(neg, { showPlus: false });
      els.posReadout.textContent = formatVpsVoltage(pos, { showPlus: true });
    } else {
      els.negReadout.textContent = '0.00 V';
      els.posReadout.textContent = '0.00 V';
    }

    if (!elvisMode) {
      els.noticeWrap.hidden = false;
      els.noticeText.textContent = 'Enable NI ELVIS II mode to use Variable Power Supplies';
      els.noticeActionBtn.hidden = false;
      els.noticeActionBtn.textContent = '🔌 Enable NI ELVIS II';
      els.noticeActionBtn.dataset.vpsAction = 'enable-elvis';
    } else if (!powered) {
      els.noticeWrap.hidden = false;
      els.noticeText.textContent = 'Lab Power is OFF — Turn Power ON to energize supplies';
      els.noticeActionBtn.hidden = false;
      els.noticeActionBtn.textContent = '⚡ Turn Power ON';
      els.noticeActionBtn.dataset.vpsAction = 'power-on';
    } else {
      els.noticeWrap.hidden = true;
      els.noticeText.textContent = '';
      els.noticeActionBtn.hidden = true;
      delete els.noticeActionBtn.dataset.vpsAction;
    }

    negDial?.setValue(neg);
    posDial?.setValue(pos);
    runStopFooter?.setRunning(vpsEnabled);
  }

  function setVpsEnabled(nextEnabled) {
    const enabled = Boolean(nextEnabled);
    if (currentState.vpsEnabled === enabled) {
      runStopFooter?.setRunning(enabled);
      return;
    }
    currentState = { ...currentState, vpsEnabled: enabled };
    syncScreenAndControls();
    cb.onRunStateChange(enabled);
  }

  function mount(containerEl) {
    if (!containerEl) {
      throw new Error('createVpsInstrument.mount requires containerEl');
    }
    destroy();
    mountContainer = containerEl;
    renderMarkup(containerEl);

    ac = new AbortController();
    const { signal } = ac;

    els.resetNegBtn.addEventListener('click', () => {
      currentState = { ...currentState, neg: 0 };
      negDial?.setValue(0, { forceInput: true });
      syncScreenAndControls();
      cb.onSupplyChange({ pos: currentState.pos, neg: 0 });
    }, { signal });

    els.resetPosBtn.addEventListener('click', () => {
      currentState = { ...currentState, pos: 0 };
      posDial?.setValue(0, { forceInput: true });
      syncScreenAndControls();
      cb.onSupplyChange({ pos: 0, neg: currentState.neg });
    }, { signal });

    els.noticeActionBtn.addEventListener('click', () => {
      const action = els.noticeActionBtn.dataset.vpsAction;
      if (action === 'enable-elvis') {
        cb.onEnableElvisMode();
      } else if (action === 'power-on') {
        cb.onPowerToggle(true);
      }
    }, { signal });

    if (lastSnapshot) {
      update(lastSnapshot);
    } else {
      syncScreenAndControls();
    }
  }

  function update(snapshot = {}) {
    lastSnapshot = snapshot;
    const rawPos = snapshot?.elvisSupplyPos ?? snapshot?.supplyPos ?? snapshot?.pos;
    const rawNeg = snapshot?.elvisSupplyNeg ?? snapshot?.supplyNeg ?? snapshot?.neg;
    const rawEnabled = snapshot?.vpsEnabled ?? snapshot?.enabled ?? snapshot?.running;

    currentState = {
      powered: snapshot?.powered !== undefined ? Boolean(snapshot.powered) : true,
      elvisMode: Boolean(snapshot?.elvisMode),
      vpsEnabled: rawEnabled !== undefined ? Boolean(rawEnabled) : currentState.vpsEnabled,
      pos: rawPos !== undefined ? clampNum(rawPos, SUPPLY_POS_MIN, SUPPLY_POS_MAX, 5.0) : currentState.pos,
      neg: rawNeg !== undefined ? clampNum(rawNeg, SUPPLY_NEG_MIN, SUPPLY_NEG_MAX, -5.0) : currentState.neg
    };
    syncScreenAndControls();
  }

  function onLayoutChange(_mode) {
    // Panel adapts via CSS in both dock and full-bench grid layouts.
  }

  function onVisibilityChange(_visible, _mode) {
    // No background timers to pause; re-syncs cleanly via update().
  }

  function destroy() {
    if (ac) {
      ac.abort();
      ac = null;
    }
    negDial?.destroy();
    negDial = null;
    posDial?.destroy();
    posDial = null;
    runStopFooter?.destroy();
    runStopFooter = null;
    els = null;
    if (mountContainer) {
      mountContainer.innerHTML = '';
      mountContainer = null;
    }
  }

  return {
    id: 'vps',
    label: 'VPS',
    title: 'Variable Power Supplies',
    icon: VPS_TAB_ICON_SVG,
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
