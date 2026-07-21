// ---------------------------------------------------------------
// DATENBANK — jetzt über @libsql/client (Turso-kompatibel).
//
// Warum der Wechsel von node:sqlite?
// Gratis-Hoster wie Render löschen bei jedem Neustart das lokale
// Dateisystem — eine library.db auf der Platte wäre dort ständig weg.
// Turso ist "SQLite in der Cloud" mit dauerhaft kostenlosem Tarif.
// Lokal ändert sich fast nichts: ohne Umgebungsvariablen nutzt der
// Client einfach weiter die Datei library.db.
//
// Auch die Schematic-Dateien (nur wenige KB pro Stück) liegen jetzt
// als BLOBs in der Datenbank — damit ist ALLES Persistente an einem
// Ort und der App-Server darf zustandslos sein.
//
// Achtung: alle Funktionen sind jetzt async (Cloud = Netzwerk)!
// ---------------------------------------------------------------
const { createClient } = require("@libsql/client");
const path = require("path");
const fs = require("fs");

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:" + path.join(__dirname, "library.db"),
  authToken: process.env.TURSO_AUTH_TOKEN
});

// ---------------------------------------------------------------
// KEINE SEED-DATEN.
// Frueher legte init() hier fuenf Beispielmaschinen an, sobald die
// Tabelle leer war. Das machte es unmoeglich, die Bibliothek zu
// leeren: Nach jedem Serverstart standen die Demo-Eintraege wieder
// drin. Eine leere Bibliothek ist ein gueltiger Zustand — die Liste
// zeigt dann den Hinweistext aus i18n ("empty").
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// INITIALISIERUNG — einmal beim Serverstart aufrufen (await!)
// ---------------------------------------------------------------
async function init() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS machines (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL,
      description TEXT NOT NULL,
      version     TEXT NOT NULL,
      difficulty  TEXT NOT NULL,
      designer    TEXT NOT NULL,
      uploadDate  TEXT NOT NULL,
      downloadUrl TEXT NOT NULL DEFAULT '#'
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS materials (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      amount     INTEGER NOT NULL
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS files (
      machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
      data       BLOB NOT NULL
    )`);

  // Optionale Spalten nachrüsten. ALTER TABLE schlägt fehl, wenn es die
  // Spalte schon gibt — das fangen wir ab, so bleibt der Aufruf beliebig
  // wiederholbar.
  //   name_en / description_en  Zweisprachigkeit
  //   sourceUrl                 Link zum Original (Reddit, YouTube, Forum)
  //   permission                auf welcher Grundlage die Schematic hier
  //                             liegen darf — den Designer zu nennen und
  //                             die Erlaubnis zur Weiterverbreitung zu
  //                             haben sind zwei verschiedene Dinge
  for (const col of ["name_en", "description_en", "sourceUrl", "permission"]) {
    try { await db.execute(`ALTER TABLE machines ADD COLUMN ${col} TEXT`); }
    catch { /* Spalte existiert schon */ }
  }

  // Einmalige Migration: liegen noch Schematics im alten files/-Ordner,
  // wandern sie in die Datenbank — aber nur, wenn die zugehörige
  // Maschine existiert (Fremdschlüssel!), und ohne bei einem Fehler
  // den ganzen Serverstart zu reißen
  const filesDir = path.join(__dirname, "files");
  if (fs.existsSync(filesDir)) {
    for (const f of fs.readdirSync(filesDir)) {
      if (!f.endsWith(".litematic")) continue;
      const id = f.replace(".litematic", "");
      try {
        const machine = await db.execute({ sql: "SELECT id FROM machines WHERE id = ?", args: [id] });
        if (machine.rows.length === 0) continue; // verwaiste Datei — überspringen
        const existing = await db.execute({ sql: "SELECT machine_id FROM files WHERE machine_id = ?", args: [id] });
        if (existing.rows.length === 0) {
          await saveFile(id, fs.readFileSync(path.join(filesDir, f)));
          console.log("Schematic in die Datenbank migriert:", f);
        }
      } catch (err) {
        console.error("Migration übersprungen für", f, "-", err.message);
      }
    }
  }
}

// ---------------------------------------------------------------
// ABFRAGEN
// ---------------------------------------------------------------
async function getAllMachines() {
  // Ein einziger Join statt einer Abfrage pro Maschine — in der
  // Cloud zählt jede eingesparte Netzwerkrunde
  const rs = await db.execute(`
    SELECT m.*, mat.name AS matName, mat.amount AS matAmount
    FROM machines m LEFT JOIN materials mat ON mat.machine_id = m.id
    ORDER BY m.uploadDate DESC, mat.id
  `);
  const byId = new Map();
  for (const row of rs.rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id, name: row.name, category: row.category, description: row.description,
        nameEn: row.name_en || null, descriptionEn: row.description_en || null,
        version: row.version, difficulty: row.difficulty, designer: row.designer,
        sourceUrl: row.sourceUrl || null, permission: row.permission || null,
        uploadDate: row.uploadDate, downloadUrl: row.downloadUrl, materials: []
      });
    }
    if (row.matName) byId.get(row.id).materials.push({ name: row.matName, amount: Number(row.matAmount) });
  }
  return [...byId.values()];
}

async function getMachineById(id) {
  const rs = await db.execute({ sql: "SELECT * FROM machines WHERE id = ?", args: [id] });
  if (rs.rows.length === 0) return null;
  const m = rs.rows[0];
  const mats = await db.execute({ sql: "SELECT name, amount FROM materials WHERE machine_id = ? ORDER BY id", args: [id] });
  return {
    id: m.id, name: m.name, category: m.category, description: m.description,
    nameEn: m.name_en || null, descriptionEn: m.description_en || null,
    version: m.version, difficulty: m.difficulty, designer: m.designer,
    sourceUrl: m.sourceUrl || null, permission: m.permission || null,
    uploadDate: m.uploadDate, downloadUrl: m.downloadUrl,
    materials: mats.rows.map(r => ({ name: r.name, amount: Number(r.amount) }))
  };
}

async function createMachine(m) {
  // batch = Transaktion: entweder alles oder nichts
  const statements = [
    {
      sql: `INSERT INTO machines (id, name, category, description, name_en, description_en, version, difficulty, designer, sourceUrl, permission, uploadDate, downloadUrl)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [m.id, m.name, m.category, m.description, m.nameEn || null, m.descriptionEn || null,
        m.version, m.difficulty, m.designer, m.sourceUrl || null, m.permission || null,
        m.uploadDate, m.downloadUrl]
    },
    ...m.materials.map(mat => ({
      sql: "INSERT INTO materials (machine_id, name, amount) VALUES (?, ?, ?)",
      args: [m.id, mat.name, mat.amount]
    }))
  ];
  await db.batch(statements, "write");
  return getMachineById(m.id);
}

// Alles löschen. Materialien und Dateien hängen per ON DELETE CASCADE
// an den Maschinen — die werden aber nur mitgelöscht, wenn die
// Fremdschlüssel-Prüfung aktiv ist, und das ist sie nicht überall.
// Deshalb hier ausdrücklich alle drei Tabellen leeren.
async function deleteAllMachines() {
  await db.batch([
    "DELETE FROM files",
    "DELETE FROM materials",
    "DELETE FROM machines"
  ], "write");
}

// ---------------------------------------------------------------
// SCHEMATIC-DATEIEN (BLOBs)
// ---------------------------------------------------------------
async function saveFile(machineId, buffer) {
  await db.execute({
    sql: "INSERT OR REPLACE INTO files (machine_id, data) VALUES (?, ?)",
    args: [machineId, buffer]
  });
}

async function getFile(machineId) {
  const rs = await db.execute({ sql: "SELECT data FROM files WHERE machine_id = ?", args: [machineId] });
  if (rs.rows.length === 0) return null;
  return Buffer.from(rs.rows[0].data);
}

module.exports = { init, getAllMachines, getMachineById, createMachine, deleteAllMachines, saveFile, getFile };
