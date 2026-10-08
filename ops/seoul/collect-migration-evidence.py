#!/usr/bin/env python3
"""Read-only, fail-closed source/target migration evidence collector.

The operator supplies exact role, paths and database identity. This program
never writes to PostgreSQL, auth, media or R2; its only write is an exclusive
0600 JSON evidence file. It does not authorize a cutover.
"""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import socket
import stat
import subprocess
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag

TABLES = ('projects', 'records', 'entries', 'attachments', 'settings', 'notebooks')
MAGIC = b'PROCESSLOG-AESGCM-1\x00'
LIMIT = 25 * 1024 * 1024
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
HEX32 = re.compile(r'[a-f0-9]{32}\Z')
SOURCE_ROOT = Path('/home/hans/services/process-log/backups')
TARGET_ROOT = Path('/home/ubuntu/apps/sanyulog')
TARGET_BACKUPS = Path('/home/ubuntu/backups/sanyulog')


def require_regular(path, *, maximum=None):
    path = Path(path)
    for ancestor in (path, *path.parents):
        try:
            info = ancestor.lstat()
        except FileNotFoundError as error:
            raise ValueError('missing_path') from error
        if stat.S_ISLNK(info.st_mode) or (ancestor == path and not stat.S_ISREG(info.st_mode)):
            raise ValueError('unsafe_path')
        if ancestor != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError('unsafe_ancestor')
        if ancestor == path and info.st_nlink != 1:
            raise ValueError('hardlinked_input')
    if maximum is not None and path.stat().st_size > maximum:
        raise ValueError('oversize_file')
    return path


def digest_file(path):
    path = require_regular(path)
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def cell(value):
    if value is None:
        return ['null']
    if isinstance(value, bytes):
        return ['bytes', value.hex()]
    if isinstance(value, int):
        return ['int', value]
    if isinstance(value, float):
        return ['float', repr(value)]
    if isinstance(value, str):
        return ['text', value]
    raise ValueError('unsupported_auth_cell')


def canonical_hash(rows, columns):
    encoded = []
    for row in rows:
        values = [cell(value) for value in row]
        encoded.append(json.dumps(dict(columns=list(columns), values=values), sort_keys=True,
                                  ensure_ascii=False, separators=(',', ':')))
    encoded.sort()
    return hashlib.sha256(('\n'.join(encoded)).encode('utf-8')).hexdigest()


def collect_auth(path):
    path = require_regular(path, maximum=128 * 1024 * 1024)
    before = digest_file(path)
    uri = path.as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('auth_integrity')
        users = db.execute('SELECT * FROM users ORDER BY id')
        user_columns = tuple(column[0] for column in users.description)
        user_rows = users.fetchall()
        sessions = db.execute('SELECT * FROM sessions ORDER BY token_hash')
        session_columns = tuple(column[0] for column in sessions.description)
        session_rows = sessions.fetchall()
    if not {'id', 'storage_id', 'enabled'}.issubset(user_columns) or not {'token_hash', 'user_id'}.issubset(session_columns):
        raise ValueError('auth_schema')
    users_by_id = {row[user_columns.index('id')] for row in user_rows}
    if len(users_by_id) != len(user_rows):
        raise ValueError('duplicate_user')
    accounts = []
    seen = set()
    for row in user_rows:
        storage_id = row[user_columns.index('storage_id')]
        enabled = row[user_columns.index('enabled')]
        if (not isinstance(storage_id, str) or
            (storage_id != 'owner' and not HEX32.fullmatch(storage_id)) or
            storage_id in seen or type(enabled) is not int or enabled not in (0, 1)):
            raise ValueError('invalid_account')
        seen.add(storage_id)
        accounts.append((storage_id, bool(enabled)))
    if 'owner' not in seen or not accounts:
        raise ValueError('owner_missing')
    if any(row[session_columns.index('user_id')] not in users_by_id for row in session_rows):
        raise ValueError('session_orphan')
    after = digest_file(path)
    if before != after:
        raise ValueError('auth_changed_during_read')
    return dict(authDbSha256=before, accountRowsSha256=canonical_hash(user_rows, user_columns),
                sessionRowsSha256=canonical_hash(session_rows, session_columns),
                sessionCount=len(session_rows), accounts=accounts)


def check_auth_directory(path):
    root = Path(path)
    if not root.is_dir() or stat.S_ISLNK(root.lstat().st_mode):
        raise ValueError('auth_directory_invalid')
    entries = list(root.iterdir())
    if len(entries) != 1 or entries[0].name != 'auth.db':
        raise ValueError('auth_sidecar_or_extra')
    require_regular(entries[0])


def normalized_table(rows):
    canonical = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('invalid_pg_row')
        canonical.append(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(',', ':')))
    canonical.sort()
    return hashlib.sha256(('\n'.join(canonical)).encode('utf-8')).hexdigest()


def checked_media_tree(root, expected):
    root = Path(root)
    if not root.is_dir() or stat.S_ISLNK(root.lstat().st_mode):
        raise ValueError('media_root_invalid')
    actual = set()
    stack = [root]
    allowed_dirs = {Path('.'), Path('accounts')}
    for relative in expected:
        for parent in relative.parents:
            allowed_dirs.add(parent)
    while stack:
        directory = stack.pop()
        for child in directory.iterdir():
            info = child.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('media_symlink')
            relative = child.relative_to(root)
            if stat.S_ISDIR(info.st_mode):
                if relative not in allowed_dirs:
                    raise ValueError('extra_media_directory')
                stack.append(child)
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink != 1:
                    raise ValueError('linked_media')
                actual.add(relative)
            else:
                raise ValueError('special_media')
    if actual != expected:
        raise ValueError('media_inventory_mismatch')


def abort_walk(error):
    raise ValueError('unreadable_subtree') from error


def collect_dataset(auth_db, key_file, attachments_root, pg_rows):
    auth = collect_auth(auth_db)
    key_file = require_regular(key_file, maximum=32)
    key = key_file.read_bytes()
    if len(key) != 32:
        raise ValueError('invalid_key')
    key_hash = hashlib.sha256(key).hexdigest()
    aes = AESGCM(key)
    del key
    account_ids = {storage_id for storage_id, _ in auth['accounts']}
    expected_schemas = {('public' if storage_id == 'owner' else 'process_log_user_' + storage_id): storage_id
                        for storage_id in account_ids}
    if not isinstance(pg_rows, dict) or set(pg_rows) - set(expected_schemas):
        raise ValueError('unknown_schema')
    if 'public' not in pg_rows:
        raise ValueError('owner_schema_missing')
    accounts = []
    database = []
    media = []
    expected_paths = set()
    for storage_id, enabled in auth['accounts']:
        schema = 'public' if storage_id == 'owner' else 'process_log_user_' + storage_id
        initialized = schema in pg_rows
        accounts.append(dict(storageId=storage_id, enabled=enabled, initialized=initialized))
        if not initialized:
            continue
        tables = pg_rows[schema]
        if not isinstance(tables, dict) or set(tables) != set(TABLES):
            raise ValueError('incomplete_tables')
        database.append(dict(schema=schema, tables=[dict(name=name, rows=len(tables[name]),
                  normalizedSha256=normalized_table(tables[name])) for name in TABLES]))
        refs = {}
        for row in tables['attachments']:
            digest, size = row.get('file'), row.get('size')
            if not isinstance(digest, str) or not HEX64.fullmatch(digest) or type(size) is not int or size < 0 or size > LIMIT:
                raise ValueError('invalid_media_reference')
            old = refs.get(digest)
            if old is not None and old[0] != size:
                raise ValueError('conflicting_media_reference')
            refs[digest] = (size, (old[1] if old else 0) + 1)
        for digest, (size, count) in sorted(refs.items()):
            relative = Path(digest) if storage_id == 'owner' else Path('accounts') / storage_id / digest
            expected_paths.add(relative)
            path = require_regular(Path(attachments_root) / relative, maximum=LIMIT + len(MAGIC) + 28)
            info = path.lstat()
            if info.st_nlink != 1:
                raise ValueError('linked_media')
            blob = path.read_bytes()
            if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 28:
                raise ValueError('unencrypted_media')
            try:
                plaintext = aes.decrypt(blob[len(MAGIC):len(MAGIC)+12], blob[len(MAGIC)+12:],
                                        ('attachment:' + digest).encode('utf-8'))
            except (InvalidTag, ValueError) as error:
                raise ValueError('ciphertext_invalid') from error
            if len(plaintext) != size or hashlib.sha256(plaintext).hexdigest() != digest:
                raise ValueError('plaintext_mismatch')
            media.append(dict(storageId=storage_id, key=f'v1/{storage_id}/{digest}',
                              plaintextSha256=digest, plaintextBytes=size,
                              ciphertextSha256=hashlib.sha256(blob).hexdigest(),
                              ciphertextBytes=len(blob), references=count))
    checked_media_tree(attachments_root, expected_paths)
    return dict(authDbSha256=auth['authDbSha256'], storageKeySha256=key_hash,
                accountRowsSha256=auth['accountRowsSha256'], sessionRowsSha256=auth['sessionRowsSha256'],
                sessionCount=auth['sessionCount'], accounts=accounts, database=database, media=media)


def ensure_auth_stable(first, dataset):
    for field in ('authDbSha256', 'accountRowsSha256', 'sessionRowsSha256', 'sessionCount'):
        if first[field] != dataset[field]:
            raise ValueError('auth_changed_during_capture')
    observed = [(item['storageId'], item['enabled']) for item in dataset['accounts']]
    if first['accounts'] != observed:
        raise ValueError('auth_accounts_changed_during_capture')


def run_psql(container, user, database, script):
    command = ['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-A', '-t',
               '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database]
    result = subprocess.run(command, input=script, text=True, capture_output=True, timeout=300)
    if result.returncode:
        raise ValueError('database_query_failed')
    return result.stdout.splitlines()


def capture_postgres(container, user, database, account_ids):
    identity = run_psql(container, user, database,
        "SELECT current_database() || '|' || current_user || '|' || current_setting('server_version_num');")
    if len(identity) != 1 or identity[0].split('|')[:2] != [database, user] or not identity[0].split('|')[2].startswith('18'):
        raise ValueError('database_identity')
    names = run_psql(container, user, database,
        "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname='public' OR nspname LIKE 'process_log_user_%' ORDER BY nspname;")
    expected = {'public'} | {'process_log_user_' + sid for sid in account_ids if sid != 'owner'}
    if set(names) - expected or len(names) != len(set(names)) or 'public' not in names:
        raise ValueError('database_schema_identity')
    table_script = "SELECT n.nspname || '|' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND (n.nspname='public' OR n.nspname LIKE 'process_log_user_%') ORDER BY 1;"
    observed = run_psql(container, user, database, table_script)
    table_map = {name: set() for name in names}
    for line in observed:
        bits = line.split('|')
        if len(bits) != 2 or bits[0] not in table_map or bits[1] in table_map[bits[0]]:
            raise ValueError('database_table_identity')
        table_map[bits[0]].add(bits[1])
    if any(tables != set(TABLES) for tables in table_map.values()):
        raise ValueError('database_table_identity')
    sql = ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;", "SET LOCAL TIME ZONE 'UTC';", "SET LOCAL DateStyle TO ISO, YMD;"]
    sections = []
    for schema in sorted(names):
        if not re.fullmatch(r'[a-z0-9_]+', schema):
            raise ValueError('unsafe_schema')
        for table in TABLES:
            marker = f'BEGIN_{schema}_{table}'
            sections.append((marker, schema, table))
            sql.append(f"SELECT '{marker}';")
            sql.append(f'''COPY (SELECT line FROM (SELECT encode(convert_to(row_to_json(t)::text,'UTF8'),'hex') AS line FROM "{schema}"."{table}" t) q ORDER BY line COLLATE "C") TO STDOUT;''')
            sql.append("SELECT 'END_SECTION';")
    sql.append('COMMIT;')
    lines = run_psql(container, user, database, '\n'.join(sql))
    rows = {schema: {name: [] for name in TABLES} for schema in names}
    cursor = 0
    for marker, schema, table in sections:
        if cursor >= len(lines) or lines[cursor] != marker:
            raise ValueError('database_capture_incomplete')
        cursor += 1
        while cursor < len(lines) and lines[cursor] != 'END_SECTION':
            encoded = lines[cursor]
            if not encoded or len(encoded) % 2 or not re.fullmatch('[0-9a-f]+', encoded):
                raise ValueError('database_capture_invalid_hex')
            rows[schema][table].append(json.loads(bytes.fromhex(encoded)))
            cursor += 1
        if cursor >= len(lines):
            raise ValueError('database_capture_incomplete')
        cursor += 1
    if cursor != len(lines):
        raise ValueError('database_capture_extra')
    return rows


def validate_manifest(snapshot):
    snapshot = Path(snapshot)
    manifest = require_regular(snapshot / 'manifest.json', maximum=16 * 1024 * 1024)
    content = manifest.read_bytes()
    data = json.loads(content)
    if (data.get('schemaVersion') != 1 or data.get('complete') is not True or
        data.get('sourceStopped') is not True or data.get('databaseName') != 'process_log' or
        data.get('dumpDatabase') != 'process_log' or data.get('databaseUser') != 'process_log' or
        data.get('dumpFormat') != 'custom' or data.get('keyBytes') != 32 or
        not isinstance(data.get('members'), list)):
        raise ValueError('snapshot_manifest_incomplete')
    expected = {'manifest.json'}
    for entry in data['members']:
        relative = entry.get('path')
        if (entry.get('kind') != 'file' or not isinstance(relative, str) or
            not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', relative) or
            '..' in relative.split('/') or relative in expected or
            type(entry.get('bytes')) is not int or entry['bytes'] < 0 or
            not isinstance(entry.get('sha256'), str) or not HEX64.fullmatch(entry['sha256'])):
            raise ValueError('snapshot_member_invalid')
        expected.add(relative)
        path = require_regular(snapshot / relative)
        if path.stat().st_size != entry['bytes'] or digest_file(path) != entry['sha256']:
            raise ValueError('snapshot_member_mismatch')
    if not {'db.dump', 'auth/auth.db', 'secrets/storage.key'}.issubset(expected):
        raise ValueError('snapshot_required_member_missing')
    roots = data.get('roots')
    if not isinstance(roots, list):
        raise ValueError('snapshot_roots_missing')
    expected_dirs = set()
    for entry in roots:
        relative = entry.get('path') if isinstance(entry, dict) else None
        if (not isinstance(entry, dict) or entry.get('kind') != 'directory' or not isinstance(relative, str) or
            not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', relative) or
            '..' in relative.split('/') or relative in expected_dirs):
            raise ValueError('snapshot_root_invalid')
        expected_dirs.add(relative)
    if not {'auth', 'attachments', 'state', 'config', 'secrets'}.issubset(expected_dirs):
        raise ValueError('snapshot_required_root_missing')
    for relative in expected:
        if relative == 'manifest.json':
            continue
        for parent in Path(relative).parents:
            if parent != Path('.') and parent.as_posix() not in expected_dirs:
                raise ValueError('snapshot_member_parent_missing')
    actual = set()
    actual_dirs = set()
    for directory, dirs, files in os.walk(snapshot, followlinks=False, onerror=abort_walk):
        for name in dirs + files:
            candidate = Path(directory) / name
            if stat.S_ISLNK(candidate.lstat().st_mode):
                raise ValueError('snapshot_symlink')
        for name in dirs:
            actual_dirs.add((Path(directory) / name).relative_to(snapshot).as_posix())
        for name in files:
            actual.add((Path(directory) / name).relative_to(snapshot).as_posix())
    if actual != expected or actual_dirs != expected_dirs:
        raise ValueError('snapshot_extra_or_missing')
    return hashlib.sha256(content).hexdigest(), data


def check_restored_state(source_root, target_root):
    def inventory(root):
        base = Path(root) / 'state'
        if not base.is_dir() or stat.S_ISLNK(base.lstat().st_mode):
            raise ValueError('state_root_invalid')
        result = {}
        for directory, dirs, files in os.walk(base, followlinks=False, onerror=abort_walk):
            for name in dirs + files:
                child = Path(directory) / name
                info = child.lstat()
                if stat.S_ISLNK(info.st_mode):
                    raise ValueError('state_symlink')
                relative = child.relative_to(base).as_posix()
                if name in dirs:
                    if not stat.S_ISDIR(info.st_mode):
                        raise ValueError('state_special_directory')
                    result[relative] = ('directory',)
                else:
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise ValueError('state_special_file')
                    result[relative] = ('file', info.st_size, digest_file(child))
        return result
    if inventory(source_root) != inventory(target_root):
        raise ValueError('restored_state_mismatch')


def check_container_stopped(name, project):
    result = subprocess.run(['docker', 'inspect', '--format',
        '{{.State.Status}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}',
        name], capture_output=True, text=True, timeout=20)
    valid = ({f'created|{project}|app', f'exited|{project}|app'} if project == 'sanyulog'
             else {f'exited|{project}|app'})
    if result.returncode or result.stdout.strip() not in valid:
        raise ValueError('app_not_stopped_or_wrong_identity')


def check_hostname(role):
    expected = 'dev-linux' if role == 'source' else 'VM-0-3-ubuntu'
    if socket.gethostname() != expected:
        raise ValueError('host_identity_mismatch')


def write_evidence(path, payload):
    path = Path(path)
    parent = path.parent
    for ancestor in (parent, *parent.parents):
        if not ancestor.is_dir() or stat.S_ISLNK(ancestor.lstat().st_mode):
            raise ValueError('output_directory_invalid')
    if os.name != 'nt' and (stat.S_IMODE(parent.stat().st_mode) & 0o077):
        raise ValueError('output_directory_public')
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        if hasattr(os, 'fchmod'):
            os.fchmod(stream.fileno(), 0o600)
        else:
            os.chmod(path, 0o600)
        try:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        except Exception:
            raise
    return hashlib.sha256(encoded).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=('source', 'target'), required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--db-container', required=True)
    parser.add_argument('--db-user', required=True)
    parser.add_argument('--db-name', required=True)
    parser.add_argument('--app-container', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    try:
        check_hostname(args.role)
        root = Path(args.root)
        snapshot = Path(args.snapshot)
        if args.role == 'source':
            if (root.parent != SOURCE_ROOT or not re.fullmatch(r'snapshot-\d{8}T\d{6}Z', root.name) or
                snapshot != root or args.db_container != 'dev-postgres' or args.db_user != 'process_log' or
                args.db_name != 'process_log' or args.app_container != 'process-log'):
                raise ValueError('source_identity')
            project = 'process-log'
        else:
            if (root != TARGET_ROOT or snapshot.parent != TARGET_BACKUPS or
                not re.fullmatch(r'snapshot-\d{8}T\d{6}Z', snapshot.name) or
                args.db_container != 'sanyulog-postgres-1' or args.db_user != 'sanyulog' or
                args.db_name != 'sanyulog' or args.app_container != 'sanyulog-app-1'):
                raise ValueError('target_identity')
            project = 'sanyulog'
        output = Path(args.output)
        expected_output_root = (SOURCE_ROOT if args.role == 'source' else TARGET_BACKUPS) / 'evidence'
        if output.parent != expected_output_root or not re.fullmatch(r'migration-(?:source|target)-\d{8}T\d{6}Z\.json', output.name):
            raise ValueError('output_identity')
        check_container_stopped(args.app_container, project)
        manifest_hash, manifest = validate_manifest(snapshot)
        auth_db = root / 'auth' / 'auth.db'
        key_file = root / 'secrets' / 'storage.key'
        attachments = root / 'attachments'
        check_auth_directory(auth_db.parent)
        auth = collect_auth(auth_db)
        rows = capture_postgres(args.db_container, args.db_user, args.db_name,
                                {storage_id for storage_id, _ in auth['accounts']})
        dataset = collect_dataset(auth_db, key_file, attachments, rows)
        ensure_auth_stable(auth, dataset)
        if args.role == 'target':
            member = {entry['path']: entry for entry in manifest['members']}
            if dataset['authDbSha256'] != member['auth/auth.db']['sha256'] or dataset['storageKeySha256'] != member['secrets/storage.key']['sha256']:
                raise ValueError('restored_identity_mismatch')
            check_restored_state(snapshot, root)
        check_container_stopped(args.app_container, project)
        dataset.update(host='172.16.240.13' if args.role == 'source' else '43.131.245.43',
                       snapshotManifestSha256=manifest_hash)
        if args.role == 'source':
            dataset.update(sourceStopped=True, snapshotComplete=True)
        else:
            dataset.update(postgresMajor=18, restoreComplete=True)
        digest = write_evidence(args.output, dataset)
        print(json.dumps(dict(ok=True, role=args.role, evidenceSha256=digest,
                              accountCount=len(dataset['accounts']), mediaCount=len(dataset['media'])),
                         sort_keys=True))
        return 0
    except Exception:
        print(json.dumps(dict(ok=False, error='collector_failed'), sort_keys=True))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
