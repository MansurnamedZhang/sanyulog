"""Real databases/envelopes; only the external S3 service is replaced."""
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from contextlib import closing, redirect_stdout
from unittest.mock import patch

from auth import USER_SCHEMA
from r2_media import R2Mirror
from storage_crypto import MAGIC
from store import Store
from test_r2_media import MemoryS3
from r2_reconcile import build_inventory, sync_inventory, prune_unreferenced, main


class ListingS3(MemoryS3):
    def list_objects_v2(self, *, Bucket, Prefix, ContinuationToken=None):
        self.check('list')
        keys = sorted(key for bucket, key in self.objects if bucket == Bucket and key.startswith(Prefix))
        start = int(ContinuationToken or '0')
        result = {'Contents': [{'Key': key} for key in keys[start:start+1]],
                  'IsTruncated': start + 1 < len(keys)}
        if result['IsTruncated']:
            result['NextContinuationToken'] = str(start + 1)
        return result


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.key = self.root / 'key'
        self.key.write_bytes(bytes(range(32)))
        self.auth = self.root / 'auth.db'
        self.disabled = '1' * 32
        self.absent = '2' * 32
        with closing(sqlite3.connect(self.auth)) as c, c:
            c.execute(USER_SCHEMA)
            for index, account in enumerate(('owner', self.disabled, self.absent), 1):
                c.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?)',
                          (index, 'PRIVATE-user-'+str(index), b'salt', b'password', index == 1, index == 1, account))
        self.s = Store(self.root / 'data', self.key)
        self.other = Store(self.s.root / 'accounts' / self.disabled, self.key, storage_id=self.disabled)
        self.client = ListingS3()
        self.mirror = R2Mirror(self.client, 'sanyulog-media')

    def add(self, store=None, content=b'PRIVATE-attachment'):
        store = store or self.s
        project = store.create_project({'name': 'PRIVATE-project'})
        record = store.create_record({'project_id': project['id'], 'title': 'PRIVATE-note'})
        attachment = store.add_attachment(record['id'], 'PRIVATE-name.txt', content, 'text/plain')
        return project, record, attachment

    def inventory(self):
        return build_inventory(self.auth, None, self.s.files, self.key)

    def selected(self):
        return self.inventory().for_account('owner')

    def test_inventory_includes_disabled_and_never_initializes_absent_account(self):
        self.add()
        self.add(self.other)
        before = {p.relative_to(self.root) for p in self.root.rglob('*')}
        items = self.inventory()
        self.assertEqual({i.storage_id for i in items}, {'owner', self.disabled})
        self.assertEqual(len(items.accounts), 3)
        self.assertFalse((self.s.root / 'accounts' / self.absent).exists())
        self.assertEqual(before, {p.relative_to(self.root) for p in self.root.rglob('*')})
        self.assertNotIn('PRIVATE', json.dumps(items.manifest()))
        self.assertNotIn(str(self.root), json.dumps(items.manifest()))

    def test_orphan_is_not_a_sync_source_and_corruption_is_unsynced(self):
        _, _, a = self.add()
        orphan = hashlib.sha256(b'orphan').hexdigest()
        (self.s.files / orphan).write_bytes(self.s.cipher.encrypt(b'orphan', 'attachment:'+orphan))
        (self.s.files / a['file']).write_bytes(b'corrupt')
        items = self.selected()
        self.assertEqual([i.digest for i in items], [a['file']])
        report = sync_inventory(items, self.mirror, apply=True)
        self.assertFalse(report.complete)
        self.assertEqual(report.entries[0]['status'], 'local_invalid')
        self.assertFalse(self.client.objects)

    def test_invalid_reference_path_fails_closed_without_leaking_value(self):
        self.add()
        with closing(sqlite3.connect(self.s.db)) as c, c:
            c.execute("UPDATE attachments SET file='../PRIVATE-name'")
        with self.assertRaises(ValueError) as caught:
            self.inventory()
        self.assertNotIn('PRIVATE', str(caught.exception))

    @unittest.skipUnless(os.name == 'posix', 'requires POSIX symlink support')
    def test_symlinked_media_or_root_is_rejected_without_reading_target(self):
        _, _, a = self.add()
        path = self.s.files / a['file']
        target = self.root / 'outside'
        path.rename(target)
        path.symlink_to(target)
        self.assertEqual(self.selected()[0].status, 'local_invalid')
        link = self.root / 'linked'
        link.symlink_to(self.s.files, target_is_directory=True)
        with self.assertRaises(ValueError):
            build_inventory(self.auth, None, link, self.key)

    def test_missing_local_file_blocks_cloud_completion_even_if_r2_is_valid(self):
        _, _, a = self.add()
        sync_inventory(self.selected(), self.mirror, apply=True)
        (self.s.files / a['file']).unlink()
        report = sync_inventory(self.selected(), self.mirror)
        self.assertFalse(report.complete)
        self.assertEqual(report.entries[0]['status'], 'local_invalid')

    def test_dry_run_retry_and_restore_reconcile_do_not_overwrite_existing_nonce(self):
        _, _, a = self.add()
        snapshot = self.s.backup()
        pending = sync_inventory(self.selected(), self.mirror)
        self.assertFalse(pending.complete)
        self.assertEqual(pending.entries[0]['status'], 'pending_sync')
        self.assertFalse(self.client.objects)
        self.client.fail = 'get'  # Upload committed, read-back interrupted.
        self.assertFalse(sync_inventory(self.selected(), self.mirror, apply=True).complete)
        stored = dict(self.client.objects)
        self.client.fail = None
        self.s.restore(snapshot)
        self.assertNotEqual((self.s.files / a['file']).read_bytes(), next(iter(stored.values()))[0])
        self.assertTrue(sync_inventory(self.selected(), self.mirror).complete)
        self.assertTrue(sync_inventory(self.selected(), self.mirror, apply=True).complete)
        self.assertEqual(stored, self.client.objects)
        self.client.objects.clear()
        self.assertFalse(sync_inventory(self.selected(), self.mirror).complete)
        self.assertTrue(sync_inventory(self.selected(), self.mirror, apply=True).complete)

    def test_conflicting_remote_plaintext_is_never_overwritten(self):
        _, _, a = self.add()
        key = ('sanyulog-media', 'v1/owner/'+a['file'])
        blob = self.s.cipher.encrypt(b'wrong', 'attachment:'+a['file'])
        self.client.objects[key] = (blob, {'ciphertext-sha256': hashlib.sha256(blob).hexdigest()}, 'application/octet-stream')
        self.assertFalse(sync_inventory(self.selected(), self.mirror, apply=True).complete)
        self.assertEqual(self.client.objects[key][0], blob)

    def test_legacy_oversize_stays_local_and_is_never_cloud_complete(self):
        _, _, a = self.add()
        content = b'x' * (25 * 1024 * 1024 + 1)
        digest = hashlib.sha256(content).hexdigest()
        with closing(sqlite3.connect(self.s.db)) as c, c:
            c.execute('UPDATE attachments SET file=?,size=? WHERE id=?', (digest, len(content), a['id']))
        path = self.s.files / digest
        path.write_bytes(self.s.cipher.encrypt(content, 'attachment:'+digest))
        report = sync_inventory(self.selected(), self.mirror, apply=True)
        self.assertFalse(report.complete)
        self.assertEqual(report.entries[0]['status'], 'oversize')
        self.assertTrue(path.exists())
        self.assertFalse(self.client.objects)

    def test_plaintext_local_is_not_uploaded_or_silently_migrated_by_inventory(self):
        _, _, a = self.add()
        path = self.s.files / a['file']
        path.write_bytes(b'PRIVATE-attachment')
        self.assertFalse(sync_inventory(self.selected(), self.mirror, apply=True).complete)
        self.assertEqual(path.read_bytes(), b'PRIVATE-attachment')
        self.assertFalse(self.client.objects)

    def test_delete_shared_hash_and_project_cascade_remain_pending_until_scoped_gc(self):
        p, _, a = self.add()
        p2, _, b = self.add()
        _, _, other = self.add(self.other)
        sync_inventory(self.selected(), self.mirror, apply=True)
        sync_inventory(self.inventory().for_account(self.disabled), self.mirror, apply=True)
        self.s.delete_attachment(a['id'])
        with self.assertRaises(KeyError): self.s.read_attachment(a['id'])
        self.assertEqual(prune_unreferenced(self.selected(), self.mirror).entries, [])
        self.s.delete_project(p2['id'])
        with self.assertRaises(KeyError): self.s.read_attachment(b['id'])
        self.assertEqual(prune_unreferenced(self.selected(), self.mirror).entries[0]['status'], 'pending_prune')
        self.client.fail = 'delete'
        self.assertFalse(prune_unreferenced(self.selected(), self.mirror, apply=True).complete)
        self.assertTrue((self.s.files / a['file']).exists())
        self.client.fail = None
        self.assertEqual(prune_unreferenced(self.selected(), self.mirror).entries[0]['status'], 'pending_prune')
        self.assertTrue(prune_unreferenced(self.selected(), self.mirror, apply=True).complete)
        self.assertFalse((self.s.files / a['file']).exists())
        self.assertEqual(self.other.read_attachment(other['id'])[1], b'PRIVATE-attachment')
        self.assertEqual(set(self.client.objects), {('sanyulog-media', 'v1/'+self.disabled+'/'+a['file'])})

    def test_stale_inventory_cannot_delete_new_reference(self):
        _, _, a = self.add()
        sync_inventory(self.selected(), self.mirror, apply=True)
        self.s.delete_attachment(a['id'])
        stale = self.selected()
        _, _, b = self.add()
        self.assertEqual(prune_unreferenced(stale, self.mirror, apply=True).entries, [])
        self.assertEqual(self.s.read_attachment(b['id'])[1], b'PRIVATE-attachment')

    def test_remote_only_orphans_paginate_and_do_not_touch_other_buckets_or_prefixes(self):
        for value in (b'one', b'two', b'three'):
            digest = hashlib.sha256(value).hexdigest()
            blob = self.s.cipher.encrypt(value, 'attachment:'+digest)
            self.mirror.put_ciphertext('owner', digest, blob, self.s.cipher)
            R2Mirror(self.client, 'other-bucket').put_ciphertext('owner', digest, blob, self.s.cipher)
        report = prune_unreferenced(self.selected(), self.mirror, apply=True)
        self.assertTrue(report.complete)
        self.assertEqual(len(report.entries), 3)
        self.assertEqual({bucket for bucket, _ in self.client.objects}, {'other-bucket'})

    def test_plain_lists_multiscope_apply_and_wrong_bucket_have_no_authority(self):
        self.add()
        for function in (sync_inventory, prune_unreferenced):
            for items, mirror in ((list(self.selected()), self.mirror), (self.inventory(), self.mirror),
                                  (self.selected(), R2Mirror(self.client, 'other-bucket'))):
                with self.subTest(function=function.__name__), self.assertRaises(ValueError):
                    function(items, mirror, apply=True)
        self.assertFalse(self.client.objects)

    def test_absent_account_never_gains_prune_authority(self):
        items = self.inventory().for_account(self.absent)
        self.assertFalse(prune_unreferenced(items, self.mirror, apply=True).complete)
        self.assertNotIn('list', self.client.calls)
        self.assertFalse((self.s.root / 'accounts' / self.absent).exists())

    def test_forged_listing_outside_prefix_aborts_before_any_delete(self):
        with patch.object(self.client, 'list_objects_v2', return_value={
                'Contents': [{'Key': 'v1/'+self.disabled+'/'+'a'*64}], 'IsTruncated': False}):
            report = prune_unreferenced(self.selected(), self.mirror, apply=True)
        self.assertFalse(report.complete)
        self.assertNotIn('delete', self.client.calls)

    def test_local_gc_failure_is_rediscovered_after_remote_delete(self):
        _, _, a = self.add()
        sync_inventory(self.selected(), self.mirror, apply=True)
        self.s.delete_record(self.s.get_record(self.s.state()['records'][0]['id'])['id'])
        real_unlink = Path.unlink
        def failing_unlink(path, *args, **kwargs):
            if path == self.s.files / a['file']:
                raise OSError('PRIVATE-secret-diagnostic')
            return real_unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', failing_unlink), self.assertLogs('r2_reconcile', level='INFO') as logs:
            report = prune_unreferenced(self.selected(), self.mirror, apply=True)
        self.assertFalse(report.complete)
        self.assertFalse(self.client.objects)
        self.assertNotIn('PRIVATE', ''.join(logs.output))
        self.assertEqual(prune_unreferenced(self.selected(), self.mirror).entries[0]['status'], 'pending_prune')
        self.assertTrue((self.s.files / a['file']).is_file())

    def test_apply_rereads_refs_after_writer_lock_acquisition(self):
        self.add()
        with patch('r2_reconcile.media_lock') as lock:
            lock.return_value.__enter__.side_effect = lambda: self.s.delete_project(self.s.state()['projects'][0]['id'])
            report = sync_inventory(self.selected(), self.mirror, apply=True)
        self.assertEqual(report.entries, [])
        self.assertFalse(self.client.objects)

    def test_cli_sync_and_prune_default_to_read_only_and_do_not_leak_sdk_errors(self):
        self.add()
        args = ['--auth-db', str(self.auth), '--attachments-root', str(self.s.files), '--key-file', str(self.key),
                '--storage-id', 'owner']
        with patch('r2_reconcile.R2Credentials.load'), patch('r2_reconcile.create_r2_client', return_value=self.client), \
                patch.dict(os.environ, {'PROCESS_LOG_R2_CREDENTIALS_FILE': 'fake', 'PROCESS_LOG_R2_ACCOUNT_ID': 'fake'}):
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(['sync']+args), 2)
            self.assertFalse(json.loads(output.getvalue())['apply'])
            self.assertFalse(self.client.objects)
            self.client.fail = 'list'
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(['prune']+args), 2)
            self.assertNotIn('fake-secret', output.getvalue())
            self.assertNotIn('PRIVATE', output.getvalue())

    def test_inventory_command_nonzero_when_referenced_media_is_invalid(self):
        _, _, a = self.add()
        (self.s.files / a['file']).write_bytes(b'corrupt')
        with redirect_stdout(io.StringIO()) as output:
            code = main(['inventory', '--auth-db', str(self.auth), '--attachments-root', str(self.s.files), '--key-file', str(self.key)])
        self.assertEqual(code, 2)
        self.assertFalse(json.loads(output.getvalue())['complete'])

    def test_cli_defaults_to_inventory_dry_run_and_requires_explicit_apply_scope(self):
        self.add()
        cmd = [sys.executable, 'r2_reconcile.py', 'inventory', '--auth-db', str(self.auth),
               '--attachments-root', str(self.s.files), '--key-file', str(self.key)]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('PRIVATE', result.stdout)
        self.assertFalse(json.loads(result.stdout)['apply'])
        for extras in (['--apply'], ['--apply', '--storage-id', 'owner']):
            result = subprocess.run(cmd[:2]+['sync']+cmd[3:]+extras, capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)


@unittest.skipUnless(os.environ.get('PROCESS_LOG_TEST_DATABASE_URL'), 'requires isolated PostgreSQL test database')
class PostgreSQLInventoryTests(unittest.TestCase):
    add = ReconcileTests.add
    selected = ReconcileTests.selected
    test_restore_reconcile = ReconcileTests.test_dry_run_retry_and_restore_reconcile_do_not_overwrite_existing_nonce
    test_delete_cascade_gc = ReconcileTests.test_delete_shared_hash_and_project_cascade_remain_pending_until_scoped_gc
    test_stale_inventory = ReconcileTests.test_stale_inventory_cannot_delete_new_reference
    test_absent_account = ReconcileTests.test_absent_account_never_gains_prune_authority

    def setUp(self):
        ReconcileTests.setUp(self)
        import psycopg
        from pgstore import PostgreSQLStore
        self.dsn = os.environ['PROCESS_LOG_TEST_DATABASE_URL']
        # The explicitly configured disposable CI database is the only owner
        # public schema touched by these tests. Clear references before startup
        # encryption, not after it, and leave no key-dependent rows behind.
        with psycopg.connect(self.dsn) as c:
            for table in ('projects', 'settings'):
                if c.execute('SELECT to_regclass(%s)', ('public.'+table,)).fetchone()[0]:
                    c.execute('DELETE FROM public.'+table)
        old_disabled, old_absent = self.disabled, self.absent
        self.disabled, self.absent = uuid.uuid4().hex, uuid.uuid4().hex
        with closing(sqlite3.connect(self.auth)) as c, c:
            c.execute('UPDATE users SET storage_id=? WHERE storage_id=?', (self.disabled, old_disabled))
            c.execute('UPDATE users SET storage_id=? WHERE storage_id=?', (self.absent, old_absent))
        self.s = PostgreSQLStore(self.root / 'pg-state', self.dsn, self.root / 'pg-files', self.key)
        self.addCleanup(self.clear_owner)
        with self.s.connection() as c:
            c.execute('DELETE FROM projects')
        self.other = PostgreSQLStore(self.root / 'pg-state' / 'accounts' / self.disabled, self.dsn,
                                     self.s.files / 'accounts' / self.disabled, self.key,
                                     namespace='process_log_user_'+self.disabled, storage_id=self.disabled)
        self.addCleanup(self.drop_secondary)
        with self.other.connection() as c:
            c.execute('DELETE FROM projects')

    def clear_owner(self):
        with self.s.connection() as c:
            c.execute('DELETE FROM projects')
            c.execute('DELETE FROM settings')

    def drop_secondary(self):
        import psycopg
        from psycopg import sql
        with psycopg.connect(self.dsn) as c:
            c.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier('process_log_user_'+self.disabled)))

    def inventory(self):
        return build_inventory(self.auth, self.dsn, self.s.files, self.key)

    def test_pg_inventory_includes_disabled_without_creating_missing_schema(self):
        import psycopg
        self.add()
        self.add(self.other)
        with psycopg.connect(self.dsn) as c:
            query = 'SELECT schema_name FROM information_schema.schemata WHERE schema_name=%s'
            self.assertIsNone(c.execute(query, ('process_log_user_'+self.absent,)).fetchone())
        items = self.inventory()
        self.assertEqual({i.storage_id for i in items}, {'owner', self.disabled})
        with psycopg.connect(self.dsn) as c:
            self.assertIsNone(c.execute(query, ('process_log_user_'+self.absent,)).fetchone())

    def test_wrong_key_rejected_even_for_empty_pg_account(self):
        wrong = self.root / 'wrong-key'
        wrong.write_bytes(b'x' * 32)
        with self.assertRaises(ValueError):
            build_inventory(self.auth, self.dsn, self.s.files, wrong)
