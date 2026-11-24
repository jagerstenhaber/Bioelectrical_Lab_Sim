#!/usr/bin/env node
/**
 * Repository Integrity & Parity Auditor (`npm run audit`)
 *
 * Automatically checks:
 *  1. JS syntax (`node --check`) across all files in `js/` and `tests/`
 *  2. Zero-DOM boundary in `js/sim/*` (no window, document, localStorage, HTMLElement, SVGElement)
 *  3. `parts/manifest.json` <-> `parts/<id>/{part.json,graphic.svg}` <-> `getFallbackCatalog()` (`js/partsLoader.js`) parity
 *  4. `labs/manifest.json` <-> `labs/<id>.json` <-> `OFFLINE_DEMO_LAB_MANIFEST` / `OFFLINE_DEMO_LABS` (`js/labLoader.js`) parity
 *  5. Every `allowedParts`, `allowedSensors`, and `allowedInstruments` ID in `labs/*.json` exists in the catalog/registries
 *  6. Every preset in `LAB_PRESETS` (`js/presets.js`) builds with 0 connectivity warnings and valid hole IDs
 *  7. Critical `[hidden]` CSS display rules exist in `css/styles.css` and `css/elvismx.css`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getFallbackCatalog } from '../js/partsLoader.js';
import {
  OFFLINE_DEMO_LAB_MANIFEST,
  OFFLINE_DEMO_LABS
} from '../js/labLoader.js';
import { validateAndParseLabJson } from '../js/sim/labEvaluator.js';
import { HARDWARE_MODULES } from '../js/sim/hardwareRegistry.js';
import { LAB_PRESETS, buildPresetCircuit } from '../js/presets.js';
import { BreadboardModel } from '../js/breadboard.js';
import { analyzeCircuit } from '../js/connectivity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const errors = [];
const checksPassed = [];

function fail(msg) {
  errors.push(msg);
}

function pass(msg) {
  checksPassed.push(msg);
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. JS Syntax Check across js/, tests/, scripts/
// ---------------------------------------------------------------------------
const jsFiles = [
  ...collectJsFiles(path.join(ROOT, 'js')),
  ...collectJsFiles(path.join(ROOT, 'tests')),
  ...collectJsFiles(path.join(ROOT, 'scripts'))
];

for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`Syntax error in ${path.relative(ROOT, file)}: ${err.stderr?.toString() || err.message}`);
  }
}
pass(`JS syntax verified across ${jsFiles.length} module files`);

// ---------------------------------------------------------------------------
// 2. Zero-DOM Boundary Check on js/sim/*
// ---------------------------------------------------------------------------
const simFiles = collectJsFiles(path.join(ROOT, 'js', 'sim'));
const forbiddenDomPattern = /\b(window|document|localStorage|HTMLElement|SVGElement|DOMParser|customElements)\b/;

for (const file of simFiles) {
  const code = fs.readFileSync(file, 'utf8');
  // Strip block comments, line comments, string literals, and regex literals before scanning
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g, '//');
  const match = stripped.match(forbiddenDomPattern);
  if (match) {
    fail(`Zero-DOM violation in ${path.relative(ROOT, file)}: found forbidden identifier "${match[1]}"`);
  }
}
pass(`Zero-DOM boundary verified across ${simFiles.length} js/sim/* modules`);

// ---------------------------------------------------------------------------
// 3. Parts Catalog & Offline Fallback Parity
// ---------------------------------------------------------------------------
const partsDir = path.join(ROOT, 'parts');
const partsManifest = JSON.parse(fs.readFileSync(path.join(partsDir, 'manifest.json'), 'utf8'));
const fallbackParts = getFallbackCatalog();
const fallbackPartMap = new Map(fallbackParts.map((p) => [p.id, p]));
const diskCatalogMap = new Map();

if (!Array.isArray(partsManifest.parts) || partsManifest.parts.length === 0) {
  fail('parts/manifest.json has no parts array');
}

for (const partId of partsManifest.parts) {
  const partJsonPath = path.join(partsDir, partId, 'part.json');
  const svgPath = path.join(partsDir, partId, 'graphic.svg');
  if (!fs.existsSync(partJsonPath)) {
    fail(`Missing parts/${partId}/part.json`);
    continue;
  }
  if (!fs.existsSync(svgPath)) {
    fail(`Missing parts/${partId}/graphic.svg`);
    continue;
  }
  const meta = JSON.parse(fs.readFileSync(partJsonPath, 'utf8'));
  const svgText = fs.readFileSync(svgPath, 'utf8');
  if (meta.id !== partId) {
    fail(`parts/${partId}/part.json has mismatched id "${meta.id}"`);
  }
  if (!svgText.includes('<svg')) {
    fail(`parts/${partId}/graphic.svg is missing <svg> root tag`);
  }
  diskCatalogMap.set(partId, meta);

  const fb = fallbackPartMap.get(partId);
  if (!fb) {
    fail(`Part "${partId}" is in parts/manifest.json but missing from getFallbackCatalog() in js/partsLoader.js`);
  } else {
    if (fb.placement !== meta.placement) {
      fail(`Part "${partId}" placement mismatch between disk (${meta.placement}) and offline fallback (${fb.placement})`);
    }
    if ((fb.pins || []).length !== (meta.pins || []).length) {
      fail(`Part "${partId}" pin count mismatch between disk and offline fallback`);
    }
  }
}

for (const fb of fallbackParts) {
  if (!diskCatalogMap.has(fb.id)) {
    fail(`Fallback part "${fb.id}" in js/partsLoader.js is missing from parts/manifest.json`);
  }
}
pass(`Parts catalog parity verified (${diskCatalogMap.size} parts on disk & offline fallback)`);

// ---------------------------------------------------------------------------
// 4. Guided Labs Manifest, Schema, Filter IDs & Offline Fallback Parity
// ---------------------------------------------------------------------------
const labsDir = path.join(ROOT, 'labs');
const labsManifest = JSON.parse(fs.readFileSync(path.join(labsDir, 'manifest.json'), 'utf8'));
const validSensorIds = new Set(HARDWARE_MODULES.map((m) => m.id));
const validInstrumentIds = new Set(['dmm', 'vps', 'fgen', 'arb', 'scope', 'bode', 'arduino']);

if (!Array.isArray(labsManifest.labs) || labsManifest.labs.length === 0) {
  fail('labs/manifest.json has no labs array');
}

if (labsManifest.labs.length !== OFFLINE_DEMO_LAB_MANIFEST.length) {
  fail(
    `labs/manifest.json count (${labsManifest.labs.length}) !== OFFLINE_DEMO_LAB_MANIFEST count (${OFFLINE_DEMO_LAB_MANIFEST.length})`
  );
}

for (const entry of labsManifest.labs) {
  const labFile = path.join(labsDir, entry.file);
  if (!fs.existsSync(labFile)) {
    fail(`Missing guided lab file labs/${entry.file}`);
    continue;
  }
  const rawText = fs.readFileSync(labFile, 'utf8');
  const parsed = validateAndParseLabJson(rawText);
  if (!parsed.ok) {
    fail(`Guided lab labs/${entry.file} failed schema validation: ${parsed.error}`);
    continue;
  }

  const offlineRaw = OFFLINE_DEMO_LABS[entry.id];
  if (!offlineRaw) {
    fail(`Guided lab "${entry.id}" is missing from OFFLINE_DEMO_LABS in js/labLoader.js`);
  } else {
    const offlineParsed = validateAndParseLabJson(offlineRaw);
    if (!offlineParsed.ok || JSON.stringify(parsed.lab) !== JSON.stringify(offlineParsed.lab)) {
      fail(`Guided lab "${entry.id}" on disk differs from OFFLINE_DEMO_LABS["${entry.id}"] in js/labLoader.js`);
    }
  }

  for (const pid of parsed.lab.filters.allowedParts || []) {
    if (!diskCatalogMap.has(pid)) {
      fail(`Guided lab "${entry.id}" references unknown allowedParts ID "${pid}"`);
    }
  }
  for (const sid of parsed.lab.filters.allowedSensors || []) {
    if (!validSensorIds.has(sid)) {
      fail(`Guided lab "${entry.id}" references unknown allowedSensors ID "${sid}"`);
    }
  }
  for (const iid of parsed.lab.filters.allowedInstruments || []) {
    if (!validInstrumentIds.has(iid)) {
      fail(`Guided lab "${entry.id}" references unknown allowedInstruments ID "${iid}"`);
    }
  }
}
pass(`Guided labs parity & schema verified (${labsManifest.labs.length} labs on disk & offline fallback)`);

// ---------------------------------------------------------------------------
// 5. Classroom Demo Presets Integrity
// ---------------------------------------------------------------------------
for (const presetMeta of LAB_PRESETS) {
  const preset = buildPresetCircuit(presetMeta.id);
  const bb = new BreadboardModel(preset.boardConfig || {});
  const conn = analyzeCircuit(bb, preset.placedParts, preset.wires, diskCatalogMap);
  if (conn.warnings.length > 0) {
    fail(
      `Preset "${presetMeta.id}" produced connectivity warnings: ${conn.warnings.map((w) => w.message).join('; ')}`
    );
  }
}
pass(`All ${LAB_PRESETS.length} LAB_PRESETS build cleanly with 0 connectivity warnings`);

// ---------------------------------------------------------------------------
// 6. Critical [hidden] CSS Rules Guard
// ---------------------------------------------------------------------------
const stylesCss = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
const elvisCss = fs.readFileSync(path.join(ROOT, 'css', 'elvismx.css'), 'utf8');

const requiredStylesHidden = [
  '.sidebar-tab-badge[hidden]',
  '.sensor-card[hidden]',
  '.isolation-card[hidden]',
  '.lab-filter-banner[hidden]',
  '.lab-step-bar[hidden]',
  '.isolation-safety-pill[hidden]'
];
for (const sel of requiredStylesHidden) {
  if (!stylesCss.includes(sel)) {
    fail(`Missing "${sel}" display:none rule in css/styles.css`);
  }
}

const requiredElvisHidden = [
  '.dock-rail-btn[hidden]',
  '.dock-tab-btn[hidden]',
  '.computer-aux-btn[hidden]',
  '.computer-wide-btn[hidden]'
];
for (const sel of requiredElvisHidden) {
  if (!elvisCss.includes(sel)) {
    fail(`Missing "${sel}" display:none rule in css/elvismx.css`);
  }
}
pass('Critical [hidden] CSS display guards verified in styles.css and elvismx.css');

// ---------------------------------------------------------------------------
// Summary Output
// ---------------------------------------------------------------------------
console.log('\n=== BIOELECTRICAL LAB SIM REPOSITORY AUDIT ===');
for (const msg of checksPassed) {
  console.log(`✔ ${msg}`);
}

if (errors.length > 0) {
  console.error(`\n✖ Audit failed with ${errors.length} error(s):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
} else {
  console.log('\n✔ Repository audit passed with 0 errors.\n');
}
