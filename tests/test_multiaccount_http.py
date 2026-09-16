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
