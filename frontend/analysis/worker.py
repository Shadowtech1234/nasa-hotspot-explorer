"""PyScript entry point. Keep the analysis callable independent of the browser."""

import json
from polyscript import xworker

from detail import analyze


def analyze_json(payload):
    return json.dumps(analyze(json.loads(payload)), allow_nan=False)


xworker.sync.analyze = analyze_json
