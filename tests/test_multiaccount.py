import tempfile
import unittest
from pathlib import Path
from auth import Auth

class MultiAccountTests(unittest.TestCase):
    def test_admin_creates_and_disables_account_without_affecting_owner(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'auth.db'
            Auth.initialize(path,'admin','owner-password-123')
            auth=Auth(path)
            owner=auth.login('admin','owner-password-123','test')
            user=auth.create_user(owner, 'alice', 'alice-password-123')
            alice=auth.login('alice','alice-password-123','test')
            self.assertEqual(auth.principal(alice)['id'], user['id'])
            self.assertFalse(auth.principal(alice)['is_admin'])
            with self.assertRaises(PermissionError): auth.create_user(alice,'bob','bob-password-123')
            auth.change_password(alice,'alice-password-123','alice-new-password-123','test')
            self.assertIsNone(auth.user(alice))
            self.assertEqual(auth.user(owner),'admin')
            alice=auth.login('alice','alice-new-password-123','test')
            auth.update_user(owner,user['id'],{'enabled':False})
            self.assertIsNone(auth.user(alice))
            self.assertIsNone(auth.login('alice','alice-new-password-123','test'))
            auth.update_user(owner,user['id'],{'enabled':True,'new_password':'alice-reset-password-123'})
            self.assertTrue(auth.login('alice','alice-reset-password-123','test'))
            with self.assertRaises(ValueError): auth.update_user(owner,1,{'enabled':False})

    def test_legacy_account_and_session_migrate(self):
        import sqlite3, hashlib, time
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'auth.db'
            c=sqlite3.connect(path)
            c.executescript('CREATE TABLE account(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt BLOB NOT NULL, password_hash BLOB NOT NULL);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,created REAL NOT NULL,expires REAL NOT NULL);CREATE TABLE attempts(peer TEXT NOT NULL,created REAL NOT NULL);')
            salt=b'x'*16; token='a'*43
            c.execute('INSERT INTO account VALUES (1,?,?,?)',('legacy',salt,Auth.password_hash('legacy-password-123',salt)))
            c.execute('INSERT INTO sessions VALUES (?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),time.time(),time.time()+86400));c.commit();c.close()
            auth=Auth(path)
            self.assertEqual(auth.principal(token),{'id':1,'username':'legacy','is_admin':True,'storage_id':'owner'})
            self.assertTrue(auth.login('legacy','legacy-password-123','test'))
            self.assertEqual(len(auth.list_users(token)),1)

    def test_success_on_another_account_cannot_clear_failed_login_limit(self):
        from auth import RateLimited
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'auth.db'; Auth.initialize(path,'admin','owner-password-123')
            auth=Auth(path); owner=auth.login('admin','owner-password-123','owner-peer')
            auth.create_user(owner,'alice','alice-password-123')
            for _ in range(9): self.assertIsNone(auth.login('admin','wrong','shared-peer'))
            self.assertTrue(auth.login('alice','alice-password-123','shared-peer'))
            self.assertIsNone(auth.login('admin','wrong','shared-peer'))
            with self.assertRaises(RateLimited): auth.login('admin','owner-password-123','shared-peer')
