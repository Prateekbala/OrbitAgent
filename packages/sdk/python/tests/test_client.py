import json
import unittest
from io import BytesIO
from urllib.error import HTTPError
from orbit_sdk import OrbitClient, OrbitError

class Response(BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): self.close()

class TestClient(unittest.TestCase):
    def test_contract_and_single_dispatch(self):
        client = OrbitClient("https://example.test/api/public/v1", lambda: "private-token")
        class Opener:
            calls = 0
            def open(self, request, timeout):
                self.calls += 1
                assert request.full_url == "https://example.test/api/public/v1/tasks"
                assert request.headers["Authorization"] == "Bearer private-token"
                assert json.loads(request.data)["clientId"] == "stable-id"
                return Response(b'{"id":"task-id"}')
        opener = Opener()
        client._opener = opener
        self.assertEqual(client.request("createTask", body={"clientId": "stable-id", "title": "Contract"}), {"id": "task-id"})
        self.assertEqual(opener.calls, 1)

    def test_errors_do_not_include_credentials(self):
        client = OrbitClient("https://example.test/api/public/v1", "private-token")
        class Opener:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 403, "Forbidden", {}, Response(b'{"error":{"code":"INSUFFICIENT_SCOPE","message":"Missing scope"}}'))
        client._opener = Opener()
        with self.assertRaises(OrbitError) as caught:
            client.request("getTask", path={"id": "task-id"})
        self.assertEqual(caught.exception.code, "INSUFFICIENT_SCOPE")
        self.assertNotIn("private-token", str(caught.exception))

    def test_insecure_external_base_url_rejected(self):
        with self.assertRaises(ValueError): OrbitClient("http://example.test/api/public/v1", "private-token")

if __name__ == "__main__": unittest.main()
