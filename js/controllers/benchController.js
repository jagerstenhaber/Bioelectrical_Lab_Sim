import {
  createDefaultSimConfig,
  solveDcCircuit,
  measureResistance
} from '../sim/dcSolver.js';
import { solveTransientCircuit, createLiveCircuitStepper } from '../sim/transientSolver.js';
import { analyzeCircuitIsolation } from '../sim/isolationAnalyzer.js';
import { solveBodeSweep, createDefaultBodeConfig } from '../sim/acSolver.js';
import { createDefaultEmgConfig } from '../sim/emgModel.js';
import { createDefaultPulseOxConfig } from '../sim/ppgModel.js';
import { createDefaultArbConfig } from '../sim/arbModel.js';
import { hasTimeVaryingStimulus, getSlowestStimulusFreqHz } from '../sim/circuitElements.js';
import { computeWaveformMetrics, createDefaultFgenConfig } from '../sim/linearAlgebra.js';
import { LAB_PRESETS, buildPresetCircuit } from '../presets.js';
import { createStarterCircuit } from '../persistence.js';
import { createDmmInstrument, formatVoltage } from '../ui/dmmPanel.js';
import { createVpsInstrument } from '../ui/vpsPanel.js';
import { createFgenInstrument } from '../ui/fgenPanel.js';
import { createArbInstrument } from '../ui/arbPanel.js';
import {
  createScopeInstrument,
  createDefaultScopeConfig,
  computeAutoscale
} from '../ui/scopePanel.js';
import { createBodeInstrument } from '../ui/bodePanel.js';
import { createArduinoInstrument } from '../ui/arduinoPanel.js';
import {
  createArduinoRunner,
  ARDUINO_EXAMPLE_SKETCHES
} from '../sim/arduinoRuntime.js';
import { createWorkspaceManager } from '../ui/workspaceManager.js';
import { renderRuntimeOverlay } from '../ui/runtimeOverlay.js';

const PROBE_MODES = new Set([
  'probe-red',
  'probe-black',
  'probe-fgen',
  'probe-arb-ao0',
  'probe-arb-ao1',
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
    vpsEnabled: typeof rawCfg.vpsEnabled === 'boolean' ? rawCfg.vpsEnabled : base.vpsEnabled,
    usbIsolatorEnabled:
      typeof rawCfg.usbIsolatorEnabled === 'boolean'
        ? rawCfg.usbIsolatorEnabled
        : base.usbIsolatorEnabled,
    elvisSupplyPos: clampVal(rawCfg.elvisSupplyPos, 0, 12, base.elvisSupplyPos),
    elvisSupplyNeg: clampVal(rawCfg.elvisSupplyNeg, -12, 0, base.elvisSupplyNeg),
    loadCellForceGrams: clampVal(rawCfg.loadCellForceGrams, 0, 1000, base.loadCellForceGrams),
    arduinoPinStates: isPlainObject(rawCfg.arduinoPinStates) ? { ...rawCfg.arduinoPinStates } : {},
    fgen: createDefaultFgenConfig(rawCfg.fgen),
    arb: createDefaultArbConfig(rawCfg.arb),
    emg: createDefaultEmgConfig(rawCfg.emg),
    pulseOx: createDefaultPulseOxConfig(rawCfg.pulseOx)
  };
}

/**
 * BenchController encapsulates live simulation state, workspace & virtual bench
 * instruments (DMM, VPS, FGEN, ARB, Scope, Bode, Nano), preset loading,
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
      presetSelect: host.presetSelect || null,
      generateId: host.generateId || null,
      getBoardContext: host.getBoardContext || (() => ({})),
      getInteractionMode: host.getInteractionMode || (() => 'build'),
      setInteractionMode: host.setInteractionMode || (() => {}),
      setSidebarCollapsed: host.setSidebarCollapsed || (() => {}),
      onCircuitTopologyReset: host.onCircuitTopologyReset || (() => {}),
      onInspectorNeedsRefresh: host.onInspectorNeedsRefresh || (() => {}),
      onBenchControlsUpdated: host.onBenchControlsUpdated || (() => {}),
      onWorkspaceModeChange: host.onWorkspaceModeChange || (() => {}),
      onWarningsAndStatusRefresh: host.onWarningsAndStatusRefresh || (() => {}),
      onPlacePartById: host.onPlacePartById || null,
      onEnableElvisMode: host.onEnableElvisMode || null,
      onLabContextChanged: host.onLabContextChanged || (() => {}),
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
    this.isolationResult = null;
    this.arduinoLiveStepper = null;
    this.dmmResistance = null;
    this.dmmAcVoltage = null;
    this.dmmTransientNotice = null;
    this.dmmTransientTimer = null;
    this.hasRunInitialStoppedScopeCapture = false;
    this.hasRunInitialStoppedBodeSweep = false;
    this._pendingForceScopeCapture = false;
    this._pendingForceBodeSweep = false;

    // Arduino Nano Runtime & IDE State
    this.arduinoCode = ARDUINO_EXAMPLE_SKETCHES[0]?.code || '';
    this.arduinoRunner = null;
    this.arduinoInstrument = null;
    this.arduinoTxActive = false;
    this.arduinoTxTimer = null;
    this.arduinoUiRaf = null;
    this.arduinoUiTimeout = null;
    this.arduinoDcDirty = false;
    this.lastInstantSolve = { tSec: null, result: null };
    this.arduinoTickRaf = null;
    this.lastArduinoScopeTickMs = 0;
    this._pendingArduinoScopeTimeout = null;

    // Preserved persistence bag (retains unknown future keys across load/save cycles)
    this.simStateExtras = {};

    // Workspace & Registered Instrument Panels
    this.workspaceManager = null;
    this.dmmInstrument = null;
    this.vpsInstrument = null;
    this.fgenInstrument = null;
    this.arbInstrument = null;
    this.scopeInstrument = null;
    this.bodeInstrument = null;
    this.registeredInstruments = [];

    this.saveDebounceTimer = null;
    this.ac = new AbortController();

    this._initArduinoRunner();
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
    const { appShellEl, instrumentDockEl } = this.host;
    if (!appShellEl || !instrumentDockEl) return;

    this.workspaceManager = createWorkspaceManager({
      appShellEl,
      dockEl: instrumentDockEl,
      callbacks: {
        onPowerToggle: (nextPowered) => {
          this.setSimPower(nextPowered);
        },
        onLoadChange: (grams) => {
          this.applyStimulusPatch({ loadCellForceGrams: grams }, { commit: true });
        },
        onEmgChange: (patch) => {
          this.applyStimulusPatch({ emg: patch }, { commit: true });
        },
        onPulseOxChange: (patch) => {
          this.applyStimulusPatch({ pulseOx: patch }, { commit: true });
        },
        onStateChange: (wsState) => {
          const dmmVisible = this.workspaceManager.isInstrumentVisible('dmm');
          const fgenVisible = this.workspaceManager.isInstrumentVisible('fgen');
          const arbVisible = this.workspaceManager.isInstrumentVisible('arb');
          const scopeVisible = this.workspaceManager.isInstrumentVisible('scope');
          const bodeVisible = this.workspaceManager.isInstrumentVisible('bode');
          const mode = this.host.getInteractionMode();

          const probingDmm = mode === 'probe-red' || mode === 'probe-black';
          const probingFgen = mode === 'probe-fgen';
          const probingArb = mode === 'probe-arb-ao0' || mode === 'probe-arb-ao1';
          const probingScope = mode === 'probe-scope-ch0' || mode === 'probe-scope-ch1';
          const probingBode = mode === 'probe-bode-in' || mode === 'probe-bode-out';

          if (
            (probingDmm && !dmmVisible) ||
            (probingFgen && !fgenVisible) ||
            (probingArb && !arbVisible) ||
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

          this.host.onWorkspaceModeChange?.(wsState);

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
          this.host.onLabContextChanged?.();
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

    this.vpsInstrument = createVpsInstrument({
      callbacks: {
        onSupplyChange: ({ pos, neg }) => {
          if (Number.isFinite(pos)) this.simConfig.elvisSupplyPos = Math.min(12, Math.max(0, pos));
          if (Number.isFinite(neg)) this.simConfig.elvisSupplyNeg = Math.min(0, Math.max(-12, neg));
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.scheduleSave();
        },
        onRunStateChange: (enabled) => {
          this.simConfig.vpsEnabled = Boolean(enabled);
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.scheduleSave();
        },
        onEnableElvisMode: () => {
          this.host.onEnableElvisMode?.();
        },
        onPowerToggle: (nextPowered) => {
          this.setSimPower(nextPowered);
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

    this.arbInstrument = createArbInstrument({
      callbacks: {
        onConfigChange: (nextCfg) => {
          this.simConfig.arb = createDefaultArbConfig(nextCfg);
          this.lastInstantSolve = { tSec: null, result: null };
          this.runSimulation();
          this.updateArbUI();
          this.scheduleSave();
        },
        onRunStateChange: (running) => {
          this.simConfig.arb = createDefaultArbConfig({
            ...this.simConfig.arb,
            running: Boolean(running)
          });
          this.lastInstantSolve = { tSec: null, result: null };
          this.runSimulation();
          this.updateArbUI();
          this.scheduleSave();
        },
        onStartProbe: (chKey) => {
          this.enterProbeMode(chKey === 'ao1' ? 'probe-arb-ao1' : 'probe-arb-ao0', 'arb');
        },
        onClearProbe: (chKey) => {
          const key = chKey === 'ao1' ? 'ao1' : 'ao0';
          const probeMode = key === 'ao1' ? 'probe-arb-ao1' : 'probe-arb-ao0';
          this.simConfig.arb = createDefaultArbConfig({
            ...this.simConfig.arb,
            [key]: { ...this.simConfig.arb[key], probeHole: null }
          });
          if (this.host.getInteractionMode() === probeMode) {
            this.host.setInteractionMode('build');
          }
          this.runSimulation();
          this.updateArbUI();
          this.scheduleSave();
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
          const readChannelMetrics = () => {
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
            return {
              m0: trace0?.valid && trace0.samples ? computeWaveformMetrics(trace0.samples, dt) : null,
              m1: trace1?.valid && trace1.samples ? computeWaveformMetrics(trace1.samples, dt) : null
            };
          };

          if (!this.transientResult) {
            this.runTransientForInstruments({ forceScopeCapture: true });
          }

          let { m0, m1 } = readChannelMetrics();

          const { breadboard, placedParts } = this.getBoardContext();
          const stimulusFreqHz = this.simConfig.fgen?.enabled
            ? this.simConfig.fgen.frequencyHz
            : getSlowestStimulusFreqHz({
                breadboard,
                placedParts,
                simConfig: this.simConfig,
                dcResult: this.dcResult
              });

          const prevTimePerDiv = this.scopeState.timePerDiv;
          let auto = computeAutoscale({
            ch0Metrics: m0,
            ch1Metrics: m1,
            fgenFreqHz: stimulusFreqHz
          });

          if (this.scopeState.ch0.enabled) this.scopeState.ch0.voltsPerDiv = auto.ch0VoltsPerDiv;
          if (this.scopeState.ch1.enabled) this.scopeState.ch1.voltsPerDiv = auto.ch1VoltsPerDiv;
          this.scopeState.timePerDiv = auto.timePerDiv;
          this.scopeState.trigger.level = auto.triggerLevel;

          const prevDmmVac = this.dmmAcVoltage;
          this.runTransientForInstruments({ forceScopeCapture: true });

          // If timebase changed noticeably (e.g. 2 ms/div -> 200 ms/div for 72 BPM EKG),
          // re-evaluate vertical Volts/Div and trigger level from the new full-cycle capture.
          if (prevTimePerDiv > 0 && Math.abs(Math.log2(auto.timePerDiv / prevTimePerDiv)) >= 1) {
            ({ m0, m1 } = readChannelMetrics());
            auto = computeAutoscale({
              ch0Metrics: m0,
              ch1Metrics: m1,
              fgenFreqHz: stimulusFreqHz
            });
            if (this.scopeState.ch0.enabled) this.scopeState.ch0.voltsPerDiv = auto.ch0VoltsPerDiv;
            if (this.scopeState.ch1.enabled) this.scopeState.ch1.voltsPerDiv = auto.ch1VoltsPerDiv;
            this.scopeState.trigger.level = auto.triggerLevel;
            if (auto.timePerDiv !== this.scopeState.timePerDiv) {
              this.scopeState.timePerDiv = auto.timePerDiv;
              this.runTransientForInstruments({ forceScopeCapture: true });
            }
          }

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

    this.arduinoInstrument = createArduinoInstrument({
      callbacks: {
        onCodeChange: (code) => {
          this.arduinoCode = code;
          this.scheduleSave();
        },
        onRun: (code) => {
          this.arduinoCode = code;
          this.startArduinoSketch(code, { save: true });
        },
        onStop: () => {
          this.stopArduinoRunner({ reset: false });
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
        },
        onReset: () => {
          this.stopArduinoRunner({ reset: true });
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
        },
        onSendSerial: (text) => {
          this.arduinoRunner?.sendSerialInput(text);
        },
        onClearSerial: () => {
          this.arduinoRunner?.clearSerial?.();
          this.updateArduinoUI();
        },
        onClearPlotter: () => {
          this.arduinoRunner?.clearPlotter?.();
          this.updateArduinoUI();
        },
        onPlaceNano: () => {
          this.host.onPlacePartById?.('arduino-nano');
        },
        onPowerToggle: (nextPowered) => {
          this.setSimPower(nextPowered);
        },
        onSelectExample: (_id, sketch) => {
          if (sketch?.code) {
            this.arduinoCode = sketch.code;
            this.scheduleSave();
          }
        },
        onNewSketch: (code) => {
          this.stopArduinoRunner({ reset: true });
          this.arduinoCode = typeof code === 'string' ? code : '';
          this.runSimulation();
          this.host.onInspectorNeedsRefresh({ preserveControls: true });
          this.scheduleSave();
        }
      }
    });
    this.arduinoInstrument.setCode(this.arduinoCode, { notify: false });

    this.registerInstrument(this.dmmInstrument);
    this.registerInstrument(this.vpsInstrument);
    this.registerInstrument(this.fgenInstrument);
    this.registerInstrument(this.arbInstrument);
    this.registerInstrument(this.scopeInstrument);
    this.registerInstrument(this.bodeInstrument);
    this.registerInstrument(this.arduinoInstrument);

    for (const extraPanel of this.registeredInstruments) {
      if (
        extraPanel !== this.dmmInstrument &&
        extraPanel !== this.vpsInstrument &&
        extraPanel !== this.fgenInstrument &&
        extraPanel !== this.arbInstrument &&
        extraPanel !== this.scopeInstrument &&
        extraPanel !== this.bodeInstrument &&
        extraPanel !== this.arduinoInstrument
      ) {
        this.workspaceManager.registerInstrument(extraPanel);
      }
    }

    this.ac?.abort();
    this.ac = new AbortController();
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
    if (this.simConfig.arb?.ao0?.probeHole && !breadboard.getHole(this.simConfig.arb.ao0.probeHole)) {
      this.simConfig.arb.ao0.probeHole = null;
    }
    if (this.simConfig.arb?.ao1?.probeHole && !breadboard.getHole(this.simConfig.arb.ao1.probeHole)) {
      this.simConfig.arb.ao1.probeHole = null;
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
    this.lastInstantSolve = { tSec: null, result: null };
    this.hasRunInitialStoppedScopeCapture = false;
    this.hasRunInitialStoppedBodeSweep = false;
    this.scopeInstrument?.resetFrozen();
    this.bodeInstrument?.resetFrozen();
  }

  clearAllProbes() {
    this.stopArduinoRunner({ reset: true });
    this.dmmState.probeRed = null;
    this.dmmState.probeBlack = null;
    this.simConfig.fgen.probeHole = null;
    if (this.simConfig.arb?.ao0) this.simConfig.arb.ao0.probeHole = null;
    if (this.simConfig.arb?.ao1) this.simConfig.arb.ao1.probeHole = null;
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
    } else if (mode === 'probe-arb-ao0') {
      this.simConfig.arb.ao0.probeHole = hole.id;
    } else if (mode === 'probe-arb-ao1') {
      this.simConfig.arb.ao1.probeHole = hole.id;
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
      const slowestHz = getSlowestStimulusFreqHz({
        breadboard,
        placedParts,
        simConfig: this.simConfig,
        dcResult: this.dcResult
      });
      const hasFastFgen = Boolean(this.simConfig.fgen?.enabled) && fgenFreq >= 10;
      const emgVacCapture = !this.simConfig.fgen?.enabled && Boolean(breadboard.emgMode) && (slowestHz == null || slowestHz >= 10);
      let minPwmFreqHz = Infinity;
      if (!this.simConfig.fgen?.enabled) {
        const pinStates = this.simConfig.arduinoPinStates;
        if (isPlainObject(pinStates)) {
          for (const entry of Object.values(pinStates)) {
            if (!isPlainObject(entry)) continue;
            if (entry.mode === 'PWM') {
              const f = Number.isFinite(entry.freqHz) && entry.freqHz > 0 ? entry.freqHz : 490;
              if (f < minPwmFreqHz) minPwmFreqHz = f;
            } else {
              for (const nested of Object.values(entry)) {
                if (isPlainObject(nested) && nested.mode === 'PWM') {
                  const f = Number.isFinite(nested.freqHz) && nested.freqHz > 0 ? nested.freqHz : 490;
                  if (f < minPwmFreqHz) minPwmFreqHz = f;
                }
              }
            }
          }
        }
      }
      const hasActivePwm = Number.isFinite(minPwmFreqHz) && minPwmFreqHz > 0;
      const hasFastSource = hasFastFgen || hasActivePwm;
      const effectiveFreq = hasActivePwm
        ? minPwmFreqHz
        : hasFastFgen
        ? fgenFreq
        : (slowestHz || fgenFreq);

      const cyclesInScope = scopeDurationSec * effectiveFreq;
      const samplesPerCycleInScope = (scopeSamples - 1) / Math.max(1e-9, cyclesInScope);
      const canReuseScopeCapture =
        !emgVacCapture &&
        needScope &&
        this.transientResult &&
        cyclesInScope >= 3 &&
        samplesPerCycleInScope >= 32;

      const vacDuration =
        !hasFastSource && slowestHz && slowestHz < 10
          ? Math.min(4.0, Math.max(0.2, 2.0 / slowestHz))
          : emgVacCapture
          ? 0.36
          : hasActivePwm
          ? Math.min(0.2, 4 / minPwmFreqHz)
          : Math.min(4.0, 4 / effectiveFreq);

      const vacResult = canReuseScopeCapture
        ? this.transientResult
        : solveTransientCircuit({
            breadboard,
            connectivity,
            placedParts,
            wires,
            catalogMap,
            simConfig: this.simConfig,
            totalDurationSec: vacDuration,
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

  // ---------------------------------------------------------------------------
  // Arduino Nano Runtime & Fast Throttled Ticks
  // ---------------------------------------------------------------------------
  _initArduinoRunner() {
    this.arduinoRunner = createArduinoRunner({
      readPinVoltage: (pinId) => this.readArduinoPinVoltage(pinId),
      onPinStateChange: (_pinId, _pinState, allPinStates) => {
        this.simConfig.arduinoPinStates = { ...(allPinStates || {}) };
        this.arduinoDcDirty = true;
        this.arduinoStepperPinDirty = true;
        if (this.arduinoLiveStepper) {
          this.arduinoLiveStepper.syncArduinoPinStates(this.simConfig.arduinoPinStates);
          this.arduinoStepperPinDirty = false;
        }
        this.lastInstantSolve = { tSec: null, result: null };
        this.scheduleFastArduinoTick();
      },
      onSerialOutput: () => {
        this.scheduleArduinoUiRefresh();
      },
      onTxPulse: () => {
        this.pulseArduinoTxLed();
      },
      onError: () => {
        this.scheduleArduinoUiRefresh();
      },
      onStateChange: () => {
        this.scheduleArduinoUiRefresh();
      }
    });
  }

  getPlacedArduinoNano() {
    const { placedParts } = this.getBoardContext();
    return (placedParts || []).find((p) => p.partId === 'arduino-nano') || null;
  }

  _circuitHasCapacitors(placedParts, catalogMap) {
    if (!Array.isArray(placedParts) || !catalogMap) return false;
    return placedParts.some((p) => {
      const def = typeof catalogMap.get === 'function' ? catalogMap.get(p.partId) : catalogMap[p.partId];
      return def?.unit === 'F';
    });
  }

  _solveArduinoInstantAt(tSec) {
    const { breadboard, connectivity, placedParts, wires, catalogMap } = this.getBoardContext();
    if (!breadboard || !connectivity) return null;

    if (!this._circuitHasCapacitors(placedParts, catalogMap)) {
      return solveDcCircuit({
        breadboard,
        connectivity,
        placedParts,
        wires,
        catalogMap,
        simConfig: this.simConfig,
        timeSec: tSec
      });
    }

    if (!this.arduinoLiveStepper) {
      this.arduinoLiveStepper = createLiveCircuitStepper({
        breadboard,
        placedParts,
        wires,
        catalogMap,
        connectivity,
        simConfig: this.simConfig
      });
      this.arduinoStepperPinDirty = false;
    }

    if (this.arduinoStepperPinDirty) {
      this.arduinoLiveStepper.syncArduinoPinStates(this.simConfig.arduinoPinStates);
      this.arduinoStepperPinDirty = false;
    }

    const stepRes = this.arduinoLiveStepper.stepToTime(tSec);
    if (!stepRes) return null;
    return {
      powered: stepRes.powered,
      nodeVoltages: stepRes.nodeVoltages,
      getHoleVoltage(holeId) {
        if (!holeId) return null;
        const hole = breadboard.getHole(holeId);
        if (!hole) return null;
        const net = connectivity.getNetForHole(holeId);
        if (!net) return null;
        const v = stepRes.nodeVoltages.get(net.id);
        return Number.isFinite(v) ? v : null;
      }
    };
  }

  readArduinoPinVoltage(pinId) {
    if (!this.simConfig.powered) return 0;
    const nano = this.getPlacedArduinoNano();
    const { breadboard, connectivity, placedParts, wires, catalogMap } = this.getBoardContext();
    if (!nano || !connectivity) return NaN;

    const pinHole = connectivity.getPinHole(nano.id, pinId);
    if (!pinHole) return NaN;
    const gndHole =
      connectivity.getPinHole(nano.id, 'GND_BOT') ||
      connectivity.getPinHole(nano.id, 'GND_TOP');

    const isTimeVarying = hasTimeVaryingStimulus({
      breadboard,
      placedParts,
      simConfig: this.simConfig,
      dcResult: this.dcResult
    });
    if (isTimeVarying && breadboard) {
      const elapsedMs =
        this.arduinoRunner?.getElapsedMs?.() ??
        this.arduinoRunner?.getState()?.elapsedMs ??
        0;
      const tSec = elapsedMs / 1000;
      if (
        !this.lastInstantSolve.result ||
        this.lastInstantSolve.tSec === null ||
        Math.abs(tSec - this.lastInstantSolve.tSec) > 0.0004
      ) {
        const res = this._solveArduinoInstantAt(tSec);
        this.lastInstantSolve = { tSec, result: res };
      }

      const instantRes = this.lastInstantSolve.result;
      if (!instantRes) return NaN;
      const vPin = instantRes.getHoleVoltage(pinHole.id);
      if (!Number.isFinite(vPin)) return NaN;
      const vGndRaw = gndHole ? instantRes.getHoleVoltage(gndHole.id) : 0;
      const vGnd = Number.isFinite(vGndRaw) ? vGndRaw : 0;
      return vPin - vGnd;
    }

    if (this.arduinoDcDirty) {
      this.arduinoDcDirty = false;
      if (breadboard && connectivity) {
        this.dcResult = solveDcCircuit({
          breadboard,
          connectivity,
          placedParts,
          wires,
          catalogMap,
          simConfig: this.simConfig
        });
      }
    }

    if (!this.dcResult) return NaN;

    const vPin = this.dcResult.getHoleVoltage(pinHole.id);
    if (!Number.isFinite(vPin)) return NaN;

    const vGndRaw = gndHole ? this.dcResult.getHoleVoltage(gndHole.id) : 0;
    const vGnd = Number.isFinite(vGndRaw) ? vGndRaw : 0;
    return vPin - vGnd;
  }

  getArduinoPinVoltages() {
    const voltages = {};
    if (!this.simConfig.powered) return voltages;
    const nano = this.getPlacedArduinoNano();
    const { breadboard, connectivity, placedParts } = this.getBoardContext();
    if (!nano || !connectivity) return voltages;

    const runnerRunning = Boolean(this.arduinoRunner?.getState()?.running);
    const isTimeVarying =
      runnerRunning &&
      hasTimeVaryingStimulus({
        breadboard,
        placedParts,
        simConfig: this.simConfig,
        dcResult: this.dcResult
      });

    let voltageSource = this.dcResult;
    if (isTimeVarying && breadboard) {
      const elapsedMs =
        this.arduinoRunner?.getElapsedMs?.() ??
        this.arduinoRunner?.getState()?.elapsedMs ??
        0;
      const tSec = elapsedMs / 1000;
      if (
        !this.lastInstantSolve.result ||
        this.lastInstantSolve.tSec === null ||
        Math.abs(tSec - this.lastInstantSolve.tSec) > 0.0004
      ) {
        const res = this._solveArduinoInstantAt(tSec);
        this.lastInstantSolve = { tSec, result: res };
      }
      if (this.lastInstantSolve.result) {
        voltageSource = this.lastInstantSolve.result;
      }
    }
    if (!voltageSource) return voltages;

    const gndHole =
      connectivity.getPinHole(nano.id, 'GND_BOT') ||
      connectivity.getPinHole(nano.id, 'GND_TOP');
    const vGndRaw = gndHole ? voltageSource.getHoleVoltage(gndHole.id) : 0;
    const vGnd = Number.isFinite(vGndRaw) ? vGndRaw : 0;

    for (let i = 0; i <= 13; i += 1) {
      const id = `D${i}`;
      const hole = connectivity.getPinHole(nano.id, id);
      if (hole) {
        const v = voltageSource.getHoleVoltage(hole.id);
        if (Number.isFinite(v)) voltages[id] = v - vGnd;
      }
    }
    for (let i = 0; i <= 7; i += 1) {
      const id = `A${i}`;
      const hole = connectivity.getPinHole(nano.id, id);
      if (hole) {
        const v = voltageSource.getHoleVoltage(hole.id);
        if (Number.isFinite(v)) voltages[id] = v - vGnd;
      }
    }
    return voltages;
  }

  pulseArduinoTxLed() {
    const wasActive = this.arduinoTxActive;
    this.arduinoTxActive = true;
    if (this.arduinoTxTimer) {
      clearTimeout(this.arduinoTxTimer);
    }
    this.arduinoTxTimer = setTimeout(() => {
      this.arduinoTxTimer = null;
      this.arduinoTxActive = false;
      this.renderRuntimeOverlayAll();
    }, 120);
    if (!wasActive) {
      this.renderRuntimeOverlayAll();
    }
  }

  scheduleArduinoUiRefresh() {
    if (typeof requestAnimationFrame === 'function') {
      if (this.arduinoUiRaf !== null) return;
      this.arduinoUiRaf = requestAnimationFrame(() => {
        this.arduinoUiRaf = null;
        this.updateArduinoUI();
        this.renderRuntimeOverlayAll();
      });
    } else {
      if (this.arduinoUiTimeout !== null) return;
      this.arduinoUiTimeout = setTimeout(() => {
        this.arduinoUiTimeout = null;
        this.updateArduinoUI();
        this.renderRuntimeOverlayAll();
      }, 50);
    }
  }

  startArduinoSketch(code = this.arduinoCode, { save = true } = {}) {
    if (typeof code === 'string') {
      this.arduinoCode = code;
    }
    if (!this.arduinoRunner) return { ok: false, error: 'Arduino runner not initialized' };

    if (!this.getPlacedArduinoNano() || !this.simConfig.powered) {
      this.updateArduinoUI();
      return { ok: false };
    }

    const res = this.arduinoRunner.start(this.arduinoCode);
    if (!res.ok) {
      this.simConfig.arduinoPinStates = {};
      this.arduinoDcDirty = false;
      const { breadboard, connectivity } = this.getBoardContext();
      if (breadboard && connectivity) {
        this.runSimulation();
      } else {
        this.updateArduinoUI();
        this.renderRuntimeOverlayAll();
      }
    } else {
      this.updateArduinoUI();
      this.renderRuntimeOverlayAll();
    }
    if (save) {
      this.scheduleSave();
    }
    return res;
  }

  stopArduinoRunner({ reset = false } = {}) {
    this.lastInstantSolve = { tSec: null, result: null };
    this.arduinoLiveStepper = null;
    if (this.arduinoTxTimer) {
      clearTimeout(this.arduinoTxTimer);
      this.arduinoTxTimer = null;
    }
    this.arduinoTxActive = false;
    if (this._pendingArduinoScopeTimeout) {
      clearTimeout(this._pendingArduinoScopeTimeout);
      this._pendingArduinoScopeTimeout = null;
    }
    if (reset && this.arduinoTickRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.arduinoTickRaf);
      this.arduinoTickRaf = null;
    }
    if (this.arduinoRunner) {
      if (reset) {
        this.arduinoRunner.reset();
        this.arduinoDcDirty = false;
      } else {
        this.arduinoRunner.stop();
      }
      const runnerState = this.arduinoRunner.getState();
      this.simConfig.arduinoPinStates = reset ? {} : { ...(runnerState.pinStates || {}) };
    }
  }

  _runThrottledArduinoScopeTick() {
    this.lastArduinoScopeTickMs = performance.now();
    const prevDmmVac = this.dmmAcVoltage;
    this.runTransientForInstruments();
    this.updateScopeUI();
    if (this.dmmAcVoltage !== prevDmmVac) {
      this.updateDmmUI();
    }
  }

  scheduleFastArduinoTick() {
    if (typeof requestAnimationFrame === 'function') {
      if (this.arduinoTickRaf !== null) return;
      this.arduinoTickRaf = requestAnimationFrame(() => {
        this.arduinoTickRaf = null;
        this.runFastArduinoTick();
      });
    } else {
      this.runFastArduinoTick();
    }
  }

  /**
   * Fast Simulation Tick triggered by Arduino GPIO / PWM changes:
   * updates DC MNA, runtime LED overlays, DMM DC, Pin Monitor, and throttled Scope
   * without tearing down static breadboard wires/parts DOM or running Bode sweeps.
   */
  runFastArduinoTick() {
    if (!this.arduinoRunner) return;
    const runnerState = this.arduinoRunner.getState();
    this.simConfig.arduinoPinStates = { ...(runnerState.pinStates || {}) };

    const { breadboard, connectivity, placedParts, wires, catalogMap } = this.getBoardContext();
    if (!breadboard || !connectivity) {
      this.updateArduinoUI();
      return;
    }

    if (this.arduinoDcDirty || !this.dcResult) {
      this.arduinoDcDirty = false;
      this.lastInstantSolve = { tSec: null, result: null };
      this.dcResult = solveDcCircuit({
        breadboard,
        connectivity,
        placedParts,
        wires,
        catalogMap,
        simConfig: this.simConfig
      });
    }

    this.renderRuntimeOverlayAll();

    const dmmVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('dmm') : false;
    if (dmmVisible) {
      this.updateDmmUI();
    }

    this.updateArduinoUI();
    this.host.onInspectorNeedsRefresh({ preserveControls: true });
    this.host.onWarningsAndStatusRefresh();

    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    if (scopeVisible && this.scopeState.running) {
      const now = performance.now();
      const elapsed = now - this.lastArduinoScopeTickMs;
      if (elapsed >= 180) {
        this._runThrottledArduinoScopeTick();
      } else if (!this._pendingArduinoScopeTimeout) {
        this._pendingArduinoScopeTimeout = setTimeout(() => {
          this._pendingArduinoScopeTimeout = null;
          if (
            this.workspaceManager?.isInstrumentVisible('scope') &&
            this.scopeState.running
          ) {
            this._runThrottledArduinoScopeTick();
          }
        }, 180 - elapsed);
      }
    }
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

    if (!this.getPlacedArduinoNano()) {
      const runnerState = this.arduinoRunner?.getState();
      const hasNonInputPin = runnerState?.pinStates
        ? Object.values(runnerState.pinStates).some((st) => st && st.mode && st.mode !== 'INPUT')
        : false;
      const hasPinStates = Object.keys(this.simConfig.arduinoPinStates || {}).length > 0;
      if (
        runnerState?.running ||
        runnerState?.ledBuiltIn ||
        hasNonInputPin ||
        hasPinStates
      ) {
        this.stopArduinoRunner({ reset: true });
      }
      this.simConfig.arduinoPinStates = {};
      this.arduinoDcDirty = false;
    }

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

    this.arduinoDcDirty = false;
    this.lastInstantSolve = { tSec: null, result: null };
    this.arduinoLiveStepper = null;
    this.dcResult = solveDcCircuit({
      breadboard,
      connectivity,
      placedParts,
      wires,
      catalogMap,
      simConfig: this.simConfig
    });

    this.isolationResult = analyzeCircuitIsolation({
      breadboard,
      placedParts,
      wires,
      catalogMap,
      connectivity,
      simConfig: {
        ...this.simConfig,
        dmmProbeRed: this.dmmState?.probeRed || null
      },
      dcResult: this.dcResult
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
    this.host.onLabContextChanged?.();
  }

  // ---------------------------------------------------------------------------
  // Runtime Overlay & Instrument Panel Updates
  // ---------------------------------------------------------------------------
  renderRuntimeOverlayAll() {
    const { breadboard, placedParts, wires, catalogMap, runtimeOverlayLayer } = this.getBoardContext();
    if (!runtimeOverlayLayer || !breadboard) return;

    const dmmVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('dmm') : false;
    const fgenVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('fgen') : false;
    const arbVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('arb') : false;
    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    const bodeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('bode') : false;
    const runnerState = this.arduinoRunner ? this.arduinoRunner.getState() : null;
    const arbProbeAo0 = this.simConfig.arb?.ao0?.probeHole || null;
    const arbProbeAo1 = this.simConfig.arb?.ao1?.probeHole || null;

    renderRuntimeOverlay({
      layerEl: runtimeOverlayLayer,
      breadboard,
      placedParts,
      wires,
      catalogMap,
      dcResult: this.dcResult,
      simConfig: this.simConfig,
      isolationResult: this.isolationResult,
      dmmState: this.dmmState,
      showProbes: dmmVisible,
      fgenProbeHole: this.simConfig.fgen?.probeHole || null,
      showFgenProbe: fgenVisible || Boolean(this.simConfig.fgen?.enabled && this.simConfig.fgen?.probeHole),
      arbProbeAo0,
      arbProbeAo1,
      showArbProbes: Boolean(
        !breadboard.elvisMode &&
          (arbVisible || this.simConfig.arb?.running || arbProbeAo0 || arbProbeAo1)
      ),
      scopeProbes: this.scopeState,
      showScopeProbes: scopeVisible,
      bodeProbes: {
        inputHole: this.bodeState.inputSource === 'PROBE' ? this.bodeState.inputProbeHole : null,
        outputHole: this.bodeState.outputSource === 'PROBE' ? this.bodeState.outputProbeHole : null
      },
      showBodeProbes: bodeVisible,
      arduinoState: runnerState
        ? {
            ledBuiltIn: Boolean(runnerState.ledBuiltIn),
            txActive: Boolean(this.arduinoTxActive),
            running: Boolean(runnerState.running),
            pinStates: runnerState.pinStates
          }
        : null
    });
  }

  updateAllInstruments({ forceScopeCapture = false, forceBodeSweep = false } = {}) {
    this.updateDmmUI();
    this.updateVpsUI();
    this.updateFgenUI();
    this.updateArbUI();
    this.updateScopeUI({ forceCapture: forceScopeCapture });
    this.updateBodeUI({ forceCapture: forceBodeSweep });
    this.updateArduinoUI();
  }

  updateVpsUI() {
    if (!this.vpsInstrument) return;
    const { breadboard } = this.getBoardContext();
    this.vpsInstrument.update({
      powered: Boolean(this.simConfig.powered),
      elvisMode: Boolean(breadboard?.elvisMode),
      vpsEnabled: this.simConfig.vpsEnabled !== false,
      elvisSupplyPos: this.simConfig.elvisSupplyPos,
      elvisSupplyNeg: this.simConfig.elvisSupplyNeg
    });
  }

  updateArduinoUI() {
    if (!this.arduinoInstrument) return;
    const runnerState = this.arduinoRunner
      ? this.arduinoRunner.getState()
      : {
          running: false,
          compileError: null,
          pinStates: {},
          serialLines: [],
          plotterSeries: [],
          elapsedMs: 0,
          baudRate: 9600,
          warnings: []
        };

    this.arduinoInstrument.update({
      code: this.arduinoCode,
      running: Boolean(runnerState.running),
      powered: Boolean(this.simConfig.powered),
      hasNano: Boolean(this.getPlacedArduinoNano()),
      compileError: runnerState.compileError,
      warnings: runnerState.warnings,
      serialLines: runnerState.serialLines,
      serialVersion: runnerState.serialVersion,
      plotterSeries: runnerState.plotterSeries,
      plotterVersion: runnerState.plotterVersion,
      pinStates: runnerState.pinStates,
      pinVoltages: this.getArduinoPinVoltages(),
      elapsedMs: runnerState.elapsedMs,
      baudRate: runnerState.baudRate
    });
  }

  updateDmmUI() {
    const { breadboard, connectivity } = this.getBoardContext();
    this.workspaceManager?.updateBenchControls({
      powered: Boolean(this.simConfig.powered),
      elvisMode: Boolean(breadboard?.elvisMode),
      loadCellsMode: Boolean(breadboard?.loadCellsMode),
      emgMode: Boolean(breadboard?.emgMode),
      pulseOxMode: Boolean(breadboard?.pulseOxMode),
      simConfig: this.simConfig
    });
    this.host.onBenchControlsUpdated?.({
      boardState: {
        elvisMode: Boolean(breadboard?.elvisMode),
        loadCellsMode: Boolean(breadboard?.loadCellsMode),
        emgMode: Boolean(breadboard?.emgMode),
        pulseOxMode: Boolean(breadboard?.pulseOxMode)
      },
      simConfig: this.simConfig,
      isolationResult: this.isolationResult
    });

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

  updateArbUI() {
    if (!this.arbInstrument) return;
    const { breadboard } = this.getBoardContext();
    const mode = this.host.getInteractionMode();
    this.arbInstrument.update({
      arbConfig: this.simConfig.arb,
      powered: Boolean(this.simConfig.powered),
      elvisMode: Boolean(breadboard?.elvisMode),
      isProbingAo0: mode === 'probe-arb-ao0',
      isProbingAo1: mode === 'probe-arb-ao1'
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
    this.host.onLabContextChanged?.();
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
    this.host.onLabContextChanged?.();
  }

  setAllowedInstruments(allowedIdsOrNull) {
    this.workspaceManager?.setAllowedInstruments(allowedIdsOrNull);
  }

  /**
   * Builds the live bench telemetry context consumed by labEvaluator.evaluateLab().
   *
   * @returns {object}
   */
  getLabEvaluationContext() {
    let dmmReading = null;
    if (this.dmmState.probeRed && this.dmmState.probeBlack) {
      if (this.dmmState.mode === 'VDC' && this.simConfig.powered && this.dcResult) {
        const res = this.dcResult.getVoltageDiff(this.dmmState.probeRed, this.dmmState.probeBlack);
        if (res?.valid && Number.isFinite(res.volts)) {
          dmmReading = res.volts;
        }
      } else if (this.dmmState.mode === 'VAC' && this.simConfig.powered) {
        if (this.dmmAcVoltage?.valid && Number.isFinite(this.dmmAcVoltage.voltsRms)) {
          dmmReading = this.dmmAcVoltage.voltsRms;
        }
      } else if (
        (this.dmmState.mode === 'OHM' || this.dmmState.mode === 'CONT') &&
        !this.simConfig.powered
      ) {
        if (this.dmmResistance?.valid && Number.isFinite(this.dmmResistance.ohms)) {
          dmmReading = this.dmmResistance.ohms;
        }
      }
    }

    const scopeMetrics = { ch0: null, ch1: null };
    if (this.simConfig.powered && this.transientResult) {
      const dt = this.transientResult.dt || (this.scopeState.timePerDiv * 10) / 300;
      for (const chKey of ['ch0', 'ch1']) {
        const chCfg = this.scopeState[chKey];
        if (!chCfg?.enabled) continue;
        const trace = this.transientResult.getChannelTrace({
          type: chCfg.source,
          holeId: chCfg.probeHole
        });
        if (trace?.valid && trace.samples) {
          scopeMetrics[chKey] = computeWaveformMetrics(trace.samples, dt);
        }
      }
    }

    const runnerState = this.arduinoRunner ? this.arduinoRunner.getState() : null;
    return {
      simConfig: this.simConfig,
      dcResult: this.dcResult,
      dmmState: this.dmmState,
      dmmReading,
      bodeResult: this.bodeResult,
      scopeMetrics,
      workspaceState: this.workspaceManager ? this.workspaceManager.getState() : null,
      visibleInstruments: this.workspaceManager
        ? this.workspaceManager.getVisibleInstrumentIds()
        : new Set(),
      arduinoState: runnerState,
      arduinoCode: this.arduinoCode,
      isolationResult: this.isolationResult
    };
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
    if (!powered) {
      this.stopArduinoRunner({ reset: true });
      this.simConfig.arduinoPinStates = {};
      this.arduinoDcDirty = false;
    }
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

  /**
   * Apply a partial external stimulus patch (load cell force and/or EMG config),
   * rerun the simulation, and synchronize inspector, sidebar, and workspace controls.
   *
   * @param {object} patch
   * @param {object} [options]
   * @param {boolean} [options.commit=true]
   */
  applyStimulusPatch(patch = {}, { commit = true } = {}) {
    if (!isPlainObject(patch)) return;

    if (patch.loadCellForceGrams !== undefined) {
      const grams = Number(patch.loadCellForceGrams);
      if (Number.isFinite(grams)) {
        this.simConfig.loadCellForceGrams = Math.min(1000, Math.max(0, grams));
      }
    }

    if (isPlainObject(patch.emg)) {
      this.simConfig.emg = createDefaultEmgConfig({
        ...this.simConfig.emg,
        ...patch.emg
      });
    }

    if (isPlainObject(patch.pulseOx)) {
      this.simConfig.pulseOx = createDefaultPulseOxConfig({
        ...this.simConfig.pulseOx,
        ...patch.pulseOx
      });
    }

    if (typeof patch.usbIsolatorEnabled === 'boolean') {
      this.simConfig.usbIsolatorEnabled = patch.usbIsolatorEnabled;
      this.arduinoLiveStepper = null;
    }

    this.runSimulation();
    this.host.onInspectorNeedsRefresh?.({ preserveControls: true });
    if (commit) {
      this.scheduleSave();
    }
  }

  // ---------------------------------------------------------------------------
  // Presets & Starter Circuit
  // ---------------------------------------------------------------------------
  setActivePresetLabel(presetId = '') {
    if (this.host.presetSelect) {
      this.host.presetSelect.value = presetId || '';
    }
    if (!presetId) {
      this.workspaceManager?.setActiveCircuitTitle?.('');
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
    const presetMeta = LAB_PRESETS.find((p) => p.id === presetId) || null;
    const preset = buildPresetCircuit(presetId, {
      generateId: this._makeIdGenerator()
    });
    if (presetMeta && !preset.name) {
      preset.name = presetMeta.name;
    }
    return this._applyPresetObject(presetId, preset);
  }

  _applyPresetObject(presetId, preset) {
    this.stopArduinoRunner({ reset: true });
    this.arduinoLiveStepper = null;
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

    const defaultArd = preset.defaultArduino || null;
    if (defaultArd?.sketchId) {
      const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === defaultArd.sketchId);
      if (sketch) {
        this.arduinoCode = sketch.code;
      }
    }
    this.arduinoInstrument?.setCode(this.arduinoCode, { notify: false });
    if (defaultArd?.drawerTab) {
      this.arduinoInstrument?.setActiveDrawerTab(defaultArd.drawerTab);
    }

    if (this.workspaceManager) {
      const defaultDockTabs = [
        ['arduino', defaultArd?.open],
        ['scope', preset.defaultScope?.open],
        ['bode', preset.defaultBode?.open],
        ['arb', preset.defaultArb?.open],
        ['vps', preset.defaultVps?.open],
        ['dmm', preset.defaultDmm?.open]
      ];
      const openTab = defaultDockTabs.find(([, shouldOpen]) => Boolean(shouldOpen))?.[0] || null;
      if (openTab) {
        this.workspaceManager.openDock(openTab, { notify: false });
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

    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    this._pendingForceScopeCapture = scopeVisible && !this.scopeState.running;

    const bodeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('bode') : false;
    this._pendingForceBodeSweep = bodeVisible && !this.bodeState.running;

    this.setActivePresetLabel(presetId);
    this.workspaceManager?.setActiveCircuitTitle?.(preset.name || '');
    this.host.onCircuitTopologyReset({
      boardConfig: preset.boardConfig,
      placedParts: preset.placedParts,
      wires: preset.wires,
      presetId
    });

    if (defaultArd?.autoRun && this.simConfig.powered && this.getPlacedArduinoNano()) {
      this.startArduinoSketch(this.arduinoCode, { save: false });
    } else {
      this.updateArduinoUI();
    }
  }

  loadStarterCircuit(presetId = 'starter') {
    const { breadboard } = this.getBoardContext();
    const starterCircuit = createStarterCircuit(
      Boolean(breadboard?.elvisMode),
      this._makeIdGenerator()
    );
    this.stopArduinoRunner({ reset: true });
    this.simConfig = createDefaultSimConfig();
    this.dmmState = { mode: 'VDC', probeRed: null, probeBlack: null, running: true };
    this.dmmInstrument?.setRunning(true, { notify: false, resetFrozen: true });
    this.scopeState = createDefaultScopeConfig();
    this.bodeState = normalizeBodeState();
    this.resetTransientAndBode();
    this.workspaceManager?.closeDock({ notify: false });
    this.updateArduinoUI();
    this.setActivePresetLabel(presetId);
    const starterMeta = LAB_PRESETS.find((p) => p.id === presetId);
    this.workspaceManager?.setActiveCircuitTitle?.(starterMeta?.name || '');
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
        usbIsolatorEnabled: Boolean(this.simConfig.usbIsolatorEnabled),
        arduinoPinStates: {},
        fgen: createDefaultFgenConfig(this.simConfig.fgen),
        arb: createDefaultArbConfig(this.simConfig.arb),
        emg: createDefaultEmgConfig(this.simConfig.emg),
        pulseOx: createDefaultPulseOxConfig(this.simConfig.pulseOx)
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
      arduinoState: {
        code: this.arduinoCode
      },
      workspaceState: this.workspaceManager ? this.workspaceManager.getState() : undefined
    };
    return this.simStateExtras;
  }

  applySimState(simState) {
    this.stopArduinoRunner({ reset: true });
    this.arduinoLiveStepper = null;
    this.simStateExtras = isPlainObject(simState) ? { ...simState } : {};
    this.simConfig = this.normalizeSimConfig(this.simStateExtras.simConfig);
    this.simConfig.arduinoPinStates = {};
    this.arduinoDcDirty = false;

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

    const savedArduino = this.simStateExtras.arduinoState;
    if (isPlainObject(savedArduino) && typeof savedArduino.code === 'string') {
      this.arduinoCode = savedArduino.code;
    }
    this.arduinoInstrument?.setCode(this.arduinoCode, { notify: false });

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
      this.host.onWorkspaceModeChange?.(ws);
    }

    const scopeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('scope') : false;
    this._pendingForceScopeCapture = scopeVisible && !this.scopeState.running;

    const bodeVisible = this.workspaceManager ? this.workspaceManager.isInstrumentVisible('bode') : false;
    this._pendingForceBodeSweep = bodeVisible && !this.bodeState.running;

    this.setActivePresetLabel('');
    this.updatePowerButtonUI();
    this.updateArbUI();
    this.updateArduinoUI();
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
   * Handles virtual bench keyboard shortcuts (`P` Power, `M` DMM, `V` VPS, `G` FGEN, `W` ARB, `O` Scope, `B` Bode, `A` Nano, `F` Full Bench).
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
    if (k === 'v') {
      this.workspaceManager?.toggleDock('vps');
      return true;
    }
    if (k === 'g') {
      this.workspaceManager?.toggleDock('fgen');
      return true;
    }
    if (k === 'w') {
      this.workspaceManager?.toggleDock('arb');
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
    if (k === 'a') {
      this.workspaceManager?.toggleDock('arduino');
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

  destroy() {
    if (this.ac) {
      this.ac.abort();
      this.ac = null;
    }
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    if (this.dmmTransientTimer) {
      clearTimeout(this.dmmTransientTimer);
      this.dmmTransientTimer = null;
    }
    if (this.arduinoUiRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.arduinoUiRaf);
      this.arduinoUiRaf = null;
    }
    if (this.arduinoTickRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.arduinoTickRaf);
      this.arduinoTickRaf = null;
    }
    if (this.arduinoUiTimeout) {
      clearTimeout(this.arduinoUiTimeout);
      this.arduinoUiTimeout = null;
    }
    this.stopArduinoRunner({ reset: true });
    this.workspaceManager?.destroy();
    this.workspaceManager = null;
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
