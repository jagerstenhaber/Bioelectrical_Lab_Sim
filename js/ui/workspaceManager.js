/**
 * Option C Workspace Manager
 * Manages the Collapsible Tabbed Right Instrument Dock, Slim Launcher Rail,
 * Full Bench ("Computer View") grid, and shared Bench Supply & Load Cell controls.
 */

import {
  computeComputerVisibility,
  getPanelComputerSlot,
  getPanelComputerLayout
} from './workspaceLayout.js';
import { getStimulusSummaryText } from '../sim/hardwareRegistry.js';
import { createDefaultPulseOxConfig } from '../sim/ppgModel.js';

function toSet(collection) {
  if (collection instanceof Set) return collection;
  return new Set(Array.isArray(collection) ? collection : []);
}

function buildStimulusRowsHtml(idPrefix) {
  return `
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
    <div class="bench-pox-group" data-bench-pox-group hidden>
      <div class="bench-pox-mode-row">
        <span class="bench-pox-mode-label">Finger</span>
        <button type="button" class="bench-pox-finger-btn is-active" data-bench-pox-finger aria-pressed="true" title="Toggle Pulse-Ox Finger Clip">Finger In</button>
      </div>
      <div class="bench-slider-row">
        <div class="bench-slider-label">
          <label for="${idPrefix}-pox-bpm">BPM</label>
          <span class="bench-slider-val" data-bench-pox-bpm-val>72 BPM</span>
        </div>
        <input id="${idPrefix}-pox-bpm" data-bench-pox-bpm type="range" min="45" max="160" step="1" value="72" />
      </div>
      <div class="bench-slider-row">
        <div class="bench-slider-label">
          <label for="${idPrefix}-pox-spo2">SpO₂</label>
          <span class="bench-slider-val" data-bench-pox-spo2-val>98%</span>
        </div>
        <input id="${idPrefix}-pox-spo2" data-bench-pox-spo2 type="range" min="70" max="100" step="1" value="98" />
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
    onLoadChange: callbacks.onLoadChange || (() => {}),
    onEmgChange: callbacks.onEmgChange || (() => {}),
    onPulseOxChange: callbacks.onPulseOxChange || (() => {}),
    onStateChange: callbacks.onStateChange || (() => {})
  };

  dockEl.innerHTML = `
    <div class="dock-rail" data-dock-rail>
      <div class="dock-rail-brand" aria-hidden="true">BENCH</div>
      <div class="dock-rail-list" data-dock-rail-list></div>
      <button type="button" class="dock-rail-expand" data-dock-rail-expand title="Open Full Bench (Computer View)">⤢</button>
    </div>

    <div class="dock-panel-shell" data-dock-panel-shell>
      <div class="dock-header">
        <div class="dock-header-top">
          <span class="dock-header-title">NI ELVISmx Bench</span>
          <div class="dock-header-actions">
            <button type="button" class="dock-return-chip" data-dock-return-chip hidden title="Return to Full Bench (Computer View)">⤢ Return to Full Bench</button>
            <button type="button" class="dock-expand-btn" data-dock-expand title="Expand to Full Bench (Computer View)">⤢ Full Bench</button>
            <button type="button" class="dock-close-btn" data-dock-close title="Collapse Instrument Dock">✕</button>
          </div>
        </div>
        <div class="dock-tabs" role="tablist" aria-label="Bench Instruments" data-dock-tabs></div>
      </div>
      <div class="dock-body" data-dock-body></div>
      <div class="dock-bench-tray" data-dock-bench-tray hidden>
        <button type="button" class="dock-bench-tray-header" data-dock-tray-toggle aria-expanded="true" title="Toggle Bench Stimulus Controls">
          <span class="dock-bench-tray-title">Bench Stimulus</span>
          <span class="dock-tray-summary" data-dock-tray-summary></span>
          <span class="dock-tray-chevron" data-dock-tray-chevron aria-hidden="true">▾</span>
        </button>
        <div class="dock-bench-tray-body" data-dock-tray-body>
          ${buildStimulusRowsHtml('dock')}
        </div>
      </div>
    </div>

    <div class="computer-view" data-computer-view>
      <div class="computer-topbar">
        <div class="computer-topbar-left">
          <span class="computer-brand-pill">NI ELVISmx</span>
          <span class="computer-title">NI ELVISmx Virtual Bench</span>
          <span class="computer-circuit-pill" data-computer-circuit hidden></span>
          <button type="button" class="computer-power-pill is-on" data-computer-power title="Toggle Lab Power">⚡ Power: ON</button>
        </div>
        <div class="computer-bench-stimuli" data-computer-stimuli hidden>
          ${buildStimulusRowsHtml('computer')}
        </div>
        <div class="computer-topbar-actions">
          <div class="computer-aux-switcher" data-computer-aux-switcher hidden role="group" aria-label="Top-Right Compact Instrument"></div>
          <div class="computer-wide-switcher" data-computer-wide-switcher hidden role="group" aria-label="Primary Wide Instrument"></div>
          <button type="button" class="computer-drawer-btn" data-computer-drawer-toggle hidden aria-pressed="false" title="Toggle Side Bench (Compact Instruments)">◫ Side Bench</button>
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
    dockTrayToggle: dockEl.querySelector('[data-dock-tray-toggle]'),
    dockTraySummary: dockEl.querySelector('[data-dock-tray-summary]'),
    dockTrayChevron: dockEl.querySelector('[data-dock-tray-chevron]'),
    computerCircuitPill: dockEl.querySelector('[data-computer-circuit]'),
    computerPowerPill: dockEl.querySelector('[data-computer-power]'),
    computerStimuli: dockEl.querySelector('[data-computer-stimuli]'),
    computerAuxSwitcher: dockEl.querySelector('[data-computer-aux-switcher]'),
    computerWideSwitcher: dockEl.querySelector('[data-computer-wide-switcher]'),
    computerDrawerToggle: dockEl.querySelector('[data-computer-drawer-toggle]'),
    computerSplitBtn: dockEl.querySelector('[data-computer-split]'),
    computerBackBtn: dockEl.querySelector('[data-computer-back]'),
    computerGrid: dockEl.querySelector('[data-computer-grid]')
  };

  const stimulusContainers = [els.dockTray, els.computerStimuli].map((container) => ({
    container,
    loadRow: container.querySelector('[data-bench-load-row]'),
    loadInput: container.querySelector('[data-bench-load-force]'),
    loadVal: container.querySelector('[data-bench-load-val]'),
    emgGroup: container.querySelector('[data-bench-emg-group]'),
    emgFlexInput: container.querySelector('[data-bench-emg-flex]'),
    emgFlexVal: container.querySelector('[data-bench-emg-flex-val]'),
    emgModeBtn: container.querySelector('[data-bench-emg-mode]'),
    emgHumInput: container.querySelector('[data-bench-emg-hum]'),
    emgHumVal: container.querySelector('[data-bench-emg-hum-val]'),
    poxGroup: container.querySelector('[data-bench-pox-group]'),
    poxFingerBtn: container.querySelector('[data-bench-pox-finger]'),
    poxBpmInput: container.querySelector('[data-bench-pox-bpm]'),
    poxBpmVal: container.querySelector('[data-bench-pox-bpm-val]'),
    poxSpo2Input: container.querySelector('[data-bench-pox-spo2]'),
    poxSpo2Val: container.querySelector('[data-bench-pox-spo2-val]')
  }));

  /** @type {Map<string, { panel: object, rootEl: HTMLElement, lastVisible: boolean }>} */
  const instruments = new Map();

  let state = {
    workspaceMode: 'bench', // 'bench' | 'computer'
    dockOpen: false,
    activeTabId: null,
    activeWideId: null,
    activeAuxId: null,
    benchDrawerOpen: false
  };

  let dockTrayUserCollapsed = null; // null = auto, true/false = explicit user toggle
  let returnToComputerAfterProbe = false;

  let benchControlsState = {
    powered: true,
    elvisMode: false,
    loadCellsMode: false,
    emgMode: false,
    pulseOxMode: false,
    loadCellForceGrams: 0,
    emgFlexEffort: 0.5,
    emgBurstMode: 'burst',
    emgHumMvpp: 0,
    pulseOxFingerPresent: true,
    pulseOxBpm: 72,
    pulseOxSpo2: 98
  };

  /** @type {Set<string>|null} null = all registered instruments allowed */
  let allowedInstrumentIds = null;

  function isInstrumentAllowed(id) {
    if (!id || !instruments.has(id)) return false;
    return allowedInstrumentIds === null || allowedInstrumentIds.has(id);
  }

  function getPanelList() {
    const out = [];
    for (const [id, entry] of instruments.entries()) {
      if (isInstrumentAllowed(id)) {
        out.push(entry.panel);
      }
    }
    return out;
  }

  function getComputerLayout() {
    return computeComputerVisibility(state, getPanelList());
  }

  function getPrimaryComputerInstruments() {
    const list = [];
    for (const [id, entry] of instruments.entries()) {
      if (
        isInstrumentAllowed(id) &&
        entry.panel.computerTile !== false &&
        getPanelComputerSlot(entry.panel) === 'primary'
      ) {
        list.push({ id, panel: entry.panel });
      }
    }
    return list;
  }

  function getAuxComputerInstruments() {
    const list = [];
    for (const [id, entry] of instruments.entries()) {
      if (
        isInstrumentAllowed(id) &&
        entry.panel.computerTile !== false &&
        getPanelComputerSlot(entry.panel) === 'aux'
      ) {
        list.push({ id, panel: entry.panel });
      }
    }
    return list;
  }

  function resolveWideId(preferredId = null) {
    const primaryList = getPrimaryComputerInstruments();
    if (primaryList.length === 0) return null;
    if (preferredId && primaryList.some((w) => w.id === preferredId)) {
      return preferredId;
    }
    if (state.activeWideId && primaryList.some((w) => w.id === state.activeWideId)) {
      return state.activeWideId;
    }
    if (state.activeTabId && primaryList.some((w) => w.id === state.activeTabId)) {
      return state.activeTabId;
    }
    return primaryList[0].id;
  }

  function resolveAuxId(preferredId = null) {
    const auxList = getAuxComputerInstruments();
    if (auxList.length === 0) return null;
    if (preferredId && auxList.some((a) => a.id === preferredId)) {
      return preferredId;
    }
    if (state.activeAuxId && auxList.some((a) => a.id === state.activeAuxId)) {
      return state.activeAuxId;
    }
    if (state.activeTabId && auxList.some((a) => a.id === state.activeTabId)) {
      return state.activeTabId;
    }
    if (auxList.some((a) => a.id === 'fgen')) {
      return 'fgen';
    }
    return auxList[0].id;
  }

  function getState() {
    const layout = state.workspaceMode === 'computer' ? getComputerLayout() : null;
    return {
      workspaceMode: state.workspaceMode,
      dockOpen: state.dockOpen,
      activeTabId: state.activeTabId,
      activeWideId: layout ? layout.activePrimaryId : resolveWideId(),
      activeAuxId: resolveAuxId(),
      benchDrawerOpen: Boolean(state.benchDrawerOpen)
    };
  }

  function isInstrumentVisible(id) {
    if (!isInstrumentAllowed(id)) return false;
    if (state.workspaceMode === 'computer') {
      const layout = getComputerLayout();
      return toSet(layout.visibleIds).has(id);
    }
    return state.dockOpen && state.activeTabId === id;
  }

  function getVisibleInstrumentIds() {
    const out = new Set();
    for (const id of instruments.keys()) {
      if (isInstrumentVisible(id)) {
        out.add(id);
      }
    }
    return out;
  }

  function notifyStateChange() {
    cb.onStateChange(getState());
  }

  function isDockTrayCollapsed() {
    if (dockTrayUserCollapsed !== null) {
      return dockTrayUserCollapsed;
    }
    return state.activeTabId === 'arduino';
  }

  function updateDockTraySummary() {
    if (!els.dockTraySummary) return;
    const summary = getStimulusSummaryText(benchControlsState, {
      loadCellForceGrams: benchControlsState.loadCellForceGrams,
      emg: {
        flexEffort: benchControlsState.emgFlexEffort,
        burstMode: benchControlsState.emgBurstMode,
        humMvpp: benchControlsState.emgHumMvpp
      },
      pulseOx: {
        fingerPresent: benchControlsState.pulseOxFingerPresent,
        bpm: benchControlsState.pulseOxBpm,
        spo2: benchControlsState.pulseOxSpo2
      }
    });
    els.dockTraySummary.textContent = summary || '';
  }

  function syncDockTrayCollapse() {
    if (!els.dockTray) return;
    const collapsed = isDockTrayCollapsed();
    els.dockTray.classList.toggle('is-collapsed', collapsed);
    if (els.dockTrayToggle) {
      els.dockTrayToggle.setAttribute('aria-expanded', String(!collapsed));
    }
    if (els.dockTrayChevron) {
      els.dockTrayChevron.textContent = collapsed ? '▸' : '▾';
    }
    updateDockTraySummary();
  }

  function syncStimulusVisibility(layout = null) {
    const hasStimuli =
      benchControlsState.loadCellsMode ||
      benchControlsState.emgMode ||
      benchControlsState.pulseOxMode;
    if (els.dockTray) {
      els.dockTray.hidden = !hasStimuli;
      syncDockTrayCollapse();
    }
    if (els.computerStimuli) {
      const activeLayout =
        layout || (state.workspaceMode === 'computer' ? getComputerLayout() : null);
      const allowComputerStimuli = activeLayout ? Boolean(activeLayout.showStimuli) : true;
      els.computerStimuli.hidden = !(hasStimuli && allowComputerStimuli);
    }
  }

  function syncAttributesAndLayout() {
    appShellEl.dataset.workspace = state.workspaceMode;
    appShellEl.dataset.dock = state.dockOpen ? 'open' : 'closed';

    const activeEntry = state.activeTabId ? instruments.get(state.activeTabId) : null;
    if (
      state.workspaceMode === 'bench' &&
      state.dockOpen &&
      (activeEntry?.panel?.preferredWidth === 'wide' ||
        getPanelComputerSlot(activeEntry?.panel) === 'primary')
    ) {
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

    // Update tab & rail active highlights and kit visibility
    for (const btn of els.tabsWrap.querySelectorAll('.dock-tab-btn')) {
      const id = btn.dataset.instrumentId;
      const allowed = isInstrumentAllowed(id);
      btn.hidden = !allowed;
      const isActive = allowed && id === state.activeTabId;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    }

    for (const btn of els.railList.querySelectorAll('.dock-rail-btn')) {
      const id = btn.dataset.instrumentId;
      const allowed = isInstrumentAllowed(id);
      btn.hidden = !allowed;
      const isActive = allowed && state.dockOpen && id === state.activeTabId;
      btn.classList.toggle('is-active', isActive);
    }

    const hasAnyAllowedComputerTile = getPanelList().some((p) => p.computerTile !== false);
    if (els.railExpandBtn) {
      els.railExpandBtn.hidden = !hasAnyAllowedComputerTile;
    }

    let layout = null;
    if (state.workspaceMode === 'computer') {
      layout = getComputerLayout();
      state.activeWideId = layout.activePrimaryId;
      state.activeAuxId = resolveAuxId();
      appShellEl.dataset.computerLayout = layout.layoutMode;
      els.computerGrid.dataset.computerLayout = layout.layoutMode;
    } else {
      state.activeWideId = resolveWideId();
      state.activeAuxId = resolveAuxId();
      delete appShellEl.dataset.computerLayout;
      delete els.computerGrid.dataset.computerLayout;
    }

    // Update Side Bench drawer toggle in Full Bench topbar
    if (els.computerDrawerToggle) {
      const showToggle = state.workspaceMode === 'computer' && Boolean(layout?.showDrawerToggle);
      const isDrawerOpen = Boolean(layout?.drawerOpen);
      els.computerDrawerToggle.hidden = !showToggle;
      els.computerDrawerToggle.classList.toggle('is-active', isDrawerOpen);
      els.computerDrawerToggle.setAttribute('aria-pressed', String(isDrawerOpen));
      els.computerDrawerToggle.textContent =
        layout?.activePrimaryId === 'bode' ? '◫ VPS / DMM' : '◫ Side Bench';
    }

    // Update compact top-right aux switcher (e.g. FGEN | VPS) in Full Bench topbar
    if (els.computerAuxSwitcher) {
      const allowedSet = toSet(layout?.allowedAuxIds);
      const showAuxSwitcher = state.workspaceMode === 'computer' && Boolean(layout?.showAuxSwitcher);
      els.computerAuxSwitcher.hidden = !showAuxSwitcher;
      for (const btn of els.computerAuxSwitcher.querySelectorAll('.computer-aux-btn')) {
        const auxId = btn.dataset.auxInstrumentId;
        const isAllowed = isInstrumentAllowed(auxId) && allowedSet.has(auxId);
        btn.hidden = !isAllowed;
        const isActive = isAllowed && auxId === layout?.activeAuxId;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
      }
    }

    // Update primary-slot switcher in Full Bench topbar
    if (els.computerWideSwitcher) {
      const showWideSwitcher = state.workspaceMode === 'computer' && Boolean(layout?.showWideSwitcher);
      els.computerWideSwitcher.hidden = !showWideSwitcher;
      for (const btn of els.computerWideSwitcher.querySelectorAll('.computer-wide-btn')) {
        const wideId = btn.dataset.wideInstrumentId;
        const isAllowed = isInstrumentAllowed(wideId);
        btn.hidden = !isAllowed;
        const isActive = showWideSwitcher && isAllowed && wideId === layout?.activePrimaryId;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
      }
    }

    // Reparent instrument slots cleanly without destroying DOM/state
    if (state.workspaceMode === 'computer') {
      const visibleSet = toSet(layout.visibleIds);
      for (const [id, { panel, rootEl }] of instruments.entries()) {
        if (!isInstrumentAllowed(id) || panel.computerTile === false) {
          rootEl.hidden = true;
          if (rootEl.parentElement !== els.dockBody) {
            els.dockBody.appendChild(rootEl);
          }
          continue;
        }
        rootEl.hidden = !visibleSet.has(id);
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

    syncStimulusVisibility(layout);

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
    if (els.computerAuxSwitcher) {
      els.computerAuxSwitcher.innerHTML = '';
    }
    if (els.computerWideSwitcher) {
      els.computerWideSwitcher.innerHTML = '';
    }

    for (const [id, { panel }] of instruments.entries()) {
      const label = panel.label || panel.title || id;
      const title = panel.title || label;
      const iconHtml = panel.icon || '';
      const slot = getPanelComputerSlot(panel);

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

      if (els.computerAuxSwitcher && panel.computerTile !== false && slot === 'aux') {
        const auxBtn = document.createElement('button');
        auxBtn.type = 'button';
        auxBtn.className = 'computer-aux-btn';
        auxBtn.dataset.auxInstrumentId = id;
        auxBtn.title = `Show ${title} in Full Bench top-right slot`;
        auxBtn.textContent = label;
        els.computerAuxSwitcher.appendChild(auxBtn);
      }

      if (els.computerWideSwitcher && panel.computerTile !== false && slot === 'primary') {
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
    if (tabId && isInstrumentAllowed(tabId)) return tabId;
    if (state.activeTabId && isInstrumentAllowed(state.activeTabId)) return state.activeTabId;
    for (const id of instruments.keys()) {
      if (isInstrumentAllowed(id)) return id;
    }
    return null;
  }

  function setAllowedInstruments(allowedIdsOrNull, { notify = true } = {}) {
    if (allowedIdsOrNull === null || allowedIdsOrNull === undefined) {
      allowedInstrumentIds = null;
    } else if (Array.isArray(allowedIdsOrNull)) {
      allowedInstrumentIds = new Set(allowedIdsOrNull);
    } else if (allowedIdsOrNull instanceof Set) {
      allowedInstrumentIds = new Set(allowedIdsOrNull);
    } else {
      allowedInstrumentIds = null;
    }

    const prevTab = state.activeTabId;
    const prevDockOpen = state.dockOpen;
    const prevMode = state.workspaceMode;

    if (state.activeTabId && !isInstrumentAllowed(state.activeTabId)) {
      state.activeTabId = resolveTabId(null);
      if (!state.activeTabId) {
        state.dockOpen = false;
      }
    } else if (!state.activeTabId) {
      state.activeTabId = resolveTabId(null);
    }

    if (state.workspaceMode === 'computer') {
      const hasAny = getPanelList().some((p) => p.computerTile !== false);
      if (!hasAny) {
        state.workspaceMode = 'bench';
        state.dockOpen = false;
      }
    }

    state.activeWideId = resolveWideId();
    state.activeAuxId = resolveAuxId();

    syncAttributesAndLayout();
    const changed =
      prevTab !== state.activeTabId ||
      prevDockOpen !== state.dockOpen ||
      prevMode !== state.workspaceMode;
    if (changed && notify) {
      notifyStateChange();
    }
  }

  function openDock(tabId, { notify = true } = {}) {
    if (tabId && !isInstrumentAllowed(tabId)) {
      return;
    }
    const nextTabId = resolveTabId(tabId);
    if (!nextTabId) {
      closeDock({ notify });
      return;
    }
    const prevMode = state.workspaceMode;
    const changed =
      state.workspaceMode !== 'bench' ||
      !state.dockOpen ||
      state.activeTabId !== nextTabId;

    state.workspaceMode = 'bench';
    state.dockOpen = true;
    state.activeTabId = nextTabId;
    const nextEntry = nextTabId ? instruments.get(nextTabId) : null;
    if (nextEntry?.panel?.computerTile !== false) {
      const slot = getPanelComputerSlot(nextEntry.panel);
      if (slot === 'primary') {
        state.activeWideId = nextTabId;
      } else if (slot === 'aux') {
        state.activeAuxId = nextTabId;
      }
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
    if (tabId && !isInstrumentAllowed(tabId)) {
      return;
    }
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
    if (!isInstrumentAllowed(id)) return;
    const entry = id ? instruments.get(id) : null;
    if (
      !entry ||
      getPanelComputerSlot(entry.panel) !== 'primary' ||
      entry.panel.computerTile === false
    ) {
      return;
    }
    const prevWide = resolveWideId();
    const prevDrawerOpen = state.benchDrawerOpen;
    state.activeWideId = id;
    state.activeTabId = id;
    state.benchDrawerOpen = false;
    syncAttributesAndLayout();
    if (state.workspaceMode === 'computer') {
      for (const [instId, { panel }] of instruments.entries()) {
        if (isInstrumentVisible(instId)) {
          panel.onLayoutChange?.('computer');
        }
      }
    }
    if ((prevWide !== id || prevDrawerOpen !== state.benchDrawerOpen) && notify) {
      notifyStateChange();
    }
  }

  function setActiveAuxInstrument(id, { notify = true } = {}) {
    if (!isInstrumentAllowed(id)) return;
    const entry = id ? instruments.get(id) : null;
    if (
      !entry ||
      getPanelComputerSlot(entry.panel) !== 'aux' ||
      entry.panel.computerTile === false
    ) {
      return;
    }
    const prevAux = resolveAuxId();
    state.activeAuxId = id;
    state.activeTabId = id;
    syncAttributesAndLayout();
    if (state.workspaceMode === 'computer') {
      entry.panel.onLayoutChange?.('computer');
    }
    if (prevAux !== id && notify) {
      notifyStateChange();
    }
  }

  function setWorkspaceMode(mode, { notify = true } = {}) {
    const nextMode = mode === 'computer' ? 'computer' : 'bench';
    const prevMode = state.workspaceMode;
    if (nextMode === prevMode) return;

    state.workspaceMode = nextMode;
    if (nextMode === 'computer') {
      const returningFromProbe = returnToComputerAfterProbe;
      returnToComputerAfterProbe = false;
      const activePanel = state.activeTabId ? instruments.get(state.activeTabId)?.panel : null;
      const activeSlot = activePanel ? getPanelComputerSlot(activePanel) : null;
      if (activePanel?.computerTile !== false && activeSlot === 'primary') {
        state.activeWideId = state.activeTabId;
      } else {
        state.activeWideId = resolveWideId();
      }
      if (activePanel?.computerTile !== false && activeSlot === 'aux') {
        state.activeAuxId = state.activeTabId;
      } else {
        state.activeAuxId = resolveAuxId();
      }
      const primaryPanel = state.activeWideId ? instruments.get(state.activeWideId)?.panel : null;
      if (!returningFromProbe && getPanelComputerLayout(primaryPanel) === 'focus-with-drawer') {
        state.benchDrawerOpen = false;
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

  function setActiveCircuitTitle(title) {
    if (!els.computerCircuitPill) return;
    const text = typeof title === 'string' ? title.trim() : '';
    els.computerCircuitPill.textContent = text;
    els.computerCircuitPill.hidden = !text;
    els.computerCircuitPill.title = text;
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
    rootEl.dataset.computerSlot = getPanelComputerSlot(panel);
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

  function syncPulseOxControlsDom(fingerPresent, bpm, spo2) {
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const fingerIn = Boolean(fingerPresent);
    const safeBpm = Math.round(bpm);
    const safeSpo2 = Math.round(spo2);
    for (const sc of stimulusContainers) {
      if (sc.poxFingerBtn) {
        sc.poxFingerBtn.textContent = fingerIn ? 'Finger In' : 'No Finger';
        sc.poxFingerBtn.classList.toggle('is-active', fingerIn);
        sc.poxFingerBtn.classList.toggle('is-no-finger', !fingerIn);
        sc.poxFingerBtn.setAttribute('aria-pressed', String(fingerIn));
      }
      if (sc.poxBpmInput && activeEl !== sc.poxBpmInput) {
        sc.poxBpmInput.value = String(safeBpm);
      }
      if (sc.poxBpmVal) {
        sc.poxBpmVal.textContent = `${safeBpm} BPM`;
      }
      if (sc.poxSpo2Input && activeEl !== sc.poxSpo2Input) {
        sc.poxSpo2Input.value = String(safeSpo2);
      }
      if (sc.poxSpo2Val) {
        sc.poxSpo2Val.textContent = `${safeSpo2}%`;
      }
    }
  }

  function updateBenchControls({
    powered = true,
    elvisMode = false,
    loadCellsMode = false,
    emgMode = false,
    pulseOxMode = false,
    simConfig = {}
  } = {}) {
    const loadGrams = Number.isFinite(simConfig?.loadCellForceGrams) ? simConfig.loadCellForceGrams : 0;
    const rawEmg = simConfig?.emg && typeof simConfig.emg === 'object' ? simConfig.emg : {};
    const flexEffort = Number.isFinite(rawEmg.flexEffort) ? Math.min(1, Math.max(0, rawEmg.flexEffort)) : 0.5;
    const flexPct = Math.round(flexEffort * 100);
    const burstMode = rawEmg.burstMode === 'continuous' ? 'continuous' : 'burst';
    const humMvpp = Number.isFinite(rawEmg.humMvpp) ? Math.round(Math.min(50, Math.max(0, rawEmg.humMvpp))) : 0;
    const poxCfg = createDefaultPulseOxConfig(simConfig?.pulseOx);
    const poxFinger = poxCfg.fingerPresent;
    const poxBpm = Math.round(poxCfg.bpm);
    const poxSpo2 = Math.round(poxCfg.spo2);

    benchControlsState = {
      powered: Boolean(powered),
      elvisMode: Boolean(elvisMode),
      loadCellsMode: Boolean(loadCellsMode),
      emgMode: Boolean(emgMode),
      pulseOxMode: Boolean(pulseOxMode),
      loadCellForceGrams: loadGrams,
      emgFlexEffort: flexEffort,
      emgBurstMode: burstMode,
      emgHumMvpp: humMvpp,
      pulseOxFingerPresent: poxFinger,
      pulseOxBpm: poxBpm,
      pulseOxSpo2: poxSpo2
    };

    if (els.computerPowerPill) {
      els.computerPowerPill.classList.toggle('is-on', benchControlsState.powered);
      els.computerPowerPill.classList.toggle('is-off', !benchControlsState.powered);
      els.computerPowerPill.textContent = benchControlsState.powered ? '⚡ Power: ON' : '⚡ Power: OFF';
      els.computerPowerPill.setAttribute('aria-pressed', String(benchControlsState.powered));
    }

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;

    for (const sc of stimulusContainers) {
      sc.loadRow.hidden = !benchControlsState.loadCellsMode;
      if (sc.emgGroup) {
        sc.emgGroup.hidden = !benchControlsState.emgMode;
      }
      if (sc.poxGroup) {
        sc.poxGroup.hidden = !benchControlsState.pulseOxMode;
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

    if (benchControlsState.pulseOxMode) {
      syncPulseOxControlsDom(poxFinger, poxBpm, poxSpo2);
    }

    syncStimulusVisibility();
  }

  function applyState(saved, { notify = false } = {}) {
    const prevMode = state.workspaceMode;
    const prevWideId = state.activeWideId;
    const prevDrawerOpen = state.benchDrawerOpen;
    let nextWorkspaceMode = 'bench';
    let nextDockOpen = false;
    let nextActiveTabId = state.activeTabId;
    let nextActiveWideId = state.activeWideId;
    let nextActiveAuxId = state.activeAuxId;
    let nextBenchDrawerOpen = false;

    if (saved && typeof saved === 'object') {
      if (saved.workspaceState && typeof saved.workspaceState === 'object') {
        const ws = saved.workspaceState;
        nextWorkspaceMode = ws.workspaceMode === 'computer' ? 'computer' : 'bench';
        nextDockOpen = Boolean(ws.dockOpen);
        nextBenchDrawerOpen = Boolean(ws.benchDrawerOpen);
        if (typeof ws.activeTabId === 'string' && instruments.has(ws.activeTabId)) {
          nextActiveTabId = ws.activeTabId;
        }
        if (typeof ws.activeWideId === 'string' && instruments.has(ws.activeWideId)) {
          nextActiveWideId = ws.activeWideId;
        }
        if (typeof ws.activeAuxId === 'string' && instruments.has(ws.activeAuxId)) {
          nextActiveAuxId = ws.activeAuxId;
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
        if (typeof saved.benchDrawerOpen === 'boolean') {
          nextBenchDrawerOpen = saved.benchDrawerOpen;
        }
        if (typeof saved.activeTabId === 'string' && instruments.has(saved.activeTabId)) {
          nextActiveTabId = saved.activeTabId;
        }
        if (typeof saved.activeWideId === 'string' && instruments.has(saved.activeWideId)) {
          nextActiveWideId = saved.activeWideId;
        }
        if (typeof saved.activeAuxId === 'string' && instruments.has(saved.activeAuxId)) {
          nextActiveAuxId = saved.activeAuxId;
        }
      }
    }

    state = {
      workspaceMode: nextWorkspaceMode,
      dockOpen: nextDockOpen,
      activeTabId: resolveTabId(nextActiveTabId),
      activeWideId: resolveWideId(nextActiveWideId),
      activeAuxId: resolveAuxId(nextActiveAuxId),
      benchDrawerOpen: nextBenchDrawerOpen
    };
    returnToComputerAfterProbe = false;

    syncAttributesAndLayout();
    if (prevMode !== state.workspaceMode) {
      for (const { panel } of instruments.values()) {
        panel.onLayoutChange?.(state.workspaceMode);
      }
    } else if (
      state.workspaceMode === 'computer' &&
      (prevWideId !== state.activeWideId || prevDrawerOpen !== state.benchDrawerOpen)
    ) {
      for (const [id, { panel }] of instruments.entries()) {
        if (isInstrumentVisible(id)) {
          panel.onLayoutChange?.('computer');
        }
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

  els.dockTrayToggle?.addEventListener('click', () => {
    dockTrayUserCollapsed = !isDockTrayCollapsed();
    syncDockTrayCollapse();
  }, { signal });

  els.computerDrawerToggle?.addEventListener('click', () => {
    state.benchDrawerOpen = !state.benchDrawerOpen;
    syncAttributesAndLayout();
    for (const [id, { panel }] of instruments.entries()) {
      if (isInstrumentVisible(id)) {
        panel.onLayoutChange?.('computer');
      }
    }
    notifyStateChange();
  }, { signal });

  if (els.computerAuxSwitcher) {
    els.computerAuxSwitcher.addEventListener('click', (e) => {
      const btn = e.target.closest('.computer-aux-btn');
      if (!btn) return;
      setActiveAuxInstrument(btn.dataset.auxInstrumentId);
    }, { signal });
  }

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
    sc.loadInput.addEventListener('input', () => {
      const grams = Number(sc.loadInput.value);
      benchControlsState.loadCellForceGrams = grams;
      for (const other of stimulusContainers) {
        if (other !== sc) other.loadInput.value = String(grams);
        other.loadVal.textContent = `${Math.round(grams)} g`;
      }
      updateDockTraySummary();
      cb.onLoadChange(grams);
    }, { signal });

    sc.emgFlexInput?.addEventListener('input', () => {
      const pct = Math.round(Number(sc.emgFlexInput.value));
      const flexEffort = Math.min(1, Math.max(0, pct / 100));
      benchControlsState.emgFlexEffort = flexEffort;
      syncEmgControlsDom(pct, benchControlsState.emgBurstMode, benchControlsState.emgHumMvpp);
      updateDockTraySummary();
      cb.onEmgChange({ flexEffort });
    }, { signal });

    sc.emgModeBtn?.addEventListener('click', () => {
      const nextMode = benchControlsState.emgBurstMode === 'continuous' ? 'burst' : 'continuous';
      benchControlsState.emgBurstMode = nextMode;
      const pct = Math.round(benchControlsState.emgFlexEffort * 100);
      syncEmgControlsDom(pct, nextMode, benchControlsState.emgHumMvpp);
      updateDockTraySummary();
      cb.onEmgChange({ burstMode: nextMode });
    }, { signal });

    sc.emgHumInput?.addEventListener('input', () => {
      const humMvpp = Math.round(Math.min(50, Math.max(0, Number(sc.emgHumInput.value))));
      benchControlsState.emgHumMvpp = humMvpp;
      const pct = Math.round(benchControlsState.emgFlexEffort * 100);
      syncEmgControlsDom(pct, benchControlsState.emgBurstMode, humMvpp);
      updateDockTraySummary();
      cb.onEmgChange({ humMvpp });
    }, { signal });

    sc.poxFingerBtn?.addEventListener('click', () => {
      const nextFinger = !benchControlsState.pulseOxFingerPresent;
      benchControlsState.pulseOxFingerPresent = nextFinger;
      syncPulseOxControlsDom(
        nextFinger,
        benchControlsState.pulseOxBpm,
        benchControlsState.pulseOxSpo2
      );
      updateDockTraySummary();
      cb.onPulseOxChange({ fingerPresent: nextFinger });
    }, { signal });

    sc.poxBpmInput?.addEventListener('input', () => {
      const bpm = Math.round(Math.min(160, Math.max(45, Number(sc.poxBpmInput.value) || 72)));
      benchControlsState.pulseOxBpm = bpm;
      syncPulseOxControlsDom(
        benchControlsState.pulseOxFingerPresent,
        bpm,
        benchControlsState.pulseOxSpo2
      );
      updateDockTraySummary();
      cb.onPulseOxChange({ bpm });
    }, { signal });

    sc.poxSpo2Input?.addEventListener('input', () => {
      const spo2 = Math.round(Math.min(100, Math.max(70, Number(sc.poxSpo2Input.value) || 98)));
      benchControlsState.pulseOxSpo2 = spo2;
      syncPulseOxControlsDom(
        benchControlsState.pulseOxFingerPresent,
        benchControlsState.pulseOxBpm,
        spo2
      );
      updateDockTraySummary();
      cb.onPulseOxChange({ spo2 });
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
    delete appShellEl.dataset.computerLayout;
    dockEl.innerHTML = '';
  }

  return {
    registerInstrument,
    openDock,
    closeDock,
    toggleDock,
    setWorkspaceMode,
    setActiveWideInstrument,
    setActiveAuxInstrument,
    setAllowedInstruments,
    temporarilyReturnForProbe,
    setActiveCircuitTitle,
    updateBenchControls,
    getState,
    applyState,
    isInstrumentVisible,
    getVisibleInstrumentIds,
    destroy
  };
}
