import os
import sqlite3
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import patch
from pathlib import Path
from store import Store

class EncryptionTests(unittest.TestCase):
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
                                      s.encrypt_attachment_files, s.backup):
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
