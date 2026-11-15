"""Serve the current FIRMS demo export without accessing the NASA API."""

from datetime import date
from enum import Enum
import json
import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .aggregate import OUTPUT_DIR


# FastAPI uses this enum to validate the optional sensor query parameter.
class Sensor(str, Enum):
    MODIS = "MODIS"
    VIIRS = "VIIRS"


def create_app(output_dir=OUTPUT_DIR):
    app = FastAPI(title="NASA Hotspot Explorer")

    def load(path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HTTPException(503, "Demo data unavailable. Generate the backend outputs.") from None

    # Read the active release on each request so rebuilds can go live without a restart.
    @app.get("/api/calendar")
    def calendar():
        manifest = load(output_dir / "manifest.json")
        return load(output_dir / manifest["data_version"] / "calendar.json")

    @app.get("/api/map")
    def map_points(date: str, sensor: Sensor | None = None):
        try:
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", date):
                raise ValueError
            day = parse_date(date)
        except ValueError:
            raise HTTPException(422, "date must be a valid YYYY-MM-DD UTC date") from None

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

    return app


def parse_date(value):
    return date.fromisoformat(value).isoformat()


app = create_app()
