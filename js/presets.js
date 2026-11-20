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
    name: 'NI ELVIS II: Load Cell + AD620 Amp',
    description: 'Full-bridge load cell excited at +5V and amplified by an AD620 (Rg = 100 Ω, G = 495) on ±15V.'
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
 *   defaultDmm: { open: boolean, mode: 'VDC'|'OHM'|'CONT', probeRed: string|null, probeBlack: string|null }
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

    default:
      throw new Error(`Unknown lab preset: ${presetId}`);
  }
}
