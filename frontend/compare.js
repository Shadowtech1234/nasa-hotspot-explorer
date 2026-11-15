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
        minZoom: 2, maxZoom: 15, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1,
        attributionControl: true, preferCanvas: true, scrollWheelZoom: false,
        zoomAnimation: false, fadeAnimation: !reducedMotion
      });
      view.attributionControl.setPrefix(false);
      view.createPane("detail-imagery").style.zIndex = "210";
      const attribution = "NASA EOSDIS GIBS";
      L.imageOverlay(globalImageUrl, globalImagery.getBounds(), {attribution}).addTo(view);
      L.imageOverlay(scene.image, sceneBounds, {pane: "detail-imagery", attribution}).addTo(view);
      const outline = L.rectangle(asLeafletBounds(region), {
        color: "#fff", opacity: .8, weight: 1, dashArray: "4 5", fill: false, interactive: false
      }).addTo(view);
      const points = L.layerGroup().addTo(view);
      view.setView([38, -119], 5, {animate: false});
      views.set(sensor, {view, outline, points, target});
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

  function fitComparison() {
    const {view} = views.get(narrow.matches ? activeSensor : "MODIS");
    view.invalidateSize({pan: true});
    view.fitBounds(asLeafletBounds(activeBounds()), {padding: [20, 20], maxZoom: 10, animate: false});
  }

  function renderSensors() {
    if (!views.size) createViews();
    const bounds = activeBounds();
    const dates = state.result ? [...state.result.days.keys()].sort() : [];
    const dateSelect = $("compare-date");
    if (Array.from(dateSelect.options, option => option.value).join() !== dates.join()) {
      dateSelect.replaceChildren(...dates.map(date => new Option(date, date)));
    }
    dateSelect.value = state.selected;
    dateSelect.disabled = !dates.length;
    $("compare-fit").disabled = !dates.length;
    $("sensor-scope").textContent = state.result ? selection.area + " · " + sourceLabel()
      : "Sensor comparison will appear after you select an area and dates.";
    $("compare-visual-note").textContent = "Imagery: VIIRS · " + scene.date +
      " · Blue Marble fills gaps. The observation date controls detections.";
    const counts = state.result?.days.get(state.selected);
    const partial = state.result?.partialByDay.get(state.selected);
    for (const [sensor, {points, outline}] of views) {
      const count = counts?.[sensor];
      $("compare-" + sensor.toLowerCase()).textContent = count == null ? "Unavailable"
        : number.format(count) + (partial?.includes(sensor) ? " (partial)" : "");
      points.clearLayers();
      for (const point of state.points) {
        if (point.sensor === sensor) mapPoint(point).addTo(points);
      }
      outline.setBounds(asLeafletBounds(bounds));
      outline.setStyle({opacity: state.result && fixedBounds ? 0.8 : 0});
    }
    const signature = bounds.join(",");
    if (signature !== lastArea) fitComparison();
    lastArea = signature;
  }

  window.addEventListener("hotspot:compare", renderSensors);
  $("compare-date").addEventListener("change", event => selectDay(event.target.value));
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
