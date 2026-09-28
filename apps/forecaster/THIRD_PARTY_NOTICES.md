# Third-party notices (forecaster)

This image runs Google's TimesFM 2.5 for MelonOffice's Forecasting Engine (ADR-0059).

| Component                  | Version                                                                        | License      | Source                                                 |
| -------------------------- | ------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------ |
| TimesFM (code)             | `timesfm` 2.0.2                                                                | Apache-2.0   | https://github.com/google-research/timesfm             |
| TimesFM 2.5 200M (weights) | `google/timesfm-2.5-200m-pytorch` @ `d418f3e8a8fa79d655b391c158f0ee8d68fe68c9` | Apache-2.0   | https://huggingface.co/google/timesfm-2.5-200m-pytorch |
| PyTorch                    | 2.14.0 (CPU)                                                                   | BSD-3-Clause | https://pytorch.org                                    |
| NumPy                      | 2.4.6                                                                          | BSD-3-Clause | https://numpy.org                                      |
| safetensors                | 0.8.0                                                                          | Apache-2.0   | https://github.com/huggingface/safetensors             |
| huggingface_hub            | 2.0.0                                                                          | Apache-2.0   | https://github.com/huggingface/huggingface_hub         |

The weights are used unmodified. The Apache-2.0 license text is at
https://www.apache.org/licenses/LICENSE-2.0 and ships with each Python package in its
`*.dist-info` folder inside the image.
