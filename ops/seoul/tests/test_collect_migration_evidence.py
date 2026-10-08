import hashlib
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest import mock

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


SUT = Path(__file__).resolve().parents[1] / 'collect-migration-evidence.py'
if not SUT.is_file():
    raise AssertionError('RED: migration evidence collector missing')
spec = importlib.util.spec_from_file_location('sanyu_migration_collector', SUT)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sanyu-collector-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.auth = self.root / 'auth.db'
        self.key = self.root / 'storage.key'
        self.attachments = self.root / 'attachments'
        self.attachments.mkdir()
        self.key.write_bytes(bytes(range(32)))
        with closing(sqlite3.connect(self.auth)) as db, db:
            db.execute('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, salt BLOB, password_hash BLOB, is_admin INTEGER, enabled INTEGER, storage_id TEXT)')
            db.execute('CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, created REAL, expires REAL, user_id INTEGER)')
            db.execute('INSERT INTO users VALUES (1,?,?,?,?,?,?)', ('owner', b'salt', b'hash', 1, 1, 'owner'))
            db.execute('INSERT INTO users VALUES (2,?,?,?,?,?,?)', ('disabled', b'salt2', b'hash2', 0, 0, '1234567890abcdef1234567890abcdef'))
            db.execute('INSERT INTO sessions VALUES (?,?,?,?)', ('a'*64, 1.5, 2.5, 1))
        self.plain = b'fixture media bytes'
        self.digest = hashlib.sha256(self.plain).hexdigest()
        magic = b'PROCESSLOG-AESGCM-1\x00'
        nonce = b'0'*12
        self.ciphertext = magic + nonce + AESGCM(self.key.read_bytes()).encrypt(nonce, self.plain, ('attachment:'+self.digest).encode())
        (self.attachments / self.digest).write_bytes(self.ciphertext)
        self.rows = {'public': {table: [] for table in collector.TABLES}}
        self.rows['public']['attachments'] = [dict(id='ref1', file=self.digest, size=len(self.plain))]

    def evidence(self):
        return collector.collect_dataset(self.auth, self.key, self.attachments, self.rows)

    def test_disabled_account_and_all_session_columns_affect_hash(self):
        before = self.evidence()
        self.assertEqual(2, len(before['accounts']))
        self.assertEqual(1, before['sessionCount'])
        self.assertFalse(before['accounts'][1]['enabled'])
        self.assertFalse(before['accounts'][1]['initialized'])
        with closing(sqlite3.connect(self.auth)) as db, db:
            db.execute('UPDATE users SET password_hash=? WHERE id=2', (b'changed',))
            db.execute('UPDATE sessions SET expires=?', (9.5,))
        after = self.evidence()
        self.assertNotEqual(before['accountRowsSha256'], after['accountRowsSha256'])
        self.assertNotEqual(before['sessionRowsSha256'], after['sessionRowsSha256'])

    def test_all_six_tables_and_verified_ciphertext(self):
        result = self.evidence()
        self.assertEqual(set(collector.TABLES), {table['name'] for table in result['database'][0]['tables']})
        media = result['media'][0]
        self.assertEqual(1, media['references'])
        self.assertEqual(hashlib.sha256(self.ciphertext).hexdigest(), media['ciphertextSha256'])
        self.assertEqual(self.digest, media['plaintextSha256'])
        self.assertEqual(len(self.plain), media['plaintextBytes'])

    def test_missing_or_extra_table_rejected(self):
        del self.rows['public']['projects']
        with self.assertRaises(ValueError):
            self.evidence()
        self.rows['public']['projects'] = []
        self.rows['public']['unexpected'] = []
        with self.assertRaises(ValueError):
            self.evidence()

    def test_missing_corrupt_and_extra_media_rejected(self):
        path = self.attachments / self.digest
        path.unlink()
        with self.assertRaises(ValueError):
            self.evidence()
        path.write_bytes(self.ciphertext[:-1]+b'x')
        with self.assertRaises(ValueError):
            self.evidence()
        path.write_bytes(self.ciphertext)
        (self.attachments / ('f'*64)).write_bytes(b'orphan')
        with self.assertRaises(ValueError):
            self.evidence()

    def test_symlink_media_rejected(self):
        path = self.attachments / self.digest
        outside = self.root / 'outside'
        outside.write_bytes(self.ciphertext)
        path.unlink()
        try:
            path.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest('symlink unavailable')
        with self.assertRaises(ValueError):
            self.evidence()

    def test_uninitialized_account_schema_must_be_absent(self):
        self.rows['process_log_user_1234567890abcdef1234567890abcdef'] = {table: [] for table in collector.TABLES}
        result = self.evidence()
        self.assertTrue(result['accounts'][1]['initialized'])
        self.assertEqual(2, len(result['database']))

    def test_output_is_exclusive_mode_0600_and_not_overwritten(self):
        destination = self.root / 'evidence.json'
        collector.write_evidence(destination, {'role': 'source'})
        if os.name != 'nt':
            self.assertEqual(0o600, stat.S_IMODE(destination.stat().st_mode))
        with self.assertRaises(FileExistsError):
            collector.write_evidence(destination, {'role': 'target'})
        self.assertEqual('source', json.loads(destination.read_text())['role'])

    def test_snapshot_database_identity_is_not_inferred_from_filename(self):
        snapshot = self.root / 'snapshot'
        snapshot.mkdir()
        for relative, payload in (('db.dump', b'PGDMPfixture'), ('auth/auth.db', b'auth'),
                                  ('secrets/storage.key', bytes(range(32)))):
            path = snapshot / relative
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(payload)
        members = []
        for relative in ('db.dump', 'auth/auth.db', 'secrets/storage.key'):
            payload = (snapshot / relative).read_bytes()
            members.append(dict(path=relative, kind='file', bytes=len(payload),
                                sha256=hashlib.sha256(payload).hexdigest()))
        manifest = dict(schemaVersion=1, complete=True, sourceStopped=True,
                        databaseName='process_log', dumpDatabase='process_log', databaseUser='process_log',
                        dumpFormat='custom', keyBytes=32, members=members)
        (snapshot / 'manifest.json').write_text(json.dumps(manifest))
        collector.validate_manifest(snapshot)
        manifest['databaseName'] = 'wrong'
        (snapshot / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            collector.validate_manifest(snapshot)

    def test_restored_state_tree_requires_exact_bytes_and_no_extras(self):
        source = self.root / 'source'
        target = self.root / 'target'
        (source / 'state').mkdir(parents=True)
        (target / 'state').mkdir(parents=True)
        (source / 'state' / 'one').write_bytes(b'stable')
        (target / 'state' / 'one').write_bytes(b'stable')
        collector.check_restored_state(source, target)
        (target / 'state' / 'one').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            collector.check_restored_state(source, target)
        (target / 'state' / 'one').write_bytes(b'stable')
        (target / 'state' / 'extra').write_bytes(b'x')
        with self.assertRaises(ValueError):
            collector.check_restored_state(source, target)
        (target / 'state' / 'extra').unlink()
        (target / 'state' / 'empty-extra').mkdir()
        with self.assertRaises(ValueError):
            collector.check_restored_state(source, target)

    def test_postgres_capture_parses_six_tables_in_read_only_transaction(self):
        marker_rows = []
        for name in collector.TABLES:
            marker_rows.extend((f'BEGIN_public_{name}', 'END_SECTION'))
        calls = []
        def fake_psql(container, user, database, script):
            calls.append(script)
            if len(calls) == 1:
                return ['process_log|process_log|180006']
            if len(calls) == 2:
                return ['public']
            if len(calls) == 3:
                return [f'public|{name}' for name in collector.TABLES]
            return marker_rows
        with mock.patch.object(collector, 'run_psql', side_effect=fake_psql):
            rows = collector.capture_postgres('dev-postgres', 'process_log', 'process_log', {'owner'})
        self.assertEqual(set(collector.TABLES), set(rows['public']))
        self.assertIn('REPEATABLE READ READ ONLY', calls[3])
        self.assertIn('"public"."attachments"', calls[3])
        self.assertNotIn('INSERT ', calls[3])

    def test_role_is_bound_to_actual_hostname(self):
        with mock.patch.object(collector.socket, 'gethostname', return_value='VM-0-3-ubuntu'):
            with self.assertRaises(ValueError):
                collector.check_hostname('source')
            collector.check_hostname('target')

    def test_target_created_app_is_safe_but_source_must_be_exited(self):
        completed = mock.Mock(returncode=0, stdout='created|sanyulog|app\n')
        with mock.patch.object(collector.subprocess, 'run', return_value=completed):
            collector.check_container_stopped('sanyulog-app-1', 'sanyulog')
        completed = mock.Mock(returncode=0, stdout='created|process-log|app\n')
        with mock.patch.object(collector.subprocess, 'run', return_value=completed):
            with self.assertRaises(ValueError):
                collector.check_container_stopped('process-log', 'process-log')

    def test_auth_sidecar_is_not_silently_ignored(self):
        authdir = self.root / 'auth'
        authdir.mkdir()
        (authdir / 'auth.db').write_bytes(b'fixture')
        collector.check_auth_directory(authdir)
        (authdir / 'auth.db-wal').write_bytes(b'unmerged')
        with self.assertRaises(ValueError):
            collector.check_auth_directory(authdir)


if __name__ == '__main__':
    unittest.main()
