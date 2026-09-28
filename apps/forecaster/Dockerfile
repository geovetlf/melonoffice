# The forecaster (ADR-0059): TimesFM 2.5 on CPU. Build from the repository root:
#   docker build -f apps/forecaster/Dockerfile .
# The weights are downloaded here, at the pinned revision, and baked into the image; the
# running service never reaches Hugging Face.

FROM python:3.11-slim AS weights
RUN pip install --no-cache-dir huggingface_hub==2.0.0
WORKDIR /build
COPY apps/forecaster/forecaster ./forecaster
COPY apps/forecaster/download_weights.py .
RUN python download_weights.py /models/timesfm-2.5-200m

FROM python:3.11-slim
ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    PORT=8080
WORKDIR /app
COPY apps/forecaster/requirements-torch.txt apps/forecaster/requirements.txt ./
RUN pip install --no-cache-dir -r requirements-torch.txt \
  && pip install --no-cache-dir -r requirements.txt
COPY --from=weights /models /models
COPY apps/forecaster/forecaster ./forecaster
COPY apps/forecaster/THIRD_PARTY_NOTICES.md ./
RUN useradd --uid 10001 --no-create-home forecaster
USER forecaster
EXPOSE 8080
CMD ["python", "-m", "forecaster.server"]
