// Integrationstests über ALLE Maschinen in files/.
// Ausführen: node test/machines.test.js   (npm run test:machines)
//
// Die Tests hier prüfen bewusst KEIN maschinenspezifisches Wunschergebnis
// ("Tür geht auf"), sondern allgemeine Eigenschaften, die jede korrekte
// Redstone-Engine erfüllen muss. Dadurch lässt sich die Engine nicht auf
// eine einzelne Maschine überanpassen: Ein Eingriff, der die 8x8-Tür
// grün macht und dabei eine andere Maschine bricht, fällt sofort auf.
//
//   RUHE          Eine Maschine ohne Eingabe muss ruhen. Kein Zustand
//                 darf sich von selbst ändern.
//   DETERMINISMUS Zwei identische Läufe müssen Block für Block dasselbe
//                 Ergebnis liefern.
//   KONSISTENZ    Nach dem Stillstand muss jeder Zustand zu seinen
//                 Eingängen passen — keine verpassten Updates, keine
//                 hängenden Bewegungen. NICHT geprüft werden hier
//                 BUD-geparkte Kolben: Ein Kolben, der Strom hätte, aber
//                 mangels Block-Update nicht geschaltet hat, ist in
//                 Vanilla ein völlig legaler Zustand — Quasi-Konnektivität
//                 beruht genau darauf. Verstärker, Komparatoren und Staub
//                 dagegen aktualisieren sich immer, die dürfen nie hängen.
//   REVERSIBEL    Hebel um, zur Ruhe kommen, Hebel zurück, zur Ruhe
//                 kommen → Endzustand == Anfangszustand. Das ist der
//                 schärfste Test: Er fängt Blöcke, die durch die Gegend
//                 wandern, ohne dass man wissen muss, was die Maschine tut.
"use strict";
const fs = require("fs");
const path = require("path");
const { getBlockGrid } = require("../lib/litematic.js");
const { RedstoneSim } = require("../public/sim.js");

const FILES = path.join(__dirname, "../files");

// Bekannte, dokumentierte offene Punkte (siehe README, Abschnitt
// "Simulation — Stand & Grenzen"). Diese lassen die Suite NICHT scheitern,
// aber wenn einer davon plötzlich besteht, meldet die Suite das ebenfalls —
// damit ein Fix nicht unbemerkt bleibt und der Eintrag verschwinden kann.
const KNOWN_OPEN = {
  "8x8-flush-trapdoor-final.litematic": ["REVERSIBEL"]
};

let pass = 0, fail = 0, known = 0, fixed = 0;

function report(machine, name, ok, detail) {
  const isKnown = (KNOWN_OPEN[machine] || []).includes(name);
  if (ok && isKnown) { fixed++; console.log(`  BEHOBEN  ${name} — war als offen vermerkt, besteht jetzt. Eintrag in KNOWN_OPEN entfernen!`); }
  else if (ok) { pass++; console.log(`  ok       ${name}`); }
  else if (isKnown) { known++; console.log(`  offen    ${name} — bekannt, siehe README${detail ? ": " + detail : ""}`); }
  else { fail++; console.log(`  FEHLER   ${name}${detail ? " — " + detail : ""}`); }
}

const fingerprint = sim => sim.cells.map(c => c.name + "|" + JSON.stringify(c.props)).join("\n");

// Bis zur Ruhe laufen lassen. Rückgabe: null = kam zur Ruhe,
// sonst die Anzahl GT, nach der abgebrochen wurde (= läuft endlos).
function runToRest(sim, maxGT = 3000) {
  let last = sim.gameTick, rested = false;
  const prev = sim.onChange;
  sim.onChange = () => { last = sim.gameTick; };
  for (let i = 0; i < maxGT; i++) {
    sim.tick();
    if (sim.gameTick - last > 60) { rested = true; break; }
  }
  sim.onChange = prev;
  return rested ? null : sim.gameTick;
}

function firstDiffs(a, b, size, limit = 5) {
  const A = a.split("\n"), B = b.split("\n");
  const [W, , D] = size;
  const out = []; let n = 0;
  for (let i = 0; i < A.length; i++) {
    if (A[i] === B[i]) continue;
    n++;
    if (out.length < limit) {
      const y = Math.floor(i / (D * W)), z = Math.floor((i % (D * W)) / W), x = i % W;
      out.push(`(${x},${y},${z}) ${A[i].split("|")[0].replace("minecraft:", "")} → ${B[i].split("|")[0].replace("minecraft:", "")}`);
    }
  }
  return { count: n, samples: out };
}

// Konsistenz: passt jeder Zustand zu seinen Eingängen?
function inconsistencies(sim) {
  const bad = [];
  sim.eachCell((c, x, y, z) => {
    const n = c.name, P = `(${x},${y},${z})`;
    if (n.endsWith("redstone_wire")) {
      const want = sim.computeWirePower(x, y, z);
      if (String(want) !== (c.props.power || "0")) bad.push(`Staub ${P} ist ${c.props.power}, soll ${want}`);
    } else if (n.endsWith("repeater")) {
      if (!sim.repeaterLocked(c, x, y, z) && (c.props.powered === "true") !== sim.repeaterInput(c, x, y, z) && !sim.hasTick(x, y, z))
        bad.push(`Verstärker ${P} hängt`);
    } else if (n.endsWith("comparator")) {
      if ((c._out || 0) !== sim.comparatorOutput(c, x, y, z) && !sim.hasTick(x, y, z))
        bad.push(`Komparator ${P} hängt`);
    } else if (n === "minecraft:moving_piston") {
      bad.push(`hängende Bewegung ${P}`);
    }
  });
  return bad;
}

function findLever(sim) {
  let found = null;
  sim.eachCell((c, x, y, z) => { if (!found && c.name.endsWith("lever")) found = [x, y, z]; });
  return found;
}

(async () => {
  const files = fs.readdirSync(FILES).filter(f => f.endsWith(".litematic")).sort();
  for (const file of files) {
    console.log("\n" + file);
    const buf = fs.readFileSync(path.join(FILES, file));
    const load = async () => { const g = await getBlockGrid(buf); const s = new RedstoneSim(g); s.settle(); return [s, g]; };

    // --- RUHE ---------------------------------------------------
    {
      const [sim] = await load();
      const before = fingerprint(sim);
      for (let i = 0; i < 200; i++) sim.tick();
      const after = fingerprint(sim);
      const d = firstDiffs(before, after, sim.cells && [sim.W, sim.H, sim.D]);
      report(file, "RUHE", before === after, d.count ? `${d.count} Zellen ändern sich ohne Eingabe` : "");
    }

    // --- DETERMINISMUS ------------------------------------------
    {
      const [a] = await load(), [b] = await load();
      const lv = findLever(a);
      if (lv) { a.interact(...lv); b.interact(...lv); }
      for (let i = 0; i < 300; i++) { a.tick(); b.tick(); }
      report(file, "DETERMINISMUS", fingerprint(a) === fingerprint(b), "zwei identische Läufe weichen ab");
    }

    // --- KONSISTENZ + REVERSIBEL --------------------------------
    {
      const [sim, grid] = await load();
      const lever = findLever(sim);
      if (!lever) {
        console.log("  --       REVERSIBEL — übersprungen (kein Hebel in der Maschine)");
        const bad = inconsistencies(sim);
        report(file, "KONSISTENZ", bad.length === 0, bad.slice(0, 3).join("; "));
      } else {
        const start = fingerprint(sim);
        sim.interact(...lever);
        const stuck1 = runToRest(sim);
        const moved = fingerprint(sim) !== start;
        report(file, "REAGIERT", moved && !stuck1, stuck1 ? `kommt nach ${stuck1} GT nicht zur Ruhe` : "Hebel bewirkt nichts");

        const bad = inconsistencies(sim);
        report(file, "KONSISTENZ", bad.length === 0, bad.slice(0, 3).join("; "));

        sim.interact(...lever);
        runToRest(sim);
        const end = fingerprint(sim);
        const d = firstDiffs(start, end, grid.size);
        report(file, "REVERSIBEL", start === end, d.count ? `${d.count} Abweichungen, u. a. ${d.samples[0]}` : "");
        if (start !== end && (KNOWN_OPEN[file] || []).includes("REVERSIBEL"))
          d.samples.forEach(s => console.log(`             ${s}`));
      }
    }
  }

  console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen, ${known} bekannt offen` + (fixed ? `, ${fixed} BEHOBEN` : ""));
  process.exit(fail > 0 || fixed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
