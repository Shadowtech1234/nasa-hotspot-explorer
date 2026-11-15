"use strict";

const $ = id => document.getElementById(id);
const sensors = ["MODIS", "VIIRS"];
const region = [-128, 23, -64, 51];
const colors = {MODIS: "#ffac69", VIIRS: "#68dfed"};
const number = new Intl.NumberFormat("en-US");
const heatGradient = {0.2: "#4382cf", 0.45: "#56c4cf", 0.65: "#f4cf58", 0.82: "#f48b45", 1: "#c62445"};
const monthName = new Intl.DateTimeFormat("en-US", {month: "long", year: "numeric", timeZone: "UTC"});
const pageSize = 20;
const state = {result: null, sensor: "both", selected: "", page: 0, tab: "map", points: []};
let catalog;
let catalogRequest;
let selectionRequest;
let selectionTimer;
let selection;
let fixedBounds;
let appliedRange;
let overview;
let overviewRequest;
let overviewZoom;
let drawing = false;
let dragStart;
let dragBox;
let dragPointer;
let mapDragging;
let basemapError = false;
let visible = [];

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const map = L.map("map", {
  fadeAnimation: !reducedMotion, zoomAnimation: !reducedMotion, markerZoomAnimation: !reducedMotion,
  minZoom: 2, maxZoom: 15, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1,
  scrollWheelZoom: false, preferCanvas: true
});
map.attributionControl.setPrefix(false);
map.createPane("basemap").style.zIndex = "220";
map.createPane("global-imagery").style.zIndex = "225";
map.createPane("imagery").style.zIndex = "230";
map.createPane("overview-heat").style.zIndex = "250";
L.control.scale({imperial: false, maxWidth: 88}).addTo(map);
const boundary = L.rectangle(asLeafletBounds(region), {
  color: "#a3c2d5", opacity: 0.8, weight: 1, dashArray: "5 5", fill: false, interactive: false
}).addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const overviewLayer = L.heatLayer([], {
  pane: "overview-heat", gradient: heatGradient, max: 1, maxZoom: map.getMinZoom(), minOpacity: 0.08
});
const focusLayer = L.layerGroup().addTo(map);
map.setView([35, -115], 2);
const scene = {
  date: "Nov 10, 2026 UTC",
  projectedBounds: [-14248894, 2632019, -7124447, 6621294],
  image: "assets/viirs-noaa20-2026-11-10.jpg"
};
const [west, south, east, north] = scene.projectedBounds;
const projection = L.CRS.EPSG3857.projection;
const sceneBounds = L.latLngBounds(
  projection.unproject(L.point(west, south)),
  projection.unproject(L.point(east, north))
);
const satellite = L.imageOverlay(scene.image, sceneBounds, {
  pane: "imagery", attribution: "NASA EOSDIS GIBS",
  alt: "True-color NOAA-20 VIIRS image of the contiguous United States on November 10, 2026"
});
const globalImageUrl = "assets/viirs-world-2026-11-10.jpg";
const globalImagery = L.imageOverlay(globalImageUrl,
  [[-85.05112878, -180], [85.05112878, 180]], {
    pane: "global-imagery", attribution: "NASA EOSDIS GIBS",
    alt: "Global satellite mosaic with November 10, 2026 VIIRS imagery"
  });
const imageryLayers = [globalImagery, satellite];
const imageryStatus = new Map();
for (const layer of imageryLayers) {
  imageryStatus.set(layer, "loading");
  layer.on("load", () => {
    imageryStatus.set(layer, "ready");
    mapHelp();
  });
  layer.on("error", () => {
    imageryStatus.set(layer, "failed");
    layer.remove();
    mapHelp();
  });
}

function setBasemap(choice) {
  $("basemap").value = choice;
  for (const layer of imageryLayers) {
    if (choice === "simple") layer.remove();
    else {
      if (imageryStatus.get(layer) === "failed") {
        imageryStatus.set(layer, "loading");
        layer.setUrl(layer === satellite ? scene.image : globalImageUrl);
      }
      layer.addTo(map);
    }
  }
  mapHelp();
}

function mapHelp() {
  let imagery = "";
  if ($("basemap").value === "satellite") {
    if (imageryStatus.get(globalImagery) === "ready") {
      imagery = "VIIRS · " + scene.date + " · Blue Marble fills gaps";
    } else if (imageryStatus.get(satellite) === "ready" && map.getBounds().overlaps(sceneBounds)) {
      imagery = "VIIRS · " + scene.date + " · U.S. detail";
    } else if (imageryLayers.some(layer => imageryStatus.get(layer) === "loading")) {
      imagery = "Loading satellite imagery…";
    } else {
      imagery = "Satellite imagery unavailable here · Simple basemap";
    }
  } else if (basemapError) {
    imagery = "Simple basemap unavailable";
  }
  const action = drawing ? "Drag corners to select an area. Esc cancels."
    : map.scrollWheelZoom.enabled()
    ? "Scroll to zoom. Esc releases scrolling."
    : matchMedia("(pointer: coarse)").matches ? "Drag to pan. Pinch to zoom."
      : "Click or focus the map to scroll to zoom.";
  $("map-help").textContent = [imagery, action].filter(Boolean).join(" · ");
}

function asLeafletBounds(bounds) {
  return [[bounds[1], bounds[0]], [bounds[3], bounds[2]]];
}

function activeBounds() {
  return selection?.bbox ?? fixedBounds ?? catalog?.initial_bbox ?? region;
}

function fitArea() {
  map.fitBounds(asLeafletBounds(fixedBounds ?? catalog.initial_bbox), {
    padding: [22, 22], maxZoom: 10, animate: false
  });
}

function element(tag, text = "", className = "") {
  const result = document.createElement(tag);
  result.textContent = text;
  if (className) result.className = className;
  return result;
}

function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}

function sourceLabel() {
  if (!catalog) return "Published data unavailable";
  const labels = {MODIS_SP: "MODIS", VIIRS_SNPP_SP: "Suomi-NPP VIIRS"};
  const sources = Object.values(catalog.sources).map(product => labels[product] || product);
  return "NASA FIRMS · " + sources.join(" + ");
}

function shiftDay(day, offset) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function dateRange() {
  const start = $("date-start").value;
  const last = $("date-end").value;
  if (!start || !last || start > last) {
    status("Choose a start date on or before the end date.", true);
    return null;
  }
  return {start, end_exclusive: shiftDay(last, 1)};
}

async function loadCatalog() {
  catalogRequest?.abort();
  cancelSelection();
  const request = new AbortController();
  catalogRequest = request;
  $("retry-data").disabled = true;
  status("Loading the published dataset…");
  try {
    const index = await staticData.index(request.signal);
    request.signal.throwIfAborted();
    const firstLoad = !catalog;
    const releaseChanged = catalog?.version !== index.version;
    catalog = index;
    if (releaseChanged) {
      overviewRequest?.abort();
      overviewRequest = undefined;
      overview = undefined;
    }
    const last = shiftDay(catalog.end_exclusive, -1);
    $("published-dates").textContent =
      "Published dates (UTC) " + catalog.start + " through " + last + " · coverage varies by area and sensor";
    if (firstLoad) {
      // Start with at most the last month of the published dates.
      $("date-start").value = [catalog.start, shiftDay(last, -30)].sort()[1];
      $("date-end").value = last;
      appliedRange = dateRange();
    }
    refreshSelection({force: true});
  } catch (error) {
    if (!request.signal.aborted) status("Could not load the published dataset. " + error.message, true);
  } finally {
    if (!request.signal.aborted) $("retry-data").disabled = false;
  }
}

function cancelSelection() {
  clearTimeout(selectionTimer);
  selectionRequest?.abort();
}

function refreshSelection({force = false, delay = 0} = {}) {
  if (!catalog || !appliedRange) return;
  if (showingOverview()) {
    if (selection || force) {
      cancelSelection();
      setDrawing(false);
      selection = undefined;
      state.result = null;
      state.points = [];
      status("Zoom in to see individual detections and daily counts.");
      render();
    } else if (overview && overviewZoom !== map.getZoom()) {
      renderMap(visible);
    }
    updateOverview();
    return;
  }

  const bbox = fixedBounds ?? boundsFromLeaflet(map.getBounds());
  const next = {bbox, area: fixedBounds ? "Drawn area" : "Map view", ...appliedRange};
  if (!force && JSON.stringify(next) === JSON.stringify(selection)) return;
  cancelSelection();
  const request = new AbortController();
  selectionRequest = request;
  selection = next;
  state.result = null;
  state.points = [];
  state.page = 0;
  status("Loading detections for the selected area and dates…");
  render();
  selectionTimer = setTimeout(() => loadSelection(next, request), delay);
}

async function loadSelection(query, request) {
  try {
    const {rows, unavailable_packets: missing} = await staticData.analyze(
      catalog, query, request.signal,
      () => status("Analyzing detections in your browser…"));
    request.signal.throwIfAborted();
    const days = new Map(rows.map(row => [row.date_utc, row.sensor_detections]));
    const pointsByDay = new Map(rows.map(row => [row.date_utc, row.points]));
    const partialByDay = new Map(rows.map(row => [row.date_utc, row.partial_sensors]));
    state.result = {days, pointsByDay, partialByDay, missing};
    selectDay(days.has(state.selected) ? state.selected : rows[0].date_utc);
  } catch (error) {
    if (!request.signal.aborted) status("Could not analyze the selection. " + error.message, true);
  }
}

function selectDay(day) {
  if (!state.result?.days.has(day)) return;
  state.selected = day;
  state.page = 0;
  state.points = state.result.pointsByDay.get(day);
  const counts = state.result.days.get(day);
  const unavailable = selectedSensors().filter(sensor => counts[sensor] === null);
  const message = [sourceLabel()];
  if (state.result.missing) message.push("Some FIRMS packets could not be loaded. Reload data to retry.");
  if (unavailable.length) {
    message.push("Published input unavailable for " + unavailable.join(" and ") + " on " + day + ".");
  }
  const partial = selectedSensors().filter(sensor => state.result.partialByDay.get(day).includes(sensor));
  if (partial.length) message.push("Partial coverage for " + partial.join(" and ") + " on " + day + ".");
  status(message.join(" · "), Boolean(state.result.missing));
  render();
}

function showingOverview() {
  return map.getZoom() <= 4;
}

async function updateOverview() {
  if (!catalog || !showingOverview() || overview || overviewRequest) return;
  const request = new AbortController();
  overviewRequest = request;
  try {
    const summary = await staticData.overview(catalog, request.signal);
    request.signal.throwIfAborted();
    overview = {...summary, heatPoints: buildHeatPoints(summary.cells)};
  } catch {
    if (!request.signal.aborted) overview = {unavailable: true};
  } finally {
    if (!request.signal.aborted) {
      overviewRequest = undefined;
      if (state.tab === "map") renderMap(visible);
    }
  }
}

function buildHeatPoints(cells) {
  const combined = new Map();
  for (const {bbox, center, count} of cells) {
    const key = bbox.join(",");
    if (!combined.has(key)) combined.set(key, {count: 0, latSum: 0, lonSum: 0});
    const total = combined.get(key);
    total.count += count;
    total.latSum += center[1] * count;
    total.lonSum += center[0] * count;
  }
  let maxCount = 1;
  for (const {count} of combined.values()) maxCount = Math.max(maxCount, count);
  // Use the same release-wide scale for all sensor choices and viewports.
  const weight = count => Math.log1p(count) / Math.log1p(maxCount);
  const result = {MODIS: [], VIIRS: [], both: []};
  for (const {sensor, center, count} of cells) {
    result[sensor].push([center[1], center[0], weight(count)]);
  }
  for (const {count, latSum, lonSum} of combined.values()) {
    result.both.push([latSum / count, lonSum / count, weight(count)]);
  }
  return result;
}

function renderOverview() {
  overviewZoom = map.getZoom();
  const points = overview?.heatPoints?.[state.sensor];
  if (!points?.length) overviewLayer.remove();
  if (!catalog) return "Published data unavailable";
  if (!overview) return "Loading the heat map…";
  if (overview.unavailable) return "Heat map unavailable. Reload data to retry.";

  const dates = overview.start + " through " + shiftDay(overview.end_exclusive, -1) + " UTC";
  if (!points.length) return "No published detections for this sensor · " + dates;

  const spread = overviewZoom - map.getMinZoom();
  overviewLayer.setOptions({radius: 5 + 2 * spread, blur: 4 + spread});
  overviewLayer.setLatLngs(points);
  if (!map.hasLayer(overviewLayer)) overviewLayer.addTo(map);
  return "All published dates · " + dates + " · Zoom in to use your selected dates";
}

function boundsFromLeaflet(box) {
  return [Math.max(-180, box.getWest()), Math.max(-85, box.getSouth()),
    Math.min(180, box.getEast()), Math.min(85, box.getNorth())];
}

function setDrawing(active) {
  if (drawing === active) return;
  drawing = active;
  $("draw-area").setAttribute("aria-pressed", String(active));
  $("map").classList.toggle("drawing-box", active);
  if (active) {
    mapDragging = map.dragging.enabled();
    map.dragging.disable();
    $("map").focus({preventScroll: true});
  } else {
    if (mapDragging) map.dragging.enable();
    if (dragPointer !== undefined && $("map").hasPointerCapture(dragPointer)) {
      $("map").releasePointerCapture(dragPointer);
    }
    dragBox?.remove();
    dragBox = undefined;
    dragStart = undefined;
    dragPointer = undefined;
  }
  mapHelp();
}

function startBox(event) {
  if (!drawing || !event.isPrimary || event.button !== 0
      || event.target.closest(".leaflet-control")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  dragStart = map.mouseEventToContainerPoint(event);
  dragPointer = event.pointerId;
  $("map").setPointerCapture(dragPointer);
  const origin = map.containerPointToLatLng(dragStart);
  dragBox = L.rectangle([origin, origin], {color: "#fff", weight: 2, interactive: false}).addTo(map);
}

function moveBox(event) {
  if (event.pointerId !== dragPointer) return;
  const corner = map.mouseEventToLatLng(event);
  dragBox.setBounds([map.containerPointToLatLng(dragStart), corner]);
}

function finishBox(event) {
  if (event.pointerId !== dragPointer) return;
  const corner = map.mouseEventToContainerPoint(event);
  const largeEnough = Math.abs(corner.x - dragStart.x) >= 8 && Math.abs(corner.y - dragStart.y) >= 8;
  const box = L.latLngBounds(map.containerPointToLatLng(dragStart), map.containerPointToLatLng(corner));
  setDrawing(false);
  const bbox = boundsFromLeaflet(box);
  if (!largeEnough || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    status("Draw a larger box to select an area.", true);
    return;
  }
  fixedBounds = bbox;
  refreshSelection();
}

function fetchLocal(path) {
  return fetch(path).then(response => {
    if (!response.ok) throw new Error(path + " could not be loaded.");
    return response;
  });
}

fetchLocal("assets/countries.geojson").then(response => response.json()).then(geojson => {
  L.geoJSON(geojson, {
    pane: "basemap", interactive: false, attribution: "Made with Natural Earth",
    style: {color: "#556c76", weight: 0.65, fillColor: "#263842", fillOpacity: 1}
  }).addTo(map);
}).catch(() => {
  basemapError = true;
  render();
});

function selectedSensors() {
  return state.sensor === "both" ? sensors : [state.sensor];
}

function analysisDay(date) {
  const counts = state.result.days.get(date);
  const partial = state.result.partialByDay.get(date);
  return {date, counts: selectedSensors().map(sensor => (
    {sensor, count: counts[sensor], partial: partial.includes(sensor)}
  ))};
}

function calendarCell({date, counts}) {
  const cell = element("button", "", "day");
  cell.type = "button";
  cell.classList.toggle("has-activity", counts.some(({count}) => count > 0));
  cell.dataset.date = date;
  cell.setAttribute("aria-pressed", String(date === state.selected));
  const description = counts.map(({sensor, count, partial}) =>
    sensor + ": " + (count === null ? "source unavailable" : number.format(count) + " detections")
      + (partial ? ", partial coverage" : ""));
  cell.setAttribute("aria-label", date + " UTC. " + description.join(". "));
  cell.title = description.join(" · ");
  cell.append(element("strong", String(Number(date.slice(8)))));
  for (const {sensor, count, partial} of counts) {
    const prefix = counts.length > 1 ? sensor[0] + " " : "";
    const label = count === null ? "?" : number.format(count) + (partial ? "*" : "");
    cell.append(element("span", prefix + label, count === null ? "unknown" : sensor.toLowerCase()));
  }
  return cell;
}

function renderCalendar(days) {
  const calendar = $("calendar");
  const scroll = calendar.scrollTop;
  const content = document.createDocumentFragment();
  let grid;
  let month;
  for (const day of days) {
    const prefix = day.date.slice(0, 7);
    if (prefix !== month) {
      month = prefix;
      const section = element("section", "", "month");
      section.append(element("h3", monthName.format(new Date(day.date))));
      grid = element("div", "", "week");
      for (const weekday of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
        grid.append(element("span", weekday, "weekday"));
      }
      const offset = (new Date(day.date).getUTCDay() + 6) % 7;
      for (let column = 0; column < offset; column++) grid.append(element("span"));
      section.append(grid);
      content.append(section);
    }
    grid.append(calendarCell(day));
  }
  if (!days.length) content.append(element("p", "Zoom in to see daily detection counts for an area.", "subtle"));
  calendar.replaceChildren(content);
  calendar.scrollTop = scroll;
}

function popupFor(point) {
  const popup = element("div");
  popup.append(element("strong", point.sensor), element("div",
    point.date + (point.time ? " " + point.time : "") + " UTC"),
  element("div", point.lat.toFixed(4) + ", " + point.lon.toFixed(4)));
  if (point.satellite) popup.append(element("div", "Satellite: " + point.satellite));
  if (point.confidence) popup.append(element("div", "Confidence: " + point.confidence));
  if (point.frp != null) popup.append(element("div", "Fire radiative power: " + point.frp + " MW"));
  return popup;
}

function mapPoint(point, focus = false) {
  return L.circleMarker([point.lat, point.lon], {
    radius: focus ? 8 : 3,
    color: focus ? "#ffffff" : colors[point.sensor],
    fillColor: colors[point.sensor], fillOpacity: 0.76,
    weight: focus ? 2 : 0
  }).bindPopup(() => popupFor(point), {autoPan: false});
}

function renderMap(points) {
  pointLayer.clearLayers();
  focusLayer.clearLayers();
  const wide = showingOverview();
  if (fixedBounds) boundary.setBounds(asLeafletBounds(fixedBounds));
  boundary.setStyle({opacity: fixedBounds && !wide ? 0.85 : 0});
  if (wide) $("map-scope").textContent = renderOverview();
  else {
    overviewLayer.remove();
    $("map-scope").textContent = $("list-summary").textContent;
    for (const point of points) mapPoint(point).addTo(pointLayer);
  }
  const legend = $("legend");
  legend.replaceChildren();
  if (wide) {
    if (map.hasLayer(overviewLayer)) {
      const ramp = element("span", "", "heat-legend-ramp");
      ramp.setAttribute("aria-hidden", "true");
      const stops = Object.entries(heatGradient).sort(([a], [b]) => Number(a) - Number(b))
        .map(([stop, color]) => color + " " + Number(stop) * 100 + "%");
      ramp.style.background = "linear-gradient(to right, " + stops.join(", ") + ")";
      legend.append(element("strong", "Detection concentration"), element("span", "Low"),
        ramp, element("span", "High"), element("span", selectedSensors().join(" + ")));
    }
    return;
  }
  for (const sensor of selectedSensors()) {
    const label = element("span", "", sensor.toLowerCase());
    const dot = element("i", "", "dot");
    dot.setAttribute("aria-hidden", "true");
    label.append(dot, document.createTextNode(sensor));
    legend.append(label);
  }
}

function renderDetails() {
  const target = $("details");
  const pages = Math.ceil(visible.length / pageSize);
  $("previous").disabled = state.page === 0;
  $("next").disabled = state.page + 1 >= pages;
  $("page").textContent = pages ? "Page " + (state.page + 1) + " of " + number.format(pages) : "";
  if (!pages) {
    target.replaceChildren(element("p", state.result
      ? "No detections to display for this selection." : "Select an area and dates to see individual detections."));
    return;
  }
  const table = element("table");
  const header = table.createTHead().insertRow();
  for (const title of ["Date (UTC)", "Sensor", "Latitude", "Longitude", "Map"]) {
    const cell = element("th", title);
    cell.scope = "col";
    header.append(cell);
  }
  const body = table.createTBody();
  const first = state.page * pageSize;
  for (const point of visible.slice(first, first + pageSize)) {
    const row = body.insertRow();
    for (const value of [point.date + (point.time ? " " + point.time : ""), point.sensor,
      point.lat.toFixed(4), point.lon.toFixed(4)]) row.insertCell().textContent = value;
    const button = element("button", "Locate");
    button.type = "button";
    button.setAttribute("aria-label", "Locate " + point.sensor + " point at " +
      point.lat.toFixed(4) + ", " + point.lon.toFixed(4));
    button.addEventListener("click", () => {
      showTab("map");
      map.panInside([point.lat, point.lon], {padding: [22, 22], animate: false});
      focusLayer.clearLayers();
      mapPoint(point, true).addTo(focusLayer).openPopup();
      $("map").focus({preventScroll: true});
      $("map").scrollIntoView({block: "nearest"});
    });
    row.insertCell().append(button);
  }
  target.replaceChildren(table);
}

function render() {
  const days = state.result ? [...state.result.days.keys()].sort().map(analysisDay) : [];
  const sensorsShown = selectedSensors();
  visible = state.points.filter(point => sensorsShown.includes(point.sensor));
  state.page = Math.min(state.page, Math.max(0, Math.ceil(visible.length / pageSize) - 1));
  const bounds = activeBounds().map(value => value.toFixed(2)).join(", ");
  $("area-name").textContent = showingOverview() ? "Regional overview" : selection?.area ?? "Map view";
  $("area-name").title = selection ? "W, S, E, N: " + bounds : "";
  $("fit-area").disabled = !catalog;
  $("fit-area").textContent = fixedBounds ? "Fit box" : "Zoom to data";
  $("draw-area").hidden = showingOverview();
  $("draw-area").disabled = !catalog;
  $("clear-box").hidden = !fixedBounds;
  $("apply-dates").disabled = !catalog;
  const selected = state.result && analysisDay(state.selected);
  const counts = selected?.counts.map(({sensor, count, partial}) =>
    sensor + " " + (count === null ? "unavailable" : number.format(count))
      + (partial ? " (partial)" : "")).join(" · ");
  const scope = selected ? state.selected + " UTC · " + counts : "No detections loaded for this area and date range";
  $("map-scope").textContent = scope;
  $("list-summary").textContent = scope;
  mapHelp();
  $("provenance").textContent = sourceLabel();
  $("coverage").textContent = selection
    ? "Selected bounds (west, south, east, north) " + bounds + ". Satellite observation coverage is unknown."
    : "";
  $("download-csv").disabled = !visible.length;
  for (const button of document.querySelectorAll("[data-sensor]")) {
    button.setAttribute("aria-pressed", String(state.sensor === button.dataset.sensor));
  }
  renderCalendar(days);
  if (state.tab === "map") renderMap(visible);
  renderDetails();
  if (state.tab === "compare") window.dispatchEvent(new Event("hotspot:compare"));
}

function csvCell(value) {
  if (value == null) return "";
  let text = String(value);
  // Source fields can contain spreadsheet formulas. Keep those fields literal.
  if (typeof value === "string" && /^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function exportCsv() {
  const rows = [
    ["date_utc", "time_utc", "sensor", "satellite", "latitude", "longitude", "confidence", "frp_mw"],
    ...visible.map(point => [point.date, point.time, point.sensor, point.satellite, point.lat, point.lon,
      point.confidence, point.frp])
  ];
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

$("download-csv").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([exportCsv()], {type: "text/csv;charset=utf-8"}));
  const link = element("a");
  link.href = url;
  link.download = "detections.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("retry-data").addEventListener("click", () => {
  if (overview?.unavailable) overview = undefined;
  loadCatalog();
});
$("date-range").addEventListener("submit", event => {
  event.preventDefault();
  const range = dateRange();
  if (!range) return;
  appliedRange = range;
  refreshSelection();
  if (showingOverview()) status("Dates applied. Zoom in for daily counts in this range.");
});
$("draw-area").addEventListener("click", () => setDrawing(!drawing));
$("clear-box").addEventListener("click", () => {
  setDrawing(false);
  fixedBounds = undefined;
  if (showingOverview()) render();
  else refreshSelection();
  $(showingOverview() ? "fit-area" : "draw-area").focus();
});
$("map").addEventListener("pointerdown", startBox, true);
$("map").addEventListener("pointermove", moveBox);
$("map").addEventListener("pointerup", finishBox);
$("map").addEventListener("pointercancel", () => setDrawing(false));
$("fit-area").addEventListener("click", fitArea);
for (const button of document.querySelectorAll("[data-sensor]")) {
  button.addEventListener("click", () => {
    state.sensor = button.dataset.sensor;
    if (state.result) selectDay(state.selected);
    else render();
  });
}
$("calendar").addEventListener("click", event => {
  const date = event.target.closest("button[data-date]")?.dataset.date;
  if (!date) return;
  selectDay(date);
  $("calendar").querySelector('[data-date="' + date + '"]')?.focus({preventScroll: true});
});
$("previous").addEventListener("click", () => { state.page--; renderDetails(); });
$("next").addEventListener("click", () => { state.page++; renderDetails(); });

const tabs = ["map", "compare", "detections"];

function showTab(tab, focusTab = false) {
  if (tab !== "map") setDrawing(false);
  if (tab !== state.tab) {
    state.tab = tab;
    for (const id of tabs) {
      const active = id === tab;
      $(id + "-tab").setAttribute("aria-selected", String(active));
      $(id + "-tab").tabIndex = active ? 0 : -1;
      $(id + "-panel").hidden = !active;
    }
    $("explorer-filters").hidden = tab === "compare";
    if (tab === "map") {
      map.invalidateSize({pan: true});
      refreshSelection();
      renderMap(visible);
    } else {
      setWheel(false);
    }
  }
  if (tab === "compare") window.dispatchEvent(new Event("hotspot:compare"));
  if (focusTab) $(tab + "-tab").focus();
}

function resizeMap() {
  if (state.tab !== "map") return;
  map.invalidateSize({pan: true});
}

function setWheel(active) {
  if (active) map.scrollWheelZoom.enable();
  else map.scrollWheelZoom.disable();
  mapHelp();
}

for (const [index, tab] of tabs.entries()) {
  const button = $(tab + "-tab");
  button.addEventListener("click", () => showTab(tab));
  button.addEventListener("keydown", event => {
    const target = {ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1};
    if (!Object.hasOwn(target, event.key)) return;
    event.preventDefault();
    showTab(tabs[target[event.key]], true);
  });
}
$("basemap").addEventListener("change", event => setBasemap(event.target.value));
$("resize-map").addEventListener("click", event => {
  const large = $("map").classList.toggle("is-larger");
  event.currentTarget.setAttribute("aria-pressed", String(large));
  event.currentTarget.textContent = large ? "Standard size" : "Larger map";
  resizeMap();
});
$("map").addEventListener("focusin", () => setWheel(true));
$("map").addEventListener("focusout", event => {
  if (!$("map").contains(event.relatedTarget)) setWheel(false);
});
$("map").addEventListener("pointerdown", () => setWheel(true));
document.addEventListener("pointerdown", event => {
  if (!$("map").contains(event.target)) setWheel(false);
});
$("map").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    setDrawing(false);
    setWheel(false);
  }
});
map.on("moveend", () => {
  mapHelp();
  if (state.tab === "map") refreshSelection({delay: 150});
});
new ResizeObserver(resizeMap).observe($("map"));

setBasemap("satellite");
render();
loadCatalog();
