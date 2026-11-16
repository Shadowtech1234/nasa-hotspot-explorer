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
the health check path. The bundled Western US archive covers August 2019
through 2024. The app queries that release without a FIRMS key.
