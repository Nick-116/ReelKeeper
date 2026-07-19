const express = require("express");
const fs = require("fs");
const path = require("path");
const yauzl = require("yauzl");

const app = express();
const port = Number(process.env.PORT || 3000);
const dataFile = process.env.DATA_FILE || path.join(__dirname, "data", "reelkeeper.json");
const lcscPhotoCache = new Map();

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const now = () => new Date().toISOString();

function seedData() {
  return {
    parts: [],
    movements: [],
    importBatches: [],
    bomMatchRules: []
  };
}

function ensureStore() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(seedData(), null, 2));
  }
}

function readStore() {
  ensureStore();
  const store = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  store.parts ||= [];
  store.movements ||= [];
  store.importBatches ||= [];
  store.bomMatchRules ||= [];
  return store;
}

function writeStore(store) {
  const tmp = `${dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, dataFile);
}

function normalizePart(input, existing = {}) {
  const text = (value) => String(value || "").trim();
  const number = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const base = {
    ...existing,
    id: existing.id || input.id || `part_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: text(input.name) || text(input.description) || existing.name || "Unnamed part",
    category: text(input.category) || (existing.category && existing.category !== "Uncategorized" ? existing.category : inferCategory({ ...existing, ...input })),
    manufacturer: text(input.manufacturer) || existing.manufacturer || "",
    mpn: text(input.mpn || input.manufacturerPartNumber) || existing.mpn || "",
    lcsc: text(input.lcsc || input.lcscPartNumber || input.supplierPart) || existing.lcsc || "",
    package: text(input.package || input.footprint) || existing.package || "",
    value: text(input.value) || existing.value || "",
    description: text(input.description) || existing.description || "",
    storageType: normalizeStorageType(input.storageType || input.packagingStatus || existing.storageType),
    quantity: Math.max(0, number(input.quantity, existing.quantity || 0)),
    minimum: Math.max(0, number(input.minimum, existing.minimum || 0)),
    location: text(input.location) || existing.location || "",
    photoUrl: text(input.photoUrl) || existing.photoUrl || "",
    notes: text(input.notes) || existing.notes || "",
    createdAt: existing.createdAt || now(),
    updatedAt: now()
  };

  return { ...base, specs: deriveSpecs(base) };
}

function normalizeStorageType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("loose") || text.includes("bag") || text.includes("unpack")) return "loose";
  if (text.includes("mixed")) return "mixed";
  return "machine-ready";
}

function partKey(part) {
  return [
    part.lcsc && `lcsc:${part.lcsc.toLowerCase()}`,
    part.mpn && `mpn:${part.mpn.toLowerCase()}`,
    part.name && part.package && part.value && `combo:${part.name.toLowerCase()}|${part.package.toLowerCase()}|${part.value.toLowerCase()}`
  ].filter(Boolean);
}

function findPart(parts, row) {
  const requestedId = String(row.id || row.partId || "").trim();
  if (requestedId) return parts.find((part) => part.id === requestedId);
  const wanted = partKey(normalizePart(row));
  return parts.find((part) => partKey(part).some((key) => wanted.includes(key)));
}

function findImportPart(parts, row) {
  const wanted = partKey(normalizePart(row));
  const storageType = row.storageType || "machine-ready";
  return parts.find((part) =>
    (part.storageType || "machine-ready") === storageType &&
    partKey(part).some((key) => wanted.includes(key))
  );
}

function inferCategory(input) {
  const designator = String(input.designator || "").trim().toUpperCase();
  const footprint = String(input.footprint || input.package || "").trim().toUpperCase();
  const text = [input.name, input.description, input.comment, input.value, input.mpn, input.manufacturerPartNumber].join(" ").toLowerCase();
  const firstRef = designator.match(/[A-Z]+/)?.[0] || "";

  if (firstRef === "R" || /^R\d{4}$/.test(footprint) || /\b(resistor|ohm|Ω|kohm|mohm)\b/i.test(text)) return "Resistors";
  if (firstRef === "C" || /^C\d{4}$/.test(footprint) || /\b(capacitor|ceramic capacitor|electrolytic|uf|nf|pf)\b/i.test(text)) return "Capacitors";
  if (firstRef === "L" || footprint.includes("IND") || /\b(inductor|ferrite|bead|uh|nh)\b|swpa\d/i.test(text)) return "Inductors";
  if (firstRef === "D" || /\b(diode|tvs|zener|rectifier|schottky|esd)\b/i.test(text)) return "Diodes";
  if (firstRef === "LED" || footprint.includes("LED") || /\bled\b/i.test(text)) return "LEDs";
  if (firstRef === "F" || /\b(fuse|ptc)\b/i.test(text)) return "Fuses";
  if (["J", "P", "CN", "CON", "DC"].includes(firstRef) || /\b(connector|terminal block|receptacle|header|jack|socket)\b/i.test(text)) return "Connectors";
  if (["U", "IC"].includes(firstRef) || /\b(mcu|microcontroller|regulators?|converters?|transceivers?|modules?|amplifiers?|drivers?|ic)\b/i.test(text)) return "ICs & Modules";
  if (["Q", "M"].includes(firstRef) || /\b(mosfet|transistor|bjt)\b/i.test(text)) return "Transistors";
  if (firstRef === "SW" || /\b(switch|button)\b/i.test(text)) return "Switches";
  if (["Y", "X"].includes(firstRef) || /\b(crystal|oscillator|resonator)\b/i.test(text)) return "Crystals & Oscillators";
  return "Uncategorized";
}

function normalizePackage(value) {
  const raw = String(value || "").toUpperCase();
  const cleaned = raw.replace(/[_\s]/g, "-");
  const chip = cleaned.match(/(?:^|[^0-9])([CRL]?(?:0201|0402|0603|0805|1206|1210|1812|2010|2512))(?:[^0-9]|$)/);
  if (chip) return chip[1].replace(/^[CRL]/, "");
  const packageMatch = cleaned.match(/\b(SOD-?\d+[A-Z]?|SMA|SMB|SMC|SOT-?23(?:-\d)?|TSOT-?23(?:-\d)?|SOIC-?\d+|SOP-?\d+|TSSOP-?\d+|QFN-?\d+|DFN-?\d+|DIP-?\d+|SMA\(DO-214AC\))\b/);
  if (packageMatch) return packageMatch[1].replace("SMA(DO-214AC)", "SMA");
  const size = cleaned.match(/L(\d+(?:\.\d+)?)-W(\d+(?:\.\d+)?)/);
  if (size) return `L${size[1]}W${size[2]}`;
  return raw.trim();
}

function parseMetricValue(value, category) {
  let raw = String(value || "").toLowerCase().replace(/ω/g, "ohm").replace(/µ/g, "u").replace(/\s+/g, "");
  if (!raw || raw === "-") return null;

  if (category === "Resistors") {
    raw = raw.replace(/r(?=\d)/, ".").replace(/k/, "k").replace(/m/, "m");
    const match = raw.match(/(\d+(?:\.\d+)?)(r|ohm|k|kohm|m|mohm)?/);
    if (!match) return null;
    const multiplier = match[2] === "k" || match[2] === "kohm" ? 1_000 : match[2] === "m" || match[2] === "mohm" ? 1_000_000 : 1;
    return { kind: "resistance", value: Number(match[1]) * multiplier, unit: "ohm" };
  }

  if (category === "Capacitors") {
    const match = raw.match(/(\d+(?:\.\d+)?)(pf|nf|uf|mf|f)/);
    if (!match) return null;
    const multipliers = { pf: 1e-12, nf: 1e-9, uf: 1e-6, mf: 1e-3, f: 1 };
    return { kind: "capacitance", value: Number(match[1]) * multipliers[match[2]], unit: "F" };
  }

  if (category === "Inductors") {
    const code = raw.match(/(\d+)r(\d+)/);
    if (code) return { kind: "inductance", value: Number(`${code[1]}.${code[2]}`) * 1e-6, unit: "H" };
    const match = raw.match(/(\d+(?:\.\d+)?)(nh|uh|mh|h)/);
    if (!match) return null;
    const multipliers = { nh: 1e-9, uh: 1e-6, mh: 1e-3, h: 1 };
    return { kind: "inductance", value: Number(match[1]) * multipliers[match[2]], unit: "H" };
  }

  return null;
}

function parseVoltage(...values) {
  const raw = values.join(" ").toLowerCase();
  const matches = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*(kv|v)\b/g)];
  if (!matches.length) return null;
  return Math.max(...matches.map((match) => Number(match[1]) * (match[2] === "kv" ? 1000 : 1)));
}

function deriveSpecs(input) {
  const category = input.category || inferCategory(input);
  const valueSource = input.value || input.comment || input.name || input.description || input.mpn || "";
  return {
    category,
    package: normalizePackage(input.package || input.footprint),
    electrical: parseMetricValue(valueSource, category),
    voltage: parseVoltage(input.value, input.comment, input.name, input.description, input.mpn)
  };
}

function closeEnough(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  const diff = Math.abs(a.value - b.value);
  const basis = Math.max(Math.abs(a.value), Math.abs(b.value), 1e-15);
  return diff / basis < 0.001;
}

function compatibility(part, request) {
  const req = normalizePart(request);
  const have = part.specs || deriveSpecs(part);
  const exact = (req.lcsc && part.lcsc && req.lcsc.toLowerCase() === part.lcsc.toLowerCase()) ||
    (req.mpn && part.mpn && req.mpn.toLowerCase() === part.mpn.toLowerCase());

  if (exact) {
    return { ok: true, score: 100, reasons: ["Exact supplier or manufacturer part match"] };
  }

  if (!["Resistors", "Capacitors", "Inductors"].includes(req.category)) {
    return { ok: false, score: 0, reasons: ["Exact part number required for this category"] };
  }

  const reasons = [];
  if (req.category !== "Uncategorized" && have.category !== req.category) return { ok: false, score: 0, reasons: ["Different category"] };
  reasons.push(`Category: ${req.category}`);

  if (req.specs.package && have.package && req.specs.package !== have.package) return { ok: false, score: 0, reasons: [`Package mismatch: need ${req.specs.package}, have ${have.package}`] };
  if (req.specs.package && have.package) reasons.push(`Package: ${have.package}`);

  if (req.specs.electrical) {
    if (!have.electrical || !closeEnough(have.electrical, req.specs.electrical)) return { ok: false, score: 0, reasons: ["Electrical value mismatch"] };
    reasons.push("Electrical value matches");
  }

  if (req.specs.voltage) {
    if (!have.voltage || have.voltage < req.specs.voltage) return { ok: false, score: 0, reasons: [`Voltage too low or unknown: need ${req.specs.voltage}V`] };
    reasons.push(`Voltage: ${have.voltage}V >= ${req.specs.voltage}V`);
  }

  return { ok: reasons.length >= 2, score: reasons.length * 10, reasons };
}

function compatibleParts(parts, row) {
  return parts
    .map((part) => ({ part, match: compatibility(part, row) }))
    .filter((item) => item.match.ok)
    .sort((a, b) => b.match.score - a.match.score || b.part.quantity - a.part.quantity);
}

function bomRequestKey(row) {
  const normalized = normalizePart(row);
  if (normalized.lcsc) return `lcsc:${normalized.lcsc.toLowerCase()}`;
  if (normalized.mpn) return `mpn:${normalized.mpn.toLowerCase()}`;
  const specs = normalized.specs || deriveSpecs(normalized);
  return JSON.stringify({
    category: specs.category || normalized.category || "Uncategorized",
    package: specs.package || "",
    electricalKind: specs.electrical?.kind || "",
    electricalValue: specs.electrical?.value ?? "",
    voltage: specs.voltage ?? "",
    value: normalized.value.toLowerCase()
  });
}

function bomLine(store, row) {
  const required = Number(row.quantity || row.qty || row.required || 0) || 0;
  const requestKey = bomRequestKey(row);
  const rule = store.bomMatchRules.find((item) => item.requestKey === requestKey);
  const forcedPart = rule ? store.parts.find((part) => part.id === rule.partId) : null;
  const matches = forcedPart
    ? [{ part: forcedPart, match: { reasons: ["Saved BOM match"], score: 1000 } }]
    : compatibleParts(store.parts, row);
  const available = matches.reduce((sum, item) => sum + item.part.quantity, 0);
  const stockedMatches = matches.filter((item) => item.part.quantity > 0);
  return {
    requestKey,
    requested: row,
    requestedSpecs: normalizePart(row).specs,
    matchedPart: stockedMatches[0]?.part || matches[0]?.part || null,
    matches: matches.slice(0, 8).map((item) => ({
      part: item.part,
      reasons: item.match.reasons,
      available: item.part.quantity
    })),
    required,
    available,
    shortage: Math.max(0, required - available),
    status: available >= required ? "ready" : matches.length ? "short" : "missing",
    savedMatch: Boolean(forcedPart)
  };
}

function readZipEntry(buffer, entryName) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on("entry", (entry) => {
        if (entry.fileName !== entryName) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            zip.close();
            resolve(Buffer.concat(chunks).toString("utf8"));
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => reject(new Error(`Missing ${entryName}`)));
      zip.on("error", reject);
    });
  });
}

function stripXml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function columnName(cellRef) {
  return String(cellRef || "").replace(/[0-9]/g, "");
}

async function parseXlsxBom(buffer) {
  const sharedXml = await readZipEntry(buffer, "xl/sharedStrings.xml").catch(() => "");
  const strings = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((match) => stripXml(match[1]));
  const sheetXml = await readZipEntry(buffer, "xl/worksheets/sheet1.xml");
  const rowMatches = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
  const rows = rowMatches.map((rowMatch) => {
    const cells = {};
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] || "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      const rawValue = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] || body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || "";
      const value = type === "s" ? strings[Number(rawValue)] || "" : stripXml(rawValue);
      cells[columnName(ref)] = value;
    }
    return cells;
  }).filter((row) => Object.values(row).some(Boolean));

  if (!rows.length) return [];
  const headerRow = rows[0];
  const headers = Object.fromEntries(Object.entries(headerRow).map(([column, header]) => [column, normalizeImportKey(header)]));
  return rows.slice(1).map((row) => {
    const output = {};
    Object.entries(headers).forEach(([column, key]) => {
      if (key) output[key] = row[column] || "";
    });
    if (output.quantity) output.quantity = Number(String(output.quantity).replace(/[^0-9.-]/g, "")) || 0;
    return output;
  }).filter((row) => Object.values(row).some((value) => value !== ""));
}

function normalizeImportKey(header) {
  const key = String(header || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const map = {
    lcscpartnumber: "lcsc",
    supplierpart: "lcsc",
    manufacturepartnumber: "mpn",
    manufacturerpartnumber: "mpn",
    manufacturerpart: "mpn",
    mpn: "mpn",
    quantity: "quantity",
    qty: "quantity",
    comment: "comment",
    description: "description",
    designator: "designator",
    footprint: "footprint",
    package: "package",
    value: "value",
    manufacturer: "manufacturer",
    supplier: "supplier",
    customerno: "customerNo",
    packagingstatus: "storageType",
    storagetype: "storageType",
    storage: "storageType",
    packaging: "storageType"
  };
  return map[key] || key;
}

function normalizeImportedRow(row) {
  const output = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    output[normalizeImportKey(key)] = value;
  });
  if (!output.description && output.name) output.description = output.name;
  if (!output.name && output.description) output.name = output.description;
  if (!output.package && output.footprint) output.package = output.footprint;
  if (!output.value && output.comment) output.value = output.comment;
  if (output.quantity) output.quantity = Number(String(output.quantity).replace(/[^0-9.-]/g, "")) || 0;
  output.storageType = normalizeStorageType(output.storageType || output.packagingStatus);
  output.category = output.category || inferCategory(output);
  return output;
}

function recordMovement(store, movement) {
  const part = store.parts.find((item) => item.id === movement.partId);
  store.movements.unshift({
    id: `move_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: now(),
    partName: movement.partName || part?.name || "",
    ...movement
  });
  store.movements = store.movements.slice(0, 500);
}

async function lookupLcscPhoto(lcsc) {
  const partNumber = String(lcsc || "").trim().toUpperCase();
  if (!/^C\d+$/i.test(partNumber)) return "";
  if (lcscPhotoCache.has(partNumber)) return lcscPhotoCache.get(partNumber);

  try {
    const response = await fetch(`https://www.lcsc.com/product-detail/${encodeURIComponent(partNumber)}.html`, {
      headers: {
        "user-agent": "Mozilla/5.0 ReelKeeper/1.0"
      }
    });
    if (!response.ok) throw new Error(`LCSC returned ${response.status}`);
    const html = await response.text();
    const images = [...html.matchAll(/https?:\/\/assets\.lcsc\.com\/images\/lcsc\/[^"'<>\\]+?\.(?:jpg|jpeg|png|webp)/gi)]
      .map((match) => match[0].replace(/\\u002F/g, "/"));
    const image = images.find((url) => /_front\./i.test(url)) || images.find((url) => !/logo|blank/i.test(url)) || "";
    lcscPhotoCache.set(partNumber, image);
    return image;
  } catch (_error) {
    lcscPhotoCache.set(partNumber, "");
    return "";
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "ReelKeeper", time: now() });
});

app.get("/api/parts", (req, res) => {
  const store = readStore();
  const q = String(req.query.q || "").toLowerCase();
  const category = String(req.query.category || "").toLowerCase();
  const lowOnly = req.query.low === "true";

  const parts = store.parts.filter((part) => {
    const haystack = [part.name, part.category, part.manufacturer, part.mpn, part.lcsc, part.package, part.value, part.location].join(" ").toLowerCase();
    return (!q || haystack.includes(q)) &&
      (!category || part.category.toLowerCase() === category) &&
      (!lowOnly || part.quantity <= part.minimum);
  });

  res.json({ parts, movements: store.movements.slice(0, 20) });
});

app.get("/api/audit", (_req, res) => {
  const store = readStore();
  const entries = store.movements.map((entry) => {
    const part = store.parts.find((item) => item.id === entry.partId);
    const batch = store.importBatches.find((item) => item.id === entry.source);
    return {
      ...entry,
      partName: entry.partName || part?.name || "Deleted component",
      source: batch?.fileName || entry.source
    };
  });
  res.json({ entries });
});

app.post("/api/parts", (req, res) => {
  const store = readStore();
  const part = normalizePart(req.body || {});
  store.parts.unshift(part);
  recordMovement(store, { type: "create", partId: part.id, delta: part.quantity, source: "manual" });
  writeStore(store);
  res.status(201).json({ part });
});

app.patch("/api/parts/:id", (req, res) => {
  const store = readStore();
  const index = store.parts.findIndex((part) => part.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Part not found" });

  const previousQuantity = store.parts[index].quantity;
  const part = normalizePart(req.body || {}, store.parts[index]);
  store.parts[index] = part;
  if (part.quantity !== previousQuantity) {
    recordMovement(store, { type: "adjust", partId: part.id, delta: part.quantity - previousQuantity, source: "manual" });
  } else {
    recordMovement(store, { type: "edit", partId: part.id, delta: 0, source: "manual" });
  }
  writeStore(store);
  res.json({ part });
});

app.delete("/api/parts/:id", (req, res) => {
  const store = readStore();
  const index = store.parts.findIndex((part) => part.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Part not found" });

  const [part] = store.parts.splice(index, 1);
  recordMovement(store, { type: "delete", partId: part.id, partName: part.name, delta: -part.quantity, source: "manual" });
  writeStore(store);
  res.json({ ok: true });
});

app.post("/api/reset", (_req, res) => {
  writeStore(seedData());
  lcscPhotoCache.clear();
  res.json({ ok: true });
});

app.post("/api/import/order", async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.map(normalizeImportedRow) : [];
  const store = readStore();
  const changes = [];
  const batch = {
    id: `import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fileName: String(req.body.fileName || "LCSC order CSV").trim(),
    storageType: normalizeStorageType(req.body.storageType),
    importedAt: now(),
    undoneAt: null,
    count: 0,
    totalQuantity: 0,
    changes: []
  };

  for (const row of rows) {
    const quantity = Number(row.quantity || row.qty || row.orderQuantity || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    row.storageType = normalizeStorageType(row.storageType || batch.storageType);
    if (!row.photoUrl && row.lcsc) {
      row.photoUrl = await lookupLcscPhoto(row.lcsc);
    }

    const existing = findImportPart(store.parts, row);
    if (existing) {
      const beforeQuantity = existing.quantity;
      existing.quantity += quantity;
      const refreshed = normalizePart({ ...row, quantity: existing.quantity }, existing);
      Object.assign(existing, refreshed, { quantity: refreshed.quantity });
      existing.updatedAt = now();
      if (!existing.photoUrl && row.photoUrl) existing.photoUrl = row.photoUrl;
      recordMovement(store, { type: "order-import", partId: existing.id, delta: quantity, source: batch.id });
      batch.changes.push({ action: "updated", partId: existing.id, added: quantity, beforeQuantity, lcsc: existing.lcsc, mpn: existing.mpn, name: existing.name, storageType: existing.storageType });
      changes.push({ action: "updated", part: existing, added: quantity });
    } else {
      const part = normalizePart({ ...row, quantity });
      store.parts.unshift(part);
      recordMovement(store, { type: "order-import", partId: part.id, delta: quantity, source: batch.id });
      batch.changes.push({ action: "created", partId: part.id, added: quantity, beforeQuantity: 0, lcsc: part.lcsc, mpn: part.mpn, name: part.name, storageType: part.storageType });
      changes.push({ action: "created", part, added: quantity });
    }
  }

  batch.count = batch.changes.length;
  batch.totalQuantity = batch.changes.reduce((sum, change) => sum + change.added, 0);
  batch.storageType = [...new Set(batch.changes.map((change) => change.storageType || batch.storageType))].length > 1 ? "mixed" : batch.storageType;
  if (batch.count) {
    store.importBatches.unshift(batch);
  }
  writeStore(store);
  res.json({ changes, count: changes.length, batch });
});

app.get("/api/import/order/history", (_req, res) => {
  const store = readStore();
  res.json({
    imports: store.importBatches.map((batch) => ({
      id: batch.id,
      fileName: batch.fileName,
      importedAt: batch.importedAt,
      undoneAt: batch.undoneAt || null,
      count: batch.count,
      totalQuantity: batch.totalQuantity,
      storageType: batch.storageType || "machine-ready",
      changes: batch.changes
    }))
  });
});

app.post("/api/import/order/:id/undo", (req, res) => {
  const store = readStore();
  const batch = store.importBatches.find((item) => item.id === req.params.id);
  if (!batch) return res.status(404).json({ error: "Import not found" });
  if (batch.undoneAt) return res.status(409).json({ error: "Import already undone", batch });

  const results = [];
  batch.changes.forEach((change) => {
    const index = store.parts.findIndex((part) => part.id === change.partId);
    if (index === -1) {
      results.push({ ...change, status: "missing" });
      return;
    }

    const part = store.parts[index];
    const removed = Math.min(part.quantity, change.added);
    part.quantity = Math.max(0, part.quantity - change.added);
    part.updatedAt = now();
    recordMovement(store, { type: "order-import-undo", partId: part.id, delta: -removed, source: batch.id });

    if (change.action === "created" && part.quantity === 0) {
      store.parts.splice(index, 1);
      results.push({ ...change, status: "removed", removed });
    } else {
      results.push({ ...change, status: removed < change.added ? "partially-undone" : "undone", removed, remaining: part.quantity });
    }
  });

  batch.undoneAt = now();
  batch.undoResults = results;
  writeStore(store);
  res.json({ batch, results });
});

app.post("/api/bom/check", (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.map(normalizeImportedRow) : [];
  const store = readStore();
  const lines = rows.map((row) => bomLine(store, row));

  res.json({
    lines,
    summary: {
      total: lines.length,
      ready: lines.filter((line) => line.status === "ready").length,
      short: lines.filter((line) => line.status === "short").length,
      missing: lines.filter((line) => line.status === "missing").length
    }
  });
});

app.post("/api/bom/upload", async (req, res) => {
  try {
    const base64 = String(req.body.fileBase64 || "").replace(/^data:.*?;base64,/, "");
    if (!base64) return res.status(400).json({ error: "fileBase64 is required" });
    const rows = await parseXlsxBom(Buffer.from(base64, "base64"));
    const store = readStore();
    const lines = rows.map(normalizeImportedRow).map((row) => bomLine(store, row));
    res.json({
      rows,
      lines,
      summary: {
        total: lines.length,
        ready: lines.filter((line) => line.status === "ready").length,
        short: lines.filter((line) => line.status === "short").length,
        missing: lines.filter((line) => line.status === "missing").length
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not parse XLSX BOM" });
  }
});

app.post("/api/bom/matches", (req, res) => {
  const store = readStore();
  const part = store.parts.find((item) => item.id === req.body.partId);
  if (!part) return res.status(404).json({ error: "Inventory component not found" });
  if (!req.body.requested || typeof req.body.requested !== "object") {
    return res.status(400).json({ error: "requested BOM line is required" });
  }

  const requestKey = bomRequestKey(normalizeImportedRow(req.body.requested));
  const existing = store.bomMatchRules.find((item) => item.requestKey === requestKey);
  const rule = {
    requestKey,
    partId: part.id,
    requested: normalizeImportedRow(req.body.requested),
    createdAt: existing?.createdAt || now(),
    updatedAt: now()
  };
  if (existing) Object.assign(existing, rule);
  else store.bomMatchRules.push(rule);
  recordMovement(store, { type: "bom-match", partId: part.id, delta: 0, source: "BOM Check" });
  writeStore(store);
  res.json({ rule, part });
});

function useComponent(req, res) {
  const store = readStore();
  const quantity = Number(req.body.quantity || 1);
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: "quantity must be a positive number" });

  const match = findPart(store.parts, req.body);
  if (!match) return res.status(404).json({ error: "Part not found" });
  if (match.quantity < quantity) {
    return res.status(409).json({ error: "Insufficient inventory", available: match.quantity, requested: quantity, part: match });
  }

  match.quantity = Math.max(0, match.quantity - quantity);
  match.updatedAt = now();
  recordMovement(store, {
    type: "consume",
    partId: match.id,
    delta: -quantity,
    source: "API"
  });
  writeStore(store);
  res.json({ part: match, consumed: quantity });
}

app.post("/api/use", useComponent);
app.post("/api/consume", useComponent);

app.get("/api/docs", (_req, res) => {
  res.json({
    name: "ReelKeeper API",
    baseUrl: "/api",
    endpoints: [
      { method: "GET", path: "/parts", description: "List inventory. Optional query params: q, category, low=true." },
      { method: "POST", path: "/parts", description: "Create a part." },
      { method: "PATCH", path: "/parts/:id", description: "Update a part." },
      { method: "DELETE", path: "/parts/:id", description: "Delete a part." },
      { method: "POST", path: "/import/order", description: "Import purchased parts. Body: { rows: [{ lcsc, mpn, name, quantity, category, package, value, manufacturer }] }." },
      { method: "GET", path: "/import/order/history", description: "List LCSC order import batches, including undone imports." },
      { method: "POST", path: "/import/order/:id/undo", description: "Undo one LCSC order import batch and subtract those quantities from components." },
      { method: "POST", path: "/bom/check", description: "Compare BOM rows with inventory. Body: { rows: [{ lcsc, mpn, name, quantity, package, value }] }." },
      { method: "POST", path: "/bom/upload", description: "Upload an XLSX BOM as base64. Body: { fileName, fileBase64 }. Returns compatible stock matches and shortages." },
      { method: "POST", path: "/bom/matches", description: "Save a reusable BOM-to-inventory match. Body: { requested: { lcsc, mpn, package, value }, partId }." },
      { method: "POST", path: "/use", description: "Mark a component as used. Body: { lcsc or mpn or id, quantity }. Quantity defaults to 1." }
    ],
    useExample: {
      method: "POST",
      url: "/api/use",
      body: { lcsc: "C25804", quantity: 1 }
    }
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  ensureStore();
  console.log(`ReelKeeper running on http://localhost:${port}`);
});
