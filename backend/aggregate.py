"""Build calendar, GeoJSON, and audit exports from the registered inputs."""

import argparse
import csv
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path

from .ingest import DATA_DIR, SOURCES, open_csv, write_json
from .normalize import normalize

OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"
SCHEMA_VERSION = 1


def load_source(data_dir, source, sensor, start, end, bounds):
    west, south, east, north = bounds
    counts = {"input": 0, "retained": 0, "rejected": 0, "outside_selection": 0,
              "duplicates": 0, "missing_frp": 0, "invalid_frp": 0}
    accepted, rejected = [], []
    seen = set()
    # Verify that the CSV still matches the copy registered in the input manifest.
    payload = (data_dir / source["file"]).read_bytes()
    if hashlib.sha256(payload).hexdigest() != source["sha256"]:
        raise ValueError(f"{sensor} file hash differs from the registered hash")
    for row_number, row in enumerate(open_csv(payload), start=1):
        counts["input"] += 1
        try:
            observation, frp_issue = normalize(
                row, sensor, f"{source['source_id']}:{source['sha256']}:{row_number}"
            )
        except ValueError as error:
            counts["rejected"] += 1
            rejected.append({"row": row_number, "reason": str(error), "source_row": row})
            continue
        # Retained counts structurally valid rows, including those outside the selection.
        counts["retained"] += 1
        # Report identical rows in the audit and keep them in the detection counts.
        signature = tuple(row.items())
        if signature in seen:
            counts["duplicates"] += 1
        seen.add(signature)
        if frp_issue:
            counts[frp_issue] += 1
        day = observation["acquired_at_utc"][:10]
        lat, lon = observation["latitude"], observation["longitude"]
        # The end date is exclusive. Points on the edges of the bounding box are included.
        if not (start <= day < end and west <= lon <= east and south <= lat <= north):
            counts["outside_selection"] += 1
            continue
        accepted.append(observation)
    return accepted, {"status": "available", **counts, "rejected_rows": rejected}


def build(data_dir, output_dir):
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    start, end = manifest["start"], manifest["end_exclusive"]
    first_day = date.fromisoformat(start)
    days = [(first_day + timedelta(days=i)).isoformat()
            for i in range((date.fromisoformat(end) - first_day).days)]
    # Create a slot even for dates on which neither source has a detection.
    features = {day: [] for day in days}
    availability, audit = {}, {}
    for sensor in SOURCES:
        source = manifest["sources"].get(sensor)
        try:
            records, report = (
                load_source(data_dir, source, sensor, start, end, manifest["bbox"])
                if source else ([], {"status": "unavailable"})
            )
        except FileNotFoundError:
            records, report = [], {"status": "unavailable", "reason": "missing_file"}
        availability[sensor] = report["status"]
        audit[sensor] = report
        for record in records:
            day = record["acquired_at_utc"][:10]
            # GeoJSON stores longitude first, followed by latitude.
            coordinates = [record["longitude"], record["latitude"]]
            properties = {key: value for key, value in record.items()
                          if key not in {"longitude", "latitude"}}
            features[day].append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": coordinates},
                "properties": properties,
            })

    inputs = {"schema_version": SCHEMA_VERSION, **manifest, "availability": availability}
    # The input hashes, selection, and availability identify this release.
    version = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()[:16]
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "data_version": version,
        "region": manifest["region"],
        "bbox": manifest["bbox"],
        "metric": "sensor_detections",
        "units": "detections",
        "method_status": "native",
        "coverage": "unknown",
        "availability": availability,
        "sources": {sensor: entry["source_id"] for sensor, entry in manifest["sources"].items()
                    if availability[sensor] == "available"},
    }
    rows = []
    version_dir = output_dir / version
    for day, points in features.items():
        # Derive counts from the map points so both views use the same records.
        # A missing source has a null count. An available source can have zero.
        counts = {
            sensor: sum(point["properties"]["sensor"] == sensor for point in points)
            if availability[sensor] == "available" else None
            for sensor in SOURCES
        }
        rows.append({"date_utc": day, "sensor_detections": counts})
        write_json(version_dir / "map" / f"{day}.geojson", {
            "type": "FeatureCollection",
            "features": points,
            "metadata": {**metadata, "date_utc": day},
        })
    write_json(version_dir / "calendar.json", {
        **metadata, "start": start, "end_exclusive": end, "rows": rows,
    })
    write_json(version_dir / "audit.json", {"data_version": version, "sources": audit})
    # Switch the API to this release after all its files have been written.
    write_json(output_dir / "manifest.json", {**metadata, "start": start, "end_exclusive": end})
    return version_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    args = parser.parse_args()
    try:
        print(build(args.data_dir, args.output_dir))
    except (OSError, ValueError, csv.Error) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
