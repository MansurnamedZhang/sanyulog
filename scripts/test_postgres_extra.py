"""Run from the project root against a disposable PostgreSQL database only.

PROCESS_LOG_TEST_DATABASE_URL must identify a database safe to clear.
Usage: python -B scripts/test_postgres_extra.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
sys.path.insert(0, str(Path.cwd() / 'tests'))
from test_notebook import NotebookTests
from pgstore import PostgreSQLStore


class ExtraPG(NotebookTests):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.s = PostgreSQLStore(self.root, os.environ['PROCESS_LOG_TEST_DATABASE_URL'])
        with self.s.connection() as c:
            c.execute('DELETE FROM projects')
            c.execute("DELETE FROM settings WHERE key='workspaces'")
        self.p = self.s.create_project({'name': 'Notebook'})
        self.r = self.s.create_record({'project_id': self.p['id'], 'title': '持续实验'})


if __name__ == '__main__':
    names = [
        'test_workspaces_move_projects_and_roundtrip_backup',
        'test_independent_csv_table_survives_save_backup_and_export',
    ]
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.TestSuite(ExtraPG(name) for name in names)
    )
    raise SystemExit(0 if result.wasSuccessful() and not result.skipped else 1)
