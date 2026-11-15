"""Export published monthly regions using the local archive algorithm."""

from datetime import timedelta
import json
from pathlib import Path
import re

from .archive import parse_bounds, parse_day
from .history import open_history


def json_bytes(value):
    return (json.dumps(value, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def monthly_files(archive_output, regions_file=None):
    history = open_history(archive_output)
    if history is None:
        raise ValueError("Build the historical archive before packaging monthly activity.")
    regions = (json.loads(regions_file.read_text(encoding="utf-8-sig")) if regions_file
               else [{"id": "archive", "label": history.manifest["region"], "bbox": history.extent}])
    if not isinstance(regions, list) or not regions:
        raise ValueError("Published regions must be a nonempty list.")
    index = []
    files = {}
    for region in regions:
        region_id, label = region["id"], region["label"]
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", region_id) or any(
            item["id"] == region_id for item in index
        ):
            raise ValueError("Published region IDs must be unique lowercase slugs.")
        if not isinstance(label, str) or not label.strip():
            raise ValueError("Published regions need a display name.")
        bbox = history.selection(",".join(map(str, parse_bounds(region["bbox"]))))
        calendar = [row for row in history.calendar(bbox, history.start, history.end, "month")["rows"]
                    if row["standard_days"] or row["provisional_days"]]
        prefix = f"monthly/{region_id}"
        for row in calendar:
            path = f"{prefix}/{row['date_utc'][:7]}.json"
            files[path] = month_file(history, bbox, row)
            row["map"] = Path(path).name
        path = f"{prefix}/calendar.json"
        files[path] = json_bytes({"rows": calendar})
        index.append({"id": region_id, "label": label, "bbox": bbox, "calendar": path})
    return index, files


def month_file(history, bbox, row):
    month = parse_day(row["date_utc"])
    start = parse_day(row["first_day"])
    end = parse_day(row["last_day"]) + timedelta(days=1)
    return json_bytes({
        "month": row["date_utc"],
        "maps": {str(resolution): history.overview(bbox, month, start, end, resolution)["features"]
                 for resolution in (2, 3)},
    })
