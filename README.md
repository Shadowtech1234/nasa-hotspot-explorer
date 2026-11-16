# Fire Signal

**Explore NASA satellite fire detections and see how a month compares with the same season in earlier years.**

Fire Signal is a dashboard for students, educators, and anyone exploring fire activity. It brings together daily hotspot maps, sensor comparisons, and historical context using observations from NASA’s Fire Information for Resource Management System (FIRMS).

[Frontend documentation](frontend/README.md) · [Backend and archive files](backend/) · [Data credits](#data-credits)

## Explore the dashboard

| View | What you can explore |
| --- | --- |
| **Map & Calendar** | Filter by area, date, or sensor. Select a day to inspect individual hotspots or view monthly activity across the map. |
| **Analysis** | Explore daily and seasonal patterns and the distribution of fire radiative power (FRP). |
| **Compare** | Compare MODIS and Suomi-NPP VIIRS trends and inspect the same period on synchronized maps. |
| **History** | Explore weekly activity and see where a month ranks against the same calendar month in earlier years. |

Each view supports CSV and JSON exports. The bundled five-day sample supports daily detections, density, sensor comparison, and FRP. Historical views require archive data or a compatible monthly export. Weekly activity requires the server archive.

## How monthly comparisons work

1. **Group detections into hexagons.** Historical analysis counts how many H3 grid cells had at least one detection on each day.
2. **Adjust for differences between sensors.** The monthly calculation uses Suomi-NPP VIIRS as the reference for comparing activity across instruments.
3. **Compare like months.** The dashboard ranks an eligible month against the same calendar month in earlier years for the selected area.

A reported zero means the source recorded zero detections for that day. Missing data is shown as unavailable. The historical ranking describes observed satellite activity in the selected area.

## Project files

| Directory | Contents |
| --- | --- |
| [`frontend/`](frontend/) | Browser interface built with HTML, CSS, JavaScript, and Leaflet. |
| [`backend/`](backend/) | Python data processing, archive tooling, and the FastAPI service. |

## Data credits

Fire Signal uses MODIS and Suomi-NPP VIIRS standard-processing observations from NASA FIRMS. The bundled archive was prepared using the [Portolan FIRMS mirror](https://source.coop/portolan-mirrors/firms-catalog). The [frontend documentation](frontend/README.md#satellite-scene-provenance) records the sources for the satellite basemap imagery.

Built for the **NASA Space Apps Challenge**.
