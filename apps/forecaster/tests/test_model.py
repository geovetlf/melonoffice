"""The real TimesFM 2.5 architecture, with random weights: runs only where timesfm is installed.

It checks the loader's guards and the output's shape, not forecast quality (random weights).
The pinned real weights are only in the image (ADR-0059).
"""

import importlib.util
import os
import tempfile
import unittest

HAS_TIMESFM = importlib.util.find_spec("timesfm") is not None


@unittest.skipUnless(HAS_TIMESFM, "timesfm is not installed here")
class TimesFMModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import timesfm
        from safetensors.torch import save_file

        from forecaster.contract import CHECKPOINT_REVISION

        cls.dir = tempfile.TemporaryDirectory()
        module = timesfm.TimesFM_2p5_200M_torch(torch_compile=False).model
        state = {k: v.contiguous() for k, v in module.state_dict().items()}
        save_file(state, os.path.join(cls.dir.name, "model.safetensors"))
        with open(os.path.join(cls.dir.name, "REVISION"), "w", encoding="utf-8") as f:
            f.write(CHECKPOINT_REVISION + "\n")

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def test_forecasts_the_median_and_nine_quantiles(self):
        from forecaster.model import TimesFMModel

        model = TimesFMModel(self.dir.name, max_context=1024, threads=2)
        point, quantiles, usage = model.forecast([float(i % 7 + 1) for i in range(200)], 30)
        self.assertEqual(len(point), 30)
        self.assertTrue(all(len(row) == 9 for row in quantiles))
        self.assertEqual(point, [row[4] for row in quantiles])
        self.assertGreater(usage["memoryMb"], 0)

    def test_refuses_a_checkpoint_of_another_revision(self):
        from forecaster.model import TimesFMModel

        with tempfile.TemporaryDirectory() as other:
            with open(os.path.join(other, "REVISION"), "w", encoding="utf-8") as f:
                f.write("0000000\n")
            with self.assertRaisesRegex(RuntimeError, "not the pinned one"):
                TimesFMModel(other, max_context=1024, threads=2)


if __name__ == "__main__":
    unittest.main()
