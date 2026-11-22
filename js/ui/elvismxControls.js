/**
 * Shared NI ELVISmx Soft Front Panel (SFP) Helpers & Control Primitives
 * Zero-DOM-dependency pure computation helpers + lightweight DOM widget builders.
 */

export const SCOPE_VOLTS_PER_DIV = Object.freeze([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]);
export const SCOPE_TIME_PER_DIV = Object.freeze([5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5]);

const SVG_NS = 'http://www.w3.org/2000/svg';
const VDC_FULL_SCALE_STEPS = [0.01, 0.1, 1, 5, 15, 30];
const OHM_FULL_SCALE_STEPS = [100, 1000, 10000, 100000, 1e6, 1e7];

function formatVdcScaleLabel(step) {
  if (step < 1) {
    return `${Math.round(step * 1000)} mV`;
  }
  return `${step} V`;
}

function formatOhmScaleLabel(step) {
  if (step < 1000) return `${step} Ω`;
  if (step < 1e6) return `${Math.round(step / 1000)} kΩ`;
  return `${Math.round(step / 1e6)} MΩ`;
}

function formatCleanMetric(val) {
  const rounded = Math.round(val);
  if (Math.abs(val - rounded) < 1e-6) {
    return String(rounded);
  }
  return String(Number(val.toFixed(2)));
}

/**
 * Formats a frequency in Hz into human-friendly Hz / kHz / MHz strings.
 * Pure function (zero DOM dependencies).
 *
 * @param {number} hz
 * @returns {string}
 */
export function formatFrequency(hz) {
  if (typeof hz !== 'number' || !Number.isFinite(hz) || hz < 0) {
    return '---';
  }
  if (hz >= 1e6) {
    const mhz = hz / 1e6;
    const decimals = mhz < 10 ? 2 : 1;
    return `${mhz.toFixed(decimals)} MHz`;
  }
  if (hz >= 1e3) {
    const khz = hz / 1e3;
    const decimals = khz < 10 ? 3 : khz < 100 ? 2 : 1;
    return `${khz.toFixed(decimals)} kHz`;
  }
  const decimals = hz < 10 ? 2 : 1;
  return `${hz.toFixed(decimals)} Hz`;
}

/**
 * Formats an oscilloscope vertical scale setting (Volts/div).
 * Pure function (zero DOM dependencies).
 *
 * @param {number} v
 * @returns {string}
 */
export function formatVoltsPerDiv(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return '---';
  }
  if (v < 1 - 1e-9) {
    return `${formatCleanMetric(v * 1000)} mV`;
  }
  return `${formatCleanMetric(v)} V`;
}

/**
 * Formats an oscilloscope horizontal timebase setting (seconds/div).
 * Pure function (zero DOM dependencies).
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatTimePerDiv(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) {
    return '---';
  }
  if (sec === 0) {
    return '0 s';
  }
  if (sec < 1e-6 - 1e-15) {
    return `${formatCleanMetric(sec * 1e9)} ns`;
  }
  if (sec < 1e-3 - 1e-12) {
    return `${formatCleanMetric(sec * 1e6)} µs`;
  }
  if (sec < 1 - 1e-9) {
    return `${formatCleanMetric(sec * 1e3)} ms`;
  }
  return `${formatCleanMetric(sec)} s`;
}

/**
 * Computes normalized 0..100% bargraph fill and auto-ranged full-scale label.
 * Pure function (zero DOM dependencies).
 *
 * @param {number|boolean|null|undefined} value
 * @param {'VDC'|'VAC'|'OHM'|'CONT'} mode
 * @returns {{ percent: number, scaleLabel: string }}
 */
export function computeBarGraphPercent(value, mode) {
  if (mode === 'CONT') {
    const shorted = Boolean(value);
    return {
      percent: shorted ? 100 : 0,
      scaleLabel: shorted ? 'SHORT' : 'OPEN'
    };
  }

  if (mode === 'VDC' || mode === 'VAC') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { percent: 0, scaleLabel: formatVdcScaleLabel(VDC_FULL_SCALE_STEPS[0]) };
    }
    const absV = Math.abs(value);
    let fullScale = VDC_FULL_SCALE_STEPS[VDC_FULL_SCALE_STEPS.length - 1];
    for (const step of VDC_FULL_SCALE_STEPS) {
      if (absV <= step) {
        fullScale = step;
        break;
      }
    }
    const percent = Math.min(100, Math.max(0, (absV / fullScale) * 100));
    return {
      percent,
      scaleLabel: formatVdcScaleLabel(fullScale)
    };
  }

  if (mode === 'OHM') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2e7) {
      return { percent: 0, scaleLabel: 'OL' };
    }
    let fullScale = OHM_FULL_SCALE_STEPS[OHM_FULL_SCALE_STEPS.length - 1];
    for (const step of OHM_FULL_SCALE_STEPS) {
      if (value <= step) {
        fullScale = step;
        break;
      }
    }
    const percent = Math.min(100, Math.max(0, (value / fullScale) * 100));
    return {
      percent,
      scaleLabel: formatOhmScaleLabel(fullScale)
    };
  }

  return { percent: 0, scaleLabel: '' };
}

/**
 * Creates a crisp segmented cyan LED bargraph element with subtle scale ticks.
 *
 * @param {number} [segmentCount=30]
 * @returns {{ el: HTMLElement, update: (percent: number, active?: boolean) => void }}
 */
export function createBarGraphElement(segmentCount = 30) {
  const count = Math.max(1, Math.floor(Number(segmentCount) || 30));

  const wrap = document.createElement('div');
  wrap.className = 'elvis-bargraph-wrap';

  const bar = document.createElement('div');
  bar.className = 'elvis-bargraph';
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');

  const segments = [];
  for (let i = 0; i < count; i++) {
    const seg = document.createElement('span');
    seg.className = 'elvis-bargraph-seg';
    bar.appendChild(seg);
    segments.push(seg);
  }

  const ticks = document.createElement('div');
  ticks.className = 'elvis-bargraph-ticks';
  ticks.setAttribute('aria-hidden', 'true');
  const tickCount = 7;
  for (let i = 0; i < tickCount; i++) {
    const tick = document.createElement('span');
    tick.className = i === 0 || i === 3 || i === tickCount - 1
      ? 'elvis-bargraph-tick is-major'
      : 'elvis-bargraph-tick';
    ticks.appendChild(tick);
  }

  wrap.appendChild(bar);
  wrap.appendChild(ticks);

  function update(percent, active = true) {
    const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
    const isActive = Boolean(active);
    wrap.classList.toggle('is-inactive', !isActive);
    bar.setAttribute('aria-valuenow', String(Math.round(isActive ? clamped : 0)));

    const litCount = !isActive || clamped <= 0
      ? 0
      : Math.min(count, Math.max(1, Math.round((clamped / 100) * count)));

    for (let i = 0; i < count; i++) {
      segments[i].classList.toggle('is-lit', i < litCount);
    }
  }

  return { el: wrap, update };
}

/**
 * Creates an authentic NI ELVISmx Run / Stop instrument control footer row.
 *
 * @param {object} [options]
 * @param {() => void} [options.onRun]
 * @param {() => void} [options.onStop]
 * @returns {{ el: HTMLElement, setRunning: (isRunning: boolean) => void, destroy: () => void }}
 */
export function createRunStopFooter({ onRun, onStop } = {}) {
  const row = document.createElement('div');
  row.className = 'elvis-runstop-row';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'elvis-btn-run is-active';
  runBtn.setAttribute('aria-pressed', 'true');
  runBtn.dataset.elvisAction = 'run';
  runBtn.innerHTML = `
    <span class="elvis-ctrl-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none">
        <polygon points="3,2 14,8 3,14" fill="#22c55e" stroke="#86efac" stroke-width="1"/>
      </svg>
    </span>
    <span>Run</span>
  `;

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'elvis-btn-stop';
  stopBtn.setAttribute('aria-pressed', 'false');
  stopBtn.dataset.elvisAction = 'stop';
  stopBtn.innerHTML = `
    <span class="elvis-ctrl-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none">
        <rect x="3" y="3" width="10" height="10" rx="1.5" fill="#ef4444" stroke="#fca5a5" stroke-width="1"/>
      </svg>
    </span>
    <span>Stop</span>
  `;

  row.appendChild(runBtn);
  row.appendChild(stopBtn);

  const ac = new AbortController();
  const { signal } = ac;

  runBtn.addEventListener('click', () => {
    if (typeof onRun === 'function') onRun();
  }, { signal });

  stopBtn.addEventListener('click', () => {
    if (typeof onStop === 'function') onStop();
  }, { signal });

  function setRunning(isRunning) {
    const running = Boolean(isRunning);
    runBtn.classList.toggle('is-active', running);
    runBtn.setAttribute('aria-pressed', String(running));
    stopBtn.classList.toggle('is-active', !running);
    stopBtn.setAttribute('aria-pressed', String(!running));
  }

  function destroy() {
    ac.abort();
  }

  return { el: row, setRunning, destroy };
}

function clamp01(t) {
  if (!Number.isFinite(t)) return 0;
  return Math.min(1, Math.max(0, t));
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad)
  };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function countDecimals(step) {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const s = String(step);
  if (s.includes('e-')) {
    return Number(s.split('e-')[1]) || 0;
  }
  const dot = s.indexOf('.');
  return dot >= 0 ? s.length - dot - 1 : 0;
}

/**
 * Creates a circular NI ELVISmx SVG rotary dial paired with either a discrete
 * `<select>` (when `options` is provided) or a numeric `<input>` spinbox.
 * Supports vertical pointer drag (Shift = 5x fine precision), mouse wheel,
 * keyboard arrows, and direct field input.
 *
 * @param {object} config
 * @param {string} config.label
 * @param {number|*} [config.value]
 * @param {number} [config.min=0]
 * @param {number} [config.max=10]
 * @param {number} [config.step=0.1]
 * @param {string} [config.unit='']
 * @param {boolean} [config.logScale=false]
 * @param {Array<*>|null} [config.options=null]
 * @param {((opt: *) => string)|null} [config.formatOption=null]
 * @param {(val: *) => void} [config.onChange]
 * @returns {{ el: HTMLElement, setValue: (val: *) => void, setDisabled: (bool: boolean) => void, destroy: () => void }}
 */
export function createDialSpinbox({
  label = '',
  value,
  min = 0,
  max = 10,
  step = 0.1,
  unit = '',
  logScale = false,
  options = null,
  formatOption = null,
  onChange
} = {}) {
  const isDiscrete = Array.isArray(options) && options.length > 0;
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin + 10;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 0.1;
  const useLog = Boolean(logScale) && safeMin > 0 && safeMax > safeMin;
  const baseDecimals = Math.max(0, Math.min(6, countDecimals(safeStep)));

  const wrap = document.createElement('div');
  wrap.className = 'elvis-dial-wrap';

  const labelEl = document.createElement('span');
  labelEl.className = 'elvis-dial-label';
  labelEl.textContent = label;

  const knobSvg = document.createElementNS(SVG_NS, 'svg');
  knobSvg.setAttribute('class', 'elvis-dial-knob');
  knobSvg.setAttribute('viewBox', '0 0 64 64');
  knobSvg.setAttribute('width', '56');
  knobSvg.setAttribute('height', '56');
  knobSvg.setAttribute('role', 'slider');
  knobSvg.setAttribute('tabindex', '0');
  knobSvg.setAttribute('aria-label', label || 'Rotary dial');

  const trackArc = document.createElementNS(SVG_NS, 'path');
  trackArc.setAttribute('class', 'elvis-dial-track');
  trackArc.setAttribute('d', describeArc(32, 32, 24, 135, 405));
  trackArc.setAttribute('fill', 'none');
  trackArc.setAttribute('stroke', '#1e293b');
  trackArc.setAttribute('stroke-width', '4');
  trackArc.setAttribute('stroke-linecap', 'round');

  const valueArc = document.createElementNS(SVG_NS, 'path');
  valueArc.setAttribute('class', 'elvis-dial-arc');
  valueArc.setAttribute('fill', 'none');
  valueArc.setAttribute('stroke', '#22f3ff');
  valueArc.setAttribute('stroke-width', '4');
  valueArc.setAttribute('stroke-linecap', 'round');

  const outerDisc = document.createElementNS(SVG_NS, 'circle');
  outerDisc.setAttribute('cx', '32');
  outerDisc.setAttribute('cy', '32');
  outerDisc.setAttribute('r', '18');
  outerDisc.setAttribute('fill', '#1e293b');
  outerDisc.setAttribute('stroke', '#475569');
  outerDisc.setAttribute('stroke-width', '1.5');

  const innerDisc = document.createElementNS(SVG_NS, 'circle');
  innerDisc.setAttribute('cx', '32');
  innerDisc.setAttribute('cy', '32');
  innerDisc.setAttribute('r', '14.5');
  innerDisc.setAttribute('fill', '#0f172a');
  innerDisc.setAttribute('stroke', '#334155');
  innerDisc.setAttribute('stroke-width', '1');

  const pointerLine = document.createElementNS(SVG_NS, 'line');
  pointerLine.setAttribute('class', 'elvis-dial-pointer');
  pointerLine.setAttribute('stroke', '#22f3ff');
  pointerLine.setAttribute('stroke-width', '2.5');
  pointerLine.setAttribute('stroke-linecap', 'round');

  knobSvg.append(trackArc, valueArc, outerDisc, innerDisc, pointerLine);

  const controlRow = document.createElement('div');
  controlRow.className = 'elvis-dial-control';

  let selectEl = null;
  let inputEl = null;

  if (isDiscrete) {
    selectEl = document.createElement('select');
    selectEl.className = 'elvis-dial-select';
    selectEl.setAttribute('aria-label', label || 'Value');
    options.forEach((opt, idx) => {
      const optionEl = document.createElement('option');
      optionEl.value = String(idx);
      optionEl.textContent =
        typeof formatOption === 'function' ? String(formatOption(opt)) : String(opt);
      selectEl.appendChild(optionEl);
    });
    controlRow.appendChild(selectEl);
  } else {
    inputEl = document.createElement('input');
    inputEl.type = 'number';
    inputEl.className = 'elvis-dial-input';
    inputEl.min = String(safeMin);
    inputEl.max = String(safeMax);
    inputEl.step = useLog ? 'any' : String(safeStep);
    inputEl.setAttribute('aria-label', label || 'Value');
    controlRow.appendChild(inputEl);

    if (unit) {
      const unitEl = document.createElement('span');
      unitEl.className = 'elvis-dial-unit';
      unitEl.textContent = unit;
      controlRow.appendChild(unitEl);
    }
  }

  wrap.append(labelEl, knobSvg, controlRow);

  let isDisabled = false;
  let currentIdx = 0;
  let currentValue = isDiscrete ? options[0] : safeMin;
  let currentT = 0;

  function findClosestOptionIndex(val) {
    const exactIdx = options.indexOf(val);
    if (exactIdx >= 0) return exactIdx;
    const numVal = Number(val);
    if (!Number.isFinite(numVal)) return 0;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < options.length; i++) {
      const optNum = Number(options[i]);
      if (!Number.isFinite(optNum)) continue;
      const dist = Math.abs(optNum - numVal);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function clampContinuous(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return safeMin;
    return Math.min(safeMax, Math.max(safeMin, num));
  }

  function formatInputNumber(val) {
    if (!Number.isFinite(val)) return String(safeMin);
    if (useLog) {
      if (val < 10) return String(Number(val.toFixed(2)));
      if (val < 100) return String(Number(val.toFixed(1)));
      return String(Math.round(val * 10) / 10);
    }
    return String(Number(val.toFixed(Math.max(baseDecimals, 2))));
  }

  function valueToT(val) {
    if (isDiscrete) {
      return options.length > 1 ? currentIdx / (options.length - 1) : 0;
    }
    const clamped = clampContinuous(val);
    if (useLog) {
      return clamp01(Math.log(clamped / safeMin) / Math.log(safeMax / safeMin));
    }
    return clamp01((clamped - safeMin) / (safeMax - safeMin));
  }

  function tToValue(t, fine = false) {
    const clampedT = clamp01(t);
    if (useLog) {
      const raw = safeMin * Math.pow(safeMax / safeMin, clampedT);
      let rounded;
      if (raw < 10) {
        rounded = Number(raw.toFixed(fine ? 2 : 1));
      } else if (raw < 100) {
        rounded = Number(raw.toFixed(fine ? 1 : 0));
      } else if (raw < 1000) {
        rounded = fine ? Math.round(raw) : Math.round(raw / 5) * 5;
      } else {
        const sig = fine ? 4 : 3;
        rounded = Number(raw.toPrecision(sig));
      }
      return clampContinuous(rounded);
    }
    const raw = safeMin + clampedT * (safeMax - safeMin);
    const effStep = fine ? safeStep / 5 : safeStep;
    const snapped = safeMin + Math.round((raw - safeMin) / effStep) * effStep;
    const decimals = Math.min(6, baseDecimals + (fine ? 2 : 0));
    return clampContinuous(Number(snapped.toFixed(decimals)));
  }

  function renderKnobVisual(t) {
    const norm = clamp01(t);
    currentT = norm;
    const endAngle = 135 + norm * 270;

    if (norm <= 0.002) {
      valueArc.setAttribute('d', '');
    } else {
      valueArc.setAttribute('d', describeArc(32, 32, 24, 135, endAngle));
    }

    const innerPt = polarToCartesian(32, 32, 5, endAngle);
    const outerPt = polarToCartesian(32, 32, 15, endAngle);
    pointerLine.setAttribute('x1', innerPt.x.toFixed(2));
    pointerLine.setAttribute('y1', innerPt.y.toFixed(2));
    pointerLine.setAttribute('x2', outerPt.x.toFixed(2));
    pointerLine.setAttribute('y2', outerPt.y.toFixed(2));

    if (isDiscrete) {
      knobSvg.setAttribute('aria-valuemin', '0');
      knobSvg.setAttribute('aria-valuemax', String(Math.max(0, options.length - 1)));
      knobSvg.setAttribute('aria-valuenow', String(currentIdx));
      const text =
        typeof formatOption === 'function'
          ? String(formatOption(currentValue))
          : String(currentValue);
      knobSvg.setAttribute('aria-valuetext', text);
    } else {
      knobSvg.setAttribute('aria-valuemin', String(safeMin));
      knobSvg.setAttribute('aria-valuemax', String(safeMax));
      knobSvg.setAttribute('aria-valuenow', String(currentValue));
      knobSvg.setAttribute('aria-valuetext', unit ? `${currentValue} ${unit}` : String(currentValue));
    }
  }

  function syncControlDom({ forceInput = false } = {}) {
    if (isDiscrete && selectEl) {
      if (selectEl.selectedIndex !== currentIdx) {
        selectEl.selectedIndex = currentIdx;
      }
    } else if (inputEl) {
      const isFocused = typeof document !== 'undefined' && document.activeElement === inputEl;
      if (forceInput || !isFocused) {
        inputEl.value = formatInputNumber(currentValue);
      }
    }
  }

  function setValue(val, { forceInput = false } = {}) {
    if (isDiscrete) {
      currentIdx = findClosestOptionIndex(val);
      currentValue = options[currentIdx];
      renderKnobVisual(valueToT(currentValue));
      syncControlDom({ forceInput });
    } else {
      currentValue = clampContinuous(val);
      renderKnobVisual(valueToT(currentValue));
      syncControlDom({ forceInput });
    }
  }

  function emitChange(nextVal) {
    if (typeof onChange === 'function') {
      onChange(nextVal);
    }
  }

  function setDisabled(bool) {
    isDisabled = Boolean(bool);
    if (isDisabled) {
      endDrag();
    }
    wrap.classList.toggle('is-disabled', isDisabled);
    knobSvg.setAttribute('aria-disabled', String(isDisabled));
    knobSvg.setAttribute('tabindex', isDisabled ? '-1' : '0');
    if (selectEl) selectEl.disabled = isDisabled;
    if (inputEl) inputEl.disabled = isDisabled;
  }

  // Initial value
  setValue(value !== undefined ? value : isDiscrete ? options[0] : safeMin, { forceInput: true });

  const ac = new AbortController();
  const { signal } = ac;

  let dragging = false;
  let lastY = 0;
  let dragT = currentT;
  let discreteAccum = 0;

  knobSvg.addEventListener('pointerdown', (e) => {
    if (isDisabled || e.button !== 0) return;
    e.preventDefault();
    knobSvg.focus?.();
    dragging = true;
    lastY = e.clientY;
    dragT = currentT;
    discreteAccum = 0;
    knobSvg.classList.add('is-dragging');
    try {
      knobSvg.setPointerCapture?.(e.pointerId);
    } catch (_) {
      // Ignore synthetic event environments without active pointerId
    }
  }, { signal });

  window.addEventListener('pointermove', (e) => {
    if (!dragging || isDisabled) return;
    const dy = lastY - e.clientY;
    lastY = e.clientY;
    if (dy === 0) return;

    if (isDiscrete) {
      const pxPerStep = e.shiftKey ? 90 : 18;
      discreteAccum += dy / pxPerStep;
      const stepDelta = Math.trunc(discreteAccum);
      if (stepDelta !== 0) {
        discreteAccum -= stepDelta;
        const nextIdx = Math.min(options.length - 1, Math.max(0, currentIdx + stepDelta));
        if (nextIdx !== currentIdx) {
          currentIdx = nextIdx;
          currentValue = options[currentIdx];
          renderKnobVisual(valueToT(currentValue));
          syncControlDom();
          emitChange(currentValue);
        }
      }
    } else {
      const fullSweepPx = e.shiftKey ? 750 : 150;
      dragT = clamp01(dragT + dy / fullSweepPx);
      const nextVal = tToValue(dragT, e.shiftKey);
      renderKnobVisual(dragT);
      if (nextVal !== currentValue) {
        currentValue = nextVal;
        syncControlDom();
        emitChange(currentValue);
      }
    }
  }, { signal });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    knobSvg.classList.remove('is-dragging');
    renderKnobVisual(valueToT(currentValue));
  }

  window.addEventListener('pointerup', endDrag, { signal });
  window.addEventListener('pointercancel', endDrag, { signal });

  knobSvg.addEventListener('wheel', (e) => {
    if (isDisabled) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    if (dir === 0) return;

    if (isDiscrete) {
      const nextIdx = Math.min(options.length - 1, Math.max(0, currentIdx + dir));
      if (nextIdx !== currentIdx) {
        currentIdx = nextIdx;
        currentValue = options[currentIdx];
        renderKnobVisual(valueToT(currentValue));
        syncControlDom();
        emitChange(currentValue);
      }
    } else {
      let nextVal;
      if (useLog) {
        const nextT = clamp01(currentT + dir * (e.shiftKey ? 0.004 : 0.02));
        nextVal = tToValue(nextT, e.shiftKey);
        if (nextVal === currentValue) {
          const factor = e.shiftKey ? 1.01 : 1.05;
          nextVal = clampContinuous(dir > 0 ? currentValue * factor : currentValue / factor);
        }
      } else {
        const stepSize = e.shiftKey ? safeStep / 5 : safeStep;
        const decimals = Math.min(6, baseDecimals + (e.shiftKey ? 2 : 0));
        nextVal = clampContinuous(Number((currentValue + dir * stepSize).toFixed(decimals)));
      }
      if (nextVal !== currentValue) {
        currentValue = nextVal;
        renderKnobVisual(valueToT(currentValue));
        syncControlDom();
        emitChange(currentValue);
      }
    }
  }, { signal, passive: false });

  knobSvg.addEventListener('keydown', (e) => {
    if (isDisabled) return;
    let dir = 0;
    let stepMult = 1;
    let jumpExtreme = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') dir = 1;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') dir = -1;
    else if (e.key === 'PageUp') { dir = 1; stepMult = 5; }
    else if (e.key === 'PageDown') { dir = -1; stepMult = 5; }
    else if (e.key === 'Home') jumpExtreme = 'min';
    else if (e.key === 'End') jumpExtreme = 'max';

    if (dir === 0 && !jumpExtreme) return;
    e.preventDefault();
    e.stopPropagation();

    if (isDiscrete) {
      const nextIdx =
        jumpExtreme === 'min'
          ? 0
          : jumpExtreme === 'max'
          ? options.length - 1
          : Math.min(options.length - 1, Math.max(0, currentIdx + dir * stepMult));
      if (nextIdx !== currentIdx) {
        currentIdx = nextIdx;
        currentValue = options[currentIdx];
        renderKnobVisual(valueToT(currentValue));
        syncControlDom();
        emitChange(currentValue);
      }
    } else {
      let nextVal;
      if (jumpExtreme === 'min') {
        nextVal = safeMin;
      } else if (jumpExtreme === 'max') {
        nextVal = safeMax;
      } else if (useLog) {
        const nextT = clamp01(currentT + dir * stepMult * (e.shiftKey ? 0.004 : 0.02));
        nextVal = tToValue(nextT, e.shiftKey);
        if (nextVal === currentValue) {
          const baseFactor = e.shiftKey ? 1.01 : 1.05;
          const factor = Math.pow(baseFactor, stepMult);
          nextVal = clampContinuous(dir > 0 ? currentValue * factor : currentValue / factor);
        }
      } else {
        const stepSize = (e.shiftKey ? safeStep / 5 : safeStep) * stepMult;
        const decimals = Math.min(6, baseDecimals + (e.shiftKey ? 2 : 0));
        nextVal = clampContinuous(Number((currentValue + dir * stepSize).toFixed(decimals)));
      }
      if (nextVal !== currentValue) {
        currentValue = nextVal;
        renderKnobVisual(valueToT(currentValue));
        syncControlDom();
        emitChange(currentValue);
      }
    }
  }, { signal });

  if (selectEl) {
    selectEl.addEventListener('change', () => {
      if (isDisabled) return;
      const idx = Math.min(options.length - 1, Math.max(0, selectEl.selectedIndex));
      currentIdx = idx;
      currentValue = options[idx];
      renderKnobVisual(valueToT(currentValue));
      emitChange(currentValue);
    }, { signal });
  }

  if (inputEl) {
    const handleInput = () => {
      if (isDisabled) return;
      if (inputEl.value.trim() === '') return;
      const parsed = Number(inputEl.value);
      if (!Number.isFinite(parsed)) return;
      const clamped = clampContinuous(parsed);
      currentValue = clamped;
      renderKnobVisual(valueToT(currentValue));
      emitChange(currentValue);
    };
    inputEl.addEventListener('input', handleInput, { signal });
    inputEl.addEventListener('change', handleInput, { signal });
    inputEl.addEventListener('blur', () => {
      syncControlDom({ forceInput: true });
    }, { signal });
  }

  function destroy() {
    dragging = false;
    ac.abort();
  }

  return {
    el: wrap,
    setValue,
    setDisabled,
    destroy
  };
}

