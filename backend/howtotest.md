## Build the historical archive

The FastAPI server on this page is a local preview for archive endpoints. The
public static site uses the [monthly export built during packaging](../frontend/README.md#refresh-the-published-data).

### Worldwide deployment

Build the worldwide manifest with one entry per product and covered date interval.
Download the global standard-processing CSV/ZIP extracts from FIRMS and keep
them on a volume with room for both extracts and the generated Parquet files.
Include declared gaps and known outages before calibration. Each archive build
reuses the imported monthly partitions by their content hashes. Copy the whole
output root when packaging a release for another machine, including its active
pointer, history, raw, and cell directories. The monthly map queries these
partitions and caches regional summaries by release and selection.

Set `FIRMS_WORLD_OUTPUT_DIR` to the worldwide build's output root before
starting Uvicorn. A separately configured `FIRMS_OUTPUT_DIR` remains available
from the archive selector. For a partial worldwide sample, name it with its
actual dates and coverage. The calendar and map report percentile gaps for
months without five comparable earlier years.

The monthly map uses symbol size for activity and color for local percentile.
Zoom in for finer regions, click a symbol for its values, or choose a daily
observation for the active cells and raw detection layers.

Use Python 3.10 or later and install `backend/requirements.txt`. Request
worldwide CSV extracts from the [NASA FIRMS archive](https://firms.modaps.eosdis.nasa.gov/download/)
for MODIS Collection 6.1 and VIIRS Collection 2. List the files and their actual
coverage in a local manifest. The importer accepts a plain CSV, a gzip-compressed
CSV, or a FIRMS download ZIP with one `fire_archive_*.csv` or `fire_nrt_*.csv`
member for the declared processing stream. Keep the downloaded archives outside Git.

```json
{
  "region": "World",
  "bbox": [-180, -90, 180, 90],
  "inputs": [
    {"product": "MODIS_SP", "path": "modis-sp-2024.zip", "start": "2024-01-01", "end_exclusive": "2025-01-01"},
    {"product": "VIIRS_SNPP_SP", "path": "snpp-sp-2024.zip", "start": "2024-01-01", "end_exclusive": "2025-01-01"}
  ],
  "outages": []
}
```

- Filenames are relative to the manifest and may also be absolute paths. Use
  `MODIS_SP`, `VIIRS_SNPP_SP`, `VIIRS_NOAA20_SP`, and `VIIRS_NOAA21_SP` for
  standard processing. Add `_NRT` products for provisional observations. A
  mixed ZIP can appear twice with separate `_SP` and `_NRT` date ranges.
- Dates are UTC with an exclusive end. Declare only dates covered by the
  extract and an area covered by every declared input. Split gaps in file
  coverage into separate entries. For known platform outages, add `platform`,
  `start`, and `end_exclusive` entries in `outages`. Supported platform names
  are `Terra`, `Aqua`, `Suomi-NPP`, `NOAA-20`, and `NOAA-21`. Round outages
  outward to UTC days and record their source in an optional `source_url`.
  See the [NASA FIRMS notices](https://firms2.modaps.eosdis.nasa.gov/content/notifications/firms/outages.html)
  and [MODIS outages](https://landweb.modaps.eosdis.nasa.gov/outage).
- An overlap backtest needs at least two earlier years of active overlap and
  a later, complete archive year to hold out. Add all available overlap years
  for each platform pair. A release built from a single year can display
  Suomi-NPP reference activity and observed cells from other platforms.

```powershell
python -m backend.archive build backend/data/archive.json
python -m uvicorn backend.api:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/`. Use the same output location for both commands.
For a full backfill, pass `--output-dir` to the build and set `FIRMS_OUTPUT_DIR`
before starting Uvicorn. Allow space for the original extracts, normalized
Parquet, and temporary files. Use monthly extracts to limit staging size.
The build reuses completed inputs and cell partitions and activates the
release with `history.json`. `audit.json` records the input hashes, collection
versions, and known outages. `validation.json` records per-platform holdout errors.

For an individual extract or repair, set `FIRMS_MAP_KEY` locally and run:

```powershell
python -m backend.archive fetch VIIRS_NOAA20_SP 2024-08-01 2024-08-06 backend/data/noaa20.csv --bbox=-124.5,37,-119,42
```

Confirm dates in NASA's [product availability information](https://firms.modaps.eosdis.nasa.gov/api/data_availability/).
The [Area API](https://firms.modaps.eosdis.nasa.gov/api/area/) limits requests to
five days each and applies a transaction quota. Use bulk files for a world backfill.

### Reading the results

The observed layer counts each H3 resolution 7 cell with eligible detections
once per UTC day. The calendar sums reference cell-days and estimates bridged
from other platforms using zero-intercept seasonal ratios fitted on common
dates. Cloud cover, overpass timing, and fire detectability affect the index.
A `null` index means conversion or source inputs were unavailable. Partial
months show usable days. See the [MODIS guide](https://www.earthdata.nasa.gov/s3fs-public/2023-09/MODIS_C6_C6.1_Fire_User_Guide_1.0.pdf),
[VIIRS guide](https://www.earthdata.nasa.gov/s3fs-public/2025-06/VIIRS_C2_AF-375m_User_Guide_1.2.pdf),
[SHIFT](https://github.com/squadronzero/project-shift), and [Zij](https://zij.watch/how-it-works).

- `GET /api/calendar` returns monthly index values. Filter it with `bbox`,
  `start`, and exclusive `end`. Use `granularity=day` for daily observed cells
  and raw counts over a window of up to 366 days.
- `GET /api/map?date=2024-08-01&layer=cells` returns active cell centers.
  The default `layer=detections` returns raw points. Both take `bbox`, `sensor`,
  `limit`, and `offset`. Follow `metadata.next_offset` to page results. Pass
  `version` from the calendar to detect a release changing between requests.
- `GET /api/validation` reports held-out monthly absolute errors and signed
  bias against Suomi-NPP for the regional fit and both baselines. An area
  without diagnostics had no eligible held-out tile-months in the release.

Run the regression checks with `python -m unittest backend.test_history -v`.

## Five-day sensor comparison demo

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

Open http://127.0.0.1:8000/docs to try the legacy demo endpoints. If the sample
outputs already exist, you can start Uvicorn without fetching again. The dashboard
uses the [static data path](../frontend/README.md).


- `GET /api/calendar` returns the daily counts and metadata. An example row is
  `{"date_utc":"2025-08-01","sensor_detections":{"MODIS":2,"VIIRS":0}}`.
- `GET /api/map?date=2025-08-01` returns a GeoJSON FeatureCollection. Add
  `&sensor=MODIS` or `&sensor=VIIRS` to restrict the points to one sensor.

A count of zero means the source was loaded and there were no eligible detections.
A null count and the `availability` metadata identify missing inputs, including
on maps with no features. Counts represent valid hotspot records, including
reported duplicates. Satellite observation coverage is unknown from these CSVs.
