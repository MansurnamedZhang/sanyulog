"""Route each authenticated account to its independent encrypted data store."""
import re
import threading
from pathlib import Path
from store import Store

class AccountStores:
    def __init__(self, owner, root, database_url=None, attachments_dir=None, encryption_key_file=None):
        self.stores = {'owner': owner}
        self.root = Path(root).resolve()
        self.database_url = database_url
        self.attachments_dir = Path(attachments_dir).resolve() if attachments_dir else None
        self.key_file = encryption_key_file
        self.lock = threading.RLock()

    def get(self, principal):
        key = principal['storage_id']
        if key != 'owner' and not re.fullmatch('[a-f0-9]{32}', key):
            raise ValueError('账号数据区标识无效')
        with self.lock:
            if key not in self.stores:
                root = self.root / 'accounts' / key
                if self.database_url:
                    from pgstore import PostgreSQLStore
                    files = self.attachments_dir / 'accounts' / key if self.attachments_dir else None
                    self.stores[key] = PostgreSQLStore(root, self.database_url, files, self.key_file, namespace='process_log_user_'+key)
                else:
                    self.stores[key] = Store(root, encryption_key_file=self.key_file)
            return self.stores[key]
