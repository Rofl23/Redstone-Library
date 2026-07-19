// ---------------------------------------------------------------
// EINMALIGES UMZUGSSKRIPT: lokale library.db → Turso-Cloud
//
// Aufruf (PowerShell, im Projektordner):
//   $env:TURSO_DATABASE_URL = "libsql://…"
//   $env:TURSO_AUTH_TOKEN   = "…"
//   node migrate-to-cloud.js
//
// Kopiert alle Maschinen, Materialien und Schematic-Dateien, die es
// in der Cloud noch nicht gibt. Kann gefahrlos mehrfach laufen.
// ---------------------------------------------------------------
const { createClient } = require("@libsql/client");
const path = require("path");

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("Bitte erst TURSO_DATABASE_URL und TURSO_AUTH_TOKEN setzen (siehe Kommentar oben).");
  process.exit(1);
}

const local = createClient({ url: "file:" + path.join(__dirname, "library.db") });
const cloud = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

(async () => {
  const machines = (await local.execute("SELECT * FROM machines")).rows;
  console.log(`Lokal gefunden: ${machines.length} Maschinen`);

  let copied = 0, skipped = 0;
  for (const m of machines) {
    const exists = await cloud.execute({ sql: "SELECT id FROM machines WHERE id = ?", args: [m.id] });
    if (exists.rows.length > 0) { skipped++; continue; }

    const mats = (await local.execute({
      sql: "SELECT name, amount FROM materials WHERE machine_id = ? ORDER BY id", args: [m.id]
    })).rows;

    await cloud.batch([
      {
        sql: `INSERT INTO machines (id, name, category, description, version, difficulty, designer, uploadDate, downloadUrl)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [m.id, m.name, m.category, m.description, m.version, m.difficulty, m.designer, m.uploadDate, m.downloadUrl]
      },
      ...mats.map(mat => ({
        sql: "INSERT INTO materials (machine_id, name, amount) VALUES (?, ?, ?)",
        args: [m.id, mat.name, mat.amount]
      }))
    ], "write");

    const file = await local.execute({ sql: "SELECT data FROM files WHERE machine_id = ?", args: [m.id] });
    if (file.rows.length > 0) {
      await cloud.execute({
        sql: "INSERT OR REPLACE INTO files (machine_id, data) VALUES (?, ?)",
        args: [m.id, Buffer.from(file.rows[0].data)]
      });
    }

    console.log("Kopiert:", m.name, file.rows.length ? "(mit Schematic)" : "(ohne Datei)");
    copied++;
  }

  console.log(`Fertig: ${copied} kopiert, ${skipped} waren schon in der Cloud.`);
})().catch(err => { console.error("Fehler:", err.message); process.exit(1); });
