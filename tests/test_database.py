import copy
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from store import Store

def ident(n):
    return f'{n:032x}'

def database():
    return {'version': 1, 'title': '独立实验库', 'columns': [
        {'id':ident(1), 'name':'标题', 'type':'text', 'options':[]},
        {'id':ident(2), 'name':'状态', 'type':'select', 'options':[{'id':ident(20), 'label':'完成', 'color':'green'}]},
        {'id':ident(3), 'name':'标签', 'type':'multi-select', 'options':[{'id':ident(30), 'label':'训练', 'color':'blue'}]},
        {'id':ident(4), 'name':'分数', 'type':'number', 'options':[]},
        {'id':ident(5), 'name':'日期', 'type':'date', 'options':[]},
        {'id':ident(6), 'name':'验证', 'type':'checkbox', 'options':[]}
    ], 'rows':[{'id':ident(100), 'values':{ident(1):'隐私段落\n第二段', ident(2):ident(20), ident(3):[ident(30)], ident(4):2.5, ident(5):'2026-10-13', ident(6):True}}],
    'view':{'filter':{'column':ident(2),'operator':'equals','value':ident(20)},'sort':{'column':ident(4),'direction':'desc'}}}

class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.key=self.root/'test.key'
        self.key.write_bytes(os.urandom(32))
        self.data=self.root/'data'
        self.s=Store(self.data,encryption_key_file=self.key)
        p=self.s.create_project({'name':'测试'})
        self.r=self.s.create_record({'project_id':p['id'],'title':'测试数据库'})
    def cells(self, data):
        return [{'id':ident(999),'type':'database','source':json.dumps(data,ensure_ascii=False),'language':'','attachment_ids':[]},
                {'id':ident(998),'type':'table','source':'原表格,值\n原样,"多段\n文字"','language':'','attachment_ids':[]}]
    def test_encrypted_restart_backup_export_keeps_schema_and_original_table(self):
        cells=self.cells(database())
        saved=self.s.update_record(self.r['id'],{'version':1,'cells':cells})
        c=sqlite3.connect(self.s.db)
        try:
            raw=c.execute('SELECT cells FROM notebooks WHERE record_id=?',(self.r['id'],)).fetchone()[0]
        finally:
            c.close()
        self.assertNotIn('隐私段落',str(raw))
        self.assertEqual(Store(self.data,encryption_key_file=self.key).get_record(self.r['id'])['cells'],cells)
        with tempfile.TemporaryDirectory() as folder:
            restored=Store(folder,encryption_key_file=self.key);restored.restore(self.s.backup())
            self.assertEqual(restored.get_record(self.r['id'])['cells'],cells)
        md=self.s.markdown(saved['id'])
        self.assertIn('独立实验库',md);self.assertIn('训练',md);self.assertIn('完成',md)
        self.assertNotIn(ident(30),md)
    def test_invalid_updates_rejected_atomically(self):
        cases=[]
        for col,value in [(2,'bad'),(3,[ident(30),ident(30)]),(4,True),(4,float('inf')),(5,'2026-02-30'),(6,1)]:
            d=database();d['rows'][0]['values'][ident(col)]=value;cases.append(d)
        d=database();d['columns'][1]['options'][0]['label']='bad\nlabel';cases.append(d)
        d=database();d['columns'].append(copy.deepcopy(d['columns'][0]));cases.append(d)
        d=database();d['view']['filter']['value']='missing';cases.append(d)
        d=database();d['rows'][0]['values']['extra']='bad';cases.append(d)
        d=database();d['version']=True;cases.append(d)
        for d in cases:
            with self.assertRaises(ValueError):
                self.s.update_record(self.r['id'],{'version':1,'title':'不可保存','cells':self.cells(d)})
            self.assertEqual(self.s.get_record(self.r['id'])['title'],'测试数据库')
