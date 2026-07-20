// ---------------------------------------------------------------
// LISTEN-SEITE
// Die Daten kommen jetzt nicht mehr aus einem fest eingetippten
// Array, sondern per fetch() aus unserer eigenen API (/api/machines).
// Der Server liest sie aus der SQLite-Datenbank.
// ---------------------------------------------------------------
let machines = []; // wird nach dem Laden gefüllt

// ---------------------------------------------------------------
// RENDERING
// Jede Karte ist jetzt ein Link auf ihre eigene Seite:
// machine.html?id=auto-weizenfarm
// ---------------------------------------------------------------
function renderMachines(list) {
  const grid = document.getElementById("machine-grid");
  grid.innerHTML = "";

  if (list.length === 0) {
    grid.innerHTML = `<p class="empty-state">${t("empty")}</p>`;
    return;
  }

  list.forEach(machine => {
    const card = document.createElement("a");
    card.className = "card";
    card.href = `machine.html?id=${encodeURIComponent(machine.id)}`;
    card.innerHTML = `
      <h2 class="card-title">${localName(machine)}</h2>
      <p class="card-desc">${localDesc(machine)}</p>
      <div class="card-meta">
        <span class="tag category">${machine.category}</span>
        <span class="tag">${machine.version}</span>
        <span class="tag">${difficultyLabel(machine.difficulty)}</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

// ---------------------------------------------------------------
// FILTERUNG (unverändert: alle drei Filter zusammen anwenden)
// ---------------------------------------------------------------
const activeFilters = {
  category: "alle",
  difficulty: "alle",
  search: ""
};

function applyFilters() {
  const filtered = machines.filter(m => {
    const matchesCategory =
      activeFilters.category === "alle" || m.category === activeFilters.category;

    const matchesDifficulty =
      activeFilters.difficulty === "alle" || m.difficulty === activeFilters.difficulty;

    const searchTerm = activeFilters.search.toLowerCase();
    const matchesSearch =
      searchTerm === "" ||
      m.name.toLowerCase().includes(searchTerm) ||
      m.description.toLowerCase().includes(searchTerm) ||
      (m.nameEn || "").toLowerCase().includes(searchTerm) ||
      (m.descriptionEn || "").toLowerCase().includes(searchTerm);

    return matchesCategory && matchesDifficulty && matchesSearch;
  });

  renderMachines(filtered);
}

function setupFilters() {
  const buttons = document.querySelectorAll(".filter-btn");
  buttons.forEach(button => {
    button.addEventListener("click", () => {
      buttons.forEach(b => b.classList.remove("active"));
      button.classList.add("active");
      activeFilters.category = button.dataset.filter;
      applyFilters();
    });
  });

  const difficultySelect = document.getElementById("difficulty-select");
  difficultySelect.addEventListener("change", () => {
    activeFilters.difficulty = difficultySelect.value;
    applyFilters();
  });

  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", () => {
    activeFilters.search = searchInput.value;
    applyFilters();
  });
}

// ---------------------------------------------------------------
// START
// async/await: wir warten auf die Antwort der API, bevor wir
// rendern. Schlägt das fehl (Server aus?), zeigen wir eine Meldung.
// ---------------------------------------------------------------
async function init() {
  onLanguageChange = applyFilters; // Sprachwechsel → Karten neu rendern
  setupLanguageButton();
  setupFilters();

  try {
    const res = await fetch("/api/machines");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    machines = await res.json();
    applyFilters();
  } catch (err) {
    console.error(err);
    document.getElementById("machine-grid").innerHTML =
      `<p class="empty-state">${t("loadError")}</p>`;
  }
}

init();
