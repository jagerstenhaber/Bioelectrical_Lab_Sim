import { getRotatedPinOffset } from './breadboard.js';

/**
 * Breadboard Connectivity & Net Analyzer
 * Uses a Disjoint-Set (Union-Find) over breadboard & NI ELVIS II strips to:
 * 1. Group strips connected via jumper wires or internal device nets (e.g., Arduino Nano GND pins, NI ELVIS II GROUND rows).
 * 2. Track all component pins, NI ELVIS II instrument signals, and wires attached to every hole and net.
 * 3. Detect direct power-to-ground short circuits (e.g., 5V/+15V/-15V shorted to GND).
 */

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }

  makeSet(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
    }
  }

  find(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root);
    }
    let curr = x;
    while (curr !== root) {
      const nxt = this.parent.get(curr);
      this.parent.set(curr, root);
      curr = nxt;
    }
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootB, rootA);
    }
  }
}

export function analyzeCircuit(breadboard, placedParts, wires, catalogMap) {
  const ds = new DisjointSet();

  // Initialize every breadboard & NI ELVIS II strip
  let firstElvisGndStrip = null;
  let firstElvisAiGndStrip = null;

  for (const [stripId, holes] of breadboard.strips.entries()) {
    ds.makeSet(stripId);
    const firstHole = holes[0];
    if (firstHole?.type === 'elvis') {
      if (firstHole.elvisLabel === 'GROUND') {
        if (!firstElvisGndStrip) firstElvisGndStrip = stripId;
        else ds.union(firstElvisGndStrip, stripId);
      } else if (firstHole.elvisLabel === 'AIGND') {
        if (!firstElvisAiGndStrip) firstElvisAiGndStrip = stripId;
        else ds.union(firstElvisAiGndStrip, stripId);
      }
    }
  }

  // Track occupancy per hole: holeId -> Array of { kind, id, label, partName, pinRole }
  const holeOccupants = new Map();
  const addOccupant = (holeId, item) => {
    if (!holeOccupants.has(holeId)) {
      holeOccupants.set(holeId, []);
    }
    holeOccupants.get(holeId).push(item);
  };

  // 1. Union strips connected by jumper wires
  for (const wire of wires) {
    const hA = breadboard.getHole(wire.holeA);
    const hB = breadboard.getHole(wire.holeB);
    if (hA && hB) {
      ds.union(hA.stripId, hB.stripId);
      addOccupant(hA.id, {
        kind: 'wire',
        id: wire.id,
        label: `Jumper Wire (${wire.colorName || 'Wire'})`
      });
      addOccupant(hB.id, {
        kind: 'wire',
        id: wire.id,
        label: `Jumper Wire (${wire.colorName || 'Wire'})`
      });
    }
  }

  // 2. Map placed component pins to holes and union internal component nets (e.g., Nano GND_TOP <-> GND_BOT)
  const partPinHoles = new Map(); // instanceId -> Map(pinId -> hole)

  for (const inst of placedParts) {
    const partDef = catalogMap.get(inst.partId);
    if (!partDef) continue;

    const pinMap = new Map();
    partPinHoles.set(inst.id, pinMap);

    if (partDef.placement === 'two-lead') {
      const h1 = breadboard.getHole(inst.pinHoles?.P1);
      const h2 = breadboard.getHole(inst.pinHoles?.P2);
      const p1Label = partDef.pins?.[0]?.label || 'Lead 1';
      const p2Label = partDef.pins?.[1]?.label || 'Lead 2';
      if (h1) {
        pinMap.set('P1', h1);
        addOccupant(h1.id, {
          kind: 'pin',
          instanceId: inst.id,
          partName: partDef.name,
          pinId: 'P1',
          pinLabel: p1Label,
          role: 'passive'
        });
      }
      if (h2) {
        pinMap.set('P2', h2);
        addOccupant(h2.id, {
          kind: 'pin',
          instanceId: inst.id,
          partName: partDef.name,
          pinId: 'P2',
          pinLabel: p2Label,
          role: 'passive'
        });
      }
    } else if (partDef.placement === 'footprint') {
      const anchorHole = breadboard.getHole(inst.anchorHoleId);
      if (!anchorHole) continue;
      const rot = inst.rotation || 0;

      for (const pin of partDef.pins) {
        const { dx, dy } = getRotatedPinOffset(pin, rot);
        const hole = breadboard.getHoleAtGrid(anchorHole.gridX + dx, anchorHole.gridY + dy);
        if (hole) {
          pinMap.set(pin.id, hole);
          addOccupant(hole.id, {
            kind: 'pin',
            instanceId: inst.id,
            partName: partDef.name,
            pinId: pin.id,
            pinLabel: pin.label,
            role: pin.role || 'signal'
          });
        }
      }

      if (Array.isArray(partDef.internalNets)) {
        for (const group of partDef.internalNets) {
          let firstStrip = null;
          for (const pinId of group) {
            const h = pinMap.get(pinId);
            if (h) {
              if (!firstStrip) firstStrip = h.stripId;
              else ds.union(firstStrip, h.stripId);
            }
          }
        }
      }
    }
  }

  // 3. Build Net objects keyed by root stripId
  const nets = new Map();

  for (const [stripId, holes] of breadboard.strips.entries()) {
    const netId = ds.find(stripId);
    if (!nets.has(netId)) {
      nets.set(netId, {
        id: netId,
        strips: new Set(),
        holes: new Set(),
        pins: [],
        wires: new Set(),
        hasPower: false,
        hasGround: false,
        powerLabels: new Set(),
        isShorted: false
      });
    }
    const net = nets.get(netId);
    net.strips.add(stripId);

    // If this strip is an NI ELVIS II row, record its signal/power/ground role
    const firstHole = holes[0];
    if (firstHole?.type === 'elvis' && firstHole.elvisRole !== 'blank') {
      if (firstHole.elvisRole === 'power') {
        net.hasPower = true;
        net.powerLabels.add(`ELVIS ${firstHole.elvisLabel}`);
      } else if (firstHole.elvisRole === 'ground') {
        net.hasGround = true;
      }
      const stripHasConnection = holes.some((h) => (holeOccupants.get(h.id) || []).length > 0);
      if (stripHasConnection) {
        net.pins.push({
          kind: 'elvis',
          partName: 'NI ELVIS II',
          pinLabel: `Row ${firstHole.elvisRowNum}${firstHole.elvisLabel ? ` (${firstHole.elvisLabel})` : ''}`,
          role: firstHole.elvisRole
        });
      }
    } else if (firstHole?.type === 'sensor') {
      const stripHasConnection = holes.some((h) => (holeOccupants.get(h.id) || []).length > 0);
      if (stripHasConnection) {
        net.pins.push({
          kind: 'sensor',
          partName: 'External Sensor',
          pinLabel: firstHole.sensorLabel,
          role: firstHole.sensorRole
        });
      }
    }

    for (const h of holes) {
      net.holes.add(h.id);
      const occs = holeOccupants.get(h.id) || [];
      for (const occ of occs) {
        if (occ.kind === 'pin') {
          net.pins.push({ ...occ, holeId: h.id });
          // Only true voltage supply outputs (role === 'power') count as power sources
          if (occ.role === 'power') {
            net.hasPower = true;
            net.powerLabels.add(occ.pinLabel);
          } else if (occ.role === 'ground') {
            net.hasGround = true;
          }
        } else if (occ.kind === 'wire') {
          net.wires.add(occ.id);
        }
      }
    }
  }

  // 4. Check for shorts, self-shorted 2-lead components, IC trough placement errors, and crowded holes
  const warnings = [];
  for (const net of nets.values()) {
    if (net.hasPower && net.hasGround) {
      net.isShorted = true;
      warnings.push({
        netId: net.id,
        message: `Short circuit detected! Power (${Array.from(net.powerLabels).join(', ')}) is directly connected to GND.`
      });
    } else if (net.powerLabels.size > 1) {
      net.isShorted = true;
      warnings.push({
        netId: net.id,
        message: `Voltage conflict! Multiple supplies (${Array.from(net.powerLabels).join(' & ')}) are shorted together.`
      });
    }
  }

  // 5. Check placed parts for same-strip self-shorts (2-lead parts) or non-straddled DIP ICs
  for (const inst of placedParts) {
    const partDef = catalogMap.get(inst.partId);
    const pinMap = partPinHoles.get(inst.id);
    if (!partDef || !pinMap) continue;

    if (partDef.placement === 'two-lead') {
      const h1 = pinMap.get('P1');
      const h2 = pinMap.get('P2');
      if (h1 && h2 && ds.find(h1.stripId) === ds.find(h2.stripId)) {
        const net = nets.get(ds.find(h1.stripId));
        if (net) net.isShorted = true;
        warnings.push({
          netId: ds.find(h1.stripId),
          message: `Component shorted to itself! Both leads of ${partDef.shortLabel || partDef.name} (${h1.id} & ${h2.id}) are in the same connected strip/net.`
        });
      }
    } else if (partDef.placement === 'footprint') {
      const internalPairs = new Set();
      if (Array.isArray(partDef.internalNets)) {
        for (const grp of partDef.internalNets) {
          for (const a of grp) {
            for (const b of grp) {
              internalPairs.add(`${a}|${b}`);
            }
          }
        }
      }

      const pins = partDef.pins || [];
      let reportedForPart = false;
      for (let i = 0; i < pins.length && !reportedForPart; i++) {
        for (let j = i + 1; j < pins.length && !reportedForPart; j++) {
          const pA = pins[i];
          const pB = pins[j];
          if (internalPairs.has(`${pA.id}|${pB.id}`)) continue;
          const hA = pinMap.get(pA.id);
          const hB = pinMap.get(pB.id);
          if (hA && hB && hA.stripId === hB.stripId) {
            const net = nets.get(ds.find(hA.stripId));
            if (net) net.isShorted = true;
            warnings.push({
              netId: ds.find(hA.stripId),
              message: `IC placement error! ${partDef.shortLabel || partDef.name} pins [${pA.label}] and [${pB.label}] are shorted in the same strip (${hA.id}–${hB.id}) — straddle the center trough!`
            });
            reportedForPart = true;
          }
        }
      }
    }
  }

  // 6. Check for multiple leads/wires plugged into the exact same breadboard hole
  for (const [holeId, occs] of holeOccupants.entries()) {
    if (occs.length > 1) {
      const hole = breadboard.getHole(holeId);
      const netId = hole ? ds.find(hole.stripId) : holeId;
      warnings.push({
        netId,
        message: `Crowded hole (${holeId}): ${occs.length} leads/wires share one hole — use separate holes in the same strip.`
      });
    }
  }

  return {
    getNetForHole(holeId) {
      const hole = breadboard.getHole(holeId);
      if (!hole) return null;
      const root = ds.find(hole.stripId);
      return nets.get(root) || null;
    },
    getOccupants(holeId) {
      return holeOccupants.get(holeId) || [];
    },
    getPinHole(instanceId, pinId) {
      return partPinHoles.get(instanceId)?.get(pinId) || null;
    },
    nets,
    warnings
  };
}
