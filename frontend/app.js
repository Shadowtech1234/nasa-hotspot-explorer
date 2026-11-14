"use strict";

const $ = id => document.getElementById(id);
const data = HotspotData;
const region = [-128, 23, -64, 51];
const colors = {MODIS: "#ffac69", VIIRS: "#68dfed", Harmonized: "#c4b1ff"};
const number = new Intl.NumberFormat("en-US");
const monthName = new Intl.DateTimeFormat("en-US", {month: "long", year: "numeric", timeZone: "UTC"});
const pageSize = 20;
const state = {
  raw: new Map(), team: null, mode: "raw", sensor: "both", bounds: region, area: "Contiguous U.S. view",
  rawSource: "", selected: "", page: 0, snapshot: null
};
let revision = 0;
let basemapError = false;
let visible = [];

const map = L.map("map", {
  minZoom: 2, maxZoom: 15, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1,
  scrollWheelZoom: false, preferCanvas: true
});
map.attributionControl.setPrefix(false);
map.createPane("basemap").style.zIndex = "230";
L.control.scale({imperial: false}).addTo(map);
const boundary = L.rectangle(asLeafletBounds(region), {
  color: "#a3c2d5", opacity: 0.8, weight: 1, dashArray: "5 5", fill: false, interactive: false
}).addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const focusLayer = L.layerGroup().addTo(map);
fitArea();

function asLeafletBounds(bounds) {
  return [[bounds[1], bounds[0]], [bounds[3], bounds[2]]];
}

function activeBounds() {
  return state.mode === "raw" ? state.bounds : state.team.bounds;
}

function fitArea() {
  map.fitBounds(asLeafletBounds(activeBounds()), {padding: [22, 22], maxZoom: 10, animate: false});
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
  return state.mode === "raw" ? state.rawSource : state.team.source + " · Method: " + state.team.method;
}

function resetDates(keys) {
  const days = Array.from(keys).sort();
  const end = days.at(-1) || "";
  const monthStart = end ? end.slice(0, 7) + "-01" : "";
  const start = days[0] < monthStart && data.listDates(days[0], end).length > 31
    ? monthStart : days[0] || "";
  $("start").value = start;
  $("end").value = end;
  state.selected = "";
  state.page = 0;
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

async function restoreSnapshot() {
  const attempt = ++revision;
  status("Loading FIRMS snapshots…");
  try {
    state.snapshot ??= Promise.allSettled(data.sensors.map(async sensor => {
      const response = await fetchLocal("assets/" + sensor.toLowerCase() + ".csv");
      return data.parseFirms(await response.text(), sensor);
    }));
    const results = await state.snapshot;
    if (attempt !== revision) return;
    const points = [];
    const available = [];
    let skipped = 0;
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue;
      for (const point of result.value.points) points.push(point);
      available.push(data.sensors[index]);
      skipped += result.value.skipped;
    }
    if (!available.length) {
      state.snapshot = null;
      throw new Error("The bundled snapshots could not load. Open a FIRMS CSV to explore detections.");
    }
    if (available.length < data.sensors.length) state.snapshot = null;
    state.raw = data.indexRaw(points);
    state.rawSource = "NASA FIRMS · " + available.join(" + ") +
      " · U.S. and Hawaii NRT snapshot downloaded Nov 14, 2026 (UTC)";
    state.sensor = "both";
    state.bounds = region;
    state.area = "Contiguous U.S. view";
    setMode("raw");
    const warning = available.length < data.sensors.length ? " · One sensor snapshot could not load" : "";
    status($("provenance").textContent + warning + skippedLabel(skipped), Boolean(warning));
  } catch (error) {
    if (attempt !== revision) return;
    status(error.message, true);
    render();
  }
}

function skippedLabel(skipped) {
  return skipped ? " · " + number.format(skipped) + " unusable rows skipped" : "";
}

function setMode(mode) {
  state.mode = mode;
  $("mode").value = mode;
  resetDates((mode === "raw" ? state.raw : state.team.days).keys());
  render();
  fitArea();
}

async function importFiles(files) {
  if (!files.length) return;
  const attempt = ++revision;
  status("Reading selected files…");
  try {
    if (files.some(file => file.size > 20 * 1024 * 1024)) {
      throw new Error("Each file must be under 20 MB. Export a smaller date range or area.");
    }
    if (files.length === 1 && /\.json$/i.test(files[0].name)) {
      const team = data.parseTeam(await files[0].text());
      if (attempt !== revision) return;
      state.team = team;
      $("team-option").disabled = false;
      setMode("harmonized");
      status("Loaded team export · " + files[0].name);
      return;
    }
    if (files.length > 8 || !files.every(file => /\.csv$/i.test(file.name))) {
      throw new Error("Choose up to eight FIRMS CSV files or one team JSON file.");
    }
    const points = [];
    let skipped = 0;
    for (const file of files) {
      const parsed = data.parseFirms(await file.text());
      for (const point of parsed.points) points.push(point);
      skipped += parsed.skipped;
    }
    if (attempt !== revision) return;
    if (!points.length) throw new Error("The CSV files have no detection rows.");
    state.raw = data.indexRaw(points);
    state.rawSource = "Imported FIRMS CSV · " + files.map(file => file.name).join(", ");
    state.bounds = data.extent;
    state.area = "All imported areas";
    state.sensor = "both";
    setMode("raw");
    status($("provenance").textContent + skippedLabel(skipped));
  } catch (error) {
    if (attempt === revision) status("Could not import data. " + error.message, true);
  }
}

function selectedSensors() {
  return state.sensor === "both" ? data.sensors : [state.sensor];
}

function rawDay(date) {
  const records = state.raw.get(date);
  const points = [];
  const counts = selectedSensors().map(sensor => {
    if (!records?.[sensor].length) return {sensor, count: null};
    const inArea = records[sensor].filter(point => data.contains(state.bounds, point));
    for (const point of inArea) points.push(point);
    return {sensor, count: inArea.length};
  });
  return {date, counts, points};
}

function teamDay(date) {
  const day = state.team.days.get(date);
  return {date, counts: [{sensor: "Harmonized", count: day?.count ?? null}], points: day?.points ?? []};
}

function calendarCell({date, counts}) {
  const cell = element("button", "", "day");
  cell.type = "button";
  cell.dataset.date = date;
  cell.setAttribute("aria-pressed", String(date === state.selected));
  const description = counts.map(({sensor, count}) =>
    sensor + ": " + (count === null ? "coverage unknown" : count === 0 ? "no records" : number.format(count)));
  cell.setAttribute("aria-label", date + " UTC. " + description.join(". "));
  cell.title = description.join(" · ");
  cell.append(element("strong", String(Number(date.slice(8)))));
  for (const {sensor, count} of counts) {
    const prefix = counts.length > 1 ? sensor[0] + " " : "";
    const label = count === null ? "?" : number.format(count);
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
  if (!days.length) content.append(element("p", "Choose a valid range of up to 366 days.", "subtle"));
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
  }).bindPopup(() => popupFor(point));
}

function renderMap(points) {
  pointLayer.clearLayers();
  focusLayer.clearLayers();
  boundary.setBounds(asLeafletBounds(activeBounds()));
  for (const point of points) mapPoint(point).addTo(pointLayer);
  const legend = $("legend");
  legend.replaceChildren();
  const sensors = state.mode === "raw" ? selectedSensors() : ["Harmonized"];
  for (const sensor of sensors) {
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
    target.replaceChildren(element("p", state.mode === "raw"
      ? "No detections match the current filters."
      : "The team export has no map points for this selection. See the calendar for the reported counts."));
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
      map.setView([point.lat, point.lon], Math.max(7, map.getZoom()), {animate: false});
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
  const dates = data.listDates($("start").value, $("end").value);
  const valid = dates.length > 0 && dates.length <= 366;
  const raw = state.mode === "raw";
  const days = valid ? dates.map(raw ? rawDay : teamDay) : [];
  if (!days.some(day => day.date === state.selected)) state.selected = "";
  visible = days.filter(day => !state.selected || day.date === state.selected).flatMap(day => day.points);
  state.page = Math.min(state.page, Math.max(0, Math.ceil(visible.length / pageSize) - 1));
  const bounds = activeBounds().map(value => value.toFixed(2)).join(", ");
  $("area-name").textContent = raw ? state.area : state.team.area;
  $("area-name").title = "W, S, E, N: " + bounds;
  $("sensor-control").hidden = !raw;
  $("edit-area").disabled = !raw;
  $("use-view").disabled = !raw;
  $("clear-day").hidden = !state.selected;
  $("detail-title").textContent = raw ? "Detections" : "Harmonized map points";
  $("calendar-summary").textContent = valid ? (raw
    ? "Raw detections per day · 0 no records · ? coverage unknown"
    : "Team counts per day · ? coverage unknown · Area fixed by export")
    : "Select up to 366 consecutive UTC dates.";
  const pointCount = number.format(visible.length) + (raw ? " raw detections" : " exported points");
  $("list-summary").textContent = pointCount;
  $("map-scope").textContent = (state.selected ? state.selected + " UTC · " : "") + pointCount +
    (basemapError ? " · Basemap unavailable" : "");
  const records = Array.from((raw ? state.raw : state.team.days).keys()).sort();
  const datesText = records.length ? " · Record dates (UTC) " + records[0] + " to " + records.at(-1) : "";
  $("provenance").textContent = (sourceLabel() || "No dataset loaded") + datesText;
  for (const button of document.querySelectorAll("[data-sensor]")) {
    button.setAttribute("aria-pressed", String(state.sensor === button.dataset.sensor));
  }
  renderCalendar(days);
  renderMap(visible);
  renderDetails();
}

function applyArea(bounds, name, fit) {
  state.bounds = bounds;
  state.area = name;
  state.page = 0;
  render();
  if (fit) fitArea();
}

$("mode").addEventListener("change", event => {
  setMode(event.target.value);
  status($("provenance").textContent);
});
$("upload").addEventListener("change", event => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  importFiles(files);
});
$("restore").addEventListener("click", restoreSnapshot);
$("fit-area").addEventListener("click", fitArea);
$("use-view").addEventListener("click", () => {
  const bounds = map.getBounds();
  const next = [Math.max(-180, bounds.getWest()), Math.max(-85, bounds.getSouth()),
    Math.min(180, bounds.getEast()), Math.min(85, bounds.getNorth())];
  if (data.validBounds(next)) applyArea(next, "Selected map view", false);
});
$("edit-area").addEventListener("click", () => {
  const fields = $("bounds-form").elements;
  ["west", "south", "east", "north"].forEach((name, index) => {
    fields[name].value = state.bounds[index];
  });
  $("bounds-error").textContent = "";
  $("bounds-dialog").showModal();
});
$("cancel-bounds").addEventListener("click", () => $("bounds-dialog").close());
$("bounds-form").addEventListener("submit", event => {
  event.preventDefault();
  const bounds = ["west", "south", "east", "north"].map(name => event.target.elements[name].valueAsNumber);
  if (!data.validBounds(bounds)) {
    $("bounds-error").textContent = "West must be less than east, and south less than north.";
    return;
  }
  $("bounds-dialog").close();
  applyArea(bounds, "Custom bounds", true);
});
for (const id of ["start", "end"]) {
  $(id).addEventListener("change", () => { state.page = 0; render(); });
}
for (const button of document.querySelectorAll("[data-sensor]")) {
  button.addEventListener("click", () => {
    state.sensor = button.dataset.sensor;
    state.page = 0;
    render();
  });
}
$("calendar").addEventListener("click", event => {
  const date = event.target.closest("button[data-date]")?.dataset.date;
  if (!date) return;
  state.selected = state.selected === date ? "" : date;
  state.page = 0;
  render();
  $("calendar").querySelector('[data-date="' + date + '"]')?.focus({preventScroll: true});
});
$("clear-day").addEventListener("click", () => {
  const previous = state.selected;
  state.selected = "";
  state.page = 0;
  render();
  $("calendar").querySelector('[data-date="' + previous + '"]')?.focus();
});
$("previous").addEventListener("click", () => { state.page--; renderDetails(); });
$("next").addEventListener("click", () => { state.page++; renderDetails(); });

render();
restoreSnapshot();

