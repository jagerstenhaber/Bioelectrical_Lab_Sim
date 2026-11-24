import { validateAndParseLabJson, serializeLabTemplate } from './sim/labEvaluator.js';

/**
 * Offline fallback catalog mirroring ./labs/manifest.json and ./labs/*.json
 * so demo labs load seamlessly even when index.html is opened over file://.
 */
export const OFFLINE_DEMO_LAB_MANIFEST = Object.freeze([
  {
    id: 'lab1-dc-divider',
    file: 'lab1-dc-divider.json',
    title: 'Lab 1: Intro DC Circuits & Voltage Divider',
    course: 'Bioinstrumentation I',
    summary: 'Build a current-limited LED indicator and a 2.5 V resistive divider, then verify with the DMM.',
    kitBadge: '5 parts · DMM only'
  },
  {
    id: 'lab2-rc-filter-bode',
    file: 'lab2-rc-filter-bode.json',
    title: 'Lab 2: Analog RC Low-Pass Filter & Bode Plot',
    course: 'Bioinstrumentation I',
    summary: 'Build a 1.59 kHz RC low-pass filter on NI ELVIS II and measure its cutoff on Bode & Scope.',
    kitBadge: '5 parts · FGEN / Scope / Bode'
  },
  {
    id: 'lab3-optical-ppg',
    file: 'lab3-optical-ppg.json',
    title: 'Lab 3: Optical Finger PPG (LED + Photoresistor)',
    course: 'Bioelectrical Signals',
    summary: 'Pair a lit Red LED with a photoresistor in Finger PPG mode and plot the pulse on Arduino Nano.',
    kitBadge: '5 parts · Nano / DMM / Scope'
  },
  {
    id: 'lab4-isolated-emg-fir',
    file: 'lab4-isolated-emg-fir.json',
    title: 'Lab 4: Safe Isolated Surface EMG (IEC 60601 + FIR)',
    course: 'Biomedical Instrumentation',
    summary: 'Build a single-supply AD620 EMG front end with ADuM3160 USB isolation, HPF DC blocking, and FIR DSP.',
    kitBadge: '5 parts · EMG + ADuM3160 · Nano'
  }
]);

export const OFFLINE_DEMO_LABS = Object.freeze({
  'lab1-dc-divider': {
    schemaVersion: 1,
    id: 'lab1-dc-divider',
    title: 'Lab 1: Intro DC Circuits & Voltage Divider',
    course: 'Bioinstrumentation I',
    author: 'Bioelectrical Lab Sim Demo',
    description:
      'Introduction to breadboard wiring, current-limiting resistors, resistive voltage dividers, and Virtual DMM measurements. Only essential introductory parts and the DMM are shown.',
    initialBoard: {
      elvisMode: false,
      loadCellsMode: false,
      emgMode: false,
      pulseOxMode: false,
      usbIsolatorEnabled: false,
      clearBoard: true,
      defaultInstrument: 'dmm'
    },
    filters: {
      allowedParts: [
        'arduino-nano',
        'led-red',
        'resistor-330-1pct',
        'resistor-10k-1pct',
        'pot-side-turn'
      ],
      allowedSensors: [],
      allowedInstruments: ['dmm']
    },
    steps: [
      {
        id: 'step-power',
        title: 'Place Arduino Nano as +5 V Power Source',
        instruction:
          'Switch to the Parts tab and place an Arduino Nano onto the breadboard. Verify Lab Power is ON so you have regulated +5 V and GND rails.',
        hint: "Drag or click the Arduino Nano in the Parts tab. You do not need to write any code for this DC lab—just wire from the Nano's 5V and GND pins to your power rails.",
        checks: [
          { id: 'c-pwr', type: 'power-on', label: 'Lab Power is ON' },
          { id: 'c-nano', type: 'part-placed', partId: 'arduino-nano', label: 'Arduino Nano placed on breadboard' }
        ]
      },
      {
        id: 'step-led',
        title: 'Build a Current-Limited LED Indicator',
        instruction:
          'Place a Red LED and a 330 Ω resistor in series between +5 V and GND so the LED lights safely without overcurrent.',
        hint: 'Connect +5 V -> 330 Ω resistor -> Red LED Anode (+, longer lead), and connect the LED Cathode (−, flat edge) to GND. Press [R] to flip the LED if it is reverse-biased.',
        checks: [
          { id: 'c-res330', type: 'part-placed', partId: 'resistor-330-1pct', label: '330 Ω current-limiting resistor placed' },
          { id: 'c-led', type: 'led-lit', minBrightness: 0.25, label: 'Red LED conducting safely (no overcurrent)' },
          { id: 'c-clean1', type: 'no-warnings', label: 'Zero shorts or wiring warnings' }
        ]
      },
      {
        id: 'step-divider',
        title: 'Build a 2.5 V Voltage Divider',
        instruction:
          'Place two 10 kΩ resistors in series between +5 V and GND so their shared midpoint strip sits at half the supply voltage (+2.50 V).',
        hint: 'Wire +5 V to one lead of the first 10 kΩ resistor, connect the second 10 kΩ resistor from that shared midpoint column to GND, and ensure zero wiring warnings.',
        checks: [
          { id: 'c-r10k', type: 'part-placed', partId: 'resistor-10k-1pct', minCount: 2, label: 'Two 10 kΩ resistors placed' },
          { id: 'c-wires', type: 'wire-count', min: 3, label: 'Power, ground, and divider jumpers wired' },
          { id: 'c-clean2', type: 'no-warnings', label: 'Zero shorts or wiring warnings' }
        ]
      },
      {
        id: 'step-dmm',
        title: 'Measure Midpoint Voltage with the DMM',
        instruction:
          'Open the DMM (right rail), select DC V, connect COM (−) to GND, and probe the midpoint between your two 10 kΩ resistors with Red (+) to verify ~2.50 V.',
        hint: 'Click COM → GND on the DMM panel, then click Red (+) and click any hole on the strip shared by your two 10 kΩ resistors.',
        checks: [
          { id: 'c-dmm-open', type: 'instrument-open', instrumentId: 'dmm', label: 'Virtual DMM is open' },
          { id: 'c-dmm-val', type: 'dmm-reading', mode: 'VDC', min: 2.35, max: 2.65, label: 'DMM measures 2.50 V (±0.15 V)' }
        ]
      }
    ]
  },

  'lab2-rc-filter-bode': {
    schemaVersion: 1,
    id: 'lab2-rc-filter-bode',
    title: 'Lab 2: Analog RC Low-Pass Filter & Bode Plot',
    course: 'Bioinstrumentation I',
    author: 'Bioelectrical Lab Sim Demo',
    description:
      'Design and characterize a first-order RC low-pass filter (fc ≈ 1.59 kHz) on the NI ELVIS II prototyping board using the Function Generator, Oscilloscope, and Bode Analyzer.',
    initialBoard: {
      elvisMode: true,
      loadCellsMode: false,
      emgMode: false,
      pulseOxMode: false,
      usbIsolatorEnabled: false,
      clearBoard: true,
      defaultInstrument: 'bode'
    },
    filters: {
      allowedParts: [
        'resistor-1k-1pct',
        'resistor-10k-1pct',
        'resistor-100k-1pct',
        'cap-100nf',
        'cap-1uf'
      ],
      allowedSensors: [],
      allowedInstruments: ['dmm', 'fgen', 'scope', 'bode']
    },
    steps: [
      {
        id: 'step-elvis-rc',
        title: 'Build a 1.59 kHz RC Low-Pass Filter on ELVIS II',
        instruction:
          'With ELVIS II mode ON, wire FGEN (Row 33) through a 1 kΩ resistor to your output node, and connect a 100 nF capacitor from the output node to GROUND (Row 49 or 53). Wire AI 0+ to FGEN, AI 1+ to the filter output, and AI 0− / AI 1− to AIGND.',
        hint: 'Check fc = 1 / (2π × 1 kΩ × 100 nF) = 1.592 kHz using the topbar RC Calc tool!',
        checks: [
          { id: 'c-elvis', type: 'board-mode', elvisMode: true, label: 'NI ELVIS II mode is active' },
          { id: 'c-r1k', type: 'part-placed', partId: 'resistor-1k-1pct', label: '1 kΩ resistor placed' },
          { id: 'c-c100n', type: 'part-placed', partId: 'cap-100nf', label: '100 nF capacitor placed' },
          { id: 'c-clean', type: 'no-warnings', label: 'Zero wiring warnings' }
        ]
      },
      {
        id: 'step-bode',
        title: 'Measure −3 dB Cutoff on the Bode Analyzer',
        instruction:
          'Open the Bode Analyzer (right rail), ensure Stimulus is FGEN and Response is AI 1 (or your output probe), and verify the measured −3 dB cutoff frequency is near 1.59 kHz.',
        hint: 'In Full Bench Bode view you can drag the frequency cursor directly to 1.59 kHz and observe −3.0 dB gain and −45° phase shift.',
        checks: [
          { id: 'c-bode-open', type: 'instrument-open', instrumentId: 'bode', label: 'Bode Analyzer is open' },
          { id: 'c-bode-fc', type: 'bode-cutoff', minHz: 1350, maxHz: 1850, label: 'Measured −3 dB cutoff fc ≈ 1.59 kHz (±250 Hz)' }
        ]
      },
      {
        id: 'step-scope',
        title: 'Verify Time-Domain Attenuation on the Oscilloscope',
        instruction:
          'Open FGEN (set 4 Vpp Sine at 1592 Hz and press Run) and view CH 0 (input) and CH 1 (filtered output) on the Oscilloscope.',
        hint: 'At f = fc, a 4.0 Vpp input attenuates by 0.707× to ~2.83 Vpp with a 45° phase lag.',
        checks: [
          { id: 'c-scope-open', type: 'instrument-open', instrumentId: 'scope', label: 'Oscilloscope is open' },
          { id: 'c-scope-ch1', type: 'scope-signal', channel: 'ch1', minVpp: 2.4, maxVpp: 3.2, label: 'CH 1 filtered output reads ~2.83 Vpp (±0.4 V)' }
        ]
      },
      {
        id: 'step-reflect',
        title: 'Compare 100 nF vs 1 µF Cutoff',
        instruction:
          'Try swapping the 100 nF capacitor for the 1 µF capacitor and observe how the cutoff shifts down by 10× (to ~159 Hz), then check off below.',
        hint: 'Doubling or multiplying C by 10 divides fc by the same factor because fc = 1 / (2πRC).',
        checks: [
          { id: 'c-manual', type: 'manual-check', label: 'I verified the 10× shift in cutoff frequency when changing C' }
        ]
      }
    ]
  },

  'lab3-optical-ppg': {
    schemaVersion: 1,
    id: 'lab3-optical-ppg',
    title: 'Lab 3: Optical Finger PPG (LED + Photoresistor)',
    course: 'Bioelectrical Signals',
    author: 'Bioelectrical Lab Sim Demo',
    description:
      'Build an optical photoplethysmography (PPG) sensor using a powered Red LED and a CdS Photoresistor voltage divider, then stream the arterial pulse to the Arduino Nano Serial Plotter.',
    initialBoard: {
      elvisMode: false,
      loadCellsMode: false,
      emgMode: false,
      pulseOxMode: false,
      usbIsolatorEnabled: false,
      clearBoard: true,
      defaultInstrument: 'arduino'
    },
    filters: {
      allowedParts: [
        'arduino-nano',
        'led-red',
        'photoresistor',
        'resistor-330-1pct',
        'resistor-10k-1pct'
      ],
      allowedSensors: [],
      allowedInstruments: ['dmm', 'scope', 'arduino']
    },
    steps: [
      {
        id: 'step-led-source',
        title: 'Build the Optical Light Source (Red LED)',
        instruction:
          "Place an Arduino Nano, a 330 Ω resistor, and a Red LED powered from the Nano's +5 V and GND pins. Remember: the photoresistor PPG mode will NOT detect a pulse without a lit LED!",
        hint: 'Connect Nano 5V -> 330 Ω -> Red LED Anode (+), and LED Cathode (−) -> Nano GND.',
        checks: [
          { id: 'c-nano', type: 'part-placed', partId: 'arduino-nano', label: 'Arduino Nano placed' },
          { id: 'c-led', type: 'led-lit', minBrightness: 0.25, label: 'Red LED powered & glowing safely' }
        ]
      },
      {
        id: 'step-ldr-divider',
        title: 'Wire the Photoresistor Voltage Divider to A0',
        instruction:
          'Place a Photoresistor (CdS LDR) and a 10 kΩ resistor in a +5 V to GND voltage divider, and connect the midpoint to Arduino Nano pin A0.',
        hint: 'Wire +5 V -> Photoresistor -> midpoint strip -> 10 kΩ -> GND, then run a jumper from the midpoint strip to Nano A0.',
        checks: [
          { id: 'c-ldr', type: 'part-placed', partId: 'photoresistor', label: 'Photoresistor placed' },
          { id: 'c-r10k', type: 'part-placed', partId: 'resistor-10k-1pct', label: '10 kΩ divider resistor placed' },
          { id: 'c-clean', type: 'no-warnings', label: 'Zero wiring warnings' }
        ]
      },
      {
        id: 'step-ppg-mode',
        title: 'Enable LED + Finger PPG Mode',
        instruction:
          'Click the Photoresistor on the breadboard to open its inspector, switch from Manual Light to LED + Finger PPG, and toggle Finger Interposed ON.',
        hint: "You should see a cyan pulse halo appear on the photoresistor and the badge 'LED Linked · Finger PPG' in the inspector.",
        checks: [
          { id: 'c-mode', type: 'part-prop', partId: 'photoresistor', prop: 'lightMode', equals: 'led-ppg', label: 'Photoresistor set to LED + Finger PPG mode' },
          { id: 'c-finger', type: 'part-prop', partId: 'photoresistor', prop: 'fingerPresent', equals: true, label: 'Finger interposed between LED and LDR' }
        ]
      },
      {
        id: 'step-plot',
        title: 'Sample & Plot the PPG Pulse on Arduino Nano',
        instruction:
          'Open the Nano tab, choose or write a sketch that reads analogRead(A0) and prints to Serial, click Upload & Run, and inspect the beating waveform in the Serial Plotter.',
        hint: "Try the built-in 'Optical PPG (LED + Photoresistor)' sketch from the Example Sketches dropdown, then remove the 330 Ω resistor to confirm the PPG flatlines without the LED!",
        checks: [
          { id: 'c-ard-run', type: 'arduino-running', minSerialLines: 5, label: 'Arduino sketch running & streaming Serial data' },
          { id: 'c-manual', type: 'manual-check', label: 'I verified the PPG disappears when the Red LED is turned off' }
        ]
      }
    ]
  },

  'lab4-isolated-emg-fir': {
    schemaVersion: 1,
    id: 'lab4-isolated-emg-fir',
    title: 'Lab 4: Safe Isolated Surface EMG (IEC 60601 + FIR)',
    course: 'Biomedical Instrumentation',
    author: 'Bioelectrical Lab Sim Demo',
    description:
      'Design a patient-safe single-supply AD620 surface EMG front end meeting IEC 60601 isolation goals (ADuM3160 USB isolator + secondary high-pass DC blocking), then apply an FIR digital filter on Arduino Nano.',
    initialBoard: {
      elvisMode: false,
      loadCellsMode: false,
      emgMode: true,
      pulseOxMode: false,
      usbIsolatorEnabled: false,
      clearBoard: true,
      defaultInstrument: 'arduino'
    },
    filters: {
      allowedParts: [
        'arduino-nano',
        'inamp-ad620',
        'cap-1uf',
        'resistor-100-1pct',
        'resistor-10k-1pct'
      ],
      allowedSensors: ['emg', 'adum3160'],
      allowedInstruments: ['dmm', 'scope', 'arduino']
    },
    steps: [
      {
        id: 'step-primary-iso',
        title: 'Mount 3-Pad EMG & Insert ADuM3160 USB Isolator',
        instruction:
          'Place an Arduino Nano on the breadboard (non-ELVIS isolated mode), confirm 3-Pad Surface EMG is mounted in the Sensors tab, and click Insert on the ADuM3160 USB Isolator.',
        hint: "Watch the inline teal ADuM3160 2.5kV ISO module attach to the Nano's USB port, separating the patient acquisition circuit from host PC USB mains ground.",
        checks: [
          { id: 'c-nano', type: 'part-placed', partId: 'arduino-nano', label: 'Arduino Nano placed' },
          { id: 'c-emg-iso', type: 'board-mode', elvisMode: false, emgMode: true, usbIsolatorEnabled: true, label: '3-Pad EMG mounted + ADuM3160 USB Isolator inserted (no ELVIS bridge)' }
        ]
      },
      {
        id: 'step-ad620',
        title: 'Wire Single-Supply AD620 Instrumentation Amplifier',
        instruction:
          'Place the AD620 straddling the center trough with a 100 Ω gain resistor across RG1–RG2 (G ≈ 495). Power +VS from +5 V and −VS from GND, create a +2.5 V virtual ground (two 10 kΩ resistors) for AD620 REF & EMG BLK, and connect EMG RED 1/2 to IN+/IN−.',
        hint: 'Using a +2.5 V virtual ground (10 kΩ / 10 kΩ divider) keeps the single-supply AD620 comfortably inside its common-mode input range.',
        checks: [
          { id: 'c-ad620', type: 'ic-powered', partId: 'inamp-ad620', label: 'AD620 powered cleanly' },
          { id: 'c-rg', type: 'part-placed', partId: 'resistor-100-1pct', label: '100 Ω gain resistor placed' },
          { id: 'c-clean', type: 'no-warnings', label: 'Zero shorts or wiring warnings' }
        ]
      },
      {
        id: 'step-hpf-iso',
        title: 'Add Secondary High-Pass Isolation & Verify IEC 60601',
        instruction:
          'Place a 1 µF film capacitor in series between the AD620 OUT and Arduino Nano pin A0, biased to +2.5 V using two 10 kΩ resistors (fc ≈ 31.8 Hz). Verify the green IEC 60601 Isolated ✓ badge appears!',
        hint: 'The series 1 µF capacitor blocks single-fault DC offset while passing AC skeletal muscle bursts (~20–250 Hz). Click Inspect on the safety pill to review every IEC 60601 check.',
        checks: [
          { id: 'c-cap', type: 'part-placed', partId: 'cap-1uf', label: '1 µF series high-pass capacitor placed' },
          { id: 'c-iso-safe', type: 'isolation-level', level: 'safe', maxHpfHz: 60, label: 'Full IEC 60601 Safe Isolation achieved (fc ≤ 60 Hz)' }
        ]
      },
      {
        id: 'step-fir',
        title: 'Filter the Isolated EMG Stream with #include <FIR.h>',
        instruction:
          'Open the Nano tab, load or write a sketch using #include <FIR.h> to read A0 and smooth the EMG bursts, click Upload & Run, and observe Raw vs Filtered EMG in the Serial Plotter.',
        hint: "Try the built-in 'FIR Filter: 3-Pad EMG Low-Pass' example sketch and adjust EMG Flex & 60 Hz Hum in the Bench Stimulus bar.",
        checks: [
          { id: 'c-ard-fir', type: 'arduino-running', requireLibrary: 'FIR.h', minSerialLines: 5, label: 'Arduino sketch running with #include <FIR.h>' }
        ]
      }
    ]
  }
});

/**
 * Loads the downloadable demo lab manifest from ./labs/manifest.json with an
 * offline fallback for file:// usage.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadDemoLabManifest() {
  if (typeof fetch === 'function' && typeof window !== 'undefined' && window.location?.protocol !== 'file:') {
    try {
      const resp = await fetch('./labs/manifest.json', { cache: 'no-cache' });
      if (resp.ok) {
        const json = await resp.json();
        if (Array.isArray(json?.labs) && json.labs.length > 0) {
          return json.labs;
        }
      }
    } catch {
      // Fall back to embedded offline manifest below
    }
  }
  return OFFLINE_DEMO_LAB_MANIFEST.map((item) => ({ ...item }));
}

/**
 * Loads a built-in demo lab by ID (fetching ./labs/<file> over HTTP when available,
 * falling back cleanly to OFFLINE_DEMO_LABS for file:// or offline usage).
 *
 * @param {string} labId
 * @param {Array<object>} [manifest]
 * @returns {Promise<{ ok: true, lab: object } | { ok: false, error: string }>}
 */
export async function loadDemoLabById(labId, manifest = OFFLINE_DEMO_LAB_MANIFEST) {
  const entry = (manifest || OFFLINE_DEMO_LAB_MANIFEST).find((m) => m.id === labId);
  const fileName = entry?.file || `${labId}.json`;

  if (typeof fetch === 'function' && typeof window !== 'undefined' && window.location?.protocol !== 'file:') {
    try {
      const resp = await fetch(`./labs/${fileName}`, { cache: 'no-cache' });
      if (resp.ok) {
        const text = await resp.text();
        const parsed = validateAndParseLabJson(text);
        if (parsed.ok) return parsed;
      }
    } catch {
      // Fall through to embedded offline copy
    }
  }

  const fallback = OFFLINE_DEMO_LABS[labId];
  if (fallback) {
    return validateAndParseLabJson(JSON.parse(JSON.stringify(fallback)));
  }

  return { ok: false, error: `Demo lab "${labId}" was not found.` };
}

/**
 * Safely validates a ?lab= URL parameter so only relative paths or same-origin
 * http(s) URLs are fetched (blocking javascript:, data:, and cross-origin URLs).
 *
 * @param {string} rawUrl
 * @param {string} [baseHref]
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function resolveSafeLabUrl(rawUrl, baseHref = typeof window !== 'undefined' ? window.location.href : 'http://localhost/') {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'Empty lab URL.' };
  }
  const trimmed = rawUrl.trim();
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    return { ok: false, error: 'Unsupported URL scheme for lab file.' };
  }
  try {
    const base = new URL(baseHref);
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return { ok: false, error: 'Only http(s) or relative lab URLs are supported.' };
    }
    if (resolved.origin !== base.origin) {
      return {
        ok: false,
        error: 'External cross-origin lab URLs are blocked. Download the .json file and load it directly in the Lab tab.'
      };
    }
    return { ok: true, url: resolved.href };
  } catch {
    return { ok: false, error: 'Invalid lab URL format.' };
  }
}

/**
 * Reads the ?lab=... query parameter from window.location.search (or a custom search string).
 *
 * @param {string} [search]
 * @returns {string|null}
 */
export function getLabParamFromSearch(search = typeof window !== 'undefined' ? window.location.search : '') {
  if (!search || typeof search !== 'string') return null;
  try {
    const params = new URLSearchParams(search);
    const val = params.get('lab');
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Fetches and validates a lab JSON file from a safe same-origin URL (e.g., ?lab=./labs/lab1-dc-divider.json).
 *
 * @param {string} rawUrl
 * @returns {Promise<{ ok: true, lab: object } | { ok: false, error: string }>}
 */
export async function loadLabFromUrl(rawUrl) {
  const safe = resolveSafeLabUrl(rawUrl);
  if (!safe.ok) return safe;

  if (typeof fetch !== 'function') {
    return { ok: false, error: 'Fetch API is not available in this environment.' };
  }

  try {
    const resp = await fetch(safe.url, { cache: 'no-cache' });
    if (!resp.ok) {
      return { ok: false, error: `Could not load lab file (HTTP ${resp.status}).` };
    }
    const text = await resp.text();
    return validateAndParseLabJson(text);
  } catch (err) {
    return { ok: false, error: `Failed to fetch lab file: ${err?.message || 'network error'}` };
  }
}

/**
 * Triggers a clean browser download of a lab object as a formatted .json file.
 *
 * @param {object} lab
 * @param {string} [filename]
 */
export function downloadLabJsonFile(lab, filename = null) {
  if (!lab || typeof document === 'undefined') return;
  const safeId = String(lab.id || 'custom-lab').replace(/[^a-zA-Z0-9_-]+/g, '-');
  const outName = filename || `${safeId}.json`;
  const jsonText = serializeLabTemplate(lab);
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
