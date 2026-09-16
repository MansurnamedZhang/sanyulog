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
    def test_every_private_endpoint_requires_session(self):
        with tempfile.TemporaryDirectory() as root:
            auth_db = Path(root) / 'auth.db'
            Auth.initialize(auth_db, 'admin', 'test-password-12345')
            server = make_server(Path(root)/'data', 0, auth_db=auth_db, cookie_secure=False)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            base = 'http://127.0.0.1:'+str(server.server_port)
            def request(path, data=None, cookie=None, origin=None):
                headers={'Content-Type':'application/json', 'Origin': origin or base}
                if cookie:
                    headers['Cookie']=cookie
                    headers['X-Process-Log-Account']='owner'
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
                with request('/api/state', cookie=cookie) as response: self.assertEqual(response.status,200)
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
