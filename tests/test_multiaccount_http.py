import json
import os
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from auth import Auth
from server import make_server
from store import Store
from unittest.mock import patch
from r2_media import R2Credentials
from test_r2_media import MemoryS3

class MultiAccountHttpTests(unittest.TestCase):
    def test_storage_attachment_backup_and_mutation_are_account_scoped(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); key=root/'storage.key'; key.write_bytes(os.urandom(32))
            db=root/'auth.db'; Auth.initialize(db,'admin','owner-password-123')
            server=make_server(root/'data',0,auth_db=db,encryption_key_file=key,cookie_secure=False)
            p=server.store.create_project({'name':'owner-private'})
            r=server.store.create_record({'project_id':p['id'],'title':'owner-secret'})
            attachment=server.store.add_attachment(r['id'],'private.txt',b'owner-private-file','text/plain')
            before=server.store.state()
            thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
            base='http://127.0.0.1:'+str(server.server_port)
            def request(path, user=None, data=None, method=None, expected=None):
                headers={'Content-Type':'application/json','X-Process-Log':'1'}
                if user: headers.update({'Cookie':user['cookie'],'X-Process-Log-Account':expected or user['key']})
                raw=data if isinstance(data,bytes) else json.dumps(data).encode() if data is not None else None
                req=urllib.request.Request(base+path,data=raw,headers=headers,method=method)
                try: return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=10)
                except urllib.error.HTTPError as e: return e
            def login(name,password):
                with request('/api/auth/login',data={'username':name,'password':password}) as response:
                    self.assertEqual(response.status,200)
                    cookie=response.headers['Set-Cookie'].split(';')[0]
                temp={'cookie':cookie,'key':'owner'}
                with request('/api/auth/status',temp) as response: principal=json.load(response)['user']
                return {'cookie':cookie,'key':principal['storage_id']}
            try:
                owner=login('admin','owner-password-123')
                with request('/api/auth/users',owner,{'username':'alice','password':'alice-password-123'}) as response:
                    self.assertEqual(response.status,200); alice_id=json.load(response)['id']
                alice=login('alice','alice-password-123')
                with request('/api/state',alice) as response: self.assertEqual(json.load(response)['records'],[])
                with request('/api/auth/users',alice) as response: self.assertEqual(response.status,403)
                for path in ['/api/records/'+r['id']+'/markdown','/api/attachments/'+attachment['id']]:
                    with request(path,alice) as response: self.assertEqual(response.status,404)
                with request('/api/records/'+r['id'],alice,{'version':1,'title':'attack'},'PUT') as response: self.assertEqual(response.status,404)
                with request('/api/projects',alice,{'name':'alice-project'}) as response: alice_project=json.load(response)
                with request('/api/records',alice,{'project_id':alice_project['id'],'title':'alice-secret','related_id':r['id']}) as response: self.assertEqual(response.status,400)
                with request('/api/records',alice,{'project_id':alice_project['id'],'title':'alice-secret'}) as response: self.assertEqual(response.status,200)
                with request('/api/projects',alice,{'name':'stale-tab'},expected='owner') as response: self.assertEqual(response.status,401)
                with request('/api/auth/logout',alice,{},expected='owner') as response: self.assertEqual(response.status,401)
                with request('/api/backup',alice) as response: backup=response.read()
                copy=Store(root/'copy',encryption_key_file=key); copy.restore(backup)
                self.assertEqual([v['title'] for v in copy.state()['records']],['alice-secret'])
                with request('/api/restore',alice,backup) as response: self.assertEqual(response.status,200)
                self.assertEqual(server.store.state(),before)
                with request('/api/auth/users/'+str(alice_id),owner,{'enabled':False},'PUT') as response: self.assertEqual(response.status,200)
                with request('/api/state',alice) as response: self.assertEqual(response.status,401)
                with request('/api/state',owner) as response: self.assertEqual(json.load(response),before)
            finally:
                server.shutdown(); server.server_close(); thread.join()


class R2MultiAccountHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        key = self.root / 'storage.key'
        key.write_bytes(bytes(range(32)))
        db = self.root / 'auth.db'
        Auth.initialize(db, 'admin', 'owner-password-123')
        self.client = MemoryS3()
        env = {'PROCESS_LOG_R2_ACCOUNT_ID': 'a' * 32,
               'PROCESS_LOG_R2_BUCKET': 'test-private',
               'PROCESS_LOG_R2_CREDENTIALS_FILE': 'test-credentials'}
        with patch.dict(os.environ, env), patch('r2_media.R2Credentials.load', return_value=R2Credentials('fake-access', 'fake-secret')), patch('r2_media.create_r2_client', return_value=self.client):
            self.server = make_server(self.root / 'data', 0, auth_db=db,
                                      encryption_key_file=key, cookie_secure=False)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        auth = self.server.auth
        self.owner = auth.login('admin', 'owner-password-123', '127.0.0.1')
        self.alice_id = auth.create_user(self.owner, 'alice', 'alice-password-123')['id']
        self.alice = auth.login('alice', 'alice-password-123', '127.0.0.1')
        self.alice_key = auth.principal(self.alice)['storage_id']

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, token=None, data=None, method=None, claimed_account=None):
        headers = {'Content-Type': 'application/json', 'X-Process-Log': '1'}
        if token:
            headers['Cookie'] = 'process_log_session=' + token
            headers['X-Process-Log-Account'] = claimed_account or ('owner' if token == self.owner else self.alice_key)
        if isinstance(data, bytes):
            raw = data
            headers['Content-Type'] = 'text/plain'
            headers['X-Filename'] = 'file.txt'
        else:
            raw = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request('http://127.0.0.1:' + str(self.server.server_port) + path,
                                     data=raw, headers=headers, method=method)
        try:
            response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read()

    def record(self, token):
        status, raw = self.request('/api/projects', token, {'name': 'private'})
        self.assertEqual(status, 200)
        status, raw = self.request('/api/records', token, {'project_id': json.loads(raw)['id'], 'title': 'private'})
        self.assertEqual(status, 200)
        return json.loads(raw)

    def test_authenticated_partition_controls_upload_read_and_fallback(self):
        content = b'identical content in two accounts'
        records = [self.record(token) for token in (self.owner, self.alice)]
        attachments = []
        for token, record in zip((self.owner, self.alice), records):
            status, raw = self.request('/api/records/' + record['id'] + '/attachments', token, content)
            self.assertEqual(status, 200)
            attachments.append(json.loads(raw))
        digest = attachments[0]['file']
        self.assertEqual(set(self.client.objects), {
            ('test-private', 'v1/owner/' + digest),
            ('test-private', 'v1/' + self.alice_key + '/' + digest)})
        before = list(self.client.calls)
        for token, foreign in ((self.alice, attachments[0]), (self.owner, attachments[1])):
            self.assertEqual(self.request('/api/attachments/' + foreign['id'], token)[0], 404)
            self.assertEqual(self.request('/api/attachments/' + digest, token)[0], 404)
        self.assertEqual(self.request('/api/attachments/' + attachments[0]['id'])[0], 401)
        self.assertEqual(self.client.calls, before)
        self.assertEqual(self.request('/api/records/' + records[0]['id'] + '/attachments', self.alice, b'attack')[0], 404)
        self.client.objects.pop(('test-private', 'v1/' + self.alice_key + '/' + digest))
        with self.assertLogs('store', level='WARNING'):
            self.assertEqual(self.request('/api/attachments/' + attachments[1]['id'], self.alice, claimed_account='owner'), (200, content))
        alice_store = self.server.account_stores.stores[self.alice_key]
        (alice_store.files / digest).unlink()
        with self.assertLogs('store', level='WARNING'):
            status, raw = self.request('/api/attachments/' + attachments[1]['id'], self.alice)
        self.assertNotEqual(status, 200)
        self.assertNotIn(content, raw)
        self.assertNotIn(digest.encode(), raw)
        self.assertEqual(self.request('/api/attachments/' + attachments[0]['id'], self.owner), (200, content))

    def test_failed_remote_upload_is_not_http_success_or_visible_record(self):
        record = self.record(self.owner)
        self.client.fail = 'put'
        status, raw = self.request('/api/records/' + record['id'] + '/attachments', self.owner, b'private')
        self.assertNotEqual(status, 200)
        self.assertNotIn(b'fake-secret', raw)
        self.assertNotIn(b'fake-access', raw)
        self.assertEqual(self.server.store.get_record(record['id'])['attachments'], [])
        self.client.fail = None
        results = [self.request('/api/records/' + record['id'] + '/attachments', self.owner, b'private') for _ in range(2)]
        self.assertEqual(results[0][0], 200)
        self.assertEqual(results[0], results[1])

    def test_disabled_uninitialized_account_never_creates_store_or_r2_objects(self):
        self.server.auth.update_user(self.owner, self.alice_id, {'enabled': False})
        self.assertEqual(self.request('/api/state', self.alice)[0], 401)
        self.assertEqual(self.request('/api/attachments/' + 'a' * 32, self.alice)[0], 401)
        self.assertEqual(set(self.server.account_stores.stores), {'owner'})
        self.assertFalse((self.root / 'data' / 'accounts' / self.alice_key).exists())
        self.assertEqual(self.client.calls, [])
