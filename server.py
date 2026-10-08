"""Run with python server.py. Data stays beside this application."""
import argparse
import ipaddress
import json
import mimetypes
import os
import re
import sqlite3
import sys
from http.cookies import SimpleCookie, CookieError
from auth import Auth, RateLimited
from account_stores import AccountStores
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from store import Conflict, Store

BASE = Path(__file__).resolve().parent


def preview_mime(mime, content):
    """Allow only declared passive media with a matching container signature.

    This is a conservative signature check, not a decoder or a codec guarantee.
    Inspect the full verified plaintext before selecting a partial response.
    """
    if mime == 'image/png' and content.startswith(b'\x89PNG\r\n\x1a\n'):
        return mime
    if mime == 'image/jpeg' and content.startswith(b'\xff\xd8\xff'):
        return mime
    if mime == 'image/gif' and content.startswith((b'GIF87a', b'GIF89a')):
        return mime
    if (mime == 'image/webp' and content[:4] == b'RIFF'
            and content[8:12] == b'WEBP' and content[12:16] in (b'VP8 ', b'VP8L', b'VP8X')):
        return mime
    if mime == 'video/mp4' and len(content) >= 16 and content[4:8] == b'ftyp':
        box_size = int.from_bytes(content[:4], 'big')
        # Do not treat every ISO base-media file (e.g. AVIF/HEIC) as an MP4.
        if (16 <= box_size <= len(content) and box_size % 4 == 0
                and content[8:12] in (b'isom', b'iso2', b'mp41', b'mp42', b'avc1', b'M4V ')):
            return mime
    if mime == 'video/webm' and content.startswith(b'\x1a\x45\xdf\xa3'):
        # The EBML DocType signature distinguishes WebM from generic Matroska.
        if b'\x42\x82\x84webm' in content[4:4096]:
            return mime
    if mime == 'audio/mpeg':
        offset = 0
        if (len(content) >= 10 and content[:3] == b'ID3' and content[3] in (2, 3, 4)
                and all(value < 128 for value in content[6:10])):
            tag_size = 0
            for value in content[6:10]:
                tag_size = (tag_size << 7) | value
            offset = 10 + tag_size + (10 if content[3] == 4 and content[5] & 16 else 0)
        frame = content[offset:offset + 4]
        if (len(frame) == 4 and frame[0] == 255 and frame[1] & 224 == 224
                and frame[1] & 24 != 8 and frame[1] & 6 == 2
                and frame[2] >> 4 not in (0, 15) and frame[2] & 12 != 12):
            return mime
    if mime == 'audio/ogg' and len(content) >= 28 and content[:5] == b'OggS\x00':
        packet = 27 + content[26]
        if content[26] and content[packet:packet + 8] == b'OpusHead':
            return mime
        if content[26] and content[packet:packet + 7] == b'\x01vorbis':
            return mime
    if mime == 'audio/wav' and len(content) >= 12 and content[:4] == b'RIFF' and content[8:12] == b'WAVE':
        return mime
    return 'application/octet-stream'


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, fmt, *args):
        pass

    def send(self, data, content_type='application/json; charset=utf-8', status=200, filename=None, inline=False, cookie=None, extra_headers=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        if filename:
            self.send_header('Content-Disposition', ('inline' if inline else 'attachment')+"; filename*=UTF-8''"+quote(filename, safe=''))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def send_attachment(self, metadata, content, *, preview: bool, range_header: str | None) -> None:
        """Called only after the account store authorized and verified the read."""
        mime = preview_mime(metadata['mime'], content)
        headers = {'Accept-Ranges': 'bytes'}
        size = len(content)
        status = 200
        payload = content
        if range_header is not None:
            value = range_header.strip()
            # RFC 9110 requires unknown range units to be ignored.
            if value.partition('=')[0].lower() == 'bytes' or '=' not in value:
                match = re.fullmatch(r'bytes=([0-9]*)-([0-9]*)', value, re.IGNORECASE)
                start, end = 0, -1
                if match and any(match.groups()) and size:
                    first, last = match.groups()
                    def number(digits):
                        # Saturate before conversion: untrusted decimals can exceed Python's int limit.
                        digits = digits.lstrip('0') or '0'
                        return size + 1 if len(digits) > len(str(size)) else int(digits)
                    if first:
                        start = number(first)
                        end = min(number(last), size - 1) if last else size - 1
                    elif number(last):
                        start = max(0, size - number(last))
                        end = size - 1
                if start > end or start >= size:
                    headers['Content-Range'] = f'bytes */{size}'
                    status, payload = 416, b''
                else:
                    headers['Content-Range'] = f'bytes {start}-{end}/{size}'
                    status, payload = 206, content[start:end + 1]
        return self.send(payload, mime, status=status, filename=metadata['name'],
                         inline=preview and mime != 'application/octet-stream', extra_headers=headers)

    def body(self, limit=2*1024*1024):
        length = int(self.headers.get('Content-Length', '0'))
        if length < 0 or length > limit:
            raise ValueError(f'请求过大，最大 {limit // (1024*1024)} MB')
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError('上传不完整，请重试')
        return data

    def auth_peer(self):
        peer = str(ipaddress.ip_address(self.client_address[0]))
        if peer not in self.server.trusted_proxies:
            return peer
        forwarded = self.headers.get('X-Forwarded-For', '')
        if len(forwarded) > 1024: return peer
        try:
            chain = [str(ipaddress.ip_address(value.strip())) for value in forwarded.split(',')]
        except ValueError:
            return peer
        for address in reversed(chain):
            if address not in self.server.trusted_proxies: return address
        return peer

    def session_token(self):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            return cookie['process_log_session'].value if 'process_log_session' in cookie else ''
        except CookieError:
            return ''

    def session_cookie(self, token=''):
        age = self.server.auth.seconds if token else 0
        secure = '; Secure' if self.server.cookie_secure else ''
        return f'process_log_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}{secure}'

    def handle_request(self):
        try:
            host = self.headers.get('Host')
            if len(self.headers.get_all('Host', [])) != 1 or host not in self.server.allowed_hosts:
                return self.send({'error': '访问地址未获允许'}, status=403)
            if self.command != 'GET':
                origin = self.headers.get('Origin')
                if (origin and (origin not in self.server.allowed_origins or urlsplit(origin).netloc != host)) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                    return self.send({'error': '拒绝跨站修改'}, status=403)
                if not origin and self.headers.get('X-Process-Log') != '1':
                    return self.send({'error': '缺少本地请求标识'}, status=403)
            u = urlsplit(self.path)
            path = u.path
            s = self.server.store
            method = self.command
            auth = self.server.auth
            token = self.session_token()
            if path == '/api/auth/status' and method == 'GET':
                person = auth.principal(token) if auth else None
                return self.send({'enabled': bool(auth), 'authenticated': bool(person), 'username': person['username'] if person else None, 'user': person,
                                  'days': auth.seconds // 86400 if auth else None})
            if path == '/api/auth/login' and method == 'POST' and auth:
                if self.headers.get_content_type() != 'application/json': raise ValueError('需要 JSON 格式')
                data = json.loads(self.body(4096))
                if not isinstance(data, dict): raise ValueError('请求必须为对象')
                new_token = auth.login(data.get('username'), data.get('password'), self.auth_peer())
                if not new_token: return self.send({'error': '用户名或密码错误'}, status=401)
                return self.send({'ok': True}, cookie=self.session_cookie(new_token))
            person = auth.principal(token) if auth else None
            if auth and person and path.startswith('/api/') and path != '/api/health':
                expected_account = self.headers.get('X-Process-Log-Account')
                direct_download = method == 'GET' and (path.startswith('/api/attachments/') or path.endswith('/markdown'))
                if not direct_download and not expected_account:
                    return self.send({'error': '页面版本过旧，请刷新页面后继续；原草稿仍保留，无需重复登录', 'code': 'page_refresh_required'}, status=409)
                if not direct_download and expected_account != person['storage_id']:
                    return self.send({'error': '其他标签页已切换账号，请登录原账号继续，或刷新进入当前账号；原草稿仍保留', 'code': 'account_changed'}, status=401)
            if path == '/api/auth/logout' and method == 'POST' and auth:
                auth.logout(token)
                return self.send({'ok': True}, cookie=self.session_cookie())
            if auth and not person:
                if path.startswith('/api/') and path != '/api/health':
                    return self.send({'error': '请登录后继续，当前输入仍保留在页面中'}, status=401)
                if method == 'GET' and path in ('/', '/cell-export.html'):
                    return self.send((BASE / 'static' / 'login.html').read_bytes(), 'text/html; charset=utf-8')
            if auth and person and path.startswith('/api/'):
                s = self.server.account_stores.get(person)
            if auth and path == '/api/auth/users' and method == 'GET':
                return self.send({'users': auth.list_users(token)})
            if auth and path == '/api/auth/users' and method == 'POST':
                if self.headers.get_content_type() != 'application/json': raise ValueError('需要 JSON 格式')
                data=json.loads(self.body(4096))
                if not isinstance(data,dict): raise ValueError('请求必须为对象')
                return self.send(auth.create_user(token,data.get('username'),data.get('password')))
            if auth and path.startswith('/api/auth/users/') and method == 'PUT':
                if self.headers.get_content_type() != 'application/json': raise ValueError('需要 JSON 格式')
                data=json.loads(self.body(4096))
                auth.update_user(token,int(path.rsplit('/',1)[1]),data)
                return self.send({'ok':True})
            if path == '/api/auth/password' and method == 'POST' and auth:
                if self.headers.get_content_type() != 'application/json': raise ValueError('需要 JSON 格式')
                data = json.loads(self.body(4096))
                if not isinstance(data, dict): raise ValueError('请求必须为对象')
                if not auth.change_password(token, data.get('password'), data.get('new_password'), self.auth_peer()):
                    return self.send({'error': '当前密码错误或登录已过期'}, status=401)
                return self.send({'ok': True}, cookie=self.session_cookie())
            if method == 'GET':
                static = {'/vendor/rich-editor.js': 'vendor/rich-editor.js', '/vendor/mermaid-runtime.js': 'vendor/mermaid-runtime.js', '/mermaid-renderer.js': 'mermaid-renderer.js', '/mermaid-source.mjs': 'mermaid-source.mjs', '/notebook-export.mjs': 'notebook-export.mjs', '/accounts-ui.js': 'accounts-ui.js', '/auth-ui.js': 'auth-ui.js', '/login.css': 'login.css', '/cell-export.html': 'cell-export.html', '/cell-export.js': 'cell-export.js', '/cell-export.css': 'cell-export.css', '/vendor/html-to-image.js': 'vendor/html-to-image.js', '/': 'index.html', '/app.js': 'app.js', '/library.mjs': 'library.mjs', '/style.css': 'style.css', '/notebook.js': 'notebook.js', '/notebook-core.mjs': 'notebook-core.mjs', '/vendor/katex.mjs': 'vendor/katex.mjs', '/brand/process-log-logo.png': 'brand/process-log-logo.png'}
                static.update({
                    '/favicon.ico': 'brand/favicon.ico',
                    '/manifest.webmanifest': 'manifest.webmanifest',
                    **{f'/brand/{name}': f'brand/{name}' for name in (
                        'sanyu-mark.svg', 'sanyu-16.png', 'sanyu-32.png', 'sanyu-64.png',
                        'apple-touch-icon.png', 'icon-192.png', 'icon-512.png')},
                })
                if path in static:
                    file = BASE / 'static' / static[path]
                    content_type = {'.js': 'text/javascript', '.mjs': 'text/javascript',
                                    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
                                    '.webmanifest': 'application/manifest+json'}.get(file.suffix)
                    content_type = content_type or mimetypes.guess_type(file)[0] or 'application/octet-stream'
                    if content_type.startswith('text/') or file.suffix in ('.svg', '.webmanifest'):
                        content_type += '; charset=utf-8'
                    return self.send(file.read_bytes(), content_type)
                if path == '/api/health':
                    with s.connection() as connection:
                        connection.execute('SELECT 1').fetchone()
                    return self.send({'ok': True})
                if path == '/api/state':
                    return self.send(s.state())
                if path == '/api/backup':
                    return self.send(s.backup(), 'application/octet-stream' if s.cipher.aes else 'application/zip',
                                     filename='process-log-backup.plbackup' if s.cipher.aes else 'process-log-backup.zip')
                parts = path.strip('/').split('/')
                if len(parts) == 4 and parts[:2] == ['api', 'records'] and parts[3] == 'markdown':
                    return self.send(s.markdown(parts[2]).encode(), 'text/markdown; charset=utf-8', filename='record-'+parts[2][:8]+'.md')
                if len(parts) == 3 and parts[:2] == ['api', 'attachments']:
                    a, content = s.read_attachment(parts[2])
                    preview = parse_qs(u.query).get('preview') == ['1']
                    ranges = self.headers.get_all('Range', [])
                    # No validators are emitted, so If-Range cannot be satisfied.
                    range_header = ','.join(ranges) if ranges and not self.headers.get('If-Range') else None
                    return self.send_attachment(a, content, preview=preview, range_header=range_header)
                raise KeyError('页面不存在')
            if path == '/api/restore' and method == 'POST':
                s.restore(self.body(250*1024*1024))
                return self.send({'ok': True})
            parts = path.strip('/').split('/')
            if method == 'POST' and len(parts) == 4 and parts[:2] == ['api', 'records'] and parts[3] == 'attachments':
                return self.send(s.add_attachment(parts[2], unquote(self.headers.get('X-Filename', 'file')),
                                                   self.body(25*1024*1024), self.headers.get('Content-Type', 'application/octet-stream')))
            data = {}
            if method in ['POST', 'PUT']:
                if self.headers.get_content_type() != 'application/json':
                    raise ValueError('需要 JSON 格式')
                limit = 2 * 1024 * 1024
                if method == 'PUT' and len(parts) == 3 and parts[:2] == ['api', 'records']:
                    # Legacy notebooks can exceed the new-document limit. Permit an
                    # unchanged snapshot plus metadata; Store still checks growth.
                    existing = s.get_record(parts[2])
                    limit = max(limit, len(json.dumps(existing['cells']).encode()) + 2 * 1024 * 1024)
                data = json.loads(self.body(limit) or b'{}')
                if not isinstance(data, dict):
                    raise ValueError('请求必须为 JSON 对象')
            if path == '/api/workspaces' and method == 'POST':
                return self.send(s.create_workspace(data))
            if path == '/api/projects' and method == 'POST':
                return self.send(s.create_project(data))
            if path == '/api/records' and method == 'POST':
                return self.send(s.create_record(data))
            if path == '/api/templates' and method == 'PUT':
                s.save_templates(data.get('templates'))
                return self.send({'ok': True})
            if len(parts) == 3 and parts[0] == 'api':
                entity, identifier = parts[1:]
                if method == 'PUT':
                    operation = {'workspaces': s.update_workspace, 'projects': s.update_project, 'records': s.update_record, 'entries': s.update_entry}.get(entity)
                    if operation:
                        return self.send(operation(identifier, data) or {'ok': True})
                if method == 'DELETE':
                    operation = {'workspaces': s.delete_workspace, 'projects': s.delete_project, 'records': s.delete_record, 'entries': s.delete_entry, 'attachments': s.delete_attachment}.get(entity)
                    if operation:
                        operation(identifier)
                        return self.send({'ok': True})
            if len(parts) == 4 and parts[:2] == ['api', 'records'] and method == 'POST':
                if parts[3] == 'entries':
                    return self.send(s.add_entry(parts[2], data))
                if parts[3] == 'duplicate':
                    return self.send(s.duplicate(parts[2]))
            raise KeyError('接口不存在')
        except PermissionError as e:
            self.send({'error': str(e)}, status=403)
        except RateLimited as e:
            self.send({'error': str(e)}, status=429)
        except Conflict as e:
            self.send({'error': str(e)}, status=409)
        except KeyError as e:
            self.send({'error': str(e).strip("'")}, status=404)
        except (ValueError, TypeError, AttributeError, sqlite3.IntegrityError) as e:
            self.send({'error': str(e)}, status=400)
        except (ConnectionError, TimeoutError):
            pass
        except Exception as e:
            print(f'Error: {type(e).__name__}: {e}', file=sys.stderr, flush=True)
            self.send({'error': '保存或读取失败，请检查磁盘空间后重试。当前输入不会清空。'}, status=500)

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_DELETE = handle_request


def make_server(root, port=8765, *, host='127.0.0.1', allowed_origins=None, database_url=None, attachments_dir=None, encryption_key_file=None, auth_db=None, session_days=7, cookie_secure=True, trusted_proxies=None):
    r2_values = [os.environ.get(name) for name in
                 ('PROCESS_LOG_R2_ACCOUNT_ID', 'PROCESS_LOG_R2_BUCKET', 'PROCESS_LOG_R2_CREDENTIALS_FILE')]
    media_mirror = None
    if any(value is not None for value in r2_values):
        if not all(value and value.strip() for value in r2_values):
            raise ValueError('R2 配置必须同时提供账号、桶和凭据文件')
        account, bucket, credentials_file = r2_values
        if bucket != 'sanyulog-media':
            raise ValueError('R2 媒体镜像仅支持专用桶 sanyulog-media')
        if database_url and not attachments_dir:
            raise ValueError('PostgreSQL R2 媒体镜像必须显式配置 PROCESS_LOG_ATTACHMENTS')
        if not encryption_key_file:
            raise ValueError('R2 媒体镜像需要配置原始加密密钥')
        from r2_media import R2Credentials, R2Mirror, create_r2_client
        credentials = R2Credentials.load(Path(credentials_file))
        media_mirror = R2Mirror(create_r2_client(account, credentials), bucket)
    origins = set(allowed_origins or [])
    for origin in origins:
        parsed = urlsplit(origin)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or '*' in parsed.netloc
                or any(character.isspace() for character in origin)):
            raise ValueError('访问来源必须为完整的 http(s)://主机[:端口]，不能包含路径或通配符')
        parsed.port  # Reject malformed port values before binding a socket.
    server = ThreadingHTTPServer((host, port), Handler)
    origins.update({f'http://127.0.0.1:{server.server_port}', f'http://localhost:{server.server_port}'})
    server.allowed_origins = origins
    server.allowed_hosts = {urlsplit(origin).netloc for origin in origins}
    try:
        server.auth = Auth(auth_db, session_days) if auth_db else None
        server.cookie_secure = cookie_secure
        server.trusted_proxies = {str(ipaddress.ip_address(value)) for value in (trusted_proxies or [])}
        if database_url:
            from pgstore import PostgreSQLStore
            server.store = PostgreSQLStore(root, database_url, attachments_dir, encryption_key_file, media_mirror=media_mirror)
        else:
            server.store = Store(root, encryption_key_file=encryption_key_file, media_mirror=media_mirror)
        server.account_stores = AccountStores(server.store, root, database_url, attachments_dir, encryption_key_file, media_mirror=media_mirror)
    except Exception:
        server.server_close()
        raise
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='过程记录工具')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PROCESS_LOG_PORT', '8765')))
    parser.add_argument('--host', default=os.environ.get('PROCESS_LOG_HOST', '127.0.0.1'))
    parser.add_argument('--allow-origin', action='append', default=None)
    parser.add_argument('--data', default=os.environ.get('PROCESS_LOG_DATA', str(BASE / 'data')))
    args = parser.parse_args()
    origins = args.allow_origin if args.allow_origin is not None else [x.strip() for x in os.environ.get('PROCESS_LOG_ALLOWED_ORIGINS', '').split(',') if x.strip()]
    try:
        httpd = make_server(args.data, args.port, host=args.host, allowed_origins=origins,
                            database_url=os.environ.get('DATABASE_URL'), attachments_dir=os.environ.get('PROCESS_LOG_ATTACHMENTS'),
                            encryption_key_file=os.environ.get('PROCESS_LOG_ENCRYPTION_KEY_FILE'),
                            auth_db=(os.environ.get('PROCESS_LOG_AUTH_DB') or str(Path(args.data) / 'auth.db')) if os.environ.get('PROCESS_LOG_AUTH_ENABLED', '1') != '0' else None,
                            session_days=int(os.environ.get('PROCESS_LOG_SESSION_DAYS', '7')),
                            cookie_secure=os.environ.get('PROCESS_LOG_COOKIE_SECURE', '1') != '0',
                            trusted_proxies=[v.strip() for v in os.environ.get('PROCESS_LOG_TRUSTED_PROXIES', '').split(',') if v.strip()])
    except (ValueError, sqlite3.Error) as e:
        raise SystemExit(f'Cannot start: {e}')
    except OSError as e:
        raise SystemExit(f'Cannot start: {e}. Try --port 8766.')
    print(f'Process Log listening on {args.host}:{httpd.server_port}', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
