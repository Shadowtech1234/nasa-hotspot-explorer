"use strict";

const HotspotData = (() => {
  const sensors = ["MODIS", "VIIRS"];
  const extent = [-180, -85, 180, 85];
  const urls = {
    MODIS: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_USA_contiguous_and_Hawaii_7d.csv",
    VIIRS: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_7d.csv"
  };

  function csvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    text = text.replace(/^\uFEFF/, "") + "\n";
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          field += '"';
          index++;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"' && !field) {
        quoted = true;
      } else if (character === "," || character === "\r" || character === "\n") {
        row.push(field.trim());
        field = "";
        if (character === ",") continue;
        if (character === "\r" && text[index + 1] === "\n") index++;
        if (row.some(Boolean)) rows.push(row);
        row = [];
      } else {
        field += character;
      }
    }
    if (quoted) throw new Error("A CSV field has an unclosed quote.");
    return rows;
  }

  function isDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = new Date(value + "T00:00:00Z");
    return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
  }

  function validBounds(bounds) {
    return Array.isArray(bounds) && bounds.length === 4 &&
      bounds.every(Number.isFinite) && bounds[0] >= extent[0] &&
      bounds[1] >= extent[1] && bounds[2] <= extent[2] && bounds[3] <= extent[3] &&
      bounds[0] < bounds[2] && bounds[1] < bounds[3];
  }

  function contains(bounds, point) {
    return point.lon >= bounds[0] && point.lon <= bounds[2] &&
      point.lat >= bounds[1] && point.lat <= bounds[3];
  }

  function sensorFor(instrument, satellite, defaultSensor) {
    const name = instrument?.toUpperCase();
    if (sensors.includes(name)) return name;
    if (name) return null;
    const platform = satellite?.toUpperCase();
    if (["A", "T", "AQUA", "TERRA"].includes(platform)) return "MODIS";
    if (["N", "N20", "N21", "J1", "J2", "SNPP", "S-NPP", "SUOMI NPP",
      "NOAA-20", "NOAA-21"].includes(platform)) return "VIIRS";
    return defaultSensor;
  }

  function coordinates(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) &&
      Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  function parseFirms(text, defaultSensor) {
    const [header, ...rows] = csvRows(text);
    const index = new Map(header?.map((name, position) => [name.toLowerCase(), position]));
    if (!["latitude", "longitude", "acq_date"].every(name => index.has(name))) {
      throw new Error("FIRMS CSV needs latitude, longitude, and acq_date columns.");
    }
    const number = value => value ? Number(value) : NaN;
    const points = [];
    let skipped = 0;
    for (const row of rows) {
      const read = name => row[index.get(name)] || "";
      const lat = number(read("latitude"));
      const lon = number(read("longitude"));
      const date = read("acq_date");
      const satellite = read("satellite");
      const sensor = sensorFor(read("instrument"), satellite, defaultSensor);
      if (!coordinates(lat, lon) || !isDate(date) || !sensor) {
        skipped++;
        continue;
      }
      const time = read("acq_time").padStart(4, "0");
      points.push({
        lat, lon, date, sensor, satellite,
        time: read("acq_time") && /^(?:[01]\d|2[0-3])[0-5]\d$/.test(time)
          ? time.slice(0, 2) + ":" + time.slice(2) : "",
        confidence: read("confidence"),
        frp: Number.isFinite(number(read("frp"))) ? number(read("frp")) : null
      });
    }
    if (rows.length && !points.length) {
      throw new Error("No usable MODIS or VIIRS rows were found. Check coordinates, dates, and the instrument or satellite column.");
    }
    return {points, skipped};
  }

  function parseTeam(text) {
    const data = JSON.parse(text);
    if (!data || !validBounds(data.bounds) || !Array.isArray(data.days) || !data.days.length ||
        !["area", "source", "method"].every(key => typeof data[key] === "string" && data[key].trim())) {
      throw new Error("Team export needs area, bounds, source, method, and daily records.");
    }
    const days = new Map();
    for (const day of data.days) {
      if (!day || !isDate(day.date) || days.has(day.date) ||
          (day.count !== null && !(Number.isSafeInteger(day.count) && day.count >= 0))) {
        throw new Error("Team dates must be unique UTC dates with a nonnegative count or null.");
      }
      const positions = day.points === undefined ? [] : day.points;
      if (!Array.isArray(positions) || !positions.every(point => point &&
          coordinates(point.lat, point.lon) && contains(data.bounds, point))) {
        throw new Error("Team map points must have numeric lat and lon within the export bounds.");
      }
      if (positions.length && (day.count === null || day.count === 0)) {
        throw new Error("A day needs a positive count to include map points.");
      }
      const points = positions.map(({lat, lon}) => ({lat, lon, date: day.date, sensor: "Harmonized"}));
      days.set(day.date, {count: day.count, points});
    }
    return {area: data.area.trim(), bounds: data.bounds, source: data.source.trim(), method: data.method.trim(), days};
  }

  function listDates(start, end) {
    const days = [];
    if (!isDate(start) || !isDate(end) || start > end) return days;
    for (const date = new Date(start); date <= new Date(end); date.setUTCDate(date.getUTCDate() + 1)) {
      days.push(date.toISOString().slice(0, 10));
      if (days.length > 366) break;
    }
    return days;
  }

  function indexRaw(points) {
    const days = new Map();
    for (const point of points) {
      if (!days.has(point.date)) days.set(point.date, {MODIS: [], VIIRS: []});
      days.get(point.date)[point.sensor].push(point);
    }
    return days;
  }

  return {sensors, urls, extent, validBounds, contains, parseFirms, parseTeam, listDates, indexRaw};
})();
