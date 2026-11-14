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
Satellite opens with a bundled global NOAA-20 VIIRS image from November
10, 2026 UTC. NASA Blue Marble fills gaps in the dated imagery, and a sharper
VIIRS scene covers the contiguous U.S. Both work offline. Simple is available
from the map controls. Imagery dates are independent of detection dates.

## Satellite scene provenance

- Product: NOAA-20 VIIRS Corrected Reflectance (True Color), November 10, 2026 UTC.
- Provider: NASA EOSDIS Global Imagery Browse Services (GIBS).
- Coverage: contiguous U.S. and surrounding areas. Web Mercator (EPSG:3857)
  bounds in meters, west/south/east/north: `[-14248894, 2632019, -7124447, 6621294]`.
- Source: [NASA GIBS WMS image](https://gibs-a.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&STYLES=&CRS=EPSG:3857&BBOX=-14248894,2632019,-7124447,6621294&WIDTH=1920&HEIGHT=1076&FORMAT=image%2Fpng&TRANSPARENT=TRUE&TIME=2026-11-10).
  The source was encoded as JPEG at its original 1920 × 1076 resolution.

The global JPEG combines two 2048 × 2048 NASA GIBS WMS exports in Web Mercator, spanning −180° to 180° longitude and approximately −85° to 85° latitude. The layers are NOAA-20 VIIRS Corrected Reflectance (True Color), dated 2026-11-10, and Blue Marble Next Generation underneath. Global detail is suitable for regional viewing. The bundled U.S. scene supplies additional detail where available.

## CSV downloads and judging handoff

Detections exports every matching raw record, including rows on other
pages. In harmonized mode it exports daily totals for the full date range.
Unknown dates have a blank count and an explicit coverage status. The
Data & methods panel shows the active source, method, and coverage.

For the competition demo, load a validated historical team export for
one study area. Supply the unit counted, overlap-period validation, and
coverage limits. A seasonal comparison is a useful next step once the
team data can support it. See the [challenge brief](https://hackathlone.com/challenges/modis-and-viirs-hot-spots) and [2026 judging criteria](https://www.spaceappschallenge.org/2026/local-events/ajmer/).

## Judge walkthrough

1. Open **Compare**, then **Try the demo**. November 10, 2026 uses the
   bundled California study box `[-125, 32, -114, 42]` and shows 73 MODIS
   and 290 VIIRS observations. Pan one map and watch the other follow.
   The difference illustrates why raw observation counts are hard to compare.
2. With a real historical team export loaded, select a week under
   **This week in context**. Inspect a daily count on the map, then return
   to Compare and open **Evidence and coverage**.
3. Print the briefing or download the comparison CSV to review its inputs.
   Until the team supplies the historical export, the first step runs with
   real data and the second step explains what is required.

The comparison sums the same seven UTC calendar dates for each included
year. It excludes incomplete windows and invalid leap-day matches. It
requires seven reported counts for the selected week and at least three
complete prior weeks. The range is the observed minimum and maximum of
those weeks, not a forecast or a confidence interval.

The optional fields below extend the existing harmonized JSON format.
Existing exports still import. Values shown in the evidence panel come
from your export, so use validated values and explain what they measure.

```json
{
  "countUnit": "Harmonized active grid-cell days",
  "validation": [
    {
      "metric": "Name of overlap-period check",
      "value": "Validated result and units",
      "period": "UTC dates evaluated",
      "interpretation": "What the metric demonstrates and its limitation"
    }
  ]
}
```

## Sensor Handoff

Use **Play the Sensor Handoff** on the opening map. The sequence runs for
about ten seconds and ends on a static comparison. It uses the dated
satellite imagery as geographic context. The raw California example is
available separately via **Try the demo**.

To enable the handoff, include `countUnit` and this optional `handoff`
array in the harmonized team export. These values illustrate the format.

```json
{
  "countUnit": "Active grid-cell days",
  "handoff": [
    { "start": "2010-11-04", "end": "2010-11-10", "modis": 54, "viirs": null },
    { "start": "2018-11-04", "end": "2018-11-10", "modis": 62, "viirs": 147 },
    { "start": "2026-11-04", "end": "2026-11-10", "modis": null, "viirs": 132 }
  ]
}
```

Supply verified raw observation totals for the same area as the export.
Use null when the source does not supply a sensor total and zero when it
reports zero. The first week is MODIS only, the second includes both
sensors, and the third includes VIIRS with or without MODIS. The three
windows use the same seven UTC calendar dates in chronological order.
All 21 dates need non-null harmonized daily counts in `days`. The viewer
sums each week and shows the source, count unit, method and any validation
already supplied by the team. A missing or incomplete handoff leaves
the rest of the export usable and displays the missing requirement.
