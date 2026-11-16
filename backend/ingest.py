"""Register, download, and read the two FIRMS inputs for the demo."""

import argparse
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import quote
from urllib.request import urlopen

DATA_DIR = Path(__file__).resolve().parent / "data"
# Demo request defaults. NASA expects bounds in west, south, east, north order.
START = date(2025, 8, 1)
BOUNDS = (-124.5, 37.0, -119.0, 42.0)
SOURCES = {"MODIS": "MODIS_SP", "VIIRS": "VIIRS_SNPP_SP"}
FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/"
REQUIRED = {"latitude", "longitude", "acq_date", "acq_time", "satellite"}


def write_json(path, payload):
    # Replace the destination only after the complete JSON file has been written.
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        temporary = Path(stream.name)
    try:
        temporary.write_text(json.dumps(payload, allow_nan=False) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def open_csv(data):
    # utf-8-sig also accepts CSVs that begin with a UTF-8 byte order mark.
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig"), newline=""), strict=True)
    fields = reader.fieldnames or []
    if len(set(fields)) != len(fields) or not REQUIRED.issubset(fields):
        raise ValueError("Missing or duplicate FIRMS CSV headers")
    return reader


def register(data_dir, inputs, days, fetched=False):
    sources = {}
    for sensor, source_id in SOURCES.items():
        if sensor not in inputs:
            continue
        payload = inputs[sensor]
        for _ in open_csv(payload):
            pass
        # Name files by their content so a new download can coexist with earlier inputs.
        digest = hashlib.sha256(payload).hexdigest()
        filename = f"{sensor.lower()}-{digest}.csv"
        sources[sensor] = {
            "source_id": source_id,
            "file": filename,
            "sha256": digest,
            "source_url": FIRMS_URL,
            "retrieved_at_utc": datetime.now(timezone.utc).isoformat() if fetched else None,
            "attribution": "NASA FIRMS",
        }

    data_dir.mkdir(parents=True, exist_ok=True)
    for sensor, source in sources.items():
        (data_dir / source["file"]).write_bytes(inputs[sensor])
    manifest = {
        "region": "northern-california-demo",
        "bbox": BOUNDS,
        "start": START.isoformat(),
        "end_exclusive": (START + timedelta(days=days)).isoformat(),
        "sources": sources,
    }
    # Publish the manifest after the raw files are in place.
    write_json(data_dir / "manifest.json", manifest)


def download(key, days):
    inputs = {}
    area = ",".join(map(str, BOUNDS))
    for sensor, source_id in SOURCES.items():
        chunks = []
        # The Area API caps each request at five days.
        for offset in range(0, days, 5):
            start = START + timedelta(days=offset)
            url = f"{FIRMS_URL}csv/{quote(key, safe='')}/{source_id}/{area}/5/{start}"
            try:
                with urlopen(url, timeout=45) as response:
                    chunk = response.read()
                reader = open_csv(chunk)
                for _ in reader:
                    pass
            # Network exceptions can contain the request URL, which includes the key.
            except (OSError, ValueError, csv.Error):
                raise ValueError(
                    f"FIRMS request failed for {source_id} starting {start}. "
                    "Check the map key, network, and product availability."
                ) from None
            chunks.append((reader.fieldnames, chunk))
        fields, combined = chunks[0]
        # The combined file needs only the header from the first response.
        for other_fields, other_chunk in chunks[1:]:
            if fields != other_fields:
                raise ValueError(f"FIRMS CSV headers changed across {source_id} requests")
            combined = combined.rstrip(b"\r\n") + b"\n" + b"".join(other_chunk.splitlines(keepends=True)[1:])
        inputs[sensor] = combined
    return inputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--days", type=int, choices=(5, 10), default=5)
    options = parser.add_subparsers(dest="command", required=True)
    options.add_parser("fetch")
    # Local extracts follow the same registration path as downloads.
    local = options.add_parser("register")
    local.add_argument("--modis", type=Path)
    local.add_argument("--viirs", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "fetch":
            key = os.environ.get("FIRMS_MAP_KEY", "").strip()
            if not key:
                parser.error("Set FIRMS_MAP_KEY in your local environment before fetching.")
            inputs = download(key, args.days)
        else:
            paths = {"MODIS": args.modis, "VIIRS": args.viirs}
            inputs = {sensor: path.read_bytes() for sensor, path in paths.items() if path}
            if not inputs:
                parser.error("Provide --modis, --viirs, or both.")
        register(args.data_dir, inputs, args.days, fetched=args.command == "fetch")
    except (OSError, ValueError, csv.Error) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
