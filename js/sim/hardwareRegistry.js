/**
 * Pure, zero-DOM declarative registry for external lab hardware and sensor modules
 * mounted on the bench (e.g. Load Cells, 3-Pad Surface EMG).
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

/**
 * Clamp a numeric value to [min, max], returning fallback when non-finite.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampOrDefault(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const HARDWARE_MODULES = Object.freeze([
  Object.freeze({
    id: 'load-cells',
    label: 'Load Cells',
    shortLabel: 'Load',
    icon: '⚖',
    category: 'sensor',
    boardFlag: 'loadCellsMode',
    hasTerminalBlock: true,
    description: 'Rectangular Full-Bridge (500 g) & Pair of E-Shaped Half-Bridge strain gauges.',
    controls: Object.freeze([
      Object.freeze({
        id: 'loadCellForceGrams',
        type: 'range',
        label: 'Load Cell Force',
        min: 0,
        max: 1000,
        step: 10,
        get: (simConfig) =>
          Number.isFinite(simConfig?.loadCellForceGrams)
            ? Math.min(1000, Math.max(0, simConfig.loadCellForceGrams))
            : 0,
        patch: (val) => ({
          loadCellForceGrams: Math.min(1000, Math.max(0, Number(val) || 0))
        }),
        format: (val) => `${Math.round(Number(val) || 0)} g`
      })
    ])
  }),
  Object.freeze({
    id: 'emg',
    label: '3-Pad Surface EMG',
    shortLabel: 'EMG',
    icon: '💓',
    category: 'sensor',
    boardFlag: 'emgMode',
    hasTerminalBlock: true,
    description:
      'Dynamic differential surface EMG electrodes (Red 1/2 + Black Ref) with burst/hold & 60 Hz hum.',
    controls: Object.freeze([
      Object.freeze({
        id: 'emg.flexEffort',
        type: 'range',
        label: 'EMG Flex',
        min: 0,
        max: 100,
        step: 5,
        get: (simConfig) => {
          const clampedFlex = clampOrDefault(simConfig?.emg?.flexEffort, 0, 1, 0.5);
          return Math.round(clampedFlex * 100);
        },
        patch: (val) => ({
          emg: {
            flexEffort: Math.min(1, Math.max(0, (Number(val) || 0) / 100))
          }
        }),
        format: (val) => `${Math.round(Number(val) || 0)}%`
      }),
      Object.freeze({
        id: 'emg.burstMode',
        type: 'toggle',
        label: 'Mode',
        onLabel: 'Burst',
        offLabel: 'Hold',
        get: (simConfig) => simConfig?.emg?.burstMode !== 'continuous',
        patch: (val) => ({
          emg: {
            burstMode: val ? 'burst' : 'continuous'
          }
        }),
        format: (val) => (val ? 'Burst' : 'Hold')
      }),
      Object.freeze({
        id: 'emg.humMvpp',
        type: 'range',
        label: '60 Hz Hum',
        min: 0,
        max: 50,
        step: 1,
        get: (simConfig) => {
          const clampedHum = clampOrDefault(simConfig?.emg?.humMvpp, 0, 50, 0);
          return Math.round(clampedHum);
        },
        patch: (val) => ({
          emg: {
            humMvpp: Math.round(Math.min(50, Math.max(0, Number(val) || 0)))
          }
        }),
        format: (val) => `${Math.round(Number(val) || 0)} mVpp`
      })
    ])
  })
]);

/**
 * Look up a registered hardware module by id.
 * @param {string} id
 * @returns {object|null}
 */
export function getHardwareModule(id) {
  return HARDWARE_MODULES.find((mod) => mod.id === id) || null;
}

/**
 * Return all hardware modules currently enabled in boardState.
 * @param {object} [boardState]
 * @returns {Array<object>}
 */
export function getActiveHardwareModules(boardState = {}) {
  return HARDWARE_MODULES.filter((mod) => Boolean(boardState?.[mod.boardFlag]));
}

/**
 * Count how many hardware modules are currently enabled in boardState.
 * @param {object} [boardState]
 * @returns {number}
 */
export function getActiveHardwareCount(boardState = {}) {
  return getActiveHardwareModules(boardState).length;
}

/**
 * Build a concise 1-line summary of active external hardware stimuli,
 * e.g. "Load 500 g · EMG 85% Burst · 15 mVpp" (omits 0 mVpp hum; "" if none active).
 * @param {object} [boardState]
 * @param {object} [simConfig]
 * @returns {string}
 */
export function getStimulusSummaryText(boardState = {}, simConfig = {}) {
  const active = getActiveHardwareModules(boardState);
  if (active.length === 0) return '';

  const parts = [];
  for (const mod of active) {
    if (mod.id === 'load-cells') {
      const forceCtrl = mod.controls[0];
      const forceVal = forceCtrl.get(simConfig);
      parts.push(`${mod.shortLabel} ${forceCtrl.format(forceVal)}`);
      continue;
    }

    if (mod.id === 'emg') {
      const flexCtrl = mod.controls.find((c) => c.id === 'emg.flexEffort');
      const modeCtrl = mod.controls.find((c) => c.id === 'emg.burstMode');
      const humCtrl = mod.controls.find((c) => c.id === 'emg.humMvpp');

      const flexText = flexCtrl.format(flexCtrl.get(simConfig));
      const modeText = modeCtrl.format(modeCtrl.get(simConfig));
      parts.push(`${mod.shortLabel} ${flexText} ${modeText}`);

      const humVal = humCtrl.get(simConfig);
      if (humVal > 0) {
        parts.push(humCtrl.format(humVal));
      }
      continue;
    }

    // Generic fallback for any future hardware modules
    const summaryControls = mod.controls
      .map((ctrl) => ctrl.format(ctrl.get(simConfig)))
      .join(' ');
    parts.push(summaryControls ? `${mod.shortLabel} ${summaryControls}` : mod.shortLabel);
  }

  return parts.join(' · ');
}
