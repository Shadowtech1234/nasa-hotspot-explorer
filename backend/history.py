"""Build and query the versioned FIRMS burning activity archive."""

from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import date, timedelta
from functools import lru_cache
import json
from pathlib import Path
from statistics import median
import tempfile

import duckdb
from h3.api import basic_int as h3

from .archive import (WORLD, date_range, day_masks, identity, import_input, parse_bounds, parse_day,
                      publish_dir, read_config, within_bounds)
from .harmonize import MODES, MODIS, PLATFORMS, REFERENCE, RESOLUTION, calibrate, select_mode
from .ingest import write_json


SCHEMA_VERSION = 2
ACTIVE_HISTORY = "history.json"
archive_modes = {**MODES, REFERENCE: "Suomi-NPP"}


@contextmanager
def connect(output):
    spill = output / "query-tmp"
    spill.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=spill) as session:
        with duckdb.connect(config={"threads": 2, "temp_directory": session}) as db:
            yield db


def partitions(output, paths):
    return [(output / path).as_posix() for path in paths]


def copy_query(db, path, query, params):
    destination = path.as_posix().replace("'", "''")
    db.execute(f"COPY ({query}) TO '{destination}' (FORMAT parquet, COMPRESSION zstd)", params).fetchall()


def build_cells(db, output, raw):
    cache = output / "cells" / identity([SCHEMA_VERSION, raw])
    dest = cache / "cells.parquet"
    if not dest.is_file():
        cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=cache.parent) as tmp:
            stage = Path(tmp) / "publish"
            stage.mkdir()
            copy_query(db, stage / dest.name, """
                SELECT date_utc, cell, any_value(cell_lat) AS cell_lat, any_value(cell_lon) AS cell_lon,
                       any_value(tile) AS tile, any_value(parent) AS parent, bit_or(platform_mask) AS platforms
                FROM read_parquet(?) WHERE eligible GROUP BY date_utc, cell ORDER BY date_utc, cell
            """, [partitions(output, raw)])
            publish_dir(stage, cache, dest.name)
    return dest.relative_to(output).as_posix()


def insert_days(db, days):
    # Bind one document so DuckDB can convert the date coverage in bulk.
    db.execute("""
        CREATE TEMP TABLE days AS SELECT key::DATE AS date_utc,
            (value->>'sp')::INTEGER AS sp, (value->>'nrt')::INTEGER AS nrt,
            (value->>'available')::INTEGER AS available, (value->>'mode')::INTEGER AS mode
        FROM json_each(?::JSON)
    """, [json.dumps(days, separators=(",", ":"))])


def pairs_for_calibration(db, output, cells, days):
    insert_days(db, days)
    db.execute("CREATE TEMP TABLE paired (mode INTEGER, month VARCHAR, tile BIGINT, source BIGINT, reference BIGINT)")
    # The work table holds monthly tile summaries on matched available dates. DuckDB
    # can spill this table and joins to disk during a worldwide rebuild.
    for month, path in cells.items():
        db.execute("""
            INSERT INTO paired
            SELECT candidate.mode, ?, c.tile,
                   count_if(c.platforms & candidate.mode <> 0), count_if(c.platforms & 4 <> 0)
            FROM read_parquet(?) c JOIN days d USING (date_utc)
            JOIN (VALUES (8), (16), (3), (1), (2)) candidate(mode)
              ON d.available & (candidate.mode | 4) = (candidate.mode | 4)
            WHERE c.platforms & (candidate.mode | 4) <> 0
            GROUP BY candidate.mode, c.tile
        """, [month, (output / path).as_posix()])

    def query(mode, year_start, holdout):
        predicate = "left(month, 4) = left(?, 4)" if holdout else "month < ?"
        cursor = db.execute(f"SELECT month, tile, source, reference FROM paired WHERE mode = ? AND {predicate}",
                            [mode, year_start])
        while batch := cursor.fetchmany(8192):
            yield from batch

    return query


def insert_factors(db, coefficient_rows):
    columns = [list(column) for column in zip(*coefficient_rows)] if coefficient_rows else [[], [], [], []]
    db.execute("""
        CREATE TEMP TABLE factor AS SELECT unnest(?::INTEGER[]) AS mode, unnest(?::INTEGER[]) AS season,
            unnest(?::BIGINT[]) AS tile, unnest(?::DOUBLE[]) AS value
    """, columns)


WEIGHTED_CELLS = """
    SELECT c.*,
           CASE WHEN c.platforms & d.mode = 0 THEN 0.0 WHEN d.mode = 4 THEN 1.0
                ELSE coalesce(local.value, broader.value, seasonal.value, annual.value) END AS activity
    FROM read_parquet(?) c JOIN days d USING (date_utc)
    LEFT JOIN factor local ON (local.mode, local.season, local.tile) = (d.mode, month(c.date_utc), c.tile)
    LEFT JOIN factor broader ON (broader.mode, broader.season, broader.tile) = (d.mode, month(c.date_utc), c.parent)
    LEFT JOIN factor seasonal ON (seasonal.mode, seasonal.season, seasonal.tile) = (d.mode, month(c.date_utc), 0)
    LEFT JOIN factor annual ON (annual.mode, annual.season, annual.tile) = (d.mode, 0, 0)
"""


def archive_inventory(imports):
    products = defaultdict(list)
    for item in imports:
        products[item["product"]].append(item)
    return {product: {
        "start": min(item["start"] for item in files),
        "end_exclusive": max(item["end_exclusive"] for item in files),
        "records": sum(item["audit"]["retained"] for item in files),
        "versions": sorted({version for item in files for version in item["audit"]["versions"]}),
    } for product, files in products.items()}


def build_archive(config, output):
    bbox, region, inputs, outages = read_config(Path(config))
    output = Path(output).resolve()
    version = identity([SCHEMA_VERSION, bbox, region, outages, sorted(
        (entry for _, entry in inputs), key=lambda entry: entry["id"])])[:24]
    release = output / "history" / version
    marker = "release.json"
    if not (release / marker).is_file():
        release.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=release.parent) as tmp:
            stage = Path(tmp) / "publish"
            stage.mkdir()
            with connect(output) as db:
                manifest, reports, imports = prepare_archive(db, output, release, stage, version, bbox, region, inputs, outages)
            write_json(stage / "validation.json", {"data_version": version, "bbox": bbox, "reference": "Suomi-NPP detections",
                       "unit": "active cell-days per H3 resolution 3 tile-month", "calibrations": reports})
            write_json(stage / "audit.json", {"data_version": version, "inputs": imports, "outages": outages})
            write_json(stage / marker, manifest)
            publish_dir(stage, release, marker)
    write_json(output / ACTIVE_HISTORY, {"data_version": version})
    return release


def prepare_archive(db, output, release, stage, version, bbox, region, inputs, outages):
    imports = [import_input(db, path, entry, bbox, output) for path, entry in inputs]
    # Use the current manifest provenance even when the normalized bytes were cached.
    imports = [{**item, **entry} for item, (_, entry) in zip(imports, inputs)]
    standard, provisional, available = day_masks(imports, outages)
    days = {day: {"sp": sp, "nrt": provisional[day], "available": available[day], "mode": 0}
            for day, sp in standard.items()}
    raw, cells, monthly = defaultdict(list), {}, {}
    for item in imports:
        for month, files in item["partitions"].items():
            raw[month].extend(files)
    for month in sorted(raw):
        raw[month].sort()
        cells[month] = build_cells(db, output, raw[month])

    pairs = pairs_for_calibration(db, output, cells, days)
    models, reports = calibrate(pairs, available, standard)
    coefficient_rows = [(mode, season, tile, factor) for mode, model in models.items()
                        for (season, tile), factor in sorted(model.items())]
    db.execute("DROP TABLE paired")
    db.execute("DROP TABLE days")
    for info in days.values():
        info["mode"] = select_mode(info["available"], models)
    insert_days(db, days)
    insert_factors(db, coefficient_rows)
    copy_query(db, stage / "factors.parquet", "SELECT * FROM factor", [])
    worldwide_totals = {}
    for month, path in cells.items():
        file = stage / f"{month}.parquet"
        copy_query(db, file, f"""
            SELECT ?::VARCHAR AS month, cell, any_value(cell_lat) AS cell_lat, any_value(cell_lon) AS cell_lon,
                   count(*) AS observed, sum(activity) AS activity
            FROM ({WEIGHTED_CELLS}) GROUP BY cell ORDER BY cell
        """, [month, (output / path).as_posix()])
        monthly[month] = (release / file.name).relative_to(output).as_posix()
        worldwide_totals[month] = db.execute("SELECT sum(observed), sum(activity) FROM read_parquet(?)",
                                             [file.as_posix()]).fetchall()[0]
    manifest = {"schema_version": SCHEMA_VERSION, "data_version": version, "region": region, "bbox": bbox,
                "start": min(days), "end_exclusive": (parse_day(max(days)) + timedelta(days=1)).isoformat(),
                "days": days, "raw": raw, "cells": cells, "monthly": monthly,
                "worldwide_totals": worldwide_totals, "product_coverage": archive_inventory(imports)}
    return manifest, reports, imports


def open_history(output):
    pointer = output / ACTIVE_HISTORY
    if not pointer.is_file():
        return None
    version = json.loads(pointer.read_text(encoding="utf-8"))["data_version"]
    return read_release(output, version)


@lru_cache(maxsize=4)
def read_release(output, version):
    manifest = json.loads((output / "history" / version / "release.json").read_text(encoding="utf-8"))
    return History(output, manifest)


def bbox_filter(bbox, lon, lat):
    west, south, east, north = bbox
    if bbox == WORLD:
        return "true", []
    longitudes = f"{lon} BETWEEN ? AND ?" if west < east else f"({lon} >= ? OR {lon} <= ?)"
    return f"{lat} BETWEEN ? AND ? AND {longitudes}", [south, north, west, east]


def platform_names(mask):
    return [name for name, bit in PLATFORMS.items() if mask & bit]


def month_end(month):
    year, number = map(int, month.split("-"))
    return date(year + (number == 12), number % 12 + 1, 1)


class History:
    def __init__(self, output, manifest):
        self.output = output
        self.manifest = manifest
        self.version = manifest["data_version"]
        self.extent = tuple(manifest["bbox"])
        self.days = manifest["days"]
        self.start = parse_day(manifest["start"])
        self.end = parse_day(manifest["end_exclusive"])

    def selection(self, value):
        bbox = self.extent if value is None else parse_bounds(value)
        if not within_bounds(bbox, self.extent):
            raise ValueError("Bounding box lies outside this archive release")
        return bbox

    def metadata(self, bbox):
        products = self.manifest["product_coverage"]
        sources = {
            sensor: " + ".join(product for product in products if product.startswith(sensor))
            for sensor in ("MODIS", "VIIRS")
        }
        return {"archive": True, "schema_version": SCHEMA_VERSION, "data_version": self.version,
                "bbox": bbox, "archive_bbox": self.extent, "region": self.manifest["region"],
                "archive_start": self.start.isoformat(), "archive_end_exclusive": self.end.isoformat(), "sources": sources,
                "coverage": "unknown", "h3_resolution": RESOLUTION}

    def validation(self):
        path = self.output / "history" / self.version / "validation.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def raw_counts(self, db, days, bbox):
        paths = [file for month in {day[:7] for day in days} for file in self.manifest["raw"].get(month, [])]
        if not paths:
            return {}
        bounds, params = bbox_filter(bbox, "r.longitude", "r.latitude")
        return {(day.isoformat(), sensor): count for day, sensor, count in db.execute(f"""
            SELECT r.date_utc, r.sensor, count(*) FROM read_parquet(?) r JOIN days d USING (date_utc)
            WHERE (r.processing = 'SP' OR r.platform_mask & d.nrt <> 0) AND {bounds}
            GROUP BY r.date_utc, r.sensor
        """, [partitions(self.output, paths), *params]).fetchall()}

    def day_rows(self, db, days, bbox, *, include_raw):
        insert_days(db, days)
        factor_file = self.output / "history" / self.version / "factors.parquet"
        db.execute("CREATE TEMP TABLE factor AS SELECT * FROM read_parquet(?)", [factor_file.as_posix()])
        cell_paths = [self.manifest["cells"][month] for month in sorted({day[:7] for day in days})
                      if month in self.manifest["cells"]]
        by_day = {}
        if cell_paths:
            bounds, params = bbox_filter(bbox, "cell_lon", "cell_lat")
            by_day = {day.isoformat(): (observed, activity) for day, observed, activity in db.execute(f"""
                SELECT date_utc, count(*), sum(activity) FROM ({WEIGHTED_CELLS}) WHERE {bounds} GROUP BY date_utc
            """, [partitions(self.output, cell_paths), *params]).fetchall()}
        raw = self.raw_counts(db, days, bbox) if include_raw else {}
        db.execute("DROP TABLE days")
        db.execute("DROP TABLE factor")
        rows = []
        for day, info in days.items():
            observed, activity = by_day.get(day, (0, 0.0))
            row = {"date_utc": day, "observed_cell_days": observed if observed or info["available"] else None,
                   "activity": activity if info["mode"] else None, "source": archive_modes.get(info["mode"]),
                   "standard_platforms": platform_names(info["sp"]), "provisional_platforms": platform_names(info["nrt"])}
            if include_raw:
                availability = info["available"] | info["nrt"]
                row["sensor_detections"] = {
                    sensor: raw.get((day, sensor), 0) if (day, sensor) in raw or availability & mask else None
                    for sensor, mask in (("MODIS", MODIS), ("VIIRS", 28))
                }
            rows.append(row)
        return rows

    def month_rows(self, db, days, bbox):
        calendar = defaultdict(dict)
        for day, info in days.items():
            calendar[day[:7]][day] = info
        # Previous complete months serve as the baseline even when outside the selected date range.
        past_modes = Counter(day[:7] for day, info in self.days.items() if info["mode"])
        seasons = {month[5:] for month in calendar}
        baseline = {month for month, count in past_modes.items() if month[5:] in seasons
                    and month < max(calendar) and count == (month_end(month) - parse_day(month + "-01")).days}
        complete = {month for month, selected in calendar.items()
                    if len(selected) == sum(day.startswith(month) for day in self.days)}
        needed = complete | baseline
        if bbox == WORLD:
            totals = self.manifest["worldwide_totals"]
        else:
            totals = {}
            paths = [self.manifest["monthly"][month] for month in sorted(needed) if month in self.manifest["monthly"]]
            if paths:
                bounds, params = bbox_filter(bbox, "cell_lon", "cell_lat")
                totals = {month: (observed, activity) for month, observed, activity in db.execute(f"""
                    SELECT month, sum(observed), sum(activity) FROM read_parquet(?) WHERE {bounds} GROUP BY month
                """, [partitions(self.output, paths), *params]).fetchall()}
        rows = []
        for month, selected in sorted(calendar.items()):
            observed, activity = totals.get(month, (0, 0.0))
            if month not in complete:
                partial = self.day_rows(db, selected, bbox, include_raw=False)
                observed = sum(row["observed_cell_days"] or 0 for row in partial)
                activity = sum(row["activity"] or 0.0 for row in partial)
            source_days = Counter(archive_modes[info["mode"]] for info in selected.values() if info["mode"])
            standard_days = sum(bool(info["available"]) for info in selected.values())
            usable = sum(source_days.values())
            expected = (month_end(month) - parse_day(month + "-01")).days
            historical = [totals.get(past, (0, 0.0))[1] or 0.0 for past in baseline
                          if past[5:] == month[5:] and past < month]
            historical_median = percentile = None
            if usable == expected and len(historical) >= 5:
                value = activity or 0.0
                historical_median = median(historical)
                percentile = 100 * (sum(item < value for item in historical)
                                    + 0.5 * sum(item == value for item in historical)) / len(historical)
            rows.append({"date_utc": month + "-01", "first_day": min(selected), "last_day": max(selected),
                         "observed_cell_days": (observed or 0) if standard_days or observed else None,
                         "activity": (activity or 0.0) if usable else None, "standard_days": standard_days,
                         "usable_days": usable, "days_in_month": expected, "selected_days": len(selected),
                         "provisional_days": sum(bool(info["nrt"]) for info in selected.values()),
                         "source_days": dict(source_days), "historical_median": historical_median,
                         "historical_percentile": percentile, "baseline_years": len(historical)})
        return rows

    def calendar(self, bbox, start, end, granularity):
        if not self.start <= start < end <= self.end:
            raise ValueError("Date range lies outside this archive release or is empty")
        if granularity == "day" and (end - start).days > 366:
            raise ValueError("Request up to 366 days, or use monthly granularity")
        days = {day.isoformat(): self.days[day.isoformat()] for day in date_range(start, end)}
        with connect(self.output) as db:
            rows = (self.month_rows(db, days, bbox) if granularity == "month"
                    else self.day_rows(db, days, bbox, include_raw=True))
        # Daily estimates are intermediate weights; the public comparable unit is monthly.
        if granularity == "day":
            for row in rows:
                del row["activity"]
        return {**self.metadata(bbox), "start": start.isoformat(), "end_exclusive": end.isoformat(), "granularity": granularity,
                "metric": "snpp_equivalent_active_cell_days" if granularity == "month" else "observed_active_cell_days",
                "product_coverage": self.manifest["product_coverage"], "rows": rows}

    def overview(self, bbox, month, start, end, resolution=2):
        if month.day != 1 or not self.start <= start < end <= self.end or start.strftime("%Y-%m") != month.strftime("%Y-%m") or end > month_end(month.strftime("%Y-%m")):
            raise ValueError("Select a date interval inside one archive month")
        return overview_regions(self, bbox, month, start, end, resolution)

    def map_points(self, day, bbox, layer, sensor, limit, offset):
        info = self.days[day]
        month = day[:7]
        features = []
        with connect(self.output) as db:
            if layer == "cells" and month in self.manifest["cells"]:
                bounds, params = bbox_filter(bbox, "cell_lon", "cell_lat")
                sensor_mask = {"MODIS": MODIS, "VIIRS": 28, None: 31}[sensor]
                rows = db.execute(f"""
                    SELECT cell_lon, cell_lat, cell, platforms FROM read_parquet(?)
                    WHERE date_utc = ?::DATE AND (platforms & ? <> 0) AND {bounds}
                    ORDER BY cell LIMIT ? OFFSET ?
                """, [(self.output / self.manifest["cells"][month]).as_posix(), day, sensor_mask,
                      *params, limit + 1, offset]).fetchall()
                features = [point(lon, lat, {"cell": h3.int_to_str(cell), "platforms": platform_names(mask)})
                            for lon, lat, cell, mask in rows]
            if layer == "detections" and month in self.manifest["raw"]:
                bounds, params = bbox_filter(bbox, "longitude", "latitude")
                rows = db.execute(f"""
                    SELECT longitude, latitude, record_id, sensor, platform, acquired_at_utc, confidence_raw, frp_mw,
                           fire_type, version, product, processing, eligible
                    FROM read_parquet(?) WHERE date_utc = ?::DATE AND (processing = 'SP' OR platform_mask & ? <> 0)
                         AND (? IS NULL OR sensor = ?) AND {bounds}
                    ORDER BY acquired_at_utc, record_id LIMIT ? OFFSET ?
                """, [partitions(self.output, self.manifest["raw"][month]), day, info["nrt"], sensor, sensor,
                      *params, limit + 1, offset]).fetchall()
                fields = ("record_id", "sensor", "platform", "acquired_at_utc", "confidence_raw", "frp_mw",
                          "fire_type", "version", "product", "processing", "eligible")
                features = [point(lon, lat, dict(zip(fields, attributes))) for lon, lat, *attributes in rows]
        return {"type": "FeatureCollection", "features": features[:limit], "metadata": {
            **self.metadata(bbox), "date_utc": day, "layer": layer, "selected_sensor": sensor,
            "standard_platforms": platform_names(info["sp"]), "provisional_platforms": platform_names(info["nrt"]),
            "next_offset": offset + limit if len(features) > limit else None,
        }}


def point(lon, lat, properties):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": properties}


@lru_cache(maxsize=32)
def overview_regions(history, bbox, month, start, end, resolution):
    """Aggregate fine cells to map regions before ranking their historical totals."""
    key = month.strftime("%Y-%m")
    complete = Counter(day[:7] for day, info in history.days.items() if info["mode"])
    baseline = sorted(past for past, count in complete.items()
                      if past < key and past[5:] == key[5:]
                      and count == (month_end(past) - parse_day(past + "-01")).days)
    complete_current = start == month and end == month_end(key) and complete[key] == (end - start).days
    days = {day.isoformat(): history.days[day.isoformat()] for day in date_range(start, end)}
    usable = any(info["mode"] for info in days.values())
    paths = [history.manifest["monthly"][past] for past in baseline if past in history.manifest["monthly"]]
    observed_totals = defaultdict(dict)
    bounds, params = bbox_filter(bbox, "cell_lon", "cell_lat")
    # H3 stores the resolution above the base cell and pads unused child digits with ones.
    # Roll up in DuckDB so a worldwide query sends only region-month totals to Python.
    region_id = f"((cell & {~(15 << 52)}) | {resolution << 52} | {(1 << ((15 - resolution) * 3)) - 1})"
    with connect(history.output) as db:
        if paths:
            rows = db.execute(f"""
                SELECT month, {region_id} AS region, sum(activity) FROM read_parquet(?) WHERE {bounds}
                GROUP BY month, region
            """, [partitions(history.output, paths), *params]).fetchall()
            for past, region, activity in rows:
                observed_totals[region][past] = activity or 0
        current_path = history.manifest["cells"].get(key)
        current = defaultdict(lambda: [0, 0.0])
        if current_path:
            insert_days(db, days)
            factor_path = history.output / "history" / history.version / "factors.parquet"
            db.execute("CREATE TEMP TABLE factor AS SELECT * FROM read_parquet(?)", [factor_path.as_posix()])
            rows = db.execute(f"""
                SELECT {region_id} AS region, count(*), sum(activity) FROM ({WEIGHTED_CELLS})
                WHERE {bounds} GROUP BY region
            """, [(history.output / current_path).as_posix(), *params]).fetchall()
            for region, observed, activity in rows:
                current[region] = (observed, activity or 0)
    features = []
    # Regions with past activity can show an unusually quiet month with zero reports.
    for region in sorted(current.keys() | (observed_totals.keys() if complete_current else set())):
        observed, value = current[region]
        past = [observed_totals[region].get(year, 0) for year in baseline]
        percentile = historical_median = None
        if complete_current and len(past) >= 5:
            historical_median = median(past)
            percentile = 100 * (sum(item < value for item in past) + 0.5 * sum(item == value for item in past)) / len(past)
        lat, lon = h3.cell_to_latlng(region)
        boundary = h3.cell_to_boundary(region)
        unwrapped = [lon + (x - lon + 180) % 360 - 180 for _, x in boundary]
        wrap = lambda x: (x + 180) % 360 - 180
        region_bbox = [wrap(min(unwrapped)), min(y for y, _ in boundary),
                       wrap(max(unwrapped)), max(y for y, _ in boundary)]
        features.append(point(lon, lat, {"region": h3.int_to_str(region), "activity": value if usable else None,
                                         "bbox": region_bbox,
                                         "observed_cell_days": observed, "baseline_years": len(past),
                                         "historical_median": historical_median, "historical_percentile": percentile}))
    return {"type": "FeatureCollection", "features": features,
            "metadata": {**history.metadata(bbox), "complete_month": complete_current}}
