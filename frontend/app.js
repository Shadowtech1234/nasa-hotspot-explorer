"use strict";

const $ = id => document.getElementById(id);
const sensors = ["MODIS", "VIIRS"];
const region = [-128, 23, -64, 51];
const world = [-180, -90, 180, 90];
const colors = {MODIS: "#ffac69", VIIRS: "#68dfed", cells: "#d6acff"};
const number = new Intl.NumberFormat("en-US");
const monthName = new Intl.DateTimeFormat("en-US", {month: "long", year: "numeric", timeZone: "UTC"});
const monthShort = new Intl.DateTimeFormat("en-US", {month: "short", timeZone: "UTC"});
const ordinal = new Intl.PluralRules("en-US", {type: "ordinal"});
const pageSize = 20;
const state = {backend: null, history: null, selection: null, month: "", sensor: "both", selected: "", page: 0,
  tab: "map", points: [], cells: [], offsets: {}, mapPending: false};
let historyRequest;
let overviewRequest;
let overviewData;
let overviewKey;
let densityRequest;
let densityKey;
let densityData;
let calendarRequest;
let mapRequest;
let basemapError = false;
let geography;
let countryLabels = [];
const studyAreas = new Map();
let drawStart;
let drawPreview;
let fitOnShow = false;
let visible = [];

const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const reducedMotion = motionPreference.matches;
const map = L.map("map", {
  fadeAnimation: !reducedMotion, zoomAnimation: !reducedMotion, markerZoomAnimation: !reducedMotion,
  minZoom: 0, maxZoom: 15, zoomSnap: .25, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1,
  scrollWheelZoom: false, preferCanvas: true
});
map.attributionControl.setPrefix(false);
map.createPane("basemap").style.zIndex = "220";
map.createPane("global-imagery").style.zIndex = "225";
map.createPane("imagery").style.zIndex = "230";
map.createPane("country-labels").style.zIndex = "235";
const labelLayer = L.layerGroup().addTo(map);
L.control.scale({imperial: false, maxWidth: 88}).addTo(map);
const boundary = L.polyline(areaOutline(region), {
  color: "#a3c2d5", opacity: 0.8, weight: 1, dashArray: "5 5", fill: false, interactive: false
}).addTo(map);
const footprintLayer = L.geoJSON(null, {
  style: {color: "#a3c2d5", opacity: 0.8, weight: 1, fill: false, interactive: false}
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
  $("map").dataset.basemap = choice;
  geography?.setStyle(basemapStyle(choice));
  for (const layer of imageryLayers) {
    if (choice !== "satellite") layer.remove();
    else {
      if (imageryStatus.get(layer) === "failed") {
        imageryStatus.set(layer, "loading");
        layer.setUrl(layer === satellite ? scene.image : globalImageUrl);
      }
      layer.addTo(map);
    }
  }
  renderCountryLabels();
  mapHelp();
}

function basemapStyle(choice) {
  return choice === "light" ? {color: "#a5b3a9", weight: 0.65, fillColor: "#d6dfd4", fillOpacity: 1}
    : {color: "#3f5757", weight: 0.65, fillColor: "#202e2e", fillOpacity: 1};
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
  const action = $("draw-area").getAttribute("aria-pressed") === "true" ? "Drag a rectangle to choose bounds. Esc cancels."
    : map.scrollWheelZoom.enabled()
    ? "Scroll to zoom. Esc releases scrolling."
    : matchMedia("(pointer: coarse)").matches ? "Drag to pan. Pinch to zoom."
      : "Click or focus the map to scroll to zoom.";
  $("map-help").textContent = [imagery, action].filter(Boolean).join(" · ");
}

function asLeafletBounds(bounds) {
  const [west, south, east, north] = bounds;
  if (isWorld(bounds)) return [[-60, west], [78, east]];
  return west <= east ? [[south, west], [north, east]] : [[south, -180], [north, 180]];
}

function isWorld(bounds) {
  return bounds.every((value, index) => value === world[index]);
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
  if (state.history?.published) {
    const row = state.backend.rowsByDay.get(state.selected);
    const detail = row?.unavailable_packets ? "Some published packets are unavailable"
      : row?.partial_sensors?.length ? "Partial coverage for " + row.partial_sensors.join(" and ") : "";
    return ["NASA FIRMS", "Published data", state.selected + " UTC", detail].filter(Boolean).join(" · ");
  }
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

let usePublishedData = new URLSearchParams(location.search).get("data") === "local";

async function fetchApi(path, signal) {
  if (usePublishedData) return publishedApi.handle(path, signal);
  const response = await fetch(path, {signal, cache: "no-store"});
  if (path === "/api/archives" && (response.status === 404 || response.status === 405 ||
      (response.ok && !response.headers.get("content-type")?.includes("application/json")))) {
    usePublishedData = true;
    return publishedApi.handle(path, signal);
  }
  if (!response.ok) {
    const {detail} = await response.json().catch(() => ({}));
    throw Object.assign(new Error(typeof detail === "string" ? detail : "The API returned HTTP " + response.status + "."),
      {status: response.status});
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

function archiveUrl(path, params, history = state.history) {
  const {dataset, bbox, data_version: version} = history;
  return apiUrl(path, {...params, ...(dataset ? {dataset} : {}), bbox: bbox.join(","), version});
}

function archiveDataset() {
  const dataset = $("archive-dataset").value;
  return dataset ? {dataset} : {};
}

async function loadBackend(selection = null, areaLabel = "") {
  historyRequest?.abort();
  const request = new AbortController();
  historyRequest = request;
  const dataset = archiveDataset().dataset;
  let previewedPercentiles = false;
  $("retry-data").disabled = true;
  status("Loading the burning activity calendar…");
  try {
    const calendar = await fetchApi(apiUrl("/api/calendar", {...selection, ...(dataset ? {dataset} : {})}), request.signal);
    if (request.signal.aborted) return;
    if (calendar.archive) {
      const previous = dataset === state.history?.dataset ? calendar.rows.find(row => row.date_utc === state.month) : null;
      const latest = calendar.rows.findLast(row => row.activity !== null) ??
        calendar.rows.findLast(row => row.observed_cell_days > 0 || row.provisional_days > 0) ?? calendar.rows.at(-1);
      const year = latest?.date_utc.slice(0, 4);
      const initial = firstCalendarMonth(calendar.rows.filter(row => row.date_utc.startsWith(year)));
      const month = previous ?? initial;
      const history = {...calendar, dataset, areaLabel};
      if (calendar.has_footprint) {
        history.footprint = state.history?.data_version === calendar.data_version ? state.history.footprint :
          await fetchApi(apiUrl("/api/footprint", {version: calendar.data_version, ...(dataset ? {dataset} : {})}),
            request.signal);
        if (request.signal.aborted) return;
      }
      if (!state.history && month) {
        $("percentile-panel").hidden = false;
        renderPercentiles(history, month.date_utc, "first");
        previewedPercentiles = true;
      }
      await selectArchiveMonth(month, {refit: true, history, selection, signal: request.signal});
    } else {
      calendarRequest?.abort();
      state.history = null;
      footprintLayer.clearLayers();
      state.selection = selection;
      applyCalendar(calendar);
      if (state.tab === "map") fitArea();
      else fitOnShow = true;
      $("map-layer").value = "density";
      await selectBackendDay(calendar.rows[0].date_utc, true);
    }
  } catch (error) {
    if (!request.signal.aborted) {
      $("archive-dataset").value = state.history?.dataset ?? dataset ?? "";
      const localPreview = ["127.0.0.1", "localhost", ""].includes(location.hostname);
      const hint = localPreview ? " Launch the app with start-explorer.cmd from the project folder." : "";
      status("Could not load the detection calendar. " + error.message + hint, true);
      if (!state.backend && !previewedPercentiles) {
        $("percentile-chart").replaceChildren(element("p", "Monthly percentiles are unavailable.", "subtle"));
      }
    }
  } finally {
    if (!request.signal.aborted) $("retry-data").disabled = false;
  }
}

function configureArchive(calendar) {
  $("area-search").value = "";
  $("archive-dataset").value = calendar.dataset ?? "";
  $("archive-bounds").value = calendar.bbox.join(", ");
  $("archive-bounds-help").textContent = calendar.published && !calendar.static_detections
    ? "Choose Published detections to draw or search for a custom area."
    : "Search for an area or draw on the map to fill these coordinates.";
  for (const id of ["archive-start", "archive-end"]) {
    $(id).min = calendar.archive_start;
    $(id).max = dateOffset(calendar.archive_end_exclusive, -1);
  }
  $("archive-start").value = calendar.start;
  $("archive-end").value = dateOffset(calendar.end_exclusive, -1);
  const years = [...new Set(calendar.rows.map(row => row.date_utc.slice(0, 4)))].reverse();
  $("archive-year").replaceChildren(...years.map(year => new Option(year, year)));
}

function firstCalendarMonth(rows) {
  const hasData = row => row.activity != null || row.observed_cell_days != null || row.provisional_days > 0;
  return rows.find(row => row.date_utc.slice(5, 7) === "01" && hasData(row)) ?? rows.find(hasData) ?? rows[0];
}

function formatPercentile(rank) {
  const value = Math.round(rank);
  const suffix = {one: "st", two: "nd", few: "rd", other: "th"}[ordinal.select(value)];
  return number.format(value) + suffix + " percentile";
}

function renderArchive(percentilePosition = "keep") {
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
    const date = new Date(row.date_utc);
    button.title = monthName.format(date);
    button.append(element("span", state.tab === "map" ? monthShort.format(date) : button.title), element("strong", amount, "harmonized"));
    if (row.historical_percentile != null) {
      const level = percentileLevel(row.historical_percentile);
      if (level.key === "high" || level.key === "low") button.classList.add(level.key);
      button.append(element("small", formatPercentile(row.historical_percentile)));
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
    "Historical median " + number.format(Math.round(current.historical_median)) + " · " +
      formatPercentile(current.historical_percentile) + " across " + current.baseline_years + " years";
  $("archive-month-summary").textContent = [observed, current.usable_days + " of " + current.days_in_month + " comparable days",
    estimate, ...sourceDays, baseline].filter(Boolean).join(" · ");
  const peak = state.history.rows.filter(row => row.usable_days === row.days_in_month).reduce(
    (best, row) => !best || row.activity > best.activity ? row : best, null);
  $("archive-peak").textContent = peak ? "Peak complete month in this selection · " + monthName.format(new Date(peak.date_utc)) +
    " · " + number.format(Math.round(peak.activity)) + " cell-days" : "";
  renderPercentiles(state.history, state.month, percentilePosition);
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

function renderPercentiles(history, selectedMonth, position) {
  const chart = $("percentile-chart");
  const firstRanked = history.rows.findIndex(row => row.historical_percentile != null);
  if (firstRanked === -1) {
    chart.replaceChildren(element("p", "This selection has no months with a complete historical comparison.", "subtle"));
    return;
  }
  const rows = history.rows.slice(firstRanked);
  const frame = element("div", "", "percentile-frame");
  const axis = element("div", "", "percentile-axis");
  axis.setAttribute("aria-hidden", "true");
  const scroll = element("div", "", "percentile-scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "Monthly percentile plot. Scroll to see more months.");
  const plot = element("div", "", "percentile-plot");
  const guides = element("div", "", "percentile-guides");
  guides.setAttribute("aria-hidden", "true");
  plot.append(guides);
  const positionFor = rank => (5 + rank * .9) + "%";
  for (const rank of [0, 10, 50, 90, 100]) {
    const tick = element("span", String(rank), "percentile-tick");
    const line = element("span", "", "percentile-guide");
    tick.style.setProperty("--rank", positionFor(rank));
    line.style.setProperty("--rank", positionFor(rank));
    if (rank === 50) line.classList.add("percentile-median");
    axis.append(tick);
    guides.append(line);
  }
  let selectedSlot;
  const previousScroll = chart.querySelector(".percentile-scroll")?.scrollLeft ?? 0;
  for (const [index, row] of rows.entries()) {
    const slot = element("div", "", "percentile-month");
    const track = element("div", "", "percentile-track");
    const date = new Date(row.date_utc);
    const startsYear = date.getUTCMonth() === 0;
    const selected = row.date_utc === selectedMonth;
    slot.classList.toggle("starts-year", startsYear && index > 0);
    slot.classList.toggle("selected-month", selected);
    if (row.historical_percentile != null) {
      const rank = row.historical_percentile;
      const button = element("button", "", "percentile-point");
      button.type = "button";
      button.title = monthName.format(date) + " · " + formatPercentile(rank);
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(selected));
      button.style.setProperty("--rank", positionFor(rank));
      button.style.color = percentileLevel(rank).color;
      button.disabled = history !== state.history;
      button.onclick = () => selectArchiveMonth(row);
      track.append(button);
    }
    slot.append(track, element("span", monthShort.format(date), "percentile-month-label"));
    if (index === 0 || startsYear) slot.append(element("span", row.date_utc.slice(0, 4), "percentile-year"));
    if (selected) selectedSlot = slot;
    plot.append(slot);
  }
  scroll.append(plot);
  frame.append(axis, scroll);
  chart.replaceChildren(frame);
  if (position === "first") scroll.scrollLeft = 0;
  else if (position === "selected" && selectedSlot) {
    scroll.scrollLeft = Math.max(0, selectedSlot.offsetLeft + selectedSlot.offsetWidth / 2 - scroll.clientWidth / 2);
  } else scroll.scrollLeft = previousScroll;
}

async function loadOverview(month) {
  if (!month || $("map-layer").value !== "overview") return;
  const zoom = map.getZoom();
  const span = boundsSpan(state.history.bbox);
  const resolution = zoom >= 8 && span <= 14 ? 5 : zoom >= 6 && span <= 40 ? 4 : zoom >= 4.5 ? 3 : 2;
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

async function selectArchiveMonth(month, {refit = false, history = state.history, selection, signal, day} = {}) {
  if (!month) return;
  calendarRequest?.abort();
  const request = new AbortController();
  const active = signal ? AbortSignal.any([request.signal, signal]) : request.signal;
  calendarRequest = request;
  status("Loading daily observations for " + monthName.format(new Date(month.date_utc)) + "…");
  try {
    const daily = await fetchApi(archiveUrl("/api/calendar", {
      start: month.first_day, end: dateOffset(month.last_day, 1), granularity: "day"
    }, history), active);
    if (active.aborted) return;
    applyCalendar(daily);
    if (history !== state.history) {
      if (history.footprint !== state.history?.footprint) {
        footprintLayer.clearLayers();
        if (history.footprint) footprintLayer.addData(history.footprint);
      }
      state.history = history;
      state.selection = selection;
      configureArchive(history);
    }
    if (history.areaLabel) state.backend.area = history.areaLabel;
    overviewRequest?.abort();
    overviewKey = null;
    overviewData = null;
    state.month = month.date_utc;
    $("archive-year").value = state.month.slice(0, 4);
    renderArchive(signal ? "keep" : "selected");
    if (refit && state.tab === "map") fitArea();
    else if (refit) fitOnShow = true;
    const preferred = state.backend.days.has(day) ? day : daily.rows[0].date_utc;
    const provisionalOnly = history.static_detections ||
      (month.activity == null && !month.observed_cell_days && month.provisional_days > 0);
    $("map-layer").value = day ? "detections" : provisionalOnly ? "density" : "overview";
    loadOverview(month);
    await selectBackendDay(preferred, !day);
    if (!active.aborted && day) showTab("map", true);
  } catch (error) {
    if (!active.aborted) {
      if (signal) throw error;
      status("Could not load daily observations. " + error.message, true);
    }
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
  if (!state.backend?.days.has(date)) return;
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
    $("map-layer").value = state.history.published || (!day.standard_platforms.length && day.provisional_platforms.length)
      ? "detections" : "cells";
  }
  status("Loading backend detections for " + date + "…");
  updateDensity();
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
  if (state.tab === "history") return [];
  if (state.tab === "map" && $("map-layer").value === "density") return [];
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

const geographyData = fetchLocal("assets/countries.geojson").then(response => response.json());
geographyData.then(geojson => {
  geography = L.geoJSON(geojson, {
    pane: "basemap", interactive: false, attribution: "Made with Natural Earth",
    style: basemapStyle($("basemap").value)
  }).addTo(map);
  for (const feature of geojson.features) {
    const {ADMIN, CONTINENT, SUBREGION, LABEL_X, LABEL_Y, MIN_LABEL, LABELRANK, NAME} = feature.properties;
    if (NAME && Number.isFinite(LABEL_X) && Number.isFinite(LABEL_Y) && ADMIN !== "Antarctica") {
      countryLabels.push({name: NAME, lat: LABEL_Y, lon: LABEL_X, zoom: Math.max(3, MIN_LABEL), rank: LABELRANK});
    }
    const coordinates = feature.geometry.coordinates.flat(feature.geometry.type === "Polygon" ? 1 : 2);
    for (const name of new Set([ADMIN, CONTINENT, SUBREGION])) {
      if (!name || name === "Seven seas (open ocean)") continue;
      if (!studyAreas.has(name)) studyAreas.set(name, []);
      for (const point of coordinates) studyAreas.get(name).push(point);
    }
  }
  $("area-options").replaceChildren(...[...studyAreas.keys()].sort().map(name => {
    const option = element("option");
    option.value = name;
    return option;
  }));
  countryLabels.sort((a, b) => a.rank - b.rank);
  renderCountryLabels();
}).catch(() => {
  basemapError = true;
  render();
});

function renderCountryLabels() {
  labelLayer.clearLayers();
  const zoom = map.getZoom();
  if ($("basemap").value === "satellite" || zoom < 1.5) return;
  const {x: width, y: height} = map.getSize();
  const occupied = [];
  for (const {name, lat, lon, rank, zoom: minZoom} of countryLabels) {
    if (zoom < minZoom && !(zoom < 3 && rank <= 2 && minZoom <= 4)) continue;
    const {x, y} = map.latLngToContainerPoint([lat, lon]);
    const half = name.length * 3 + 5;
    if (x - half < 0 || x + half > width || y < 9 || y > height - 9 ||
        occupied.some(other => Math.abs(y - other.y) < 15 && Math.abs(x - other.x) < half + other.half)) continue;
    occupied.push({x, y, half});
    L.tooltip({pane: "country-labels", permanent: true, direction: "center", className: "country-label"})
      .setLatLng([lat, lon]).setContent(element("span", name)).addTo(labelLayer);
  }
}

function boundsForArea(points) {
  const longitudes = points.map(([lon]) => lon).sort((a, b) => a - b);
  let largest = longitudes[0] + 360 - longitudes.at(-1);
  let west = longitudes[0], east = longitudes.at(-1), south = 90, north = -90;
  for (let index = 1; index < longitudes.length; index++) {
    const gap = longitudes[index] - longitudes[index - 1];
    if (gap > largest) {
      largest = gap;
      west = longitudes[index];
      east = longitudes[index - 1];
    }
  }
  for (const [, lat] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north].map(value => Number(value.toFixed(5)));
}

function clearDrawPreview() {
  drawPreview?.remove();
  drawPreview = null;
}

function setDrawing(active) {
  $("draw-area").setAttribute("aria-pressed", String(active));
  $("draw-area").textContent = active ? "Cancel drawing" : "Draw on map";
  $("map").classList.toggle("is-drawing", active);
  if (active) {
    map.dragging.disable();
    $("map").focus({preventScroll: true});
    setWheel(false);
  } else {
    map.dragging.enable();
    drawStart = null;
  }
  mapHelp();
}

function drawBounds(event) {
  const end = map.mouseEventToLatLng(event);
  return L.latLngBounds(drawStart, L.latLng(Math.max(-85, Math.min(85, end.lat)),
    Math.max(-180, Math.min(180, end.lng))));
}

const mapElement = $("map");
mapElement.addEventListener("pointerdown", event => {
  if ($("draw-area").getAttribute("aria-pressed") !== "true" || event.button !== 0 ||
      event.target.closest(".leaflet-control")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  clearDrawPreview();
  const {lat, lng} = map.mouseEventToLatLng(event);
  drawStart = L.latLng(Math.max(-85, Math.min(85, lat)), Math.max(-180, Math.min(180, lng)));
  mapElement.setPointerCapture(event.pointerId);
  drawPreview = L.rectangle([drawStart, drawStart], {color: "#a5eeaa", weight: 2, fillOpacity: .12, interactive: false}).addTo(map);
}, true);
mapElement.addEventListener("pointermove", event => {
  if (drawStart) drawPreview.setBounds(drawBounds(event));
});
mapElement.addEventListener("pointerup", event => {
  if (!drawStart) return;
  const box = drawBounds(event);
  setDrawing(false);
  const bounds = [box.getWest(), box.getSouth(), box.getEast(), box.getNorth()].map(value => Number(value.toFixed(5)));
  if (bounds[0] === bounds[2] || bounds[1] === bounds[3]) {
    clearDrawPreview();
    return;
  }
  drawPreview.setBounds(box);
  $("area-search").value = "";
  $("archive-bounds").value = bounds.join(", ");
  $("archive-bounds").focus({preventScroll: true});
});
mapElement.addEventListener("pointercancel", () => {
  if (!drawStart) return;
  setDrawing(false);
  clearDrawPreview();
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
  refreshMapExport();
  pointLayer.clearLayers();
  focusLayer.clearLayers();
  boundary.setLatLngs(areaOutline(activeBounds()));
  const wholeFootprint = state.history?.has_footprint && activeBounds().join() === state.history.archive_bbox.join();
  boundary.setStyle({opacity: state.backend && !wholeFootprint && !isWorld(activeBounds()) ? 0.85 : 0});
  $("density-map").hidden = $("map-layer").value !== "density";
  if (state.history && $("map-layer").value === "overview") {
    renderOverview(points);
    return;
  }
  if ($("map-layer").value === "density") {
    renderDensity();
    $("legend").replaceChildren(element("span", "Relative detection density"),
      element("i", "", "heat-ramp density-ramp"), element("span", "Low to high"));
    if (state.history) {
      const loaded = densityData?.points?.some(point => selectedSensors().includes(point.sensor));
      if (!loaded) $("map-scope").textContent = state.selected + " UTC · " +
        (densityData?.error ?? (densityData ? "No detections reported for the selected sensors" : "Loading detection density…"));
    }
    return;
  }
  const showCells = state.history && $("map-layer").value === "cells";
  if (showCells) {
    for (const cell of visibleCells()) {
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

function visibleCells() {
  return state.cells.filter(cell => cell.platforms.some(platform => {
    const sensor = platform === "Terra" || platform === "Aqua" ? "MODIS" : "VIIRS";
    return state.sensor === "both" || state.sensor === sensor;
  }));
}

function boundsSpan([west, south, east, north]) {
  return Math.max(north - south, (east - west + 360) % 360 || 360);
}

function updateDensity() {
  if (!state.history || $("map-layer").value !== "density" || !state.selected) return;
  const span = boundsSpan(activeBounds());
  const step = span <= 10 ? "0.1" : span <= 35 ? "0.25" : "1";
  const url = archiveUrl("/api/density", {date: state.selected, step});
  if (url === densityKey) return;
  densityRequest?.abort();
  const request = new AbortController();
  densityRequest = request;
  densityKey = url;
  densityData = null;
  fetchApi(url, request.signal).then(result => {
    if (request.signal.aborted) return;
    if (result.metadata.date_utc !== state.selected) return;
    if (result.metadata.data_version !== state.backend.data_version) throw new Error("The archive changed. Reload the calendar.");
    densityData = {step: result.metadata.step_degrees, points: result.features.map(({geometry, properties}) => ({
      lat: geometry.coordinates[1], lon: geometry.coordinates[0], ...properties
    }))};
  }).catch(error => {
    if (!request.signal.aborted) densityData = {error: error.message};
  }).finally(() => {
    if (!request.signal.aborted && state.tab === "map" && $("map-layer").value === "density") render();
  });
}

function renderDensity() {
  const canvas = $("density-map");
  if (canvas.hidden || state.tab !== "map") return;
  const {x: width, y: height} = map.getSize();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  const buckets = new Map();
  const global = state.history && isWorld(activeBounds()) && map.getZoom() < 4;
  const spacing = global ? 6 : 10;
  const points = state.history ? densityData?.points ?? [] : visible;
  const filters = selectedSensors();
  for (const point of points) {
    if (!filters.includes(point.sensor)) continue;
    const {x, y} = map.latLngToContainerPoint([point.lat, point.lon]);
    if (x < -24 || x > width + 24 || y < -24 || y > height + 24) continue;
    const cx = Math.round(x / spacing) * spacing, cy = Math.round(y / spacing) * spacing;
    const key = cx + "," + cy;
    if (!buckets.has(key)) buckets.set(key, {cx, cy, count: 0});
    buckets.get(key).count += point.count ?? 1;
  }
  let max = 1;
  for (const {count} of buckets.values()) max = Math.max(max, count);
  for (const {cx, cy, count} of [...buckets.values()].sort((a, b) => a.count - b.count)) {
    const strength = Math.log1p(count) / Math.log1p(max);
    const radius = global ? 5 + 7 * strength : 10 + 10 * strength;
    const gradient = context.createRadialGradient(cx, cy, 1, cx, cy, radius);
    const warmth = Math.round(95 + 142 * strength);
    const intensity = .26 + .69 * strength;
    gradient.addColorStop(0, "rgba(255," + warmth + ",100," + intensity + ")");
    gradient.addColorStop(.3, "rgba(243,96,59," + intensity * .62 + ")");
    gradient.addColorStop(1, "rgba(190,43,61,0)");
    context.fillStyle = gradient;
    context.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
}

const heatColors = ["#245654", "#4c8e67", "#b8aa52", "#f28c47", "#fc573e"];

function renderOverview(points) {
  const legend = $("legend");
  const byPercentile = $("overview-metric").value === "percentile";
  const features = overviewData?.features ?? [];
  const maximum = features.reduce((max, {properties: row}) => Math.max(max, row.activity ?? row.observed_cell_days), 1);
  const observed = features.length && features.every(({properties}) => properties.activity == null);
  const metric = observed ? "Observed cell-days" : "Comparable cell-days";
  const levels = byPercentile ? percentileLevels : heatColors.map((color, index) => ({
    color,
    label: index ? "≥ " + number.format(Math.expm1(Math.log1p(maximum) * index / heatColors.length)) : "Low"
  }));
  legend.replaceChildren(element("span", byPercentile ? "Monthly percentile" : metric));
  for (const level of levels) {
    const item = element("span");
    const dot = element("i", "", "dot");
    dot.style.color = level.color;
    item.append(dot, document.createTextNode(level.label));
    legend.append(item);
  }
  if (state.selected) {
    const dots = element("div", "", "legend overview-dots");
    let label = "Fire detection dots · " + state.selected + " UTC";
    if (selectedSensors().some(sensor => state.offsets[sensor] != null)) label += " · loaded records";
    if (!points.length && !state.mapPending) label += " · none plotted";
    dots.append(element("span", label));
    for (const sensor of selectedSensors()) {
      const item = element("span", "", sensor.toLowerCase());
      item.append(element("i", "", "dot"), document.createTextNode(sensor));
      dots.append(item);
    }
    legend.append(dots);
  }
  $("map-scope").textContent = monthName.format(new Date(state.month)) + " · " +
    (overviewData?.error ?? (!overviewData ? "Loading monthly activity…" : features.length
      ? (overviewData.metadata.complete_month ? "Monthly activity by grid region" : "Partial month · percentile unavailable")
      : "No standard-processing activity reported for this selection"));
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    const row = feature.properties;
    const level = percentileLevel(row.historical_percentile);
    const activity = row.activity ?? row.observed_cell_days;
    if (!byPercentile && !activity) continue;
    const index = Math.min(heatColors.length - 1, Math.floor(heatColors.length * Math.log1p(activity) / Math.log1p(maximum)));
    const color = byPercentile ? level.color : heatColors[index];
    const style = {fillColor: color, fillOpacity: byPercentile ? .24 : .15 + index * .05,
      color, opacity: .45, weight: .65};
    const ring = row.boundary?.map(([x, y]) => [y, x]);
    const rings = ring ? [ring] : [];
    if (ring?.some(([, x]) => x > 180)) rings.push(ring.map(([y, x]) => [y, x - 360]));
    if (ring?.some(([, x]) => x < -180)) rings.push(ring.map(([y, x]) => [y, x + 360]));
    const shape = rings.length ? L.polygon(rings.map(r => [r]), style) : L.circleMarker([lat, lon], {...style, radius: 6});
    shape.bindPopup(() => {
      const popup = element("div");
      popup.append(element("strong", level.label));
      popup.append(element("div", number.format(Math.round(activity)) +
        (row.activity == null ? " observed cell-days" : " comparable cell-days")));
      if (row.historical_percentile != null) popup.append(element("div",
        formatPercentile(row.historical_percentile) + " across " + row.baseline_years +
        " years · median " + number.format(Math.round(row.historical_median))));
      if (isWorld(state.history.archive_bbox)) {
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
  const light = $("basemap").value === "light";
  const radius = map.getZoom() < 4 ? 1.5 : 2.3;
  for (const point of points) {
    L.circleMarker([point.lat, point.lon], {radius, interactive: false, weight: .65,
      color: light ? "#fffaf0" : "#121c1a", fillColor: light
        ? (point.sensor === "MODIS" ? "#a6411d" : "#066c83") : colors[point.sensor], fillOpacity: .86}).addTo(pointLayer);
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
    ? "Study bounds (west, south, east, north) " + bounds + ". " +
      (state.backend.area_coverage === "partial" ? "Data cover the portion inside the solid archive outline. " : "") +
      "Satellite observation coverage is unknown."
    : "";
  $("download-csv").disabled = !visible.length;
  $("download-csv").textContent = state.history && selectedSensors().some(sensor => state.offsets[sensor] != null)
    ? "Download loaded detections" : "Download filtered CSV";
  $("download-json").disabled = !visible.length;
  $("download-json").textContent = selectedSensors().some(sensor => state.offsets[sensor] != null)
    ? "Download loaded JSON" : "Download filtered JSON";
  $("archive-panel").hidden = !state.history;
  $("percentile-panel").hidden = !state.history && !!state.backend;
  $("jump-to-percentile").hidden = !state.history;
  $("calendar-shortcut").href = state.history ? "#archive-title" : "#calendar-title";
  $("archive-selection").hidden = !state.history;
  $("map-layer-control").hidden = !state.backend;
  for (const option of $("map-layer").options) {
    option.hidden = option.disabled = (option.value === "overview" && (!state.history || state.history.static_detections)) ||
      (option.value === "cells" && (!state.history || state.history.published));
  }
  $("overview-metric-control").hidden = !state.history || $("map-layer").value !== "overview";
  $("map-selection-summary").textContent = state.backend
    ? (state.history ?? state.backend).start + " through " + dateOffset((state.history ?? state.backend).end_exclusive, -1) + " UTC"
    : "";
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
  window.dispatchEvent(new Event("hotspot:state"));
}

function csvCell(value) {
  if (value == null) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
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

function downloadFile(contents, type, name) {
  const url = URL.createObjectURL(new Blob([contents], {type}));
  const link = element("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportScope() {
  const scope = state.history ?? state.backend;
  return {area: state.backend.area, bbox: scope.bbox, data_version: scope.data_version,
    start: scope.start, end_exclusive: scope.end_exclusive};
}

function bindDataExport(id, getData) {
  const form = $(id);
  const button = form.querySelector("button");
  const buttonLabel = button.textContent;
  const getSelection = () => getData(form.elements.dataset?.value);
  const refresh = () => {
    const data = getSelection();
    button.disabled = !data;
    button.textContent = data?.complete === false ? "Export loaded rows" : buttonLabel;
  };
  form.addEventListener("change", refresh);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = getSelection();
    if (!data) return;
    const {name, rows, ...metadata} = data;
    const records = rows();
    if (form.elements.format.value === "json") {
      downloadFile(JSON.stringify({...exportScope(), ...metadata, rows: records}, null, 2), "application/json", name + ".json");
    } else {
      const {area, data_version} = exportScope();
      const scope = metadata.complete == null ? {area, data_version} : {area, data_version, complete: metadata.complete};
      const columns = Object.keys(records[0]);
      const table = [[...columns, ...Object.keys(scope)],
        ...records.map(record => [...columns.map(column => record[column]), ...Object.values(scope)])];
      downloadFile(table.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n",
        "text/csv;charset=utf-8", name + ".csv");
    }
  });
  return refresh;
}

function detectionRecord(point) {
  return {date_utc: point.date, time_utc: point.time, sensor: point.sensor, satellite: point.satellite,
    latitude: point.lat, longitude: point.lon, confidence: point.confidence, frp_mw: point.frp,
    processing: point.processing, eligible_for_index: point.eligible};
}

const refreshMapExport = bindDataExport("map-export", selection => {
  if (!state.backend) return null;
  const included = selectedSensors();
  if (selection === "daily") {
    return {name: "daily-calendar", sensors: included, start: state.backend.start, end_exclusive: state.backend.end_exclusive,
      rows: () => state.backend.rows.map(row => ({
      date_utc: row.date_utc, observed_cell_days: row.observed_cell_days ?? null,
      ...Object.fromEntries(included.map(sensor => [sensor.toLowerCase() + "_detections", row.sensor_detections[sensor] ?? null]))
    }))};
  }
  const layer = selection === "points" ? "detections" : $("map-layer").value;
  if (layer === "overview") {
    if (!overviewData?.features?.length) return null;
    return {name: "monthly-map-" + state.month.slice(0, 7), month: state.month, layer,
      complete_month: overviewData.metadata.complete_month,
      rows: () => overviewData.features.map(({geometry, properties}) => ({
        month_utc: state.month, latitude: geometry.coordinates[1], longitude: geometry.coordinates[0],
        ...properties
      }))};
  }
  if (layer === "density" && state.history) {
    if (!densityData?.points?.some(point => included.includes(point.sensor))) return null;
    return {name: "detection-density-" + state.selected, date_utc: state.selected, layer,
      grid_step_degrees: densityData.step, sensors: included,
      rows: () => densityData.points.filter(point => included.includes(point.sensor)).map(point => ({
        date_utc: state.selected, sensor: point.sensor, latitude: point.lat, longitude: point.lon, count: point.count
      }))};
  }
  if (layer === "cells") {
    const cells = visibleCells();
    if (!cells.length) return null;
    const complete = state.offsets.cells == null;
    return {name: (complete ? "active-cells-" : "loaded-active-cells-") + state.selected, date_utc: state.selected,
      layer, complete, sensors: included, rows: () => cells.map(cell => ({
        date_utc: cell.date, cell: cell.cell, latitude: cell.lat, longitude: cell.lon, platforms: cell.platforms
      }))};
  }
  if (!visible.length) return null;
  const complete = included.every(sensor => state.offsets[sensor] == null);
  return {name: (complete ? "map-detections-" : "map-loaded-detections-") + state.selected,
    date_utc: state.selected, layer, sensors: included, complete, rows: () => visible.map(detectionRecord)};
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme-toggle").setAttribute("aria-pressed", String(theme === "dark"));
  $("theme-label").textContent = theme === "dark" ? "Dark" : "Light";
  $("theme-icon").textContent = theme === "dark" ? "☾" : "☀";
  if ($("basemap").value !== "satellite") setBasemap(theme);
  if (state.backend && state.tab === "map") renderMap(visible);
  window.dispatchEvent(new CustomEvent("hotspot:theme", {detail: theme}));
}

$("theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  try {
    localStorage.setItem("hotspot-theme", theme);
  } catch {}
  applyTheme(theme);
});

$("download-csv").addEventListener("click", () => downloadFile(exportCsv(), "text/csv;charset=utf-8", "detections.csv"));
$("download-json").addEventListener("click", () => downloadFile(JSON.stringify({
  date_utc: state.selected, bbox: activeBounds(), data_version: state.backend.data_version,
  sensors: selectedSensors(), complete: selectedSensors().every(sensor => state.offsets[sensor] == null),
  detections: visible
}, null, 2), "application/json", "detections-" + state.selected + ".json"));

$("retry-data").addEventListener("click", () => {
  densityKey = null;
  loadBackend(state.selection, state.history?.areaLabel);
});
$("fetch-next").addEventListener("click", loadMoreMap);
$("map-layer").addEventListener("change", () => {
  updateDensity();
  render();
  loadOverview(state.history?.rows.find(row => row.date_utc === state.month));
});
$("overview-metric").addEventListener("change", () => renderMap(visible));
$("archive-dataset").addEventListener("change", () => {
  loadBackend();
});
$("archive-selection").addEventListener("submit", event => {
  event.preventDefault();
  clearDrawPreview();
  const areaLabel = [...studyAreas.keys()].find(name => name.toLowerCase() === $("area-search").value.trim().toLowerCase());
  loadBackend({bbox: $("archive-bounds").value, start: $("archive-start").value, end: dateOffset($("archive-end").value, 1)}, areaLabel);
});
$("archive-reset").addEventListener("click", () => {
  clearDrawPreview();
  loadBackend();
});
$("area-search").addEventListener("input", event => {
  const input = event.target.value.trim().toLowerCase();
  const name = [...studyAreas.keys()].find(value => value.toLowerCase() === input);
  if (!name) return;
  clearDrawPreview();
  $("archive-bounds").value = boundsForArea(studyAreas.get(name)).join(", ");
});
$("archive-bounds").addEventListener("input", () => {
  $("area-search").value = "";
  clearDrawPreview();
});
$("draw-area").addEventListener("click", () => {
  const active = $("draw-area").getAttribute("aria-pressed") !== "true";
  if (!active) clearDrawPreview();
  setDrawing(active);
});
$("archive-year").addEventListener("change", event => {
  const rows = state.history.rows.filter(row => row.date_utc.startsWith(event.target.value));
  renderArchive();
  selectArchiveMonth(firstCalendarMonth(rows));
});
$("archive-months").addEventListener("click", event => {
  const day = event.target.closest("[data-month]")?.dataset.month;
  if (day) selectArchiveMonth(state.history.rows.find(row => row.date_utc === day));
});
$("open-month-map").addEventListener("click", () => {
  const month = state.history?.rows.find(row => row.date_utc === state.month);
  if (!month) return;
  $("map-layer").value = state.history.static_detections ||
    (month.activity == null && !month.observed_cell_days && month.provisional_days > 0) ? "density" : "overview";
  updateDensity();
  loadOverview(month);
  showTab("map", true);
  $("map").scrollIntoView({block: "center"});
  render();
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
  selectBackendDay(date, $("map-layer").value === "overview");
  $("calendar").querySelector('[data-date="' + date + '"]')?.focus({preventScroll: true});
});
$("previous").addEventListener("click", () => { state.page--; renderDetails(); });
$("next").addEventListener("click", () => { state.page++; renderDetails(); });

const tabs = ["map", "detections", "compare", "history"];
const openFilters = new Map();
const tabBar = document.querySelector(".tabs");
let tabAnimation;
let tabSwipe;

function positionTabIndicator() {
  const button = $(state.tab + "-tab");
  tabBar.style.setProperty("--indicator-x", button.offsetLeft + "px");
  tabBar.style.setProperty("--indicator-y", button.offsetTop + "px");
  tabBar.style.setProperty("--indicator-width", button.offsetWidth + "px");
  tabBar.style.setProperty("--indicator-height", button.offsetHeight + "px");
  tabBar.classList.add("has-indicator");
}

function placeArchivePanels(tab) {
  $(tab + "-calendar").append($("archive-panel"));
  $(tab + "-percentiles").append($("percentile-panel"));
  $("open-month-map").hidden = tab === "map";
}

function showTab(tab, focusTab = false) {
  let direction = 0;
  if (tab !== state.tab) {
    direction = Math.sign(tabs.indexOf(tab) - tabs.indexOf(state.tab));
    tabAnimation?.cancel();
    openFilters.set(state.tab, $("explorer-filters").open);
    state.tab = tab;
    for (const id of tabs) {
      const active = id === tab;
      $(id + "-tab").setAttribute("aria-selected", String(active));
      $(id + "-tab").tabIndex = active ? 0 : -1;
      $(id + "-panel").hidden = !active;
    }
    positionTabIndicator();
    $("view-filters").hidden = tab === "map";
    (tab === "map" ? $("map-workspace") : $("view-filters")).append($("explorer-filters"));
    $("explorer-filters").open = openFilters.get(tab) ?? false;
    if (tab === "map" || tab === "history") {
      placeArchivePanels(tab);
      if (state.history) renderArchive();
    }
    $("draw-area").hidden = tab !== "map";
    $("sensor-control").hidden = tab === "history" || tab === "compare";
    if (tab === "map") {
      map.invalidateSize({pan: true});
      if (fitOnShow) {
        fitOnShow = false;
        fitArea();
      }
      renderMap(visible);
    } else {
      setDrawing(false);
      setWheel(false);
    }
  }
  if (tab === "compare") window.dispatchEvent(new Event("hotspot:compare"));
  $("fetch-next").hidden = !state.history || !nextMapKeys().length;
  $("fetch-next").textContent = tab === "map" && $("map-layer").value === "cells"
    ? "Load more active cells" : "Load more detections";
  window.dispatchEvent(new Event("hotspot:state"));
  if (focusTab) $(tab + "-tab").focus();
  if (direction && !motionPreference.matches) {
    tabAnimation = $(tab + "-panel").animate([
      {opacity: .76, transform: "translateX(" + direction * 12 + "px)"},
      {opacity: 1, transform: "translateX(0)"}
    ], {duration: 265, easing: "cubic-bezier(.2,.72,.22,1)"});
  }
}

function resizeMap() {
  if (state.tab !== "map") return;
  map.invalidateSize({pan: true});
  renderCountryLabels();
  renderDensity();
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

const workspace = $("workspace");
workspace.addEventListener("touchstart", event => {
  tabSwipe = null;
  if (event.touches.length !== 1) return;
  const {identifier, clientX, clientY} = event.touches[0];
  const target = event.target;
  if (!tabBar.contains(target)) {
    if (!target.closest('[role="tabpanel"]') ||
        target.closest("a, button, input, select, summary, label, textarea, canvas, [contenteditable], " +
          ".leaflet-container, .chart-scroll, .week-scroll, #calendar, #percentile-chart, #details")) return;
    if (clientX < 24 || clientX > innerWidth - 24) return;
  }
  tabSwipe = {identifier, clientX, clientY, tab: state.tab, time: performance.now()};
}, {passive: true});
workspace.addEventListener("touchcancel", () => { tabSwipe = null; }, {passive: true});
workspace.addEventListener("touchend", event => {
  const start = tabSwipe;
  tabSwipe = null;
  if (!start || start.tab !== state.tab || event.touches.length || performance.now() - start.time > 900) return;
  const end = Array.from(event.changedTouches).find(touch => touch.identifier === start.identifier);
  if (!end) return;
  const dx = end.clientX - start.clientX;
  const dy = end.clientY - start.clientY;
  if (Math.abs(dx) < 55 || Math.abs(dx) < 1.45 * Math.abs(dy)) return;
  const next = tabs[tabs.indexOf(state.tab) - Math.sign(dx)];
  if (!next) return;
  if (event.cancelable) event.preventDefault();
  showTab(next);
  if (tabBar.getBoundingClientRect().top < 0) tabBar.scrollIntoView({block: "start"});
});
motionPreference.addEventListener("change", event => {
  if (event.matches) tabAnimation?.cancel();
});
new ResizeObserver(positionTabIndicator).observe(tabBar);
positionTabIndicator();

$("basemap").addEventListener("change", event => {
  setBasemap(event.target.value);
  renderMap(visible);
});
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
    if ($("draw-area").getAttribute("aria-pressed") === "true") {
      setDrawing(false);
      clearDrawPreview();
    }
    setWheel(false);
  }
});
map.on("moveend", mapHelp);
map.on("moveend", renderCountryLabels);
map.on("moveend", () => renderDensity());
map.on("zoomend", () => loadOverview(state.history?.rows.find(row => row.date_utc === state.month)));
new ResizeObserver(resizeMap).observe($("map"));

$("explorer-filters").open = !matchMedia("(max-width: 860px)").matches;
placeArchivePanels("map");
applyTheme(document.documentElement.dataset.theme ?? "dark");
render();
fetchApi("/api/archives").then(archives => {
  $("archive-dataset").replaceChildren(...archives.map(archive => new Option(archive.name, archive.id)));
  $("archive-choice").hidden = archives.length < 2;
}).catch(() => {}).finally(() => loadBackend());
