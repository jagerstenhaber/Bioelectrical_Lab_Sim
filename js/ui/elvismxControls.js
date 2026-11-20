/**
 * Shared NI ELVISmx Soft Front Panel (SFP) Helpers & Control Primitives
 * Zero-DOM-dependency pure computation helpers + lightweight DOM widget builders.
 */

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

/**
 * Computes normalized 0..100% bargraph fill and auto-ranged full-scale label.
 * Pure function (zero DOM dependencies).
 *
 * @param {number|boolean|null|undefined} value
 * @param {'VDC'|'OHM'|'CONT'} mode
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

  if (mode === 'VDC') {
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
