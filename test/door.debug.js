// Diagnose-Werkzeug für die 8x8 Flush Trapdoor Final.
// Ausführen: node test/door.debug.js
// Zeigt: Tür-Fortschritt, Stillstands-Zeitpunkt und Konsistenz-Check
// (Komponenten, deren Zustand nicht zu ihren Eingängen passt = BUD-geparkt
// oder verpasstes Update).
"use strict";
const fs = require("fs");
const path = require("path");
const { getBlockGrid } = require("../lib/litematic.js");
const { RedstoneSim } = require("../public/sim.js");

(async () => {
  const buf = fs.readFileSync(path.join(__dirname, "../files/8x8-flush-trapdoor-final.litematic"));
  const grid = await getBlockGrid(buf);
  const sim = new RedstoneSim(grid);
  let last = 0;
  sim.onChange = () => { last = sim.gameTick; };
  const door = () => {
    let a = 0;
    for (let z = 7; z <= 14; z++) for (let x = 8; x <= 15; x++)
      if (sim.get(x, 9, z).name === "minecraft:air") a++;
    return a;
  };

  sim.interact(0, 10, 0); // Hebel (0,10,0)
  for (let i = 1; i <= 6000; i++) {
    sim.tick();
    if (sim.gameTick - last > 300) break;
  }
  console.log("Tür offen:", door() + "/64 — letzte Aktivität bei GT", last);

  console.log("\nKonsistenz-Check (hängende Komponenten):");
  let n = 0;
  sim.eachCell((c, x, y, z) => {
    const name = c.name, P = `(${x},${y},${z})`;
    if (name.endsWith("redstone_wire")) {
      const want = sim.computeWirePower(x, y, z);
      if (String(want) !== (c.props.power || "0")) { console.log("  WIRE falsch", P, c.props.power, "soll", want); n++; }
    } else if (name.endsWith("repeater")) {
      const locked = sim.repeaterLocked(c, x, y, z), input = sim.repeaterInput(c, x, y, z);
      if (!locked && (c.props.powered === "true") !== input && !sim.hasTick(x, y, z)) {
        console.log("  REPEATER hängt", P, "powered:" + c.props.powered, "input:" + input); n++;
      }
    } else if (name.endsWith("comparator")) {
      const out = sim.comparatorOutput(c, x, y, z);
      if ((c._out || 0) !== out && !sim.hasTick(x, y, z)) { console.log("  COMPARATOR hängt", P, c._out, "soll", out); n++; }
    } else if (name === "minecraft:piston" || name === "minecraft:sticky_piston") {
      const want = sim.pistonShouldExtend(c, x, y, z);
      if (want !== (c.props.extended === "true")) {
        console.log("  PISTON BUD-geparkt", P, "ext:" + c.props.extended, "will:" + want, "facing:" + c.props.facing); n++;
      }
    } else if (name.endsWith("observer")) {
      if (c.props.powered === "true" && !sim.hasTick(x, y, z)) { console.log("  OBSERVER hängt an", P); n++; }
    } else if (name === "minecraft:moving_piston") {
      console.log("  MOVING hängt", P); n++;
    }
  });
  console.log(n ? n + " Auffälligkeiten." : "  keine.");
})().catch(e => { console.error(e); process.exit(1); });
