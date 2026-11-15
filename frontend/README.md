# Hotspot Explorer

The map, calendar, and sensor comparison run from static files. JavaScript selects
the FIRMS CSV packets for the requested bounds and dates. A PyScript worker runs
the Python analysis with Pyodide and returns daily detection counts and points.
The counts are a demo metric until the analysis algorithm is ready.

## Run locally

From the repository root:

    python -m http.server 8000 --bind 127.0.0.1 --directory frontend

Open http://127.0.0.1:8000/. The browser downloads the pinned PyScript runtime
and Pyodide on the first detailed analysis. The packaged Northern California
sample covers August 1–5, 2025 UTC.

The wide view shows detection concentration in a heat map. Zoom in and pan
to load individual detections and daily counts for the map view. Use **Zoom to
data** to go directly to the published study area. To hold a specific area
while panning, choose **Draw box** and drag between opposite corners.
**Clear box** returns to automatic viewport selection.

Use the date fields to change the inclusive UTC range for the detailed view.
Clicking a calendar day updates the map, comparison, and detection table from
the same result without another CSV download. The heat map uses the full
published date range shown above the map. Its colors represent relative
concentration of recorded detections.

A zero indicates published input coverage and no detections in the selection.
Counts marked partial cover only the available part of the selection. An
uncovered area or date, or a failed packet, makes the affected sensor and day
unavailable. Use **Reload data** to retry failed downloads. Input coverage does
not describe satellite overpasses.

## Refresh the published data

Keep the raw CSVs, input manifests, and FIRMS key local. Run the packager from the
repository root:

    python -m backend.package_static --manifest backend/data/manifest.json --initial-bounds -124.5 37 -119 40

The command accepts the existing ingestion manifest. For a new extract, prepare a
manifest next to its CSVs with the actual requested footprint and UTC interval.
For example:

    {
      "bbox": [-124.5, 37, -119, 42],
      "start": "2025-08-01",
      "end_exclusive": "2025-08-06",
      "sources": {
        "MODIS": {"source_id": "MODIS_SP", "file": "modis.csv"},
        "VIIRS": {"source_id": "VIIRS_SNPP_SP", "file": "viirs.csv"}
      }
    }

Repeat the manifest flag to retain earlier windows in a new release. Use one
extract per product and date and one product per sensor for the release. The
dates in the manifest should describe known source availability, even if a CSV
contains zero rows. NASA can publish standard processing data after a delay.
Check the [NASA FIRMS archive](https://firms.modaps.eosdis.nasa.gov/download/)
for available dates.

The command writes versioned CSV packets and a separate heat map summary to
**frontend/data**, then updates the index. The summary stores counts and average
coordinates for occupied 1° cells by sensor. Inspect the raw and overview file
sizes before expanding the area. Publish the **frontend** directory as the static site root. On GitHub Pages
with GitHub Actions as the source, pass **frontend** as the artifact path in the
[Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
The files use relative URLs so they work under a repository subpath.

## Algorithm integration

The in-memory entry point is **frontend/analysis/detail.py**, function
**analyze(request)**. Its request contains exact **bbox**, UTC **start** and
**end_exclusive**, coverage entries, and CSV packets with sensor/product
metadata and text. Missing packet text is null. The result contains daily
**sensor_detections**, **partial_sensors**, and **points**, plus an unavailable-packet count.
Replace the demo count calculation after agreeing on the new metric and its
output contract with the algorithm owner.

## Satellite scene provenance

- Product: NOAA-20 VIIRS Corrected Reflectance (True Color), November 10, 2026 UTC.
- Provider: NASA EOSDIS Global Imagery Browse Services (GIBS).
- Coverage: contiguous U.S. and surrounding areas. Web Mercator (EPSG:3857)
  bounds in meters, west/south/east/north: `[-14248894, 2632019, -7124447, 6621294]`.
- Source: [NASA GIBS WMS image](https://gibs-a.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&STYLES=&CRS=EPSG:3857&BBOX=-14248894,2632019,-7124447,6621294&WIDTH=1920&HEIGHT=1076&FORMAT=image%2Fpng&TRANSPARENT=TRUE&TIME=2026-11-10).
  The source was encoded as JPEG at its original 1920 × 1076 resolution.

The global JPEG combines two 2048 × 2048 NASA GIBS WMS exports in Web Mercator, spanning −180° to 180° longitude and approximately −85° to 85° latitude. The layers are NOAA-20 VIIRS Corrected Reflectance (True Color), dated 2026-11-10, and Blue Marble Next Generation underneath. Global detail is suitable for regional viewing. The bundled U.S. scene supplies additional detail where available.
