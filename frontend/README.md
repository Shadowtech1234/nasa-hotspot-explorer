# Hotspot Explorer

The frontend renders the MODIS and VIIRS calendar, hotspot map, detection table,
and side-by-side sensor comparison. It requires the backend to supply detection
data and shows a connection error when the API is unavailable.

## Connect the backend

Serve this directory as the website and route the following relative paths to
the backend on the website's origin:

- `GET /api/calendar` supplies the study bounding box, source labels, export
  version, and reported MODIS and VIIRS counts by UTC date. Zero is a reported
  count. A null count means the source is unavailable.
- `GET /api/map?date=YYYY-MM-DD` supplies the selected day's GeoJSON points and
  metadata for the same export version.

The frontend displays API counts and uses the exported area and dates. FIRMS
ingestion, validation, and aggregation belong to the backend. The historical
views require a backend historical export.

## Preview the interface

From this folder, run `python -m http.server 8000 --bind 127.0.0.1` and open
`http://127.0.0.1:8000/`. This static preview displays the map imagery and
interface while the API is being connected.

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
