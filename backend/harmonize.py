"""Fit a common active-cell-day index against the Suomi-NPP VIIRS record."""

from calendar import isleap
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from functools import lru_cache

from h3.api import basic_int as h3


PLATFORMS = {"Terra": 1, "Aqua": 2, "Suomi-NPP": 4, "NOAA-20": 8, "NOAA-21": 16}
REFERENCE = PLATFORMS["Suomi-NPP"]
MODIS = PLATFORMS["Terra"] | PLATFORMS["Aqua"]
MODES = {8: "NOAA-20", 16: "NOAA-21", 3: "Terra+Aqua", 1: "Terra", 2: "Aqua"}
RESOLUTION = 7
MIN_CELL_DAYS = 100


@lru_cache(maxsize=100_000)
def cell_info(cell):
    tile = h3.cell_to_parent(cell, 3)
    return (*h3.cell_to_latlng(cell), tile, parent_region(tile))


@lru_cache(maxsize=50_000)
def parent_region(tile):
    return h3.cell_to_parent(tile, 2)


@dataclass
class Totals:
    source: int = 0
    reference: int = 0
    years: set = field(default_factory=set)

    def add(self, year, source, reference):
        self.source += source
        self.reference += reference
        self.years.add(year)

    @property
    def supported(self):
        return min(self.source, self.reference) >= MIN_CELL_DAYS and len(self.years) >= 2


def factors(rows):
    """Use common dates and zero-intercept ratios with spatial shrinkage."""
    totals = defaultdict(Totals)
    for month, tile, source, reference in rows:
        year, season = int(month[:4]), int(month[5:7])
        for key in ((0, 0), (season, 0), (season, parent_region(tile)), (season, tile)):
            totals[key].add(year, source, reference)

    result = {}
    for (season, tile), item in sorted(totals.items()):
        if not item.supported:
            continue
        if tile and h3.get_resolution(tile) == 3:
            parent = result.get((season, parent_region(tile)), result.get((season, 0), result.get((0, 0))))
            if parent is not None:
                result[season, tile] = (item.reference + MIN_CELL_DAYS * parent) / (item.source + MIN_CELL_DAYS)
                continue
        result[season, tile] = item.reference / item.source
    return result


def factor_for(model, season, tile):
    for key in ((season, tile), (season, parent_region(tile)), (season, 0), (0, 0)):
        if key in model:
            return model[key]
    return None


def shared_years(availability, mode):
    required = REFERENCE | mode
    counts = Counter(int(day[:4]) for day, mask in availability.items() if mask & required == required)
    return sorted(year for year, days in counts.items() if days == 365 + isleap(year))


VALIDATION_AREAS = {
    "northern_california": (-124.5, 37.0, -119.0, 42.0),
    "north_india": (73.0, 27.0, 79.0, 33.0),
    "central_sahara": (5.0, 20.0, 20.0, 28.0),
}


def validation(rows, model):
    errors = defaultdict(lambda: {"tile_months": 0, "mae": [0.0] * 3, "bias": [0.0] * 3})
    for month, tile, source, reference in rows:
        factor = factor_for(model, int(month[5:7]), tile)
        global_factor = model.get((0, 0))
        if factor is None or global_factor is None:
            return {}
        residuals = [source * factor - reference, source - reference, source * global_factor - reference]
        lat, lon = h3.cell_to_latlng(tile)
        groups = ["all"] + [name for name, (west, south, east, north) in VALIDATION_AREAS.items()
                            if west <= lon <= east and south <= lat <= north]
        for name in groups:
            group = errors[name]
            group["tile_months"] += 1
            for i, error in enumerate(residuals):
                group["mae"][i] += abs(error)
                group["bias"][i] += error

    for group in errors.values():
        for metric in ("mae", "bias"):
            group[metric] = {name: total / group["tile_months"] for name, total in zip(
                ("regional_ratio", "unadjusted", "global_ratio"), group[metric])}
    return dict(errors)


def calibrate(paired_rows, available, archived):
    """Hold out the latest complete archive year for each platform configuration."""
    models, audit = {}, {}
    for mode, name in MODES.items():
        # An outage can remove days from scoring without turning an otherwise fully
        # imported calendar year into a partial-year partition.
        years = shared_years(archived, mode)
        if not years:
            audit[name] = {"status": "no_complete_overlap_year"}
            continue
        year = years[-1]
        required = REFERENCE | mode
        matched_days = sum(day.startswith(str(year)) and mask & required == required for day, mask in available.items())
        if matched_days < (365 + isleap(year)) * 0.9:
            audit[name] = {"status": "insufficient_holdout_coverage", "holdout_year": year,
                           "holdout_matched_days": matched_days}
            continue
        model = factors(paired_rows(mode, f"{year:04}-01", False))
        scores = validation(paired_rows(mode, f"{year:04}-01", True), model)
        mae = scores.get("all", {}).get("mae")
        passed = bool(mae and mae["regional_ratio"] <= mae["unadjusted"] + 1e-9)
        audit[name] = {"holdout_year": year, "holdout_matched_days": matched_days,
                       "regions": scores, "factor_count": len(model),
                       "status": "validated" if passed else "unvalidated"}
        if passed:
            models[mode] = model
    return models, audit


def select_mode(mask, models):
    if mask & REFERENCE:
        return REFERENCE
    # Select by input availability. A zero-detection day still has a source.
    for mode in MODES:
        if mode in models and mask & mode == mode:
            return mode
    return 0
