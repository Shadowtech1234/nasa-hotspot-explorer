"""Regression tests for archive coverage, calibration, and map/calendar consistency."""

import csv
from datetime import date, timedelta
import json
from pathlib import Path
import tempfile
import unittest

from .archive import WORLD, parse_bounds, within_bounds
from .history import build_archive, open_history
from .package_monthly import month_file


class ArchiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        root = Path(cls.temp.name)
        cls.output = root / "output"
        inputs = []

        def register(product, start, end, rows, powers=None):
            filename = f"{product}-{start}.csv"
            with (root / filename).open("w", encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(["acq_date", "satellite", "latitude", "longitude", "confidence", "type", "acq_time", "frp"])
                writer.writerows((*row, "0042", 10 if powers is None else powers[index])
                                 for index, row in enumerate(rows))
            inputs.append({"product": product, "start": start, "end_exclusive": end, "path": filename})

        for product, platform, latitude_longitudes, confidence in (
            ("MODIS_SP", "T", [(38.2, -122.6)], "30"),
            ("VIIRS_SNPP_SP", "N", [(38.2, -122.6), (38.2, -122.55)], "nominal"),
            ("VIIRS_NOAA20_SP", "J1", [(38.2, -122.6), (38.2, -122.55)], "h"),
        ):
            records = []
            for year in range(2019, 2025):
                for offset in range(31):
                    day = date(year, 1, 1) + timedelta(days=offset)
                    records.extend((day, platform, lat, lon, confidence, "0") for lat, lon in latitude_longitudes)
            register(product, "2019-01-01", "2025-01-01", records)

        old = ("2001-08-01", "Terra", 38.2, -122.6, "40", "0")
        register("MODIS_SP", "2001-08-01", "2001-08-03", [old, old,
                 ("2001-08-01", "T", 38.24, -122.6, "29", "0"), ("2001-08-01", "T", 38.28, -122.6, "99", "2")],
                 powers=[10, 10, None, 120])
        register("VIIRS_SNPP_SP", "2026-11-01", "2026-11-03", [("2026-11-02", "N", 10, 20, "N", "0")])
        register("VIIRS_NOAA20_SP", "2026-11-01", "2026-11-04", [("2026-11-02", "N20", 38.2, -122.6, "N", "0")])
        register("VIIRS_NOAA20_NRT", "2026-11-02", "2026-11-05", [
            ("2026-11-02", "N20", 0, 179.6, "h", ""), ("2026-11-04", "N20", 0, 179.8, "h", ""),
            ("2026-11-04", "N20", 0, -179.8, "h", ""), ("2026-11-04", "N20", 0, 0, "h", ""),
        ])
        cls.config = root / "manifest.json"
        cls.config.write_text(json.dumps({"inputs": inputs, "outages": [{"platform": "NOAA-20", "start": "2026-11-03",
                                                                         "end_exclusive": "2026-11-04"}]}), encoding="utf-8")
        cls.release = build_archive(cls.config, cls.output)
        cls.history = open_history(cls.output)

    def calendar(self, start, end, granularity="month", bbox=WORLD):
        return self.history.calendar(bbox, date.fromisoformat(start), date.fromisoformat(end), granularity)["rows"]

    def test_held_out_model_and_historical_estimate(self):
        model = self.history.validation()["calibrations"]["Terra"]
        self.assertEqual(model["holdout_year"], 2024)
        self.assertEqual(model["status"], "validated")
        self.assertLess(model["regions"]["all"]["mae"]["regional_ratio"], model["regions"]["all"]["mae"]["unadjusted"])
        month, = self.calendar("2001-08-01", "2001-09-01")
        self.assertEqual(month["activity"], 2)
        self.assertEqual(month["observed_cell_days"], 1)
        self.assertEqual(month["usable_days"], 2)
        self.assertEqual(month["source_days"], {"Terra": 2})

    def test_same_month_baseline_across_prior_years(self):
        month, = self.calendar("2024-01-01", "2024-02-01", bbox=(-123, 37, -121, 40))
        self.assertEqual(month["activity"], 62)
        self.assertEqual(month["historical_median"], 62)
        self.assertEqual(month["historical_percentile"], 50)
        self.assertEqual(month["baseline_years"], 5)
        partial, = self.calendar("2024-01-01", "2024-01-04")
        self.assertEqual(partial["activity"], 6)
        self.assertIsNone(partial["historical_median"])

    def test_daily_raw_and_observed_cells(self):
        first, empty, unavailable = self.calendar("2001-08-01", "2001-08-04", "day")
        self.assertEqual(first["sensor_detections"], {"MODIS": 4, "VIIRS": None})
        self.assertEqual(first["observed_cell_days"], 1)
        self.assertEqual(empty["sensor_detections"], {"MODIS": 0, "VIIRS": None})
        self.assertEqual(empty["observed_cell_days"], 0)
        self.assertIsNone(unavailable["observed_cell_days"])
        cells = self.history.map_points(first["date_utc"], WORLD, "cells", None, 10, 0)
        self.assertEqual(len(cells["features"]), first["observed_cell_days"])

    def test_handoff_outage_and_provisional_are_different(self):
        days = self.calendar("2026-11-01", "2026-11-05", "day")
        self.assertEqual([day["source"] for day in days], ["Suomi-NPP", "NOAA-20", None, None])
        self.assertEqual(days[1]["sensor_detections"]["VIIRS"], 2)
        self.assertEqual(days[1]["provisional_platforms"], [])
        self.assertIsNone(days[2]["sensor_detections"]["VIIRS"])
        self.assertIsNone(days[2]["observed_cell_days"])
        self.assertEqual(days[3]["provisional_platforms"], ["NOAA-20"])
        self.assertIsNone(days[3]["observed_cell_days"])

    def test_dateline_and_pagination(self):
        bounds = parse_bounds("170,-10,-170,10")
        self.assertTrue(within_bounds(bounds, WORLD))
        self.assertFalse(within_bounds(WORLD, bounds))
        query = ("2026-11-04", bounds, "detections", "VIIRS", 1)
        first = self.history.map_points(*query, 0)
        second = self.history.map_points(*query, first["metadata"]["next_offset"])
        self.assertIsNone(second["metadata"]["next_offset"])
        lon1 = first["features"][0]["geometry"]["coordinates"][0]
        lon2 = second["features"][0]["geometry"]["coordinates"][0]
        self.assertEqual({lon1, lon2}, {-179.8, 179.8})

    def test_analytics_week_boundaries_and_sensor_coverage(self):
        result = self.history.analytics(WORLD, date(2019, 12, 29), date(2020, 1, 3))
        last, first = result["weeks"]
        self.assertEqual((last["year"], last["week"], last["observed_cell_days"]), (2019, 52, 0))
        self.assertEqual((first["year"], first["week"], first["observed_cell_days"]), (2020, 1, 4))
        self.assertEqual(first["days"][0]["date_utc"], "2019-12-30")
        december, january = result["months"]
        self.assertEqual(december["sensors"]["VIIRS"], {"count": 0, "reporting_days": 3})
        self.assertEqual(january["sensors"]["MODIS"], {"count": 2, "reporting_days": 2})

        result = self.history.analytics(WORLD, date(2001, 8, 1), date(2001, 8, 4))
        self.assertEqual(result["weeks"][0]["available_days"], 2)
        self.assertEqual(result["months"][0]["sensors"]["VIIRS"], {"count": None, "reporting_days": 0})

    def test_frp_summary_uses_full_filtered_day(self):
        bbox = (170, -10, -170, 10)
        sample = self.history.map_points("2026-11-04", bbox, "detections", "VIIRS", 1, 0)
        self.assertEqual(len(sample["features"]), 1)
        stats = self.history.daily_frp("2026-11-04", bbox)
        self.assertEqual(stats["VIIRS"], {"sample_count": 2, "mean_mw": 10, "bins": [0, 2, 0, 0, 0]})
        self.assertEqual(stats["MODIS"]["sample_count"], 0)
        density = self.history.daily_density("2026-11-04", bbox, .25)
        self.assertEqual(sum(feature["properties"]["count"] for feature in density["features"]), 2)
        self.assertEqual({feature["properties"]["sensor"] for feature in density["features"]}, {"VIIRS"})

    def test_frp_map_ranks_measured_detections_before_pagination(self):
        query = ("2001-08-01", WORLD, "frp", "MODIS")
        first = self.history.map_points(*query, 1, 0)
        self.assertEqual(first["metadata"]["next_offset"], 1)
        second = self.history.map_points(*query, 2, 1)
        self.assertIsNone(second["metadata"]["next_offset"])
        features = first["features"] + second["features"]
        self.assertEqual([feature["properties"]["frp_mw"] for feature in features], [120, 10, 10])

    def test_repeat_build_uses_same_release(self):
        self.assertEqual(build_archive(self.config, self.output), self.release)

    def test_monthly_map_totals_and_partial_percentiles(self):
        month = date(2024, 1, 1)
        for end in (date(2024, 2, 1), date(2024, 1, 4)):
            expected, = self.calendar(month.isoformat(), end.isoformat())
            exported = json.loads(month_file(self.history, WORLD, expected))
            for resolution in (2, 3, 4, 5):
                overview = self.history.overview(WORLD, month, month, end, resolution)
                if resolution in (2, 3):
                    self.assertEqual(exported["maps"][str(resolution)], overview["features"])
                rows = [feature["properties"] for feature in overview["features"]]
                self.assertTrue(rows)
                self.assertEqual(sum(row["activity"] for row in rows), expected["activity"])
                self.assertEqual(sum(row["observed_cell_days"] for row in rows), expected["observed_cell_days"])
                self.assertEqual(all(row["historical_percentile"] is None for row in rows), end.month == 1)

    def test_invalid_replacement_leaves_active_release_available(self):
        invalid = self.config.parent / "invalid.csv"
        invalid.write_text("latitude,longitude\n0,0\n", encoding="utf-8")
        config = self.config.parent / "invalid.json"
        config.write_text(json.dumps({"inputs": [{"product": "MODIS_SP", "path": invalid.name,
                                                 "start": "2024-01-01", "end_exclusive": "2024-01-02"}]}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Missing or duplicate MODIS_SP CSV headers"):
            build_archive(config, self.output)
        self.assertEqual(open_history(self.output).version, self.history.version)


if __name__ == "__main__":
    unittest.main()
