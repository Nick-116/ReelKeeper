const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const yauzl = require("yauzl");
const XLSX = require("@e965/xlsx");

const app = express();
const port = Number(process.env.PORT || 3000);
const dataFile = process.env.DATA_FILE || path.join(__dirname, "data", "reelkeeper.json");
const lcscDetailsCache = new Map();
const openPnpFootprintPreviews = new Map();

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const now = () => new Date().toISOString();

function seedData() {
  return {
    parts: [],
    movements: [],
    importBatches: [],
    bomMatchRules: [],
    openPnpNozzleAssignments: {}
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
  store.openPnpNozzleAssignments ||= {};
  store.parts.forEach((part) => {
    if (Number(part.heightMm) > 0) return;
    part.heightMm = defaultPartHeightMm(part);
    part.heightSource = part.heightMm ? "ReelKeeper package default" : "";
  });
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

  const priceBreaks = Array.isArray(input.priceBreaks) ? input.priceBreaks : (existing.priceBreaks || []);
  const base = {
    ...existing,
    id: existing.id || input.id || `part_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: text(input.name) || text(input.description) || existing.name || "Unnamed part",
    category: text(input.category) || (existing.category && existing.category !== "Uncategorized" ? existing.category : inferCategory({ ...existing, ...input })),
    manufacturer: text(input.manufacturer) || existing.manufacturer || "",
    mpn: text(input.mpn || input.manufacturerPartNumber) || existing.mpn || "",
    lcsc: text(input.lcsc || input.lcscPartNumber || input.supplierPart) || existing.lcsc || "",
    mouser: text(input.mouser || input.mouserPartNumber) || existing.mouser || "",
    package: text(input.package || input.footprint) || existing.package || "",
    value: text(input.value) || existing.value || "",
    description: text(input.description) || existing.description || "",
    storageType: normalizeStorageType(input.storageType || input.packagingStatus || existing.storageType),
    quantity: Math.max(0, number(input.quantity, existing.quantity || 0)),
    minimum: Math.max(0, number(input.minimum, existing.minimum || 0)),
    location: text(input.location) || existing.location || "",
    photoUrl: text(input.photoUrl) || existing.photoUrl || "",
    priceBreaks: priceBreaks
      .map((item) => ({ quantity: Math.max(1, number(item.quantity || item.ladder, 1)), unitPrice: number(item.unitPrice ?? item.usdPrice) }))
      .filter((item) => item.unitPrice > 0)
      .sort((a, b) => a.quantity - b.quantity),
    priceCurrency: priceBreaks.length ? "USD" : (existing.priceCurrency || ""),
    priceSource: text(input.priceSource) || existing.priceSource || "",
    priceUpdatedAt: text(input.priceUpdatedAt) || existing.priceUpdatedAt || "",
    notes: text(input.notes) || existing.notes || "",
    createdAt: existing.createdAt || now(),
    updatedAt: now()
  };

  const suppliedHeight = Number(input.heightMm ?? input.height);
  const existingHeight = Number(existing.heightMm);
  if (Number.isFinite(suppliedHeight) && suppliedHeight > 0) {
    base.heightMm = suppliedHeight;
    base.heightSource = text(input.heightSource) || "Manual";
  } else if (Number.isFinite(existingHeight) && existingHeight > 0) {
    base.heightMm = existingHeight;
    base.heightSource = existing.heightSource || "Manual";
  } else {
    base.heightMm = defaultPartHeightMm(base);
    base.heightSource = base.heightMm ? "ReelKeeper package default" : "";
  }

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
    part.mouser && `mouser:${part.mouser.toLowerCase()}`,
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
    (req.mouser && part.mouser && req.mouser.toLowerCase() === part.mouser.toLowerCase()) ||
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
  if (normalized.mouser) return `mouser:${normalized.mouser.toLowerCase()}`;
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
  const pricedPart = stockedMatches.find((item) => item.part.priceBreaks?.length)?.part ||
    matches.find((item) => item.part.priceBreaks?.length)?.part ||
    store.parts.find((part) => part.lcsc && part.lcsc.toLowerCase() === String(row.lcsc || "").toLowerCase() && part.priceBreaks?.length) || null;
  const breaks = pricedPart?.priceBreaks || [];
  const priceBreak = breaks.filter((item) => item.quantity <= required).at(-1) || breaks[0] || null;
  const unitPrice = priceBreak ? Number(priceBreak.unitPrice) : null;
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
    savedMatch: Boolean(forcedPart),
    unitPrice,
    estimatedCost: unitPrice === null ? null : unitPrice * required,
    priceQuantityBreak: priceBreak?.quantity || null,
    priceUpdatedAt: pricedPart?.priceUpdatedAt || null
  };
}

function bomSummary(lines) {
  const priced = lines.filter((line) => line.estimatedCost !== null);
  return {
    total: lines.length,
    ready: lines.filter((line) => line.status === "ready").length,
    short: lines.filter((line) => line.status === "short").length,
    missing: lines.filter((line) => line.status === "missing").length,
    estimatedCostPerBoard: priced.reduce((sum, line) => sum + line.estimatedCost, 0),
    pricedLines: priced.length,
    unpricedLines: lines.length - priced.length
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
    mouser: "mouser",
    mouserpart: "mouser",
    mouserpartnumber: "mouser",
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
    height: "heightMm",
    heightmm: "heightMm",
    value: "value",
    manufacturer: "manufacturer",
    supplier: "supplier",
    customerno: "customerNo",
    packagingstatus: "storageType",
    storagetype: "storageType",
    storage: "storageType",
    packaging: "storageType",
    pricebreaks: "priceBreaks",
    pricecurrency: "priceCurrency",
    pricesource: "priceSource"
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

function parseMoney(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMouserWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames.find((name) => /order details/i.test(name)) || workbook.SheetNames[0];
  if (!sheetName) throw new Error("The Mouser workbook does not contain a worksheet");
  const records = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
  return records.map((record) => {
    const quantity = Number(String(record["Order Qty."] ?? record["Order Qty"] ?? "").replace(/[^0-9.-]/g, "")) || 0;
    const unitPrice = Math.round((parseMoney(record["Price (USD)"]) + parseMoney(record["Tariff: Price (USD)"])) * 1e6) / 1e6;
    const description = String(record["Desc.:"] || record["Desc."] || record.Description || "").trim();
    const mpn = String(record["Mfr. #:"] || record["Mfr. #"] || "").trim();
    const row = {
      mouser: String(record["Mouser #:"] || record["Mouser #"] || "").trim(),
      mpn,
      name: description,
      description,
      quantity,
      category: inferCategory({ name: description, description, mpn }),
      priceSource: "Mouser",
      priceCurrency: "USD"
    };
    if (unitPrice > 0) row.priceBreaks = [{ quantity: Math.max(1, quantity), unitPrice }];
    return row;
  }).filter((row) => row.quantity > 0 && (row.mouser || row.mpn || row.name));
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

function extractLcscPriceBreaks(html) {
  const match = html.match(/"productPriceList":(\[\{.*?\}\])/s);
  if (!match) return [];
  try {
    return JSON.parse(match[1]).map((item) => ({
      quantity: Number(item.ladder),
      unitPrice: Number(item.usdPrice ?? item.currencyPrice ?? item.productPrice)
    })).filter((item) => Number.isFinite(item.quantity) && item.quantity > 0 && Number.isFinite(item.unitPrice) && item.unitPrice > 0)
      .sort((a, b) => a.quantity - b.quantity);
  } catch (_error) {
    return [];
  }
}

async function lookupLcscDetails(lcsc, refresh = false) {
  const partNumber = String(lcsc || "").trim().toUpperCase();
  if (!/^C\d+$/i.test(partNumber)) return { photoUrl: "", priceBreaks: [] };
  if (!refresh && lcscDetailsCache.has(partNumber)) return lcscDetailsCache.get(partNumber);

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
    const details = { photoUrl: image, priceBreaks: extractLcscPriceBreaks(html) };
    lcscDetailsCache.set(partNumber, details);
    return details;
  } catch (error) {
    if (!refresh) lcscDetailsCache.set(partNumber, { photoUrl: "", priceBreaks: [] });
    throw error;
  }
}

function openPnpId(value, fallback) {
  const cleaned = String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned || fallback;
}

function compactDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(value);
}

function simpleOpenPnpPackageId(value) {
  let normalized = openPnpId(value, "PACKAGE").toUpperCase()
    .replace(/^EE-/, "")
    .replace(/-[A-F0-9]{8}$/, "")
    .replace(/[^A-Z0-9.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const passive = normalized.match(/(?:^|-)([RCL](?:0201|0402|0603|0805|1206|1210|1812|2010|2512))(?:-|$)/);
  if (passive) return passive[1];

  const family = normalized.match(/(?:^|-)((?:LQFP|TQFP|QFP|QFN|DFN|SOIC|SSOP|TSSOP|SOP|DIP|SOD|SOT)-?\d+(?:-\d+)?)(?:-|$)/);
  if (family) {
    let id = family[1].replace(/([A-Z])(?=\d)/, "$1-");
    const dimensions = normalized.match(/(?:^|-)L(\d+(?:\.\d+)?)-W(\d+(?:\.\d+)?)(?:-|$)/);
    const pitch = normalized.match(/(?:^|-)P(\d+(?:\.\d+)?)(?:-|$)/);
    if (dimensions) id += `-${compactDimension(dimensions[1])}X${compactDimension(dimensions[2])}`;
    if (pitch) id += `-P${compactDimension(pitch[1])}`;
    if (/(?:^|-)EP(?:-|$)/.test(normalized)) id += "-EP";
    return id;
  }
  return normalized.slice(0, 48) || "PACKAGE";
}

function openPnpPackageId(part) {
  if (part.openPnpPackageId) return simpleOpenPnpPackageId(part.openPnpPackageId);
  let packageId = openPnpId(part.package || part.specs?.package, "UNASSIGNED").toUpperCase().replace(/\s+/g, "-");
  if (/^(?:0201|0402|0603|0805|1206|1210|1812|2010|2512)$/.test(packageId)) {
    const prefix = part.category === "Resistors" ? "R" : part.category === "Capacitors" ? "C" : part.category === "Inductors" ? "L" : "";
    packageId = `${prefix}${packageId}`;
  }
  return packageId;
}

// Nominal land patterns for unambiguous two-terminal EIA chip sizes.
// Dimensions are millimeters. More complex packages need exact part data.
const OPENPNP_PASSIVE_FOOTPRINTS = {
  "0201": { bodyWidth: 0.6, bodyHeight: 0.3, padWidth: 0.3, padHeight: 0.35, padCenter: 0.3 },
  "0402": { bodyWidth: 1.0, bodyHeight: 0.5, padWidth: 0.5, padHeight: 0.55, padCenter: 0.5 },
  "0603": { bodyWidth: 1.6, bodyHeight: 0.8, padWidth: 0.7, padHeight: 0.85, padCenter: 0.8 },
  "0805": { bodyWidth: 2.0, bodyHeight: 1.25, padWidth: 0.9, padHeight: 1.3, padCenter: 1.0 },
  "1206": { bodyWidth: 3.2, bodyHeight: 1.6, padWidth: 1.2, padHeight: 1.8, padCenter: 1.5 },
  "1210": { bodyWidth: 3.2, bodyHeight: 2.5, padWidth: 1.2, padHeight: 2.7, padCenter: 1.5 }
};

const OPENPNP_COMMON_PACKAGES = {
  "SOT-23-3-COMMON": {
    units: "Millimeters",
    bodyWidth: 1.3,
    bodyHeight: 2.9,
    pads: [
      { name: "1", x: -1.1, y: 0.95, width: 1.0, height: 0.8 },
      { name: "2", x: -1.1, y: -0.95, width: 1.0, height: 0.8 },
      { name: "3", x: 1.1, y: 0, width: 1.0, height: 0.8 }
    ]
  }
};

const OPENPNP_NOZZLE_SIZES = ["40", "65", "140", "220", "400", "750"];

const OPENPNP_PASSIVE_HEIGHTS_MM = {
  "0201": { Resistors: 0.3, Capacitors: 0.33, default: 0.3 },
  "0402": { Resistors: 0.35, Capacitors: 0.5, default: 0.45 },
  "0603": { Resistors: 0.45, Capacitors: 0.8, default: 0.55 },
  "0805": { Resistors: 0.55, Capacitors: 0.95, default: 0.7 },
  "1206": { Resistors: 0.6, Capacitors: 1.1, default: 0.8 },
  "1210": { Resistors: 0.6, Capacitors: 1.4, default: 1.0 }
};

const OPENPNP_PACKAGE_HEIGHT_RULES = [
  [/\bSOT[-_ ]?23\b/i, 1.1],
  [/\bSOT[-_ ]?89\b/i, 1.6],
  [/\bSOT[-_ ]?223\b/i, 1.8],
  [/\bSOD[-_ ]?123\b/i, 1.35],
  [/\bSOD[-_ ]?323\b/i, 1.0],
  [/\bSMA\b|DO[-_ ]?214AC/i, 2.3],
  [/\bSMB\b|DO[-_ ]?214AA/i, 2.45],
  [/\bSMC\b|DO[-_ ]?214AB/i, 2.6],
  [/\bTSSOP\b|\bMSOP\b/i, 1.2],
  [/\bSSOP\b|\bQSOP\b/i, 1.75],
  [/\bSOIC\b|\bSOP\b/i, 1.75],
  [/\bTQFP\b/i, 1.2],
  [/\bLQFP\b|\bQFP\b/i, 1.6],
  [/\bQFN\b/i, 1.0],
  [/\bDFN\b|\bWSON\b/i, 0.8],
  [/\bBGA\b/i, 1.2]
];

function defaultPartHeightMm(part) {
  const packageName = String(part.openPnpPackageId || part.package || "").trim();
  const passiveMatch = packageName.match(/(?:^|[^0-9])(0201|0402|0603|0805|1206|1210)(?:[^0-9]|$)/);
  if (passiveMatch && ["Resistors", "Capacitors", "Inductors"].includes(part.category)) {
    const defaults = OPENPNP_PASSIVE_HEIGHTS_MM[passiveMatch[1]];
    return defaults[part.category] || defaults.default;
  }
  return OPENPNP_PACKAGE_HEIGHT_RULES.find(([pattern]) => pattern.test(packageName))?.[1] || 0;
}

function recommendedOpenPnpNozzleSize(footprint) {
  if (!footprint) return "";
  const target = Math.min(Number(footprint.bodyWidth), Number(footprint.bodyHeight)) * 0.65;
  const candidates = OPENPNP_NOZZLE_SIZES.filter((size) => Number(size) / 100 <= target);
  return candidates.at(-1) || "40";
}

function openPnpFootprint(packageId) {
  if (OPENPNP_COMMON_PACKAGES[packageId]) return OPENPNP_COMMON_PACKAGES[packageId];
  const match = String(packageId).match(/^[RCL](0201|0402|0603|0805|1206|1210)$/);
  if (!match) return null;
  const dimensions = OPENPNP_PASSIVE_FOOTPRINTS[match[1]];
  return {
    units: "Millimeters",
    bodyWidth: dimensions.bodyWidth,
    bodyHeight: dimensions.bodyHeight,
    pads: [
      { name: "1", x: -dimensions.padCenter, y: 0, width: dimensions.padWidth, height: dimensions.padHeight },
      { name: "2", x: dimensions.padCenter, y: 0, width: dimensions.padWidth, height: dimensions.padHeight }
    ]
  };
}

function easyEdaPackageId(packageName, packageUuid) {
  return simpleOpenPnpPackageId(packageName || `PACKAGE-${packageUuid.slice(0, 8)}`);
}

async function fetchEasyEdaJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "ReelKeeper/1.0 OpenPnP footprint importer" }
    });
    if (!response.ok) throw new Error(`EasyEDA returned ${response.status}`);
    const data = await response.json();
    if (!data.success || !data.result) throw new Error("EasyEDA returned no component data");
    return data.result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("EasyEDA request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function rotatedPadExtents(pad) {
  const radians = (pad.rotation || 0) * Math.PI / 180;
  const halfWidth = (Math.abs(Math.cos(radians)) * pad.width + Math.abs(Math.sin(radians)) * pad.height) / 2;
  const halfHeight = (Math.abs(Math.sin(radians)) * pad.width + Math.abs(Math.cos(radians)) * pad.height) / 2;
  return { minX: pad.x - halfWidth, maxX: pad.x + halfWidth, minY: pad.y - halfHeight, maxY: pad.y + halfHeight };
}

function easyEdaBodySize(packageName, width, height) {
  const dimensions = String(packageName || "").match(/(?:^|[-_])L(\d+(?:\.\d+)?)[-_]W(\d+(?:\.\d+)?)(?:[-_]|$)/i);
  if (dimensions) return { bodyWidth: Number(dimensions[1]), bodyHeight: Number(dimensions[2]) };
  const chip = String(packageName || "").match(/(?:^|[^0-9])(0201|0402|0603|0805|1206|1210)(?:[^0-9]|$)/);
  if (chip && OPENPNP_PASSIVE_FOOTPRINTS[chip[1]]) {
    const known = OPENPNP_PASSIVE_FOOTPRINTS[chip[1]];
    return { bodyWidth: known.bodyWidth, bodyHeight: known.bodyHeight };
  }
  return { bodyWidth: width, bodyHeight: height };
}

function parseEasyEdaFootprint(component, lcsc) {
  const shapes = component.dataStr?.shape;
  if (!Array.isArray(shapes)) throw new Error("EasyEDA package has no shape data");
  const rawPads = shapes.filter((shape) => typeof shape === "string" && shape.startsWith("PAD~")).map((shape) => {
    const fields = shape.split("~");
    const pad = {
      name: String(fields[8] || "").trim(),
      shape: String(fields[1] || "RECT").toUpperCase(),
      x: Number(fields[2]),
      y: Number(fields[3]),
      width: Number(fields[4]),
      height: Number(fields[5]),
      rotation: Number(fields[11] || 0)
    };
    if (!pad.name || ![pad.x, pad.y, pad.width, pad.height, pad.rotation].every(Number.isFinite) || pad.width <= 0 || pad.height <= 0) return null;
    return pad;
  }).filter(Boolean);
  if (!rawPads.length) throw new Error("EasyEDA package contains no valid pads");
  if (rawPads.length > 500) throw new Error("EasyEDA package contains too many pads to import safely");

  const rawBounds = rawPads.map(rotatedPadExtents);
  const minX = Math.min(...rawBounds.map((bounds) => bounds.minX));
  const maxX = Math.max(...rawBounds.map((bounds) => bounds.maxX));
  const minY = Math.min(...rawBounds.map((bounds) => bounds.minY));
  const maxY = Math.max(...rawBounds.map((bounds) => bounds.maxY));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const unitToMm = 0.254;
  const width = (maxX - minX) * unitToMm;
  const height = (maxY - minY) * unitToMm;
  if (width <= 0 || height <= 0 || width > 100 || height > 100) throw new Error("EasyEDA package dimensions are outside the supported range");

  const packageName = component.dataStr?.head?.c_para?.package || component.title || `LCSC-${lcsc}`;
  const body = easyEdaBodySize(packageName, width, height);
  return {
    packageName,
    footprint: {
      units: "Millimeters",
      bodyWidth: Number(body.bodyWidth.toFixed(4)),
      bodyHeight: Number(body.bodyHeight.toFixed(4)),
      pads: rawPads.map((pad) => ({
        name: pad.name,
        x: Number(((pad.x - centerX) * unitToMm).toFixed(5)),
        y: Number((-(pad.y - centerY) * unitToMm).toFixed(5)),
        width: Number((pad.width * unitToMm).toFixed(5)),
        height: Number((pad.height * unitToMm).toFixed(5)),
        rotation: Number((-pad.rotation).toFixed(3)),
        roundness: ["OVAL", "ELLIPSE", "ROUND", "CIRCLE"].includes(pad.shape) ? 100 : 0
      }))
    }
  };
}

async function fetchEasyEdaFootprint(lcsc) {
  const product = await fetchEasyEdaJson(`https://easyeda.com/api/products/${encodeURIComponent(lcsc)}/components`);
  const packageUuid = product.dataStr?.head?.puuid || product.packageDetail?.uuid;
  if (!packageUuid) throw new Error("EasyEDA component has no associated package");
  const component = await fetchEasyEdaJson(`https://easyeda.com/api/components/${encodeURIComponent(packageUuid)}`);
  const parsed = parseEasyEdaFootprint(component, lcsc);
  return {
    lcsc,
    packageUuid,
    packageId: easyEdaPackageId(parsed.packageName, packageUuid),
    packageName: parsed.packageName,
    footprint: parsed.footprint,
    source: "EasyEDA"
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

function compactOpenPnpNumber(value) {
  return Number(value.toPrecision(6)).toString().toUpperCase();
}

function openPnpElectricalValue(part) {
  const electrical = (part.specs || deriveSpecs(part)).electrical;
  if (!electrical || !Number.isFinite(electrical.value)) return "";
  const value = electrical.value;
  if (electrical.kind === "resistance") {
    if (value >= 1_000_000) return `${compactOpenPnpNumber(value / 1_000_000)}M`;
    if (value >= 1_000) return `${compactOpenPnpNumber(value / 1_000)}K`;
    return `${compactOpenPnpNumber(value)}R`;
  }
  if (electrical.kind === "capacitance") {
    if (value >= 1e-3) return `${compactOpenPnpNumber(value / 1e-3)}MF`;
    if (value >= 1e-6) return `${compactOpenPnpNumber(value / 1e-6)}UF`;
    if (value >= 1e-9) return `${compactOpenPnpNumber(value / 1e-9)}NF`;
    return `${compactOpenPnpNumber(value / 1e-12)}PF`;
  }
  return "";
}

function openPnpCategoryCode(part) {
  const category = part.category || inferCategory(part);
  return ({
    "Resistors": "R",
    "Capacitors": "C",
    "Inductors": "L",
    "Diodes": "D",
    "LEDs": "LED",
    "Fuses": "F",
    "Connectors": "CN",
    "ICs & Modules": "IC",
    "Transistors": "Q",
    "Switches": "SW",
    "Crystals & Oscillators": "Y",
    "Uncategorized": "X"
  })[category] || String(category || "X").replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase() || "X";
}

function openPnpPartIdentity(part) {
  const packageId = openPnpPackageId(part);
  const value = openPnpElectricalValue(part);
  const supplierId = part.lcsc || (part.mouser ? `MOUSER-${part.mouser}` : "") || part.mpn;
  const categoryCode = openPnpCategoryCode(part);
  let baseId;
  let baseName;
  if (["Resistors", "Capacitors"].includes(part.category) && value && supplierId) {
    const type = part.category === "Resistors" ? "resistor" : "capacitor";
    const cleanSupplierId = String(supplierId).toUpperCase().replace(/[^A-Z0-9._-]+/g, "-");
    baseId = `${value}-${packageId}-${cleanSupplierId}`;
    baseName = `${value} ${packageId} ${type} - ${cleanSupplierId}`;
  } else {
    baseId = openPnpId(part.mpn || part.lcsc || part.mouser, part.id);
    baseName = part.name || part.description || part.value || baseId;
  }
  return {
    id: String(baseId).toUpperCase().startsWith(`${categoryCode}-`) ? baseId : `${categoryCode}-${baseId}`,
    name: `${categoryCode} - ${baseName}`,
    legacyId: baseId
  };
}

function openPnpParts(parts, nozzleAssignments = {}) {
  const unique = new Map();
  parts.forEach((part) => {
    const identity = openPnpPartIdentity(part);
    const id = identity.id;
    const key = id.toUpperCase();
    const existing = unique.get(key);
    const candidate = {
      id,
      name: identity.name,
      packageId: openPnpPackageId(part),
      quantity: Number(part.quantity || 0),
      lcsc: part.lcsc || "",
      mouser: part.mouser || "",
      footprint: part.openPnpFootprint || openPnpFootprint(openPnpPackageId(part)),
      footprintSource: part.openPnpFootprint ? (part.openPnpFootprintSource || "EasyEDA") : (openPnpFootprint(openPnpPackageId(part)) ? "ReelKeeper standard package" : ""),
      heightMm: Number(part.heightMm) || defaultPartHeightMm(part),
      heightSource: part.heightSource || (defaultPartHeightMm(part) ? "ReelKeeper package default" : ""),
      partIds: [part.id],
      legacyIds: [...new Set([identity.legacyId, part.mpn, part.lcsc, part.mouser].filter(Boolean))]
    };
    candidate.nozzleSize = nozzleAssignments[candidate.packageId] || "";
    if (!existing) {
      unique.set(key, candidate);
      return;
    }
    const preferred = candidate.quantity > existing.quantity ? candidate : existing;
    const preferredHeight = [existing, candidate].find((item) => item.heightMm > 0 && item.heightSource === "Manual") ||
      [existing, candidate].find((item) => item.heightMm > 0) || preferred;
    unique.set(key, {
      ...preferred,
      lcsc: existing.lcsc || candidate.lcsc,
      mouser: existing.mouser || candidate.mouser,
      footprint: existing.footprint || candidate.footprint,
      footprintSource: existing.footprintSource || candidate.footprintSource,
      heightMm: preferredHeight.heightMm || 0,
      heightSource: preferredHeight.heightSource || "",
      partIds: [...new Set([...(existing.partIds || []), ...(candidate.partIds || [])])],
      legacyIds: [...new Set([...(existing.legacyIds || []), ...(candidate.legacyIds || [])])]
    });
  });
  return [...unique.values()].map((part) => {
    const identifiers = [part.lcsc && `LCSC ${part.lcsc}`, part.mouser && `Mouser ${part.mouser}`].filter(Boolean);
    const nameIncludesSupplier = (part.lcsc && part.name.includes(part.lcsc)) || (part.mouser && part.name.includes(part.mouser));
    return {
      id: part.id,
      name: [part.name, identifiers.length && !nameIncludesSupplier ? `(${identifiers.join(", ")})` : ""].filter(Boolean).join(" "),
      packageId: part.packageId,
      footprint: part.footprint,
      footprintSource: part.footprintSource,
      partIds: part.partIds || [],
      legacyIds: part.legacyIds || [],
      heightMm: part.heightMm || 0,
      heightSource: part.heightSource || "",
      nozzleSize: part.nozzleSize || ""
    };
  }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildOpenPnpPartsXml(parts) {
  const rows = openPnpParts(parts).map((part) =>
    `  <part id="${escapeXml(part.id)}" name="${escapeXml(part.name)}" height-units="Millimeters" height="${escapeXml(part.heightMm || 0)}" package-id="${escapeXml(part.packageId)}" speed="1.0"/>`
  );
  return [`<?xml version="1.0" encoding="UTF-8"?>`, `<openpnp-parts>`, ...rows, `</openpnp-parts>`, ""].join("\n");
}

function openPnpPackages(parts, nozzleAssignments = {}) {
  const packages = new Map();
  openPnpParts(parts, nozzleAssignments).forEach((part) => {
    const existing = packages.get(part.packageId);
    if (!existing || (!existing.footprint && part.footprint)) {
      packages.set(part.packageId, { id: part.packageId, footprint: part.footprint, footprintSource: part.footprintSource, nozzleSize: part.nozzleSize });
    }
  });
  return [...packages.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function openPnpExportStatus(parts) {
  const exportedParts = openPnpParts(parts);
  const items = exportedParts.map((part) => {
    const footprint = part.footprint;
    let issue = "";
    if (!footprint) {
      if (part.packageId === "UNASSIGNED") {
        issue = "No package is assigned";
      } else if (/^(?:0201|0402|0603|0805|1206|1210)$/.test(part.packageId)) {
        issue = "Passive type is unknown, so the package cannot be mapped safely";
      } else {
        issue = `No verified footprint template for ${part.packageId}`;
      }
    }
    return {
      id: part.id,
      name: part.name,
      packageId: part.packageId,
      heightMm: part.heightMm || 0,
      heightSource: part.heightSource || "",
      ready: Boolean(footprint),
      source: part.footprintSource || "",
      issue,
      partIds: part.partIds
    };
  });
  const ready = items.filter((item) => item.ready).length;
  const heightsReady = items.filter((item) => item.heightMm > 0).length;
  return {
    total: items.length,
    ready,
    needsReview: items.length - ready,
    heightsReady,
    heightsMissing: items.length - heightsReady,
    items
  };
}

function knownOpenPnpPackages(parts) {
  const packages = new Map();
  ["R", "C", "L"].forEach((prefix) => {
    Object.keys(OPENPNP_PASSIVE_FOOTPRINTS).forEach((size) => {
      const id = `${prefix}${size}`;
      packages.set(id, { id, footprint: openPnpFootprint(id), source: "ReelKeeper standard package" });
    });
  });
  Object.entries(OPENPNP_COMMON_PACKAGES).forEach(([id, footprint]) => {
    packages.set(id, { id, footprint, source: "ReelKeeper common package" });
  });
  openPnpPackages(parts).filter((pkg) => pkg.footprint).forEach((pkg) => {
    packages.set(pkg.id, { id: pkg.id, footprint: pkg.footprint, source: pkg.footprintSource || "Inventory component" });
  });
  return [...packages.values()].map((pkg) => ({
    ...pkg,
    padCount: pkg.footprint.pads.length,
    bodyWidth: pkg.footprint.bodyWidth,
    bodyHeight: pkg.footprint.bodyHeight
  })).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function buildOpenPnpPackagesXml(parts) {
  const rows = openPnpPackages(parts).map((pkg) => {
    const description = pkg.footprint ? `${pkg.footprintSource || "ReelKeeper"} footprint` : "Footprint needs review";
    if (!pkg.footprint) {
      return `  <package id="${escapeXml(pkg.id)}" description="${description}"><footprint units="Millimeters"/></package>`;
    }
    const pads = pkg.footprint.pads.map((pad) => {
      const optional = [
        pad.rotation ? ` rotation="${pad.rotation}"` : "",
        pad.roundness ? ` roundness="${pad.roundness}"` : ""
      ].join("");
      return `      <pad name="${escapeXml(pad.name)}" x="${pad.x}" y="${pad.y}" width="${pad.width}" height="${pad.height}"${optional}/>`;
    });
    return [
      `  <package id="${escapeXml(pkg.id)}" description="${description}">`,
      `    <footprint units="${pkg.footprint.units}" body-width="${pkg.footprint.bodyWidth}" body-height="${pkg.footprint.bodyHeight}">`,
      ...pads,
      `    </footprint>`,
      `  </package>`
    ].join("\n");
  });
  return [`<?xml version="1.0" encoding="UTF-8"?>`, `<openpnp-packages>`, ...rows, `</openpnp-packages>`, ""].join("\n");
}

function buildOpenPnpImportScript(parts, nozzleAssignments = {}) {
  const data = JSON.stringify(openPnpParts(parts, nozzleAssignments), null, 2);
  return `// ReelKeeper OpenPnP additive parts importer
// Generated ${now()}. Existing IDs are preserved; legacy descriptions and EasyEDA package assignments may be cleaned up.
var Part = Java.type("org.openpnp.model.Part");
var Package = Java.type("org.openpnp.model.Package");
var Length = Java.type("org.openpnp.model.Length");
var LengthUnit = Java.type("org.openpnp.model.LengthUnit");
var FootprintPad = Java.type("org.openpnp.model.Footprint$Pad");
var JOptionPane = Java.type("javax.swing.JOptionPane");

var reelKeeperParts = ${data};
var addedParts = 0;
var skippedParts = 0;
var migratedLegacyParts = 0;
var updatedPartNames = 0;
var partHeightsAdded = 0;
var addedPackages = 0;
var addedFootprints = 0;
var nozzleCompatibilitiesAdded = 0;
var nozzleTips = [];
var machineNozzleTips = config.getMachine().getNozzleTips();
for (var nozzleIndex = 0; nozzleIndex < machineNozzleTips.size(); nozzleIndex++) {
  nozzleTips.push(machineNozzleTips.get(nozzleIndex));
}
var tipByReelKeeperSize = {};

function nozzleTipLabel(tip) {
  var name = String(tip.getName() || tip.getId());
  var id = String(tip.getId());
  return name === id ? id : name + " [" + id + "]";
}

function existingTipForSize(size) {
  for (var partIndex = 0; partIndex < reelKeeperParts.length; partIndex++) {
    var item = reelKeeperParts[partIndex];
    if (item.nozzleSize !== size) continue;
    var existingPackage = config.getPackage(item.packageId);
    if (existingPackage == null) continue;
    var compatible = existingPackage.getCompatibleNozzleTips().iterator();
    if (compatible.hasNext()) return compatible.next();
  }
  return null;
}

function selectNozzleTip(size) {
  if (tipByReelKeeperSize[size] !== undefined) return tipByReelKeeperSize[size];
  var selected = existingTipForSize(size);
  if (selected == null) {
    var numericMatches = nozzleTips.filter(function(tip) {
      var numbers = nozzleTipLabel(tip).match(/\\d+/g) || [];
      return numbers.some(function(number) { return Number(number) === Number(size); });
    });
    if (numericMatches.length === 1) selected = numericMatches[0];
  }
  if (selected == null && nozzleTips.length > 0) {
    var labels = nozzleTips.map(nozzleTipLabel);
    var choices = Java.to(labels, "java.lang.Object[]");
    var answer = JOptionPane.showInputDialog(gui,
      "ReelKeeper nozzle " + size + " needs an OpenPnP nozzle tip.\\nSelect the matching configured tip:",
      "Map ReelKeeper Nozzle " + size,
      JOptionPane.QUESTION_MESSAGE, null, choices, choices[0]);
    if (answer != null) {
      var selectedIndex = labels.indexOf(String(answer));
      if (selectedIndex >= 0) selected = nozzleTips[selectedIndex];
    }
  }
  tipByReelKeeperSize[size] = selected;
  return selected;
}

function addFootprint(pkg, definition, source) {
  if (definition == null || pkg.getFootprint().getPads().size() > 0) return;
  var footprint = pkg.getFootprint();
  footprint.setBodyWidth(definition.bodyWidth);
  footprint.setBodyHeight(definition.bodyHeight);
  definition.pads.forEach(function(item) {
    var pad = new FootprintPad();
    pad.setName(item.name);
    pad.setX(item.x);
    pad.setY(item.y);
    pad.setWidth(item.width);
    pad.setHeight(item.height);
    pad.setRotation(item.rotation || 0);
    pad.setRoundness(item.roundness || 0);
    footprint.addPad(pad);
  });
  pkg.setDescription(source ? source + " footprint" : "ReelKeeper footprint");
  addedFootprints++;
}

reelKeeperParts.forEach(function(item) {
  var pkg = config.getPackage(item.packageId);
  if (pkg == null) {
    pkg = new Package(item.packageId);
    pkg.setDescription("Created by ReelKeeper import");
    config.addPackage(pkg);
    addedPackages++;
  }
  addFootprint(pkg, item.footprint, item.footprintSource);
  if (item.nozzleSize) {
    var selectedTip = selectNozzleTip(item.nozzleSize);
    if (selectedTip != null && !pkg.getCompatibleNozzleTips().contains(selectedTip)) {
      pkg.addCompatibleNozzleTip(selectedTip);
      nozzleCompatibilitiesAdded++;
    }
  }

  var existingPart = config.getPart(item.id);
  if (existingPart == null) {
    item.legacyIds.some(function(legacyId) {
      existingPart = config.getPart(legacyId);
      return existingPart != null;
    });
  }
  if (existingPart != null) {
    if (String(existingPart.getName() || "") !== item.name) {
      existingPart.setName(item.name);
      updatedPartNames++;
    }
    var existingPackage = existingPart.getPackage();
    var existingPackageId = existingPackage == null ? "" : String(existingPackage.getId());
    if (existingPackageId.indexOf("EE-") === 0 && existingPackageId !== item.packageId) {
      existingPart.setPackage(pkg);
      migratedLegacyParts++;
    }
    if (item.heightMm > 0 && existingPart.getHeight().getValue() <= 0) {
      existingPart.setHeight(new Length(item.heightMm, LengthUnit.Millimeters));
      partHeightsAdded++;
    }
    skippedParts++;
    return;
  }

  var part = new Part(item.id);
  part.setName(item.name);
  part.setPackage(pkg);
  if (item.heightMm > 0) {
    part.setHeight(new Length(item.heightMm, LengthUnit.Millimeters));
    partHeightsAdded++;
  }
  part.setSpeed(1.0);
  config.addPart(part);
  addedParts++;
});

config.save();
var summary = "ReelKeeper import complete.\\nAdded parts: " + addedParts +
  "\\nExisting parts skipped: " + skippedParts +
  "\\nPart names updated: " + updatedPartNames +
  "\\nPart heights added: " + partHeightsAdded +
  "\\nLegacy package names updated: " + migratedLegacyParts +
  "\\nPackages created: " + addedPackages +
  "\\nFootprints added: " + addedFootprints +
  "\\nNozzle compatibilities added: " + nozzleCompatibilitiesAdded;
print(summary);
JOptionPane.showMessageDialog(gui, summary, "ReelKeeper Import", JOptionPane.INFORMATION_MESSAGE);
`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "ReelKeeper", time: now() });
});

app.get("/api/export/openpnp/parts.xml", (_req, res) => {
  const store = readStore();
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="reelkeeper-openpnp-parts.xml"');
  res.send(buildOpenPnpPartsXml(store.parts));
});

app.get("/api/export/openpnp/packages.xml", (_req, res) => {
  const store = readStore();
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="reelkeeper-openpnp-packages.xml"');
  res.send(buildOpenPnpPackagesXml(store.parts));
});

app.get("/api/export/openpnp/status", (_req, res) => {
  const store = readStore();
  res.json(openPnpExportStatus(store.parts));
});

app.get("/api/openpnp/packages/known", (_req, res) => {
  const store = readStore();
  const packages = knownOpenPnpPackages(store.parts).map(({ footprint, ...pkg }) => pkg);
  res.json({ packages });
});

app.post("/api/openpnp/packages/assign", (req, res) => {
  const partIds = new Set(Array.isArray(req.body?.partIds) ? req.body.partIds.map(String) : []);
  const packageId = String(req.body?.packageId || "");
  if (!partIds.size || !packageId) return res.status(400).json({ error: "Select a component and package." });
  const store = readStore();
  const knownPackage = knownOpenPnpPackages(store.parts).find((pkg) => pkg.id === packageId);
  if (!knownPackage?.footprint?.pads?.length) return res.status(400).json({ error: "The selected package has no verified pad geometry." });

  let updated = 0;
  store.parts.forEach((part) => {
    if (!partIds.has(part.id)) return;
    part.openPnpPackageId = knownPackage.id;
    part.openPnpFootprint = JSON.parse(JSON.stringify(knownPackage.footprint));
    part.openPnpFootprintSource = `Mapped from ${knownPackage.id}`;
    part.openPnpFootprintUpdatedAt = now();
    part.updatedAt = now();
    updated++;
  });
  if (!updated) return res.status(404).json({ error: "Component not found." });
  store.movements.unshift({
    id: `move_${Date.now()}`,
    type: "footprint-map",
    partName: `${updated} component${updated === 1 ? "" : "s"}`,
    delta: 0,
    source: knownPackage.id,
    at: now()
  });
  writeStore(store);
  res.json({ updated, packageId: knownPackage.id });
});

app.get("/api/openpnp/nozzles", (_req, res) => {
  const store = readStore();
  const packages = openPnpPackages(store.parts, store.openPnpNozzleAssignments).map((pkg) => ({
    packageId: pkg.id,
    assignedSize: store.openPnpNozzleAssignments[pkg.id] || "",
    recommendedSize: recommendedOpenPnpNozzleSize(pkg.footprint),
    bodyWidth: pkg.footprint?.bodyWidth || null,
    bodyHeight: pkg.footprint?.bodyHeight || null
  }));
  res.json({ sizes: OPENPNP_NOZZLE_SIZES, packages });
});

app.post("/api/openpnp/nozzles/assign", (req, res) => {
  const packageId = String(req.body?.packageId || "");
  const size = String(req.body?.size || "");
  if (!packageId) return res.status(400).json({ error: "Package is required." });
  if (size && !OPENPNP_NOZZLE_SIZES.includes(size)) return res.status(400).json({ error: "Unknown ReelKeeper nozzle size." });
  const store = readStore();
  const available = openPnpPackages(store.parts, store.openPnpNozzleAssignments).some((pkg) => pkg.id === packageId);
  if (!available) return res.status(404).json({ error: "Package not found in the component library." });
  if (size) store.openPnpNozzleAssignments[packageId] = size;
  else delete store.openPnpNozzleAssignments[packageId];
  store.movements.unshift({ id: `move_${Date.now()}`, type: "nozzle-assign", partName: packageId, delta: 0, source: size ? `Nozzle ${size}` : "Nozzle cleared", at: now() });
  writeStore(store);
  res.json({ packageId, size });
});

app.post("/api/openpnp/nozzles/auto", (_req, res) => {
  const store = readStore();
  let updated = 0;
  openPnpPackages(store.parts, store.openPnpNozzleAssignments).forEach((pkg) => {
    if (store.openPnpNozzleAssignments[pkg.id]) return;
    const size = recommendedOpenPnpNozzleSize(pkg.footprint);
    if (!size) return;
    store.openPnpNozzleAssignments[pkg.id] = size;
    updated++;
  });
  if (updated) {
    store.movements.unshift({ id: `move_${Date.now()}`, type: "nozzle-auto", partName: `${updated} package${updated === 1 ? "" : "s"}`, delta: 0, source: "Automatic recommendation", at: now() });
    writeStore(store);
  }
  res.json({ updated });
});

async function buildEasyEdaFootprintPreview(store, options = {}) {
  const requestedIds = Array.isArray(options.partIds) ? new Set(options.partIds.map(String)) : null;
  const candidates = store.parts.filter((part) =>
    part.lcsc &&
    (!requestedIds || requestedIds.has(part.id)) &&
    (options.refresh === true || !part.openPnpFootprint)
  );
  const groups = new Map();
  candidates.forEach((part) => {
    const lcsc = String(part.lcsc).trim().toUpperCase();
    if (!groups.has(lcsc)) groups.set(lcsc, { lcsc, partIds: [], partNames: [] });
    groups.get(lcsc).partIds.push(part.id);
    groups.get(lcsc).partNames.push(part.name || part.mpn || lcsc);
  });

  const results = await mapWithConcurrency([...groups.values()], 4, async (group) => {
    try {
      return { ok: true, ...group, ...(await fetchEasyEdaFootprint(group.lcsc)) };
    } catch (error) {
      return { ok: false, ...group, error: error.message };
    }
  });
  const token = randomUUID();
  openPnpFootprintPreviews.set(token, {
    createdAt: Date.now(),
    items: results.filter((item) => item.ok)
  });
  for (const [previewToken, preview] of openPnpFootprintPreviews) {
    if (Date.now() - preview.createdAt > 30 * 60 * 1000) openPnpFootprintPreviews.delete(previewToken);
  }
  return { token, items: results, skipped: store.parts.filter((part) => part.lcsc && part.openPnpFootprint).length };
}

async function updateLcscPartData(store, options = {}) {
  const partNumbers = [...new Set(store.parts.map((part) => String(part.lcsc || "").trim().toUpperCase()).filter((value) => /^C\d+$/.test(value)))];
  const results = [];
  for (const lcsc of partNumbers) {
    try {
      const details = await lookupLcscDetails(lcsc, true);
      if (options.requirePricing && !details.priceBreaks.length) throw new Error("No USD pricing found");
      if (!details.priceBreaks.length && !details.photoUrl) throw new Error("No product data found");
      const updatedAt = now();
      store.parts.filter((part) => String(part.lcsc || "").trim().toUpperCase() === lcsc).forEach((part) => {
        if (details.priceBreaks.length) {
          part.priceBreaks = details.priceBreaks;
          part.priceCurrency = "USD";
          part.priceSource = "LCSC";
          part.priceUpdatedAt = updatedAt;
        }
        if (details.photoUrl) part.photoUrl = details.photoUrl;
        part.updatedAt = updatedAt;
      });
      results.push({ lcsc, ok: true, priceBreaks: details.priceBreaks.length, photo: Boolean(details.photoUrl) });
    } catch (error) {
      results.push({ lcsc, ok: false, error: error.message || "LCSC lookup failed" });
    }
  }
  return { total: partNumbers.length, updated: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length, results };
}

app.post("/api/openpnp/footprints/fetch", async (req, res) => {
  const store = readStore();
  res.json(await buildEasyEdaFootprintPreview(store, req.body || {}));
});

app.post("/api/openpnp/footprints/approve", (req, res) => {
  const preview = openPnpFootprintPreviews.get(String(req.body?.token || ""));
  if (!preview || Date.now() - preview.createdAt > 30 * 60 * 1000) {
    return res.status(400).json({ error: "Footprint preview expired. Fetch the EasyEDA footprints again." });
  }
  const approved = new Set(Array.isArray(req.body?.lcscNumbers) ? req.body.lcscNumbers.map((value) => String(value).toUpperCase()) : []);
  const store = readStore();
  let updated = 0;
  preview.items.filter((item) => approved.has(item.lcsc)).forEach((item) => {
    let packageId = item.packageId;
    const collision = store.parts.find((part) =>
      part.openPnpFootprint &&
      openPnpPackageId(part) === packageId &&
      JSON.stringify(part.openPnpFootprint) !== JSON.stringify(item.footprint)
    );
    if (collision) {
      packageId = `${packageId}-${compactDimension(item.footprint.bodyWidth)}X${compactDimension(item.footprint.bodyHeight)}`;
    }
    item.partIds.forEach((partId) => {
      const part = store.parts.find((candidate) => candidate.id === partId && String(candidate.lcsc).toUpperCase() === item.lcsc);
      if (!part) return;
      part.openPnpPackageId = packageId;
      part.openPnpFootprint = item.footprint;
      part.openPnpFootprintSource = "EasyEDA";
      part.openPnpFootprintUpdatedAt = now();
      part.updatedAt = now();
      updated++;
    });
  });
  if (updated) {
    store.movements.unshift({
      id: `move_${Date.now()}`,
      type: "footprint-import",
      partName: `${updated} component${updated === 1 ? "" : "s"}`,
      delta: 0,
      source: "EasyEDA",
      at: now()
    });
    writeStore(store);
  }
  openPnpFootprintPreviews.delete(String(req.body.token));
  res.json({ updated });
});

app.get("/api/export/openpnp/import-script.js", (_req, res) => {
  const store = readStore();
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="ReelKeeper_Import_Parts.js"');
  res.send(buildOpenPnpImportScript(store.parts, store.openPnpNozzleAssignments));
});

app.get("/api/parts", (req, res) => {
  const store = readStore();
  const q = String(req.query.q || "").toLowerCase();
  const category = String(req.query.category || "").toLowerCase();
  const lowOnly = req.query.low === "true";

  const parts = store.parts.filter((part) => {
    const haystack = [part.name, part.category, part.manufacturer, part.mpn, part.lcsc, part.mouser, part.package, part.value, part.location].join(" ").toLowerCase();
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
  lcscDetailsCache.clear();
  res.json({ ok: true });
});

app.post("/api/pricing/lcsc/update", async (_req, res) => {
  const store = readStore();
  const result = await updateLcscPartData(store, { requirePricing: true });
  writeStore(store);
  res.json(result);
});

app.post("/api/parts/update-all", async (_req, res) => {
  const store = readStore();
  const pricing = await updateLcscPartData(store);
  writeStore(store);
  const footprints = await buildEasyEdaFootprintPreview(store);
  if (pricing.total) {
    store.movements.unshift({
      id: `move_${Date.now()}`,
      type: "part-data-update",
      partName: `${pricing.updated} LCSC part${pricing.updated === 1 ? "" : "s"}`,
      delta: 0,
      source: "LCSC and EasyEDA",
      at: now()
    });
    writeStore(store);
  }
  res.json({ pricing, footprints });
});

app.post("/api/import/mouser/preview", (req, res) => {
  try {
    const base64 = String(req.body.fileBase64 || "").replace(/^data:.*?;base64,/, "");
    if (!base64) return res.status(400).json({ error: "fileBase64 is required" });
    const rows = parseMouserWorkbook(Buffer.from(base64, "base64"));
    if (!rows.length) return res.status(400).json({ error: "No Mouser order lines were found in this workbook" });
    res.json({ rows });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not parse Mouser order workbook" });
  }
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
    if (row.priceBreaks?.length && !row.priceUpdatedAt) row.priceUpdatedAt = now();
    row.storageType = normalizeStorageType(row.storageType || batch.storageType);
    if (row.lcsc) {
      try {
        const details = await lookupLcscDetails(row.lcsc);
        if (!row.photoUrl) row.photoUrl = details.photoUrl;
        if (details.priceBreaks.length) {
          row.priceBreaks = details.priceBreaks;
          row.priceSource = "LCSC";
          row.priceUpdatedAt = now();
        }
      } catch (_error) {
        // Import remains usable when LCSC is temporarily unavailable.
      }
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
    summary: bomSummary(lines)
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
      summary: bomSummary(lines)
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
      { method: "POST", path: "/parts", description: "Create a part. Optional heightMm overrides the package-based OpenPnP height default." },
      { method: "PATCH", path: "/parts/:id", description: "Update a part, including its OpenPnP placement height with heightMm." },
      { method: "DELETE", path: "/parts/:id", description: "Delete a part." },
      { method: "POST", path: "/import/order", description: "Import purchased parts. Body: { rows: [{ lcsc, mpn, name, quantity, category, package, value, manufacturer }] }." },
      { method: "POST", path: "/import/mouser/preview", description: "Parse a Mouser .xls or .xlsx order before importing. Body: { fileName, fileBase64 }." },
      { method: "GET", path: "/import/order/history", description: "List supplier order import batches, including undone imports." },
      { method: "POST", path: "/import/order/:id/undo", description: "Undo one supplier order import batch and subtract those quantities from components." },
      { method: "POST", path: "/bom/check", description: "Compare BOM rows with inventory. Body: { rows: [{ lcsc, mpn, name, quantity, package, value }] }." },
      { method: "POST", path: "/bom/upload", description: "Upload an XLSX BOM as base64. Body: { fileName, fileBase64 }. Returns compatible stock matches and shortages." },
      { method: "POST", path: "/bom/matches", description: "Save a reusable BOM-to-inventory match. Body: { requested: { lcsc, mpn, package, value }, partId }." },
      { method: "POST", path: "/pricing/lcsc/update", description: "Refresh USD price breaks for all components with an LCSC part number." },
      { method: "POST", path: "/parts/update-all", description: "Refresh LCSC pricing and photos, then fetch missing EasyEDA footprint previews for approval." },
      { method: "GET", path: "/export/openpnp/parts.xml", description: "Download all unique inventory components as an OpenPnP parts.xml file." },
      { method: "GET", path: "/export/openpnp/packages.xml", description: "Download OpenPnP packages.xml with generated footprints for standard two-terminal passive packages." },
      { method: "GET", path: "/export/openpnp/status", description: "Report which inventory components have generated OpenPnP footprints and which need review." },
      { method: "GET", path: "/openpnp/packages/known", description: "List built-in and inventory package footprints available for manual mapping." },
      { method: "POST", path: "/openpnp/packages/assign", description: "Assign a known package footprint to one or more inventory component IDs." },
      { method: "GET", path: "/openpnp/nozzles", description: "List OpenPnP packages with ReelKeeper nozzle size assignments and recommendations." },
      { method: "POST", path: "/openpnp/nozzles/assign", description: "Assign one ReelKeeper nozzle size to an OpenPnP package." },
      { method: "POST", path: "/openpnp/nozzles/auto", description: "Assign conservative nozzle size recommendations to currently unassigned packages." },
      { method: "POST", path: "/openpnp/footprints/fetch", description: "Fetch EasyEDA footprint previews for inventory components with LCSC numbers." },
      { method: "POST", path: "/openpnp/footprints/approve", description: "Approve fetched EasyEDA footprint previews using the temporary token and selected LCSC numbers." },
      { method: "GET", path: "/export/openpnp/import-script.js", description: "Download an additive OpenPnP script that creates missing packages and parts without changing existing IDs." },
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
