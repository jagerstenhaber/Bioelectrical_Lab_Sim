/**
 * Option C Workspace Manager
 * Manages the Collapsible Tabbed Right Instrument Dock, Slim Launcher Rail,
 * Full Bench ("Computer View") grid, and shared Bench Supply & Load Cell controls.
 */

function formatSupplyValue(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '0.0 V';
  if (Math.abs(num) < 0.05) return '0.0 V';
  return `${num > 0 ? '+' : ''}${num.toFixed(1)} V`;
}

function buildStimulusRowsHtml(idPrefix) {
  return `
    <div class="bench-slider-row" data-bench-supply-pos-row hidden>
      <div class="bench-slider-label">
        <label for="${idPrefix}-supply-pos">ELVIS SUPPLY +</label>
        <span class="bench-slider-val" data-bench-supply-pos-val>+5.0 V</span>
      </div>
      <input id="${idPrefix}-supply-pos" data-bench-supply-pos type="range" min="0" max="12" step="0.1" value="5" />
    </div>
    <div class="bench-slider-row" data-bench-supply-neg-row hidden>
      <div class="bench-slider-label">
        <label for="${idPrefix}-supply-neg">ELVIS SUPPLY −</label>
        <span class="bench-slider-val" data-bench-supply-neg-val>-5.0 V</span>
      </div>
      <input id="${idPrefix}-supply-neg" data-bench-supply-neg type="range" min="-12" max="0" step="0.1" value="-5" />
    </div>
    <div class="bench-slider-row" data-bench-load-row hidden>
      <div class="bench-slider-label">
        <label for="${idPrefix}-load-force">Load Cell Force</label>
        <span class="bench-slider-val" data-bench-load-val>0 g</span>
      </div>
      <input id="${idPrefix}-load-force" data-bench-load-force type="range" min="0" max="1000" step="10" value="0" />
    </div>
    <div class="bench-emg-group" data-bench-emg-group hidden>
      <div class="bench-slider-row">
        <div class="bench-slider-label">
          <label for="${idPrefix}-emg-flex">EMG Flex</label>
          <span class="bench-slider-val" data-bench-emg-flex-val>50%</span>
        </div>
        <input id="${idPrefix}-emg-flex" data-bench-emg-flex type="range" min="0" max="100" step="5" value="50" />
      </div>
      <div class="bench-emg-mode-row">
        <span class="bench-emg-mode-label">Mode</span>
        <button type="button" class="bench-emg-mode-btn is-burst" data-bench-emg-mode aria-pressed="true" title="Toggle EMG Burst vs Continuous Hold">Burst</button>
      </div>
      <div class="bench-slider-row">
        <div class="bench-slider-label">
          <label for="${idPrefix}-emg-hum">60 Hz Hum</label>
          <span class="bench-slider-val" data-bench-emg-hum-val>0 mVpp</span>
        </div>
        <input id="${idPrefix}-emg-hum" data-bench-emg-hum type="range" min="0" max="50" step="1" value="0" />
      </div>
    </div>
  `;
}

/**
 * Creates the Option C Workspace Manager controlling the Right Instrument Dock
 * and Full Bench ("Computer View") mode.
 *
 * @param {object} options
 * @param {HTMLElement} options.appShellEl
 * @param {HTMLElement} options.dockEl
 * @param {object} [options.callbacks]
 */
export function createWorkspaceManager({
  appShellEl,
  dockEl,
  callbacks = {}
} = {}) {
  if (!appShellEl || !dockEl) {
    throw new Error('createWorkspaceManager requires appShellEl and dockEl');
  }

  const cb = {
    onPowerToggle: callbacks.onPowerToggle || (() => {}),
    onSupplyChange: callbacks.onSupplyChange || (() => {}),
    onLoadChange: callbacks.onLoadChange || (() => {}),
    onEmgChange: callbacks.onEmgChange || (() => {}),
    onStateChange: callbacks.onStateChange || (() => {})
  };

  dockEl.innerHTML = `
    <div class="dock-rail" data-dock-rail>
      <div class="dock-rail-list" data-dock-rail-list></div>
      <button type="button" class="dock-rail-expand" data-dock-rail-expand title="Open Full Bench (Computer View)">⤢</button>
    </div>

    <div class="dock-panel-shell" data-dock-panel-shell>
      <div class="dock-header">
        <div class="dock-tabs" role="tablist" aria-label="Bench Instruments" data-dock-tabs></div>
        <div class="dock-header-actions">
          <button type="button" class="dock-return-chip" data-dock-return-chip hidden title="Return to Full Bench (Computer View)">⤢ Return to Full Bench</button>
          <button type="button" class="dock-expand-btn" data-dock-expand title="Expand to Full Bench (Computer View)">⤢ Full Bench</button>
          <button type="button" class="dock-close-btn" data-dock-close title="Collapse Instrument Dock">✕</button>
        </div>
      </div>
      <div class="dock-body" data-dock-body></div>
      <div class="dock-bench-tray" data-dock-bench-tray hidden>
        <div class="dock-bench-tray-title">Bench Supply &amp; Stimulus</div>
        ${buildStimulusRowsHtml('dock')}
      </div>
    </div>

    <div class="computer-view" data-computer-view>
      <div class="computer-topbar">
        <div class="computer-topbar-left">
          <span class="computer-brand-pill">NI ELVISmx</span>
          <span class="computer-title">NI ELVISmx Virtual Bench</span>
          <button type="button" class="computer-power-pill is-on" data-computer-power title="Toggle Lab Power">⚡ Power: ON</button>
        </div>
        <div class="computer-bench-stimuli" data-computer-stimuli hidden>
          ${buildStimulusRowsHtml('computer')}
        </div>
        <div class="computer-topbar-actions">
          <div class="computer-wide-switcher" data-computer-wide-switcher hidden role="group" aria-label="Primary Wide Instrument"></div>
          <button type="button" class="computer-split-btn" data-computer-split title="Return to Split Bench + Dock View">◫ Split View</button>
          <button type="button" class="computer-back-btn" data-computer-back title="Collapse Instruments and Return to Breadboard">◀ Back to Board</button>
        </div>
      </div>
      <div class="computer-grid" data-computer-grid></div>
    </div>
  `;

  const els = {
    railList: dockEl.querySelector('[data-dock-rail-list]'),
    railExpandBtn: dockEl.querySelector('[data-dock-rail-expand]'),
    tabsWrap: dockEl.querySelector('[data-dock-tabs]'),
    returnChip: dockEl.querySelector('[data-dock-return-chip]'),
    expandBtn: dockEl.querySelector('[data-dock-expand]'),
    closeBtn: dockEl.querySelector('[data-dock-close]'),
    dockBody: dockEl.querySelector('[data-dock-body]'),
    dockTray: dockEl.querySelector('[data-dock-bench-tray]'),
    computerPowerPill: dockEl.querySelector('[data-computer-power]'),
    computerStimuli: dockEl.querySelector('[data-computer-stimuli]'),
    computerWideSwitcher: dockEl.querySelector('[data-computer-wide-switcher]'),
    computerSplitBtn: dockEl.querySelector('[data-computer-split]'),
    computerBackBtn: dockEl.querySelector('[data-computer-back]'),
    computerGrid: dockEl.querySelector('[data-computer-grid]')
  };

  const stimulusContainers = [els.dockTray, els.computerStimuli].map((container) => ({
    container,
    supplyPosRow: container.querySelector('[data-bench-supply-pos-row]'),
    supplyPosInput: container.querySelector('[data-bench-supply-pos]'),
    supplyPosVal: container.querySelector('[data-bench-supply-pos-val]'),
    supplyNegRow: container.querySelector('[data-bench-supply-neg-row]'),
    supplyNegInput: container.querySelector('[data-bench-supply-neg]'),
    supplyNegVal: container.querySelector('[data-bench-supply-neg-val]'),
    loadRow: container.querySelector('[data-bench-load-row]'),
    loadInput: container.querySelector('[data-bench-load-force]'),
    loadVal: container.querySelector('[data-bench-load-val]'),
    emgGroup: container.querySelector('[data-bench-emg-group]'),
    emgFlexInput: container.querySelector('[data-bench-emg-flex]'),
    emgFlexVal: container.querySelector('[data-bench-emg-flex-val]'),
    emgModeBtn: container.querySelector('[data-bench-emg-mode]'),
    emgHumInput: container.querySelector('[data-bench-emg-hum]'),
    emgHumVal: container.querySelector('[data-bench-emg-hum-val]')
  }));

  /** @type {Map<string, { panel: object, rootEl: HTMLElement }>} */
  const instruments = new Map();

  let state = {
    workspaceMode: 'bench', // 'bench' | 'computer'
    dockOpen: false,
    activeTabId: null,
    activeWideId: null
  };

  let returnToComputerAfterProbe = false;

  let benchControlsState = {
    powered: true,
    elvisMode: false,
    loadCellsMode: false,
    emgMode: false,
    elvisSupplyPos: 5.0,
    elvisSupplyNeg: -5.0,
    loadCellForceGrams: 0,
    emgFlexEffort: 0.5,
    emgBurstMode: 'burst',
    emgHumMvpp: 0
  };

  function getWideComputerInstruments() {
    const list = [];
    for (const [id, entry] of instruments.entries()) {
      if (entry.panel.computerTile !== false && entry.panel.preferredWidth === 'wide') {
        list.push({ id, panel: entry.panel });
      }
    }
    return list;
  }

  function resolveWideId(preferredId = null) {
    const wideList = getWideComputerInstruments();
    if (wideList.length === 0) return null;
    if (preferredId && wideList.some((w) => w.id === preferredId)) {
      return preferredId;
    }
    if (state.activeWideId && wideList.some((w) => w.id === state.activeWideId)) {
      return state.activeWideId;
    }
    if (state.activeTabId && wideList.some((w) => w.id === state.activeTabId)) {
      return state.activeTabId;
    }
    return wideList[0].id;
  }

  function getState() {
    return {
      workspaceMode: state.workspaceMode,
      dockOpen: state.dockOpen,
      activeTabId: state.activeTabId,
      activeWideId: resolveWideId()
    };
  }

  function isInstrumentVisible(id) {
    const entry = id ? instruments.get(id) : null;
    if (!entry) return false;
    if (state.workspaceMode === 'computer') {
      if (entry.panel.computerTile === false) return false;
      if (entry.panel.preferredWidth === 'wide') {
        const activeWide = resolveWideId();
        return activeWide ? id === activeWide : true;
      }
      return true;
    }
    return state.dockOpen && state.activeTabId === id;
  }

  function notifyStateChange() {
    cb.onStateChange(getState());
  }

  function syncAttributesAndLayout() {
    appShellEl.dataset.workspace = state.workspaceMode;
    appShellEl.dataset.dock = state.dockOpen ? 'open' : 'closed';

    const activeEntry = state.activeTabId ? instruments.get(state.activeTabId) : null;
    if (state.workspaceMode === 'bench' && state.dockOpen && activeEntry?.panel?.preferredWidth === 'wide') {
      appShellEl.dataset.dockWidth = 'wide';
    } else {
      delete appShellEl.dataset.dockWidth;
    }

    const showReturnChip =
      state.workspaceMode === 'bench' && state.dockOpen && returnToComputerAfterProbe;
    if (els.returnChip) {
      els.returnChip.hidden = !showReturnChip;
    }
    if (els.expandBtn) {
      els.expandBtn.hidden = showReturnChip;
    }

    // Update tab & rail active highlights
    for (const btn of els.tabsWrap.querySelectorAll('.dock-tab-btn')) {
      const isActive = btn.dataset.instrumentId === state.activeTabId;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    }

    for (const btn of els.railList.querySelectorAll('.dock-rail-btn')) {
      const isActive = state.dockOpen && btn.dataset.instrumentId === state.activeTabId;
      btn.classList.toggle('is-active', isActive);
    }

    const activeWideId = resolveWideId();
    state.activeWideId = activeWideId;

    // Update wide-slot switcher in Full Bench topbar
    if (els.computerWideSwitcher) {
      const wideList = getWideComputerInstruments();
      const showSwitcher = state.workspaceMode === 'computer' && wideList.length >= 2;
      els.computerWideSwitcher.hidden = !showSwitcher;
      if (showSwitcher) {
        for (const btn of els.computerWideSwitcher.querySelectorAll('.computer-wide-btn')) {
          const isActive = btn.dataset.wideInstrumentId === activeWideId;
          btn.classList.toggle('is-active', isActive);
          btn.setAttribute('aria-pressed', String(isActive));
        }
      }
    }

    // Reparent instrument slots cleanly without destroying DOM/state
    if (state.workspaceMode === 'computer') {
      for (const [id, { panel, rootEl }] of instruments.entries()) {
        if (panel.computerTile === false) {
          rootEl.hidden = true;
          if (rootEl.parentElement !== els.dockBody) {
            els.dockBody.appendChild(rootEl);
          }
          continue;
        }
        const isHiddenWide = panel.preferredWidth === 'wide' && activeWideId && id !== activeWideId;
        rootEl.hidden = Boolean(isHiddenWide);
        if (rootEl.parentElement !== els.computerGrid) {
          els.computerGrid.appendChild(rootEl);
        }
      }
    } else {
      for (const [id, { rootEl }] of instruments.entries()) {
        if (rootEl.parentElement !== els.dockBody) {
          els.dockBody.appendChild(rootEl);
        }
        rootEl.hidden = !(state.dockOpen && state.activeTabId === id);
      }
    }

    // Notify instruments when visibility changes
    for (const [id, entry] of instruments.entries()) {
      const visible = isInstrumentVisible(id);
      if (visible !== entry.lastVisible) {
        entry.lastVisible = visible;
        entry.panel.onVisibilityChange?.(visible, state.workspaceMode);
      }
    }
  }

  function renderTabsAndRail() {
    els.tabsWrap.innerHTML = '';
    els.railList.innerHTML = '';
    if (els.computerWideSwitcher) {
      els.computerWideSwitcher.innerHTML = '';
    }

    for (const [id, { panel }] of instruments.entries()) {
      const label = panel.label || panel.title || id;
      const title = panel.title || label;
      const iconHtml = panel.icon || '';

      const railBtn = document.createElement('button');
      railBtn.type = 'button';
      railBtn.className = 'dock-rail-btn';
      railBtn.dataset.instrumentId = id;
      railBtn.title = `Open ${title}`;
      const railIcon = document.createElement('span');
      railIcon.className = 'dock-rail-icon';
      railIcon.setAttribute('aria-hidden', 'true');
      railIcon.innerHTML = iconHtml;
      const railLabel = document.createElement('span');
      railLabel.className = 'dock-rail-label';
      railLabel.textContent = label;
      railBtn.append(railIcon, railLabel);
      els.railList.appendChild(railBtn);

      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'dock-tab-btn';
      tabBtn.setAttribute('role', 'tab');
      tabBtn.dataset.instrumentId = id;
      tabBtn.title = title;
      const tabIcon = document.createElement('span');
      tabIcon.className = 'dock-tab-icon';
      tabIcon.setAttribute('aria-hidden', 'true');
      tabIcon.innerHTML = iconHtml;
      const tabLabel = document.createElement('span');
      tabLabel.textContent = label;
      tabBtn.append(tabIcon, tabLabel);
      els.tabsWrap.appendChild(tabBtn);

      if (els.computerWideSwitcher && panel.computerTile !== false && panel.preferredWidth === 'wide') {
        const wideBtn = document.createElement('button');
        wideBtn.type = 'button';
        wideBtn.className = 'computer-wide-btn';
        wideBtn.dataset.wideInstrumentId = id;
        wideBtn.title = `Show ${title} in Full Bench primary slot`;
        wideBtn.textContent = label;
        els.computerWideSwitcher.appendChild(wideBtn);
      }
    }

    syncAttributesAndLayout();
  }

  function resolveTabId(tabId) {
    if (tabId && instruments.has(tabId)) return tabId;
    if (state.activeTabId && instruments.has(state.activeTabId)) return state.activeTabId;
    const first = instruments.keys().next();
    return first.done ? null : first.value;
  }

  function openDock(tabId, { notify = true } = {}) {
    const nextTabId = resolveTabId(tabId);
    const prevMode = state.workspaceMode;
    const changed =
      state.workspaceMode !== 'bench' ||
      !state.dockOpen ||
      state.activeTabId !== nextTabId;

    state.workspaceMode = 'bench';
    state.dockOpen = true;
    state.activeTabId = nextTabId;
    if (nextTabId && instruments.get(nextTabId)?.panel?.preferredWidth === 'wide') {
      state.activeWideId = nextTabId;
    }
    if (prevMode !== 'computer') {
      returnToComputerAfterProbe = false;
    }

    syncAttributesAndLayout();
    if (prevMode !== 'bench') {
      for (const { panel } of instruments.values()) {
        panel.onLayoutChange?.('bench');
      }
    }
    if (changed && notify) {
      notifyStateChange();
    }
  }

  function closeDock({ notify = true } = {}) {
    const prevMode = state.workspaceMode;
    const changed = state.workspaceMode !== 'bench' || state.dockOpen;

    state.workspaceMode = 'bench';
    state.dockOpen = false;
    returnToComputerAfterProbe = false;

    syncAttributesAndLayout();
    if (prevMode !== 'bench') {
      for (const { panel } of instruments.values()) {
        panel.onLayoutChange?.('bench');
      }
    }
    if (changed && notify) {
      notifyStateChange();
    }
  }

  function toggleDock(tabId, { notify = true } = {}) {
    if (state.workspaceMode === 'computer') {
      openDock(tabId, { notify });
      return;
    }
    if (state.dockOpen && (!tabId || state.activeTabId === tabId)) {
      closeDock({ notify });
    } else {
      openDock(tabId, { notify });
    }
  }

  function setActiveWideInstrument(id, { notify = true } = {}) {
    const entry = id ? instruments.get(id) : null;
    if (!entry || entry.panel.preferredWidth !== 'wide' || entry.panel.computerTile === false) {
      return;
    }
    const prevWide = resolveWideId();
    state.activeWideId = id;
    state.activeTabId = id;
    syncAttributesAndLayout();
    if (state.workspaceMode === 'computer') {
      entry.panel.onLayoutChange?.('computer');
    }
    if (prevWide !== id && notify) {
      notifyStateChange();
    }
  }

  function setWorkspaceMode(mode, { notify = true } = {}) {
    const nextMode = mode === 'computer' ? 'computer' : 'bench';
    const prevMode = state.workspaceMode;
    if (nextMode === prevMode) return;

    state.workspaceMode = nextMode;
    if (nextMode === 'computer') {
      returnToComputerAfterProbe = false;
      if (state.activeTabId && instruments.get(state.activeTabId)?.panel?.preferredWidth === 'wide') {
        state.activeWideId = state.activeTabId;
      } else {
        state.activeWideId = resolveWideId();
      }
    } else if (!state.activeTabId) {
      state.activeTabId = resolveTabId(null);
    }

    syncAttributesAndLayout();
    for (const { panel } of instruments.values()) {
      panel.onLayoutChange?.(nextMode);
    }
    if (notify) {
      notifyStateChange();
    }
  }

  function temporarilyReturnForProbe(tabId) {
    if (state.workspaceMode !== 'computer') return false;
    returnToComputerAfterProbe = true;
    state.workspaceMode = 'bench';
    state.dockOpen = true;
    state.activeTabId = resolveTabId(tabId);

    syncAttributesAndLayout();
    for (const { panel } of instruments.values()) {
      panel.onLayoutChange?.('bench');
    }
    notifyStateChange();
    return true;
  }

  function registerInstrument(panel) {
    if (!panel || typeof panel.id !== 'string' || !panel.id) {
      throw new Error('registerInstrument requires a panel with a non-empty id');
    }
    if (instruments.has(panel.id)) {
      const existing = instruments.get(panel.id);
      existing.panel.destroy?.();
      existing.rootEl.remove();
      instruments.delete(panel.id);
    }

    const rootEl = document.createElement('div');
    rootEl.className = 'dock-instrument-slot';
    rootEl.dataset.instrumentSlot = panel.id;
    rootEl.dataset.preferredWidth = panel.preferredWidth || 'compact';
    rootEl.hidden = true;

    instruments.set(panel.id, { panel, rootEl, lastVisible: false });
    if (!state.activeTabId) {
      state.activeTabId = panel.id;
    }

    if (state.workspaceMode === 'computer' && panel.computerTile !== false) {
      els.computerGrid.appendChild(rootEl);
    } else {
      els.dockBody.appendChild(rootEl);
    }

    panel.mount?.(rootEl);
    panel.onLayoutChange?.(state.workspaceMode);
    renderTabsAndRail();
    return rootEl;
  }

  function syncEmgControlsDom(flexPct, burstMode, humMvpp) {
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const isBurst = burstMode !== 'continuous';
    for (const sc of stimulusContainers) {
      if (sc.emgFlexInput && activeEl !== sc.emgFlexInput) {
        sc.emgFlexInput.value = String(flexPct);
      }
      if (sc.emgFlexVal) {
        sc.emgFlexVal.textContent = `${flexPct}%`;
      }
      if (sc.emgModeBtn) {
        sc.emgModeBtn.textContent = isBurst ? 'Burst' : 'Hold';
        sc.emgModeBtn.classList.toggle('is-burst', isBurst);
        sc.emgModeBtn.classList.toggle('is-hold', !isBurst);
        sc.emgModeBtn.setAttribute('aria-pressed', String(isBurst));
      }
      if (sc.emgHumInput && activeEl !== sc.emgHumInput) {
        sc.emgHumInput.value = String(humMvpp);
      }
      if (sc.emgHumVal) {
        sc.emgHumVal.textContent = `${Math.round(humMvpp)} mVpp`;
      }
    }
  }

  function updateBenchControls({
    powered = true,
    elvisMode = false,
    loadCellsMode = false,
    emgMode = false,
    simConfig = {}
  } = {}) {
    const supplyPos = Number.isFinite(simConfig?.elvisSupplyPos) ? simConfig.elvisSupplyPos : 5.0;
    const supplyNeg = Number.isFinite(simConfig?.elvisSupplyNeg) ? simConfig.elvisSupplyNeg : -5.0;
    const loadGrams = Number.isFinite(simConfig?.loadCellForceGrams) ? simConfig.loadCellForceGrams : 0;
    const rawEmg = simConfig?.emg && typeof simConfig.emg === 'object' ? simConfig.emg : {};
    const flexEffort = Number.isFinite(rawEmg.flexEffort) ? Math.min(1, Math.max(0, rawEmg.flexEffort)) : 0.5;
    const flexPct = Math.round(flexEffort * 100);
    const burstMode = rawEmg.burstMode === 'continuous' ? 'continuous' : 'burst';
    const humMvpp = Number.isFinite(rawEmg.humMvpp) ? Math.round(Math.min(50, Math.max(0, rawEmg.humMvpp))) : 0;

    benchControlsState = {
      powered: Boolean(powered),
      elvisMode: Boolean(elvisMode),
      loadCellsMode: Boolean(loadCellsMode),
      emgMode: Boolean(emgMode),
      elvisSupplyPos: supplyPos,
      elvisSupplyNeg: supplyNeg,
      loadCellForceGrams: loadGrams,
      emgFlexEffort: flexEffort,
      emgBurstMode: burstMode,
      emgHumMvpp: humMvpp
    };

    if (els.computerPowerPill) {
      els.computerPowerPill.classList.toggle('is-on', benchControlsState.powered);
      els.computerPowerPill.classList.toggle('is-off', !benchControlsState.powered);
      els.computerPowerPill.textContent = benchControlsState.powered ? '⚡ Power: ON' : '⚡ Power: OFF';
      els.computerPowerPill.setAttribute('aria-pressed', String(benchControlsState.powered));
    }

    const showStimuli =
      benchControlsState.elvisMode || benchControlsState.loadCellsMode || benchControlsState.emgMode;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;

    for (const sc of stimulusContainers) {
      sc.container.hidden = !showStimuli;
      sc.supplyPosRow.hidden = !benchControlsState.elvisMode;
      sc.supplyNegRow.hidden = !benchControlsState.elvisMode;
      sc.loadRow.hidden = !benchControlsState.loadCellsMode;
      if (sc.emgGroup) {
        sc.emgGroup.hidden = !benchControlsState.emgMode;
      }

      if (benchControlsState.elvisMode) {
        if (activeEl !== sc.supplyPosInput) {
          sc.supplyPosInput.value = String(supplyPos);
        }
        sc.supplyPosVal.textContent = formatSupplyValue(supplyPos);
        if (activeEl !== sc.supplyNegInput) {
          sc.supplyNegInput.value = String(supplyNeg);
        }
        sc.supplyNegVal.textContent = formatSupplyValue(supplyNeg);
      }

      if (benchControlsState.loadCellsMode) {
        if (activeEl !== sc.loadInput) {
          sc.loadInput.value = String(loadGrams);
        }
        sc.loadVal.textContent = `${Math.round(loadGrams)} g`;
      }
    }

    if (benchControlsState.emgMode) {
      syncEmgControlsDom(flexPct, burstMode, humMvpp);
    }
  }

  function applyState(saved, { notify = false } = {}) {
    const prevMode = state.workspaceMode;
    let nextWorkspaceMode = 'bench';
    let nextDockOpen = false;
    let nextActiveTabId = state.activeTabId;
    let nextActiveWideId = state.activeWideId;

    if (saved && typeof saved === 'object') {
      if (saved.workspaceState && typeof saved.workspaceState === 'object') {
        const ws = saved.workspaceState;
        nextWorkspaceMode = ws.workspaceMode === 'computer' ? 'computer' : 'bench';
        nextDockOpen = Boolean(ws.dockOpen);
        if (typeof ws.activeTabId === 'string' && instruments.has(ws.activeTabId)) {
          nextActiveTabId = ws.activeTabId;
        }
        if (typeof ws.activeWideId === 'string' && instruments.has(ws.activeWideId)) {
          nextActiveWideId = ws.activeWideId;
        }
      } else {
        if (saved.workspaceMode === 'computer' || saved.workspaceMode === 'bench') {
          nextWorkspaceMode = saved.workspaceMode;
        }
        if (typeof saved.dockOpen === 'boolean') {
          nextDockOpen = saved.dockOpen;
        } else if (saved.dmmState?.open === true) {
          // Legacy v4/v5 saved state migration
          nextDockOpen = true;
          nextActiveTabId = instruments.has('dmm') ? 'dmm' : resolveTabId(null);
        }
        if (typeof saved.activeTabId === 'string' && instruments.has(saved.activeTabId)) {
          nextActiveTabId = saved.activeTabId;
        }
        if (typeof saved.activeWideId === 'string' && instruments.has(saved.activeWideId)) {
          nextActiveWideId = saved.activeWideId;
        }
      }
    }

    state = {
      workspaceMode: nextWorkspaceMode,
      dockOpen: nextDockOpen,
      activeTabId: resolveTabId(nextActiveTabId),
      activeWideId: resolveWideId(nextActiveWideId)
    };
    returnToComputerAfterProbe = false;

    syncAttributesAndLayout();
    if (prevMode !== state.workspaceMode) {
      for (const { panel } of instruments.values()) {
        panel.onLayoutChange?.(state.workspaceMode);
      }
    }
    if (notify) {
      notifyStateChange();
    }
  }

  // Event bindings via AbortController for clean teardown
  const ac = new AbortController();
  const { signal } = ac;

  els.railList.addEventListener('click', (e) => {
    const btn = e.target.closest('.dock-rail-btn');
    if (!btn) return;
    openDock(btn.dataset.instrumentId);
  }, { signal });

  els.tabsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.dock-tab-btn');
    if (!btn) return;
    openDock(btn.dataset.instrumentId);
  }, { signal });

  els.railExpandBtn.addEventListener('click', () => {
    setWorkspaceMode('computer');
  }, { signal });

  els.expandBtn.addEventListener('click', () => {
    setWorkspaceMode('computer');
  }, { signal });

  els.returnChip.addEventListener('click', () => {
    setWorkspaceMode('computer');
  }, { signal });

  els.closeBtn.addEventListener('click', () => {
    closeDock();
  }, { signal });

  if (els.computerWideSwitcher) {
    els.computerWideSwitcher.addEventListener('click', (e) => {
      const btn = e.target.closest('.computer-wide-btn');
      if (!btn) return;
      setActiveWideInstrument(btn.dataset.wideInstrumentId);
    }, { signal });
  }

  els.computerSplitBtn.addEventListener('click', () => {
    openDock(state.activeTabId);
  }, { signal });

  els.computerBackBtn.addEventListener('click', () => {
    closeDock();
  }, { signal });

  els.computerPowerPill.addEventListener('click', () => {
    cb.onPowerToggle(!benchControlsState.powered);
  }, { signal });

  for (const sc of stimulusContainers) {
    sc.supplyPosInput.addEventListener('input', () => {
      const pos = Number(sc.supplyPosInput.value);
      benchControlsState.elvisSupplyPos = pos;
      for (const other of stimulusContainers) {
        if (other !== sc) other.supplyPosInput.value = String(pos);
        other.supplyPosVal.textContent = formatSupplyValue(pos);
      }
      cb.onSupplyChange({ pos, neg: benchControlsState.elvisSupplyNeg });
    }, { signal });

    sc.supplyNegInput.addEventListener('input', () => {
      const neg = Number(sc.supplyNegInput.value);
      benchControlsState.elvisSupplyNeg = neg;
      for (const other of stimulusContainers) {
        if (other !== sc) other.supplyNegInput.value = String(neg);
        other.supplyNegVal.textContent = formatSupplyValue(neg);
      }
      cb.onSupplyChange({ pos: benchControlsState.elvisSupplyPos, neg });
    }, { signal });

    sc.loadInput.addEventListener('input', () => {
      const grams = Number(sc.loadInput.value);
      benchControlsState.loadCellForceGrams = grams;
      for (const other of stimulusContainers) {
        if (other !== sc) other.loadInput.value = String(grams);
        other.loadVal.textContent = `${Math.round(grams)} g`;
      }
      cb.onLoadChange(grams);
    }, { signal });

    sc.emgFlexInput?.addEventListener('input', () => {
      const pct = Math.round(Number(sc.emgFlexInput.value));
      const flexEffort = Math.min(1, Math.max(0, pct / 100));
      benchControlsState.emgFlexEffort = flexEffort;
      syncEmgControlsDom(pct, benchControlsState.emgBurstMode, benchControlsState.emgHumMvpp);
      cb.onEmgChange({ flexEffort });
    }, { signal });

    sc.emgModeBtn?.addEventListener('click', () => {
      const nextMode = benchControlsState.emgBurstMode === 'continuous' ? 'burst' : 'continuous';
      benchControlsState.emgBurstMode = nextMode;
      const pct = Math.round(benchControlsState.emgFlexEffort * 100);
      syncEmgControlsDom(pct, nextMode, benchControlsState.emgHumMvpp);
      cb.onEmgChange({ burstMode: nextMode });
    }, { signal });

    sc.emgHumInput?.addEventListener('input', () => {
      const humMvpp = Math.round(Math.min(50, Math.max(0, Number(sc.emgHumInput.value))));
      benchControlsState.emgHumMvpp = humMvpp;
      const pct = Math.round(benchControlsState.emgFlexEffort * 100);
      syncEmgControlsDom(pct, benchControlsState.emgBurstMode, humMvpp);
      cb.onEmgChange({ humMvpp });
    }, { signal });
  }

  // Initial DOM sync
  syncAttributesAndLayout();

  function destroy() {
    ac.abort();
    for (const { panel, rootEl } of instruments.values()) {
      panel.destroy?.();
      rootEl.remove();
    }
    instruments.clear();
    delete appShellEl.dataset.dockWidth;
    dockEl.innerHTML = '';
  }

  return {
    registerInstrument,
    openDock,
    closeDock,
    toggleDock,
    setWorkspaceMode,
    setActiveWideInstrument,
    temporarilyReturnForProbe,
    updateBenchControls,
    getState,
    applyState,
    isInstrumentVisible,
    destroy
  };
}
