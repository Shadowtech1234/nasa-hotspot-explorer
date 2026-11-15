"use strict";

const $ = id => document.getElementById(id);
const sensors = ["MODIS", "VIIRS"];
const region = [-128, 23, -64, 51];
const colors = {MODIS: "#ffac69", VIIRS: "#68dfed", cells: "#d6acff"};
const number = new Intl.NumberFormat("en-US");
const monthName = new Intl.DateTimeFormat("en-US", {month: "long", year: "numeric", timeZone: "UTC"});
const pageSize = 20;
const state = {backend: null, history: null, selection: null, month: "", sensor: "both", selected: "", page: 0,
  tab: "map", points: [], cells: [], offsets: {}, mapPending: false};
let historyRequest;
let overviewRequest;
let overviewData;
let overviewKey;
let calendarRequest;
let mapRequest;
let basemapError = false;
let fitOnShow = false;
let visible = [];

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const map = L.map("map", {
  fadeAnimation: !reducedMotion, zoomAnimation: !reducedMotion, markerZoomAnimation: !reducedMotion,
  minZoom: 0, maxZoom: 15, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1,
  scrollWheelZoom: false, preferCanvas: true
});
map.attributionControl.setPrefix(false);
map.createPane("basemap").style.zIndex = "220";
map.createPane("global-imagery").style.zIndex = "225";
map.createPane("imagery").style.zIndex = "230";
L.control.scale({imperial: false, maxWidth: 88}).addTo(map);
const boundary = L.polyline(areaOutline(region), {
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
  const [west, south, east, north] = bounds;
  return west <= east ? [[south, west], [north, east]] : [[south, -180], [north, 180]];
}

function areaOutline([west, south, east, north]) {
  const longitude = west <= east ? [[west, east]] : [[west, 180], [-180, east]];
  return longitude.map(([left, right]) => [[south, left], [north, left], [north, right], [south, right], [south, left]]);
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
  if (state.history) {
    const row = state.backend.rowsByDay.get(state.selected);
    const standard = row?.standard_platforms?.join(", ");
    const provisional = row?.provisional_platforms?.join(", ");
    return ["NASA FIRMS", standard && standard, provisional && "Provisional · " + provisional,
      !standard && !provisional && "No archive inputs for this date"].filter(Boolean).join(" · ");
  }
  const labels = {MODIS_SP: "MODIS", VIIRS_SNPP_SP: "Suomi-NPP VIIRS"};
  const sources = sensors.map(sensor => {
    const source = state.backend.sources[sensor];
    return labels[source] || source || sensor + " unavailable";
  });
  return "NASA FIRMS standard processing · " + sources.join(" + ");
}

async function fetchApi(path, signal) {
  const response = await fetch(path, {signal, cache: "no-store"});
  if (!response.ok) {
    const {detail} = await response.json().catch(() => ({}));
    throw new Error(typeof detail === "string" ? detail : "The API returned HTTP " + response.status + ".");
  }
  return response.json();
}

function applyCalendar(calendar) {
  if (!Array.isArray(calendar.bbox) || calendar.bbox.length !== 4 ||
      !calendar.bbox.every(Number.isFinite) || !calendar.data_version ||
      !calendar.sources || !Array.isArray(calendar.rows) || !calendar.rows.length) {
    throw new Error("The API calendar is missing dates, bounds, or sources.");
  }
  const days = new Map(calendar.rows.map(row => [row.date_utc, row.sensor_detections]));
  const subset = calendar.archive_bbox && calendar.archive_bbox.join() !== calendar.bbox.join();
  const area = calendar.region === "northern-california-demo" ? "Northern California demo" : calendar.region;
  state.backend = {...calendar, days, rowsByDay: new Map(calendar.rows.map(row => [row.date_utc, row])),
    area: subset ? "Selected area" : area};
}

function dateOffset(day, offset) {
  const value = new Date(day + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function apiUrl(path, params) {
  return path + "?" + new URLSearchParams(params);
}

function archiveUrl(path, params) {
  return apiUrl(path, {...params, ...archiveDataset(), bbox: state.history.bbox.join(","), version: state.history.data_version});
}

function archiveDataset() {
  const dataset = $("archive-dataset").value;
  return dataset ? {dataset} : {};
}

async function loadBackend(selection = null) {
  historyRequest?.abort();
  overviewRequest?.abort();
  overviewKey = null;
  const request = new AbortController();
  historyRequest = request;
  $("retry-data").disabled = true;
  status("Loading the burning activity calendar…");
  try {
    const calendar = await fetchApi(apiUrl("/api/calendar", {...selection, ...archiveDataset()}), request.signal);
    if (request.signal.aborted) return;
    state.selection = selection;
    if (calendar.archive) {
      state.history = calendar;
      const previous = calendar.rows.find(row => row.date_utc === state.month);
      const latest = calendar.rows.findLast(row => row.activity !== null) ??
        calendar.rows.findLast(row => row.observed_cell_days > 0 || row.provisional_days > 0) ?? calendar.rows.at(-1);
      configureArchive(calendar);
      await selectArchiveMonth(previous ?? latest, true);
    } else {
      calendarRequest?.abort();
      state.history = null;
      applyCalendar(calendar);
      if (state.tab === "map") fitArea();
      else fitOnShow = true;
      await selectBackendDay(calendar.rows[0].date_utc);
    }
  } catch (error) {
    if (!request.signal.aborted) {
      status("Could not load the detection calendar. " + error.message, true);
    }
  } finally {
    if (!request.signal.aborted) $("retry-data").disabled = false;
  }
}

function configureArchive(calendar) {
  $("archive-bounds").value = calendar.bbox.join(", ");
  for (const id of ["archive-start", "archive-end"]) {
    $(id).min = calendar.archive_start;
    $(id).max = dateOffset(calendar.archive_end_exclusive, -1);
  }
  $("archive-start").value = calendar.start;
  $("archive-end").value = dateOffset(calendar.end_exclusive, -1);
  const years = [...new Set(calendar.rows.map(row => row.date_utc.slice(0, 4)))].reverse();
  $("archive-year").replaceChildren(...years.map(year => new Option(year, year)));
}

function renderArchive() {
  const current = state.history.rows.find(row => row.date_utc === state.month);
  const rows = state.history.rows.filter(row => row.date_utc.startsWith($("archive-year").value));
  const focused = document.activeElement?.dataset.month;
  $("archive-months").replaceChildren(...rows.map(row => {
    const button = element("button", "", row.usable_days < row.days_in_month ? "partial" : "");
    button.type = "button";
    button.dataset.month = row.date_utc;
    button.setAttribute("aria-pressed", String(row === current));
    const amount = row.activity === null ? (row.provisional_days ? "Provisional only" : "Index unavailable")
      : number.format(Math.round(row.activity)) + (row.usable_days < row.days_in_month ? " · partial" : "");
    button.append(element("span", monthName.format(new Date(row.date_utc))), element("strong", amount, "harmonized"));
    if (row.historical_percentile != null) {
      const level = percentileLevel(row.historical_percentile);
      if (level.key === "high" || level.key === "low") button.classList.add(level.key);
      button.append(element("small", "Percentile " + number.format(row.historical_percentile) +
        (["high", "low"].includes(level.key) ? " · " + level.label : "")));
    }
    return button;
  }));
  if (focused) $("archive-months").querySelector('[data-month="' + focused + '"]')?.focus({preventScroll: true});
  if (!current) return;
  const sourceDays = Object.entries(current.source_days).map(([source, days]) => source + " · " + days + " days");
  const observed = current.observed_cell_days === null ? "Standard-processing activity unavailable"
    : number.format(current.observed_cell_days) + " observed cell-days";
  const estimate = sourceDays.length && (current.source_days["Suomi-NPP"] !== current.usable_days) ? "Includes estimates" : "";
  const baseline = current.historical_median === null ?
    (current.usable_days < current.days_in_month ? "Percentile unavailable for an incomplete month"
      : "Percentile needs five complete earlier years · " + current.baseline_years + " available") :
    "Historical median " + number.format(Math.round(current.historical_median)) + " · Percentile " +
      number.format(Math.round(current.historical_percentile)) + " across " + current.baseline_years + " years";
  $("archive-month-summary").textContent = [observed, current.usable_days + " of " + current.days_in_month + " comparable days",
    estimate, ...sourceDays, baseline].filter(Boolean).join(" · ");
  const peak = state.history.rows.filter(row => row.usable_days === row.days_in_month).reduce(
    (best, row) => !best || row.activity > best.activity ? row : best, null);
  $("archive-peak").textContent = peak ? "Peak complete month in this selection · " + monthName.format(new Date(peak.date_utc)) +
    " · " + number.format(Math.round(peak.activity)) + " cell-days" : "";
  renderPercentiles();
}

const percentileLevels = [
  {key: "high", label: "Unusually high", color: "#ff7043"},
  {key: "above", label: "Above typical", color: "#ffbe63"},
  {key: "typical", label: "Typical range", color: "#77daa5"},
  {key: "below", label: "Below typical", color: "#77c9f4"},
  {key: "low", label: "Unusually low", color: "#7e9eff"},
  {key: "unknown", label: "Percentile unavailable", color: "#c5b6d7"},
];

function percentileLevel(rank) {
  return percentileLevels[rank == null ? 5 : rank >= 90 ? 0 : rank >= 75 ? 1 : rank > 25 ? 2 : rank > 10 ? 3 : 4];
}

function renderPercentiles() {
  const chart = $("percentile-chart");
  if (!state.history.rows.some(row => row.historical_percentile != null)) {
    chart.replaceChildren(element("p", "This selection has no months with a complete historical comparison.", "subtle"));
    return;
  }
  const plot = element("div", "", "percentile-plot");
  for (const rank of [0, 10, 50, 90, 100]) {
    const line = element("span", String(rank), "percentile-guide");
    line.style.setProperty("--rank", (5 + rank * 0.9) + "%");
    plot.append(line);
  }
  let selectedSlot;
  for (const [index, row] of state.history.rows.entries()) {
    const slot = element("div", "", "percentile-month");
    if (index === 0 || row.date_utc.slice(5, 7) === "01") {
      slot.append(element("span", row.date_utc.slice(0, 4), "percentile-year"));
    }
    if (row.historical_percentile != null) {
      const rank = row.historical_percentile;
      const button = element("button", "", "percentile-point");
      button.type = "button";
      button.title = monthName.format(new Date(row.date_utc)) + " · Percentile " + number.format(rank);
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(row.date_utc === state.month));
      button.style.setProperty("--rank", (5 + rank * 0.9) + "%");
      button.style.color = percentileLevel(rank).color;
      button.onclick = () => selectArchiveMonth(row);
      slot.append(button);
    }
    if (row.date_utc === state.month) selectedSlot = slot;
    plot.append(slot);
  }
  chart.replaceChildren(plot);
  if (selectedSlot) chart.scrollLeft = Math.max(0, selectedSlot.offsetLeft - chart.clientWidth / 2);
}

async function loadOverview(month) {
  if (!month || $("map-layer").value !== "overview") return;
  const resolution = map.getZoom() >= 5 ? 3 : 2;
  const url = archiveUrl("/api/overview", {month: month.date_utc, start: month.first_day,
    end: dateOffset(month.last_day, 1), resolution});
  if (url === overviewKey) return;
  overviewKey = url;
  overviewRequest?.abort();
  const request = new AbortController();
  overviewRequest = request;
  overviewData = null;
  if (state.tab === "map") renderMap(visible);
  try {
    const result = await fetchApi(url, request.signal);
    if (request.signal.aborted) return;
    overviewData = result;
  } catch (error) {
    if (request.signal.aborted) return;
    overviewKey = null;
    overviewData = {error: error.message};
  }
  if (!request.signal.aborted && state.tab === "map") renderMap(visible);
}

async function selectArchiveMonth(month, refit = false) {
  if (!month) return;
  calendarRequest?.abort();
  mapRequest?.abort();
  const request = new AbortController();
  calendarRequest = request;
  status("Loading daily observations for " + monthName.format(new Date(month.date_utc)) + "…");
  try {
    const daily = await fetchApi(archiveUrl("/api/calendar", {
      start: month.first_day, end: dateOffset(month.last_day, 1), granularity: "day"
    }), request.signal);
    if (request.signal.aborted) return;
    applyCalendar(daily);
    state.month = month.date_utc;
    $("archive-year").value = state.month.slice(0, 4);
    renderArchive();
    if (refit && state.tab === "map") fitArea();
    else if (refit) fitOnShow = true;
    const preferred = state.backend.days.has(state.selected) ? state.selected : (daily.rows.findLast(row =>
      Object.values(row.sensor_detections).some(count => count > 0)) ?? daily.rows.at(-1)).date_utc;
    $("map-layer").value = "overview";
    loadOverview(month);
    await selectBackendDay(preferred, true);
  } catch (error) {
    if (!request.signal.aborted) status("Could not load daily observations. " + error.message, true);
  }
}

function mapPage(date, layer, signal, sensor, offset = 0) {
  const params = {date, layer, offset, limit: layer === "cells" ? 2500 : 1500};
  if (sensor) params.sensor = sensor;
  return fetchApi(state.history ? archiveUrl("/api/map", params) : apiUrl("/api/map", {date}), signal);
}

function acceptMapPage(collection, date, key) {
  if (collection.metadata?.data_version !== state.backend.data_version) {
    throw new Error("The export changed. Reload the backend data to refresh it.");
  }
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features) || collection.metadata.date_utc !== date) {
    throw new Error("The API map is missing a valid daily GeoJSON export.");
  }
  for (const {geometry, properties} of collection.features) {
    const [lon, lat] = geometry.coordinates;
    if (key === "cells") {
      state.cells.push({lon, lat, date, cell: properties.cell, platforms: properties.platforms});
    } else {
      state.points.push({lon, lat, date, sensor: properties.sensor, time: properties.acquired_at_utc.slice(11, 16),
        satellite: properties.platform, confidence: properties.confidence_raw, frp: properties.frp_mw,
        processing: properties.processing, eligible: properties.eligible});
    }
  }
  state.offsets[key] = collection.metadata.next_offset;
}

async function selectBackendDay(date, preserveLayer = false) {
  mapRequest?.abort();
  const request = new AbortController();
  mapRequest = request;
  state.selected = date;
  state.page = 0;
  state.points = [];
  state.cells = [];
  state.offsets = {};
  state.mapPending = true;
  if (state.history && !preserveLayer) {
    const day = state.backend.rowsByDay.get(date);
    $("map-layer").value = !day.standard_platforms.length && day.provisional_platforms.length ? "detections" : "cells";
  }
  status("Loading backend detections for " + date + "…");
  render();
  try {
    const pages = state.history ? await Promise.all([
      mapPage(date, "cells", request.signal), ...sensors.map(sensor => mapPage(date, "detections", request.signal, sensor))
    ]) : [await mapPage(date, "detections", request.signal)];
    if (request.signal.aborted) return;
    const keys = state.history ? ["cells", ...sensors] : ["detections"];
    pages.forEach((collection, index) => acceptMapPage(collection, date, keys[index]));
    status(sourceLabel());
  } catch (error) {
    if (request.signal.aborted) return;
    status("Detection map unavailable. " + error.message, true);
  }
  state.mapPending = false;
  render();
}

function nextMapKeys() {
  if (state.tab === "map" && $("map-layer").value === "overview") return [];
  const keys = state.tab === "map" && $("map-layer").value === "cells" ? ["cells"]
    : state.tab === "compare" ? sensors : selectedSensors();
  return keys.filter(key => state.offsets[key] != null);
}

async function loadMoreMap() {
  if (state.mapPending) return;
  const keys = nextMapKeys();
  const signal = mapRequest.signal;
  const date = state.selected;
  state.mapPending = true;
  render();
  try {
    const pages = await Promise.all(keys.map(key => mapPage(date, key === "cells" ? key : "detections", signal,
      key === "cells" ? null : key, state.offsets[key])));
    if (signal.aborted) return;
    pages.forEach((page, index) => acceptMapPage(page, date, keys[index]));
  } catch (error) {
    if (!signal.aborted) status("Could not load more map records. " + error.message, true);
  } finally {
    if (!signal.aborted) {
      state.mapPending = false;
      render();
    }
  }
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
  const row = state.backend.rowsByDay.get(date);
  return {date, row, counts: selectedSensors().map(sensor => ({sensor, count: counts[sensor]}))};
}

function calendarCell({date, counts, row}) {
  const cell = element("button", "", "day");
  cell.type = "button";
  cell.classList.toggle("has-activity", counts.some(({count}) => count > 0));
  cell.dataset.date = date;
  cell.setAttribute("aria-pressed", String(date === state.selected));
  const description = counts.map(({sensor, count}) =>
    sensor + ": " + (count === null ? "source unavailable"
      : count === 0 ? "no records" : number.format(count)));
  if (row.provisional_platforms?.length) description.push("Includes provisional data");
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
  if (point.processing === "NRT") popup.append(element("div", "Provisional detection"));
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
  boundary.setLatLngs(areaOutline(activeBounds()));
  boundary.setStyle({opacity: state.backend ? 0.85 : 0});
  if (state.history && $("map-layer").value === "overview") {
    renderOverview();
    return;
  }
  const showCells = state.history && $("map-layer").value === "cells";
  if (showCells) {
    for (const cell of state.cells) {
      const modis = cell.platforms.some(platform => platform === "Terra" || platform === "Aqua");
      const viirs = cell.platforms.some(platform => platform !== "Terra" && platform !== "Aqua");
      if ((state.sensor === "MODIS" && !modis) || (state.sensor === "VIIRS" && !viirs)) continue;
      L.circleMarker([cell.lat, cell.lon], {radius: 3.5, weight: 0, fillColor: colors.cells, fillOpacity: 0.8})
        .bindPopup(() => element("span", "Active cell " + cell.cell + " · " + cell.platforms.join(", "))).addTo(pointLayer);
    }
  } else {
    for (const point of points) mapPoint(point).addTo(pointLayer);
  }
  const legend = $("legend");
  legend.replaceChildren();
  for (const sensor of showCells ? ["Active cell centers"] : selectedSensors()) {
    const label = element("span", "", showCells ? "harmonized" : sensor.toLowerCase());
    const dot = element("i", "", "dot");
    dot.setAttribute("aria-hidden", "true");
    label.append(dot, document.createTextNode(sensor));
    legend.append(label);
  }
}

function renderOverview() {
  const legend = $("legend");
  legend.replaceChildren(element("span", "Size · monthly activity"));
  for (const level of percentileLevels) {
    const item = element("span");
    const dot = element("i", "", "dot");
    dot.style.color = level.color;
    item.append(dot, document.createTextNode(level.label));
    legend.append(item);
  }
  const features = overviewData?.features ?? [];
  $("map-scope").textContent = monthName.format(new Date(state.month)) + " · " +
    (overviewData?.error ?? (!overviewData ? "Loading monthly activity…" : features.length
      ? (overviewData.metadata.complete_month ? "Monthly activity by grid region" : "Partial month · percentile unavailable")
      : "No standard-processing activity reported for this selection"));
  const maximum = features.reduce((max, f) => Math.max(max, f.properties.activity ?? f.properties.observed_cell_days), 1);
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    const row = feature.properties;
    const level = percentileLevel(row.historical_percentile);
    const activity = row.activity ?? row.observed_cell_days;
    L.circleMarker([lat, lon], {
      radius: 3 + 22 * Math.sqrt(activity / maximum),
      fillColor: level.color, fillOpacity: 0.8, color: "#172535", weight: 1
    }).bindPopup(() => {
      const popup = element("div");
      popup.append(element("strong", level.label));
      popup.append(element("div", number.format(Math.round(activity)) +
        (row.activity == null ? " observed cell-days" : " comparable cell-days")));
      if (row.historical_percentile != null) popup.append(element("div",
        "Percentile " + number.format(row.historical_percentile) + " across " + row.baseline_years +
        " years · median " + number.format(Math.round(row.historical_median))));
      if (state.history.archive_bbox.join() === "-180,-90,180,90") {
        const select = element("button", "Use region bounds");
        select.type = "button";
        select.onclick = () => loadBackend({
          bbox: row.bbox.join(","), start: state.history.start, end: state.history.end_exclusive
        });
        popup.append(select);
      }
      return popup;
    }).addTo(pointLayer);
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
  const headings = state.history ? ["Date (UTC)", "Sensor", "Platform", "Processing", "Latitude", "Longitude", "Map"]
    : ["Date (UTC)", "Sensor", "Latitude", "Longitude", "Map"];
  for (const title of headings) {
    const cell = element("th", title);
    cell.scope = "col";
    header.append(cell);
  }
  const body = table.createTBody();
  const first = state.page * pageSize;
  for (const point of visible.slice(first, first + pageSize)) {
    const row = body.insertRow();
    const attributes = state.history ? [point.satellite, point.processing === "NRT" ? "Provisional" : "Standard"] : [];
    for (const value of [point.date + (point.time ? " " + point.time : ""), point.sensor, ...attributes,
      point.lat.toFixed(4), point.lon.toFixed(4)]) row.insertCell().textContent = value;
    const button = element("button", "Locate");
    button.type = "button";
    button.setAttribute("aria-label", "Locate " + point.sensor + " point at " +
      point.lat.toFixed(4) + ", " + point.lon.toFixed(4));
    button.addEventListener("click", () => {
      if (state.history) $("map-layer").value = "detections";
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
  const cells = selected?.row.observed_cell_days;
  const cellsLabel = cells == null ? "Active cells unavailable" : number.format(cells) + " active cells across sensors";
  $("map-scope").textContent = state.history && $("map-layer").value === "cells" && selected
    ? state.selected + " UTC · " + cellsLabel : scope;
  $("list-summary").textContent = scope + (state.history && selected?.row.provisional_platforms.length ? " · includes provisional" : "");
  mapHelp();
  $("provenance").textContent = sourceLabel();
  $("coverage").textContent = state.backend
    ? "Study bounds (west, south, east, north) " + bounds + ". Satellite observation coverage is unknown."
    : "";
  $("download-csv").disabled = !visible.length;
  $("download-csv").textContent = state.history && selectedSensors().some(sensor => state.offsets[sensor] != null)
    ? "Download loaded detections" : "Download filtered CSV";
  $("archive-panel").hidden = !state.history;
  $("map-layer-control").hidden = !state.history;
  $("archive-method").hidden = !state.history;
  $("calendar-title").textContent = state.history ? "Daily observations" : "Burning activity calendar";
  $("fetch-next").hidden = !state.history || !nextMapKeys().length;
  $("fetch-next").disabled = state.mapPending;
  $("fetch-next").textContent = state.tab === "map" && $("map-layer").value === "cells"
    ? "Load more active cells" : "Load more detections";
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
  const archiveColumns = state.history ? ["processing", "eligible_for_index"] : [];
  const rows = [
    ["date_utc", "time_utc", "sensor", "satellite", "latitude", "longitude", "confidence", "frp_mw", ...archiveColumns],
    ...visible.map(point => [point.date, point.time, point.sensor, point.satellite, point.lat, point.lon,
      point.confidence, point.frp, ...(state.history ? [point.processing, point.eligible] : [])])
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

$("retry-data").addEventListener("click", () => loadBackend(state.selection));
$("fetch-next").addEventListener("click", loadMoreMap);
$("map-layer").addEventListener("change", () => {
  render();
  loadOverview(state.history?.rows.find(row => row.date_utc === state.month));
});
$("archive-dataset").addEventListener("change", () => {
  state.month = "";
  loadBackend();
});
$("archive-selection").addEventListener("submit", event => {
  event.preventDefault();
  loadBackend({bbox: $("archive-bounds").value, start: $("archive-start").value, end: dateOffset($("archive-end").value, 1)});
});
$("archive-reset").addEventListener("click", () => loadBackend());
$("archive-year").addEventListener("change", event => {
  const rows = state.history.rows.filter(row => row.date_utc.startsWith(event.target.value));
  renderArchive();
  selectArchiveMonth(rows.findLast(row => row.activity !== null || row.provisional_days > 0) ?? rows.at(-1));
});
$("archive-months").addEventListener("click", event => {
  const day = event.target.closest("[data-month]")?.dataset.month;
  if (day) selectArchiveMonth(state.history.rows.find(row => row.date_utc === day));
});
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
  $("fetch-next").hidden = !state.history || !nextMapKeys().length;
  $("fetch-next").textContent = tab === "map" && $("map-layer").value === "cells"
    ? "Load more active cells" : "Load more detections";
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
map.on("zoomend", () => loadOverview(state.history?.rows.find(row => row.date_utc === state.month)));
new ResizeObserver(resizeMap).observe($("map"));

setBasemap("satellite");
render();
fetchApi("/api/archives").then(archives => {
  $("archive-dataset").replaceChildren(...archives.map(archive => new Option(archive.name, archive.id)));
  $("archive-choice").hidden = archives.length < 2;
}).catch(() => {}).finally(() => loadBackend());
