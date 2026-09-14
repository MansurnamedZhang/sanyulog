import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('server'), 'HTTP API is not implemented')
        from server import make_server
        self.temp = tempfile.TemporaryDirectory()
        self.server = make_server(self.temp.name, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:'+str(self.server.server_port)

    def tearDown(self):
        if hasattr(self, 'server'):
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()
            self.temp.cleanup()

    def request(self, path, data=None, method=None, headers=None):
        h = {'Content-Type': 'application/json', 'Origin': self.base}
        h.update(headers or {})
        raw = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(self.base+path, data=raw, headers=h, method=method)
        try:
            return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=5)
        except urllib.error.HTTPError as e:
            return e

    def test_workspaces_api(self):
        with self.request('/api/workspaces', {'name': '实验'}) as response:
            self.assertEqual(response.status, 200)
            workspace = json.load(response)
        with self.request('/api/workspaces/'+workspace['id'], {'name': '实验二'}, 'PUT') as response:
            self.assertEqual(response.status, 200)
        with self.request('/api/state') as response:
            self.assertIn('实验二', [w['name'] for w in json.load(response)['workspaces']])
        with self.request('/api/workspaces/'+workspace['id'], method='DELETE') as response:
            self.assertEqual(response.status, 200)

    def test_crud_and_markdown(self):
        with self.request('/api/projects', {'name': '项目'}) as response:
            self.assertEqual(response.status, 200)
            p = json.load(response)
        with self.request('/api/records', {'project_id': p['id'], 'title': '我的实验'}) as response:
            r = json.load(response)
        with self.request('/api/records/'+r['id']+'/markdown') as response:
            self.assertIn('我的实验', response.read().decode())
            self.assertIn('attachment', response.headers['Content-Disposition'])
        with self.request('/api/records/'+r['id'], method='DELETE') as response:
            self.assertEqual(response.status, 200)
        with self.request('/api/state') as response:
            self.assertEqual(json.load(response)['records'], [])

    def test_external_origin_and_invalid_payload_rejected(self):
        with self.request('/api/projects', {'name': 'bad'}, headers={'Origin': 'https://evil.example'}) as response:
            self.assertEqual(response.status, 403)
        with self.request('/api/projects', {'name': ''}) as response:
            self.assertEqual(response.status, 400)
        with self.request('/api/projects', ['bad']) as response:
            self.assertEqual(response.status, 400)

    def test_unknown_routes_do_not_expose_disk(self):
        with self.request('/store.py') as response:
            self.assertEqual(response.status, 404)
        with self.request('/api/state', headers={'Host': 'evil.example'}) as response:
            self.assertEqual(response.status, 403)

    def test_binary_attachment_backup_restore_round_trip(self):
        with self.request('/api/projects', {'name': '附件项目'}) as response:
            p = json.load(response)
        with self.request('/api/records', {'project_id': p['id'], 'title': '附件实验'}) as response:
            r = json.load(response)
        with self.request('/api/records/'+r['id']+'/attachments', b'\x00\xff\x01sample', method='POST',
                          headers={'Content-Type': 'application/octet-stream', 'X-Filename': 'weights.bin'}) as response:
            self.assertEqual(response.status, 200)
            a = json.load(response)
        with self.request('/api/backup') as response:
            backup = response.read()
        with self.request('/api/projects/'+p['id'], method='DELETE') as response:
            self.assertEqual(response.status, 200)
        with self.request('/api/restore', backup, method='POST', headers={'Content-Type': 'application/zip'}) as response:
            self.assertEqual(response.status, 200)
        with self.request('/api/attachments/'+a['id']) as response:
            self.assertEqual(response.read(), b'\x00\xff\x01sample')
        with self.request('/api/state') as response:
            self.assertEqual(json.load(response)['records'][0]['title'], '附件实验')

    def test_active_attachment_never_served_inline_and_bad_json_is_400(self):
        p = self.server.store.create_project({'name': 'project'})
        r = self.server.store.create_record({'project_id': p['id'], 'title': 'record'})
        a = self.server.store.add_attachment(r['id'], 'example.html', b'<script>alert(1)</script>', 'text/html')
        with self.request('/api/attachments/'+a['id']+'?preview=1') as response:
            self.assertEqual(response.headers['Content-Type'], 'application/octet-stream')
            self.assertTrue(response.headers['Content-Disposition'].startswith('attachment'))
        with self.request('/api/projects', b'{bad json', method='POST') as response:
            self.assertEqual(response.status, 400)

    def test_notebook_update_roundtrip_and_module_content_types(self):
        for path in ['/notebook.js', '/notebook-core.mjs', '/vendor/katex.mjs']:
            with self.request(path) as response:
                self.assertEqual(response.status, 200)
                self.assertIn('javascript', response.headers['Content-Type'])
        p = self.server.store.create_project({'name': 'Notebook'})
        r = self.server.store.create_record({'project_id': p['id'], 'title': '持续记录'})
        cells = [{'id': 'a'*32, 'type': 'code', 'source': '    train()\n', 'language': 'python', 'attachment_ids': []}]
        with self.request('/api/records/'+r['id'], {'version': r['version'], 'cells': cells}, method='PUT') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.load(response)['cells'], cells)
        with self.request('/api/records/'+r['id'], {'version': r['version'], 'cells': []}, method='PUT') as response:
            self.assertEqual(response.status, 409)


if __name__ == '__main__':
    unittest.main()
