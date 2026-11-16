"use strict";

(() => {
  const narrow = matchMedia("(max-width: 700px)");
  const views = new Map();
  let activeSensor = "MODIS";
  let lastArea = "";
  let syncing = false;

  function createViews() {
    for (const sensor of sensors) {
      const target = $("compare-map-" + sensor.toLowerCase());
      const view = L.map(target, {
        minZoom: 0, maxZoom: 15, zoomSnap: .25, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1,
        attributionControl: true, preferCanvas: true, scrollWheelZoom: false,
        zoomAnimation: false, fadeAnimation: !reducedMotion
      });
      view.attributionControl.setPrefix(false);
      view.createPane("comparison-basemap").style.zIndex = "220";
      view.createPane("comparison-imagery").style.zIndex = "225";
      view.createPane("detail-imagery").style.zIndex = "230";
      const imagery = [
        L.imageOverlay(globalImageUrl, globalImagery.getBounds(), {pane: "comparison-imagery", attribution: "NASA EOSDIS GIBS"}),
        L.imageOverlay(scene.image, sceneBounds, {pane: "detail-imagery", attribution: "NASA EOSDIS GIBS"})
      ];
      const outline = L.polyline(areaOutline(region), {
        color: "#fff", opacity: .8, weight: 1, dashArray: "4 5", fill: false, interactive: false
      }).addTo(view);
      const points = L.layerGroup().addTo(view);
      view.setView([38, -119], 5, {animate: false});
      const entry = {view, outline, points, target, imagery};
      views.set(sensor, entry);
      geographyData.then(geojson => {
        entry.geography = L.geoJSON(geojson, {pane: "comparison-basemap", interactive: false, attribution: "Made with Natural Earth",
          style: basemapStyle($("compare-basemap").value)}).addTo(view);
      }).catch(() => {});
      view.on("moveend", () => {
        if (syncing) return;
        const other = views.get(sensor === "MODIS" ? "VIIRS" : "MODIS")?.view;
        if (!other) return;
        syncing = true;
        other.setView(view.getCenter(), view.getZoom(), {animate: false});
        syncing = false;
      });
      new ResizeObserver(() => {
        if (target.offsetWidth && target.offsetHeight) view.invalidateSize({pan: true});
      }).observe(target);
    }
  }

  function setComparisonBasemap() {
    const choice = $("compare-basemap").value;
    for (const {view, target, imagery, geography} of views.values()) {
      target.dataset.basemap = choice;
      geography?.setStyle(basemapStyle(choice));
      for (const layer of imagery) {
        if (choice === "satellite") layer.addTo(view);
        else layer.remove();
      }
    }
    $("compare-visual-note").textContent = choice === "satellite"
      ? "Satellite imagery: VIIRS · " + scene.date + " · Blue Marble fills gaps."
      : "Pan or zoom either map to update both.";
  }

  function fitComparison() {
    const {view} = views.get(narrow.matches ? activeSensor : "MODIS");
    view.invalidateSize({pan: true});
    view.fitBounds(asLeafletBounds(activeBounds()), {padding: [20, 20], maxZoom: 10, animate: false});
  }

  function renderSensors() {
    if (!views.size) {
      createViews();
      setComparisonBasemap();
    }
    const bounds = activeBounds();
    const dates = state.backend ? [...state.backend.days.keys()].sort() : [];
    const dateSelect = $("compare-date");
    if (Array.from(dateSelect.options, option => option.value).join() !== dates.join()) {
      dateSelect.replaceChildren(...dates.map(date => new Option(date, date)));
    }
    dateSelect.value = state.selected;
    dateSelect.disabled = !dates.length;
    $("compare-fit").disabled = !dates.length;
    $("sensor-scope").textContent = state.backend ? state.backend.area + " · " + state.selected + " UTC"
      : "Sensor comparison will appear when the backend is connected.";
    const counts = state.backend?.days.get(state.selected);
    for (const [sensor, {points, outline}] of views) {
      const count = counts?.[sensor];
      const displayed = state.points.filter(point => point.sensor === sensor).length;
      $("compare-" + sensor.toLowerCase()).textContent = count == null ? "Unavailable" : number.format(count) +
        (state.offsets[sensor] != null ? " · " + number.format(displayed) + " plotted" : "");
      points.clearLayers();
      for (const point of state.points) {
        if (point.sensor === sensor) mapPoint(point).addTo(points);
      }
      outline.setLatLngs(areaOutline(bounds));
      outline.setStyle({opacity: state.backend && !isWorld(bounds) ? 0.8 : 0});
    }
    const signature = bounds.join(",");
    if (signature !== lastArea) fitComparison();
    lastArea = signature;
  }

  window.addEventListener("hotspot:compare", renderSensors);
  $("compare-basemap").value = document.documentElement.dataset.theme ?? "dark";
  window.addEventListener("hotspot:theme", event => {
    if ($("compare-basemap").value === "satellite") return;
    $("compare-basemap").value = event.detail;
    if (views.size) setComparisonBasemap();
  });
  $("compare-date").addEventListener("change", event =>
    selectBackendDay(event.target.value, $("map-layer").value === "overview"));
  $("compare-basemap").addEventListener("change", setComparisonBasemap);
  $("compare-fit").addEventListener("click", fitComparison);

  function resizeComparison() {
    if (state.tab !== "compare") return;
    for (const {view, target} of views.values()) {
      if (target.offsetWidth) view.invalidateSize({pan: true});
    }
  }

  for (const button of document.querySelectorAll("[data-compare-view]")) {
    button.addEventListener("click", () => {
      const previous = views.get(activeSensor).view;
      const center = previous.getCenter();
      const zoom = previous.getZoom();
      activeSensor = button.dataset.compareView;
      $("compare-maps").dataset.active = activeSensor;
      for (const option of document.querySelectorAll("[data-compare-view]")) {
        option.setAttribute("aria-pressed", String(option === button));
      }
      const selected = views.get(activeSensor).view;
      selected.invalidateSize({pan: true});
      selected.setView(center, zoom, {animate: false});
    });
  }
  narrow.addEventListener("change", resizeComparison);
})();
