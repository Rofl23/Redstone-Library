// ---------------------------------------------------------------
// 3D-VIEWER
// Rendert die Schematic in echter Minecraft-Optik mit deepslate
// (Bibliothek der misode.github.io-Tools). deepslate und gl-matrix
// werden lokal vom eigenen Server geladen (/vendor/…); nur die
// Vanilla-Texturen/Modelle kommen vom mcmeta-Projekt (GitHub).
// Die Simulation (sim.js) läuft daneben und meldet Änderungen;
// wir bauen dann nur die Buffer neu.
// deepslate und glMatrix sind globale Variablen aus den
// <script>-Tags in machine.html.
// ---------------------------------------------------------------
const { mat4, vec3 } = glMatrix;

// Wichtig: auf einen festen Datenstand gepinnt! Der "summary"-Zweig
// folgt immer der neuesten Minecraft-Version, und deren Modellformat
// (26.x) ist mit deepslate 0.19 nicht mehr kompatibel — Blöcke wie
// Glas und Redstone-Staub wurden dann still übersprungen
// ("t.startsWith is not a function"). 1.21.1 passt zur Bibliothek.
const MCMETA_VERSION = "1.21.1";
const MCMETA = "https://raw.githubusercontent.com/misode/mcmeta/";

// ---- Assets laden (einmalig, ~5 MB, wird vom Browser gecacht) --
async function loadResources() {
  const [blockstates, models, uvMap, atlasImage] = await Promise.all([
    fetch(MCMETA + MCMETA_VERSION + "-summary/assets/block_definition/data.min.json").then(r => r.json()),
    fetch(MCMETA + MCMETA_VERSION + "-summary/assets/model/data.min.json").then(r => r.json()),
    fetch(MCMETA + MCMETA_VERSION + "-atlas/all/data.min.json").then(r => r.json()),
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.crossOrigin = "Anonymous";
      img.src = MCMETA + MCMETA_VERSION + "-atlas/all/atlas.png";
    })
  ]);

  // Blockstate-Definitionen und Modelle in deepslate-Objekte heben.
  // fromJson hatte je nach Version 1 oder 2 Parameter — wir prüfen das.
  const twoArg = deepslate.BlockDefinition.fromJson.length >= 2;
  const blockDefinitions = {};
  for (const id of Object.keys(blockstates)) {
    blockDefinitions["minecraft:" + id] = twoArg
      ? deepslate.BlockDefinition.fromJson(id, blockstates[id])
      : deepslate.BlockDefinition.fromJson(blockstates[id]);
  }
  const twoArgM = deepslate.BlockModel.fromJson.length >= 2;
  const blockModels = {};
  for (const id of Object.keys(models)) {
    blockModels["minecraft:" + id] = twoArgM
      ? deepslate.BlockModel.fromJson(id, models[id])
      : deepslate.BlockModel.fromJson(models[id]);
  }
  Object.values(blockModels).forEach(m =>
    m.flatten({ getBlockModel: id => blockModels[id.toString()] }));

  // Textur-Atlas: ein großes PNG + UV-Tabelle, wo welche Textur liegt
  const atlasSize = deepslate.upperPowerOfTwo(Math.max(atlasImage.width, atlasImage.height));
  const canvas = document.createElement("canvas");
  canvas.width = atlasSize; canvas.height = atlasSize;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(atlasImage, 0, 0);
  const atlasData = ctx.getImageData(0, 0, atlasSize, atlasSize);
  const idMap = {};
  for (const id of Object.keys(uvMap)) {
    const [u, v, du, dv] = uvMap[id];
    const dv2 = (du !== dv && id.startsWith("block/")) ? du : dv;
    idMap["minecraft:" + id] = [u / atlasSize, v / atlasSize, (u + du) / atlasSize, (v + dv2) / atlasSize];
  }
  const textureAtlas = new deepslate.TextureAtlas(atlasData, idMap);

  // Diagnose: fehlende Texturen nicht crashen lassen (deepslate
  // überspringt sonst den ganzen Block), sondern sammeln und mit
  // einer Ersatz-UV rendern — dann sieht man den Block wenigstens
  const missingTextures = new Set();

  return {
    missingTextures,
    getBlockDefinition(id) { return blockDefinitions[id.toString()]; },
    getBlockModel(id) { return blockModels[id.toString()]; },
    getTextureUV(id) {
      const uv = idMap[id.toString()];
      if (!uv) {
        missingTextures.add(id.toString());
        return [0, 0, 16 / atlasSize, 16 / atlasSize]; // Ersatz statt Absturz
      }
      return textureAtlas.getTextureUV(id);
    },
    getTextureAtlas() { return textureAtlas.getTextureAtlas(); },
    getBlockFlags() { return { opaque: false }; },
    getBlockProperties() { return null; },
    getDefaultBlockProperties() { return null; }
  };
}

// ---- Brücke Simulation → deepslate -----------------------------
// deepslate braucht nur getSize/getBlocks/getBlock; statt echte
// Structure-Objekte neu zu bauen, lesen wir direkt aus der Sim.
class SimStructure {
  constructor(sim) { this.sim = sim; }
  getSize() { return [this.sim.W, this.sim.H, this.sim.D]; }
  getBlock(pos) {
    const c = this.sim.get(pos[0], pos[1], pos[2]);
    // moving_piston = Block "in Bewegung" — hat kein Modell, wird
    // für die 2 Ticks der Bewegung einfach nicht gezeichnet
    if (!c || c.name === "minecraft:air" || c.name === "minecraft:moving_piston") return null;
    return { pos, state: new deepslate.BlockState(deepslate.Identifier.parse(c.name), c.props) };
  }
  getBlocks() {
    const out = [];
    this.sim.eachCell((c, x, y, z) => {
      if (c.name !== "minecraft:air" && c.name !== "minecraft:moving_piston")
        out.push({ pos: [x, y, z], state: new deepslate.BlockState(deepslate.Identifier.parse(c.name), c.props) });
    });
    return out;
  }
}

// ---- Viewer-Start ----------------------------------------------
async function initViewer(machineId) {
  const section = document.getElementById("viewer-section");
  const status = document.getElementById("viewer-status");
  const canvas = document.getElementById("structure-canvas");
  section.hidden = false;
  status.textContent = t("viewerLoading");

  let grid;
  try {
    const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/blocks`);
    if (!res.ok) { section.hidden = true; return; }
    grid = await res.json();
  } catch { section.hidden = true; return; }

  let resources;
  try {
    resources = await loadResources();
  } catch (err) {
    console.error(err);
    status.textContent = t("viewerError") + " [" + err.message + "]";
    return;
  }

  // Simulation aufsetzen (RedstoneSim kommt aus sim.js, klassisch
  // geladen). settle() normalisiert gespeicherte Signalreste, BEVOR
  // der Renderer den Anfangszustand einliest — sonst geht die
  // Maschine beim ersten Start von selbst los.
  const sim = new RedstoneSim(grid);
  sim.settle();

  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const gl = canvas.getContext("webgl");
  if (!gl) { status.textContent = t("viewerError"); return; }

  // deepslate fängt Fehler pro Block ab und loggt sie nur in die
  // Konsole — wir hören mit und zeigen sie in der Statuszeile an,
  // damit man z. B. "Error rendering block redstone_wire" auch
  // ohne offene Konsole sieht
  const renderErrors = new Set();
  const origConsoleError = console.error.bind(console);
  console.error = (...args) => {
    const msg = String(args[0]);
    if (msg.includes("Error rendering block")) {
      renderErrors.add(msg.replace("Error rendering block ", "") +
        (args[1] && args[1].message ? " → " + args[1].message : ""));
    }
    origConsoleError(...args);
  };

  const structure = new SimStructure(sim);
  const renderer = new deepslate.StructureRenderer(gl, structure, resources);

  // Diagnose-Ausgabe nach dem ersten Buffer-Aufbau
  setTimeout(() => {
    const problems = [];
    if (renderErrors.size) problems.push("Renderfehler: " + [...renderErrors].slice(0, 3).join(" · "));
    if (resources.missingTextures.size) problems.push("Fehlende Texturen: " + [...resources.missingTextures].slice(0, 5).join(", "));
    if (problems.length) {
      document.getElementById("viewer-status").textContent = "⚠ " + problems.join(" — ");
      origConsoleError("Viewer-Diagnose:", problems.join(" — "));
    }
  }, 500);

  // ---- Kamera: zwei Modi ----
  // "orbit": nur anschauen — Ziehen dreht die Ansicht um die
  //          Konstruktion, Rad zoomt. Kein WASD.
  // "free":  freie Kamera — Ziehen dreht die Kamera selbst
  //          (umschauen), WASD + Q/E fliegen, Rad = vor/zurück.
  // Beim Umschalten wird die Kameraposition so umgerechnet, dass
  // sich das Bild nicht ändert.
  const center = [grid.size[0] / 2, grid.size[1] / 2, grid.size[2] / 2];
  let yaw = 0.7, pitch = 0.5;
  let dist = Math.max(...grid.size) * 1.8 + 2;
  let mode = "orbit";
  let eye = [0, 0, 0];
  const keys = new Set();

  // Richtung von der Kamera weg nach hinten (Gegenteil der Blickrichtung)
  function backVector() {
    return [
      -Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw)
    ];
  }

  function viewMatrix() {
    const view = mat4.create();
    if (mode === "orbit") {
      mat4.translate(view, view, [0, 0, -dist]);
      mat4.rotateX(view, view, pitch);
      mat4.rotateY(view, view, yaw);
      mat4.translate(view, view, [-center[0], -center[1], -center[2]]);
    } else {
      mat4.rotateX(view, view, pitch);
      mat4.rotateY(view, view, yaw);
      mat4.translate(view, view, [-eye[0], -eye[1], -eye[2]]);
    }
    return view;
  }

  let needsRedraw = true;
  function render() {
    // WASD/QE: nur im freien Modus, pro Frame solange gedrückt
    if (mode === "free" && keys.size) {
      const speed = 0.35;
      const fwd = [Math.sin(yaw), 0, -Math.cos(yaw)];
      const right = [Math.cos(yaw), 0, Math.sin(yaw)];
      if (keys.has("w")) { eye[0] += fwd[0] * speed; eye[2] += fwd[2] * speed; }
      if (keys.has("s")) { eye[0] -= fwd[0] * speed; eye[2] -= fwd[2] * speed; }
      if (keys.has("a")) { eye[0] -= right[0] * speed; eye[2] -= right[2] * speed; }
      if (keys.has("d")) { eye[0] += right[0] * speed; eye[2] += right[2] * speed; }
      if (keys.has("e")) eye[1] += speed;
      if (keys.has("q")) eye[1] -= speed;
      needsRedraw = true;
    }
    if (needsRedraw) {
      needsRedraw = false;
      renderer.drawStructure(viewMatrix());
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // Tasten nur abgreifen, wenn der Nutzer nicht gerade tippt
  window.addEventListener("keydown", e => {
    if (/input|textarea|select/i.test(document.activeElement?.tagName || "")) return;
    const k = e.key.toLowerCase();
    if ("wasdqe".includes(k)) { keys.add(k); e.preventDefault(); }
  });
  window.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());

  // Nur die 16er-Chunks neu bauen, in denen sich etwas geändert hat —
  // sonst ruckelt jede große Maschine bei jedem Tick
  sim.onChange = changedList => {
    try {
      if (changedList && changedList.length) {
        const chunkSet = new Set(changedList.map(([x, y, z]) =>
          (x >> 4) + "," + (y >> 4) + "," + (z >> 4)));
        renderer.updateStructureBuffers([...chunkSet].map(s => s.split(",").map(Number)));
      } else {
        renderer.updateStructureBuffers();
      }
    } catch {
      renderer.updateStructureBuffers(); // Fallback: alles neu
    }
    needsRedraw = true;
  };

  // ---- Maussteuerung ----
  let dragging = false, moved = false, lastX = 0, lastY = 0;
  canvas.addEventListener("mousedown", e => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener("mouseup", () => { dragging = false; });
  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    yaw += dx / 120; pitch += dy / 120;
    pitch = Math.max(-1.55, Math.min(1.55, pitch));
    lastX = e.clientX; lastY = e.clientY;
    needsRedraw = true;
  });
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    if (mode === "orbit") {
      dist = Math.max(3, Math.min(120, dist + e.deltaY * 0.02));
    } else {
      // freier Modus: Rad fliegt vor/zurück entlang der Blickrichtung
      const b = backVector();
      const step = e.deltaY * 0.02;
      eye[0] += b[0] * step; eye[1] += b[1] * step; eye[2] += b[2] * step;
    }
    needsRedraw = true;
  }, { passive: false });

  // ---- Modus-Umschalter ----
  const modeBtn = document.getElementById("cam-mode");
  const updateModeUI = () => {
    modeBtn.textContent = mode === "orbit" ? "👁 " + t("modeOrbit") : "✈ " + t("modeFree");
    status.textContent = mode === "orbit" ? t("viewerHint") : t("viewerHintFree");
  };
  modeBtn.addEventListener("click", () => {
    const b = backVector();
    if (mode === "orbit") {
      // Kamera dort platzieren, wo sie gerade "steht" — Bild bleibt gleich
      eye = [center[0] + b[0] * dist, center[1] + b[1] * dist, center[2] + b[2] * dist];
      mode = "free";
    } else {
      // Orbit-Mittelpunkt vor die Kamera legen — Bild bleibt gleich
      center[0] = eye[0] - b[0] * dist;
      center[1] = eye[1] - b[1] * dist;
      center[2] = eye[2] - b[2] * dist;
      mode = "orbit";
    }
    updateModeUI();
    needsRedraw = true;
  });

  // ---- Klick → Raycast ins Gitter → Hebel/Knopf schalten ----
  canvas.addEventListener("click", e => {
    if (moved) return; // war ein Drag, kein Klick
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);

    // Strahl aus der Kamera rekonstruieren (inverse view-projection)
    const proj = mat4.perspective(mat4.create(), 70 * Math.PI / 180,
      canvas.clientWidth / canvas.clientHeight, 0.1, 500);
    const inv = mat4.invert(mat4.create(), mat4.multiply(mat4.create(), proj, viewMatrix()));
    const p0 = vec3.transformMat4(vec3.create(), [ndcX, ndcY, -1], inv);
    const p1 = vec3.transformMat4(vec3.create(), [ndcX, ndcY, 1], inv);
    const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), p1, p0));

    // DDA: den Strahl Block für Block durchs Gitter laufen lassen
    let [px, py, pz] = p0;
    for (let step = 0; step < 600; step++) {
      const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
      const c = sim.get(bx, by, bz);
      if (c && c.name !== "minecraft:air") {
        if (sim.interact(bx, by, bz)) { doTick(); }
        return;
      }
      px += dir[0] * 0.25; py += dir[1] * 0.25; pz += dir[2] * 0.25;
    }
  });

  // ---- Simulations-Steuerung ----
  // Der Tick-Zähler macht sichtbar, dass "1 Tick" auch dann etwas
  // tut, wenn sich in der Schaltung gerade nichts ändert
  let timer = null;
  const playBtn = document.getElementById("sim-play");
  const tickCounter = document.getElementById("tick-counter");
  const speedSelect = document.getElementById("sim-speed");
  const doTick = () => { sim.tick(); tickCounter.textContent = "GT " + sim.gameTick; };
  // 1× = 20 GT/s wie im Spiel; 0.1× = Zeitlupe zum Nachvollziehen
  const interval = () => 50 / parseFloat(speedSelect.value);
  playBtn.addEventListener("click", () => {
    if (timer) {
      clearInterval(timer); timer = null;
      playBtn.textContent = "▶ " + t("simPlay");
    } else {
      timer = setInterval(doTick, interval());
      playBtn.textContent = "⏸ " + t("simPause");
    }
  });
  speedSelect.addEventListener("change", () => {
    if (timer) { clearInterval(timer); timer = setInterval(doTick, interval()); }
  });
  document.getElementById("sim-step").addEventListener("click", doTick);
  document.getElementById("sim-reset").addEventListener("click", () => {
    if (timer) { clearInterval(timer); timer = null; playBtn.textContent = "▶ " + t("simPlay"); }
    sim.reset(); sim.settle();
    tickCounter.textContent = "GT 0";
  });

  updateModeUI();
}

// machine.js meldet, wenn die Maschine geladen ist. Fehler beim
// Start sollen sichtbar sein, nicht nur in der Konsole landen.
function startViewer(id) {
  initViewer(id).catch(err => {
    console.error(err);
    const status = document.getElementById("viewer-status");
    document.getElementById("viewer-section").hidden = false;
    status.textContent = t("viewerError") + " [" + err.message + "]";
  });
}
if (window.__machineLoaded) startViewer(window.__machineLoaded);
document.addEventListener("machine-loaded", e => startViewer(e.detail));
