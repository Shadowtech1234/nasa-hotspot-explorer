"use strict";

const publishedApi = (() => {
  const catalogs = new Map();
  const rawId = "published-detections";

  async function catalog(signal) {
    const index = await staticData.index(signal);
    if (index.version && !catalogs.has(index.version)) catalogs.clear();
    if (!catalogs.has(index.version)) catalogs.set(index.version, {index, calendars: new Map(), results: new Map()});
    return catalogs.get(index.version);
  }

  function reject(message, status = 422) {
    throw Object.assign(new Error(message), {status});
  }

  function rawMonths(rows) {
    const months = new Map();
    for (const row of rows) {
      const month = row.date_utc.slice(0, 7) + "-01";
      if (!months.has(month)) {
        const date = new Date(month);
        const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        months.set(month, {date_utc: month, first_day: row.date_utc, last_day: row.date_utc, days_in_month: days,
          activity: null, observed_cell_days: null, usable_days: 0, provisional_days: 0, source_days: {},
          historical_median: null, historical_percentile: null, baseline_years: 0});
      }
      months.get(month).last_day = row.date_utc;
    }
    return [...months.values()];
  }

  async function detections(release, bbox, start, end_exclusive, signal) {
    const key = JSON.stringify([bbox, start, end_exclusive]);
    for (const saved of release.results.values()) {
      if (saved.bbox.join() === bbox.join() && saved.start <= start && saved.end_exclusive >= end_exclusive) {
        return saved.rows.filter(row => row.date_utc >= start && row.date_utc < end_exclusive);
      }
    }
    const result = await staticData.analyze(release.index, {bbox, start, end_exclusive}, signal, () => {});
    const rows = result.rows.map(row => ({...row, unavailable_packets: result.unavailable_packets}));
    signal.throwIfAborted();
    if (!result.unavailable_packets) {
      if (release.results.size >= 8) release.results.delete(release.results.keys().next().value);
      release.results.set(key, {bbox, start, end_exclusive, rows});
    }
    return rows;
  }

  async function handle(path, signal = new AbortController().signal) {
    const url = new URL(path, window.location.href);
    const p = url.searchParams;
    // The archive list refreshes the index so a new published release can go live.
    const release = url.pathname === "/api/archives" || !catalogs.size
      ? await catalog(signal) : catalogs.values().next().value;
    const {index, calendars} = release;
    const choices = (index.monthly ?? []).map(item => ({...item, id: "published-" + item.id}));
    if (url.pathname === "/api/archives") {
      return [...choices.map(item => ({id: item.id, name: item.label})), {id: rawId, name: "Published detections"}];
    }
    if (p.has("version") && p.get("version") !== index.version) reject("The published release changed. Reload the calendar.", 409);
    const region = p.get("dataset") === rawId ? null : choices.find(item => item.id === p.get("dataset")) ?? choices[0];
    let published;
    if (region) {
      published = calendars.get(region.id);
      if (!published) {
        published = (await staticData.monthly(region.calendar, signal)).rows;
        calendars.set(region.id, published);
      }
    }
    const defaults = region?.bbox ?? index.initial_bbox;
    const bbox = p.has("bbox") ? p.get("bbox").split(",").map(value => Number(value.trim())) : defaults;
    if (bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3] ||
        bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90) reject("Enter valid west, south, east and north coordinates.");
    if (region && bbox.join() !== defaults.join()) reject("Choose Published detections to query a custom area.");
    const archive_start = published?.[0]?.first_day ?? index.start;
    const archive_end_exclusive = published?.length ? dateOffset(published.at(-1).last_day, 1) : index.end_exclusive;
    const start = p.get("start") ?? archive_start;
    const end_exclusive = p.get("end") ?? archive_end_exclusive;
    const metadata = {archive: true, published: true, static_detections: !region, data_version: index.version,
      region: region?.label ?? "Published detections", bbox, archive_bbox: defaults, archive_start,
      archive_end_exclusive, start, end_exclusive, sources: index.sources};
    const point = (item, properties) => ({
      type: "Feature", geometry: {type: "Point", coordinates: [item.lon, item.lat]}, properties
    });

    switch (url.pathname) {
      case "/api/calendar": {
        if (start < archive_start || end_exclusive > archive_end_exclusive || start >= end_exclusive) {
          reject("Select dates within the published range.");
        }
        if (p.get("granularity") === "day") {
          const rows = (await detections(release, bbox, start, end_exclusive, signal)).map(row => ({
            date_utc: row.date_utc, sensor_detections: row.sensor_detections, observed_cell_days: null,
            standard_platforms: [], provisional_platforms: [], partial_sensors: row.partial_sensors,
            unavailable_packets: row.unavailable_packets
          }));
          return {...metadata, rows};
        }
        const rows = region ? published.filter(row => row.first_day >= start && row.last_day < end_exclusive)
          : rawMonths(await detections(release, bbox, start, end_exclusive, signal));
        if (!rows.length) reject("Select a complete published month or use Published detections for custom dates.");
        return {...metadata, rows};
      }
      case "/api/overview": {
        const month = published?.find(row => row.date_utc === p.get("month"));
        if (!month) reject("No published map for this month.", 404);
        const href = new URL(month.map, new URL(region.calendar, staticData.indexUrl));
        const result = await staticData.monthly(href, signal);
        const resolution = Number(p.get("resolution")) >= 3 ? "3" : "2";
        return {features: result.maps[resolution] ?? [], metadata: {...metadata,
          complete_month: month.usable_days === month.days_in_month}};
      }
      case "/api/map":
      case "/api/density":
      case "/api/frp": {
        const date = p.get("date");
        const row = (await detections(release, bbox, date, dateOffset(date, 1), signal))[0];
        const points = row?.points ?? [];
        if (url.pathname === "/api/frp") {
          const bins_mw = ["0–<10", "10–<50", "50–<100", "100–<500", "500+"];
          const stats = Object.fromEntries(["MODIS", "VIIRS"].map(sensor => {
            const values = points.filter(item => item.sensor === sensor && item.frp != null).map(item => item.frp);
            const bins = bins_mw.map(() => 0);
            for (const value of values) bins[[10, 50, 100, 500].filter(cutoff => value >= cutoff).length]++;
            return [sensor, {bins, sample_count: values.length,
              mean_mw: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null}];
          }));
          return {date_utc: date, data_version: index.version, bins_mw, sensors: stats};
        }
        const density = url.pathname === "/api/density";
        const sensor = p.get("sensor");
        const layer = p.get("layer");
        const selected = layer === "cells" ? [] : points.filter(item => !sensor || item.sensor === sensor);
        const ranked = layer === "frp" ? selected.filter(item => Number.isFinite(item.frp))
          .sort((a, b) => b.frp - a.frp) : selected;
        const offset = Number(p.get("offset") ?? 0);
        const end = offset + Number(p.get("limit") ?? 3000);
        const next_offset = layer === "frp" && end < ranked.length ? end : null;
        const page = layer === "frp" ? ranked.slice(offset, end) : ranked;
        const features = page.map(item =>
          point(item, density ? {sensor: item.sensor, count: 1} : {sensor: item.sensor, platform: item.satellite,
            acquired_at_utc: item.date + "T" + item.time, confidence_raw: item.confidence, frp_mw: item.frp}));
        return {type: "FeatureCollection", features, metadata: {...metadata, date_utc: date, next_offset}};
      }
      case "/api/analytics": {
        const rows = await detections(release, bbox, start, end_exclusive, signal);
        const months = new Map();
        for (const day of rows) {
          const month = day.date_utc.slice(0, 7);
          if (!months.has(month)) months.set(month, {month, selected_days: 0, sensors: {
            MODIS: {count: null, reporting_days: 0}, VIIRS: {count: null, reporting_days: 0}
          }});
          const bucket = months.get(month);
          bucket.selected_days++;
          for (const [sensor, total] of Object.entries(bucket.sensors)) {
            const count = day.sensor_detections[sensor];
            if (count == null) continue;
            total.count = (total.count ?? 0) + count;
            total.reporting_days++;
          }
        }
        return {...metadata, weeks: [], months: [...months.values()]};
      }
      case "/api/validation":
        return {calibrations: {}};
      default:
        reject("Published data route unavailable.", 404);
    }
  }

  return {handle};
})();
