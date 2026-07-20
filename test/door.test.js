// Integrationstest: 8x8 Flush Trapdoor Final
// Ausführen: node test/door.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const { getBlockGrid } = require("../lib/litematic.js");
const { RedstoneSim } = require("../public/sim.js");

const DOOR = { y: 9, x0: 8, x1: 15, z0: 7, z1: 14 }; // 8x8 Türfläche
const LEVER = [0, 10, 0];

function doorState(sim) {
  let iron = 0, air = 0, other = 0;
  for (let z = DOOR.z0; z <= DOOR.z1; z++)
    for (let x = DOOR.x0; x <= DOOR.x1; x++) {
      const n = sim.get(x, DOOR.y, z).name;
      if (n === "minecraft:iron_block") iron++;
      else if (n === "minecraft:air") air++;
      else other++;
    }
  return { iron, air, other };
}

function fingerprint(sim) {
  return sim.cells.map(c => c.name + "|" + JSON.stringify(c.props)).join("\n");
}

function runUntil(sim, cond, maxGT, label) {
  for (let i = 0; i < maxGT; i++) {
    sim.tick();
    if (cond()) return sim.gameTick;
  }
  const s = doorState(sim);
  throw new Error(label + " nicht erreicht nach " + maxGT + " GT " +
    "(iron=" + s.iron + " air=" + s.air + " other=" + s.other + ")");
}

(async () => {
  const buf = fs.readFileSync(path.join(__dirname, "../files/8x8-flush-trapdoor-final.litematic"));
  const grid = await getBlockGrid(buf);
  const sim = new RedstoneSim(grid);

  const start = doorState(sim);
  console.log("Startzustand Türfläche:", start);
  if (start.iron !== 64) throw new Error("Tür startet nicht geschlossen (64 Eisen erwartet)");
  const closedFp = fingerprint(sim);

  // Öffnen
  sim.interact(...LEVER);
  const tOpen = runUntil(sim,
    () => doorState(sim).air === 64, 2000, "Tür offen (64 Luft)");
  console.log("offen nach", tOpen, "GT (" + (tOpen / 20).toFixed(1) + " s)");

  // Nachlauf: Maschine soll zur Ruhe kommen
  for (let i = 0; i < 100; i++) sim.tick();
  const openState = doorState(sim);
  if (openState.air !== 64) throw new Error("Tür nach Nachlauf nicht mehr offen: " + JSON.stringify(openState));

  // Schließen
  const tBase = sim.gameTick;
  sim.interact(...LEVER);
  const tClose = runUntil(sim,
    () => doorState(sim).iron === 64, 2000, "Tür geschlossen (64 Eisen)");
  console.log("geschlossen nach", tClose - tBase, "GT");

  // Zur Ruhe kommen lassen, dann Endzustand mit Anfangszustand vergleichen
  for (let i = 0; i < 200; i++) sim.tick();
  const endFp = fingerprint(sim);
  if (endFp !== closedFp) {
    const a = closedFp.split("\n"), b = endFp.split("\n");
    let diffs = 0;
    const [W, , D] = grid.size;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && diffs < 25) {
        const y = Math.floor(i / (D * W)), z = Math.floor((i % (D * W)) / W), x = i % W;
        console.log(`  DIFF (${x},${y},${z}): ${a[i]}  →  ${b[i]}`);
        diffs++;
      } else if (a[i] !== b[i]) diffs++;
    }
    throw new Error("Endzustand != Anfangszustand (" + diffs + " Abweichungen)");
  }
  console.log("Endzustand == Anfangszustand — Zyklus vollständig reversibel.");
  console.log("BESTANDEN");
})().catch(e => { console.error("FEHLGESCHLAGEN:", e.message); process.exit(1); });
