"""Compute exact FIRMS detection counts and points from packets in memory."""

import csv
from datetime import date, timedelta
import io

if __package__:
    from .normalize import normalize
else:
    from normalize import normalize


SENSORS = ("MODIS", "VIIRS")


def contains(outer, inner):
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and outer[2] >= inner[2] and outer[3] >= inner[3])


def analyze(request):
    """Return JSON-compatible daily results. A null count indicates missing input."""
    west, south, east, north = request["bbox"]
    rows = {}
    coverage = [item for item in request["coverage"]
                if west < item["bbox"][2] and item["bbox"][0] < east
                and south < item["bbox"][3] and item["bbox"][1] < north]
    failed_packets = [packet for packet in request["packets"] if packet["text"] is None]
    current = date.fromisoformat(request["start"])
    end = date.fromisoformat(request["end_exclusive"])
    while current < end:
        day = current.isoformat()
        counts = dict.fromkeys(SENSORS)
        partial = set()
        for item in coverage:
            if item["start"] <= day < item["end_exclusive"]:
                sensor = item["sensor"]
                counts[sensor] = 0
                if not contains(item["bbox"], request["bbox"]):
                    partial.add(sensor)
        for packet in failed_packets:
            if packet["start"] <= day < packet["end_exclusive"]:
                counts[packet["sensor"]] = None
                partial.discard(packet["sensor"])
        rows[day] = {"date_utc": day, "sensor_detections": counts,
                     "partial_sensors": sorted(partial), "points": []}
        current += timedelta(days=1)

    for packet in request["packets"]:
        if packet["text"] is None:
            continue
        sensor = packet["sensor"]
        reader = csv.DictReader(io.StringIO(packet["text"], newline=""))
        for row in reader:
            point, _ = normalize(row, sensor, str(reader.line_num))
            lon, lat = point["longitude"], point["latitude"]
            timestamp = point["acquired_at_utc"]
            day = timestamp[:10]
            if day not in rows or not (west <= lon < east and south <= lat < north):
                continue
            result = rows[day]
            if result["sensor_detections"][sensor] is None:
                continue
            result["sensor_detections"][sensor] += 1
            result["points"].append({
                "lon": lon, "lat": lat, "date": day, "sensor": sensor,
                "time": timestamp[11:16], "satellite": point["platform"],
                "confidence": point["confidence_raw"], "frp": point["frp_mw"],
            })
    return {"rows": list(rows.values()), "unavailable_packets": len(failed_packets)}
