# Fire Signal

Fire Signal is a satellite fire activity explorer built with NASA FIRMS data.
Use it to see where MODIS and VIIRS detected fire activity, compare the two
sensors, and find out whether a month was unusually active for a selected area.

## Explore the dashboard

| View | What you can do |
| --- | --- |
| **Map & Calendar** | Filter by area, date, and sensor. Explore monthly activity by grid cell or select a day to see individual detections. |
| **Analysis** | Review daily and seasonal detections and a fire radiative power breakdown in megawatts (MW). Locate a detection on the map or export filtered data as CSV or JSON. |
| **Compare** | Compare MODIS and VIIRS trends and explore both sensors on synchronized maps. |
| **History** | Explore weekly activity and see where each month ranks against the same month in earlier years. |

The monthly calendar groups detections into H3 grid cells and uses Suomi-NPP
VIIRS as a reference to put MODIS and VIIRS activity on a comparable scale.
Each percentile compares a complete month with the same month in at least five
earlier years for the selected area.

## Run the Western US demo

The repository includes a prepared archive for January 2019 through December
2024 within 122.75°W to 119.5°W and 38°N to 44°N. It uses standard-processing
MODIS and Suomi-NPP VIIRS records from NASA FIRMS via the
[Portolan FIRMS mirror](https://source.coop/portolan-mirrors/firms-catalog).
The prepared archive runs without a FIRMS key. Its release audit records source
files and dates without worldwide standard-processing records for each satellite.

From the repository root, install the dependencies with Python 3.10 or later.

```sh
python -m pip install -r backend/requirements.txt
```

Set the archive path and start the server. In PowerShell, run:

```powershell
$env:FIRMS_OUTPUT_DIR = "backend/deploy-data/western-us"
python -m uvicorn backend.api:app --host 127.0.0.1 --port 8765
```

On macOS or Linux, run:

```sh
FIRMS_OUTPUT_DIR=backend/deploy-data/western-us python -m uvicorn backend.api:app --host 127.0.0.1 --port 8765
```

Open [the local dashboard](http://127.0.0.1:8765/).

## Run the static sample

Serve the `frontend` directory from the repository root to try the checked-in
five-day sample. The browser runs the detection analysis with PyScript.

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory frontend
```

Open [the static preview](http://127.0.0.1:8000/). See the
[frontend guide](frontend/README.md) for packaging and hosting static data and
the [archive and calibration guide](backend/howtotest.md) for building a release.

## Deploy on Render

Create a Python Web Service from `main` using the repository root as the working
directory.

| Setting | Value |
| --- | --- |
| Build command | `pip install -r backend/requirements.txt` |
| Start command | `python -m uvicorn backend.api:app --host 0.0.0.0 --port $PORT` |
| Environment variable | `FIRMS_OUTPUT_DIR=backend/deploy-data/western-us` |
| Health check path | `/api/health` |
