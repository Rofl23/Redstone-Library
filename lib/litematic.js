// ---------------------------------------------------------------
// LITEMATIC-PARSER
// Eine .litematic-Datei ist gzip-komprimiertes NBT (Minecrafts
// Binärformat für strukturierte Daten). prismarine-nbt übernimmt
// das Entpacken und Parsen — wir müssen "nur" noch die richtigen
// Felder herausziehen und die Blöcke zählen.
// ---------------------------------------------------------------
const nbt = require("prismarine-nbt");

// ---------------------------------------------------------------
// DataVersion → Vollversion. Minecraft zählt intern jede Snapshot-
// Version hoch (DataVersion); wir übersetzen auf die Vollversion,
// in der die Schematic erstellt wurde. Nur Vollversionen seit 1.12
// (älter unterstützt Litematica nicht). Ab 2026 gilt das neue
// Schema "Jahr.Drop" (26.1, 26.2, …).
// Quelle: minecraft.wiki/w/Data_version — Einträge sind die
// DataVersion des jeweiligen Releases. Bei neuen Versionen oben
// ergänzen (und die Auswahlliste in upload.html!).
// ---------------------------------------------------------------
const DATA_VERSIONS = [
  [4902, "26.2+"],
  [4786, "26.1+"],
  [3953, "1.21+"],
  [3463, "1.20+"],
  [3105, "1.19+"],
  [2860, "1.18+"],
  [2724, "1.17+"],
  [2566, "1.16+"],
  [2225, "1.15+"],
  [1952, "1.14+"],
  [1519, "1.13+"],
  [1139, "1.12+"]
];

function gameVersionFromDataVersion(dataVersion) {
  for (const [min, label] of DATA_VERSIONS) {
    if (dataVersion >= min) return label;
  }
  return "";
}

// ---------------------------------------------------------------
// Deutsche Namen für gängige (Redstone-)Blöcke. Alles andere wird
// aus der englischen ID hübsch gemacht: "sticky_piston" → "Sticky
// Piston". Die Liste kann beliebig wachsen.
// ---------------------------------------------------------------
const BLOCK_NAMES_DE = {
  piston: "Kolben",
  sticky_piston: "Klebriger Kolben",
  redstone_wire: "Redstonestaub",
  redstone_torch: "Redstonefackel",
  redstone_wall_torch: "Redstonefackel",
  redstone_block: "Redstoneblock",
  redstone_lamp: "Redstonelampe",
  repeater: "Redstone-Verstärker",
  comparator: "Redstone-Vergleicher",
  observer: "Beobachter",
  hopper: "Trichter",
  dropper: "Spender (Dropper)",
  dispenser: "Werfer",
  chest: "Kiste",
  trapped_chest: "Redstonetruhe",
  barrel: "Fass",
  lever: "Hebel",
  stone_button: "Steinknopf",
  oak_button: "Holzknopf",
  stone_pressure_plate: "Steindruckplatte",
  oak_pressure_plate: "Holzdruckplatte",
  heavy_weighted_pressure_plate: "Wägeplatte (schwer)",
  light_weighted_pressure_plate: "Wägeplatte (leicht)",
  target: "Zielblock",
  daylight_detector: "Tageslichtsensor",
  tripwire_hook: "Haken",
  tripwire: "Stolperdraht",
  note_block: "Notenblock",
  tnt: "TNT",
  slime_block: "Schleimblock",
  honey_block: "Honigblock",
  rail: "Schiene",
  powered_rail: "Antriebsschiene",
  detector_rail: "Sensorschiene",
  activator_rail: "Aktivierungsschiene",
  iron_door: "Eisentür",
  oak_door: "Eichenholztür",
  iron_trapdoor: "Eisenfalltür",
  oak_trapdoor: "Eichenholzfalltür",
  water: "Wasser (Eimer)",
  lava: "Lava (Eimer)",
  glass: "Glas",
  stone: "Stein",
  smooth_stone: "Glatter Stein",
  cobblestone: "Bruchstein",
  dirt: "Erde",
  sand: "Sand",
  obsidian: "Obsidian",
  crafting_table: "Werkbank",
  furnace: "Ofen",
  cauldron: "Kessel",
  composter: "Komposter",
  lectern: "Lesepult",
  sculk_sensor: "Sculk-Sensor",
  calibrated_sculk_sensor: "Kalibrierter Sculk-Sensor",
  lightning_rod: "Blitzableiter",
  scaffolding: "Gerüst",
  ladder: "Leiter",
  torch: "Fackel",
  wall_torch: "Fackel",
  soul_sand: "Seelensand",
  ice: "Eis",
  packed_ice: "Packeis",
  blue_ice: "Blaueis"
};

// Blöcke, die in der Materialliste nichts verloren haben
const IGNORED_BLOCKS = new Set([
  "minecraft:air", "minecraft:cave_air", "minecraft:void_air"
]);

function displayName(blockId) {
  const short = blockId.replace("minecraft:", "");
  if (BLOCK_NAMES_DE[short]) return BLOCK_NAMES_DE[short];
  // "sticky_piston" → "Sticky Piston"
  return short.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------
// BIT-ENTPACKEN
// Litematica speichert pro Block-Position einen Index in die
// Palette, bit-gepackt in ein Array aus 64-Bit-Longs. Bei z. B.
// 5 Bits pro Index liegen 12,8 Indizes in einem Long — Indizes
// dürfen dabei über die Grenze zwischen zwei Longs laufen (anders
// als bei Vanilla-Minecraft ab 1.16, das auffüllt!).
// Wir nutzen BigInt, weil normale JS-Zahlen nur 53 Bit sicher können.
// ---------------------------------------------------------------
function unpackBlockStates(longArray, bitsPerEntry, count) {
  const bits = BigInt(bitsPerEntry);
  const mask = (1n << bits) - 1n;
  const indices = new Array(count);

  // prismarine-nbt liefert Long-Arrays als [high32, low32]-Paare
  const longs = longArray.map(([hi, lo]) =>
    (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)
  );

  for (let i = 0; i < count; i++) {
    const bitIndex = BigInt(i) * bits;
    const longIndex = Number(bitIndex >> 6n);       // / 64
    const offset = bitIndex & 63n;                  // % 64

    let value = longs[longIndex] >> offset;
    if (offset + bits > 64n) {
      // Index läuft in den nächsten Long hinein
      value |= longs[longIndex + 1] << (64n - offset);
    }
    indices[i] = Number(value & mask);
  }
  return indices;
}

// ---------------------------------------------------------------
// HAUPTFUNKTION
// Nimmt den rohen Dateiinhalt (Buffer), gibt Metadaten und
// Materialliste zurück.
// ---------------------------------------------------------------
async function parseLitematic(buffer) {
  // parse() erkennt gzip selbst und liefert einen Baum aus
  // { type, value }-Knoten. nbt.simplify() macht daraus
  // gewöhnliche JS-Objekte ohne die Typ-Hüllen.
  const { parsed } = await nbt.parse(buffer);
  const root = nbt.simplify(parsed);

  const meta = root.Metadata || {};
  const size = meta.EnclosingSize || {};

  // ---- Materialliste über alle Regionen zählen ----
  const counts = new Map();

  for (const regionName of Object.keys(root.Regions || {})) {
    const region = root.Regions[regionName];
    const palette = region.BlockStatePalette || [];
    const volume =
      Math.abs(region.Size.x) * Math.abs(region.Size.y) * Math.abs(region.Size.z);

    // Litematica nutzt mindestens 2 Bits, sonst so viele wie nötig
    const bitsPerEntry = Math.max(2, Math.ceil(Math.log2(palette.length)));

    // Das rohe (nicht simplifizierte) LongArray brauchen wir für die Bits
    const rawRegion = parsed.value.Regions.value[regionName].value;
    const longArray = rawRegion.BlockStates.value;

    const indices = unpackBlockStates(longArray, bitsPerEntry, volume);

    for (const idx of indices) {
      const block = palette[idx];
      if (!block || IGNORED_BLOCKS.has(block.Name)) continue;
      counts.set(block.Name, (counts.get(block.Name) || 0) + 1);
    }
  }

  const materials = [...counts.entries()]
    .map(([blockId, amount]) => ({ name: displayName(blockId), amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    name: meta.Name || "",
    designer: meta.Author || "",
    version: gameVersionFromDataVersion(root.MinecraftDataVersion || 0),
    size: size.x ? `${size.x}×${size.y}×${size.z}` : "",
    totalBlocks: meta.TotalBlocks ?? null,
    materials
  };
}

// ---------------------------------------------------------------
// BLOCK-GITTER FÜR DEN 3D-VIEWER
// Liefert die komplette Struktur als flaches Array: für jede
// Position ein Index in die Palette. Reihenfolge wie bei
// Litematica: erst x, dann z, dann y (y-major).
// Mehrere Regionen werden anhand ihrer Position in ein
// gemeinsames Gitter gelegt.
// ---------------------------------------------------------------
async function getBlockGrid(buffer) {
  const { parsed } = await nbt.parse(buffer);
  const root = nbt.simplify(parsed);

  const regionNames = Object.keys(root.Regions || {});
  if (regionNames.length === 0) throw new Error("Keine Regionen in der Datei");

  // Bounding-Box über alle Regionen. Achtung: Size darf in
  // Litematica negativ sein — dann liegt der Ursprung verschoben.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const regions = [];

  for (const rn of regionNames) {
    const r = root.Regions[rn];
    const ax = Math.abs(r.Size.x), ay = Math.abs(r.Size.y), az = Math.abs(r.Size.z);
    const ox = r.Position.x + Math.min(r.Size.x + 1, 0);
    const oy = r.Position.y + Math.min(r.Size.y + 1, 0);
    const oz = r.Position.z + Math.min(r.Size.z + 1, 0);
    minX = Math.min(minX, ox); maxX = Math.max(maxX, ox + ax - 1);
    minY = Math.min(minY, oy); maxY = Math.max(maxY, oy + ay - 1);
    minZ = Math.min(minZ, oz); maxZ = Math.max(maxZ, oz + az - 1);
    regions.push({
      name: rn, ax, ay, az, ox, oy, oz,
      palette: r.BlockStatePalette || [],
      longArray: parsed.value.Regions.value[rn].value.BlockStates.value
    });
  }

  const W = maxX - minX + 1, H = maxY - minY + 1, D = maxZ - minZ + 1;

  // Gemeinsame Palette über alle Regionen (Index 0 = Luft)
  const paletteIndex = new Map([["minecraft:air|{}", 0]]);
  const palette = [{ name: "minecraft:air", props: {} }];
  const blocks = new Array(W * H * D).fill(0);

  for (const reg of regions) {
    const bits = Math.max(2, Math.ceil(Math.log2(reg.palette.length)));
    const volume = reg.ax * reg.ay * reg.az;
    const indices = unpackBlockStates(reg.longArray, bits, volume);

    // lokale Palette → globale Palette übersetzen
    const localToGlobal = reg.palette.map(entry => {
      const props = entry.Properties || {};
      const key = entry.Name + "|" + JSON.stringify(props);
      if (!paletteIndex.has(key)) {
        paletteIndex.set(key, palette.length);
        palette.push({ name: entry.Name, props });
      }
      return paletteIndex.get(key);
    });

    for (let i = 0; i < volume; i++) {
      const y = Math.floor(i / (reg.ax * reg.az));
      const rem = i % (reg.ax * reg.az);
      const z = Math.floor(rem / reg.ax);
      const x = rem % reg.ax;
      const wx = reg.ox - minX + x;
      const wy = reg.oy - minY + y;
      const wz = reg.oz - minZ + z;
      blocks[(wy * D + wz) * W + wx] = localToGlobal[indices[i]];
    }
  }

  return { size: [W, H, D], palette, blocks };
}

module.exports = { parseLitematic, getBlockGrid };
