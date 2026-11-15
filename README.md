# NASA Hotspot Explorer

Historical NASA MODIS/VIIRS hotspot analysis and burning-calendar prototype.

## Backend demo

From the repository root, use Python 3.10 or later in a virtual environment.
Install the API dependencies with `python -m pip install -r backend/requirements.txt`
(or `uv pip install -r backend/requirements.txt` in a uv environment).

Set `FIRMS_MAP_KEY` in your local shell, then run:

```text
$env:FIRMS_MAP_KEY = 'PASTE_YOUR_KEY_HERE'
python -m backend.ingest fetch
python -m backend.aggregate
python -m uvicorn backend.api:app --reload
```

The downloader requests MODIS standard processing and Suomi-NPP VIIRS standard
processing from the [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/).
The default sample is the Northern California demo rectangle
(west, south, east, north: -124.5, 37.0, -119.0, 42.0), August 1–5, 2025 UTC.
If either sensor has too few detections for the demo, run
`python -m backend.ingest --days 10 fetch` and rebuild.

To use existing standard processing CSV extracts for that same footprint and
window, run `python -m backend.ingest register --modis path/to/modis.csv --viirs path/to/viirs.csv`.
Use `--days 10` before `register` if both extracts span the extended window.
Registration replaces the active input manifest. A source omitted from it, or
whose file is missing, is shown as unavailable. Source files and manifests are
local under `backend/data/`. The aggregate command prints the version directory
with the generated calendar, daily maps, and `audit.json`. These are under
`backend/outputs/`.

Open the API docs at `http://127.0.0.1:8000/docs`. During local frontend
development, proxy `/api` to `http://127.0.0.1:8000` from the frontend dev server.

- `GET /api/calendar` returns the daily counts and metadata. An example row is
  `{"date_utc":"2025-08-01","sensor_detections":{"MODIS":2,"VIIRS":0}}`.
- `GET /api/map?date=2025-08-01` returns a GeoJSON FeatureCollection. Add
  `&sensor=MODIS` or `&sensor=VIIRS` to restrict the points to one sensor.

A count of zero means the source was loaded and there were no eligible detections.
A null count and the `availability` metadata identify missing inputs, including
on maps with no features. Counts represent valid hotspot records, including
reported duplicates. Satellite observation coverage is unknown from these CSVs.
