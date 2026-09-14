import importlib.util
import io
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('store'), 'Persistent store is not implemented')
        from store import Store
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.s = Store(self.root)
        self.p = self.s.create_project({'name': 'H3 实验'})

    def record(self):
        return self.s.create_record({'project_id': self.p['id'], 'title': '训练 01', 'params': {'lr': '0.0001'}, 'tags': ['基线']})

    def test_records_survive_restart_and_search_timeline(self):
        from store import Store
        r = self.record()
        self.s.add_entry(r['id'], {'kind': '问题', 'body': 'CUDA 显存不足'})
        state = Store(self.root).state()
        self.assertEqual(state['records'][0]['params'], {'lr': '0.0001'})
        self.assertEqual(self.s.search('显存')[0]['id'], r['id'])
        self.assertEqual(self.s.search('基线')[0]['id'], r['id'])

    def test_edit_conflict_and_copy_link(self):
        from store import Conflict
        r = self.record()
        updated = self.s.update_record(r['id'], {'version': r['version'], 'title': '训练 02'})
        self.assertEqual(updated['title'], '训练 02')
        with self.assertRaises(Conflict):
            self.s.update_record(r['id'], {'version': r['version'], 'title': 'stale'})
        self.s.add_entry(r['id'], {'body': '历史', 'kind': '操作'})
        copy = self.s.duplicate(r['id'])
        self.assertEqual(copy['related_id'], r['id'])
        self.assertEqual(copy['params'], {'lr': '0.0001'})
        self.assertEqual(copy['entries'], [])
        self.assertEqual(copy['status'], '进行中')

    def test_attachment_backup_restore_and_markdown(self):
        r = self.record()
        a = self.s.add_attachment(r['id'], '日志.txt', b'log content', 'text/plain')
        self.s.add_entry(r['id'], {'body': '完成一次运行', 'kind': '结论'})
        backup = self.s.backup()
        self.s.delete_record(r['id'])
        self.s.restore(backup)
        self.assertEqual(self.s.read_attachment(a['id'])[1], b'log content')
        md = self.s.markdown(r['id'])
        self.assertIn('完成一次运行', md)
        self.assertIn('0.0001', md)
        self.assertIn('日志.txt', md)
        self.assertTrue(list((self.root / 'backups').glob('before-restore-*.zip')))

    def test_invalid_restore_never_changes_existing_data(self):
        r = self.record()
        for content in [b'not zip', self.bad_zip()]:
            with self.assertRaises(ValueError):
                self.s.restore(content)
            self.assertEqual(self.s.get_record(r['id'])['title'], '训练 01')

    def bad_zip(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('../escape.txt', 'bad')
        return out.getvalue()

    def test_delete_project_cascades_and_templates_persist(self):
        r = self.record()
        a = self.s.add_attachment(r['id'], 'x.txt', b'x', 'text/plain')
        self.s.save_templates([{'id': 'custom', 'name': '自定义', 'goal': '验证', 'params': {'seed': '42'}}])
        self.assertEqual(self.s.state()['templates'][0]['params']['seed'], '42')
        self.s.delete_project(self.p['id'])
        self.assertEqual(self.s.state()['records'], [])
        with self.assertRaises(KeyError):
            self.s.read_attachment(a['id'])

    def test_required_fields_and_invalid_links_rejected(self):
        with self.assertRaises(ValueError):
            self.s.create_record({'project_id': self.p['id'], 'title': '  '})
        with self.assertRaises(ValueError):
            self.s.create_record({'project_id': 'missing', 'title': 'hello'})
        r = self.record()
        with self.assertRaises(ValueError):
            self.s.update_record(r['id'], {'version': r['version'], 'related_id': r['id']})

    def test_restore_rejects_invalid_record_content_and_template(self):
        r = self.record()
        for sql in ["UPDATE records SET id='<script>'", "UPDATE settings SET value='[1]' WHERE key='templates'"]:
            raw = self.s.backup()
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                candidate = self.root / 'tampered.db'
                candidate.write_bytes(z.read('process.db'))
            with sqlite3.connect(candidate) as conn:
                conn.execute(sql)
            conn.close()
            out = io.BytesIO()
            with zipfile.ZipFile(out, 'w') as z:
                z.write(candidate, 'process.db')
            with self.assertRaises(ValueError):
                self.s.restore(out.getvalue())
            self.assertEqual(self.s.get_record(r['id'])['title'], '训练 01')

    def test_entry_edits_and_attachment_deletion(self):
        r = self.record()
        e = self.s.add_entry(r['id'], {'body': 'before'})
        self.s.update_entry(e['id'], {'body': 'after'})
        self.assertEqual(self.s.get_record(r['id'])['entries'][0]['body'], 'after')
        self.s.delete_entry(e['id'])
        self.assertEqual(self.s.get_record(r['id'])['entries'], [])
        a = self.s.add_attachment(r['id'], 'sample.txt', b'a', 'text/plain')
        self.s.delete_attachment(a['id'])
        self.assertEqual(self.s.get_record(r['id'])['attachments'], [])

    def test_timeline_preserves_code_whitespace(self):
        r = self.record()
        e = self.s.add_entry(r['id'], {'body': '    first()\n    second()\n'})
        self.assertEqual(e['body'], '    first()\n    second()\n')
        self.s.update_entry(e['id'], {'body': '\n    changed()\n'})
        self.assertEqual(self.s.get_record(r['id'])['entries'][0]['body'], '\n    changed()\n')

    def test_oversized_backup_is_rejected_before_success(self):
        r = self.record()
        self.s.add_attachment(r['id'], 'large.bin', bytes(range(256))*8, 'application/octet-stream')
        size = self.s.db.stat().st_size
        with patch('store.MAX_BACKUP_BYTES', size + 1024, create=True):
            with self.assertRaises(ValueError):
                self.s.backup()
        self.assertEqual(self.s.get_record(r['id'])['title'], '训练 01')


if __name__ == '__main__':
    unittest.main()
