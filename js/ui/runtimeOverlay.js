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
 * pushbutton pressed highlight, and DMM/FGEN/Scope probe markers) into #layer-runtime-overlay.
 */
export function renderRuntimeOverlay({
  layerEl,
  breadboard,
  placedParts = [],
  catalogMap,
  dcResult = null,
  dmmState = {},
  showProbes = true,
  fgenProbeHole = null,
  showFgenProbe = false,
  scopeProbes = null,
  showScopeProbes = false,
  bodeProbes = null,
  showBodeProbes = false,
  arduinoState = null
} = {}) {
  if (!layerEl || !breadboard) return;
  layerEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  const powered = Boolean(dcResult?.powered);

  // 1. Live LED Glow, Pushbutton Pressed Highlight & Arduino Nano Onboard LEDs
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
    } else if (inst.partId === 'arduino-nano') {
      const anchorHole = breadboard.getHole(inst.anchorHoleId);
      if (!anchorHole) continue;

      const rot = inst.rotation || 0;
      const d13State = arduinoState?.pinStates?.D13;
      const d13Level =
        d13State?.mode === 'PWM'
          ? Math.min(1, Math.max(0, (Number(d13State.dutyCycle) || 0) / 255))
          : d13State?.mode === 'OUTPUT' && (Number(d13State.voltage) || 0) >= 2.0
          ? 1
          : 0;
      const lActive = powered && (Boolean(arduinoState?.ledBuiltIn) || d13Level > 0);
      const lIntensity = lActive ? Math.max(0.45, arduinoState?.ledBuiltIn ? 1 : d13Level) : 0;
      const txActive = powered && Boolean(arduinoState?.txActive);

      const nanoLeds = [
        {
          id: 'pwr',
          dx: 11.8,
          dy: 2.0,
          active: powered,
          color: '#22c55e',
          core: '#bbf7d0',
          auraR: 6.5,
          coreR: 2.3,
          auraOpacity: 0.42
        },
        {
          id: 'l',
          dx: 11.8,
          dy: 3.0,
          active: lActive,
          color: '#f59e0b',
          core: '#fde047',
          auraR: 6.0 + 3.5 * lIntensity,
          coreR: 2.6,
          auraOpacity: 0.38 + 0.42 * lIntensity
        },
        {
          id: 'tx',
          dx: 11.8,
          dy: 4.0,
          active: txActive,
          color: '#38bdf8',
          core: '#e0f2fe',
          auraR: 7.5,
          coreR: 2.4,
          auraOpacity: 0.58
        }
      ];

      for (const led of nanoLeds) {
        const offset = getRotatedPinOffset({ dx: led.dx, dy: led.dy }, rot);
        const lx = anchorHole.x + offset.dx * PITCH;
        const ly = anchorHole.y + offset.dy * PITCH;

        const ledEl = svgEl('g', {
          class: `runtime-nano-led is-${led.id}${led.active ? ' is-lit' : ''}`,
          transform: `translate(${lx.toFixed(1)}, ${ly.toFixed(1)})`,
          'pointer-events': 'none'
        });

        if (led.active) {
          ledEl.appendChild(
            svgEl('circle', {
              cx: 0,
              cy: 0,
              r: led.auraR.toFixed(1),
              fill: led.color,
              opacity: led.auraOpacity.toFixed(2)
            })
          );
          ledEl.appendChild(
            svgEl('circle', {
              cx: 0,
              cy: 0,
              r: led.coreR.toFixed(1),
              fill: led.core,
              opacity: '0.96'
            })
          );
        } else {
          ledEl.appendChild(
            svgEl('circle', {
              cx: 0,
              cy: 0,
              r: '2.0',
              fill: '#0f172a',
              stroke: '#475569',
              'stroke-width': '0.7',
              opacity: '0.7'
            })
          );
        }

        frag.appendChild(ledEl);
      }
    }
  }

  // 2. DMM, FGEN & Scope Probe Markers
  const probes = [];
  if (showProbes) {
    if (dmmState?.probeBlack) {
      const hole = breadboard.getHole(dmmState.probeBlack);
      if (hole) {
        probes.push({ kind: 'black', hole, tag: 'COM', dirX: -1, dirY: -1 });
      }
    }
    if (dmmState?.probeRed) {
      const hole = breadboard.getHole(dmmState.probeRed);
      if (hole) {
        probes.push({ kind: 'red', hole, tag: '+', dirX: 1, dirY: -1 });
      }
    }
  }

  if (showFgenProbe && fgenProbeHole) {
    const hole = breadboard.getHole(fgenProbeHole);
    if (hole) {
      probes.push({ kind: 'fgen', hole, tag: 'FGEN', dirX: -1, dirY: 1 });
    }
  }

  if (showScopeProbes && scopeProbes) {
    if (scopeProbes.ch0?.enabled && scopeProbes.ch0?.source === 'PROBE' && scopeProbes.ch0?.probeHole) {
      const hole = breadboard.getHole(scopeProbes.ch0.probeHole);
      if (hole) {
        probes.push({ kind: 'scope-ch0', hole, tag: 'CH0', dirX: 1, dirY: 1 });
      }
    }
    if (scopeProbes.ch1?.enabled && scopeProbes.ch1?.source === 'PROBE' && scopeProbes.ch1?.probeHole) {
      const hole = breadboard.getHole(scopeProbes.ch1.probeHole);
      if (hole) {
        probes.push({ kind: 'scope-ch1', hole, tag: 'CH1', dirX: 1, dirY: -1 });
      }
    }
  }

  if (showBodeProbes && bodeProbes) {
    if (bodeProbes.inputHole) {
      const hole = breadboard.getHole(bodeProbes.inputHole);
      if (hole) {
        probes.push({ kind: 'bode-in', hole, tag: 'BIN', dirX: -1, dirY: 1 });
      }
    }
    if (bodeProbes.outputHole) {
      const hole = breadboard.getHole(bodeProbes.outputHole);
      if (hole) {
        probes.push({ kind: 'bode-out', hole, tag: 'BOUT', dirX: 1, dirY: 1 });
      }
    }
  }

  // Avoid visual overlap if multiple probes land on the exact same hole
  const holeSlotOffsets = new Map();
  const fallbackDirs = [
    [1, -1],
    [-1, -1],
    [1, 1],
    [-1, 1]
  ];

  const probePalette = {
    red: {
      ring: '#ef4444',
      outline: '#ffffff',
      pillBg: '#ef4444',
      pillStroke: '#ffffff',
      pillText: '#ffffff',
      pillW: 17,
      fontSize: 11
    },
    black: {
      ring: '#0f172a',
      outline: '#f8fafc',
      pillBg: '#0f172a',
      pillStroke: '#f8fafc',
      pillText: '#f8fafc',
      pillW: 28,
      fontSize: 8.5
    },
    fgen: {
      ring: '#06b6d4',
      outline: '#ffffff',
      pillBg: '#06b6d4',
      pillStroke: '#ffffff',
      pillText: '#041016',
      pillW: 32,
      fontSize: 8.5
    },
    'scope-ch0': {
      ring: '#22c55e',
      outline: '#ffffff',
      pillBg: '#22c55e',
      pillStroke: '#ffffff',
      pillText: '#031208',
      pillW: 28,
      fontSize: 8.5
    },
    'scope-ch1': {
      ring: '#eab308',
      outline: '#ffffff',
      pillBg: '#eab308',
      pillStroke: '#ffffff',
      pillText: '#140f02',
      pillW: 28,
      fontSize: 8.5
    },
    'bode-in': {
      ring: '#38bdf8',
      outline: '#ffffff',
      pillBg: '#38bdf8',
      pillStroke: '#ffffff',
      pillText: '#041016',
      pillW: 28,
      fontSize: 8.5
    },
    'bode-out': {
      ring: '#f472b6',
      outline: '#ffffff',
      pillBg: '#f472b6',
      pillStroke: '#ffffff',
      pillText: '#1a0612',
      pillW: 32,
      fontSize: 8.5
    }
  };

  for (const probe of probes) {
    const slotCount = holeSlotOffsets.get(probe.hole.id) || 0;
    holeSlotOffsets.set(probe.hole.id, slotCount + 1);

    let dirX = probe.dirX;
    let dirY = probe.dirY;
    if (slotCount > 0) {
      const [fx, fy] = fallbackDirs[slotCount % fallbackDirs.length];
      dirX = fx;
      dirY = fy;
    }

    const palette = probePalette[probe.kind] || probePalette.red;
    const tipX = probe.hole.x;
    const tipY = probe.hole.y;
    const endX = tipX + dirX * 13;
    const endY = tipY + dirY * 14;

    const pillW = palette.pillW;
    const pillH = 14;
    const pillX = endX + (dirX > 0 ? -3 : -pillW + 3);
    const pillY = endY + (dirY < 0 ? -pillH + 1 : -1);

    const isDmm = probe.kind === 'red' || probe.kind === 'black';
    const g = svgEl('g', {
      class: isDmm ? `runtime-dmm-probe is-${probe.kind}` : `runtime-instrument-probe is-${probe.kind}`,
      'pointer-events': 'none'
    });

    // High-contrast outer & inner ring around probed hole
    g.appendChild(
      svgEl('circle', {
        cx: tipX,
        cy: tipY,
        r: 6.4,
        fill: 'none',
        stroke: palette.outline,
        'stroke-width': 2.8
      })
    );
    g.appendChild(
      svgEl('circle', {
        cx: tipX,
        cy: tipY,
        r: 6.4,
        fill: 'none',
        stroke: palette.ring,
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
        stroke: palette.outline,
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
        stroke: palette.ring,
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
        fill: palette.pillBg,
        stroke: palette.pillStroke,
        'stroke-width': 1.3
      })
    );
    const label = svgEl('text', {
      x: pillX + pillW / 2,
      y: pillY + 10.2,
      fill: palette.pillText,
      'font-size': palette.fontSize,
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
  emgMode = false,
  simConfig,
  escapeHtml = defaultEscapeHtml
} = {}) {
  let controlsHtml = '';

  if (inst === 'sensor') {
    const blocks = [];
    if (loadCellsMode) {
      const grams = Number.isFinite(simConfig?.loadCellForceGrams) ? simConfig.loadCellForceGrams : 0;
      blocks.push(`
        <div class="inspector-control-row">
          <div class="inspector-control-head">
            <label for="sim-ctrl-load">Applied Load</label>
            <span class="inspector-control-val" data-sim-val="loadCellForceGrams">${Math.round(grams)} g</span>
          </div>
          <input id="sim-ctrl-load" class="inspector-slider" type="range" min="0" max="1000" step="10"
                 value="${Math.round(grams)}" data-sim-config="loadCellForceGrams" />
        </div>
      `);
    }
    if (emgMode) {
      const rawEmg = simConfig?.emg && typeof simConfig.emg === 'object' ? simConfig.emg : {};
      const flexPct = Math.round((Number.isFinite(rawEmg.flexEffort) ? Math.min(1, Math.max(0, rawEmg.flexEffort)) : 0.5) * 100);
      const isBurst = rawEmg.burstMode !== 'continuous';
      const humMvpp = Math.round(Number.isFinite(rawEmg.humMvpp) ? Math.min(50, Math.max(0, rawEmg.humMvpp)) : 0);
      blocks.push(`
        <div class="inspector-control-row">
          <div class="inspector-control-head">
            <label for="sim-ctrl-emg-flex">Muscle Flex Effort</label>
            <span class="inspector-control-val" data-sim-emg-val="flexEffort">${flexPct}%</span>
          </div>
          <input id="sim-ctrl-emg-flex" class="inspector-slider" type="range" min="0" max="100" step="5"
                 value="${flexPct}" data-sim-emg="flexEffort" />
        </div>
        <div class="inspector-control-row inspector-control-inline">
          <label>Contraction Mode</label>
          <button type="button" class="inspector-hold-btn ${isBurst ? 'is-pressed' : ''}" data-sim-emg="burstMode" aria-pressed="${isBurst}">
            ${isBurst ? 'Burst' : 'Hold'}
          </button>
        </div>
        <div class="inspector-control-row">
          <div class="inspector-control-head">
            <label for="sim-ctrl-emg-hum">60 Hz Mains Hum</label>
            <span class="inspector-control-val" data-sim-emg-val="humMvpp">${humMvpp} mVpp</span>
          </div>
          <input id="sim-ctrl-emg-hum" class="inspector-slider" type="range" min="0" max="50" step="1"
                 value="${humMvpp}" data-sim-emg="humMvpp" />
        </div>
      `);
    }
    controlsHtml = blocks.join('');
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
    !powered && (isActivePart || (inst === 'sensor' && (loadCellsMode || emgMode)))
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
