import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HARDWARE_MODULES,
  getHardwareModule,
  getActiveHardwareModules,
  getActiveHardwareCount,
  getStimulusSummaryText
} from '../js/sim/hardwareRegistry.js';
import {
  getPanelComputerSlot,
  getPanelComputerLayout,
  computeComputerVisibility
} from '../js/ui/workspaceLayout.js';

const STANDARD_PANELS = [
  {
    id: 'scope',
    preferredWidth: 'wide',
    computerSlot: 'primary',
    computerLayout: 'bench'
  },
  {
    id: 'arduino',
    preferredWidth: 'wide',
    computerSlot: 'primary',
    computerLayout: 'focus-with-drawer',
    keepStimuliInFocus: true
  },
  {
    id: 'bode',
    preferredWidth: 'wide',
    computerSlot: 'primary',
    computerLayout: 'focus-with-drawer',
    excludedAuxIds: ['fgen']
  },
  {
    id: 'fgen',
    computerSlot: 'aux'
  },
  {
    id: 'vps',
    computerSlot: 'aux'
  },
  {
    id: 'dmm',
    computerSlot: 'meter'
  },
  {
    id: 'hidden-helper',
    computerTile: false,
    preferredWidth: 'wide'
  }
];

test('workspaceLayout: Scope uses bench layout showing Scope + active Aux + DMM', () => {
  const res = computeComputerVisibility({ activeWideId: 'scope' }, STANDARD_PANELS);

  assert.equal(res.activePrimaryId, 'scope');
  assert.equal(res.activeAuxId, 'fgen');
  assert.deepEqual(res.allowedAuxIds, ['fgen', 'vps']);
  assert.equal(res.layoutMode, 'bench');
  assert.equal(res.showDrawerToggle, false);
  assert.equal(res.drawerOpen, false);
  assert.equal(res.showAuxSwitcher, true);
  assert.equal(res.showWideSwitcher, true);
  assert.equal(res.showStimuli, true);
  assert.deepEqual([...res.visibleIds].sort(), ['dmm', 'fgen', 'scope']);

  // Respects explicit activeAuxId selection
  const resVps = computeComputerVisibility(
    { activeWideId: 'scope', activeAuxId: 'vps' },
    STANDARD_PANELS
  );
  assert.equal(resVps.activeAuxId, 'vps');
  assert.deepEqual([...resVps.visibleIds].sort(), ['dmm', 'scope', 'vps']);
});

test('workspaceLayout: Nano (arduino) defaults to focus-with-drawer and opens bench drawer when toggled', () => {
  const focusRes = computeComputerVisibility({ activeWideId: 'arduino' }, STANDARD_PANELS);

  assert.equal(focusRes.activePrimaryId, 'arduino');
  assert.equal(focusRes.layoutMode, 'focus');
  assert.equal(focusRes.showDrawerToggle, true);
  assert.equal(focusRes.drawerOpen, false);
  assert.deepEqual([...focusRes.visibleIds], ['arduino']);
  assert.equal(focusRes.showAuxSwitcher, false);
  assert.equal(focusRes.showWideSwitcher, true);
  assert.equal(focusRes.showStimuli, true);

  const drawerRes = computeComputerVisibility(
    { activeWideId: 'arduino', benchDrawerOpen: true },
    STANDARD_PANELS
  );

  assert.equal(drawerRes.activePrimaryId, 'arduino');
  assert.equal(drawerRes.activeAuxId, 'fgen');
  assert.equal(drawerRes.layoutMode, 'bench');
  assert.equal(drawerRes.showDrawerToggle, true);
  assert.equal(drawerRes.drawerOpen, true);
  assert.deepEqual([...drawerRes.visibleIds].sort(), ['arduino', 'dmm', 'fgen']);
  assert.equal(drawerRes.showAuxSwitcher, true);
  assert.equal(drawerRes.showStimuli, true);
});

test('workspaceLayout: Bode defaults to focus and never shows excluded fgen even with drawer open', () => {
  const focusRes = computeComputerVisibility({ activeWideId: 'bode' }, STANDARD_PANELS);

  assert.equal(focusRes.activePrimaryId, 'bode');
  assert.equal(focusRes.layoutMode, 'focus');
  assert.equal(focusRes.showDrawerToggle, true);
  assert.equal(focusRes.drawerOpen, false);
  assert.deepEqual([...focusRes.visibleIds], ['bode']);
  assert.equal(focusRes.showAuxSwitcher, false);
  assert.equal(focusRes.showStimuli, false);
  assert.deepEqual(focusRes.allowedAuxIds, ['vps']);
  assert.equal(focusRes.activeAuxId, 'vps');

  const bodeInputState = { activeWideId: 'bode', activeAuxId: 'fgen', benchDrawerOpen: true };
  const drawerWithFgenRequested = computeComputerVisibility(bodeInputState, STANDARD_PANELS);

  assert.equal(drawerWithFgenRequested.layoutMode, 'bench');
  assert.equal(drawerWithFgenRequested.drawerOpen, true);
  assert.deepEqual(drawerWithFgenRequested.allowedAuxIds, ['vps']);
  assert.equal(drawerWithFgenRequested.activeAuxId, 'vps');
  assert.equal(drawerWithFgenRequested.visibleIds.has('fgen'), false);
  assert.deepEqual([...drawerWithFgenRequested.visibleIds].sort(), ['bode', 'dmm', 'vps']);
  assert.equal(drawerWithFgenRequested.showAuxSwitcher, false);
  assert.equal(drawerWithFgenRequested.showStimuli, true);
  assert.equal(bodeInputState.activeAuxId, 'fgen');

  const restoredScope = computeComputerVisibility(
    { ...bodeInputState, activeWideId: 'scope', benchDrawerOpen: false },
    STANDARD_PANELS
  );
  assert.equal(restoredScope.activeAuxId, 'fgen');
  assert.deepEqual([...restoredScope.visibleIds].sort(), ['dmm', 'fgen', 'scope']);
});

test('workspaceLayout: legacy panels without explicit computerSlot or computerLayout fall back cleanly', () => {
  const legacyPanels = [
    { id: 'scope', preferredWidth: 'wide' },
    { id: 'fgen' },
    { id: 'vps' },
    { id: 'dmm' },
    { id: 'excluded', computerTile: false }
  ];

  assert.equal(getPanelComputerSlot({ id: 'scope', preferredWidth: 'wide' }), 'primary');
  assert.equal(getPanelComputerSlot({ id: 'dmm' }), 'meter');
  assert.equal(getPanelComputerSlot({ id: 'fgen' }), 'aux');
  assert.equal(getPanelComputerSlot({ id: 'dmm', computerSlot: 'aux' }), 'aux');

  assert.equal(getPanelComputerLayout({ id: 'scope' }), 'bench');
  assert.equal(
    getPanelComputerLayout({ id: 'bode', computerLayout: 'focus-with-drawer' }),
    'focus-with-drawer'
  );

  const res = computeComputerVisibility({ activeTabId: 'vps' }, legacyPanels);
  assert.equal(res.activePrimaryId, 'scope');
  assert.equal(res.activeAuxId, 'vps');
  assert.equal(res.layoutMode, 'bench');
  assert.equal(res.showWideSwitcher, false);
  assert.equal(res.showAuxSwitcher, true);
  assert.equal(res.showDrawerToggle, false);
  assert.deepEqual([...res.visibleIds].sort(), ['dmm', 'scope', 'vps']);

  // Empty panels edge case
  const emptyRes = computeComputerVisibility({}, []);
  assert.equal(emptyRes.activePrimaryId, null);
  assert.equal(emptyRes.activeAuxId, null);
  assert.deepEqual(emptyRes.allowedAuxIds, []);
  assert.equal(emptyRes.layoutMode, 'bench');
  assert.equal(emptyRes.showDrawerToggle, false);
  assert.equal(emptyRes.visibleIds.size, 0);
});

test('hardwareRegistry: HARDWARE_MODULES metadata and lookup helpers', () => {
  assert.equal(Object.isFrozen(HARDWARE_MODULES), true);
  assert.equal(HARDWARE_MODULES.length, 4);

  const loadMod = getHardwareModule('load-cells');
  assert.ok(loadMod);
  assert.equal(loadMod.label, 'Load Cells');
  assert.equal(loadMod.shortLabel, 'Load');
  assert.equal(loadMod.icon, '⚖');
  assert.equal(loadMod.category, 'sensor');
  assert.equal(loadMod.boardFlag, 'loadCellsMode');
  assert.equal(loadMod.hasTerminalBlock, true);

  const emgMod = getHardwareModule('emg');
  assert.ok(emgMod);
  assert.equal(emgMod.label, '3-Pad Surface EMG');
  assert.equal(emgMod.shortLabel, 'EMG');
  assert.equal(emgMod.icon, '💓');
  assert.equal(emgMod.category, 'sensor');
  assert.equal(emgMod.boardFlag, 'emgMode');
  assert.equal(emgMod.hasTerminalBlock, true);

  const poxMod = getHardwareModule('pulse-ox');
  assert.ok(poxMod);
  assert.equal(poxMod.category, 'sensor');
  assert.equal(poxMod.boardFlag, 'pulseOxMode');
  assert.equal(poxMod.hasTerminalBlock, true);
  assert.ok(Array.isArray(poxMod.controls) && poxMod.controls.length >= 3);

  const isoMod = getHardwareModule('adum3160');
  assert.ok(isoMod);
  assert.equal(isoMod.category, 'safety');
  assert.equal(isoMod.boardFlag, null);
  assert.equal(isoMod.simConfigFlag, 'usbIsolatorEnabled');
  assert.equal(isoMod.hasTerminalBlock, false);

  assert.equal(getHardwareModule('nonexistent'), null);

  assert.deepEqual(getActiveHardwareModules({}), []);
  assert.equal(getActiveHardwareCount({}), 0);

  const activeLoad = getActiveHardwareModules({ loadCellsMode: true, emgMode: false, pulseOxMode: false });
  assert.deepEqual(
    activeLoad.map((m) => m.id),
    ['load-cells']
  );
  assert.equal(getActiveHardwareCount({ loadCellsMode: true, emgMode: false, pulseOxMode: false }), 1);

  const activeAll = getActiveHardwareModules(
    { loadCellsMode: true, emgMode: true, pulseOxMode: true },
    { usbIsolatorEnabled: true }
  );
  assert.deepEqual(
    activeAll.map((m) => m.id),
    ['load-cells', 'emg', 'pulse-ox', 'adum3160']
  );
  assert.equal(
    getActiveHardwareCount(
      { loadCellsMode: true, emgMode: true, pulseOxMode: true },
      { usbIsolatorEnabled: true }
    ),
    4
  );
});

test('hardwareRegistry: control get, patch, and format behaviors clamp and normalize cleanly', () => {
  const loadCtrl = getHardwareModule('load-cells').controls[0];
  assert.equal(loadCtrl.get(undefined), 0);
  assert.equal(loadCtrl.get({ loadCellForceGrams: 420 }), 420);
  assert.equal(loadCtrl.get({ loadCellForceGrams: -50 }), 0);
  assert.equal(loadCtrl.get({ loadCellForceGrams: 1800 }), 1000);
  assert.deepEqual(loadCtrl.patch(500), { loadCellForceGrams: 500 });
  assert.deepEqual(loadCtrl.patch(9999), { loadCellForceGrams: 1000 });
  assert.deepEqual(loadCtrl.patch(-10), { loadCellForceGrams: 0 });
  assert.equal(loadCtrl.format(500.4), '500 g');

  const emgControls = getHardwareModule('emg').controls;
  const flexCtrl = emgControls.find((c) => c.id === 'emg.flexEffort');
  const modeCtrl = emgControls.find((c) => c.id === 'emg.burstMode');
  const humCtrl = emgControls.find((c) => c.id === 'emg.humMvpp');

  assert.equal(flexCtrl.get(undefined), 50);
  assert.equal(flexCtrl.get({ emg: { flexEffort: 0.85 } }), 85);
  assert.equal(flexCtrl.get({ emg: { flexEffort: 2 } }), 100);
  assert.equal(flexCtrl.get({ emg: { flexEffort: -1 } }), 0);
  assert.deepEqual(flexCtrl.patch(85), { emg: { flexEffort: 0.85 } });
  assert.deepEqual(flexCtrl.patch(150), { emg: { flexEffort: 1 } });
  assert.deepEqual(flexCtrl.patch(-25), { emg: { flexEffort: 0 } });
  assert.equal(flexCtrl.format(85), '85%');

  assert.equal(modeCtrl.get(undefined), true);
  assert.equal(modeCtrl.get({ emg: { burstMode: 'burst' } }), true);
  assert.equal(modeCtrl.get({ emg: { burstMode: 'continuous' } }), false);
  assert.deepEqual(modeCtrl.patch(true), { emg: { burstMode: 'burst' } });
  assert.deepEqual(modeCtrl.patch(false), { emg: { burstMode: 'continuous' } });
  assert.equal(modeCtrl.format(true), 'Burst');
  assert.equal(modeCtrl.format(false), 'Hold');

  assert.equal(humCtrl.get(undefined), 0);
  assert.equal(humCtrl.get({ emg: { humMvpp: 15.4 } }), 15);
  assert.equal(humCtrl.get({ emg: { humMvpp: 90 } }), 50);
  assert.equal(humCtrl.get({ emg: { humMvpp: -5 } }), 0);
  assert.deepEqual(humCtrl.patch(15.2), { emg: { humMvpp: 15 } });
  assert.deepEqual(humCtrl.patch(99), { emg: { humMvpp: 50 } });
  assert.deepEqual(humCtrl.patch(-3), { emg: { humMvpp: 0 } });
  assert.equal(humCtrl.format(15), '15 mVpp');

  const poxControls = getHardwareModule('pulse-ox').controls;
  const poxFingerCtrl = poxControls.find((c) => c.id === 'pulseOx.fingerPresent');
  const poxBpmCtrl = poxControls.find((c) => c.id === 'pulseOx.bpm');
  const poxSpo2Ctrl = poxControls.find((c) => c.id === 'pulseOx.spo2');
  const poxPerfCtrl = poxControls.find((c) => c.id === 'pulseOx.perfusion');

  assert.ok(poxFingerCtrl && poxBpmCtrl && poxSpo2Ctrl);
  assert.deepEqual(poxFingerCtrl.patch(false), { pulseOx: { fingerPresent: false } });
  assert.deepEqual(poxBpmCtrl.patch(90), { pulseOx: { bpm: 90 } });
  assert.deepEqual(poxBpmCtrl.patch(250), { pulseOx: { bpm: 160 } });
  assert.deepEqual(poxSpo2Ctrl.patch(92), { pulseOx: { spo2: 92 } });
  assert.deepEqual(poxSpo2Ctrl.patch(40), { pulseOx: { spo2: 70 } });
  if (poxPerfCtrl) {
    assert.equal(typeof poxPerfCtrl.format(poxPerfCtrl.get({ pulseOx: { perfusion: 0.7 } })), 'string');
  }
});

test('hardwareRegistry: getStimulusSummaryText produces tidy summaries', () => {
  assert.equal(getStimulusSummaryText({}, {}), '');

  assert.equal(
    getStimulusSummaryText({ loadCellsMode: true }, { loadCellForceGrams: 500 }),
    'Load 500 g'
  );

  // Omits 0 mVpp hum
  assert.equal(
    getStimulusSummaryText(
      { emgMode: true },
      { emg: { flexEffort: 0.5, burstMode: 'continuous', humMvpp: 0 } }
    ),
    'EMG 50% Hold'
  );

  // Includes hum when > 0, and joins multiple modules cleanly
  assert.equal(
    getStimulusSummaryText(
      { loadCellsMode: true, emgMode: true },
      {
        loadCellForceGrams: 500,
        emg: { flexEffort: 0.85, burstMode: 'burst', humMvpp: 15 }
      }
    ),
    'Load 500 g · EMG 85% Burst · 15 mVpp'
  );

  const poxSummaryOn = getStimulusSummaryText(
    { pulseOxMode: true },
    { pulseOx: { fingerPresent: true, bpm: 72, spo2: 98, perfusion: 0.65 } }
  );
  assert.ok(poxSummaryOn.includes('72') && poxSummaryOn.includes('98%'), `got: ${poxSummaryOn}`);

  const poxSummaryCombined = getStimulusSummaryText(
    { loadCellsMode: true, pulseOxMode: true },
    {
      loadCellForceGrams: 500,
      pulseOx: { fingerPresent: true, bpm: 84, spo2: 95, perfusion: 0.6 }
    }
  );
  assert.ok(
    poxSummaryCombined.startsWith('Load 500 g · ') &&
      poxSummaryCombined.includes('84') &&
      poxSummaryCombined.includes('95%'),
    `got: ${poxSummaryCombined}`
  );

  // Safety modules (adum3160) are excluded from stimulus summary text
  assert.equal(getStimulusSummaryText({}, { usbIsolatorEnabled: true }), '');
  assert.equal(
    getStimulusSummaryText(
      { emgMode: true },
      { usbIsolatorEnabled: true, emg: { flexEffort: 0.5, burstMode: 'continuous', humMvpp: 0 } }
    ),
    'EMG 50% Hold'
  );
});
