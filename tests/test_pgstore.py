import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from store import Store, Conflict

@unittest.skipUnless(os.environ.get('PROCESS_LOG_TEST_DATABASE_URL'), 'requires isolated PostgreSQL test database')
class PostgreSQLTests(unittest.TestCase):
    def setUp(self):
        try:
            from pgstore import PostgreSQLStore
        except ImportError:
            self.fail('PostgreSQL store is not implemented')
        self.factory = PostgreSQLStore
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dsn = os.environ['PROCESS_LOG_TEST_DATABASE_URL']
        self.s = PostgreSQLStore(self.root, self.dsn)
        with self.s.connection() as c:
            c.execute('DELETE FROM projects')
        self.p = self.s.create_project({'name': 'PG project'})
        self.r = self.s.create_record({'project_id': self.p['id'], 'title': 'Notebook'})

    def test_storage_restart_and_atomic_validation(self):
        cell = dict(id='a'*32, type='code', source='    print(42)\n', language='python', attachment_ids=[])
        saved = self.s.update_record(self.r['id'], {'version':1, 'cells':[cell]})
        other = self.factory(self.root, self.dsn)
        self.assertEqual(other.get_record(saved['id']), saved)
        with self.assertRaises(ValueError):
            other.update_record(saved['id'], {'version':2, 'title':'bad', 'cells':[cell,cell]})
        self.assertEqual(other.get_record(saved['id']), saved)
        self.assertFalse((self.root/'process.db').exists())

    def test_two_store_instances_reject_lost_update(self):
        other=self.factory(self.root,self.dsn)
        def update(store):
            try:
                store.update_record(self.r['id'], {'version':1,'title':'changed'})
                return 'saved'
            except Conflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(update,[self.s,other])), ['saved','conflict'])

    def test_sqlite_migration_portable_backup_and_attachments(self):
        local=Store(self.root/'local')
        p=local.create_project({'name':'original'})
        r=local.create_record({'project_id':p['id'],'title':'Migrated'})
        a=local.add_attachment(r['id'],'note.txt',b'original bytes','text/plain')
        local.add_entry(r['id'],{'body':'history'})
        copy=local.duplicate(r['id'])
        # Also exercise a relationship to a record inserted later.
        local.update_record(r['id'],{'version':2,'related_id':copy['id']})
        expected=local.state()
        self.s.restore(local.backup())
        self.assertEqual(self.s.state(),expected)
        self.assertEqual(self.s.read_attachment(a['id'])[1],b'original bytes')
        exported=self.s.backup()
        restored=Store(self.root/'restored')
        restored.restore(exported)
        self.assertEqual(restored.state(),expected)
        self.assertTrue(list((self.root/'backups').glob('before-restore-*.zip')))
        self.s.delete_project(p['id'])
        self.s.restore(exported)
        self.assertEqual(self.s.state(),expected)

    def test_invalid_restore_preserves_current_data(self):
        before=self.s.state()
        with self.assertRaises(ValueError):self.s.restore(b'not a zip')
        self.assertEqual(self.s.state(),before)

    def test_entries_templates_and_cascade(self):
        e=self.s.add_entry(self.r['id'],{'kind':'问题','body':'before'})
        self.s.update_entry(e['id'],{'body':'after'})
        self.assertIn('after',self.s.markdown(self.r['id']))
        self.s.save_templates([{'id':'custom','name':'custom','params':{},'goal':''}])
        self.assertEqual(self.s.state()['templates'][0]['id'],'custom')
        self.s.delete_entry(e['id'])
        self.assertEqual(self.s.get_record(self.r['id'])['cells'],[])
        self.s.delete_project(self.p['id'])
        self.assertEqual(self.s.state()['records'],[])

    def test_restore_never_truncates_existing_attachment(self):
        from unittest.mock import patch
        import shutil
        a = self.s.add_attachment(self.r['id'], 'keep.txt', b'precious original', 'text/plain')
        archive = self.s.backup()
        before = self.s.state()
        original_copy = shutil.copyfile
        def interrupted(src, dst, *args, **kwargs):
            if Path(dst).parent == self.s.files:
                Path(dst).write_bytes(b'truncated')
                raise OSError('simulated interrupted copy')
            return original_copy(src, dst, *args, **kwargs)
        with patch('pgstore.shutil.copyfile', side_effect=interrupted):
            try:
                self.s.restore(archive)
            except OSError:
                pass
        self.assertEqual(self.s.state(), before)
        self.assertEqual(self.s.read_attachment(a['id'])[1], b'precious original')

    def test_z_encryption_migration_and_backup(self):
        key = self.root / 'storage.key'
        key.write_bytes(os.urandom(32))
        before = self.s.state()
        encrypted = self.factory(self.root, self.dsn, encryption_key_file=key)
        try:
            self.assertEqual(encrypted.state(), before)
            with encrypted.connection() as c:
                with c.raw.cursor(row_factory=__import__('psycopg').rows.tuple_row) as raw:
                    raw.execute('SELECT title FROM records WHERE id=%s', (self.r['id'],))
                    self.assertTrue(raw.fetchone()[0].startswith('plenc:v1:'))
            a = encrypted.add_attachment(self.r['id'], 'private.txt', b'PRIVATE-PG-CONTENT', 'text/plain')
            expected = encrypted.state()
            backup = encrypted.backup()
            self.assertFalse(backup.startswith(b'PK'))
            local = Store(self.root / 'encrypted-copy', encryption_key_file=key)
            local.restore(backup)
            self.assertEqual(local.state(), expected)
            encrypted.restore(backup)
            self.assertEqual(encrypted.state(), expected)
            self.assertEqual(encrypted.read_attachment(a['id'])[1], b'PRIVATE-PG-CONTENT')
            with self.assertRaises(ValueError): self.factory(self.root, self.dsn)
        finally:
            # Only the explicitly configured isolated test database is used here.
            with encrypted.connection() as c:
                c.execute('DELETE FROM projects')
                c.execute('DELETE FROM settings')

    def test_account_schema_isolation_and_backup(self):
        import secrets
        from account_stores import AccountStores
        registry=AccountStores(self.s, self.root, self.dsn)
        storage_id=secrets.token_hex(16)
        secondary=registry.get({'storage_id':storage_id})
        try:
            self.assertEqual(secondary.state()['records'],[])
            p=secondary.create_project({'name':'secondary'})
            r=secondary.create_record({'project_id':p['id'],'title':'secondary-only'})
            a=secondary.add_attachment(r['id'],'secondary.txt',b'secondary-bytes','text/plain')
            with self.assertRaises(KeyError): secondary.get_record(self.r['id'])
            with self.assertRaises(KeyError): self.s.read_attachment(a['id'])
            expected=secondary.state()
            before=self.s.state()
            backup=secondary.backup()
            secondary.restore(backup)
            self.assertEqual(secondary.state(),expected)
            self.assertEqual(self.s.state(),before)
            restarted=self.factory(self.root/'accounts'/storage_id,self.dsn,namespace='process_log_user_'+storage_id)
            self.assertEqual(restarted.state(),expected)
        finally:
            with self.s.connection() as c:
                c.raw.execute('DROP SCHEMA "process_log_user_'+storage_id+'" CASCADE')
