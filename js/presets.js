import { createStarterCircuit } from './persistence.js';

/**
 * Built-in Lab Presets for Bioelectrical Lab Sim.
 * Pure ES module (zero DOM dependencies) for browser & Node testing.
 */

export const LAB_PRESETS = [
  {
    id: 'starter',
    name: 'Starter: Arduino + Op-Amp',
    description: 'Arduino Nano powering a Dual Op-Amp (DIP-8) with decoupling capacitor and feedback resistors.'
  },
  {
    id: 'led-demo',
    name: 'LED + 330 Ω Resistor Demo',
    description: 'Arduino Nano 5V supply driving a red LED through a 330 Ω current-limiting resistor (~9.1 mA).'
  },
  {
    id: 'pot-divider',
    name: 'Potentiometer Voltage Divider',
    description: '10 kΩ side-turn potentiometer across 5V and GND; adjust wiper to sweep 0–5 V on the DMM.'
  },
  {
    id: 'loadcell-ad620',
    name: 'ELVIS II: Load Cell + AD620',
    description: 'Full-bridge load cell excited at +5V and amplified by an AD620 (Rg = 100 Ω, G = 495) on ±15V.'
  },
  {
    id: 'rc-lowpass',
    name: 'ELVIS II: RC Low-Pass Filter (1.59 kHz)',
    description: '1 kΩ + 100 nF RC low-pass filter driven by FGEN at fc = 1592 Hz (-3 dB attenuation on Scope AI0/AI1).'
  },
  {
    id: 'opamp-ac-amp',
    name: 'ELVIS II: Inverting Op-Amp (G = -10)',
    description: 'Dual Op-Amp on ±15V with 1 kΩ input & 10 kΩ feedback resistors amplifying 200 Hz 1.5 Vpp FGEN sine by -10×.'
  },
  {
    id: 'emg-ad620',
    name: 'ELVIS II: 3-Pad EMG + AD620',
    description: '3-pad surface EMG amplified by an AD620 (Rg = 100 Ω, G = 495) on ±15V; compare clean EMG (CH0) vs raw 60 Hz hum (CH1).'
  },
  {
    id: 'arduino-button-led',
    name: 'Arduino: Button (INPUT_PULLUP) + LED',
    description: 'Arduino Nano reads a pushbutton on D2 (INPUT_PULLUP) and drives an LED on D9 through a 330 Ω resistor.'
  },
  {
    id: 'arduino-pot-pwm',
    name: 'Arduino: Pot → PWM LED & Plotter',
    description: '10 kΩ potentiometer wiper into Arduino A0 controls 490 Hz PWM brightness on D9 while streaming ADC & PWM to Serial Plotter.'
  },
  {
    id: 'arduino-emg-fir',
    name: 'ELVIS II: EMG → Arduino FIR',
    description: '3-pad EMG amplified by AD620 (G = 495, biased to +2.50 V via SUPPLY +) into Arduino A0 running an 8-tap #include <FIR.h> low-pass filter.'
  },
  {
    id: 'ppg-ldr',
    name: 'LED + Photoresistor Finger PPG',
    description: 'Red LED illuminates a finger optical path onto a CdS photoresistor 10 kΩ divider sampled on Arduino Nano A0 & Serial Plotter.'
  },
  {
    id: 'pulseox-tia',
    name: 'ELVIS II: True Dual-LED Pulse-Ox + TIA',
    description: '660 nm Red + 940 nm IR finger-clip Pulse-Ox sensor driving a Dual Op-Amp Transimpedance Amplifier (Rf = 100 kΩ) into Scope AI0.'
  }
];

function createDefaultGenerator() {
  let seq = 1;
  return (prefix = 'item') => `${prefix}_${seq++}`;
}

/**
 * Builds a complete, verified preset circuit configuration.
 *
 * @param {string} presetId
 * @param {object} [options]
 * @param {boolean} [options.elvisMode=false]
 * @param {(prefix?: string) => string} [options.generateId]
 * @returns {{
 *   boardConfig: { elvisMode: boolean, loadCellsMode: boolean, emgMode: boolean, sensorPosition: string },
 *   placedParts: Array<object>,
 *   wires: Array<object>,
 *   simConfig: object,
 *   defaultDmm: { open: boolean, mode: 'VDC'|'VAC'|'OHM'|'CONT', probeRed: string|null, probeBlack: string|null },
 *   defaultScope?: object
 * }}
 */
export function buildPresetCircuit(presetId, { elvisMode = false, generateId } = {}) {
  const genId = typeof generateId === 'function' ? generateId : createDefaultGenerator();

  switch (presetId) {
    case 'starter': {
      const { placedParts, wires } = createStarterCircuit(Boolean(elvisMode), genId);
      return {
        boardConfig: {
          elvisMode: Boolean(elvisMode),
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0
        },
        defaultDmm: {
          open: false,
          mode: 'VDC',
          probeRed: null,
          probeBlack: null
        }
      };
    }

    case 'led-demo': {
      // Arduino Nano at d2 (rot 0): 5V is at h13 (TERM_BOT_13), GND_BOT is at h15 (TERM_BOT_15)
      // Bottom rails: BP13 -> f21 -> resistor-330-1pct (g21 -> g25) -> led-red (h25 Anode -> h29 Cathode) -> j29 -> BN29
      const placedParts = [
        {
          id: genId('arduino-nano'),
          partId: 'arduino-nano',
          anchorHoleId: 'd2',
          rotation: 0
        },
        {
          id: genId('resistor-330-1pct'),
          partId: 'resistor-330-1pct',
          pinHoles: { P1: 'g21', P2: 'g25' }
        },
        {
          id: genId('led-red'),
          partId: 'led-red',
          pinHoles: { P1: 'h25', P2: 'h29' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'j13', holeB: 'BP13', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'j15', holeB: 'BN15', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'BP21', holeB: 'f21', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'j29', holeB: 'BN29', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: false,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0
        },
        defaultDmm: {
          open: true,
          mode: 'VDC',
          probeRed: 'j25',
          probeBlack: 'BN25'
        }
      };
    }

    case 'pot-divider': {
      // Arduino Nano at d2 (rot 0): 5V at h13, GND_BOT at h15
      // Potentiometer (Side-Turn) at d21 (rot 0): P1=d21, WIPER=d23, P3=d25
      // Note: Nano occupies cols 2..16 (rows d & h), so col 21..25 has zero overlap.
      // Wire e21 -> BN21 (GND to P1), BP25 -> e25 (+5V to P3), probe Wiper at a23 vs BN21 (GND).
      const placedParts = [
        {
          id: genId('arduino-nano'),
          partId: 'arduino-nano',
          anchorHoleId: 'd2',
          rotation: 0
        },
        {
          id: genId('pot-side-turn'),
          partId: 'pot-side-turn',
          anchorHoleId: 'd21',
          rotation: 0,
          props: { wiper: 0.5, resistance: 10000 }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'j13', holeB: 'BP13', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'j15', holeB: 'BN15', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'e21', holeB: 'BN21', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'BP25', holeB: 'e25', color: '#ef4444', colorName: 'Red' }
      ];

      return {
        boardConfig: {
          elvisMode: false,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0
        },
        defaultDmm: {
          open: true,
          mode: 'VDC',
          probeRed: 'a23',
          probeBlack: 'BN21'
        }
      };
    }

    case 'loadcell-ad620': {
      // Vertical ELVIS mode + Load Cells (sensorPosition: 'right'):
      // AD620 at e28 with rotation 90 straddles center trough:
      //   RG2 -> e28, VS+ -> e29, OUT -> e30, REF -> e31
      //   RG1 -> f28, IN- -> f29, IN+ -> f30, VS- -> f31
      // 100 Ω 1% resistor across a28 (RG2 strip) and j28 (RG1 strip) -> G = 1 + 49400/100 = 495
      const placedParts = [
        {
          id: genId('inamp-ad620'),
          partId: 'inamp-ad620',
          anchorHoleId: 'e28',
          rotation: 90
        },
        {
          id: genId('resistor-100-1pct'),
          partId: 'resistor-100-1pct',
          pinHoles: { P1: 'a28', P2: 'j28' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'ELV_51A', holeB: 'b29', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'ELV_52A', holeB: 'g31', color: '#3b82f6', colorName: 'Blue' },
        { id: genId('wire'), holeA: 'ELV_49A', holeB: 'b31', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_54A', holeB: 'LC_FB_RED_A', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'ELV_49B', holeB: 'LC_FB_BLK_A', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'LC_FB_GRN_A', holeB: 'g30', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'LC_FB_WHT_A', holeB: 'g29', color: '#f8fafc', colorName: 'White' }
      ];

      return {
        boardConfig: {
          elvisMode: true,
          loadCellsMode: true,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'right'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 500
        },
        defaultDmm: {
          open: true,
          mode: 'VDC',
          probeRed: 'b30',
          probeBlack: 'ELV_53D'
        }
      };
    }

    case 'rc-lowpass': {
      // Vertical ELVIS II mode:
      // Input strip: TERM_BOT_20 (f20..j20)
      // Output strip: TERM_BOT_24 (f24..j24)
      // Ground return strip: TERM_BOT_28 (f28..j28) -> ELV_53D
      // 1 kΩ resistor across g20 -> g24, 100 nF capacitor across h24 -> h28
      // FGEN (ELV_33D) -> j20, AI0+ (ELV_1D) -> i20, AI0- (ELV_2D) -> ELV_49D
      // AI1+ (ELV_3D) -> i24, AI1- (ELV_4D) -> ELV_49C
      const placedParts = [
        {
          id: genId('resistor-1k-1pct'),
          partId: 'resistor-1k-1pct',
          pinHoles: { P1: 'g20', P2: 'g24' }
        },
        {
          id: genId('cap-100nf'),
          partId: 'cap-100nf',
          pinHoles: { P1: 'h24', P2: 'h28' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'ELV_33D', holeB: 'j20', color: '#f97316', colorName: 'Orange' },
        { id: genId('wire'), holeA: 'j28', holeB: 'ELV_53D', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_1D', holeB: 'i20', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'ELV_2D', holeB: 'ELV_49D', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_3D', holeB: 'i24', color: '#eab308', colorName: 'Yellow' },
        { id: genId('wire'), holeA: 'ELV_4D', holeB: 'ELV_49C', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: true,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0,
          fgen: {
            enabled: true,
            waveform: 'sine',
            frequencyHz: 1592,
            amplitudeVpp: 4.0,
            dcOffsetV: 0,
            dutyCycle: 50,
            probeHole: null
          }
        },
        defaultScope: {
          open: true,
          running: true,
          timePerDiv: 0.0002,
          trigger: { source: 'CH0', slope: 'rising', level: 0 },
          ch0: { enabled: true, source: 'AI0', coupling: 'DC', voltsPerDiv: 1, vPos: 0 },
          ch1: { enabled: true, source: 'AI1', coupling: 'DC', voltsPerDiv: 1, vPos: 0 }
        },
        defaultDmm: {
          open: false,
          mode: 'VAC',
          probeRed: 'f24',
          probeBlack: 'ELV_53C'
        }
      };
    }

    case 'opamp-ac-amp': {
      // Vertical ELVIS II mode:
      // opamp-dual-dip8 at anchor e28 with rotation 90 straddles trough:
      //   VCC (Pin 8)  -> e28 (TERM_TOP_28) -> ELV_51D (+15V)
      //   OUT1 (Pin 1) -> f28 (TERM_BOT_28)
      //   IN1- (Pin 2) -> f29 (TERM_BOT_29)
      //   IN1+ (Pin 3) -> f30 (TERM_BOT_30) -> ELV_53D (GROUND)
      //   GND (Pin 4)  -> f31 (TERM_BOT_31) -> ELV_52D (-15V)
      // Input strip: TERM_BOT_24 (f24..j24)
      // 1 kΩ input resistor:  g24 -> g29 (input strip -> IN1-)
      // 10 kΩ feedback resistor: h29 -> h28 (IN1- -> OUT1)
      // FGEN (ELV_33D) -> j24, AI0+ (ELV_1D) -> i24, AI0- (ELV_2D) -> ELV_49D
      // AI1+ (ELV_3D) -> j28 (OUT1 strip), AI1- (ELV_4D) -> ELV_49C
      const placedParts = [
        {
          id: genId('opamp-dual-dip8'),
          partId: 'opamp-dual-dip8',
          anchorHoleId: 'e28',
          rotation: 90
        },
        {
          id: genId('resistor-1k-1pct'),
          partId: 'resistor-1k-1pct',
          pinHoles: { P1: 'g24', P2: 'g29' }
        },
        {
          id: genId('resistor-10k-1pct'),
          partId: 'resistor-10k-1pct',
          pinHoles: { P1: 'h29', P2: 'h28' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'ELV_51D', holeB: 'a28', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'ELV_52D', holeB: 'j31', color: '#3b82f6', colorName: 'Blue' },
        { id: genId('wire'), holeA: 'j30', holeB: 'ELV_53D', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_33D', holeB: 'j24', color: '#f97316', colorName: 'Orange' },
        { id: genId('wire'), holeA: 'ELV_1D', holeB: 'i24', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'ELV_2D', holeB: 'ELV_49D', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_3D', holeB: 'j28', color: '#eab308', colorName: 'Yellow' },
        { id: genId('wire'), holeA: 'ELV_4D', holeB: 'ELV_49C', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: true,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0,
          fgen: {
            enabled: true,
            waveform: 'sine',
            frequencyHz: 200,
            amplitudeVpp: 1.5,
            dcOffsetV: 0,
            dutyCycle: 50,
            probeHole: null
          }
        },
        defaultScope: {
          open: true,
          running: true,
          timePerDiv: 0.002,
          trigger: { source: 'CH0', slope: 'rising', level: 0 },
          ch0: { enabled: true, source: 'AI0', coupling: 'DC', voltsPerDiv: 1, vPos: 0 },
          ch1: { enabled: true, source: 'AI1', coupling: 'DC', voltsPerDiv: 5, vPos: 0 }
        },
        defaultDmm: {
          open: false,
          mode: 'VAC',
          probeRed: null,
          probeBlack: null
        }
      };
    }

    case 'emg-ad620': {
      // Vertical ELVIS mode + 3-Pad EMG (sensorPosition: 'right'):
      // AD620 at e28 with rotation 90 straddles center trough:
      //   RG2 -> e28, VS+ -> e29, OUT -> e30, REF -> e31
      //   RG1 -> f28, IN- -> f29, IN+ -> f30, VS- -> f31
      // 100 Ω 1% resistor across a28 (RG2 strip) and j28 (RG1 strip) -> G = 1 + 49400/100 = 495
      const placedParts = [
        {
          id: genId('inamp-ad620'),
          partId: 'inamp-ad620',
          anchorHoleId: 'e28',
          rotation: 90
        },
        {
          id: genId('resistor-100-1pct'),
          partId: 'resistor-100-1pct',
          pinHoles: { P1: 'a28', P2: 'j28' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'ELV_51D', holeB: 'b29', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'ELV_52D', holeB: 'g31', color: '#3b82f6', colorName: 'Blue' },
        { id: genId('wire'), holeA: 'ELV_53D', holeB: 'b31', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'EMG_RED1_A', holeB: 'g30', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'EMG_RED2_A', holeB: 'g29', color: '#f97316', colorName: 'Orange' },
        { id: genId('wire'), holeA: 'EMG_BLK_A', holeB: 'ELV_53C', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_1D', holeB: 'b30', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'ELV_2D', holeB: 'ELV_49D', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_3D', holeB: 'EMG_RED1_B', color: '#eab308', colorName: 'Yellow' },
        { id: genId('wire'), holeA: 'ELV_4D', holeB: 'ELV_49C', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: true,
          loadCellsMode: false,
          emgMode: true,
          pulseOxMode: false,
          sensorPosition: 'right'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0,
          emg: {
            flexEffort: 0.75,
            burstMode: 'burst',
            humMvpp: 15,
            electrodeMismatch: 0.05
          }
        },
        defaultScope: {
          open: true,
          running: true,
          timePerDiv: 0.02,
          trigger: { source: 'AUTO', slope: 'rising', level: 0 },
          ch0: { enabled: true, source: 'AI0', coupling: 'DC', voltsPerDiv: 0.5, vPos: 1.5 },
          ch1: { enabled: true, source: 'AI1', coupling: 'DC', voltsPerDiv: 0.02, vPos: -2 }
        },
        defaultDmm: {
          open: false,
          mode: 'VDC',
          probeRed: null,
          probeBlack: null
        }
      };
    }

    case 'arduino-button-led': {
      // Arduino Nano at d2 (rot 0):
      //   Top pins (row d): D9=d5 (strip a5..e5), D2=d12 (strip a12..e12)
      //   Bottom pins (row h): GND_BOT=h15 (strip f15..j15)
      // Pushbutton at e22 (rot 0) straddling trough:
      //   Pair A: P1=e22, P3=f22; Pair B: P2=e24, P4=f24
      //   b22 -> a12 (D2), i24 -> BN24 (GND)
      // LED + 330 Ω resistor on D9:
      //   a5 -> b28, 330 Ω (c28 -> c32), LED (P1=d32, P2=g32), i32 -> BN32
      const placedParts = [
        {
          id: genId('arduino-nano'),
          partId: 'arduino-nano',
          anchorHoleId: 'd2',
          rotation: 0
        },
        {
          id: genId('pushbutton-4pin'),
          partId: 'pushbutton-4pin',
          anchorHoleId: 'e22',
          rotation: 0,
          props: { pressed: false }
        },
        {
          id: genId('resistor-330-1pct'),
          partId: 'resistor-330-1pct',
          pinHoles: { P1: 'c28', P2: 'c32' }
        },
        {
          id: genId('led-red'),
          partId: 'led-red',
          pinHoles: { P1: 'd32', P2: 'g32' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'j15', holeB: 'BN15', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'b22', holeB: 'a12', color: '#3b82f6', colorName: 'Blue' },
        { id: genId('wire'), holeA: 'i24', holeB: 'BN24', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'a5', holeB: 'b28', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'i32', holeB: 'BN31', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: false,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0
        },
        defaultArduino: {
          open: true,
          sketchId: 'button-led',
          autoRun: true,
          drawerTab: 'serial'
        },
        defaultDmm: {
          open: false,
          mode: 'VDC',
          probeRed: null,
          probeBlack: null
        }
      };
    }

    case 'arduino-pot-pwm': {
      // Arduino Nano at d2 (rot 0):
      //   Top pins (row d): D9=d5 (strip a5..e5)
      //   Bottom pins (row h): A0=h5 (strip f5..j5), 5V=h13 (strip f13..j13), GND_BOT=h15 (strip f15..j15)
      // Potentiometer (Side-Turn) at e21 (rot 0): P1=e21, WIPER=e23, P3=e25
      //   a21 -> BN21 (GND), a25 -> BP25 (+5V), b23 -> i5 (A0)
      // LED + 330 Ω resistor on D9:
      //   a5 -> b30, 330 Ω (c30 -> c34), LED (P1=d34, P2=g34), i34 -> BN34
      const placedParts = [
        {
          id: genId('arduino-nano'),
          partId: 'arduino-nano',
          anchorHoleId: 'd2',
          rotation: 0
        },
        {
          id: genId('pot-side-turn'),
          partId: 'pot-side-turn',
          anchorHoleId: 'e21',
          rotation: 0,
          props: { wiper: 0.5, resistance: 10000 }
        },
        {
          id: genId('resistor-330-1pct'),
          partId: 'resistor-330-1pct',
          pinHoles: { P1: 'c30', P2: 'c34' }
        },
        {
          id: genId('led-red'),
          partId: 'led-red',
          pinHoles: { P1: 'd34', P2: 'g34' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'j13', holeB: 'BP13', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'j15', holeB: 'BN15', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'a21', holeB: 'BN21', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'a25', holeB: 'BP25', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'b23', holeB: 'i5', color: '#f97316', colorName: 'Orange' },
        { id: genId('wire'), holeA: 'a5', holeB: 'b30', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'i34', holeB: 'BN34', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: false,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0
        },
        defaultArduino: {
          open: true,
          sketchId: 'pot-plotter',
          autoRun: true,
          drawerTab: 'plotter'
        },
        defaultScope: {
          open: false,
          running: true,
          timePerDiv: 0.0005,
          trigger: { source: 'CH0', slope: 'rising', level: 2.5 },
          ch0: { enabled: true, source: 'PROBE', probeHole: 'a30', coupling: 'DC', voltsPerDiv: 2, vPos: -1 },
          ch1: { enabled: false, source: 'AI1', coupling: 'DC', voltsPerDiv: 1, vPos: 0 }
        },
        defaultDmm: {
          open: false,
          mode: 'VDC',
          probeRed: 'a30',
          probeBlack: 'BN34'
        }
      };
    }

    case 'arduino-emg-fir': {
      // Vertical ELVIS II mode + 3-Pad EMG (sensorPosition: 'right'):
      // Arduino Nano at d2 (rot 90):
      //   Rows 2..16: A0 = h5 (strip f5..j5), GND_BOT = h15 (strip f15..j15)
      // AD620 at e28 (rot 90) straddles center trough:
      //   RG2 -> e28, VS+ -> e29, OUT -> e30, REF -> e31
      //   RG1 -> f28, IN- -> f29, IN+ -> f30, VS- -> f31
      // 100 Ω 1% resistor across a28 (RG2 strip) and j28 (RG1 strip) -> G = 1 + 49400/100 = 495
      // Biased via ELVIS SUPPLY + (+2.50 V, ELV_48D) -> AD620 REF (b31)
      // AD620 OUT (b30) -> Arduino A0 (j5), and AD620 OUT (c30) -> AI0+ (ELV_1D)
      const placedParts = [
        {
          id: genId('arduino-nano'),
          partId: 'arduino-nano',
          anchorHoleId: 'd2',
          rotation: 90
        },
        {
          id: genId('inamp-ad620'),
          partId: 'inamp-ad620',
          anchorHoleId: 'e28',
          rotation: 90
        },
        {
          id: genId('resistor-100-1pct'),
          partId: 'resistor-100-1pct',
          pinHoles: { P1: 'a28', P2: 'j28' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'ELV_51D', holeB: 'b29', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'ELV_52D', holeB: 'g31', color: '#3b82f6', colorName: 'Blue' },
        { id: genId('wire'), holeA: 'ELV_48D', holeB: 'b31', color: '#a855f7', colorName: 'Purple' },
        { id: genId('wire'), holeA: 'EMG_RED1_A', holeB: 'g30', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'EMG_RED2_A', holeB: 'g29', color: '#f97316', colorName: 'Orange' },
        { id: genId('wire'), holeA: 'EMG_BLK_A', holeB: 'ELV_53C', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'b30', holeB: 'j5', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'c30', holeB: 'ELV_1D', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'ELV_2D', holeB: 'ELV_49D', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'j15', holeB: 'ELV_53D', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: true,
          loadCellsMode: false,
          emgMode: true,
          pulseOxMode: false,
          sensorPosition: 'right'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          vpsEnabled: true,
          elvisSupplyPos: 2.5,
          elvisSupplyNeg: -2.5,
          loadCellForceGrams: 0,
          emg: {
            flexEffort: 0.85,
            burstMode: 'burst',
            humMvpp: 15,
            electrodeMismatch: 0.05
          }
        },
        defaultArduino: {
          open: true,
          sketchId: 'fir-emg-filter',
          autoRun: true,
          drawerTab: 'plotter'
        },
        defaultScope: {
          open: false,
          running: true,
          timePerDiv: 0.02,
          trigger: { source: 'AUTO', slope: 'rising', level: 2.5 },
          ch0: { enabled: true, source: 'AI0', coupling: 'DC', voltsPerDiv: 0.5, vPos: -2 },
          ch1: { enabled: false, source: 'AI1', coupling: 'DC', voltsPerDiv: 1, vPos: 0 }
        },
        defaultDmm: {
          open: false,
          mode: 'VDC',
          probeRed: null,
          probeBlack: null
        }
      };
    }

    case 'ppg-ldr': {
      // Arduino Nano at d2 (rot 0):
      //   Bottom pins (row h): A0=h5 (strip f5..j5), 5V=h13 (strip f13..j13), GND_BOT=h15 (strip f15..j15)
      //   j13 -> BP13 (+5V rail), j15 -> BN15 (GND rail)
      // Optical emitter:
      //   BP21 -> f21, 330 Ω resistor (g21 -> g24), Red LED (h24 Anode -> h27 Cathode), j27 -> BN27
      // Optical PPG receiver (5V -> Photoresistor -> divider node col 35 -> 10 kΩ -> GND):
      //   BP31 -> f31, Photoresistor (g31 -> g35), 10 kΩ (h35 -> h39), j39 -> BN39
      //   Divider node i35 -> j5 (Nano A0)
      const placedParts = [
        {
          id: genId('arduino-nano'),
          partId: 'arduino-nano',
          anchorHoleId: 'd2',
          rotation: 0
        },
        {
          id: genId('resistor-330-1pct'),
          partId: 'resistor-330-1pct',
          pinHoles: { P1: 'g21', P2: 'g24' }
        },
        {
          id: genId('led-red'),
          partId: 'led-red',
          pinHoles: { P1: 'h24', P2: 'h27' }
        },
        {
          id: genId('photoresistor'),
          partId: 'photoresistor',
          pinHoles: { P1: 'g31', P2: 'g35' },
          props: {
            lightLevel: 0.5,
            lightMode: 'led-ppg',
            fingerPresent: true,
            bpm: 72,
            perfusion: 0.65
          }
        },
        {
          id: genId('resistor-10k-1pct'),
          partId: 'resistor-10k-1pct',
          pinHoles: { P1: 'h35', P2: 'h39' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'j13', holeB: 'BP13', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'j15', holeB: 'BN15', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'BP21', holeB: 'f21', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'j27', holeB: 'BN27', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'BP31', holeB: 'f31', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'j39', holeB: 'BN39', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'i35', holeB: 'j5', color: '#f97316', colorName: 'Orange' }
      ];

      return {
        boardConfig: {
          elvisMode: false,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: false,
          sensorPosition: 'auto'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0
        },
        defaultArduino: {
          open: true,
          autoRun: true,
          sketchId: 'ppg-ldr-plotter',
          drawerTab: 'plotter'
        },
        defaultDmm: {
          open: false,
          mode: 'VDC',
          probeRed: 'j35',
          probeBlack: 'BN35'
        }
      };
    }

    case 'pulseox-tia': {
      // Vertical ELVIS II mode + True Dual-LED Pulse-Ox (sensorPosition: 'right'):
      // Dual Op-Amp (opamp-dual-dip8) at e28 with rotation 90 straddles trough:
      //   VCC (Pin 8)  -> e28 (TERM_TOP_28) -> ELV_51D (+15V)
      //   OUT1 (Pin 1) -> f28 (TERM_BOT_28)
      //   IN1- (Pin 2) -> f29 (TERM_BOT_29)
      //   IN1+ (Pin 3) -> f30 (TERM_BOT_30) -> ELV_53D (GROUND)
      //   GND (Pin 4)  -> f31 (TERM_BOT_31) -> ELV_52D (-15V)
      // Two 330 Ω current-limiting resistors from ELVIS +5V to Pulse-Ox LEDs:
      //   ELV_54A -> e10, 330 Ω (c10 -> c14), e14 -> POX_RED_A_A
      //   ELV_54B -> e18, 330 Ω (c18 -> c22), e22 -> POX_IR_A_A
      //   POX_LED_K_A -> ELV_53B (GROUND)
      // TIA Stage 1:
      //   POX_PD_A_A -> ELV_53C (GROUND)
      //   POX_PD_K_A -> h29 (IN1- strip)
      //   100 kΩ feedback resistor across g28 (OUT1) -> g29 (IN1-)
      //   OUT1 (j28) -> ELV_1A (AI 0+), ELV_2A (AI 0-) -> ELV_18A (AIGND)
      const placedParts = [
        {
          id: genId('opamp-dual-dip8'),
          partId: 'opamp-dual-dip8',
          anchorHoleId: 'e28',
          rotation: 90
        },
        {
          id: genId('resistor-330-1pct'),
          partId: 'resistor-330-1pct',
          pinHoles: { P1: 'c10', P2: 'c14' }
        },
        {
          id: genId('resistor-330-1pct'),
          partId: 'resistor-330-1pct',
          pinHoles: { P1: 'c18', P2: 'c22' }
        },
        {
          id: genId('resistor-100k-1pct'),
          partId: 'resistor-100k-1pct',
          pinHoles: { P1: 'g28', P2: 'g29' }
        }
      ];

      const wires = [
        { id: genId('wire'), holeA: 'ELV_54A', holeB: 'e10', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'e14', holeB: 'POX_RED_A_A', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'ELV_54B', holeB: 'e18', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'e22', holeB: 'POX_IR_A_A', color: '#a855f7', colorName: 'Purple' },
        { id: genId('wire'), holeA: 'POX_LED_K_A', holeB: 'ELV_53B', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'ELV_51D', holeB: 'a28', color: '#ef4444', colorName: 'Red' },
        { id: genId('wire'), holeA: 'ELV_52D', holeB: 'j31', color: '#3b82f6', colorName: 'Blue' },
        { id: genId('wire'), holeA: 'j30', holeB: 'ELV_53D', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'POX_PD_A_A', holeB: 'ELV_53C', color: '#1e293b', colorName: 'Black' },
        { id: genId('wire'), holeA: 'POX_PD_K_A', holeB: 'h29', color: '#eab308', colorName: 'Yellow' },
        { id: genId('wire'), holeA: 'j28', holeB: 'ELV_1A', color: '#22c55e', colorName: 'Green' },
        { id: genId('wire'), holeA: 'ELV_2A', holeB: 'ELV_18A', color: '#1e293b', colorName: 'Black' }
      ];

      return {
        boardConfig: {
          elvisMode: true,
          loadCellsMode: false,
          emgMode: false,
          pulseOxMode: true,
          sensorPosition: 'right'
        },
        placedParts,
        wires,
        simConfig: {
          powered: true,
          vpsEnabled: true,
          elvisSupplyPos: 5.0,
          elvisSupplyNeg: -5.0,
          loadCellForceGrams: 0,
          pulseOx: {
            fingerPresent: true,
            bpm: 72,
            spo2: 98,
            perfusion: 0.65
          }
        },
        defaultScope: {
          open: true,
          running: true,
          timePerDiv: 0.5,
          trigger: { source: 'AUTO', slope: 'rising', level: 0 },
          ch0: { enabled: true, source: 'AI0', coupling: 'AC', voltsPerDiv: 0.05, vPos: 0 },
          ch1: { enabled: false }
        },
        defaultDmm: {
          open: false,
          mode: 'VDC',
          probeRed: 'i28',
          probeBlack: 'ELV_53A'
        }
      };
    }

    default:
      throw new Error(`Unknown lab preset: ${presetId}`);
  }
}
