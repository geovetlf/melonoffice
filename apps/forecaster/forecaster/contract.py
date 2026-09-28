"""The forecaster's HTTP contract (ADR-0059), with no model and no torch: it only checks input.

POST /v1/forecast takes exactly {"values": [...], "horizon": n, "frequency": "day"|"week"|"month"}
and answers {"model": {"id", "version"}, "point": [...], "quantiles": [[9 values], ...],
"usage": {...}}. The Forecasting Engine checks the answer again on its side.
"""

import math

MODEL_ID = "timesfm-2.5-200m"
PACKAGE_VERSION = "2.0.2"
CHECKPOINT_REPO = "google/timesfm-2.5-200m-pytorch"
CHECKPOINT_REVISION = "d418f3e8a8fa79d655b391c158f0ee8d68fe68c9"
MODEL_VERSION = f"{PACKAGE_VERSION}+{CHECKPOINT_REVISION[:8]}"

FREQUENCIES = ("day", "week", "month")
# TimesFM 2.5 predicts 128 steps per pass; past it, 2.0.2 uses its autoregressive path.
MAX_HORIZON = 128
MAX_BODY_BYTES = 512 * 1024
FIELDS = {"values", "horizon", "frequency"}


class InvalidRequest(ValueError):
    """The request is not one the forecaster runs. `field` names what was wrong."""

    def __init__(self, field: str):
        super().__init__(field)
        self.field = field


def _number(value) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def check_request(body, max_context: int):
    """The request's values, horizon and frequency; InvalidRequest otherwise."""
    if not isinstance(body, dict) or set(body.keys()) != FIELDS:
        raise InvalidRequest("body")
    values = body["values"]
    if (
        not isinstance(values, list)
        or len(values) < 1
        or len(values) > max_context
        or not all(_number(v) for v in values)
    ):
        raise InvalidRequest("values")
    horizon = body["horizon"]
    if (
        not isinstance(horizon, int)
        or isinstance(horizon, bool)
        or horizon < 1
        or horizon > MAX_HORIZON
    ):
        raise InvalidRequest("horizon")
    frequency = body["frequency"]
    if frequency not in FREQUENCIES:
        raise InvalidRequest("frequency")
    return [float(v) for v in values], horizon, frequency


def answer(point, quantiles, usage):
    """The response body. Every number must be finite; the caller checks the shapes too."""
    horizon = len(point)
    if len(quantiles) != horizon or any(len(row) != 9 for row in quantiles):
        raise ValueError("model output has the wrong shape")
    flat = [*point, *(q for row in quantiles for q in row)]
    if not all(_number(v) for v in flat):
        raise ValueError("model output is not finite")
    return {
        "model": {"id": MODEL_ID, "version": MODEL_VERSION},
        "point": [float(v) for v in point],
        "quantiles": [[float(q) for q in row] for row in quantiles],
        "usage": usage,
    }
