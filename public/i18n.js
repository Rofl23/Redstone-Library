// ---------------------------------------------------------------
// ÜBERSETZUNGEN — von beiden Seiten (Liste + Detailseite) benutzt.
// Die gewählte Sprache landet in localStorage, damit sie beim
// Seitenwechsel und beim nächsten Besuch erhalten bleibt.
// ---------------------------------------------------------------
const translations = {
  de: {
    title: "Redstone-Bibliothek",
    tagline: "Nachbauen ohne Rätselraten.",
    search: "Suche z. B. 'Tür' oder 'Farm'…",
    allDifficulties: "Alle Schwierigkeiten",
    easy: "Einfach",
    medium: "Mittel",
    advanced: "Fortgeschritten",
    all: "Alle",
    farms: "Farmen",
    doors: "Türen",
    storage: "Speicher",
    logic: "Logik",
    footer: "Ein Projekt für alle, die Redstone verstehen statt nur nachklicken wollen.",
    empty: "Keine Maschinen in dieser Kategorie – noch nicht.",
    materials: "Materialien",
    version: "Version",
    difficultyLabel: "Schwierigkeit",
    designer: "Design",
    uploaded: "Hochgeladen",
    download: "Download (.litematic)",
    back: "← Zurück zur Bibliothek",
    notFound: "Diese Maschine gibt es nicht (mehr).",
    loadError: "Daten konnten nicht geladen werden – läuft der Server?",
    upload: "+ Maschine hochladen",
    uploadHeading: "Neue Maschine hochladen",
    nameLabel: "Name",
    categoryLabel: "Kategorie",
    descriptionLabel: "Beschreibung",
    addMaterial: "+ Material hinzufügen",
    matNamePlaceholder: "z. B. Kolben",
    noMaterials: "Mindestens ein Material angeben.",
    uploadFailed: "Upload fehlgeschlagen:",
    submit: "Hochladen",
    schematicLabel: "Schematic-Datei (.litematic) – füllt das Formular automatisch aus",
    analyzing: "Datei wird analysiert…",
    analyzed: "Formular ausgefüllt – bitte prüfen und ggf. korrigieren.",
    blocks: "Blöcke",
    noFile: "Keine Schematic-Datei hinterlegt.",
    viewer3d: "3D-Ansicht & Simulation",
    simPlay: "Start",
    simPause: "Pause",
    simStep: "1 Tick",
    simReset: "Zurücksetzen",
    viewerLoading: "3D-Ansicht lädt… (beim ersten Mal dauert es kurz, Texturen werden geladen)",
    viewerHint: "Ziehen = Ansicht drehen · Mausrad = zoomen · Klick auf Hebel/Knopf = schalten",
    viewerHintFree: "Ziehen = umsehen · WASD + Q/E = fliegen · Mausrad = vor/zurück · Klick = schalten",
    viewerHintTouch: "1 Finger = drehen · 2 Finger = zoomen · Tippen = Hebel/Knopf schalten",
    viewerHintFreeTouch: "1 Finger = umsehen · 2 Finger zusammen/auseinander = fliegen · Tippen = schalten",
    modeOrbit: "Ansehen",
    modeFree: "Freie Kamera",
    viewerError: "3D-Ansicht konnte nicht geladen werden."
  },
  en: {
    title: "Redstone Library",
    tagline: "Build without guessing.",
    search: "Search e.g. 'door' or 'farm'…",
    allDifficulties: "All difficulties",
    easy: "Easy",
    medium: "Medium",
    advanced: "Advanced",
    all: "All",
    farms: "Farms",
    doors: "Doors",
    storage: "Storage",
    logic: "Logic",
    footer: "A project for everyone who wants to understand redstone instead of just copying it.",
    empty: "No machines in this category – yet.",
    materials: "Materials",
    version: "Version",
    difficultyLabel: "Difficulty",
    designer: "Design",
    uploaded: "Uploaded",
    download: "Download (.litematic)",
    back: "← Back to the library",
    notFound: "This machine doesn't exist (anymore).",
    loadError: "Could not load data – is the server running?",
    upload: "+ Upload a machine",
    uploadHeading: "Upload a new machine",
    nameLabel: "Name",
    categoryLabel: "Category",
    descriptionLabel: "Description",
    addMaterial: "+ Add material",
    matNamePlaceholder: "e.g. piston",
    noMaterials: "Add at least one material.",
    uploadFailed: "Upload failed:",
    submit: "Upload",
    schematicLabel: "Schematic file (.litematic) – fills the form automatically",
    analyzing: "Analyzing file…",
    analyzed: "Form filled in – please review and correct if needed.",
    blocks: "blocks",
    noFile: "No schematic file available.",
    viewer3d: "3D view & simulation",
    simPlay: "Play",
    simPause: "Pause",
    simStep: "1 tick",
    simReset: "Reset",
    viewerLoading: "Loading 3D view… (first time takes a moment, textures are loading)",
    viewerHint: "Drag = rotate view · Wheel = zoom · Click levers/buttons to toggle",
    viewerHintFree: "Drag = look around · WASD + Q/E = fly · Wheel = forward/back · Click to toggle",
    viewerHintTouch: "1 finger = rotate · 2 fingers = zoom · Tap levers/buttons to toggle",
    viewerHintFreeTouch: "1 finger = look around · pinch = fly · Tap to toggle",
    modeOrbit: "View",
    modeFree: "Free camera",
    viewerError: "Could not load the 3D view."
  }
};

// Datenwert ("Einfach") → i18n-Key ("easy"), weil die Datenbank
// deutsche Schwierigkeitsgrade speichert, die Anzeige aber
// übersetzt sein soll.
const difficultyKeys = {
  "Einfach": "easy",
  "Mittel": "medium",
  "Fortgeschritten": "advanced"
};

let language = localStorage.getItem("language") || "de";

function t(key) {
  return translations[language][key] || key;
}

function difficultyLabel(difficulty) {
  return t(difficultyKeys[difficulty]) || difficulty;
}

// Übersetzt alle statischen Texte (data-i18n / data-i18n-placeholder)
// und aktualisiert den Umschalt-Button. Was dynamisch gerendert wird
// (Karten, Detailinhalt), rendert die jeweilige Seite danach selbst
// neu — dafür ist onLanguageChange da.
let onLanguageChange = null;

function setLanguage(lang) {
  language = lang;
  localStorage.setItem("language", lang);

  document.querySelectorAll("[data-i18n]").forEach(el => {
    const text = translations[lang][el.dataset.i18n];
    if (text) el.textContent = text;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const text = translations[lang][el.dataset.i18nPlaceholder];
    if (text) el.placeholder = text;
  });

  document.documentElement.lang = lang;
  document.getElementById("language-btn").textContent =
    lang === "de" ? "🇩🇪 DE" : "🇬🇧 EN";

  if (onLanguageChange) onLanguageChange();
}

function setupLanguageButton() {
  document.getElementById("language-btn").addEventListener("click", () => {
    setLanguage(language === "de" ? "en" : "de");
  });
  // beim Laden einmal anwenden, falls gespeicherte Sprache != Standard
  setLanguage(language);
}
