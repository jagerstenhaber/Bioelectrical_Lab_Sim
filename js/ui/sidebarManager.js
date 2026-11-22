import {
  HARDWARE_MODULES,
  getActiveHardwareCount
} from '../sim/hardwareRegistry.js';

/**
 * Left Sidebar Tab & External Sensors/Hardware Manager.
 * Manages the segmented tab strip inside `.sidebar-title-row` (`Parts` | `Sensors (N)`
 * plus any future tabs registered via `registerTab`), mounts declarative sensor cards
 * from `HARDWARE_MODULES`, and keeps live stimulus controls & badges synchronized.
 */
export function createSidebarManager({
  sidebarEl,
  expandBtnEl = null,
  partsPanelEl = null,
  sensorsPanelEl = null,
  onToggleHardware = () => {},
  onStimulusPatch = () => {}
} = {}) {
  if (!sidebarEl) {
    throw new Error('createSidebarManager requires sidebarEl');
  }

  const ac = new AbortController();
  const { signal } = ac;

  const titleRowEl = sidebarEl.querySelector('.sidebar-title-row');
  if (!titleRowEl) {
    throw new Error('createSidebarManager requires a .sidebar-title-row inside sidebarEl');
  }

  // Ensure segmented tabs container lives inside .sidebar-title-row (0px added height)
  let tabsEl = titleRowEl.querySelector('#sidebar-tabs, .sidebar-tabs');
  if (!tabsEl) {
    tabsEl = document.createElement('div');
    tabsEl.id = 'sidebar-tabs';
    tabsEl.className = 'sidebar-tabs';
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.setAttribute('aria-label', 'Sidebar Sections');

    const staticHeading = titleRowEl.querySelector('h2');
    if (staticHeading) {
      staticHeading.replaceWith(tabsEl);
    } else {
      titleRowEl.prepend(tabsEl);
    }
  } else {
    const staticHeading = titleRowEl.querySelector('h2');
    if (staticHeading) {
      staticHeading.remove();
    }
  }

  // Resolve Parts & Sensors panels
  const resolvedPartsPanel =
    partsPanelEl || sidebarEl.querySelector('[data-sidebar-panel="parts"]');
  let resolvedSensorsTabPanel =
    sensorsPanelEl || sidebarEl.querySelector('[data-sidebar-panel="sensors"]');

  if (!resolvedSensorsTabPanel) {
    resolvedSensorsTabPanel = document.createElement('div');
    resolvedSensorsTabPanel.id = 'sidebar-sensors-panel';
    resolvedSensorsTabPanel.className = 'sidebar-tab-panel';
    resolvedSensorsTabPanel.dataset.sidebarPanel = 'sensors';
    resolvedSensorsTabPanel.hidden = true;
    sidebarEl.appendChild(resolvedSensorsTabPanel);
  }

  // Scrollable inner #sensors-panel container
  resolvedSensorsTabPanel.innerHTML = `
    <div id="sensors-panel" class="sensors-list"></div>
  `;
  const sensorsListEl = resolvedSensorsTabPanel.querySelector('#sensors-panel');

  /** @type {Map<string, { id: string, label: string, panelEl: HTMLElement, btnEl: HTMLButtonElement }>} */
  const tabs = new Map();
  let activeTabId = 'parts';
  let lastBoardState = {};
  let lastSimConfig = {};

  // Build sensor cards declaratively from HARDWARE_MODULES
  const moduleRefs = new Map();

  for (const mod of HARDWARE_MODULES) {
    const cardEl = document.createElement('section');
    cardEl.className = 'sensor-card';
    cardEl.dataset.hardwareId = mod.id;

    const headerEl = document.createElement('div');
    headerEl.className = 'sensor-card-header';

    const titleWrapEl = document.createElement('div');
    titleWrapEl.className = 'sensor-card-title-wrap';

    const iconEl = document.createElement('span');
    iconEl.className = 'sensor-card-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = mod.icon || '';

    const titleEl = document.createElement('h3');
    titleEl.className = 'sensor-card-title';
    titleEl.textContent = mod.label;

    titleWrapEl.append(iconEl, titleEl);

    const mountBtnEl = document.createElement('button');
    mountBtnEl.type = 'button';
    mountBtnEl.className = 'sensor-mount-btn';
    mountBtnEl.dataset.hardwareMount = mod.id;
    mountBtnEl.setAttribute('aria-pressed', 'false');
    mountBtnEl.textContent = 'Mount';
    mountBtnEl.title = `Mount or unmount ${mod.label} on the bench`;

    mountBtnEl.addEventListener(
      'click',
      () => {
        const currentlyMounted = Boolean(lastBoardState?.[mod.boardFlag]);
        onToggleHardware(mod.id, !currentlyMounted);
      },
      { signal }
    );

    headerEl.append(titleWrapEl, mountBtnEl);

    const descEl = document.createElement('p');
    descEl.className = 'sensor-card-desc';
    descEl.textContent = mod.description || '';

    const controlsEl = document.createElement('div');
    controlsEl.className = 'sensor-card-controls';
    controlsEl.hidden = true;

    const controlRefs = [];

    for (const ctrl of mod.controls || []) {
      if (ctrl.type === 'range') {
        const rowEl = document.createElement('div');
        rowEl.className = 'sensor-control-row';

        const inputId = `sidebar-sensor-${mod.id}-${ctrl.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

        const headEl = document.createElement('div');
        headEl.className = 'sensor-control-head';

        const labelEl = document.createElement('label');
        labelEl.setAttribute('for', inputId);
        labelEl.textContent = ctrl.label;

        const valEl = document.createElement('span');
        valEl.className = 'sensor-control-val';
        valEl.dataset.sensorVal = ctrl.id;

        headEl.append(labelEl, valEl);

        const sliderEl = document.createElement('input');
        sliderEl.id = inputId;
        sliderEl.type = 'range';
        sliderEl.className = 'sensor-slider';
        sliderEl.min = String(ctrl.min);
        sliderEl.max = String(ctrl.max);
        sliderEl.step = String(ctrl.step);
        sliderEl.dataset.sensorCtrl = ctrl.id;

        const initVal = ctrl.get(lastSimConfig);
        sliderEl.value = String(initVal);
        valEl.textContent = ctrl.format(initVal);

        sliderEl.addEventListener(
          'input',
          () => {
            const nextVal = Number(sliderEl.value);
            valEl.textContent = ctrl.format(nextVal);
            onStimulusPatch(ctrl.patch(nextVal), { commit: false });
          },
          { signal }
        );

        sliderEl.addEventListener(
          'change',
          () => {
            const nextVal = Number(sliderEl.value);
            onStimulusPatch(ctrl.patch(nextVal), { commit: true });
          },
          { signal }
        );

        rowEl.append(headEl, sliderEl);
        controlsEl.appendChild(rowEl);
        controlRefs.push({ ctrl, inputEl: sliderEl, valEl });
      } else if (ctrl.type === 'toggle') {
        const rowEl = document.createElement('div');
        rowEl.className = 'sensor-control-row is-inline';

        const labelEl = document.createElement('span');
        labelEl.className = 'sensor-control-label';
        labelEl.textContent = ctrl.label;

        const toggleBtnEl = document.createElement('button');
        toggleBtnEl.type = 'button';
        toggleBtnEl.className = 'sensor-toggle-btn';
        toggleBtnEl.dataset.sensorCtrl = ctrl.id;

        const initOn = Boolean(ctrl.get(lastSimConfig));
        toggleBtnEl.classList.toggle('is-pressed', initOn);
        toggleBtnEl.setAttribute('aria-pressed', String(initOn));
        toggleBtnEl.textContent = ctrl.format(initOn);

        toggleBtnEl.addEventListener(
          'click',
          () => {
            const curOn = Boolean(ctrl.get(lastSimConfig));
            const nextOn = !curOn;
            toggleBtnEl.classList.toggle('is-pressed', nextOn);
            toggleBtnEl.setAttribute('aria-pressed', String(nextOn));
            toggleBtnEl.textContent = ctrl.format(nextOn);
            onStimulusPatch(ctrl.patch(nextOn), { commit: true });
          },
          { signal }
        );

        rowEl.append(labelEl, toggleBtnEl);
        controlsEl.appendChild(rowEl);
        controlRefs.push({ ctrl, btnEl: toggleBtnEl });
      }
    }

    cardEl.append(headerEl, descEl, controlsEl);
    sensorsListEl.appendChild(cardEl);

    moduleRefs.set(mod.id, {
      mod,
      cardEl,
      mountBtnEl,
      controlsEl,
      controlRefs
    });
  }

  const footerNoteEl = document.createElement('div');
  footerNoteEl.className = 'sensors-footer-note';
  footerNoteEl.innerHTML =
    '<strong>Tip:</strong> Mounted external sensors can be repositioned around the breadboard by clicking them on the canvas and pressing <kbd>R</kbd>.';
  sensorsListEl.appendChild(footerNoteEl);

  function setActiveTab(tabId) {
    if (!tabs.has(tabId)) return;
    activeTabId = tabId;
    for (const [id, entry] of tabs.entries()) {
      const isActive = id === activeTabId;
      entry.btnEl.classList.toggle('is-active', isActive);
      entry.btnEl.setAttribute('aria-selected', String(isActive));
      if (entry.panelEl) {
        entry.panelEl.hidden = !isActive;
      }
    }
  }

  /**
   * Register a sidebar tab (used for built-in Parts & Sensors, and extensible for future Lab Guide).
   * @param {{ id: string, label: string, panelEl: HTMLElement, badgeHtml?: string }} tabDef
   */
  function registerTab({ id, label, panelEl, badgeHtml = '' } = {}) {
    if (!id || !panelEl) return null;

    if (tabs.has(id)) {
      const existing = tabs.get(id);
      existing.btnEl.remove();
      tabs.delete(id);
    }

    panelEl.dataset.sidebarPanel = id;
    panelEl.setAttribute('role', 'tabpanel');
    if (!panelEl.id) {
      panelEl.id = `sidebar-panel-${id}`;
    }

    const btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.className = 'sidebar-tab-btn';
    btnEl.setAttribute('role', 'tab');
    btnEl.dataset.sidebarTab = id;
    btnEl.setAttribute('aria-controls', panelEl.id);
    btnEl.setAttribute('aria-selected', 'false');

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label || id;
    btnEl.appendChild(labelSpan);

    if (badgeHtml) {
      const tmp = document.createElement('span');
      tmp.innerHTML = badgeHtml;
      while (tmp.firstChild) {
        btnEl.appendChild(tmp.firstChild);
      }
    }

    btnEl.addEventListener(
      'click',
      () => {
        setActiveTab(id);
      },
      { signal }
    );

    if (panelEl.parentElement !== sidebarEl) {
      sidebarEl.appendChild(panelEl);
    }

    tabsEl.appendChild(btnEl);
    const entry = { id, label: label || id, panelEl, btnEl };
    tabs.set(id, entry);

    setActiveTab(tabs.has(activeTabId) ? activeTabId : id);
    return entry;
  }

  // Register built-in tabs
  if (resolvedPartsPanel) {
    registerTab({
      id: 'parts',
      label: 'Parts',
      panelEl: resolvedPartsPanel
    });
  }

  registerTab({
    id: 'sensors',
    label: 'Sensors',
    panelEl: resolvedSensorsTabPanel,
    badgeHtml: '<span class="sidebar-tab-badge" data-sensors-badge hidden>0</span>'
  });

  const sensorsBadgeEl = tabsEl.querySelector('[data-sensors-badge]');

  function syncState({ boardState = {}, simConfig = {} } = {}) {
    lastBoardState = boardState || {};
    lastSimConfig = simConfig || {};

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;

    for (const { mod, cardEl, mountBtnEl, controlsEl, controlRefs } of moduleRefs.values()) {
      const isMounted = Boolean(lastBoardState?.[mod.boardFlag]);
      cardEl.classList.toggle('is-mounted', isMounted);
      mountBtnEl.classList.toggle('is-mounted', isMounted);
      mountBtnEl.setAttribute('aria-pressed', String(isMounted));
      mountBtnEl.textContent = isMounted ? 'Mounted' : 'Mount';
      controlsEl.hidden = !isMounted;

      if (isMounted) {
        for (const ref of controlRefs) {
          const val = ref.ctrl.get(lastSimConfig);
          if (ref.ctrl.type === 'range') {
            if (ref.valEl) {
              ref.valEl.textContent = ref.ctrl.format(val);
            }
            if (ref.inputEl && activeEl !== ref.inputEl) {
              ref.inputEl.value = String(val);
            }
          } else if (ref.ctrl.type === 'toggle' && ref.btnEl) {
            const isOn = Boolean(val);
            ref.btnEl.classList.toggle('is-pressed', isOn);
            ref.btnEl.setAttribute('aria-pressed', String(isOn));
            ref.btnEl.textContent = ref.ctrl.format(isOn);
          }
        }
      }
    }

    const activeCount = getActiveHardwareCount(lastBoardState);
    if (sensorsBadgeEl) {
      sensorsBadgeEl.textContent = String(activeCount);
      sensorsBadgeEl.hidden = activeCount === 0;
    }

    if (expandBtnEl) {
      expandBtnEl.textContent =
        activeCount > 0 ? `▶ Parts & Sensors (${activeCount})` : '▶ Parts & Sensors';
    }
  }

  function destroy() {
    ac.abort();
    tabs.clear();
    moduleRefs.clear();
  }

  setActiveTab('parts');
  syncState({ boardState: {}, simConfig: {} });

  return {
    setActiveTab,
    registerTab,
    syncState,
    destroy
  };
}
