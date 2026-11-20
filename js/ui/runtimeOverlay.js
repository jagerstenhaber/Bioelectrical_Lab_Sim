import { PITCH, getRotatedPinOffset } from '../breadboard.js';
import { getDefaultPartProps, getPhotoresistorOhms } from '../sim/dcSolver.js';
import { formatVoltage, formatResistance } from './dmmPanel.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) {
      el.setAttribute(k, String(v));
    }
  }
  return el;
}

function defaultEscapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPowerMw(mw) {
  if (!Number.isFinite(mw)) return '---';
  if (Math.abs(mw) < 0.01) return `${(mw * 1000).toFixed(1)} µW`;
  return `${mw.toFixed(2)} mW`;
}

/**
 * Renders live DC simulation visual overlays (LED glow + overcurrent badge,
 * pushbutton pressed highlight, and DMM Red/Black probe markers) into #layer-runtime-overlay.
 */
export function renderRuntimeOverlay({
  layerEl,
  breadboard,
  placedParts = [],
  catalogMap,
  dcResult = null,
  dmmState = {},
  showProbes = true
} = {}) {
  if (!layerEl || !breadboard) return;
  layerEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  const powered = Boolean(dcResult?.powered);

  // 1. Live LED Glow & Pushbutton Pressed Highlight
  for (const inst of placedParts) {
    if (inst.partId === 'led-red' && powered && dcResult?.partResults) {
      const sim = dcResult.partResults.get(inst.id);
      if (!sim || !(sim.ledBrightness > 0)) continue;

      const h1 = breadboard.getHole(inst.pinHoles?.P1);
      const h2 = breadboard.getHole(inst.pinHoles?.P2);
      if (!h1 || !h2) continue;

      const mx = (h1.x + h2.x) / 2;
      const my = (h1.y + h2.y) / 2;
      const b = Math.min(1, Math.max(0, sim.ledBrightness));

      const ledGroup = svgEl('g', {
        class: 'runtime-led-glow',
        transform: `translate(${mx.toFixed(1)}, ${my.toFixed(1)})`,
        'pointer-events': 'none'
      });

      ledGroup.appendChild(
        svgEl('circle', {
          cx: 0,
          cy: 0,
          r: (14 + 14 * b).toFixed(1),
          fill: '#ef4444',
          opacity: (0.16 + 0.24 * b).toFixed(2)
        })
      );
      ledGroup.appendChild(
        svgEl('circle', {
          cx: 0,
          cy: 0,
          r: (8 + 8 * b).toFixed(1),
          fill: '#fca5a5',
          opacity: (0.28 + 0.36 * b).toFixed(2)
        })
      );
      ledGroup.appendChild(
        svgEl('circle', {
          cx: 0,
          cy: 0,
          r: (3.2 + 3.8 * b).toFixed(1),
          fill: '#ffffff',
          opacity: (0.45 + 0.45 * b).toFixed(2)
        })
      );

      if (sim.overcurrent === true) {
        const badge = svgEl('g', {
          class: 'runtime-overcurrent-badge',
          transform: 'translate(0, -17)'
        });
        badge.appendChild(
          svgEl('rect', {
            x: -10,
            y: -9,
            width: 20,
            height: 15,
            rx: 4,
            fill: '#dc2626',
            stroke: '#fde047',
            'stroke-width': 1.2
          })
        );
        const text = svgEl('text', {
          x: 0,
          y: 2,
          fill: '#fef08a',
          'font-size': 10,
          'font-weight': 800,
          'text-anchor': 'middle',
          'font-family': 'sans-serif'
        });
        text.textContent = '⚠';
        badge.appendChild(text);
        ledGroup.appendChild(badge);
      }

      frag.appendChild(ledGroup);
    } else if (inst.partId === 'pushbutton-4pin' && inst.props?.pressed === true) {
      const anchorHole = breadboard.getHole(inst.anchorHoleId);
      if (!anchorHole) continue;
      const { dx, dy } = getRotatedPinOffset({ dx: 1, dy: 1.5 }, inst.rotation || 0);
      const cx = anchorHole.x + dx * PITCH;
      const cy = anchorHole.y + dy * PITCH;

      const ringGroup = svgEl('g', {
        class: 'runtime-pushbutton-pressed',
        transform: `translate(${cx.toFixed(1)}, ${cy.toFixed(1)})`,
        'pointer-events': 'none'
      });
      ringGroup.appendChild(
        svgEl('circle', {
          cx: 0,
          cy: 0,
          r: 12.8,
          fill: 'rgba(56, 189, 248, 0.2)',
          stroke: '#38bdf8',
          'stroke-width': 2.2
        })
      );
      ringGroup.appendChild(
        svgEl('circle', {
          cx: 0,
          cy: 0,
          r: 7.8,
          fill: 'none',
          stroke: '#bae6fd',
          'stroke-width': 1.2,
          'stroke-dasharray': '3 2'
        })
      );
      frag.appendChild(ringGroup);
    }
  }

  // 2. DMM Probe Markers
  const probes = [];
  if (showProbes) {
    if (dmmState?.probeBlack) {
      const hole = breadboard.getHole(dmmState.probeBlack);
      if (hole) {
        probes.push({ kind: 'black', hole, tag: 'COM' });
      }
    }
    if (dmmState?.probeRed) {
      const hole = breadboard.getHole(dmmState.probeRed);
      if (hole) {
        probes.push({ kind: 'red', hole, tag: '+' });
      }
    }
  }

  const sameHole =
    probes.length === 2 && probes[0].hole.id === probes[1].hole.id;

  for (const probe of probes) {
    const isRed = probe.kind === 'red';
    // Offset Red up-right and Black up-left (or down-left if near top) so adjacent holes stay visible
    const dirX = isRed ? 1 : -1;
    const dirY = sameHole && !isRed ? 1 : -1;
    const tipX = probe.hole.x;
    const tipY = probe.hole.y;
    const endX = tipX + dirX * 13;
    const endY = tipY + dirY * 14;

    const ringColor = isRed ? '#ef4444' : '#0f172a';
    const ringOutline = isRed ? '#ffffff' : '#f8fafc';
    const pillBg = isRed ? '#ef4444' : '#0f172a';
    const pillStroke = isRed ? '#ffffff' : '#f8fafc';
    const pillText = isRed ? '#ffffff' : '#f8fafc';
    const pillW = isRed ? 17 : 28;
    const pillH = 14;
    const pillX = endX + (dirX > 0 ? -3 : -pillW + 3);
    const pillY = endY + (dirY < 0 ? -pillH + 1 : -1);

    const g = svgEl('g', {
      class: `runtime-dmm-probe is-${probe.kind}`,
      'pointer-events': 'none'
    });

    // High-contrast outer & inner ring around probed hole
    g.appendChild(
      svgEl('circle', {
        cx: tipX,
        cy: tipY,
        r: 6.4,
        fill: 'none',
        stroke: ringOutline,
        'stroke-width': 2.8
      })
    );
    g.appendChild(
      svgEl('circle', {
        cx: tipX,
        cy: tipY,
        r: 6.4,
        fill: 'none',
        stroke: ringColor,
        'stroke-width': 1.7
      })
    );

    // Angled probe needle shadow + shaft
    g.appendChild(
      svgEl('line', {
        x1: tipX + dirX * 2.5,
        y1: tipY + dirY * 2.5,
        x2: endX,
        y2: endY,
        stroke: ringOutline,
        'stroke-width': 3.4,
        'stroke-linecap': 'round'
      })
    );
    g.appendChild(
      svgEl('line', {
        x1: tipX + dirX * 2.5,
        y1: tipY + dirY * 2.5,
        x2: endX,
        y2: endY,
        stroke: ringColor,
        'stroke-width': 2,
        'stroke-linecap': 'round'
      })
    );

    // Readable pill tag
    g.appendChild(
      svgEl('rect', {
        x: pillX,
        y: pillY,
        width: pillW,
        height: pillH,
        rx: 4,
        fill: pillBg,
        stroke: pillStroke,
        'stroke-width': 1.3
      })
    );
    const label = svgEl('text', {
      x: pillX + pillW / 2,
      y: pillY + 10.2,
      fill: pillText,
      'font-size': isRed ? 11 : 8.5,
      'font-weight': 800,
      'font-family': "'JetBrains Mono', ui-monospace, monospace",
      'text-anchor': 'middle'
    });
    label.textContent = probe.tag;
    g.appendChild(label);

    frag.appendChild(g);
  }

  layerEl.appendChild(frag);
}

/**
 * Builds the live DC telemetry HTML snippet for the currently selected component.
 */
export function buildSimTelemetryHtml({
  inst,
  partDef,
  partSim,
  powered,
  escapeHtml = defaultEscapeHtml
} = {}) {
  if (!powered || !partSim || !inst || inst === 'sensor' || !partDef) {
    return '';
  }

  const rows = [];
  let extraTip = '';

  if (partDef.unit === 'Ω' || inst.partId === 'photoresistor') {
    const rText = formatResistance(partSim.resistanceOhms);
    if (partSim.floating) {
      rows.push(['R', rText], ['State', 'Floating']);
    } else {
      rows.push(
        ['R', rText],
        ['ΔV', formatVoltage(partSim.voltageDrop)],
        ['I', `${partSim.currentMa.toFixed(2)} mA`],
        ['P', formatPowerMw(partSim.powerMw)]
      );
    }
  } else if (inst.partId === 'pot-side-turn' || inst.partId === 'pot-top-turn') {
    const pct = `${Math.round((partSim.wiper ?? 0.5) * 100)}%`;
    const vWiper = partSim.vWiper != null ? formatVoltage(partSim.vWiper) : 'Floating';
    rows.push(['Wiper', pct], ['V_wiper', vWiper]);
  } else if (inst.partId === 'led-red' || inst.partId === 'diode-1n4007') {
    let status = 'OFF';
    let statusClass = '';
    if (partSim.overcurrent) {
      status = 'OVERCURRENT!';
      statusClass = 'is-danger';
    } else if (partSim.conducting) {
      status = 'ON';
      statusClass = 'is-ok';
    } else if (partSim.reverseBiased) {
      status = 'Reverse-Biased';
      statusClass = 'is-warn';
      extraTip = `<div class="inspector-sim-tip">Tip: Swap leads or press <kbd>R</kbd> twice to flip polarity.</div>`;
    }
    const vfText = partSim.voltageDrop != null ? formatVoltage(partSim.voltageDrop) : 'Floating';
    const iText = partSim.voltageDrop != null ? `${partSim.currentMa.toFixed(2)} mA` : '---';
    rows.push(
      ['Status', `<span class="telemetry-badge ${statusClass}">${escapeHtml(status)}</span>`, true],
      ['V_f', vfText],
      ['I', iText]
    );
  } else if (inst.partId === 'cap-10uf' || inst.partId === 'cap-100nf') {
    const dv = partSim.voltageDrop != null ? formatVoltage(partSim.voltageDrop) : 'Floating';
    const label = inst.partId === 'cap-10uf' ? 'V(+)−V(−)' : 'ΔV (DC)';
    rows.push([label, dv]);
    if (partSim.reverseBiased) {
      extraTip = `<div class="inspector-sim-tip is-danger">⚠ Reverse polarity! Connect + lead to higher voltage.</div>`;
    }
  } else if (inst.partId === 'opamp-dual-dip8') {
    if (!partSim.powered) {
      rows.push([
        'Power',
        '<span class="telemetry-badge is-warn">UNPOWERED — connect Pin 8 VCC+ &amp; Pin 4 GND</span>',
        true
      ]);
    } else {
      rows.push(['Power', '<span class="telemetry-badge is-ok">Powered</span>', true]);
      for (const st of partSim.stages || []) {
        const vStr = st.vOut != null ? formatVoltage(st.vOut) : 'Floating';
        const satBadge = st.saturated
          ? ` <span class="telemetry-badge is-warn">${st.state === 'high' ? 'SAT+' : 'SAT−'}</span>`
          : '';
        rows.push([`OUT${st.stage}`, `${escapeHtml(vStr)}${satBadge}`, true]);
      }
    }
  } else if (inst.partId === 'inamp-ad620') {
    if (!partSim.powered) {
      rows.push([
        'Power',
        '<span class="telemetry-badge is-warn">UNPOWERED — connect Pin 7 +Vs &amp; Pin 4 −Vs</span>',
        true
      ]);
    } else {
      const rgText = Number.isFinite(partSim.rgOhms) ? formatResistance(partSim.rgOhms) : 'Open (∞)';
      const gainText = `${partSim.gain.toFixed(1)}× (Rg ${rgText})`;
      const vDiff =
        partSim.vInP != null && partSim.vInN != null
          ? `${((partSim.vInP - partSim.vInN) * 1000) >= 0 ? '+' : ''}${((partSim.vInP - partSim.vInN) * 1000).toFixed(2)} mV`
          : 'Floating';
      const vRefText =
        partSim.vRef != null
          ? `${formatVoltage(partSim.vRef)}${partSim.refFloating ? ' (mid)' : ''}`
          : '---';
      const vOutText = partSim.vOut != null ? formatVoltage(partSim.vOut) : '---';
      const satBadge = partSim.saturated
        ? ` <span class="telemetry-badge is-warn">${partSim.state === 'high' ? 'SAT+' : 'SAT−'}</span>`
        : '';

      rows.push(
        ['Power', '<span class="telemetry-badge is-ok">Powered</span>', true],
        ['Gain G', gainText],
        ['V_diff', vDiff],
        ['V_ref', vRefText],
        ['V_out', `${escapeHtml(vOutText)}${satBadge}`, true]
      );
    }
  } else {
    return '';
  }

  const cellsHtml = rows
    .map(([k, v, raw]) => {
      const valHtml = raw ? v : escapeHtml(v);
      return `<div class="telemetry-item"><span class="telemetry-key">${escapeHtml(k)}</span><span class="telemetry-val">${valHtml}</span></div>`;
    })
    .join('');

  return `
    <div class="inspector-telemetry-grid">${cellsHtml}</div>
    ${extraTip}
  `;
}

/**
 * Builds interactive simulation controls + live DC telemetry HTML for #selection-inspector.
 */
export function buildSimInspectorHtml({
  inst,
  partDef,
  partSim,
  powered,
  loadCellsMode,
  simConfig,
  escapeHtml = defaultEscapeHtml
} = {}) {
  let controlsHtml = '';

  if (inst === 'sensor') {
    if (loadCellsMode) {
      const grams = Number.isFinite(simConfig?.loadCellForceGrams) ? simConfig.loadCellForceGrams : 0;
      controlsHtml = `
        <div class="inspector-control-row">
          <div class="inspector-control-head">
            <label for="sim-ctrl-load">Applied Load</label>
            <span class="inspector-control-val" data-sim-val="loadCellForceGrams">${Math.round(grams)} g</span>
          </div>
          <input id="sim-ctrl-load" class="inspector-slider" type="range" min="0" max="1000" step="10"
                 value="${Math.round(grams)}" data-sim-config="loadCellForceGrams" />
        </div>
      `;
    }
  } else if (inst && partDef) {
    const props = {
      ...getDefaultPartProps(inst.partId),
      ...(inst.props && typeof inst.props === 'object' ? inst.props : {})
    };

    if (inst.partId === 'pot-side-turn' || inst.partId === 'pot-top-turn') {
      const wiperPct = Math.round((Number.isFinite(props.wiper) ? props.wiper : 0.5) * 100);
      const res = Number.isFinite(props.resistance) ? props.resistance : 10000;
      controlsHtml = `
        <div class="inspector-control-row">
          <div class="inspector-control-head">
            <label for="sim-ctrl-wiper">Wiper Position</label>
            <span class="inspector-control-val" data-sim-val="wiper">${wiperPct}%</span>
          </div>
          <input id="sim-ctrl-wiper" class="inspector-slider" type="range" min="0" max="100" step="1"
                 value="${wiperPct}" data-sim-prop="wiper" />
        </div>
        <div class="inspector-control-row inspector-control-inline">
          <label for="sim-ctrl-pot-r">Total Resistance</label>
          <select id="sim-ctrl-pot-r" class="inspector-select" data-sim-prop="resistance">
            <option value="1000" ${res === 1000 ? 'selected' : ''}>1 kΩ</option>
            <option value="10000" ${res === 10000 ? 'selected' : ''}>10 kΩ</option>
            <option value="100000" ${res === 100000 ? 'selected' : ''}>100 kΩ</option>
          </select>
        </div>
      `;
    } else if (inst.partId === 'pushbutton-4pin') {
      const pressed = Boolean(props.pressed);
      controlsHtml = `
        <div class="inspector-control-row inspector-control-inline">
          <button type="button" class="inspector-hold-btn ${pressed ? 'is-pressed' : ''}" data-sim-hold-btn>
            Hold to Press
          </button>
          <label class="inspector-checkbox-label">
            <input type="checkbox" ${pressed ? 'checked' : ''} data-sim-prop="pressed" />
            <span>Latch Pressed</span>
          </label>
        </div>
      `;
    } else if (inst.partId === 'photoresistor') {
      const level = Number.isFinite(props.lightLevel) ? props.lightLevel : 0.5;
      const lightPct = Math.round(level * 100);
      const rOhms = getPhotoresistorOhms(level);
      controlsHtml = `
        <div class="inspector-control-row">
          <div class="inspector-control-head">
            <label for="sim-ctrl-light">Ambient Light (${lightPct}%)</label>
            <span class="inspector-control-val" data-sim-val="lightLevel">${escapeHtml(formatResistance(rOhms))}</span>
          </div>
          <input id="sim-ctrl-light" class="inspector-slider" type="range" min="0" max="100" step="1"
                 value="${lightPct}" data-sim-prop="lightLevel" />
          <div class="inspector-slider-scale"><span>Dark 100 kΩ</span><span>Bright 500 Ω</span></div>
        </div>
      `;
    }
  }

  const ACTIVE_PART_IDS = new Set([
    'opamp-dual-dip8',
    'inamp-ad620',
    'arduino-nano',
    'led-red',
    'diode-1n4007',
    'pot-side-turn',
    'pot-top-turn',
    'photoresistor',
    'pushbutton-4pin'
  ]);

  const isActivePart = Boolean(inst && inst !== 'sensor' && ACTIVE_PART_IDS.has(inst.partId));
  const powerOffPillHtml =
    !powered && (isActivePart || (inst === 'sensor' && loadCellsMode))
      ? `<div class="inspector-power-off-pill">Power: OFF — Turn Lab Power ON <kbd>P</kbd> to simulate</div>`
      : '';

  const telemetryInner = buildSimTelemetryHtml({
    inst,
    partDef,
    partSim,
    powered,
    escapeHtml
  });

  const showTelemetryWrap =
    Boolean(powered && partSim && inst !== 'sensor') && telemetryInner.length > 0;

  if (!controlsHtml && !showTelemetryWrap && !powerOffPillHtml) {
    return '';
  }

  return `
    <div class="inspector-sim-section">
      ${powerOffPillHtml}
      ${controlsHtml}
      ${
        showTelemetryWrap
          ? `<div class="inspector-telemetry" data-sim-telemetry>${telemetryInner}</div>`
          : '<div class="inspector-telemetry" data-sim-telemetry hidden></div>'
      }
    </div>
  `;
}
