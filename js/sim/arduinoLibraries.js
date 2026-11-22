/**
 * Extensible Arduino Library Registry for the sandboxed Arduino Nano runtime.
 *
 * Pure, zero-DOM ES2022+ module (browser + Node compatible).
 * Future libraries can be added modularly by calling `registerArduinoLibrary(spec)`.
 */

/**
 * Registry keyed by canonical header name (e.g. `'FIR.h'`).
 * @type {Map<string, {
 *   header: string,
 *   aliases: string[],
 *   name: string,
 *   description: string,
 *   repoUrl: string,
 *   usagePattern?: RegExp,
 *   missingIncludeError?: string,
 *   transpile?: (code: string) => string,
 *   createBindings: () => Record<string, unknown>
 * }>}
 */
export const ARDUINO_LIBRARY_REGISTRY = new Map();

/**
 * Register an Arduino library specification in the global registry.
 *
 * @param {{
 *   header: string,
 *   aliases?: string[],
 *   name: string,
 *   description: string,
 *   repoUrl: string,
 *   usagePattern?: RegExp,
 *   missingIncludeError?: string,
 *   transpile?: (code: string) => string,
 *   createBindings: () => Record<string, unknown>
 * }} spec
 */
export function registerArduinoLibrary(spec) {
  if (!spec || typeof spec.header !== 'string' || !spec.header.trim()) {
    throw new TypeError('Arduino library spec requires a non-empty string "header".');
  }
  if (typeof spec.createBindings !== 'function') {
    throw new TypeError(`Arduino library "${spec.header}" requires a createBindings() function.`);
  }

  const header = spec.header.trim();
  const aliases = Array.isArray(spec.aliases)
    ? spec.aliases.map((a) => String(a).trim()).filter(Boolean)
    : [];

  const normalized = {
    header,
    aliases,
    name: String(spec.name || header),
    description: String(spec.description || ''),
    repoUrl: String(spec.repoUrl || ''),
    usagePattern: spec.usagePattern instanceof RegExp ? spec.usagePattern : undefined,
    missingIncludeError:
      typeof spec.missingIncludeError === 'string' && spec.missingIncludeError.trim()
        ? spec.missingIncludeError.trim()
        : undefined,
    transpile: typeof spec.transpile === 'function' ? spec.transpile : undefined,
    createBindings: spec.createBindings
  };

  ARDUINO_LIBRARY_REGISTRY.set(header, normalized);
  return normalized;
}

/**
 * Resolve an `#include` header string (e.g. `'FIR.h'`, `'FIR/FIR.h'`, `'fir.h'`)
 * against registered Arduino libraries.
 *
 * @param {string} headerName
 */
export function resolveArduinoLibrary(headerName) {
  if (typeof headerName !== 'string') return null;
  const trimmed = headerName.trim();
  if (!trimmed) return null;

  if (ARDUINO_LIBRARY_REGISTRY.has(trimmed)) {
    return ARDUINO_LIBRARY_REGISTRY.get(trimmed);
  }

  const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
  if (ARDUINO_LIBRARY_REGISTRY.has(baseName)) {
    return ARDUINO_LIBRARY_REGISTRY.get(baseName);
  }

  const lower = trimmed.toLowerCase();
  const baseLower = baseName.toLowerCase();

  for (const lib of ARDUINO_LIBRARY_REGISTRY.values()) {
    if (lib.header.toLowerCase() === lower || lib.header.toLowerCase() === baseLower) {
      return lib;
    }
    for (const alias of lib.aliases) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower === lower || aliasLower === baseLower) {
        return lib;
      }
    }
  }

  return null;
}

/**
 * List metadata for all currently supported Arduino libraries.
 *
 * @returns {Array<{ header: string, aliases: string[], name: string, description: string, repoUrl: string }>}
 */
export function getSupportedArduinoLibraries() {
  return Array.from(ARDUINO_LIBRARY_REGISTRY.values(), (lib) => ({
    header: lib.header,
    aliases: [...lib.aliases],
    name: lib.name,
    description: lib.description,
    repoUrl: lib.repoUrl
  }));
}

/**
 * Detect usage of a registered library in sketch code when its `#include` is missing.
 *
 * @param {string} code
 * @param {Iterable<string>} [includedHeaders=[]]
 * @returns {{ header: string, error: string, line: number } | null}
 */
export function findMissingLibraryInclude(code, includedHeaders = []) {
  if (typeof code !== 'string' || !code) return null;

  const includedSet = new Set();
  if (includedHeaders) {
    for (const header of includedHeaders) {
      const lib = resolveArduinoLibrary(header);
      includedSet.add(lib ? lib.header : String(header).trim());
    }
  }

  for (const lib of ARDUINO_LIBRARY_REGISTRY.values()) {
    if (includedSet.has(lib.header) || !(lib.usagePattern instanceof RegExp)) {
      continue;
    }
    lib.usagePattern.lastIndex = 0;
    const match = lib.usagePattern.exec(code);
    if (match) {
      const line = code.slice(0, match.index).split('\n').length;
      const error =
        lib.missingIncludeError ||
        `Library ${lib.name} requires #include <${lib.header}> at the top of your sketch.`;
      return { header: lib.header, error, line };
    }
  }

  return null;
}

/**
 * Run library-specific C++ -> JS transpiler passes for all included headers.
 * Deduplicates by canonical library header.
 *
 * @param {string} code
 * @param {string[]} [includedHeaders=[]]
 * @returns {string}
 */
export function applyLibraryTranspilers(code, includedHeaders = []) {
  if (typeof code !== 'string' || !Array.isArray(includedHeaders) || includedHeaders.length === 0) {
    return code;
  }

  let transformed = code;
  const seen = new Set();

  for (const header of includedHeaders) {
    const lib = resolveArduinoLibrary(header);
    if (!lib || seen.has(lib.header)) continue;
    seen.add(lib.header);
    if (typeof lib.transpile === 'function') {
      transformed = lib.transpile(transformed);
    }
  }

  return transformed;
}

/**
 * Create fresh per-runner runtime bindings for all included library headers.
 * Deduplicates by canonical library header.
 *
 * @param {string[]} [includedHeaders=[]]
 * @returns {Record<string, unknown>}
 */
export function createLibraryBindings(includedHeaders = []) {
  const bindings = {};
  if (!Array.isArray(includedHeaders) || includedHeaders.length === 0) {
    return bindings;
  }

  const seen = new Set();
  for (const header of includedHeaders) {
    const lib = resolveArduinoLibrary(header);
    if (!lib || seen.has(lib.header)) continue;
    seen.add(lib.header);
    const libBindings = lib.createBindings();
    if (libBindings && typeof libBindings === 'object') {
      Object.assign(bindings, libBindings);
    }
  }

  return bindings;
}

/* -------------------------------------------------------------------------- */
/* Built-in Library: FIR.h (LeemanGeophysicalLLC/FIR_Filter_Arduino_Library)  */
/* -------------------------------------------------------------------------- */

const FIR_TEMPLATE_DECL_RE =
  /(^|(?<=[;{}\n]))([ \t]*)(static\s+)?FIR\s*<\s*([A-Za-z_][\w\s]*?)\s*,\s*([^>]+?)\s*>\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*;/g;

function transpileFirTemplates(code) {
  return code.replace(
    FIR_TEMPLATE_DECL_RE,
    (_, _boundary, indent, staticMod, rawType, rawTaps, rawNames) => {
      const typeStr = rawType.replace(/\s+/g, ' ').trim();
      const tapsExpr = rawTaps.trim();
      const names = rawNames
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      const declarators = names
        .map((name) => `${name} = new FIR(${JSON.stringify(typeStr)}, ${tapsExpr})`)
        .join(', ');
      const staticPrefix = staticMod ? 'static ' : '';
      return `${indent}${staticPrefix}let ${declarators};`;
    }
  );
}

function createFirBindings() {
  class FIR {
    constructor(typeName, ntaps) {
      this._isInt = /^(int|long|short|byte|uint|int\d+|unsigned|signed|char|word|size_t)/i.test(
        String(typeName || 'float').trim()
      );
      this._ntaps = Math.min(4096, Math.max(1, Math.trunc(Number(ntaps) || 1)));
      this._values = new Array(this._ntaps).fill(0);
      this._coeffs = new Array(this._ntaps).fill(0);
      this._gain = 1;
      this._k = 0;
    }

    setGain(newgain) {
      const g = Number(newgain);
      const safe = Number.isFinite(g) ? g : 0;
      this._gain = this._isInt ? Math.trunc(safe) : safe;
    }

    getGain() {
      return this._gain;
    }

    setFilterCoeffs(coeffs) {
      this._values.fill(0);
      this._k = 0;

      for (let i = 0; i < this._ntaps; i += 1) {
        const raw = coeffs && coeffs.length !== undefined ? Number(coeffs[i] ?? 0) : 0;
        const safe = Number.isFinite(raw) ? raw : 0;
        this._coeffs[i] = this._isInt ? Math.trunc(safe) : safe;
      }

      this._gain = 1;
      let newGain = 0;
      for (let i = 0; i < this._ntaps; i += 1) {
        newGain = this.processReading(1);
      }
      this._values.fill(0);
      this._k = 0;
      if (!this._isInt && Math.abs(newGain) < 1e-12) {
        newGain = 0;
      }
      this.setGain(newGain);
    }

    processReading(newval) {
      const raw = Number(newval);
      const safe = Number.isFinite(raw) ? raw : 0;
      const val = this._isInt ? Math.trunc(safe) : safe;

      this._values[this._k] = val;

      let output = 0;
      for (let i = 0; i < this._ntaps; i += 1) {
        output += this._coeffs[i] * this._values[(i + this._k) % this._ntaps];
      }

      this._k = (this._k + 1) % this._ntaps;

      if (!this._gain) return 0;
      return this._isInt ? Math.trunc(output / this._gain) : output / this._gain;
    }
  }

  return { FIR };
}

registerArduinoLibrary({
  header: 'FIR.h',
  aliases: ['FIR_Filter.h'],
  name: 'FIR Filter (Leeman Geophysical LLC)',
  description:
    'Templated Finite Impulse Response (FIR) digital filter library with automatic DC gain normalization.',
  repoUrl: 'https://github.com/LeemanGeophysicalLLC/FIR_Filter_Arduino_Library',
  usagePattern: /\bFIR\s*</,
  missingIncludeError: 'FIR filter requires #include <FIR.h> at the top of your sketch.',
  transpile: transpileFirTemplates,
  createBindings: createFirBindings
});
