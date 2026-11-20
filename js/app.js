import {
  BreadboardModel,
  PITCH,
  BOARD_ORIGIN_X,
  BOARD_ORIGIN_Y,
  getRotatedPinOffset
} from './breadboard.js';
import { loadPartsCatalog } from './partsLoader.js';
import { analyzeCircuit } from './connectivity.js';
import {
  renderHorizontalBoardMarkup,
  renderVerticalElvisBoardMarkup,
  renderExternalSensorsMarkup,
  computeWirePath
} from './boardRenderer.js';
import { initRcCalculator } from './rcCalculator.js';
import {
  parseCircuitState,
  saveCircuitToLocalStorage,
  loadCircuitFromLocalStorage,
  downloadCircuitJson,
  exportBreadboardSvg,
  createStarterCircuit
} from './persistence.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const WIRE_COLORS = [
  { name: 'Red', hex: '#ef4444', stroke: '#b91c1c' },
  { name: 'Black', hex: '#1e293b', stroke: '#0f172a' },
  { name: 'Blue', hex: '#3b82f6', stroke: '#1d4ed8' },
  { name: 'Green', hex: '#22c55e', stroke: '#15803d' },
  { name: 'Yellow', hex: '#eab308', stroke: '#a16207' },
  { name: 'Orange', hex: '#f97316', stroke: '#c2410c' },
  { name: 'Purple', hex: '#a855f7', stroke: '#7e22ce' },
  { name: 'White', hex: '#f8fafc', stroke: '#94a3b8' }
];

class BreadboardPlannerApp {
  constructor() {
    this.breadboard = new BreadboardModel({ elvisMode: false });
    this.catalog = [];
    this.catalogMap = new Map();

    // Circuit State
    // Footprint parts store: { id, partId, anchorHoleId, rotation }
    // Two-lead parts store:  { id, partId, pinHoles: { P1, P2 } }
    this.placedParts = [];
    this.wires = []; // Array of { id, holeA, holeB, color, colorName }
    this.simState = {};
    this.nextId = 1;

    // Catalog Category State: collapsed & popped-out categories
    this.collapsedCategories = new Set(['Resistors (1% Metal Film)']);
    this.poppedOutCategories = new Map(); // categoryName -> { x, y }

    // UI / Interaction State
    this.interactionMode = 'build';
    this.onHolePointerDown = null;
    this.activeWireColor = WIRE_COLORS[0];
    this.activeWireStyle = 'curved'; // 'curved' (stranded jumper) | 'straight' (solid-core wire)
    this.showXray = false;
    this.selectedItem = null; // { type: 'part' | 'wire' | 'sensor', id }
    this.hoveredHoleId = null;
    this.hoveredPartId = null;

    // Viewport pan/zoom
    this.viewZoom = 1;
    this.viewPan = { x: 0, y: 0 };
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.panMovedDist = 0;
    this.spacePressed = false;

    // Active drag operation
    this.dragState = null;
    this.floatingWindowDrag = null;

    this.connectivity = null;
  }

  async init() {
    this.cacheDom();
    this.catalog = await loadPartsCatalog();
    this.collapsedCategories = new Set();
    for (const part of this.catalog) {
      this.catalogMap.set(part.id, part);
      this.collapsedCategories.add(part.category);
    }

    this.renderWireSwatches();
    this.updateWireStyleButton();
    this.renderCatalogSidebar();
    this.setupSvgCanvas();
    this.setupRcCalculator();
    this.bindEvents();

    // Load saved circuit or starter demo
    if (!this.loadFromLocalStorage()) {
      this.loadStarterCircuit();
    } else {
      this.recalculateAndRender();
    }
  }

  cacheDom() {
    this.appShellEl = document.querySelector('.app-shell');
    this.catalogContainer = document.getElementById('catalog-list');
    this.searchInput = document.getElementById('part-search');
    this.btnCollapseSidebar = document.getElementById('btn-collapse-sidebar');
    this.btnExpandSidebar = document.getElementById('btn-expand-sidebar');
    this.floatingPalettesLayer = document.getElementById('floating-palettes-layer');
    this.svgEl = document.getElementById('breadboard-svg');
    this.canvasWrap = document.getElementById('canvas-container');
    this.wireSwatchesEl = document.getElementById('wire-swatches');
    this.btnWireStyle = document.getElementById('btn-wire-style');
    this.inspectorEl = document.getElementById('selection-inspector');
    this.statusHoleEl = document.getElementById('status-hole');
    this.statusNetEl = document.getElementById('status-net');
    this.warningBannerEl = document.getElementById('short-warning-banner');

    // Buttons
    this.btnXray = document.getElementById('btn-xray');
    this.btnElvisMode = document.getElementById('btn-elvis-mode');
    this.btnLoadCells = document.getElementById('btn-load-cells');
    this.btnEmgMode = document.getElementById('btn-emg-mode');
    this.btnRcCalc = document.getElementById('btn-rc-calc');
    this.btnRotate = document.getElementById('btn-rotate');
    this.btnDelete = document.getElementById('btn-delete');
    this.btnStarter = document.getElementById('btn-starter');
    this.btnClear = document.getElementById('btn-clear');
    this.btnSaveJson = document.getElementById('btn-save-json');
    this.btnLoadJson = document.getElementById('btn-load-json');
    this.fileLoadInput = document.getElementById('file-load-json');
    this.btnExportSvg = document.getElementById('btn-export-svg');
    this.btnPanLeft = document.getElementById('btn-pan-left');
    this.btnPanUp = document.getElementById('btn-pan-up');
    this.btnPanDown = document.getElementById('btn-pan-down');
    this.btnPanRight = document.getElementById('btn-pan-right');
    this.btnZoomIn = document.getElementById('btn-zoom-in');
    this.btnZoomOut = document.getElementById('btn-zoom-out');
    this.btnZoomReset = document.getElementById('btn-zoom-reset');

    // RC Filter Calculator Elements
    this.rcCalcPanel = document.getElementById('rc-calculator-panel');
    this.rcCalcHeader = document.getElementById('rc-calc-header');
    this.btnRcClear = document.getElementById('btn-rc-clear');
    this.btnRcClose = document.getElementById('btn-rc-close');
    this.rcInputR = document.getElementById('rc-input-r');
    this.rcUnitR = document.getElementById('rc-unit-r');
    this.rcBadgeR = document.getElementById('rc-badge-r');
    this.rcInputC = document.getElementById('rc-input-c');
    this.rcUnitC = document.getElementById('rc-unit-c');
    this.rcBadgeC = document.getElementById('rc-badge-c');
    this.rcInputF = document.getElementById('rc-input-f');
    this.rcUnitF = document.getElementById('rc-unit-f');
    this.rcBadgeF = document.getElementById('rc-badge-f');
  }

  generateId(prefix = 'item') {
    return `${prefix}_${this.nextId++}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // ---------------------------------------------------------------------------
  // Catalog, Category Collapse/Pop-Out & Wire Color UI
  // ---------------------------------------------------------------------------
  renderWireSwatches() {
    this.wireSwatchesEl.innerHTML = '';
    for (const c of WIRE_COLORS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `wire-swatch ${c.name === this.activeWireColor.name ? 'active' : ''}`;
      btn.style.setProperty('--swatch-color', c.hex);
      btn.title = `${c.name} Jumper Wire`;
      btn.setAttribute('aria-label', `${c.name} Wire`);
      btn.addEventListener('click', () => {
        this.activeWireColor = c;
        this.renderWireSwatches();
        if (this.selectedItem?.type === 'wire') {
          const wire = this.wires.find((w) => w.id === this.selectedItem.id);
          if (wire) {
            wire.color = c.hex;
            wire.colorName = c.name;
            this.recalculateAndRender();
          }
        }
      });
      this.wireSwatchesEl.appendChild(btn);
    }
  }

  updateWireStyleButton() {
    if (!this.btnWireStyle) return;
    const isSolid = this.activeWireStyle === 'straight';
    this.btnWireStyle.textContent = isSolid ? '╱ Solid' : '⌒ Flex';
    this.btnWireStyle.classList.toggle('solid-mode', isSolid);
  }

  setWiresFaded(faded) {
    if (!this.wiresLayer) return;
    this.wiresLayer.classList.toggle('wires-faded', Boolean(faded));
  }

  createPartCardElement(part) {
    const card = document.createElement('div');
    card.className = 'part-card';
    card.dataset.partId = part.id;
    card.title = `${part.name}\n${part.description || ''}\nDrag onto breadboard or click to add`;

    const previewWrap = document.createElement('div');
    previewWrap.className = 'part-card-preview';

    if (part.placement === 'two-lead') {
      previewWrap.innerHTML = `
        <svg viewBox="-34 -14 68 28" class="part-thumb-svg">
          <line x1="-30" y1="0" x2="-${part.leadAttachOffset}" y2="0" stroke="#94a3b8" stroke-width="2.2" stroke-linecap="round"/>
          <line x1="${part.leadAttachOffset}" y1="0" x2="30" y2="0" stroke="#94a3b8" stroke-width="2.2" stroke-linecap="round"/>
          <g>${part.svgInnerMarkup}</g>
        </svg>
      `;
    } else {
      previewWrap.innerHTML = `
        <svg viewBox="${part.svgViewBox}" class="part-thumb-svg part-thumb-large">
          ${part.svgInnerMarkup}
        </svg>
      `;
    }

    const metaWrap = document.createElement('div');
    metaWrap.className = 'part-card-meta';

    const titleEl = document.createElement('div');
    titleEl.className = 'part-card-name';
    titleEl.textContent = part.shortLabel || part.name;
    metaWrap.appendChild(titleEl);

    if (part.bands) {
      const subEl = document.createElement('div');
      subEl.className = 'part-card-sub';
      subEl.textContent = part.bands.slice(0, 4).join('·');
      metaWrap.appendChild(subEl);
    } else {
      const subEl = document.createElement('div');
      subEl.className = 'part-card-sub';
      subEl.textContent =
        part.id === 'arduino-nano'
          ? '30-Pin DIP'
          : part.id === 'opamp-dual-dip8'
          ? '8-Pin DIP (LM358/TL072)'
          : part.id === 'inamp-ad620'
          ? '8-Pin DIP (AD620 In-Amp)'
          : part.id === 'pot-side-turn'
          ? '2-Pitch Inline (5 holes)'
          : part.id === 'pot-top-turn'
          ? '1-Pitch Triangle'
          : part.id === 'pushbutton-4pin'
          ? '4-Pin (Trough Bridge)'
          : part.id === 'diode-1n4007'
          ? '1N4007 (+ Anode / − Band)'
          : part.id === 'led-red'
          ? '5mm (+ Anode / − Flat)'
          : part.id === 'photoresistor'
          ? 'CdS Light Sensor'
          : part.id === 'cap-10uf'
          ? 'Polarized Decoupling (+ / −)'
          : part.marking
          ? `Code ${part.marking}`
          : '';
      metaWrap.appendChild(subEl);
    }

    card.appendChild(previewWrap);
    card.appendChild(metaWrap);

    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.startCatalogDrag(part, e);
    });

    return card;
  }

  renderCatalogSidebar(filterText = '') {
    const query = filterText.trim().toLowerCase();
    this.catalogContainer.innerHTML = '';

    const groups = new Map();
    for (const part of this.catalog) {
      if (query) {
        const hay = `${part.name} ${part.category} ${part.description || ''} ${(part.bands || []).join(' ')}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      if (!groups.has(part.category)) {
        groups.set(part.category, []);
      }
      groups.get(part.category).push(part);
    }

    for (const [category, parts] of groups.entries()) {
      const isCollapsed = !query && this.collapsedCategories.has(category);
      const isPoppedOut = this.poppedOutCategories.has(category);

      const section = document.createElement('div');
      section.className = `catalog-category ${isCollapsed ? 'collapsed' : ''} ${isPoppedOut ? 'popped-out' : ''}`;

      const headerRow = document.createElement('div');
      headerRow.className = 'catalog-category-header';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'category-toggle-btn';
      toggleBtn.title = isCollapsed ? `Show ${category}` : `Hide ${category}`;
      toggleBtn.innerHTML = `
        <span class="category-chevron">${isCollapsed ? '▸' : '▾'}</span>
        <span class="catalog-category-title">${category}</span>
        <span class="category-count">${parts.length}</span>
      `;
      toggleBtn.addEventListener('click', () => {
        if (this.collapsedCategories.has(category)) {
          this.collapsedCategories.delete(category);
        } else {
          this.collapsedCategories.add(category);
        }
        this.renderCatalogSidebar(this.searchInput.value);
      });

      const popBtn = document.createElement('button');
      popBtn.type = 'button';
      popBtn.className = `category-popout-btn ${isPoppedOut ? 'active' : ''}`;
      popBtn.title = isPoppedOut ? 'Dock category back into sidebar' : 'Pop out category into floating window';
      popBtn.textContent = isPoppedOut ? '↙ Dock' : '⧉ Pop';
      popBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePopOutCategory(category);
      });

      headerRow.appendChild(toggleBtn);
      headerRow.appendChild(popBtn);
      section.appendChild(headerRow);

      if (isPoppedOut) {
        const notice = document.createElement('div');
        notice.className = 'popped-out-notice';
        notice.textContent = 'Popped out as floating window';
        section.appendChild(notice);
      } else if (!isCollapsed) {
        const grid = document.createElement('div');
        grid.className = 'catalog-grid';
        for (const part of parts) {
          grid.appendChild(this.createPartCardElement(part));
        }
        section.appendChild(grid);
      }

      this.catalogContainer.appendChild(section);
    }

    this.renderFloatingPalettes();
  }

  togglePopOutCategory(category) {
    if (this.poppedOutCategories.has(category)) {
      this.poppedOutCategories.delete(category);
    } else {
      const idx = this.poppedOutCategories.size;
      this.poppedOutCategories.set(category, {
        x: 24 + (idx * 28) % 180,
        y: 20 + (idx * 36) % 160
      });
    }
    this.renderCatalogSidebar(this.searchInput.value);
  }

  renderFloatingPalettes() {
    if (!this.floatingPalettesLayer) return;
    this.floatingPalettesLayer.innerHTML = '';

    for (const [category, pos] of this.poppedOutCategories.entries()) {
      const parts = this.catalog.filter((p) => p.category === category);
      if (parts.length === 0) continue;

      const win = document.createElement('div');
      win.className = 'floating-palette';
      win.style.left = `${pos.x}px`;
      win.style.top = `${pos.y}px`;

      const titleBar = document.createElement('div');
      titleBar.className = 'floating-palette-header';
      titleBar.innerHTML = `
        <span class="floating-palette-title">${category}</span>
        <button type="button" class="floating-palette-close" title="Dock back to sidebar">✕</button>
      `;

      titleBar.querySelector('.floating-palette-close').addEventListener('click', () => {
        this.poppedOutCategories.delete(category);
        this.renderCatalogSidebar(this.searchInput.value);
      });

      titleBar.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        this.floatingWindowDrag = {
          category,
          winEl: win,
          startClientX: e.clientX,
          startClientY: e.clientY,
          origX: pos.x,
          origY: pos.y
        };
      });

      const body = document.createElement('div');
      body.className = 'floating-palette-body catalog-grid';
      for (const part of parts) {
        body.appendChild(this.createPartCardElement(part));
      }

      win.appendChild(titleBar);
      win.appendChild(body);
      this.floatingPalettesLayer.appendChild(win);
    }
  }

  // ---------------------------------------------------------------------------
  // SVG Breadboard & Rotated NI ELVIS II Setup
  // ---------------------------------------------------------------------------
  setupSvgCanvas() {
    this.svgEl.innerHTML = '';

    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = `
      <filter id="boardShadow" x="-5%" y="-5%" width="110%" height="114%">
        <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#020617" flood-opacity="0.45"/>
      </filter>
      <filter id="partDropShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-color="#0f172a" flood-opacity="0.38"/>
      </filter>
      <filter id="dragLiftShadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="8" stdDeviation="5" flood-color="#020617" flood-opacity="0.5"/>
      </filter>
    `;
    this.svgEl.appendChild(defs);

    this.viewportGroup = document.createElementNS(SVG_NS, 'g');
    this.viewportGroup.setAttribute('id', 'viewport-root');

    this.boardBaseLayer = document.createElementNS(SVG_NS, 'g');
    this.xrayLayer = document.createElementNS(SVG_NS, 'g');
    this.highlightLayer = document.createElementNS(SVG_NS, 'g');
    this.holesLayer = document.createElementNS(SVG_NS, 'g');
    this.partsLayer = document.createElementNS(SVG_NS, 'g');
    this.wiresLayer = document.createElementNS(SVG_NS, 'g');
    this.wiresLayer.setAttribute('class', 'wires-layer');
    this.runtimeOverlayLayer = document.createElementNS(SVG_NS, 'g');
    this.runtimeOverlayLayer.setAttribute('id', 'layer-runtime-overlay');
    this.interactionLayer = document.createElementNS(SVG_NS, 'g');

    this.viewportGroup.append(
      this.boardBaseLayer,
      this.xrayLayer,
      this.highlightLayer,
      this.holesLayer,
      this.partsLayer,
      this.wiresLayer,
      this.runtimeOverlayLayer,
      this.interactionLayer
    );
    this.svgEl.appendChild(this.viewportGroup);

    this.updateBoardViewBox();
    this.renderBreadboardBase();
    this.renderXrayLayer();
    this.renderBreadboardHoles();
  }

  updateBoardViewBox() {
    const vb = this.breadboard.getBoardViewBox();
    this.svgEl.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
  }

  renderBreadboardBase() {
    this.boardBaseLayer.innerHTML = '';
    const mainMarkup = this.breadboard.elvisMode
      ? renderVerticalElvisBoardMarkup(this.breadboard)
      : renderHorizontalBoardMarkup(this.breadboard);
    const sensorsMarkup = renderExternalSensorsMarkup(this.breadboard, {
      isSensorSelected: this.selectedItem?.type === 'sensor'
    });
    this.boardBaseLayer.innerHTML = mainMarkup + sensorsMarkup;

    // Allow clicking any external sensor illustration or terminal block to select it & press [R] to rotate around board
    for (const el of this.boardBaseLayer.querySelectorAll('.external-sensor-selectable')) {
      el.style.cursor = 'pointer';
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.selectItem('sensor', 'sensors');
      });
    }
  }

  renderXrayLayer() {
    this.xrayLayer.innerHTML = '';
    this.xrayLayer.style.display = this.showXray ? 'block' : 'none';

    let paths = '';
    for (const [, holes] of this.breadboard.strips.entries()) {
      if (holes.length < 2) continue;
      const first = holes[0];
      const last = holes[holes.length - 1];
      const isRail = first.type === 'rail';
      const isElvis = first.type === 'elvis';
      const color = isRail
        ? first.polarity === 'pos'
          ? 'rgba(239, 68, 68, 0.22)'
          : 'rgba(59, 130, 246, 0.22)'
        : isElvis
        ? 'rgba(16, 185, 129, 0.28)'
        : 'rgba(217, 119, 6, 0.22)';
      paths += `<line x1="${first.x}" y1="${first.y}" x2="${last.x}" y2="${last.y}"
                      stroke="${color}" stroke-width="7" stroke-linecap="round" pointer-events="none"/>`;
    }
    this.xrayLayer.innerHTML = paths;
  }

  renderBreadboardHoles() {
    this.holesLayer.innerHTML = '';
    this.holeElements = new Map();

    const frag = document.createDocumentFragment();
    for (const hole of this.breadboard.holes.values()) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `bb-hole ${hole.type === 'elvis' ? 'elvis-hole' : ''}`);
      g.dataset.holeId = hole.id;
      g.setAttribute('transform', `translate(${hole.x}, ${hole.y})`);

      g.innerHTML = `
        <rect x="-5.2" y="-5.2" width="10.4" height="10.4" rx="2.2" class="bb-hole-hit"/>
        <rect x="-3.6" y="-3.6" width="7.2" height="7.2" rx="1.5" class="bb-hole-bevel"/>
        <rect x="-2.1" y="-2.1" width="4.2" height="4.2" rx="0.9" class="bb-hole-socket"/>
      `;

      g.addEventListener('pointerenter', () => this.onHoleHover(hole.id));
      g.addEventListener('pointerleave', () => {
        if (this.hoveredHoleId === hole.id) {
          this.onHoleHover(null);
        }
      });

      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.handleHolePointerDown(hole, e);
      });

      this.holeElements.set(hole.id, g);
      frag.appendChild(g);
    }
    this.holesLayer.appendChild(frag);
  }

  handleHolePointerDown(hole, e) {
    if (typeof this.onHolePointerDown === 'function' && this.onHolePointerDown(hole, e, this.interactionMode) === true) {
      return;
    }
    if (this.interactionMode !== 'build') return;
    this.startWireDrawFromHole(hole, e);
  }

  // ---------------------------------------------------------------------------
  // Circuit Analysis, Rendering & Net Highlighting
  // ---------------------------------------------------------------------------
  recalculateAndRender({ save = true } = {}) {
    this.connectivity = analyzeCircuit(
      this.breadboard,
      this.placedParts,
      this.wires,
      this.catalogMap
    );

    this.renderWires();
    this.renderPlacedParts();
    this.renderNetHighlights();
    this.updateInspectorUI();
    this.updateWarningsBanner();
    if (save) {
      this.saveToLocalStorage();
    }
  }

  renderWires() {
    this.wiresLayer.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const wire of this.wires) {
      const hA = this.breadboard.getHole(wire.holeA);
      const hB = this.breadboard.getHole(wire.holeB);
      if (!hA || !hB) continue;

      const isSelected = this.selectedItem?.type === 'wire' && this.selectedItem.id === wire.id;
      const wireStyle = wire.style || 'curved';
      const isStraight = wireStyle === 'straight';
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', `circuit-wire ${isSelected ? 'selected' : ''}`);
      g.dataset.wireId = wire.id;

      const d = computeWirePath(hA.x, hA.y, hB.x, hB.y, wireStyle);
      const bodyWidth = isStraight ? 3.8 : 4.4;
      const endFill = isStraight ? '#cbd5e1' : '#1e293b';
      const endStroke = isStraight ? '#475569' : '#94a3b8';
      const endRadius = isStraight ? 2.9 : 3.4;
      const isBlackWire = wire.color === '#1e293b' || wire.colorName === 'Black';

      g.innerHTML = `
        <path d="${d}" fill="none" stroke="transparent" stroke-width="12" stroke-linecap="round" class="wire-hit"/>
        <path d="${d}" fill="none" stroke="rgba(15,23,42,0.32)" stroke-width="${bodyWidth + 1.2}" stroke-linecap="round" transform="translate(0, ${isStraight ? 1.2 : 2})"/>
        ${isSelected ? `<path d="${d}" fill="none" stroke="#38bdf8" stroke-width="8.5" stroke-linecap="round" opacity="0.65"/>` : ''}
        ${isBlackWire ? `<path d="${d}" fill="none" stroke="#94a3b8" stroke-width="${bodyWidth + 1.3}" stroke-linecap="round" opacity="0.85"/>` : ''}
        <circle cx="${hA.x}" cy="${hA.y}" r="${endRadius}" fill="${endFill}" stroke="${endStroke}" stroke-width="1.1"/>
        <circle cx="${hB.x}" cy="${hB.y}" r="${endRadius}" fill="${endFill}" stroke="${endStroke}" stroke-width="1.1"/>
        <path d="${d}" fill="none" stroke="${wire.color}" stroke-width="${bodyWidth}" stroke-linecap="round" class="wire-body"/>
        <path d="${d}" fill="none" stroke="rgba(255,255,255,0.36)" stroke-width="1.2" stroke-linecap="round" pointer-events="none"/>
        <circle cx="${hA.x}" cy="${hA.y}" r="5.5" class="pin-drag-handle" data-end="A"/>
        <circle cx="${hB.x}" cy="${hB.y}" r="5.5" class="pin-drag-handle" data-end="B"/>
      `;

      g.addEventListener('pointerenter', () => this.onHoleHover(wire.holeA));
      g.addEventListener('pointerleave', () => this.onHoleHover(null));

      g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.selectItem('wire', wire.id);
        const endAttr = e.target.getAttribute('data-end');
        if (endAttr === 'A' || endAttr === 'B') {
          this.startMoveWireEnd(wire, endAttr, e);
        }
      });

      frag.appendChild(g);
    }

    this.wiresLayer.appendChild(frag);
  }

  renderPlacedParts() {
    this.partsLayer.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const inst of this.placedParts) {
      const partDef = this.catalogMap.get(inst.partId);
      if (!partDef) continue;

      const isSelected = this.selectedItem?.type === 'part' && this.selectedItem.id === inst.id;

      if (partDef.placement === 'two-lead') {
        const el = this.renderTwoLeadPart(inst, partDef, isSelected);
        if (el) frag.appendChild(el);
      } else if (partDef.placement === 'footprint') {
        const el = this.renderFootprintPart(inst, partDef, isSelected);
        if (el) frag.appendChild(el);
      }
    }

    this.partsLayer.appendChild(frag);
  }

  renderTwoLeadPart(inst, partDef, isSelected) {
    const h1 = this.breadboard.getHole(inst.pinHoles.P1);
    const h2 = this.breadboard.getHole(inst.pinHoles.P2);
    if (!h1 || !h2) return null;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `placed-part two-lead-part ${isSelected ? 'selected' : ''}`);
    g.dataset.instanceId = inst.id;

    g.addEventListener('pointerenter', () => {
      this.hoveredPartId = inst.id;
      this.setWiresFaded(true);
    });
    g.addEventListener('pointerleave', () => {
      if (this.hoveredPartId === inst.id) {
        this.hoveredPartId = null;
      }
      if (!this.dragState) {
        this.setWiresFaded(false);
      }
    });

    const mx = (h1.x + h2.x) / 2;
    const my = (h1.y + h2.y) / 2;
    const dx = h2.x - h1.x;
    const dy = h2.y - h1.y;
    const dist = Math.hypot(dx, dy) || 1;
    let angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

    const ux = dx / dist;
    const uy = dy / dist;
    const attach = Math.min(partDef.leadAttachOffset || 14, dist * 0.42);

    const bodyStart1X = mx - ux * attach;
    const bodyStart1Y = my - uy * attach;
    const bodyStart2X = mx + ux * attach;
    const bodyStart2Y = my + uy * attach;

    if (!partDef.polarized && (angleDeg > 90 || angleDeg < -90)) {
      angleDeg += 180;
    }

    g.innerHTML = `
      <circle cx="${h1.x}" cy="${h1.y}" r="3.4" fill="#cbd5e1" stroke="#475569" stroke-width="1.1"/>
      <circle cx="${h2.x}" cy="${h2.y}" r="3.4" fill="#cbd5e1" stroke="#475569" stroke-width="1.1"/>

      <line x1="${h1.x}" y1="${h1.y}" x2="${bodyStart1X.toFixed(1)}" y2="${bodyStart1Y.toFixed(1)}"
            stroke="#64748b" stroke-width="3.2" stroke-linecap="round"/>
      <line x1="${h1.x}" y1="${h1.y}" x2="${bodyStart1X.toFixed(1)}" y2="${bodyStart1Y.toFixed(1)}"
            stroke="#e2e8f0" stroke-width="1.8" stroke-linecap="round"/>

      <line x1="${bodyStart2X.toFixed(1)}" y1="${bodyStart2Y.toFixed(1)}" x2="${h2.x}" y2="${h2.y}"
            stroke="#64748b" stroke-width="3.2" stroke-linecap="round"/>
      <line x1="${bodyStart2X.toFixed(1)}" y1="${bodyStart2Y.toFixed(1)}" x2="${h2.x}" y2="${h2.y}"
            stroke="#e2e8f0" stroke-width="1.8" stroke-linecap="round"/>

      <g class="part-body-group" transform="translate(${mx.toFixed(1)}, ${my.toFixed(1)}) rotate(${angleDeg.toFixed(1)})" filter="url(#partDropShadow)">
        ${isSelected ? `<rect x="${-partDef.bodyWidth / 2 - 3}" y="${-partDef.bodyHeight / 2 - 3}" width="${partDef.bodyWidth + 6}" height="${partDef.bodyHeight + 6}" rx="6" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-dasharray="3 2"/>` : ''}
        ${partDef.svgInnerMarkup}
      </g>

      <text x="${mx.toFixed(1)}" y="${(my - 13).toFixed(1)}" class="part-floating-label">${partDef.shortLabel || partDef.name}</text>

      <g class="lead-handle-group" data-pin="P1" transform="translate(${h1.x}, ${h1.y})">
        <circle cx="0" cy="0" r="6.8" class="lead-handle-ring"/>
        <circle cx="0" cy="0" r="3.2" class="lead-handle-dot"/>
      </g>
      <g class="lead-handle-group" data-pin="P2" transform="translate(${h2.x}, ${h2.y})">
        <circle cx="0" cy="0" r="6.8" class="lead-handle-ring"/>
        <circle cx="0" cy="0" r="3.2" class="lead-handle-dot"/>
      </g>
    `;

    const bodyGroup = g.querySelector('.part-body-group');
    bodyGroup.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.selectItem('part', inst.id);
      this.startMovePart(inst, partDef, e);
    });

    for (const handle of g.querySelectorAll('.lead-handle-group')) {
      const pinId = handle.dataset.pin;
      const holeId = inst.pinHoles[pinId];
      const pinLabel = partDef.pins?.find((p) => p.id === pinId)?.label || (pinId === 'P1' ? 'Lead 1' : 'Lead 2');
      handle.addEventListener('pointerenter', () => this.onHoleHover(holeId, `${partDef.name} (${pinLabel})`));
      handle.addEventListener('pointerleave', () => this.onHoleHover(null));
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.selectItem('part', inst.id);
        this.startMoveLead(inst, partDef, pinId, e);
      });
    }

    return g;
  }

  renderFootprintPart(inst, partDef, isSelected) {
    const anchorHole = this.breadboard.getHole(inst.anchorHoleId);
    if (!anchorHole) return null;

    const anchorX = anchorHole.x;
    const anchorY = anchorHole.y;
    const rot = inst.rotation || 0;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `placed-part footprint-part ${isSelected ? 'selected' : ''}`);
    g.dataset.instanceId = inst.id;
    g.setAttribute('transform', `translate(${anchorX}, ${anchorY})`);

    g.addEventListener('pointerenter', () => {
      this.hoveredPartId = inst.id;
      this.setWiresFaded(true);
    });
    g.addEventListener('pointerleave', () => {
      if (this.hoveredPartId === inst.id) {
        this.hoveredPartId = null;
      }
      if (!this.dragState) {
        this.setWiresFaded(false);
      }
    });

    const bo = partDef.bodyOffset || { x: -14, y: -10, width: 252, height: 116 };

    let pinsOverlay = '';
    for (const pin of partDef.pins) {
      const { dx, dy } = getRotatedPinOffset(pin, rot);
      const px = dx * PITCH;
      const py = dy * PITCH;
      const hole = this.breadboard.getHoleAtGrid(anchorHole.gridX + dx, anchorHole.gridY + dy);
      const holeId = hole ? hole.id : '';
      pinsOverlay += `
        <circle cx="${px}" cy="${py}" r="5.5" class="footprint-pin-hit"
                data-pin-id="${pin.id}" data-pin-label="${pin.label}" data-hole-id="${holeId}"/>
      `;
    }

    g.innerHTML = `
      <g class="part-body-group" transform="rotate(${rot})" filter="url(#partDropShadow)">
        ${isSelected ? `<rect x="${bo.x - 3}" y="${bo.y - 3}" width="${bo.width + 6}" height="${bo.height + 6}" rx="6" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="4 2"/>` : ''}
        ${partDef.svgInnerMarkup}
      </g>
      <g class="footprint-pins-layer">
        ${pinsOverlay}
      </g>
    `;

    const bodyGroup = g.querySelector('.part-body-group');
    bodyGroup.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.selectItem('part', inst.id);
      this.startMovePart(inst, partDef, e);
    });

    for (const pinEl of g.querySelectorAll('.footprint-pin-hit')) {
      const holeId = pinEl.dataset.holeId;
      const pinLabel = pinEl.dataset.pinLabel;
      pinEl.addEventListener('pointerenter', () => {
        if (holeId) {
          this.onHoleHover(holeId, `${partDef.name} [${pinLabel}]`);
        }
      });
      pinEl.addEventListener('pointerleave', () => this.onHoleHover(null));
      pinEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const hole = this.breadboard.getHole(holeId);
        if (hole) {
          this.handleHolePointerDown(hole, e);
        }
      });
    }

    return g;
  }

  // ---------------------------------------------------------------------------
  // Connectivity Highlighting & Status Bar
  // ---------------------------------------------------------------------------
  onHoleHover(holeId, customPinTitle = null) {
    this.hoveredHoleId = holeId;
    this.hoveredPinTitle = customPinTitle;
    this.renderNetHighlights();
    this.updateStatusBar();
  }

  renderNetHighlights() {
    this.highlightLayer.innerHTML = '';

    for (const el of this.holeElements.values()) {
      el.classList.remove('hole-strip-active', 'hole-net-active', 'hole-shorted');
    }

    if (!this.hoveredHoleId || !this.connectivity) return;

    const hoveredHole = this.breadboard.getHole(this.hoveredHoleId);
    const net = this.connectivity.getNetForHole(this.hoveredHoleId);
    if (!hoveredHole || !net) return;

    const stripHoles = this.breadboard.getStripHoles(hoveredHole.stripId);
    if (stripHoles.length >= 2) {
      const first = stripHoles[0];
      const last = stripHoles[stripHoles.length - 1];
      const stripLine = document.createElementNS(SVG_NS, 'line');
      stripLine.setAttribute('x1', first.x);
      stripLine.setAttribute('y1', first.y);
      stripLine.setAttribute('x2', last.x);
      stripLine.setAttribute('y2', last.y);
      stripLine.setAttribute('class', net.isShorted ? 'net-strip-line shorted' : 'net-strip-line primary');
      this.highlightLayer.appendChild(stripLine);
    }

    for (const stripId of net.strips) {
      if (stripId === hoveredHole.stripId) continue;
      const sHoles = this.breadboard.getStripHoles(stripId);
      if (sHoles.length >= 2) {
        const first = sHoles[0];
        const last = sHoles[sHoles.length - 1];
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', first.x);
        line.setAttribute('y1', first.y);
        line.setAttribute('x2', last.x);
        line.setAttribute('y2', last.y);
        line.setAttribute('class', net.isShorted ? 'net-strip-line shorted' : 'net-strip-line secondary');
        this.highlightLayer.appendChild(line);
      }
    }

    for (const hId of net.holes) {
      const el = this.holeElements.get(hId);
      if (!el) continue;
      if (net.isShorted) {
        el.classList.add('hole-shorted');
      } else if (hoveredHole.stripId === this.breadboard.getHole(hId)?.stripId) {
        el.classList.add('hole-strip-active');
      } else {
        el.classList.add('hole-net-active');
      }
    }
  }

  updateStatusBar() {
    if (!this.hoveredHoleId) {
      this.statusHoleEl.textContent = 'Hover any hole, pin, or wire to inspect connections';
      this.statusNetEl.textContent = this.breadboard.elvisMode
        ? 'NI ELVIS II Vertical Layout (54 Rows + 830-Pt Board)'
        : '830 Tie Points Ready';
      this.statusNetEl.className = 'status-pill';
      return;
    }

    const hole = this.breadboard.getHole(this.hoveredHoleId);
    const net = this.connectivity?.getNetForHole(this.hoveredHoleId);
    if (!hole || !net) return;

    this.statusHoleEl.textContent = this.hoveredPinTitle
      ? `${this.hoveredPinTitle} → ${hole.displayName}`
      : hole.displayName;

    const pinSummaries = net.pins.map((p) => `${p.partName} [${p.pinLabel}]`);
    let roleTag = 'Signal Net';
    let pillClass = 'status-pill net-signal';

    if (net.isShorted) {
      roleTag = 'SHORT CIRCUIT!';
      pillClass = 'status-pill net-short';
    } else if (net.hasPower) {
      roleTag = `Power Net (${Array.from(net.powerLabels).join('/')})`;
      pillClass = 'status-pill net-power';
    } else if (net.hasGround) {
      roleTag = 'Ground Net (GND)';
      pillClass = 'status-pill net-ground';
    }

    if (pinSummaries.length > 0) {
      this.statusNetEl.textContent = `${roleTag}: ${pinSummaries.join(' • ')}`;
    } else {
      this.statusNetEl.textContent = `${roleTag} (${net.strips.size} strip${net.strips.size > 1 ? 's' : ''}, ${net.holes.size} holes)`;
    }
    this.statusNetEl.className = pillClass;
  }

  updateWarningsBanner() {
    const warnings = this.connectivity?.warnings || [];
    if (warnings.length === 0) {
      this.warningBannerEl.hidden = true;
      this.warningBannerEl.textContent = '';
    } else {
      this.warningBannerEl.hidden = false;
      this.warningBannerEl.textContent = `⚠️ ${warnings.map((w) => w.message).join(' | ')}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Drag and Drop / Placement / Wire Drawing Interactions
  // ---------------------------------------------------------------------------
  clientToSvgPoint(clientX, clientY) {
    const pt = this.svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = this.viewportGroup.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    return pt.matrixTransform(ctm.inverse());
  }

  startCatalogDrag(partDef, e) {
    const svgPt = this.clientToSvgPoint(e.clientX, e.clientY);
    const defaultRot = this.breadboard.elvisMode && partDef.placement === 'footprint' ? 90 : 0;
    this.dragState = {
      mode: 'catalog-part',
      partDef,
      defaultRot,
      startClientX: e.clientX,
      startClientY: e.clientY,
      currentSvgPt: svgPt,
      hasMovedOnBoard: false
    };
    this.setWiresFaded(true);
    this.renderDragPreview();
  }

  startMovePart(inst, partDef, e) {
    const svgPt = this.clientToSvgPoint(e.clientX, e.clientY);
    this.setWiresFaded(true);
    if (partDef.placement === 'two-lead') {
      const h1 = this.breadboard.getHole(inst.pinHoles.P1);
      const h2 = this.breadboard.getHole(inst.pinHoles.P2);
      if (!h1 || !h2) return;
      const midX = (h1.x + h2.x) / 2;
      const midY = (h1.y + h2.y) / 2;
      this.dragState = {
        mode: 'move-part',
        inst,
        partDef,
        offsetX: svgPt.x - midX,
        offsetY: svgPt.y - midY,
        leadDeltaGx: h2.gridX - h1.gridX,
        leadDeltaGy: h2.gridY - h1.gridY
      };
    } else {
      const anchorHole = this.breadboard.getHole(inst.anchorHoleId);
      if (!anchorHole) return;
      this.dragState = {
        mode: 'move-part',
        inst,
        partDef,
        offsetX: svgPt.x - anchorHole.x,
        offsetY: svgPt.y - anchorHole.y
      };
    }
  }

  startMoveLead(inst, partDef, pinId, e) {
    const svgPt = this.clientToSvgPoint(e.clientX, e.clientY);
    this.setWiresFaded(true);
    this.dragState = {
      mode: 'move-lead',
      inst,
      partDef,
      pinId,
      currentSvgPt: svgPt
    };
  }

  startWireDrawFromHole(hole, e) {
    if (hole.polarity === 'pos') {
      this.activeWireColor = WIRE_COLORS[0]; // Red for +V
      this.renderWireSwatches();
    } else if (hole.polarity === 'neg') {
      this.activeWireColor = WIRE_COLORS[1]; // Black for GND
      this.renderWireSwatches();
    } else if (hole.polarity === 'neg_supply') {
      this.activeWireColor = WIRE_COLORS[2]; // Blue for -15V / SUPPLY -
      this.renderWireSwatches();
    }
    const svgPt = this.clientToSvgPoint(e.clientX, e.clientY);
    this.dragState = {
      mode: 'draw-wire',
      startHole: hole,
      currentSvgPt: svgPt,
      snapHole: hole
    };
    this.renderDragPreview();
  }

  startMoveWireEnd(wire, end, e) {
    const svgPt = this.clientToSvgPoint(e.clientX, e.clientY);
    this.dragState = {
      mode: 'move-wire-end',
      wire,
      end,
      currentSvgPt: svgPt
    };
  }

  onGlobalPointerMove(e) {
    if (this.floatingWindowDrag) {
      const { category, winEl, startClientX, startClientY, origX, origY } = this.floatingWindowDrag;
      const nx = Math.max(8, origX + (e.clientX - startClientX));
      const ny = Math.max(8, origY + (e.clientY - startClientY));
      this.poppedOutCategories.set(category, { x: nx, y: ny });
      winEl.style.left = `${nx}px`;
      winEl.style.top = `${ny}px`;
      return;
    }

    if (this.isPanning) {
      const dx = e.clientX - this.panStart.x;
      const dy = e.clientY - this.panStart.y;
      this.panMovedDist += Math.hypot(dx, dy);
      const ctm = this.svgEl.getScreenCTM();
      const scaleX = ctm && ctm.a ? ctm.a : 1;
      const scaleY = ctm && ctm.d ? ctm.d : 1;
      this.viewPan.x += dx / scaleX;
      this.viewPan.y += dy / scaleY;
      this.panStart = { x: e.clientX, y: e.clientY };
      this.applyViewportTransform();
      return;
    }

    if (!this.dragState) return;

    const svgPt = this.clientToSvgPoint(e.clientX, e.clientY);
    this.dragState.currentSvgPt = svgPt;

    if (this.dragState.mode === 'catalog-part') {
      const dist = Math.hypot(e.clientX - this.dragState.startClientX, e.clientY - this.dragState.startClientY);
      if (dist > 8) {
        this.dragState.hasMovedOnBoard = true;
      }
      this.renderDragPreview();
    } else if (this.dragState.mode === 'move-part') {
      const { inst, partDef } = this.dragState;
      const targetX = svgPt.x - this.dragState.offsetX;
      const targetY = svgPt.y - this.dragState.offsetY;

      if (partDef.placement === 'two-lead') {
        const { leadDeltaGx, leadDeltaGy } = this.dragState;
        const p1TargetX = targetX - (leadDeltaGx * PITCH) / 2;
        const p1TargetY = targetY - (leadDeltaGy * PITCH) / 2;
        const cand = this.findBestTwoLeadPlacement(p1TargetX, p1TargetY, leadDeltaGx, leadDeltaGy);
        if (cand && (inst.pinHoles.P1 !== cand.h1.id || inst.pinHoles.P2 !== cand.h2.id)) {
          inst.pinHoles.P1 = cand.h1.id;
          inst.pinHoles.P2 = cand.h2.id;
          this.recalculateAndRender({ save: false });
        }
      } else if (partDef.placement === 'footprint') {
        const best = this.breadboard.findBestFootprintAnchor(partDef, targetX, targetY, inst.rotation || 0);
        if (best && best.anchorHoleId && inst.anchorHoleId !== best.anchorHoleId) {
          inst.anchorHoleId = best.anchorHoleId;
          this.recalculateAndRender({ save: false });
        }
      }
    } else if (this.dragState.mode === 'move-lead') {
      const { inst, pinId } = this.dragState;
      const otherPinId = pinId === 'P1' ? 'P2' : 'P1';
      const otherHoleId = inst.pinHoles[otherPinId];
      const nearest = this.breadboard.findNearestHole(svgPt.x, svgPt.y, PITCH * 2.5);
      if (nearest && nearest.id !== otherHoleId && inst.pinHoles[pinId] !== nearest.id) {
        inst.pinHoles[pinId] = nearest.id;
        this.onHoleHover(nearest.id);
        this.recalculateAndRender({ save: false });
      }
    } else if (this.dragState.mode === 'draw-wire') {
      const nearest = this.breadboard.findNearestHole(svgPt.x, svgPt.y, PITCH * 1.5);
      this.dragState.snapHole = nearest;
      if (nearest) this.onHoleHover(nearest.id);
      this.renderDragPreview();
    } else if (this.dragState.mode === 'move-wire-end') {
      const { wire, end } = this.dragState;
      const otherHoleId = end === 'A' ? wire.holeB : wire.holeA;
      const currentHoleId = end === 'A' ? wire.holeA : wire.holeB;
      const nearest = this.breadboard.findNearestHole(svgPt.x, svgPt.y, PITCH * 1.8);
      if (nearest && nearest.id !== otherHoleId && currentHoleId !== nearest.id) {
        if (end === 'A') wire.holeA = nearest.id;
        else wire.holeB = nearest.id;
        this.onHoleHover(nearest.id);
        this.recalculateAndRender({ save: false });
      }
    }
  }

  onGlobalPointerUp() {
    if (this.floatingWindowDrag) {
      this.floatingWindowDrag = null;
      return;
    }

    if (this.isPanning) {
      const wasClickOnly = this.panMovedDist < 5;
      this.isPanning = false;
      this.canvasWrap.classList.remove('panning');
      if (wasClickOnly) {
        this.selectItem(null, null);
      }
      return;
    }

    if (!this.dragState) return;
    const state = this.dragState;
    this.dragState = null;
    this.interactionLayer.innerHTML = '';
    if (!this.hoveredPartId) {
      this.setWiresFaded(false);
    }

    if (state.mode === 'catalog-part') {
      const { partDef, currentSvgPt, hasMovedOnBoard, defaultRot } = state;
      if (hasMovedOnBoard) {
        this.placeNewPartAt(partDef, currentSvgPt.x, currentSvgPt.y, defaultRot);
      } else {
        this.placeNewPartAtDefault(partDef);
      }
    } else if (state.mode === 'draw-wire') {
      const { startHole, snapHole } = state;
      if (snapHole && snapHole.id !== startHole.id) {
        const newWire = {
          id: this.generateId('wire'),
          holeA: startHole.id,
          holeB: snapHole.id,
          color: this.activeWireColor.hex,
          colorName: this.activeWireColor.name,
          style: this.activeWireStyle
        };
        this.wires.push(newWire);
        this.selectItem('wire', newWire.id);
        this.recalculateAndRender();
      }
    } else if (
      state.mode === 'move-part' ||
      state.mode === 'move-lead' ||
      state.mode === 'move-wire-end'
    ) {
      this.saveToLocalStorage();
    }
  }

  findBestTwoLeadPlacement(p1TargetX, p1TargetY, dGx, dGy) {
    const approxGx = Math.round((p1TargetX - BOARD_ORIGIN_X) / PITCH);
    const approxGy = Math.round((p1TargetY - BOARD_ORIGIN_Y) / PITCH);

    let best = null;
    let bestScore = Infinity;

    for (let xOff = -3; xOff <= 3; xOff++) {
      for (let yOff = -3; yOff <= 3; yOff++) {
        const gx1 = approxGx + xOff;
        const gy1 = approxGy + yOff;
        const h1 = this.breadboard.getHoleAtGrid(gx1, gy1);
        const h2 = this.breadboard.getHoleAtGrid(gx1 + dGx, gy1 + dGy);
        if (h1 && h2) {
          const score = Math.hypot(h1.x - p1TargetX, h1.y - p1TargetY);
          if (score < bestScore) {
            bestScore = score;
            best = { h1, h2 };
          }
        }
      }
    }
    return best;
  }

  placeNewPartAt(partDef, svgX, svgY, defaultRot = 0) {
    if (partDef.placement === 'two-lead') {
      const span = partDef.defaultSpan || 4;
      const isElvis = this.breadboard.elvisMode;
      const dGx = isElvis ? 0 : span;
      const dGy = isElvis ? span : 0;
      const p1X = svgX - (dGx * PITCH) / 2;
      const p1Y = svgY - (dGy * PITCH) / 2;
      const cand = this.findBestTwoLeadPlacement(p1X, p1Y, dGx, dGy);
      if (cand) {
        const inst = {
          id: this.generateId(partDef.id),
          partId: partDef.id,
          pinHoles: { P1: cand.h1.id, P2: cand.h2.id }
        };
        this.placedParts.push(inst);
        this.selectItem('part', inst.id);
        this.recalculateAndRender();
      }
    } else if (partDef.placement === 'footprint') {
      const best = this.breadboard.findBestFootprintAnchor(partDef, svgX, svgY, defaultRot);
      if (best && best.anchorHoleId) {
        const inst = {
          id: this.generateId(partDef.id),
          partId: partDef.id,
          anchorHoleId: best.anchorHoleId,
          rotation: defaultRot
        };
        this.placedParts.push(inst);
        this.selectItem('part', inst.id);
        this.recalculateAndRender();
      }
    }
  }

  placeNewPartAtDefault(partDef) {
    if (partDef.placement === 'footprint') {
      const defRow = partDef.defaultPosition?.row || 'd';
      const defCol = partDef.defaultPosition?.col || 20;
      const anchorHole = this.breadboard.getHole(`${defRow}${defCol}`);
      const defaultRot = this.breadboard.elvisMode ? 90 : 0;
      if (anchorHole) {
        const best = this.breadboard.findBestFootprintAnchor(partDef, anchorHole.x, anchorHole.y, defaultRot);
        if (best && best.anchorHoleId) {
          const inst = {
            id: this.generateId(partDef.id),
            partId: partDef.id,
            anchorHoleId: best.anchorHoleId,
            rotation: defaultRot
          };
          this.placedParts.push(inst);
          this.selectItem('part', inst.id);
          this.recalculateAndRender();
        }
      }
    } else {
      const span = partDef.defaultSpan || 4;
      const count = this.placedParts.filter((p) => p.partId !== 'arduino-nano').length;
      const col1 = 24 + ((count * 5) % 32);
      const rows = ['d', 'e', 'f', 'g', 'c', 'h'];
      const row = rows[count % rows.length];
      const h1 = this.breadboard.getHole(`${row}${col1}`);
      const h2 = this.breadboard.getHole(`${row}${col1 + span}`);
      if (h1 && h2) {
        const inst = {
          id: this.generateId(partDef.id),
          partId: partDef.id,
          pinHoles: { P1: h1.id, P2: h2.id }
        };
        this.placedParts.push(inst);
        this.selectItem('part', inst.id);
        this.recalculateAndRender();
      }
    }
  }

  renderDragPreview() {
    this.interactionLayer.innerHTML = '';
    if (!this.dragState) return;

    if (this.dragState.mode === 'draw-wire') {
      const { startHole, currentSvgPt, snapHole } = this.dragState;
      const endX = snapHole ? snapHole.x : currentSvgPt.x;
      const endY = snapHole ? snapHole.y : currentSvgPt.y;
      const d = computeWirePath(startHole.x, startHole.y, endX, endY, this.activeWireStyle);

      this.interactionLayer.innerHTML = `
        <path d="${d}" fill="none" stroke="${this.activeWireColor.hex}" stroke-width="4.4"
              stroke-linecap="round" stroke-dasharray="5 3" opacity="0.85" pointer-events="none"/>
        <circle cx="${startHole.x}" cy="${startHole.y}" r="4.5" fill="${this.activeWireColor.hex}" pointer-events="none"/>
        <circle cx="${endX}" cy="${endY}" r="5" fill="none" stroke="${this.activeWireColor.hex}" stroke-width="2" pointer-events="none"/>
      `;
    } else if (this.dragState.mode === 'catalog-part') {
      const { partDef, currentSvgPt, defaultRot } = this.dragState;
      if (partDef.placement === 'two-lead') {
        const span = partDef.defaultSpan || 4;
        const isElvis = this.breadboard.elvisMode;
        const dGx = isElvis ? 0 : span;
        const dGy = isElvis ? span : 0;
        const p1X = currentSvgPt.x - (dGx * PITCH) / 2;
        const p1Y = currentSvgPt.y - (dGy * PITCH) / 2;
        const cand = this.findBestTwoLeadPlacement(p1X, p1Y, dGx, dGy);
        const h1 = cand ? cand.h1 : { x: p1X, y: p1Y };
        const h2 = cand ? cand.h2 : { x: currentSvgPt.x + (dGx * PITCH) / 2, y: currentSvgPt.y + (dGy * PITCH) / 2 };
        const mx = (h1.x + h2.x) / 2;
        const my = (h1.y + h2.y) / 2;
        const previewRot = isElvis ? 90 : 0;

        this.interactionLayer.innerHTML = `
          <g opacity="0.82" pointer-events="none" filter="url(#dragLiftShadow)">
            <circle cx="${h1.x}" cy="${h1.y}" r="5.5" fill="none" stroke="#22c55e" stroke-width="2"/>
            <circle cx="${h2.x}" cy="${h2.y}" r="5.5" fill="none" stroke="#22c55e" stroke-width="2"/>
            <line x1="${h1.x}" y1="${h1.y}" x2="${h2.x}" y2="${h2.y}" stroke="#94a3b8" stroke-width="2.5"/>
            <g transform="translate(${mx}, ${my}) rotate(${previewRot})">${partDef.svgInnerMarkup}</g>
          </g>
        `;
      } else if (partDef.placement === 'footprint') {
        const best = this.breadboard.findBestFootprintAnchor(partDef, currentSvgPt.x, currentSvgPt.y, defaultRot || 0);
        const gx = best ? BOARD_ORIGIN_X + best.gridX * PITCH : currentSvgPt.x;
        const gy = best ? BOARD_ORIGIN_Y + best.gridY * PITCH : currentSvgPt.y;

        this.interactionLayer.innerHTML = `
          <g transform="translate(${gx}, ${gy}) rotate(${defaultRot || 0})" opacity="0.82" pointer-events="none" filter="url(#dragLiftShadow)">
            ${partDef.svgInnerMarkup}
          </g>
        `;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Selection, Rotation, Deletion & Inspector
  // ---------------------------------------------------------------------------
  selectItem(type, id) {
    const prevWasSensor = this.selectedItem?.type === 'sensor';
    this.selectedItem = type && id ? { type, id } : null;
    if (prevWasSensor || this.selectedItem?.type === 'sensor') {
      this.renderBreadboardBase();
    }
    this.recalculateAndRender();
  }

  rotateSelected() {
    if (!this.selectedItem) return;

    if (this.selectedItem.type === 'sensor') {
      this.breadboard.rotateSensorPosition();
      this.updateBoardViewBox();
      this.renderBreadboardBase();
      this.renderXrayLayer();
      this.renderBreadboardHoles();
      this.recalculateAndRender();
      return;
    }

    if (this.selectedItem.type === 'wire') {
      const wire = this.wires.find((w) => w.id === this.selectedItem.id);
      if (!wire) return;
      const cycle = ['curved', 'straight', 'curved-alt'];
      const curStyle = wire.style || 'curved';
      const nextStyle = cycle[(cycle.indexOf(curStyle) + 1) % cycle.length];
      wire.style = nextStyle;
      this.activeWireStyle = nextStyle === 'straight' ? 'straight' : 'curved';
      this.updateWireStyleButton();
      this.recalculateAndRender();
      return;
    }

    if (this.selectedItem.type !== 'part') return;
    const inst = this.placedParts.find((p) => p.id === this.selectedItem.id);
    if (!inst) return;
    const partDef = this.catalogMap.get(inst.partId);
    if (!partDef) return;

    if (partDef.placement === 'two-lead') {
      const h1 = this.breadboard.getHole(inst.pinHoles.P1);
      const h2 = this.breadboard.getHole(inst.pinHoles.P2);
      if (!h1 || !h2) return;

      const midGx = Math.round((h1.gridX + h2.gridX) / 2);
      const midGy = Math.round((h1.gridY + h2.gridY) / 2);
      const dGx = h2.gridX - h1.gridX;
      const dGy = h2.gridY - h1.gridY;

      const newDGx = -dGy;
      const newDGy = dGx;

      const p1TargetX = BOARD_ORIGIN_X + (midGx - newDGx / 2) * PITCH;
      const p1TargetY = BOARD_ORIGIN_Y + (midGy - newDGy / 2) * PITCH;

      const cand = this.findBestTwoLeadPlacement(p1TargetX, p1TargetY, newDGx, newDGy);
      if (cand && cand.h1.id !== cand.h2.id) {
        inst.pinHoles.P1 = cand.h1.id;
        inst.pinHoles.P2 = cand.h2.id;
      } else {
        const tmp = inst.pinHoles.P1;
        inst.pinHoles.P1 = inst.pinHoles.P2;
        inst.pinHoles.P2 = tmp;
      }
      this.recalculateAndRender();
    } else if (partDef.placement === 'footprint') {
      const anchorHole = this.breadboard.getHole(inst.anchorHoleId);
      if (!anchorHole) return;
      const currentRot = inst.rotation || 0;

      for (const step of [90, 180, 270]) {
        const candidateRot = (currentRot + step) % 360;
        const best = this.breadboard.findBestFootprintAnchor(partDef, anchorHole.x, anchorHole.y, candidateRot);
        if (best && best.anchorHoleId) {
          inst.rotation = candidateRot;
          inst.anchorHoleId = best.anchorHoleId;
          this.recalculateAndRender();
          break;
        }
      }
    }
  }

  deleteSelected() {
    if (!this.selectedItem || this.selectedItem.type === 'sensor') return;
    if (this.selectedItem.type === 'part') {
      this.placedParts = this.placedParts.filter((p) => p.id !== this.selectedItem.id);
    } else if (this.selectedItem.type === 'wire') {
      this.wires = this.wires.filter((w) => w.id !== this.selectedItem.id);
    }
    this.selectItem(null, null);
  }

  updateInspectorUI() {
    if (!this.selectedItem) {
      this.inspectorEl.hidden = true;
      this.btnRotate.disabled = true;
      this.btnDelete.disabled = true;
      return;
    }

    this.btnDelete.disabled = false;

    if (this.selectedItem.type === 'part') {
      const inst = this.placedParts.find((p) => p.id === this.selectedItem.id);
      const partDef = inst ? this.catalogMap.get(inst.partId) : null;
      if (!inst || !partDef) {
        this.inspectorEl.hidden = true;
        return;
      }

      this.btnRotate.disabled = false;
      this.inspectorEl.hidden = false;

      if (partDef.placement === 'two-lead') {
        const p1Label = escapeHtml(partDef.pins?.[0]?.label || 'Lead 1');
        const p2Label = escapeHtml(partDef.pins?.[1]?.label || 'Lead 2');
        this.inspectorEl.innerHTML = `
          <div class="inspector-title">${escapeHtml(partDef.name)}</div>
          <div class="inspector-detail">
            ${p1Label}: <strong>${escapeHtml(inst.pinHoles.P1)}</strong> ↔ ${p2Label}: <strong>${escapeHtml(inst.pinHoles.P2)}</strong>
            ${partDef.bands ? `<span class="inspector-bands">(${escapeHtml(partDef.bands.join(' - '))})</span>` : ''}
          </div>
          <div class="inspector-hint">Tip: Drag either lead endpoint to stretch across any holes, or press <kbd>R</kbd> to rotate.</div>
        `;
      } else {
        const pinSummary = partDef.pins
          .slice(0, 8)
          .map((p) => {
            const h = this.connectivity?.getPinHole(inst.id, p.id);
            return `${escapeHtml(p.label)}: ${escapeHtml(h ? h.id : '?')}`;
          })
          .join(' · ');
        const rotBadge = inst.rotation ? ` (${escapeHtml(inst.rotation)}°)` : '';
        this.inspectorEl.innerHTML = `
          <div class="inspector-title">${escapeHtml(partDef.name)}${rotBadge}</div>
          <div class="inspector-detail">${pinSummary}${partDef.pins.length > 8 ? ' …' : ''}</div>
          <div class="inspector-hint">Tip: Press <kbd>R</kbd> to rotate footprint, or click &amp; drag any pin pad to draw a jumper wire.</div>
        `;
      }
    } else if (this.selectedItem.type === 'wire') {
      const wire = this.wires.find((w) => w.id === this.selectedItem.id);
      if (!wire) {
        this.inspectorEl.hidden = true;
        return;
      }
      const styleLabel =
        wire.style === 'straight'
          ? 'Solid-Core Wire (Straight)'
          : wire.style === 'curved-alt'
          ? 'Stranded Jumper (Arc 2)'
          : 'Stranded Jumper (Arc 1)';
      this.btnRotate.disabled = false;
      this.inspectorEl.hidden = false;
      this.inspectorEl.innerHTML = `
        <div class="inspector-title">${escapeHtml(wire.colorName || '')} ${escapeHtml(styleLabel)}</div>
        <div class="inspector-detail">Connects <strong>${escapeHtml(wire.holeA)}</strong> ↔ <strong>${escapeHtml(wire.holeB)}</strong></div>
        <div class="inspector-hint">Tip: Press <kbd>R</kbd> to cycle wire shape (Arc 1 → Straight Solid → Arc 2), click a color swatch to recolor, or drag either wire tip.</div>
      `;
    } else if (this.selectedItem.type === 'sensor') {
      const sideLabels = {
        top: 'Top (Above Board)',
        right: 'Right Side',
        bottom: 'Bottom (Below Board)',
        left: 'Left Side'
      };
      const curSide = this.breadboard.getEffectiveSensorSide();
      this.btnRotate.disabled = false;
      this.btnDelete.disabled = true;
      this.inspectorEl.hidden = false;
      this.inspectorEl.innerHTML = `
        <div class="inspector-title">External Sensors Dock</div>
        <div class="inspector-detail">Position: <strong>${escapeHtml(sideLabels[curSide] || curSide)}</strong></div>
        <div class="inspector-hint">Tip: Press <kbd>R</kbd> (or click Rotate) to move sensors around the board (Top → Right → Bottom → Left).</div>
      `;
    }
  }

  // ---------------------------------------------------------------------------
  // Starter Circuit, Save/Load JSON & Export SVG
  // ---------------------------------------------------------------------------
  loadStarterCircuit() {
    const starter = createStarterCircuit(this.breadboard.elvisMode, (prefix) => this.generateId(prefix));
    this.placedParts = starter.placedParts;
    this.wires = starter.wires;
    this.selectItem(null, null);
  }

  saveToLocalStorage() {
    saveCircuitToLocalStorage(this.breadboard, this.placedParts, this.wires, {
      simState: this.simState
    });
  }

  applyParsedCircuitState(data) {
    this.breadboard.configure({
      elvisMode: data.elvisMode,
      loadCellsMode: data.loadCellsMode,
      emgMode: data.emgMode,
      sensorPosition: data.sensorPosition
    });
    this.btnElvisMode.classList.toggle('active', this.breadboard.elvisMode);
    this.btnLoadCells.classList.toggle('active', this.breadboard.loadCellsMode);
    this.btnEmgMode.classList.toggle('active', this.breadboard.emgMode);
    this.placedParts = data.placedParts;
    this.wires = data.wires;
    this.simState = data.simState ? { ...data.simState } : {};
    this.hoveredHoleId = null;
    this.resetZoom();
    this.updateBoardViewBox();
    this.renderBreadboardBase();
    this.renderXrayLayer();
    this.renderBreadboardHoles();
    this.updateStatusBar();
  }

  loadFromLocalStorage() {
    const data = loadCircuitFromLocalStorage();
    if (!data) return false;
    this.applyParsedCircuitState(data);
    return true;
  }

  exportCircuitJson() {
    downloadCircuitJson(this.breadboard, this.placedParts, this.wires, {
      simState: this.simState
    });
  }

  importCircuitJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result);
        const data = parseCircuitState(raw);
        if (data) {
          this.applyParsedCircuitState(data);
          this.selectItem(null, null);
        } else {
          alert('Could not read circuit JSON file.');
        }
      } catch (err) {
        alert('Could not read circuit JSON file.');
      }
    };
    reader.readAsText(file);
  }

  exportSvgImage() {
    exportBreadboardSvg(this.svgEl);
  }

  // ---------------------------------------------------------------------------
  // RC Filter Calculator (3 Boxes: Fill in any 2 -> 3rd fills itself)
  // f_c = 1 / (2 * pi * R * C)
  // ---------------------------------------------------------------------------
  setupRcCalculator() {
    this.rcCalculator = initRcCalculator({
      panelEl: this.rcCalcPanel,
      headerEl: this.rcCalcHeader,
      toggleBtn: this.btnRcCalc,
      clearBtn: this.btnRcClear,
      closeBtn: this.btnRcClose,
      canvasWrap: this.canvasWrap,
      inputs: {
        R: { input: this.rcInputR, unit: this.rcUnitR, badge: this.rcBadgeR },
        C: { input: this.rcInputC, unit: this.rcUnitC, badge: this.rcBadgeC },
        F: { input: this.rcInputF, unit: this.rcUnitF, badge: this.rcBadgeF }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Zoom, Pan & Event Listeners
  // ---------------------------------------------------------------------------
  applyViewportTransform() {
    this.viewportGroup.setAttribute(
      'transform',
      `translate(${this.viewPan.x.toFixed(1)}, ${this.viewPan.y.toFixed(1)}) scale(${this.viewZoom.toFixed(3)})`
    );
  }

  panBy(dx, dy) {
    this.viewPan.x += dx;
    this.viewPan.y += dy;
    this.applyViewportTransform();
  }

  zoomBy(factor, clientX = null, clientY = null) {
    const oldZoom = this.viewZoom;
    const newZoom = Math.min(2.6, Math.max(0.55, oldZoom * factor));
    if (newZoom === oldZoom) return;

    const ctm = this.svgEl.getScreenCTM();
    if (ctm) {
      const pt = this.svgEl.createSVGPoint();
      if (clientX !== null && clientY !== null) {
        pt.x = clientX;
        pt.y = clientY;
      } else {
        const rect = this.svgEl.getBoundingClientRect();
        pt.x = rect.left + rect.width / 2;
        pt.y = rect.top + rect.height / 2;
      }
      const svgPt = pt.matrixTransform(ctm.inverse());
      const ratio = newZoom / oldZoom;
      this.viewPan.x = svgPt.x - (svgPt.x - this.viewPan.x) * ratio;
      this.viewPan.y = svgPt.y - (svgPt.y - this.viewPan.y) * ratio;
    }

    this.viewZoom = newZoom;
    this.applyViewportTransform();
  }

  resetZoom() {
    this.viewZoom = 1;
    this.viewPan = { x: 0, y: 0 };
    this.applyViewportTransform();
  }

  setSidebarCollapsed(collapsed) {
    this.sidebarCollapsed = Boolean(collapsed);
    if (this.appShellEl) {
      this.appShellEl.classList.toggle('sidebar-collapsed', this.sidebarCollapsed);
    }
    if (this.btnExpandSidebar) {
      this.btnExpandSidebar.hidden = !this.sidebarCollapsed;
    }
  }

  bindEvents() {
    if (this.btnCollapseSidebar) {
      this.btnCollapseSidebar.addEventListener('click', () => {
        this.setSidebarCollapsed(true);
      });
    }
    if (this.btnExpandSidebar) {
      this.btnExpandSidebar.addEventListener('click', () => {
        this.setSidebarCollapsed(false);
      });
    }

    if (this.btnWireStyle) {
      this.btnWireStyle.addEventListener('click', () => {
        this.activeWireStyle = this.activeWireStyle === 'straight' ? 'curved' : 'straight';
        this.updateWireStyleButton();
        if (this.selectedItem?.type === 'wire') {
          const wire = this.wires.find((w) => w.id === this.selectedItem.id);
          if (wire) {
            wire.style = this.activeWireStyle;
            this.recalculateAndRender();
          }
        }
      });
    }

    this.searchInput.addEventListener('input', (e) => {
      this.renderCatalogSidebar(e.target.value);
    });

    window.addEventListener('pointermove', (e) => this.onGlobalPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onGlobalPointerUp(e));

    // Capture Space + drag or Middle-click drag anywhere on the canvas (even over holes/parts)
    this.canvasWrap.addEventListener(
      'pointerdown',
      (e) => {
        if ((this.spacePressed && e.button === 0) || e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          this.isPanning = true;
          this.panMovedDist = 0;
          this.panStart = { x: e.clientX, y: e.clientY };
          this.canvasWrap.classList.add('panning');
        }
      },
      true
    );

    // Prevent browser autoscroll circle on middle-click
    this.canvasWrap.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });

    // Left-click & drag on any empty board space or background pans the view
    this.svgEl.addEventListener('pointerdown', (e) => {
      if (e.button === 0 || e.button === 1) {
        e.preventDefault();
        this.isPanning = true;
        this.panMovedDist = 0;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.canvasWrap.classList.add('panning');
      }
    });

    this.canvasWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      this.zoomBy(factor, e.clientX, e.clientY);
    }, { passive: false });

    this.btnXray.addEventListener('click', () => {
      this.showXray = !this.showXray;
      this.btnXray.classList.toggle('active', this.showXray);
      this.renderXrayLayer();
    });

    this.btnElvisMode.addEventListener('click', () => {
      const nextMode = !this.breadboard.elvisMode;
      const rotDelta = nextMode ? 90 : 270;

      // Rotate all placed footprint parts on the breadboard by 90° CW (or 90° CCW)
      // so they stay locked onto the exact same breadboard hole IDs when the board rotates!
      for (const inst of this.placedParts) {
        const partDef = this.catalogMap.get(inst.partId);
        if (partDef?.placement === 'footprint' && inst.anchorHoleId && !inst.anchorHoleId.startsWith('ELV_')) {
          inst.rotation = ((inst.rotation || 0) + rotDelta) % 360;
        }
      }

      this.breadboard.configure({ elvisMode: nextMode, sensorPosition: 'auto' });
      this.btnElvisMode.classList.toggle('active', nextMode);
      this.resetZoom();
      this.updateBoardViewBox();
      this.renderBreadboardBase();
      this.renderXrayLayer();
      this.renderBreadboardHoles();
      this.recalculateAndRender();
      this.updateStatusBar();
    });

    this.btnLoadCells.addEventListener('click', () => {
      const next = !this.breadboard.loadCellsMode;
      this.breadboard.setLoadCellsMode(next);
      this.btnLoadCells.classList.toggle('active', next);
      if (!this.breadboard.loadCellsMode && !this.breadboard.emgMode && this.selectedItem?.type === 'sensor') {
        this.selectedItem = null;
      }
      this.updateBoardViewBox();
      this.renderBreadboardBase();
      this.renderXrayLayer();
      this.renderBreadboardHoles();
      this.recalculateAndRender();
      this.updateStatusBar();
    });

    this.btnEmgMode.addEventListener('click', () => {
      const next = !this.breadboard.emgMode;
      this.breadboard.setEmgMode(next);
      this.btnEmgMode.classList.toggle('active', next);
      if (!this.breadboard.loadCellsMode && !this.breadboard.emgMode && this.selectedItem?.type === 'sensor') {
        this.selectedItem = null;
      }
      this.updateBoardViewBox();
      this.renderBreadboardBase();
      this.renderXrayLayer();
      this.renderBreadboardHoles();
      this.recalculateAndRender();
      this.updateStatusBar();
    });

    // Toggle handled by initRcCalculator()

    this.btnRotate.addEventListener('click', () => this.rotateSelected());
    this.btnDelete.addEventListener('click', () => this.deleteSelected());

    this.btnStarter.addEventListener('click', () => {
      this.loadStarterCircuit();
    });

    this.btnClear.addEventListener('click', () => {
      this.placedParts = [];
      this.wires = [];
      this.selectItem(null, null);
    });

    this.btnSaveJson.addEventListener('click', () => this.exportCircuitJson());
    this.btnLoadJson.addEventListener('click', () => this.fileLoadInput.click());
    this.fileLoadInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this.importCircuitJson(file);
        e.target.value = '';
      }
    });

    this.btnExportSvg.addEventListener('click', () => this.exportSvgImage());

    this.btnPanLeft.addEventListener('click', () => this.panBy(64, 0));
    this.btnPanRight.addEventListener('click', () => this.panBy(-64, 0));
    this.btnPanUp.addEventListener('click', () => this.panBy(0, 64));
    this.btnPanDown.addEventListener('click', () => this.panBy(0, -64));

    this.btnZoomIn.addEventListener('click', () => this.zoomBy(1.18));
    this.btnZoomOut.addEventListener('click', () => this.zoomBy(1 / 1.18));
    this.btnZoomReset.addEventListener('click', () => this.resetZoom());

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') {
        this.spacePressed = true;
        this.canvasWrap.classList.add('panning');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.panBy(48, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.panBy(-48, 0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.panBy(0, 48);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.panBy(0, -48);
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.rotateSelected();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === 'Escape') {
        this.selectItem(null, null);
      } else if (e.key === 'x' || e.key === 'X') {
        this.btnXray.click();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spacePressed = false;
        if (!this.isPanning) {
          this.canvasWrap.classList.remove('panning');
        }
      }
    });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const app = new BreadboardPlannerApp();
    app.init();
  });
}
