/**
 * Pure, zero-DOM Lab Guidance schema parser, validator, and live check evaluator.
 * Supports externally loaded professor .json lab files with step-by-step instructions,
 * live automated circuit/instrument/IEC-60601 checks, and optional kit filtering.
 *
 * Browser + Node ES2022+ compatible (no DOM or external npm dependencies).
 */

export const LAB_SCHEMA_VERSION = 1;

export const VALID_CHECK_TYPES = Object.freeze([
  'power-on',
  'board-mode',
  'part-placed',
  'wire-count',
  'no-warnings',
  'led-lit',
  'part-prop',
  'ic-powered',
  'instrument-open',
  'dmm-reading',
  'bode-cutoff',
  'scope-signal',
  'arduino-running',
  'isolation-level',
  'manual-check'
]);

const VALID_CHECK_TYPE_SET = new Set(VALID_CHECK_TYPES);

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function normalizeStringArrayOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeOptionalNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function formatRangeValue(val, unit = '') {
  if (!Number.isFinite(val)) return '---';
  const abs = Math.abs(val);
  let numStr;
  if (abs >= 1000 && unit === 'Hz') {
    return `${(val / 1000).toFixed(2)} kHz`;
  }
  if (abs >= 100) numStr = val.toFixed(1);
  else if (abs >= 1) numStr = val.toFixed(2);
  else numStr = val.toFixed(3);
  return unit ? `${numStr} ${unit}` : numStr;
}

function checkNumericBounds(value, min, max) {
  if (!Number.isFinite(value)) return false;
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
}

function normalizeCheck(rawCheck, stepIdx, checkIdx) {
  if (!isPlainObject(rawCheck)) {
    return { ok: false, error: `Step ${stepIdx + 1}, check ${checkIdx + 1} must be an object.` };
  }
  const type = typeof rawCheck.type === 'string' ? rawCheck.type.trim() : '';
  if (!VALID_CHECK_TYPE_SET.has(type)) {
    return {
      ok: false,
      error: `Step ${stepIdx + 1}, check ${checkIdx + 1} has unsupported check type "${type || '(empty)'}".`
    };
  }
  const id =
    typeof rawCheck.id === 'string' && rawCheck.id.trim()
      ? rawCheck.id.trim()
      : `s${stepIdx + 1}-c${checkIdx + 1}`;
  const label =
    typeof rawCheck.label === 'string' && rawCheck.label.trim()
      ? rawCheck.label.trim()
      : `Check: ${type}`;

  // Preserve type-specific config fields cleanly
  const normalized = { ...rawCheck, id, type, label };
  if (rawCheck.partIds !== undefined) {
    normalized.partIds = normalizeStringArrayOrNull(rawCheck.partIds) || [];
  }
  return { ok: true, check: normalized };
}

/**
 * Validates and normalizes a Lab Guidance JSON string or object.
 *
 * @param {string|object} rawOrString
 * @returns {{ ok: true, lab: object } | { ok: false, error: string }}
 */
export function validateAndParseLabJson(rawOrString) {
  let raw = rawOrString;
  if (typeof rawOrString === 'string') {
    const trimmed = rawOrString.trim();
    if (!trimmed) {
      return { ok: false, error: 'Lab file is empty.' };
    }
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      return { ok: false, error: `Invalid JSON syntax: ${err.message}` };
    }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Lab file root must be a JSON object.' };
  }

  const version = raw.schemaVersion ?? 1;
  if (version !== LAB_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Unsupported lab schemaVersion "${version}" (expected ${LAB_SCHEMA_VERSION}).`
    };
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) {
    return { ok: false, error: 'Lab JSON must include a non-empty "title" string.' };
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { ok: false, error: 'Lab JSON must include a non-empty "steps" array.' };
  }

  const steps = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const rs = raw.steps[i];
    if (!isPlainObject(rs)) {
      return { ok: false, error: `Step ${i + 1} must be an object.` };
    }
    const stepTitle = typeof rs.title === 'string' ? rs.title.trim() : '';
    if (!stepTitle) {
      return { ok: false, error: `Step ${i + 1} must include a non-empty "title".` };
    }
    const stepId =
      typeof rs.id === 'string' && rs.id.trim() ? rs.id.trim() : `step-${i + 1}`;
    const instruction =
      typeof rs.instruction === 'string' ? rs.instruction.trim() : '';
    const hint = typeof rs.hint === 'string' ? rs.hint.trim() : '';

    const rawChecks = Array.isArray(rs.checks) ? rs.checks : [];
    const checks = [];
    for (let j = 0; j < rawChecks.length; j++) {
      const parsedCheck = normalizeCheck(rawChecks[j], i, j);
      if (!parsedCheck.ok) return parsedCheck;
      checks.push(parsedCheck.check);
    }

    steps.push({
      id: stepId,
      title: stepTitle,
      instruction,
      hint,
      checks
    });
  }

  const rawFilters = isPlainObject(raw.filters) ? raw.filters : {};
  const filters = {
    allowedParts: normalizeStringArrayOrNull(rawFilters.allowedParts),
    allowedSensors: normalizeStringArrayOrNull(rawFilters.allowedSensors),
    allowedInstruments: normalizeStringArrayOrNull(rawFilters.allowedInstruments)
  };

  let initialBoard = null;
  if (isPlainObject(raw.initialBoard)) {
    initialBoard = {
      elvisMode:
        typeof raw.initialBoard.elvisMode === 'boolean' ? raw.initialBoard.elvisMode : undefined,
      loadCellsMode:
        typeof raw.initialBoard.loadCellsMode === 'boolean'
          ? raw.initialBoard.loadCellsMode
          : undefined,
      emgMode:
        typeof raw.initialBoard.emgMode === 'boolean' ? raw.initialBoard.emgMode : undefined,
      pulseOxMode:
        typeof raw.initialBoard.pulseOxMode === 'boolean'
          ? raw.initialBoard.pulseOxMode
          : undefined,
      usbIsolatorEnabled:
        typeof raw.initialBoard.usbIsolatorEnabled === 'boolean'
          ? raw.initialBoard.usbIsolatorEnabled
          : undefined,
      clearBoard: Boolean(raw.initialBoard.clearBoard),
      defaultInstrument:
        typeof raw.initialBoard.defaultInstrument === 'string'
          ? raw.initialBoard.defaultInstrument.trim()
          : null
    };
  }

  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'custom-lab';

  return {
    ok: true,
    lab: {
      schemaVersion: LAB_SCHEMA_VERSION,
      id,
      title,
      course: typeof raw.course === 'string' ? raw.course.trim() : '',
      author: typeof raw.author === 'string' ? raw.author.trim() : '',
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      initialBoard,
      filters,
      steps
    }
  };
}

/**
 * Serializes a lab object into formatted JSON for professors to download and customize.
 *
 * @param {object} lab
 * @returns {string}
 */
export function serializeLabTemplate(lab) {
  return `${JSON.stringify(lab, null, 2)}\n`;
}

function getManualCheckKey(stepId, checkId) {
  return `${stepId}::${checkId}`;
}

function lookupPartDef(catalogMap, partId) {
  if (!catalogMap || !partId) return null;
  if (typeof catalogMap.get === 'function') return catalogMap.get(partId) || null;
  return catalogMap[partId] || null;
}

/**
 * Evaluates a single declarative lab check against live simulation and bench state.
 *
 * @param {object} check
 * @param {object} ctx
 * @param {object} [options]
 * @returns {{ id: string, type: string, label: string, passed: boolean, detail: string, manualKey?: string }}
 */
export function evaluateLabCheck(check, ctx = {}, { stepId = 'step', manualCheckState = {} } = {}) {
  const {
    breadboard = null,
    placedParts = [],
    wires = [],
    catalogMap = null,
    connectivity = null,
    simConfig = {},
    dcResult = null,
    bodeResult = null,
    scopeMetrics = null,
    dmmState = null,
    dmmReading = null,
    workspaceState = null,
    visibleInstruments = null,
    arduinoState = null,
    arduinoCode = '',
    isolationResult = null
  } = ctx;

  const base = {
    id: check.id,
    type: check.type,
    label: check.label
  };

  switch (check.type) {
    case 'power-on': {
      const passed = Boolean(simConfig?.powered);
      return {
        ...base,
        passed,
        detail: passed ? 'Lab Power is ON' : 'Turn Lab Power ON [P]'
      };
    }

    case 'board-mode': {
      const mismatches = [];
      const flags = [
        ['elvisMode', 'ELVIS II mode', Boolean(breadboard?.elvisMode)],
        ['loadCellsMode', 'Load Cells', Boolean(breadboard?.loadCellsMode)],
        ['emgMode', '3-Pad EMG', Boolean(breadboard?.emgMode)],
        ['pulseOxMode', 'True Pulse-Ox', Boolean(breadboard?.pulseOxMode)],
        ['usbIsolatorEnabled', 'ADuM3160 USB Isolator', Boolean(simConfig?.usbIsolatorEnabled)]
      ];
      for (const [key, name, actual] of flags) {
        if (typeof check[key] === 'boolean' && actual !== check[key]) {
          mismatches.push(`${name}: ${check[key] ? 'ON' : 'OFF'} required`);
        }
      }
      const passed = mismatches.length === 0;
      return {
        ...base,
        passed,
        detail: passed ? 'Board configuration matches' : mismatches.join(' · ')
      };
    }

    case 'part-placed': {
      const minCount = Math.max(1, Math.round(normalizeOptionalNumber(check.minCount) ?? 1));
      const allowedSet =
        Array.isArray(check.partIds) && check.partIds.length > 0 ? new Set(check.partIds) : null;
      const matches = placedParts.filter((inst) => {
        if (typeof check.partId === 'string' && check.partId) {
          return inst.partId === check.partId;
        }
        if (allowedSet) {
          return allowedSet.has(inst.partId);
        }
        if (typeof check.unit === 'string' && check.unit) {
          const def = lookupPartDef(catalogMap, inst.partId);
          return def?.unit === check.unit;
        }
        return false;
      });
      const count = matches.length;
      const passed = count >= minCount;
      return {
        ...base,
        passed,
        detail: `${count} / ${minCount} placed`
      };
    }

    case 'wire-count': {
      const min = Math.max(0, Math.round(normalizeOptionalNumber(check.min) ?? 1));
      const count = Array.isArray(wires) ? wires.length : 0;
      const passed = count >= min;
      return {
        ...base,
        passed,
        detail: `${count} / ${min} wires`
      };
    }

    case 'no-warnings': {
      const connWarnings = Array.isArray(connectivity?.warnings) ? connectivity.warnings.length : 0;
      const simErrors = Array.isArray(dcResult?.diagnostics)
        ? dcResult.diagnostics.filter((d) => d.severity === 'error').length
        : 0;
      const total = connWarnings + simErrors;
      const passed = total === 0;
      return {
        ...base,
        passed,
        detail: passed ? 'No shorts or wiring errors' : `${total} active wiring/circuit error(s)`
      };
    }

    case 'led-lit': {
      const minBrightness = normalizeOptionalNumber(check.minBrightness) ?? 0.15;
      const allowOvercurrent = Boolean(check.allowOvercurrent);
      const leds = placedParts.filter((p) => p.partId === 'led-red');
      let bestBrightness = 0;
      let anyOvercurrent = false;
      let litOk = false;

      for (const led of leds) {
        const sim = dcResult?.partResults?.get(led.id);
        if (!sim) continue;
        const bright = Number.isFinite(sim.ledBrightness) ? sim.ledBrightness : 0;
        if (bright > bestBrightness) bestBrightness = bright;
        if (sim.overcurrent) anyOvercurrent = true;
        if (sim.conducting && bright >= minBrightness && (allowOvercurrent || !sim.overcurrent)) {
          litOk = true;
        }
      }

      let detail = 'Wire & power a Red LED with a current-limiting resistor';
      if (litOk) detail = `LED conducting (${Math.round(bestBrightness * 100)}% brightness)`;
      else if (anyOvercurrent) detail = 'LED overcurrent! Add a 220–330 Ω series resistor';
      else if (leds.length > 0) detail = 'LED placed, but not conducting yet';

      return {
        ...base,
        passed: Boolean(simConfig?.powered && litOk),
        detail
      };
    }

    case 'part-prop': {
      const targetParts = placedParts.filter(
        (p) => !check.partId || p.partId === check.partId
      );
      const propName = typeof check.prop === 'string' ? check.prop : '';
      const min = normalizeOptionalNumber(check.min);
      const max = normalizeOptionalNumber(check.max);
      let passed = false;
      let observed = null;

      for (const inst of targetParts) {
        const val = inst.props?.[propName];
        if (val !== undefined) observed = val;
        if (check.equals !== undefined) {
          if (val === check.equals) {
            passed = true;
            break;
          }
        } else if (min !== null || max !== null) {
          if (checkNumericBounds(Number(val), min, max)) {
            passed = true;
            break;
          }
        }
      }

      const detail = passed
        ? `${propName} = ${String(observed)}`
        : targetParts.length === 0
        ? `Place ${check.partId || 'component'} first`
        : `Adjust ${propName} in Selection Inspector`;

      return { ...base, passed, detail };
    }

    case 'ic-powered': {
      const targetId = check.partId || null;
      const ics = placedParts.filter((p) =>
        targetId
          ? p.partId === targetId
          : p.partId === 'opamp-dual-dip8' || p.partId === 'inamp-ad620'
      );
      const poweredIc = ics.find((ic) => Boolean(dcResult?.partResults?.get(ic.id)?.powered));
      const passed = Boolean(simConfig?.powered && poweredIc);
      return {
        ...base,
        passed,
        detail: passed
          ? 'IC supply rails powered'
          : ics.length === 0
          ? 'Place the IC straddling the center trough'
          : 'Connect IC power rails (+VS / −VS or VCC / GND)'
      };
    }

    case 'instrument-open': {
      const targetId = check.instrumentId;
      let passed = false;
      if (visibleInstruments instanceof Set) {
        passed = visibleInstruments.has(targetId);
      } else if (workspaceState) {
        passed = Boolean(
          (workspaceState.workspaceMode === 'bench' &&
            workspaceState.dockOpen &&
            workspaceState.activeTabId === targetId) ||
            (workspaceState.workspaceMode === 'computer' &&
              (workspaceState.activeWideId === targetId ||
                workspaceState.activeAuxId === targetId ||
                targetId === 'dmm'))
        );
      }
      return {
        ...base,
        passed,
        detail: passed ? `${targetId.toUpperCase()} open` : `Open ${targetId.toUpperCase()} from the right rail`
      };
    }

    case 'dmm-reading': {
      const modeOk = !check.mode || dmmState?.mode === check.mode;
      const min = normalizeOptionalNumber(check.min);
      const max = normalizeOptionalNumber(check.max);
      const rawVal =
        typeof dmmReading === 'number'
          ? dmmReading
          : dmmReading && typeof dmmReading.value === 'number'
          ? dmmReading.value
          : null;
      const measured =
        rawVal !== null && Number.isFinite(rawVal)
          ? check.absValue
            ? Math.abs(rawVal)
            : rawVal
          : null;

      const inRange = modeOk && measured !== null && checkNumericBounds(measured, min, max);
      const unit =
        (check.mode || dmmState?.mode) === 'OHM'
          ? 'Ω'
          : (check.mode || dmmState?.mode) === 'CONT'
          ? ''
          : 'V';

      let detail = 'Place DMM Red (+) and COM (−) probes';
      if (!modeOk) {
        detail = `Switch DMM to ${check.mode} mode`;
      } else if (measured !== null) {
        detail = `Measured: ${formatRangeValue(measured, unit)}`;
      }
      const effectiveMode = check.mode || dmmState?.mode || 'VDC';
      const powerOk = effectiveMode === 'OHM' || effectiveMode === 'CONT'
        ? !simConfig?.powered
        : Boolean(simConfig?.powered);
      return {
        ...base,
        passed: Boolean(powerOk && inRange),
        detail
      };
    }

    case 'bode-cutoff': {
      const minHz = normalizeOptionalNumber(check.minHz);
      const maxHz = normalizeOptionalNumber(check.maxHz);
      const fc = bodeResult?.valid && Number.isFinite(bodeResult.cutoffHz) ? bodeResult.cutoffHz : null;
      const passed = Boolean(simConfig?.powered && fc !== null && checkNumericBounds(fc, minHz, maxHz));
      return {
        ...base,
        passed,
        detail:
          fc !== null
            ? `Measured fc = ${formatRangeValue(fc, 'Hz')}`
            : 'Open Bode Analyzer and sweep across your filter'
      };
    }

    case 'scope-signal': {
      const chKey = check.channel === 'ch1' ? 'ch1' : 'ch0';
      const metrics = scopeMetrics?.[chKey] || null;
      const minVpp = normalizeOptionalNumber(check.minVpp);
      const maxVpp = normalizeOptionalNumber(check.maxVpp);
      const minFreqHz = normalizeOptionalNumber(check.minFreqHz);
      const maxFreqHz = normalizeOptionalNumber(check.maxFreqHz);
      const minRms = normalizeOptionalNumber(check.minRms);
      const maxRms = normalizeOptionalNumber(check.maxRms);

      const hasMetrics = Boolean(metrics && Number.isFinite(metrics.vpp));
      let passed = Boolean(simConfig?.powered && hasMetrics);
      if (passed && (minVpp !== null || maxVpp !== null)) {
        passed = checkNumericBounds(metrics.vpp, minVpp, maxVpp);
      }
      if (passed && (minFreqHz !== null || maxFreqHz !== null)) {
        passed = checkNumericBounds(metrics.freqHz, minFreqHz, maxFreqHz);
      }
      if (passed && (minRms !== null || maxRms !== null)) {
        passed = checkNumericBounds(metrics.rms, minRms, maxRms);
      }

      const detail = hasMetrics
        ? `${chKey.toUpperCase()}: Vpp ${formatRangeValue(metrics.vpp, 'V')}${
            Number.isFinite(metrics.freqHz) ? ` · ${formatRangeValue(metrics.freqHz, 'Hz')}` : ''
          }`
        : `Open Oscilloscope and connect ${chKey.toUpperCase()}`;

      return { ...base, passed, detail };
    }

    case 'arduino-running': {
      const isRunning = Boolean(arduinoState?.running && !arduinoState?.compileError);
      const minSerial = Math.max(0, Math.round(normalizeOptionalNumber(check.minSerialLines) ?? 0));
      const serialLines = Number.isFinite(arduinoState?.serialLineCount)
        ? arduinoState.serialLineCount
        : Array.isArray(arduinoState?.serialLines)
        ? arduinoState.serialLines.length
        : 0;
      const reqLib = typeof check.requireLibrary === 'string' ? check.requireLibrary.trim() : '';
      const hasLib = !reqLib || new RegExp(`#include\\s*[<"]\\s*${reqLib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[>"]`).test(arduinoCode || '');

      const passed = Boolean(simConfig?.powered && isRunning && hasLib && serialLines >= minSerial);
      let detail = 'Upload & Run sketch in the Nano tab';
      if (arduinoState?.compileError) {
        detail = 'Fix compile/runtime error in Nano IDE';
      } else if (!hasLib) {
        detail = `Add #include <${reqLib}> to your sketch`;
      } else if (isRunning && serialLines < minSerial) {
        detail = `Waiting for Serial output (${serialLines}/${minSerial} lines)`;
      } else if (passed) {
        detail = reqLib ? `Sketch running with ${reqLib}` : 'Sketch running cleanly';
      }
      return { ...base, passed, detail };
    }

    case 'isolation-level': {
      const iso = isolationResult || null;
      const reqLevel = check.level || 'safe';
      let levelOk = false;
      if (iso?.active) {
        if (reqLevel === 'safe') levelOk = iso.level === 'safe';
        else if (reqLevel === 'partial') levelOk = iso.level === 'safe' || iso.level === 'partial';
      }

      let specificCheckOk = true;
      if (typeof check.requireCheck === 'string' && check.requireCheck) {
        const found = iso?.checks?.find((c) => c.id === check.requireCheck);
        specificCheckOk = Boolean(found && found.status === 'pass');
      }

      const minHpfHz = normalizeOptionalNumber(check.minHpfHz);
      const maxHpfHz = normalizeOptionalNumber(check.maxHpfHz);
      let hpfOk = true;
      if (minHpfHz !== null || maxHpfHz !== null) {
        hpfOk = checkNumericBounds(iso?.detectedHpfCutoffHz, minHpfHz, maxHpfHz);
      }

      const passed = Boolean(levelOk && specificCheckOk && hpfOk);
      let detail = 'Mount patient electrodes to evaluate IEC 60601 isolation';
      if (iso?.active) {
        if (passed) {
          detail = iso.detectedHpfCutoffHz
            ? `IEC 60601 ${iso.level} · fc ≈ ${formatRangeValue(iso.detectedHpfCutoffHz, 'Hz')}`
            : `IEC 60601 ${iso.level}`;
        } else {
          detail = iso.summary || 'Complete required IEC 60601 barriers';
        }
      }
      return { ...base, passed, detail };
    }

    case 'manual-check': {
      const manualKey = getManualCheckKey(stepId, check.id);
      const passed = Boolean(manualCheckState?.[manualKey]);
      return {
        ...base,
        passed,
        manualKey,
        detail: passed ? 'Checked off' : 'Self-check when complete'
      };
    }

    default:
      return { ...base, passed: false, detail: `Unsupported check: ${check.type}` };
  }
}

/**
 * Evaluates all steps and checks of a loaded lab against live bench context.
 *
 * @param {object|null} lab
 * @param {object} ctx
 * @param {object} [manualCheckState]
 * @returns {object|null}
 */
export function evaluateLab(lab, ctx = {}, manualCheckState = {}) {
  if (!lab || !Array.isArray(lab.steps)) return null;

  let totalChecks = 0;
  let passedChecks = 0;
  let completedSteps = 0;
  let firstIncompleteIdx = -1;

  const evaluatedSteps = lab.steps.map((step, idx) => {
    const checks = (step.checks || []).map((chk) =>
      evaluateLabCheck(chk, ctx, { stepId: step.id, manualCheckState })
    );
    const stepPassed = checks.filter((c) => c.passed).length;
    const stepTotal = checks.length;
    const complete = stepTotal > 0 ? stepPassed === stepTotal : true;

    totalChecks += stepTotal;
    passedChecks += stepPassed;
    if (complete) {
      completedSteps += 1;
    } else if (firstIncompleteIdx === -1) {
      firstIncompleteIdx = idx;
    }

    return {
      id: step.id,
      title: step.title,
      instruction: step.instruction,
      hint: step.hint,
      checks,
      passedCount: stepPassed,
      totalCount: stepTotal,
      complete
    };
  });

  const totalSteps = evaluatedSteps.length;
  const allPassed = totalChecks > 0 ? passedChecks === totalChecks : completedSteps === totalSteps;
  const recommendedStepIndex = firstIncompleteIdx === -1 ? Math.max(0, totalSteps - 1) : firstIncompleteIdx;

  return {
    labId: lab.id,
    title: lab.title,
    totalSteps,
    completedSteps,
    totalChecks,
    passedChecks,
    allPassed,
    recommendedStepIndex,
    steps: evaluatedSteps
  };
}
