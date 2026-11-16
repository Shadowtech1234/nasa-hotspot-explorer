"""Import FIRMS operational and archive exports into reusable monthly Parquet partitions."""

import argparse
from contextlib import contextmanager
import csv
from datetime import date, timedelta
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from time import sleep
from urllib.parse import quote
from urllib.request import urlopen
from zipfile import ZipFile

import duckdb
from h3.api import basic_int as h3

from .harmonize import MODIS, PLATFORMS, REFERENCE, RESOLUTION, cell_info
from .ingest import FIRMS_URL, REQUIRED, write_json
from .normalize import normalize


WORLD = (-180.0, -90.0, 180.0, 90.0)
PRODUCTS = {"MODIS": MODIS, "VIIRS_SNPP": REFERENCE, "VIIRS_NOAA20": 8, "VIIRS_NOAA21": 16}
PLATFORM_ALIASES = {
    "Terra": ("t", "terra"), "Aqua": ("a", "aqua"),
    "Suomi-NPP": ("n", "npp", "snpp", "suominpp", "suominationalpolarorbitingpartnership"),
    "NOAA-20": ("1", "j1", "n20", "noaa20", "jpss1"),
    "NOAA-21": ("2", "j2", "n21", "noaa21", "jpss2"),
}
PLATFORM_NAMES = {alias: platform for platform, aliases in PLATFORM_ALIASES.items() for alias in aliases}
MISSION_STARTS = dict(zip(PLATFORMS, ("2000-11-01", "2002-07-04", "2012-01-20", "2018-04-01", "2023-03-01")))
SNPP_FINAL_DAY = date(2026, 11, 2)
IMPORT_SCHEMA = 1
ARCHIVE_URL = "https://firms.modaps.eosdis.nasa.gov/download/"
RAW_COLUMNS = {
    "date_utc": "DATE", "record_id": "VARCHAR", "sensor": "VARCHAR", "platform": "VARCHAR",
    "platform_mask": "INTEGER", "product": "VARCHAR", "processing": "VARCHAR",
    "latitude": "DOUBLE", "longitude": "DOUBLE", "acquired_at_utc": "VARCHAR",
    "confidence_raw": "VARCHAR", "frp_mw": "DOUBLE", "fire_type": "VARCHAR", "version": "VARCHAR",
    "eligible": "BOOLEAN", "cell": "BIGINT", "cell_lat": "DOUBLE", "cell_lon": "DOUBLE",
    "tile": "BIGINT", "parent": "BIGINT", "month": "VARCHAR",
}


def parse_day(value):
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("Dates must use YYYY-MM-DD UTC format")
    return parsed


def date_range(start, end):
    return (start + timedelta(days=offset) for offset in range((end - start).days))


def parse_bounds(value):
    parts = value.split(",") if isinstance(value, str) else value
    if not isinstance(parts, (tuple, list)) or len(parts) != 4:
        raise ValueError("Bounding box must have west,south,east,north coordinates")
    west, south, east, north = map(float, parts)
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south < north <= 90
            and west != east and (west, east) != (180, -180)):
        raise ValueError("Invalid bounding box")
    return west, south, east, north


def longitude_ranges(west, east):
    return [(west, east)] if west < east else [(west, 180), (-180, east)]


def within_bounds(selection, archive):
    west, south, east, north = selection
    aw, a_south, ae, a_north = archive
    return a_south <= south < north <= a_north and all(
        any(lo <= start <= end <= hi for lo, hi in longitude_ranges(aw, ae))
        for start, end in longitude_ranges(west, east)
    )


def product_parts(product):
    base, _, processing = product.rpartition("_")
    if base not in PRODUCTS or processing not in {"SP", "NRT"}:
        raise ValueError(f"Unsupported FIRMS product: {product}")
    return PRODUCTS[base], processing


@contextmanager
def csv_file(path, processing):
    if path.suffix.lower() == ".zip":
        prefix = "fire_archive_" if processing == "SP" else "fire_nrt_"
        with ZipFile(path) as archive:
            files = [name for name in archive.namelist() if Path(name).name.lower().startswith(prefix)
                     and name.lower().endswith(".csv")]
            if len(files) != 1:
                raise ValueError(f"Expected one {prefix}*.csv in {path.name}")
            with archive.open(files[0]) as member, io.TextIOWrapper(member, encoding="utf-8-sig", newline="") as stream:
                yield stream
        return
    opener = gzip.open if path.suffix.lower() == ".gz" else open
    with opener(path, "rt", encoding="utf-8-sig", newline="") as stream:
        yield stream


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def identity(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest()


def publish_dir(staging, destination, marker):
    for attempt in range(7):
        try:
            staging.rename(destination)
            return
        except OSError as error:
            # A concurrent build of the same content may have already published it.
            if (destination / marker).is_file():
                return
            # Windows file indexing or cloud sync can briefly hold a new file open.
            if getattr(error, "winerror", None) not in {5, 32} or attempt == 6:
                raise
            sleep(0.05 * (attempt + 1))


def normalized_rows(stream, entry, bbox, audit):
    reader = csv.DictReader(stream, strict=True)
    source_mask, processing = product_parts(entry["product"])
    sensor = "MODIS" if source_mask == MODIS else "VIIRS"
    required = REQUIRED | ({"type", "confidence"} if processing == "SP" else set())
    fields = reader.fieldnames or []
    if len(set(fields)) != len(fields) or not required.issubset(fields):
        raise ValueError(f"Missing or duplicate {entry['product']} CSV headers")

    west, south, east, north = bbox
    intervals = longitude_ranges(west, east)
    versions = set()
    for line, row in enumerate(reader, 2):
        audit["input"] += 1
        try:
            observation, frp_issue = normalize(row, sensor, f"{entry['id'][:24]}:{line}")
            platform = PLATFORM_NAMES.get("".join(c for c in observation["platform"].lower() if c.isalnum()))
            bit = PLATFORMS.get(platform, 0)
            if not bit & source_mask:
                raise ValueError("Satellite does not match declared product")
            day = observation["acquired_at_utc"][:10]
            version = row.get("version", "").strip()
            if processing == "SP" and version.upper().endswith("RT"):
                raise ValueError("Provisional row in a standard-processing input")
        except ValueError as error:
            raise ValueError(f"{entry['name']} line {line}: {error}") from None

        lat, lon = observation["latitude"], observation["longitude"]
        if not (entry["start"] <= day < entry["end_exclusive"] and south <= lat <= north
                and any(lo <= lon <= hi for lo, hi in intervals)):
            audit["outside_selection"] += 1
            continue
        if day < MISSION_STARTS[platform] or (bit == REFERENCE and day > SNPP_FINAL_DAY.isoformat()):
            raise ValueError(f"{entry['name']} line {line}: acquisition outside {platform} mission record")

        confidence = observation["confidence_raw"]
        fire_type = row.get("type", "").strip()
        eligible = False
        if processing == "SP":
            try:
                if sensor == "MODIS":
                    score = float(confidence or "nan")
                    if not 0 <= score <= 100:
                        raise ValueError("invalid MODIS confidence")
                    eligible = score >= 30
                else:
                    code = (confidence or "").lower()
                    if code not in {"l", "n", "h", "low", "nominal", "high"}:
                        raise ValueError("invalid VIIRS confidence")
                    eligible = code in {"n", "h", "nominal", "high"}
                if fire_type not in {"0", "1", "2", "3"}:
                    raise ValueError("invalid FIRMS fire type")
            except ValueError as error:
                raise ValueError(f"{entry['name']} line {line}: {error}") from None
            eligible = eligible and fire_type == "0"

        cell = h3.latlng_to_cell(lat, lon, RESOLUTION) if eligible else None
        cell_lat, cell_lon, tile, parent = cell_info(cell) if eligible else (None, None, None, None)
        audit["retained"] += 1
        audit["eligible"] += int(eligible)
        if frp_issue:
            audit[frp_issue] += 1
        if version:
            versions.add(version)
        yield (day, observation["record_id"], sensor, platform, bit, entry["product"], processing,
               lat, lon, observation["acquired_at_utc"], confidence, observation["frp_mw"], fire_type or None,
               version or None, eligible, cell, cell_lat, cell_lon, tile, parent, day[:7])
    audit["versions"] = sorted(versions)


def import_input(db, path, entry, bbox, output):
    cache = output / "raw" / entry["id"]
    marker = cache / "input.json"
    if marker.is_file():
        return json.loads(marker.read_text(encoding="utf-8"))
    cache.parent.mkdir(parents=True, exist_ok=True)
    audit = dict.fromkeys(("input", "retained", "outside_selection", "eligible", "missing_frp", "invalid_frp"), 0)
    with tempfile.TemporaryDirectory(dir=cache.parent) as tmp:
        stage = Path(tmp) / "publish"
        stage.mkdir()
        spool = Path(tmp) / "raw.csv"
        with csv_file(path, product_parts(entry["product"])[1]) as source, spool.open("w", newline="", encoding="utf-8") as target:
            writer = csv.writer(target)
            writer.writerow(RAW_COLUMNS)
            writer.writerows(normalized_rows(source, entry, bbox, audit))
        if digest_file(path) != entry["sha256"]:
            raise ValueError(f"Input changed during import: {path.name}")
        if audit["retained"]:
            columns = ", ".join(f"'{key}': '{kind}'" for key, kind in RAW_COLUMNS.items())
            # DuckDB requires a parameter-free destination for partitioned COPY.
            destination = (stage / "months").as_posix().replace("'", "''")
            db.execute(f"""COPY (SELECT * FROM read_csv(?, header=true, columns={{{columns}}},
                                  auto_detect=false, delim=',', quote='\"', escape='\"')
                                  ORDER BY date_utc, record_id)
                           TO '{destination}' (FORMAT parquet, PARTITION_BY (month))""", [spool.as_posix()]).fetchall()
        partitions = {}
        for folder in sorted((stage / "months").glob("month=*")):
            partitions[folder.name[6:]] = [(cache / file.relative_to(stage)).relative_to(output).as_posix()
                                           for file in sorted(folder.glob("*.parquet"))]
        result = {**entry, "audit": audit, "partitions": partitions}
        write_json(stage / "input.json", result)
        publish_dir(stage, cache, "input.json")
    return result


def read_config(path):
    config = json.loads(path.read_text(encoding="utf-8"))
    bbox = parse_bounds(config.get("bbox", WORLD))
    inputs = []
    windows = {}
    for raw in config["inputs"]:
        product = raw["product"]
        product_parts(product)
        start, end = parse_day(raw["start"]), parse_day(raw["end_exclusive"])
        if start >= end:
            raise ValueError("Input dates must give a nonempty interval")
        for other_start, other_end in windows.setdefault(product, []):
            if start < other_end and other_start < end:
                raise ValueError(f"Overlapping {product} inputs; replace the affected interval in the manifest")
        windows[product].append((start, end))
        source = path.parent / raw["path"]
        entry = {"product": product, "start": start.isoformat(), "end_exclusive": end.isoformat(),
                 "sha256": digest_file(source), "name": source.name, "attribution": "NASA FIRMS",
                 "source_url": raw.get("source_url", ARCHIVE_URL), "retrieved_at_utc": raw.get("retrieved_at_utc")}
        entry["id"] = identity([IMPORT_SCHEMA, bbox, product, entry["start"], entry["end_exclusive"], entry["sha256"]])
        inputs.append((source, entry))
    if not inputs:
        raise ValueError("Declare at least one FIRMS input")
    outages = config.get("outages", [])
    for outage in outages:
        if outage["platform"] not in PLATFORMS or parse_day(outage["start"]) >= parse_day(outage["end_exclusive"]):
            raise ValueError("Outages must give a known platform and nonempty UTC date interval")
    footprint = None
    if "footprint" in config:
        info = config["footprint"]
        footprint = ((path.parent / info["path"]).read_bytes(), info["source_url"])
    region = config.get("region", "World" if bbox == WORLD else "Archive study area")
    return bbox, region, inputs, outages, footprint


def day_masks(imports, outages):
    """File coverage describes reported input availability; local swath coverage is unknown."""
    first = min(parse_day(entry["start"]) for entry in imports)
    end = max(parse_day(entry["end_exclusive"]) for entry in imports)
    standard = dict.fromkeys((day.isoformat() for day in date_range(first, end)), 0)
    provisional = standard.copy()
    for entry in imports:
        mask, processing = product_parts(entry["product"])
        target = standard if processing == "SP" else provisional
        start, stop = parse_day(entry["start"]), parse_day(entry["end_exclusive"])
        for name, bit in PLATFORMS.items():
            if mask & bit:
                platform_end = min(stop, SNPP_FINAL_DAY + timedelta(days=1)) if bit == REFERENCE else stop
                for day in date_range(max(start, parse_day(MISSION_STARTS[name])), platform_end):
                    target[day.isoformat()] |= bit
    for day in provisional:
        provisional[day] &= ~standard[day]
    available = standard.copy()
    if SNPP_FINAL_DAY.isoformat() in available:
        available[SNPP_FINAL_DAY.isoformat()] &= ~REFERENCE
    for outage in outages:
        start = max(first, parse_day(outage["start"]))
        stop = min(end, parse_day(outage["end_exclusive"]))
        for day in date_range(start, stop):
            available[day.isoformat()] &= ~PLATFORMS[outage["platform"]]
    return standard, provisional, available


def fetch(product, bbox, start, end, path, key):
    product_parts(product)
    if not start < end or not key.strip():
        raise ValueError("Set FIRMS_MAP_KEY and specify a nonempty date interval")
    area = "world" if bbox == WORLD else ",".join(map(str, bbox))
    if bbox[0] >= bbox[2]:
        raise ValueError("Use archive CSVs for antimeridian-crossing extracts")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as temp:
        target = Path(temp) / "download.csv"
        with target.open("w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file)
            fields = None
            for offset in range(0, (end - start).days, 5):
                day = start + timedelta(days=offset)
                limit = min((end - day).days, 5)
                url = f"{FIRMS_URL}csv/{quote(key.strip(), safe='')}/{product}/{area}/{limit}/{day}"
                try:
                    with urlopen(url, timeout=90) as response, io.TextIOWrapper(response, encoding="utf-8-sig", newline="") as stream:
                        reader = csv.reader(stream, strict=True)
                        header = next(reader, [])
                        if len(set(header)) != len(header) or not REQUIRED.issubset(header):
                            raise ValueError("Invalid FIRMS header")
                        if fields is None:
                            fields = header
                            writer.writerow(fields)
                        if header != fields:
                            raise ValueError("FIRMS header changed")
                        writer.writerows(reader)
                except (OSError, ValueError, csv.Error):
                    raise ValueError(f"FIRMS request failed for {product} starting {day}. Check key and source availability.") from None
        target.replace(path)


def main():
    from .aggregate import OUTPUT_DIR
    from .history import build_archive

    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("manifest", type=Path)
    build.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    download = commands.add_parser("fetch")
    download.add_argument("product")
    download.add_argument("start")
    download.add_argument("end_exclusive")
    download.add_argument("csv", type=Path)
    download.add_argument("--bbox", default=WORLD)
    args = parser.parse_args()
    try:
        if args.command == "build":
            print(build_archive(args.manifest, args.output_dir))
        else:
            fetch(args.product, parse_bounds(args.bbox), parse_day(args.start), parse_day(args.end_exclusive),
                  args.csv, os.environ.get("FIRMS_MAP_KEY", ""))
    except (OSError, ValueError, TypeError, KeyError, csv.Error, duckdb.Error) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
