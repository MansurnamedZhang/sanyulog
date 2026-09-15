"""PostgreSQL persistence; SQLite is used only for portable backup interchange."""
from storage_crypto import StorageCipher, SENSITIVE
import hashlib
import os
import json
import re
import shutil
import sqlite3
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

import psycopg
from store import Store, V1_SCHEMA, NOTEBOOK_SCHEMA, DEFAULT_TEMPLATES, uid

TABLES = ('projects', 'records', 'entries', 'attachments', 'settings', 'notebooks')


class Row(dict):
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


def row_factory(cursor, cipher=None):
    columns = [column.name for column in cursor.description] if cursor.description else []
    return lambda values: Row((name, cipher.open(value, name) if cipher and name in SENSITIVE else value) for name, value in zip(columns, values) if name != 'rowid')


class Connection:
    """Translate the existing store's parameter syntax, preserving bound parameters."""
    def __init__(self, raw):
        self.raw = raw

    def execute(self, query, parameters=None):
        if isinstance(parameters, dict):
            query = re.sub(r':([a-z_]+)', r'%(\1)s', query)
        else:
            query = query.replace('?', '%s')
        return self.raw.execute(query, parameters)


class PostgreSQLStore(Store):
    def __init__(self, root, database_url, attachments_dir=None, encryption_key_file=None):
        self.cipher = StorageCipher(encryption_key_file)
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.files = Path(attachments_dir).resolve() if attachments_dir else self.root / 'attachments'
        self.files.mkdir(parents=True, exist_ok=True)
        self.database_url = database_url
        self.lock = threading.RLock()
        self.local = threading.local()
        with self.connection() as c:
            schema = V1_SCHEMA.split('PRAGMA')[0] + NOTEBOOK_SCHEMA.split('PRAGMA')[0]
            schema = schema.replace('related_id TEXT REFERENCES records(id) ON DELETE SET NULL',
                                    'related_id TEXT REFERENCES records(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED')
            c.raw.execute(schema)
            for table in TABLES:
                c.raw.execute(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS rowid BIGINT GENERATED ALWAYS AS IDENTITY')
            c.raw.execute('INSERT INTO settings(key,value) VALUES (%s,%s) ON CONFLICT(key) DO NOTHING',
                          ('templates', json.dumps(DEFAULT_TEMPLATES, ensure_ascii=False)))
            self.cipher.configure(c)
            self.migrate_notebooks(c)
            self.migrate_encryption(c)
        self.encrypt_attachment_files()

    @contextmanager
    def connection(self):
        with self.lock:
            existing = getattr(self.local, 'connection', None)
            if existing is not None:
                yield existing
                return
            try:
                with psycopg.connect(self.database_url, row_factory=lambda cursor: row_factory(cursor, self.cipher), connect_timeout=10,
                                     options='-c statement_timeout=60000 -c lock_timeout=30000') as raw:
                    # Serialize store transactions across threads/processes before reading versions.
                    raw.execute('SELECT pg_advisory_xact_lock(728351024)')
                    connection = Connection(raw)
                    self.local.connection = connection
                    try:
                        yield connection
                    finally:
                        del self.local.connection
            except psycopg.IntegrityError as error:
                raise sqlite3.IntegrityError('数据库约束校验失败，修改已回滚') from error

    def backup(self):
        with self.connection() as c, tempfile.TemporaryDirectory(dir=self.root) as directory:
            portable = Store(directory, encryption_key_file=self.cipher.key_file)
            with sqlite3.connect(portable.db) as target:
                target.execute('DELETE FROM settings')
                for table in TABLES:
                    columns = [row[1] for row in target.execute('PRAGMA table_info('+table+')')]
                    rows = c.execute('SELECT '+','.join(columns)+' FROM '+table+' ORDER BY rowid').fetchall()
                    target.executemany('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in columns)+')',
                                       [tuple(self.cipher.seal(row[column], column) if column in SENSITIVE else row[column] for column in columns) for row in rows])
            for row in c.execute('SELECT DISTINCT file FROM attachments'):
                shutil.copyfile(self.files / row['file'], portable.files / row['file'])
            return portable.backup()

    def restore(self, content):
        # Reuse strict schema, ID, relationship, notebook and attachment validation.
        with self.connection() as c, tempfile.TemporaryDirectory(dir=self.root) as directory:
            candidate = Store(directory, encryption_key_file=self.cipher.key_file)
            candidate.restore(content)
            backups = self.root / 'backups'
            backups.mkdir(exist_ok=True)
            (backups / ('before-restore-'+uid()+'.zip')).write_bytes(self.backup())
            with sqlite3.connect(candidate.db) as source:
                source.row_factory = sqlite3.Row
                c.execute('DELETE FROM projects')
                c.execute('DELETE FROM settings')
                for table in TABLES:
                    columns = [row[1] for row in source.execute('PRAGMA table_info('+table+')')]
                    rows = source.execute('SELECT '+','.join(columns)+' FROM '+table+' ORDER BY rowid').fetchall()
                    with c.raw.cursor() as cursor:
                        cursor.executemany('INSERT INTO '+table+' ('+','.join(columns)+') VALUES ('+
                                           ','.join('%s' for _ in columns)+')',
                                           [tuple(row[column] for column in columns) for row in rows])
                for row in source.execute('SELECT DISTINCT file FROM attachments'):
                    incoming = candidate.files / row['file']
                    destination = self.files / row['file']
                    digest = hashlib.sha256(incoming.read_bytes()).digest()
                    if destination.exists() and hashlib.sha256(destination.read_bytes()).digest() == digest:
                        continue
                    fd, name = tempfile.mkstemp(prefix='.restore-', dir=self.files)
                    os.close(fd)
                    staged = Path(name)
                    try:
                        shutil.copyfile(incoming, staged)
                        if hashlib.sha256(staged.read_bytes()).digest() != digest:
                            raise ValueError('附件复制校验失败')
                        with staged.open('rb') as copied:
                            os.fsync(copied.fileno())
                        os.replace(staged, destination)
                    finally:
                        staged.unlink(missing_ok=True)
