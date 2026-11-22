/**
 * Pure, zero-DOM layout computation module for Full Bench ("Computer View")
 * focus vs. side-by-side bench layouts.
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

const VALID_COMPUTER_SLOTS = new Set(['primary', 'aux', 'meter']);

/**
 * Determine which Computer View slot a panel belongs to: 'primary' | 'aux' | 'meter'.
 * Respects explicit `panel.computerSlot` and falls back cleanly for legacy panel descriptors.
 * @param {object} [panel]
 * @returns {'primary'|'aux'|'meter'}
 */
export function getPanelComputerSlot(panel) {
  if (panel && VALID_COMPUTER_SLOTS.has(panel.computerSlot)) {
    return panel.computerSlot;
  }
  if (panel?.preferredWidth === 'wide') {
    return 'primary';
  }
  if (panel?.id === 'dmm') {
    return 'meter';
  }
  return 'aux';
}

/**
 * Determine the Computer View layout behavior for a primary panel:
 * 'focus-with-drawer' | 'bench'.
 * @param {object} [panel]
 * @returns {'focus-with-drawer'|'bench'}
 */
export function getPanelComputerLayout(panel) {
  return panel?.computerLayout === 'focus-with-drawer' ? 'focus-with-drawer' : 'bench';
}

/**
 * Compute Full Bench ("Computer View") instrument visibility, slot selection,
 * drawer state, and topbar switcher flags.
 *
 * @param {object} [state]
 * @param {string|null} [state.activeWideId]
 * @param {string|null} [state.activeAuxId]
 * @param {string|null} [state.activeTabId]
 * @param {boolean} [state.benchDrawerOpen]
 * @param {Array<object>} [panels]
 * @returns {{
 *   activePrimaryId: string|null,
 *   activeAuxId: string|null,
 *   allowedAuxIds: Array<string>,
 *   layoutMode: 'focus'|'bench',
 *   showDrawerToggle: boolean,
 *   drawerOpen: boolean,
 *   visibleIds: Set<string>,
 *   showAuxSwitcher: boolean,
 *   showWideSwitcher: boolean,
 *   showStimuli: boolean
 * }}
 */
export function computeComputerVisibility(state = {}, panels = []) {
  const safeState = state && typeof state === 'object' ? state : {};
  const safePanels = Array.isArray(panels) ? panels : [];

  const tilePanels = safePanels.filter((panel) => panel && panel.computerTile !== false);

  const primaryPanels = [];
  const auxPanels = [];
  const meterPanels = [];

  for (const panel of tilePanels) {
    const slot = getPanelComputerSlot(panel);
    if (slot === 'primary') {
      primaryPanels.push(panel);
    } else if (slot === 'meter') {
      meterPanels.push(panel);
    } else {
      auxPanels.push(panel);
    }
  }

  let activePrimaryId = null;
  if (safeState.activeWideId && primaryPanels.some((p) => p.id === safeState.activeWideId)) {
    activePrimaryId = safeState.activeWideId;
  } else if (safeState.activeTabId && primaryPanels.some((p) => p.id === safeState.activeTabId)) {
    activePrimaryId = safeState.activeTabId;
  } else {
    activePrimaryId = primaryPanels[0]?.id || null;
  }

  const activePrimary = primaryPanels.find((p) => p.id === activePrimaryId) || null;
  const excludedAux = new Set(
    Array.isArray(activePrimary?.excludedAuxIds) ? activePrimary.excludedAuxIds : []
  );
  const allowedAuxPanels = auxPanels.filter((p) => !excludedAux.has(p.id));

  let activeAuxId = null;
  if (safeState.activeAuxId && allowedAuxPanels.some((p) => p.id === safeState.activeAuxId)) {
    activeAuxId = safeState.activeAuxId;
  } else if (safeState.activeTabId && allowedAuxPanels.some((p) => p.id === safeState.activeTabId)) {
    activeAuxId = safeState.activeTabId;
  } else if (allowedAuxPanels.some((p) => p.id === 'fgen')) {
    activeAuxId = 'fgen';
  } else {
    activeAuxId = allowedAuxPanels[0]?.id || null;
  }

  const isFocusCapable = getPanelComputerLayout(activePrimary) === 'focus-with-drawer';
  const hasSideBench = allowedAuxPanels.length > 0 || meterPanels.length > 0;
  const showDrawerToggle = isFocusCapable && hasSideBench;
  const drawerOpen = showDrawerToggle && Boolean(safeState.benchDrawerOpen);
  const layoutMode = isFocusCapable && !drawerOpen ? 'focus' : 'bench';

  const visibleIds = new Set();
  if (layoutMode === 'focus') {
    if (activePrimaryId) {
      visibleIds.add(activePrimaryId);
    }
  } else {
    if (activePrimaryId) {
      visibleIds.add(activePrimaryId);
    }
    if (activeAuxId) {
      visibleIds.add(activeAuxId);
    }
    for (const meter of meterPanels) {
      if (meter.id) {
        visibleIds.add(meter.id);
      }
    }
  }

  const showAuxSwitcher = layoutMode === 'bench' && allowedAuxPanels.length >= 2;
  const showWideSwitcher = primaryPanels.length >= 2;
  const showStimuli = layoutMode === 'bench' || Boolean(activePrimary?.keepStimuliInFocus);

  return {
    activePrimaryId,
    activeAuxId,
    allowedAuxIds: allowedAuxPanels.map((p) => p.id),
    layoutMode,
    showDrawerToggle,
    drawerOpen,
    visibleIds,
    showAuxSwitcher,
    showWideSwitcher,
    showStimuli
  };
}
