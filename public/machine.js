// ---------------------------------------------------------------
// DETAILSEITE
// Welche Maschine gezeigt wird, steht in der URL:
//   machine.html?id=auto-weizenfarm
// URLSearchParams liest den ?id=…-Teil aus, dann holen wir genau
// diese eine Maschine von der API (/api/machines/:id).
// ---------------------------------------------------------------
let machine = null;

function renderDetail() {
  const container = document.getElementById("machine-detail");

  if (!machine) {
    container.innerHTML = `<p class="empty-state">${t("notFound")}</p>`;
    return;
  }

  const dateLocale = language === "de" ? "de-DE" : "en-GB";
  const date = new Date(machine.uploadDate).toLocaleDateString(dateLocale, {
    year: "numeric", month: "long", day: "numeric"
  });

  const materialRows = machine.materials
    .map(m => `<li><span class="mat-amount">${m.amount}×</span> ${m.name}</li>`)
    .join("");

  document.title = `${localName(machine)} – ${t("title")}`;

  container.innerHTML = `
    <h2 class="detail-title">${localName(machine)}</h2>
    <p class="card-desc">${localDesc(machine)}</p>

    <dl class="detail-meta">
      <dt>${t("version")}</dt><dd>${machine.version}</dd>
      <dt>${t("difficultyLabel")}</dt><dd>${difficultyLabel(machine.difficulty)}</dd>
      <dt>${t("designer")}</dt><dd>${machine.designer}</dd>
      <dt>${t("uploaded")}</dt><dd>${date}</dd>
    </dl>

    <h3 class="detail-heading">${t("materials")}</h3>
    <ul class="material-list">${materialRows}</ul>

    ${machine.downloadUrl && machine.downloadUrl !== "#"
      ? `<a class="download-btn" href="${machine.downloadUrl}">${t("download")}</a>`
      : `<p class="empty-state">${t("noFile")}</p>`}
  `;
}

async function init() {
  onLanguageChange = renderDetail; // Sprachwechsel → Inhalt neu rendern
  setupLanguageButton();

  const id = new URLSearchParams(window.location.search).get("id");

  try {
    const res = await fetch(`/api/machines/${encodeURIComponent(id)}`);
    if (res.ok) {
      machine = await res.json();
      // dem 3D-Viewer (viewer.js, lädt asynchron als Modul) Bescheid
      // geben — er zeigt sich nur, wenn eine Schematic-Datei existiert
      if (machine.downloadUrl && machine.downloadUrl !== "#") {
        window.__machineLoaded = machine.id;
        document.dispatchEvent(new CustomEvent("machine-loaded", { detail: machine.id }));
      }
    }
    // bei 404 bleibt machine null → renderDetail zeigt "nicht gefunden"
    renderDetail();
  } catch (err) {
    console.error(err);
    document.getElementById("machine-detail").innerHTML =
      `<p class="empty-state">${t("loadError")}</p>`;
  }
}

init();
