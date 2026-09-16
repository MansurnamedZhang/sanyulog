"""Multi-account authentication with revocable, hashed persistent sessions."""
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

USER_SCHEMA = 'CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, salt BLOB NOT NULL, password_hash BLOB NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, storage_id TEXT NOT NULL UNIQUE)'
SCHEMA = USER_SCHEMA + ''';
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id));
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
            if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account'").fetchone():
                c.execute(USER_SCHEMA)
                c.execute("INSERT INTO users(id,username,salt,password_hash,is_admin,enabled,storage_id) SELECT id,username,salt,password_hash,1,1,'owner' FROM account")
                c.execute('ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1')
                c.execute('DROP TABLE account')
            if not c.execute('SELECT 1 FROM users WHERE id=1 AND is_admin=1 AND enabled=1').fetchone():
                raise ValueError('管理员账号配置损坏')

    @contextmanager
    def connection(self):
        c = sqlite3.connect(self.path, timeout=20)
        try:
            c.execute('PRAGMA secure_delete=ON')
            c.execute('PRAGMA foreign_keys=ON')
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
        cls.validate_username(username)
        path = Path(path)
        if reset:
            auth = cls(path)
            with auth.connection() as c:
                salt = secrets.token_bytes(16)
                c.execute('UPDATE users SET username=?,salt=?,password_hash=? WHERE id=1', (username.strip(), salt, cls.password_hash(password, salt)))
                c.execute('DELETE FROM sessions WHERE user_id=1')
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
                c.execute("INSERT INTO users(id,username,salt,password_hash,is_admin,enabled,storage_id) VALUES (1,?,?,?,1,1,'owner')", (username.strip(), salt, cls.password_hash(password, salt)))
        finally:
            c.close()

    @staticmethod
    def token_hash(token):
        if not isinstance(token, str) or len(token) != 43 or any(ch not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' for ch in token):
            return ''
        return hashlib.sha256(token.encode()).hexdigest()

    @staticmethod
    def validate_username(username):
        if not isinstance(username, str) or not 1 <= len(username.strip()) <= 64 or any(ch.isspace() or ord(ch)<32 for ch in username.strip()):
            raise ValueError('账号须为 1 至 64 个字符，不能含空格或控制字符')

    def principal(self, token):
        digest = self.token_hash(token)
        if not digest: return None
        with self.connection() as c:
            return self.session_user(c, digest)

    def session_user(self, c, digest):
        row = c.execute('SELECT u.id,u.username,u.is_admin,u.storage_id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>? AND u.enabled=1', (digest,time.time())).fetchone()
        return {'id':row[0], 'username':row[1], 'is_admin':bool(row[2]), 'storage_id':row[3]} if row else None

    def user(self, token):
        person = self.principal(token)
        return person['username'] if person else None

    def require_admin(self, c, token):
        person = self.session_user(c, self.token_hash(token))
        if not person or not person['is_admin']: raise PermissionError('仅管理员可以管理账号')

    def list_users(self, token):
        with self.connection() as c:
            self.require_admin(c,token)
            return [{'id':r[0], 'username':r[1], 'is_admin':bool(r[2]), 'enabled':bool(r[3])} for r in c.execute('SELECT id,username,is_admin,enabled FROM users ORDER BY id')]

    def create_user(self, token, username, password):
        self.validate_username(username)
        self.validate_password(password)
        with self.connection() as c:
            self.require_admin(c,token)
            if c.execute('SELECT 1 FROM users WHERE username=?',(username.strip(),)).fetchone():
                raise ValueError('账号已存在')
            salt=secrets.token_bytes(16)
            identifier=c.execute('INSERT INTO users(username,salt,password_hash,storage_id) VALUES (?,?,?,?)',(username.strip(),salt,self.password_hash(password,salt),secrets.token_hex(16))).lastrowid
            return {'id':identifier, 'username':username.strip(), 'is_admin':False, 'enabled':True}

    def update_user(self, token, identifier, data):
        if identifier == 1: raise ValueError('不能停用或通过此入口重置主管理员，请使用修改密码')
        if not isinstance(data,dict) or not data or set(data)-{'enabled','new_password'}: raise ValueError('账号更新格式无效')
        if 'enabled' in data and not isinstance(data['enabled'],bool): raise ValueError('账号状态必须为布尔值')
        if 'new_password' in data: self.validate_password(data['new_password'])
        with self.connection() as c:
            self.require_admin(c,token)
            if not c.execute('SELECT 1 FROM users WHERE id=?',(identifier,)).fetchone(): raise KeyError('账号不存在')
            if 'enabled' in data: c.execute('UPDATE users SET enabled=? WHERE id=?',(int(data['enabled']),identifier))
            if 'new_password' in data:
                salt=secrets.token_bytes(16)
                c.execute('UPDATE users SET salt=?,password_hash=? WHERE id=?',(salt,self.password_hash(data['new_password'],salt),identifier))
            c.execute('DELETE FROM sessions WHERE user_id=?',(identifier,))

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
            row = c.execute('SELECT username,salt,password_hash,id,enabled FROM users WHERE username=?', (username if isinstance(username,str) else '',)).fetchone()
            candidate = row or c.execute('SELECT username,salt,password_hash,id,enabled FROM users WHERE id=1').fetchone()
            matches = self.verify(candidate, username, password)
            if not row or not row[4] or not matches:
                c.execute('INSERT INTO attempts VALUES (?,?)', (peer_hash, time.time()))
                return None
            c.execute('DELETE FROM sessions WHERE expires<=?', (time.time(),))
            c.execute('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT -1 OFFSET 49)', (row[3],))
            token = secrets.token_urlsafe(32)
            now = time.time()
            c.execute('INSERT INTO sessions(token_hash,created,expires,user_id) VALUES (?,?,?,?)', (self.token_hash(token), now, now+self.seconds, row[3]))
            return token

    def logout(self, token):
        with self.connection() as c:
            c.execute('DELETE FROM sessions WHERE token_hash=?', (self.token_hash(token),))

    def change_password(self, token, password, new_password, peer):
        self.validate_password(new_password)
        with self.connection() as c:
            peer_hash = self.check_rate(c, peer)
            person=self.session_user(c,self.token_hash(token))
            if not person: return False
            row = c.execute('SELECT username,salt,password_hash FROM users WHERE id=?',(person['id'],)).fetchone()
            if not self.verify(row, row[0], password):
                c.execute('INSERT INTO attempts VALUES (?,?)', (peer_hash, time.time()))
                return False
            salt = secrets.token_bytes(16)
            c.execute('UPDATE users SET salt=?,password_hash=? WHERE id=?', (salt, self.password_hash(new_password, salt),person['id']))
            c.execute('DELETE FROM sessions WHERE user_id=?',(person['id'],))
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
