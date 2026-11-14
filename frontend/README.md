# Hotspot Explorer

A frontend for the 2026 NASA Space Apps MODIS and VIIRS Hot Spots challenge.

## Run in VS Code

Open this folder in VS Code and serve it with Live Server, or run
`python -m http.server 8000 --bind 127.0.0.1` from this folder and open
http://127.0.0.1:8000/. The browser fetches bundled assets over local HTTP.
The dashboard, basemap and snapshot work offline once the static server is
running. There are no build steps, API keys, or database connections.

## Data

The bundled U.S. and Hawaii near real-time (NRT) CSVs were downloaded on
2026-11-14 UTC from NASA FIRMS:

- [MODIS Collection 6.1](https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_USA_contiguous_and_Hawaii_7d.csv)
- [VIIRS NOAA-20 Collection 2](https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_7d.csv)

Open up to eight CSVs in one selection to replace the active raw dataset.
Each CSV must be under 20 MB and supply latitude, longitude, acq_date and
either instrument or a recognized satellite code. Acquire archived CSVs
from the [NASA FIRMS archive](https://firms.modaps.eosdis.nasa.gov/download/).
The dashboard counts rows within the selected bounds, keeping the sensors
separate. Files with overlapping records can count the same observation
more than once. A question mark means there are no rows for that sensor and
day in the loaded files. A 0 means none of the loaded observations for that
sensor and day match the selected area. Neither result establishes fire
absence.

## Harmonized data handoff

Open one JSON file from the team's data pipeline to enable Harmonized
activity. This proposed frontend interchange format has no server
dependency. The example below is illustrative and contains invented counts.

```json
{
  "area": "Southern California",
  "bounds": [-120, 32, -114, 36],
  "source": "Team export",
  "method": "Team methodology and version",
  "days": [
    {"date": "2025-01-07", "count": 5, "points": [{"lat": 34.05, "lon": -118.24}]},
    {"date": "2025-01-08", "count": 0},
    {"date": "2025-01-09", "count": null}
  ]
}
```

Bounds are `[west, south, east, north]` and must be ordered with latitudes
between -85 and 85 degrees. The team supplies one count per UTC date for the
entire exported area. Missing dates and null counts display as unknown.
Optional points are shown on the map for positive counts and may represent
a subset of the total. The calendar always uses the supplied count.
Importing JSON preserves the currently loaded raw dataset.

Map geometry comes from [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/).
Leaflet 1.9.4 is bundled with its license in the assets folder.

## Explorer tabs

Use Map & Calendar to inspect an area. Follow map updates raw sensor counts
after you move or resize the map. Lock area or Edit bounds keeps the study
area fixed. The Detections tab contains the matching rows and import controls.
Focus or click the map to enable wheel zoom, and press Escape to release it.
The Satellite basemap uses NASA GIBS Blue Marble regional imagery. The Simple
basemap is bundled and is used automatically if imagery cannot load.
