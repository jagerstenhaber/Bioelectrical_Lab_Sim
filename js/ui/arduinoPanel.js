/**
 * Arduino Nano Virtual IDE, Serial Monitor, Serial Plotter & Pin Monitor
 * Zero-dependency ES2022+ module implementing the InstrumentPanel contract.
 */

import { ARDUINO_EXAMPLE_SKETCHES } from '../sim/arduinoRuntime.js';

const ARDUINO_TAB_ICON_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M8 10 L6 12 L8 14" />
    <path d="M16 10 L18 12 L16 14" />
    <line x1="13" y1="9" x2="11" y2="15" />
    <line x1="7" y1="2.5" x2="7" y2="5" />
    <line x1="12" y1="2.5" x2="12" y2="5" />
    <line x1="17" y1="2.5" x2="17" y2="5" />
    <line x1="7" y1="19" x2="7" y2="21.5" />
    <line x1="12" y1="19" x2="12" y2="21.5" />
    <line x1="17" y1="19" x2="17" y2="21.5" />
  </svg>
`;

const PLOTTER_COLORS = ['#22f3ff', '#22ff66', '#facc15', '#f472b6'];

const MONITORED_PIN_IDS = [
  'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'
];

const VALID_DRAWER_TABS = new Set(['serial', 'plotter', 'pins']);

function formatPinVoltage(volts) {
  if (typeof volts !== 'number' || !Number.isFinite(volts)) return '0.00 V';
  if (Math.abs(volts) < 0.005) return '0.00 V';
  return `${volts > 0 ? '+' : ''}${volts.toFixed(2)} V`;
}

function formatPlotterValue(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '---';
  if (Math.abs(val) >= 100 || Number.isInteger(val)) {
    return Number.isInteger(val) ? String(val) : val.toFixed(1);
  }
  return val.toFixed(2);
}

function parseCompileError(compileError) {
  if (!compileError) return null;
  if (typeof compileError === 'string') {
    return { message: compileError, line: null };
  }
  if (typeof compileError === 'object') {
    const message = String(compileError.error || compileError.message || 'Compile/runtime error');
    const line = Number.isInteger(compileError.line) && compileError.line > 0
      ? compileError.line
      : null;
    return { message, line };
  }
  return null;
}

/**
 * Creates the Arduino Nano Virtual IDE InstrumentPanel.
 *
 * @param {object} [options]
 * @param {object} [options.callbacks]
 * @returns {object} InstrumentPanel implementation
 */
export function createArduinoInstrument({ callbacks = {} } = {}) {
  const cb = {
    onCodeChange: callbacks.onCodeChange || (() => {}),
    onRun: callbacks.onRun || (() => {}),
    onStop: callbacks.onStop || (() => {}),
    onReset: callbacks.onReset || (() => {}),
    onSendSerial: callbacks.onSendSerial || (() => {}),
    onClearSerial: callbacks.onClearSerial || (() => {}),
    onClearPlotter: callbacks.onClearPlotter || (() => {}),
    onPlaceNano: callbacks.onPlaceNano || (() => {}),
    onPowerToggle: callbacks.onPowerToggle || (() => {}),
    onSelectExample: callbacks.onSelectExample || (() => {})
  };

  let mountContainer = null;
  let ac = null;
  let resizeObserver = null;
  let rafId = null;
  let els = null;

  let currentCode = ARDUINO_EXAMPLE_SKETCHES[0]?.code || '';
  let activeDrawerTab = 'serial';
  let autoScroll = true;
  let lastGutterLines = -1;
  let lastGutterErrLine = undefined;
  let lastRenderedSerialVersion = -1;
  let lastRenderedSerialLen = -1;
  let lastSnapshot = null;
  let canvasMetrics = { cssW: 380, cssH: 145, dpr: 1 };

  function buildMarkup(containerEl) {
    const exampleOptsHtml = ARDUINO_EXAMPLE_SKETCHES.map(
      (s) => `<option value="${s.id}">${s.name}</option>`
    ).join('');

    containerEl.innerHTML = `
      <section class="elvis-sfp elvis-arduino" aria-label="Arduino Nano IDE">
        <header class="elvis-sfp-header elvis-arduino-header">
          <div class="elvis-sfp-title-wrap">
            <span class="elvis-sfp-badge">NANO</span>
            <h3 class="elvis-sfp-title">Arduino Nano IDE</h3>
          </div>
          <span class="elvis-sfp-badge">ATmega328P</span>
        </header>

        <div class="elvis-sfp-body elvis-arduino-body">
          <div class="arduino-toolbar">
            <select class="arduino-example-select" data-arduino-example aria-label="Example Sketches">
              <option value="">Example Sketches…</option>
              ${exampleOptsHtml}
            </select>
            <div class="arduino-toolbar-actions">
              <button type="button" class="arduino-btn-run" data-arduino-run title="Upload & Run Sketch (Ctrl/Cmd + Enter)">▶ Upload &amp; Run</button>
              <button type="button" class="arduino-btn-stop" data-arduino-stop disabled title="Stop Sketch">■ Stop</button>
              <button type="button" class="arduino-btn-reset" data-arduino-reset title="Reset Arduino State & Serial">↻ Reset</button>
            </div>
            <span class="arduino-status-pill" data-arduino-status>■ STOPPED</span>
          </div>

          <div class="arduino-notice-bar" data-arduino-notice hidden>
            <span class="arduino-notice-text" data-arduino-notice-text></span>
            <button type="button" class="arduino-notice-btn" data-arduino-notice-btn hidden></button>
          </div>

          <div class="arduino-editor-wrap">
            <div class="arduino-gutter" data-arduino-gutter aria-hidden="true"></div>
            <textarea
              class="arduino-code-input"
              data-arduino-code
              spellcheck="false"
              autocapitalize="off"
              autocomplete="off"
              autocorrect="off"
              aria-label="Arduino Sketch Editor"
            ></textarea>
          </div>

          <div class="arduino-drawer">
            <div class="arduino-drawer-tabs">
              <div class="arduino-drawer-tab-group" role="tablist" aria-label="Arduino Output Panels">
                <button type="button" class="arduino-drawer-tab is-active" role="tab" aria-selected="true" data-drawer-tab="serial">Serial Monitor</button>
                <button type="button" class="arduino-drawer-tab" role="tab" aria-selected="false" data-drawer-tab="plotter">Serial Plotter</button>
                <button type="button" class="arduino-drawer-tab" role="tab" aria-selected="false" data-drawer-tab="pins">Pin Monitor</button>
              </div>
              <div class="arduino-drawer-actions">
                <label class="arduino-autoscroll-label" data-arduino-autoscroll-wrap>
                  <input type="checkbox" data-arduino-autoscroll checked />
                  <span>Auto-scroll</span>
                </label>
                <button type="button" class="arduino-clear-btn" data-arduino-clear title="Clear active output">Clear</button>
              </div>
            </div>

            <div class="arduino-drawer-pane" data-drawer-pane="serial">
              <div class="arduino-serial-log" data-arduino-serial-log aria-live="polite"></div>
              <div class="arduino-serial-input-row">
                <input
                  type="text"
                  class="arduino-serial-input"
                  data-arduino-serial-input
                  placeholder="Send serial text (e.g. ON, OFF, 128)…"
                  aria-label="Serial Monitor Input"
                />
                <button type="button" class="arduino-serial-send-btn" data-arduino-serial-send>Send</button>
              </div>
            </div>

            <div class="arduino-drawer-pane" data-drawer-pane="plotter" hidden>
              <div class="arduino-plotter-wrap">
                <canvas class="arduino-plotter-canvas" data-arduino-plotter-canvas></canvas>
                <div class="arduino-plotter-legend" data-arduino-plotter-legend></div>
              </div>
            </div>

            <div class="arduino-drawer-pane" data-drawer-pane="pins" hidden>
              <div class="arduino-pin-grid" data-arduino-pin-grid></div>
            </div>
          </div>
        </div>
      </section>
    `;

    els = {
      exampleSelect: containerEl.querySelector('[data-arduino-example]'),
      runBtn: containerEl.querySelector('[data-arduino-run]'),
      stopBtn: containerEl.querySelector('[data-arduino-stop]'),
      resetBtn: containerEl.querySelector('[data-arduino-reset]'),
      statusPill: containerEl.querySelector('[data-arduino-status]'),
      noticeBar: containerEl.querySelector('[data-arduino-notice]'),
      noticeText: containerEl.querySelector('[data-arduino-notice-text]'),
      noticeBtn: containerEl.querySelector('[data-arduino-notice-btn]'),
      gutter: containerEl.querySelector('[data-arduino-gutter]'),
      codeInput: containerEl.querySelector('[data-arduino-code]'),
      drawerTabs: Array.from(containerEl.querySelectorAll('[data-drawer-tab]')),
      drawerPanes: Array.from(containerEl.querySelectorAll('[data-drawer-pane]')),
      autoScrollWrap: containerEl.querySelector('[data-arduino-autoscroll-wrap]'),
      autoScrollCheck: containerEl.querySelector('[data-arduino-autoscroll]'),
      clearBtn: containerEl.querySelector('[data-arduino-clear]'),
      serialLog: containerEl.querySelector('[data-arduino-serial-log]'),
      serialInput: containerEl.querySelector('[data-arduino-serial-input]'),
      serialSendBtn: containerEl.querySelector('[data-arduino-serial-send]'),
      plotterCanvas: containerEl.querySelector('[data-arduino-plotter-canvas]'),
      plotterLegend: containerEl.querySelector('[data-arduino-plotter-legend]'),
      pinGrid: containerEl.querySelector('[data-arduino-pin-grid]')
    };
  }

  function syncExampleSelect() {
    if (!els?.exampleSelect) return;
    const match = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.code === currentCode);
    els.exampleSelect.value = match ? match.id : '';
  }

  function syncGutter(errorLine = null) {
    if (!els?.gutter || !els?.codeInput) return;
    const lineCount = Math.max(1, els.codeInput.value.split('\n').length);
    const errLine = parseCompileError(lastSnapshot?.compileError)?.line ?? errorLine ?? null;

    if (lineCount === lastGutterLines && errLine === lastGutterErrLine) {
      els.gutter.scrollTop = els.codeInput.scrollTop;
      return;
    }

    lastGutterLines = lineCount;
    lastGutterErrLine = errLine;

    const frag = document.createDocumentFragment();
    for (let i = 1; i <= lineCount; i += 1) {
      const lineEl = document.createElement('div');
      lineEl.className = i === errLine ? 'arduino-gutter-line is-error' : 'arduino-gutter-line';
      lineEl.textContent = String(i);
      frag.appendChild(lineEl);
    }
    els.gutter.innerHTML = '';
    els.gutter.appendChild(frag);
    els.gutter.scrollTop = els.codeInput.scrollTop;
  }

  function getCode() {
    if (els?.codeInput) {
      currentCode = els.codeInput.value;
    }
    return currentCode;
  }

  function setCode(code, { notify = false } = {}) {
    currentCode = typeof code === 'string' ? code : '';
    if (els?.codeInput) {
      els.codeInput.value = currentCode;
      syncGutter();
    }
    syncExampleSelect();
    if (notify) {
      cb.onCodeChange(currentCode);
    }
  }

  function setActiveDrawerTab(tab) {
    const nextTab = VALID_DRAWER_TABS.has(tab) ? tab : 'serial';
    activeDrawerTab = nextTab;
    if (!els) return;

    for (const btn of els.drawerTabs) {
      const isActive = btn.dataset.drawerTab === nextTab;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    }

    for (const pane of els.drawerPanes) {
      pane.hidden = pane.dataset.drawerPane !== nextTab;
    }

    els.autoScrollWrap.hidden = nextTab !== 'serial';
    els.clearBtn.hidden = nextTab === 'pins';

    if (nextTab === 'plotter') {
      schedulePlotterRedraw();
    } else if (nextTab === 'pins') {
      renderPinMonitor(
        lastSnapshot?.pinStates || {},
        lastSnapshot?.pinVoltages || {},
        lastSnapshot?.powered !== undefined ? Boolean(lastSnapshot.powered) : true
      );
    }
  }

  function renderNoticeAndStatus(snapshot = {}) {
    if (!els) return;
    const running = Boolean(snapshot.running);
    const powered = snapshot.powered !== undefined ? Boolean(snapshot.powered) : true;
    const hasNano = snapshot.hasNano !== undefined ? Boolean(snapshot.hasNano) : true;
    const parsedError = parseCompileError(snapshot.compileError);
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];

    // Status pill
    els.statusPill.classList.remove('is-running', 'is-error', 'is-off');
    if (!powered) {
      els.statusPill.classList.add('is-off');
      els.statusPill.textContent = '○ POWER OFF';
    } else if (parsedError) {
      els.statusPill.classList.add('is-error');
      els.statusPill.textContent = '✕ ERROR';
    } else if (running) {
      els.statusPill.classList.add('is-running');
      els.statusPill.textContent = '● RUNNING';
    } else {
      els.statusPill.textContent = '■ STOPPED';
    }

    els.runBtn.classList.toggle('is-active', running && powered);
    els.stopBtn.disabled = !running;

    // Notice bar
    els.noticeBar.classList.remove('is-error', 'is-warn');
    els.noticeBtn.classList.remove('is-power');
    els.noticeBtn.dataset.noticeAction = '';

    if (parsedError) {
      els.noticeBar.hidden = false;
      els.noticeBar.classList.add('is-error');
      const hasLinePrefix = parsedError.line !== null && !/\bline\s+\d+/i.test(parsedError.message);
      els.noticeText.textContent = hasLinePrefix
        ? `Line ${parsedError.line}: ${parsedError.message}`
        : parsedError.message;
      els.noticeBtn.hidden = true;
    } else if (!hasNano) {
      els.noticeBar.hidden = false;
      els.noticeBar.classList.add('is-warn');
      els.noticeText.textContent = 'No Arduino Nano placed on breadboard.';
      els.noticeBtn.hidden = false;
      els.noticeBtn.textContent = '+ Place Arduino Nano';
      els.noticeBtn.dataset.noticeAction = 'place-nano';
    } else if (!powered) {
      els.noticeBar.hidden = false;
      els.noticeBar.classList.add('is-warn');
      els.noticeText.textContent = 'Lab Power is OFF — Turn Power ON to run Arduino sketches.';
      els.noticeBtn.hidden = false;
      els.noticeBtn.classList.add('is-power');
      els.noticeBtn.textContent = '⚡ Turn Power ON';
      els.noticeBtn.dataset.noticeAction = 'power-on';
    } else if (warnings.length > 0) {
      els.noticeBar.hidden = false;
      els.noticeBar.classList.add('is-warn');
      els.noticeText.textContent =
        warnings.length > 1 ? `${warnings[0]} (+${warnings.length - 1} more)` : String(warnings[0]);
      els.noticeBtn.hidden = true;
    } else {
      els.noticeBar.hidden = true;
      els.noticeText.textContent = '';
      els.noticeBtn.hidden = true;
    }
  }

  function renderSerialMonitor(serialLines = [], serialVersion = null) {
    if (!els?.serialLog) return;
    const visibleLines = Array.isArray(serialLines) ? serialLines : [];
    const versionKey = Number.isFinite(serialVersion) ? serialVersion : null;

    if (
      versionKey !== null &&
      versionKey === lastRenderedSerialVersion &&
      visibleLines.length === lastRenderedSerialLen
    ) {
      return;
    }

    lastRenderedSerialVersion = versionKey;
    lastRenderedSerialLen = visibleLines.length;

    els.serialLog.innerHTML = '';
    if (visibleLines.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'arduino-serial-empty';
      empty.textContent = 'Serial output will appear here (Serial.println)…';
      els.serialLog.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const line of visibleLines) {
      const row = document.createElement('div');
      row.className = 'arduino-serial-line';
      row.textContent = String(line ?? '');
      frag.appendChild(row);
    }
    els.serialLog.appendChild(frag);

    if (autoScroll) {
      els.serialLog.scrollTop = els.serialLog.scrollHeight;
    }
  }

  function resizePlotterCanvasIfNeeded() {
    if (!els?.plotterCanvas) return;
    const rect = els.plotterCanvas.getBoundingClientRect();
    const cssW = Math.max(200, Math.round(rect.width || 380));
    const cssH = Math.max(140, Math.round(rect.height || 145));
    const dpr =
      typeof window !== 'undefined' && window.devicePixelRatio
        ? Math.min(2.5, window.devicePixelRatio)
        : 1;

    if (
      canvasMetrics.cssW !== cssW ||
      canvasMetrics.cssH !== cssH ||
      canvasMetrics.dpr !== dpr ||
      els.plotterCanvas.width !== Math.round(cssW * dpr) ||
      els.plotterCanvas.height !== Math.round(cssH * dpr)
    ) {
      canvasMetrics = { cssW, cssH, dpr };
      els.plotterCanvas.width = Math.round(cssW * dpr);
      els.plotterCanvas.height = Math.round(cssH * dpr);
    }
  }

  function renderPlotterLegend(channelMeta) {
    if (!els?.plotterLegend) return;
    els.plotterLegend.innerHTML = '';
    if (!channelMeta || channelMeta.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'arduino-serial-empty';
      empty.textContent = 'Print numbers or label:value pairs to plot up to 4 channels.';
      els.plotterLegend.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const ch of channelMeta) {
      const chip = document.createElement('span');
      chip.className = 'arduino-plotter-chip';

      const dot = document.createElement('span');
      dot.className = 'arduino-plotter-dot';
      dot.style.backgroundColor = ch.color;

      const text = document.createElement('span');
      text.textContent = `${ch.label}: ${formatPlotterValue(ch.latest)}`;

      chip.append(dot, text);
      frag.appendChild(chip);
    }
    els.plotterLegend.appendChild(frag);
  }

  function drawSerialPlotter(plotterSeries = []) {
    if (!els?.plotterCanvas) return;
    resizePlotterCanvasIfNeeded();

    const ctx = els.plotterCanvas.getContext('2d');
    if (!ctx) return;

    const visibleSeries = Array.isArray(plotterSeries) ? plotterSeries : [];

    const { cssW, cssH, dpr } = canvasMetrics;
    ctx.save();
    ctx.scale(dpr, dpr);

    // Pitch-black CRT background
    ctx.fillStyle = '#04070b';
    ctx.fillRect(0, 0, cssW, cssH);

    const padLeft = 40;
    const padRight = 10;
    const padTop = 10;
    const padBottom = 12;
    const plotW = Math.max(40, cssW - padLeft - padRight);
    const plotH = Math.max(40, cssH - padTop - padBottom);

    // Subtle green gridlines
    ctx.strokeStyle = 'rgba(20, 83, 45, 0.55)';
    ctx.lineWidth = 0.85;
    ctx.beginPath();
    const xDivs = 8;
    const yDivs = 4;
    for (let i = 0; i <= xDivs; i += 1) {
      const x = Math.round(padLeft + (i / xDivs) * plotW) + 0.5;
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
    }
    for (let j = 0; j <= yDivs; j += 1) {
      const y = Math.round(padTop + (j / yDivs) * plotH) + 0.5;
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#14532d';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 0.5, padTop + 0.5, plotW - 1, plotH - 1);

    // Collect up to 4 channels in appearance order
    const channelOrder = [];
    const channelLatest = new Map();
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (const pt of visibleSeries) {
      const channels = Array.isArray(pt?.channels) ? pt.channels : [];
      for (const ch of channels) {
        if (!ch || typeof ch.label !== 'string' || !Number.isFinite(ch.value)) continue;
        if (!channelLatest.has(ch.label)) {
          if (channelOrder.length >= 4) continue;
          channelOrder.push(ch.label);
        }
        channelLatest.set(ch.label, ch.value);
        if (ch.value < minVal) minVal = ch.value;
        if (ch.value > maxVal) maxVal = ch.value;
      }
    }

    if (visibleSeries.length === 0 || channelOrder.length === 0 || !Number.isFinite(minVal)) {
      ctx.fillStyle = '#64748b';
      ctx.font = "600 11px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for numeric Serial.println(…) data', padLeft + plotW / 2, padTop + plotH / 2);
      ctx.restore();
      renderPlotterLegend([]);
      return;
    }

    // Pad Y range slightly so traces don't hug the top/bottom edges
    if (Math.abs(maxVal - minVal) < 1e-9) {
      const pad = Math.max(1, Math.abs(minVal) * 0.15);
      minVal -= pad;
      maxVal += pad;
    } else {
      const span = maxVal - minVal;
      minVal -= span * 0.08;
      maxVal += span * 0.08;
    }
    const ySpan = maxVal - minVal;
    const valToY = (v) => padTop + ((maxVal - v) / ySpan) * plotH;

    // Y-axis min / mid / max labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = "700 9.5px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const midVal = (minVal + maxVal) / 2;
    ctx.fillText(formatPlotterValue(maxVal), padLeft - 4, padTop + 5);
    ctx.fillText(formatPlotterValue(midVal), padLeft - 4, padTop + plotH / 2);
    ctx.fillText(formatPlotterValue(minVal), padLeft - 4, padTop + plotH - 5);

    // Plot clipped traces
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotW, plotH);
    ctx.clip();

    const nPts = visibleSeries.length;
    const xAt = (idx) => (nPts <= 1 ? padLeft + plotW / 2 : padLeft + (idx / (nPts - 1)) * plotW);

    const legendMeta = [];
    channelOrder.forEach((label, chIdx) => {
      const color = PLOTTER_COLORS[chIdx % PLOTTER_COLORS.length];
      legendMeta.push({ label, color, latest: channelLatest.get(label) });

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();

      let started = false;
      let lastX = null;
      let lastY = null;
      for (let i = 0; i < nPts; i += 1) {
        const ch = (visibleSeries[i]?.channels || []).find((c) => c.label === label);
        if (!ch || !Number.isFinite(ch.value)) {
          started = false;
          continue;
        }
        const x = xAt(i);
        const y = valToY(ch.value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
        lastY = y;
      }
      ctx.stroke();

      if (lastX !== null && lastY !== null) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lastX, lastY, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });

    ctx.restore();
    ctx.restore();

    renderPlotterLegend(legendMeta);
  }

  function renderPinMonitor(pinStates = {}, pinVoltages = {}, powered = true) {
    if (!els?.pinGrid) return;
    const states = pinStates && typeof pinStates === 'object' ? pinStates : {};
    const voltages = pinVoltages && typeof pinVoltages === 'object' ? pinVoltages : {};

    const frag = document.createDocumentFragment();
    for (const pinId of MONITORED_PIN_IDS) {
      const st = states[pinId] || { mode: 'INPUT', voltage: 0 };
      const mode = st.mode || 'INPUT';
      const liveV = typeof voltages[pinId] === 'number' && Number.isFinite(voltages[pinId])
        ? voltages[pinId]
        : null;

      let modeLabel = 'IN';
      let chipClass = 'arduino-pin-chip';
      let valText = formatPinVoltage(powered ? (liveV ?? 0) : 0);

      if (mode === 'PWM') {
        modeLabel = 'PWM';
        const duty = Math.max(0, Math.min(255, Number(st.dutyCycle) || 0));
        const pct = Math.round((duty / 255) * 100);
        const effV = powered ? (liveV ?? (5 * duty) / 255) : 0;
        if (powered && duty > 0) chipClass += ' is-pwm';
        valText = `${pct}% · ${formatPinVoltage(effV)}`;
      } else if (mode === 'INPUT_PULLUP') {
        modeLabel = 'PU';
        const effV = powered ? (liveV ?? 5) : 0;
        if (powered) chipClass += ' is-pullup';
        valText = formatPinVoltage(effV);
      } else if (mode === 'OUTPUT') {
        modeLabel = 'OUT';
        const outV = typeof st.voltage === 'number' ? st.voltage : 0;
        const effV = powered ? (liveV ?? outV) : 0;
        const isHigh = powered && outV >= 2.0;
        if (isHigh) chipClass += ' is-high';
        valText = `${isHigh ? 'HI' : 'LO'} · ${formatPinVoltage(effV)}`;
      } else {
        const effV = powered ? (liveV ?? 0) : 0;
        if (powered && effV >= 2.0) chipClass += ' is-high';
        valText = formatPinVoltage(effV);
      }

      const chip = document.createElement('div');
      chip.className = chipClass;

      const top = document.createElement('div');
      top.className = 'arduino-pin-top';

      const nameEl = document.createElement('span');
      nameEl.className = 'arduino-pin-name';
      nameEl.textContent = pinId;

      const modeEl = document.createElement('span');
      modeEl.className = 'arduino-pin-mode';
      modeEl.textContent = modeLabel;

      top.append(nameEl, modeEl);

      const valEl = document.createElement('div');
      valEl.className = 'arduino-pin-val';
      valEl.textContent = valText;

      chip.append(top, valEl);
      frag.appendChild(chip);
    }

    els.pinGrid.innerHTML = '';
    els.pinGrid.appendChild(frag);
  }

  function schedulePlotterRedraw() {
    if (!els || activeDrawerTab !== 'plotter') return;
    if (typeof requestAnimationFrame === 'function') {
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        drawSerialPlotter(lastSnapshot?.plotterSeries || []);
      });
    } else {
      drawSerialPlotter(lastSnapshot?.plotterSeries || []);
    }
  }

  function bindEvents() {
    ac = new AbortController();
    const { signal } = ac;

    els.exampleSelect.addEventListener('change', () => {
      const id = els.exampleSelect.value;
      if (!id) return;
      const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === id);
      if (!sketch) return;
      setCode(sketch.code, { notify: true });
      cb.onSelectExample(sketch.id, sketch);
    }, { signal });

    els.runBtn.addEventListener('click', () => {
      cb.onRun(getCode());
    }, { signal });

    els.stopBtn.addEventListener('click', () => {
      cb.onStop();
    }, { signal });

    els.resetBtn.addEventListener('click', () => {
      cb.onReset();
    }, { signal });

    els.noticeBtn.addEventListener('click', () => {
      const action = els.noticeBtn.dataset.noticeAction;
      if (action === 'place-nano') {
        cb.onPlaceNano();
      } else if (action === 'power-on') {
        cb.onPowerToggle(true);
      }
    }, { signal });

    els.codeInput.addEventListener('input', () => {
      currentCode = els.codeInput.value;
      syncGutter();
      syncExampleSelect();
      cb.onCodeChange(currentCode);
    }, { signal });

    els.codeInput.addEventListener('scroll', () => {
      if (els?.gutter) {
        els.gutter.scrollTop = els.codeInput.scrollTop;
      }
    }, { signal });

    els.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const start = els.codeInput.selectionStart ?? 0;
        const end = els.codeInput.selectionEnd ?? start;
        const val = els.codeInput.value;
        els.codeInput.value = `${val.slice(0, start)}  ${val.slice(end)}`;
        els.codeInput.selectionStart = start + 2;
        els.codeInput.selectionEnd = start + 2;
        currentCode = els.codeInput.value;
        syncGutter();
        syncExampleSelect();
        cb.onCodeChange(currentCode);
        return;
      }

      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        cb.onRun(getCode());
      }
    }, { signal });

    for (const tabBtn of els.drawerTabs) {
      tabBtn.addEventListener('click', () => {
        setActiveDrawerTab(tabBtn.dataset.drawerTab);
      }, { signal });
    }

    els.autoScrollCheck.addEventListener('change', () => {
      autoScroll = Boolean(els.autoScrollCheck.checked);
      if (autoScroll && els.serialLog) {
        els.serialLog.scrollTop = els.serialLog.scrollHeight;
      }
    }, { signal });

    els.clearBtn.addEventListener('click', () => {
      if (activeDrawerTab === 'serial') {
        lastRenderedSerialVersion = -1;
        lastRenderedSerialLen = -1;
        cb.onClearSerial();
      } else if (activeDrawerTab === 'plotter') {
        cb.onClearPlotter();
      }
    }, { signal });

    const submitSerial = () => {
      if (!els?.serialInput) return;
      const raw = els.serialInput.value;
      if (!raw) return;
      const payload = raw.endsWith('\n') ? raw : `${raw}\n`;
      els.serialInput.value = '';
      cb.onSendSerial(payload);
    };

    els.serialSendBtn.addEventListener('click', submitSerial, { signal });
    els.serialInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submitSerial();
      }
    }, { signal });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (activeDrawerTab === 'plotter') {
          schedulePlotterRedraw();
        }
      });
      resizeObserver.observe(els.plotterCanvas);
    }
  }

  function mount(containerEl) {
    if (!containerEl) {
      throw new Error('createArduinoInstrument.mount requires containerEl');
    }
    destroy();
    mountContainer = containerEl;
    lastGutterLines = -1;
    lastGutterErrLine = undefined;
    lastRenderedSerialVersion = -1;
    lastRenderedSerialLen = -1;
    buildMarkup(containerEl);
    els.codeInput.value = currentCode;
    syncExampleSelect();
    syncGutter();
    setActiveDrawerTab(activeDrawerTab);
    bindEvents();
    update(lastSnapshot || {});
  }

  function update(snapshot = {}) {
    lastSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    if (!els) return;

    const isEditing =
      typeof document !== 'undefined' && document.activeElement === els.codeInput;
    if (!isEditing && typeof lastSnapshot.code === 'string' && lastSnapshot.code !== els.codeInput.value) {
      currentCode = lastSnapshot.code;
      els.codeInput.value = currentCode;
      syncExampleSelect();
    }

    syncGutter();
    renderNoticeAndStatus(lastSnapshot);
    renderSerialMonitor(lastSnapshot.serialLines || [], lastSnapshot.serialVersion);
    if (activeDrawerTab === 'plotter') {
      drawSerialPlotter(lastSnapshot.plotterSeries || []);
    } else if (activeDrawerTab === 'pins') {
      renderPinMonitor(
        lastSnapshot.pinStates || {},
        lastSnapshot.pinVoltages || {},
        lastSnapshot.powered !== undefined ? Boolean(lastSnapshot.powered) : true
      );
    }
  }

  function onLayoutChange(_mode) {
    if (activeDrawerTab === 'plotter') {
      schedulePlotterRedraw();
    }
  }

  function onVisibilityChange(visible, _mode) {
    if (visible && activeDrawerTab === 'plotter') {
      schedulePlotterRedraw();
    }
  }

  function destroy() {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (ac) {
      ac.abort();
      ac = null;
    }
    lastGutterLines = -1;
    lastGutterErrLine = undefined;
    lastRenderedSerialVersion = -1;
    lastRenderedSerialLen = -1;
    els = null;
    if (mountContainer) {
      mountContainer.innerHTML = '';
      mountContainer = null;
    }
  }

  return {
    id: 'arduino',
    label: 'Nano',
    title: 'Arduino Nano IDE',
    icon: ARDUINO_TAB_ICON_SVG,
    preferredWidth: 'wide',
    computerTile: true,
    mount,
    update,
    getCode,
    setCode,
    setActiveDrawerTab,
    onLayoutChange,
    onVisibilityChange,
    destroy
  };
}
