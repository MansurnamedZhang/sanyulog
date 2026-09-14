import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from server import make_server


class DeploymentTests(unittest.TestCase):
    def test_configured_lan_origin_works_and_foreign_origin_stays_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            try:
                server = make_server(folder, 0, host='127.0.0.1', allowed_origins=['http://process-log.example:8765'])
            except TypeError:
                self.fail('Configurable container/LAN binding is not implemented')
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def request(path, origin, data=None):
                headers = {'Host': 'process-log.example:8765', 'Origin': origin, 'Content-Type': 'application/json'}
                req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,
                                             data=json.dumps(data).encode() if data is not None else None, headers=headers)
                try:
                    return opener.open(req, timeout=5)
                except urllib.error.HTTPError as e:
                    return e
            try:
                with request('/api/projects', 'http://process-log.example:8765', {'name': 'LAN project'}) as response:
                    self.assertEqual(response.status, 200)
                with request('/api/projects', 'https://evil.example', {'name': 'bad'}) as response:
                    self.assertEqual(response.status, 403)
                with request('/api/health', 'http://process-log.example:8765') as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.load(response), {'ok': True})
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
