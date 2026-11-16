"use strict";

(() => {
  let scope;
  let historyResource = {};
  let validationResource = {};
  let frpResource = {};
  let selectedWeek;
  let historyRendered;
  let trendRendered;
  let analysisRendered;
  let analysisCalendar;
  let openingCalendar;
  let openingWeek;
  let openingPeriods = [];
  let trendObserver;
  let paintTrend;

  const refreshHistoryExport = bindDataExport("history-export", selection => {
    if (selection === "monthly" && state.history?.rows.length) {
      return {name: "monthly-activity", metric: "snpp_equivalent_active_cell_days", rows: () => state.history.rows};
    }
    const weeks = historyResource.result?.weeks;
    if (selection !== "weekly" || !weeks?.length) return null;
    return {name: "weekly-activity", metric: "observed_active_cell_days",
      rows: () => weeks.map(({days, ...row}) => ({
        ...row, first_selected_date: days[0].date_utc, last_selected_date: days.at(-1).date_utc,
        selected_days: days.length, days
      }))};
  });

  const refreshTrendExport = bindDataExport("trend-export", () => {
    const periods = state.history ? historyResource.result?.months : dailyPeriods();
    if (!periods?.length) return null;
    return {name: "sensor-comparison", period: state.history ? "month" : "day", units: "raw satellite detections",
      rows: () => periods.map(row => ({
        period_utc: row.month, selected_days: row.selected_days,
        modis_detections: row.sensors.MODIS.count, modis_reporting_days: row.sensors.MODIS.reporting_days,
        viirs_detections: row.sensors.VIIRS.count, viirs_reporting_days: row.sensors.VIIRS.reporting_days
      }))};
  });

  const monthsOfYear = new Intl.DateTimeFormat("en-US", {month: "short", timeZone: "UTC"});
  const label = count => count == null ? "Unavailable" : number.format(count);

  function message(target, text) {
    $(target).replaceChildren(element("p", text, "subtle"));
  }

  function query(resource, url, context) {
    if (resource.url === url && resource.context === context) return;
    resource.request?.abort();
    const request = new AbortController();
    Object.assign(resource, {url, context, request, result: null, error: ""});
    fetchApi(url, request.signal).catch(async error => {
      if (request.signal.aborted || (!(error instanceof TypeError) && !(error.status >= 500))) throw error;
      await new Promise(resolve => setTimeout(resolve, 400));
      return fetchApi(url, request.signal);
    }).then(result => {
      if (request.signal.aborted) return;
      if (result.data_version && result.data_version !== context.data_version) {
        throw new Error("The archive changed. Reload the calendar.");
      }
      resource.result = result;
    }).catch(error => {
      if (!request.signal.aborted) resource.error = error.message;
    }).finally(() => {
      if (!request.signal.aborted) update();
    });
  }

  function getOpeningWeek(rows) {
    const first = rows[0]?.date_utc;
    if (!first) return null;
    const weekday = (new Date(first).getUTCDay() + 6) % 7;
    const start = dateOffset(first, -weekday);
    const end = dateOffset(start, 7);
    const thursday = dateOffset(start, 3);
    const year = thursday.slice(0, 4);
    const week = 1 + Math.floor((Date.parse(thursday) - Date.parse(year + "-01-01")) / 604800000);
    const days = rows.filter(row => row.date_utc < end).map(row => ({
      date_utc: row.date_utc, observed_cell_days: row.observed_cell_days ?? null
    }));
    const reported = days.filter(day => day.observed_cell_days != null);
    return {week_start: start, year: Number(year), week, days, available_days: reported.length,
      observed_cell_days: reported.length ? reported.reduce((sum, day) => sum + day.observed_cell_days, 0) : null};
  }

  function openDay(day) {
    const month = state.history.rows.find(row => day >= row.first_day && day <= row.last_day);
    if (!month) return;
    if (state.backend.days.has(day)) {
      showTab("map", true);
      selectBackendDay(day);
    } else {
      selectArchiveMonth(month, {day});
    }
  }

  function weekDescription(row) {
    return row.year + " · Week " + row.week + " · " + label(row.observed_cell_days) +
      " observed cell-days · " + row.available_days + "/" + row.days.length + " days reported";
  }

  function showWeek(row, button) {
    if (!row) return;
    selectedWeek = row.week_start;
    for (const old of $("weekly-heatmap").querySelectorAll('[aria-pressed="true"]')) {
      old.setAttribute("aria-pressed", "false");
      old.tabIndex = -1;
    }
    button.setAttribute("aria-pressed", "true");
    button.tabIndex = 0;
    const dates = row.days[0].date_utc + " through " + row.days.at(-1).date_utc + " UTC";
    const items = element("div", "", "week-days");
    for (const day of row.days) {
      const link = element("button", day.date_utc.slice(5) + " · " + label(day.observed_cell_days));
      link.type = "button";
      link.title = "Open " + day.date_utc + " on the map";
      link.onclick = () => openDay(day.date_utc);
      items.append(link);
    }
    $("week-detail").replaceChildren(element("h3", row.year + " · Week " + row.week),
      element("p", dates, "subtle"), element("strong", label(row.observed_cell_days) + " observed cell-days"),
      element("p", row.available_days + " of " + row.days.length + " selected days reported", "subtle"), items);
  }

  function renderHistory() {
    refreshHistoryExport();
    const source = historyResource.result;
    const preview = !source && state.history && openingWeek;
    const weeks = source?.weeks ?? (preview ? [openingWeek] : []);
    $("weekly-mode").textContent = preview ? historyResource.error
      ? "Showing the opening week. The full history could not load."
      : "Showing the opening week while the full history loads." : "";
    const key = source ?? (preview || (state.history ? historyResource.error || "pending" : "demo"));
    if (key === historyRendered) return;
    historyRendered = key;
    $("week-detail").replaceChildren();
    if (!weeks.length) {
      message("weekly-heatmap", state.history ? historyResource.error || (source
        ? "Weekly cell-days are unavailable in this published release." : "Loading weekly activity…")
        : "Weekly activity is available with a historical archive.");
      return;
    }
    const grid = element("div", "", "week-grid");
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Weekly activity by ISO year. Use arrow keys to move between weeks.");
    const headings = element("div", "", "week-row");
    headings.append(element("span", "Year"));
    for (let i = 1; i <= 53; i++) headings.append(element("span", i === 1 || i % 4 === 0 || i === 53 ? String(i) : ""));
    grid.append(headings);
    const max = weeks.reduce((value, row) => Math.max(value, row.observed_cell_days ?? 0), 1);
    const byYear = Map.groupBy(weeks, row => row.year);
    const current = weeks.find(row => row.week_start === selectedWeek) ?? weeks[0];
    let currentButton;
    const buttons = new Map();
    for (const [year, weeks] of [...byYear].reverse()) {
      const strip = element("div", "", "week-row");
      strip.append(element("strong", year));
      for (const row of weeks) {
        const button = element("button", "", "week-tile");
        button.type = "button";
        button.tabIndex = -1;
        button.style.gridColumn = row.week + 1;
        button.title = weekDescription(row);
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", "false");
        const value = row.observed_cell_days;
        button.dataset.level = value == null ? "missing" : value === 0 ? "zero"
          : Math.min(heatColors.length - 1, Math.floor(heatColors.length * Math.log1p(value) / Math.log1p(max)));
        button.classList.toggle("partial-week", row.available_days < 7 && value != null);
        button.onclick = () => showWeek(row, button);
        button.onkeydown = event => {
          const step = {ArrowLeft: -7, ArrowRight: 7}[event.key];
          const yearStep = {ArrowUp: 1, ArrowDown: -1}[event.key];
          if (step === undefined && yearStep === undefined) return;
          event.preventDefault();
          const target = step !== undefined ? buttons.get(dateOffset(row.week_start, step))
            : (byYear.get(year + yearStep) ?? []).reduce((closest, candidate) =>
              !closest || Math.abs(candidate.week - row.week) < Math.abs(closest.week - row.week) ? candidate : closest, null);
          if (step !== undefined) target?.focus();
          else if (target) buttons.get(target.week_start).focus();
        };
        buttons.set(row.week_start, button);
        if (row === current) currentButton = button;
        strip.append(button);
      }
      grid.append(strip);
    }
    const legend = element("div", "", "legend weekly-legend");
    legend.append(element("i", "", "heat-ramp"), element("span", "Low to high"));
    for (const [name, level] of [["Zero", "zero"], ["Unavailable", "missing"], ["Partial week", "partial"]]) {
      const item = element("span");
      const icon = element("i", "", "week-tile legend-tile");
      icon.dataset.level = level;
      item.append(icon, document.createTextNode(name));
      legend.append(item);
    }
    $("weekly-heatmap").replaceChildren(legend, element("div", "", "week-scroll"));
    $("weekly-heatmap").lastChild.append(grid);
    showWeek(current, currentButton);
  }

  function dailyPeriods(rows = state.backend?.rows ?? []) {
    return rows.map(row => ({
      month: row.date_utc, selected_days: 1,
      sensors: Object.fromEntries(sensors.map(sensor => [sensor, {
        count: row.sensor_detections[sensor] ?? null, reporting_days: Number(row.sensor_detections[sensor] != null)
      }]))
    }));
  }

  function renderTrend() {
    refreshTrendExport();
    const source = historyResource.result;
    const preview = state.history && !source && openingPeriods.length > 0;
    const key = state.history ? source ?? (preview ? openingPeriods : historyResource.error || "archive") : state.backend ?? "waiting";
    if (key !== trendRendered) {
      trendRendered = key;
      $("trend-detail").textContent = "";
      const periods = state.history ? source?.months ?? openingPeriods : dailyPeriods();
      if (!periods?.length) {
        trendObserver?.disconnect();
        paintTrend = null;
        message("sensor-trend", state.history ? historyResource.error || "Loading sensor totals…" : "No sensor data loaded.");
      } else drawTrend(periods, preview);
    }
    if (preview) $("trend-caption").textContent = historyResource.error
      ? "Daily detections for the opening week · full trend unavailable"
      : "Daily detections for the opening week · full trend is loading";
    const diagnostics = validationResource.result;
    const items = Object.entries(diagnostics?.calibrations ?? {});
    if (!items.length) {
      $("calibration").textContent = validationResource.error || (diagnostics ? "No validation results in this release."
        : state.history ? "Loading calibration…" : "Calibration is available with a historical archive.");
      return;
    }
    const summary = element("ul");
    const statuses = {
      validated: "Validated", unvalidated: "Did not meet validation criteria",
      no_complete_overlap_year: "No complete overlap year",
      insufficient_holdout_coverage: "Insufficient holdout coverage"
    };
    for (const [sensor, audit] of items) {
      const mae = audit.regions?.all?.mae;
      const details = [statuses[audit.status] ?? audit.status,
        audit.holdout_year ? "held-out year " + audit.holdout_year : "",
        mae ? "Mean absolute error per tile-month: " + number.format(mae.regional_ratio) +
          " adjusted, " + number.format(mae.unadjusted) + " unadjusted" : ""];
      summary.append(element("li", sensor + " · " + details.filter(Boolean).join(" · ")));
    }
    $("calibration").replaceChildren(summary);
  }

  function drawTrend(periods, preview) {
    const monthly = state.history && !preview;
    $("trend-caption").textContent = (monthly ? "Monthly" : "Daily") + " detection counts · gaps indicate unavailable data";
    const canvas = element("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const ctx = canvas.getContext("2d");
    const peak = periods.reduce((m, row) => Math.max(m, ...sensors.map(sensor => row.sensors[sensor].count ?? 0)), 1);
    const tickBase = 10 ** Math.floor(Math.log10(Math.max(1, peak / 4)));
    const tickStep = tickBase * ([1, 2, 5, 10].find(value => value * tickBase >= peak / 4) ?? 10);
    const maximum = Math.ceil(peak / tickStep) * tickStep;
    const tickLabel = new Intl.NumberFormat("en-US", {notation: "compact"});
    const picker = element("select");
    let horizontal;
    paintTrend = () => {
      const {width, height} = canvas.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      const ratio = window.devicePixelRatio || 1;
      const pixels = [Math.round(width * ratio), Math.round(height * ratio)];
      if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) {
        [canvas.width, canvas.height] = pixels;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = "12px system-ui";
      const palette = getComputedStyle(document.documentElement);
      const muted = palette.getPropertyValue("--muted").trim();
      const left = Math.max(30, ctx.measureText(tickLabel.format(maximum)).width + 13);
      const right = width - 10, top = 14, bottom = height - 30;
      horizontal = {left, right};
      const last = periods.length - 1;
      const x = index => left + (last ? index / last : .5) * (right - left);
      const y = count => bottom - (count / maximum) * (bottom - top);
      const selected = Number(picker.value);
      ctx.strokeStyle = palette.getPropertyValue("--line").trim();
      ctx.fillStyle = muted;
      ctx.lineWidth = 1;
      ctx.textAlign = "right";
      for (let count = 0; count <= maximum; count += tickStep) {
        const position = y(count);
        ctx.beginPath();
        ctx.moveTo(left, position);
        ctx.lineTo(right, position);
        ctx.stroke();
        ctx.fillText(tickLabel.format(count), left - 7, position + 4);
      }
      const labels = Math.min(7, periods.length, Math.max(2, Math.floor(width / 85)));
      for (let i = 0; i < labels; i++) {
        const index = labels === 1 ? 0 : Math.round(i * last / (labels - 1));
        const period = periods[index].month;
        ctx.textAlign = !last ? "center" : index === 0 ? "left" : index === last ? "right" : "center";
        ctx.fillText(monthly ? period : period.slice(5), x(index), height - 9);
      }
      ctx.strokeStyle = muted;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x(selected), top);
      ctx.lineTo(x(selected), bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const sensor of sensors) {
        ctx.strokeStyle = ctx.fillStyle = palette.getPropertyValue("--" + sensor.toLowerCase()).trim();
        ctx.lineWidth = 1.7;
        ctx.beginPath();
        let connected = false;
        for (const [index, row] of periods.entries()) {
          const {count} = row.sensors[sensor];
          if (count == null) {
            connected = false;
          } else {
            if (connected) ctx.lineTo(x(index), y(count));
            else ctx.moveTo(x(index), y(count));
            connected = true;
          }
        }
        ctx.stroke();
        periods.forEach((row, i) => {
          const {count} = row.sensors[sensor];
          if (count == null || (i !== selected && periods[i - 1]?.sensors[sensor].count != null &&
              periods[i + 1]?.sensors[sensor].count != null && last > 15)) return;
          ctx.beginPath();
          ctx.arc(x(i), y(count), i === selected ? 4 : 2, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    };
    const readout = index => {
      const row = periods[index];
      $("trend-detail").textContent = row.month + " · " + sensors.map(sensor => {
        const {count, reporting_days} = row.sensors[sensor];
        return sensor + " " + label(count) + " · " + reporting_days + "/" + row.selected_days + " days reported";
      }).join(" · ");
    };
    const controls = element("div", "", "actions trend-controls");
    controls.append(...sensors.map(sensor => element("strong", sensor, sensor.toLowerCase())));
    const periodLabel = element("label", "Period", "basemap-label");
    periods.forEach((row, index) => picker.append(new Option(row.month, index)));
    const activePeriod = monthly ? state.month.slice(0, 7) : state.selected;
    picker.value = Math.max(0, periods.findIndex(row => row.month === activePeriod));
    const selectPeriod = () => {
      readout(Number(picker.value));
      paintTrend();
    };
    picker.onchange = selectPeriod;
    canvas.onclick = event => {
      if (!horizontal) return;
      const {left, right} = horizontal;
      const fraction = Math.max(0, Math.min(1, (event.offsetX - left) / (right - left)));
      picker.value = Math.round(fraction * (periods.length - 1));
      selectPeriod();
    };
    const showMaps = element("button", "Show on sensor maps");
    showMaps.type = "button";
    showMaps.onclick = async () => {
      const {month: period} = periods[Number(picker.value)];
      if (monthly) {
        const month = state.history.rows.find(row => row.date_utc.startsWith(period));
        if (month) await selectArchiveMonth(month);
      } else {
        await selectBackendDay(period, $("map-layer").value === "overview");
      }
      if (state.tab === "compare") {
        $("sensor-title").focus({preventScroll: true});
        $("sensor-title").scrollIntoView({block: "start"});
      }
    };
    periodLabel.append(picker);
    controls.append(periodLabel, showMaps);
    $("sensor-trend").replaceChildren(controls, canvas);
    trendObserver?.disconnect();
    trendObserver = new ResizeObserver(() => paintTrend?.());
    trendObserver.observe(canvas);
    selectPeriod();
  }

  function bars(target, labels, series) {
    const plot = element("div", "", "bars");
    plot.style.setProperty("--columns", labels.length);
    const peak = series.reduce((max, item) => Math.max(max, ...item.values), 1);
    const table = element("table");
    const row = table.createTHead().insertRow();
    row.append(element("th", "Period or range"), ...series.map(item => element("th", item.name)));
    const body = table.createTBody();
    for (const [index, name] of labels.entries()) {
      const bucket = element("div", "", "bar-bucket");
      const group = element("div", "", "bar-group");
      const tr = body.insertRow();
      tr.append(element("th", name));
      for (const item of series) {
        const count = item.values[index];
        const bar = element("i", "", "chart-bar " + item.name.toLowerCase());
        bar.style.height = count == null ? "0" : (count / peak * 100) + "%";
        bar.title = name + " · " + item.name + " · " + label(count);
        group.append(bar);
        tr.insertCell().textContent = label(count);
      }
      bucket.append(group, element("span", name));
      plot.append(bucket);
    }
    plot.setAttribute("aria-hidden", "true");
    const values = element("details", "", "chart-values");
    values.append(element("summary", "Chart values"), table);
    $(target).replaceChildren(plot, values);
  }

  function renderDetections() {
    const summary = frpResource.result;
    const selected = state.selected;
    const list = selectedSensors();
    const key = [state.backend, selected, state.sensor, historyResource.result, historyResource.error,
      summary, frpResource.error];
    if (analysisRendered?.every((value, index) => value === key[index])) return;
    analysisRendered = key;
    const datePicker = $("analysis-date");
    if (analysisCalendar !== state.backend) {
      analysisCalendar = state.backend;
      const dates = state.backend ? [...state.backend.days.keys()].sort() : [];
      datePicker.replaceChildren(...dates.map(date => new Option(date, date)));
      datePicker.disabled = !dates.length;
    }
    datePicker.value = selected;
    $("detection-analysis-scope").textContent = selected ? selected + " UTC · " + state.backend.area : "Select a day to inspect detections.";
    const readings = state.backend?.days.get(selected);
    const metrics = list.map(sensor => {
      const metric = element("div", "", "sensor-metric " + sensor.toLowerCase());
      metric.append(element("span", sensor + " observations"), element("strong", label(readings?.[sensor])));
      return metric;
    });
    if (summary) {
      const total = list.reduce((sum, sensor) => sum + summary.sensors[sensor].sample_count, 0);
      const power = list.reduce((sum, sensor) => {
        const result = summary.sensors[sensor];
        return sum + (result.mean_mw ?? 0) * result.sample_count;
      }, 0);
      const metric = element("div", "", "sensor-metric");
      metric.append(element("span", "Mean fire radiative power"), element("strong", total ? number.format(power / total) + " MW" : "Unavailable"),
        element("small", number.format(total) + " measurements"));
      metrics.push(metric);
    }
    $("detection-metrics").replaceChildren(...metrics);
    const months = historyResource.result?.months;
    if (months?.length) {
      $("season-title").textContent = "Seasonal detections";
      const labels = Array.from({length: 12}, (_, i) => monthsOfYear.format(new Date(Date.UTC(2000, i, 1))));
      const series = list.map(name => {
        const values = Array(12).fill(null);
        for (const row of months) {
          const month = Number(row.month.slice(5)) - 1;
          const {count} = row.sensors[name];
          if (count != null) values[month] = (values[month] ?? 0) + count;
        }
        return {name, values};
      });
      bars("season-chart", labels, series);
    } else if (openingPeriods.length) {
      $("season-title").textContent = "Opening-week detections";
      bars("season-chart", openingPeriods.map(row => row.month.slice(5)), list.map(name => ({
        name, values: openingPeriods.map(row => row.sensors[name].count)
      })));
    } else {
      $("season-title").textContent = "Seasonal detections";
      message("season-chart", state.history ? historyResource.error || "Loading detections across the selected dates…"
        : "Seasonal totals are available with a historical archive.");
    }
    if (summary && list.some(sensor => summary.sensors[sensor].sample_count)) {
      bars("frp-chart", summary.bins_mw, list.map(name => ({
        name, values: summary.sensors[name].sample_count ? summary.sensors[name].bins : summary.bins_mw.map(() => null)
      })));
    } else {
      message("frp-chart", frpResource.error || (summary ? "No radiative power measurements for this selection."
        : selected ? "Loading fire radiative power…" : "Select an observation date."));
    }
  }

  function update() {
    if (state.history !== scope) {
      scope = state.history;
      historyResource.request?.abort();
      validationResource.request?.abort();
      historyResource = {};
      validationResource = {};
    }
    if (state.backend !== openingCalendar) {
      openingCalendar = state.backend;
      const rows = openingCalendar?.rows ?? [];
      openingWeek = getOpeningWeek(rows);
      openingPeriods = openingWeek ? dailyPeriods(rows.slice(0, openingWeek.days.length)) : [];
      selectedWeek = openingWeek?.week_start;
      historyRendered = null;
    }
    if (state.history) {
      query(historyResource, archiveUrl("/api/analytics", {start: scope.start, end: scope.end_exclusive}), scope);
      query(validationResource, archiveUrl("/api/validation", {}), scope);
    }
    if (state.backend?.days.has(state.selected)) {
      const params = {date: state.selected};
      const url = scope ? archiveUrl("/api/frp", params) : apiUrl("/api/frp", params);
      query(frpResource, url, scope ?? state.backend);
    }
    renderHistory();
    renderTrend();
    renderDetections();
  }

  window.addEventListener("hotspot:state", update);
  window.addEventListener("hotspot:theme", () => paintTrend?.());
  $("analysis-date").addEventListener("change", event =>
    selectBackendDay(event.target.value, $("map-layer").value === "overview"));
  $("retry-data").addEventListener("click", () => {
    for (const resource of [historyResource, validationResource, frpResource]) {
      if (resource.error) resource.url = null;
    }
  });
  update();
})();
