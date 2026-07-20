// ---------------------------------------------------------------
// REDSTONE-SIMULATION (Stufe 3: ereignisbasierte Engine)
//
// Vanilla-artige Ereignisverarbeitung statt "pro Tick global rechnen":
//   - Block-Updates laufen SOFORT und synchron in Minecrafts
//     Update-Reihenfolge (West, Ost, Unten, Oben, Nord, Süd)
//   - Komponenten mit Verzögerung (Verstärker, Fackeln, Komparatoren,
//     Beobachter, Lampen) planen TILE-TICKS mit Vanilla-Prioritäten:
//     -3 = extrem hoch (Verstärker vor Diode), -2 = sehr hoch
//     (Verstärker beim Abschalten), -1 = hoch, 0 = normal.
//     Fällige Ticks eines Game-Ticks laufen sortiert nach
//     (Zeit, Priorität, Einfüge-Reihenfolge) — wie im Spiel.
//   - Kolben laufen über BLOCK-EVENTS, die am ENDE desselben
//     Game-Ticks verarbeitet werden. Dadurch funktioniert 0-Tick-Tech:
//     ein Puls, der im selben Tick wieder verschwindet, erreicht den
//     Kolben trotzdem (und kurze Pulse lassen klebrige Kolben ihren
//     Block fallen lassen — "block dropping").
//   - Redstonestaub ist verzögerungsfrei und relaxiert synchron
//     innerhalb der Update-Kette.
//   - Quasi-Konnektivität + BUD: Kolben werten ihren Strom NUR bei
//     einem Block-Update aus — QC-Strom ohne Update lässt sie
//     "geparkt" stehen.
//
// 1 Redstone-Tick (RT) = 2 Game-Ticks (GT). tick() = 1 GT.
// Die Engine kennt kein Rendering: sie arbeitet nur auf dem
// Block-Gitter und meldet Änderungen über onChange.
// ---------------------------------------------------------------
"use strict";

const DIRS = {
  north: [0, 0, -1], south: [0, 0, 1],
  west: [-1, 0, 0], east: [1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0]
};
const OPPOSITE = {
  north: "south", south: "north", west: "east",
  east: "west", up: "down", down: "up"
};
const SIDES = ["north", "south", "west", "east", "up", "down"];
const HORIZONTAL = ["north", "south", "west", "east"];
// Minecrafts Block-Update-Reihenfolge (entscheidend für Türen,
// die auf die exakte Reihenfolge kompiliert sind)
const UPDATE_ORDER = ["west", "east", "down", "up", "north", "south"];
// Seiten-Richtungen von Verstärkern/Komparatoren, abhängig vom facing
const SIDES_OF = {
  north: ["east", "west"], south: ["east", "west"],
  east: ["north", "south"], west: ["north", "south"]
};

// Tile-Tick-Prioritäten (Vanilla TickPriority, kleiner = früher)
const PRIO_EXTREMELY_HIGH = -3;
const PRIO_VERY_HIGH = -2;
const PRIO_HIGH = -1;
const PRIO_NORMAL = 0;

// Welches Instrument ein Notenblock hat, bestimmt der Block darunter.
function noteInstrument(name) {
  if (name === "minecraft:air") return "harp";
  if (/gold_block/.test(name)) return "bell";
  if (/iron_block/.test(name)) return "iron_xylophone";
  if (/emerald_block/.test(name)) return "bit";
  if (/bone_block/.test(name)) return "xylophone";
  if (/soul_sand/.test(name)) return "cow_bell";
  if (/packed_ice/.test(name)) return "chime";
  if (/glowstone/.test(name)) return "pling";
  if (/hay_block/.test(name)) return "banjo";
  if (/pumpkin/.test(name)) return "didgeridoo";
  if (/clay/.test(name)) return "flute";
  if (/wool/.test(name)) return "guitar";
  if (/sand|gravel|concrete_powder/.test(name)) return "snare";
  if (/glass|sea_lantern|beacon/.test(name)) return "hat";
  if (/planks|log|_wood|bamboo|barrel|crafting/.test(name)) return "bass";
  if (/stone|cobble|obsidian|brick|ore|deepslate|netherrack|quartz|concrete/.test(name)) return "basedrum";
  return "harp";
}

const SOLID_ENOUGH = name =>
  !/air|wire|torch|lever|button|pressure_plate|rail|water|lava|slab|stairs|glass|head$|leaves$|repeater$|comparator$|_door$|trapdoor$|fence|_gate$|moving_piston$/.test(name);

const isWire = n => n.endsWith("redstone_wire");
const isTorch = n => n.endsWith("redstone_torch") || n.endsWith("redstone_wall_torch");
const isRepeater = n => n.endsWith("repeater");
const isComparator = n => n.endsWith("comparator");
const isObserver = n => n.endsWith("observer");
const isPiston = n => n === "minecraft:piston" || n === "minecraft:sticky_piston";
const isDiode = n => isRepeater(n) || isComparator(n);
// Komponenten, mit denen sich Staub optisch/logisch verbindet
const wireConnectable = n =>
  isWire(n) || isTorch(n) || isDiode(n) || n.endsWith("redstone_block")
  || n.endsWith("lever") || n.endsWith("_button") || n.endsWith("tripwire_hook")
  || n.endsWith("observer") || n.endsWith("target") || n.endsWith("daylight_detector")
  || n.endsWith("pressure_plate");

class RedstoneSim {
  constructor(grid) {
    const [W, H, D] = grid.size;
    this.W = W; this.H = H; this.D = D;
    this.gameTick = 0;
    this.onChange = null;            // Callback fürs Rendering
    this.changed = new Set();        // Positionen, die sich diesen Tick änderten

    this.tickQueue = [];             // Tile-Ticks {at, prio, seq, x,y,z}
    this.tickSeq = 0;
    this.blockEvents = [];           // Kolben-Events {x,y,z, extend}
    this.motions = [];               // laufende Kolben-Bewegungen {at, group}
    this.updateDepth = 0;            // Schutz gegen Endlos-Rekursion

    this.cells = grid.blocks.map(i => {
      const p = grid.palette[i];
      return { name: p.name, props: { ...p.props } };
    });
    this.initial = grid;             // fürs Reset
    this.settling = false;
    this.settle0();
  }

  // ---- Grundlagen ----------------------------------------------
  idx(x, y, z) { return (y * this.D + z) * this.W + x; }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D; }
  get(x, y, z) { return this.inside(x, y, z) ? this.cells[this.idx(x, y, z)] : null; }
  markChanged(x, y, z) { this.changed.add(x + "," + y + "," + z); }
  eachCell(fn) {
    for (let y = 0; y < this.H; y++) for (let z = 0; z < this.D; z++) for (let x = 0; x < this.W; x++)
      fn(this.cells[this.idx(x, y, z)], x, y, z);
  }

  reset() {
    this.cells = this.initial.blocks.map(i => {
      const p = this.initial.palette[i];
      return { name: p.name, props: { ...p.props } };
    });
    this.tickQueue = [];
    this.blockEvents = [];
    this.motions = [];
    this.gameTick = 0;
    this.changed.clear();
    this.settle0();
    if (this.onChange) this.onChange();
  }

  // Einschwingen nach dem Laden: alle Komponenten in ihren stabilen
  // Zustand bringen, OHNE dass Beobachter pulsen oder Kolben-Bewegungen
  // animiert werden. Schematics speichern oft "mitten im Signal".
  settle0() {
    this.settling = true;
    const relaxWires = () => {
      for (let round = 0; round < 48; round++) {
        let dirty = false;
        this.eachCell((c, x, y, z) => {
          if (!isWire(c.name)) return;
          const want = String(this.computeWirePower(x, y, z));
          if ((c.props.power || "0") !== want) { c.props.power = want; dirty = true; }
        });
        if (!dirty) break;
      }
    };
    // Fackeln/Dioden und Staub wechselseitig stabilisieren
    for (let round = 0; round < 8; round++) {
      relaxWires();
      let dirty = false;
      this.eachCell((c, x, y, z) => {
        const n = c.name;
        if (isTorch(n)) {
          const want = this.torchShouldBeLit(c, x, y, z) ? "true" : "false";
          if ((c.props.lit || "true") !== want) { c.props.lit = want; dirty = true; }
        } else if (isRepeater(n)) {
          const lk = this.repeaterLocked(c, x, y, z) ? "true" : "false";
          if ((c.props.locked || "false") !== lk) { c.props.locked = lk; dirty = true; }
          if (lk !== "true") {
            const want = this.repeaterInput(c, x, y, z) ? "true" : "false";
            if ((c.props.powered || "false") !== want) { c.props.powered = want; dirty = true; }
          }
        } else if (isComparator(n)) {
          const out = this.comparatorOutput(c, x, y, z);
          if ((c._out || 0) !== out) { c._out = out; dirty = true; }
          c.props.powered = out > 0 ? "true" : "false";
        } else if (isObserver(n)) {
          if (c.props.powered === "true") { c.props.powered = "false"; dirty = true; }
        }
      });
      if (!dirty) break;
    }
    relaxWires();
    // Übrige Geräte auf Steady-State setzen
    this.eachCell((c, x, y, z) => {
      const n = c.name;
      if (/redstone_lamp$/.test(n)) {
        c.props.lit = this.deviceHasPower(x, y, z) ? "true" : "false";
      } else if (/_trapdoor$/.test(n) || /_door$/.test(n) || /fence_gate$/.test(n)) {
        let input = this.deviceHasPower(x, y, z);
        if (/_door$/.test(n)) {
          const oy = c.props.half === "upper" ? y - 1 : y + 1;
          input = input || this.deviceHasPower(x, oy, z);
        }
        c.props.open = input ? "true" : "false";
        c.props.powered = c.props.open;
      } else if (/powered_rail$|activator_rail$/.test(n)) {
        c.props.powered = this.railChainPowered(x, y, z) ? "true" : "false";
      } else if (n.endsWith("note_block")) {
        const below = this.get(x, y - 1, z);
        c.props.instrument = noteInstrument(below ? below.name : "minecraft:air");
        c.props.powered = this.deviceHasPower(x, y, z) ? "true" : "false";
      } else if (n.endsWith("tripwire_hook")) {
        const d = DIRS[c.props.facing || "north"];
        let count = 0;
        for (let i = 1; i <= 40; i++) {
          const cell = this.get(x + d[0] * i, y, z + d[2] * i);
          if (!cell || !cell.name.endsWith("tripwire")) break;
          count++;
        }
        c._twCount = count;
      }
    });
    this.settling = false;
    this.tickQueue = [];
    this.blockEvents = [];
    this.motions = [];
    this.changed.clear();
    this.gameTick = 0;
  }

  // Kompatibilität zur alten API (viewer.js ruft settle() auf)
  settle() { this.settle0(); }

  // ---- Zustandsänderungen + Block-Updates ----------------------
  // Jede sichtbare Zustandsänderung läuft hier durch: markiert fürs
  // Rendering und weckt Beobachter, die auf die Position schauen.
  stateChanged(x, y, z) {
    this.markChanged(x, y, z);
    if (this.settling) return;
    for (const s of SIDES) {
      const d = DIRS[s];
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      const nb = this.get(nx, ny, nz);
      if (nb && isObserver(nb.name)) {
        const f = DIRS[nb.props.facing || "north"];
        if (nx + f[0] === x && ny + f[1] === y && nz + f[2] === z)
          this.observerDetect(nx, ny, nz);
      }
    }
  }

  setCell(x, y, z, name, props) {
    const c = this.get(x, y, z);
    if (!c) return;
    c.name = name;
    c.props = props;
    this.stateChanged(x, y, z);
  }

  // Block-Updates an alle 6 Nachbarn, in Vanilla-Reihenfolge
  updateNeighbors(x, y, z) {
    if (this.settling) return;
    for (const s of UPDATE_ORDER) {
      const d = DIRS[s];
      this.neighborUpdate(x + d[0], y + d[1], z + d[2]);
    }
  }

  // Update-Welle nach einer Staub-Änderung — EXAKT wie Vanilla:
  // 1. direkte Nachbarn in Update-Reihenfolge (W,E,D,U,N,S),
  // 2. dann für jede Richtung in Direction.values()-Reihenfolge
  //    (D,U,N,S,W,E) die Nachbarn DIESER Position (wieder W,E,D,U,N,S).
  // Kein Dedupe: Positionen bekommen wie im Spiel mehrere Updates —
  // die Reihenfolge ist für kompilierte Türen (BUDs!) entscheidend.
  updateWireNeighborhood(x, y, z) {
    if (this.settling) return;
    for (const s of UPDATE_ORDER) {
      const d = DIRS[s];
      this.neighborUpdate(x + d[0], y + d[1], z + d[2]);
    }
    for (const s of ["down", "up", "north", "south", "west", "east"]) {
      const d = DIRS[s];
      for (const s2 of UPDATE_ORDER) {
        const d2 = DIRS[s2];
        const px = x + d[0] + d2[0], py = y + d[1] + d2[1], pz = z + d[2] + d2[2];
        if (px === x && py === y && pz === z) continue; // die Staub-Zelle selbst
        this.neighborUpdate(px, py, pz);
      }
    }
  }

  // Ein einzelnes Block-Update: die Komponente an (x,y,z) reagiert.
  neighborUpdate(x, y, z) {
    const c = this.get(x, y, z);
    if (!c) return;
    if (this.updateDepth > 512) return;   // Sicherung gegen Endlos-Ketten
    this.updateDepth++;
    try {
      const n = c.name;
      if (isWire(n)) this.wireUpdate(c, x, y, z);
      else if (isTorch(n)) this.torchUpdate(c, x, y, z);
      else if (isRepeater(n)) this.repeaterUpdate(c, x, y, z);
      else if (isComparator(n)) this.comparatorUpdate(c, x, y, z);
      else if (isPiston(n)) this.pistonUpdate(c, x, y, z);
      else if (/redstone_lamp$/.test(n)) this.lampUpdate(c, x, y, z);
      else if (/_trapdoor$/.test(n) || /_door$/.test(n) || /fence_gate$/.test(n)) this.doorUpdate(c, x, y, z);
      else if (n.endsWith("note_block")) this.noteUpdate(c, x, y, z);
      else if (/powered_rail$|activator_rail$/.test(n)) this.railUpdate(c, x, y, z);
      else if (/_leaves$/.test(n)) this.leafUpdate(c, x, y, z);
      else if (n.endsWith("tripwire_hook")) this.hookUpdate(c, x, y, z);
    } finally {
      this.updateDepth--;
    }
  }

  // ---- Tile-Ticks & Block-Events -------------------------------
  // WICHTIG: Ticks des aktuellen Batches, die noch nicht GELAUFEN
  // sind, zählen mit (wie Vanillas hasScheduledTick) — sonst plant
  // ein Neighbor-Update während der Tick-Phase Duplikate, und zwei
  // anhängige Ticks machen aus einem Verstärker ein Perpetuum mobile.
  hasTick(x, y, z) {
    const key = x + "," + y + "," + z;
    if (this.dueSet && this.dueSet.has(key)) return true;
    return this.tickQueue.some(t => t.x === x && t.y === y && t.z === z);
  }
  scheduleTick(x, y, z, delayGT, prio = PRIO_NORMAL) {
    if (this.settling) return;
    this.tickQueue.push({ at: this.gameTick + delayGT, prio, seq: this.tickSeq++, x, y, z });
  }
  addBlockEvent(x, y, z, extend) {
    if (this.settling) return;
    this.blockEvents.push({ x, y, z, extend });
  }

  // ---- Ein Game-Tick -------------------------------------------
  tick() {
    this.gameTick++;

    // Phase 1: fällige Tile-Ticks, sortiert nach (Zeit, Priorität, Reihenfolge)
    const due = [];
    this.tickQueue = this.tickQueue.filter(t => {
      if (t.at <= this.gameTick) { due.push(t); return false; }
      return true;
    });
    due.sort((a, b) => (a.at - b.at) || (a.prio - b.prio) || (a.seq - b.seq));
    this.dueSet = new Map();
    for (const t of due) {
      const k = t.x + "," + t.y + "," + t.z;
      this.dueSet.set(k, (this.dueSet.get(k) || 0) + 1);
    }
    for (const t of due) {
      // erst austragen, dann ausführen: während des eigenen Handlers
      // darf die Position neu geplant werden (Puls-Ketten!)
      const k = t.x + "," + t.y + "," + t.z;
      const n = this.dueSet.get(k);
      if (n <= 1) this.dueSet.delete(k); else this.dueSet.set(k, n - 1);
      this.scheduledTick(t.x, t.y, t.z);
    }
    this.dueSet = null;

    // Phase 2: Block-Events (Kolben) — inklusive Events, die während
    // der Verarbeitung neu entstehen (0-Tick!). Begrenzte Runden.
    for (let round = 0; round < 16 && this.blockEvents.length; round++) {
      const batch = this.blockEvents;
      this.blockEvents = [];
      for (const ev of batch) this.executeBlockEvent(ev);
    }

    // Phase 3: Kolben-Bewegungen kommen an (Vanillas Block-Entity-Phase
    // läuft NACH den Block-Events). Kolben-Events, die durch die
    // Ankunfts-Updates entstehen, laufen erst im NÄCHSTEN Tick —
    // genau wie im Spiel.
    if (this.motions.length) {
      const due = this.motions.filter(m => m.at <= this.gameTick);
      if (due.length) {
        this.motions = this.motions.filter(m => m.at > this.gameTick);
        for (const m of due)
          for (const [mx, my, mz] of m.group) this.finishMotionAt(mx, my, mz);
      }
    }

    // Rendering benachrichtigen
    if (this.changed.size && this.onChange) {
      const list = [...this.changed].map(s => s.split(",").map(Number));
      this.changed.clear();
      this.onChange(list);
    } else {
      this.changed.clear();
    }
  }

  // Fälliger Tile-Tick an einer Position → an die Komponente leiten
  scheduledTick(x, y, z) {
    const c = this.get(x, y, z);
    if (!c) return;
    const n = c.name;
    if (isTorch(n)) this.torchTick(c, x, y, z);
    else if (isRepeater(n)) this.repeaterTick(c, x, y, z);
    else if (isComparator(n)) this.comparatorTick(c, x, y, z);
    else if (isObserver(n)) this.observerTick(c, x, y, z);
    else if (/redstone_lamp$/.test(n)) this.lampTick(c, x, y, z);
    else if (n.endsWith("_button")) this.buttonTick(c, x, y, z);
    else if (n.endsWith("tripwire")) this.tripwireTick(c, x, y, z);
    else if (/_leaves$/.test(n)) this.leafTick(c, x, y, z);
    else if (n === "minecraft:moving_piston") this.finishMotionAt(x, y, z);
  }

  // ---- Interaktion ---------------------------------------------
  interact(x, y, z) {
    const c = this.get(x, y, z);
    if (!c) return false;
    if (c.name.endsWith("lever")) {
      c.props.powered = c.props.powered === "true" ? "false" : "true";
      this.stateChanged(x, y, z);
      this.updateNeighbors(x, y, z);
      const a = this.attachedTo(c, x, y, z);
      this.updateNeighbors(a[0], a[1], a[2]);
      return true;
    }
    if (c.name.endsWith("_button") && c.props.powered !== "true") {
      c.props.powered = "true";
      this.stateChanged(x, y, z);
      this.updateNeighbors(x, y, z);
      const a = this.attachedTo(c, x, y, z);
      this.updateNeighbors(a[0], a[1], a[2]);
      this.scheduleTick(x, y, z, c.name.includes("stone") ? 20 : 30);
      return true;
    }
    if (c.name.endsWith("tripwire") && c.props.powered !== "true") {
      c.props.powered = "true";
      this.stateChanged(x, y, z);
      this.tripwireLineChanged(x, y, z);
      this.scheduleTick(x, y, z, 10);
      return true;
    }
    return false;
  }

  buttonTick(c, x, y, z) {
    if (c.props.powered !== "true") return;
    c.props.powered = "false";
    this.stateChanged(x, y, z);
    this.updateNeighbors(x, y, z);
    const a = this.attachedTo(c, x, y, z);
    this.updateNeighbors(a[0], a[1], a[2]);
  }

  tripwireTick(c, x, y, z) {
    if (c.props.powered !== "true") return;
    c.props.powered = "false";
    this.stateChanged(x, y, z);
    this.tripwireLineChanged(x, y, z);
  }

  // Halteblock von Hebel/Knopf bestimmen
  attachedTo(c, x, y, z) {
    const face = c.props.face || "wall";
    if (face === "floor") return [x, y - 1, z];
    if (face === "ceiling") return [x, y + 1, z];
    const d = DIRS[OPPOSITE[c.props.facing || "north"]];
    return [x + d[0], y + d[1], z + d[2]];
  }

  // ---- Leistungsmodell (on demand) -----------------------------
  // Starke Powerung eines soliden Blocks: Fackel darunter, Hebel/Knopf/
  // Haken dran, Verstärker/Komparator/Beobachter, der hineinzeigt.
  strongPowerInto(x, y, z) {
    let best = 0;
    for (const s of SIDES) {
      const d = DIRS[s];
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      const c = this.get(nx, ny, nz);
      if (!c) continue;
      const n = c.name;
      const toTarget = OPPOSITE[s]; // Richtung vom Nachbarn zum Zielblock
      if (isTorch(n) && c.props.lit !== "false" && s === "down") best = Math.max(best, 15);
      else if ((n.endsWith("lever") || n.endsWith("_button")) && c.props.powered === "true") {
        const a = this.attachedTo(c, nx, ny, nz);
        if (a[0] === x && a[1] === y && a[2] === z) best = Math.max(best, 15);
      }
      else if (n.endsWith("tripwire_hook") && c.props.powered === "true") {
        const a = DIRS[OPPOSITE[c.props.facing || "north"]];
        if (nx + a[0] === x && ny + a[1] === y && nz + a[2] === z) best = Math.max(best, 15);
      }
      else if (isRepeater(n) && c.props.powered === "true"
        && OPPOSITE[c.props.facing || "north"] === toTarget) best = Math.max(best, 15);
      else if (isComparator(n) && (c._out || 0) > 0
        && OPPOSITE[c.props.facing || "north"] === toTarget) best = Math.max(best, c._out || 0);
      else if (isObserver(n) && c.props.powered === "true"
        && OPPOSITE[c.props.facing || "north"] === toTarget) best = Math.max(best, 15);
      if (best >= 15) return 15;
    }
    return best;
  }

  // Verbindet sich Staub an (x,y,z) in Richtung dir (horizontal)?
  wireConnects(x, y, z, dir) {
    const d = DIRS[dir];
    const nx = x + d[0], nz = z + d[2];
    const nb = this.get(nx, y, nz);
    if (nb) {
      if (isWire(nb.name)) return true;
      if (isRepeater(nb.name)) {
        const f = nb.props.facing || "north";
        if (f === dir || f === OPPOSITE[dir]) return true;
      } else if (wireConnectable(nb.name)) return true;
    }
    // diagonal hoch (nur wenn über dem Staub kein Block liegt)
    const above = this.get(x, y + 1, z);
    if (!(above && SOLID_ENOUGH(above.name))) {
      const upNb = this.get(nx, y + 1, nz);
      if (upNb && isWire(upNb.name) && nb && SOLID_ENOUGH(nb.name)) return true;
    }
    // diagonal runter (nur wenn die Kante frei ist)
    if (!(nb && SOLID_ENOUGH(nb.name))) {
      const dnNb = this.get(nx, y - 1, nz);
      if (dnNb && isWire(dnNb.name)) return true;
    }
    return false;
  }

  // Richtungen, in die dieser Staub zeigt (für schwache Powerung).
  // Keine Verbindungen → Kreuz (powert alle 4 Seiten).
  wirePointsTo(x, y, z) {
    const dirs = HORIZONTAL.filter(dir => this.wireConnects(x, y, z, dir));
    return dirs.length ? dirs : HORIZONTAL.slice();
  }

  // Gesamt-Powerlevel eines soliden Blocks (stark + Staub obendrauf/zeigend)
  blockPowerLevel(x, y, z) {
    let best = this.strongPowerInto(x, y, z);
    if (best >= 15) return 15;
    const above = this.get(x, y + 1, z);
    if (above && isWire(above.name)) best = Math.max(best, parseInt(above.props.power || "0", 10));
    for (const s of HORIZONTAL) {
      const d = DIRS[s];
      const nx = x + d[0], nz = z + d[2];
      const nb = this.get(nx, y, nz);
      if (nb && isWire(nb.name)) {
        const p = parseInt(nb.props.power || "0", 10);
        if (p > best && this.wirePointsTo(nx, y, nz).includes(OPPOSITE[s])) best = p;
      }
    }
    return best;
  }

  // Bekommt ein GERÄT an (x,y,z) aus Richtung `side` Strom? Liefert Stärke.
  devicePowerFrom(x, y, z, side) {
    const d = DIRS[side];
    const nx = x + d[0], ny = y + d[1], nz = z + d[2];
    const c = this.get(nx, ny, nz);
    if (!c) return 0;
    const n = c.name;
    const toDevice = OPPOSITE[side];
    if (isWire(n)) {
      const p = parseInt(c.props.power || "0", 10);
      if (p === 0) return 0;
      if (side === "up") return p;                 // Staub AUF dem Gerät
      if (side === "down") return 0;               // Staub unterm Gerät powert nicht
      return this.wirePointsTo(nx, ny, nz).includes(toDevice) ? p : 0;
    }
    if (n.endsWith("redstone_block")) return 15;
    if (isTorch(n) && c.props.lit !== "false") return 15;
    if ((n.endsWith("lever") || n.endsWith("_button") || n.endsWith("tripwire_hook"))
      && c.props.powered === "true") return 15;
    if (isRepeater(n) && c.props.powered === "true"
      && OPPOSITE[c.props.facing || "north"] === toDevice) return 15;
    if (isComparator(n) && OPPOSITE[c.props.facing || "north"] === toDevice) return c._out || 0;
    if (isObserver(n) && c.props.powered === "true"
      && OPPOSITE[c.props.facing || "north"] === toDevice) return 15;
    if (SOLID_ENOUGH(n)) return this.blockPowerLevel(nx, ny, nz);
    return 0;
  }

  deviceHasPower(x, y, z, exceptSide = null) {
    for (const s of SIDES) {
      if (s === exceptSide) continue;
      if (this.devicePowerFrom(x, y, z, s) > 0) return true;
    }
    return false;
  }

  // ---- Redstonestaub -------------------------------------------
  // Staub liest: direkte Komponenten, STARK gepowerte solide Blöcke
  // und Nachbar-Staub (−1, auch diagonal mit Abschneide-Regeln).
  computeWirePower(x, y, z) {
    let best = 0;
    for (const s of SIDES) {
      const d = DIRS[s];
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      const c = this.get(nx, ny, nz);
      if (!c) continue;
      const n = c.name;
      const toWire = OPPOSITE[s];
      if (n.endsWith("redstone_block")) best = Math.max(best, 15);
      else if (isTorch(n) && c.props.lit !== "false") best = Math.max(best, 15);
      else if ((n.endsWith("lever") || n.endsWith("_button") || n.endsWith("tripwire_hook"))
        && c.props.powered === "true") best = Math.max(best, 15);
      else if (isRepeater(n) && c.props.powered === "true"
        && OPPOSITE[c.props.facing || "north"] === toWire) best = Math.max(best, 15);
      else if (isComparator(n) && OPPOSITE[c.props.facing || "north"] === toWire)
        best = Math.max(best, c._out || 0);
      else if (isObserver(n) && c.props.powered === "true"
        && OPPOSITE[c.props.facing || "north"] === toWire) best = Math.max(best, 15);
      else if (SOLID_ENOUGH(n)) best = Math.max(best, this.strongPowerInto(nx, ny, nz));
      if (best >= 15) return 15;
    }
    // Nachbar-Staub, gleiche Ebene + diagonal
    const above = this.get(x, y + 1, z);
    const upBlocked = above && SOLID_ENOUGH(above.name);
    let neighborBest = 0;
    for (const s of HORIZONTAL) {
      const d = DIRS[s];
      const nx = x + d[0], nz = z + d[2];
      const same = this.get(nx, y, nz);
      if (same && isWire(same.name))
        neighborBest = Math.max(neighborBest, parseInt(same.props.power || "0", 10));
      // diagonal hoch: Nachbar solide, Staub oben drauf, über uns frei
      if (!upBlocked && same && SOLID_ENOUGH(same.name)) {
        const upWire = this.get(nx, y + 1, nz);
        if (upWire && isWire(upWire.name))
          neighborBest = Math.max(neighborBest, parseInt(upWire.props.power || "0", 10));
      }
      // diagonal runter: Kante frei, Staub eins tiefer
      if (!(same && SOLID_ENOUGH(same.name))) {
        const dnWire = this.get(nx, y - 1, nz);
        if (dnWire && isWire(dnWire.name))
          neighborBest = Math.max(neighborBest, parseInt(dnWire.props.power || "0", 10));
      }
    }
    return Math.max(best, Math.max(0, neighborBest - 1));
  }

  wireUpdate(c, x, y, z) {
    const want = this.computeWirePower(x, y, z);
    if ((parseInt(c.props.power || "0", 10)) === want) return;
    c.props.power = String(want);
    this.stateChanged(x, y, z);
    // Staub ist verzögerungsfrei: Änderung breitet sich synchron aus
    this.updateWireNeighborhood(x, y, z);
  }

  // ---- Fackel --------------------------------------------------
  torchAttachPos(c, x, y, z) {
    if (c.name.endsWith("wall_torch")) {
      const d = DIRS[OPPOSITE[c.props.facing || "north"]];
      return [x + d[0], y + d[1], z + d[2]];
    }
    return [x, y - 1, z];
  }
  torchShouldBeLit(c, x, y, z) {
    const [ax, ay, az] = this.torchAttachPos(c, x, y, z);
    const a = this.get(ax, ay, az);
    if (!a) return true;
    if (SOLID_ENOUGH(a.name)) return this.blockPowerLevel(ax, ay, az) === 0;
    return true;
  }
  torchUpdate(c, x, y, z) {
    const want = this.torchShouldBeLit(c, x, y, z);
    const lit = c.props.lit !== "false";
    if (lit !== want && !this.hasTick(x, y, z))
      this.scheduleTick(x, y, z, 2, PRIO_NORMAL);
  }
  torchTick(c, x, y, z) {
    const want = this.torchShouldBeLit(c, x, y, z);
    const lit = c.props.lit !== "false";
    if (lit === want) return;
    c.props.lit = want ? "true" : "false";
    this.stateChanged(x, y, z);
    this.updateNeighbors(x, y, z);
    this.updateNeighbors(x, y + 1, z); // Block darüber wird stark gepowert
  }

  // ---- Verstärker ----------------------------------------------
  repeaterLocked(c, x, y, z) {
    const facing = c.props.facing || "north";
    return SIDES_OF[facing].some(sname => {
      const d = DIRS[sname];
      const nb = this.get(x + d[0], y + d[1], z + d[2]);
      return nb && isDiode(nb.name)
        && nb.props.powered === "true" && (nb.props.facing || "north") === sname;
    });
  }
  repeaterInput(c, x, y, z) {
    const facing = c.props.facing || "north"; // facing zeigt zum Eingang
    return this.devicePowerFrom(x, y, z, facing) > 0;
  }
  repeaterPrio(c, x, y, z) {
    // Vanilla: zeigt der Ausgang auf eine Diode → extrem hoch;
    // beim Abschalten → sehr hoch; sonst hoch.
    const outDir = OPPOSITE[c.props.facing || "north"];
    const d = DIRS[outDir];
    const front = this.get(x + d[0], y + d[1], z + d[2]);
    if (front && isDiode(front.name)) return PRIO_EXTREMELY_HIGH;
    return c.props.powered === "true" ? PRIO_VERY_HIGH : PRIO_HIGH;
  }
  repeaterUpdate(c, x, y, z) {
    const locked = this.repeaterLocked(c, x, y, z);
    const lockedProp = locked ? "true" : "false";
    if ((c.props.locked || "false") !== lockedProp) {
      c.props.locked = lockedProp;
      this.stateChanged(x, y, z);
    }
    if (locked) return;
    const input = this.repeaterInput(c, x, y, z);
    const powered = c.props.powered === "true";
    if (input !== powered && !this.hasTick(x, y, z)) {
      const delay = parseInt(c.props.delay || "1", 10);
      this.scheduleTick(x, y, z, delay * 2, this.repeaterPrio(c, x, y, z));
    }
  }
  repeaterTick(c, x, y, z) {
    if (this.repeaterLocked(c, x, y, z)) return;
    const input = this.repeaterInput(c, x, y, z);
    const powered = c.props.powered === "true";
    if (powered && !input) {
      c.props.powered = "false";
      this.repeaterOutputChanged(c, x, y, z);
    } else if (!powered) {
      c.props.powered = "true";
      // Puls-Garantie: auch ein 1-GT-Eingangspuls erzeugt einen vollen
      // Ausgangspuls — das Abschalten wird VOR den Output-Updates
      // geplant, sonst plant das synchrone Selbst-Update doppelt.
      if (!input) {
        const delay = parseInt(c.props.delay || "1", 10);
        this.scheduleTick(x, y, z, delay * 2, PRIO_VERY_HIGH);
      }
      this.repeaterOutputChanged(c, x, y, z);
    }
  }
  repeaterOutputChanged(c, x, y, z) {
    this.stateChanged(x, y, z);
    this.updateNeighbors(x, y, z);
    const d = DIRS[OPPOSITE[c.props.facing || "north"]];
    this.updateNeighbors(x + d[0], y + d[1], z + d[2]); // stark gepowerter Block
  }

  // ---- Komparator ----------------------------------------------
  containerSignal(cell) {
    if (!cell) return -1;
    if (cell.name.endsWith("composter")) return parseInt(cell.props.level || "0", 10);
    if (cell.name.endsWith("target")) return parseInt(cell.props.power || "0", 10);
    if (/cake$/.test(cell.name)) return 14 - 2 * parseInt(cell.props.bites || "0", 10);
    return -1;
  }
  comparatorRead(x, y, z, dirName, isSide) {
    const d = DIRS[dirName];
    const nx = x + d[0], ny = y + d[1], nz = z + d[2];
    const cell = this.get(nx, ny, nz);
    if (!cell) return 0;
    const n = cell.name;
    if (isWire(n)) return parseInt(cell.props.power || "0", 10);
    if (n.endsWith("redstone_block")) return 15;
    if (isRepeater(n) && cell.props.powered === "true"
      && (cell.props.facing || "north") === dirName) return 15;
    if (isComparator(n) && (cell.props.facing || "north") === dirName) return cell._out || 0;
    if (isSide) return 0;
    // ab hier: nur der Rück-Eingang
    if (isTorch(n) && cell.props.lit !== "false") return 15;
    if ((n.endsWith("lever") || n.endsWith("_button") || n.endsWith("tripwire_hook"))
      && cell.props.powered === "true") return 15;
    if (isObserver(n) && cell.props.powered === "true"
      && (cell.props.facing || "north") === dirName) return 15;
    const cont = this.containerSignal(cell);
    if (cont >= 0) return cont;
    if (SOLID_ENOUGH(n)) {
      let v = this.blockPowerLevel(nx, ny, nz);
      const cont2 = this.containerSignal(this.get(nx + d[0], ny + d[1], nz + d[2]));
      if (cont2 >= 0) v = Math.max(v, cont2);
      return v;
    }
    return 0;
  }
  comparatorOutput(c, x, y, z) {
    const facing = c.props.facing || "north";
    const rear = this.comparatorRead(x, y, z, facing, false);
    const sd = SIDES_OF[facing];
    const side = Math.max(
      this.comparatorRead(x, y, z, sd[0], true),
      this.comparatorRead(x, y, z, sd[1], true)
    );
    return (c.props.mode === "subtract")
      ? Math.max(0, rear - side)
      : (rear >= side ? rear : 0);
  }
  comparatorUpdate(c, x, y, z) {
    const out = this.comparatorOutput(c, x, y, z);
    if ((c._out || 0) !== out && !this.hasTick(x, y, z)) {
      const outDir = OPPOSITE[c.props.facing || "north"];
      const d = DIRS[outDir];
      const front = this.get(x + d[0], y + d[1], z + d[2]);
      const prio = (front && isDiode(front.name)) ? PRIO_HIGH : PRIO_NORMAL;
      this.scheduleTick(x, y, z, 2, prio);
    }
  }
  comparatorTick(c, x, y, z) {
    const out = this.comparatorOutput(c, x, y, z);
    if ((c._out || 0) === out) return;
    c._out = out;
    c.props.powered = out > 0 ? "true" : "false";
    this.stateChanged(x, y, z);
    this.updateNeighbors(x, y, z);
    const d = DIRS[OPPOSITE[c.props.facing || "north"]];
    this.updateNeighbors(x + d[0], y + d[1], z + d[2]);
  }

  // ---- Beobachter ----------------------------------------------
  // Shape-getrieben: stateChanged() der beobachteten Position ruft
  // observerDetect. Kein Schnappschuss-Vergleich mehr nötig — und
  // bewegte Beobachter pulsen beim Materialisieren über setCell.
  observerDetect(x, y, z) {
    const c = this.get(x, y, z);
    if (!c || !isObserver(c.name)) return;
    if (c.props.powered === "true") return; // pulst gerade schon
    if (!this.hasTick(x, y, z)) this.scheduleTick(x, y, z, 2, PRIO_NORMAL);
  }
  observerTick(c, x, y, z) {
    if (c.props.powered === "true") {
      c.props.powered = "false";
      this.observerOutputChanged(c, x, y, z);
    } else {
      c.props.powered = "true";
      this.observerOutputChanged(c, x, y, z);
      this.scheduleTick(x, y, z, 2, PRIO_NORMAL);
    }
  }
  observerOutputChanged(c, x, y, z) {
    this.stateChanged(x, y, z);
    this.updateNeighbors(x, y, z);
    const d = DIRS[OPPOSITE[c.props.facing || "north"]];
    this.updateNeighbors(x + d[0], y + d[1], z + d[2]);
  }

  // ---- Lampe ---------------------------------------------------
  lampUpdate(c, x, y, z) {
    const powered = this.deviceHasPower(x, y, z);
    const lit = c.props.lit === "true";
    if (powered && !lit) {
      c.props.lit = "true";
      this.stateChanged(x, y, z);
    } else if (!powered && lit && !this.hasTick(x, y, z)) {
      this.scheduleTick(x, y, z, 4, PRIO_NORMAL); // Vanilla: 4 GT Aus-Verzögerung
    }
  }
  lampTick(c, x, y, z) {
    if (!this.deviceHasPower(x, y, z) && c.props.lit === "true") {
      c.props.lit = "false";
      this.stateChanged(x, y, z);
    }
  }

  // ---- Türen / Falltüren / Zauntore ----------------------------
  doorUpdate(c, x, y, z) {
    let input = this.deviceHasPower(x, y, z);
    if (/_door$/.test(c.name)) {
      const oy = c.props.half === "upper" ? y - 1 : y + 1;
      input = input || this.deviceHasPower(x, oy, z);
    }
    const want = input ? "true" : "false";
    if ((c.props.powered || "false") !== want) {
      c.props.powered = want;
      c.props.open = want;
      this.stateChanged(x, y, z);
      // andere Türhälfte synchron halten
      if (/_door$/.test(c.name)) {
        const oy = c.props.half === "upper" ? y - 1 : y + 1;
        const other = this.get(x, oy, z);
        if (other && /_door$/.test(other.name) && other.props.open !== want) {
          other.props.open = want;
          other.props.powered = want;
          this.stateChanged(x, oy, z);
        }
      }
    }
  }

  // ---- Notenblock ----------------------------------------------
  noteUpdate(c, x, y, z) {
    const below = this.get(x, y - 1, z);
    const inst = noteInstrument(below ? below.name : "minecraft:air");
    if ((c.props.instrument || "harp") !== inst) {
      c.props.instrument = inst;
      this.stateChanged(x, y, z);
    }
    const want = this.deviceHasPower(x, y, z) ? "true" : "false";
    if ((c.props.powered || "false") !== want) {
      c.props.powered = want;
      this.stateChanged(x, y, z);
    }
  }

  // ---- Schienen ------------------------------------------------
  railChainPowered(x, y, z) {
    const c = this.get(x, y, z);
    if (!c) return false;
    const railType = c.name.endsWith("powered_rail") ? "powered_rail" : "activator_rail";
    const seen = new Set();
    const bfs = [[x, y, z, 0]];
    seen.add(this.idx(x, y, z));
    for (let qi = 0; qi < bfs.length; qi++) {
      const [cx, cy, cz, depth] = bfs[qi];
      if (this.deviceHasPower(cx, cy, cz)) return true;
      if (depth >= 8) continue;
      for (const s of HORIZONTAL) {
        const d = DIRS[s];
        for (const dy of [0, 1, -1]) {
          const nx = cx + d[0], ny = cy + dy, nz = cz + d[2];
          const nb = this.get(nx, ny, nz);
          if (nb && nb.name.endsWith(railType) && !seen.has(this.idx(nx, ny, nz))) {
            seen.add(this.idx(nx, ny, nz));
            bfs.push([nx, ny, nz, depth + 1]);
          }
        }
      }
    }
    return false;
  }
  railUpdate(c, x, y, z) {
    const want = this.railChainPowered(x, y, z) ? "true" : "false";
    if ((c.props.powered || "false") !== want) {
      c.props.powered = want;
      this.stateChanged(x, y, z);
      // Kette weiterreichen: Nachbar-Schienen updaten
      for (const s of HORIZONTAL) {
        const d = DIRS[s];
        for (const dy of [0, 1, -1]) {
          const nb = this.get(x + d[0], y + dy, z + d[2]);
          if (nb && /powered_rail$|activator_rail$/.test(nb.name))
            this.neighborUpdate(x + d[0], y + dy, z + d[2]);
        }
      }
    }
  }

  // ---- Leafstone -----------------------------------------------
  leafDistanceWant(x, y, z) {
    let best = Infinity;
    for (const s of SIDES) {
      const d = DIRS[s];
      const nb = this.get(x + d[0], y + d[1], z + d[2]);
      if (!nb) continue;
      if (/_log$|_wood$|_stem$|_hyphae$/.test(nb.name)) best = 0;
      else if (/_leaves$/.test(nb.name)) best = Math.min(best, parseInt(nb.props.distance || "7", 10));
    }
    return Math.min(7, best + 1);
  }
  leafUpdate(c, x, y, z) {
    const want = String(this.leafDistanceWant(x, y, z));
    if ((c.props.distance || "7") !== want && !this.hasTick(x, y, z))
      this.scheduleTick(x, y, z, 1, PRIO_NORMAL); // Welle: 1 Block pro GT
  }
  leafTick(c, x, y, z) {
    const want = String(this.leafDistanceWant(x, y, z));
    if ((c.props.distance || "7") === want) return;
    c.props.distance = want;
    this.stateChanged(x, y, z);
    this.updateNeighbors(x, y, z);
  }

  // ---- Stolperdraht --------------------------------------------
  // Bei Änderung einer Schnur: beide Haken der Linie neu bewerten
  tripwireLineChanged(x, y, z) {
    for (const axis of [["west", "east"], ["north", "south"]]) {
      for (const s of axis) {
        const d = DIRS[s];
        for (let i = 1; i <= 41; i++) {
          const cell = this.get(x + d[0] * i, y, z + d[2] * i);
          if (!cell) break;
          if (cell.name.endsWith("tripwire_hook")) {
            this.neighborUpdate(x + d[0] * i, y, z + d[2] * i);
            break;
          }
          if (!cell.name.endsWith("tripwire")) break;
        }
      }
    }
    this.updateNeighbors(x, y, z);
  }
  hookUpdate(c, x, y, z) {
    const d = DIRS[c.props.facing || "north"];
    let anyPowered = false, count = 0;
    for (let i = 1; i <= 40; i++) {
      const cell = this.get(x + d[0] * i, y, z + d[2] * i);
      if (!cell || !cell.name.endsWith("tripwire")) break;
      count++;
      if (cell.props.powered === "true") anyPowered = true;
    }
    const broke = c._twCount !== undefined && count < c._twCount && !this.settling;
    c._twCount = count;
    const want = (broke || anyPowered) ? "true" : "false";
    if ((c.props.powered || "false") !== want) {
      c.props.powered = want;
      this.stateChanged(x, y, z);
      this.updateNeighbors(x, y, z);
      const a = DIRS[OPPOSITE[c.props.facing || "north"]];
      this.updateNeighbors(x + a[0], y + a[1], z + a[2]);
      if (broke) this.scheduleTick(x, y, z, 10);
    }
  }

  // ---- Kolben --------------------------------------------------
  isFragile(name) {
    return /wire|torch|lever|button|pressure_plate|rail|tripwire|ladder|scaffolding|carpet|snow$|leaves$|repeater$|comparator$/.test(name);
  }
  isImmovable(cell) {
    return /obsidian|bedrock|furnace|chest|barrel|hopper|dispenser|dropper|jukebox|spawner|enchanting|beacon|piston_head|anvil|respawn_anchor|reinforced_deepslate|lectern|_sign$|_banner$|_skull$|_head$|end_portal_frame|moving_piston$/.test(cell.name)
      || (/^minecraft:(sticky_)?piston$/.test(cell.name) && cell.props.extended === "true");
  }

  // Soll dieser Kolben ausgefahren sein? (inkl. Quasi-Konnektivität)
  pistonShouldExtend(c, x, y, z) {
    const facing = c.props.facing || "north";
    // direkter Strom: alle Seiten außer der Vorderseite
    if (this.deviceHasPower(x, y, z, facing)) return true;
    // QC: Position über dem Kolben (nicht für aufwärts zeigende)
    if (facing !== "up" && this.inside(x, y + 1, z)) {
      if (this.deviceHasPower(x, y + 1, z, "down")) return true;
    }
    return false;
  }

  // WICHTIG: nur bei Block-Updates aufgerufen → BUD-Verhalten gratis.
  // Der Kolben schaltet nicht sofort, sondern legt ein BLOCK-EVENT an,
  // das am Ende des Game-Ticks verarbeitet wird (Vanilla-Verhalten).
  pistonUpdate(c, x, y, z) {
    const want = this.pistonShouldExtend(c, x, y, z);
    const extended = c.props.extended === "true";
    if (want && !extended) this.addBlockEvent(x, y, z, true);
    else if (!want && extended) this.addBlockEvent(x, y, z, false);
  }

  executeBlockEvent(ev) {
    const c = this.get(ev.x, ev.y, ev.z);
    if (!c || !isPiston(c.name)) return;
    const { x, y, z } = ev;
    const facing = c.props.facing || "north";
    const d = DIRS[facing];
    const should = this.pistonShouldExtend(c, x, y, z);
    const extended = c.props.extended === "true";

    if (ev.extend) {
      if (!should || extended) return; // Situation hat sich geändert
      // läuft vor dem Kolben noch eine Bewegung? → sofort abschließen
      // (kurzer Puls vollendet die Bewegung augenblicklich)
      this.finishMotionAt(x + d[0], y + d[1], z + d[2]);
      if (this.tryExtend(x, y, z, c, d)) {
        c.props.extended = "true";
        this.stateChanged(x, y, z);
        this.updateNeighbors(x, y, z);
      }
    } else {
      if (should || !extended) return;
      this.retract(x, y, z, c, d, c.name.includes("sticky"));
      c.props.extended = "false";
      this.stateChanged(x, y, z);
      this.updateNeighbors(x, y, z);
    }
  }

  // Eine laufende moving_piston-Bewegung an dieser Position sofort beenden
  finishMotionAt(x, y, z) {
    const cell = this.get(x, y, z);
    if (!cell || cell.name !== "minecraft:moving_piston" || !cell._payload) return;
    const group = cell._motionGroup || [[x, y, z]];
    for (const [mx, my, mz] of group) {
      const mc = this.get(mx, my, mz);
      if (!mc || mc.name !== "minecraft:moving_piston" || !mc._payload) continue;
      const payload = mc._payload;
      delete mc._payload;
      delete mc._motionGroup;
      this.setCell(mx, my, mz, payload.name, payload.props);
      // Bewegte Beobachter: pulsen nach der Ankunft (wie im Spiel).
      // War der Beobachter beim Bewegen noch gepowert, ist sein alter
      // Abschalt-Tick verloren — neu planen, sonst hängt er ewig an.
      if (isObserver(payload.name) && !this.hasTick(mx, my, mz))
        this.scheduleTick(mx, my, mz, 2, PRIO_NORMAL);
      this.updateNeighbors(mx, my, mz);
    }
  }

  // Startet eine Bewegung: Quellblöcke verschwinden sofort, Ziele sind
  // 2 GT lang moving_piston (unverschiebbar, nicht leitend), dann
  // materialisieren die Blöcke und feuern Block-Updates.
  startMotion(group, d) {
    group.sort((a, b) =>
      (b[0] * d[0] + b[1] * d[1] + b[2] * d[2]) - (a[0] * d[0] + a[1] * d[1] + a[2] * d[2]));
    const moving = [];
    for (const [x, y, z] of group) {
      const src = this.get(x, y, z);
      const dst = this.get(x + d[0], y + d[1], z + d[2]);
      const payload = { name: src.name, props: { ...src.props } };
      const crushedTripwire = dst.name.endsWith("tripwire");
      src.name = "minecraft:air"; src.props = {};
      this.stateChanged(x, y, z);
      dst.name = "minecraft:moving_piston";
      dst.props = {};
      dst._payload = payload;
      this.stateChanged(x + d[0], y + d[1], z + d[2]);
      // Überschriebener Stolperdraht: Haken der Linie benachrichtigen
      if (crushedTripwire) this.tripwireLineChanged(x + d[0], y + d[1], z + d[2]);
      moving.push([x + d[0], y + d[1], z + d[2]]);
    }
    for (const [mx, my, mz] of moving) {
      const mc = this.get(mx, my, mz);
      if (mc) mc._motionGroup = moving;
    }
    // Quell-Positionen updaten (Blöcke sind weg)
    for (const [x, y, z] of group) this.updateNeighbors(x, y, z);
    for (const [mx, my, mz] of moving) this.updateNeighbors(mx, my, mz);
    if (this.settling) {
      for (const [mx, my, mz] of moving) this.finishMotionAt(mx, my, mz);
    } else {
      // Ankunft in 2 GT in der Bewegungs-Phase (nach den Block-Events)
      this.motions.push({ at: this.gameTick + 2, group: moving });
    }
  }

  collectGroup(sx, sy, sz, d, exclude) {
    const set = new Map();
    const stack = [[sx, sy, sz]];
    while (stack.length) {
      const [x, y, z] = stack.pop();
      const key = x + "," + y + "," + z;
      if (set.has(key)) continue;
      const cell = this.get(x, y, z);
      if (!cell) return null;
      if (cell.name === "minecraft:air" || this.isFragile(cell.name)) continue;
      if (this.isImmovable(cell)) return null;
      set.set(key, [x, y, z]);
      if (set.size > 12) return null;

      const tx = x + d[0], ty = y + d[1], tz = z + d[2];
      const target = this.get(tx, ty, tz);
      if (!target) return null;
      if (target.name !== "minecraft:air" && !this.isFragile(target.name)) {
        if (tx + "," + ty + "," + tz === exclude) return null;
        stack.push([tx, ty, tz]);
      }

      const isSlime = /slime_block$/.test(cell.name);
      const isHoney = /honey_block$/.test(cell.name);
      if (isSlime || isHoney) {
        for (const s of SIDES) {
          const dd = DIRS[s];
          const nx = x + dd[0], ny = y + dd[1], nz = z + dd[2];
          if (nx + "," + ny + "," + nz === exclude) continue;
          const nb = this.get(nx, ny, nz);
          if (!nb || nb.name === "minecraft:air" || this.isFragile(nb.name) || this.isImmovable(nb)) continue;
          if (isSlime && /honey_block$/.test(nb.name)) continue;
          if (isHoney && /slime_block$/.test(nb.name)) continue;
          stack.push([nx, ny, nz]);
        }
      }
    }
    return [...set.values()];
  }

  tryExtend(x, y, z, c, d) {
    const front = this.get(x + d[0], y + d[1], z + d[2]);
    if (!front) return false;
    if (front.name === "minecraft:moving_piston") return false;
    if (front.name !== "minecraft:air" && !this.isFragile(front.name)) {
      const group = this.collectGroup(x + d[0], y + d[1], z + d[2], d, x + "," + y + "," + z);
      if (group === null) return false;
      this.startMotion(group, d);
    } else if (front.name !== "minecraft:air" && this.isFragile(front.name)) {
      // Zerbrechliches wird zerstört
      const wasTripwire = front.name.endsWith("tripwire");
      this.setCell(x + d[0], y + d[1], z + d[2], "minecraft:air", {});
      this.updateNeighbors(x + d[0], y + d[1], z + d[2]);
      if (wasTripwire) this.tripwireLineChanged(x + d[0], y + d[1], z + d[2]);
    }
    const head = this.get(x + d[0], y + d[1], z + d[2]);
    head.name = "minecraft:piston_head";
    head.props = { facing: c.props.facing || "north", short: "false", type: c.name.includes("sticky") ? "sticky" : "normal" };
    this.stateChanged(x + d[0], y + d[1], z + d[2]);
    this.updateNeighbors(x + d[0], y + d[1], z + d[2]);
    return true;
  }

  retract(x, y, z, c, d, sticky) {
    const front = this.get(x + d[0], y + d[1], z + d[2]);
    if (!front || front.name !== "minecraft:piston_head") return;
    this.setCell(x + d[0], y + d[1], z + d[2], "minecraft:air", {});
    this.updateNeighbors(x + d[0], y + d[1], z + d[2]);

    if (sticky) {
      const bx = x + d[0] * 2, by = y + d[1] * 2, bz = z + d[2] * 2;
      const beyond = this.get(bx, by, bz);
      // 0-Tick "block dropping": bewegt sich der Block dahinter noch,
      // wird er NICHT mitgezogen — der Kolben lässt ihn fallen.
      if (beyond && beyond.name === "minecraft:moving_piston") return;
      if (beyond && beyond.name !== "minecraft:air"
        && !this.isFragile(beyond.name) && !this.isImmovable(beyond)) {
        const back = [-d[0], -d[1], -d[2]];
        const group = this.collectGroup(bx, by, bz, back, x + "," + y + "," + z);
        if (group !== null) this.startMotion(group, back);
      }
    }
  }
}

// In Node (Tests) und im Browser nutzbar
if (typeof module !== "undefined") module.exports = { RedstoneSim };
