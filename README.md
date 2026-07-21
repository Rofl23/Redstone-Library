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

## Tests

| Befehl | Was es prüft |
|--------|--------------|
| `npm test` | Vanilla-Primitiven einzeln: Fackel-/Verstärker-Timing (alle vier Delay-Stufen), Puls-Garantie, Signalabfall, QC-BUD, 0-Tick-Kolben, 12-Block-Schubgrenze, Locking, Beobachter-Pulse |
| `npm run test:machines` | Alle Maschinen in `files/` gegen allgemeine Invarianten |
| `npm run test:all` | beides |
| `npm run test:door` | Integrationstest 8x8 Flush Trapdoor Final |
| `npm run debug:door` | Fortschritts- und Konsistenz-Diagnose |

`test:machines` prüft bewusst **kein** maschinenspezifisches
Wunschergebnis, sondern Eigenschaften, die jede korrekte Engine
erfüllen muss — dadurch lässt sich die Engine nicht auf eine einzelne
Maschine überanpassen:

* **RUHE** — ohne Eingabe darf sich kein Zustand von selbst ändern
* **DETERMINISMUS** — zwei identische Läufe, Block für Block gleich
* **KONSISTENZ** — nach dem Stillstand passt jeder Zustand zu seinen
  Eingängen. BUD-geparkte Kolben zählen ausdrücklich **nicht** als
  Fehler; die sind in Vanilla legal, darauf beruht Quasi-Konnektivität
* **REVERSIBEL** — Hebel um, zur Ruhe, Hebel zurück, zur Ruhe →
  Endzustand muss dem Anfangszustand entsprechen. Der schärfste Test:
  Er fängt wandernde Blöcke, ohne dass man wissen muss, was die
  Maschine eigentlich tut

Bekannte offene Punkte stehen als `KNOWN_OPEN` in
`test/machines.test.js`. Die lassen die Suite nicht scheitern, aber
wenn einer davon plötzlich besteht, meldet die Suite das und schlägt
fehl — damit ein Fix nicht unbemerkt bleibt.

Die Aussagekraft der Tests wurde per **Mutationstest** geprüft: gezielt
eingebaute Fehler (Verstärker-Delay immer 1, QC abgeschaltet, kein
Signalabfall, 12-Block-Grenze aufgehoben) müssen von mindestens einer
Suite gefangen werden. Die ersten beiden Lücken, die dabei auffielen,
sind mit Test 9 und 10 in `sim.test.js` geschlossen.

Mehrere Vanilla-Details sind zusätzlich umgesetzt, die alle auf
demselben Muster beruhen — **welche Blöcke beim Zustandswechsel
selbst Block-Updates verschicken** (`setBlock(…, Flag 1 =
UPDATE_NEIGHBORS)`):

* **Kolbenköpfe** leiten Block-Updates an ihre Basis weiter (wie
  `PistonHeadBlock.neighborChanged`).
* **Notenblöcke** schicken beim Wechsel von `powered` Updates an alle
  6 Nachbarn (`NoteBlock.neighborChanged` → `setBlock(…, 3)`). Das ist
  der klassische Notenblock-BUD, der QC-geparkte Kolben weckt.
* **Redstone-Lampen** ebenso, beim Ein- wie beim Ausschalten.
* **Antriebsschienen** ebenso, plus die zusätzlichen expliziten
  Updates an den Block darunter (und bei Steigung darüber), wie in
  `PoweredRailBlock.updateState`.
* **Quasi-Konnektivität gilt für alle Kolben**, auch für aufwärts
  zeigende. Vanillas `PistonBaseBlock.getNeighborSignal` prüft die
  Nachbarn von `pos.above()` unabhängig vom Facing.

Türen/Falltüren verschicken bewusst **keine** Updates — Vanilla nutzt
dort Flag 2.

Nach dem Stillstand meldet `npm run debug:door` **null** inkonsistente
Komponenten: jeder Zustand passt zu seinen Eingängen, keine
Endlos-Oszillationen, keine hängenden Bewegungen.

Bekannte Grenze: Die 8x8 Flush Trapdoor Final öffnet aktuell **56 von
64** Feldern. Das Komparator-Gate der Ostseite funktioniert seit dem
Notenblock-BUD-Fix: Der Sticky-Kolben (18,5,17) schiebt den Komposter
(18,5,18) nach (18,5,19) vor den Komparator (17,5,19) — exakt
zeitgleich mit dem West-Spiegel (Kolben 3,5,2, Komposter 4,5,2 →
5,5,2, Komparator 6,5,2). Beide Analog-Leitungen (y=5, z=2 bzw.
z=19) gehen bei GT 17 an.

Offen bleiben die Nordhälften der Spalten **x=12 und x=14** (y=9,
z=7–10). Die Ursache ist zurückverfolgt bis zum Auslöser — es fehlt
kein Impuls, es ist einer **zu viel**:

```
GT 13  Notenblock (16,4,4) wird powered
GT 15  Notenblock wieder aus → Beobachter (16,4,5) pulst
GT 15  dessen Ausgang gibt QC auf (16,4,6) → Kolben (16,3,6) fährt aus
       und schiebt eine 12er-Gruppe nach Osten
       ↳ dabei wird Sticky-Kolben (16,4,9) mitgerissen
GT 15+ (16,4,9) WANDERT: 16→17→18→19… ein Block alle 10 GT
GT 21  dieser Wanderer zieht beim Einziehen die Aufwärts-Kolbenreihe
       (12…15,4,8) nach Osten, statt sie ausfahren zu lassen
       ↳ Nordhälfte x=12 und x=14 bleibt zu
```

Der Strukturspiegel **(7,3,6) feuert im ganzen Lauf kein einziges
Mal**, ebenso bleibt (7,4,9) komplett unbewegt — die Westseite
verhält sich richtig, die Ostseite hat einen Runaway. Der
Beobachter-Puls auf den Notenblock-Zustandswechsel ist dabei korrekt
(POWERED ist Teil des Blockzustands, Vanilla-Beobachter sehen das).

Der Wanderer marschiert dabei als Ganzes: Kolben (17,3,5) zieht beim
Einziehen den Schieber (16,3,6) per Slime-Klebung einen Block nach
Osten, der schiebt erneut — fünf Zyklen bis x=21, dann ist der Platz
alle.

**Bereits geprüft und als Ursache ausgeschlossen:**

* *Der Auslöser.* Notenblock (16,4,4) wird über den Target-Block
  (16,4,3) und den Staub (16,4,2) powered. Staub gibt in Vanilla
  starkes Signal in seine Zeigerichtung, der Target-Block leitet es
  als Vollblock weiter — regelkonform. Die Westseite hat an dieser
  Stelle schlicht keinen Target/Staub, die beiden Arme sind hier
  **absichtlich verschieden gebaut**, kein Spiegel.
* *Der Beobachter-Puls* auf den Notenblock-Zustandswechsel (POWERED
  gehört zum Blockzustand) und die *QC über Luft* auf (16,4,6) sind
  beide vanilla-korrekt.
* *`collectGroup`.* Eine getreue Portierung von Vanillas
  `PistonStructureResolver` (inkl. „Schubachse beim Verzweigen
  überspringen") liefert für den Schub bei GT 15 **exakt dieselben 12
  Blöcke** — keine Abweichung.
* *Die Baugruppe selbst* ist sauber ost-west-gespiegelt (Obsidian
  blockiert auf beiden Seiten die nach innen zeigenden Kolben
  (6,3,5)/(17,3,5) identisch).

Damit ist jeder Einzelschritt für sich vanilla-treu, das Gesamtergebnis
aber falsch. Nächster Verdacht: nicht *ob*, sondern *wann* — die
relative Reihenfolge von Block-Events und Bewegungs-Phase innerhalb
eines Ticks, die darüber entscheidet, ob der Zieher (17,3,5) den
Schieber (16,3,6) überhaupt noch zu fassen bekommt. Zu klären wäre am
besten per Referenzmessung in echtem Minecraft, ob die Ost-Baugruppe
dort ebenfalls wandert (dann liegt der Fehler in der Kollateralwirkung
bei GT 21) oder stillsteht (dann in der Tick-Phasenordnung).

Achtung für die Weiterarbeit: Der Bau ist **nicht** global
ost-west-gespiegelt (583 Abweichungen schon im Ausgangszustand), eine
automatische Spiegel-Bisektion greift nicht — der Vergleich muss über
die jeweiligen Bauteilpaare von Hand laufen. Werkzeuge:
`test/door.debug.js` und `test/sim.test.js`.
