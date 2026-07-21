// ---------------------------------------------------------------
// ALLE MASCHINEN LÖSCHEN
//
// Ausführen:
//   npm run db:clear            → leert die lokale library.db
//   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… npm run db:clear
//                               → leert die Cloud-Datenbank (die Website!)
//
// Das Skript nimmt dieselbe Datenbank wie der Server: ohne
// Umgebungsvariablen die lokale Datei, mit ihnen Turso. Vor dem
// Löschen zeigt es an, WAS gelöscht wird und WO — und verlangt eine
// ausdrückliche Bestätigung, damit man nicht versehentlich die
// Live-Bibliothek leert.
//
// Bestätigung überspringen (z. B. in Skripten): --yes
// ---------------------------------------------------------------
"use strict";
const readline = require("readline");
const db = require("./db.js");

const isCloud = Boolean(process.env.TURSO_DATABASE_URL);
const ziel = isCloud
  ? `Turso-Cloud (${process.env.TURSO_DATABASE_URL})  ← das ist die LIVE-Website`
  : "lokale Datei library.db";

function frage(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(text, a => { rl.close(); res(a); }));
}

(async () => {
  await db.init();
  const machines = await db.getAllMachines();

  console.log("\nDatenbank: " + ziel);
  if (machines.length === 0) {
    console.log("Es sind keine Maschinen vorhanden — nichts zu tun.\n");
    return;
  }

  console.log(`\n${machines.length} Maschine(n) werden gelöscht:\n`);
  for (const m of machines) {
    const datei = m.downloadUrl && m.downloadUrl !== "#" ? "mit Schematic" : "ohne Datei";
    console.log(`  - ${m.name}  (${m.id}, ${m.designer}, ${datei})`);
  }
  console.log("\nMitsamt Materiallisten und hochgeladenen Schematic-Dateien.");
  console.log("Das lässt sich nicht rückgängig machen.\n");

  if (!process.argv.includes("--yes")) {
    const antwort = await frage('Zum Bestätigen "LOESCHEN" eingeben: ');
    if (antwort.trim() !== "LOESCHEN") {
      console.log("Abgebrochen — es wurde nichts geändert.\n");
      process.exit(1);
    }
  }

  await db.deleteAllMachines();
  const rest = await db.getAllMachines();
  console.log(`\nFertig. Verbleibende Maschinen: ${rest.length}\n`);
})().catch(e => { console.error("Fehlgeschlagen:", e.message); process.exit(1); });
