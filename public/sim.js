// ---------------------------------------------------------------
// REDSTONE-SIMULATION (Stufe 1)
// Tick-basierte Engine, bewusst vereinfachte Minecraft-Regeln:
//   - Quellen: Hebel, Knöpfe (mit Ablaufzeit), Redstoneblock,
//     Fackeln, Verstärker-Ausgang
//   - Redstonestaub leitet mit Signalabfall (15 → 0), auch
//     diagonal hoch/runter
//   - Fackeln invertieren ihren Halteblock (1 Redstone-Tick)
//   - Verstärker: gerichtete Weiterleitung mit 1–4 RT Verzögerung
//   - Lampen leuchten, Beobachter pulsen bei Nachbar-Änderung,
//     Kolben fahren aus (schieben aber noch keine Blöcke — Stufe 2)
// 1 Redstone-Tick (RT) = 2 Game-Ticks (GT). tick() = 1 GT.
//
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
// Seiten-Richtungen von Verstärkern/Komparatoren, abhängig vom facing
const SIDES_OF = {
  north: ["east", "west"], south: ["east", "west"],
  east: ["north", "south"], west: ["north", "south"]
};

// Welches Instrument ein Notenblock hat, bestimmt der Block darunter.
// Grobe Zuordnung der wichtigsten Fälle — entscheidend ist nur, dass
// sich der Wert ÄNDERT, wenn sich der Block darunter ändert.
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

class RedstoneSim {
  constructor(grid) {
    const [W, H, D] = grid.size;
    this.W = W; this.H = H; this.D = D;
    this.gameTick = 0;
    this.onChange = null;          // Callback fürs Rendering
    this.pending = [];             // geplante Zustandswechsel [{at, fn}]
    this.changed = new Set();      // Positionen, die sich diesen Tick änderten

    // Zellen als eigenständige Objekte (Kopie der Palette-Daten),
    // damit die Simulation Properties ändern kann
    this.cells = grid.blocks.map(i => {
      const p = grid.palette[i];
      return { name: p.name, props: { ...p.props } };
    });
    this.initial = grid;           // fürs Reset

    this.prevChanged = new Set(); // Änderungen des VORHERIGEN Ticks (für Block-Updates)
    this.settling = false;
    this.initObservers();
  }

  // Beobachter: Anfangszustand der beobachteten Nachbarn merken
  initObservers() {
    this.observed = new Map();
    this.eachCell((c, x, y, z) => {
      if (c.name.endsWith("observer")) {
        const d = DIRS[c.props.facing || "north"];
        this.observed.set(this.idx(x, y, z), this.snapshot(x + d[0], y + d[1], z + d[2]));
      }
    });
  }

  // Einschwingen nach dem Laden: Schematics speichern oft "mitten im
  // Signal" (Staub mit Restwert, gepowerte Verstärker). Ein paar
  // stille Ticks normalisieren das — ohne dass Beobachter auf diese
  // Pseudo-Änderungen pulsen und die Maschine von selbst losläuft.
  settle(ticks = 12) {
    this.settling = true;
    for (let i = 0; i < ticks; i++) this.tick();
    this.settling = false;
    this.pending = [];
    this.gameTick = 0;
  }

  // Gab es im letzten Tick eine Änderung direkt neben (oder auf)
  // dieser Position? Das ist unser "Block-Update".
  neighborChanged(x, y, z) {
    if (this.prevChanged.has(x + "," + y + "," + z)) return true;
    for (const s of SIDES) {
      const d = DIRS[s];
      if (this.prevChanged.has((x + d[0]) + "," + (y + d[1]) + "," + (z + d[2]))) return true;
    }
    return false;
  }

  idx(x, y, z) { return (y * this.D + z) * this.W + x; }
  // Nur was hier gemeldet wird, baut der Viewer neu — das ist der
  // Schlüssel gegen Ruckeln bei großen Maschinen
  markChanged(x, y, z) { this.changed.add(x + "," + y + "," + z); }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D; }
  get(x, y, z) { return this.inside(x, y, z) ? this.cells[this.idx(x, y, z)] : null; }
  snapshot(x, y, z) { const c = this.get(x, y, z); return c ? c.name + JSON.stringify(c.props) : ""; }
  eachCell(fn) {
    for (let y = 0; y < this.H; y++) for (let z = 0; z < this.D; z++) for (let x = 0; x < this.W; x++)
      fn(this.cells[this.idx(x, y, z)], x, y, z);
  }

  reset() {
    this.cells = this.initial.blocks.map(i => {
      const p = this.initial.palette[i];
      return { name: p.name, props: { ...p.props } };
    });
    this.pending = [];
    this.gameTick = 0;
    this.changed.clear();
    this.prevChanged.clear();
    this.initObservers();
    if (this.onChange) this.onChange();
  }

  // ---- Interaktion ---------------------------------------------
  // Klick auf Hebel/Knopf. Gibt true zurück, wenn etwas passierte.
  interact(x, y, z) {
    const c = this.get(x, y, z);
    if (!c) return false;
    if (c.name.endsWith("lever")) {
      c.props.powered = c.props.powered === "true" ? "false" : "true";
      this.markChanged(x, y, z);
      return true;
    }
    if (c.name.endsWith("_button") && c.props.powered !== "true") {
      c.props.powered = "true";
      this.markChanged(x, y, z);
      const dauer = c.name.includes("stone") ? 20 : 30; // GT
      this.schedule(dauer, () => { c.props.powered = "false"; this.markChanged(x, y, z); });
      return true;
    }
    // Klick auf einen Stolperdraht = "eine Entität läuft durch"
    // (echte Mobs/Spieler gibt es in der Simulation nicht)
    if (c.name.endsWith("tripwire") && c.props.powered !== "true") {
      c.props.powered = "true";
      this.markChanged(x, y, z);
      this.schedule(10, () => { c.props.powered = "false"; this.markChanged(x, y, z); });
      return true;
    }
    return false;
  }

  schedule(inGT, fn) { this.pending.push({ at: this.gameTick + inGT, fn }); }

  // ---- Leistungsberechnung -------------------------------------
  // Jeder Tick rechnet die Stromverteilung komplett neu (einfach
  // und robust, für Maschinen-Größen völlig schnell genug).
  // Jetzt ANALOG: Blöcke merken sich, mit welcher STÄRKE sie
  // gepowert sind (zwei Maps statt eines Sets). Komparatoren können
  // so echte Signalstärken lesen, subtrahieren und weitergeben —
  // die Grundlage für analoge Sequenzer wie in großen Türen.
  computePower() {
    const dust = new Map();    // idx → Signalstärke 0-15
    const strong = new Map();  // stark gepowerte Blöcke (speisen Staub, Stärke bleibt erhalten)
    const weak = new Map();    // schwach gepowerte Blöcke (aktivieren nur Geräte / sind lesbar)
    const queue = [];

    const setMax = (m, i, v) => { if ((m.get(i) || 0) < v) { m.set(i, v); return true; } return false; };
    const feedBlock = (x, y, z, s = 15) => {
      const c = this.get(x, y, z);
      if (c && SOLID_ENOUGH(c.name)) setMax(strong, this.idx(x, y, z), s);
    };
    const feedDust = (x, y, z, strength) => {
      const c = this.get(x, y, z);
      if (c && c.name.endsWith("redstone_wire")) {
        if (setMax(dust, this.idx(x, y, z), strength)) queue.push([x, y, z, strength]);
      }
    };
    const feedAround = (x, y, z, strength) => {
      for (const s of SIDES) { const d = DIRS[s]; feedDust(x + d[0], y + d[1], z + d[2], strength); }
    };

    // 1. Quellen einsammeln
    this.eachCell((c, x, y, z) => {
      const n = c.name;
      if (n.endsWith("redstone_block")) { feedAround(x, y, z, 15); }
      else if (n.endsWith("lever") && c.props.powered === "true") {
        feedAround(x, y, z, 15); feedBlock(...this.attachedTo(c, x, y, z));
      }
      else if (n.endsWith("_button") && c.props.powered === "true") {
        feedAround(x, y, z, 15); feedBlock(...this.attachedTo(c, x, y, z));
      }
      else if ((n.endsWith("redstone_torch") || n.endsWith("redstone_wall_torch")) && c.props.lit !== "false") {
        feedAround(x, y, z, 15); feedBlock(x, y + 1, z); // Fackel powert Block darüber stark
      }
      else if (n.endsWith("repeater") && c.props.powered === "true") {
        const out = OPPOSITE[c.props.facing || "north"]; // facing zeigt zum Eingang
        const d = DIRS[out];
        feedDust(x + d[0], y + d[1], z + d[2], 15);
        feedBlock(x + d[0], y + d[1], z + d[2]);
      }
      else if (n.endsWith("comparator")) {
        // Komparator gibt seine BERECHNETE Stärke weiter (nicht 15!)
        const out = c._out || 0;
        if (out > 0) {
          const d = DIRS[OPPOSITE[c.props.facing || "north"]];
          feedDust(x + d[0], y + d[1], z + d[2], out);
          feedBlock(x + d[0], y + d[1], z + d[2], out);
        }
      }
      else if (n.endsWith("observer") && c.props.powered === "true") {
        // Ausgang ist die Rückseite (gegenüber dem beobachtenden Gesicht)
        const d = DIRS[OPPOSITE[c.props.facing || "north"]];
        feedDust(x + d[0], y + d[1], z + d[2], 15);
        feedBlock(x + d[0], y + d[1], z + d[2]);
      }
      else if (n.endsWith("tripwire_hook") && c.props.powered === "true") {
        // ausgelöster Haken: powert Umgebung + seinen Halteblock stark
        feedAround(x, y, z, 15);
        const d = DIRS[OPPOSITE[c.props.facing || "north"]];
        feedBlock(x + d[0], y + d[1], z + d[2]);
      }
    });

    // 2. Stark gepowerte Blöcke speisen angrenzenden Staub —
    // mit ihrer eigenen Stärke (Komparator 7 → Staub 7)
    for (const [i, s] of strong) {
      const y = Math.floor(i / (this.D * this.W));
      const z = Math.floor((i % (this.D * this.W)) / this.W);
      const x = i % this.W;
      feedAround(x, y, z, s);
    }

    // 3. Staub breitet sich aus (BFS mit Abfall, auch diagonal ±1 Höhe).
    // Kein queue.shift() — das wäre O(n²); wir laufen mit einem
    // Lesezeiger über das Array.
    for (let qi = 0; qi < queue.length; qi++) {
      const [x, y, z, s] = queue[qi];
      // Staub powert Nachbarblöcke SCHWACH — mit seiner Stärke, damit
      // Komparatoren sie durch den Block hindurch lesen können.
      // Schwache Powerung speist keinen neuen Staub, sonst würde sich
      // das Signal endlos selbst verstärken.
      for (const side of [...HORIZONTAL, "down"]) {
        const d = DIRS[side];
        const nb = this.get(x + d[0], y + d[1], z + d[2]);
        if (nb && SOLID_ENOUGH(nb.name)) setMax(weak, this.idx(x + d[0], y + d[1], z + d[2]), s);
      }
      if (s <= 1) continue;

      // Blockierungsregeln wie im Spiel (vereinfacht):
      // hoch nur, wenn über dem Staub kein Block liegt;
      // runter nur, wenn die Kante frei ist (kein Block daneben)
      const above = this.get(x, y + 1, z);
      const upBlocked = above && SOLID_ENOUGH(above.name);
      for (const side of HORIZONTAL) {
        const d = DIRS[side];
        feedDust(x + d[0], y, z + d[2], s - 1);
        if (!upBlocked) feedDust(x + d[0], y + 1, z + d[2], s - 1); // Treppe hoch
        const edge = this.get(x + d[0], y, z + d[2]);
        if (!edge || !SOLID_ENOUGH(edge.name)) feedDust(x + d[0], y - 1, z + d[2], s - 1); // Treppe runter
      }
    }

    return { dust, strong, weak };
  }

  // Wie stark ist dieser Block gepowert (egal ob stark oder schwach)?
  powerLevel(power, i) {
    return Math.max(power.strong.get(i) || 0, power.weak.get(i) || 0);
  }

  // Signal, das ein Behälter/Spezialblock für Komparatoren liefert.
  // -1 = das ist gar kein lesbarer Block.
  containerSignal(cell) {
    if (!cell) return -1;
    if (cell.name.endsWith("composter")) return parseInt(cell.props.level || "0", 10);
    if (cell.name.endsWith("target")) return parseInt(cell.props.power || "0", 10);
    if (/cake$/.test(cell.name)) return 14 - 2 * parseInt(cell.props.bites || "0", 10);
    return -1;
  }

  // Welche Signalstärke fließt aus Richtung `dirName` in die Position
  // (x,y,z)? Für Komparator-Eingänge: hinten liest fast alles
  // (inkl. Behälter, auch durch EINEN Block hindurch), die Seiten
  // nur Staub, Verstärker, Komparatoren und Redstoneblöcke.
  signalToward(x, y, z, dirName, power, isSide) {
    const d = DIRS[dirName];
    const nx = x + d[0], ny = y + d[1], nz = z + d[2];
    const cell = this.get(nx, ny, nz);
    if (!cell) return 0;
    const i = this.idx(nx, ny, nz);

    if (cell.name.endsWith("redstone_wire")) return power.dust.get(i) || 0;
    if (cell.name.endsWith("redstone_block")) return 15;
    if (cell.name.endsWith("repeater") && cell.props.powered === "true"
      && (cell.props.facing || "north") === dirName) return 15;
    if (cell.name.endsWith("comparator") && (cell.props.facing || "north") === dirName)
      return cell._out || 0;
    if (isSide) return 0;

    // ab hier: nur der Rück-Eingang
    if ((cell.name.endsWith("redstone_torch") || cell.name.endsWith("redstone_wall_torch"))
      && cell.props.lit !== "false") return 15;
    if ((cell.name.endsWith("lever") || cell.name.endsWith("_button") || cell.name.endsWith("tripwire_hook"))
      && cell.props.powered === "true") return 15;
    if (cell.name.endsWith("observer") && cell.props.powered === "true"
      && (cell.props.facing || "north") === dirName) return 15;

    const cont = this.containerSignal(cell);
    if (cont >= 0) return cont;

    if (SOLID_ENOUGH(cell.name)) {
      let v = this.powerLevel(power, i);
      // Behälter hinter dem Block: Komparatoren lesen durch EINEN Block
      const cont2 = this.containerSignal(this.get(nx + d[0], ny + d[1], nz + d[2]));
      if (cont2 >= 0) v = Math.max(v, cont2);
      return v;
    }
    return 0;
  }

  // ---- Kolben-Mechanik -----------------------------------------
  // Zerbrechlich: wird beim Schieben zerstört (wie im Spiel)
  isFragile(name) {
    return /wire|torch|lever|button|pressure_plate|rail|tripwire|ladder|scaffolding|carpet|snow$|leaves$|repeater$|comparator$/.test(name);
  }
  // Unbeweglich: blockiert den Kolben komplett. Faustregel im Spiel:
  // Blöcke mit Block-Entity (Truhen, Öfen …) plus Härtefälle wie
  // Obsidian und Bedrock. Ausnahme: Shulker-Kisten sind beweglich —
  // deshalb steht "shulker" hier bewusst NICHT drin.
  isImmovable(cell) {
    return /obsidian|bedrock|furnace|chest|barrel|hopper|dispenser|dropper|jukebox|spawner|enchanting|beacon|piston_head|anvil|respawn_anchor|reinforced_deepslate|lectern|_sign$|_banner$|_skull$|_head$|end_portal_frame|moving_piston$/.test(cell.name)
      || (/^minecraft:(sticky_)?piston$/.test(cell.name) && cell.props.extended === "true");
  }

  // Startet eine Bewegung: die Gruppenblöcke verschwinden sofort,
  // an den Zielpositionen liegt 2 GT lang "moving_piston" (Minecrafts
  // Block 36) — unverschiebbar und nicht leitend. Erst bei Ankunft
  // materialisieren die Blöcke wieder; bewegte Beobachter pulsen
  // dann von selbst (ihr Schnappschuss passt nicht mehr).
  startMotion(group, d) {
    group.sort((a, b) =>
      (b[0] * d[0] + b[1] * d[1] + b[2] * d[2]) - (a[0] * d[0] + a[1] * d[1] + a[2] * d[2]));
    const moving = [];
    for (const [x, y, z] of group) {
      const src = this.get(x, y, z);
      const dst = this.get(x + d[0], y + d[1], z + d[2]);
      dst.name = "minecraft:moving_piston";
      dst.props = {};
      dst._payload = { name: src.name, props: { ...src.props } };
      src.name = "minecraft:air"; src.props = {};
      this.markChanged(x, y, z);
      this.markChanged(x + d[0], y + d[1], z + d[2]);
      moving.push([x + d[0], y + d[1], z + d[2]]);
    }
    const finish = () => {
      for (const [mx, my, mz] of moving) {
        const cell = this.get(mx, my, mz);
        if (!cell || cell.name !== "minecraft:moving_piston") continue;
        cell.name = cell._payload.name;
        cell.props = cell._payload.props;
        delete cell._payload;
        this.markChanged(mx, my, mz);
      }
    };
    if (this.settling) finish(); else this.schedule(2, finish);
  }

  // Sammelt die Gruppe von Blöcken, die sich zusammen bewegen muss.
  // Startet beim Block vor dem Kolben; Schleim-/Honigblöcke ziehen
  // ihre Nachbarn mit in die Gruppe. Für jeden Gruppenblock muss
  // auch sein Zielfeld frei sein — oder der Block dort gehört selbst
  // zur Gruppe. Max. 12 Blöcke, sonst schlägt die Bewegung fehl.
  // Gibt die Positionsliste zurück, oder null wenn unmöglich.
  // `exclude` ist die Position des Kolbens selbst: Schleim darf ihn
  // nicht mit in die Gruppe ziehen — sonst schiebt sich der Kolben
  // selbst weg und der Kopf überschreibt die Basis!
  collectGroup(sx, sy, sz, d, exclude) {
    const set = new Map();
    const stack = [[sx, sy, sz]];
    while (stack.length) {
      const [x, y, z] = stack.pop();
      const key = x + "," + y + "," + z;
      if (set.has(key)) continue;
      const cell = this.get(x, y, z);
      if (!cell) return null; // Rand der Schematic
      if (cell.name === "minecraft:air" || this.isFragile(cell.name)) continue;
      if (this.isImmovable(cell)) return null;
      set.set(key, [x, y, z]);
      if (set.size > 12) return null;

      // Zielfeld: liegt dort ein fester Block, muss er mitgeschoben werden
      const tx = x + d[0], ty = y + d[1], tz = z + d[2];
      const target = this.get(tx, ty, tz);
      if (!target) return null;
      if (target.name !== "minecraft:air" && !this.isFragile(target.name)) {
        if (tx + "," + ty + "," + tz === exclude) return null; // gegen den Kolben gedrückt
        stack.push([tx, ty, tz]);
      }

      // Schleim/Honig klebt an allen Nachbarn (unbewegliche werden
      // einfach nicht mitgenommen — nur der Schubpfad ist Pflicht).
      // WICHTIG: Schleim und Honig kleben NICHT aneinander — so
      // trennt man z. B. die Motoren von Flugmaschinen!
      const isSlime = /slime_block$/.test(cell.name);
      const isHoney = /honey_block$/.test(cell.name);
      if (isSlime || isHoney) {
        for (const s of SIDES) {
          const dd = DIRS[s];
          const nx = x + dd[0], ny = y + dd[1], nz = z + dd[2];
          if (nx + "," + ny + "," + nz === exclude) continue; // klebt nicht am Kolben
          const nb = this.get(nx, ny, nz);
          if (!nb || nb.name === "minecraft:air" || this.isFragile(nb.name) || this.isImmovable(nb)) continue;
          if (isSlime && /honey_block$/.test(nb.name)) continue; // Schleim ↛ Honig
          if (isHoney && /slime_block$/.test(nb.name)) continue; // Honig ↛ Schleim
          stack.push([nx, ny, nz]);
        }
      }
    }
    return [...set.values()];
  }

  // Bewegt eine Gruppe um einen Schritt in Richtung d.
  // Reihenfolge: die vordersten zuerst, damit sich nichts überschreibt.
  // Bewegte Beobachter pulsen automatisch (ihr Schnappschuss stimmt
  // nicht mehr — genau wie im Spiel, wo Beobachter beim Bewegtwerden feuern).
  moveGroup(group, d) {
    group.sort((a, b) =>
      (b[0] * d[0] + b[1] * d[1] + b[2] * d[2]) - (a[0] * d[0] + a[1] * d[1] + a[2] * d[2]));
    for (const [x, y, z] of group) {
      const src = this.get(x, y, z);
      const dst = this.get(x + d[0], y + d[1], z + d[2]);
      dst.name = src.name; dst.props = { ...src.props };
      src.name = "minecraft:air"; src.props = {};
      this.markChanged(x, y, z);
      this.markChanged(x + d[0], y + d[1], z + d[2]);
    }
  }

  // Ausfahren: Gruppe vor dem Kolben in Bewegung setzen, Kopf setzen
  tryExtend(x, y, z, c, d) {
    const front = this.get(x + d[0], y + d[1], z + d[2]);
    if (!front) return false;
    if (front.name === "minecraft:moving_piston") return false; // dort bewegt sich schon was
    if (front.name !== "minecraft:air" && !this.isFragile(front.name)) {
      const group = this.collectGroup(x + d[0], y + d[1], z + d[2], d, x + "," + y + "," + z);
      if (group === null) return false;
      this.startMotion(group, d);
    }
    front.name = "minecraft:piston_head";
    front.props = { facing: c.props.facing || "north", short: "false", type: c.name.includes("sticky") ? "sticky" : "normal" };
    this.markChanged(x + d[0], y + d[1], z + d[2]);
    return true;
  }

  // Einziehen: Kopf weg; klebrige Kolben ziehen den Block dahinter
  // zurück — hängt Schleim dran, kommt die ganze Gruppe mit
  retract(x, y, z, c, d, sticky) {
    const front = this.get(x + d[0], y + d[1], z + d[2]);
    if (!front || front.name !== "minecraft:piston_head") return;
    front.name = "minecraft:air"; front.props = {};
    this.markChanged(x + d[0], y + d[1], z + d[2]);

    if (sticky) {
      const bx = x + d[0] * 2, by = y + d[1] * 2, bz = z + d[2] * 2;
      const beyond = this.get(bx, by, bz);
      if (beyond && beyond.name !== "minecraft:air"
        && !this.isFragile(beyond.name) && !this.isImmovable(beyond)) {
        const back = [-d[0], -d[1], -d[2]];
        const group = this.collectGroup(bx, by, bz, back, x + "," + y + "," + z);
        if (group !== null) this.startMotion(group, back);
      }
    }
  }

  // Halteblock von Hebel/Knopf bestimmen
  attachedTo(c, x, y, z) {
    const face = c.props.face || "wall";
    if (face === "floor") return [x, y - 1, z];
    if (face === "ceiling") return [x, y + 1, z];
    const d = DIRS[OPPOSITE[c.props.facing || "north"]];
    return [x + d[0], y + d[1], z + d[2]];
  }

  // Bekommt diese Zelle von irgendwo Strom? (für Geräte-Eingänge)
  hasInput(x, y, z, power, onlySide = null) {
    const check = side => {
      const d = DIRS[side];
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      const c = this.get(nx, ny, nz);
      if (!c) return false;
      const i = this.idx(nx, ny, nz);
      if (c.name.endsWith("redstone_wire") && (power.dust.get(i) || 0) > 0) return true;
      if (this.powerLevel(power, i) > 0) return true;
      if (c.name.endsWith("redstone_block")) return true;
      if ((c.name.endsWith("redstone_torch") || c.name.endsWith("redstone_wall_torch")) && c.props.lit !== "false") return true;
      if (c.name.endsWith("lever") && c.props.powered === "true") return true;
      if (c.name.endsWith("_button") && c.props.powered === "true") return true;
      if (c.name.endsWith("tripwire_hook") && c.props.powered === "true") return true;
      if ((c.name.endsWith("repeater") || c.name.endsWith("comparator"))
        && c.props.powered === "true" && OPPOSITE[c.props.facing || "north"] === OPPOSITE[side]) return true;
      return false;
    };
    if (onlySide) return check(onlySide);
    return SIDES.some(check);
  }

  // ---- Ein Game-Tick -------------------------------------------
  tick() {
    this.gameTick++;

    // 1. fällige geplante Änderungen ausführen
    this.pending = this.pending.filter(p => {
      if (p.at <= this.gameTick) { p.fn(); return false; }
      return true;
    });

    // 2. Strom neu berechnen
    const power = this.computePower();

    // 2b. "Leafstone": Blätter speichern ihre Distanz zum nächsten
    // Stamm (1-7). Ändert sich die (z. B. weil ein Kolben den Stamm
    // wegschiebt), wandert die Änderung pro Tick einen Block weiter
    // durch die Blätter — Beobachter erkennen das und machen daraus
    // drahtlose Signalübertragung. Erst alle Zielwerte berechnen,
    // dann anwenden, damit die Welle exakt 1 Block/Tick läuft.
    const leafUpdates = [];
    this.eachCell((c, x, y, z) => {
      if (!/_leaves$/.test(c.name)) return;
      let best = Infinity;
      for (const s of SIDES) {
        const d = DIRS[s];
        const nb = this.get(x + d[0], y + d[1], z + d[2]);
        if (!nb) continue;
        if (/_log$|_wood$|_stem$|_hyphae$/.test(nb.name)) best = 0;
        else if (/_leaves$/.test(nb.name)) best = Math.min(best, parseInt(nb.props.distance || "7", 10));
      }
      const want = String(Math.min(7, best + 1));
      if ((c.props.distance || "7") !== want) leafUpdates.push([c, want, x, y, z]);
    });
    for (const [c, want, x, y, z] of leafUpdates) {
      c.props.distance = want;
      this.markChanged(x, y, z);
    }

    // 2c. Antriebsschienen: direkt aktivierte Schienen geben den
    // Zustand an angrenzende Antriebsschienen weiter — bis zu 8
    // weiter (9 insgesamt), wie im Spiel. Auch an Steigungen (±1 Höhe).
    const rails = [];
    this.eachCell((c, x, y, z) => {
      if (/powered_rail$|activator_rail$/.test(c.name)) rails.push([c, x, y, z]);
    });
    // Wichtig: Antriebs- und Aktivierungsschienen bilden GETRENNTE
    // Ketten — eine Antriebsschiene gibt ihren Zustand nicht an eine
    // Aktivierungsschiene weiter (und umgekehrt), wie im Spiel.
    for (const railType of ["powered_rail", "activator_rail"]) {
      const list = rails.filter(([c]) => c.name.endsWith(railType));
      if (!list.length) continue;
      const on = new Set();
      const bfs = [];
      for (const [, x, y, z] of list) {
        if (this.hasInput(x, y, z, power)) { on.add(this.idx(x, y, z)); bfs.push([x, y, z, 0]); }
      }
      const railAt = (x, y, z) => {
        const c = this.get(x, y, z);
        return c && c.name.endsWith(railType);
      };
      for (let qi = 0; qi < bfs.length; qi++) {
        const [x, y, z, depth] = bfs[qi];
        if (depth >= 8) continue;
        for (const s of HORIZONTAL) {
          const d = DIRS[s];
          for (const dy of [0, 1, -1]) {
            const nx = x + d[0], ny = y + dy, nz = z + d[2];
            if (railAt(nx, ny, nz) && !on.has(this.idx(nx, ny, nz))) {
              on.add(this.idx(nx, ny, nz));
              bfs.push([nx, ny, nz, depth + 1]);
            }
          }
        }
      }
      for (const [c, x, y, z] of list) {
        const want = on.has(this.idx(x, y, z)) ? "true" : "false";
        if ((c.props.powered || "false") !== want) {
          c.props.powered = want;
          this.markChanged(x, y, z);
        }
      }
    }

    // 3. Komponenten reagieren lassen
    this.eachCell((c, x, y, z) => {
      const n = c.name;

      // Staub: sichtbare Signalstärke setzen
      if (n.endsWith("redstone_wire")) {
        const s = String(power.dust.get(this.idx(x, y, z)) || 0);
        if (c.props.power !== s) { c.props.power = s; this.markChanged(x, y, z); }
      }

      // Lampe: an/aus (Ausschalten hat in echt 2 GT Verzögerung)
      else if (n.endsWith("redstone_lamp")) {
        const want = this.hasInput(x, y, z, power) ? "true" : "false";
        if (c.props.lit !== want) {
          if (want === "true") { c.props.lit = "true"; this.markChanged(x, y, z); }
          else this.schedule(2, () => {
            if (!this.hasInput(x, y, z, this.computePower())) {
              c.props.lit = "false"; this.markChanged(x, y, z);
            }
          });
        }
      }

      // Fackel: invertiert ihren Halteblock, 1 RT Verzögerung
      else if (n.endsWith("redstone_torch") || n.endsWith("redstone_wall_torch")) {
        const attach = n.endsWith("wall_torch")
          ? (() => { const d = DIRS[OPPOSITE[c.props.facing || "north"]]; return [x + d[0], y + d[1], z + d[2]]; })()
          : [x, y - 1, z];
        const blockPowered = this.powerLevel(power, this.idx(...attach)) > 0;
        const want = blockPowered ? "false" : "true";
        if ((c.props.lit || "true") !== want && !c._scheduled) {
          c._scheduled = true;
          this.schedule(2, () => { c.props.lit = want; c._scheduled = false; this.markChanged(x, y, z); });
        }
      }

      // Verstärker + Komparator: Eingang hinten (facing-Seite).
      // Verstärker mit 1-4 RT Delay, Komparator fest 1 RT
      // (Subtraktions-Modus und Behälter-Auslesen: Stufe 2)
      else if (n.endsWith("repeater")) {
        // Locking: zeigt ein gepowerter Verstärker/Komparator in die
        // SEITE dieses Verstärkers, friert er dessen Zustand ein
        const facing = c.props.facing || "north";
        const locked = SIDES_OF[facing].some(sname => {
          const d = DIRS[sname];
          const nb = this.get(x + d[0], y + d[1], z + d[2]);
          return nb && (nb.name.endsWith("repeater") || nb.name.endsWith("comparator"))
            && nb.props.powered === "true" && (nb.props.facing || "north") === sname;
        });
        const lockedProp = locked ? "true" : "false";
        if ((c.props.locked || "false") !== lockedProp) { c.props.locked = lockedProp; this.markChanged(x, y, z); }
        if (!locked) {
          const input = this.hasInput(x, y, z, power, facing);
          const want = input ? "true" : "false";
          if ((c.props.powered || "false") !== want && !c._scheduled) {
            const delay = parseInt(c.props.delay || "1", 10);
            c._scheduled = true;
            this.schedule(delay * 2, () => { c.props.powered = want; c._scheduled = false; this.markChanged(x, y, z); });
          }
        }
      }

      // Komparator: rechnet ANALOG. Hinten liest er die volle
      // Signalstärke (auch aus Kompostern/Zielblöcken, sogar durch
      // einen Block hindurch), die Seiten begrenzen oder subtrahieren.
      else if (n.endsWith("comparator")) {
        const facing = c.props.facing || "north";
        const rear = this.signalToward(x, y, z, facing, power, false);
        const sd = SIDES_OF[facing];
        const side = Math.max(
          this.signalToward(x, y, z, sd[0], power, true),
          this.signalToward(x, y, z, sd[1], power, true)
        );
        const out = (c.props.mode === "subtract")
          ? Math.max(0, rear - side)      // Subtraktionsmodus
          : (rear >= side ? rear : 0);    // Vergleichsmodus
        if ((c._out || 0) !== out && !c._scheduled) {
          c._scheduled = true;
          this.schedule(2, () => {
            c._out = out;
            c.props.powered = out > 0 ? "true" : "false";
            c._scheduled = false;
            this.markChanged(x, y, z);
          });
        }
      }

      // Falltüren, Türen, Zauntore: öffnen bei Strom, schließen ohne
      else if (/_trapdoor$/.test(n) || /_door$/.test(n) || /fence_gate$/.test(n)) {
        let input = this.hasInput(x, y, z, power);
        if (/_door$/.test(n)) {
          // Türen sind 2 Blöcke hoch — Strom an einer Hälfte reicht
          const oy = c.props.half === "upper" ? y - 1 : y + 1;
          input = input || this.hasInput(x, oy, z, power);
        }
        const want = input ? "true" : "false";
        if ((c.props.open || "false") !== want) {
          c.props.open = want;
          c.props.powered = want;
          this.markChanged(x, y, z);
        }
      }

      // Notenblock: sein "instrument" hängt vom Block DARUNTER ab.
      // Schiebt ein Kolben den Block weg/hin, ändert sich der Zustand —
      // Beobachter erkennen das (klassische Notenblock-BUD-Technik).
      else if (n.endsWith("note_block")) {
        const below = this.get(x, y - 1, z);
        const inst = noteInstrument(below ? below.name : "minecraft:air");
        if ((c.props.instrument || "harp") !== inst) {
          c.props.instrument = inst;
          this.markChanged(x, y, z);
        }
        const want = this.hasInput(x, y, z, power) ? "true" : "false";
        if ((c.props.powered || "false") !== want) {
          c.props.powered = want;
          this.markChanged(x, y, z);
        }
      }

      // Kolben: schieben jetzt bis zu 12 Blöcke (Stufe 2).
      // Zerbrechliches (Staub, Fackeln, Hebel …) geht beim Schieben
      // kaputt — wie im Spiel. Unbewegliches blockiert den Kolben.
      else if (n === "minecraft:piston" || n === "minecraft:sticky_piston") {
        // Quasi-Konnektivität MIT BUD-Verhalten: QC-Strom (Position
        // über dem Kolben) zählt nur, wenn den Kolben auch ein
        // Block-Update erreicht — sonst bleibt er "geparkt", wie im
        // Spiel. Direkter Strom zählt als eigenes Update (Wechsel).
        const direct = this.hasInput(x, y, z, power);
        const qc = this.hasInput(x, y + 1, z, power);
        const want = (direct || qc) ? "true" : "false";
        const directChanged = direct !== (c._lastDirect === true);
        c._lastDirect = direct;
        const updated = directChanged || this.neighborChanged(x, y, z);
        if ((c.props.extended || "false") !== want && updated) {
          // Die 2-GT-Verzögerung steckt jetzt in der BEWEGUNG selbst
          // (moving_piston-Zwischenzustand): der Kolben schaltet
          // sofort, die geschobenen Blöcke kommen 2 GT später an —
          // wie im Spiel. Läuft vor dem Kolben schon eine Bewegung,
          // wartet er.
          const d = DIRS[c.props.facing || "north"];
          const front = this.get(x + d[0], y + d[1], z + d[2]);
          if (front && front.name === "minecraft:moving_piston") {
            // warten, bis die laufende Bewegung fertig ist
          } else if (want === "true") {
            if (this.tryExtend(x, y, z, c, d)) {
              c.props.extended = "true";
              this.markChanged(x, y, z);
            }
            // wenn blockiert: bleibt eingefahren, prüft beim nächsten Update wieder
          } else {
            this.retract(x, y, z, c, d, n.includes("sticky"));
            c.props.extended = "false";
            this.markChanged(x, y, z);
          }
        }
      }

      // Beobachter: pulst, wenn sich der beobachtete Nachbar ändert.
      // Der Puls wird NICHT vorausgeplant, sondern läuft pro Tick aus:
      // vorausgeplante Aufträge würden ins Leere zeigen, wenn ein
      // Kolben den Beobachter währenddessen woandershin bewegt —
      // der hing dann für immer auf "powered" fest.
      else if (n.endsWith("observer")) {
        const d = DIRS[c.props.facing || "north"];
        const now = this.snapshot(x + d[0], y + d[1], z + d[2]);
        const i = this.idx(x, y, z);
        if (this.observed.get(i) !== now) {
          this.observed.set(i, now);
          // beim Einschwingen nur den Schnappschuss aktualisieren —
          // sonst löst das Laden der Schematic die Maschine aus
          if (!this.settling && c.props.powered !== "true") {
            c.props.powered = "true";
            c._justPulsed = true; // diesen Tick nicht gleich wieder abschalten
            this.markChanged(x, y, z);
          }
        } else if (c.props.powered === "true") {
          if (c._justPulsed) {
            c._justPulsed = false; // 1 Tick Puls-Dauer gewähren
          } else {
            c.props.powered = "false"; // Puls vorbei (auch nach Bewegung!)
            this.markChanged(x, y, z);
          }
        }
      }

      // Stolperdraht-Haken: überwacht seine Schnur (bis 40 Blöcke in
      // Blickrichtung). Feuert, wenn (a) eine Schnur ausgelöst wird
      // (Klick = Entität) oder (b) die Schnur plötzlich kürzer wird —
      // z. B. weil ein Kolben sie zerrissen hat.
      else if (n.endsWith("tripwire_hook")) {
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
        if (broke) {
          if (c.props.powered !== "true") {
            c.props.powered = "true";
            this.markChanged(x, y, z);
            this.schedule(2, () => { c.props.powered = "false"; this.markChanged(x, y, z); });
          }
        } else {
          const want = anyPowered ? "true" : "false";
          if ((c.props.powered || "false") !== want) {
            c.props.powered = want;
            this.markChanged(x, y, z);
          }
        }
      }
    });

    // 4. Änderungen dieses Ticks für die Block-Update-Erkennung im
    // nächsten Tick aufheben, dann Rendering benachrichtigen
    this.prevChanged = new Set(this.changed);
    if (this.changed.size && this.onChange) {
      const list = [...this.changed].map(s => s.split(",").map(Number));
      this.changed.clear();
      this.onChange(list);
    } else {
      this.changed.clear();
    }
  }
}

// In Node (Tests) und im Browser nutzbar
if (typeof module !== "undefined") module.exports = { RedstoneSim };
