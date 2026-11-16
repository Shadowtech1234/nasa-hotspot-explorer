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
from .history import FRP_LABELS, frp_summary, open_history


FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"


class ExplorerFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if path == "." or Path(path).suffix in {".html", ".js", ".css"}:
            response.headers["Cache-Control"] = "no-cache"
        return response


# FastAPI uses this enum to validate the optional sensor query parameter.
class Sensor(str, Enum):
    MODIS = "MODIS"
    VIIRS = "VIIRS"


def create_app(output_dir=OUTPUT_DIR, world_output=None):
    app = FastAPI(title="NASA Hotspot Explorer")
    output_dir = Path(output_dir)

    def load(path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HTTPException(503, "Demo data unavailable. Generate the backend outputs.") from None

    def demo_map(day):
        manifest = load(output_dir / "manifest.json")
        if not manifest["start"] <= day < manifest["end_exclusive"]:
            raise HTTPException(404, "Date is outside the demo window")
        return load(output_dir / manifest["data_version"] / "map" / f"{day}.geojson")

    # Read the active release on each request so rebuilds can go live without a restart.
    def archive(version, dataset=None):
        try:
            primary = open_history(output_dir)
            world = open_history(Path(world_output)) if world_output else None
            result = primary if dataset == "regional" else world if dataset == "world" else world or primary
        except (OSError, ValueError, KeyError):
            raise HTTPException(503, "Archive release is unavailable") from None
        if version and (result is None or result.version != version):
            raise HTTPException(409, "The archive changed. Reload the calendar.")
        return result

    @app.get("/api/health")
    def health():
        release = archive(None, "regional")
        if release is None:
            raise HTTPException(503, "Regional archive is unavailable")
        manifest = release.manifest
        paths = [*manifest["cells"].values(), *manifest["monthly"].values(),
                 *(path for files in manifest["raw"].values() for path in files)]
        if not paths or not all((output_dir / path).is_file() for path in paths):
            raise HTTPException(503, "Regional archive files are unavailable")
        return {"status": "ok", "data_version": release.version}

    @app.get("/api/archives")
    def archives():
        choices = []
        for key, path in (("world", world_output), ("regional", output_dir)):
            release = open_history(Path(path)) if path else None
            if release:
                choices.append({"id": key, "name": release.manifest["region"]})
        return choices

    @app.get("/api/calendar")
    def calendar(bbox: str | None = None, start: str | None = None, end: str | None = None,
                 granularity: Literal["day", "month"] | None = None, version: str | None = None,
                 dataset: Literal["regional", "world"] | None = None):
        release = archive(version, dataset)
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
                   offset: Annotated[int, Query(ge=0)] = 0, dataset: Literal["regional", "world"] | None = None):
        try:
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", date):
                raise ValueError
            day = parse_date(date)
        except ValueError:
            raise HTTPException(422, "date must be a valid YYYY-MM-DD UTC date") from None

        release = archive(version, dataset)
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
        collection = demo_map(day)
        # Filter the response in memory and leave the saved GeoJSON intact.
        if sensor:
            collection["features"] = [
                feature for feature in collection["features"]
                if feature["properties"]["sensor"] == sensor.value
            ]
            collection["metadata"]["selected_sensor"] = sensor.value
        return JSONResponse(collection, media_type="application/geo+json")

    @app.get("/api/validation")
    def validation(version: str | None = None, dataset: Literal["regional", "world"] | None = None):
        release = archive(version, dataset)
        if release is None:
            raise HTTPException(404, "Calibration results require a FIRMS archive release")
        try:
            return release.validation()
        except (OSError, ValueError):
            raise HTTPException(503, "Calibration results are unavailable") from None

    @app.get("/api/analytics")
    def analytics(start: str, end: str, bbox: str | None = None, version: str | None = None,
                  dataset: Literal["regional", "world"] | None = None):
        release = archive(version, dataset)
        if release is None:
            raise HTTPException(404, "Historical analytics require a FIRMS archive release")
        try:
            return release.analytics(release.selection(bbox), parse_day(start), parse_day(end))
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        except (OSError, duckdb.Error):
            raise HTTPException(503, "Could not query historical analytics") from None

    @app.get("/api/frp")
    def frp(date: str, bbox: str | None = None, version: str | None = None,
            dataset: Literal["regional", "world"] | None = None):
        try:
            day = parse_day(date).isoformat()
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        release = archive(version, dataset)
        if release is None:
            if bbox:
                raise HTTPException(422, "Area filters require a FIRMS archive release")
            collection = demo_map(day)
            rows = collection["features"]
            collection_version = collection["metadata"]["data_version"]
            stats = {sensor.value: frp_summary(row["properties"]["frp_mw"] for row in rows
                                             if row["properties"]["sensor"] == sensor.value)
                     for sensor in Sensor}
        else:
            try:
                if day not in release.days:
                    raise HTTPException(404, "Date is outside the archive release")
                stats = release.daily_frp(day, release.selection(bbox))
                collection_version = release.version
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
            except (OSError, duckdb.Error):
                raise HTTPException(503, "Could not query fire radiative power") from None
        return {"date_utc": day, "data_version": collection_version, "bins_mw": FRP_LABELS, "sensors": stats}

    @app.get("/api/overview")
    def overview(month: str, start: str, end: str, bbox: str | None = None, version: str | None = None,
                 dataset: Literal["regional", "world"] | None = None,
                 resolution: Literal["2", "3", "4", "5"] = "2"):
        release = archive(version, dataset)
        if release is None:
            raise HTTPException(404, "The monthly map requires an archive release")
        try:
            return release.overview(release.selection(bbox), parse_day(month), parse_day(start), parse_day(end), int(resolution))
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        except (OSError, duckdb.Error):
            raise HTTPException(503, "Could not load the monthly map") from None

    @app.get("/api/density")
    def density(date: str, step: Literal["0.1", "0.25", "1"] = "1", bbox: str | None = None,
                version: str | None = None, dataset: Literal["regional", "world"] | None = None):
        release = archive(version, dataset)
        if release is None:
            raise HTTPException(404, "Gridded density requires a FIRMS archive release")
        try:
            day = parse_day(date).isoformat()
            if day not in release.days:
                raise HTTPException(404, "Date is outside the archive release")
            return release.daily_density(day, release.selection(bbox), float(step))
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        except (OSError, duckdb.Error):
            raise HTTPException(503, "Could not load detection density") from None

    # Register this last so the root mount cannot intercept API or docs routes.
    if (FRONTEND_DIR / "index.html").is_file():
        app.mount("/", ExplorerFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    return app


def parse_date(value):
    return date.fromisoformat(value).isoformat()


app = create_app(os.environ.get("FIRMS_OUTPUT_DIR", OUTPUT_DIR), os.environ.get("FIRMS_WORLD_OUTPUT_DIR"))
