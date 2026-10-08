import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from auth import Auth
from server import make_server

class AuthHttpTests(unittest.TestCase):
    def test_attachment_auth_and_account_scope_precede_range_handling(self):
        with tempfile.TemporaryDirectory() as root:
            auth_db = Path(root) / 'auth.db'
            Auth.initialize(auth_db, 'admin', 'test-password-12345')
            server = make_server(Path(root) / 'data', 0, auth_db=auth_db, cookie_secure=False)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_port)
            auth = server.auth
            owner = auth.login('admin', 'test-password-12345', '127.0.0.1')
            alice_id = auth.create_user(owner, 'alice', 'alice-password-12345')['id']
            alice = auth.login('alice', 'alice-password-12345', '127.0.0.1')
            project = server.store.create_project({'name': 'private'})
            record = server.store.create_record({'project_id': project['id'], 'title': 'private'})
            content = b'RIFF\x24\x00\x00\x00WAVEfmt ' + b'\x00' * 28
            attachment = server.store.add_attachment(record['id'], 'private.wav', content, 'audio/wav')
            path = '/api/attachments/' + attachment['id'] + '?preview=1'
            def request(token=None, byte_range=None):
                headers = {}
                if token: headers['Cookie'] = 'process_log_session=' + token
                if byte_range is not None: headers['Range'] = byte_range
                req = urllib.request.Request(base + path, headers=headers)
                try: return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10)
                except urllib.error.HTTPError as error: return error
            try:
                # A direct media request deliberately needs no account header: the session is authority.
                with request(owner, 'bytes=0-3') as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.read(), b'RIFF')
                    self.assertEqual(response.headers['Content-Type'], 'audio/wav')
                for token, expected in [(None, 401), (alice, 404)]:
                    with request(token) as response:
                        self.assertEqual(response.status, expected)
                        baseline = response.read()
                    for byte_range in ['bytes=0-3', 'bytes=-3', 'bytes=9999-', 'bytes=0-1,4-5', 'bytes=invalid']:
                        with self.subTest(account='anonymous' if token is None else 'foreign', byte_range=byte_range), request(token, byte_range) as response:
                            self.assertEqual(response.status, expected)
                            self.assertEqual(response.read(), baseline)
                            self.assertIsNone(response.headers['Content-Range'])
                            self.assertIsNone(response.headers['Accept-Ranges'])
                            self.assertEqual(response.headers['Cache-Control'], 'no-store')
                auth.update_user(owner, alice_id, {'enabled': False})
                with request(alice, 'bytes=invalid') as response:
                    self.assertEqual(response.status, 401)
                    self.assertNotIn(b'RIFF', response.read())
            finally:
                server.shutdown(); server.server_close(); thread.join()

    def test_every_private_endpoint_requires_session(self):
        with tempfile.TemporaryDirectory() as root:
            auth_db = Path(root) / 'auth.db'
            Auth.initialize(auth_db, 'admin', 'test-password-12345')
            server = make_server(Path(root)/'data', 0, auth_db=auth_db, cookie_secure=False)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            base = 'http://127.0.0.1:'+str(server.server_port)
            def request(path, data=None, cookie=None, origin=None, legacy=False):
                headers={'Content-Type':'application/json', 'Origin': origin or base}
                if cookie:
                    headers['Cookie']=cookie
                    if not legacy: headers['X-Process-Log-Account']='owner'
                req=urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
                try: return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10)
                except urllib.error.HTTPError as e: return e
            try:
                for path in ['/api/state','/api/backup','/api/attachments/abc','/api/records/abc/markdown']:
                    with request(path) as response: self.assertEqual(response.status,401,path)
                with request('/api/projects', {'name':'unauthorized'}) as response: self.assertEqual(response.status,401)
                with request('/') as response: self.assertIn('登录'.encode(), response.read())
                with request('/api/auth/login', {'username':'admin','password':'test-password-12345'}, origin='https://evil.example') as response: self.assertEqual(response.status,403)
                with request('/api/auth/login', {'username':'admin','password':'test-password-12345'}) as response:
                    self.assertEqual(response.status,200)
                    header=response.headers['Set-Cookie']
                    self.assertIn('HttpOnly',header); self.assertIn('SameSite=Strict',header); self.assertIn('Max-Age=604800',header)
                    cookie=header.split(';')[0]
                # An already-open pre-multiaccount page must not enter a login loop.
                with request('/api/auth/status', cookie=cookie, legacy=True) as response:
                    self.assertTrue(json.load(response)['authenticated'])
                for legacy_path, payload in [('/api/state', None), ('/api/projects', {'name':'legacy-write'}), ('/api/auth/logout', {})]:
                    with request(legacy_path, payload, cookie=cookie, legacy=True) as response:
                        self.assertEqual(response.status,409)
                        self.assertEqual(json.load(response)['code'],'page_refresh_required')
                with request('/api/state', cookie=cookie) as response:
                    self.assertEqual(response.status,200)
                    self.assertEqual(json.load(response)['projects'],[])

                with request('/api/auth/logout', {}, cookie=cookie) as response: self.assertIn('Max-Age=0', response.headers['Set-Cookie'])
                with request('/api/state', cookie=cookie) as response: self.assertEqual(response.status,401)
                with request('/api/health') as response: self.assertEqual(response.status,200)
            finally:
                server.shutdown(); server.server_close(); thread.join()

    def test_only_explicit_proxy_can_supply_client_address(self):
        from server import Handler
        from types import SimpleNamespace
        handler = object.__new__(Handler)
        handler.client_address = ('127.0.0.1', 1234)
        handler.headers = {'X-Forwarded-For':'198.51.100.4, 192.0.2.3'}
        handler.server = SimpleNamespace(trusted_proxies=set())
        self.assertEqual(handler.auth_peer(), '127.0.0.1')
        handler.server.trusted_proxies = {'127.0.0.1'}
        self.assertEqual(handler.auth_peer(), '192.0.2.3')
        handler.server.trusted_proxies.add('192.0.2.3')
        self.assertEqual(handler.auth_peer(), '198.51.100.4')
        handler.headers = {'X-Forwarded-For':'invalid'}
        self.assertEqual(handler.auth_peer(), '127.0.0.1')
