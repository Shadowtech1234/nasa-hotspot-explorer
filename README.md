# Fire Signal

Fire Signal is an interactive dashboard for exploring satellite fire detections from NASA’s Fire Information for Resource Management System (FIRMS). It helps answer a question a hotspot map alone can’t: **Was this month unusually active for this area?**

[Open the live dashboard](YOUR_VERCEL_URL) · [Watch the 30-second demo](YOUR_DEMO_VIDEO_URL)

## What you can do

| View | What it shows |
| --- | --- |
| **Map & Calendar** | Filter by area, date, or sensor. Select a day to see individual hotspot detections or explore monthly activity on a map. |
| **Analysis** | Explore daily and seasonal detection patterns and fire radiative power. Export filtered detections as CSV or JSON. |
| **Compare** | Compare MODIS and Suomi-NPP VIIRS observations on synchronized maps and see detection trends over time. |
| **History** | Explore weekly activity and see how a month ranks against the same month in earlier years. |

## How it works

Fire Signal groups NASA FIRMS detections into hexagonal grid cells. For the historical analysis, it measures how many grid cells showed activity each day and uses Suomi-NPP VIIRS as a reference to put monthly activity from both instruments on a comparable scale.

The dashboard compares each eligible month with the same calendar month in earlier years for the selected area. It also distinguishes days with zero detections from days when source data was unavailable. These choices help users interpret what they see and put a busy month in seasonal context.

## Why we built it

Satellite data can show where fire activity was detected, but raw records are difficult to explore without specialized tools. We built Fire Signal for students, educators, and anyone curious about fire activity. The dashboard brings the map, sensor comparisons, and historical context together so users can explore the data from their browser.

## Built with

- **Python and FastAPI** for data processing and the API
- **HTML, CSS, and JavaScript** for the browser interface
- **NASA FIRMS** for MODIS and Suomi-NPP VIIRS fire detection data


## Data credits

Fire Signal uses NASA FIRMS standard-processing observations. The bundled archive was prepared using the [Portolan FIRMS mirror](https://source.coop/portolan-mirrors/firms-catalog).

Built for the NASA Space Apps Challenge.
