// ---------------------------------------------------------------
// SERVER
// Express ist ein Mini-Framework für HTTP-Server in Node.js.
// Der Server hat zwei Jobs:
//   1. Die statischen Dateien aus /public ausliefern (HTML, CSS, JS)
//   2. Eine JSON-API unter /api/* anbieten
// Persistentes (Maschinen + Schematic-Dateien) liegt komplett in
// der Datenbank (db.js) — der Server selbst ist zustandslos und
// übersteht damit auch Gratis-Hosting, das bei jedem Neustart das
// Dateisystem wegwirft.
// Starten mit:  npm start   →  http://localhost:3000
// ---------------------------------------------------------------
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const db = require("./db");
const { parseLitematic, getBlockGrid } = require("./lib/litematic");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());                                  // JSON im Request-Body parsen
// Frontend ausliefern. HTML und JS bekommen "no-cache": Der Browser darf
// sie weiter zwischenspeichern, muss aber bei jedem Aufruf beim Server
// nachfragen, ob sie sich geändert haben (ETag → meist 304, kein erneuter
// Download). Ohne das liefert der Browser nach einem Deploy weiter die
// alte sim.js aus und simuliert stillschweigend mit veraltetem Code —
// ein Fehler, der sehr schwer zu erkennen ist, weil die API frische
// Daten liefert und nur die Logik alt ist.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  }
}));

// 3D-Bibliotheken lokal aus node_modules ausliefern — so hängt der
// Viewer an keinem externen CDN (nur die Texturen kommen von außen)
app.get("/vendor/deepslate.js", (req, res) =>
  res.type("application/javascript")
    .sendFile(path.join(__dirname, "node_modules/deepslate/dist/deepslate.umd.cjs")));
app.get("/vendor/gl-matrix.js", (req, res) =>
  res.sendFile(path.join(__dirname, "node_modules/gl-matrix/gl-matrix-min.js")));

// ---------------------------------------------------------------
// TEMP-UPLOADS
// Frisch analysierte Schematics warten hier auf das Absenden des
// Formulars — nur im RAM (Map), nach 1 Stunde wird aufgeräumt.
// Geht der Server dazwischen schlafen, muss der Nutzer die Datei
// einfach neu wählen — verschmerzbar.
// ---------------------------------------------------------------
const tempUploads = new Map(); // token → { buffer, at }
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [token, entry] of tempUploads) {
    if (entry.at < cutoff) tempUploads.delete(token);
  }
}, 10 * 60 * 1000).unref();

// multer nimmt multipart/form-data (Datei-Uploads) entgegen.
// memoryStorage: die Datei landet als Buffer im RAM — okay bei 10 MB Limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------

// GET /api/machines — alle Maschinen (Filtern übernimmt das Frontend)
app.get("/api/machines", async (req, res) => {
  try {
    res.json(await db.getAllMachines());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// GET /api/machines/:id — eine einzelne Maschine
app.get("/api/machines/:id", async (req, res) => {
  try {
    const machine = await db.getMachineById(req.params.id);
    if (!machine) return res.status(404).json({ error: "Maschine nicht gefunden" });
    res.json(machine);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// GET /api/machines/:id/blocks — Blockdaten für den 3D-Viewer.
// Das Parsen ist nicht ganz billig, deshalb merken wir uns das
// Ergebnis pro Maschine im RAM (einfacher Cache).
const gridCache = new Map();
app.get("/api/machines/:id/blocks", async (req, res) => {
  const id = req.params.id;
  if (gridCache.has(id)) return res.json(gridCache.get(id));
  try {
    const buffer = await db.getFile(id);
    if (!buffer) return res.status(404).json({ error: "Keine Schematic für diese Maschine" });
    const grid = await getBlockGrid(buffer);
    gridCache.set(id, grid);
    res.json(grid);
  } catch (err) {
    console.error("Blockdaten fehlgeschlagen:", err.message);
    res.status(422).json({ error: "Datei konnte nicht gelesen werden" });
  }
});

// POST /api/analyze — .litematic hochladen und auslesen.
// Die Datei wird unter einem Zufallstoken im RAM geparkt; das
// Formular schickt das Token beim Absenden mit.
app.post("/api/analyze", upload.single("schematic"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Keine Datei erhalten" });
  }
  if (!req.file.originalname.toLowerCase().endsWith(".litematic")) {
    return res.status(400).json({ error: "Nur .litematic-Dateien werden unterstützt" });
  }
  try {
    const result = await parseLitematic(req.file.buffer);
    const fileToken = crypto.randomBytes(16).toString("hex");
    tempUploads.set(fileToken, { buffer: req.file.buffer, at: Date.now() });
    res.json({ ...result, fileToken });
  } catch (err) {
    console.error("Analyse fehlgeschlagen:", err.message);
    res.status(422).json({ error: "Datei konnte nicht gelesen werden – ist das wirklich eine .litematic?" });
  }
});

// GET /download/:id — die Schematic einer Maschine herunterladen
app.get("/download/:id", async (req, res) => {
  try {
    const machine = await db.getMachineById(req.params.id);
    const buffer = machine ? await db.getFile(req.params.id) : null;
    if (!buffer) return res.status(404).json({ error: "Keine Datei für diese Maschine" });
    const filename = machine.name.replace(/[^\wäöüß \-]/gi, "") + ".litematic";
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("application/octet-stream").send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// POST /api/machines — neue Maschine anlegen
app.post("/api/machines", async (req, res) => {
  const { name, category, description, version, difficulty, designer, materials } = req.body;

  // Validierung: niemals dem Client vertrauen, auch nicht dem eigenen
  if (!name || !category || !description || !version || !difficulty || !designer) {
    return res.status(400).json({ error: "Pflichtfelder fehlen" });
  }

  // optionale englische Texte — nur Strings mit sinnvoller Länge
  const nameEn = typeof req.body.nameEn === "string" ? req.body.nameEn.trim().slice(0, 80) : "";
  const descriptionEn = typeof req.body.descriptionEn === "string" ? req.body.descriptionEn.trim().slice(0, 300) : "";

  // Herkunft: Quelle nur als http(s)-Link annehmen — ein Feld, in dem ein
  // Link landet, der später ungeprüft in die Seite geschrieben wird, ist
  // sonst ein offenes Scheunentor (javascript:-URLs).
  const rawSource = typeof req.body.sourceUrl === "string" ? req.body.sourceUrl.trim().slice(0, 500) : "";
  let sourceUrl = "";
  if (rawSource) {
    try {
      const u = new URL(rawSource);
      if (u.protocol === "http:" || u.protocol === "https:") sourceUrl = u.href;
      else return res.status(400).json({ error: "Quelle muss ein http- oder https-Link sein" });
    } catch { return res.status(400).json({ error: "Quelle ist kein gültiger Link" }); }
  }
  const ALLOWED_PERMISSION = ["eigenes-werk", "erlaubnis-erhalten", "frei-geteilt", "unbekannt"];
  const permission = ALLOWED_PERMISSION.includes(req.body.permission) ? req.body.permission : "unbekannt";
  if (!Array.isArray(materials) || materials.length === 0 ||
      !materials.every(m => typeof m.name === "string" && Number.isInteger(m.amount) && m.amount > 0)) {
    return res.status(400).json({ error: "materials muss eine Liste aus { name, amount } sein" });
  }

  // id aus dem Namen erzeugen ("Automatische Weizenfarm" → "automatische-weizenfarm")
  const id = name.toLowerCase()
    .replace(/[äöüß]/g, c => ({ "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" }[c]))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  try {
    if (await db.getMachineById(id)) {
      return res.status(409).json({ error: "Eine Maschine mit diesem Namen existiert schon" });
    }

    // Kam vorher eine Datei über /api/analyze? Dann aus dem RAM-Parkplatz holen
    let downloadUrl = "#";
    let fileBuffer = null;
    const { fileToken } = req.body;
    if (fileToken && /^[a-f0-9]{32}$/.test(fileToken) && tempUploads.has(fileToken)) {
      fileBuffer = tempUploads.get(fileToken).buffer;
      tempUploads.delete(fileToken);
      downloadUrl = "/download/" + id;
    }

    const machine = await db.createMachine({
      id, name, category, description,
      nameEn: nameEn || null, descriptionEn: descriptionEn || null,
      version, difficulty, designer,
      sourceUrl: sourceUrl || null, permission,
      uploadDate: new Date().toISOString().slice(0, 10), // "2026-07-19"
      downloadUrl,
      materials
    });
    if (fileBuffer) await db.saveFile(id, fileBuffer);

    res.status(201).json(machine);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Datenbankfehler" });
  }
});

// ---------------------------------------------------------------
// Erst die Datenbank initialisieren, dann Anfragen annehmen
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Redstone-Bibliothek läuft auf http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error("Datenbank-Initialisierung fehlgeschlagen:", err);
  process.exit(1);
});
