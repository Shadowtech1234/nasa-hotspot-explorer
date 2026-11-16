# Hotspot Explorer

The frontend opens on a cloud-free hotspot map with controls for the area,
dates, sensor, and basemap. The monthly map overlays selected-day fire
detection points on translucent activity cells. History includes an ISO-week heat map, the
harmonized monthly calendar, and the monthly percentile chart. Compare shows
sensor trends and synchronized maps. Choose a trend period and select
**Show on sensor maps** to inspect that period on both maps. Opening-week data
appears while the full selected date range loads. Analysis includes seasonal totals,
daily fire radiative power. Every view has CSV and JSON downloads for its data.
The theme control in the header switches between light and dark and remembers
the choice in the browser.

Run the [archive setup](../backend/howtotest.md) to serve the app and data on the
same origin. The five-day demo supports daily detections, density, sensor
comparison, and fire radiative power. Historical charts require an archive.

## Connect the backend

Serve this directory as the website and route the following relative paths to
the backend on the website's origin:

- `GET /api/calendar` supplies the study bounding box, source labels, release
  version, and calendar rows by UTC month for an archive. Daily rows include
  the reported MODIS and VIIRS counts. Zero is a reported count. A null count
  means the source is unavailable.
- `GET /api/map?date=YYYY-MM-DD` supplies the selected day's GeoJSON points and
  metadata for the same export version.
- `GET /api/overview` supplies monthly activity and historical percentiles by H3
  region, with region boundaries for the map.
- `GET /api/density` supplies gridded daily detection counts from the full
  archive day, including provisional detections where available.
- `GET /api/analytics` supplies weekly observed active cell-days and monthly
  raw detection counts by sensor, including the number of reporting days.
- `GET /api/frp?date=YYYY-MM-DD` supplies the full day's fire radiative power
  histogram and summary statistics for the selected area, independent of
  detection pagination.

The full historical view uses the server archive. Published monthly exports
can supply monthly activity and percentiles when the archive contains a
baseline. Weekly cell-days require the server archive.

## Run the static site

From the repository root, run
`python -m http.server 8000 --bind 127.0.0.1 --directory frontend` and open
`http://127.0.0.1:8000/`. With the API absent, the app loads the checked-in
five-day sample. PyScript runs the existing Python analysis in the browser.
Choose **Published detections** in the archive selector for custom bounds or
date ranges. Published monthly regions use the bounds and months in the export.

To use a generated preview in the ignored `frontend/data/local` directory,
open `http://127.0.0.1:8000/?data=local`.

## Refresh the published data

Keep raw inputs and FIRMS credentials local. Run
`python -m backend.package_static --manifest backend/data/manifest.json --initial-bounds -124.5 37 -119 40`
from the repository root. Pass `--archive-output` with the archive root to add
monthly activity and `--regions` with named region bounds to publish subsets.
Publish the `frontend` directory as the static site root.

The basemaps use Natural Earth geometry and NASA EOSDIS GIBS NOAA-20 VIIRS
Corrected Reflectance imagery from November 10, 2026 UTC. Leaflet is bundled
with its license in the assets folder.

## Satellite scene provenance

- Product: NOAA-20 VIIRS Corrected Reflectance (True Color), November 10, 2026 UTC.
- Provider: NASA EOSDIS Global Imagery Browse Services (GIBS).
- Coverage: contiguous U.S. and surrounding areas. Web Mercator (EPSG:3857)
  bounds in meters, west/south/east/north: `[-14248894, 2632019, -7124447, 6621294]`.
- Source: [NASA GIBS WMS image](https://gibs-a.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&STYLES=&CRS=EPSG:3857&BBOX=-14248894,2632019,-7124447,6621294&WIDTH=1920&HEIGHT=1076&FORMAT=image%2Fpng&TRANSPARENT=TRUE&TIME=2026-11-10).
  The source was encoded as JPEG at its original 1920 × 1076 resolution.

The global JPEG combines two 2048 × 2048 NASA GIBS WMS exports in Web Mercator, spanning −180° to 180° longitude and approximately −85° to 85° latitude. The layers are NOAA-20 VIIRS Corrected Reflectance (True Color), dated 2026-11-10, and Blue Marble Next Generation underneath. Global detail is suitable for regional viewing. The bundled U.S. scene supplies additional detail where available.
