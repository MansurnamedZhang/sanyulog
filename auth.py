"""Single-owner authentication with revocable, hashed persistent sessions."""
import argparse
import getpass
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA = '''
CREATE TABLE account(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt BLOB NOT NULL, password_hash BLOB NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL);
CREATE TABLE attempts(peer TEXT NOT NULL, created REAL NOT NULL);
CREATE INDEX attempts_created ON attempts(created);
'''

class RateLimited(ValueError):
    pass

class Auth:
    def __init__(self, path, days=7):
        self.path = Path(path)
        if not 1 <= int(days) <= 30: raise ValueError('登录有效期必须为 1 至 30 天')
        self.seconds = int(days) * 86400
        if not self.path.is_file():
            raise ValueError('请先使用 auth.py 初始化管理员账号，拒绝在未配置账号时开放服务')
        with self.connection() as c:
            if c.execute('SELECT count(*) FROM account').fetchone()[0] != 1:
                raise ValueError('管理员账号配置损坏')

    @contextmanager
    def connection(self):
        c = sqlite3.connect(self.path, timeout=20)
        try:
            c.execute('PRAGMA secure_delete=ON')
            with c:
                c.execute('BEGIN IMMEDIATE')
                yield c
        finally:
            c.close()

    @staticmethod
    def password_hash(password, salt):
        return hashlib.scrypt(password.encode(), salt=salt, n=32768, r=8, p=3, maxmem=64*1024*1024, dklen=32)

    @staticmethod
    def validate_password(password):
        if not isinstance(password, str) or not 12 <= len(password) <= 256:
            raise ValueError('密码长度须为 12 至 256 个字符')

    @classmethod
    def initialize(cls, path, username, password, reset=False):
        cls.validate_password(password)
        if not isinstance(username, str) or not 1 <= len(username.strip()) <= 64:
            raise ValueError('用户名长度须为 1 至 64 个字符')
        path = Path(path)
        if reset:
            auth = cls(path)
            with auth.connection() as c:
                salt = secrets.token_bytes(16)
                c.execute('UPDATE account SET username=?,salt=?,password_hash=? WHERE id=1', (username.strip(), salt, cls.password_hash(password, salt)))
                c.execute('DELETE FROM sessions')
                c.execute('DELETE FROM attempts')
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as error:
            raise ValueError('账号文件已存在；重置须显式使用 --reset') from error
        os.close(fd)
        c = sqlite3.connect(path)
        try:
            c.executescript(SCHEMA)
            salt = secrets.token_bytes(16)
            with c:
                c.execute('INSERT INTO account VALUES (1,?,?,?)', (username.strip(), salt, cls.password_hash(password, salt)))
        finally:
            c.close()

    @staticmethod
    def token_hash(token):
        if not isinstance(token, str) or len(token) != 43 or any(ch not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' for ch in token):
            return ''
        return hashlib.sha256(token.encode()).hexdigest()

    def user(self, token):
        digest = self.token_hash(token)
        if not digest: return None
        with self.connection() as c:
            row = c.execute('SELECT username FROM account WHERE EXISTS (SELECT 1 FROM sessions WHERE token_hash=? AND expires>?)', (digest, time.time())).fetchone()
            return row[0] if row else None

    def check_rate(self, c, peer):
        now = time.time()
        c.execute('DELETE FROM attempts WHERE created<?', (now-900,))
        peer = hashlib.sha256(peer.encode()).hexdigest()
        if c.execute('SELECT count(*) FROM attempts WHERE peer=?', (peer,)).fetchone()[0] >= 10 or c.execute('SELECT count(*) FROM attempts').fetchone()[0] >= 1000:
            raise RateLimited('尝试次数过多，请 15 分钟后重试')
        return peer

    def verify(self, row, username, password):
        if not isinstance(password, str) or len(password) > 256 or not isinstance(username, str): return False
        matches = hmac.compare_digest(self.password_hash(password, row[1]), row[2])
        return hmac.compare_digest(username.encode(), row[0].encode()) and matches

    def login(self, username, password, peer):
        with self.connection() as c:
            peer_hash = self.check_rate(c, peer)
            row = c.execute('SELECT username,salt,password_hash FROM account').fetchone()
            if not self.verify(row, username, password):
                c.execute('INSERT INTO attempts VALUES (?,?)', (peer_hash, time.time()))
                return None
            c.execute('DELETE FROM attempts WHERE peer=?', (peer_hash,))
            c.execute('DELETE FROM sessions WHERE expires<=?', (time.time(),))
            c.execute('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions ORDER BY created DESC LIMIT -1 OFFSET 49)')
            token = secrets.token_urlsafe(32)
            now = time.time()
            c.execute('INSERT INTO sessions VALUES (?,?,?)', (self.token_hash(token), now, now+self.seconds))
            return token

    def logout(self, token):
        with self.connection() as c:
            c.execute('DELETE FROM sessions WHERE token_hash=?', (self.token_hash(token),))

    def change_password(self, token, password, new_password, peer):
        self.validate_password(new_password)
        with self.connection() as c:
            peer_hash = self.check_rate(c, peer)
            if not c.execute('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?', (self.token_hash(token), time.time())).fetchone(): return False
            row = c.execute('SELECT username,salt,password_hash FROM account').fetchone()
            if not self.verify(row, row[0], password):
                c.execute('INSERT INTO attempts VALUES (?,?)', (peer_hash, time.time()))
                return False
            salt = secrets.token_bytes(16)
            c.execute('UPDATE account SET salt=?,password_hash=? WHERE id=1', (salt, self.password_hash(new_password, salt)))
            c.execute('DELETE FROM sessions')
            c.execute('DELETE FROM attempts')
            return True

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='初始化或重置过程簿管理员账号；不会修改笔记或加密密钥')
    parser.add_argument('--db', required=True)
    parser.add_argument('--username', default='admin')
    parser.add_argument('--reset', action='store_true')
    args = parser.parse_args()
    password = getpass.getpass('新密码（至少 12 字符）: ')
    if password != getpass.getpass('再次输入: '): raise SystemExit('两次密码不一致')
    Auth.initialize(args.db, args.username, password, reset=args.reset)
    print('账号已配置。')
