// Unit-Tests für die ereignisbasierte Redstone-Engine.
// Ausführen: node test/sim.test.js
"use strict";
const assert = require("assert");
const { RedstoneSim } = require("../public/sim.js");

// ---- Mini-Welt-Baukasten ---------------------------------------
function world(W, H, D, blocks) {
  const palette = [{ name: "minecraft:air", props: {} }];
  const index = new Map([["minecraft:air|{}", 0]]);
  const grid = { size: [W, H, D], palette, blocks: new Array(W * H * D).fill(0) };
  for (const [x, y, z, name, props = {}] of blocks) {
    const key = name + "|" + JSON.stringify(props);
    if (!index.has(key)) {
      index.set(key, palette.length);
      palette.push({ name: "minecraft:" + name, props });
    }
    grid.blocks[(y * D + z) * W + x] = index.get(key);
  }
  return grid;
}
const at = (sim, x, y, z) => sim.get(x, y, z);
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.log("FAIL  " + name + "\n      " + e.message); }
}

// ---- 1. Fackel invertiert mit 1 RT (2 GT) ----------------------
test("Fackel: invertiert Halteblock mit 2 GT Verzögerung", () => {
  const sim = new RedstoneSim(world(5, 4, 3, [
    ["1", 1, 1, "x"] && [1, 1, 1, "stone"],
    [1, 2, 1, "lever", { face: "floor", powered: "false" }],
    [2, 1, 1, "redstone_wall_torch", { facing: "east", lit: "true" }],
    [3, 0, 1, "stone"],
    [3, 1, 1, "redstone_wire", { power: "0" }]
  ]));
  assert.strictEqual(at(sim, 2, 1, 1).props.lit, "true");
  assert.strictEqual(at(sim, 3, 1, 1).props.power, "15");
  sim.interact(1, 2, 1);                       // Hebel an
  assert.strictEqual(at(sim, 2, 1, 1).props.lit, "true", "Fackel noch an (Delay)");
  sim.tick();
  assert.strictEqual(at(sim, 2, 1, 1).props.lit, "true", "nach 1 GT noch an");
  sim.tick();
  assert.strictEqual(at(sim, 2, 1, 1).props.lit, "false", "nach 2 GT aus");
  assert.strictEqual(at(sim, 3, 1, 1).props.power, "0", "Staub sofort mit aus");
});

// ---- 2. Verstärker: Delay + Puls-Garantie ----------------------
test("Verstärker: 1 RT Delay, 1-GT-Puls wird zum vollen Ausgangspuls", () => {
  const sim = new RedstoneSim(world(5, 3, 3, [
    [0, 0, 1, "stone"], [2, 0, 1, "stone"],
    [0, 1, 1, "lever", { face: "floor", powered: "false" }],
    [1, 1, 1, "repeater", { facing: "west", delay: "1", powered: "false" }],
    [2, 1, 1, "redstone_wire", { power: "0" }]
  ]));
  sim.interact(0, 1, 1);                        // an
  sim.tick();                                   // GT 1
  sim.interact(0, 1, 1);                        // aus — Eingang war nur 1 GT an
  assert.strictEqual(at(sim, 2, 1, 1).props.power, "0");
  sim.tick();                                   // GT 2: Verstärker schaltet AN
  assert.strictEqual(at(sim, 1, 1, 1).props.powered, "true");
  assert.strictEqual(at(sim, 2, 1, 1).props.power, "15");
  sim.tick();                                   // GT 3: noch an (voller Puls)
  assert.strictEqual(at(sim, 1, 1, 1).props.powered, "true");
  sim.tick();                                   // GT 4: aus
  assert.strictEqual(at(sim, 1, 1, 1).props.powered, "false");
  assert.strictEqual(at(sim, 2, 1, 1).props.power, "0");
});

// ---- 3. Staub: Signalabfall ------------------------------------
test("Staub: Abfall 15 → 13 über drei Blöcke", () => {
  const blocks = [[0, 1, 0, "lever", { face: "floor", powered: "true" }], [0, 0, 0, "stone"]];
  for (let x = 1; x <= 3; x++) {
    blocks.push([x, 0, 0, "stone"]);
    blocks.push([x, 1, 0, "redstone_wire", { power: "0" }]);
  }
  const sim = new RedstoneSim(world(6, 3, 2, blocks));
  assert.strictEqual(at(sim, 1, 1, 0).props.power, "15");
  assert.strictEqual(at(sim, 2, 1, 0).props.power, "14");
  assert.strictEqual(at(sim, 3, 1, 0).props.power, "13");
});

// ---- 4. Quasi-Konnektivität + BUD ------------------------------
test("QC-BUD: Kolben bleibt ohne Update geparkt, Update weckt ihn", () => {
  // Kolben (2,1,2) facing south. QC-Position (2,2,2) wird über soliden
  // Block B (3,2,2) gepowert (Hebel obendrauf) — B-Updates erreichen
  // den Kolben nicht. Triggerdraht läuft bei z=1 quer (powert ihn nicht).
  const sim = new RedstoneSim(world(6, 5, 5, [
    [2, 1, 2, "piston", { facing: "south", extended: "false" }],
    [3, 2, 2, "stone"],
    [3, 3, 2, "lever", { face: "floor", powered: "false" }],
    // Triggerleitung west-ost bei z=1 (zeigt nicht zum Kolben)
    [0, 1, 1, "lever", { face: "floor", powered: "false" }], [0, 0, 1, "stone"],
    [1, 0, 1, "stone"], [1, 1, 1, "redstone_wire", { power: "0" }],
    [2, 0, 1, "stone"], [2, 1, 1, "redstone_wire", { power: "0" }],
    [3, 0, 1, "stone"], [3, 1, 1, "redstone_wire", { power: "0" }]
  ]));
  sim.interact(3, 3, 2);                        // QC-Strom an — KEIN Update am Kolben
  for (let i = 0; i < 6; i++) sim.tick();
  assert.strictEqual(at(sim, 2, 1, 2).props.extended, "false", "geparkt (BUD)");
  sim.interact(0, 1, 1);                        // Draht ändert sich neben dem Kolben
  sim.tick();                                   // Block-Event läuft am Tick-Ende
  assert.strictEqual(at(sim, 2, 1, 2).props.extended, "true", "Update weckt Kolben");
  assert.strictEqual(at(sim, 2, 1, 3).name, "minecraft:piston_head");
});

// ---- 5. Kurzer Puls: klebriger Kolben lässt Block fallen -------
test("0-Tick-Verhalten: kurzer Puls → Sticky-Kolben droppt den Block", () => {
  const sim = new RedstoneSim(world(6, 3, 3, [
    [0, 0, 1, "stone"],
    [0, 1, 1, "lever", { face: "floor", powered: "false" }],
    [1, 1, 1, "sticky_piston", { facing: "east", extended: "false" }],
    [2, 1, 1, "stone"]
  ]));
  sim.interact(0, 1, 1);                        // an
  sim.tick();                                   // Ausfahren startet, Block bewegt sich (2 GT)
  assert.strictEqual(at(sim, 1, 1, 1).props.extended, "true");
  sim.interact(0, 1, 1);                        // aus, noch während der Bewegung
  sim.tick();                                   // Einziehen: Block ist noch "moving" → gedroppt
  sim.tick(); sim.tick();                       // Bewegung kommt an
  assert.strictEqual(at(sim, 1, 1, 1).props.extended, "false", "eingezogen");
  assert.strictEqual(at(sim, 2, 1, 1).name, "minecraft:air", "nicht zurückgezogen");
  assert.strictEqual(at(sim, 3, 1, 1).name, "minecraft:stone", "Block gedroppt");
});

// ---- 6. Retract-Event wird durch Re-Powern im selben Tick storniert
test("0-Tick-Verhalten: Re-Powern im selben Tick verhindert Einziehen", () => {
  const sim = new RedstoneSim(world(6, 3, 3, [
    [0, 0, 1, "stone"],
    [0, 1, 1, "lever", { face: "floor", powered: "false" }],
    [1, 1, 1, "sticky_piston", { facing: "east", extended: "false" }],
    [2, 1, 1, "stone"]
  ]));
  sim.interact(0, 1, 1);
  sim.tick(); sim.tick(); sim.tick();           // voll ausgefahren
  assert.strictEqual(at(sim, 3, 1, 1).name, "minecraft:stone");
  sim.interact(0, 1, 1);                        // aus → Retract-Event
  sim.interact(0, 1, 1);                        // sofort wieder an
  sim.tick();
  assert.strictEqual(at(sim, 1, 1, 1).props.extended, "true", "bleibt ausgefahren");
  assert.strictEqual(at(sim, 3, 1, 1).name, "minecraft:stone", "Block unangetastet");
});

// ---- 7. Beobachter: 2-GT-Puls bei Änderung ---------------------
test("Beobachter: pulst 2 GT nach beobachteter Änderung", () => {
  const sim = new RedstoneSim(world(6, 3, 3, [
    [0, 0, 1, "stone"],
    [0, 1, 1, "lever", { face: "floor", powered: "false" }],
    [1, 0, 1, "stone"], [1, 1, 1, "redstone_wire", { power: "0" }],
    [2, 1, 1, "observer", { facing: "west", powered: "false" }],   // schaut auf den Draht
    [3, 0, 1, "stone"], [3, 1, 1, "redstone_wire", { power: "0" }]
  ]));
  sim.interact(0, 1, 1);                        // Draht ändert sich
  sim.tick(); sim.tick();                       // Detection-Delay 2 GT
  assert.strictEqual(at(sim, 2, 1, 1).props.powered, "true", "Puls an");
  assert.strictEqual(at(sim, 3, 1, 1).props.power, "15", "Ausgang powert Draht");
  sim.tick(); sim.tick();                       // Puls-Dauer 2 GT
  assert.strictEqual(at(sim, 2, 1, 1).props.powered, "false", "Puls vorbei");
  assert.strictEqual(at(sim, 3, 1, 1).props.power, "0");
});

// ---- 8. Verstärker-Locking -------------------------------------
test("Verstärker: Locking friert den Zustand ein", () => {
  const sim = new RedstoneSim(world(6, 3, 4, [
    [0, 0, 2, "stone"],
    [0, 1, 2, "lever", { face: "floor", powered: "false" }],
    [1, 1, 2, "repeater", { facing: "west", delay: "1", powered: "false" }],
    // Locker: Verstärker von Norden in die Seite, dauerhaft an
    [1, 0, 0, "stone"],
    [1, 1, 0, "lever", { face: "floor", powered: "true" }],
    [1, 1, 1, "repeater", { facing: "north", delay: "1", powered: "true" }],
    [2, 0, 2, "stone"], [2, 1, 2, "redstone_wire", { power: "0" }]
  ]));
  assert.strictEqual(at(sim, 1, 1, 2).props.locked, "true", "gesperrt");
  sim.interact(0, 1, 2);                        // Eingang an — aber gesperrt
  for (let i = 0; i < 6; i++) sim.tick();
  assert.strictEqual(at(sim, 1, 1, 2).props.powered, "false", "bleibt aus");
  assert.strictEqual(at(sim, 2, 1, 2).props.power, "0");
});

// ---- 9. Verstärker: alle vier Verzögerungsstufen ----------------
// Test 2 prüft nur delay=1 — eine Engine, die JEDE Verzögerung als 1 RT
// behandelt, käme damit durch. Hier werden alle vier Stufen einzeln
// nachgemessen: delay=n bedeutet exakt 2n Game-Ticks.
test("Verstärker: Verzögerung 1–4 entspricht exakt 2/4/6/8 GT", () => {
  for (const delay of [1, 2, 3, 4]) {
    const sim = new RedstoneSim(world(5, 3, 3, [
      [0, 0, 1, "stone"], [2, 0, 1, "stone"],
      [0, 1, 1, "lever", { face: "floor", powered: "false" }],
      [1, 1, 1, "repeater", { facing: "west", delay: String(delay), powered: "false" }],
      [2, 1, 1, "redstone_wire", { power: "0" }]
    ]));
    sim.interact(0, 1, 1);                      // Eingang dauerhaft an
    const want = 2 * delay;
    for (let gt = 1; gt < want; gt++) {
      sim.tick();
      assert.strictEqual(at(sim, 2, 1, 1).props.power, "0",
        `delay=${delay}: nach ${gt} GT darf der Ausgang noch nicht an sein`);
    }
    sim.tick();                                 // GT == 2*delay
    assert.strictEqual(at(sim, 2, 1, 1).props.power, "15",
      `delay=${delay}: nach ${want} GT muss der Ausgang an sein`);
  }
});

// ---- 10. Kolben: 12-Block-Grenze --------------------------------
// Vanilla schiebt höchstens 12 Blöcke. Bei 13 passiert gar nichts —
// der Kolben fährt nicht einmal aus.
test("Kolben: schiebt 12 Blöcke, verweigert bei 13", () => {
  // Kolben bei x=0 nach Osten, davor LÜCKENLOS n Steine ab x=1.
  const build = n => {
    const blocks = [
      [0, 0, 1, "stone"],
      [0, 2, 1, "lever", { face: "floor", powered: "false" }],
      [0, 1, 1, "piston", { facing: "east", extended: "false" }]
    ];
    for (let i = 0; i < n; i++) blocks.push([1 + i, 1, 1, "stone"]);
    return new RedstoneSim(world(n + 4, 3, 3, blocks));
  };

  const ok = build(12);
  ok.interact(0, 2, 1);
  for (let i = 0; i < 6; i++) ok.tick();
  assert.strictEqual(at(ok, 0, 1, 1).props.extended, "true", "12 Blöcke: Kolben fährt aus");
  assert.strictEqual(at(ok, 1, 1, 1).name, "minecraft:piston_head", "12 Blöcke: Kopf steht");
  assert.strictEqual(at(ok, 13, 1, 1).name, "minecraft:stone", "12 Blöcke: hinterster Block ist mitgerückt");
  assert.strictEqual(at(ok, 14, 1, 1).name, "minecraft:air", "12 Blöcke: dahinter bleibt Luft");

  const tooMany = build(13);
  tooMany.interact(0, 2, 1);
  for (let i = 0; i < 6; i++) tooMany.tick();
  assert.strictEqual(at(tooMany, 0, 1, 1).props.extended, "false", "13 Blöcke: Kolben bleibt eingefahren");
  assert.strictEqual(at(tooMany, 1, 1, 1).name, "minecraft:stone", "13 Blöcke: nichts hat sich bewegt");
  assert.strictEqual(at(tooMany, 14, 1, 1).name, "minecraft:air", "13 Blöcke: nichts ist nach hinten gerückt");
});

console.log("\n" + passed + " bestanden, " + failed + " fehlgeschlagen");
process.exit(failed ? 1 : 0);
