"""Normalize FIRMS rows while retaining source attributes and audit details."""

from datetime import date, datetime, timezone
import math
import re


def normalize(row, sensor, record_id):
    # DictReader uses None for extra columns or missing values at the end of a row.
    if None in row or None in row.values():
        raise ValueError("wrong_column_count")
    try:
        lat = float(row["latitude"])
        lon = float(row["longitude"])
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError
    except ValueError:
        raise ValueError("invalid_coordinates") from None

    raw_date = row["acq_date"].strip()
    raw_time = row["acq_time"].strip()
    try:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", raw_date):
            raise ValueError
        if not re.fullmatch(r"[0-9]{1,4}", raw_time):
            raise ValueError
        day = date.fromisoformat(raw_date)
        # FIRMS reports UTC time as HHMM. CSVs may omit leading zeros.
        hour, minute = divmod(int(raw_time), 100)
        timestamp = datetime(day.year, day.month, day.day, hour, minute, tzinfo=timezone.utc)
    except ValueError:
        raise ValueError("invalid_acquisition_timestamp") from None

    platform = row["satellite"].strip()
    if not platform:
        raise ValueError("missing_platform")

    # Fire radiative power is optional for detection counts. Report issues separately.
    frp = None
    frp_issue = None
    raw_frp = row.get("frp", "").strip()
    if raw_frp:
        try:
            frp = float(raw_frp)
            if not math.isfinite(frp) or frp < 0:
                raise ValueError
        except ValueError:
            frp = None
            frp_issue = "invalid_frp"
    else:
        frp_issue = "missing_frp"

    return {
        "record_id": record_id,
        "sensor": sensor,
        "platform": platform,
        "latitude": lat,
        "longitude": lon,
        "acquired_at_utc": timestamp.isoformat().replace("+00:00", "Z"),
        "confidence_raw": row.get("confidence", "").strip() or None,
        "frp_mw": frp,
    }, frp_issue
