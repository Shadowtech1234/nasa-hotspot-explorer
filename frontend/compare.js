"use strict";

(() => {
  const demoBounds = [-125, 32, -114, 42];
  const demoDate = "2026-11-10";
  const narrow = matchMedia("(max-width: 700px)");
  const views = new Map();
  let activeSensor = "MODIS";
  let lastArea = "";
  let lastTeam;
  let sensorDate = "";
  let comparison;
  let demo;
  let syncing = false;

  function briefingRows(result) {
    return [
      ["Selected week", result.start, result.end, result.total],
      ...result.prior.map(week => [String(week.year), week.start, week.end, week.total])
    ];
  }

  function compareTable(headers, rows) {
    const table = element("table");
    const heading = table.createTHead().insertRow();
    for (const title of headers) {
      const cell = element("th", title);
      cell.scope = "col";
      heading.append(cell);
    }
    const body = table.createTBody();
    for (const values of rows) {
      const row = body.insertRow();
      for (const value of values) row.insertCell().textContent = value;
    }
    return table;
  }

  function createViews() {
    for (const sensor of data.sensors) {
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
      const outline = L.rectangle(asLeafletBounds(demoBounds), {
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

  function studyBounds() {
    if (demo) return demoBounds;
    return state.mode === "harmonized" ? state.team.bounds : state.bounds;
  }

  function fitComparison() {
    const {view} = views.get(narrow.matches ? activeSensor : "MODIS");
    view.invalidateSize({pan: true});
    view.fitBounds(asLeafletBounds(studyBounds()), {padding: [20, 20], maxZoom: 10, animate: false});
  }

  function renderSensors() {
    if (!views.size) createViews();
    const bounds = studyBounds();
    const area = demo ? "California study box" : state.mode === "harmonized" ? state.team.area :
      state.follow ? "Study area from Map & Calendar" : state.area;
    const dates = Array.from((demo?.raw || state.raw).keys()).sort();
    if (!sensorDate && dates.length) {
      sensorDate = state.selected && state.raw.has(state.selected) ? state.selected : dates.at(-1);
    }
    $("compare-date").value = sensorDate;
    $("compare-date").disabled = !dates.length;
    $("compare-fit").disabled = !dates.length;
    $("sensor-scope").textContent = area + " · " + (demo?.source || state.rawSource || "No FIRMS data loaded");
    $("compare-visual-note").textContent = "Imagery: VIIRS · " + scene.date +
      " · Blue Marble fills gaps. The observation date controls detections.";
    $("compare-fit").textContent = demo ? "Fit California study box" : "Fit study area";
    const records = (demo?.raw || state.raw).get(sensorDate);
    for (const [sensor, {points, outline}] of views) {
      const rows = records?.[sensor] || [];
      const matching = rows.filter(point => data.contains(bounds, point));
      $("compare-" + sensor.toLowerCase()).textContent = rows.length
        ? number.format(matching.length) : "Unknown";
      points.clearLayers();
      for (const point of matching) mapPoint(point).addTo(points);
      outline.setBounds(asLeafletBounds(bounds));
    }
    const signature = bounds.join(",");
    if (signature !== lastArea) fitComparison();
    lastArea = signature;
  }

  function evidence() {
    const node = $("season-evidence");
    node.replaceChildren();
    const team = state.team;
    if (!team) {
      node.append(element("p", "Waiting for a team export with comparable daily counts for one study area."));
      return;
    }
    const dates = Array.from(team.days.keys()).sort();
    node.append(element("p", "Source: " + team.source),
      element("p", "Method: " + team.method),
      element("p", "Count unit: " + (team.countUnit || "Unspecified in export")),
      element("p", "Record span: " + dates[0] + " through " + dates.at(-1) +
        " UTC. Missing dates and null counts are unknown."));
    if (!team.validation.length) {
      node.append(element("p", "The team export does not include overlap-period validation."));
      return;
    }
    const list = element("ul");
    for (const item of team.validation) {
      list.append(element("li", item.metric + " · " + item.value + " · " + item.period + " — " + item.interpretation));
    }
    node.append(list);
  }

  function metric(label, value) {
    const node = element("div", "", "season-metric");
    node.append(element("span", label), element("strong", value));
    return node;
  }

  function inspectDay(date) {
    setMode("harmonized");
    $("start").value = comparison.start;
    $("end").value = comparison.end;
    state.selected = date;
    state.page = 0;
    render();
    showTab("map");
    $("calendar").querySelector('[data-date="' + date + '"]')?.focus();
  }

  function renderSeason() {
    const team = state.team;
    const end = $("season-end");
    const report = $("season-report");
    evidence();
    end.disabled = !team;
    report.hidden = true;
    comparison = null;
    if (!team) {
      $("season-scope").textContent = "Harmonized activity";
      $("season-status").textContent = "Import a historical team JSON export to compare a week with the same dates in previous years.";
      return;
    }
    if (lastTeam !== team) {
      lastTeam = team;
      const dates = Array.from(team.days.keys()).sort();
      end.min = dates[0];
      end.max = dates.at(-1);
      end.value = end.max;
    }
    $("season-scope").textContent = team.area + " · " + (team.countUnit || "Harmonized counts");
    const result = data.seasonalComparison(team.days, end.value);
    if (result.error) {
      $("season-status").textContent = result.error;
      return;
    }
    comparison = result;
    report.hidden = false;
    const position = result.total > result.max ? "Above" : result.total < result.min ? "Below" : "Within";
    $("season-status").textContent = position + " the observed historical range for these dates · " +
      result.start + " to " + result.end + " UTC · " + result.prior.length + " complete prior weeks.";
    $("season-metrics").replaceChildren(metric("Selected week", number.format(result.total)),
      metric("Historical median", number.format(result.median)),
      metric("Historical range", number.format(result.min) + "–" + number.format(result.max)));
    const rows = briefingRows(result);
    const max = Math.max(1, result.total, result.max);
    $("season-chart").replaceChildren(...rows.map(([label, , , total], index) => {
      const row = element("div", "", "season-bar" + (index === 0 ? " is-current" : ""));
      const track = element("div", "", "season-track");
      const fill = element("div");
      fill.style.width = (total / max * 100) + "%";
      track.append(fill);
      row.append(element("span", label), track, element("strong", number.format(total)));
      return row;
    }));
    $("season-values").replaceChildren(compareTable(["Period", "Start (UTC)", "End (UTC)", "Total"], rows));
    $("season-days").replaceChildren(...result.observations.map(({date, count}) => {
      const button = element("button", date.slice(5) + " · " + number.format(count));
      button.type = "button";
      button.setAttribute("aria-label", "Inspect " + date + " UTC, count " + count);
      button.addEventListener("click", () => inspectDay(date));
      return button;
    }));
  }

  function downloadBriefing() {
    if (!comparison) return;
    const result = comparison;
    const team = state.team;
    const rows = [
      ["period", "start_utc", "end_utc", "weekly_total", "historical_median", "historical_min", "historical_max",
        "reported_days", "area", "west", "south", "east", "north", "count_unit", "source", "method"],
      ...briefingRows(result).map((row, index) => [...row,
        ...(index === 0 ? [result.median, result.min, result.max] : ["", "", ""]),
        7, team.area, ...team.bounds, team.countUnit, team.source, team.method])
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
    const link = element("a");
    link.href = url;
    link.download = "seasonal-burning-comparison.csv";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function printBriefing() {
    if (!comparison) return;
    const result = comparison;
    const team = state.team;
    const target = $("print-report");
    const years = result.prior.map(week => week.year).join(", ");
    target.replaceChildren(
      element("h1", "Seasonal burning activity briefing"),
      element("p", team.area + " · " + result.start + " to " + result.end + " UTC"),
      element("p", $("season-status").textContent),
      element("p", "Selected total: " + number.format(result.total) + " · Historical median: " +
        number.format(result.median) + " · Observed range: " + number.format(result.min) + "–" + number.format(result.max)),
      element("p", "Complete prior years: " + years),
      element("p", "Coverage: 7 reported days per included week · Bounds (W, S, E, N): " + team.bounds.join(", ")),
      element("p", "Source: " + team.source),
      element("p", "Count unit: " + (team.countUnit || "Unspecified in export")),
      element("p", "Method: " + team.method),
      element("p", "The comparison uses the same UTC calendar dates. Incomplete weeks are excluded."));
    document.body.classList.add("printing-brief");
    window.print();
  }

  window.addEventListener("afterprint", () => document.body.classList.remove("printing-brief"));
  window.addEventListener("hotspot:compare", () => {
    renderSensors();
    renderSeason();
  });
  $("compare-date").addEventListener("change", event => {
    sensorDate = event.target.value;
    renderSensors();
  });
  $("compare-fit").addEventListener("click", fitComparison);
  async function toggleDemo() {
    const button = $("compare-demo");
    button.disabled = true;
    try {
      if (demo) {
        demo = null;
        sensorDate = "";
      } else {
        demo = await loadSnapshot();
        sensorDate = demoDate;
      }
      button.textContent = demo ? "Back to my study area" : "Try the demo";
      renderSensors();
    } catch (error) {
      $("sensor-scope").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
  $("compare-demo").addEventListener("click", toggleDemo);
  $("launch-compare").addEventListener("click", () => {
    showTab("compare", true);
    if (!demo && !$("compare-demo").disabled) toggleDemo();
  });
  $("season-end").addEventListener("change", renderSeason);
  $("open-team-import").addEventListener("click", () => {
    showTab("detections");
    $("upload").focus();
  });
  $("download-comparison").addEventListener("click", downloadBriefing);
  $("print-briefing").addEventListener("click", printBriefing);

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
