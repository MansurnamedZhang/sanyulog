import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from store import Store, Conflict


class NotebookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.s = Store(self.root)
        self.p = self.s.create_project({'name': 'Notebook'})
        self.r = self.s.create_record({'project_id': self.p['id'], 'title': '持续实验'})

    def test_workspaces_move_projects_and_roundtrip_backup(self):
        self.assertEqual(self.s.state()['projects'][0]['workspace_id'], 'default')
        workspace = self.s.create_workspace({'name': '工作流'})
        self.s.update_project(self.p['id'], {'name': 'Notebook', 'workspace_id': workspace['id']})
        with self.assertRaises(ValueError):
            self.s.delete_workspace(workspace['id'])
        with self.assertRaises(ValueError):
            self.s.create_project({'name': '无效', 'workspace_id': 'missing'})
        self.assertEqual(len(self.s.state()['projects']), 1)
        self.s.update_workspace(workspace['id'], {'name': '新空间'})
        backup = self.s.backup()
        with tempfile.TemporaryDirectory() as folder:
            restored = Store(folder)
            restored.restore(backup)
            self.assertEqual(restored.state(), self.s.state())
        self.s.update_project(self.p['id'], {'name': 'Notebook', 'workspace_id': 'default'})
        self.s.delete_workspace(workspace['id'])
        self.assertEqual(len(self.s.state()['workspaces']), 1)
        self.assertEqual(self.s.get_record(self.r['id'])['title'], '持续实验')

    def cell(self, identifier='a', **extra):
        return {'id': identifier*32, 'type': 'markdown', 'source': '# 开始\n\n随手记', 'language': '', 'attachment_ids': [], **extra}

    def test_independent_csv_table_survives_save_backup_and_export(self):
        cells=[self.cell(type='table',source='name,value\nA,"1,2"\n')]
        saved=self.s.update_record(self.r['id'],{'version':self.r['version'],'cells':cells})
        self.s.restore(self.s.backup())
        self.assertEqual(self.s.get_record(saved['id'])['cells'],cells)
        self.assertIn('name',self.s.markdown(saved['id']))
        with self.assertRaises(ValueError):
            self.s.update_record(saved['id'],{'version':saved['version'],'cells':[self.cell(type='table',source='a,"broken')]})

    def test_cells_save_order_whitespace_restart_and_conflict(self):
        cells = [self.cell('a'), self.cell('b', type='code', language='python', source='    run()\n'), self.cell('c', source='')]
        r = self.s.update_record(self.r['id'], {'version': self.r['version'], 'cells': cells})
        self.assertEqual(r.get('cells'), cells)
        reordered = [cells[2], cells[0], cells[1]]
        self.s.update_record(r['id'], {'version': r['version'], 'cells': reordered})
        self.assertEqual(Store(self.root).get_record(r['id'])['cells'], reordered)
        with self.assertRaises(Conflict):
            self.s.update_record(r['id'], {'version': r['version'], 'cells': []})

    def test_invalid_cells_rejected_atomically(self):
        cases = [[self.cell(), self.cell()], [self.cell(type='html')], [self.cell(attachment_ids=['f'*32])], [self.cell(source=42)]]
        for cells in cases:
            with self.assertRaises(ValueError):
                self.s.update_record(self.r['id'], {'version': self.r['version'], 'title': '不可提交', 'cells': cells})
            self.assertEqual(self.s.get_record(self.r['id'])['title'], '持续实验')

    def test_legacy_entries_become_cells_and_keep_attachments(self):
        e = self.s.add_entry(self.r['id'], {'kind': '问题', 'body': '    日志\n'})
        a = self.s.add_attachment(self.r['id'], 'log.txt', b'hello', 'text/plain')
        # Turn the real fixture into a v1 database without discarding source tables.
        with self.s.connection() as c:
            c.execute('DROP TABLE IF EXISTS notebooks')
            c.execute('PRAGMA user_version=1')
        reopened = Store(self.root)
        r = reopened.get_record(self.r['id'])
        self.assertIn('cells', r)
        self.assertEqual(r['cells'][0]['id'], e['id'])
        self.assertIn('    日志\n', r['cells'][0]['source'])
        self.assertEqual(r['cells'][1]['attachment_ids'], [a['id']])
        self.assertEqual(Store(self.root).get_record(r['id'])['cells'], r['cells'])
        self.assertTrue(list((self.root/'backups').glob('before-notebook-*.zip')))

    def test_backup_roundtrip_and_markdown_includes_cells(self):
        a = self.s.add_attachment(self.r['id'], 'output.txt', b'output', 'text/plain')
        cells = [self.cell(), self.cell('b', type='code', source='print(1)\n', language='python'), self.cell('c', type='file', attachment_ids=[a['id']])]
        r = self.s.update_record(self.r['id'], {'version': self.r['version'], 'cells': cells})
        backup = self.s.backup()
        self.s.delete_record(r['id'])
        self.s.restore(backup)
        self.assertEqual(self.s.get_record(r['id']).get('cells'), cells)
        md = self.s.markdown(r['id'])
        self.assertIn('# 开始', md)
        self.assertIn('```python\nprint(1)\n', md)
        self.assertIn('output.txt', md)

    def test_restore_v1_backup_migrates_before_install(self):
        self.s.add_entry(self.r['id'], {'body': 'old backup'})
        with self.s.connection() as c:
            c.execute('DROP TABLE IF EXISTS notebooks')
            c.execute('PRAGMA user_version=1')
        backup = self.s.backup()
        self.s = Store(self.root)
        self.s.restore(backup)
        r = self.s.get_record(self.r['id'])
        self.assertIn('cells', r)
        self.assertIn('old backup', r['cells'][0]['source'])

    def test_oversized_legacy_notebooks_remain_editable_and_restorable(self):
        for count, body in [(16, 'x'*100000), (2001, 'entry')]:
            with self.subTest(count=count):
                with self.s.connection() as c:
                    c.execute('DROP TABLE IF EXISTS notebooks')
                    c.execute('DELETE FROM entries')
                    c.execute('PRAGMA user_version=1')
                    c.executemany('INSERT INTO entries VALUES (?,?,?,?,?)',
                                  [(f'{i:032x}', self.r['id'], '操作', body, f'2026-09-09T00:00:{i:05d}') for i in range(count)])
                self.s = Store(self.root)
                r = self.s.get_record(self.r['id'])
                saved = self.s.update_record(r['id'], {'version': r['version'], 'title': '旧记录仍可编辑', 'cells': r['cells']})
                self.s.restore(self.s.backup())
                self.assertEqual(self.s.get_record(r['id'])['cells'], saved['cells'])


if __name__ == '__main__':
    unittest.main()
