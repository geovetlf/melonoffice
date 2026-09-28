"""The forecaster's contract and server, with a fake model: no torch needed (ADR-0059)."""

import http.client
import json
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

from forecaster.contract import MODEL_VERSION, check_request, InvalidRequest
from forecaster.server import make_handler


class FakeModel:
    def __init__(self, fail=False, nan=False):
        self.calls = []
        self.fail = fail
        self.nan = nan

    def forecast(self, values, horizon):
        self.calls.append((values, horizon))
        if self.fail:
            raise RuntimeError("boom")
        point = [float("nan") if self.nan else 10.0] * horizon
        quantiles = [[1, 2, 3, 4, 10, 6, 7, 8, 9]] * horizon
        return point, quantiles, {"inferenceMs": 5, "memoryMb": 100}


class ContractTest(unittest.TestCase):
    def test_accepts_exactly_the_contract(self):
        values, horizon, frequency = check_request(
            {"values": [1, 2.5, 0], "horizon": 7, "frequency": "day"}, 1024
        )
        self.assertEqual((values, horizon, frequency), ([1.0, 2.5, 0.0], 7, "day"))

    def test_refuses_anything_else(self):
        good = {"values": [1, 2], "horizon": 7, "frequency": "week"}
        for bad, field in [
            ([], "body"),
            ({**good, "extra": 1}, "body"),
            ({"values": [1], "horizon": 7}, "body"),
            ({**good, "values": []}, "values"),
            ({**good, "values": [1, "2"]}, "values"),
            ({**good, "values": [1, True]}, "values"),
            ({**good, "values": [1] * 1025}, "values"),
            ({**good, "horizon": 0}, "horizon"),
            ({**good, "horizon": 129}, "horizon"),
            ({**good, "horizon": 7.0}, "horizon"),
            ({**good, "horizon": True}, "horizon"),
            ({**good, "frequency": "hour"}, "frequency"),
        ]:
            with self.assertRaises(InvalidRequest) as caught:
                check_request(bad, 1024)
            self.assertEqual(caught.exception.field, field)


class ServerTest(unittest.TestCase):
    def start(self, model):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(model, 1024))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def post(self, url, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = urllib.request.Request(
            url + "/v1/forecast", data=data, headers={"content-type": content_type}
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def post_oversized(self, url):
        # Only the headers: the server refuses on the declared length before reading the body.
        # Writing the body too would race the refusal and fail with a broken pipe.
        connection = http.client.HTTPConnection(urllib.parse.urlsplit(url).netloc)
        self.addCleanup(connection.close)
        connection.putrequest("POST", "/v1/forecast")
        connection.putheader("content-type", "application/json")
        connection.putheader("content-length", str(512 * 1024 + 1))
        connection.endheaders()
        return connection.getresponse().status

    def test_health_names_the_pinned_model(self):
        url = self.start(FakeModel())
        with urllib.request.urlopen(url + "/health") as response:
            body = json.loads(response.read())
        self.assertEqual(body["model"], {"id": "timesfm-2.5-200m", "version": MODEL_VERSION})
        self.assertEqual(MODEL_VERSION, "2.0.2+d418f3e8")

    def test_forecasts_with_the_model_version_the_engine_checks(self):
        model = FakeModel()
        url = self.start(model)
        status, body = self.post(url, {"values": [1, 2, 3], "horizon": 2, "frequency": "day"})
        self.assertEqual(status, 200)
        self.assertEqual(body["model"]["version"], MODEL_VERSION)
        self.assertEqual(body["point"], [10.0, 10.0])
        self.assertEqual(len(body["quantiles"]), 2)
        self.assertEqual(len(body["quantiles"][0]), 9)
        self.assertEqual(model.calls, [([1.0, 2.0, 3.0], 2)])

    def test_refuses_bad_requests_without_running_the_model(self):
        model = FakeModel()
        url = self.start(model)
        self.assertEqual(self.post(url, {"values": [1], "horizon": 500, "frequency": "day"})[0], 400)
        self.assertEqual(self.post(url, b"{not json")[0], 400)
        self.assertEqual(self.post(url, {"values": [1]}, content_type="text/plain")[0], 415)
        self.assertEqual(self.post_oversized(url), 413)
        self.assertEqual(model.calls, [])

    def test_a_failing_or_non_finite_model_is_a_500_without_data(self):
        for model in (FakeModel(fail=True), FakeModel(nan=True)):
            url = self.start(model)
            status, body = self.post(url, {"values": [1, 2], "horizon": 1, "frequency": "day"})
            self.assertEqual((status, body), (500, {"error": "forecast_failed"}))


if __name__ == "__main__":
    unittest.main()
