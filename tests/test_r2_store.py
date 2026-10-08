"""Real encrypted stores with only the external S3 boundary replaced."""
import hashlib
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext

from r2_media import R2Mirror
from storage_crypto import MAGIC
from store import Store
from test_r2_media import MemoryS3


class R2StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.key = self.root / 'key'
        self.key.write_bytes(bytes(range(32)))
        self.client = MemoryS3()
        self.mirror = R2Mirror(self.client, 'test-private')
        self.s = Store(self.root / 'data', self.key, media_mirror=self.mirror)
        p = self.s.create_project({'name': 'private'})
        self.record = self.s.create_record({'project_id': p['id'], 'title': 'note'})
        self.content = b'private attachment'
        self.digest = hashlib.sha256(self.content).hexdigest()
        self.object_key = ('test-private', 'v1/owner/' + self.digest)

    def upload(self, store=None, name='file.txt', mime='text/plain'):
        return (store or self.s).add_attachment(self.record['id'], name, self.content, mime)

    def rows(self):
        return self.s.get_record(self.record['id'])['attachments']

    def replace_remote(self, blob):
        self.client.objects[self.object_key] = (
            blob, {'ciphertext-sha256': hashlib.sha256(blob).hexdigest()}, 'application/octet-stream')

    def test_constructor_wires_mirror_and_partition(self):
        s = Store(self.root / 'other', self.key, media_mirror=self.mirror, storage_id='a' * 32)
        p = s.create_project({'name': 'other'})
        r = s.create_record({'project_id': p['id'], 'title': 'note'})
        a = s.add_attachment(r['id'], 'file', self.content, 'text/plain')
        self.assertEqual(self.mirror.get_ciphertext('a' * 32, a['file']), (s.files / a['file']).read_bytes())

    def test_mirror_requires_encryption_before_creating_store(self):
        target = self.root / 'unencrypted'
        with self.assertRaises(ValueError):
            Store(target, media_mirror=self.mirror)
        self.assertFalse(target.exists())

    def test_invalid_partition_is_rejected_before_creating_store(self):
        target = self.root / 'invalid'
        with self.assertRaises(ValueError):
            Store(target, self.key, media_mirror=self.mirror, storage_id='../other')
        self.assertFalse(target.exists())

    def test_local_ciphertext_and_remote_confirmation_precede_visible_record(self):
        original = self.client.get_object
        def observe(**kwargs):
            self.assertEqual(self.rows(), [])
            self.assertTrue((self.s.files / self.digest).read_bytes().startswith(MAGIC))
            return original(**kwargs)
        with patch.object(self.client, 'get_object', observe):
            a = self.upload()
        self.assertEqual(self.client.objects[self.object_key][0], (self.s.files / self.digest).read_bytes())
        self.assertEqual(self.rows(), [a])

    def test_put_head_and_readback_failure_leave_no_visible_record(self):
        for operation in ('put', 'head', 'get'):
            with self.subTest(operation=operation):
                self.client.fail = operation
                with self.assertRaises(ValueError):
                    self.upload()
                self.assertEqual(self.rows(), [])
        self.client.fail = None
        a = self.upload()
        self.assertEqual(self.rows(), [a])
        self.assertEqual(len(self.client.objects), 1)

    def test_insert_failure_leaves_verified_orphan_and_retry_is_idempotent(self):
        with self.s.connection() as c:
            c.execute("CREATE TRIGGER fail_attachment BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'injected insert'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.upload()
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.mirror.get_ciphertext('owner', self.digest), (self.s.files / self.digest).read_bytes())
        with self.s.connection() as c:
            c.execute('DROP TRIGGER fail_attachment')
        a = self.upload()
        self.assertEqual(self.upload(), a)
        self.assertEqual(self.rows(), [a])

    def test_retry_dedupes_normalized_name_and_mime_but_keeps_distinct_metadata(self):
        a = self.upload(name='folder/file.txt', mime='x' * 105)
        self.assertEqual(self.upload(name='file.txt', mime='x' * 100), a)
        self.assertNotEqual(self.upload(name='other.txt')['id'], a['id'])
        self.assertNotEqual(self.upload(mime='text/csv')['id'], a['id'])
        self.assertEqual(len(self.rows()), 3)

    def test_independent_store_instances_dedupe_concurrent_retry(self):
        other = Store(self.s.root, self.key, media_mirror=self.mirror)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.upload, [self.s, other]))
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.s.read_attachment(results[0]['id'])[1], self.content)
        self.assertEqual(other.verified_media((other.files / self.digest).read_bytes(), results[0]), self.content)

    def test_retry_rechecks_remote_and_existing_record_length(self):
        self.upload()
        self.client.fail = 'get'
        with self.assertRaises(ValueError):
            self.upload()
        self.client.fail = None
        with self.s.connection() as c:
            c.execute('UPDATE attachments SET size=size+1')
        with self.assertRaises(ValueError):
            self.upload()
        self.assertEqual(len(self.rows()), 1)

    def test_r2_is_preferred_when_local_copy_is_corrupt(self):
        a = self.upload()
        (self.s.files / self.digest).write_bytes(b'corrupt local')
        self.assertEqual(self.s.read_attachment(a['id'])[1], self.content)

    def test_missing_timeout_and_corrupt_remote_use_verified_local_with_safe_warning(self):
        a = self.upload()
        for failure in ('missing', 'timeout', 'corrupt', 'wrong-plaintext', 'plaintext'):
            with self.subTest(failure=failure):
                self.client.fail = None
                self.client.corrupt_get = False
                self.replace_remote((self.s.files / self.digest).read_bytes())
                if failure == 'missing': self.client.objects.clear()
                if failure == 'corrupt': self.client.corrupt_get = True
                if failure == 'wrong-plaintext':
                    self.replace_remote(self.s.cipher.encrypt(b'not original', 'attachment:' + self.digest))
                if failure == 'plaintext': self.replace_remote(self.content)
                timeout = patch.object(self.client, 'get_object', side_effect=TimeoutError('fake-secret')) if failure == 'timeout' else nullcontext()
                with timeout, self.assertLogs('store', level='WARNING') as logs:
                    self.assertEqual(self.s.read_attachment(a['id'])[1], self.content)
                for secret in (self.digest, a['id'], 'fake-secret', 'fake-access', 'private attachment'):
                    self.assertNotIn(secret, '\n'.join(logs.output))

    def test_bad_plaintext_hash_in_both_copies_is_rejected(self):
        a = self.upload()
        blob = self.s.cipher.encrypt(b'wrong', 'attachment:' + self.digest)
        self.replace_remote(blob)
        (self.s.files / self.digest).write_bytes(blob)
        with self.assertLogs('store', level='WARNING'), self.assertRaises(ValueError):
            self.s.read_attachment(a['id'])

    def test_record_length_is_checked_on_both_copies(self):
        a = self.upload()
        with self.s.connection() as c:
            c.execute('UPDATE attachments SET size=size+1')
        with self.assertLogs('store', level='WARNING'), self.assertRaises(ValueError):
            self.s.read_attachment(a['id'])

    def test_plaintext_local_fallback_is_rejected_in_r2_mode(self):
        a = self.upload()
        self.client.objects.clear()
        (self.s.files / self.digest).write_bytes(self.content)
        with self.assertLogs('store', level='WARNING'), self.assertRaises(ValueError):
            self.s.read_attachment(a['id'])

    def test_unknown_id_and_hash_never_touch_remote(self):
        a = self.upload()
        before = list(self.client.calls)
        for identifier in ('a' * 32, a['file']):
            with self.assertRaises(KeyError): self.s.read_attachment(identifier)
        self.assertEqual(self.client.calls, before)

    def test_bad_local_copy_blocks_retry_without_overwriting_remote(self):
        self.upload()
        before = dict(self.client.objects)
        (self.s.files / self.digest).write_bytes(b'bad')
        with self.assertRaises(ValueError): self.upload()
        self.assertEqual(self.client.objects, before)
        self.assertEqual(len(self.rows()), 1)

    def test_unconfigured_mode_preserves_duplicate_uploads(self):
        self.s.media_mirror = None
        first, second = self.upload(), self.upload()
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(self.s.read_attachment(first['id'])[1], self.content)
        self.assertEqual(self.client.calls, [])


class R2ConfigurationTests(unittest.TestCase):
    def test_each_partial_environment_configuration_fails_before_creating_data(self):
        from server import make_server
        values = {'PROCESS_LOG_R2_ACCOUNT_ID': 'a' * 32,
                  'PROCESS_LOG_R2_BUCKET': 'test-private',
                  'PROCESS_LOG_R2_CREDENTIALS_FILE': 'not-a-real-secret-file'}
        for mask in range(1, 7):
            with self.subTest(mask=mask), tempfile.TemporaryDirectory() as root:
                env = {key: value for i, (key, value) in enumerate(values.items()) if mask & (1 << i)}
                with patch.dict(os.environ, env, clear=True):
                    target = Path(root) / 'data'
                    with self.assertRaises(ValueError):
                        server = make_server(target, 0)
                        server.server_close()
                    self.assertFalse(target.exists())


@unittest.skipUnless(os.environ.get('PROCESS_LOG_TEST_DATABASE_URL'), 'requires isolated PostgreSQL test database')
class R2PostgreSQLTests(unittest.TestCase):
    def setUp(self):
        from pgstore import PostgreSQLStore
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        key = root / 'key'
        key.write_bytes(bytes(range(32)))
        self.storage_id = uuid.uuid4().hex
        self.namespace = 'process_log_user_' + self.storage_id
        self.client = MemoryS3()
        self.mirror = R2Mirror(self.client, 'test-private')
        self.dsn = os.environ['PROCESS_LOG_TEST_DATABASE_URL']
        self.s = PostgreSQLStore(root / 'data', self.dsn, encryption_key_file=key,
                                 namespace=self.namespace, media_mirror=self.mirror, storage_id=self.storage_id)
        self.addCleanup(self.drop_test_schema)
        self.other = PostgreSQLStore(root / 'data', self.dsn, encryption_key_file=key,
                                     namespace=self.namespace, media_mirror=self.mirror, storage_id=self.storage_id)
        p = self.s.create_project({'name': 'PG mirror'})
        self.record = self.s.create_record({'project_id': p['id'], 'title': 'note'})

    def drop_test_schema(self):
        import psycopg
        from psycopg import sql
        # Exact randomly allocated test schema only, never the owner's public schema.
        with psycopg.connect(self.dsn) as c:
            c.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(self.namespace)))

    def upload(self, store):
        return store.add_attachment(self.record['id'], 'file.txt', b'PG private', 'text/plain')

    def test_concurrent_retry_is_unique_and_r2_then_local_reads_verify(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.upload, [self.s, self.other]))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.s.get_record(self.record['id'])['attachments'], [results[0]])
        a = results[0]
        local_path = self.s.files / a['file']
        original = local_path.read_bytes()
        local_path.write_bytes(b'corrupt local')
        self.assertEqual(self.s.read_attachment(a['id'])[1], b'PG private')
        local_path.write_bytes(original)
        self.client.objects.clear()
        with self.assertLogs('store', level='WARNING'):
            self.assertEqual(self.other.read_attachment(a['id'])[1], b'PG private')

    def test_remote_and_insert_failure_roll_back_and_retry_keeps_one_record(self):
        self.client.fail = 'put'
        with self.assertRaises(ValueError): self.upload(self.s)
        self.assertEqual(self.s.get_record(self.record['id'])['attachments'], [])
        self.client.fail = None
        with self.s.connection() as c:
            c.execute('ALTER TABLE attachments ADD CONSTRAINT reject_test_upload CHECK (size < 0)')
        with self.assertRaises(sqlite3.IntegrityError): self.upload(self.s)
        self.assertEqual(self.s.get_record(self.record['id'])['attachments'], [])
        self.assertEqual(len(self.client.objects), 1)
        with self.s.connection() as c:
            c.execute('ALTER TABLE attachments DROP CONSTRAINT reject_test_upload')
        a = self.upload(self.s)
        self.assertEqual(self.upload(self.other), a)
        self.assertEqual(self.s.get_record(self.record['id'])['attachments'], [a])
        self.assertEqual(self.s.read_attachment(a['id'])[1], b'PG private')
