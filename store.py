"""Local transactional storage. No third-party dependencies."""
import hashlib
import csv
import io
import json
import os
import sqlite3
import tempfile
import threading
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

MAX_BACKUP_BYTES = 250 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def uid():
    return uuid.uuid4().hex


class Conflict(ValueError):
    pass


DEFAULT_TEMPLATES = [
    {'id': 'general', 'name': '通用过程', 'goal': '', 'params': {}},
    {'id': 'lora', 'name': 'LoRA 训练', 'goal': '', 'params': {
        '基础模型': '', '数据集 / 版本': '', '学习率': '', 'LoRA rank': '',
        'LoRA alpha': '', 'batch size': '', '训练步数': '', '随机种子': '', '输出目录': ''}},
    {'id': 'workflow', 'name': '工作流调试', 'goal': '', 'params': {
        '工作流 / 版本': '', '环境': '', '输入': '', '预期输出': '', '本次改动': ''}},
]
V1_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL, status TEXT NOT NULL, goal TEXT NOT NULL, params TEXT NOT NULL, tags TEXT NOT NULL,
 result TEXT NOT NULL, conclusion TEXT NOT NULL, next_step TEXT NOT NULL,
 related_id TEXT REFERENCES records(id) ON DELETE SET NULL, created TEXT NOT NULL, updated TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
 name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, file TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version=1;
"""
NOTEBOOK_SCHEMA = """
CREATE TABLE IF NOT EXISTS notebooks(record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE, cells TEXT NOT NULL);
PRAGMA user_version=2;
"""
SCHEMA = V1_SCHEMA + NOTEBOOK_SCHEMA


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.files = self.root / 'attachments'
        self.files.mkdir(exist_ok=True)
        self.db = self.root / 'process.db'
        self.lock = threading.RLock()
        with self.connection() as c:
            version = c.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1, 2):
                raise ValueError('数据库版本不兼容')
            if version == 1:
                backups = self.root / 'backups'
                backups.mkdir(exist_ok=True)
                (backups / ('before-notebook-'+uid()+'.zip')).write_bytes(self.backup())
            c.executescript(SCHEMA)
            c.execute('INSERT OR IGNORE INTO settings VALUES (?,?)', ('templates', json.dumps(DEFAULT_TEMPLATES, ensure_ascii=False)))
            self.migrate_notebooks(c)

    def migrate_notebooks(self, c):
        for row in c.execute('SELECT id FROM records WHERE id NOT IN (SELECT record_id FROM notebooks)').fetchall():
            record_id = row[0]
            cells = [dict(id=e[0], type='markdown', source='### '+e[1]+'\n\n'+e[2], language='', attachment_ids=[])
                     for e in c.execute('SELECT id,kind,body FROM entries WHERE record_id=? ORDER BY created,rowid', (record_id,))]
            files = [a[0] for a in c.execute('SELECT id FROM attachments WHERE record_id=? ORDER BY created,rowid', (record_id,))]
            if files:
                cells.append(dict(id=uid(), type='file', source='', language='', attachment_ids=files))
            c.execute('INSERT INTO notebooks VALUES (?,?)', (record_id, json.dumps(cells, ensure_ascii=False)))

    def validate_cells(self, c, record_id, cells, previous=None, restoring=False):
        if not isinstance(cells, list):
            raise ValueError('单元格必须为列表')
        previous = previous or []
        if not restoring and len(cells) > max(2000, len(previous)):
            raise ValueError('单个笔记本最多 2000 个单元格')
        ids = set()
        attachments = {r[0] for r in c.execute('SELECT id FROM attachments WHERE record_id=?', (record_id,))}
        for cell in cells:
            if not isinstance(cell, dict) or set(cell) != {'id', 'type', 'source', 'language', 'attachment_ids'}:
                raise ValueError('单元格格式不正确')
            identifier = cell['id']
            if not isinstance(identifier, str) or len(identifier) != 32 or any(ch not in '0123456789abcdef' for ch in identifier) or identifier in ids:
                raise ValueError('单元格 ID 无效或重复')
            ids.add(identifier)
            if cell['type'] not in ['markdown', 'code', 'log', 'file', 'table']:
                raise ValueError('单元格类型无效')
            if not isinstance(cell['source'], str) or len(cell['source']) > 500000:
                raise ValueError('单元格内容最多 500000 字符')
            if cell['type'] == 'table':
                try:
                    rows = list(csv.reader(io.StringIO(cell['source'].lstrip('\ufeff'), newline=''), strict=True))
                    if len(rows) > 1001 or any(len(row) > 50 for row in rows):
                        raise ValueError('独立表格最多 1000 行数据、50 列')
                except csv.Error as e:
                    raise ValueError('CSV 格式错误：'+str(e)) from e
            if not isinstance(cell['language'], str) or len(cell['language']) > 40 or any(ch not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-' for ch in cell['language']):
                raise ValueError('代码语言格式无效')
            refs = cell['attachment_ids']
            if not isinstance(refs, list) or any(not isinstance(a, str) or a not in attachments for a in refs) or len(set(refs)) != len(refs):
                raise ValueError('单元格引用了无效的附件')
        if not restoring and len(json.dumps(cells, ensure_ascii=False).encode()) > max(1500000, len(json.dumps(previous, ensure_ascii=False).encode())):
            raise ValueError('笔记本正文最多 1.5 MB，请分成多个笔记本')

    @contextmanager
    def connection(self):
        with self.lock:
            c = sqlite3.connect(self.db, timeout=20)
            c.row_factory = sqlite3.Row
            c.execute('PRAGMA foreign_keys=ON')
            try:
                with c:
                    yield c
            finally:
                c.close()

    def required(self, value, label, limit=300, trim=True):
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(f'{label}不能为空，且不能超过 {limit} 字符')
        return value.strip() if trim else value

    def record_dict(self, c, row):
        d = dict(row)
        d['params'], d['tags'] = json.loads(d['params']), json.loads(d['tags'])
        d['entries'] = [dict(r) for r in c.execute('SELECT * FROM entries WHERE record_id=? ORDER BY created, rowid', (d['id'],))]
        d['attachments'] = [dict(r) for r in c.execute('SELECT * FROM attachments WHERE record_id=? ORDER BY created, rowid', (d['id'],))]
        notebook = c.execute('SELECT cells FROM notebooks WHERE record_id=?', (d['id'],)).fetchone()
        d['cells'] = json.loads(notebook[0]) if notebook else []
        return d

    def workspace_data(self, c):
        row = c.execute("SELECT value FROM settings WHERE key='workspaces'").fetchone()
        return json.loads(row[0]) if row else {'items': [{'id': 'default', 'name': '默认工作空间'}], 'projects': {}}

    def save_workspace_data(self, c, value):
        c.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  ('workspaces', json.dumps(value, ensure_ascii=False)))

    def create_workspace(self, data):
        with self.connection() as c:
            value = self.workspace_data(c)
            item = {'id': uid(), 'name': self.required(data.get('name'), '工作空间名称', 100)}
            value['items'].append(item)
            self.save_workspace_data(c, value)
            return item

    def update_workspace(self, workspace_id, data):
        with self.connection() as c:
            value = self.workspace_data(c)
            item = next((w for w in value['items'] if w['id'] == workspace_id), None)
            if not item:
                raise KeyError('工作空间不存在')
            item['name'] = self.required(data.get('name'), '工作空间名称', 100)
            self.save_workspace_data(c, value)
            return item

    def delete_workspace(self, workspace_id):
        with self.connection() as c:
            value = self.workspace_data(c)
            if workspace_id == 'default':
                raise ValueError('默认工作空间不能删除')
            if any(value['projects'].get(r[0], 'default') == workspace_id for r in c.execute('SELECT id FROM projects')):
                raise ValueError('请先将项目移出此工作空间')
            value['items'] = [w for w in value['items'] if w['id'] != workspace_id]
            self.save_workspace_data(c, value)

    def assign_workspace(self, c, project_id, workspace_id):
        value = self.workspace_data(c)
        if not any(w['id'] == workspace_id for w in value['items']):
            raise ValueError('工作空间不存在')
        value['projects'][project_id] = workspace_id
        self.save_workspace_data(c, value)

    def state(self):
        with self.connection() as c:
            spaces = self.workspace_data(c)
            return {'workspaces': spaces['items'], 'projects': [dict(r) | {'workspace_id': spaces['projects'].get(r['id'], 'default')} for r in c.execute('SELECT * FROM projects ORDER BY created')],
                    'records': [self.record_dict(c, r) for r in c.execute('SELECT * FROM records ORDER BY updated DESC, rowid DESC')],
                    'templates': json.loads(c.execute("SELECT value FROM settings WHERE key='templates'").fetchone()[0])}

    def get_record(self, record_id):
        with self.connection() as c:
            row = c.execute('SELECT * FROM records WHERE id=?', (record_id,)).fetchone()
            if row is None:
                raise KeyError('记录不存在')
            return self.record_dict(c, row)

    def create_project(self, data):
        p = {'id': uid(), 'name': self.required(data.get('name'), '项目名称', 100), 'created': now()}
        with self.connection() as c:
            c.execute('INSERT INTO projects VALUES (:id,:name,:created)', p)
            self.assign_workspace(c, p['id'], data.get('workspace_id', 'default'))
        return p

    def update_project(self, project_id, data):
        with self.connection() as c:
            if c.execute('UPDATE projects SET name=? WHERE id=?', (self.required(data.get('name'), '项目名称', 100), project_id)).rowcount == 0:
                raise KeyError('项目不存在')
            if 'workspace_id' in data:
                self.assign_workspace(c, project_id, data['workspace_id'])
        return {'id': project_id, 'name': data['name'].strip()}

    def delete_project(self, project_id):
        with self.connection() as c:
            c.execute('DELETE FROM projects WHERE id=?', (project_id,))

    def validate_record(self, c, d):
        d['title'] = self.required(d.get('title'), '标题')
        if d.get('status') not in ['进行中', '已完成', '受阻', '已搁置']:
            raise ValueError('无效的记录状态')
        if not c.execute('SELECT 1 FROM projects WHERE id=?', (d['project_id'],)).fetchone():
            raise ValueError('请选择有效的项目')
        if d.get('related_id'):
            if d['related_id'] == d['id'] or not c.execute('SELECT 1 FROM records WHERE id=?', (d['related_id'],)).fetchone():
                raise ValueError('关联记录无效')
        if not isinstance(d['params'], dict) or len(d['params']) > 100 or any(not isinstance(k, str) or not k.strip() or not isinstance(v, str) for k, v in d['params'].items()):
            raise ValueError('参数必须为文本键值对，最多 100 项')
        if not isinstance(d['tags'], list) or len(d['tags']) > 30 or any(not isinstance(t, str) or len(t) > 60 for t in d['tags']):
            raise ValueError('标签格式无效')
        d['tags'] = list(dict.fromkeys(t.strip() for t in d['tags'] if t.strip()))
        for field in ['goal', 'result', 'conclusion', 'next_step']:
            if not isinstance(d[field], str) or len(d[field]) > 100000:
                raise ValueError('文本内容过长或格式无效')

    def create_record(self, data):
        d = dict(id=uid(), project_id=data.get('project_id'), title=data.get('title'), status='进行中',
                 goal='', params={}, tags=[], result='', conclusion='', next_step='', related_id=None,
                 created=now(), updated=now(), version=1)
        for k in ['status', 'goal', 'params', 'tags', 'related_id', 'result', 'conclusion', 'next_step']:
            if k in data:
                d[k] = data[k]
        with self.connection() as c:
            self.validate_record(c, d)
            dbd = {**d, 'params': json.dumps(d['params'], ensure_ascii=False), 'tags': json.dumps(d['tags'], ensure_ascii=False)}
            c.execute('INSERT INTO records VALUES (:id,:project_id,:title,:status,:goal,:params,:tags,:result,:conclusion,:next_step,:related_id,:created,:updated,:version)', dbd)
            cells = data.get('cells', [])
            self.validate_cells(c, d['id'], cells)
            c.execute('INSERT INTO notebooks VALUES (?,?)', (d['id'], json.dumps(cells, ensure_ascii=False)))
        return self.get_record(d['id'])

    def update_record(self, record_id, data):
        with self.connection() as c:
            d = self.get_record(record_id)
            if data.get('version') != d['version']:
                raise Conflict('记录已在其他窗口更新。请复制当前内容，刷新后重试。')
            fields = ['title', 'status', 'goal', 'params', 'tags', 'result', 'conclusion', 'next_step', 'related_id']
            for k in fields:
                if k in data:
                    d[k] = data[k]
            self.validate_record(c, d)
            if 'cells' in data:
                self.validate_cells(c, record_id, data['cells'], previous=d['cells'])
                c.execute('UPDATE notebooks SET cells=? WHERE record_id=?', (json.dumps(data['cells'], ensure_ascii=False), record_id))
            d['version'] += 1
            d['updated'] = now()
            d['params'], d['tags'] = json.dumps(d['params'], ensure_ascii=False), json.dumps(d['tags'], ensure_ascii=False)
            c.execute('UPDATE records SET '+','.join(k+'=:'+k for k in fields+['version', 'updated'])+' WHERE id=:id', d)
        return self.get_record(record_id)

    def duplicate(self, record_id):
        with self.lock:
            original = self.get_record(record_id)
            return self.create_record({k: original[k] for k in ['project_id', 'goal', 'params', 'tags']} |
                                      {'title': original['title'][:290]+' · 副本', 'related_id': record_id})

    def delete_record(self, record_id):
        with self.connection() as c:
            c.execute('DELETE FROM records WHERE id=?', (record_id,))

    def add_entry(self, record_id, data):
        self.get_record(record_id)
        d = dict(id=uid(), record_id=record_id, kind=data.get('kind', '操作'),
                 body=self.required(data.get('body'), '记录内容', 100000, trim=False), created=now())
        if d['kind'] not in ['操作', '观察', '问题', '结论']:
            raise ValueError('无效的时间线类型')
        with self.connection() as c:
            c.execute('INSERT INTO entries VALUES (:id,:record_id,:kind,:body,:created)', d)
            cells = json.loads(c.execute('SELECT cells FROM notebooks WHERE record_id=?', (record_id,)).fetchone()[0])
            cells.append(dict(id=d['id'], type='markdown', source='### '+d['kind']+'\n\n'+d['body'], language='', attachment_ids=[]))
            c.execute('UPDATE notebooks SET cells=? WHERE record_id=?', (json.dumps(cells, ensure_ascii=False), record_id))
            c.execute('UPDATE records SET updated=?,version=version+1 WHERE id=?', (now(), record_id))
        return d

    def update_entry(self, entry_id, data):
        with self.connection() as c:
            e = c.execute('SELECT record_id,kind FROM entries WHERE id=?', (entry_id,)).fetchone()
            if e is None:
                raise KeyError('时间线记录不存在')
            if not c.execute('UPDATE entries SET body=? WHERE id=?', (self.required(data.get('body'), '记录内容', 100000, trim=False), entry_id)).rowcount:
                raise KeyError('时间线记录不存在')
            cells = json.loads(c.execute('SELECT cells FROM notebooks WHERE record_id=?', (e[0],)).fetchone()[0])
            for cell in cells:
                if cell['id'] == entry_id:
                    cell['source'] = '### '+e[1]+'\n\n'+data['body']
            c.execute('UPDATE notebooks SET cells=? WHERE record_id=?', (json.dumps(cells, ensure_ascii=False), e[0]))
            c.execute('UPDATE records SET updated=?,version=version+1 WHERE id=?', (now(), e[0]))

    def delete_entry(self, entry_id):
        with self.connection() as c:
            e = c.execute('SELECT record_id FROM entries WHERE id=?', (entry_id,)).fetchone()
            if e:
                cells = json.loads(c.execute('SELECT cells FROM notebooks WHERE record_id=?', (e[0],)).fetchone()[0])
                cells = [cell for cell in cells if cell['id'] != entry_id]
                c.execute('UPDATE notebooks SET cells=? WHERE record_id=?', (json.dumps(cells, ensure_ascii=False), e[0]))
                c.execute('UPDATE records SET updated=?,version=version+1 WHERE id=?', (now(), e[0]))
            c.execute('DELETE FROM entries WHERE id=?', (entry_id,))

    def search(self, query):
        q = query.casefold()
        return [r for r in self.state()['records'] if q in json.dumps(r, ensure_ascii=False).casefold()]

    def add_attachment(self, record_id, name, content, mime):
        with self.lock:
            self.get_record(record_id)
            if len(content) > 25 * 1024 * 1024:
                raise ValueError('单个附件不能超过 25 MB')
            safe_name = self.required(name.replace('\\', '/').split('/')[-1], '文件名', 240)
            filename = hashlib.sha256(content).hexdigest()
            path = self.files / filename
            if not path.exists():
                path.write_bytes(content)
            d = dict(id=uid(), record_id=record_id, name=safe_name, mime=str(mime)[:100], size=len(content), file=filename, created=now())
            with self.connection() as c:
                c.execute('INSERT INTO attachments VALUES (:id,:record_id,:name,:mime,:size,:file,:created)', d)
            return d

    def read_attachment(self, attachment_id):
        with self.connection() as c:
            row = c.execute('SELECT * FROM attachments WHERE id=?', (attachment_id,)).fetchone()
            if row is None:
                raise KeyError('附件不存在')
            return dict(row), (self.files / row['file']).read_bytes()

    def delete_attachment(self, attachment_id):
        with self.connection() as c:
            row = c.execute('SELECT record_id FROM attachments WHERE id=?', (attachment_id,)).fetchone()
            if row:
                cells = json.loads(c.execute('SELECT cells FROM notebooks WHERE record_id=?', (row[0],)).fetchone()[0])
                for cell in cells:
                    cell['attachment_ids'] = [a for a in cell['attachment_ids'] if a != attachment_id]
                c.execute('UPDATE notebooks SET cells=? WHERE record_id=?', (json.dumps(cells, ensure_ascii=False), row[0]))
                c.execute('UPDATE records SET updated=?,version=version+1 WHERE id=?', (now(), row[0]))
            c.execute('DELETE FROM attachments WHERE id=?', (attachment_id,))

    def validate_templates(self, templates):
        if not isinstance(templates, list) or not 1 <= len(templates) <= 30:
            raise ValueError('请保留 1–30 个模板')
        ids = set()
        for t in templates:
            if not isinstance(t, dict):
                raise ValueError('模板格式无效')
            self.required(t.get('id'), '模板 ID')
            self.required(t.get('name'), '模板名称', 80)
            if t['id'] in ids or not isinstance(t.get('goal', ''), str) or not isinstance(t.get('params'), dict) or len(t['params']) > 100:
                raise ValueError('模板格式无效或 ID 重复')
            ids.add(t['id'])
            if any(not isinstance(k, str) or not k.strip() or not isinstance(v, str) for k, v in t['params'].items()):
                raise ValueError('模板参数必须为文本键值对')
    def save_templates(self, templates):
        self.validate_templates(templates)
        with self.connection() as c:
            c.execute("UPDATE settings SET value=? WHERE key='templates'", (json.dumps(templates, ensure_ascii=False),))

    def markdown(self, record_id):
        r = self.get_record(record_id)
        lines = [f"# {r['title']}", '', f"状态：{r['status']}  ", f"创建：{r['created']}  ", '标签：'+', '.join(r['tags']), '']
        for label, key in [('目标', 'goal'), ('参数', 'params'), ('结果', 'result'), ('结论', 'conclusion'), ('下一步', 'next_step')]:
            value = json.dumps(r[key], ensure_ascii=False, indent=2) if key == 'params' else r[key]
            lines.extend(['## '+label, '', value or '（未填写）', ''])
        if r['related_id']:
            lines.extend(['关联记录：'+r['related_id'], ''])
        lines.extend(['## Notebook', ''])
        for cell in r['cells']:
            source = cell['source']
            if cell['type'] == 'table':
                rows = list(csv.reader(io.StringIO(source.lstrip('\ufeff'), newline='')))
                if rows:
                    width = max(len(row) for row in rows)
                    def table_line(row):
                        values = [str(v).replace('&', '&#38;').replace('|', '&#124;').replace('<', '&#60;').replace('>', '&#62;').replace('\r', '').replace('\n', '&#10;') for v in row]
                        return '| '+' | '.join(values+['']*(width-len(values)))+' |'
                    lines.extend([table_line(rows[0]), table_line(['---']*width), *[table_line(row) for row in rows[1:]], ''])
            elif cell['type'] in ['code', 'log']:
                fence = '`' * max(3, max((len(part) for part in __import__('re').findall(r'`+', source)), default=0)+1)
                lines.extend([fence+(cell['language'] if cell['type']=='code' else 'text'), source, fence, ''])
            else:
                lines.extend([source, ''])
            for a in r['attachments']:
                if a['id'] in cell['attachment_ids']:
                    lines.extend(['附件：'+a['name']+' · attachments/'+a['file'], ''])
        lines.extend(['## 附件清单', '', '附件原文件包含在完整 ZIP 备份中。', ''])
        lines.extend(f"- {a['name']} ({a['size']} bytes), 文件：attachments/{a['file']}" for a in r['attachments'])
        return '\n'.join(lines)

    def backup(self):
        with self.lock:
            with self.connection() as c:
                filenames = [r['file'] for r in c.execute('SELECT DISTINCT file FROM attachments')]
            total_size = self.db.stat().st_size + sum((self.files / name).stat().st_size for name in filenames)
            if total_size > MAX_BACKUP_BYTES:
                raise ValueError('当前数据超过完整备份的 250 MB 上限，无法生成可恢复的备份。现有数据保持不变。')
            out = io.BytesIO()
            # All writes are serialized and each connection closes before snapshot.
            with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
                z.write(self.db, 'process.db')
                for filename in filenames:
                    z.write(self.files / filename, 'attachments/'+filename)
            return out.getvalue()

    def restore(self, content):
        with self.lock:
            try:
                with zipfile.ZipFile(io.BytesIO(content)) as z:
                    names = z.namelist()
                    if len(names) != len(set(names)) or 'process.db' not in names or sum(i.file_size for i in z.infolist()) > MAX_BACKUP_BYTES:
                        raise ValueError('备份缺少数据库或解压后超过 250 MB')
                    for n in names:
                        if n != 'process.db' and not (n.startswith('attachments/') and len(n) == 76 and all(ch in '0123456789abcdef' for ch in n[12:])):
                            raise ValueError('备份包含无效路径')
                    db_bytes = z.read('process.db')
                    with tempfile.TemporaryDirectory(dir=self.root) as tmp:
                        candidate = Path(tmp) / 'candidate.db'
                        candidate.write_bytes(db_bytes)
                        c = sqlite3.connect(candidate)
                        try:
                            c.execute('PRAGMA trusted_schema=OFF')
                            version = c.execute('PRAGMA user_version').fetchone()[0]
                            if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or version not in (1, 2):
                                raise ValueError('数据库损坏或版本不兼容')
                            expected = sqlite3.connect(':memory:')
                            try:
                                expected.executescript(V1_SCHEMA if version == 1 else SCHEMA)
                                query = "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
                                if c.execute(query).fetchall() != expected.execute(query).fetchall():
                                    raise ValueError('数据库结构不兼容')
                            finally:
                                expected.close()
                            if version == 1:
                                c.executescript(NOTEBOOK_SCHEMA)
                                self.migrate_notebooks(c)
                                c.commit()
                            if c.execute('PRAGMA foreign_key_check').fetchall():
                                raise ValueError('数据库关联损坏')
                            c.row_factory = sqlite3.Row
                            for table in ['projects', 'records', 'entries', 'attachments']:
                                for row in c.execute('SELECT id FROM '+table):
                                    identifier = row['id']
                                    if not isinstance(identifier, str) or len(identifier) != 32 or any(ch not in '0123456789abcdef' for ch in identifier):
                                        raise ValueError('备份中的记录标识无效')
                            for row in c.execute('SELECT * FROM records'):
                                d = dict(row)
                                d['params'], d['tags'] = json.loads(d['params']), json.loads(d['tags'])
                                self.validate_record(c, d)
                                if not isinstance(d['version'], int) or d['version'] < 1:
                                    raise ValueError('记录版本无效')
                            for row in c.execute('SELECT name FROM projects'):
                                self.required(row['name'], '项目名称', 100)
                            for row in c.execute('SELECT kind,body FROM entries'):
                                if row['kind'] not in ['操作', '观察', '问题', '结论']:
                                    raise ValueError('时间线类型无效')
                                self.required(row['body'], '时间线内容', 100000)
                            templates = json.loads(c.execute("SELECT value FROM settings WHERE key='templates'").fetchone()[0])
                            self.validate_templates(templates)
                            if c.execute('SELECT count(*) FROM notebooks').fetchone()[0] != c.execute('SELECT count(*) FROM records').fetchone()[0]:
                                raise ValueError('备份缺少笔记本正文')
                            for record_id, cells in c.execute('SELECT record_id,cells FROM notebooks'):
                                self.validate_cells(c, record_id, json.loads(cells), restoring=True)
                            blobs = {}
                            for filename, size in c.execute('SELECT file,size FROM attachments'):
                                data = z.read('attachments/'+filename)
                                if hashlib.sha256(data).hexdigest() != filename or len(data) != size:
                                    raise ValueError('附件校验失败')
                                blobs[filename] = data
                        finally:
                            c.close()
                        backups = self.root / 'backups'
                        backups.mkdir(exist_ok=True)
                        (backups / ('before-restore-'+uid()+'.zip')).write_bytes(self.backup())
                        for filename, data in blobs.items():
                            (self.files / filename).write_bytes(data)
                        # Atomic replacement happens only after every validation and write succeeds.
                        os.replace(candidate, self.db)
            except (zipfile.BadZipFile, sqlite3.Error, KeyError, TypeError, json.JSONDecodeError, RuntimeError) as e:
                raise ValueError('无法恢复：备份损坏、缺少附件或格式不兼容') from e
