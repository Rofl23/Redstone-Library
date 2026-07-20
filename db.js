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
// SEED-DATEN (wie gehabt)
// ---------------------------------------------------------------
const seedData = [
  {
    id: "auto-weizenfarm",
    name: "Automatische Weizenfarm",
    category: "Farm",
    description: "Kolben ernten reifen Weizen automatisch, Wasser transportiert die Items zum Trichter.",
    version: "1.20+", difficulty: "Einfach", designer: "u/FarmerJoe_MC",
    uploadDate: "2026-03-14", downloadUrl: "#",
    materials: [
      { name: "Kolben", amount: 9 }, { name: "Redstoneblock", amount: 9 },
      { name: "Beobachter", amount: 9 }, { name: "Trichter", amount: 1 }, { name: "Kiste", amount: 1 }
    ]
  },
  {
    id: "flush-tuer-2x2",
    name: "Flush-Kolbentür 2x2",
    category: "Tür",
    description: "Verschwindet komplett in der Wand, kein sichtbarer Kolben von außen.",
    version: "1.16+", difficulty: "Mittel", designer: "u/RedstoneRiley",
    uploadDate: "2025-11-02", downloadUrl: "#",
    materials: [
      { name: "Klebriger Kolben", amount: 4 }, { name: "Kolben", amount: 4 },
      { name: "Redstonestaub", amount: 6 }, { name: "Redstonefackel", amount: 2 }, { name: "Druckplatte", amount: 2 }
    ]
  },
  {
    id: "item-sortierer",
    name: "Item-Sortierer (6-fach)",
    category: "Speicher",
    description: "Sortiert eingehende Items automatisch in sechs verschiedene Kisten nach Typ.",
    version: "1.14+", difficulty: "Mittel", designer: "u/StorageSage",
    uploadDate: "2025-08-21", downloadUrl: "#",
    materials: [
      { name: "Trichter", amount: 14 }, { name: "Kiste", amount: 6 },
      { name: "Vergleicher", amount: 6 }, { name: "Redstonestaub", amount: 12 }
    ]
  },
  {
    id: "xor-gatter",
    name: "XOR-Gatter (kompakt)",
    category: "Logik",
    description: "Kleinstmögliches XOR-Gatter, nützlich als Baustein für größere Rechenwerke.",
    version: "1.13+", difficulty: "Fortgeschritten", designer: "u/LogicLumberjack",
    uploadDate: "2025-05-09", downloadUrl: "#",
    materials: [
      { name: "Redstonefackel", amount: 4 }, { name: "Redstonestaub", amount: 4 }, { name: "Vollblock", amount: 3 }
    ]
  },
  {
    id: "schleim-farm",
    name: "Schleim-Farm (Superflach)",
    category: "Farm",
    description: "Nutzt Kolben zum Zerquetschen von Slimes in Superflach-Welten.",
    version: "1.18+", difficulty: "Fortgeschritten", designer: "u/SlimySteve",
    uploadDate: "2026-01-30", downloadUrl: "#",
    materials: [
      { name: "Kolben", amount: 22 }, { name: "Redstoneblock", amount: 22 },
      { name: "Beobachter", amount: 11 }, { name: "Trichter", amount: 4 }, { name: "Kiste", amount: 2 }
    ]
  }
];

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

  // Zweisprachigkeit nachrüsten: optionale englische Spalten.
  // ALTER TABLE schlägt fehl, wenn es die Spalte schon gibt — das
  // fangen wir ab, so bleibt der Aufruf beliebig wiederholbar.
  for (const col of ["name_en", "description_en"]) {
    try { await db.execute(`ALTER TABLE machines ADD COLUMN ${col} TEXT`); }
    catch { /* Spalte existiert schon */ }
  }

  const count = (await db.execute("SELECT COUNT(*) AS n FROM machines")).rows[0].n;
  if (Number(count) === 0) {
    for (const m of seedData) await createMachine(m);
    console.log("Datenbank angelegt und mit Beispieldaten gefüllt.");
  }

  // Englische Texte für die Beispielmaschinen nachtragen (nur wenn
  // noch leer — überschreibt nie etwas)
  const seedEn = {
    "auto-weizenfarm": ["Automatic Wheat Farm", "Pistons harvest ripe wheat automatically, water carries the items to a hopper."],
    "flush-tuer-2x2": ["Flush 2x2 Piston Door", "Disappears completely into the wall, no piston visible from outside."],
    "item-sortierer": ["Item Sorter (6 slots)", "Automatically sorts incoming items into six chests by type."],
    "xor-gatter": ["XOR Gate (compact)", "Smallest possible XOR gate, useful as a building block for larger circuits."],
    "schleim-farm": ["Slime Farm (Superflat)", "Uses pistons to crush slimes in superflat worlds."]
  };
  for (const [id, [nameEn, descEn]] of Object.entries(seedEn)) {
    await db.execute({
      sql: "UPDATE machines SET name_en = ?, description_en = ? WHERE id = ? AND (name_en IS NULL OR name_en = '')",
      args: [nameEn, descEn, id]
    });
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
    uploadDate: m.uploadDate, downloadUrl: m.downloadUrl,
    materials: mats.rows.map(r => ({ name: r.name, amount: Number(r.amount) }))
  };
}

async function createMachine(m) {
  // batch = Transaktion: entweder alles oder nichts
  const statements = [
    {
      sql: `INSERT INTO machines (id, name, category, description, name_en, description_en, version, difficulty, designer, uploadDate, downloadUrl)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [m.id, m.name, m.category, m.description, m.nameEn || null, m.descriptionEn || null,
        m.version, m.difficulty, m.designer, m.uploadDate, m.downloadUrl]
    },
    ...m.materials.map(mat => ({
      sql: "INSERT INTO materials (machine_id, name, amount) VALUES (?, ?, ?)",
      args: [m.id, mat.name, mat.amount]
    }))
  ];
  await db.batch(statements, "write");
  return getMachineById(m.id);
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

module.exports = { init, getAllMachines, getMachineById, createMachine, saveFile, getFile };
