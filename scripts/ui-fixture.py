"""Isolated demo server for UI regression tests; never uses production data."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
from store import Store
s = Store(sys.argv[1])
if not s.state()['projects']:
    p = s.create_project({'name': 'H3 LoRA 训练'})
    s.create_project({'name': '工作流调试'})
    w = s.create_workspace({'name': '日常研究'})
    s.create_project({'name': '研究随记', 'workspace_id': w['id']})
    for i, (title, status, tags) in enumerate([('视频数据配比与训练记录', '进行中', ['数据集', 'LoRA']), ('第二轮训练 · 参数与结果', '已完成', ['实验']), ('工作流排错记录', '受阻', ['调试']), ('训练前检查清单', '已完成', ['准备'])]):
        r = s.create_record({'project_id': p['id'], 'title': title})
        cells = [{'id': f'{i * 10 + j + 1:032x}', 'type': typ, 'source': source, 'language': 'python' if typ == 'code' else '', 'attachment_ids': []} for j, (typ, source) in enumerate([('markdown', '## 这次想验证什么\n比较不同数据配比对生成稳定性的影响。先建立基线，再逐项调整，保留每一次尝试的结果。\n\n### 数据准备\n- 高噪数据：覆盖更多人物、视角与姿态\n- 低噪数据：保留清晰稳定的片段\n- 重点观察\n    - 手部与发丝细节\n    - 首帧身份延续\n\n**当前结论**：先保证样本质量，再增加覆盖范围。'), ('code', 'config = {\n    "learning_rate": 1e-4,\n    "lora_rank": 32,\n    "batch_size": 4,\n}\nprint(config)'), ('table', '实验,学习率,步数,备注\n基线,0.0001,1000,先验证流程\n对照,0.00005,1500,观察细节'), ('markdown', '## 下一步\n1. 检查验证样本\n2. 对比训练前后的变化\n3. 整理可复用的参数')])]
        s.update_record(r['id'], {'version': 1, 'status': status, 'tags': tags, 'cells': cells})
from server import make_server
from auth import Auth
auth_db = Path(sys.argv[1]) / 'auth.db'
Auth.initialize(auth_db, 'admin', 'ui-test-password-only')
httpd = make_server(sys.argv[1], 0, auth_db=auth_db, cookie_secure=False)
print('UI_READY:' + str(httpd.server_port), flush=True)
httpd.serve_forever()
