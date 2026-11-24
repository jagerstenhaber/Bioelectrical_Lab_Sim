/**
 * Parts Catalog Loader
 * Dynamically loads parts from `parts/manifest.json` and each `parts/<part-id>/` folder
 * (`part.json` and `graphic.svg`).
 * Also includes a seamless fallback if opened directly via `file://` where browser CORS blocks `fetch()`.
 */

function stripOuterSvg(svgText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) {
    return { viewBox: '-19 -8 38 16', innerMarkup: svgText };
  }
  return {
    viewBox: svgEl.getAttribute('viewBox') || '-19 -8 38 16',
    innerMarkup: svgEl.innerHTML
  };
}

export async function loadPartsCatalog() {
  try {
    const manifestResp = await fetch('./parts/manifest.json');
    if (!manifestResp.ok) throw new Error(`HTTP ${manifestResp.status}`);
    const manifest = await manifestResp.json();

    const loadedParts = await Promise.all(
      manifest.parts.map(async (folderId) => {
        const [metaResp, svgResp] = await Promise.all([
          fetch(`./parts/${folderId}/part.json`),
          fetch(`./parts/${folderId}/graphic.svg`)
        ]);
        if (!metaResp.ok || !svgResp.ok) {
          throw new Error(`Failed to load part folder: ${folderId}`);
        }
        const meta = await metaResp.json();
        const svgText = await svgResp.text();
        const { viewBox, innerMarkup } = stripOuterSvg(svgText);
        return {
          ...meta,
          folderPath: `./parts/${folderId}`,
          svgViewBox: viewBox,
          svgInnerMarkup: innerMarkup,
          svgRaw: svgText
        };
      })
    );

    return loadedParts;
  } catch (err) {
    console.warn('Dynamic fetch from ./parts/ failed (likely opened via file:// protocol); using built-in mirror of ./parts/:', err);
    return getFallbackCatalog().map((item) => {
      const { viewBox, innerMarkup } = stripOuterSvg(item.svgRaw);
      return {
        ...item,
        svgViewBox: viewBox,
        svgInnerMarkup: innerMarkup
      };
    });
  }
}

function makeResistor5PctSvg(b1, b2, b3, b4 = '#D4AF37') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-19 -8 38 16" width="38" height="16">
  <path d="M -17 -4.5 C -17 -6.8 -12 -6.8 -10 -5.2 L 10 -5.2 C 12 -6.8 17 -6.8 17 -4.5 L 17 4.5 C 17 6.8 12 6.8 10 5.2 L -10 5.2 C -12 6.8 -17 6.8 -17 4.5 Z" fill="#e6cfa3" stroke="#9c7e4e" stroke-width="1.1"/>
  <rect x="-11" y="-5.4" width="3.2" height="10.8" fill="${b1}"/>
  <rect x="-5"  y="-5.1" width="3.0" height="10.2" fill="${b2}"/>
  <rect x="1"   y="-5.1" width="3.0" height="10.2" fill="${b3}"/>
  <rect x="8.5" y="-5.4" width="2.8" height="10.8" fill="${b4}"/>
  <line x1="-14" y1="-3.3" x2="14" y2="-3.3" stroke="rgba(255,255,255,0.45)" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;
}

function makeResistor1PctSvg(b1, b2, b3, b4, b5 = '#8B4513') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-19 -8 38 16" width="38" height="16">
  <path d="M -17 -4.5 C -17 -6.8 -12 -6.8 -10 -5.2 L 10 -5.2 C 12 -6.8 17 -6.8 17 -4.5 L 17 4.5 C 17 6.8 12 6.8 10 5.2 L -10 5.2 C -12 6.8 -17 6.8 -17 4.5 Z" fill="#67b7f7" stroke="#2563eb" stroke-width="1.1"/>
  <rect x="-12.5" y="-5.5" width="2.6" height="11.0" fill="${b1}"/>
  <rect x="-7.2"  y="-5.1" width="2.5" height="10.2" fill="${b2}"/>
  <rect x="-2.2"  y="-5.1" width="2.5" height="10.2" fill="${b3}"/>
  <rect x="2.8"   y="-5.1" width="2.5" height="10.2" fill="${b4}"/>
  <rect x="9.5"   y="-5.5" width="2.6" height="11.0" fill="${b5}"/>
  <line x1="-14" y1="-3.3" x2="14" y2="-3.3" stroke="rgba(255,255,255,0.48)" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;
}

export function getFallbackCatalog() {
  const nanoPins = [
    { id: 'D12', label: 'D12', dx: 0, dy: 0, role: 'digital' },
    { id: 'D11', label: 'D11', dx: 1, dy: 0, role: 'digital' },
    { id: 'D10', label: 'D10', dx: 2, dy: 0, role: 'digital' },
    { id: 'D9', label: 'D9', dx: 3, dy: 0, role: 'digital' },
    { id: 'D8', label: 'D8', dx: 4, dy: 0, role: 'digital' },
    { id: 'D7', label: 'D7', dx: 5, dy: 0, role: 'digital' },
    { id: 'D6', label: 'D6', dx: 6, dy: 0, role: 'digital' },
    { id: 'D5', label: 'D5', dx: 7, dy: 0, role: 'digital' },
    { id: 'D4', label: 'D4', dx: 8, dy: 0, role: 'digital' },
    { id: 'D3', label: 'D3', dx: 9, dy: 0, role: 'digital' },
    { id: 'D2', label: 'D2', dx: 10, dy: 0, role: 'digital' },
    { id: 'GND_TOP', label: 'GND', dx: 11, dy: 0, role: 'ground' },
    { id: 'RST_TOP', label: 'RST', dx: 12, dy: 0, role: 'control' },
    { id: 'D0', label: 'RX0', dx: 13, dy: 0, role: 'digital' },
    { id: 'D1', label: 'TX1', dx: 14, dy: 0, role: 'digital' },
    { id: 'D13', label: 'D13', dx: 0, dy: 6, role: 'digital' },
    { id: '3V3', label: '3V3', dx: 1, dy: 6, role: 'power' },
    { id: 'AREF', label: 'AREF', dx: 2, dy: 6, role: 'analog' },
    { id: 'A0', label: 'A0', dx: 3, dy: 6, role: 'analog' },
    { id: 'A1', label: 'A1', dx: 4, dy: 6, role: 'analog' },
    { id: 'A2', label: 'A2', dx: 5, dy: 6, role: 'analog' },
    { id: 'A3', label: 'A3', dx: 6, dy: 6, role: 'analog' },
    { id: 'A4', label: 'A4', dx: 7, dy: 6, role: 'analog' },
    { id: 'A5', label: 'A5', dx: 8, dy: 6, role: 'analog' },
    { id: 'A6', label: 'A6', dx: 9, dy: 6, role: 'analog' },
    { id: 'A7', label: 'A7', dx: 10, dy: 6, role: 'analog' },
    { id: '5V', label: '5V', dx: 11, dy: 6, role: 'power' },
    { id: 'RST_BOT', label: 'RST', dx: 12, dy: 6, role: 'control' },
    { id: 'GND_BOT', label: 'GND', dx: 13, dy: 6, role: 'ground' },
    { id: 'VIN', label: 'VIN', dx: 14, dy: 6, role: 'power_in' }
  ];

  const nanoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 -10 252 116" width="252" height="116">
    <rect x="-10" y="-8" width="244" height="112" rx="4" fill="#0b6480" stroke="#053b4c" stroke-width="1.5"/>
    <rect x="-6" y="-5" width="236" height="106" rx="2" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="0.8"/>
    <rect x="-14" y="29" width="26" height="38" rx="3" fill="#cbd5e1" stroke="#475569" stroke-width="1.2"/>
    <g transform="translate(106, 48) rotate(45)">
      <rect x="-16" y="-16" width="32" height="32" rx="2" fill="#1e293b" stroke="#0f172a" stroke-width="1.2"/>
    </g>
    <rect x="156" y="38" width="18" height="20" rx="2" fill="#e2e8f0" stroke="#475569" stroke-width="1"/>
    <circle cx="165" cy="48" r="3.5" fill="#dc2626"/>
    <g transform="translate(208, 34)">
      <rect x="-4" y="-3" width="18" height="34" rx="1.5" fill="#1e293b" stroke="#475569" stroke-width="0.8"/>
    </g>
    <text x="64" y="26" fill="#ffffff" font-family="sans-serif" font-weight="700" font-size="7.5">ARDUINO</text>
    <text x="64" y="75" fill="#bae6fd" font-family="sans-serif" font-weight="700" font-size="8">NANO</text>
  </svg>`;

  const opampSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -5 66 58" width="66" height="58">
    <g fill="#cbd5e1" stroke="#475569" stroke-width="0.8">
      <rect x="-2.8" y="-2.8" width="5.6" height="7" rx="1"/><rect x="13.2" y="-2.8" width="5.6" height="7" rx="1"/>
      <rect x="29.2" y="-2.8" width="5.6" height="7" rx="1"/><rect x="45.2" y="-2.8" width="5.6" height="7" rx="1"/>
      <rect x="-2.8" y="43.8" width="5.6" height="7" rx="1"/><rect x="13.2" y="43.8" width="5.6" height="7" rx="1"/>
      <rect x="29.2" y="43.8" width="5.6" height="7" rx="1"/><rect x="45.2" y="43.8" width="5.6" height="7" rx="1"/>
    </g>
    <rect x="-7" y="3" width="62" height="42" rx="2.5" fill="#1e293b" stroke="#0f172a" stroke-width="1.4"/>
    <path d="M -7 19 A 5 5 0 0 1 -7 29" fill="#0f172a" stroke="#475569" stroke-width="0.9"/>
    <circle cx="-1.5" cy="39.5" r="1.6" fill="#f8fafc"/>
    <text x="1" y="13.5" fill="#fca5a5" font-family="monospace" font-weight="800" font-size="5.5">V+</text>
    <text x="41.5" y="38" fill="#93c5fd" font-family="monospace" font-weight="800" font-size="5.5">V-</text>
    <polygon points="19.5,14 33,7.5 33,20.5" fill="rgba(56,189,248,0.14)" stroke="#7dd3fc" stroke-width="1.1"/>
    <polyline points="19.5,14 16,14 16,3" fill="none" stroke="#bae6fd" stroke-width="1"/>
    <polyline points="32,3 32,6 36,6 36,10.5 33,10.5" fill="none" stroke="#bae6fd" stroke-width="1"/>
    <polyline points="48,3 48,17.5 33,17.5" fill="none" stroke="#bae6fd" stroke-width="1"/>
    <polygon points="5.5,33 19,26.5 19,39.5" fill="rgba(56,189,248,0.14)" stroke="#7dd3fc" stroke-width="1.1"/>
    <polyline points="5.5,33 0,33 0,45" fill="none" stroke="#bae6fd" stroke-width="1"/>
    <polyline points="16,45 16,42 22,42 22,36 19,36" fill="none" stroke="#bae6fd" stroke-width="1"/>
    <polyline points="32,45 32,29.5 19,29.5" fill="none" stroke="#bae6fd" stroke-width="1"/>
  </svg>`;

  const potSideSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -44 84 52" width="84" height="52">
    <rect x="23" y="-43" width="18" height="14" rx="2" fill="#cbd5e1" stroke="#475569" stroke-width="1"/>
    <rect x="21" y="-29" width="22" height="5" rx="1" fill="#94a3b8" stroke="#475569" stroke-width="1"/>
    <rect x="-6" y="-24" width="76" height="17" rx="3.5" fill="#94a3b8" stroke="#334155" stroke-width="1.3"/>
    <rect x="-4" y="-10" width="72" height="5" rx="1" fill="#92400e" stroke="#78350f" stroke-width="0.9"/>
    <circle cx="0" cy="0" r="3.5" fill="#eab308" stroke="#a16207" stroke-width="0.9"/>
    <circle cx="32" cy="0" r="3.5" fill="#38bdf8" stroke="#0369a1" stroke-width="0.9"/>
    <circle cx="64" cy="0" r="3.5" fill="#eab308" stroke="#a16207" stroke-width="0.9"/>
  </svg>`;

  const potTopSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -7 34 46" width="34" height="46">
    <rect x="-7" y="-5" width="30" height="42" rx="3" fill="#1d4ed8" stroke="#1e3a8a" stroke-width="1.3"/>
    <circle cx="8" cy="16" r="10.2" fill="#f8fafc" stroke="#64748b" stroke-width="1.1"/>
    <line x1="8" y1="9.5" x2="8" y2="22.5" stroke="#475569" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="2.5" y1="16" x2="13.5" y2="16" stroke="#475569" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="0" cy="0" r="3.2" fill="#eab308" stroke="#a16207" stroke-width="0.9"/>
    <circle cx="16" cy="16" r="3.4" fill="#38bdf8" stroke="#0369a1" stroke-width="0.9"/>
    <circle cx="0" cy="32" r="3.2" fill="#eab308" stroke="#a16207" stroke-width="0.9"/>
  </svg>`;

  const capSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 -11 28 22" width="28" height="22">
    <ellipse cx="0" cy="0" rx="12" ry="8.5" fill="#d97706" stroke="#78350f" stroke-width="1.2"/>
    <text x="0" y="2.8" fill="#1e293b" font-family="monospace" font-weight="800" font-size="7.5" text-anchor="middle">104</text>
  </svg>`;

  const cap1ufSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 -10 30 20" width="30" height="20">
    <rect x="-13" y="-8.5" width="26" height="17" rx="3" fill="#2563eb" stroke="#1e3a8a" stroke-width="1.2"/>
    <text x="0" y="2.8" fill="#f8fafc" font-family="monospace" font-weight="800" font-size="7.2" text-anchor="middle">105</text>
  </svg>`;

  const cap10ufSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 -12 30 24" width="30" height="24">
    <circle cx="0" cy="0" r="10.5" fill="#1e3a8a" stroke="#0f172a" stroke-width="1.3"/>
    <path d="M 4.5 -9.5 A 10.5 10.5 0 0 1 4.5 9.5 Z" fill="#cbd5e1" stroke="#0f172a" stroke-width="0.9"/>
    <circle cx="-1.5" cy="0" r="6.2" fill="#1e40af" stroke="#60a5fa" stroke-width="0.7"/>
    <line x1="-5.2" y1="-3.7" x2="2.2" y2="3.7" stroke="rgba(147,197,253,0.45)" stroke-width="0.8"/>
    <line x1="-5.2" y1="3.7" x2="2.2" y2="-3.7" stroke="rgba(147,197,253,0.45)" stroke-width="0.8"/>
    <text x="-6.5" y="-2.5" fill="#fde047" font-family="monospace" font-weight="800" font-size="6.8" text-anchor="middle">+</text>
    <text x="-2" y="3.2" fill="#ffffff" font-family="monospace" font-weight="800" font-size="5.6" text-anchor="middle">10µ</text>
    <text x="7.4" y="2.4" fill="#0f172a" font-family="monospace" font-weight="900" font-size="7.5" text-anchor="middle">−</text>
  </svg>`;

  const inampSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -5 66 58" width="66" height="58">
  <g fill="#cbd5e1" stroke="#475569" stroke-width="0.8">
    <rect x="-2.8" y="-2.8" width="5.6" height="7" rx="1"/>
    <rect x="13.2" y="-2.8" width="5.6" height="7" rx="1"/>
    <rect x="29.2" y="-2.8" width="5.6" height="7" rx="1"/>
    <rect x="45.2" y="-2.8" width="5.6" height="7" rx="1"/>
    <rect x="-2.8" y="43.8" width="5.6" height="7" rx="1"/>
    <rect x="13.2" y="43.8" width="5.6" height="7" rx="1"/>
    <rect x="29.2" y="43.8" width="5.6" height="7" rx="1"/>
    <rect x="45.2" y="43.8" width="5.6" height="7" rx="1"/>
  </g>
  <rect x="-7" y="3" width="62" height="42" rx="2.5" fill="#1e293b" stroke="#0f172a" stroke-width="1.4"/>
  <rect x="-5.5" y="4.5" width="59" height="39" rx="1.5" fill="none" stroke="#334155" stroke-width="0.8"/>
  <path d="M -7 19 A 5 5 0 0 1 -7 29" fill="#0f172a" stroke="#475569" stroke-width="0.9"/>
  <circle cx="-1.5" cy="39.5" r="1.5" fill="#f8fafc"/>
  <g stroke="#fde047" stroke-width="1.05" fill="none">
    <polyline points="0,3 0,15 4,15"/>
    <polyline points="0,45 0,33 4,33"/>
    <line x1="2.5" y1="15" x2="2.5" y2="33" stroke-dasharray="1.8 1.5"/>
  </g>
  <text x="4.5" y="25.5" fill="#fde047" font-family="monospace" font-weight="800" font-size="5.2">Rg</text>
  <line x1="16" y1="3" x2="16" y2="8.5" stroke="#fca5a5" stroke-width="1.2"/>
  <text x="16" y="13.2" fill="#fca5a5" font-family="monospace" font-weight="800" font-size="5" text-anchor="middle">+Vs</text>
  <line x1="48" y1="45" x2="48" y2="39.5" stroke="#93c5fd" stroke-width="1.2"/>
  <text x="45.5" y="38" fill="#93c5fd" font-family="monospace" font-weight="800" font-size="5" text-anchor="middle">-Vs</text>
  <g stroke="#bae6fd" stroke-width="1.05" fill="none" stroke-linejoin="round">
    <polygon points="16,15 16,33 34,24" fill="rgba(56,189,248,0.16)" stroke="#7dd3fc" stroke-width="1.15"/>
    <polyline points="16,45 16,38 11.5,38 11.5,20 16,20"/>
    <polyline points="32,45 32,37 14,37 14,28 16,28"/>
    <polyline points="34,24 36.5,24 36.5,9 32,9 32,3"/>
    <polyline points="48,3 48,29.5 26,29.5 26,28"/>
  </g>
  <text x="19.3" y="21.5" fill="#fca5a5" font-family="monospace" font-weight="800" font-size="6" text-anchor="middle">−</text>
  <text x="19.3" y="29.8" fill="#86efac" font-family="monospace" font-weight="800" font-size="5.8" text-anchor="middle">+</text>
  <text x="31" y="13.5" fill="#bae6fd" font-family="monospace" font-weight="800" font-size="4.6" text-anchor="middle">OUT</text>
  <text x="44.2" y="13.5" fill="#c4b5fd" font-family="monospace" font-weight="800" font-size="4.6" text-anchor="middle">REF</text>
  <text x="41.5" y="24.5" fill="#94a3b8" font-family="monospace" font-weight="800" font-size="4.6" text-anchor="middle">AD620</text>
</svg>`;

  const diodeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-18 -8 36 16" width="36" height="16">
  <rect x="-16" y="-5.6" width="32" height="11.2" rx="2.2" fill="#1e293b" stroke="#0f172a" stroke-width="1.2"/>
  <line x1="-14" y1="-3.4" x2="14" y2="-3.4" stroke="rgba(255,255,255,0.22)" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="8.5" y="-5.6" width="4.5" height="11.2" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.6"/>
  <polygon points="-5,-3.2 -5,3.2 2.5,0" fill="#f8fafc"/>
  <line x1="2.8" y1="-3.4" x2="2.8" y2="3.4" stroke="#f8fafc" stroke-width="1.4" stroke-linecap="round"/>
  <line x1="-10" y1="0" x2="5.5" y2="0" stroke="#f8fafc" stroke-width="1.1"/>
</svg>`;

  const ledSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 -12 30 24" width="30" height="24">
  <path d="M 9.5 -7.5 A 11.5 11.5 0 1 0 9.5 7.5 Z" fill="#ef4444" stroke="#991b1b" stroke-width="1.3"/>
  <circle cx="-0.5" cy="0" r="8.2" fill="#f87171" stroke="#dc2626" stroke-width="0.9"/>
  <ellipse cx="-3.2" cy="-3.2" rx="3.4" ry="2.1" transform="rotate(-25 -3.2 -3.2)" fill="rgba(255,255,255,0.55)"/>
  <text x="-5.2" y="2.4" fill="#ffffff" font-family="monospace" font-weight="800" font-size="7.5" text-anchor="middle">+</text>
  <text x="4.5" y="2.4" fill="#fee2e2" font-family="monospace" font-weight="800" font-size="7.5" text-anchor="middle">−</text>
</svg>`;

  const photoresistorSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 -11 30 22" width="30" height="22">
  <rect x="-12.5" y="-8.5" width="25" height="17" rx="8.5" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
  <path d="M -8 -6.2 A 6.5 6.5 0 0 0 -8 6.2" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M 8 -6.2 A 6.5 6.5 0 0 1 8 6.2" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M -6.5 -4.5 H 5.5 C 7 -4.5 7 -2.2 5.5 -2.2 H -5.5 C -7 -2.2 -7 0 -5.5 0 H 5.5 C 7 0 7 2.2 5.5 2.2 H -5.5 C -7 2.2 -7 4.5 -5.5 4.5 H 6.5"
        fill="none" stroke="#dc2626" stroke-width="1.25" stroke-linecap="round"/>
  <ellipse cx="-3" cy="-4.5" rx="5" ry="1.8" fill="rgba(255,255,255,0.45)"/>
</svg>`;

  const pushbuttonSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 48 64" width="48" height="64">
  <g fill="#cbd5e1" stroke="#475569" stroke-width="0.9">
    <rect x="-3" y="-3.8" width="6" height="8" rx="1.2"/>
    <rect x="29" y="-3.8" width="6" height="8" rx="1.2"/>
    <rect x="-3" y="43.8" width="6" height="8" rx="1.2"/>
    <rect x="29" y="43.8" width="6" height="8" rx="1.2"/>
  </g>
  <rect x="-5" y="3" width="42" height="42" rx="4" fill="#1e293b" stroke="#0f172a" stroke-width="1.5"/>
  <rect x="-2.5" y="5.5" width="37" height="37" rx="3" fill="#cbd5e1" stroke="#64748b" stroke-width="1"/>
  <circle cx="2" cy="10" r="1.8" fill="#334155"/>
  <circle cx="30" cy="10" r="1.8" fill="#334155"/>
  <circle cx="2" cy="38" r="1.8" fill="#334155"/>
  <circle cx="30" cy="38" r="1.8" fill="#334155"/>
  <g stroke="#0f172a" stroke-width="1.4" fill="none" opacity="0.72">
    <line x1="0" y1="5.5" x2="0" y2="42.5"/>
    <line x1="32" y1="5.5" x2="32" y2="42.5"/>
    <line x1="0" y1="24" x2="5" y2="24"/>
    <line x1="27" y1="24" x2="32" y2="24"/>
  </g>
  <circle cx="16" cy="24" r="11.5" fill="#0f172a" stroke="#334155" stroke-width="1.2"/>
  <circle cx="16" cy="24" r="8.8" fill="#1e293b" stroke="#475569" stroke-width="0.9"/>
  <line x1="8" y1="24" x2="12" y2="24" stroke="#94a3b8" stroke-width="1.3" stroke-linecap="round"/>
  <line x1="20" y1="24" x2="24" y2="24" stroke="#94a3b8" stroke-width="1.3" stroke-linecap="round"/>
  <circle cx="12" cy="24" r="1.2" fill="#e2e8f0"/>
  <circle cx="20" cy="24" r="1.2" fill="#e2e8f0"/>
  <line x1="12" y1="24" x2="19.5" y2="19.8" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

  const resistor1Defs = [
    { id: 'resistor-100-1pct', name: '100 Ω Resistor (1%)', shortLabel: '100 Ω (1%)', value: 100, bands: ['Brown', 'Black', 'Black', 'Black', 'Brown'], colors: ['#8B4513', '#111827', '#111827', '#111827'] },
    { id: 'resistor-220-1pct', name: '220 Ω Resistor (1%)', shortLabel: '220 Ω (1%)', value: 220, bands: ['Red', 'Red', 'Black', 'Black', 'Brown'], colors: ['#DC2626', '#DC2626', '#111827', '#111827'] },
    { id: 'resistor-330-1pct', name: '330 Ω Resistor (1%)', shortLabel: '330 Ω (1%)', value: 330, bands: ['Orange', 'Orange', 'Black', 'Black', 'Brown'], colors: ['#F97316', '#F97316', '#111827', '#111827'] },
    { id: 'resistor-1k-1pct', name: '1 kΩ Resistor (1%)', shortLabel: '1 kΩ (1%)', value: 1000, bands: ['Brown', 'Black', 'Black', 'Brown', 'Brown'], colors: ['#8B4513', '#111827', '#111827', '#8B4513'] },
    { id: 'resistor-2k-1pct', name: '2 kΩ Resistor (1%)', shortLabel: '2 kΩ (1%)', value: 2000, bands: ['Red', 'Black', 'Black', 'Brown', 'Brown'], colors: ['#DC2626', '#111827', '#111827', '#8B4513'] },
    { id: 'resistor-5.1k-1pct', name: '5.1 kΩ Resistor (1%)', shortLabel: '5.1 kΩ (1%)', value: 5100, bands: ['Green', 'Brown', 'Black', 'Brown', 'Brown'], colors: ['#16A34A', '#8B4513', '#111827', '#8B4513'] },
    { id: 'resistor-10k-1pct', name: '10 kΩ Resistor (1%)', shortLabel: '10 kΩ (1%)', value: 10000, bands: ['Brown', 'Black', 'Black', 'Red', 'Brown'], colors: ['#8B4513', '#111827', '#111827', '#DC2626'] },
    { id: 'resistor-100k-1pct', name: '100 kΩ Resistor (1%)', shortLabel: '100 kΩ (1%)', value: 100000, bands: ['Brown', 'Black', 'Black', 'Orange', 'Brown'], colors: ['#8B4513', '#111827', '#111827', '#F97316'] },
    { id: 'resistor-1m-1pct', name: '1 MΩ Resistor (1%)', shortLabel: '1 MΩ (1%)', value: 1000000, bands: ['Brown', 'Black', 'Black', 'Yellow', 'Brown'], colors: ['#8B4513', '#111827', '#111827', '#EAB308'] }
  ];

  return [
    {
      id: 'arduino-nano',
      name: 'Arduino Nano',
      category: 'Microcontrollers',
      description: 'Compact ATmega328P microcontroller board (USB on left, ICSP on right).',
      placement: 'footprint',
      defaultPosition: { col: 2, row: 'd' },
      widthPitches: 15,
      heightPitches: 6,
      bodyOffset: { x: -14, y: -10, width: 252, height: 116 },
      internalNets: [['GND_TOP', 'GND_BOT'], ['RST_TOP', 'RST_BOT']],
      pins: nanoPins,
      svgRaw: nanoSvg
    },
    {
      id: 'opamp-dual-dip8',
      name: 'Dual Op-Amp (DIP-8)',
      shortLabel: 'Dual Op-Amp',
      category: 'Integrated Circuits',
      description: 'Standard 8-pin DIP dual op-amp with top-surface internal pinout diagram.',
      placement: 'footprint',
      defaultPosition: { col: 20, row: 'e' },
      widthPitches: 4,
      heightPitches: 3,
      bodyOffset: { x: -9, y: -5, width: 66, height: 58 },
      pins: [
        { id: 'VCC', label: '8: VCC+ (Supply In)', dx: 0, dy: 0, role: 'power_in' },
        { id: 'OUT2', label: '7: OUT2', dx: 1, dy: 0, role: 'signal' },
        { id: 'IN2-', label: '6: IN2-', dx: 2, dy: 0, role: 'analog' },
        { id: 'IN2+', label: '5: IN2+', dx: 3, dy: 0, role: 'analog' },
        { id: 'OUT1', label: '1: OUT1', dx: 0, dy: 3, role: 'signal' },
        { id: 'IN1-', label: '2: IN1-', dx: 1, dy: 3, role: 'analog' },
        { id: 'IN1+', label: '3: IN1+', dx: 2, dy: 3, role: 'analog' },
        { id: 'GND', label: '4: VCC- / GND', dx: 3, dy: 3, role: 'power_in' }
      ],
      svgRaw: opampSvg
    },
    {
      id: 'inamp-ad620',
      name: 'Instrumentation Amp (AD620)',
      shortLabel: 'AD620 In-Amp',
      category: 'Integrated Circuits',
      description: 'Precision 8-pin DIP instrumentation amplifier (AD620 / INA128 pinout) with top-surface internal schematic diagram.',
      placement: 'footprint',
      defaultPosition: { col: 28, row: 'e' },
      widthPitches: 4,
      heightPitches: 3,
      bodyOffset: { x: -9, y: -5, width: 66, height: 58 },
      pins: [
        { id: 'RG2', label: '8: RG (Gain 2)', dx: 0, dy: 0, role: 'passive' },
        { id: 'VS+', label: '7: +Vs (Pos Supply In)', dx: 1, dy: 0, role: 'power_in' },
        { id: 'OUT', label: '6: OUTPUT', dx: 2, dy: 0, role: 'signal' },
        { id: 'REF', label: '5: REF (Reference)', dx: 3, dy: 0, role: 'analog' },
        { id: 'RG1', label: '1: RG (Gain 1)', dx: 0, dy: 3, role: 'passive' },
        { id: 'IN-', label: '2: -IN (Inverting In)', dx: 1, dy: 3, role: 'analog' },
        { id: 'IN+', label: '3: +IN (Non-Inverting In)', dx: 2, dy: 3, role: 'analog' },
        { id: 'VS-', label: '4: -Vs (Neg Supply In)', dx: 3, dy: 3, role: 'power_in' }
      ],
      svgRaw: inampSvg
    },
    {
      id: 'pot-side-turn',
      name: 'Potentiometer (Side-Turn)',
      shortLabel: 'Pot (Side-Turn)',
      category: 'Potentiometers & Switches',
      description: 'Larger side-adjust potentiometer (2-hole pitch between pins, 5 holes total).',
      placement: 'footprint',
      defaultPosition: { col: 30, row: 'e' },
      widthPitches: 5,
      heightPitches: 1,
      bodyOffset: { x: -10, y: -44, width: 84, height: 52 },
      pins: [
        { id: 'P1', label: 'Pin 1 (CW)', dx: 0, dy: 0, role: 'passive' },
        { id: 'WIPER', label: 'Pin 2 (Wiper)', dx: 2, dy: 0, role: 'passive' },
        { id: 'P3', label: 'Pin 3 (CCW)', dx: 4, dy: 0, role: 'passive' }
      ],
      svgRaw: potSideSvg
    },
    {
      id: 'pot-top-turn',
      name: 'Trimmer Pot (Top-Turn)',
      shortLabel: 'Trimpot (Top)',
      category: 'Potentiometers & Switches',
      description: 'Compact top-adjust trimmer pot (1-hole pitch triangle across 3 rows & 2 columns).',
      placement: 'footprint',
      defaultPosition: { col: 28, row: 'e' },
      widthPitches: 2,
      heightPitches: 3,
      bodyOffset: { x: -9, y: -7, width: 34, height: 46 },
      pins: [
        { id: 'P1', label: 'Pin 1 (End)', dx: 0, dy: 0, role: 'passive' },
        { id: 'WIPER', label: 'Pin 2 (Wiper)', dx: 1, dy: 1, role: 'passive' },
        { id: 'P3', label: 'Pin 3 (End)', dx: 0, dy: 2, role: 'passive' }
      ],
      svgRaw: potTopSvg
    },
    {
      id: 'pushbutton-4pin',
      name: 'Push Button (4-Pin)',
      shortLabel: 'Push Button',
      category: 'Potentiometers & Switches',
      description: '4-legged tactile push button straddling the center trough (1 empty row gap between left and right leg pairs). Left upper/lower legs are connected, right upper/lower legs are connected.',
      placement: 'footprint',
      defaultPosition: { col: 34, row: 'e' },
      widthPitches: 3,
      heightPitches: 4,
      bodyOffset: { x: -8, y: -8, width: 48, height: 64 },
      internalNets: [['P1', 'P3'], ['P2', 'P4']],
      pins: [
        { id: 'P1', label: '1: Left-Upper (Pair A)', dx: 0, dy: 0, role: 'passive' },
        { id: 'P2', label: '2: Right-Upper (Pair B)', dx: 2, dy: 0, role: 'passive' },
        { id: 'P3', label: '3: Left-Lower (Pair A)', dx: 0, dy: 3, role: 'passive' },
        { id: 'P4', label: '4: Right-Lower (Pair B)', dx: 2, dy: 3, role: 'passive' }
      ],
      svgRaw: pushbuttonSvg
    },
    {
      id: 'diode-1n4007',
      name: 'Diode',
      shortLabel: 'Diode',
      category: 'Diodes & Optoelectronics',
      description: 'Standard 1N4007 silicon rectifier diode. Current flows from Anode (+) to Cathode (-, silver band).',
      placement: 'two-lead',
      polarized: true,
      defaultSpan: 4,
      bodyWidth: 36,
      bodyHeight: 16,
      leadAttachOffset: 16,
      pins: [{ id: 'P1', label: 'Anode (+)' }, { id: 'P2', label: 'Cathode (-)' }],
      svgRaw: diodeSvg
    },
    {
      id: 'led-red',
      name: 'LED',
      shortLabel: 'LED',
      category: 'Diodes & Optoelectronics',
      description: 'Standard 5mm light-emitting diode. Current flows from Anode (+) to Cathode (-, flat edge).',
      placement: 'two-lead',
      polarized: true,
      defaultSpan: 3,
      bodyWidth: 30,
      bodyHeight: 24,
      leadAttachOffset: 11,
      pins: [{ id: 'P1', label: 'Anode (+)' }, { id: 'P2', label: 'Cathode (-)' }],
      svgRaw: ledSvg
    },
    {
      id: 'photoresistor',
      name: 'Photoresistor',
      shortLabel: 'Photoresistor',
      category: 'Diodes & Optoelectronics',
      description: 'Cadmium-sulfide (CdS) light-dependent resistor (LDR).',
      placement: 'two-lead',
      defaultSpan: 3,
      bodyWidth: 30,
      bodyHeight: 22,
      leadAttachOffset: 12,
      pins: [{ id: 'P1', label: 'Lead 1' }, { id: 'P2', label: 'Lead 2' }],
      svgRaw: photoresistorSvg
    },
    {
      id: 'cap-100nf',
      name: '100nF Capacitor',
      shortLabel: '100nF (104)',
      category: 'Capacitors',
      value: 1e-7,
      unit: 'F',
      marking: '104',
      description: '100nF (0.1µF) ceramic disc capacitor (marking 104). Combine resistors in series/parallel to hit target RC cutoff frequencies.',
      placement: 'two-lead',
      defaultSpan: 3,
      bodyWidth: 28,
      bodyHeight: 22,
      leadAttachOffset: 11,
      pins: [{ id: 'P1', label: 'Lead 1' }, { id: 'P2', label: 'Lead 2' }],
      svgRaw: capSvg
    },
    {
      id: 'cap-1uf',
      name: '1µF Film Capacitor',
      shortLabel: '1µF (105)',
      category: 'Capacitors',
      value: 1e-6,
      unit: 'F',
      marking: '105',
      description: '1µF (105) non-polarized film capacitor for bioelectrical AC-coupling / high-pass filtering (e.g. 1µF + 10kΩ = 15.9 Hz).',
      placement: 'two-lead',
      defaultSpan: 3,
      bodyWidth: 30,
      bodyHeight: 20,
      leadAttachOffset: 12,
      pins: [{ id: 'P1', label: 'Lead 1' }, { id: 'P2', label: 'Lead 2' }],
      svgRaw: cap1ufSvg
    },
    {
      id: 'cap-10uf',
      name: '10µF Electrolytic Cap',
      shortLabel: '10µF (+ / -)',
      category: 'Capacitors',
      value: 1e-5,
      unit: 'F',
      marking: '10µF',
      description: '10µF polarized radial electrolytic capacitor for DC power rail decoupling (Not recommended for bipolar AC signals due to polarity: + Anode, − silver stripe Cathode).',
      placement: 'two-lead',
      polarized: true,
      defaultSpan: 3,
      bodyWidth: 30,
      bodyHeight: 24,
      leadAttachOffset: 11,
      pins: [{ id: 'P1', label: 'Anode (+)' }, { id: 'P2', label: 'Cathode (-)' }],
      svgRaw: cap10ufSvg
    },
    ...resistor1Defs.map((r) => ({
      id: r.id,
      name: r.name,
      shortLabel: r.shortLabel,
      category: 'Resistors (1% Metal Film)',
      value: r.value,
      unit: 'Ω',
      bands: r.bands,
      description: `${r.shortLabel} 1/4W metal film resistor (±1%, ${r.bands.join('-')}).`,
      placement: 'two-lead',
      defaultSpan: 4,
      bodyWidth: 38,
      bodyHeight: 16,
      leadAttachOffset: 17,
      pins: [{ id: 'P1', label: 'Lead 1' }, { id: 'P2', label: 'Lead 2' }],
      svgRaw: makeResistor1PctSvg(r.colors[0], r.colors[1], r.colors[2], r.colors[3])
    }))
  ];
}
