import { clamp } from './linearAlgebra.js';
import {
  resolveArduinoLibrary,
  findMissingLibraryInclude,
  applyLibraryTranspilers,
  createLibraryBindings
} from './arduinoLibraries.js';

/**
 * Zero-dependency Arduino Nano C++ subset transpiler, sandboxed async runtime,
 * Serial Plotter parser, and built-in educational sketches.
 *
 * Browser + Node ES2022+ compatible (no DOM, no bundler, no external packages).
 */

export const ARDUINO_NANO_PWM_PINS = new Set(['D3', 'D5', 'D6', 'D9', 'D10', 'D11']);
export const ARDUINO_NANO_ANALOG_ONLY_PINS = new Set(['A6', 'A7']);

const DIGITAL_PIN_IDS = Array.from({ length: 14 }, (_, i) => `D${i}`);
const ANALOG_PIN_IDS = Array.from({ length: 8 }, (_, i) => `A${i}`);
const ALL_GPIO_PIN_IDS = [...DIGITAL_PIN_IDS, ...ANALOG_PIN_IDS];

const SUPPORTED_INCLUDES = new Set([
  'Arduino.h',
  'math.h',
  'stdint.h',
  'stdbool.h',
  'stdlib.h',
  'string.h'
]);

const RADIX_CONSTANTS = Object.freeze({
  DEC: Object.freeze({ __radix: 10 }),
  HEX: Object.freeze({ __radix: 16 }),
  OCT: Object.freeze({ __radix: 8 }),
  BIN: Object.freeze({ __radix: 2 })
});

const C_TYPE_PATTERN =
  '(?:(?:unsigned|signed)\\s+)?(?:void|int|long|short|byte|word|char|bool|boolean|float|double|String|size_t|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t)';
const SCALAR_TYPE_PATTERN =
  '(?:(?:unsigned|signed)\\s+)?(?:int|long|short|byte|word|char|bool|boolean|float|double|String|size_t|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t)';

const SANDBOX_SHADOWED_GLOBALS = [
  'window',
  'document',
  'fetch',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'opener',
  'process',
  'require',
  'module',
  'exports',
  'XMLHttpRequest',
  'WebSocket',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator',
  'location',
  'setTimeout',
  'setInterval',
  'Proxy',
  'Reflect',
  'alert',
  'confirm',
  'prompt',
  'eval',
  'Function'
];

const FORBIDDEN_ESCAPE_RE =
  /\b(constructor|__proto__|prototype|eval|Function|window|document|globalThis|self|top|parent|frames|opener|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|import)\b/;

class SketchAbortError extends Error {
  constructor() {
    super('Sketch execution stopped');
    this.name = 'SketchAbortError';
  }
}

/**
 * Map an Arduino pin argument to a canonical breadboard Arduino Nano pin ID.
 * - 0..13 -> 'D0'..'D13'
 * - 14..21 -> 'A0'..'A7'
 * - 'D0'..'D13' / 'A0'..'A7' (case-insensitive) -> canonical form
 * Returns null if invalid.
 *
 * @param {number|string} pinArg
 * @returns {string|null}
 */
export function normalizeArduinoPinId(pinArg) {
  if (typeof pinArg === 'boolean' || pinArg === null || pinArg === undefined) {
    return null;
  }

  if (typeof pinArg === 'number') {
    if (!Number.isInteger(pinArg)) return null;
    if (pinArg >= 0 && pinArg <= 13) return `D${pinArg}`;
    if (pinArg >= 14 && pinArg <= 21) return `A${pinArg - 14}`;
    return null;
  }

  if (typeof pinArg !== 'string') return null;

  const trimmed = pinArg.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (num >= 0 && num <= 13) return `D${num}`;
    if (num >= 14 && num <= 21) return `A${num - 14}`;
    return null;
  }

  const upper = trimmed.toUpperCase();
  const dMatch = /^D(\d+)$/.exec(upper);
  if (dMatch) {
    const num = Number(dMatch[1]);
    return num >= 0 && num <= 13 ? `D${num}` : null;
  }

  const aMatch = /^A(\d+)$/.exec(upper);
  if (aMatch) {
    const num = Number(aMatch[1]);
    return num >= 0 && num <= 7 ? `A${num}` : null;
  }

  return null;
}

const NUMERIC_TOKEN_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;
const LABELED_TOKEN_RE = /^([^:=]+?)[:=]([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;

/**
 * Parse a single Serial.println(...) line into Serial Plotter channel points.
 * Supports unlabeled numbers ("512, 2.50", "512\t2.50", "512 2.50") and
 * labeled pairs ("ADC:512, Volts:2.50", "EMG=1.24\tThresh=0.80").
 * Returns null if the line contains no valid numeric plotter readings.
 *
 * @param {string} line
 * @returns {Array<{ label: string, value: number }>|null}
 */
export function parseSerialPlotterLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Allow optional whitespace after ':' or '=' (e.g. "ADC: 512, Volts: 2.50").
  const normalized = trimmed.replace(/([:=])\s+/g, '$1');
  const hasDelim = normalized.includes(',') || normalized.includes('\t');
  const rawTokens = hasDelim
    ? normalized.split(/[\t,]+/)
    : normalized.split(/\s+/);

  const tokens = rawTokens.map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  const parsed = [];
  let unlabeledIndex = 1;

  for (const token of tokens) {
    const numMatch = NUMERIC_TOKEN_RE.exec(token);
    if (numMatch) {
      const value = Number(numMatch[1]);
      if (!Number.isFinite(value)) return null;
      parsed.push({ label: `CH${unlabeledIndex}`, value });
      unlabeledIndex += 1;
      continue;
    }

    const labeledMatch = LABELED_TOKEN_RE.exec(token);
    if (labeledMatch) {
      const label = labeledMatch[1].trim();
      const value = Number(labeledMatch[2]);
      if (!label || !Number.isFinite(value)) return null;
      parsed.push({ label, value });
      continue;
    }

    // Reject lines containing non-numeric prose tokens (e.g. "Ready!", "LED ON").
    return null;
  }

  return parsed.length > 0 ? parsed : null;
}

/**
 * Preserve newlines inside a replaced span so original line numbers remain exact.
 * @param {string} text
 * @returns {string}
 */
function blankPreservingNewlines(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Single-pass lexer that strips // and /* ... *\/ comments and protects
 * string ("...") and char ('...') literals with placeholders while preserving
 * exact line numbers.
 *
 * @param {string} source
 * @returns {{ ok: true, code: string, literals: string[] } | { ok: false, error: string, line: number }}
 */
function stripCommentsAndProtectLiterals(source) {
  const literals = [];
  let out = '';
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const startLine = line;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (source[i] === '\n') {
          out += '\n';
          line += 1;
        }
        i += 1;
      }
      if (!closed) {
        return { ok: false, error: 'Unterminated block comment (/* ... */).', line: startLine };
      }
      out += ' ';
      continue;
    }

    // String or char literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      let literal = quote;
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
          if (i + 1 >= source.length) break;
          literal += c + source[i + 1];
          if (source[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        if (c === '\n') {
          break;
        }
        literal += c;
        i += 1;
        if (c === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        return {
          ok: false,
          error: quote === '"' ? 'Unterminated string literal.' : 'Unterminated character literal.',
          line: startLine
        };
      }
      const token = `__ARD_LIT_${literals.length}__`;
      literals.push(literal);
      out += token;
      continue;
    }

    if (ch === '\n') {
      line += 1;
    }
    out += ch;
    i += 1;
  }

  return { ok: true, code: out, literals };
}

/**
 * Restore literal placeholders back to their original string/char text.
 * @param {string} code
 * @param {string[]} literals
 * @returns {string}
 */
function restoreLiterals(code, literals) {
  return code.replace(/__ARD_LIT_(\d+)__/g, (_, idx) => literals[Number(idx)] ?? '');
}

/**
 * Check delimiter balance on comment/literal-stripped code to pinpoint syntax line errors.
 * @param {string} code
 * @returns {{ ok: true } | { ok: false, error: string, line: number }}
 */
function checkBalancedDelimiters(code) {
  const stack = [];
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const closingToOpening = { ')': '(', '}': '{', ']': '[' };
  let line = 1;

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '\n') {
      line += 1;
      continue;
    }
    if (pairs[ch]) {
      stack.push({ ch, line });
    } else if (closingToOpening[ch]) {
      const top = stack.pop();
      if (!top || top.ch !== closingToOpening[ch]) {
        return {
          ok: false,
          error: `Unexpected '${ch}' with no matching '${closingToOpening[ch]}'.`,
          line
        };
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return {
      ok: false,
      error: `Unclosed '${unclosed.ch}' (missing '${pairs[unclosed.ch]}').`,
      line: unclosed.line
    };
  }

  return { ok: true };
}

/**
 * Find the matching closing parenthesis index starting from an opening '(' index.
 * @param {string} code
 * @param {number} openIdx
 * @returns {number}
 */
function findMatchingParen(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find the matching closing brace index starting from an opening '{' index.
 * @param {string} code
 * @param {number} openIdx
 * @returns {number}
 */
function findMatchingBrace(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Convert typed C++ function parameter list "(int a, const String& s)" -> "(a, s)".
 * @param {string} paramList
 * @returns {string}
 */
function stripParamTypes(paramList) {
  const trimmed = paramList.trim();
  if (!trimmed || trimmed === 'void') return '';

  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  const cleaned = parts.map((raw) => {
    const eqIdx = raw.indexOf('=');
    const lhs = (eqIdx >= 0 ? raw.slice(0, eqIdx) : raw).replace(/\[\s*\]/g, '').trim();
    const rhs = eqIdx >= 0 ? ` = ${raw.slice(eqIdx + 1).trim()}` : '';
    const tokens = lhs.replace(/[&*]/g, ' ').trim().split(/\s+/);
    const name = tokens[tokens.length - 1] || '';
    return `${name}${rhs}`;
  });

  return cleaned.join(', ');
}

/**
 * Convert C++ scalar default value when a variable is declared without an initializer.
 * @param {string} rawType
 * @returns {string}
 */
function defaultInitializerForType(rawType) {
  const t = rawType.trim();
  if (t === 'String') return '""';
  if (t === 'bool' || t === 'boolean') return 'false';
  return '0';
}

/**
 * Convert C++ braced array initializer "{1, 2, 3}" -> "[1, 2, 3]".
 * @param {string} initializer
 * @returns {string}
 */
function convertBracedInitializer(initializer) {
  const trimmed = initializer.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return `[${trimmed.slice(1, -1)}]`;
  }
  return trimmed;
}

/**
 * Scan forward from the start of a single-statement braceless loop body to the end
 * of that statement (handling nested blocks, if/else chains, and nested loops).
 * Returns the index immediately after the terminating token (`;` or `}`), or -1 if incomplete.
 *
 * @param {string} code
 * @param {number} startIdx
 * @returns {number}
 */
function findStatementEnd(code, startIdx) {
  let i = startIdx;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (i >= code.length) return -1;

  if (code[i] === '{') {
    const closeBrace = findMatchingBrace(code, i);
    return closeBrace >= 0 ? closeBrace + 1 : -1;
  }

  if (code[i] === ';') {
    return i + 1;
  }

  const prevWordStart = (idx) => idx === 0 || !/[A-Za-z0-9_$]/.test(code[idx - 1]);

  // Handle nested control statements as single statements: if (...) stmt [else stmt], for/while (...) stmt, do stmt while (...);
  if (prevWordStart(i) && code.slice(i, i + 2) === 'if' && !/[A-Za-z0-9_$]/.test(code[i + 2] || '')) {
    let j = i + 2;
    while (j < code.length && /\s/.test(code[j])) j += 1;
    if (code[j] === '(') {
      const closeParen = findMatchingParen(code, j);
      if (closeParen >= 0) {
        const thenEnd = findStatementEnd(code, closeParen + 1);
        if (thenEnd < 0) return -1;
        let k = thenEnd;
        while (k < code.length && /\s/.test(code[k])) k += 1;
        if (code.slice(k, k + 4) === 'else' && !/[A-Za-z0-9_$]/.test(code[k + 4] || '')) {
          return findStatementEnd(code, k + 4);
        }
        return thenEnd;
      }
    }
  }

  if (
    prevWordStart(i) &&
    ((code.slice(i, i + 5) === 'while' && !/[A-Za-z0-9_$]/.test(code[i + 5] || '')) ||
      (code.slice(i, i + 3) === 'for' && !/[A-Za-z0-9_$]/.test(code[i + 3] || '')))
  ) {
    const kwLen = code[i] === 'w' ? 5 : 3;
    let j = i + kwLen;
    while (j < code.length && /\s/.test(code[j])) j += 1;
    if (code[j] === '(') {
      const closeParen = findMatchingParen(code, j);
      if (closeParen >= 0) {
        return findStatementEnd(code, closeParen + 1);
      }
    }
  }

  if (prevWordStart(i) && code.slice(i, i + 2) === 'do' && !/[A-Za-z0-9_$]/.test(code[i + 2] || '')) {
    const bodyEnd = findStatementEnd(code, i + 2);
    if (bodyEnd < 0) return -1;
    let k = bodyEnd;
    while (k < code.length && /\s/.test(code[k])) k += 1;
    if (code.slice(k, k + 5) === 'while' && !/[A-Za-z0-9_$]/.test(code[k + 5] || '')) {
      let p = k + 5;
      while (p < code.length && /\s/.test(code[p])) p += 1;
      if (code[p] === '(') {
        const closeParen = findMatchingParen(code, p);
        if (closeParen >= 0) {
          let semi = closeParen + 1;
          while (semi < code.length && /\s/.test(code[semi])) semi += 1;
          if (code[semi] === ';') return semi + 1;
          return closeParen + 1;
        }
      }
    }
    return bodyEnd;
  }

  let depth = 0;
  for (let j = i; j < code.length; j += 1) {
    const ch = code[j];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) depth -= 1;
    } else if (ch === ';' && depth === 0) {
      return j + 1;
    }
  }

  return -1;
}

/**
 * Inject cooperative `await __guard();` checks into for / while / do loops.
 * Handles braced blocks, single-statement braceless bodies, and empty-statement loops.
 *
 * @param {string} code
 * @returns {string}
 */
function injectLoopGuards(code) {
  let result = '';
  let i = 0;
  const doWhileHeaderIndices = new Set();

  // First pass: mark `while (...)` headers that belong to `do ... while (...);`
  for (let idx = 0; idx < code.length; idx += 1) {
    if (
      code.slice(idx, idx + 2) === 'do' &&
      (idx === 0 || !/[A-Za-z0-9_$]/.test(code[idx - 1])) &&
      !/[A-Za-z0-9_$]/.test(code[idx + 2] || '')
    ) {
      let j = idx + 2;
      while (j < code.length && /\s/.test(code[j])) j += 1;
      const bodyEnd =
        code[j] === '{'
          ? (() => {
              const closeBrace = findMatchingBrace(code, j);
              return closeBrace >= 0 ? closeBrace + 1 : -1;
            })()
          : findStatementEnd(code, j);
      if (bodyEnd >= 0) {
        let k = bodyEnd;
        while (k < code.length && /\s/.test(code[k])) k += 1;
        if (code.slice(k, k + 5) === 'while' && !/[A-Za-z0-9_$]/.test(code[k + 5] || '')) {
          doWhileHeaderIndices.add(k);
        }
      }
    }
  }

  while (i < code.length) {
    const prevCh = i > 0 ? code[i - 1] : '';
    const isWordStart = !prevCh || !/[A-Za-z0-9_$]/.test(prevCh);

    if (isWordStart && code.slice(i, i + 2) === 'do' && !/[A-Za-z0-9_$]/.test(code[i + 2] || '')) {
      let j = i + 2;
      while (j < code.length && /\s/.test(code[j])) j += 1;
      if (code[j] === '{') {
        result += `${code.slice(i, j + 1)} await __guard();`;
        i = j + 1;
        continue;
      }
      const stmtEnd = findStatementEnd(code, j);
      if (stmtEnd > j) {
        const innerBody = injectLoopGuards(code.slice(j, stmtEnd));
        result += `${code.slice(i, j)}{ await __guard(); ${innerBody} }`;
        i = stmtEnd;
        continue;
      }
    }

    if (
      isWordStart &&
      !doWhileHeaderIndices.has(i) &&
      ((code.slice(i, i + 5) === 'while' && !/[A-Za-z0-9_$]/.test(code[i + 5] || '')) ||
        (code.slice(i, i + 3) === 'for' && !/[A-Za-z0-9_$]/.test(code[i + 3] || '')))
    ) {
      const kwLen = code[i] === 'w' ? 5 : 3;
      let j = i + kwLen;
      while (j < code.length && /\s/.test(code[j])) j += 1;
      if (code[j] === '(') {
        const closeParen = findMatchingParen(code, j);
        if (closeParen >= 0) {
          let k = closeParen + 1;
          while (k < code.length && /\s/.test(code[k])) k += 1;
          if (code[k] === '{') {
            result += `${code.slice(i, k + 1)} await __guard();`;
            i = k + 1;
            continue;
          }
          if (code[k] === ';') {
            result += `${code.slice(i, closeParen + 1)} { await __guard(); }`;
            i = k + 1;
            continue;
          }
          const stmtEnd = findStatementEnd(code, k);
          if (stmtEnd > k) {
            const innerBody = injectLoopGuards(code.slice(k, stmtEnd));
            result += `${code.slice(i, closeParen + 1)} { await __guard(); ${innerBody} }`;
            i = stmtEnd;
            continue;
          }
        }
      }
    }

    result += code[i];
    i += 1;
  }

  return result;
}

/**
 * Rewrite calls to user-defined async functions and delay/delayMicroseconds with `await`.
 *
 * @param {string} code
 * @param {Set<string>} asyncFnNames
 * @returns {string}
 */
function injectAwaitOnAsyncCalls(code, asyncFnNames) {
  if (asyncFnNames.size === 0) return code;

  let result = '';
  let i = 0;

  while (i < code.length) {
    if (/[A-Za-z_$]/.test(code[i]) && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]))) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_$]/.test(code[end])) end += 1;
      const ident = code.slice(i, end);

      if (asyncFnNames.has(ident)) {
        // Check context before identifier
        let prevIdx = i - 1;
        while (prevIdx >= 0 && /\s/.test(code[prevIdx])) prevIdx -= 1;
        const prevChar = prevIdx >= 0 ? code[prevIdx] : '';
        const beforeSlice = code.slice(Math.max(0, prevIdx - 12), prevIdx + 1);
        const isDeclaration = /\bfunction$/.test(beforeSlice);
        const isAlreadyAwaited = /\bawait$/.test(beforeSlice);
        const isMemberCall = prevChar === '.';

        let parenIdx = end;
        while (parenIdx < code.length && /\s/.test(code[parenIdx])) parenIdx += 1;

        if (!isDeclaration && !isAlreadyAwaited && !isMemberCall && code[parenIdx] === '(') {
          const closeParen = findMatchingParen(code, parenIdx);
          if (closeParen >= 0) {
            const innerArgs = injectAwaitOnAsyncCalls(
              code.slice(parenIdx + 1, closeParen),
              asyncFnNames
            );
            result += `(await ${ident}(${innerArgs}))`;
            i = closeParen + 1;
            continue;
          }
        }
      }

      result += ident;
      i = end;
      continue;
    }

    result += code[i];
    i += 1;
  }

  return result;
}

/**
 * Split a comma-separated declarator list (e.g. `a = 1, b, c = foo(1, 2)`) at top-level commas,
 * and append default initializers to any uninitialized declarators.
 *
 * @param {string} rest
 * @param {string} rawType
 * @returns {string}
 */
function formatVariableDeclarators(rest, rawType) {
  const trailingSemi = rest.endsWith(';');
  const body = trailingSemi ? rest.slice(0, -1) : rest;
  const parts = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let current = '';

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}' && braceDepth > 0) braceDepth -= 1;

    if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const defaultVal = defaultInitializerForType(rawType);
  const formatted = parts.map((part) => {
    const leading = /^\s*/.exec(part)?.[0] || '';
    const trimmed = part.trim();
    if (!trimmed) return part;
    // Check if there is a top-level '=' assignment
    let pDepth = 0;
    let bDepth = 0;
    let cDepth = 0;
    let hasEq = false;
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === '(') pDepth += 1;
      else if (ch === ')' && pDepth > 0) pDepth -= 1;
      else if (ch === '[') bDepth += 1;
      else if (ch === ']' && bDepth > 0) bDepth -= 1;
      else if (ch === '{') cDepth += 1;
      else if (ch === '}' && cDepth > 0) cDepth -= 1;
      else if (ch === '=' && pDepth === 0 && bDepth === 0 && cDepth === 0) {
        hasEq = true;
        break;
      }
    }
    if (hasEq) {
      return part;
    }
    return `${leading}${trimmed} = ${defaultVal}`;
  });

  return `${formatted.join(',')}${trailingSemi ? ';' : ''}`;
}

/**
 * Rewrite identifier references inside a function body, skipping property access (`.name`)
 * and declarations.
 *
 * @param {string} body
 * @param {Map<string, string>} renameMap
 * @returns {string}
 */
function rewriteIdentifiersInBody(body, renameMap) {
  if (renameMap.size === 0) return body;
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (/[A-Za-z_$]/.test(body[i]) && (i === 0 || !/[A-Za-z0-9_$]/.test(body[i - 1]))) {
      let end = i + 1;
      while (end < body.length && /[A-Za-z0-9_$]/.test(body[end])) end += 1;
      const ident = body.slice(i, end);
      const replacement = renameMap.get(ident);
      if (replacement) {
        let prevIdx = i - 1;
        while (prevIdx >= 0 && /\s/.test(body[prevIdx])) prevIdx -= 1;
        const isMember = prevIdx >= 0 && body[prevIdx] === '.';
        out += isMember ? ident : replacement;
      } else {
        out += ident;
      }
      i = end;
      continue;
    }
    out += body[i];
    i += 1;
  }
  return out;
}

/**
 * Hoist function-local `static <type> <name> [= <init>];` declarations to top-level
 * unique variables (`__static_<idx>_<name>`) so values persist across `loop()` calls.
 *
 * @param {string} code
 * @returns {string}
 */
function hoistFunctionStaticVariables(code) {
  const hoistedDecls = [];
  let staticCounter = 0;
  let result = '';
  let cursor = 0;

  const asyncFnRe = /\basync\s+function\s+[A-Za-z_]\w*\s*\([^)]*\)\s*\{/g;
  const staticDeclRe = new RegExp(
    `(^|[;{}\n])([ \\t]*)static\\s+(?:const\\s+)?(${SCALAR_TYPE_PATTERN})\\s*[&*]?\\s+([A-Za-z_]\\w*)(?:\\s*=\\s*([^;]+))?\\s*;`,
    'g'
  );
  const staticArrayInitRe = new RegExp(
    `(^|[;{}\n])([ \\t]*)static\\s+(?:const\\s+)?(${SCALAR_TYPE_PATTERN})\\s+([A-Za-z_]\\w*)\\s*\\[[^\\]]*\\]\\s*=\\s*(\\{[^;]*\\})\\s*;`,
    'g'
  );
  const staticArrayDeclRe = new RegExp(
    `(^|[;{}\n])([ \\t]*)static\\s+(?:const\\s+)?(${SCALAR_TYPE_PATTERN})\\s+([A-Za-z_]\\w*)\\s*\\[([^\\]]+)\\]\\s*;`,
    'g'
  );

  const staticJsLetRe = /(^|[;{}\n])([ \t]*)static\s+let\s+([^;]+);/g;

  let match;
  while ((match = asyncFnRe.exec(code)) !== null) {
    const openBraceIdx = match.index + match[0].length - 1;
    const closeBraceIdx = findMatchingBrace(code, openBraceIdx);
    if (closeBraceIdx < 0) continue;

    result += code.slice(cursor, openBraceIdx + 1);
    let fnBody = code.slice(openBraceIdx + 1, closeBraceIdx);
    const renameMap = new Map();

    fnBody = fnBody.replace(staticJsLetRe, (_, prefix, _indent, declaratorsStr) => {
      const parts = [];
      let pDepth = 0;
      let bDepth = 0;
      let cDepth = 0;
      let cur = '';
      for (let i = 0; i < declaratorsStr.length; i += 1) {
        const ch = declaratorsStr[i];
        if (ch === '(') pDepth += 1;
        else if (ch === ')' && pDepth > 0) pDepth -= 1;
        else if (ch === '[') bDepth += 1;
        else if (ch === ']' && bDepth > 0) bDepth -= 1;
        else if (ch === '{') cDepth += 1;
        else if (ch === '}' && cDepth > 0) cDepth -= 1;
        if (ch === ',' && pDepth === 0 && bDepth === 0 && cDepth === 0) {
          parts.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) parts.push(cur.trim());

      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        const name = (eqIdx >= 0 ? part.slice(0, eqIdx) : part).trim();
        const initExpr = eqIdx >= 0 ? part.slice(eqIdx + 1).trim() : 'undefined';
        if (/^[A-Za-z_]\w*$/.test(name)) {
          const hoistedName = `__static_${staticCounter}_${name}`;
          staticCounter += 1;
          hoistedDecls.push(`let ${hoistedName} = ${initExpr};`);
          renameMap.set(name, hoistedName);
        }
      }
      return prefix;
    });

    fnBody = fnBody.replace(staticArrayInitRe, (_, prefix, _indent, _type, name, init) => {
      const hoistedName = `__static_${staticCounter}_${name}`;
      staticCounter += 1;
      hoistedDecls.push(`let ${hoistedName} = ${convertBracedInitializer(init)};`);
      renameMap.set(name, hoistedName);
      return prefix;
    });

    fnBody = fnBody.replace(staticArrayDeclRe, (_, prefix, _indent, rawType, name, sizeExpr) => {
      const hoistedName = `__static_${staticCounter}_${name}`;
      staticCounter += 1;
      const fillVal = defaultInitializerForType(rawType);
      hoistedDecls.push(`let ${hoistedName} = new Array(${sizeExpr.trim()}).fill(${fillVal});`);
      renameMap.set(name, hoistedName);
      return prefix;
    });

    fnBody = fnBody.replace(staticDeclRe, (_, prefix, _indent, rawType, name, init) => {
      const hoistedName = `__static_${staticCounter}_${name}`;
      staticCounter += 1;
      const initExpr = init !== undefined ? init.trim() : defaultInitializerForType(rawType);
      hoistedDecls.push(`let ${hoistedName} = ${initExpr};`);
      renameMap.set(name, hoistedName);
      return prefix;
    });

    result += rewriteIdentifiersInBody(fnBody, renameMap);
    cursor = closeBraceIdx;
    asyncFnRe.lastIndex = closeBraceIdx + 1;
  }

  result += code.slice(cursor);
  // Strip any remaining top-level `static let` declarations (e.g., global `static FIR<...>`)
  result = result.replace(/(^|[;{}\n])([ \t]*)static\s+let\b/g, '$1$2let');

  if (hoistedDecls.length > 0) {
    return `${hoistedDecls.join(' ')} ${result}`;
  }
  return result;
}

/**
 * Extract an approximate 1-indexed line number from a JS SyntaxError stack if available,
 * or locate the offending line by testing single-line neutralization while preserving braces.
 * @param {Error} err
 * @param {number} headerLineCount
 * @param {string} [transpiledCode]
 * @returns {number}
 */
function extractSyntaxErrorLine(err, headerLineCount, transpiledCode = '') {
  if (typeof err?.lineNumber === 'number' && err.lineNumber > headerLineCount) {
    return err.lineNumber - headerLineCount;
  }

  const stack = String(err?.stack || '');
  const match = /<anonymous>:(\d+):\d+/.exec(stack);
  if (match) {
    return Math.max(1, Number(match[1]) - headerLineCount);
  }

  if (transpiledCode) {
    const lines = transpiledCode.split('\n');
    const maxScan = Math.min(lines.length, 400);
    for (let i = 0; i < maxScan; i += 1) {
      if (!lines[i].trim()) continue;
      const candidate = [...lines];
      candidate[i] = lines[i].replace(/[^{}]/g, '');
      try {
        new Function('__env', ...SANDBOX_SHADOWED_GLOBALS, buildSandboxedBody(candidate.join('\n')));
        return i + 1;
      } catch {
        // Continue scanning
      }
    }
  }

  return 1;
}

function getHeaderLineCount(libraryBindingNames = []) {
  const marker = '__ARD_HEADER_SPLIT__';
  const emptyWrapped = buildSandboxedBody(marker, libraryBindingNames);
  const idx = emptyWrapped.indexOf(marker);
  if (idx < 0) return 0;
  return emptyWrapped.slice(0, idx).split('\n').length - 1;
}

/**
 * Transpile an Arduino C++ subset sketch into an isolated async JavaScript module string.
 *
 * @param {string} sourceCode
 * @returns {{ ok: true, jsCode: string, warnings: string[], includedHeaders: string[] } | { ok: false, error: string, line: number }}
 */
export function transpileArduinoSketch(sourceCode) {
  if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
    return { ok: false, error: 'Sketch source code is empty.', line: 1 };
  }

  const warnings = [];
  const includedHeaders = [];
  const includedHeaderSet = new Set();
  const normalizedSource = sourceCode.replace(/\r\n?/g, '\n');

  // 1. Strip comments and protect string/char literals while preserving line numbers.
  const lexed = stripCommentsAndProtectLiterals(normalizedSource);
  if (!lexed.ok) {
    return lexed;
  }

  let code = lexed.code;

  // 1b. Block forbidden JS sandbox escape identifiers/keywords.
  const escapeMatch = FORBIDDEN_ESCAPE_RE.exec(code);
  if (escapeMatch) {
    const line = code.slice(0, escapeMatch.index).split('\n').length;
    return {
      ok: false,
      error: `Restricted keyword "${escapeMatch[1]}" is not allowed in Arduino sketches.`,
      line
    };
  }

  // 2. Check delimiter balance early for crisp line numbers on missing braces/parens.
  const balanceCheck = checkBalancedDelimiters(code);
  if (!balanceCheck.ok) {
    return balanceCheck;
  }

  // 3. Process #include and #define directives (preserving line count).
  const defines = [];
  const lines = code.split('\n');
  const processedLines = lines.map((lineText) => {
    const trimmed = lineText.trim();

    if (/^#\s*include\b/.test(trimmed)) {
      const rawLine = restoreLiterals(trimmed, lexed.literals);
      const incMatch = /^#\s*include\s*[<"]([^>"]+)[>"]/.exec(rawLine);
      if (incMatch) {
        const header = incMatch[1].trim();
        const lib = resolveArduinoLibrary(header);
        if (lib) {
          if (!includedHeaderSet.has(lib.header)) {
            includedHeaderSet.add(lib.header);
            includedHeaders.push(lib.header);
          }
        } else if (!SUPPORTED_INCLUDES.has(header)) {
          warnings.push(
            `External library '#include <${header}>' is not bundled in the browser runtime and was ignored.`
          );
        }
      }
      return '';
    }

    const defMatch = /^#\s*define\s+([A-Za-z_]\w*)(?:\s+(.*))?$/.exec(trimmed);
    if (defMatch) {
      const name = defMatch[1];
      const val = defMatch[2] ? defMatch[2].trim() : '1';
      defines.push({ name, val });
      return '';
    }

    if (/^#\s*(?:pragma|ifdef|ifndef|if|else|elif|endif|undef)\b/.test(trimmed)) {
      return '';
    }

    return lineText;
  });

  code = processedLines.join('\n');

  // 3b. Friendly missing-include diagnostic for known templated libraries (e.g. FIR<...>).
  const missingInclude = findMissingLibraryInclude(code, includedHeaders);
  if (missingInclude) {
    return {
      ok: false,
      error: missingInclude.error,
      line: missingInclude.line
    };
  }

  // Expand #define constants (word-boundary safe).
  for (const { name, val } of defines) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    code = code.replace(re, val);
  }

  // 4. Float & integer numeric suffixes (e.g. 5.0f -> 5.0, 1000UL -> 1000) and trailing decimal floats (1. -> 1.0).
  code = code.replace(/(?<![A-Za-z0-9_])(\d+\.\d*|\.\d+)[fF]\b/g, '$1');
  code = code.replace(/(?<![A-Za-z0-9_.])(\d+)[fF]\b/g, '$1');
  code = code.replace(/(?<![A-Za-z0-9_.])(\d+)[uUlL]{1,2}\b/g, '$1');
  code = code.replace(/(?<![A-Za-z0-9_.])(\d+)\.(?=\s*[,;}\)\]])/g, '$1.0');

  // 4b. Apply registered Arduino library transpilers before general variable declaration passes.
  code = applyLibraryTranspilers(code, includedHeaders);

  // 5. Distinguish function prototypes (`void blinkLed(int ms);`) from C++ direct initialization (`String msg("hi");` / `int count(0);`).
  const typedParamLookahead = new RegExp(`^(?:void|${C_TYPE_PATTERN})\\b`);
  const protoOrDirectInitRe = new RegExp(
    `(^|[;{}\n])([ \\t]*)(?:static\\s+|inline\\s+)?(?:(const)\\s+)?(${C_TYPE_PATTERN})\\s*[&*]?\\s*([A-Za-z_]\\w*)\\s*\\(([^;{}]*)\\)\\s*;`,
    'g'
  );
  code = code.replace(
    protoOrDirectInitRe,
    (full, prefix, indent, isConst, rawType, name, rawArgs) => {
      const trimmedArgs = rawArgs.trim();
      const trimmedType = rawType.trim();
      const isVoidReturn = trimmedType === 'void';
      const looksLikeTypedParams =
        trimmedArgs === '' ||
        trimmedArgs === 'void' ||
        typedParamLookahead.test(trimmedArgs) ||
        /\bconst\s+/.test(trimmedArgs);

      if (isVoidReturn || looksLikeTypedParams) {
        return prefix;
      }

      const kw = isConst ? 'const' : 'let';
      return `${prefix}${indent}${kw} ${name} = (${trimmedArgs});`;
    }
  );

  // 6. Convert function definitions -> async function name(params) {
  const asyncFnNames = new Set(['delay', 'delayMicroseconds']);
  const fnDefRe = new RegExp(
    `(^|[;{}\n])([ \\t]*)(?:static\\s+|inline\\s+)?(?:const\\s+)?${C_TYPE_PATTERN}\\s*[&*]?\\s*([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)\\s*\\{`,
    'g'
  );
  code = code.replace(fnDefRe, (_, prefix, indent, fnName, rawParams) => {
    asyncFnNames.add(fnName);
    const params = stripParamTypes(rawParams);
    return `${prefix}${indent}async function ${fnName}(${params}) {`;
  });

  // 6b. Hoist function-local static variables so state persists across loop() calls.
  code = hoistFunctionStaticVariables(code);

  // 7. Convert C-style casts: (float)5, (int)-x, (int)arr[i], (byte)x, etc.
  const castTarget =
    '([+-]?(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]+\\]|\\([^)]*\\))*|\\d+(?:\\.\\d+)?|\\([^)]*\\)))';
  code = code.replace(
    new RegExp(`\\(\\s*(?:float|double)\\s*\\)\\s*${castTarget}`, 'g'),
    'Number($1)'
  );
  code = code.replace(
    new RegExp(
      `\\(\\s*(?:(?:unsigned|signed)\\s+)?(?:int|long|short|int8_t|int16_t|int32_t|uint16_t|uint32_t)\\s*\\)\\s*${castTarget}`,
      'g'
    ),
    'Math.trunc(Number($1))'
  );
  code = code.replace(
    new RegExp(`\\(\\s*(?:byte|uint8_t|unsigned\\s+char)\\s*\\)\\s*${castTarget}`, 'g'),
    '(Number($1) & 0xFF)'
  );
  code = code.replace(
    new RegExp(`\\(\\s*(?:bool|boolean)\\s*\\)\\s*${castTarget}`, 'g'),
    'Boolean($1)'
  );
  code = code.replace(new RegExp(`\\(\\s*String\\s*\\)\\s*${castTarget}`, 'g'), 'String($1)');

  // 8. Convert typed arrays (including multiline `{ ... }` initializers):
  //    int arr[5] = {1, 2, 3, 4, 5}; -> let arr = [1, 2, 3, 4, 5];
  //    const int pins[] = {2, 3};   -> const pins = [2, 3];
  //    int buf[4];                  -> let buf = new Array(4).fill(0);
  const arrayInitRe = new RegExp(
    `(^|[;{}()\n])([ \\t]*)(?:static\\s+)?(const\\s+)?(${SCALAR_TYPE_PATTERN})\\s+([A-Za-z_]\\w*)\\s*\\[[^\\]]*\\]\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`,
    'g'
  );
  code = code.replace(arrayInitRe, (_, prefix, indent, isConst, _type, name, init) => {
    const kw = isConst ? 'const' : 'let';
    return `${prefix}${indent}${kw} ${name} = ${convertBracedInitializer(init)};`;
  });

  const arrayDeclRe = new RegExp(
    `(^|[;{}()\n])([ \\t]*)(?:static\\s+)?(const\\s+)?(${SCALAR_TYPE_PATTERN})\\s+([A-Za-z_]\\w*)\\s*\\[([^\\]]+)\\]\\s*;`,
    'g'
  );
  code = code.replace(arrayDeclRe, (_, prefix, indent, isConst, rawType, name, sizeExpr) => {
    const kw = isConst ? 'const' : 'let';
    const fillVal = defaultInitializerForType(rawType);
    return `${prefix}${indent}${kw} ${name} = new Array(${sizeExpr.trim()}).fill(${fillVal});`;
  });

  // 9. Convert typed variable declarations (including inside `for (float i = 0; ...)` and multi-var decls `int a, b;`).
  const varDeclRe = new RegExp(
    `(^|[;{}()\n])([ \\t]*)(?:static\\s+|volatile\\s+)?(const\\s+)?(${SCALAR_TYPE_PATTERN})\\s*[&*]?\\s+([A-Za-z_]\\w*(?:\\s*=[^;]*|\\s*,[^;]*|\\s*(?=[;)])))`,
    'g'
  );
  code = code.replace(varDeclRe, (_, prefix, indent, isConst, rawType, rest) => {
    const kw = isConst ? 'const' : 'let';
    const trimmedRest = rest.trimEnd();
    if (!trimmedRest.includes('=') && !trimmedRest.includes(',')) {
      return `${prefix}${indent}${kw} ${trimmedRest} = ${defaultInitializerForType(rawType)}`;
    }
    if (trimmedRest.includes(',')) {
      return `${prefix}${indent}${kw} ${formatVariableDeclarators(rest, rawType)}`;
    }
    return `${prefix}${indent}${kw} ${rest}`;
  });

  // 10. Arduino String methods -> JS equivalents.
  code = code.replace(
    /(^|[;{}\n])([ \t]*)([A-Za-z_]\w*)\.(trim|toUpperCase|toLowerCase)\(\s*\)\s*;/g,
    '$1$2$3 = String($3).$4();'
  );
  code = code.replace(/\.length\(\s*\)/g, '.length');
  code = code.replace(/([A-Za-z_$][\w$]*)\.toInt\(\s*\)/g, '__toInt($1)');
  code = code.replace(/([A-Za-z_$][\w$]*)\.toFloat\(\s*\)/g, '__toFloat($1)');
  code = code.replace(
    /([A-Za-z_$][\w$]*)\.equals\(([^)]+)\)/g,
    '(String($1) === String($2))'
  );
  code = code.replace(
    /([A-Za-z_$][\w$]*)\.equalsIgnoreCase\(([^)]+)\)/g,
    '(String($1).toLowerCase() === String($2).toLowerCase())'
  );

  // 11. Inject cooperative loop guards and await on async calls.
  code = injectLoopGuards(code);
  code = injectAwaitOnAsyncCalls(code, asyncFnNames);

  // 12. Restore string/char literals.
  code = restoreLiterals(code, lexed.literals);

  // 13. Ensure required Arduino entrypoints exist.
  if (!asyncFnNames.has('setup')) {
    return {
      ok: false,
      error: 'Missing required function: void setup() { ... }',
      line: 1
    };
  }
  if (!asyncFnNames.has('loop')) {
    return {
      ok: false,
      error: 'Missing required function: void loop() { ... }',
      line: 1
    };
  }

  // 14. Validate generated JS syntax using new Function without executing it.
  const libraryBindings = createLibraryBindings(includedHeaders);
  const libraryBindingNames = Object.keys(libraryBindings);
  const wrappedBody = buildSandboxedBody(code, libraryBindingNames);
  try {
    new Function('__env', ...SANDBOX_SHADOWED_GLOBALS, wrappedBody);
  } catch (err) {
    const line = extractSyntaxErrorLine(
      err,
      getHeaderLineCount(libraryBindingNames),
      code
    );
    return {
      ok: false,
      error: `Compile error: ${err.message}`,
      line
    };
  }

  return { ok: true, jsCode: code, warnings, includedHeaders };
}

/**
 * Wrap transpiled sketch JS inside a strict-mode isolated async IIFE that returns { setup, loop }.
 * @param {string} transpiledCode
 * @param {string[]} [libraryBindingNames=[]]
 * @returns {string}
 */
function buildSandboxedBody(transpiledCode, libraryBindingNames = []) {
  const safeLibNames = libraryBindingNames.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const libDestructureLine = safeLibNames.length > 0 ? `  ${safeLibNames.join(', ')},` : null;

  return [
    'const {',
    '  HIGH, LOW, INPUT, OUTPUT, INPUT_PULLUP, LED_BUILTIN,',
    '  A0, A1, A2, A3, A4, A5, A6, A7,',
    '  PI, TWO_PI, HALF_PI, DEG_TO_RAD, RAD_TO_DEG,',
    '  DEC, HEX, OCT, BIN, LSBFIRST, MSBFIRST, CHANGE, RISING, FALLING,',
    '  pinMode, digitalWrite, digitalRead, analogRead, analogWrite,',
    '  delay, delayMicroseconds, millis, micros, Serial,',
    '  map, constrain, abs, min, max, pow, sqrt, sin, cos, tan, sq,',
    '  round, floor, ceil, random, randomSeed,',
    '  bitRead, bitWrite, bitSet, bitClear, bit, highByte, lowByte,',
    '  String, float: __ardFloat, int: __ardInt, long: __ardLong, byte: __ardByte,',
    libDestructureLine,
    '  __guard, __toInt, __toFloat',
    '} = __env;',
    'const float = __ardFloat, int = __ardInt, long = __ardLong, byte = __ardByte;',
    'return (async function __sketchMain() {',
    "  'use strict';",
    transpiledCode,
    '  return {',
    '    setup: typeof setup === "function" ? setup : null,',
    '    loop: typeof loop === "function" ? loop : null',
    '  };',
    '})();'
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Built-in educational sketches ready for immediate compile & run.
 */
export const ARDUINO_EXAMPLE_SKETCHES = Object.freeze([
  {
    id: 'blink',
    name: 'Blink (Built-In LED D13)',
    description: 'Classic 500 ms blink on D13 (LED_BUILTIN) with Serial status logs.',
    code: `// Blink built-in LED on D13 and report state over Serial
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("Blink ready on D13");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED: ON");
  delay(500);

  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED: OFF");
  delay(500);
}
`
  },
  {
    id: 'button-led',
    name: 'Button (INPUT_PULLUP) + LED (D9)',
    description: 'Reads a pushbutton on D2 with internal pull-up and drives an LED on D9.',
    code: `// Read active-low pushbutton on D2 (INPUT_PULLUP) and control LED on D9
const int BUTTON_PIN = 2;
const int LED_PIN = 9;
int lastState = HIGH;

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("Button + LED ready");
}

void loop() {
  int state = digitalRead(BUTTON_PIN);
  if (state == LOW) {
    digitalWrite(LED_PIN, HIGH);
  } else {
    digitalWrite(LED_PIN, LOW);
  }

  if (state != lastState) {
    Serial.println(state == LOW ? "Button pressed" : "Button released");
    lastState = state;
  }
  delay(20);
}
`
  },
  {
    id: 'pot-plotter',
    name: 'Potentiometer (A0) -> PWM LED (D9) + Serial Plotter',
    description: 'Samples A0 (0..1023), maps to PWM on D9 (0..255), and streams ADC & PWM to Serial Plotter.',
    code: `// Sample potentiometer on A0, dim LED on D9 via PWM, and plot both channels
const int POT_PIN = A0;
const int LED_PIN = 9;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int raw = analogRead(POT_PIN);
  int pwm = map(raw, 0, 1023, 0, 255);
  analogWrite(LED_PIN, pwm);

  Serial.print("ADC:");
  Serial.print(raw);
  Serial.print(",PWM:");
  Serial.println(pwm);
  delay(50);
}
`
  },
  {
    id: 'threshold-alarm',
    name: 'Analog Threshold Alarm (A0 -> D9 LED)',
    description: 'Compares A0 against 512 (2.5 V), flashes warning LED on D9, and prints voltage.',
    code: `// Analog threshold comparator: flashes D9 LED when A0 >= 2.50 V (ADC 512)
#define THRESHOLD 512
const int SENSOR_PIN = A0;
const int ALARM_LED = 9;

void setup() {
  pinMode(ALARM_LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Threshold Alarm ready (2.50 V)");
}

void loop() {
  int raw = analogRead(SENSOR_PIN);
  float volts = (float)raw * (5.0f / 1023.0f);
  Serial.print("Volts:");
  Serial.println(volts, 2);

  if (raw >= THRESHOLD) {
    digitalWrite(ALARM_LED, HIGH);
    delay(150);
    digitalWrite(ALARM_LED, LOW);
    delay(150);
  } else {
    digitalWrite(ALARM_LED, LOW);
    delay(100);
  }
}
`
  },
  {
    id: 'serial-echo',
    name: 'Serial Monitor Interactive Command',
    description: 'Responds to ON, OFF, or 0..255 typed in Serial Monitor to control D9 / D13.',
    code: `// Control D9 PWM and D13 built-in LED using Serial Monitor commands (ON, OFF, 0..255)
const int PWM_LED = 9;

void setup() {
  pinMode(PWM_LED, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("Send ON, OFF, or 0..255");
}

void loop() {
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\\n');
    cmd.trim();

    if (cmd.equalsIgnoreCase("ON")) {
      digitalWrite(LED_BUILTIN, HIGH);
      analogWrite(PWM_LED, 255);
      Serial.println("LED ON (255)");
    } else if (cmd.equalsIgnoreCase("OFF")) {
      digitalWrite(LED_BUILTIN, LOW);
      analogWrite(PWM_LED, 0);
      Serial.println("LED OFF (0)");
    } else if (cmd.length() > 0) {
      int level = constrain(cmd.toInt(), 0, 255);
      analogWrite(PWM_LED, level);
      digitalWrite(LED_BUILTIN, level > 0 ? HIGH : LOW);
      Serial.print("PWM set to ");
      Serial.println(level);
    }
  }
  delay(20);
}
`
  },
  {
    id: 'fir-moving-average',
    name: 'FIR Filter: Moving Average (#include <FIR.h>)',
    description: '8-tap unity moving average FIR filter on A0 plotting Raw and Filtered channels.',
    code: `// 8-tap FIR Moving Average Filter using #include <FIR.h>
#include <FIR.h>

FIR<float, 8> fir;
const int INPUT_PIN = A0;

void setup() {
  Serial.begin(115200);
  float coef[8] = {1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0};
  fir.setFilterCoeffs(coef);
  Serial.print("FIR Gain set: ");
  Serial.println(fir.getGain());
}

void loop() {
  int raw = analogRead(INPUT_PIN);
  float filtered = fir.processReading((float)raw);

  Serial.print("Raw:");
  Serial.print(raw);
  Serial.print(",Filtered:");
  Serial.println(filtered, 2);
  delay(20);
}
`
  },
  {
    id: 'fir-emg-filter',
    name: 'FIR Filter: 3-Pad EMG Low-Pass (#include <FIR.h>)',
    description: '8-tap symmetric FIR low-pass filter reading EMG + AD620 on A0 at ~100 Hz.',
    code: `// 8-tap FIR Low-Pass Envelope Filter for 3-Pad EMG + AD620 on A0 (~100 Hz)
#include <FIR.h>

FIR<float, 8> fir;
const int EMG_PIN = A0;

void setup() {
  Serial.begin(115200);
  float coef[8] = {0.05, 0.10, 0.15, 0.20, 0.20, 0.15, 0.10, 0.05};
  fir.setFilterCoeffs(coef);
  for (int i = 0; i < 8; i++) {
    fir.processReading(analogRead(EMG_PIN));
  }
  Serial.print("EMG FIR Gain: ");
  Serial.println(fir.getGain(), 2);
}

void loop() {
  int raw = analogRead(EMG_PIN);
  float filtered = fir.processReading((float)raw);

  Serial.print("Raw_EMG:");
  Serial.print(raw);
  Serial.print(",Filtered_EMG:");
  Serial.println(filtered, 2);
  delay(10);
}
`
  },
  {
    id: 'ppg-ldr-plotter',
    name: 'Optical PPG (LED + Photoresistor)',
    description: 'Samples optical finger PPG voltage divider on A0 at 50 Hz and smooths with an 8-sample moving average for Serial Plotter.',
    code: `// Optical Finger PPG: sample LDR voltage divider on A0 and smooth with moving average
const int PPG_PIN = A0;
const int WINDOW = 8;
int samples[WINDOW];
int sampleIdx = 0;
long runningSum = 0;

void setup() {
  Serial.begin(115200);
  int initVal = analogRead(PPG_PIN);
  for (int i = 0; i < WINDOW; i++) {
    samples[i] = initVal;
    runningSum += initVal;
  }
}

void loop() {
  int raw = analogRead(PPG_PIN);
  runningSum -= samples[sampleIdx];
  samples[sampleIdx] = raw;
  runningSum += raw;
  sampleIdx = (sampleIdx + 1) % WINDOW;

  float smooth = (float)runningSum / (float)WINDOW;
  Serial.print(raw);
  Serial.print(",");
  Serial.println(smooth, 2);
  delay(20);
}
`
  },
  {
    id: 'ekg-fir-filter',
    name: 'EKG + 60 Hz Hum → FIR Filter (FIR.h)',
    description: '4-tap boxcar FIR filter sampled at 200 Hz (delay(5)) with spectral notch near 50–60 Hz to denoise ARB EKG while preserving the QRS R-peak.',
    code: `// 4-tap FIR Moving-Average Filter at 200 Hz (delay(5)) to strip 60 Hz hum from ARB EKG
#include <FIR.h>

FIR<float, 4> fir;
const int EKG_PIN = A0;

void setup() {
  Serial.begin(115200);
  float coef[4] = {0.25, 0.25, 0.25, 0.25};
  fir.setFilterCoeffs(coef);
  float initVal = (float)analogRead(EKG_PIN);
  for (int i = 0; i < 4; i++) {
    fir.processReading(initVal);
  }
}

void loop() {
  int raw = analogRead(EKG_PIN);
  float filtered = fir.processReading((float)raw);

  Serial.print(raw);
  Serial.print(",");
  Serial.println(filtered, 2);
  delay(5);
}
`
  }
]);

function createInitialPinStates() {
  const states = {};
  for (const pinId of ALL_GPIO_PIN_IDS) {
    states[pinId] = { mode: 'INPUT', voltage: 0 };
  }
  return states;
}

function clonePinStates(pinStates) {
  const copy = {};
  for (const [k, v] of Object.entries(pinStates)) {
    copy[k] = { ...v };
  }
  return copy;
}

function createMulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a sandboxed virtual Arduino Nano runner.
 *
 * @param {object} [options]
 * @param {(pinId: string, pinState?: object) => number} [options.readPinVoltage]
 * @param {(pinId: string, pinState: object, allPinStates: object) => void} [options.onPinStateChange]
 * @param {(line: string, meta: object) => void} [options.onSerialOutput]
 * @param {() => void} [options.onTxPulse]
 * @param {(err: Error|{ error: string, line?: number }) => void} [options.onError]
 * @param {(state: object) => void} [options.onStateChange]
 * @param {number} [options.clockScale=1]
 */
export function createArduinoRunner(options = {}) {
  const {
    readPinVoltage = () => 0,
    onPinStateChange = null,
    onSerialOutput = null,
    onTxPulse = null,
    onError = null,
    onStateChange = null,
    clockScale: rawClockScale = 1
  } = options;

  const clockScale =
    typeof rawClockScale === 'number' && Number.isFinite(rawClockScale) && rawClockScale > 0
      ? rawClockScale
      : 1;

  const MAX_SERIAL_LINES = 500;
  const MAX_PLOTTER_POINTS = 500;

  let running = false;
  let runToken = 0;
  let startTimePerfMs = 0;
  let elapsedMs = 0;
  let baudRate = 9600;
  let compileError = null;
  let ledBuiltIn = false;
  let pinStates = createInitialPinStates();
  let serialLines = [];
  let plotterSeries = [];
  let serialVersion = 0;
  let plotterVersion = 0;
  let serialLineBuffer = '';
  let serialRxQueue = [];
  let warnings = [];

  const warnedNonPwmPins = new Set();
  const warnedAnalogOnlyPins = new Set();
  const activeAbortRejectors = new Set();

  let prng = Math.random;
  let guardIterCount = 0;
  let lastGuardYieldMs = 0;
  let delayedInLoopIteration = false;

  function getElapsedVirtualMs() {
    if (!running) return elapsedMs;
    return (performance.now() - startTimePerfMs) * clockScale;
  }

  function getState() {
    return {
      running,
      compileError: compileError ? { ...compileError } : null,
      pinStates: clonePinStates(pinStates),
      ledBuiltIn,
      serialLines: [...serialLines],
      plotterSeries: plotterSeries.map((entry) => ({
        ...entry,
        channels: entry.channels.map((ch) => ({ ...ch }))
      })),
      serialVersion,
      plotterVersion,
      elapsedMs: getElapsedVirtualMs(),
      baudRate,
      warnings: [...warnings]
    };
  }

  function emitStateChange() {
    if (typeof onStateChange === 'function') {
      onStateChange(getState());
    }
  }

  function emitPinChange(pinId) {
    if (typeof onPinStateChange === 'function') {
      onPinStateChange(pinId, { ...pinStates[pinId] }, clonePinStates(pinStates));
    }
  }

  function hasPinStateChanged(prevState, nextState, prevLedBuiltIn, nextLedBuiltIn) {
    if (prevLedBuiltIn !== nextLedBuiltIn) return true;
    if (!prevState || !nextState) return prevState !== nextState;
    return (
      prevState.mode !== nextState.mode ||
      prevState.voltage !== nextState.voltage ||
      prevState.dutyCycle !== nextState.dutyCycle ||
      prevState.freqHz !== nextState.freqHz
    );
  }

  function cancelPendingTimers() {
    for (const abortFn of activeAbortRejectors) {
      abortFn();
    }
    activeAbortRejectors.clear();
  }

  function cancelableWaitMs(realMs, activeToken) {
    if (!running || activeToken !== runToken) {
      return Promise.reject(new SketchAbortError());
    }
    return new Promise((resolve, reject) => {
      let timerId = null;
      const abort = () => {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        activeAbortRejectors.delete(abort);
        reject(new SketchAbortError());
      };
      activeAbortRejectors.add(abort);
      timerId = setTimeout(() => {
        timerId = null;
        activeAbortRejectors.delete(abort);
        if (!running || activeToken !== runToken) {
          reject(new SketchAbortError());
        } else {
          resolve();
        }
      }, realMs);
    });
  }

  function formatSerialValue(val, fmt) {
    if (typeof val === 'boolean') return val ? '1' : '0';
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) return String(val);
      if (fmt && typeof fmt === 'object' && typeof fmt.__radix === 'number') {
        const truncated = Math.trunc(val);
        return (truncated < 0 ? '-' : '') + Math.abs(truncated).toString(fmt.__radix).toUpperCase();
      }
      if (typeof fmt === 'number' && Number.isFinite(fmt)) {
        return val.toFixed(clamp(Math.trunc(fmt), 0, 20));
      }
      return Number.isInteger(val) ? String(val) : val.toFixed(2);
    }
    return val === null || val === undefined ? '' : String(val);
  }

  function appendSerialText(text) {
    if (typeof onTxPulse === 'function') {
      onTxPulse();
    }
    serialLineBuffer += text;

    let nlIdx = serialLineBuffer.indexOf('\n');
    while (nlIdx !== -1) {
      const completeLine = serialLineBuffer.slice(0, nlIdx).replace(/\r$/, '');
      serialLineBuffer = serialLineBuffer.slice(nlIdx + 1);

      serialLines.push(completeLine);
      if (serialLines.length > MAX_SERIAL_LINES) {
        serialLines.shift();
      }
      serialVersion += 1;

      const plotterPoint = parseSerialPlotterLine(completeLine);
      if (plotterPoint) {
        plotterSeries.push({
          timeMs: getElapsedVirtualMs(),
          channels: plotterPoint
        });
        if (plotterSeries.length > MAX_PLOTTER_POINTS) {
          plotterSeries.shift();
        }
        plotterVersion += 1;
      }

      if (typeof onSerialOutput === 'function') {
        onSerialOutput(completeLine, {
          lines: [...serialLines],
          serialVersion,
          plotterPoint,
          plotterSeries: plotterSeries.map((entry) => ({
            ...entry,
            channels: entry.channels.map((ch) => ({ ...ch }))
          })),
          plotterVersion
        });
      }

      nlIdx = serialLineBuffer.indexOf('\n');
    }
  }

  function buildArduinoEnv(activeToken) {
    const arduinoString = (val = '', formatOrDecimals) => {
      if (typeof val === 'number') {
        if (formatOrDecimals && typeof formatOrDecimals === 'object' && typeof formatOrDecimals.__radix === 'number') {
          const truncated = Math.trunc(val);
          return (truncated < 0 ? '-' : '') + Math.abs(truncated).toString(formatOrDecimals.__radix).toUpperCase();
        }
        if (typeof formatOrDecimals === 'number' && Number.isFinite(formatOrDecimals)) {
          return val.toFixed(clamp(Math.trunc(formatOrDecimals), 0, 20));
        }
      }
      return globalThis.String(val);
    };

    return {
      HIGH: 1,
      LOW: 0,
      INPUT: 'INPUT',
      OUTPUT: 'OUTPUT',
      INPUT_PULLUP: 'INPUT_PULLUP',
      LED_BUILTIN: 13,
      A0: 14,
      A1: 15,
      A2: 16,
      A3: 17,
      A4: 18,
      A5: 19,
      A6: 20,
      A7: 21,
      PI: Math.PI,
      TWO_PI: Math.PI * 2,
      HALF_PI: Math.PI / 2,
      DEG_TO_RAD: Math.PI / 180,
      RAD_TO_DEG: 180 / Math.PI,
      DEC: RADIX_CONSTANTS.DEC,
      HEX: RADIX_CONSTANTS.HEX,
      OCT: RADIX_CONSTANTS.OCT,
      BIN: RADIX_CONSTANTS.BIN,
      LSBFIRST: 0,
      MSBFIRST: 1,
      CHANGE: 1,
      RISING: 3,
      FALLING: 2,

      pinMode(pin, mode) {
        const pinId = normalizeArduinoPinId(pin);
        if (!pinId) return;

        if (ARDUINO_NANO_ANALOG_ONLY_PINS.has(pinId) && mode === 'OUTPUT') {
          if (!warnedAnalogOnlyPins.has(pinId)) {
            warnedAnalogOnlyPins.add(pinId);
            warnings.push(`Pin ${pinId} on Arduino Nano is analog-input only and cannot be OUTPUT.`);
          }
          return;
        }

        const prev = pinStates[pinId];
        let nextState;
        if (mode === 'INPUT_PULLUP') {
          nextState = { mode: 'INPUT_PULLUP', voltage: 5 };
        } else if (mode === 'OUTPUT') {
          nextState = {
            mode: 'OUTPUT',
            voltage: prev?.mode === 'OUTPUT' ? prev.voltage : 0
          };
        } else {
          nextState = { mode: 'INPUT', voltage: 0 };
        }

        pinStates[pinId] = nextState;
        if (hasPinStateChanged(prev, nextState, ledBuiltIn, ledBuiltIn)) {
          emitPinChange(pinId);
        }
      },

      digitalWrite(pin, val) {
        const pinId = normalizeArduinoPinId(pin);
        if (!pinId) return;

        if (ARDUINO_NANO_ANALOG_ONLY_PINS.has(pinId)) {
          if (!warnedAnalogOnlyPins.has(pinId)) {
            warnedAnalogOnlyPins.add(pinId);
            warnings.push(`Pin ${pinId} on Arduino Nano is analog-input only.`);
          }
          return;
        }

        const prev = pinStates[pinId];
        const prevLed = ledBuiltIn;
        const isHigh = Boolean(val);
        const nextState = { mode: 'OUTPUT', voltage: isHigh ? 5 : 0 };
        pinStates[pinId] = nextState;
        if (pinId === 'D13') {
          ledBuiltIn = isHigh;
        }
        if (hasPinStateChanged(prev, nextState, prevLed, ledBuiltIn)) {
          emitPinChange(pinId);
        }
      },

      digitalRead(pin) {
        const pinId = normalizeArduinoPinId(pin);
        if (!pinId || ARDUINO_NANO_ANALOG_ONLY_PINS.has(pinId)) return 0;

        const state = pinStates[pinId];
        const rawV = readPinVoltage(pinId, state ? { ...state } : undefined);
        if (Number.isFinite(rawV)) {
          return rawV >= 2.0 ? 1 : 0;
        }
        if (state?.mode === 'INPUT_PULLUP') return 1;
        if (state?.mode === 'OUTPUT') return state.voltage >= 2.0 ? 1 : 0;
        return 0;
      },

      analogRead(pin) {
        // Arduino allows analogRead(0..7) as shorthand for A0..A7
        const pinId =
          typeof pin === 'number' && Number.isInteger(pin) && pin >= 0 && pin <= 7
            ? `A${pin}`
            : normalizeArduinoPinId(pin);
        if (!pinId) return 0;

        const state = pinStates[pinId];
        const rawV = readPinVoltage(pinId, state ? { ...state } : undefined);
        const voltage = Number.isFinite(rawV) ? rawV : 0;
        return Math.round(clamp(voltage / 5.0, 0, 1) * 1023);
      },

      analogWrite(pin, val) {
        const pinId = normalizeArduinoPinId(pin);
        if (!pinId) return;

        if (ARDUINO_NANO_ANALOG_ONLY_PINS.has(pinId)) {
          if (!warnedAnalogOnlyPins.has(pinId)) {
            warnedAnalogOnlyPins.add(pinId);
            warnings.push(`Pin ${pinId} on Arduino Nano is analog-input only.`);
          }
          return;
        }

        const prev = pinStates[pinId];
        const prevLed = ledBuiltIn;
        const dutyCycle = clamp(Math.round(Number(val) || 0), 0, 255);
        let nextState;
        if (ARDUINO_NANO_PWM_PINS.has(pinId)) {
          const freqHz = pinId === 'D5' || pinId === 'D6' ? 980 : 490;
          nextState = { mode: 'PWM', dutyCycle, freqHz };
        } else {
          if (!warnedNonPwmPins.has(pinId)) {
            warnedNonPwmPins.add(pinId);
            warnings.push(
              `Pin ${pinId} does not support hardware PWM; falling back to digital threshold.`
            );
          }
          const isHigh = dutyCycle >= 128;
          nextState = { mode: 'OUTPUT', voltage: isHigh ? 5 : 0 };
          if (pinId === 'D13') {
            ledBuiltIn = isHigh;
          }
        }
        pinStates[pinId] = nextState;
        if (hasPinStateChanged(prev, nextState, prevLed, ledBuiltIn)) {
          emitPinChange(pinId);
        }
      },

      async delay(ms) {
        delayedInLoopIteration = true;
        const duration = Math.max(0, Number(ms) || 0);
        const realWait = duration / clockScale;
        await cancelableWaitMs(realWait, activeToken);
      },

      async delayMicroseconds(us) {
        delayedInLoopIteration = true;
        const durationMs = Math.max(0, (Number(us) || 0) / 1000);
        const realWait = durationMs / clockScale;
        if (realWait >= 1) {
          await cancelableWaitMs(realWait, activeToken);
        } else {
          await cancelableWaitMs(0, activeToken);
        }
      },

      millis() {
        return Math.floor(getElapsedVirtualMs());
      },

      micros() {
        return Math.floor(getElapsedVirtualMs() * 1000);
      },

      Serial: {
        begin(rate) {
          const parsed = Number(rate);
          if (Number.isFinite(parsed) && parsed > 0) {
            baudRate = parsed;
          }
        },
        print(val, prec) {
          appendSerialText(formatSerialValue(val, prec));
        },
        println(val = '', prec) {
          appendSerialText(`${formatSerialValue(val, prec)}\n`);
        },
        available() {
          return serialRxQueue.length;
        },
        read() {
          if (serialRxQueue.length === 0) return -1;
          return serialRxQueue.shift();
        },
        readStringUntil(delim = '\n') {
          const delimChar =
            typeof delim === 'number'
              ? String.fromCharCode(delim & 0xff)
              : String(delim).charAt(0) || '\n';
          let out = '';
          while (serialRxQueue.length > 0) {
            const ch = serialRxQueue.shift();
            if (ch === delimChar) break;
            out += ch;
          }
          return out;
        },
        write(b) {
          if (typeof b === 'number') {
            appendSerialText(String.fromCharCode(b & 0xff));
          } else if (typeof b === 'string') {
            appendSerialText(b);
          }
        }
      },

      map(x, inMin, inMax, outMin, outMax) {
        if (inMax === inMin) return outMin;
        return Math.trunc(((x - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin);
      },

      constrain(x, a, b) {
        return Math.min(Math.max(x, a), b);
      },

      abs: Math.abs,
      min: Math.min,
      max: Math.max,
      pow: Math.pow,
      sqrt: Math.sqrt,
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      sq(x) {
        return x * x;
      },
      round: Math.round,
      floor: Math.floor,
      ceil: Math.ceil,

      random(minOrMax, maxVal) {
        if (maxVal === undefined) {
          const bound = Math.trunc(Number(minOrMax) || 0);
          return bound > 0 ? Math.floor(prng() * bound) : 0;
        }
        const lo = Math.trunc(Number(minOrMax) || 0);
        const hi = Math.trunc(Number(maxVal) || 0);
        if (hi <= lo) return lo;
        return lo + Math.floor(prng() * (hi - lo));
      },

      randomSeed(seed) {
        const s = Math.trunc(Number(seed) || 0);
        prng = s === 0 ? Math.random : createMulberry32(s);
      },

      bitRead(value, bitIdx) {
        return (value >> bitIdx) & 1;
      },
      bitWrite(value, bitIdx, bitVal) {
        return bitVal ? value | (1 << bitIdx) : value & ~(1 << bitIdx);
      },
      bitSet(value, bitIdx) {
        return value | (1 << bitIdx);
      },
      bitClear(value, bitIdx) {
        return value & ~(1 << bitIdx);
      },
      bit(n) {
        return 1 << n;
      },
      highByte(w) {
        return (w >> 8) & 0xff;
      },
      lowByte(w) {
        return w & 0xff;
      },

      String: arduinoString,
      float: (v) => Number(v),
      int: (v) => Math.trunc(Number(v)),
      long: (v) => Math.trunc(Number(v)),
      byte: (v) => Number(v) & 0xff,

      async __guard() {
        if (!running || activeToken !== runToken) {
          throw new SketchAbortError();
        }
        guardIterCount += 1;
        const now = performance.now();
        if (guardIterCount >= 250 || now - lastGuardYieldMs >= 4) {
          guardIterCount = 0;
          lastGuardYieldMs = now;
          delayedInLoopIteration = true;
          await cancelableWaitMs(0, activeToken);
        }
      },

      __toInt(val) {
        const n = Number.parseInt(String(val), 10);
        return Number.isNaN(n) ? 0 : n;
      },

      __toFloat(val) {
        const n = Number.parseFloat(String(val));
        return Number.isNaN(n) ? 0 : n;
      }
    };
  }

  function compile(sourceCode) {
    const transpiled = transpileArduinoSketch(sourceCode);
    if (!transpiled.ok) {
      compileError = { error: transpiled.error, line: transpiled.line };
      return { ok: false, error: transpiled.error, line: transpiled.line };
    }

    const libraryBindings = createLibraryBindings(transpiled.includedHeaders);
    const libraryBindingNames = Object.keys(libraryBindings);

    try {
      const wrappedBody = buildSandboxedBody(transpiled.jsCode, libraryBindingNames);
      const factory = new Function('__env', ...SANDBOX_SHADOWED_GLOBALS, wrappedBody);
      compileError = null;
      return {
        ok: true,
        warnings: transpiled.warnings,
        includedHeaders: transpiled.includedHeaders,
        libraryBindings,
        factory
      };
    } catch (err) {
      const line = extractSyntaxErrorLine(
        err,
        getHeaderLineCount(libraryBindingNames),
        transpiled.jsCode
      );
      compileError = { error: `Compile error: ${err.message}`, line };
      return { ok: false, error: compileError.error, line };
    }
  }

  function stop() {
    if (!running && activeAbortRejectors.size === 0) {
      return;
    }
    if (running) {
      elapsedMs = getElapsedVirtualMs();
    }
    running = false;
    runToken += 1;
    cancelPendingTimers();
    emitStateChange();
  }

  function clearSerial() {
    serialLines = [];
    serialLineBuffer = '';
    serialVersion += 1;
    emitStateChange();
  }

  function clearPlotter() {
    plotterSeries = [];
    plotterVersion += 1;
    emitStateChange();
  }

  function reset() {
    stop();
    pinStates = createInitialPinStates();
    ledBuiltIn = false;
    serialLines = [];
    plotterSeries = [];
    serialVersion += 1;
    plotterVersion += 1;
    serialLineBuffer = '';
    serialRxQueue = [];
    compileError = null;
    elapsedMs = 0;
    baudRate = 9600;
    warnings = [];
    warnedNonPwmPins.clear();
    warnedAnalogOnlyPins.clear();
    prng = Math.random;
    emitStateChange();
  }

  function start(sourceCode) {
    stop();

    pinStates = createInitialPinStates();
    ledBuiltIn = false;
    serialLines = [];
    plotterSeries = [];
    serialVersion += 1;
    plotterVersion += 1;
    serialLineBuffer = '';
    warnings = [];
    warnedNonPwmPins.clear();
    warnedAnalogOnlyPins.clear();
    elapsedMs = 0;

    const compiled = compile(sourceCode);
    if (!compiled.ok) {
      running = false;
      emitStateChange();
      if (typeof onError === 'function') {
        onError({ error: compiled.error, line: compiled.line });
      }
      return compiled;
    }

    warnings = [...compiled.warnings];
    runToken += 1;
    const activeToken = runToken;
    running = true;
    startTimePerfMs = performance.now();
    guardIterCount = 0;
    lastGuardYieldMs = startTimePerfMs;
    emitStateChange();

    const env = {
      ...buildArduinoEnv(activeToken),
      ...compiled.libraryBindings
    };
    const shadowedArgs = new Array(SANDBOX_SHADOWED_GLOBALS.length).fill(undefined);

    (async () => {
      try {
        const entrypoints = await compiled.factory(env, ...shadowedArgs);
        if (!running || activeToken !== runToken) return;

        if (typeof entrypoints?.setup === 'function') {
          await entrypoints.setup();
        }

        while (running && activeToken === runToken) {
          delayedInLoopIteration = false;
          if (typeof entrypoints?.loop === 'function') {
            await entrypoints.loop();
          }
          if (!running || activeToken !== runToken) break;

          // Auto-yield ~16 ms between loop() iterations if the sketch did not delay(),
          // keeping the UI responsive while running at ~60 Hz.
          const yieldMs = delayedInLoopIteration ? 0 : Math.max(1, Math.round(16 / clockScale));
          await cancelableWaitMs(yieldMs, activeToken);
        }
      } catch (err) {
        if (err instanceof SketchAbortError) {
          return;
        }
        if (running && activeToken === runToken) {
          elapsedMs = getElapsedVirtualMs();
          running = false;
          emitStateChange();
          if (typeof onError === 'function') {
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
    })();

    return { ok: true, warnings: [...warnings] };
  }

  function sendSerialInput(text) {
    if (text === null || text === undefined) return;
    const str = String(text);
    for (let i = 0; i < str.length; i += 1) {
      serialRxQueue.push(str[i]);
    }
  }

  return {
    compile(sourceCode) {
      const res = compile(sourceCode);
      return res.ok ? { ok: true, warnings: res.warnings } : res;
    },
    start,
    stop,
    reset,
    clearSerial,
    clearPlotter,
    sendSerialInput,
    getElapsedMs: getElapsedVirtualMs,
    getState
  };
}
