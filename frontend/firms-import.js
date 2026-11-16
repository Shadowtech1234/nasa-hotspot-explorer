"use strict";

(() => {
  const maxBytes = 10 * 1024 * 1024;
  const maxPoints = 5000;
  const input = $("firms-import-file");
  const clear = $("firms-import-clear");
  const status = $("firms-import-status");
  const results = $("firms-import-results");
  const mapTarget = $("firms-import-map");
  const monthlyRows = $("firms-import-months");
  let revision = 0;
  let view;
  let pointLayer;
  let fitPoints;

  function* csvRows(text) {
    let fields = [];
    let field = "";
    let quoted = false;
    let closedQuote = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
          closedQuote = true;
        } else {
          field += char;
        }
      } else if (char === "," || char === "\r" || char === "\n") {
        fields.push(field);
        field = "";
        closedQuote = false;
        if (char !== ",") {
          if (char === "\r" && text[i + 1] === "\n") i++;
          yield fields;
          fields = [];
        }
      } else if (char === '"' && !field && !closedQuote) {
        quoted = true;
      } else if (closedQuote || char === '"') {
        throw new Error("The CSV has malformed quoted fields. Download a fresh copy and try again.");
      } else {
        field += char;
      }
    }
    if (quoted) throw new Error("The CSV ends inside a quoted field. Download a fresh copy and try again.");
    if (field || fields.length || closedQuote) yield [...fields, field];
  }

  function decimal(field) {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(field) ? Number(field) : NaN;
  }

  function isUtcDate(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const date = new Date(day);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
  }

  function analyze(text) {
    const rows = csvRows(text.replace(/^\uFEFF/, ""));
    let entry = rows.next();
    while (!entry.done && entry.value.every(field => !field.trim())) entry = rows.next();
    if (entry.done) throw new Error("This CSV is empty. Choose a FIRMS CSV with detections.");
    const header = entry.value.map(field => field.trim().toLowerCase());

    const required = ["acq_date", "latitude", "longitude"];
    const missing = required.filter(name => !header.includes(name));
    if (missing.length) throw new Error("Missing FIRMS columns: " + missing.join(", ") + ".");
    const used = [...required, "frp"];
    if (used.some(name => header.indexOf(name) !== header.lastIndexOf(name))) {
      throw new Error("A FIRMS column appears more than once. Choose a CSV with a single column for each field.");
    }
    const [dateIndex, latIndex, lonIndex, frpIndex] = used.map(name => header.indexOf(name));
    const months = new Map();
    const points = [];
    let count = 0;
    let skipped = 0;
    let first = "";
    let last = "";
    let frpCount = 0;
    let frpAverage = 0;
    let frpMax = 0;

    for (const fields of rows) {
      if (fields.length === 1 && !fields[0].trim()) continue;
      const date = fields[dateIndex]?.trim() ?? "";
      const lat = decimal(fields[latIndex]?.trim());
      const lon = decimal(fields[lonIndex]?.trim());
      if (fields.length > header.length || !isUtcDate(date) || !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
        skipped++;
        continue;
      }
      count++;
      if (!first || date < first) first = date;
      if (date > last) last = date;
      const month = date.slice(0, 7);
      months.set(month, (months.get(month) ?? 0) + 1);

      const frp = decimal(fields[frpIndex]?.trim());
      const validFrp = Number.isFinite(frp) && frp >= 0;
      if (validFrp) {
        frpCount++;
        frpAverage += (frp - frpAverage) / frpCount;
        frpMax = Math.max(frpMax, frp);
      }
      if (points.length < maxPoints) points.push({date, lat, lon, frp: validFrp ? frp : null});
    }
    return {count, skipped, first, last, months, points, frpCount, frpAverage, frpMax};
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.className = error ? "status error" : "subtle";
  }

  function refreshMap() {
    if (!view || !mapTarget.clientWidth || !mapTarget.clientHeight) return;
    view.invalidateSize({pan: false});
    if (fitPoints) {
      view.fitBounds(fitPoints, {padding: [24, 24], maxZoom: 10, animate: false});
      fitPoints = null;
    }
  }

  function renderMapPoints(points) {
    if (!view) {
      view = L.map(mapTarget, {minZoom: 0, maxZoom: 15, preferCanvas: true, scrollWheelZoom: false})
        .setView([0, 0], 1);
      view.attributionControl.setPrefix(false);
      L.imageOverlay(globalImageUrl, globalImagery.getBounds(), {
        attribution: "NASA EOSDIS GIBS", alt: "Global satellite basemap"
      }).addTo(view);
      pointLayer = L.featureGroup().addTo(view);
      new ResizeObserver(refreshMap).observe(mapTarget);
    }
    for (const {lat, lon, date, frp} of points) {
      const marker = L.circleMarker([lat, lon], {
        radius: 4, color: "#fff3dc", weight: 1, fillColor: "#f57b36", fillOpacity: .85
      }).addTo(pointLayer);
      marker.bindPopup(() => {
        const details = [date + " UTC", lat + ", " + lon];
        if (frp !== null) details.push(number.format(frp) + " MW FRP");
        return element("p", details.join(" · "));
      });
    }
    fitPoints = pointLayer.getBounds();
    refreshMap();
  }

  function render(data, filename) {
    const {count, skipped, first, last, months, points, frpCount, frpAverage, frpMax} = data;
    const totals = filename + " · " + number.format(count) + " detections · " + number.format(skipped) + " rows skipped";
    if (!count) {
      showStatus(totals + ". No valid detections. Check the dates and coordinates in the CSV.", true);
      return;
    }
    const dateRange = first === last ? first : first + " to " + last;
    showStatus(totals + " · " + dateRange + " UTC");
    $("firms-import-map-caption").textContent = points.length < count
      ? "Showing the first " + number.format(points.length) + " of " + number.format(count) + " detections."
      : number.format(count) + " detections shown.";
    $("firms-import-frp").textContent = frpCount
      ? "Fire radiative power · " + number.format(frpCount) + " readings · " +
        number.format(frpAverage) + " MW average · " + number.format(frpMax) + " MW maximum"
      : "No valid fire radiative power readings.";

    let maxCount = 0;
    for (const total of months.values()) maxCount = Math.max(maxCount, total);
    for (const [month, total] of [...months].sort(([left], [right]) => left.localeCompare(right))) {
      const row = monthlyRows.insertRow();
      const label = element("th", monthName.format(new Date(month + "-01")));
      label.scope = "row";
      row.append(label);
      const countAndBar = element("div", "", "firms-import-count");
      const bar = element("span");
      bar.style.width = (total / maxCount * 100) + "%";
      bar.setAttribute("aria-hidden", "true");
      countAndBar.append(element("span", number.format(total)), bar);
      row.insertCell().append(countAndBar);
    }
    results.hidden = false;
    renderMapPoints(points);
  }

  function resetResults() {
    results.hidden = true;
    monthlyRows.replaceChildren();
    $("firms-import-map-caption").textContent = "";
    $("firms-import-frp").textContent = "";
    pointLayer?.clearLayers();
    fitPoints = null;
  }

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const current = ++revision;
    clear.disabled = false;
    resetResults();
    if (/\.zip$/i.test(file.name)) {
      showStatus("Extract the CSV from the ZIP file, then choose the CSV.", true);
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      showStatus("Choose a FIRMS file ending in .csv.", true);
      return;
    }
    if (file.size > maxBytes) {
      showStatus("This CSV exceeds 10 MiB. Choose a smaller FIRMS download.", true);
      return;
    }
    showStatus("Reading " + file.name + "…");
    let text;
    try {
      text = new TextDecoder("utf-8", {fatal: true}).decode(await file.arrayBuffer());
    } catch {
      if (current === revision) showStatus("Could not read this file. Choose a readable UTF-8 FIRMS CSV.", true);
      return;
    }
    if (current !== revision) return;
    try {
      render(analyze(text), file.name);
    } catch (error) {
      resetResults();
      showStatus(error.message, true);
    }
  });

  clear.addEventListener("click", () => {
    revision++;
    input.value = "";
    clear.disabled = true;
    resetResults();
    showStatus("");
    input.focus();
  });
})();
