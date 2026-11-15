"""Serve the active FIRMS archive or legacy demo without calling NASA at request time."""

from datetime import date
from enum import Enum
import json
import os
from pathlib import Path
import re

from typing import Annotated, Literal

import duckdb
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .aggregate import OUTPUT_DIR
from .archive import parse_day
from .history import open_history


FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"


# FastAPI uses this enum to validate the optional sensor query parameter.
class Sensor(str, Enum):
    MODIS = "MODIS"
    VIIRS = "VIIRS"


def create_app(output_dir=OUTPUT_DIR):
    app = FastAPI(title="NASA Hotspot Explorer")
    output_dir = Path(output_dir)

    def load(path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HTTPException(503, "Demo data unavailable. Generate the backend outputs.") from None

    # Read the active release on each request so rebuilds can go live without a restart.
    def archive(version):
        try:
            result = open_history(output_dir)
        except (OSError, ValueError, KeyError):
            raise HTTPException(503, "Archive release is unavailable") from None
        if version and (result is None or result.version != version):
            raise HTTPException(409, "The archive changed. Reload the calendar.")
        return result

    @app.get("/api/calendar")
    def calendar(bbox: str | None = None, start: str | None = None, end: str | None = None,
                 granularity: Literal["day", "month"] | None = None, version: str | None = None):
        release = archive(version)
        if release is not None:
            try:
                return release.calendar(release.selection(bbox), parse_day(start) if start else release.start,
                                        parse_day(end) if end else release.end, granularity or "month")
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
            except (OSError, duckdb.Error):
                raise HTTPException(503, "Could not query the FIRMS archive") from None
        if bbox or start or end or granularity == "month":
            raise HTTPException(422, "Area and date filters require a FIRMS archive release")
        manifest = load(output_dir / "manifest.json")
        return load(output_dir / manifest["data_version"] / "calendar.json")

    @app.get("/api/map")
    def map_points(date: str, sensor: Sensor | None = None, bbox: str | None = None,
                   layer: Literal["cells", "detections"] = "detections", version: str | None = None,
                   limit: Annotated[int, Query(ge=1, le=5000)] = 3000,
                   offset: Annotated[int, Query(ge=0)] = 0):
        try:
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", date):
                raise ValueError
            day = parse_date(date)
        except ValueError:
            raise HTTPException(422, "date must be a valid YYYY-MM-DD UTC date") from None

        release = archive(version)
        if release is not None:
            if day not in release.days:
                raise HTTPException(404, "Date is outside the archive release")
            try:
                collection = release.map_points(day, release.selection(bbox), layer, sensor and sensor.value, limit, offset)
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
            except (OSError, duckdb.Error):
                raise HTTPException(503, "Could not query the FIRMS archive") from None
            return JSONResponse(collection, media_type="application/geo+json")
        if bbox or layer == "cells" or offset:
            raise HTTPException(422, "Requested map layer or filter requires a FIRMS archive release")
        # The manifest defines which UTC dates have map files in this release.
        manifest = load(output_dir / "manifest.json")
        if not manifest["start"] <= day < manifest["end_exclusive"]:
            raise HTTPException(404, "Date is outside the demo window")
        collection = load(output_dir / manifest["data_version"] / "map" / f"{day}.geojson")
        # Filter the response in memory and leave the saved GeoJSON intact.
        if sensor:
            collection["features"] = [
                feature for feature in collection["features"]
                if feature["properties"]["sensor"] == sensor.value
            ]
            collection["metadata"]["selected_sensor"] = sensor.value
        return JSONResponse(collection, media_type="application/geo+json")

    @app.get("/api/validation")
    def validation(version: str | None = None):
        release = archive(version)
        if release is None:
            raise HTTPException(404, "Calibration results require a FIRMS archive release")
        try:
            return release.validation()
        except (OSError, ValueError):
            raise HTTPException(503, "Calibration results are unavailable") from None

    # Register this last so the root mount cannot intercept API or docs routes.
    if (FRONTEND_DIR / "index.html").is_file():
        app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    return app


def parse_date(value):
    return date.fromisoformat(value).isoformat()


app = create_app(os.environ.get("FIRMS_OUTPUT_DIR", OUTPUT_DIR))
