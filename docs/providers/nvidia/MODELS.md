# Models

Read on 2026-09-29 from NVIDIA's official model pages. Model availability changes, so this is a snapshot: `listNvidiaModels()` (`GET /v1/models`) reports what is served now, and `catalogueDrift()` flags registered models NVIDIA no longer lists.

The catalogue size (around 100 models, of which a subset carry "Free Endpoint") is **not** hard-coded anywhere.

## Registered in MelonOffice

| Registry id                      | NVIDIA name                      | Capabilities in MelonOffice              | Context / output (MelonOffice cap)           | Terms                                                             | Source                                                                                 |
| -------------------------------- | -------------------------------- | ---------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `nvidia/nemotron-3-nano-30b-a3b` | `nvidia/nemotron-3-nano-30b-a3b` | text generation, tool calling, streaming | 128K published / 16,384 cap (128K published) | free prototyping; production needs a licence; content may be used | [model card](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b) |

About this model:

- Its model card lists text in and text out.
- It is "designed as a unified model for both reasoning and non-reasoning tasks". Reasoning is switched with `enable_thinking`, which is on by default. MelonOffice sends it off and drops any `<think>` trace.
- Tool calling is "Supported". Structured output is trained, but NVIDIA documents `guided_json` for self-hosted NIM only, so MelonOffice does not claim it on the hosted endpoint.
- Its languages are "English, German, Spanish, French, Italian, and Japanese".
- Its licences are the NVIDIA Nemotron Open Model License and the NVIDIA API Trial Terms of Service.

## Researched, not registered

| Model                                           | What NVIDIA publishes                                                                                     | Why not registered                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `nvidia/nemotron-3-super-120b-a12b`             | Text; context "up to 1M tokens"; tool calling; 7 languages; trial service.                                | Max output is not published, and the registry needs a real limit.                                 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Video, audio, image, text in; text out; 262K context; "Free Endpoint Available".                          | MelonOffice has no media path to NVIDIA yet, and tool calling is not stated.                      |
| `nvidia/llama-nemotron-embed-vl-1b-v2`          | Embeddings; text and image; 2048 dims; 8192 max input tokens; trial service.                              | The gateway has no embeddings operation, and Company Brain has no vector store. See CAPABILITIES. |
| `nvidia/nemotron-3-embed-1b` (NIM docs)         | Embeddings via `/v1/embeddings`; 2048 dims; `input_type` query/passage.                                   | Same as above.                                                                                    |
| `nvidia/llama-3.1-nemoguard-8b-content-safety`  | Chat completions returning User Safety / Response Safety / categories; 23 risk categories; trial service. | The registry has no moderation capability yet.                                                    |
| `magpie-tts-multilingual` (Riva)                | TTS over gRPC `grpc.nvcf.nvidia.com:443` with a function id, not OpenAI-compatible.                       | There is no voice path in MelonOffice yet.                                                        |

Other models on build.nvidia.com were not reviewed and are **UNKNOWN**: third-party models such as DeepSeek, Kimi, GLM, GPT-OSS, Gemma, Llama and Qwen, plus Cosmos (physical AI), PaliGemma and Llama Vision. Each needs its own card and licence read before registration. None may be assumed free, available or allowed in production.
