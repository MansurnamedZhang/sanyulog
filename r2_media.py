"""Private R2 mirror for existing StorageCipher attachment envelopes.

This layer never authorizes a browser request: callers must derive storage_id
from the authenticated account and authorize the attachment record first.
"""
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from storage_crypto import MAGIC


class R2Error(ValueError):
    """Safe diagnostic without SDK details, URLs, or credential contents."""
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class R2Credentials:
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)

    @classmethod
    def load(cls, path: Path) -> 'R2Credentials':
        # Windows mode bits do not establish ACL privacy. The deployed Linux
        # container must load its own restricted, read-only credential mount.
        if os.name != 'posix':
            raise R2Error('R2 credential privacy requires POSIX permissions')
        try:
            path = Path(path).absolute()
            for part in (path, *path.parents):
                if part.is_symlink():
                    raise ValueError('symlink')
            before = path.lstat()
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                        or info.st_uid not in (0, os.geteuid())
                        or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)):
                    raise ValueError('unsafe credential file')
                raw = source.read(65537)
                if len(raw) > 65536:
                    raise ValueError('oversized credential file')
            def unique_fields(pairs):
                result = {}
                for name, value in pairs:
                    if name in result:
                        raise ValueError('duplicate field')
                    result[name] = value
                return result
            data = json.loads(raw, object_pairs_hook=unique_fields)
            if (not isinstance(data, dict)
                    or set(data) != {'access_key_id', 'secret_access_key'}
                    or any(not isinstance(value, str) or not value.strip() for value in data.values())):
                raise ValueError('invalid schema')
            return cls(**data)
        except Exception:
            raise R2Error('R2 credential file is missing, unsafe, or invalid') from None


def object_key(storage_id: str, digest: str) -> str:
    if (not isinstance(storage_id, str)
            or (storage_id != 'owner' and not re.fullmatch('[a-f0-9]{32}', storage_id))):
        raise ValueError('Invalid account storage identifier')
    if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
        raise ValueError('Invalid attachment SHA-256')
    return f'v1/{storage_id}/{digest}'


def create_r2_client(account_id, credentials):
    if not isinstance(account_id, str) or not re.fullmatch('[a-f0-9]{32}', account_id):
        raise ValueError('Invalid Cloudflare account identifier')
    try:
        import boto3
        from botocore.config import Config
        return boto3.client(
            's3', endpoint_url=f'https://{account_id}.r2.cloudflarestorage.com',
            region_name='auto', aws_access_key_id=credentials.access_key_id,
            aws_secret_access_key=credentials.secret_access_key,
            config=Config(connect_timeout=5, read_timeout=30,
                          retries={'mode': 'standard', 'total_max_attempts': 3}))
    except Exception:
        raise R2Error('Unable to create private R2 client') from None


class R2Mirror:
    def __init__(self, client, bucket: str):
        if not isinstance(bucket, str) or not bucket:
            raise ValueError('R2 bucket is required')
        self.client = client
        self.bucket = bucket

    def _call(self, operation, key, **kwargs):
        try:
            return getattr(self.client, operation)(Bucket=self.bucket, Key=key, **kwargs)
        except Exception as error:
            response = getattr(error, 'response', {})
            code = response.get('Error', {}).get('Code') if isinstance(response, dict) else None
            if code in ('404', 'NoSuchKey', 'NotFound'):
                raise R2Error('R2 object not found', 'not_found') from None
            if code in ('412', 'PreconditionFailed'):
                raise R2Error('R2 object already exists', 'exists') from None
            raise R2Error('Private R2 operation failed') from None

    @staticmethod
    def _check_metadata(response, ciphertext):
        if (response.get('ContentLength') != len(ciphertext)
                or response.get('Metadata', {}).get('ciphertext-sha256') != hashlib.sha256(ciphertext).hexdigest()
                or response.get('ContentType') != 'application/octet-stream'
                or not ciphertext.startswith(MAGIC)):
            raise R2Error('R2 ciphertext integrity check failed')

    @staticmethod
    def _plaintext(ciphertext, digest, cipher):
        try:
            if cipher.aes is None or not ciphertext.startswith(MAGIC):
                raise ValueError('encrypted envelope required')
            plaintext = cipher.decrypt(ciphertext, 'attachment:' + digest)
            if hashlib.sha256(plaintext).hexdigest() != digest:
                raise ValueError('plaintext hash mismatch')
            return plaintext
        except Exception:
            raise R2Error('R2 attachment plaintext verification failed') from None

    def _read(self, key, head):
        response = self._call('get_object', key)
        try:
            body = response['Body']
            try:
                length = head['ContentLength']
                if not isinstance(length, int) or not 0 <= length <= 25 * 1024 * 1024 + len(MAGIC) + 28:
                    raise ValueError('invalid length')
                ciphertext = body.read(length + 1)
            finally:
                body.close()
            self._check_metadata(head, ciphertext)
            self._check_metadata(response, ciphertext)
            return ciphertext
        except Exception:
            raise R2Error('R2 ciphertext integrity check failed') from None

    def get_ciphertext(self, storage_id, digest) -> bytes:
        key = object_key(storage_id, digest)
        return self._read(key, self._call('head_object', key))

    def put_ciphertext(self, storage_id, digest, ciphertext, cipher) -> None:
        key = object_key(storage_id, digest)
        plaintext = self._plaintext(ciphertext, digest, cipher)
        try:
            head = self._call('head_object', key)
        except R2Error as error:
            if error.code != 'not_found':
                raise
            try:
                self._call('put_object', key, Body=ciphertext,
                           ContentType='application/octet-stream', IfNoneMatch='*',
                           Metadata={'ciphertext-sha256': hashlib.sha256(ciphertext).hexdigest()})
            except R2Error as upload_error:
                if upload_error.code != 'exists':
                    raise
            head = self._call('head_object', key)
        # An existing envelope may legitimately have a different random nonce.
        # Always verify the stored bytes and plaintext; never overwrite a key.
        stored = self._read(key, head)
        if self._plaintext(stored, digest, cipher) != plaintext:
            raise R2Error('Existing R2 attachment conflicts with upload')

    def delete_ciphertext(self, storage_id, digest) -> None:
        self._call('delete_object', object_key(storage_id, digest))
