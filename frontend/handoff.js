"use strict";

(() => {
  const steps = [
    {title: "The MODIS record", caption: "This earlier week has a MODIS observation count."},
    {title: "Both sensors observe", caption: "Same study area and week. Each instrument reports its own observations."},
    {title: "Later VIIRS observations", caption: "The source records show what each sensor reported for this later week."}
  ];
  let team;
  let stage = -1;
  let timer;
  let deadline = 0;
  let remaining = 0;
  let playing = false;
  let mapView;
  let studyOutline;

  function prepareMap() {
    if (!mapView) {
      mapView = L.map("handoff-map", {
        zoomControl: false, attributionControl: false, dragging: false,
        scrollWheelZoom: false, touchZoom: false, doubleClickZoom: false,
        boxZoom: false, keyboard: false, zoomAnimation: false, fadeAnimation: false
      });
      mapView.createPane("handoff-us").style.zIndex = "210";
      L.imageOverlay(globalImageUrl, globalImagery.getBounds()).addTo(mapView);
      L.imageOverlay(scene.image, sceneBounds, {pane: "handoff-us"}).addTo(mapView);
      studyOutline = L.rectangle(asLeafletBounds(team.bounds), {
        color: "#e4fff0", weight: 2, dashArray: "6 4", fillOpacity: .08, interactive: false
      }).addTo(mapView);
      new ResizeObserver(fitMap).observe($("handoff-map"));
    }
    fitMap();
  }

  function fitMap() {
    if (!mapView || !$("handoff-map").offsetWidth) return;
    mapView.invalidateSize({pan: false});
    studyOutline.setBounds(asLeafletBounds(team.bounds));
    mapView.fitBounds(asLeafletBounds(team.bounds), {padding: [20, 20], maxZoom: 8, animate: false});
  }

  function rawCount(value) {
    return value === null ? "Unavailable" : number.format(value);
  }

  function windowLabel(window) {
    return window.start + " – " + window.end + " UTC";
  }

  function countTile(sensor, value) {
    const tile = element("div", "", "handoff-count " + sensor.toLowerCase());
    tile.append(element("span", sensor + " observations"), element("strong", rawCount(value)));
    return tile;
  }

  function sourceDetails(stages) {
    const node = $("handoff-sources");
    node.replaceChildren(
      element("p", team.area + " · Bounds (W, S, E, N): " + team.bounds.join(", ")),
      element("p", "Source: " + team.source),
      element("p", "Count unit: " + team.countUnit),
      element("p", "Method: " + team.method),
      element("p", "Each harmonized total sums seven reported daily values. These are selected snapshots of the same calendar dates, separated by years.")
    );
    const list = element("ul");
    for (const item of stages) {
      list.append(element("li", windowLabel(item) + " · MODIS " + rawCount(item.modis) +
        " · VIIRS " + rawCount(item.viirs) + " · Harmonized " + number.format(item.total)));
    }
    node.append(list);
    if (!team.validation.length) {
      node.append(element("p", "This export does not include overlap-period validation."));
    }
    for (const item of team.validation) {
      node.append(element("p", item.metric + " · " + item.value + " · " +
        item.period + " — " + item.interpretation));
    }
  }

  function renderFrame(nextStage) {
    stage = nextStage;
    $("handoff-view").hidden = false;
    prepareMap();
    const stages = team.handoff.stages;
    const item = stages[stage];
    const result = !item;
    const frame = $("handoff-frame-title");
    $("handoff-date").textContent = item ? windowLabel(item) : team.area + " · matched calendar dates";
    frame.textContent = item ? steps[stage].title : "One comparable history";
    $("handoff-caption").textContent = item ? steps[stage].caption :
      "Each week uses the same harmonized count unit. Open the evidence for the method and source counts.";
    const metrics = $("handoff-metrics");
    if (item) {
      metrics.replaceChildren(countTile("MODIS", item.modis), countTile("VIIRS", item.viirs));
    } else {
      const max = Math.max(1, ...stages.map(window => window.total));
      metrics.replaceChildren(element("p", team.countUnit, "handoff-unit"));
      for (const window of stages) {
        const row = element("div", "", "handoff-bar");
        const track = element("span", "", "handoff-track");
        track.setAttribute("aria-hidden", "true");
        const fill = element("span");
        fill.style.width = (window.total / max * 100) + "%";
        track.append(fill);
        row.append(element("span", window.start.slice(0, 4)), track,
          element("strong", number.format(window.total)));
        metrics.append(row);
      }
    }
    $("handoff-timeline").replaceChildren(...stages.map((window, index) => {
      const pill = element("span", window.start.slice(0, 4) + " · " + steps[index].title);
      pill.classList.toggle("is-current", index === stage);
      if (index === stage) pill.setAttribute("aria-current", "step");
      return pill;
    }));
    $("handoff-map-note").textContent = "Reference imagery: NASA EOSDIS GIBS, VIIRS · " + scene.date + " · Blue Marble fills gaps.";
    const focusPlayback = [ $("handoff-pause"), $("handoff-skip") ].includes(document.activeElement);
    $("handoff-pause").hidden = result;
    $("handoff-skip").hidden = result;
    $("handoff-replay").hidden = !result;
    $("handoff-play").hidden = true;
    if (result && focusPlayback) $("handoff-replay").focus({preventScroll: true});
    sourceDetails(stages);
    const framePanel = frame.parentElement;
    framePanel.getAnimations().forEach(animation => animation.cancel());
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      framePanel.animate([{opacity: .72}, {opacity: 1}], {duration: 220, easing: "ease-out"});
    }
  }

  function updatePauseLabel() {
    $("handoff-pause").textContent = playing ? "Pause" : "Resume";
  }

  function schedule() {
    playing = true;
    updatePauseLabel();
    deadline = performance.now() + remaining;
    timer = setTimeout(() => {
      renderFrame(stage + 1);
      if (stage < steps.length) {
        remaining = stage === 1 ? 3600 : 3200;
        schedule();
      } else {
        playing = false;
      }
    }, remaining);
  }

  function pause() {
    if (!playing) return;
    clearTimeout(timer);
    remaining = Math.max(0, deadline - performance.now());
    playing = false;
    updatePauseLabel();
  }

  function start() {
    if (!team?.handoff?.stages) return;
    clearTimeout(timer);
    playing = false;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      renderFrame(steps.length);
      return;
    }
    renderFrame(0);
    remaining = 3200;
    schedule();
  }

  function updateHandoff() {
    if (team === state.team && team !== undefined) return;
    clearTimeout(timer);
    playing = false;
    stage = -1;
    team = state.team;
    const ready = Boolean(team?.handoff?.stages);
    $("handoff-view").hidden = true;
    $("handoff-play").disabled = !ready;
    $("handoff-play").hidden = !ready;
    $("handoff-import").hidden = ready;
    $("handoff-status").textContent = ready ? team.area : team ?
      team.handoff.error : "Open a harmonized team export with three handoff windows to play the sequence.";
  }

  window.addEventListener("hotspot:compare", updateHandoff);
  new MutationObserver(() => {
    if ($("compare-panel").hidden) pause();
  }).observe($("compare-panel"), {attributeFilter: ["hidden"]});

  $("launch-handoff").addEventListener("click", () => {
    showTab("compare");
    $("handoff-title").focus();
    start();
  });
  $("handoff-import").addEventListener("click", () => {
    showTab("detections");
    $("upload").focus();
  });
  $("handoff-play").addEventListener("click", () => {
    start();
    (stage === steps.length ? $("handoff-replay") : $("handoff-pause")).focus();
  });
  $("handoff-replay").addEventListener("click", () => {
    start();
    if (stage < steps.length) $("handoff-pause").focus();
  });
  $("handoff-pause").addEventListener("click", () => {
    if (playing) pause();
    else if (stage >= 0 && stage < steps.length) schedule();
  });
  $("handoff-skip").addEventListener("click", () => {
    pause();
    renderFrame(steps.length);
    $("handoff-replay").focus();
  });

  updateHandoff();
})();
