"""Auditable private-media reconciliation; dry-run unless explicitly applied.

No Store/Auth constructors: inventory must never migrate or initialize data.
The durable pending-work ledger is the full difference between DB references,
local ciphertext files and the dedicated account's R2 prefix. Run after local
restore, interrupted upload, or deletion; local restore is not cloud completion.

SQLite attachments_root is <data>/attachments; account DBs/files are under
<data>/accounts/<storage_id>. PostgreSQL uses the exact owner attachment mount,
with account files under <attachments_root>/accounts/<storage_id>.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import sqlite3
import stat
import sys
import uuid

from r2_media import R2Credentials, R2Error, R2Mirror, create_r2_client, object_key
from storage_crypto import MAGIC, StorageCipher
from store import checked_media_path, media_lock

BUCKET = 'sanyulog-media'
LIMIT = 25 * 1024 * 1024
LOG = logging.getLogger('r2_reconcile')


@dataclass(frozen=True)
class MediaItem:
    storage_id: str
    digest: str
    size: int
    reference_count: int
    status: str
    ciphertext_size: int | None = None
    ciphertext_sha256: str | None = None

    def manifest(self):
        return dict(storage_id=self.storage_id, key=object_key(self.storage_id, self.digest),
                    plaintext_sha256=self.digest, plaintext_size=self.size,
                    references=self.reference_count, status=self.status,
                    ciphertext_size=self.ciphertext_size, ciphertext_sha256=self.ciphertext_sha256)


@dataclass(frozen=True)
class AccountScope:
    storage_id: str
    enabled: bool
    initialized: bool
    files: Path = field(repr=False)
    db: Path | None = field(repr=False)
    schema: str | None = field(repr=False)


class Inventory(list):
    """A live scan's references plus scopes, including empty/absent accounts.

    A plain list/serialized manifest has no deletion authority. Explicit
    for_account() selection is required for apply. Apply never trusts the
    list's contents: it reopens auth and rereads the DB under the writer lock.
    """
    def __init__(self, items, accounts, inputs, selected=None):
        super().__init__(items)
        self.accounts = tuple(accounts)
        self._inputs = inputs
        self._selected = selected

    def for_account(self, storage_id):
        object_key(storage_id, '0' * 64)
        scopes = [a for a in self.accounts if a.storage_id == storage_id]
        if len(scopes) != 1:
            raise ValueError('Account is not in the validated auth inventory')
        return Inventory([i for i in self if i.storage_id == storage_id], scopes, self._inputs, storage_id)

    def manifest(self):
        return {'apply': False, 'complete': all(i.status == 'verified_local' for i in self),
                'cloud_verified': False, 'accounts': [dict(storage_id=a.storage_id, enabled=a.enabled,
                 initialized=a.initialized) for a in self.accounts], 'media': [i.manifest() for i in self]}


@dataclass
class SyncReport:
    apply: bool
    entries: list = field(default_factory=list)
    complete: bool = True
    run_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def record(self, storage_id, digest, status, **details):
        event = dict(storage_id=storage_id, status=status, **details)
        if digest is not None:
            event['key'] = object_key(storage_id, digest)
        self.entries.append(event)
        self.audit(event)

    def audit(self, event):
        LOG.info(json.dumps(dict(run_id=self.run_id, at=datetime.now(timezone.utc).isoformat(),
                                 apply=self.apply, **event), sort_keys=True))

    def manifest(self):
        return dict(run_id=self.run_id, apply=self.apply, complete=self.complete, entries=self.entries)


class PruneReport(SyncReport):
    pass


@contextmanager
def _sqlite(path, *, apply=False):
    path = checked_media_path(path)
    if not path.is_file():
        raise ValueError('Existing database is unavailable')
    c = sqlite3.connect(path.as_uri() + ('?mode=rw' if apply else '?mode=ro'), uri=True, timeout=30)
    try:
        c.execute('PRAGMA trusted_schema=OFF')
        if not apply:
            c.execute('PRAGMA query_only=ON')
        c.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        yield c
    finally:
        c.rollback()
        c.close()


def _auth_accounts(auth_db):
    with _sqlite(auth_db) as c:
        rows = c.execute('SELECT storage_id,enabled FROM users ORDER BY storage_id').fetchall()
    seen = set()
    for storage_id, enabled in rows:
        object_key(storage_id, '0' * 64)
        if storage_id in seen or enabled not in (0, 1):
            raise ValueError('Invalid account inventory')
        seen.add(storage_id)
    return rows


@contextmanager
def _pg(database_url, *, apply=False):
    import psycopg
    options = '-c statement_timeout=60000 -c lock_timeout=30000'
    if not apply:
        options += ' -c default_transaction_read_only=on'
    with psycopg.connect(database_url, connect_timeout=10, options=options) as c:
        if apply:
            c.execute('SELECT pg_advisory_xact_lock(728351024)')
        yield c
        c.rollback()


def _pg_exists(c, schema):
    # Both schema and table must already exist; no CREATE or search_path fallback.
    return c.execute("SELECT 1 FROM information_schema.tables WHERE table_schema=%s "
                     "AND table_name='attachments' AND table_type='BASE TABLE'", (schema,)).fetchone() is not None


def _pg_verify_key(c, scope, cipher):
    row = c.execute('SELECT value FROM "'+scope.schema+'".settings WHERE key=%s', ('encryption-check',)).fetchone()
    if row:
        cipher.columns_encrypted = True
        if cipher.open(row[0], 'value') != 'process-log-storage-v1':
            raise ValueError('Invalid storage key')


def _rows(c, scope):
    prefix = '"'+scope.schema+'".' if scope.schema else ''
    rows = c.execute('SELECT file,size FROM '+prefix+'attachments').fetchall()
    result = {}
    for digest, size in rows:
        object_key(scope.storage_id, digest)
        if type(size) is not int or size < 0:
            raise ValueError('Invalid attachment reference')
        old_size, count = result.get(digest, (size, 0))
        if old_size != size:
            raise ValueError('Conflicting attachment reference sizes')
        result[digest] = (size, count + 1)
    return result


def _read_local(scope, digest):
    object_key(scope.storage_id, digest)
    path = checked_media_path(scope.files / digest)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise ValueError('Unsafe attachment file')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if ((before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)
                or info.st_size > LIMIT + len(MAGIC) + 28):
            raise ValueError('Unsafe or oversized attachment file')
        return source.read(LIMIT + len(MAGIC) + 29)


def _local_item(scope, digest, size, count, cipher):
    if size > LIMIT:
        return MediaItem(scope.storage_id, digest, size, count, 'oversize')
    try:
        blob = _read_local(scope, digest)
        plaintext = R2Mirror._plaintext(blob, digest, cipher)
        if len(plaintext) != size:
            raise ValueError('Attachment size mismatch')
        return MediaItem(scope.storage_id, digest, size, count, 'verified_local', len(blob), hashlib.sha256(blob).hexdigest())
    except (OSError, ValueError):
        return MediaItem(scope.storage_id, digest, size, count, 'local_invalid')


def build_inventory(auth_db, database_url, attachments_root, key_file) -> list[MediaItem]:
    """Read only existing auth/DB references, never orphan files as upload input."""
    try:
        root = checked_media_path(attachments_root)
        if not root.is_dir() or (not database_url and root.name != 'attachments'):
            raise ValueError('Invalid owner attachment root')
        key_file = checked_media_path(key_file)
        cipher = StorageCipher(key_file)
        if cipher.aes is None:
            raise ValueError('Original storage key required')
        accounts, items = [], []
        for storage_id, enabled in _auth_accounts(auth_db):
            schema = ('public' if storage_id == 'owner' else 'process_log_user_'+storage_id) if database_url else None
            if database_url:
                files = root if storage_id == 'owner' else root / 'accounts' / storage_id
                db = None
                with _pg(database_url) as c:
                    initialized = _pg_exists(c, schema)
                    scope = AccountScope(storage_id, bool(enabled), initialized, checked_media_path(files), db, schema)
                    if initialized:
                        _pg_verify_key(c, scope, cipher)
                    refs = _rows(c, scope) if initialized else {}
            else:
                data = root.parent if storage_id == 'owner' else root.parent / 'accounts' / storage_id
                db, files = checked_media_path(data / 'process.db'), checked_media_path(data / 'attachments')
                initialized = db.is_file()
                scope = AccountScope(storage_id, bool(enabled), initialized, files, db, None)
                if initialized:
                    with _sqlite(db) as c:
                        cipher.configure(c)  # Verify original key, without migrations.
                        refs = _rows(c, scope)
                else:
                    refs = {}
            accounts.append(scope)
            items.extend(_local_item(scope, digest, size, count, cipher) for digest, (size, count) in sorted(refs.items()))
        return Inventory(items, accounts, (Path(auth_db), database_url, root, key_file))
    except Exception:
        raise ValueError('Media inventory validation failed') from None


def _validate_inventory(items, mirror, apply):
    if not isinstance(items, Inventory) or mirror.bucket != BUCKET:
        raise ValueError('Validated live inventory and dedicated private bucket required')
    if apply and (items._selected is None or len(items.accounts) != 1):
        raise ValueError('Apply requires explicit single-account selection')


@contextmanager
def _live_scope(items, account, apply):
    auth_db, database_url, root, key_file = items._inputs
    if account.storage_id not in dict(_auth_accounts(auth_db)):
        raise ValueError('Account no longer exists')
    cipher = StorageCipher(checked_media_path(key_file))
    if database_url:
        with _pg(database_url, apply=apply) as c:
            if not _pg_exists(c, account.schema):
                raise ValueError('Account data area is uninitialized')
            # Verify the key against metadata even when there are no attachments.
            _pg_verify_key(c, account, cipher)
            yield _rows(c, account), cipher
    else:
        if not account.db.is_file():
            raise ValueError('Account data area is uninitialized')
        if apply:
            with media_lock(account.db.parent), _sqlite(account.db, apply=True) as c:
                cipher.configure(c)
                yield _rows(c, account), cipher
        else:
            with _sqlite(account.db) as c:
                cipher.configure(c)
                yield _rows(c, account), cipher


def sync_inventory(items, mirror, *, apply=False) -> SyncReport:
    _validate_inventory(items, mirror, apply)
    report = SyncReport(apply)
    for scope in items.accounts:
        try:
            with _live_scope(items, scope, apply) as (refs, cipher):
                for digest, (size, count) in sorted(refs.items()):
                    item = _local_item(scope, digest, size, count, cipher)
                    if item.status != 'verified_local':
                        report.complete = False
                        report.record(scope.storage_id, digest, item.status)
                        continue
                    try:
                        blob = _read_local(scope, digest)
                        if apply:
                            report.audit(dict(storage_id=scope.storage_id, key=object_key(scope.storage_id, digest), status='sync_intent'))
                            mirror.put_ciphertext(scope.storage_id, digest, blob, cipher)
                        remote = mirror.get_ciphertext(scope.storage_id, digest)
                        if len(R2Mirror._plaintext(remote, digest, cipher)) != size:
                            raise ValueError('Remote length mismatch')
                        report.record(scope.storage_id, digest, 'verified_remote',
                                      local_ciphertext_sha256=hashlib.sha256(blob).hexdigest(),
                                      remote_ciphertext_sha256=hashlib.sha256(remote).hexdigest(),
                                      ciphertext_size=len(remote))
                    except (OSError, ValueError) as error:
                        report.complete = False
                        status = 'pending_sync' if isinstance(error, R2Error) and error.code == 'not_found' else 'sync_failed'
                        report.record(scope.storage_id, digest, status)
        except Exception:
            report.complete = False
            report.record(scope.storage_id, None, 'account_unavailable')
    return report


def _remote_digests(mirror, storage_id):
    prefix = object_key(storage_id, '0' * 64)[:-64]
    keys, tokens, token = set(), set(), None
    while True:
        kwargs = dict(Bucket=BUCKET, Prefix=prefix)
        if token is not None:
            kwargs['ContinuationToken'] = token
        page = mirror.client.list_objects_v2(**kwargs)
        for entry in page.get('Contents', []):
            key = entry['Key']
            digest = key[len(prefix):] if isinstance(key, str) and key.startswith(prefix) else ''
            if object_key(storage_id, digest) != key:
                raise ValueError('Invalid scoped listing')
            keys.add(digest)
        if page.get('IsTruncated') is False:
            return keys
        token = page.get('NextContinuationToken')
        if not isinstance(token, str) or not token or token in tokens:
            raise ValueError('Incomplete scoped listing')
        tokens.add(token)


def _local_digests(scope):
    path = checked_media_path(scope.files)
    if not path.exists():
        return set()
    result = set()
    for child in path.iterdir():
        # Only validated content-addressed files are eligible. Never recurse,
        # follow a link, or delete temporary/unknown names (which may be private).
        try:
            object_key(scope.storage_id, child.name)
        except ValueError:
            continue
        result.add(child.name)
    return result


def prune_unreferenced(items, mirror, *, apply=False) -> PruneReport:
    _validate_inventory(items, mirror, apply)
    report = PruneReport(apply)
    for scope in items.accounts:
        try:
            with _live_scope(items, scope, apply) as (refs, cipher):
                remote, local = _remote_digests(mirror, scope.storage_id), _local_digests(scope)
                # Fully validate the listing before any deletion. DB transaction
                # and the writer lock remain held across the complete operation.
                for digest in sorted((remote | local) - set(refs)):
                    try:
                        if digest in local:
                            R2Mirror._plaintext(_read_local(scope, digest), digest, cipher)
                        if not apply:
                            report.complete = False
                            report.record(scope.storage_id, digest, 'pending_prune')
                            continue
                        report.audit(dict(storage_id=scope.storage_id, key=object_key(scope.storage_id, digest), status='prune_intent'))
                        if digest in remote:
                            mirror.delete_ciphertext(scope.storage_id, digest)
                            try:
                                mirror.get_ciphertext(scope.storage_id, digest)
                            except R2Error as error:
                                if error.code != 'not_found':
                                    raise
                            else:
                                raise ValueError('Deletion not verified')
                        if digest in local:
                            path = checked_media_path(scope.files / digest)
                            # Revalidate immediately before unlink; never recurse.
                            R2Mirror._plaintext(_read_local(scope, digest), digest, cipher)
                            path.unlink()
                        report.record(scope.storage_id, digest, 'pruned')
                    except Exception:
                        report.complete = False
                        report.record(scope.storage_id, digest, 'prune_failed')
        except Exception:
            report.complete = False
            report.record(scope.storage_id, None, 'account_unavailable')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('inventory', 'sync', 'prune'))
    parser.add_argument('--auth-db', required=True)
    parser.add_argument('--attachments-root', required=True)
    parser.add_argument('--key-file', required=True)
    parser.add_argument('--storage-id')
    parser.add_argument('--bucket')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    if args.apply and (args.command == 'inventory' or not args.storage_id or args.bucket != BUCKET):
        parser.error('Apply requires sync/prune, explicit --storage-id and --bucket sanyulog-media')
    if args.bucket not in (None, BUCKET):
        parser.error('Only the dedicated private bucket is supported')
    try:
        items = build_inventory(args.auth_db, os.environ.get('DATABASE_URL'), args.attachments_root, args.key_file)
        if args.storage_id:
            items = items.for_account(args.storage_id)
        if args.command == 'inventory':
            manifest = items.manifest()
            print(json.dumps(manifest, sort_keys=True), flush=True)
            return 0 if manifest['complete'] else 2
        credentials = R2Credentials.load(Path(os.environ['PROCESS_LOG_R2_CREDENTIALS_FILE']))
        mirror = R2Mirror(create_r2_client(os.environ['PROCESS_LOG_R2_ACCOUNT_ID'], credentials), BUCKET)
        report = (sync_inventory if args.command == 'sync' else prune_unreferenced)(items, mirror, apply=args.apply)
        print(json.dumps(report.manifest(), sort_keys=True), flush=True)
        return 0 if report.complete else 2
    except Exception:
        print(json.dumps({'complete': False, 'error': 'Reconciliation failed validation or access checks'}), file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    # Only this audit logger is enabled; do not enable SDK diagnostics.
    LOG.addHandler(logging.StreamHandler())
    LOG.setLevel(logging.INFO)
    LOG.propagate = False
    raise SystemExit(main())
