import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAB_SCHEMA_VERSION,
  VALID_CHECK_TYPES,
  validateAndParseLabJson,
  serializeLabTemplate,
  evaluateLabCheck,
  evaluateLab
} from '../js/sim/labEvaluator.js';

const SAMPLE_LAB = {
  schemaVersion: 1,
  id: 'sample-lab',
  title: 'Sample DC & Isolation Lab',
  course: 'BME 201',
  author: 'Prof. Demo',
  description: 'Verify LED, voltage divider, and IEC 60601 isolation.',
  initialBoard: {
    elvisMode: false,
    emgMode: false,
    clearBoard: true,
    defaultInstrument: 'dmm'
  },
  filters: {
    allowedParts: ['arduino-nano', 'led-red', 'resistor-330-1pct', 'resistor-10k-1pct'],
    allowedSensors: ['emg', 'adum3160'],
    allowedInstruments: ['dmm', 'arduino']
  },
  steps: [
    {
      id: 's1',
      title: 'Power & LED',
      instruction: 'Turn power on and light the LED.',
      hint: 'Use a 330 Ohm series resistor.',
      checks: [
        { id: 'c1', type: 'power-on', label: 'Lab Power ON' },
        { id: 'c2', type: 'part-placed', partId: 'led-red', label: 'Red LED placed' },
        { id: 'c3', type: 'led-lit', minBrightness: 0.2, label: 'Red LED glowing safely' },
        { id: 'c4', type: 'no-warnings', label: 'Zero wiring warnings' }
      ]
    },
    {
      id: 's2',
      title: 'Measure & Reflect',
      instruction: 'Measure 2.5 V on DMM and check off observation.',
      checks: [
        { id: 'c5', type: 'dmm-reading', mode: 'VDC', min: 2.3, max: 2.7, label: 'DMM reads ~2.5 V' },
        { id: 'c6', type: 'manual-check', label: 'Recorded divider ratio in notebook' }
      ]
    }
  ]
};

test('validateAndParseLabJson validates schema, normalizes filters, and round-trips cleanly', () => {
  const res = validateAndParseLabJson(JSON.stringify(SAMPLE_LAB));
  assert.equal(res.ok, true);
  assert.equal(res.lab.schemaVersion, LAB_SCHEMA_VERSION);
  assert.equal(res.lab.id, 'sample-lab');
  assert.deepEqual(res.lab.filters.allowedParts, [
    'arduino-nano',
    'led-red',
    'resistor-330-1pct',
    'resistor-10k-1pct'
  ]);
  assert.deepEqual(res.lab.filters.allowedInstruments, ['dmm', 'arduino']);
  assert.equal(res.lab.initialBoard.clearBoard, true);

  const json = serializeLabTemplate(res.lab);
  const res2 = validateAndParseLabJson(json);
  assert.equal(res2.ok, true);
  assert.equal(res2.lab.steps.length, 2);
});

test('validateAndParseLabJson rejects malformed JSON, missing title/steps, and invalid check types', () => {
  assert.equal(validateAndParseLabJson('{bad json').ok, false);
  assert.equal(validateAndParseLabJson('').ok, false);
  assert.equal(validateAndParseLabJson({ schemaVersion: 99, title: 'X', steps: [] }).ok, false);
  assert.equal(validateAndParseLabJson({ title: '', steps: [{ title: 'A', checks: [] }] }).ok, false);
  assert.equal(validateAndParseLabJson({ title: 'No Steps', steps: [] }).ok, false);
  const badType = validateAndParseLabJson({
    title: 'Bad Check',
    steps: [{ title: 'S1', checks: [{ type: 'not-a-real-check', label: 'X' }] }]
  });
  assert.equal(badType.ok, false);
  assert.match(badType.error, /unsupported check type/i);
});

test('evaluateLab evaluates step completion, DMM readings, LED brightness, and manual checks', () => {
  const { lab } = validateAndParseLabJson(SAMPLE_LAB);

  const emptyEval = evaluateLab(lab, {
    placedParts: [],
    wires: [],
    simConfig: { powered: false },
    connectivity: { warnings: [] }
  });
  assert.equal(emptyEval.passedChecks, 1); // no-warnings passes on empty board
  assert.equal(emptyEval.completedSteps, 0);
  assert.equal(emptyEval.allPassed, false);
  assert.equal(emptyEval.recommendedStepIndex, 0);

  const partResults = new Map([
    ['led1', { conducting: true, ledBrightness: 0.61, overcurrent: false }]
  ]);
  const fullEval = evaluateLab(
    lab,
    {
      placedParts: [{ id: 'led1', partId: 'led-red', props: {} }],
      wires: [{ id: 'w1' }, { id: 'w2' }],
      simConfig: { powered: true },
      connectivity: { warnings: [] },
      dcResult: { partResults, diagnostics: [] },
      dmmState: { mode: 'VDC', running: true },
      dmmReading: 2.51
    },
    { 's2::c6': true }
  );
  assert.equal(fullEval.allPassed, true);
  assert.equal(fullEval.completedSteps, 2);
  assert.equal(fullEval.passedChecks, 6);
  assert.equal(fullEval.totalChecks, 6);
});

test('evaluateLabCheck covers Bode, Scope, Arduino FIR, PPG part-prop, board-mode, and IEC 60601 isolation', () => {
  assert.ok(VALID_CHECK_TYPES.includes('isolation-level'));

  const bodePass = evaluateLabCheck(
    { id: 'b1', type: 'bode-cutoff', minHz: 1300, maxHz: 1900, label: 'fc ~ 1.59 kHz' },
    { simConfig: { powered: true }, bodeResult: { valid: true, cutoffHz: 1591.5 } }
  );
  assert.equal(bodePass.passed, true);

  const scopePass = evaluateLabCheck(
    { id: 'sc1', type: 'scope-signal', channel: 'ch0', minVpp: 0.1, minFreqHz: 0.8, maxFreqHz: 2.5, label: 'PPG trace' },
    { simConfig: { powered: true }, scopeMetrics: { ch0: { vpp: 0.24, freqHz: 1.2, rms: 0.06 } } }
  );
  assert.equal(scopePass.passed, true);

  const ardFailLib = evaluateLabCheck(
    { id: 'a1', type: 'arduino-running', requireLibrary: 'FIR.h', minSerialLines: 3, label: 'FIR sketch running' },
    {
      simConfig: { powered: true },
      arduinoState: { running: true, compileError: null, serialLineCount: 10 },
      arduinoCode: 'void setup() {} void loop() {}'
    }
  );
  assert.equal(ardFailLib.passed, false);

  const ardPassLib = evaluateLabCheck(
    { id: 'a1', type: 'arduino-running', requireLibrary: 'FIR.h', minSerialLines: 3, label: 'FIR sketch running' },
    {
      simConfig: { powered: true },
      arduinoState: { running: true, compileError: null, serialLineCount: 10 },
      arduinoCode: '#include <FIR.h>\nvoid setup() {} void loop() {}'
    }
  );
  assert.equal(ardPassLib.passed, true);

  const propPass = evaluateLabCheck(
    { id: 'p1', type: 'part-prop', partId: 'photoresistor', prop: 'lightMode', equals: 'led-ppg', label: 'PPG mode' },
    { placedParts: [{ id: 'ldr1', partId: 'photoresistor', props: { lightMode: 'led-ppg' } }] }
  );
  assert.equal(propPass.passed, true);

  const isoPass = evaluateLabCheck(
    {
      id: 'i1',
      type: 'isolation-level',
      level: 'safe',
      requireCheck: 'galvanic-host-isolation',
      maxHpfHz: 50,
      label: 'IEC 60601 Safe'
    },
    {
      isolationResult: {
        active: true,
        level: 'safe',
        detectedHpfCutoffHz: 31.8,
        checks: [{ id: 'galvanic-host-isolation', status: 'pass' }]
      }
    }
  );
  assert.equal(isoPass.passed, true);

  const isoFail = evaluateLabCheck(
    { id: 'i2', type: 'isolation-level', level: 'safe', label: 'IEC 60601 Safe' },
    {
      isolationResult: {
        active: true,
        level: 'partial',
        summary: 'Partial Isolation (1/2 barriers)',
        checks: []
      }
    }
  );
  assert.equal(isoFail.passed, false);

  // OHM mode requires power OFF
  const ohmOff = evaluateLabCheck(
    { id: 'r1', type: 'dmm-reading', mode: 'OHM', min: 9500, max: 10500, label: '10k resistor' },
    { simConfig: { powered: false }, dmmState: { mode: 'OHM' }, dmmReading: 10000 }
  );
  assert.equal(ohmOff.passed, true);
  const ohmOn = evaluateLabCheck(
    { id: 'r1', type: 'dmm-reading', mode: 'OHM', min: 9500, max: 10500, label: '10k resistor' },
    { simConfig: { powered: true }, dmmState: { mode: 'OHM' }, dmmReading: 10000 }
  );
  assert.equal(ohmOn.passed, false);
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFLINE_DEMO_LAB_MANIFEST,
  OFFLINE_DEMO_LABS,
  resolveSafeLabUrl,
  getLabParamFromSearch
} from '../js/labLoader.js';
import { HARDWARE_MODULES } from '../js/sim/hardwareRegistry.js';
import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';
import { solveDcCircuit } from '../js/sim/dcSolver.js';
import { analyzeCircuitIsolation } from '../js/sim/isolationAnalyzer.js';
import { buildPresetCircuit } from '../js/presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function loadFullCatalogNode() {
  const partsDir = path.join(REPO_ROOT, 'parts');
  const partsManifest = JSON.parse(fs.readFileSync(path.join(partsDir, 'manifest.json'), 'utf8'));
  const map = new Map();
  for (const partId of partsManifest.parts) {
    const def = JSON.parse(fs.readFileSync(path.join(partsDir, partId, 'part.json'), 'utf8'));
    map.set(partId, def);
  }
  return map;
}

test('All labs/*.json files parse cleanly, reference valid catalog/sensor/instrument IDs, and match offline mirror', () => {
  const manifestPath = path.join(REPO_ROOT, 'labs', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest.labs) && manifest.labs.length >= 4);
  assert.equal(manifest.labs.length, OFFLINE_DEMO_LAB_MANIFEST.length);

  const validPartIds = new Set(loadFullCatalogNode().keys());
  const validSensorIds = new Set(HARDWARE_MODULES.map((m) => m.id));
  const validInstrumentIds = new Set(['dmm', 'vps', 'fgen', 'arb', 'scope', 'bode', 'arduino']);

  for (const entry of manifest.labs) {
    const labPath = path.join(REPO_ROOT, 'labs', entry.file);
    assert.ok(fs.existsSync(labPath), `Missing lab file ${entry.file}`);
    const raw = fs.readFileSync(labPath, 'utf8');
    const parsed = validateAndParseLabJson(raw);
    assert.equal(parsed.ok, true, `Lab ${entry.file} failed validation: ${parsed.error}`);

    // Parity with offline mirror for file:// usage
    assert.deepEqual(
      parsed.lab,
      validateAndParseLabJson(OFFLINE_DEMO_LABS[entry.id]).lab,
      `Offline mirror mismatch for ${entry.id}`
    );

    for (const partId of parsed.lab.filters.allowedParts || []) {
      assert.ok(validPartIds.has(partId), `Unknown allowedParts ID "${partId}" in ${entry.file}`);
    }
    for (const sensorId of parsed.lab.filters.allowedSensors || []) {
      assert.ok(
        validSensorIds.has(sensorId),
        `Unknown allowedSensors ID "${sensorId}" in ${entry.file}`
      );
    }
    for (const instId of parsed.lab.filters.allowedInstruments || []) {
      assert.ok(
        validInstrumentIds.has(instId),
        `Unknown allowedInstruments ID "${instId}" in ${entry.file}`
      );
    }
  }
});

test('resolveSafeLabUrl & getLabParamFromSearch permit same-origin relative URLs and block external/unsafe schemes', () => {
  assert.equal(getLabParamFromSearch('?lab=./labs/lab1-dc-divider.json'), './labs/lab1-dc-divider.json');
  assert.equal(getLabParamFromSearch('?foo=bar'), null);

  const okRel = resolveSafeLabUrl('./labs/lab1-dc-divider.json', 'https://example.edu/sim/index.html');
  assert.equal(okRel.ok, true);
  assert.equal(okRel.url, 'https://example.edu/sim/labs/lab1-dc-divider.json');

  const blockCrossOrigin = resolveSafeLabUrl('https://evil.example/lab.json', 'https://example.edu/sim/index.html');
  assert.equal(blockCrossOrigin.ok, false);

  const blockJs = resolveSafeLabUrl('javascript:alert(1)', 'https://example.edu/sim/index.html');
  assert.equal(blockJs.ok, false);

  const blockData = resolveSafeLabUrl('data:application/json,{}', 'https://example.edu/sim/index.html');
  assert.equal(blockData.ok, false);
});

test('End-to-end: Lab 4 (lab4-isolated-emg-fir.json) passes 100% of checks against emg-isolated-safe preset', () => {
  const labRaw = fs.readFileSync(path.join(REPO_ROOT, 'labs', 'lab4-isolated-emg-fir.json'), 'utf8');
  const { ok, lab } = validateAndParseLabJson(labRaw);
  assert.equal(ok, true);

  const catalogMap = loadFullCatalogNode();
  const preset = buildPresetCircuit('emg-isolated-safe');
  const breadboard = new BreadboardModel(preset.boardConfig);
  const connectivity = analyzeCircuit(breadboard, preset.placedParts, preset.wires, catalogMap);
  const dcResult = solveDcCircuit({
    breadboard,
    connectivity,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap,
    simConfig: preset.simConfig
  });
  const isolationResult = analyzeCircuitIsolation({
    breadboard,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap,
    connectivity,
    simConfig: preset.simConfig,
    dcResult
  });

  const evaluation = evaluateLab(lab, {
    breadboard,
    connectivity,
    placedParts: preset.placedParts,
    wires: preset.wires,
    catalogMap,
    simConfig: preset.simConfig,
    dcResult,
    isolationResult,
    arduinoState: { running: true, compileError: null, serialLineCount: 20 },
    arduinoCode: '#include <FIR.h>\nvoid setup(){Serial.begin(9600);} void loop(){}'
  });

  assert.equal(evaluation.allPassed, true, JSON.stringify(evaluation, null, 2));
  assert.equal(evaluation.completedSteps, 4);
  assert.equal(evaluation.passedChecks, evaluation.totalChecks);
});

