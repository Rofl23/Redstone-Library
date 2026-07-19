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

Die Tick-Simulation beherrscht: Staub mit analogen Signalstärken,
Hebel/Knöpfe, Fackeln, Verstärker (Delay + Locking), Komparatoren
(Vergleich/Subtraktion, Komposter-/Zielblock-Auslesen, Durchgriff durch
Blöcke), Lampen, Beobachter, Kolben mit Schleim-/Honig-Gruppen und
bewegten Blöcken (2-GT-Zwischenzustand), Quasi-Konnektivität mit
BUD-Verhalten, Antriebs-/Aktivierungsschienen, Türen/Falltüren,
Notenblöcke, Leafstone und Stolperdrähte.

Bekannte Grenze: Designs, die auf Minecrafts exakte ereignisbasierte
Update-Reihenfolge kompiliert sind (0-Tick-Tech, große "Final"-Türen),
laufen noch nicht zyklusgenau. Dafür müsste die Engine von "pro Tick
global rechnen" auf Vanilla-artige Ereignisverarbeitung umgebaut
werden — geplanter nächster großer Meilenstein.
