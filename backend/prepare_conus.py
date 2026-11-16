"""Prepare standard-processing FIRMS inputs for the contiguous U.S. archive."""

import argparse
from contextlib import ExitStack
import csv
from datetime import date, timedelta
import gzip
from pathlib import Path
import tempfile

import duckdb
import numpy as np
import shapefile
import shapely

from .archive import PLATFORM_NAMES, date_range
from .ingest import write_json


BOUNDARY_FILE = "cb_2024_us_state_500k.zip"
BOUNDARY_URL = "https://www2.census.gov/geo/tiger/GENZ2024/shp/" + BOUNDARY_FILE
MIRROR_URL = ("https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/"
              "portolan-mirrors/firms-catalog/detections/year={year}/detections.parquet")
STATE_EXCLUSIONS = {"AK", "HI", "AS", "GU", "MP", "PR", "VI", "UM"}
FIELDS = ("latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "frp", "type", "version")
PRODUCTS = {"MODIS": "MODIS_SP", "VIIRS_SNPP": "VIIRS_SNPP_SP"}


def census_footprint(path):
    with shapefile.Reader(str(path)) as states:
        shapes = [shapely.geometry.shape(item.shape.__geo_interface__)
                  for item in states.iterShapeRecords() if item.record.STUSPS not in STATE_EXCLUSIONS]
    if len(shapes) != 49:
        raise ValueError(f"Expected 48 states and D.C. in {path}")
    geometry = shapely.union_all(shapes)
    if geometry.geom_type not in {"Polygon", "MultiPolygon"} or not geometry.is_valid:
        raise ValueError(f"Invalid Census boundary in {path}")
    return geometry


def prepare_year(db, source, year, footprint, output):
    start, end = date(year, 1, 1), date(year + 1, 1, 1)
    west, south, east, north = footprint.bounds
    url = MIRROR_URL.format(year=year)
    filters = "quality = 'sp' AND sensor IN ('MODIS', 'VIIRS_SNPP')"
    global_days = {}
    for day, satellite, count in db.execute(f"""
        SELECT acq_date, satellite, count(*) FROM read_parquet(?) WHERE {filters} GROUP BY ALL
    """, [str(source)]).fetchall():
        name = PLATFORM_NAMES.get("".join(char for char in satellite.lower() if char.isalnum()))
        if name is None or not start <= day < end:
            raise ValueError(f"Unexpected date or satellite in {source}: {day}, {satellite}")
        global_days[day, name] = count
    outages = [{"platform": platform, "start": day.isoformat(),
                "end_exclusive": (day + timedelta(days=1)).isoformat(),
                "reason": "No worldwide standard-processing detections in source",
                "source_url": url}
               for day in date_range(start, end) for platform in ("Terra", "Aqua", "Suomi-NPP")
               if (day, platform) not in global_days]
    if any(not any(name == platform for _, name in global_days) for platform in ("Terra", "Aqua", "Suomi-NPP")):
        raise ValueError(f"{source} is missing an entire platform")

    inputs = []
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        stage = Path(temporary)
        with ExitStack() as stack:
            writers = {}
            for sensor, product in PRODUCTS.items():
                name = f"{product}-{year}.csv.gz"
                stream = stack.enter_context(gzip.open(stage / name, "wt", encoding="utf-8", newline=""))
                writer = csv.writer(stream)
                writer.writerow(FIELDS)
                writers[sensor] = writer
                inputs.append({"product": product, "path": name, "start": start.isoformat(),
                               "end_exclusive": end.isoformat(), "source_url": url})
            cursor = db.execute(f"""
                WITH candidates AS (
                    SELECT sensor, ST_Y(geometry) AS latitude, ST_X(geometry) AS longitude,
                           acq_date, strftime(acq_datetime, '%H%M') AS acq_time, satellite,
                           coalesce(confidence_pct::VARCHAR, confidence) AS confidence, frp, type, version
                    FROM read_parquet(?) WHERE {filters}
                )
                SELECT * FROM candidates WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
            """, [str(source), south, north, west, east])
            counts = dict.fromkeys(PRODUCTS, 0)
            while rows := cursor.fetchmany(32_768):
                latitudes = np.fromiter((row[1] for row in rows), dtype=float)
                longitudes = np.fromiter((row[2] for row in rows), dtype=float)
                covered = shapely.intersects_xy(footprint, longitudes, latitudes)
                for (sensor, *values), inside in zip(rows, covered):
                    if inside:
                        writers[sensor].writerow(values)
                        counts[sensor] += 1
        for entry in inputs:
            (stage / entry["path"]).replace(output / entry["path"])
    print(f"{year}: {counts}; {len(outages)} missing platform dates", flush=True)
    return inputs, outages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path, help="Directory with Census ZIP and YYYY.parquet source files")
    parser.add_argument("output_dir", type=Path, help="Directory for generated CSVs and archive.json")
    parser.add_argument("--years", nargs="+", type=int, default=list(range(2019, 2025)))
    parser.add_argument("--extension-dir", type=Path, help="DuckDB extension cache directory")
    args = parser.parse_args()
    footprint = census_footprint(args.source_dir / BOUNDARY_FILE)
    shapely.prepare(footprint)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    config = {"threads": 2, "memory_limit": "384MB"}
    if args.extension_dir:
        config["extension_directory"] = str(args.extension_dir.resolve())
    inputs, outages = [], []
    with duckdb.connect(config=config) as db:
        db.execute("LOAD spatial")
        for year in sorted(set(args.years)):
            year_inputs, year_outages = prepare_year(db, args.source_dir / f"{year}.parquet", year,
                                                     footprint, args.output_dir)
            inputs.extend(year_inputs)
            outages.extend(year_outages)
    (args.output_dir / "footprint.wkb").write_bytes(shapely.to_wkb(footprint))
    write_json(args.output_dir / "archive.json", {
        "region": "Contiguous United States", "bbox": footprint.bounds, "inputs": inputs,
        "outages": outages, "footprint": {"path": "footprint.wkb", "source_url": BOUNDARY_URL},
    })


if __name__ == "__main__":
    main()
