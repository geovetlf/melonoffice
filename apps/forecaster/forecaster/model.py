"""TimesFM 2.5 on CPU (ADR-0059), loaded once from the weights baked into the image."""

import os
import resource
import time

from .contract import CHECKPOINT_REVISION, MAX_HORIZON, PACKAGE_VERSION


class TimesFMModel:
    """The model, compiled once. `forecast` is not thread-safe: the server calls it one at a time."""

    def __init__(self, path: str, max_context: int, threads: int):
        # Imported here so the contract and its tests need no torch.
        from importlib.metadata import version

        import numpy as np
        import timesfm
        import torch

        installed = version("timesfm")
        if installed != PACKAGE_VERSION:
            raise RuntimeError(f"timesfm {installed} installed, {PACKAGE_VERSION} required")
        with open(os.path.join(path, "REVISION"), encoding="utf-8") as f:
            revision = f.read().strip()
        if revision != CHECKPOINT_REVISION:
            raise RuntimeError(f"checkpoint revision {revision} is not the pinned one")

        torch.set_num_threads(threads)
        self._np = np
        self._torch = torch
        model = timesfm.TimesFM_2p5_200M_torch(torch_compile=False)
        model.load_checkpoint(path, torch_compile=False)
        model.model.eval()
        model.compile(
            timesfm.ForecastConfig(
                max_context=max_context,
                max_horizon=MAX_HORIZON,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
            )
        )
        self._model = model

    def forecast(self, values, horizon: int):
        """The median per period and the 0.1..0.9 quantiles, with what the call took."""
        started = time.perf_counter()
        with self._torch.inference_mode():
            _, quantiles = self._model.forecast(
                horizon=horizon, inputs=[self._np.asarray(values, dtype=self._np.float32)]
            )
        rows = quantiles[0][:horizon]
        # Column 0 is the mean; 1..9 are the 0.1..0.9 quantiles. The point is the median (0.5).
        point = [float(row[5]) for row in rows]
        bands = [[float(q) for q in row[1:10]] for row in rows]
        usage = {
            "inferenceMs": round((time.perf_counter() - started) * 1000),
            "memoryMb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024,
        }
        return point, bands, usage
