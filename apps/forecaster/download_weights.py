"""Build step (ADR-0059): downloads the TimesFM 2.5 checkpoint at its pinned revision.

Run only while building the image; the running service never downloads anything.
"""

import os
import sys

from huggingface_hub import snapshot_download

sys.path.insert(0, os.path.dirname(__file__))
from forecaster.contract import CHECKPOINT_REPO, CHECKPOINT_REVISION  # noqa: E402

target = sys.argv[1]
snapshot_download(
    repo_id=CHECKPOINT_REPO,
    revision=CHECKPOINT_REVISION,
    local_dir=target,
    allow_patterns=["model.safetensors", "config.json", "README.md", "LICENSE*"],
)
with open(os.path.join(target, "REVISION"), "w", encoding="utf-8") as f:
    f.write(CHECKPOINT_REVISION + "\n")
