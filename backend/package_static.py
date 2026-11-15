"""Package registered FIRMS CSVs for the static explorer."""

import argparse
from collections import defaultdict
import csv
from datetime import date
import hashlib
import io
import json
import math
from pathlib import Path

from .ingest import open_csv, write_json
from .normalize import normalize


OVERVIEW_CELL_SIZE = 1


def bounds(values):
    west, south, east, north = map(float, values)
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("Expected valid west, south, east, north bounds.")
    return [west, south, east, north]


def contains(outer, inner):
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and outer[2] >= inner[2] and outer[3] >= inner[3])


def cell(lon, lat, size):
    return math.floor(lon / size) * size, math.floor(lat / size) * size


def month_bounds(month):
    start = date.fromisoformat(month + "-01")
    end = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    return start.isoformat(), end.isoformat()


def csv_bytes(fields, rows):
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def build(manifests, output, initial_bounds=None):
    coverage = []
    names = {}
    partitions = {}
    overview = defaultdict(lambda: [0, 0.0, 0.0])
    for path in manifests:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
        area = bounds(manifest["bbox"])
        start = date.fromisoformat(manifest["start"]).isoformat()
        end = date.fromisoformat(manifest["end_exclusive"]).isoformat()
        if start >= end:
            raise ValueError(f"{path.name}: coverage dates are out of order.")
        for sensor, source in sorted(manifest["sources"].items()):
            product = source["source_id"]
            if sensor not in ("MODIS", "VIIRS") or product not in {
                "MODIS_SP", "MODIS_NRT", "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT",
                "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT",
            } or not product.startswith(sensor + "_"):
                raise ValueError("Use a supported MODIS or VIIRS FIRMS product ID.")
            if sensor in names and names[sensor] != product:
                raise ValueError(f"Use one product per sensor per release ({sensor}).")
            if any(item["product"] == product and start < item["end_exclusive"]
                   and item["start"] < end for item in coverage):
                raise ValueError(f"Coverage dates overlap for {product}. Use one extract per product and date.")
            names[sensor] = product
            coverage.append({"sensor": sensor, "product": product, "bbox": area,
                             "start": start, "end_exclusive": end})
            reader = open_csv((path.parent / source["file"]).read_bytes())
            for row in reader:
                try:
                    point, _ = normalize(row, sensor, str(reader.line_num))
                    day = point["acquired_at_utc"][:10]
                    lon, lat = point["longitude"], point["latitude"]
                    west, south, east, north = area
                    if not (west <= lon < east and south <= lat < north and start <= day < end):
                        continue
                except ValueError as error:
                    raise ValueError(f"{product} CSV line {reader.line_num}: {error}") from None
                month = day[:7]
                x, y = cell(lon, lat, 5)
                key = (product, month, x, y)
                fields, rows = partitions.setdefault(key, (reader.fieldnames, []))
                if fields != reader.fieldnames:
                    raise ValueError(f"FIRMS CSV headers changed within a monthly packet for {product}.")
                rows.append(row)
                totals = overview[(sensor, *cell(lon, lat, OVERVIEW_CELL_SIZE))]
                totals[0] += 1
                totals[1] += lon
                totals[2] += lat

    if not coverage:
        raise ValueError("Declare coverage for at least one FIRMS product.")
    coverage.sort(key=lambda item: (item["sensor"], item["start"]))
    start = min(item["start"] for item in coverage)
    end = max(item["end_exclusive"] for item in coverage)
    overall = [min(item["bbox"][0] for item in coverage), min(item["bbox"][1] for item in coverage),
               max(item["bbox"][2] for item in coverage), max(item["bbox"][3] for item in coverage)]
    initial = bounds(initial_bounds) if initial_bounds else overall
    if not contains(overall, initial):
        raise ValueError("The initial map bounds must be inside the dataset bounds.")

    packets = []
    payloads = {}
    for (product, month, x, y), (fields, rows) in sorted(partitions.items()):
        filename = f"{product}_{month}_{x}_{y}.csv"
        month_start, month_end = month_bounds(month)
        payload = csv_bytes(fields, rows)
        payloads[filename] = payload
        packets.append({"product": product, "bbox": [x, y, x + 5, y + 5],
                        "start": month_start, "end_exclusive": month_end, "url": filename,
                        "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
    summary = {"start": start, "end_exclusive": end, "cells": [
        {"sensor": sensor, "bbox": [x, y, x + OVERVIEW_CELL_SIZE, y + OVERVIEW_CELL_SIZE], "count": count,
         "center": [lon_sum / count, lat_sum / count]}
        for (sensor, x, y), (count, lon_sum, lat_sum) in sorted(overview.items())
    ]}
    catalog = {"initial_bbox": initial, "start": start, "end_exclusive": end,
               "sources": names, "coverage": coverage, "packets": packets}
    release = hashlib.sha256(json.dumps([catalog, summary], sort_keys=True).encode()).hexdigest()
    catalog.update({"version": release, "overview": f"{release}/overview.json"})
    release_dir = output / release
    release_dir.mkdir(parents=True, exist_ok=True)
    for packet in packets:
        filename = packet["url"]
        (release_dir / filename).write_bytes(payloads[filename])
        packet["url"] = f"{release}/{filename}"
    write_json(release_dir / "overview.json", summary)
    write_json(output / "index.json", catalog)
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="append", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("frontend/data"))
    parser.add_argument("--initial-bounds", nargs=4, type=float, metavar=("W", "S", "E", "N"))
    args = parser.parse_args()
    try:
        catalog = build(args.manifest, args.output, args.initial_bounds)
    except (OSError, KeyError, TypeError, ValueError, csv.Error) as error:
        parser.exit(1, f"Could not package the dataset: {error}\n")
    packets = catalog["packets"]
    overview_bytes = (args.output / catalog["overview"]).stat().st_size
    print(f"{catalog['version']}: {len(packets)} CSV packets, "
          f"{sum(packet['bytes'] for packet in packets):,} bytes total, "
          f"{max((packet['bytes'] for packet in packets), default=0):,} bytes largest; "
          f"{overview_bytes:,} bytes overview.")


if __name__ == "__main__":
    main()
