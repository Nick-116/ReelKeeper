const state = {
  parts: [],
  movements: [],
  activePart: null,
  pendingImport: null,
  currentBom: null,
  pendingBomMatchLineIndex: null,
  advancedFilters: {}
};

const routes = {
  "/": "components",
  "/components": "components",
  "/inventory": "components",
  "/bom": "bom",
  "/orders": "orders",
  "/add-inventory": "orders",
  "/settings": "settings"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const fields = {
  id: $("#partId"),
  name: $("#partName"),
  category: $("#partCategory"),
  manufacturer: $("#partManufacturer"),
  mpn: $("#partMpn"),
  lcsc: $("#partLcsc"),
  mouser: $("#partMouser"),
  package: $("#partPackage"),
  value: $("#partValue"),
  quantity: $("#partQuantity"),
  storageType: $("#partStorageType"),
  photoUrl: $("#partPhotoUrl")
};

function normalizeHeader(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const headerMap = {
  lcsc: "lcsc",
  lcscpart: "lcsc",
  lcscpartnumber: "lcsc",
  supplierpart: "lcsc",
  supplierpartnumber: "lcsc",
  jlcpcbpart: "lcsc",
  mpn: "mpn",
  manufacturepartnumber: "mpn",
  mfrpart: "mpn",
  manufacturerpart: "mpn",
  manufacturerpartnumber: "mpn",
  partnumber: "mpn",
  name: "name",
  description: "description",
  comment: "name",
  category: "category",
  package: "package",
  footprint: "package",
  value: "value",
  quantity: "quantity",
  qty: "quantity",
  required: "quantity",
  orderquantity: "quantity",
  manufacturer: "manufacturer",
  mfr: "manufacturer",
  location: "location",
  bin: "location",
  storage: "storageType",
  storagetype: "storageType",
  packaging: "storageType",
  packagingstatus: "storageType",
  designator: "designator",
  reference: "designator",
  references: "designator",
  photourl: "photoUrl",
  image: "photoUrl",
  notes: "notes"
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((header) => headerMap[normalizeHeader(header)] || normalizeHeader(header));
  return rows.slice(1).map((values) => {
    const output = {};
    headers.forEach((header, index) => {
      if (!header) return;
      output[header] = values[index] ? values[index].trim() : "";
    });
    if (output.quantity) output.quantity = Number(String(output.quantity).replace(/[^0-9.-]/g, "")) || 0;
    return output;
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/\s*[±+/-]\s*\d+(?:\.\d+)?\s*%/gi, "")
    .replace(/\b(?:X5R|X7R|X6S|X7S|Y5V|C0G|NP0|Thick Film|Thin Film|Ceramic Capacitor|RoHS)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,)])/g, "$1")
    .trim();
}

function displayName(part) {
  return cleanDisplayText(part.name || part.description || part.mpn || "Unnamed part");
}

function categoryBadge(category) {
  return `<span class="category-badge">${escapeHtml(category || "Uncategorized")}</span>`;
}

function storageLabel(storageType) {
  if (storageType === "loose") return "Loose stock";
  if (storageType === "mixed") return "Mixed packaging";
  return "Machine-ready packaging";
}

function capacitorType(part) {
  const text = [part.name, part.description, part.mpn].join(" ").toLowerCase();
  if (/electrolytic|aluminum|aluminium/.test(text)) return "Electrolytic";
  if (/tantalum/.test(text)) return "Tantalum";
  if (/ceramic|x5r|x7r|x6s|c0g|np0|y5v/.test(text)) return "Ceramic";
  if (/film/.test(text)) return "Film";
  return "Other";
}

function formatCompactNumber(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatElectrical(spec) {
  if (!spec) return "";
  const value = Number(spec.value);
  if (!Number.isFinite(value)) return "";
  if (spec.kind === "resistance") {
    if (value >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}MΩ`;
    if (value >= 1_000) return `${formatCompactNumber(value / 1_000)}kΩ`;
    return `${formatCompactNumber(value)}Ω`;
  }
  if (spec.kind === "capacitance") {
    if (value >= 1e-3) return `${formatCompactNumber(value / 1e-3)}mF`;
    if (value >= 1e-6) return `${formatCompactNumber(value / 1e-6)}uF`;
    if (value >= 1e-9) return `${formatCompactNumber(value / 1e-9)}nF`;
    return `${formatCompactNumber(value / 1e-12)}pF`;
  }
  if (spec.kind === "inductance") {
    if (value >= 1e-3) return `${formatCompactNumber(value / 1e-3)}mH`;
    if (value >= 1e-6) return `${formatCompactNumber(value / 1e-6)}uH`;
    return `${formatCompactNumber(value / 1e-9)}nH`;
  }
  return "";
}

function optionValue(value) {
  return String(value || "").trim();
}

function uniqueSorted(values) {
  return [...new Set(values.map(optionValue).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function renderSelectFilter(id, label, values) {
  if (!values.length) return "";
  const selected = state.advancedFilters[id] || "";
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-advanced-filter="${escapeHtml(id)}">
        <option value="">All</option>
        ${values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
      </select>
    </label>
  `;
}

function renderAdvancedFilters() {
  const container = $("#advancedFilters");
  const category = $("#categoryFilter").value;
  const categoryParts = state.parts.filter((part) => !category || part.category === category);
  let html = "";

  if (category === "Resistors") {
    html = [
      renderSelectFilter("electrical", "Resistance", uniqueSorted(categoryParts.map((part) => formatElectrical(part.specs?.electrical)))),
      renderSelectFilter("voltage", "Voltage", uniqueSorted(categoryParts.map((part) => part.specs?.voltage ? `${part.specs.voltage}V` : ""))),
      renderSelectFilter("package", "Package", uniqueSorted(categoryParts.map((part) => part.specs?.package || part.package))),
      renderSelectFilter("storageType", "Packaging", uniqueSorted(categoryParts.map((part) => storageLabel(part.storageType))))
    ].join("");
  } else if (category === "Capacitors") {
    html = [
      renderSelectFilter("electrical", "Capacitance", uniqueSorted(categoryParts.map((part) => formatElectrical(part.specs?.electrical)))),
      renderSelectFilter("capacitorType", "Type", uniqueSorted(categoryParts.map(capacitorType))),
      renderSelectFilter("voltage", "Voltage", uniqueSorted(categoryParts.map((part) => part.specs?.voltage ? `${part.specs.voltage}V` : ""))),
      renderSelectFilter("package", "Package", uniqueSorted(categoryParts.map((part) => part.specs?.package || part.package))),
      renderSelectFilter("storageType", "Packaging", uniqueSorted(categoryParts.map((part) => storageLabel(part.storageType))))
    ].join("");
  } else if (category) {
    html = [
      renderSelectFilter("package", "Package", uniqueSorted(categoryParts.map((part) => part.specs?.package || part.package))),
      renderSelectFilter("storageType", "Packaging", uniqueSorted(categoryParts.map((part) => storageLabel(part.storageType))))
    ].join("");
  }

  container.innerHTML = html;
  container.classList.toggle("active", Boolean(html));
}

function partAdvancedValue(part, key) {
  if (key === "electrical") return formatElectrical(part.specs?.electrical);
  if (key === "voltage") return part.specs?.voltage ? `${part.specs.voltage}V` : "";
  if (key === "package") return part.specs?.package || part.package || "";
  if (key === "capacitorType") return capacitorType(part);
  if (key === "storageType") return storageLabel(part.storageType);
  return "";
}

function categories() {
  return [...new Set(state.parts.map((part) => part.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function renderCategoryControls() {
  const filter = $("#categoryFilter");
  const selected = filter.value;
  filter.innerHTML = `<option value="">All categories</option>${categories().map((category) => `<option>${escapeHtml(category)}</option>`).join("")}`;
  filter.value = selected;
  $("#categoryOptions").innerHTML = categories().map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");
}

function renderStats() {
  $("#componentTypes").textContent = state.parts.length.toLocaleString();
  const totalQuantity = state.parts.reduce((sum, part) => sum + Number(part.quantity || 0), 0);
  $("#totalParts").textContent = totalQuantity.toLocaleString();
}

function filteredParts() {
  const q = $("#searchInput").value.trim().toLowerCase();
  const category = $("#categoryFilter").value;

  return state.parts.filter((part) => {
    const haystack = [part.name, part.category, part.manufacturer, part.mpn, part.lcsc, part.mouser, part.package, part.value].join(" ").toLowerCase();
    const advancedOk = Object.entries(state.advancedFilters).every(([key, value]) => !value || partAdvancedValue(part, key) === value);
    return (!q || haystack.includes(q)) &&
      (!category || part.category === category) &&
      advancedOk;
  });
}

function partInitials(part) {
  if (part.category) return part.category.slice(0, 2).toUpperCase();
  return "IC";
}

function renderParts() {
  const grid = $("#partsGrid");
  const parts = filteredParts();

  if (!parts.length) {
    grid.innerHTML = `<div class="panel"><h3>No parts found</h3><p class="hint">Try clearing filters or add a new part.</p></div>`;
    return;
  }

  grid.innerHTML = parts.map((part) => {
    const loose = part.storageType === "loose";
    const thumb = part.photoUrl
      ? `<img class="component-thumb" src="${escapeHtml(part.photoUrl)}" alt="${escapeHtml(displayName(part))}" onerror="this.style.visibility='hidden'">`
      : `<div class="component-thumb thumb-fallback">${escapeHtml(partInitials(part))}</div>`;
    return `
      <article class="component-row ${loose ? "is-loose" : ""}">
        ${thumb}
        <div class="component-main">
          <h3>${escapeHtml(displayName(part))}</h3>
          <div class="meta">
            ${part.lcsc ? `<span class="pill">${escapeHtml(part.lcsc)}</span>` : ""}
            ${part.mouser ? `<span class="pill">Mouser ${escapeHtml(part.mouser)}</span>` : ""}
            ${part.package ? `<span class="pill">${escapeHtml(part.package)}</span>` : ""}
            ${part.value ? `<span class="pill">${escapeHtml(part.value)}</span>` : ""}
            ${part.storageType === "loose" ? `<span class="pill loose-pill">Loose stock</span>` : ""}
            ${part.priceBreaks?.length ? `<span class="pill price-pill">${part.priceSource ? `${escapeHtml(part.priceSource)} ` : "From "}$${Number(part.priceBreaks.at(-1).unitPrice).toFixed(4)}</span>` : ""}
          </div>
        </div>
        <div class="component-detail">
          <span>${escapeHtml(part.manufacturer || "Unknown manufacturer")}</span>
          <span>${escapeHtml(part.mpn || "No MPN")}</span>
        </div>
        <div class="component-stock">
          <div class="qty">${part.quantity.toLocaleString()}</div>
        </div>
        ${categoryBadge(part.category)}
        <div class="component-actions">
          <button data-edit="${part.id}">Edit</button>
        </div>
      </article>
    `;
  }).join("");
}

async function loadParts() {
  const data = await api("/api/parts");
  state.parts = data.parts;
  state.movements = data.movements || [];
  renderCategoryControls();
  renderStats();
  renderAdvancedFilters();
  renderParts();
}

function openPartDialog(part = null) {
  state.activePart = part;
  $("#dialogTitle").textContent = part ? "Edit part" : "Add part";
  $("#deletePartBtn").style.visibility = part ? "visible" : "hidden";

  Object.entries(fields).forEach(([key, field]) => {
    field.value = part ? (part[key] ?? "") : "";
  });

  if (!part) {
    fields.quantity.value = 0;
  }

  $("#partDialog").showModal();
}

function formPayload() {
  return {
    name: fields.name.value,
    category: fields.category.value,
    manufacturer: fields.manufacturer.value,
    mpn: fields.mpn.value,
    lcsc: fields.lcsc.value,
    mouser: fields.mouser.value,
    package: fields.package.value,
    value: fields.value.value,
    quantity: Number(fields.quantity.value || 0),
    storageType: fields.storageType.value,
    photoUrl: fields.photoUrl.value
  };
}

async function savePart(event) {
  event.preventDefault();
  const id = fields.id.value;
  if (id) {
    await api(`/api/parts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(formPayload()) });
  } else {
    await api("/api/parts", { method: "POST", body: JSON.stringify(formPayload()) });
  }
  $("#partDialog").close();
  await loadParts();
}

async function deletePart() {
  const id = fields.id.value;
  if (!id) return;
  const confirmed = window.confirm("Delete this part from inventory?");
  if (!confirmed) return;
  await api(`/api/parts/${encodeURIComponent(id)}`, { method: "DELETE" });
  $("#partDialog").close();
  await loadParts();
}

function renderBomResults(data) {
  state.currentBom = data;
  data.summary = {
    ...(data.summary || {}),
    total: data.lines.length,
    ready: data.lines.filter((line) => line.status === "ready").length,
    short: data.lines.filter((line) => line.status === "short").length,
    missing: data.lines.filter((line) => line.status === "missing").length
  };
  $("#bomResultsSection").classList.remove("hidden");
  $("#bomSummary").innerHTML = ["total", "ready", "short", "missing"].map((key) => `
    <div>
      <strong>${data.summary[key]}</strong>
      <span>${key}</span>
    </div>
  `).join("");
  const cost = Number(data.summary.estimatedCostPerBoard || 0);
  const unpriced = Number(data.summary.unpricedLines || 0);
  $("#bomCostSummary").innerHTML = `
    <div><span>Estimated component cost per board</span><strong>${cost.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })}</strong></div>
    <span>${unpriced ? `${unpriced} BOM line${unpriced === 1 ? " is" : "s are"} not included because pricing is unavailable.` : "All BOM lines include saved pricing."}</span>
  `;

  const stocked = data.lines.filter((line) => line.status === "ready");
  const order = data.lines.filter((line) => line.status !== "ready");

  $("#bomHaveResults").innerHTML = stocked.map((line) => {
    const requested = line.requested;
    const title = requested.designator || requested.name || requested.value || requested.lcsc || requested.mpn || "BOM line";
    const matches = line.matches || [];
    const matchList = matches.map((match) => `
      <div class="candidate">
        <strong>${escapeHtml(displayName(match.part))}</strong>
        <span class="meta">${Number(match.available).toLocaleString()} available · ${escapeHtml([match.part.lcsc, match.part.mpn, match.part.package, match.part.value].filter(Boolean).join(" · "))}</span>
      </div>
    `).join("");
    return `
      <div class="result-row ${line.status}">
        ${categoryBadge(requested.category || line.requestedSpecs?.category)}
        <strong>${escapeHtml(title)} · ${escapeHtml(line.status.toUpperCase())}</strong>
        <span class="meta">Need ${line.required.toLocaleString()} · Have ${line.available.toLocaleString()}</span>
        <span class="meta">${line.estimatedCost !== null ? formatBomLineCost(line) : "Price unavailable"}</span>
        ${line.manuallyCovered ? `<span class="manual-covered-label">Marked as covered for this BOM only</span>` : ""}
        ${line.savedMatch ? `<span class="saved-match-label">Using saved inventory match</span>` : ""}
        ${matchList}
      </div>
    `;
  }).join("") || `<p class="hint">No BOM lines are fully covered by inventory yet.</p>`;

  $("#bomOrderResults").innerHTML = order.map((line) => {
    const lineIndex = data.lines.indexOf(line);
    const requested = line.requested;
    const title = requested.designator || requested.name || requested.value || requested.lcsc || requested.mpn || "BOM line";
    const spec = [
      requested.value,
      requested.footprint || requested.package,
      requested.lcsc,
      requested.mpn
    ].filter(Boolean).join(" · ");
    const partial = (line.matches || []).map((match) => `${displayName(match.part)}: ${Number(match.available).toLocaleString()} available`).join("; ");
    return `
      <div class="result-row ${line.status}">
        ${categoryBadge(requested.category || line.requestedSpecs?.category)}
        <strong>${escapeHtml(title)} · ORDER ${line.shortage.toLocaleString()}</strong>
        <span class="meta">Need ${line.required.toLocaleString()} · Have ${line.available.toLocaleString()} · Short ${line.shortage.toLocaleString()}</span>
        <span class="meta">${line.estimatedCost !== null ? formatBomLineCost(line) : "Price unavailable"}</span>
        <span>${escapeHtml(cleanDisplayText(spec) || "No parsed specification")}</span>
        ${partial ? `<span class="meta">Partial compatible stock: ${escapeHtml(partial)}</span>` : ""}
        <div class="bom-correction-actions">
          <button type="button" data-mark-bom-covered="${lineIndex}">I already have this</button>
          <button type="button" class="primary" data-open-bom-match="${lineIndex}" ${state.parts.length ? "" : "disabled"}>Search inventory to match</button>
        </div>
      </div>
    `;
  }).join("") || `<p class="hint">Everything in the uploaded BOM is covered by stock.</p>`;
}

function formatBomLineCost(line) {
  const unit = Number(line.unitPrice).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 });
  const total = Number(line.estimatedCost).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return `${total} per board · ${unit} each`;
}

function markBomLineCovered(lineIndex) {
  const line = state.currentBom?.lines[lineIndex];
  if (!line) return;
  line.status = "ready";
  line.available = Math.max(line.available, line.required);
  line.shortage = 0;
  line.manuallyCovered = true;
  renderBomResults(state.currentBom);
}

function bomMatchHaystack(part) {
  return [part.name, part.lcsc, part.mouser, part.mpn, part.category, part.value, part.package, part.manufacturer].filter(Boolean).join(" ").toLowerCase();
}

function renderBomMatchSearch() {
  const query = $("#bomMatchSearchInput").value.trim().toLowerCase();
  const matches = state.parts.filter((part) => !query || bomMatchHaystack(part).includes(query));
  const shown = matches.slice(0, 50);
  $("#bomMatchResults").innerHTML = shown.map((part) => `
    <button type="button" class="bom-match-result" data-select-bom-part="${escapeHtml(part.id)}">
      <strong>${escapeHtml(displayName(part))}</strong>
      <span>${escapeHtml([part.lcsc, part.mpn, part.value, part.package].filter(Boolean).join(" · "))}</span>
      <span>${Number(part.quantity || 0).toLocaleString()} available</span>
    </button>
  `).join("") || `<p class="hint">No components match that search.</p>`;
  if (matches.length > shown.length) {
    $("#bomMatchResults").insertAdjacentHTML("beforeend", `<p class="hint">${matches.length - shown.length} more results. Refine your search to narrow the list.</p>`);
  }
}

function openBomMatchDialog(lineIndex) {
  const line = state.currentBom?.lines[lineIndex];
  if (!line) return;
  state.pendingBomMatchLineIndex = lineIndex;
  const requested = line.requested;
  $("#bomMatchRequestLabel").textContent = requested.designator || requested.name || requested.value || requested.lcsc || requested.mpn || "BOM line";
  $("#bomMatchSearchInput").value = "";
  renderBomMatchSearch();
  $("#bomMatchDialog").showModal();
  $("#bomMatchSearchInput").focus();
}

async function saveBomMatch(partId) {
  const lineIndex = state.pendingBomMatchLineIndex;
  const line = state.currentBom?.lines[lineIndex];
  if (!line || !partId) return;
  try {
    await api("/api/bom/matches", {
      method: "POST",
      body: JSON.stringify({ requested: line.requested, partId })
    });
    $("#bomMatchDialog").close();
    state.pendingBomMatchLineIndex = null;
    await checkBom();
  } catch (error) {
    window.alert(`Could not save match: ${error.message}`);
  }
}

function exportBomOrder() {
  const lines = state.currentBom?.lines.filter((line) => line.status !== "ready" && line.shortage > 0) || [];
  if (!lines.length) {
    window.alert("There are no remaining components to order.");
    return;
  }
  const headers = ["Quantity to Order", "Designator", "Description", "Value", "Package", "LCSC Part Number", "Manufacturer Part Number"];
  const rows = lines.map((line) => {
    const part = line.requested;
    return [line.shortage, part.designator, part.name || part.description, part.value, part.footprint || part.package, part.lcsc, part.mpn];
  });
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "reelkeeper_parts_to_order.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function resetBomChecker() {
  state.currentBom = null;
  state.pendingBomMatchLineIndex = null;
  $("#bomFile").value = "";
  $("#bomResultsSection").classList.add("hidden");
  $("#bomSummary").innerHTML = "";
  $("#bomCostSummary").innerHTML = "";
  $("#bomHaveResults").innerHTML = "";
  $("#bomOrderResults").innerHTML = "";
  if ($("#bomMatchDialog").open) $("#bomMatchDialog").close();
}

function resetComponentSearch() {
  $("#searchInput").value = "";
  $("#categoryFilter").value = "";
  state.advancedFilters = {};
  renderAdvancedFilters();
  renderParts();
}

async function checkBom() {
  const file = $("#bomFile").files[0];
  if (!file) {
    window.alert("Choose a BOM .xlsx file first.");
    return;
  }
  const fileBase64 = await fileToBase64(file);
  const data = await api("/api/bom/upload", {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, fileBase64 })
  });
  renderBomResults(data);
}

async function updateLcscPricing() {
  const button = $("#updatePricingBtn");
  const status = $("#pricingStatus");
  button.disabled = true;
  button.classList.add("is-loading");
  status.textContent = "Updating prices from LCSC...";
  try {
    const result = await api("/api/pricing/lcsc/update", { method: "POST" });
    status.textContent = result.total
      ? `Updated ${result.updated} of ${result.total} LCSC part numbers${result.failed ? `; ${result.failed} failed` : ""}.`
      : "No components have an LCSC part number yet.";
    await loadParts();
  } catch (error) {
    status.textContent = `Pricing update failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function previewRows(rows, fileName, source) {
  const validRows = rows.filter((row) => Number(row.quantity || 0) > 0)
    .map((row) => {
      const quantity = Number(row.quantity || 0);
      const storageType = row.storageType === "loose" ? "loose" : "machine-ready";
      return {
        ...row,
        storageType,
        machineReadyQuantity: storageType === "loose" ? 0 : quantity,
        looseQuantity: storageType === "loose" ? quantity : 0
      };
    });
  state.pendingImport = { rows: validRows, fileName, source };

  $("#importPreviewSummary").innerHTML = `
    <strong>${escapeHtml(fileName)}</strong>
    <span>${validRows.length.toLocaleString()} importable line${validRows.length === 1 ? "" : "s"}</span>
  `;
  $("#importPreviewList").innerHTML = validRows.slice(0, 80).map((row) => `
    <div class="preview-row" data-preview-index="${validRows.indexOf(row)}">
      <strong>${escapeHtml(row.name || row.description || row.mpn || row.lcsc || row.mouser || "Unnamed part")}</strong>
      <span class="meta">${escapeHtml([row.lcsc, row.mouser ? `Mouser ${row.mouser}` : "", row.mpn, row.package, row.value].filter(Boolean).join(" · "))}</span>
      ${row.priceBreaks?.length ? `<span class="meta">Saved unit cost: $${Number(row.priceBreaks[0].unitPrice).toFixed(4)}${row.priceSource ? ` from ${escapeHtml(row.priceSource)}` : ""}</span>` : ""}
      <label class="preview-storage">
        <span>Packaging</span>
        <select data-preview-storage="${validRows.indexOf(row)}">
          <option value="machine-ready" ${row.storageType !== "loose" ? "selected" : ""}>Machine-ready</option>
          <option value="loose" ${row.storageType === "loose" ? "selected" : ""}>Loose stock</option>
          <option value="split" ${Number(row.quantity) < 2 ? "disabled" : ""}>Split stock</option>
        </select>
        <div class="preview-split hidden" data-preview-split-panel="${validRows.indexOf(row)}">
          <label>
            <span>Machine-ready</span>
            <input type="number" min="0" max="${Number(row.quantity)}" step="1" value="${Number(row.machineReadyQuantity)}" data-preview-split-qty="${validRows.indexOf(row)}" data-split-kind="machineReadyQuantity">
          </label>
          <label>
            <span>Loose</span>
            <input type="number" min="0" max="${Number(row.quantity)}" step="1" value="${Number(row.looseQuantity)}" data-preview-split-qty="${validRows.indexOf(row)}" data-split-kind="looseQuantity">
          </label>
        </div>
      </label>
      <span class="preview-qty">+${Number(row.quantity || 0).toLocaleString()}</span>
    </div>
  `).join("") || `<p class="hint">No rows with positive quantity were found.</p>`;

  $("#confirmImportBtn").disabled = validRows.length === 0;
  $("#importPreviewDialog").showModal();
}

function applyImportDefaultPackaging(storageType) {
  if (!state.pendingImport) return;
  state.pendingImport.rows = state.pendingImport.rows.map((row) => {
    const quantity = Number(row.quantity || 0);
    return {
      ...row,
      storageType,
      machineReadyQuantity: storageType === "loose" ? 0 : quantity,
      looseQuantity: storageType === "loose" ? quantity : 0
    };
  });
  $$("[data-preview-storage]").forEach((select, index) => {
    select.value = storageType;
    updatePreviewSplitUi(index);
  });
}

function setPreviewRowPackaging(index, storageType) {
  const row = state.pendingImport?.rows[index];
  if (!row) return;
  const quantity = Number(row.quantity || 0);
  let machineReadyQuantity = storageType === "loose" ? 0 : quantity;
  let looseQuantity = storageType === "loose" ? quantity : 0;
  if (storageType === "split") {
    looseQuantity = Math.floor(quantity / 2);
    machineReadyQuantity = quantity - looseQuantity;
  }
  state.pendingImport.rows[index] = { ...row, storageType, machineReadyQuantity, looseQuantity };
  updatePreviewSplitUi(index);
}

function updatePreviewSplitUi(index) {
  const row = state.pendingImport?.rows[index];
  if (!row) return;
  const panel = $(`[data-preview-split-panel="${index}"]`);
  panel?.classList.toggle("hidden", row.storageType !== "split");
  $$( `[data-preview-split-qty="${index}"]`).forEach((input) => {
    input.value = Number(row[input.dataset.splitKind] || 0);
  });
}

function setPreviewSplitQuantity(index, kind, rawValue) {
  const row = state.pendingImport?.rows[index];
  if (!row) return;
  const total = Number(row.quantity || 0);
  const value = Math.min(total, Math.max(0, Math.round(Number(rawValue) || 0)));
  const otherKind = kind === "looseQuantity" ? "machineReadyQuantity" : "looseQuantity";
  state.pendingImport.rows[index] = { ...row, [kind]: value, [otherKind]: total - value };
  updatePreviewSplitUi(index);
}

async function importOrder() {
  const file = $("#orderFile").files[0];
  if (!file) {
    window.alert("Choose an LCSC order CSV file first.");
    return;
  }
  const text = await file.text();
  const rows = parseCsv(text);
  previewRows(rows, file.name, "orderFile");
}

async function importMouserOrder() {
  const input = $("#mouserOrderFile");
  const file = input.files[0];
  if (!file) return;
  try {
    const fileBase64 = await fileToBase64(file);
    const data = await api("/api/import/mouser/preview", {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, fileBase64 })
    });
    previewRows(data.rows, file.name, "mouserOrderFile");
  } catch (error) {
    input.value = "";
    window.alert(`Could not read Mouser order: ${error.message}`);
  }
}

async function importTemplate() {
  const file = $("#templateFile").files[0];
  if (!file) return;
  const text = await file.text();
  const rows = parseCsv(text);
  previewRows(rows, file.name, "templateFile");
}

async function confirmImport(event) {
  event.preventDefault();
  if (!state.pendingImport) return;
  const storageType = document.querySelector('input[name="importStorageType"]:checked')?.value || "machine-ready";
  const invalidSplit = state.pendingImport.rows.find((row) => row.storageType === "split" && (!row.machineReadyQuantity || !row.looseQuantity));
  if (invalidSplit) {
    window.alert("Split stock must have at least one component in both machine-ready and loose stock.");
    return;
  }
  const rows = state.pendingImport.rows.flatMap((row) => {
    if (row.storageType !== "split") return [{ ...row, storageType: row.storageType || storageType }];
    return [
      { ...row, quantity: row.machineReadyQuantity, storageType: "machine-ready" },
      { ...row, quantity: row.looseQuantity, storageType: "loose" }
    ];
  });
  const pendingImport = state.pendingImport;
  const confirmButton = $("#confirmImportBtn");
  confirmButton.disabled = true;
  $("#importPreviewDialog").close();
  $("#importLoadingOverlay").classList.remove("hidden");

  try {
    const data = await api("/api/import/order", {
      method: "POST",
      body: JSON.stringify({ ...pendingImport, rows, storageType })
    });
    if (pendingImport.source) {
      $(`#${pendingImport.source}`).value = "";
    }
    state.pendingImport = null;
    await loadParts();
    await loadImportHistory();
    window.alert(`Imported ${data.count} line${data.count === 1 ? "" : "s"}.`);
  } catch (error) {
    $("#importPreviewDialog").showModal();
    window.alert(`Import failed: ${error.message}`);
  } finally {
    confirmButton.disabled = false;
    $("#importLoadingOverlay").classList.add("hidden");
  }
}

function cancelImportPreview() {
  if (state.pendingImport?.source) {
    $(`#${state.pendingImport.source}`).value = "";
  }
  state.pendingImport = null;
  $("#importPreviewDialog").close();
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportTemplate() {
  const headers = ["LCSC", "MPN", "Name", "Category", "Package", "Value", "Manufacturer", "Quantity", "Packaging Status"];
  const example = ["C25804", "0603WAF1002T5E", "10k resistor", "Resistors", "0603", "10k", "UNI-ROYAL", "1000", "machine-ready"];
  const csv = [headers, example].map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "reelkeeper_inventory_template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadDocs() {
  const docs = await api("/api/docs");
  $("#apiDocs").innerHTML = `<code>${escapeHtml(JSON.stringify(docs, null, 2))}</code>`;
}

async function loadImportHistory() {
  const container = $("#importHistory");
  if (!container) return;
  const data = await api("/api/import/order/history");
  container.innerHTML = data.imports.map((item) => {
    const imported = new Date(item.importedAt).toLocaleString();
    const undone = item.undoneAt ? new Date(item.undoneAt).toLocaleString() : "";
    const preview = (item.changes || []).slice(0, 3).map((change) => `${change.lcsc || change.mpn || change.name}: +${change.added}`).join(" · ");
    return `
      <div class="result-row ${item.undoneAt ? "missing" : "ready"}">
        <strong>${escapeHtml(item.fileName || "LCSC order CSV")}</strong>
        <span class="meta">${escapeHtml(imported)} · ${Number(item.count || 0).toLocaleString()} parts · ${Number(item.totalQuantity || 0).toLocaleString()} pieces · ${escapeHtml(storageLabel(item.storageType))}</span>
        ${preview ? `<span>${escapeHtml(preview)}</span>` : ""}
        ${item.undoneAt ? `<span class="meta">Undone ${escapeHtml(undone)}</span>` : `<button class="danger undo-import-btn" data-undo-import="${escapeHtml(item.id)}">Undo import</button>`}
      </div>
    `;
  }).join("") || `<p class="hint">No order imports yet.</p>`;
}

function auditActionLabel(type) {
  return ({
    create: "Component added",
    edit: "Component edited",
    adjust: "Quantity adjusted",
    delete: "Component deleted",
    "order-import": "Order imported",
    "order-import-undo": "Order import undone",
    consume: "Component used",
    "bom-match": "BOM match saved"
  })[type] || type;
}

async function loadAuditLog() {
  const container = $("#auditLog");
  if (!container) return;
  const data = await api("/api/audit");
  container.innerHTML = data.entries.map((entry) => {
    const delta = Number(entry.delta || 0);
    const quantityText = delta ? `${delta > 0 ? "+" : ""}${delta.toLocaleString()}` : "No quantity change";
    return `
      <div class="audit-entry">
        <div>
          <strong>${escapeHtml(auditActionLabel(entry.type))}</strong>
          <span>${escapeHtml(entry.partName || entry.partId || "Component")}</span>
        </div>
        <div class="audit-entry-detail">
          <span class="audit-delta ${delta < 0 ? "negative" : ""}">${escapeHtml(quantityText)}</span>
          <span>${escapeHtml(entry.source || "ReelKeeper")}</span>
          <time datetime="${escapeHtml(entry.at)}">${escapeHtml(new Date(entry.at).toLocaleString())}</time>
        </div>
      </div>
    `;
  }).join("") || `<p class="hint">No activity has been recorded yet.</p>`;
}

async function undoImport(batchId) {
  const confirmed = window.confirm("Undo this order import and subtract those quantities from components?");
  if (!confirmed) return;
  await api(`/api/import/order/${encodeURIComponent(batchId)}/undo`, { method: "POST" });
  await loadParts();
  await loadImportHistory();
}

async function resetSoftware() {
  const confirmed = window.confirm("Reset ReelKeeper to defaults? This permanently removes all components, stock movements, and order import history.");
  if (!confirmed) return;

  const button = $("#resetSoftwareBtn");
  button.disabled = true;
  try {
    await api("/api/reset", { method: "POST" });
    state.pendingImport = null;
    await loadParts();
    await loadImportHistory();
    window.alert("ReelKeeper has been reset to its defaults.");
  } catch (error) {
    window.alert(`Reset failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function activateView(viewId, options = {}) {
  const normalized = viewId === "inventory" ? "components" : viewId;
  const leavingBom = $("#bom").classList.contains("active") && normalized !== "bom";
  if (leavingBom) resetBomChecker();
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === normalized));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === normalized));
  if (normalized === "settings") {
    loadDocs();
    loadImportHistory();
  }

  if (options.push !== false) {
    const route = $(`.tab[data-view="${normalized}"]`)?.dataset.route || "/components";
    if (window.location.pathname !== route) {
      history.pushState({ view: normalized }, "", route);
    }
  }
}

function activateRoute() {
  activateView(routes[window.location.pathname] || "components", { push: false });
}

function activateSettingsPanel(panelId) {
  $$(".settings-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.settingsPanel === panelId));
  $$(".settings-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `settings-${panelId}`));
  if (panelId === "api") loadDocs();
  if (panelId === "history") loadImportHistory();
  if (panelId === "audit") loadAuditLog();
}

function bindEvents() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      activateView(button.dataset.view);
    });
  });

  $("#newPartBtn").addEventListener("click", () => openPartDialog());
  $("#closeDialogBtn").addEventListener("click", () => $("#partDialog").close());
  $("#cancelDialogBtn").addEventListener("click", () => $("#partDialog").close());
  $("#partForm").addEventListener("submit", savePart);
  $("#deletePartBtn").addEventListener("click", deletePart);
  $("#checkBomBtn").addEventListener("click", checkBom);
  $("#exportBomOrderBtn").addEventListener("click", exportBomOrder);
  $("#clearSearchBtn").addEventListener("click", resetComponentSearch);
  $("#manualAddComponentBtn").addEventListener("click", () => openPartDialog());
  $("#orderFile").addEventListener("change", importOrder);
  $("#mouserOrderFile").addEventListener("change", importMouserOrder);
  $("#templateFile").addEventListener("change", importTemplate);
  $("#exportTemplateBtn").addEventListener("click", exportTemplate);
  $("#importPreviewForm").addEventListener("submit", confirmImport);
  $("#closeImportPreviewBtn").addEventListener("click", cancelImportPreview);
  $("#cancelImportPreviewBtn").addEventListener("click", cancelImportPreview);
  $$('input[name="importStorageType"]').forEach((input) => {
    input.addEventListener("change", () => applyImportDefaultPackaging(input.value));
  });
  $("#importPreviewList").addEventListener("change", (event) => {
    const select = event.target.closest("[data-preview-storage]");
    if (select) {
      setPreviewRowPackaging(Number(select.dataset.previewStorage), select.value);
      return;
    }
    const splitInput = event.target.closest("[data-preview-split-qty]");
    if (splitInput) setPreviewSplitQuantity(Number(splitInput.dataset.previewSplitQty), splitInput.dataset.splitKind, splitInput.value);
  });
  $("#importPreviewList").addEventListener("input", (event) => {
    const splitInput = event.target.closest("[data-preview-split-qty]");
    if (splitInput) setPreviewSplitQuantity(Number(splitInput.dataset.previewSplitQty), splitInput.dataset.splitKind, splitInput.value);
  });
  $("#refreshDocsBtn")?.addEventListener("click", loadDocs);
  $("#resetSoftwareBtn")?.addEventListener("click", resetSoftware);
  $("#updatePricingBtn")?.addEventListener("click", updateLcscPricing);
  $$(".settings-tab").forEach((button) => {
    button.addEventListener("click", () => activateSettingsPanel(button.dataset.settingsPanel));
  });
  $("#importHistory")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-undo-import]");
    if (button) undoImport(button.dataset.undoImport);
  });
  $("#bomOrderResults")?.addEventListener("click", (event) => {
    const coveredButton = event.target.closest("[data-mark-bom-covered]");
    if (coveredButton) {
      markBomLineCovered(Number(coveredButton.dataset.markBomCovered));
      return;
    }
    const matchButton = event.target.closest("[data-open-bom-match]");
    if (matchButton) openBomMatchDialog(Number(matchButton.dataset.openBomMatch));
  });
  $("#closeBomMatchDialogBtn").addEventListener("click", () => $("#bomMatchDialog").close());
  $("#bomMatchSearchInput").addEventListener("input", renderBomMatchSearch);
  $("#bomMatchResults").addEventListener("click", (event) => {
    const result = event.target.closest("[data-select-bom-part]");
    if (result) saveBomMatch(result.dataset.selectBomPart);
  });

  ["searchInput", "categoryFilter"].forEach((id) => {
    $(`#${id}`).addEventListener("input", () => {
      if (id === "categoryFilter") state.advancedFilters = {};
      renderAdvancedFilters();
      renderParts();
    });
    $(`#${id}`).addEventListener("change", () => {
      if (id === "categoryFilter") state.advancedFilters = {};
      renderAdvancedFilters();
      renderParts();
    });
  });

  $("#advancedFilters").addEventListener("change", (event) => {
    const select = event.target.closest("[data-advanced-filter]");
    if (!select) return;
    state.advancedFilters[select.dataset.advancedFilter] = select.value;
    renderParts();
  });

  $("#partsGrid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit]");
    if (!button) return;
    const part = state.parts.find((item) => item.id === button.dataset.edit);
    if (part) openPartDialog(part);
  });
}

bindEvents();
window.addEventListener("popstate", activateRoute);
activateRoute();
loadParts().then(() => {
  loadDocs();
  loadImportHistory();
});
