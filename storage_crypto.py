"""Versioned AES-256-GCM envelopes for server-managed storage encryption."""
import base64
import os
import sqlite3
from pathlib import Path
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b'PROCESSLOG-AESGCM-1\x00'
TEXT_PREFIX = 'plenc:v1:'
COLUMNS = {
    'projects': ('id', ['name']),
    'records': ('id', ['title', 'status', 'goal', 'params', 'tags', 'result', 'conclusion', 'next_step']),
    'entries': ('id', ['kind', 'body']),
    'attachments': ('id', ['name', 'mime']),
    'settings': ('key', ['value']),
    'notebooks': ('record_id', ['cells']),
}
SENSITIVE = {column for _, columns in COLUMNS.values() for column in columns}

class StorageCipher:
    def __init__(self, key_file=None):
        self.key_file = key_file
        self.aes = None
        self.columns_encrypted = False
        if key_file:
            key = Path(key_file).read_bytes()
            if len(key) != 32:
                raise ValueError('加密密钥文件必须为 32 字节，不能使用密码或自动替换已有密钥')
            self.aes = AESGCM(key)

    def encrypt(self, data, context):
        if self.aes is None: return data
        nonce = os.urandom(12)
        return MAGIC + nonce + self.aes.encrypt(nonce, data, context.encode())

    def decrypt(self, data, context):
        if not data.startswith(MAGIC): return data
        if self.aes is None: raise ValueError('数据已加密，必须配置原始加密密钥文件')
        payload = data[len(MAGIC):]
        try:
            return self.aes.decrypt(payload[:12], payload[12:], context.encode())
        except (InvalidTag, ValueError) as error:
            raise ValueError('无法解密：密钥错误或加密数据已损坏') from error

    def seal(self, value, column):
        if self.aes is None or not self.columns_encrypted: return value
        return TEXT_PREFIX + base64.b64encode(self.encrypt(value.encode(), 'column:'+column)).decode()

    def open(self, value, column):
        if not self.columns_encrypted: return value
        if not isinstance(value, str) or not value.startswith(TEXT_PREFIX):
            raise ValueError('加密数据库字段格式损坏')
        try:
            raw = base64.b64decode(value[len(TEXT_PREFIX):], validate=True)
            if not raw.startswith(MAGIC): raise ValueError('无效的加密数据')
            return self.decrypt(raw, 'column:'+column).decode()
        except (ValueError, UnicodeError) as error:
            raise ValueError('无法解密：密钥缺失、错误或数据已损坏') from error

    def configure(self, connection):
        row = connection.execute("SELECT value FROM settings WHERE key='encryption-check'").fetchone()
        if row:
            self.columns_encrypted = True
            if self.open(row[0], 'value') != 'process-log-storage-v1' or self.aes is None:
                raise ValueError('加密数据库需要原始密钥文件')

    def mapping(self, values):
        return {k: self.seal(v, k) if k in SENSITIVE and isinstance(v, str) else v for k, v in values.items()}

    def sqlite_row(self, cursor, values):
        return sqlite3.Row(cursor, tuple(self.open(v, col[0]) if col[0] in SENSITIVE else v for col, v in zip(cursor.description, values)))
