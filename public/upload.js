// ---------------------------------------------------------------
// UPLOAD-FORMULAR
// Sammelt die Formulardaten ein, schickt sie als JSON per POST an
// die API und leitet bei Erfolg auf die Seite der neuen Maschine
// weiter. Lehnt der Server ab (Validierung!), zeigen wir seine
// Fehlermeldung an, statt still zu scheitern.
// ---------------------------------------------------------------

// ---- Materialzeilen: dynamisch hinzufügen / entfernen ----------
function addMaterialRow() {
  const row = document.createElement("div");
  row.className = "material-row";
  row.innerHTML = `
    <input type="text" class="mat-name" data-i18n-placeholder="matNamePlaceholder"
           placeholder="${t("matNamePlaceholder")}" maxlength="40">
    <input type="number" class="mat-amount" min="1" max="9999" value="1"
           aria-label="Anzahl">
    <button type="button" class="remove-material" aria-label="Entfernen">✕</button>
  `;
  row.querySelector(".remove-material").addEventListener("click", () => row.remove());
  document.getElementById("material-rows").appendChild(row);
}

// ---- Schematic analysieren -------------------------------------
// Sobald eine Datei gewählt wird, schicken wir sie an /api/analyze.
// Der Server parst das NBT und schickt Name, Version, Designer und
// Materialliste zurück — wir füllen damit das Formular vor.
async function handleFileChosen(event) {
  const file = event.target.files[0];
  if (!file) return;

  const status = document.getElementById("analyze-status");
  status.hidden = false;
  status.textContent = t("analyzing");

  const formData = new FormData();
  formData.append("schematic", file);

  try {
    // Kein Content-Type-Header: bei FormData setzt ihn der Browser
    // selbst (inkl. der multipart-Boundary)
    const res = await fetch("/api/analyze", { method: "POST", body: formData });
    const data = await res.json();

    if (!res.ok) {
      status.textContent = `${t("uploadFailed")} ${data.error || res.status}`;
      return;
    }

    // Formular vorausfüllen — der Nutzer kann alles noch ändern
    const el = document.getElementById("upload-form").elements;
    if (data.name) el.name.value = data.name;
    if (data.version) el.version.value = data.version;
    if (data.designer) el.designer.value = data.designer;
    el.fileToken.value = data.fileToken;

    // Materialzeilen durch die analysierten ersetzen
    document.getElementById("material-rows").innerHTML = "";
    for (const mat of data.materials) {
      addMaterialRow();
      const row = document.querySelector("#material-rows .material-row:last-child");
      row.querySelector(".mat-name").value = mat.name;
      row.querySelector(".mat-amount").value = mat.amount;
    }
    if (data.materials.length === 0) addMaterialRow();

    status.textContent = `${t("analyzed")} ${data.size ? `(${data.size}, ${data.totalBlocks} ${t("blocks")})` : ""}`;
  } catch (err) {
    console.error(err);
    status.textContent = t("loadError");
  }
}

// ---- Absenden --------------------------------------------------
async function handleSubmit(event) {
  // Standardverhalten (Seite neu laden + ?name=… in die URL) verhindern —
  // wir schicken die Daten selbst per fetch
  event.preventDefault();

  const form = event.target;
  const errorBox = document.getElementById("form-error");
  errorBox.hidden = true;

  // Materialliste einsammeln; leere Zeilen ignorieren
  const materials = [...document.querySelectorAll(".material-row")]
    .map(row => ({
      name: row.querySelector(".mat-name").value.trim(),
      amount: parseInt(row.querySelector(".mat-amount").value, 10)
    }))
    .filter(m => m.name !== "" && Number.isInteger(m.amount) && m.amount > 0);

  if (materials.length === 0) {
    errorBox.textContent = t("noMaterials");
    errorBox.hidden = false;
    return;
  }

  // Achtung, Stolperfalle: form.name wäre das name-ATTRIBUT des
  // Formulars selbst, nicht das Eingabefeld namens "name".
  // Über form.elements kommt man sicher an die Felder.
  const el = form.elements;
  const body = {
    name: el.name.value.trim(),
    category: el.category.value,
    description: el.description.value.trim(),
    version: el.version.value.trim(),
    difficulty: el.difficulty.value,
    designer: el.designer.value.trim(),
    fileToken: el.fileToken.value || undefined,
    materials
  };

  try {
    const res = await fetch("/api/machines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      // 400 / 409 vom Server: Meldung anzeigen
      errorBox.textContent = `${t("uploadFailed")} ${data.error || res.status}`;
      errorBox.hidden = false;
      return;
    }

    // Erfolg → direkt zur Seite der neuen Maschine
    window.location.href = `machine.html?id=${encodeURIComponent(data.id)}`;
  } catch (err) {
    console.error(err);
    errorBox.textContent = t("loadError");
    errorBox.hidden = false;
  }
}

// ---- Start -----------------------------------------------------
setupLanguageButton();
addMaterialRow(); // eine leere Zeile als Startpunkt
document.getElementById("schematic-file").addEventListener("change", handleFileChosen);
document.getElementById("add-material").addEventListener("click", addMaterialRow);
document.getElementById("upload-form").addEventListener("submit", handleSubmit);
