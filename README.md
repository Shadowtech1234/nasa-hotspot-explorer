# NASA Hotspot Explorer

Historical NASA MODIS/VIIRS hotspot analysis and burning-calendar prototype.

On Windows, double-click [start-explorer.cmd](start-explorer.cmd) to start the
local server and open the explorer. It uses an existing built archive, or the
Northern California sample when available. Open **Map & Calendar** and choose
**Calendar** above the map to jump to the calendar on the left. The monthly
percentile chart sits below the map and calendars.
Use **Analysis** for daily detections and charts, **Compare** for satellite
trends and synchronized maps, and **History** for the weekly heat map.

The historical calendar uses an H3 grid and a Suomi-NPP reference to compare
monthly burning activity across the MODIS and VIIRS eras. See the [archive
setup and validation guide](backend/howtotest.md) to build and serve a FIRMS
release or run the five-day sensor comparison demo.

See the [frontend guide](frontend/README.md) for publishing and running the
browser-only site with packaged data.

## Render demo

Create a Free Python Web Service from `main` with the repository root as
the working directory. Use `pip install -r backend/requirements.txt` as
the build command and `python -m uvicorn backend.api:app --host 0.0.0.0 --port $PORT`
as the start command.

Set `FIRMS_OUTPUT_DIR=backend/deploy-data/western-us` and use `/api/health` as
the health check path. The bundled Western US archive covers January 2019
through December 2024 within 122.75°W to 119.5°W and 38°N to 44°N. It uses
standard-processing MODIS and Suomi-NPP VIIRS detections from NASA FIRMS,
accessed through the [Portolan mirror](https://source.coop/portolan-mirrors/firms-catalog).
The release audit lists the source files and dates with no worldwide
standard-processing records for a satellite. The app queries the prepared
release without a FIRMS key.
