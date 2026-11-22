import {
  createDefaultSimConfig,
  solveDcCircuit,
  measureResistance
} from '../sim/dcSolver.js';
import { solveTransientCircuit } from '../sim/transientSolver.js';
import { solveBodeSweep, createDefaultBodeConfig } from '../sim/acSolver.js';
import { createDefaultEmgConfig } from '../sim/emgModel.js';
import { computeWaveformMetrics, createDefaultFgenConfig } from '../sim/linearAlgebra.js';
import { buildPresetCircuit } from '../presets.js';
import { createStarterCircuit } from '../persistence.js';
import { createDmmInstrument, formatVoltage } from '../ui/dmmPanel.js';
import { createFgenInstrument } from '../ui/fgenPanel.js';
import {
  createScopeInstrument,
  createDefaultScopeConfig,
  computeAutoscale
} from '../ui/scopePanel.js';
import { createBodeInstrument } from '../ui/bodePanel.js';
import { createWorkspaceManager } from '../ui/workspaceManager.js';
import { renderRuntimeOverlay } from '../ui/runtimeOverlay.js';

const PROBE_MODES = new Set([
  'probe-red',
  'probe-black',
  'probe-fgen',
  'probe-scope-ch0',
  'probe-scope-ch1',
  'probe-bode-in',
  'probe-bode-out'
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBodeState(rawBode = {}) {
  const base = createDefaultBodeConfig(rawBode);
  const running =
    isPlainObject(rawBode) && typeof rawBode.running === 'boolean' ? rawBode.running : true;
  return {
    ...base,
    running
  };
}

/**
 * Normalizes a persisted or preset simConfig object while clamping out-of-range values
 * and preserving unknown future configuration keys.
 *
 * @param {unknown} rawCfg
 * @returns {object}
 */
export function normalizeSimConfig(rawCfg) {
  const base = createDefaultSimConfig();
  if (!isPlainObject(rawCfg)) {
    return base;
  }

  const clampVal = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  return {
    ...rawCfg,
    ...base,
    powered: typeof rawCfg.powered === 'boolean' ? rawCfg.powered : base.powered,
    elvisSupplyPos: clampVal(rawCfg.elvisSupplyPos, 0, 15, base.elvisSupplyPos),
    elvisSupplyNeg: clampVal(rawCfg.elvisSupplyNeg, -15, 0, base.elvisSupplyNeg),
    loadCellForceGrams: clampVal(rawCfg.loadCellForceGrams, 0, 1000, base.loadCellForceGrams),
    arduinoPinStates: isPlainObject(rawCfg.arduinoPinStates) ? { ...rawCfg.arduinoPinStates } : {},
    fgen: createDefaultFgenConfig(rawCfg.fgen),
    emg: createDefaultEmgConfig(rawCfg.emg)
  };
}

/**
 * BenchController encapsulates live simulation state, workspace & virtual bench
 * instruments (DMM, FGEN, Scope, and extensible future panels), preset loading,
 * probe placement, and the fast simulation tick.
 */
export class BenchController {
  /**
   * @param {object} host
   */
  constructor(host = {}) {
    this.host = {
      appShellEl: host.appShellEl || null,
      instrumentDockEl: host.instrumentDockEl || null,
      btnSimPower: host.btnSimPower || null,
      btnDmm: host.btnDmm || null,
      presetSelect: host.presetSelect || null,
      generateId: host.generateId || null,
      getBoardContext: host.getBoardContext || (() => ({})),
      getInteractionMode: host.getInteractionMode || (() => 'build'),
      setInteractionMode: host.setInteractionMode || (() => {}),
      setSidebarCollapsed: host.setSidebarCollapsed || (() => {}),
      onCircuitTopologyReset: host.onCircuitTopologyReset || (() => {}),
      onInspectorNeedsRefresh: host.onInspectorNeedsRefresh || (() => {}),
      onWarningsAndStatusRefresh: host.onWarningsAndStatusRefresh || (() => {}),
      onSave: host.onSave || (() => {})
    };

    // Live DC/Transient Simulation & Virtual Bench Instruments State
    this.simConfig = createDefaultSimConfig();
    this.dmmState = { mode: 'VDC', probeRed: null, probeBlack: null, running: true };
    this.scopeState = createDefaultScopeConfig();
    this.bodeState = normalizeBodeState();
    this.dcResult = null;
    this.transientResult = null;
    this.bodeResult = null;
    this.dmmResistance = null;
    this.dmmAcVoltage = null;
    this.dmmTransientNotice = null;
    this.dmmTransientTimer = null;
    this.hasRunInitialStoppedScopeCapture = false;
    this.hasRunInitialStoppedBodeSweep = false;
    this._pendingForceScopeCapture = false;
    this._pendingForceBodeSweep = false;

    // Preserved persistence bag (retains unknown future keys across load/save cycles)
    this.simStateExtras = {};

    // Workspace & Registered Instrument Panels
    this.workspaceManager = null;
    this.dmmInstrument = null;
    this.fgenInstrument = null;
    this.scopeInstrument = null;
    this.bodeInstrument = null;
    this.registeredInstruments = [];

    this.saveDebounceTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Host Context & Lifecycle Setup
  // ---------------------------------------------------------------------------
  getBoardContext() {
    return this.host.getBoardContext?.() || {};
  }

  /**
   * Registers an additional InstrumentPanel with the WorkspaceManager so future
   * instruments (Bode Analyzer, Arduino IDE, etc.) plug in cleanly without editing app.js.
   *
   * @param {object} panel
   * @returns {HTMLElement|null}
   */
  registerInstrument(panel) {
    if (!panel) return null;
    this.registeredInstruments = this.registeredInstruments.filter((p) => p.id !== panel.id);
    this.registeredInstruments.push(panel);
    if (!this.workspaceManager) return null;
    return this.workspaceManager.registerInstrument(panel);
  }

  setupWorkspaceAndInstruments() {
    const { appShellEl, instrumentDockEl, btnDmm } = this.host;
    if (!appShellEl || !instrumentDockEl) return;

    this.workspaceManager = createWorkspaceManager({
      appShellEl,
      dockEl: instrumentDockEl,
      callbacks: {
        onPowerToggle: (nextPowered) => {
          this.setSimPower(nextPowered);
        },
        onSupplyChange: ({ pos, neg }) => {
          this.simConfig.elvisSupplyPos = pos;
          this.simConfig.elvisSupplyNeg = neg;
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.scheduleSave();
        },
        onLoadChange: (grams) => {
          this.simConfig.loadCellForceGrams = grams;
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.scheduleSave();
        },
        onEmgChange: (patch) => {
          this.simConfig.emg = createDefaultEmgConfig({ ...this.simConfig.emg, ...patch });
          this.runSimulation();
          this.host.onInspectorNeedsRefresh?.({ preserveControls: true });
          this.scheduleSave();
        },
        onStateChange: (wsState) => {
          const dmmVisible = this.workspaceManager.isInstrumentVisible('dmm');
          const fgenVisible = this.workspaceManager.isInstrumentVisible('fgen');
          const scopeVisible = this.workspaceManager.isInstrumentVisible('scope');
          const bodeVisible = this.workspaceManager.isInstrumentVisible('bode');
          const mode = this.host.getInteractionMode();

          const probingDmm = mode === 'probe-red' || mode === 'probe-black';
          const probingFgen = mode === 'probe-fgen';
          const probingScope = mode === 'probe-scope-ch0' || mode === 'probe-scope-ch1';
          const probingBode = mode === 'probe-bode-in' || mode === 'probe-bode-out';

          if (
            (probingDmm && !dmmVisible) ||
            (probingFgen && !fgenVisible) ||
            (probingScope && !scopeVisible) ||
            (probingBode && !bodeVisible)
          ) {
            this.host.setInteractionMode('build');
          }

          if (
            wsState.workspaceMode === 'bench' &&
            wsState.dockOpen &&
            typeof window !== 'undefined' &&
            window.innerWidth <= 1360
          ) {
            this.host.setSidebarCollapsed(true);
          }

          this.updateDmmButtonUI();

          const forceScope =
            scopeVisible &&
            !this.scopeState.running &&
            !this.transientResult &&
            !this.hasRunInitialStoppedScopeCapture;
          if (forceScope) {
            this.hasRunInitialStoppedScopeCapture = true;
          }

          const forceBode =
            bodeVisible &&
            !this.bodeState.running &&
            !this.bodeResult &&
            !this.hasRunInitialStoppedBodeSweep;
          if (forceBode) {
            this.hasRunInitialStoppedBodeSweep = true;
          }

          const prevDmmVac = this.dmmAcVoltage;
          this.runTransientForInstruments({ forceScopeCapture: forceScope });
          this.runBodeForInstrument({ forceBodeSweep: forceBode });
          this.renderRuntimeOverlayAll();
          this.updateAllInstruments({ forceScopeCapture: forceScope, forceBodeSweep: forceBode });
          if (this.dmmAcVoltage !== prevDmmVac) {
            this.updateDmmUI();
          }
          this.saveToHost();
        }
      }
    });

    this.dmmInstrument = createDmmInstrument({
      callbacks: {
        onModeChange: (mode) => {
          this.dmmState.mode = mode;
          this.runSimulation();
          this.saveToHost();
        },
        onStartProbe: (target) => {
          const nextMode = target === 'red' ? 'probe-red' : 'probe-black';
          this.enterProbeMode(nextMode, 'dmm');
        },
        onComToGnd: () => {
          this.snapComProbeToGround();
        },
        onClearProbes: () => {
          this.dmmState.probeRed = null;
          this.dmmState.probeBlack = null;
          this.host.setInteractionMode('build');
          this.runSimulation();
          this.saveToHost();
        },
        onPowerToggle: (nextPowered) => {
          this.setSimPower(nextPowered);
        },
        onRunStateChange: (running) => {
          this.dmmState.running = Boolean(running);
          this.scheduleSave();
        }
      }
    });

    this.fgenInstrument = createFgenInstrument({
      callbacks: {
        onConfigChange: (nextFgen) => {
          this.simConfig.fgen = createDefaultFgenConfig(nextFgen);
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.scheduleSave();
        },
        onRunStateChange: (enabled) => {
          this.simConfig.fgen.enabled = Boolean(enabled);
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.scheduleSave();
        },
        onStartFgenProbe: () => {
          this.enterProbeMode('probe-fgen', 'fgen');
        },
        onClearFgenProbe: () => {
          this.simConfig.fgen.probeHole = null;
          if (this.host.getInteractionMode() === 'probe-fgen') {
            this.host.setInteractionMode('build');
          }
          this.runSimulation();
          this.saveToHost();
        }
      }
    });

    this.scopeInstrument = createScopeInstrument({
      callbacks: {
        onConfigChange: (nextConfig, meta = {}) => {
          this.scopeState = createDefaultScopeConfig(nextConfig);
          if (meta?.affectsCircuit !== false) {
            const prevDmmVac = this.dmmAcVoltage;
            this.runTransientForInstruments();
            this.renderRuntimeOverlayAll();
            this.updateScopeUI();
            if (this.dmmAcVoltage !== prevDmmVac) {
              this.updateDmmUI();
            }
          }
          this.scheduleSave();
        },
        onStartScopeProbe: (chIndex) => {
          const nextMode = chIndex === 1 ? 'probe-scope-ch1' : 'probe-scope-ch0';
          this.enterProbeMode(nextMode, 'scope');
        },
        onAutoscale: () => {
          if (!this.transientResult) {
            this.runTransientForInstruments({ forceScopeCapture: true });
          }
          const trace0 =
            this.scopeState.ch0.enabled && this.transientResult
              ? this.transientResult.getChannelTrace({
                  type: this.scopeState.ch0.source,
                  holeId: this.scopeState.ch0.probeHole
                })
              : null;
          const trace1 =
            this.scopeState.ch1.enabled && this.transientResult
              ? this.transientResult.getChannelTrace({
                  type: this.scopeState.ch1.source,
                  holeId: this.scopeState.ch1.probeHole
                })
              : null;

          const dt = this.transientResult?.dt || (this.scopeState.timePerDiv * 10) / 300;
          const m0 = trace0?.valid && trace0.samples ? computeWaveformMetrics(trace0.samples, dt) : null;
          const m1 = trace1?.valid && trace1.samples ? computeWaveformMetrics(trace1.samples, dt) : null;

          const auto = computeAutoscale({
            ch0Metrics: m0,
            ch1Metrics: m1,
            fgenFreqHz: this.simConfig.fgen?.enabled ? this.simConfig.fgen.frequencyHz : null
          });

          if (this.scopeState.ch0.enabled) this.scopeState.ch0.voltsPerDiv = auto.ch0VoltsPerDiv;
          if (this.scopeState.ch1.enabled) this.scopeState.ch1.voltsPerDiv = auto.ch1VoltsPerDiv;
          this.scopeState.timePerDiv = auto.timePerDiv;
          this.scopeState.trigger.level = auto.triggerLevel;

          const prevDmmVac = this.dmmAcVoltage;
          this.runTransientForInstruments({ forceScopeCapture: true });
          this.updateScopeUI({ forceCapture: true });
          if (this.dmmAcVoltage !== prevDmmVac) {
            this.updateDmmUI();
          }
          this.scheduleSave();
        },
        onStartFgen: () => {
          this.simConfig.fgen.enabled = true;
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.saveToHost();
        },
        onPowerToggle: (nextPowered) => {
          this.setSimPower(nextPowered);
        }
      }
    });

    this.bodeInstrument = createBodeInstrument({
      callbacks: {
        onConfigChange: (nextConfig, meta = {}) => {
          const wasRunning = this.bodeState.running;
          this.bodeState = normalizeBodeState(nextConfig);
          if (wasRunning && !this.bodeState.running && this.bodeResult) {
            this.hasRunInitialStoppedBodeSweep = true;
          }
          if (meta?.affectsCircuit !== false) {
            this.runBodeForInstrument({ forceBodeSweep: this.bodeState.running });
            this.renderRuntimeOverlayAll();
            this.updateBodeUI({ forceCapture: this.bodeState.running });
          }
          this.scheduleSave();
        },
        onStartBodeProbe: (target) => {
          const nextMode = target === 'output' ? 'probe-bode-out' : 'probe-bode-in';
          this.enterProbeMode(nextMode, 'bode');
        },
        onPowerToggle: (nextPowered) => {
          this.setSimPower(nextPowered);
        }
      }
    });

    this.registerInstrument(this.dmmInstrument);
    this.registerInstrument(this.fgenInstrument);
    this.registerInstrument(this.scopeInstrument);
    this.registerInstrument(this.bodeInstrument);

    for (const extraPanel of this.registeredInstruments) {
      if (
        extraPanel !== this.dmmInstrument &&
        extraPanel !== this.fgenInstrument &&
        extraPanel !== this.scopeInstrument &&
        extraPanel !== this.bodeInstrument
      ) {
        this.workspaceManager.registerInstrument(extraPanel);
      }
    }

    if (btnDmm) {
      btnDmm.addEventListener('click', () => {
        this.workspaceManager?.toggleDock('dmm');
      });
    }
    this.updateDmmButtonUI();
  }

  normalizeSimConfig(rawCfg) {
    return normalizeSimConfig(rawCfg);
  }

  // ---------------------------------------------------------------------------
  // Probe Management & Wiring Helpers
  // ---------------------------------------------------------------------------
  pruneInvalidProbes() {
    const { breadboard } = this.getBoardContext();
    if (!breadboard) return;

    if (this.dmmState.probeRed && !breadboard.getHole(this.dmmState.probeRed)) {
      this.dmmState.probeRed = null;
    }
    if (this.dmmState.probeBlack && !breadboard.getHole(this.dmmState.probeBlack)) {
      this.dmmState.probeBlack = null;
    }
    if (this.simConfig.fgen?.probeHole && !breadboard.getHole(this.simConfig.fgen.probeHole)) {
      this.simConfig.fgen.probeHole = null;
    }
    if (this.scopeState.ch0?.probeHole && !breadboard.getHole(this.scopeState.ch0.probeHole)) {
      this.scopeState.ch0.probeHole = null;
    }
    if (this.scopeState.ch1?.probeHole && !breadboard.getHole(this.scopeState.ch1.probeHole)) {
      this.scopeState.ch1.probeHole = null;
    }
    if (this.bodeState.inputProbeHole && !breadboard.getHole(this.bodeState.inputProbeHole)) {
      this.bodeState.inputProbeHole = null;
    }
    if (this.bodeState.outputProbeHole && !breadboard.getHole(this.bodeState.outputProbeHole)) {
      this.bodeState.outputProbeHole = null;
    }
  }

  resetTransientAndBode() {
    this.transientResult = null;
    this.bodeResult = null;
    this.dmmAcVoltage = null;
    this.hasRunInitialStoppedScopeCapture = false;
    this.hasRunInitialStoppedBodeSweep = false;
    this.scopeInstrument?.resetFrozen();
    this.bodeInstrument?.resetFrozen();
  }

  clearAllProbes() {
    this.dmmState.probeRed = null;
    this.dmmState.probeBlack = null;
    this.simConfig.fgen.probeHole = null;
    this.scopeState.ch0.probeHole = null;
    this.scopeState.ch1.probeHole = null;
    this.bodeState.inputProbeHole = null;
    this.bodeState.outputProbeHole = null;
    this.resetTransientAndBode();
  }

  enterProbeMode(probeInteractionMode, instrumentTabId) {
    const wasComputer = this.workspaceManager?.getState().workspaceMode === 'computer';
    if (wasComputer) {
      this.workspaceManager.temporarilyReturnForProbe(instrumentTabId);
      this.host.setInteractionMode(probeInteractionMode);
    } else {
      const curMode = this.host.getInteractionMode();
      this.host.setInteractionMode(
        curMode === probeInteractionMode ? 'build' : probeInteractionMode
      );
    }
    this.updateAllInstruments();
  }

  /**
   * Assigns a clicked breadboard hole to the active probe mode and runs a fast simulation tick.
   * Returns true if the mode was a probe mode and was handled.
   *
   * @param {string} mode
   * @param {{ id: string }} hole
   * @returns {boolean}
   */
  handleProbeHolePicked(mode, hole) {
    if (!PROBE_MODES.has(mode) || !hole) return false;

    if (mode === 'probe-red') {
      this.dmmState.probeRed = hole.id;
    } else if (mode === 'probe-black') {
      this.dmmState.probeBlack = hole.id;
    } else if (mode === 'probe-fgen') {
      this.simConfig.fgen.probeHole = hole.id;
    } else if (mode === 'probe-scope-ch0') {
      this.scopeState.ch0.probeHole = hole.id;
    } else if (mode === 'probe-scope-ch1') {
      this.scopeState.ch1.probeHole = hole.id;
    } else if (mode === 'probe-bode-in') {
      this.bodeState.inputProbeHole = hole.id;
    } else if (mode === 'probe-bode-out') {
      this.bodeState.outputProbeHole = hole.id;
    }

    this.host.setInteractionMode('build');
    this.runSimulation();
    this.saveToHost();
    return true;
  }

  snapComProbeToGround() {
    const { breadboard, connectivity, placedParts } = this.getBoardContext();
    let gndHoleId = null;

    if (breadboard?.elvisMode && breadboard.getHole('ELV_53D')) {
      gndHoleId = 'ELV_53D';
    } else {
      const nano = (placedParts || []).find((p) => p.partId === 'arduino-nano');
      if (nano && connectivity) {
        const gndHole =
          connectivity.getPinHole(nano.id, 'GND_BOT') ||
          connectivity.getPinHole(nano.id, 'GND_TOP');
        if (gndHole) {
          gndHoleId = gndHole.id;
        }
      }
    }

    if (!gndHoleId && connectivity) {
      for (const net of connectivity.nets.values()) {
        if (net.hasGround && net.holes.size > 0) {
          gndHoleId = net.holes.values().next().value;
          break;
        }
      }
    }

    if (!gndHoleId) {
      const msg = 'No GND source found — place an Arduino Nano or enable NI ELVIS II';
      this.host.onWarningsAndStatusRefresh({ statusOverride: msg });
      this.showDmmTransientNotice(msg);
      return;
    }

    this.dmmTransientNotice = null;
    this.dmmState.probeBlack = gndHoleId;
    if (this.host.getInteractionMode() === 'probe-black') {
      this.host.setInteractionMode('build');
    }
    this.runSimulation();
    this.saveToHost();
  }

  showDmmTransientNotice(message, durationMs = 3500) {
    if (this.dmmTransientTimer) {
      clearTimeout(this.dmmTransientTimer);
      this.dmmTransientTimer = null;
    }
    this.dmmTransientNotice = message || null;
    this.updateDmmUI();
    if (message && durationMs > 0) {
      this.dmmTransientTimer = setTimeout(() => {
        this.dmmTransientTimer = null;
        this.dmmTransientNotice = null;
        this.updateDmmUI();
      }, durationMs);
    }
  }

  isElvisFgenWired() {
    const { breadboard, connectivity } = this.getBoardContext();
    if (!breadboard?.elvisMode || !connectivity) return false;
    const holes = breadboard.strips.get('ELVIS_ROW_33') || [];
    return holes.some((h) => (connectivity.getOccupants(h.id) || []).length > 0);
  }

  hasFgenNotRunningHint() {
    if (!this.simConfig.powered || this.simConfig.fgen?.enabled) return false;
    const ch0 = this.scopeState.ch0;
    const ch1 = this.scopeState.ch1;
    const usesFgenSource =
      (ch0.enabled && ch0.source === 'FGEN') || (ch1.enabled && ch1.source === 'FGEN');
    if (usesFgenSource) return true;

    const { breadboard, connectivity } = this.getBoardContext();
    if (!connectivity || !breadboard) return false;

    const fgenNets = new Set();
    if (breadboard.elvisMode && this.isElvisFgenWired()) {
      const fgenNet = connectivity.getNetForHole('ELV_33A');
      if (fgenNet) fgenNets.add(fgenNet.id);
    }
    if (this.simConfig.fgen?.probeHole) {
      const probeNet = connectivity.getNetForHole(this.simConfig.fgen.probeHole);
      if (probeNet) fgenNets.add(probeNet.id);
    }
    if (fgenNets.size === 0) return false;

    const checkChannelWiredToFgen = (chCfg) => {
      if (!chCfg.enabled) return false;
      if (breadboard.elvisMode && chCfg.source === 'AI0') {
        const ai0Net = connectivity.getNetForHole('ELV_1A');
        return Boolean(ai0Net && fgenNets.has(ai0Net.id));
      }
      if (breadboard.elvisMode && chCfg.source === 'AI1') {
        const ai1Net = connectivity.getNetForHole('ELV_3A');
        return Boolean(ai1Net && fgenNets.has(ai1Net.id));
      }
      if (chCfg.source === 'PROBE' && chCfg.probeHole) {
        const pNet = connectivity.getNetForHole(chCfg.probeHole);
        return Boolean(pNet && fgenNets.has(pNet.id));
      }
      return false;
    };

    return checkChannelWiredToFgen(ch0) || checkChannelWiredToFgen(ch1);
  }

  // ---------------------------------------------------------------------------
  // Simulation Execution (Fast Tick)
  // ---------------------------------------------------------------------------
  runTransientForInstruments({ forceScopeCapture = false } = {}) {
    const { breadboard, connectivity, placedParts, wires, catalogMap } = this.getBoardContext();
    if (!breadboard || !connectivity) {
      this.dmmAcVoltage = null;
      return;
    }

    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    const dmmVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('dmm') : false;
    const needScope = forceScopeCapture || (scopeVisible && this.scopeState.running);
    const needDmmVac =
      Boolean(this.simConfig.powered) &&
      dmmVisible &&
      this.dmmState.mode === 'VAC' &&
      Boolean(this.dmmState.probeRed) &&
      Boolean(this.dmmState.probeBlack);

    if (!needScope && !needDmmVac) {
      this.dmmAcVoltage = null;
      return;
    }

    const fgenFreq = Math.max(0.5, Number(this.simConfig.fgen?.frequencyHz) || 100);
    const scopeDurationSec = this.scopeState.timePerDiv * 10 * 2;
    const scopeSamples = 600;

    if (needScope) {
      this.transientResult = solveTransientCircuit({
        breadboard,
        connectivity,
        placedParts,
        wires,
        catalogMap,
        simConfig: this.simConfig,
        totalDurationSec: scopeDurationSec,
        numSamples: scopeSamples
      });
    }

    if (needDmmVac) {
      const emgVacCapture = !this.simConfig.fgen?.enabled && Boolean(breadboard.emgMode);
      const cyclesInScope = scopeDurationSec * fgenFreq;
      const samplesPerCycleInScope = (scopeSamples - 1) / Math.max(1e-9, cyclesInScope);
      const canReuseScopeCapture =
        !emgVacCapture &&
        needScope &&
        this.transientResult &&
        cyclesInScope >= 3 &&
        samplesPerCycleInScope >= 32;

      const vacResult = canReuseScopeCapture
        ? this.transientResult
        : solveTransientCircuit({
            breadboard,
            connectivity,
            placedParts,
            wires,
            catalogMap,
            simConfig: this.simConfig,
            totalDurationSec: emgVacCapture ? 0.36 : Math.min(4.0, 4 / fgenFreq),
            numSamples: emgVacCapture ? 360 : 320
          });

      if (vacResult) {
        const diffTrace = vacResult.getDiffTrace(
          this.dmmState.probeRed,
          this.dmmState.probeBlack
        );
        if (diffTrace.valid && diffTrace.samples) {
          const metrics = computeWaveformMetrics(diffTrace.samples, vacResult.dt);
          this.dmmAcVoltage = {
            valid: true,
            voltsRms: metrics.vRmsAc,
            floatingReason: null
          };
        } else {
          this.dmmAcVoltage = {
            valid: false,
            voltsRms: null,
            floatingReason: diffTrace.reason || 'Probe is on a floating net'
          };
        }
      } else {
        this.dmmAcVoltage = null;
      }
    } else {
      this.dmmAcVoltage = null;
    }
  }

  runBodeForInstrument({ forceBodeSweep = false } = {}) {
    const { breadboard, connectivity, placedParts, wires, catalogMap } = this.getBoardContext();
    if (!breadboard || !connectivity) return;

    const bodeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('bode') : false;
    if (!bodeVisible) return;

    const shouldSweep =
      this.bodeState.running || Boolean(forceBodeSweep) || !this.hasRunInitialStoppedBodeSweep;
    if (!shouldSweep) return;

    this.hasRunInitialStoppedBodeSweep = true;

    this.bodeResult = solveBodeSweep({
      breadboard,
      connectivity,
      placedParts,
      wires,
      catalogMap,
      simConfig: this.simConfig,
      bodeConfig: this.bodeState
    });
  }

  /**
   * Fast Simulation Tick: solves DC + conditional Transient/Bode/DMM-VAC/Ohmmeter,
   * updates #layer-runtime-overlay, updates all visible instruments, and refreshes
   * warnings & status bar WITHOUT tearing down static breadboard parts/wires DOM.
   *
   * @param {object} [options]
   * @param {boolean} [options.forceScopeCapture=false]
   * @param {boolean} [options.forceBodeSweep=false]
   */
  runSimulation({ forceScopeCapture = false, forceBodeSweep = false } = {}) {
    this.pruneInvalidProbes();
    const shouldForceScope = Boolean(forceScopeCapture || this._pendingForceScopeCapture);
    this._pendingForceScopeCapture = false;
    if (shouldForceScope) {
      this.hasRunInitialStoppedScopeCapture = true;
    }

    const shouldForceBode = Boolean(forceBodeSweep || this._pendingForceBodeSweep);
    this._pendingForceBodeSweep = false;
    if (shouldForceBode) {
      this.hasRunInitialStoppedBodeSweep = true;
    }

    const { breadboard, connectivity, placedParts, wires, catalogMap } = this.getBoardContext();
    if (!breadboard || !connectivity) return;

    this.dcResult = solveDcCircuit({
      breadboard,
      connectivity,
      placedParts,
      wires,
      catalogMap,
      simConfig: this.simConfig
    });

    if (
      (this.dmmState.mode === 'OHM' || this.dmmState.mode === 'CONT') &&
      !this.simConfig.powered &&
      this.dmmState.probeRed &&
      this.dmmState.probeBlack
    ) {
      this.dmmResistance = measureResistance({
        breadboard,
        connectivity,
        placedParts,
        wires,
        catalogMap,
        holeA: this.dmmState.probeRed,
        holeB: this.dmmState.probeBlack,
        simConfig: this.simConfig
      });
    } else {
      this.dmmResistance = null;
    }

    this.runTransientForInstruments({ forceScopeCapture: shouldForceScope });
    this.runBodeForInstrument({ forceBodeSweep: shouldForceBode });
    this.renderRuntimeOverlayAll();
    this.updateAllInstruments({ forceScopeCapture: shouldForceScope, forceBodeSweep: shouldForceBode });
    this.host.onWarningsAndStatusRefresh();
    this.updatePowerButtonUI();
  }

  // ---------------------------------------------------------------------------
  // Runtime Overlay & Instrument Panel Updates
  // ---------------------------------------------------------------------------
  renderRuntimeOverlayAll() {
    const { breadboard, placedParts, catalogMap, runtimeOverlayLayer } = this.getBoardContext();
    if (!runtimeOverlayLayer || !breadboard) return;

    const dmmVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('dmm') : false;
    const fgenVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('fgen') : false;
    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    const bodeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('bode') : false;

    renderRuntimeOverlay({
      layerEl: runtimeOverlayLayer,
      breadboard,
      placedParts,
      catalogMap,
      dcResult: this.dcResult,
      dmmState: this.dmmState,
      showProbes: dmmVisible,
      fgenProbeHole: this.simConfig.fgen?.probeHole || null,
      showFgenProbe: fgenVisible || Boolean(this.simConfig.fgen?.enabled && this.simConfig.fgen?.probeHole),
      scopeProbes: this.scopeState,
      showScopeProbes: scopeVisible,
      bodeProbes: {
        inputHole: this.bodeState.inputSource === 'PROBE' ? this.bodeState.inputProbeHole : null,
        outputHole: this.bodeState.outputSource === 'PROBE' ? this.bodeState.outputProbeHole : null
      },
      showBodeProbes: bodeVisible
    });
  }

  updateAllInstruments({ forceScopeCapture = false, forceBodeSweep = false } = {}) {
    this.updateDmmUI();
    this.updateFgenUI();
    this.updateScopeUI({ forceCapture: forceScopeCapture });
    this.updateBodeUI({ forceCapture: forceBodeSweep });
  }

  updateDmmButtonUI() {
    const { btnDmm } = this.host;
    if (!btnDmm) return;
    const isVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('dmm') : false;
    btnDmm.classList.toggle('active', isVisible);
    btnDmm.setAttribute('aria-pressed', String(isVisible));
  }

  updateDmmUI() {
    const { breadboard, connectivity } = this.getBoardContext();
    this.workspaceManager?.updateBenchControls({
      powered: Boolean(this.simConfig.powered),
      elvisMode: Boolean(breadboard?.elvisMode),
      loadCellsMode: Boolean(breadboard?.loadCellsMode),
      emgMode: Boolean(breadboard?.emgMode),
      simConfig: this.simConfig
    });
    this.updateDmmButtonUI();

    if (!this.dmmInstrument) return;

    const voltageResult =
      this.dmmState.mode === 'VDC' &&
      this.dmmState.probeRed &&
      this.dmmState.probeBlack &&
      this.dcResult
        ? this.dcResult.getVoltageDiff(this.dmmState.probeRed, this.dmmState.probeBlack)
        : null;

    const mode = this.host.getInteractionMode();
    const activeProbeTarget =
      mode === 'probe-red'
        ? 'red'
        : mode === 'probe-black'
        ? 'black'
        : null;

    const hasShortCircuit = Boolean(
      connectivity?.warnings?.some((w) => /short circuit/i.test(w.message))
    );

    this.dmmInstrument.update({
      mode: this.dmmState.mode,
      powered: Boolean(this.simConfig.powered),
      probeRed: this.dmmState.probeRed,
      probeBlack: this.dmmState.probeBlack,
      activeProbeTarget,
      voltageResult,
      acVoltageResult: this.dmmAcVoltage,
      resistanceResult: this.dmmResistance,
      hasShortCircuit,
      transientNotice: this.dmmTransientNotice
    });
  }

  updateFgenUI() {
    if (!this.fgenInstrument) return;
    const { breadboard } = this.getBoardContext();
    this.fgenInstrument.update({
      fgen: this.simConfig.fgen,
      powered: Boolean(this.simConfig.powered),
      elvisMode: Boolean(breadboard?.elvisMode),
      elvisFgenWired: this.isElvisFgenWired(),
      isProbingFgen: this.host.getInteractionMode() === 'probe-fgen'
    });
  }

  updateScopeUI({ forceCapture = false } = {}) {
    if (!this.scopeInstrument) return;

    const mode = this.host.getInteractionMode();
    const activeProbeTarget =
      mode === 'probe-scope-ch0'
        ? 'scope-ch0'
        : mode === 'probe-scope-ch1'
        ? 'scope-ch1'
        : null;

    const getChTrace = (chCfg) => {
      if (!chCfg.enabled) return null;
      if (!this.simConfig.powered) {
        return { valid: false, samples: null, reason: 'Power OFF' };
      }
      if (!this.transientResult) {
        return { valid: false, samples: null, reason: 'No signal available' };
      }
      return this.transientResult.getChannelTrace({
        type: chCfg.source,
        holeId: chCfg.probeHole
      });
    };

    this.scopeInstrument.update({
      config: this.scopeState,
      powered: Boolean(this.simConfig.powered),
      dt: this.transientResult?.dt || (this.scopeState.timePerDiv * 10) / 300,
      totalDurationSec: this.transientResult?.totalDurationSec || this.scopeState.timePerDiv * 10,
      fgenEnabled: Boolean(this.simConfig.fgen?.enabled),
      fgenFreqHz: this.simConfig.fgen?.enabled ? this.simConfig.fgen.frequencyHz : null,
      fgenNotRunningHint: this.hasFgenNotRunningHint(),
      forceCapture: Boolean(forceCapture),
      activeProbeTarget,
      ch0: getChTrace(this.scopeState.ch0),
      ch1: getChTrace(this.scopeState.ch1)
    });
  }

  updateBodeUI({ forceCapture = false } = {}) {
    if (!this.bodeInstrument) return;

    const mode = this.host.getInteractionMode();
    const activeProbeTarget =
      mode === 'probe-bode-in'
        ? 'bode-in'
        : mode === 'probe-bode-out'
        ? 'bode-out'
        : null;

    this.bodeInstrument.update({
      config: this.bodeState,
      running: this.bodeState.running,
      powered: Boolean(this.simConfig.powered),
      forceCapture: Boolean(forceCapture),
      activeProbeTarget,
      bodeResult: this.bodeResult
    });
  }

  updatePowerButtonUI() {
    const { btnSimPower } = this.host;
    if (!btnSimPower) return;
    const powered = Boolean(this.simConfig.powered);
    btnSimPower.classList.toggle('active', powered);
    btnSimPower.setAttribute('aria-pressed', String(powered));
    const span = btnSimPower.querySelector('span');
    const label = powered ? '⚡ Power: ON' : '⚡ Power: OFF';
    if (span) span.textContent = label;
    else btnSimPower.textContent = label;
  }

  // ---------------------------------------------------------------------------
  // Power & Status Helpers
  // ---------------------------------------------------------------------------
  setSimPower(nextPowered) {
    const powered = Boolean(nextPowered);
    const shouldForceBode =
      powered && Boolean(this.bodeResult && !this.bodeResult.powered);
    this.simConfig.powered = powered;
    this.runSimulation({ forceBodeSweep: shouldForceBode });
    this.host.onInspectorNeedsRefresh({ preserveControls: false });
    this.saveToHost();
  }

  toggleSimPower() {
    this.setSimPower(!this.simConfig.powered);
  }

  getHoveredVoltageSuffix(holeId) {
    if (!this.simConfig.powered || !this.dcResult || !holeId) return '';
    const v = this.dcResult.getHoleVoltage(holeId);
    return Number.isFinite(v) ? ` · ${formatVoltage(v)}` : ' · Floating';
  }

  // ---------------------------------------------------------------------------
  // Presets & Starter Circuit
  // ---------------------------------------------------------------------------
  setActivePresetLabel(presetId = '') {
    if (this.host.presetSelect) {
      this.host.presetSelect.value = presetId || '';
    }
  }

  _makeIdGenerator() {
    if (typeof this.host.generateId === 'function') {
      return (prefix) => this.host.generateId(prefix);
    }
    let seq = 1;
    return (prefix = 'item') => `${prefix}_${seq++}_${Math.random().toString(36).slice(2, 6)}`;
  }

  loadPreset(presetId) {
    const preset = buildPresetCircuit(presetId, {
      generateId: this._makeIdGenerator()
    });
    return this._applyPresetObject(presetId, preset);
  }

  _applyPresetObject(presetId, preset) {
    this.simConfig = this.normalizeSimConfig(preset.simConfig);
    this.dmmState = {
      mode: preset.defaultDmm?.mode || 'VDC',
      probeRed: preset.defaultDmm?.probeRed || null,
      probeBlack: preset.defaultDmm?.probeBlack || null,
      running: true
    };
    this.dmmInstrument?.setRunning(true, { notify: false, resetFrozen: true });
    this.scopeState = createDefaultScopeConfig(preset.defaultScope || {});
    this.bodeState = normalizeBodeState(preset.defaultBode || {});
    this.resetTransientAndBode();

    if (this.workspaceManager) {
      if (preset.defaultScope?.open) {
        this.workspaceManager.openDock('scope', { notify: false });
        if (typeof window !== 'undefined' && window.innerWidth <= 1360) {
          this.host.setSidebarCollapsed(true);
        }
      } else if (preset.defaultBode?.open) {
        this.workspaceManager.openDock('bode', { notify: false });
        if (typeof window !== 'undefined' && window.innerWidth <= 1360) {
          this.host.setSidebarCollapsed(true);
        }
      } else if (preset.defaultDmm?.open) {
        this.workspaceManager.openDock('dmm', { notify: false });
        if (typeof window !== 'undefined' && window.innerWidth <= 1360) {
          this.host.setSidebarCollapsed(true);
        }
      } else {
        const ws = this.workspaceManager.getState();
        if (ws.workspaceMode === 'bench' && ws.dockOpen) {
          this.workspaceManager.closeDock({ notify: false });
        }
      }
    }
    this.updateDmmButtonUI();

    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    this._pendingForceScopeCapture = scopeVisible && !this.scopeState.running;

    const bodeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('bode') : false;
    this._pendingForceBodeSweep = bodeVisible && !this.bodeState.running;

    this.setActivePresetLabel(presetId);
    this.host.onCircuitTopologyReset({
      boardConfig: preset.boardConfig,
      placedParts: preset.placedParts,
      wires: preset.wires,
      presetId
    });
  }

  loadStarterCircuit(presetId = 'starter') {
    const { breadboard } = this.getBoardContext();
    const starterCircuit = createStarterCircuit(
      Boolean(breadboard?.elvisMode),
      this._makeIdGenerator()
    );
    this.simConfig = createDefaultSimConfig();
    this.dmmState = { mode: 'VDC', probeRed: null, probeBlack: null, running: true };
    this.dmmInstrument?.setRunning(true, { notify: false, resetFrozen: true });
    this.scopeState = createDefaultScopeConfig();
    this.bodeState = normalizeBodeState();
    this.resetTransientAndBode();
    this.workspaceManager?.closeDock({ notify: false });
    this.updateDmmButtonUI();
    this.setActivePresetLabel(presetId);
    this.host.onCircuitTopologyReset({
      placedParts: starterCircuit.placedParts,
      wires: starterCircuit.wires,
      presetId
    });
  }

  // ---------------------------------------------------------------------------
  // Persistence Bridge & Keyboard Shortcuts
  // ---------------------------------------------------------------------------
  getSimStateSnapshot() {
    this.simStateExtras = {
      ...this.simStateExtras,
      simConfig: {
        ...this.simConfig,
        arduinoPinStates: { ...(this.simConfig.arduinoPinStates || {}) },
        fgen: createDefaultFgenConfig(this.simConfig.fgen),
        emg: createDefaultEmgConfig(this.simConfig.emg)
      },
      dmmState: {
        mode: this.dmmState.mode,
        probeRed: this.dmmState.probeRed,
        probeBlack: this.dmmState.probeBlack,
        running: this.dmmState.running !== false,
        open: this.workspaceManager ? this.workspaceManager.isInstrumentVisible('dmm') : false
      },
      scopeState: createDefaultScopeConfig(this.scopeState),
      bodeState: normalizeBodeState(this.bodeState),
      workspaceState: this.workspaceManager ? this.workspaceManager.getState() : undefined
    };
    return this.simStateExtras;
  }

  applySimState(simState) {
    this.simStateExtras = isPlainObject(simState) ? { ...simState } : {};
    this.simConfig = this.normalizeSimConfig(this.simStateExtras.simConfig);

    const savedDmm = this.simStateExtras.dmmState;
    if (isPlainObject(savedDmm)) {
      this.dmmState = {
        mode: ['VDC', 'VAC', 'OHM', 'CONT'].includes(savedDmm.mode) ? savedDmm.mode : 'VDC',
        probeRed: typeof savedDmm.probeRed === 'string' ? savedDmm.probeRed : null,
        probeBlack: typeof savedDmm.probeBlack === 'string' ? savedDmm.probeBlack : null,
        running: typeof savedDmm.running === 'boolean' ? savedDmm.running : true
      };
    } else {
      this.dmmState = { mode: 'VDC', probeRed: null, probeBlack: null, running: true };
    }
    this.dmmInstrument?.setRunning(this.dmmState.running, { notify: false, resetFrozen: true });

    this.scopeState = createDefaultScopeConfig(this.simStateExtras.scopeState || {});
    this.bodeState = normalizeBodeState(this.simStateExtras.bodeState || {});
    this.resetTransientAndBode();

    if (this.workspaceManager) {
      this.workspaceManager.applyState(this.simStateExtras, { notify: false });
      const ws = this.workspaceManager.getState();
      if (
        ws.workspaceMode === 'bench' &&
        ws.dockOpen &&
        typeof window !== 'undefined' &&
        window.innerWidth <= 1360
      ) {
        this.host.setSidebarCollapsed(true);
      }
    }
    this.updateDmmButtonUI();

    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    this._pendingForceScopeCapture = scopeVisible && !this.scopeState.running;

    const bodeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('bode') : false;
    this._pendingForceBodeSweep = bodeVisible && !this.bodeState.running;

    this.setActivePresetLabel('');
    this.updatePowerButtonUI();
  }

  scheduleSave() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.saveToHost();
    }, 200);
  }

  saveToHost() {
    this.host.onSave();
  }

  /**
   * Handles virtual bench keyboard shortcuts (`P` Power, `M` DMM, `G` FGEN, `O` Scope, `B` Bode, `F` Full Bench).
   * Returns true if the key was handled.
   *
   * @param {string} key
   * @returns {boolean}
   */
  handleKeydownShortcut(key) {
    if (typeof key !== 'string') return false;
    const k = key.toLowerCase();
    if (k === 'p') {
      this.toggleSimPower();
      return true;
    }
    if (k === 'm') {
      this.workspaceManager?.toggleDock('dmm');
      return true;
    }
    if (k === 'g') {
      this.workspaceManager?.toggleDock('fgen');
      return true;
    }
    if (k === 'o') {
      this.workspaceManager?.toggleDock('scope');
      return true;
    }
    if (k === 'b') {
      this.workspaceManager?.toggleDock('bode');
      return true;
    }
    if (k === 'f') {
      if (this.workspaceManager) {
        const inComputerMode = this.workspaceManager.getState().workspaceMode === 'computer';
        this.workspaceManager.setWorkspaceMode(inComputerMode ? 'bench' : 'computer');
      }
      return true;
    }
    return false;
  }
}

/**
 * Factory helper to create a BenchController instance.
 *
 * @param {object} host
 * @returns {BenchController}
 */
export function createBenchController(host) {
  return new BenchController(host);
}
