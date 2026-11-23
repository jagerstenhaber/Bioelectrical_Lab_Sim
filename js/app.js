import {
  BreadboardModel,
  PITCH,
  BOARD_ORIGIN_X,
  BOARD_ORIGIN_Y,
  getRotatedPinOffset,
  computeEffectiveMaxZoom
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
  exportBreadboardSvg
} from './persistence.js';
import {
  getDefaultPartProps,
  getPhotoresistorOhms
} from './sim/dcSolver.js';
import { createDefaultEmgConfig } from './sim/emgModel.js';
import { createDefaultPulseOxConfig } from './sim/ppgModel.js';
import { LAB_PRESETS } from './presets.js';
import { formatResistance } from './ui/dmmPanel.js';
import {
  buildSimInspectorHtml,
  buildSimTelemetryHtml
} from './ui/runtimeOverlay.js';
import { createBenchController } from './controllers/benchController.js';
import { createSidebarManager } from './ui/sidebarManager.js';
import { getHardwareModule } from './sim/hardwareRegistry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function namespaceSvgIds(markup, prefix) {
  const ids = [];
  const withIds = String(markup || '').replace(/\bid=(["'])([^"']+)\1/g, (_m, q, id) => {
    ids.push(id);
    return `id=${q}${prefix}${id}${q}`;
  });
  if (ids.length === 0) return withIds;
  const idSet = new Set(ids);
  return withIds
    .replace(/url\(\s*#([^)\s'"]+)\s*\)/g, (m, id) => (idSet.has(id) ? `url(#${prefix}${id})` : m))
    .replace(/\b((?:xlink:)?href)=(["'])#([^"']+)\2/g, (m, attr, q, id) =>
      idSet.has(id) ? `${attr}=${q}#${prefix}${id}${q}` : m
    );
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
    this.activeTouchPointers = new Map();
    this.pinchState = null;

    // Active drag operation
    this.dragState = null;
    this.floatingWindowDrag = null;
    this.heldPushbuttonId = null;
    this.saveDebounceTimer = null;

    this.connectivity = null;
    this.bench = null;
    this.sidebarManager = null;
    this.isolationDismissedLevel = null;
    this.catalogPreviewSeq = 0;
  }

  async init() {
    this.cacheDom();
    this.catalog = await loadPartsCatalog();
    this.collapsedCategories = new Set();
    let seenFirstCategory = false;
    for (const part of this.catalog) {
      this.catalogMap.set(part.id, part);
      if (!seenFirstCategory) {
        seenFirstCategory = true;
      } else {
        this.collapsedCategories.add(part.category);
      }
    }

    this.renderWireSwatches();
    this.updateWireStyleButton();
    this.populatePresetSelect();
    this.renderCatalogSidebar();
    this.setupSidebarManager();
    this.setupSvgCanvas();
    this.setupRcCalculator();
    this.setupBenchController();
    this.bindEvents();
    this.bench.updatePowerButtonUI();
    this.updateProbeModeUI();

    // Load saved circuit or starter demo
    if (!this.loadFromLocalStorage()) {
      this.bench.loadStarterCircuit();
    } else {
      this.recalculateAndRender();
    }
    this.syncSidebarSensors();
  }

  cacheDom() {
    this.appShellEl = document.querySelector('.app-shell');
    this.sidebarEl = document.getElementById('parts-sidebar');
    this.sidebarPartsPanelEl = document.getElementById('sidebar-parts-panel');
    this.sidebarSensorsPanelEl = document.getElementById('sidebar-sensors-panel');
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
    this.probeBannerEl = document.getElementById('probe-mode-banner');
    this.isolationPillEl = document.getElementById('isolation-safety-pill');
    this.instrumentDockEl = document.getElementById('instrument-dock');

    // Buttons & Selectors
    this.btnSimPower = document.getElementById('btn-sim-power');
    this.btnXray = document.getElementById('btn-xray');
    this.btnElvisMode = document.getElementById('btn-elvis-mode');
    this.btnRcCalc = document.getElementById('btn-rc-calc');
    this.presetSelect = document.getElementById('preset-select');
    this.btnFileMenu = document.getElementById('btn-file-menu');
    this.fileMenuDropdown = document.getElementById('file-menu-dropdown');
    this.btnClear = document.getElementById('btn-clear');
    this.btnSaveJson = document.getElementById('btn-save-json');
    this.btnLoadJson = document.getElementById('btn-load-json');
    this.fileLoadInput = document.getElementById('file-load-json');
    this.btnExportSvg = document.getElementById('btn-export-svg');
    this.btnHelpShortcuts = document.getElementById('btn-help-shortcuts');
    this.helpPopover = document.getElementById('help-shortcuts-popover');
    this.btnHelpClose = document.getElementById('btn-help-close');
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
    const safePartId = String(part.id || 'part').replace(/[^a-zA-Z0-9_-]/g, '_');
    const previewPrefix = `cat-${safePartId}-${++this.catalogPreviewSeq}-`;
    const previewMarkup = namespaceSvgIds(part.svgInnerMarkup, previewPrefix);

    if (part.placement === 'two-lead') {
      previewWrap.innerHTML = `
        <svg viewBox="-34 -14 68 28" class="part-thumb-svg">
          <line x1="-30" y1="0" x2="-${part.leadAttachOffset}" y2="0" stroke="#94a3b8" stroke-width="2.2" stroke-linecap="round"/>
          <line x1="${part.leadAttachOffset}" y1="0" x2="30" y2="0" stroke="#94a3b8" stroke-width="2.2" stroke-linecap="round"/>
          <g>${previewMarkup}</g>
        </svg>
      `;
    } else {
      previewWrap.innerHTML = `
        <svg viewBox="${part.svgViewBox}" class="part-thumb-svg part-thumb-large">
          ${previewMarkup}
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
          ? 'CdS LDR · Ambient / PPG'
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
      popBtn.textContent = isPoppedOut ? '↙ Dock' : '↗ Pop';
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
    if (this.bench?.handleProbeHolePicked(this.interactionMode, hole)) {
      return;
    }
    if (this.interactionMode !== 'build') return;
    this.startWireDrawFromHole(hole, e);
  }

  // ---------------------------------------------------------------------------
  // Sidebar Manager & External Hardware Mounting
  // ---------------------------------------------------------------------------
  setupSidebarManager() {
    if (!this.sidebarEl) return;
    this.sidebarManager = createSidebarManager({
      sidebarEl: this.sidebarEl,
      expandBtnEl: this.btnExpandSidebar,
      partsPanelEl: this.sidebarPartsPanelEl,
      sensorsPanelEl: this.sidebarSensorsPanelEl,
      onToggleHardware: (moduleId, nextEnabled) => {
        this.toggleExternalHardware(moduleId, nextEnabled);
      },
      onStimulusPatch: (patch, { commit = true } = {}) => {
        this.bench?.applyStimulusPatch(patch, { commit });
      },
      onQuickPlacePpgLdr: () => {
        const partDef = this.catalogMap.get('photoresistor');
        if (!partDef) return;
        this.placeNewPartAtDefault(partDef, {
          lightLevel: 0.5,
          lightMode: 'led-ppg',
          fingerPresent: true,
          bpm: 72,
          perfusion: 0.6
        });
      },
      onSelectPpgLdr: (partId) => {
        if (partId) {
          this.selectItem('part', partId);
        }
      }
    });
  }

  toggleExternalHardware(moduleId, nextEnabled) {
    const mod = getHardwareModule(moduleId);
    if (!mod) return;

    const enabled = Boolean(nextEnabled);
    if (mod.boardFlag === 'loadCellsMode') {
      this.breadboard.setLoadCellsMode(enabled);
    } else if (mod.boardFlag === 'emgMode') {
      this.breadboard.setEmgMode(enabled);
    } else if (mod.boardFlag === 'pulseOxMode') {
      this.breadboard.setPulseOxMode(enabled);
    } else {
      return;
    }

    if (
      !this.breadboard.loadCellsMode &&
      !this.breadboard.emgMode &&
      !this.breadboard.pulseOxMode &&
      this.selectedItem?.type === 'sensor'
    ) {
      this.selectedItem = null;
    }

    this.updateBoardViewBox();
    this.renderBreadboardBase();
    this.renderXrayLayer();
    this.renderBreadboardHoles();
    this.recalculateAndRender();
    this.updateStatusBar();
    this.syncSidebarSensors();
  }

  syncSidebarSensors(overrideState = null) {
    if (this.sidebarManager) {
      const boardState = overrideState?.boardState || {
        elvisMode: Boolean(this.breadboard?.elvisMode),
        loadCellsMode: Boolean(this.breadboard?.loadCellsMode),
        emgMode: Boolean(this.breadboard?.emgMode),
        pulseOxMode: Boolean(this.breadboard?.pulseOxMode)
      };
      const simConfig = overrideState?.simConfig || this.bench?.simConfig || {};
      const isolationResult =
        overrideState?.isolationResult !== undefined
          ? overrideState.isolationResult
          : this.bench?.isolationResult || null;
      this.sidebarManager.syncState({
        boardState,
        simConfig,
        placedParts: this.placedParts,
        isolationResult
      });
    }
    this.updateIsolationPillUI();
  }

  _formatIsolationCutoffHz(hz) {
    if (!Number.isFinite(hz) || hz <= 0) return '';
    if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
    if (hz >= 10) return `${hz.toFixed(1)} Hz`;
    return `${hz.toFixed(2)} Hz`;
  }

  inspectIsolationInSidebar() {
    this.setSidebarCollapsed(false);
    this.sidebarManager?.setActiveTab('sensors');
    const cardEl = this.sidebarSensorsPanelEl?.querySelector('[data-isolation-card]');
    if (cardEl && typeof cardEl.scrollIntoView === 'function') {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  updateIsolationPillUI() {
    const pillEl = this.isolationPillEl;
    if (!pillEl) return;

    const iso = this.bench?.isolationResult || null;
    if (!iso || !iso.active) {
      pillEl.hidden = true;
      pillEl.className = 'isolation-safety-pill';
      pillEl.textContent = '';
      pillEl.removeAttribute('title');
      this.isolationDismissedLevel = null;
      return;
    }

    if (iso.level === 'hazard' && this.isolationDismissedLevel === 'partial') {
      this.isolationDismissedLevel = null;
    }

    if (this.isolationDismissedLevel && this.isolationDismissedLevel === iso.level && iso.level !== 'safe') {
      pillEl.hidden = true;
      return;
    }

    pillEl.innerHTML = '';
    pillEl.hidden = false;

    const level = iso.level || 'hazard';
    pillEl.className = `isolation-safety-pill is-${level}`;

    const textSpan = document.createElement('span');
    if (level === 'safe') {
      const fmtHz = this._formatIsolationCutoffHz(iso.detectedHpfCutoffHz);
      textSpan.textContent = fmtHz
        ? `🛡 IEC 60601 Isolated ✓ · fc ≈ ${fmtHz}`
        : '🛡 IEC 60601 Isolated ✓';
      pillEl.title =
        'IEC 60601 dual-layer isolation active: ADuM3160 galvanic USB barrier + secondary high-pass DC-blocking filter.';
    } else {
      textSpan.textContent = `🛡 IEC 60601: ${iso.summary}`;
      const failedDetails = (iso.checks || [])
        .filter((c) => c.required && c.status !== 'pass')
        .map((c) => c.detail || c.summary)
        .filter(Boolean);
      pillEl.title =
        failedDetails.length > 0
          ? `${failedDetails.join(' ')} (IEC 60601 galvanic & single-fault DC blocking)`
          : 'IEC 60601 requires primary galvanic USB isolation and a secondary high-pass DC-blocking stage.';
    }
    pillEl.appendChild(textSpan);

    const inspectBtn = document.createElement('button');
    inspectBtn.type = 'button';
    inspectBtn.className = 'iso-pill-btn';
    inspectBtn.textContent = 'Inspect';
    inspectBtn.addEventListener('click', () => {
      this.inspectIsolationInSidebar();
    });
    pillEl.appendChild(inspectBtn);

    if (level !== 'safe') {
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'iso-pill-btn';
      dismissBtn.textContent = '✕';
      dismissBtn.title = 'Dismiss alert for current isolation level';
      dismissBtn.setAttribute('aria-label', 'Dismiss IEC 60601 alert');
      dismissBtn.addEventListener('click', () => {
        this.isolationDismissedLevel = iso.level;
        pillEl.hidden = true;
      });
      pillEl.appendChild(dismissBtn);
    }
  }

  // ---------------------------------------------------------------------------
  // Circuit Analysis, Simulation Delegation & Rendering
  // ---------------------------------------------------------------------------
  setupBenchController() {
    this.bench = createBenchController({
      appShellEl: this.appShellEl,
      instrumentDockEl: this.instrumentDockEl,
      btnSimPower: this.btnSimPower,
      presetSelect: this.presetSelect,
      generateId: (prefix) => this.generateId(prefix),
      getBoardContext: () => ({
        breadboard: this.breadboard,
        connectivity: this.connectivity,
        placedParts: this.placedParts,
        wires: this.wires,
        catalogMap: this.catalogMap,
        runtimeOverlayLayer: this.runtimeOverlayLayer
      }),
      getInteractionMode: () => this.interactionMode,
      setInteractionMode: (mode) => {
        this.interactionMode = mode;
        this.updateProbeModeUI();
      },
      setSidebarCollapsed: (collapsed) => this.setSidebarCollapsed(collapsed),
      onCircuitTopologyReset: ({ boardConfig, placedParts, wires }) => {
        this.isolationDismissedLevel = null;
        if (boardConfig) {
          this.breadboard.configure({
            ...boardConfig,
            pulseOxMode: Boolean(boardConfig.pulseOxMode)
          });
          this.btnElvisMode.classList.toggle('active', this.breadboard.elvisMode);
        }
        this.placedParts = placedParts;
        this.wires = wires;
        this.interactionMode = 'build';
        this.hoveredHoleId = null;
        this.updateProbeModeUI();
        this.resetZoom();
        this.updateBoardViewBox();
        this.renderBreadboardBase();
        this.renderXrayLayer();
        this.renderBreadboardHoles();
        this.selectItem(null, null);
        this.syncSidebarSensors();
      },
      onInspectorNeedsRefresh: ({ preserveControls = true } = {}) => {
        this.updateInspectorUI({ preserveControls });
      },
      onBenchControlsUpdated: ({ boardState, simConfig, isolationResult }) => {
        this.syncSidebarSensors({ boardState, simConfig, isolationResult });
      },
      onWorkspaceModeChange: (wsState) => {
        if (wsState?.workspaceMode === 'computer') {
          this.closeTopbarPopovers();
        }
      },
      onWarningsAndStatusRefresh: ({ statusOverride = null } = {}) => {
        this.updateWarningsBanner();
        if (statusOverride && this.statusHoleEl) {
          this.statusHoleEl.textContent = statusOverride;
        } else {
          this.updateStatusBar();
        }
      },
      onPlacePartById: (partId) => {
        const def = this.catalogMap.get(partId);
        if (def) this.placeNewPartAtDefault(def);
      },
      onEnableElvisMode: () => {
        if (!this.breadboard.elvisMode) {
          this.btnElvisMode?.click();
        }
      },
      onSave: () => this.saveToLocalStorage()
    });
    this.bench.setupWorkspaceAndInstruments();
  }

  /**
   * Full topology & visual recalculation: re-analyzes connectivity, rebuilds static
   * wires & parts SVG DOM, updates net highlights, and executes a simulation tick.
   */
  recalculateAndRender({ save = true, preserveInspectorControls = false, forceScopeCapture = false } = {}) {
    this.connectivity = analyzeCircuit(
      this.breadboard,
      this.placedParts,
      this.wires,
      this.catalogMap
    );

    this.renderWires();
    this.renderPlacedParts();
    this.renderNetHighlights();
    this.bench.runSimulation({ forceScopeCapture });
    this.updateInspectorUI({ preserveControls: preserveInspectorControls });
    this.syncSidebarSensors();
    if (save) {
      this.saveToLocalStorage();
    }
  }

  /**
   * Fast simulation recompute path for parameter/stimulus/instrument updates
   * (sliders, buttons, FGEN/Scope/DMM controls, power toggle) — never destroys or
   * rebuilds static breadboard wires & parts SVG DOM.
   */
  recomputeSimulation({ save = false, preserveInspectorControls = true, forceScopeCapture = false } = {}) {
    if (!this.connectivity) {
      this.connectivity = analyzeCircuit(
        this.breadboard,
        this.placedParts,
        this.wires,
        this.catalogMap
      );
    }
    this.bench.runSimulation({ forceScopeCapture });
    this.updateInspectorUI({ preserveControls: preserveInspectorControls });
    this.syncSidebarSensors();
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
        const endAttr = e.target.getAttribute('data-end');
        if (this.interactionMode !== 'build') {
          const targetHoleId =
            endAttr === 'A' ? wire.holeA : endAttr === 'B' ? wire.holeB : wire.holeA;
          const hole = this.breadboard.getHole(targetHoleId);
          if (hole) {
            this.handleHolePointerDown(hole, e);
          }
          return;
        }
        this.selectItem('wire', wire.id);
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
        ${namespaceSvgIds(partDef.svgInnerMarkup, `part-${String(inst.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-`)}
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
      if (this.interactionMode !== 'build') return;
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
        if (this.interactionMode !== 'build') {
          const hole = this.breadboard.getHole(holeId);
          if (hole) {
            this.handleHolePointerDown(hole, e);
          }
          return;
        }
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
        ${namespaceSvgIds(partDef.svgInnerMarkup, `part-${String(inst.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-`)}
      </g>
      <g class="footprint-pins-layer">
        ${pinsOverlay}
      </g>
    `;

    const bodyGroup = g.querySelector('.part-body-group');
    bodyGroup.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.interactionMode !== 'build') return;
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
      const defaultNetText = this.breadboard.elvisMode
        ? 'NI ELVIS II Vertical Layout (54 Rows + 830-Pt Board)'
        : '830 Tie Points Ready';
      this.statusNetEl.textContent = defaultNetText;
      this.statusNetEl.title = defaultNetText;
      this.statusNetEl.className = 'status-pill';
      return;
    }

    const hole = this.breadboard.getHole(this.hoveredHoleId);
    const net = this.connectivity?.getNetForHole(this.hoveredHoleId);
    if (!hole || !net) return;

    let holeDisplayText = this.hoveredPinTitle
      ? `${this.hoveredPinTitle} → ${hole.displayName}`
      : hole.displayName;

    holeDisplayText += this.bench?.getHoveredVoltageSuffix(this.hoveredHoleId) || '';

    this.statusHoleEl.textContent = holeDisplayText;

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

    const netText =
      pinSummaries.length > 0
        ? `${roleTag}: ${pinSummaries.join(' • ')}`
        : `${roleTag} (${net.strips.size} strip${net.strips.size > 1 ? 's' : ''}, ${net.holes.size} holes)`;
    this.statusNetEl.textContent = netText;
    this.statusNetEl.title = netText;
    this.statusNetEl.className = pillClass;
  }

  updateWarningsBanner() {
    const connWarnings = this.connectivity?.warnings || [];
    const simDiagnostics = this.bench?.dcResult?.diagnostics || [];
    const allMessages = [
      ...connWarnings.map((w) => w.message),
      ...simDiagnostics.map((d) => d.message)
    ];

    if (allMessages.length === 0) {
      this.warningBannerEl.hidden = true;
      this.warningBannerEl.textContent = '';
      this.warningBannerEl.classList.remove('is-warning');
    } else {
      this.warningBannerEl.hidden = false;
      this.warningBannerEl.classList.toggle('is-warning', connWarnings.length === 0);
      this.warningBannerEl.textContent = `⚠️ ${allMessages.join(' | ')}`;
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

  rebaselinePinchState() {
    if (this.activeTouchPointers.size < 2) {
      this.pinchState = null;
      return;
    }
    const pts = Array.from(this.activeTouchPointers.values());
    this.pinchState = {
      lastDist: Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY),
      lastMidX: (pts[0].clientX + pts[1].clientX) / 2,
      lastMidY: (pts[0].clientY + pts[1].clientY) / 2
    };
  }

  cancelActiveDrag() {
    if (!this.dragState) return;
    const mode = this.dragState.mode;
    this.dragState = null;
    this.interactionLayer.innerHTML = '';
    this.hoveredPartId = null;
    this.setWiresFaded(false);
    if (mode === 'move-part' || mode === 'move-lead' || mode === 'move-wire-end') {
      this.saveToLocalStorage();
    }
  }

  releaseHeldPushbutton() {
    if (!this.heldPushbuttonId) return;
    const inst = this.placedParts.find((p) => p.id === this.heldPushbuttonId);
    this.heldPushbuttonId = null;
    if (inst) {
      inst.props = { ...(inst.props || {}), pressed: false };
      this.recomputeSimulation({ save: true, preserveInspectorControls: true });
    }
  }

  onGlobalPointerMove(e) {
    if (e.pointerType === 'touch' && this.activeTouchPointers.has(e.pointerId)) {
      this.activeTouchPointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      if (this.activeTouchPointers.size >= 2 && this.pinchState) {
        const pts = Array.from(this.activeTouchPointers.values());
        const dist = Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY);
        const midX = (pts[0].clientX + pts[1].clientX) / 2;
        const midY = (pts[0].clientY + pts[1].clientY) / 2;
        if (this.pinchState.lastDist > 4 && dist > 4) {
          const ctm = this.svgEl.getScreenCTM();
          const scaleX = ctm && ctm.a ? ctm.a : 1;
          const scaleY = ctm && ctm.d ? ctm.d : 1;
          const dx = midX - this.pinchState.lastMidX;
          const dy = midY - this.pinchState.lastMidY;
          this.viewPan.x += dx / scaleX;
          this.viewPan.y += dy / scaleY;
          const prevZoom = this.viewZoom;
          this.zoomBy(dist / this.pinchState.lastDist, midX, midY);
          if (this.viewZoom === prevZoom) {
            this.applyViewportTransform();
          }
        }
        this.pinchState = { lastDist: dist, lastMidX: midX, lastMidY: midY };
        return;
      }
    }

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

  onGlobalPointerCancel(e) {
    this.releaseHeldPushbutton();

    if (e && e.pointerType === 'touch') {
      this.activeTouchPointers.delete(e.pointerId);
      this.rebaselinePinchState();
    }

    this.floatingWindowDrag = null;
    this.isPanning = false;
    this.canvasWrap.classList.remove('panning');
    this.cancelActiveDrag();
  }

  onGlobalPointerUp(e) {
    this.releaseHeldPushbutton();

    if (e && e.pointerType === 'touch') {
      const wasPinching = this.pinchState !== null || this.activeTouchPointers.size >= 2;
      this.activeTouchPointers.delete(e.pointerId);
      this.rebaselinePinchState();
      if (wasPinching) {
        return;
      }
    }

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
    const defaultProps = getDefaultPartProps(partDef.id);
    const hasDefaultProps = Object.keys(defaultProps).length > 0;

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
          pinHoles: { P1: cand.h1.id, P2: cand.h2.id },
          ...(hasDefaultProps ? { props: defaultProps } : {})
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
          rotation: defaultRot,
          ...(hasDefaultProps ? { props: defaultProps } : {})
        };
        this.placedParts.push(inst);
        this.selectItem('part', inst.id);
        this.recalculateAndRender();
      }
    }
  }

  placeNewPartAtDefault(partDef, propsOverride = null) {
    const defaultProps = {
      ...getDefaultPartProps(partDef.id),
      ...(propsOverride && typeof propsOverride === 'object' ? propsOverride : {})
    };
    const hasDefaultProps = Object.keys(defaultProps).length > 0;

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
            rotation: defaultRot,
            ...(hasDefaultProps ? { props: defaultProps } : {})
          };
          this.placedParts.push(inst);
          this.selectItem('part', inst.id);
          this.recalculateAndRender();
          return inst;
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
          pinHoles: { P1: h1.id, P2: h2.id },
          ...(hasDefaultProps ? { props: defaultProps } : {})
        };
        this.placedParts.push(inst);
        this.selectItem('part', inst.id);
        this.recalculateAndRender();
        return inst;
      }
    }
    return null;
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
            <g transform="translate(${mx}, ${my}) rotate(${previewRot})">${namespaceSvgIds(partDef.svgInnerMarkup, 'drag-preview-')}</g>
          </g>
        `;
      } else if (partDef.placement === 'footprint') {
        const best = this.breadboard.findBestFootprintAnchor(partDef, currentSvgPt.x, currentSvgPt.y, defaultRot || 0);
        const gx = best ? BOARD_ORIGIN_X + best.gridX * PITCH : currentSvgPt.x;
        const gy = best ? BOARD_ORIGIN_Y + best.gridY * PITCH : currentSvgPt.y;

        this.interactionLayer.innerHTML = `
          <g transform="translate(${gx}, ${gy}) rotate(${defaultRot || 0})" opacity="0.82" pointer-events="none" filter="url(#dragLiftShadow)">
            ${namespaceSvgIds(partDef.svgInnerMarkup, 'drag-preview-')}
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

  updateInspectorUI({ preserveControls = false } = {}) {
    if (!this.selectedItem) {
      this.inspectorEl.hidden = true;
      this.inspectorEl.dataset.selectedKey = '';
      return;
    }

    const selectionKey = `${this.selectedItem.type}:${this.selectedItem.id}`;

    if (this.selectedItem.type === 'part') {
      const inst = this.placedParts.find((p) => p.id === this.selectedItem.id);
      const partDef = inst ? this.catalogMap.get(inst.partId) : null;
      if (!inst || !partDef) {
        this.inspectorEl.hidden = true;
        this.inspectorEl.dataset.selectedKey = '';
        return;
      }

      this.inspectorEl.hidden = false;

      const partSim = this.bench?.dcResult?.partResults?.get(inst.id) || null;
      const simConfig = this.bench?.simConfig || {};

      if (preserveControls && this.inspectorEl.dataset.selectedKey === selectionKey) {
        this.refreshInspectorLiveState(inst, partDef, partSim);
        return;
      }

      const simSectionHtml = buildSimInspectorHtml({
        inst,
        partDef,
        partSim,
        powered: Boolean(simConfig.powered),
        loadCellsMode: this.breadboard.loadCellsMode,
        emgMode: this.breadboard.emgMode,
        pulseOxMode: this.breadboard.pulseOxMode,
        pulseOxResult: this.bench?.dcResult?.pulseOxResult || null,
        simConfig,
        escapeHtml
      });

      const actionsHtml = `
        <div class="inspector-actions">
          <button type="button" class="inspector-action-btn" data-inspector-action="rotate" title="Rotate 90° [R]">↻ Rotate</button>
          <button type="button" class="inspector-action-btn danger" data-inspector-action="delete" title="Delete selected part [Delete]">✕ Del</button>
          <button type="button" class="inspector-action-btn inspector-close-btn" data-inspector-action="close" title="Close Inspector [Esc]" aria-label="Close Inspector">✕</button>
        </div>
      `;

      if (partDef.placement === 'two-lead') {
        const p1Label = escapeHtml(partDef.pins?.[0]?.label || 'Lead 1');
        const p2Label = escapeHtml(partDef.pins?.[1]?.label || 'Lead 2');
        this.inspectorEl.innerHTML = `
          <div class="inspector-header-row">
            <div class="inspector-title">${escapeHtml(partDef.name)}</div>
            ${actionsHtml}
          </div>
          <div class="inspector-detail">
            ${p1Label}: <strong>${escapeHtml(inst.pinHoles.P1)}</strong> ↔ ${p2Label}: <strong>${escapeHtml(inst.pinHoles.P2)}</strong>
            ${partDef.bands ? `<span class="inspector-bands">(${escapeHtml(partDef.bands.join(' - '))})</span>` : ''}
          </div>
          <div class="inspector-hint">Tip: Drag either lead endpoint to stretch across any holes, or press <kbd>R</kbd> to rotate.</div>
          ${simSectionHtml}
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
          <div class="inspector-header-row">
            <div class="inspector-title">${escapeHtml(partDef.name)}${rotBadge}</div>
            ${actionsHtml}
          </div>
          <div class="inspector-detail">${pinSummary}${partDef.pins.length > 8 ? ' …' : ''}</div>
          <div class="inspector-hint">Tip: Press <kbd>R</kbd> to rotate footprint, or click &amp; drag any pin pad to draw a jumper wire.</div>
          ${simSectionHtml}
        `;
      }

      this.inspectorEl.dataset.selectedKey = selectionKey;
      this.bindInspectorActionHandlers();
      this.bindInspectorSimHandlers(inst, partDef);
    } else if (this.selectedItem.type === 'wire') {
      const wire = this.wires.find((w) => w.id === this.selectedItem.id);
      if (!wire) {
        this.inspectorEl.hidden = true;
        this.inspectorEl.dataset.selectedKey = '';
        return;
      }
      this.inspectorEl.hidden = false;
      if (preserveControls && this.inspectorEl.dataset.selectedKey === selectionKey) {
        return;
      }
      const styleLabel =
        wire.style === 'straight'
          ? 'Solid-Core Wire (Straight)'
          : wire.style === 'curved-alt'
          ? 'Stranded Jumper (Arc 2)'
          : 'Stranded Jumper (Arc 1)';
      this.inspectorEl.dataset.selectedKey = selectionKey;
      this.inspectorEl.innerHTML = `
        <div class="inspector-header-row">
          <div class="inspector-title">${escapeHtml(wire.colorName || '')} ${escapeHtml(styleLabel)}</div>
          <div class="inspector-actions">
            <button type="button" class="inspector-action-btn" data-inspector-action="rotate" title="Cycle wire shape [R]">↻ Rotate</button>
            <button type="button" class="inspector-action-btn danger" data-inspector-action="delete" title="Delete selected wire [Delete]">✕ Del</button>
            <button type="button" class="inspector-action-btn inspector-close-btn" data-inspector-action="close" title="Close Inspector [Esc]" aria-label="Close Inspector">✕</button>
          </div>
        </div>
        <div class="inspector-detail">Connects <strong>${escapeHtml(wire.holeA)}</strong> ↔ <strong>${escapeHtml(wire.holeB)}</strong></div>
        <div class="inspector-hint">Tip: Press <kbd>R</kbd> to cycle wire shape (Arc 1 → Straight Solid → Arc 2), click a color swatch to recolor, or drag either wire tip.</div>
      `;
      this.bindInspectorActionHandlers();
    } else if (this.selectedItem.type === 'sensor') {
      const sideLabels = {
        top: 'Top (Above Board)',
        right: 'Right Side',
        bottom: 'Bottom (Below Board)',
        left: 'Left Side'
      };
      const curSide = this.breadboard.getEffectiveSensorSide();
      this.inspectorEl.hidden = false;

      if (preserveControls && this.inspectorEl.dataset.selectedKey === selectionKey) {
        this.refreshInspectorLiveState('sensor', null, null);
        return;
      }

      const simConfig = this.bench?.simConfig || {};
      const simSectionHtml = buildSimInspectorHtml({
        inst: 'sensor',
        partDef: null,
        partSim: null,
        powered: Boolean(simConfig.powered),
        loadCellsMode: this.breadboard.loadCellsMode,
        emgMode: this.breadboard.emgMode,
        pulseOxMode: this.breadboard.pulseOxMode,
        pulseOxResult: this.bench?.dcResult?.pulseOxResult || null,
        simConfig,
        escapeHtml
      });

      this.inspectorEl.innerHTML = `
        <div class="inspector-header-row">
          <div class="inspector-title">External Sensors Dock</div>
          <div class="inspector-actions">
            <button type="button" class="inspector-action-btn" data-inspector-action="rotate" title="Move sensors around the board [R]">↻ Move Side</button>
            <button type="button" class="inspector-action-btn inspector-close-btn" data-inspector-action="close" title="Close Inspector [Esc]" aria-label="Close Inspector">✕</button>
          </div>
        </div>
        <div class="inspector-detail">Position: <strong>${escapeHtml(sideLabels[curSide] || curSide)}</strong></div>
        <div class="inspector-hint">Tip: Press <kbd>R</kbd> (or click Move Side) to move sensors around the board (Top → Right → Bottom → Left).</div>
        ${simSectionHtml}
      `;
      this.inspectorEl.dataset.selectedKey = selectionKey;
      this.bindInspectorActionHandlers();
      this.bindInspectorSimHandlers('sensor', null);
    }
  }

  bindInspectorActionHandlers() {
    const rotateBtn = this.inspectorEl.querySelector('[data-inspector-action="rotate"]');
    if (rotateBtn) {
      rotateBtn.addEventListener('click', () => this.rotateSelected());
    }
    const deleteBtn = this.inspectorEl.querySelector('[data-inspector-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this.deleteSelected());
    }
    const closeBtn = this.inspectorEl.querySelector('[data-inspector-action="close"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.selectItem(null, null));
    }
  }

  refreshInspectorLiveState(inst, partDef, partSim) {
    const simConfig = this.bench?.simConfig || {};
    if (inst === 'sensor') {
      const grams = Math.round(Number.isFinite(simConfig.loadCellForceGrams) ? simConfig.loadCellForceGrams : 0);
      const valEl = this.inspectorEl.querySelector('[data-sim-val="loadCellForceGrams"]');
      const sliderEl = this.inspectorEl.querySelector('[data-sim-config="loadCellForceGrams"]');
      if (valEl) valEl.textContent = `${grams} g`;
      if (sliderEl && document.activeElement !== sliderEl) {
        sliderEl.value = String(grams);
      }

      const emg = createDefaultEmgConfig(simConfig.emg);
      const flexPct = Math.round(emg.flexEffort * 100);
      const flexValEl = this.inspectorEl.querySelector('[data-sim-emg-val="flexEffort"]');
      const flexSliderEl = this.inspectorEl.querySelector('input[data-sim-emg="flexEffort"]');
      if (flexValEl) flexValEl.textContent = `${flexPct}%`;
      if (flexSliderEl && document.activeElement !== flexSliderEl) {
        flexSliderEl.value = String(flexPct);
      }

      const burstBtnEl = this.inspectorEl.querySelector('button[data-sim-emg="burstMode"]');
      if (burstBtnEl) {
        const isBurst = emg.burstMode !== 'continuous';
        burstBtnEl.textContent = isBurst ? 'Burst' : 'Hold';
        burstBtnEl.classList.toggle('is-pressed', isBurst);
        burstBtnEl.setAttribute('aria-pressed', String(isBurst));
      }

      const humMvpp = Math.round(emg.humMvpp);
      const humValEl = this.inspectorEl.querySelector('[data-sim-emg-val="humMvpp"]');
      const humSliderEl = this.inspectorEl.querySelector('input[data-sim-emg="humMvpp"]');
      if (humValEl) humValEl.textContent = `${humMvpp} mVpp`;
      if (humSliderEl && document.activeElement !== humSliderEl) {
        humSliderEl.value = String(humMvpp);
      }

      const pox = createDefaultPulseOxConfig(simConfig.pulseOx);
      const poxRes = this.bench?.dcResult?.pulseOxResult || null;
      const poxStatusEl = this.inspectorEl.querySelector('[data-sim-pox-status]');
      if (poxStatusEl) {
        const powered = Boolean(simConfig.powered);
        const redOn = Boolean(powered && poxRes?.redLit);
        const irOn = Boolean(powered && poxRes?.irLit);
        const iPhText =
          powered && Number.isFinite(poxRes?.iPhUa)
            ? `${poxRes.iPhUa.toFixed(1)} µA`
            : '0.0 µA';
        poxStatusEl.textContent = `Red: ${redOn ? 'ON' : 'OFF'} · IR: ${irOn ? 'ON' : 'OFF'} · I_pd: ${iPhText}`;
        poxStatusEl.classList.remove('is-muted', 'is-ok', 'is-pulse', 'is-warn');
        poxStatusEl.classList.add(
          !powered ? 'is-muted' : redOn || irOn ? (pox.fingerPresent ? 'is-pulse' : 'is-ok') : 'is-warn'
        );
      }

      const poxFingerEl = this.inspectorEl.querySelector('[data-sim-prop="pulseOx.fingerPresent"]');
      if (poxFingerEl) {
        if (poxFingerEl.tagName === 'INPUT') {
          poxFingerEl.checked = Boolean(pox.fingerPresent);
        } else {
          const fingerIn = Boolean(pox.fingerPresent);
          poxFingerEl.classList.toggle('is-active', fingerIn);
          poxFingerEl.classList.toggle('is-pressed', fingerIn);
          poxFingerEl.setAttribute('aria-pressed', String(fingerIn));
          poxFingerEl.textContent = fingerIn ? 'Finger In' : 'No Finger';
        }
      }

      const poxBpm = Math.round(pox.bpm);
      const poxBpmValEl = this.inspectorEl.querySelector('[data-sim-val="pulseOx.bpm"]');
      const poxBpmSliderEl = this.inspectorEl.querySelector('input[data-sim-prop="pulseOx.bpm"]');
      if (poxBpmValEl) poxBpmValEl.textContent = `${poxBpm} BPM`;
      if (poxBpmSliderEl && document.activeElement !== poxBpmSliderEl) {
        poxBpmSliderEl.value = String(poxBpm);
      }

      const poxSpo2 = Math.round(pox.spo2);
      const poxSpo2ValEl = this.inspectorEl.querySelector('[data-sim-val="pulseOx.spo2"]');
      const poxSpo2SliderEl = this.inspectorEl.querySelector('input[data-sim-prop="pulseOx.spo2"]');
      if (poxSpo2ValEl) poxSpo2ValEl.textContent = `${poxSpo2}%`;
      if (poxSpo2SliderEl && document.activeElement !== poxSpo2SliderEl) {
        poxSpo2SliderEl.value = String(poxSpo2);
      }

      const poxPerfPct = Math.round(pox.perfusion * 100);
      const poxPerfValEl = this.inspectorEl.querySelector('[data-sim-val="pulseOx.perfusion"]');
      const poxPerfSliderEl = this.inspectorEl.querySelector('input[data-sim-prop="pulseOx.perfusion"]');
      if (poxPerfValEl) poxPerfValEl.textContent = `${poxPerfPct}%`;
      if (poxPerfSliderEl && document.activeElement !== poxPerfSliderEl) {
        const isFractionScale = Number(poxPerfSliderEl.max) > 0 && Number(poxPerfSliderEl.max) <= 2;
        poxPerfSliderEl.value = isFractionScale ? String(pox.perfusion) : String(poxPerfPct);
      }
      return;
    }

    const props = {
      ...getDefaultPartProps(inst.partId),
      ...(inst.props && typeof inst.props === 'object' ? inst.props : {})
    };

    const wiperValEl = this.inspectorEl.querySelector('[data-sim-val="wiper"]');
    if (wiperValEl) {
      wiperValEl.textContent = `${Math.round((props.wiper ?? 0.5) * 100)}%`;
    }

    const lightValEl = this.inspectorEl.querySelector('[data-sim-val="lightLevel"]');
    if (lightValEl) {
      const level = Number.isFinite(props.lightLevel) ? props.lightLevel : 0.5;
      const rOhms =
        props.lightMode === 'led-ppg' && Number.isFinite(partSim?.resistanceOhms)
          ? partSim.resistanceOhms
          : getPhotoresistorOhms(level);
      lightValEl.textContent = formatResistance(rOhms);
      const labelEl = this.inspectorEl.querySelector('label[for="sim-ctrl-light"]');
      if (labelEl) labelEl.textContent = `Ambient Light (${Math.round(level * 100)}%)`;
    }

    if (inst.partId === 'photoresistor') {
      for (const modeBtn of this.inspectorEl.querySelectorAll('[data-sim-prop="lightMode"]')) {
        const isSelectedMode = (modeBtn.dataset.simVal || 'manual') === (props.lightMode || 'manual');
        modeBtn.classList.toggle('is-active', isSelectedMode);
        modeBtn.classList.toggle('is-pressed', isSelectedMode);
        modeBtn.setAttribute('aria-pressed', String(isSelectedMode));
      }

      const opticalStatusEl = this.inspectorEl.querySelector('[data-sim-optical-status]');
      if (opticalStatusEl) {
        const powered = Boolean(simConfig.powered);
        const ledPct = Math.round((partSim?.ledBrightness || 0) * 100);
        const bpm = Math.round(Number.isFinite(props.bpm) ? props.bpm : 72);
        opticalStatusEl.classList.remove('is-muted', 'is-ok', 'is-pulse', 'is-warn');
        if (!powered) {
          opticalStatusEl.textContent = 'Power OFF — turn Lab Power ON';
          opticalStatusEl.classList.add('is-muted');
        } else if (!partSim?.opticalLinked) {
          opticalStatusEl.textContent = '🔴 No lit LED detected — wire & power a Red LED';
          opticalStatusEl.classList.add('is-warn');
        } else if (!props.fingerPresent) {
          opticalStatusEl.textContent = `🟢 LED Linked (${ledPct}%) — Direct Beam`;
          opticalStatusEl.classList.add('is-ok');
        } else {
          opticalStatusEl.textContent = `💓 LED Linked (${ledPct}%) · Finger PPG (${bpm} BPM)`;
          opticalStatusEl.classList.add('is-pulse');
        }
      }

      const ldrFingerEl = this.inspectorEl.querySelector('[data-sim-prop="fingerPresent"]');
      if (ldrFingerEl) {
        if (ldrFingerEl.tagName === 'INPUT') {
          ldrFingerEl.checked = Boolean(props.fingerPresent);
        } else {
          const fingerIn = Boolean(props.fingerPresent);
          ldrFingerEl.classList.toggle('is-active', fingerIn);
          ldrFingerEl.classList.toggle('is-pressed', fingerIn);
          ldrFingerEl.setAttribute('aria-pressed', String(fingerIn));
          ldrFingerEl.textContent = fingerIn ? 'Finger In' : 'No Finger';
        }
      }

      const bpm = Math.round(Number.isFinite(props.bpm) ? props.bpm : 72);
      const bpmValEl = this.inspectorEl.querySelector('[data-sim-val="bpm"]');
      const bpmSliderEl = this.inspectorEl.querySelector('input[data-sim-prop="bpm"]');
      if (bpmValEl) bpmValEl.textContent = `${bpm} BPM`;
      if (bpmSliderEl && document.activeElement !== bpmSliderEl) {
        bpmSliderEl.value = String(bpm);
      }

      const perf = Number.isFinite(props.perfusion) ? props.perfusion : 0.5;
      const perfPct = Math.round(perf * 100);
      const perfValEl = this.inspectorEl.querySelector('[data-sim-val="perfusion"]');
      const perfSliderEl = this.inspectorEl.querySelector('input[data-sim-prop="perfusion"]');
      if (perfValEl) perfValEl.textContent = `${perfPct}%`;
      if (perfSliderEl && document.activeElement !== perfSliderEl) {
        const isFractionScale = Number(perfSliderEl.max) > 0 && Number(perfSliderEl.max) <= 2;
        perfSliderEl.value = isFractionScale ? String(perf) : String(perfPct);
      }
    }

    const holdBtn = this.inspectorEl.querySelector('[data-sim-hold-btn]');
    const latchCb = this.inspectorEl.querySelector('[data-sim-prop="pressed"]');
    if (holdBtn) holdBtn.classList.toggle('is-pressed', Boolean(props.pressed));
    if (latchCb) latchCb.checked = Boolean(props.pressed);

    const telemetryEl = this.inspectorEl.querySelector('[data-sim-telemetry]');
    if (telemetryEl) {
      const inner = buildSimTelemetryHtml({
        inst,
        partDef,
        partSim,
        powered: Boolean(simConfig.powered),
        escapeHtml
      });
      telemetryEl.innerHTML = inner;
      telemetryEl.hidden = !(Boolean(simConfig.powered && partSim) && inner.length > 0);
    }
  }

  bindInspectorSimHandlers(inst, partDef) {
    const wiperSlider = this.inspectorEl.querySelector('input[data-sim-prop="wiper"]');
    if (wiperSlider && inst && inst !== 'sensor') {
      wiperSlider.addEventListener('input', () => {
        const val = Number(wiperSlider.value) / 100;
        inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), wiper: val };
        this.recomputeSimulation({ save: false, preserveInspectorControls: true });
      });
      wiperSlider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }

    const potResSelect = this.inspectorEl.querySelector('select[data-sim-prop="resistance"]');
    if (potResSelect && inst && inst !== 'sensor') {
      potResSelect.addEventListener('change', () => {
        const val = Number(potResSelect.value);
        inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), resistance: val };
        this.recomputeSimulation({ save: true, preserveInspectorControls: true });
      });
    }

    const lightSlider = this.inspectorEl.querySelector('input[data-sim-prop="lightLevel"]');
    if (lightSlider && inst && inst !== 'sensor') {
      lightSlider.addEventListener('input', () => {
        const val = Number(lightSlider.value) / 100;
        inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), lightLevel: val };
        this.recomputeSimulation({ save: false, preserveInspectorControls: true });
      });
      lightSlider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }

    if (inst && inst !== 'sensor' && inst.partId === 'photoresistor') {
      for (const modeBtn of this.inspectorEl.querySelectorAll('[data-sim-prop="lightMode"]')) {
        modeBtn.addEventListener('click', () => {
          const nextMode = modeBtn.dataset.simVal === 'led-ppg' ? 'led-ppg' : 'manual';
          inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), lightMode: nextMode };
          this.recomputeSimulation({ save: true, preserveInspectorControls: false });
        });
      }

      const ldrFingerEl = this.inspectorEl.querySelector('[data-sim-prop="fingerPresent"]');
      if (ldrFingerEl) {
        if (ldrFingerEl.tagName === 'INPUT') {
          ldrFingerEl.addEventListener('change', () => {
            inst.props = {
              ...getDefaultPartProps(inst.partId),
              ...(inst.props || {}),
              fingerPresent: ldrFingerEl.checked
            };
            this.recomputeSimulation({ save: true, preserveInspectorControls: true });
          });
        } else {
          ldrFingerEl.addEventListener('click', () => {
            const cur = Boolean(inst.props?.fingerPresent);
            inst.props = {
              ...getDefaultPartProps(inst.partId),
              ...(inst.props || {}),
              fingerPresent: !cur
            };
            this.recomputeSimulation({ save: true, preserveInspectorControls: true });
          });
        }
      }

      const ldrBpmSlider = this.inspectorEl.querySelector('input[data-sim-prop="bpm"]');
      if (ldrBpmSlider) {
        ldrBpmSlider.addEventListener('input', () => {
          const bpm = Number(ldrBpmSlider.value);
          inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), bpm };
          this.recomputeSimulation({ save: false, preserveInspectorControls: true });
        });
        ldrBpmSlider.addEventListener('change', () => {
          this.saveToLocalStorage();
        });
      }

      const ldrPerfSlider = this.inspectorEl.querySelector('input[data-sim-prop="perfusion"]');
      if (ldrPerfSlider) {
        const isFractionScale = Number(ldrPerfSlider.max) > 0 && Number(ldrPerfSlider.max) <= 2;
        ldrPerfSlider.addEventListener('input', () => {
          const raw = Number(ldrPerfSlider.value);
          const perfusion = isFractionScale ? raw : raw / 100;
          inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), perfusion };
          this.recomputeSimulation({ save: false, preserveInspectorControls: true });
        });
        ldrPerfSlider.addEventListener('change', () => {
          this.saveToLocalStorage();
        });
      }
    }

    const holdBtn = this.inspectorEl.querySelector('[data-sim-hold-btn]');
    if (holdBtn && inst && inst !== 'sensor') {
      holdBtn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.heldPushbuttonId = inst.id;
        inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), pressed: true };
        this.recomputeSimulation({ save: false, preserveInspectorControls: true });
      });
    }

    const latchCb = this.inspectorEl.querySelector('input[data-sim-prop="pressed"]');
    if (latchCb && inst && inst !== 'sensor') {
      latchCb.addEventListener('change', () => {
        inst.props = { ...getDefaultPartProps(inst.partId), ...(inst.props || {}), pressed: latchCb.checked };
        this.recomputeSimulation({ save: true, preserveInspectorControls: true });
      });
    }

    const loadSlider = this.inspectorEl.querySelector('input[data-sim-config="loadCellForceGrams"]');
    if (loadSlider) {
      loadSlider.addEventListener('input', () => {
        if (this.bench?.simConfig) {
          this.bench.simConfig.loadCellForceGrams = Number(loadSlider.value);
        }
        this.recomputeSimulation({ save: false, preserveInspectorControls: true });
      });
      loadSlider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }

    const emgFlexSlider = this.inspectorEl.querySelector('input[data-sim-emg="flexEffort"]');
    if (emgFlexSlider) {
      emgFlexSlider.addEventListener('input', () => {
        if (this.bench?.simConfig) {
          this.bench.simConfig.emg = createDefaultEmgConfig({
            ...this.bench.simConfig.emg,
            flexEffort: Number(emgFlexSlider.value) / 100
          });
        }
        this.recomputeSimulation({ save: false, preserveInspectorControls: true });
      });
      emgFlexSlider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }

    const emgModeBtn = this.inspectorEl.querySelector('button[data-sim-emg="burstMode"]');
    if (emgModeBtn) {
      emgModeBtn.addEventListener('click', () => {
        if (this.bench?.simConfig) {
          const cur = this.bench.simConfig.emg?.burstMode;
          this.bench.simConfig.emg = createDefaultEmgConfig({
            ...this.bench.simConfig.emg,
            burstMode: cur === 'continuous' ? 'burst' : 'continuous'
          });
        }
        this.recomputeSimulation({ save: true, preserveInspectorControls: true });
      });
    }

    const emgHumSlider = this.inspectorEl.querySelector('input[data-sim-emg="humMvpp"]');
    if (emgHumSlider) {
      emgHumSlider.addEventListener('input', () => {
        if (this.bench?.simConfig) {
          this.bench.simConfig.emg = createDefaultEmgConfig({
            ...this.bench.simConfig.emg,
            humMvpp: Number(emgHumSlider.value)
          });
        }
        this.recomputeSimulation({ save: false, preserveInspectorControls: true });
      });
      emgHumSlider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }

    const poxFingerEl = this.inspectorEl.querySelector('[data-sim-prop="pulseOx.fingerPresent"]');
    if (poxFingerEl) {
      if (poxFingerEl.tagName === 'INPUT') {
        poxFingerEl.addEventListener('change', () => {
          this.bench?.applyStimulusPatch({ pulseOx: { fingerPresent: poxFingerEl.checked } }, { commit: true });
        });
      } else {
        poxFingerEl.addEventListener('click', () => {
          const cur = this.bench?.simConfig?.pulseOx?.fingerPresent !== false;
          this.bench?.applyStimulusPatch({ pulseOx: { fingerPresent: !cur } }, { commit: true });
        });
      }
    }

    const poxBpmSlider = this.inspectorEl.querySelector('input[data-sim-prop="pulseOx.bpm"]');
    if (poxBpmSlider) {
      poxBpmSlider.addEventListener('input', () => {
        this.bench?.applyStimulusPatch({ pulseOx: { bpm: Number(poxBpmSlider.value) } }, { commit: false });
      });
      poxBpmSlider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }

    const poxSpo2Slider = this.inspectorEl.querySelector('input[data-sim-prop="pulseOx.spo2"]');
    if (poxSpo2Slider) {
      poxSpo2Slider.addEventListener('input', () => {
        this.bench?.applyStimulusPatch({ pulseOx: { spo2: Number(poxSpo2Slider.value) } }, { commit: false });
      });
      poxSpo2Slider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }

    const poxPerfSlider = this.inspectorEl.querySelector('input[data-sim-prop="pulseOx.perfusion"]');
    if (poxPerfSlider) {
      const isFractionScale = Number(poxPerfSlider.max) > 0 && Number(poxPerfSlider.max) <= 2;
      poxPerfSlider.addEventListener('input', () => {
        const raw = Number(poxPerfSlider.value);
        const perfusion = isFractionScale ? raw : raw / 100;
        this.bench?.applyStimulusPatch({ pulseOx: { perfusion } }, { commit: false });
      });
      poxPerfSlider.addEventListener('change', () => {
        this.saveToLocalStorage();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Presets, Probe Mode UI & Persistence
  // ---------------------------------------------------------------------------
  populatePresetSelect() {
    if (!this.presetSelect) return;
    this.presetSelect.innerHTML = '<option value="">★ Lab Demos</option>';
    for (const preset of LAB_PRESETS) {
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name;
      opt.title = preset.description;
      this.presetSelect.appendChild(opt);
    }
  }

  updateProbeModeUI() {
    const isRed = this.interactionMode === 'probe-red';
    const isBlack = this.interactionMode === 'probe-black';
    const isFgen = this.interactionMode === 'probe-fgen';
    const isArbAo0 = this.interactionMode === 'probe-arb-ao0';
    const isArbAo1 = this.interactionMode === 'probe-arb-ao1';
    const isScope0 = this.interactionMode === 'probe-scope-ch0';
    const isScope1 = this.interactionMode === 'probe-scope-ch1';
    const isBodeIn = this.interactionMode === 'probe-bode-in';
    const isBodeOut = this.interactionMode === 'probe-bode-out';
    const isProbing =
      isRed ||
      isBlack ||
      isFgen ||
      isArbAo0 ||
      isArbAo1 ||
      isScope0 ||
      isScope1 ||
      isBodeIn ||
      isBodeOut;

    if (this.canvasWrap) {
      this.canvasWrap.classList.toggle('probe-mode-active', isProbing);
    }
    if (this.probeBannerEl) {
      this.probeBannerEl.hidden = !isProbing;
      this.probeBannerEl.style.borderColor = isRed
        ? '#ef4444'
        : isBlack
        ? '#94a3b8'
        : isFgen
        ? '#06b6d4'
        : isArbAo0
        ? '#22c55e'
        : isArbAo1
        ? '#f59e0b'
        : isScope0
        ? '#22c55e'
        : isScope1
        ? '#eab308'
        : isBodeIn
        ? '#38bdf8'
        : isBodeOut
        ? '#f472b6'
        : '#38bdf8';

      if (isRed) {
        this.probeBannerEl.textContent = 'Click any hole or pin to place 🔴 Red (+) probe — press Esc to cancel';
      } else if (isBlack) {
        this.probeBannerEl.textContent = 'Click any hole or pin to place ⚫ Black (COM) probe — press Esc to cancel';
      } else if (isFgen) {
        this.probeBannerEl.textContent = 'Click any hole or pin to place 🔵 FGEN output probe — press Esc to cancel';
      } else if (isArbAo0) {
        this.probeBannerEl.textContent = 'Click any breadboard hole to connect ARB AO 0 output (Esc to cancel)';
      } else if (isArbAo1) {
        this.probeBannerEl.textContent = 'Click any breadboard hole to connect ARB AO 1 output (Esc to cancel)';
      } else if (isScope0) {
        this.probeBannerEl.textContent = 'Click any hole or pin to place 🟢 Scope CH 0 probe — press Esc to cancel';
      } else if (isScope1) {
        this.probeBannerEl.textContent = 'Click any hole or pin to place 🟡 Scope CH 1 probe — press Esc to cancel';
      } else if (isBodeIn) {
        this.probeBannerEl.textContent = 'Click any hole or pin to place 🔷 Bode Input (BIN) probe — press Esc to cancel';
      } else if (isBodeOut) {
        this.probeBannerEl.textContent = 'Click any hole or pin to place 🩷 Bode Output (BOUT) probe — press Esc to cancel';
      } else {
        this.probeBannerEl.textContent = '';
      }
    }
  }

  saveToLocalStorage() {
    this.simState = this.bench ? this.bench.getSimStateSnapshot() : this.simState;
    saveCircuitToLocalStorage(this.breadboard, this.placedParts, this.wires, {
      simState: this.simState
    });
  }

  applyParsedCircuitState(data) {
    this.breadboard.configure({
      elvisMode: data.elvisMode,
      loadCellsMode: data.loadCellsMode,
      emgMode: data.emgMode,
      pulseOxMode: Boolean(data.pulseOxMode),
      sensorPosition: data.sensorPosition
    });
    this.btnElvisMode.classList.toggle('active', this.breadboard.elvisMode);
    this.placedParts = data.placedParts;
    this.wires = data.wires;
    this.simState = data.simState ? { ...data.simState } : {};

    this.bench?.applySimState(this.simState);
    this.interactionMode = 'build';
    this.updateProbeModeUI();
    this.hoveredHoleId = null;
    this.resetZoom();
    this.updateBoardViewBox();
    this.renderBreadboardBase();
    this.renderXrayLayer();
    this.renderBreadboardHoles();
    this.updateStatusBar();
    this.syncSidebarSensors();
  }

  loadFromLocalStorage() {
    const data = loadCircuitFromLocalStorage();
    if (!data) return false;
    this.applyParsedCircuitState(data);
    return true;
  }

  exportCircuitJson() {
    this.simState = this.bench ? this.bench.getSimStateSnapshot() : this.simState;
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
    if (this.btnZoomReset) {
      this.btnZoomReset.textContent = `${Math.round(this.viewZoom * 100)}%`;
    }
  }

  getMaxZoom() {
    return computeEffectiveMaxZoom(
      this.breadboard.getBoardViewBox(),
      this.svgEl.getBoundingClientRect(),
      2.6
    );
  }

  panBy(dx, dy) {
    this.viewPan.x += dx;
    this.viewPan.y += dy;
    this.applyViewportTransform();
  }

  zoomBy(factor, clientX = null, clientY = null) {
    const oldZoom = this.viewZoom;
    const maxZoom = this.getMaxZoom();
    if (factor > 1 && oldZoom >= maxZoom) return;
    const upperBound = factor < 1 ? Math.max(maxZoom, oldZoom) : maxZoom;
    const newZoom = Math.min(upperBound, Math.max(0.55, oldZoom * factor));
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
    window.addEventListener('pointercancel', (e) => this.onGlobalPointerCancel(e));
    window.addEventListener('blur', () => {
      this.activeTouchPointers.clear();
      this.pinchState = null;
      this.isPanning = false;
      this.spacePressed = false;
      this.floatingWindowDrag = null;
      this.canvasWrap.classList.remove('panning');
      this.cancelActiveDrag();
      this.releaseHeldPushbutton();
    });

    // Capture multi-touch pinch/pan and Space + drag or Middle-click drag anywhere on the board surface
    this.canvasWrap.addEventListener(
      'pointerdown',
      (e) => {
        const onBoardSurface = e.target === this.canvasWrap || this.svgEl.contains(e.target);
        if (e.pointerType === 'touch' && onBoardSurface) {
          this.activeTouchPointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
          if (this.activeTouchPointers.size >= 2) {
            e.preventDefault();
            e.stopPropagation();
            this.isPanning = false;
            this.floatingWindowDrag = null;
            this.canvasWrap.classList.remove('panning');
            this.cancelActiveDrag();
            this.onHoleHover(null);
            if (this.activeTouchPointers.size === 2 || !this.pinchState) {
              this.rebaselinePinchState();
            }
            return;
          }
        }
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
      const onBoardSurface = e.target === this.canvasWrap || this.svgEl.contains(e.target);
      if (!onBoardSurface) return;
      e.preventDefault();
      const clampedDelta = Math.max(-35, Math.min(35, e.deltaY));
      const factor = e.ctrlKey ? Math.exp(-clampedDelta * 0.01) : (e.deltaY < 0 ? 1.1 : 0.9);
      this.zoomBy(factor, e.clientX, e.clientY);
    }, { passive: false });

    if (this.btnSimPower) {
      this.btnSimPower.addEventListener('click', () => this.bench?.toggleSimPower());
    }

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

    // Toggle handled by initRcCalculator()

    this.setFileMenuOpen = (open) => {
      if (!this.fileMenuDropdown || !this.btnFileMenu) return;
      const next = Boolean(open);
      this.fileMenuDropdown.hidden = !next;
      this.btnFileMenu.classList.toggle('active', next);
      this.btnFileMenu.setAttribute('aria-expanded', String(next));
      if (next) {
        this.setHelpPopoverOpen(false);
      }
    };

    this.setHelpPopoverOpen = (open) => {
      if (!this.helpPopover || !this.btnHelpShortcuts) return;
      const next = Boolean(open);
      this.helpPopover.hidden = !next;
      this.btnHelpShortcuts.classList.toggle('active', next);
      this.btnHelpShortcuts.setAttribute('aria-expanded', String(next));
      if (next) {
        this.setFileMenuOpen(false);
      }
    };

    this.closeTopbarPopovers = () => {
      this.setFileMenuOpen(false);
      this.setHelpPopoverOpen(false);
    };

    if (this.btnFileMenu && this.fileMenuDropdown) {
      this.btnFileMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setFileMenuOpen(this.fileMenuDropdown.hidden);
      });
    }

    if (this.btnHelpShortcuts && this.helpPopover) {
      this.btnHelpShortcuts.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setHelpPopoverOpen(this.helpPopover.hidden);
      });
    }

    if (this.btnHelpClose) {
      this.btnHelpClose.addEventListener('click', () => {
        this.setHelpPopoverOpen(false);
      });
    }

    document.addEventListener(
      'pointerdown',
      (e) => {
        const targetEl = e.target instanceof Element ? e.target : null;
        if (this.fileMenuDropdown && !this.fileMenuDropdown.hidden) {
          if (!targetEl || !targetEl.closest('.file-menu-wrap')) {
            this.setFileMenuOpen(false);
          }
        }
        if (this.helpPopover && !this.helpPopover.hidden) {
          if (!targetEl || !targetEl.closest('.help-popover-wrap')) {
            this.setHelpPopoverOpen(false);
          }
        }
      },
      true
    );

    if (this.presetSelect) {
      this.presetSelect.addEventListener('change', () => {
        const presetId = this.presetSelect.value;
        if (!presetId) return;
        this.bench?.loadPreset(presetId);
      });
    }

    this.btnClear.addEventListener('click', () => {
      this.setFileMenuOpen(false);
      this.placedParts = [];
      this.wires = [];
      this.bench?.clearAllProbes();
      this.interactionMode = 'build';
      this.bench?.setActivePresetLabel('');
      this.updateProbeModeUI();
      this.selectItem(null, null);
    });

    this.btnSaveJson.addEventListener('click', () => {
      this.setFileMenuOpen(false);
      this.exportCircuitJson();
    });
    this.btnLoadJson.addEventListener('click', () => {
      this.setFileMenuOpen(false);
      this.fileLoadInput.click();
    });
    this.fileLoadInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this.importCircuitJson(file);
        e.target.value = '';
      }
    });

    this.btnExportSvg.addEventListener('click', () => {
      this.setFileMenuOpen(false);
      this.exportSvgImage();
    });

    this.btnPanLeft.addEventListener('click', () => this.panBy(64, 0));
    this.btnPanRight.addEventListener('click', () => this.panBy(-64, 0));
    this.btnPanUp.addEventListener('click', () => this.panBy(0, 64));
    this.btnPanDown.addEventListener('click', () => this.panBy(0, -64));

    this.btnZoomIn.addEventListener('click', () => this.zoomBy(1.18));
    this.btnZoomOut.addEventListener('click', () => this.zoomBy(1 / 1.18));
    this.btnZoomReset.addEventListener('click', () => this.resetZoom());

    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.tagName === 'SELECT' ||
        e.target.isContentEditable
      ) {
        return;
      }
      const inComputerMode =
        this.bench?.workspaceManager?.getState().workspaceMode === 'computer';

      if (e.key === '?') {
        if (inComputerMode) return;
        e.preventDefault();
        this.setHelpPopoverOpen(this.helpPopover ? this.helpPopover.hidden : false);
        return;
      }

      if (e.code === 'Space') {
        if (inComputerMode) return;
        this.spacePressed = true;
        this.canvasWrap.classList.add('panning');
      } else if (e.key === 'ArrowLeft') {
        if (inComputerMode) return;
        e.preventDefault();
        this.panBy(48, 0);
      } else if (e.key === 'ArrowRight') {
        if (inComputerMode) return;
        e.preventDefault();
        this.panBy(-48, 0);
      } else if (e.key === 'ArrowUp') {
        if (inComputerMode) return;
        e.preventDefault();
        this.panBy(0, 48);
      } else if (e.key === 'ArrowDown') {
        if (inComputerMode) return;
        e.preventDefault();
        this.panBy(0, -48);
      } else if (e.key === 'r' || e.key === 'R') {
        if (inComputerMode) return;
        e.preventDefault();
        this.rotateSelected();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (inComputerMode) return;
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === 'Escape') {
        if (this.fileMenuDropdown && !this.fileMenuDropdown.hidden) {
          this.setFileMenuOpen(false);
        } else if (this.helpPopover && !this.helpPopover.hidden) {
          this.setHelpPopoverOpen(false);
        } else if (this.interactionMode !== 'build') {
          this.interactionMode = 'build';
          this.updateProbeModeUI();
          this.bench?.updateAllInstruments();
        } else {
          this.selectItem(null, null);
        }
      } else if (e.key === 'x' || e.key === 'X') {
        if (inComputerMode) return;
        this.btnXray.click();
      } else if (this.bench?.handleKeydownShortcut(e.key)) {
        e.preventDefault();
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
