"""The forecaster's HTTP server (ADR-0059): GET /health and POST /v1/forecast, nothing else.

It is private: Cloud Run lets only the worker's service account call it (IAM invoker), so it
has no login of its own. It keeps nothing, and logs codes and sizes, never the values.
"""

import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .contract import MAX_BODY_BYTES, MODEL_ID, MODEL_VERSION, InvalidRequest, answer, check_request

log = logging.getLogger("forecaster")


def make_handler(model, max_context: int):
    """A request handler over `model` (anything with `forecast(values, horizon)`)."""
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "melonoffice-forecaster"
        sys_version = ""

        def log_message(self, format, *args):  # noqa: A002 - the base class's name
            pass

        def _send(self, status: int, body: dict):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"status": "ok", "model": {"id": MODEL_ID, "version": MODEL_VERSION}})
            else:
                self._send(404, {"error": "not_found"})

        def do_POST(self):
            if self.path != "/v1/forecast":
                self._send(404, {"error": "not_found"})
                return
            if self.headers.get_content_type() != "application/json":
                self._send(415, {"error": "unsupported_media_type"})
                return
            try:
                length = int(self.headers.get("content-length", ""))
            except ValueError:
                self._send(411, {"error": "length_required"})
                return
            if length < 0 or length > MAX_BODY_BYTES:
                self._send(413, {"error": "too_large"})
                return
            try:
                body = json.loads(self.rfile.read(length))
                values, horizon, frequency = check_request(body, max_context)
            except (ValueError, InvalidRequest) as error:
                field = error.field if isinstance(error, InvalidRequest) else "body"
                self._send(400, {"error": "invalid_request", "field": field})
                return
            try:
                with lock:
                    point, quantiles, usage = model.forecast(values, horizon)
                result = answer(point, quantiles, usage)
            except Exception:  # noqa: BLE001 - any model failure is a 500, logged without data
                log.exception("forecast failed")
                self._send(500, {"error": "forecast_failed"})
                return
            log.info(
                json.dumps(
                    {
                        "message": "forecast",
                        "points": len(values),
                        "horizon": horizon,
                        "frequency": frequency,
                        **usage,
                    }
                )
            )
            self._send(200, result)

    return Handler


def main():
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(message)s")
    from .model import TimesFMModel

    max_context = int(os.environ.get("FORECASTER_MAX_CONTEXT", "1024"))
    model = TimesFMModel(
        path=os.environ.get("FORECASTER_MODEL_PATH", "/models/timesfm-2.5-200m"),
        max_context=max_context,
        threads=int(os.environ.get("FORECASTER_THREADS", "2")),
    )
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(model, max_context))
    log.info(json.dumps({"message": "forecaster ready", "port": port, "model": MODEL_VERSION}))
    server.serve_forever()


if __name__ == "__main__":
    main()
