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
  onStimulusPatch = () => {},
  onQuickPlacePpgLdr = () => {},
  onSelectPpgLdr = () => {},
  onTabChange = () => {},
  onClearLabFilter = () => {}
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

  // Build sensor & safety cards declaratively from HARDWARE_MODULES
  const moduleRefs = new Map();

  function buildModuleCard(mod) {
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

    const isSafetySimToggle = Boolean(!mod.boardFlag && mod.simConfigFlag);
    mountBtnEl.textContent = isSafetySimToggle ? 'Insert' : 'Mount';
    mountBtnEl.title = isSafetySimToggle
      ? `Insert or remove ${mod.label}`
      : `Mount or unmount ${mod.label} on the bench`;

    mountBtnEl.addEventListener(
      'click',
      () => {
        if (mod.boardFlag) {
          const currentlyMounted = Boolean(lastBoardState?.[mod.boardFlag]);
          onToggleHardware(mod.id, !currentlyMounted);
        } else if (mod.simConfigFlag) {
          const currentlyEnabled = Boolean(lastSimConfig?.[mod.simConfigFlag]);
          onStimulusPatch({ [mod.simConfigFlag]: !currentlyEnabled }, { commit: true });
        }
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

    moduleRefs.set(mod.id, {
      mod,
      cardEl,
      mountBtnEl,
      controlsEl,
      controlRefs,
      isSafetySimToggle
    });

    return cardEl;
  }

  function appendSectionHeading(text) {
    const headingEl = document.createElement('div');
    headingEl.className = 'sensors-section-heading';
    headingEl.textContent = text;
    sensorsListEl.appendChild(headingEl);
    return headingEl;
  }

  // Lab Kit filter banner / empty state inside Sensors tab
  const sensorsFilterBannerEl = document.createElement('div');
  sensorsFilterBannerEl.className = 'lab-filter-banner';
  sensorsFilterBannerEl.hidden = true;
  const sensorsFilterTextEl = document.createElement('span');
  const sensorsShowAllBtnEl = document.createElement('button');
  sensorsShowAllBtnEl.type = 'button';
  sensorsShowAllBtnEl.className = 'lab-filter-show-all-btn';
  sensorsShowAllBtnEl.textContent = 'Show All';
  sensorsShowAllBtnEl.addEventListener('click', () => onClearLabFilter(), { signal });
  sensorsFilterBannerEl.append(sensorsFilterTextEl, sensorsShowAllBtnEl);
  sensorsListEl.appendChild(sensorsFilterBannerEl);

  // Subsection 1: External Sensors
  const externalSensorsHeadingEl = appendSectionHeading('External Sensors');

  for (const mod of HARDWARE_MODULES.filter((m) => m.category === 'sensor')) {
    sensorsListEl.appendChild(buildModuleCard(mod));
  }

  // Optical PPG (LED + Photoresistor) breadboard helper card
  const ppgHelperCardEl = document.createElement('section');
  ppgHelperCardEl.className = 'sensor-card sensor-card-helper';
  ppgHelperCardEl.dataset.ppgHelper = 'true';

  const ppgHeaderEl = document.createElement('div');
  ppgHeaderEl.className = 'sensor-card-header';

  const ppgTitleWrapEl = document.createElement('div');
  ppgTitleWrapEl.className = 'sensor-card-title-wrap';

  const ppgIconEl = document.createElement('span');
  ppgIconEl.className = 'sensor-card-icon';
  ppgIconEl.setAttribute('aria-hidden', 'true');
  ppgIconEl.textContent = '💡';

  const ppgTitleEl = document.createElement('h3');
  ppgTitleEl.className = 'sensor-card-title';
  ppgTitleEl.textContent = 'LED + Photoresistor PPG';

  ppgTitleWrapEl.append(ppgIconEl, ppgTitleEl);

  const ppgBadgeEl = document.createElement('span');
  ppgBadgeEl.className = 'sensor-helper-badge';
  ppgBadgeEl.dataset.ppgHelperBadge = '';
  ppgBadgeEl.textContent = 'Breadboard Part';

  ppgHeaderEl.append(ppgTitleWrapEl, ppgBadgeEl);

  const ppgDescEl = document.createElement('p');
  ppgDescEl.className = 'sensor-card-desc';
  ppgDescEl.textContent =
    'Pair a lit Red LED with a Photoresistor in LED + Finger PPG mode for single-wavelength optical pulse sensing.';

  const ppgActionBtnEl = document.createElement('button');
  ppgActionBtnEl.type = 'button';
  ppgActionBtnEl.className = 'sensor-helper-btn';
  ppgActionBtnEl.dataset.ppgHelperBtn = '';
  ppgActionBtnEl.textContent = '+ Place Photoresistor (PPG)';

  let lastPlacedPpgLdrId = null;

  ppgActionBtnEl.addEventListener(
    'click',
    () => {
      if (lastPlacedPpgLdrId) {
        onSelectPpgLdr(lastPlacedPpgLdrId);
      } else {
        onQuickPlacePpgLdr();
      }
    },
    { signal }
  );

  ppgHelperCardEl.append(ppgHeaderEl, ppgDescEl, ppgActionBtnEl);
  sensorsListEl.appendChild(ppgHelperCardEl);

  // Subsection 2: Isolation & Safety (IEC 60601)
  const safetyHeadingEl = appendSectionHeading('Isolation & Safety (IEC 60601)');

  for (const mod of HARDWARE_MODULES.filter((m) => m.category === 'safety')) {
    sensorsListEl.appendChild(buildModuleCard(mod));
  }

  // Live IEC 60601 Isolation Assessment Card
  const isolationCardEl = document.createElement('section');
  isolationCardEl.className = 'isolation-card';
  isolationCardEl.dataset.isolationCard = '';

  const isolationHeadEl = document.createElement('div');
  isolationHeadEl.className = 'isolation-card-head';

  const isolationTitleEl = document.createElement('h3');
  isolationTitleEl.className = 'isolation-card-title';
  isolationTitleEl.textContent = '🛡 IEC 60601 Assessment';

  const isolationVerdictEl = document.createElement('span');
  isolationVerdictEl.className = 'isolation-verdict-pill is-inactive';
  isolationVerdictEl.dataset.isolationVerdict = '';
  isolationVerdictEl.textContent = 'No Patient Electrodes';

  isolationHeadEl.append(isolationTitleEl, isolationVerdictEl);

  const isolationChecksEl = document.createElement('div');
  isolationChecksEl.className = 'isolation-checks';
  isolationChecksEl.dataset.isolationChecks = '';

  isolationCardEl.append(isolationHeadEl, isolationChecksEl);
  sensorsListEl.appendChild(isolationCardEl);

  const footerNoteEl = document.createElement('div');
  footerNoteEl.className = 'sensors-footer-note';
  footerNoteEl.innerHTML =
    '<strong>Tip:</strong> Mounted external sensors can be repositioned around the breadboard by clicking them on the canvas and pressing <kbd>R</kbd>.';
  sensorsListEl.appendChild(footerNoteEl);

  let allowedSensorIds = null; // null = all sensors shown
  let allowPpgHelperCard = true;
  let lastIsolationActive = false;

  function applySensorFilterVisibility() {
    if (allowedSensorIds === null) {
      sensorsFilterBannerEl.hidden = true;
      externalSensorsHeadingEl.hidden = false;
      safetyHeadingEl.hidden = false;
      ppgHelperCardEl.hidden = false;
      isolationCardEl.hidden = false;
      footerNoteEl.hidden = false;
      for (const { cardEl } of moduleRefs.values()) {
        cardEl.hidden = false;
      }
      return;
    }

    let visibleSensorCards = 0;
    let visibleSafetyCards = 0;
    for (const [id, { mod, cardEl }] of moduleRefs.entries()) {
      const show = allowedSensorIds.has(id);
      cardEl.hidden = !show;
      if (show) {
        if (mod.category === 'safety') visibleSafetyCards += 1;
        else visibleSensorCards += 1;
      }
    }

    ppgHelperCardEl.hidden = !allowPpgHelperCard;
    const anyExternalVisible = visibleSensorCards > 0 || allowPpgHelperCard;
    externalSensorsHeadingEl.hidden = !anyExternalVisible;

    const showIsolationCard =
      visibleSafetyCards > 0 || allowedSensorIds.has('emg') || lastIsolationActive;
    isolationCardEl.hidden = !showIsolationCard;
    safetyHeadingEl.hidden = !(visibleSafetyCards > 0 || showIsolationCard);

    const totalVisibleModules = visibleSensorCards + visibleSafetyCards;
    footerNoteEl.hidden = visibleSensorCards === 0;

    sensorsFilterBannerEl.hidden = false;
    sensorsFilterTextEl.textContent =
      totalVisibleModules === 0 && !allowPpgHelperCard
        ? 'Lab Kit: external sensors hidden'
        : `Lab Kit: ${totalVisibleModules} of ${HARDWARE_MODULES.length} modules`;
  }

  function setAllowedSensors(allowedIdsOrNull, { allowPpgHelper = true } = {}) {
    if (allowedIdsOrNull === null || allowedIdsOrNull === undefined) {
      allowedSensorIds = null;
      allowPpgHelperCard = true;
    } else if (Array.isArray(allowedIdsOrNull)) {
      allowedSensorIds = new Set(allowedIdsOrNull);
      allowPpgHelperCard = Boolean(allowPpgHelper);
    } else if (allowedIdsOrNull instanceof Set) {
      allowedSensorIds = new Set(allowedIdsOrNull);
      allowPpgHelperCard = Boolean(allowPpgHelper);
    } else {
      allowedSensorIds = null;
      allowPpgHelperCard = true;
    }
    applySensorFilterVisibility();
  }

  function getActiveTabId() {
    return activeTabId;
  }

  function setActiveTab(tabId) {
    if (!tabs.has(tabId)) return;
    const prevTabId = activeTabId;
    activeTabId = tabId;
    for (const [id, entry] of tabs.entries()) {
      const isActive = id === activeTabId;
      entry.btnEl.classList.toggle('is-active', isActive);
      entry.btnEl.setAttribute('aria-selected', String(isActive));
      if (entry.panelEl) {
        entry.panelEl.hidden = !isActive;
      }
    }
    if (prevTabId !== activeTabId) {
      onTabChange(activeTabId);
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
  const sensorsTabBtnEl = tabs.get('sensors')?.btnEl || null;

  function renderIsolationAssessment(isolationResult) {
    const verdictClasses = ['is-inactive', 'is-safe', 'is-partial', 'is-hazard'];
    isolationVerdictEl.classList.remove(...verdictClasses);

    if (!isolationResult || !isolationResult.active) {
      isolationVerdictEl.classList.add('is-inactive');
      isolationVerdictEl.textContent = 'No Patient Electrodes';

      isolationChecksEl.innerHTML = '';
      const noteEl = document.createElement('p');
      noteEl.className = 'isolation-inactive-note';
      noteEl.textContent =
        'Mount a patient-applied sensor (e.g. 3-Pad EMG) to evaluate IEC 60601 galvanic & high-pass isolation.';
      isolationChecksEl.appendChild(noteEl);
      return;
    }

    const level = isolationResult.level || 'hazard';
    if (level === 'safe') {
      isolationVerdictEl.classList.add('is-safe');
      isolationVerdictEl.textContent = 'Isolated ✓';
    } else if (level === 'partial') {
      isolationVerdictEl.classList.add('is-partial');
      const passed = Number(isolationResult.passedRequired) || 0;
      const total = Number(isolationResult.totalRequired) || 0;
      isolationVerdictEl.textContent = `Partial (${passed}/${total})`;
    } else {
      isolationVerdictEl.classList.add('is-hazard');
      isolationVerdictEl.textContent = 'Unisolated';
    }

    isolationChecksEl.innerHTML = '';
    const iconByStatus = {
      pass: '✓',
      warn: '⚠',
      fail: '✕',
      info: 'ℹ'
    };

    for (const check of isolationResult.checks || []) {
      const status = check?.status || 'info';
      const rowEl = document.createElement('div');
      rowEl.className = `isolation-check-row is-${status}`;
      if (check?.detail) {
        rowEl.title = check.detail;
      }

      const statusIconEl = document.createElement('span');
      statusIconEl.className = 'isolation-check-icon';
      statusIconEl.setAttribute('aria-hidden', 'true');
      statusIconEl.textContent = iconByStatus[status] || 'ℹ';

      const bodyEl = document.createElement('div');
      bodyEl.className = 'isolation-check-body';

      const checkTitleEl = document.createElement('div');
      checkTitleEl.className = 'isolation-check-title';
      checkTitleEl.textContent = check?.title || '';

      const checkSummaryEl = document.createElement('div');
      checkSummaryEl.className = 'isolation-check-summary';
      checkSummaryEl.textContent = check?.summary || '';

      bodyEl.append(checkTitleEl, checkSummaryEl);
      rowEl.append(statusIconEl, bodyEl);
      isolationChecksEl.appendChild(rowEl);
    }
  }

  function syncState({
    boardState = {},
    simConfig = {},
    placedParts = [],
    isolationResult = null
  } = {}) {
    lastBoardState = boardState || {};
    lastSimConfig = simConfig || {};

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;

    for (const {
      mod,
      cardEl,
      mountBtnEl,
      controlsEl,
      controlRefs,
      isSafetySimToggle
    } of moduleRefs.values()) {
      const isMounted = mod.boardFlag
        ? Boolean(lastBoardState?.[mod.boardFlag])
        : Boolean(mod.simConfigFlag && lastSimConfig?.[mod.simConfigFlag]);

      cardEl.classList.toggle('is-mounted', isMounted);
      mountBtnEl.classList.toggle('is-mounted', isMounted);
      mountBtnEl.setAttribute('aria-pressed', String(isMounted));
      mountBtnEl.textContent = isSafetySimToggle
        ? isMounted
          ? 'Inserted'
          : 'Insert'
        : isMounted
        ? 'Mounted'
        : 'Mount';

      const hasControls = Array.isArray(controlRefs) && controlRefs.length > 0;
      controlsEl.hidden = !isMounted || !hasControls;

      if (isMounted && hasControls) {
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

    const ldr = Array.isArray(placedParts)
      ? placedParts.find((p) => p?.partId === 'photoresistor') || null
      : null;
    lastPlacedPpgLdrId = ldr?.id || null;
    ppgHelperCardEl.classList.toggle('is-mounted', Boolean(ldr));
    ppgBadgeEl.textContent = ldr ? 'On Board' : 'Breadboard Part';
    ppgBadgeEl.classList.toggle('is-on-board', Boolean(ldr));
    ppgActionBtnEl.textContent = ldr ? 'Select Photoresistor' : '+ Place Photoresistor (PPG)';

    lastIsolationActive = Boolean(isolationResult?.active);
    renderIsolationAssessment(isolationResult);
    applySensorFilterVisibility();

    const activeCount = getActiveHardwareCount(lastBoardState, lastSimConfig);
    if (sensorsBadgeEl) {
      sensorsBadgeEl.textContent = String(activeCount);
      sensorsBadgeEl.hidden = activeCount === 0;
    }

    const hasSafetyWarn = Boolean(isolationResult?.active && isolationResult.level !== 'safe');
    if (sensorsTabBtnEl) {
      sensorsTabBtnEl.classList.toggle('has-safety-warn', hasSafetyWarn);
    }

    if (expandBtnEl) {
      expandBtnEl.textContent =
        activeCount > 0 ? `▶ Parts & Sensors (${activeCount})` : '▶ Parts & Sensors';
      expandBtnEl.classList.toggle('has-safety-warn', hasSafetyWarn);
    }
  }

  function setTabBadge(tabId, text = '', { tone = 'default' } = {}) {
    const entry = tabs.get(tabId);
    if (!entry) return;
    let badge = entry.btnEl.querySelector('.sidebar-tab-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sidebar-tab-badge';
      entry.btnEl.appendChild(badge);
    }
    const clean = String(text || '').trim();
    badge.textContent = clean;
    badge.hidden = !clean;
    badge.classList.toggle('is-complete', tone === 'complete');
  }

  function destroy() {
    ac.abort();
    tabs.clear();
    moduleRefs.clear();
  }

  setActiveTab('parts');
  syncState({ boardState: {}, simConfig: {}, isolationResult: null });

  return {
    setActiveTab,
    getActiveTabId,
    registerTab,
    setAllowedSensors,
    setTabBadge,
    syncState,
    destroy
  };
}
