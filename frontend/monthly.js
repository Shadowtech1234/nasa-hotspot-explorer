"use strict";

const monthlyActivity = (() => {
  const palette = [
    ["Unusually high", "#ff7043"], ["Above typical", "#ffbe63"],
    ["Typical range", "#77daa5"], ["Below typical", "#77c9f4"],
    ["Unusually low", "#7e9eff"], ["Percentile unavailable", "#c5b6d7"]
  ];
  const regions = document.getElementById("monthly-region");
  const calendar = document.getElementById("monthly-calendar");
  let published = [];
  let region;
  let request;
  let rows = [];
  let selected;
  let summary;
  let error;

  function setRegions(entries = []) {
    if (JSON.stringify(entries) === JSON.stringify(published)) return;
    request?.abort();
    published = entries;
    region = entries.find(item => item.id === region?.id) ?? entries[0];
    regions.replaceChildren(...entries.map(item => new Option(item.label, item.id)));
    regions.value = region?.id ?? "";
    regions.disabled = !region;
    rows = [];
    selected = undefined;
    summary = undefined;
  }

  function showCalendar() {
    calendar.replaceChildren(...rows.map(row => {
      const name = monthName.format(new Date(row.date_utc));
      const amount = row.activity ?? row.observed_cell_days;
      const label = amount == null ? "Activity unavailable" : number.format(Math.round(amount)) + " cell-days";
      const button = element("button", "", "day monthly-day");
      button.type = "button";
      button.dataset.month = row.date_utc;
      button.setAttribute("aria-pressed", String(row === selected));
      button.append(element("strong", name), element("span", label));
      if (row.usable_days < row.days_in_month) button.append(element("small", "Partial month"));
      button.addEventListener("click", () => selectMonth(row));
      return button;
    }));
  }

  function regionRequest() {
    request?.abort();
    request = new AbortController();
    return request;
  }

  async function load({focus = false} = {}) {
    request?.abort();
    const next = published.find(item => item.id === regions.value);
    const previousMonth = selected?.date_utc;
    if (region?.id !== next?.id) selected = undefined;
    region = next;
    summary = undefined;
    error = undefined;
    rows = [];
    showCalendar();
    if (focus && region) focusRegion();
    renderMap(visible);
    if (!region) return;

    const pending = regionRequest();
    try {
      const data = await staticData.monthly(region.calendar, pending.signal);
      pending.signal.throwIfAborted();
      rows = data.rows;
      const row = rows.find(item => item.date_utc === previousMonth) ??
        rows.findLast(item => item.activity !== null || item.observed_cell_days !== null) ?? rows.at(-1);
      showCalendar();
      if (row) await selectMonth(row);
      else {
        error = "No published months";
        renderMap(visible);
      }
    } catch (failure) {
      handleError(failure, pending);
    }
  }

  async function selectMonth(row) {
    const pending = regionRequest();
    selected = row;
    summary = undefined;
    error = undefined;
    for (const button of calendar.children) {
      button.setAttribute("aria-pressed", String(button.dataset.month === row.date_utc));
    }
    renderMap(visible);
    try {
      const url = new URL(row.map, new URL(region.calendar, staticData.indexUrl));
      const data = await staticData.monthly(url, pending.signal);
      pending.signal.throwIfAborted();
      summary = data;
      renderMap(visible);
    } catch (failure) {
      handleError(failure, pending);
    }
  }

  function handleError(failure, pending) {
    if (pending.signal.aborted) return;
    error = "Monthly data unavailable. Reload data to retry. " + failure.message;
    renderMap(visible);
  }

  function level(percentile) {
    return palette[percentile == null ? 5 : percentile >= 90 ? 0 : percentile >= 75 ? 1 :
      percentile > 25 ? 2 : percentile > 10 ? 3 : 4];
  }

  function render() {
    const scope = $("map-scope");
    const legend = $("legend");
    legend.replaceChildren();
    if (!summary) {
      overviewLayer.remove();
      scope.textContent = error ?? (!region ? "No published monthly regions" :
        rows.length && !selected ? "No published months" : "Loading monthly activity…");
      return;
    }
    const {activity, observed_cell_days, usable_days, days_in_month, historical_percentile} = selected;
    const amount = activity ?? observed_cell_days;
    const dates = selected.first_day + " through " + selected.last_day + " UTC";
    const details = [region.label, dates,
      amount == null ? "Activity unavailable" : number.format(Math.round(amount)) + " cell-days"];
    if (usable_days < days_in_month) details.push("Partial month · " + usable_days + " comparable days");
    details.push(historical_percentile == null ? "Percentile unavailable" :
      "Regional percentile " + number.format(Math.round(historical_percentile)));
    const wide = showingOverview();
    const features = summary.maps[wide ? "2" : "3"];
    const value = feature => feature.properties.activity ?? feature.properties.observed_cell_days ?? 0;
    const maximum = features.reduce((max, feature) => Math.max(max, value(feature)), 0);
    const mapFeatures = wide ? features.filter(feature => value(feature) > 0) : features;
    if (mapFeatures.length && !mapFeatures.some(feature => {
      const [lon, lat] = feature.geometry.coordinates;
      return map.getBounds().contains([lat, lon]);
    })) {
      details.push("Activity is outside this view. Use Fit region.");
    } else if (amount === 0) {
      details.push("No monthly activity reported");
    }
    scope.textContent = details.join(" · ");
    if (wide) {
      const heat = mapFeatures.map(feature => {
        const [lon, lat] = feature.geometry.coordinates;
        return [lat, lon, Math.log1p(value(feature)) / Math.log1p(maximum)];
      });
      drawHeat(heat);
      if (heat.length) addHeatLegend(legend, "Monthly activity", "Combined sensors");
      else legend.append(element("span", "No monthly activity to show"));
      return;
    }
    overviewLayer.remove();
    legend.append(element("strong", "Size · monthly activity"));
    for (const [label, color] of palette) {
      const item = element("span");
      const dot = element("i", "", "dot");
      dot.style.color = color;
      item.append(dot, document.createTextNode(label));
      legend.append(item);
    }
    for (const feature of features) {
      const [lon, lat] = feature.geometry.coordinates;
      const data = feature.properties;
      const [label, color] = level(data.historical_percentile);
      L.circleMarker([lat, lon], {
        radius: 3 + 22 * Math.sqrt(value(feature) / (maximum || 1)),
        fillColor: color, fillOpacity: 0.8, color: "#172535", weight: 1
      }).bindPopup(() => {
        const popup = element("div");
        popup.append(element("strong", label), element("div", number.format(Math.round(value(feature))) +
          (data.activity == null ? " observed cell-days" : " comparable cell-days")));
        if (data.historical_percentile != null) popup.append(element("div",
          "Percentile " + number.format(Math.round(data.historical_percentile)) +
          " across " + data.baseline_years + " earlier years"));
        return popup;
      }, {autoPan: false}).addTo(pointLayer);
    }
  }

  function focusRegion() {
    if (!showingOverview()) {
      fitArea();
      return;
    }
    const [west, south, east, north] = region.bbox;
    map.panTo([(south + north) / 2, east < west ? 0 : (west + east) / 2], {animate: false});
  }

  regions.addEventListener("change", () => load({focus: true}));

  return {setRegions, load, render, cancel: () => request?.abort(), bounds: () => region?.bbox};
})();
