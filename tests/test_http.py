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

    def attachment(self, content, mime, name='media'):
        project = self.server.store.create_project({'name': 'media-test'})
        record = self.server.store.create_record({'project_id': project['id'], 'title': 'isolated-media'})
        return self.server.store.add_attachment(record['id'], name, content, mime)

    def assert_attachment_headers(self, response, length):
        self.assertEqual(response.headers['Content-Length'], str(length))
        self.assertEqual(response.headers['Accept-Ranges'], 'bytes')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
        self.assertIn("object-src 'none'", response.headers['Content-Security-Policy'])

    def test_supported_media_requires_matching_signature_to_preview(self):
        fixtures = [
            ('image/png', b'\x89PNG\r\n\x1a\n' + b'\x00' * 24),
            ('image/jpeg', b'\xff\xd8\xff\xe0' + b'\x00' * 24),
            ('image/gif', b'GIF89a' + b'\x00' * 24),
            ('image/webp', b'RIFF\x10\x00\x00\x00WEBPVP8 ' + b'\x00' * 8),
            ('video/mp4', b'\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42'),
            ('video/webm', b'\x1a\x45\xdf\xa3\x87\x42\x82\x84webm' + b'\x18\x53\x80\x67\x80'),
            ('audio/mpeg', b'\xff\xfb\x90\x64' + b'\x00' * 413),
            ('audio/mpeg', b'ID3\x04\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x64' + b'\x00' * 413),
            ('audio/ogg', b'OggS\x00\x02' + b'\x00' * 20 + b'\x01\x13OpusHead' + b'\x00' * 11),
            ('audio/wav', b'RIFF\x24\x00\x00\x00WAVEfmt ' + b'\x00' * 28),
        ]
        for mime, content in fixtures:
            with self.subTest(mime=mime, prefix=content[:10]):
                attachment = self.attachment(content, mime, '文件 name.media')
                path = '/api/attachments/' + attachment['id']
                with self.request(path + '?preview=1') as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers['Content-Type'], mime)
                    self.assertTrue(response.headers['Content-Disposition'].startswith('inline;'))
                    self.assertIn("filename*=UTF-8''%E6%96%87%E4%BB%B6%20name.media", response.headers['Content-Disposition'])
                    self.assert_attachment_headers(response, len(content))
                    self.assertEqual(response.read(), content)
                with self.request(path) as response:
                    self.assertTrue(response.headers['Content-Disposition'].startswith('attachment;'))
                with self.request(path + '?preview=1', headers={'Range': 'bytes=8-11'}) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.headers['Content-Type'], mime)
                    self.assertEqual(response.headers['Content-Range'], f'bytes 8-11/{len(content)}')
                    self.assertTrue(response.headers['Content-Disposition'].startswith('inline;'))
                    self.assertEqual(response.read(), content[8:12])

    def test_active_unknown_and_spoofed_media_remain_downloads_even_with_range(self):
        active = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'
        fixtures = [
            ('text/html', b'<script>alert(1)</script>'),
            ('image/svg+xml', active),
            ('application/pdf', b'%PDF-1.7'),
            ('image/png', active),
            ('image/jpeg', active),
            ('image/gif', active),
            ('image/webp', b'RIFF\x10\x00\x00\x00WAVEfmt '),
            ('video/mp4', active),
            ('video/mp4', b'\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avifmif1'),
            ('video/webm', b'\x1a\x45\xdf\xa3\x8b\x42\x82\x88matroska'),
            ('video/webm', b'\x1a\x45\xdf\xa3<script>webm</script>'),
            ('audio/mpeg', b'ID3<script>alert(1)</script>'),
            ('audio/ogg', b'OggS<script>alert(1)</script>'),
            ('audio/wav', b'RIFF\x10\x00\x00\x00WEBPVP8 '),
            ('audio/flac', b'fLaC\x00\x00\x00\x22'),
        ]
        for mime, content in fixtures:
            with self.subTest(mime=mime, prefix=content[:16]):
                attachment = self.attachment(content, mime)
                path = '/api/attachments/' + attachment['id'] + '?preview=1'
                for headers, expected in [({}, content), ({'Range': 'bytes=0-3'}, content[:4])]:
                    with self.request(path, headers=headers) as response:
                        self.assertEqual(response.status, 206 if headers else 200)
                        self.assertEqual(response.headers['Content-Type'], 'application/octet-stream')
                        self.assertTrue(response.headers['Content-Disposition'].startswith('attachment;'))
                        self.assert_attachment_headers(response, len(expected))
                        self.assertEqual(response.read(), expected)

    def test_single_byte_ranges_return_exact_plaintext_boundaries(self):
        attachment = self.attachment(b'0123456789', 'application/octet-stream')
        path = '/api/attachments/' + attachment['id']
        for header, expected, content_range in [
            ('bytes=0-3', b'0123', 'bytes 0-3/10'),
            ('bytes=4-', b'456789', 'bytes 4-9/10'),
            ('bytes=-3', b'789', 'bytes 7-9/10'),
            ('bytes=-100', b'0123456789', 'bytes 0-9/10'),
            ('bytes=8-100', b'89', 'bytes 8-9/10'),
            ('bytes=9-9', b'9', 'bytes 9-9/10'),
            ('BYTES=0-3', b'0123', 'bytes 0-3/10'),
            ('bytes=-' + '9' * 5000, b'0123456789', 'bytes 0-9/10'),
            ('bytes=00000000000000000000000002-3', b'23', 'bytes 2-3/10'),
        ]:
            with self.subTest(header=header[:80]), self.request(path, headers={'Range': header}) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers['Content-Range'], content_range)
                self.assert_attachment_headers(response, len(expected))
                self.assertEqual(response.read(), expected)

    def test_unsatisfiable_malformed_and_multiple_ranges_return_416_without_bytes(self):
        attachment = self.attachment(b'0123456789', 'audio/mpeg')
        path = '/api/attachments/' + attachment['id'] + '?preview=1'
        for header in ['bytes=10-', 'bytes=20-30', 'bytes=4-2', 'bytes=-0',
                       'bytes=0-1,4-5', 'bytes=', 'bytes=-', 'bytes=zero-3',
                       'bytes=0-3junk', 'bytes=1 - 3', 'bytes=+1-3',
                       'bytes=' + '9' * 5000 + '-']:
            with self.subTest(header=header[:80]), self.request(path, headers={'Range': header}) as response:
                self.assertEqual(response.status, 416)
                self.assertEqual(response.headers['Content-Range'], 'bytes */10')
                self.assert_attachment_headers(response, 0)
                self.assertEqual(response.read(), b'')
                self.assertTrue(response.headers['Content-Disposition'].startswith('attachment;'))
        empty = self.attachment(b'', 'audio/wav')
        with self.request('/api/attachments/' + empty['id'], headers={'Range': 'bytes=0-'}) as response:
            self.assertEqual(response.status, 416)
            self.assertEqual(response.headers['Content-Range'], 'bytes */0')
            self.assert_attachment_headers(response, 0)
            self.assertEqual(response.read(), b'')

    def test_unknown_range_unit_or_unverifiable_if_range_returns_full_attachment(self):
        attachment = self.attachment(b'0123456789', 'application/octet-stream')
        for headers in [{'Range': 'items=0-3'}, {'Range': 'bytes=0-3', 'If-Range': '"stale-validator"'},
                        {'Range': 'bytes=0-3', 'If-Range': 'Wed, 21 Oct 2015 07:28:00 GMT'}]:
            with self.subTest(headers=headers), self.request('/api/attachments/' + attachment['id'], headers=headers) as response:
                self.assertEqual(response.status, 200)
                self.assertIsNone(response.headers['Content-Range'])
                self.assert_attachment_headers(response, 10)
                self.assertEqual(response.read(), b'0123456789')

    def test_duplicate_range_fields_cannot_bypass_single_range_limit(self):
        import http.client
        attachment = self.attachment(b'0123456789', 'application/octet-stream')
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        self.addCleanup(connection.close)
        connection.putrequest('GET', '/api/attachments/' + attachment['id'])
        connection.putheader('Range', 'bytes=0-1')
        connection.putheader('Range', 'bytes=4-5')
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 416)
        self.assertEqual(response.getheader('Content-Range'), 'bytes */10')
        self.assertEqual(response.read(), b'')

    def test_range_uses_verified_r2_plaintext_and_fails_closed_for_corrupt_copies(self):
        import hashlib
        from pathlib import Path
        from r2_media import R2Mirror
        from storage_crypto import MAGIC
        from store import Store
        from test_r2_media import MemoryS3
        root = Path(self.temp.name)
        key = root / 'isolated.key'
        key.write_bytes(bytes(range(32)))
        client = MemoryS3()
        self.server.store = Store(root / 'encrypted', key, media_mirror=R2Mirror(client, 'private-test'))
        content = b'RIFF\x24\x00\x00\x00WAVEfmt ' + b'\x00' * 28
        attachment = self.attachment(content, 'audio/wav')
        digest = hashlib.sha256(content).hexdigest()
        object_key = ('private-test', 'v1/owner/' + digest)
        ciphertext = client.objects[object_key][0]
        self.assertTrue(ciphertext.startswith(MAGIC))
        path = '/api/attachments/' + attachment['id'] + '?preview=1'
        local = self.server.store.files / digest
        local.unlink()
        with self.request(path, headers={'Range': 'bytes=0-3'}) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers['Content-Type'], 'audio/wav')
            self.assertEqual(response.headers['Content-Range'], 'bytes 0-3/44')
            self.assertEqual(response.read(), b'RIFF')
        # Even a correctly hashed encrypted object must fail GCM verification after tampering.
        corrupt = ciphertext[:-1] + bytes([ciphertext[-1] ^ 1])
        client.objects[object_key] = (corrupt, {'ciphertext-sha256': hashlib.sha256(corrupt).hexdigest()}, 'application/octet-stream')
        with self.assertLogs('store', level='WARNING'), self.request(path, headers={'Range': 'bytes=invalid'}) as response:
            self.assertNotIn(response.status, (200, 206, 416))
            self.assertIsNone(response.headers['Content-Range'])
            self.assertNotIn(b'RIFF', response.read())

    def test_notebook_update_roundtrip_and_module_content_types(self):
        for path in ['/notebook.js', '/notebook-core.mjs', '/notebook-export.mjs', '/library.mjs', '/vendor/katex.mjs']:
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
