"""Strict standalone database-block contract, shared by all storage backends."""
import datetime
import json
import math
import re

TYPES = {'text', 'select', 'multi-select', 'number', 'date', 'checkbox'}
COLORS = {'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'}

def exact(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)

def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value) is not None

def label(value, limit=80):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit and not any(c in value for c in '\r\n\0')

def valid_value(column, value):
    kind = column['type']
    ids = {o['id'] for o in column['options']}
    if kind == 'text':
        return isinstance(value, str) and len(value) <= 20000
    if kind == 'select':
        return value is None or isinstance(value, str) and value in ids
    if kind == 'multi-select':
        return isinstance(value, list) and all(isinstance(v, str) and v in ids for v in value) and len(set(value)) == len(value)
    if kind == 'number':
        return value is None or type(value) in (int, float) and abs(value) <= 1.7976931348623157e308 and math.isfinite(value)
    if kind == 'date':
        if value is None:
            return True
        try:
            return isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) is not None and datetime.date.fromisoformat(value).isoformat() == value
        except ValueError:
            return False
    return kind == 'checkbox' and type(value) is bool

def validate_database(source):
    def invalid():
        raise ValueError('数据库格式、属性值或视图设置无效')
    try:
        d = json.loads(source)
    except (ValueError, TypeError, RecursionError) as e:
        raise ValueError('数据库内容不是有效 JSON') from e
    if not exact(d, ['version','title','columns','rows','view']) or type(d['version']) is not int or d['version'] != 1 or not label(d['title'],100):
        invalid()
    if not isinstance(d['columns'],list) or not 1 <= len(d['columns']) <= 50:
        invalid()
    columns = {}
    for col in d['columns']:
        if not exact(col,['id','name','type','options']) or not identifier(col['id']) or col['id'] in columns or not label(col['name']) or not isinstance(col['type'],str) or col['type'] not in TYPES:
            invalid()
        columns[col['id']] = col
        options = col['options']
        if not isinstance(options,list) or len(options) > 100 or col['type'] not in {'select','multi-select'} and options:
            invalid()
        ids, labels = set(), set()
        for o in options:
            if not exact(o,['id','label','color']) or not identifier(o['id']) or o['id'] in ids or not label(o['label']) or o['label'] != o['label'].strip() or o['label'] in labels or not isinstance(o['color'],str) or o['color'] not in COLORS:
                invalid()
            ids.add(o['id']); labels.add(o['label'])
    if not isinstance(d['rows'],list) or len(d['rows']) > 1000:
        invalid()
    ids = set()
    for row in d['rows']:
        if not exact(row,['id','values']) or not identifier(row['id']) or row['id'] in ids or not exact(row['values'],columns):
            invalid()
        ids.add(row['id'])
        if any(not valid_value(col,row['values'][key]) for key,col in columns.items()):
            invalid()
    view = d['view']
    if not exact(view,['filter','sort']):
        invalid()
    sort = view['sort']
    if sort is not None and (not exact(sort,['column','direction']) or not isinstance(sort['column'],str) or sort['column'] not in columns or sort['direction'] not in ['asc','desc']):
        invalid()
    f = view['filter']
    if f is not None:
        if not exact(f,['column','operator','value']) or not isinstance(f['column'],str) or f['column'] not in columns:
            invalid()
        col = columns[f['column']]
        allowed = {'checkbox':['equals'], 'number':['equals','gt','lt','empty','not-empty'], 'date':['equals','gt','lt','empty','not-empty'], 'select':['equals','empty','not-empty'], 'multi-select':['contains','empty','not-empty'], 'text':['contains','equals','empty','not-empty']}[col['type']]
        if f['operator'] not in allowed:
            invalid()
        if f['operator'] in ['empty','not-empty']:
            if f['value'] is not None:
                invalid()
        elif col['type'] == 'multi-select':
            if not isinstance(f['value'],str) or f['value'] not in {o['id'] for o in col['options']}:
                invalid()
        elif f['value'] is None or not valid_value(col,f['value']):
            invalid()
    return d

def display_value(col, value):
    labels = {o['id']:o['label'] for o in col['options']}
    if col['type'] == 'select':
        return labels.get(value,'')
    if col['type'] == 'multi-select':
        return '\n'.join(labels.get(v,'') for v in value)
    if col['type'] == 'checkbox':
        return '是' if value else '否'
    return str(value) if value is not None else ''

def database_markdown(source):
    d = validate_database(source)
    def safe(v):
        return str(v).replace('&','&#38;').replace('|','&#124;').replace('<','&#60;').replace('>','&#62;').replace('\r','').replace('\n','&#10;')
    def line(values):
        return '| ' + ' | '.join(safe(v) for v in values) + ' |'
    rows = [line(c['name'] for c in d['columns']), line(['---']*len(d['columns']))]
    rows += [line(display_value(c,r['values'][c['id']]) for c in d['columns']) for r in d['rows']]
    return '### ' + safe(d['title']) + '\n\n' + '\n'.join(rows) + '\n'
