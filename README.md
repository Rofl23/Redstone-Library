# Redstone-Bibliothek

Website, auf der Minecraft-Spieler Redstone-Konstruktionen suchen, im 3D-Viewer
mit Tick-Simulation ausprobieren und eigene .litematic-Dateien teilen können.

## Projektstruktur

```
redstone_library/
├── server.js        Express-Server: API + liefert das Frontend aus
├── db.js            Datenbank (Turso/libSQL, lokal: library.db-Datei)
├── lib/
│   └── litematic.js .litematic-Parser (NBT, Materialliste, Block-Gitter)
├── package.json     Abhängigkeiten
├── library.db       entsteht lokal automatisch beim ersten Start
└── public/          Frontend
    ├── index.html   Liste mit Suche und Filtern
    ├── machine.html Einzelseite (?id=…) mit 3D-Viewer + Simulation
    ├── upload.html  Upload-Formular mit Schematic-Autofill
    ├── script.js    Logik der Liste
    ├── machine.js   Logik der Einzelseite
    ├── upload.js    Logik des Formulars
    ├── viewer.js    3D-Renderer (deepslate) + Kamera + Steuerung
    ├── sim.js       Redstone-Tick-Simulation
    ├── i18n.js      Übersetzungen DE/EN
    ├── style.css    Design
    └── icon.png     Favicon + Header-Icon
```

## Lokal starten

Voraussetzung: [Node.js](https://nodejs.org) ab Version 20.

```
npm install     # einmalig: Abhängigkeiten laden
npm start       # Server starten
```

Dann http://localhost:3000 im Browser öffnen. Ohne weitere Konfiguration
landet alles in der lokalen Datei `library.db`.

## Online stellen (kostenlos)

Die App ist so gebaut, dass der Server **zustandslos** ist: Maschinen und
Schematic-Dateien liegen komplett in der Datenbank. Damit funktioniert
kostenloses Hosting, obwohl Gratis-Hoster das Dateisystem bei jedem
Neustart löschen.

Benötigt werden zwei kostenlose Konten:

**1. Turso (Datenbank, dauerhaft gratis)**

1. Auf [turso.tech](https://turso.tech) mit GitHub-Konto anmelden
2. Im Dashboard eine Datenbank anlegen (z. B. `redstone-library`)
3. Zwei Werte kopieren:
   - die **Datenbank-URL** (beginnt mit `libsql://…`)
   - einen **Auth-Token** (im Dashboard unter "Generate Token")

**2. GitHub (Code-Hosting)**

1. Neues Repository anlegen und dieses Projekt pushen
   (`.gitignore` sorgt dafür, dass `node_modules`, lokale DB usw. draußen bleiben)

**3. Render (App-Server, gratis)**

1. Auf [render.com](https://render.com) anmelden (GitHub-Login)
2. "New → Web Service" → das Repository auswählen
3. Einstellungen:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. Unter "Environment" zwei Variablen setzen:
   - `TURSO_DATABASE_URL` = die libsql://-URL aus Turso
   - `TURSO_AUTH_TOKEN` = der Token aus Turso
5. Deploy — fertig. Render zeigt die öffentliche URL an.

Hinweis zur Gratis-Stufe: Nach ~15 Minuten ohne Besucher schläft der
Server ein; der nächste Aufruf dauert dann bis zu einer Minute. Die
Daten sind davon nicht betroffen (liegen ja bei Turso).

## API

| Methode | Pfad                      | Zweck                                  |
|---------|---------------------------|----------------------------------------|
| GET     | /api/machines             | alle Maschinen (mit Materialien)       |
| GET     | /api/machines/:id         | eine Maschine                          |
| GET     | /api/machines/:id/blocks  | Block-Gitter für den 3D-Viewer         |
| POST    | /api/analyze              | .litematic hochladen + auslesen        |
| POST    | /api/machines             | neue Maschine anlegen (JSON)           |
| GET     | /download/:id             | Schematic-Datei herunterladen          |

## Simulation — Stand & Grenzen

Die Engine ist **ereignisbasiert** (Stufe 3) und arbeitet wie Vanilla
in Phasen pro Game-Tick:

1. **Tile-Ticks** mit Vanilla-Prioritäten (−3 extrem hoch … 0 normal),
   sortiert nach Zeit → Priorität → Einfüge-Reihenfolge. Verstärker
   nutzen die echten Prioritätsregeln (vor Diode: −3, beim Abschalten:
   −2, sonst −1), Fackeln/Beobachter/Lampen normale Priorität.
2. **Block-Events** für Kolben — am Tick-Ende verarbeitet, inklusive
   Events, die währenddessen neu entstehen. Dadurch funktionieren
   0-Tick-Pulse: Retract-Stornierung durch Re-Powern im selben Tick
   und "block dropping" (kurzer Puls → klebriger Kolben lässt den
   Block fallen).
3. **Bewegungs-Phase** (Vanillas Block-Entity-Phase): geschobene
   Blöcke materialisieren NACH den Block-Events; daraus entstehende
   Kolben-Events laufen erst im nächsten Tick — wie im Spiel.

Block-Updates laufen sofort und synchron in Minecrafts Reihenfolge
(West, Ost, Unten, Oben, Nord, Süd); Staub-Änderungen benachrichtigen
wie Vanilla die Nachbarn und deren Nachbarn (ohne Dedupe, in
Original-Reihenfolge). Beobachter sind shape-getrieben, pulsen auch
nach eigener Bewegung, Quasi-Konnektivität + BUD ergibt sich von
selbst, weil Kolben nur auf Block-Updates reagieren. Der Rest des
Komponentenumfangs (Staub analog, Verstärker-Locking, Komparatoren
inkl. Behälter-Durchgriff, Schienenketten, Leafstone, Stolperdrähte,
Notenblock-BUDs, Türen/Falltüren, Lampen mit 4 GT Aus-Verzögerung)
ist auf Event-Handler portiert.

Tests: `npm test` (Vanilla-Primitiven: Fackel-/Verstärker-Timing,
Puls-Garantie, Signalabfall, QC-BUD, 0-Tick-Kolben, Locking,
Beobachter-Pulse), `npm run test:door` (Integrationstest 8x8 Flush
Trapdoor Final), `npm run debug:door` (Fortschritts- und
Konsistenz-Diagnose).

Ein wichtiges Vanilla-Detail ist ebenfalls umgesetzt: **Kolbenköpfe
leiten Block-Updates an ihre Basis weiter** (wie
`PistonHeadBlock.neighborChanged`) — so wecken Nachbar-Ankünfte
QC-geparkte Kolben, deren Basis das Update selbst nie erreichen
würde. Nach dem Stillstand meldet `npm run debug:door` inzwischen
**null** inkonsistente Komponenten: jeder Zustand passt zu seinen
Eingängen, es gibt keine Endlos-Oszillationen und keine hängenden
Bewegungen mehr.

Bekannte Grenze: Die 8x8 Flush Trapdoor Final öffnet aktuell 4 ihrer
8 Spalten (außen je 2 pro Seite), dann fehlt der Startimpuls für die
Verschiebung des Block-Streifens (Tape) der Ostseite. Diagnose-Stand:
Die West-Tape-Maschinerie (y=3–7, z≤6/z≥13) läuft vollständig durch;
ihr Ost-Spiegel feuert nie. Der Ost-Trigger hängt an der
Repeater-Leitung y=5, z=19 (x=8–15), gespeist über ein
Komparator-Gate, das den Komposter (17,5,18, Level 1) liest — diese
Leitung bleibt über den ganzen Lauf tot. Nächster Schritt: verfolgen,
was dieses Gate in Vanilla freischaltet (vermutlich ein weiteres
Update-/Timing-Detail des Analog-Busses), z. B. per Referenzmessung
in echtem Minecraft. Werkzeuge dafür liegen bereit:
`test/door.debug.js` (Konsistenz-Check) und die Testfälle in
`test/sim.test.js`.
