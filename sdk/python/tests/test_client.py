import json
import pathlib
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "src"))

from ai_tidu9 import TiduClient  # noqa: E402


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._send({"providers": [{"id": "company.reviewer"}]})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        self._send({"output": request["input"], "usage": {"tokens": 2}, "evidence": ["ok"]})

    def log_message(self, _format, *args):
        return

    def _send(self, payload):
        content = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


class TiduClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.client = TiduClient(f"http://{host}:{port}", api_key="test")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_lists_and_invokes_providers(self):
        self.assertEqual(self.client.list_providers(), [{"id": "company.reviewer"}])
        result = self.client.invoke_provider("company.reviewer", "review", {"text": "hello"})
        self.assertEqual(result.output, {"text": "hello"})
        self.assertEqual(result.usage, {"tokens": 2})
        self.assertEqual(result.evidence, ("ok",))


if __name__ == "__main__":
    unittest.main()
