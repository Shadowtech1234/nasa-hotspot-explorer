"use strict";

const $ = id => document.getElementById(id);
const sensors = ["MODIS", "VIIRS"];
const region = [-128, 23, -64, 51];
const colors = {MODIS: "#ffac69", VIIRS: "#68dfed"};
const number = new Intl.NumberFormat("en-US");
const monthName = new Intl.DateTimeFormat("en-US", {month: "long", year: "numeric", timeZone: "UTC"});
const pageSize = 20;
const state = {backend: null, sensor: "both", selected: "", page: 0, tab: "map", points: []};
let calendarRequest;
let mapRequest;
let basemapError = false;
let fitOnShow = false;
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
L.control.scale({imperial: false, maxWidth: 88}).addTo(map);
const boundary = L.rectangle(asLeafletBounds(region), {
  color: "#a3c2d5", opacity: 0.8, weight: 1, dashArray: "5 5", fill: false, interactive: false
}).addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const focusLayer = L.layerGroup().addTo(map);
map.fitBounds(asLeafletBounds(region), {padding: [22, 22]});
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
  const action = map.scrollWheelZoom.enabled()
    ? "Scroll to zoom. Esc releases scrolling."
    : matchMedia("(pointer: coarse)").matches ? "Drag to pan. Pinch to zoom."
      : "Click or focus the map to scroll to zoom.";
  $("map-help").textContent = [imagery, action].filter(Boolean).join(" · ");
}

function asLeafletBounds(bounds) {
  return [[bounds[1], bounds[0]], [bounds[3], bounds[2]]];
}

function activeBounds() {
  return state.backend?.bbox ?? region;
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
  if (!state.backend) return "Backend data unavailable";
  const labels = {MODIS_SP: "MODIS", VIIRS_SNPP_SP: "Suomi-NPP VIIRS"};
  const sources = sensors.map(sensor => {
    const source = state.backend.sources[sensor];
    return labels[source] || source || sensor + " unavailable";
  });
  return "NASA FIRMS standard processing · " + sources.join(" + ");
}

async function fetchApi(path, signal) {
  const response = await fetch(path, {signal, cache: "no-store"});
  if (response.status === 503) throw new Error("The backend export is unavailable.");
  if (!response.ok) throw new Error("The API returned HTTP " + response.status + ".");
  return response.json();
}

async function loadBackend() {
  calendarRequest?.abort();
  mapRequest?.abort();
  const request = new AbortController();
  calendarRequest = request;
  $("retry-data").disabled = true;
  status("Loading the detection calendar…");
  try {
    const calendar = await fetchApi("/api/calendar", request.signal);
    if (!Array.isArray(calendar.bbox) || calendar.bbox.length !== 4 ||
        !calendar.bbox.every(Number.isFinite) || !calendar.data_version ||
        !calendar.sources || !Array.isArray(calendar.rows) || !calendar.rows.length) {
      throw new Error("The API calendar is missing dates, bounds, or sources.");
    }
    const days = new Map(calendar.rows.map(row => [row.date_utc, row.sensor_detections]));
    if (request.signal.aborted) return;
    state.backend = {...calendar, days, area: calendar.region === "northern-california-demo"
      ? "Northern California demo" : calendar.region};
    if (state.tab === "map") fitArea();
    else fitOnShow = true;
    await selectBackendDay([...days.keys()].sort()[0]);
  } catch (error) {
    if (!request.signal.aborted) {
      status("Could not load the detection calendar. " + error.message, true);
    }
  } finally {
    if (!request.signal.aborted) $("retry-data").disabled = false;
  }
}

async function selectBackendDay(date) {
  mapRequest?.abort();
  const request = new AbortController();
  mapRequest = request;
  state.selected = date;
  state.page = 0;
  state.points = [];
  status("Loading backend detections for " + date + "…");
  render();
  try {
    const collection = await fetchApi("/api/map?date=" + encodeURIComponent(date), request.signal);
    if (request.signal.aborted) return;
    if (collection.metadata?.data_version !== state.backend.data_version) {
      throw new Error("The export changed. Reload the backend data to refresh it.");
    }
    if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features) ||
        collection.metadata.date_utc !== date) {
      throw new Error("The API map is missing a valid daily GeoJSON export.");
    }
    state.points = collection.features.map(({geometry, properties}) => ({
      lon: geometry.coordinates[0], lat: geometry.coordinates[1], date,
      sensor: properties.sensor, time: properties.acquired_at_utc.slice(11, 16),
      satellite: properties.platform, confidence: properties.confidence_raw, frp: properties.frp_mw
    }));
    status(sourceLabel());
  } catch (error) {
    if (request.signal.aborted) return;
    status("Detection map unavailable. " + error.message, true);
  }
  render();
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

function backendDay(date) {
  const counts = state.backend.days.get(date);
  return {date, counts: selectedSensors().map(sensor => ({sensor, count: counts[sensor]}))};
}

function calendarCell({date, counts}) {
  const cell = element("button", "", "day");
  cell.type = "button";
  cell.classList.toggle("has-activity", counts.some(({count}) => count > 0));
  cell.dataset.date = date;
  cell.setAttribute("aria-pressed", String(date === state.selected));
  const description = counts.map(({sensor, count}) =>
    sensor + ": " + (count === null ? "source unavailable"
      : count === 0 ? "no records" : number.format(count)));
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
  if (!days.length) content.append(element("p", "The calendar will appear when the backend provides its exported dates.", "subtle"));
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
  boundary.setBounds(asLeafletBounds(activeBounds()));
  boundary.setStyle({opacity: state.backend ? 0.85 : 0});
  for (const point of points) mapPoint(point).addTo(pointLayer);
  const legend = $("legend");
  legend.replaceChildren();
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
    target.replaceChildren(element("p", state.backend
      ? "No detections to display for this selection." : "Detection data will appear when the backend is connected."));
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
  const days = state.backend ? [...state.backend.days.keys()].sort().map(backendDay) : [];
  const sensorsShown = selectedSensors();
  visible = state.points.filter(point => sensorsShown.includes(point.sensor));
  state.page = Math.min(state.page, Math.max(0, Math.ceil(visible.length / pageSize) - 1));
  const bounds = activeBounds().map(value => value.toFixed(2)).join(", ");
  $("area-name").textContent = state.backend?.area || "Study area pending";
  $("area-name").title = state.backend ? "W, S, E, N: " + bounds : "";
  $("fit-area").disabled = !state.backend;
  const selected = state.backend && backendDay(state.selected);
  const counts = selected?.counts.map(({sensor, count}) =>
    sensor + " " + (count === null ? "unavailable" : number.format(count))).join(" · ");
  const scope = selected ? state.selected + " UTC · " + counts : "No backend data loaded";
  $("map-scope").textContent = scope;
  $("list-summary").textContent = scope;
  mapHelp();
  $("provenance").textContent = sourceLabel();
  $("coverage").textContent = state.backend
    ? "Study bounds (west, south, east, north) " + bounds + ". Satellite observation coverage is unknown."
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

$("retry-data").addEventListener("click", loadBackend);
$("fit-area").addEventListener("click", fitArea);
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
  selectBackendDay(date);
  $("calendar").querySelector('[data-date="' + date + '"]')?.focus({preventScroll: true});
});
$("previous").addEventListener("click", () => { state.page--; renderDetails(); });
$("next").addEventListener("click", () => { state.page++; renderDetails(); });

const tabs = ["map", "compare", "detections"];

function showTab(tab, focusTab = false) {
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
      if (fitOnShow) {
        fitOnShow = false;
        fitArea();
      }
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
  if (event.key === "Escape") setWheel(false);
});
map.on("moveend", mapHelp);
new ResizeObserver(resizeMap).observe($("map"));

setBasemap("satellite");
render();
loadBackend();
