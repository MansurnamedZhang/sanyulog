import os
import sqlite3
import tempfile
import unittest
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest.mock import patch
from pathlib import Path
from store import Store

class EncryptionTests(unittest.TestCase):
    def test_backup_includes_committed_ordinary_process_writes_in_wal(self):
        # A raw copy of process.db misses committed WAL frames. The writer uses
        # the ordinary Store API; a separate SQLite handle only keeps WAL alive.
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            s = Store(root / 'data', encryption_key_file=key)
            p = s.create_project({'name':'project'})
            r = s.create_record({'project_id':p['id'], 'title':'before', 'goal':'before'})
            a = s.add_attachment(r['id'], 'file', b'original', 'text/plain')
            code = ('from store import Store; import sqlite3,sys\n'
                    's=Store(sys.argv[1],encryption_key_file=sys.argv[2])\n'
                    'anchor=sqlite3.connect(s.db)\n'
                    'anchor.execute("PRAGMA journal_mode=WAL")\n'
                    'anchor.execute("BEGIN")\n'
                    'anchor.execute("SELECT count(*) FROM records").fetchone()\n'
                    's.update_record(sys.argv[3],dict(version=1,title="committed",goal="committed"))\n'
                    'print("committed",flush=True)\n'
                    'sys.stdin.readline()\n'
                    'anchor.close()\n')
            child = subprocess.Popen([sys.executable, '-c', code, str(s.root), str(key), r['id']],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'committed')
                backup = s.backup()
            finally:
                _, errors = child.communicate('\n', timeout=10)
            self.assertEqual(child.returncode, 0, errors)
            copy = Store(root / 'copy', encryption_key_file=key)
            copy.restore(backup)
            with copy.connection() as c:
                self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            actual = copy.get_record(r['id'])
            self.assertEqual((actual['title'], actual['goal'], actual['version']), ('committed', 'committed', 2))
            self.assertEqual(copy.read_attachment(a['id'])[1], b'original')

    def test_restore_waits_for_ordinary_connection_commit_and_close(self):
        # POSIX can replace an open SQLite DB inode; Windows instead errors.
        # Both platforms must wait at the stable barrier BEFORE opening/swapping.
        from store import media_lock
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            s = Store(root / 'data', encryption_key_file=key)
            p = s.create_project({'name':'before'})
            backup = s.backup()
            code = ('from store import Store; import sys\n'
                    's=Store(sys.argv[1],encryption_key_file=sys.argv[2])\n'
                    'with s.connection() as c:\n'
                    ' c.execute("UPDATE projects SET name=? WHERE id=?",(s.cipher.seal("committed-before-restore","name"),sys.argv[3]))\n'
                    ' print("transaction-open",flush=True)\n'
                    ' sys.stdin.readline()\n')
            child = subprocess.Popen([sys.executable, '-c', code, str(s.root), str(key), p['id']],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            attempted, finished = threading.Event(), threading.Event()
            @contextmanager
            def observed_lock(path):
                attempted.set()
                with media_lock(path):
                    yield
            def restore():
                try:
                    s.restore(backup)
                finally:
                    finished.set()
            with ThreadPoolExecutor(max_workers=1) as pool:
                try:
                    self.assertEqual(child.stdout.readline().strip(), 'transaction-open')
                    with patch('store.media_lock', observed_lock):
                        future = pool.submit(restore)
                        self.assertTrue(attempted.wait(5), 'restore did not reach lifecycle barrier')
                        was_blocked = not finished.wait(0.3)
                        _, errors = child.communicate('\n', timeout=10)
                        future.result(timeout=10)
                    self.assertTrue(was_blocked, 'restore passed an open ordinary transaction')
                    self.assertEqual(child.returncode, 0, errors)
                finally:
                    if child.poll() is None:
                        child.communicate('\n', timeout=10)
            self.assertEqual(s.state()['projects'][0]['name'], 'before')
            copy = Store(root / 'pre-restore-copy', encryption_key_file=key)
            copy.restore(next((s.root / 'backups').glob('before-restore-*.zip')).read_bytes())
            self.assertEqual(copy.state()['projects'][0]['name'], 'committed-before-restore')
            with copy.connection() as c:
                self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_restore_backup_is_reentrant_inside_same_account_media_lock(self):
        from store import media_lock
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            s = Store(root / 'data', encryption_key_file=key)
            p = s.create_project({'name':'project'})
            r = s.create_record({'project_id':p['id'], 'title':'note'})
            a = s.add_attachment(r['id'], 'file', b'original', 'text/plain')
            backup = s.backup()
            with media_lock(s.root):
                s.restore(backup)  # restore itself calls backup under this lock.
                restored_backup = s.backup()
            copy = Store(root / 'copy', encryption_key_file=key)
            copy.restore(restored_backup)
            self.assertEqual(copy.read_attachment(a['id'])[1], b'original')

    def test_media_mutations_fail_closed_while_other_process_holds_stable_lock(self):
        # Missing guards would permit deletion or restore during a GC scan.
        from store import media_lock
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            s = Store(root / 'data', encryption_key_file=key)
            p = s.create_project({'name':'project'})
            r = s.create_record({'project_id':p['id'], 'title':'note'})
            a = s.add_attachment(r['id'], 'file', b'original', 'text/plain')
            backup = s.backup()
            code = ('from store import media_lock; import sys\n'
                    'with media_lock(sys.argv[1]):\n'
                    ' print("locked", flush=True)\n'
                    ' sys.stdin.readline()\n')
            child = subprocess.Popen([sys.executable, '-c', code, str(s.root)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'locked')
                with patch('store.media_lock', side_effect=lambda root: media_lock(root, timeout=0.05)):
                    for operation in (lambda: s.add_attachment(r['id'], 'new', b'new', 'text/plain'),
                                      lambda: s.delete_attachment(a['id']), lambda: s.delete_record(r['id']),
                                      lambda: s.delete_project(p['id']), lambda: s.restore(backup),
                                      s.encrypt_attachment_files, s.backup, s.state,
                                      lambda: s.create_project({'name':'blocked ordinary write'})):
                        with self.subTest(operation=operation), self.assertRaises(ValueError): operation()
            finally:
                child.communicate('\n', timeout=10)
            self.assertEqual(s.read_attachment(a['id'])[1], b'original')
            s.restore(backup)
            self.assertTrue((s.root / '.media.lock').is_file())

    def test_encrypted_storage_migration_backup_and_wrong_key(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            data = root / 'data'
            key = root / 'key'
            key.write_bytes(os.urandom(32))
            s = Store(data)
            p = s.create_project({'name': 'PRIVATE-PROJECT-987'})
            r = s.create_record({'project_id': p['id'], 'title': 'PRIVATE-TITLE-987', 'goal': 'PRIVATE-GOAL-987', 'cells': [{'id': 'a'*32, 'type':'markdown', 'source':'PRIVATE-BODY-987', 'language':'', 'attachment_ids':[]}]})
            a = s.add_attachment(r['id'], 'PRIVATE-FILE-987.txt', b'PRIVATE-ATTACHMENT-987', 'text/plain')
            before = s.state()
            s = Store(data, encryption_key_file=key)
            self.assertEqual(s.state(), before)
            self.assertEqual(s.read_attachment(a['id'])[1], b'PRIVATE-ATTACHMENT-987')
            self.assertNotIn(b'PRIVATE-', s.db.read_bytes())
            for f in s.files.iterdir(): self.assertNotIn(b'PRIVATE-', f.read_bytes())
            backup = s.backup()
            self.assertFalse(backup.startswith(b'PK'))
            target = Store(root / 'target', encryption_key_file=key)
            target.restore(backup)
            self.assertEqual(target.state(), before)
            self.assertEqual(target.read_attachment(a['id'])[1], b'PRIVATE-ATTACHMENT-987')
            self.assertNotIn(b'PRIVATE-', target.db.read_bytes())
            with self.assertRaises(ValueError): Store(data)
            wrong = root / 'wrong'; wrong.write_bytes(os.urandom(32))
            with self.assertRaises(ValueError): Store(data, encryption_key_file=wrong)
            damaged = backup[:-1] + bytes([backup[-1] ^ 1])
            with self.assertRaises(ValueError): target.restore(damaged)
            self.assertEqual(target.state(), before)
            current = s.get_record(r['id'])
            s.update_record(r['id'], {'version':current['version'], 'title':'NEW-PRIVATE-TITLE'})
            self.assertEqual(s.get_record(r['id'])['title'], 'NEW-PRIVATE-TITLE')
            self.assertNotIn(b'NEW-PRIVATE', s.db.read_bytes())

    def test_envelope_prefix_is_valid_plaintext_before_migration(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            plain = Store(root / 'data')
            p = plain.create_project({'name':'plenc:v1:literal'})
            r = plain.create_record({'project_id':p['id'], 'title':'plenc:v1:literal'})
            self.assertEqual(plain.get_record(r['id'])['title'], 'plenc:v1:literal')
            encrypted = Store(plain.root, encryption_key_file=key)
            self.assertEqual(encrypted.get_record(r['id'])['title'], 'plenc:v1:literal')
            self.assertEqual(Store(plain.root, encryption_key_file=key).state(), encrypted.state())

    def test_deleted_attachment_reupload_does_not_reuse_plaintext(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            plain = Store(root / 'data')
            p = plain.create_project({'name':'test'})
            r = plain.create_record({'project_id':p['id'], 'title':'test'})
            a = plain.add_attachment(r['id'], 'old.txt', b'PROCESSLOG-AESGCM-1\x00PRIVATE-orphan', 'text/plain')
            plain.delete_attachment(a['id'])
            encrypted = Store(plain.root, encryption_key_file=key)
            a = encrypted.add_attachment(r['id'], 'new.txt', b'PROCESSLOG-AESGCM-1\x00PRIVATE-orphan', 'text/plain')
            self.assertNotIn(b'PROCESSLOG-AESGCM-1\x00PRIVATE-orphan', (encrypted.files / a['file']).read_bytes())
            self.assertEqual(encrypted.read_attachment(a['id'])[1], b'PROCESSLOG-AESGCM-1\x00PRIVATE-orphan')

    def test_interrupted_attachment_restore_preserves_live_data(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            s = Store(root / 'data', encryption_key_file=key)
            p = s.create_project({'name':'test'})
            r = s.create_record({'project_id':p['id'], 'title':'test'})
            a = s.add_attachment(r['id'], 'test.txt', b'original', 'text/plain')
            before = s.state()
            backup = s.backup()
            replace = os.replace
            def fail_attachment(source, target):
                if Path(target).parent == s.files: raise OSError('simulated disk failure')
                return replace(source, target)
            with patch('store.os.replace', side_effect=fail_attachment):
                with self.assertRaises(OSError): s.restore(backup)
            self.assertEqual(s.state(), before)
            self.assertEqual(s.read_attachment(a['id'])[1], b'original')

    def test_new_writes_and_legacy_restore_are_encrypted(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            key = root / 'key'; key.write_bytes(os.urandom(32))
            original = Store(root / 'plain')
            p = original.create_project({'name':'PRIVATE-legacy'})
            r = original.create_record({'project_id':p['id'], 'title':'PRIVATE-legacy-title'})
            original.add_entry(r['id'], {'body':'PRIVATE-legacy-entry'})
            original.add_attachment(r['id'], 'legacy.txt', b'PRIVATE-legacy-file', 'text/plain')
            s = Store(root / 'encrypted', encryption_key_file=key)
            s.restore(original.backup())
            self.assertEqual(s.state(), original.state())
            w = s.create_workspace({'name':'PRIVATE-space'})
            s.update_project(p['id'], {'name':'PRIVATE-renamed', 'workspace_id':w['id']})
            e = s.add_entry(r['id'], {'body':'PRIVATE-entry'})
            s.update_entry(e['id'], {'body':'PRIVATE-updated'})
            s.save_templates([{'id':'custom', 'name':'PRIVATE-template', 'goal':'PRIVATE-goal', 'params':{}}])
            self.assertIn('PRIVATE-updated', s.markdown(r['id']))
            self.assertTrue(s.search('PRIVATE'))
            self.assertNotIn(b'PRIVATE', s.db.read_bytes())
            s.delete_entry(e['id'])
            self.assertEqual(Store(s.root, encryption_key_file=key).state(), s.state())
            with sqlite3.connect(s.db) as c:
                c.execute("UPDATE records SET title='plenc:v1:broken' WHERE id=?", (r['id'],))
            c.close()
            with self.assertRaises(ValueError): s.get_record(r['id'])

if __name__ == '__main__': unittest.main()
