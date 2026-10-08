import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch
from server import make_server


ROOT = Path(__file__).resolve().parents[1]
R2_ENV = ('PROCESS_LOG_R2_ACCOUNT_ID', 'PROCESS_LOG_R2_BUCKET', 'PROCESS_LOG_R2_CREDENTIALS_FILE')


def isolated_env(**values):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('PROCESS_LOG_') and key not in ('DATABASE_URL', 'PYTHONPATH')}
    env.update(values)
    return env


class DeploymentTests(unittest.TestCase):
    def test_runtime_copy_payload_imports_r2_modules_without_copying_private_state(self):
        # Regression: missing module COPY breaks the real image at import/startup.
        # Exercise COPY's explicit payload locally; CI separately builds Docker.
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            for line in (ROOT / 'Dockerfile').read_text().splitlines():
                words = shlex.split(line)
                if not words or words[0].upper() != 'COPY':
                    continue
                self.assertFalse(any(word.startswith('--') for word in words[1:]))
                destination = target / words[-1].removeprefix('./')
                self.assertTrue(destination.resolve().is_relative_to(target))
                for name in words[1:-1]:
                    source = ROOT / name
                    self.assertTrue(source.resolve().is_relative_to(ROOT))
                    # Only application code/static assets and pinned requirements
                    # belong in this image, never a whole-workspace COPY.
                    self.assertTrue(name == 'static/' or name == 'requirements.txt'
                                    or ('/' not in name and name.endswith('.py')), name)
                    if source.is_dir():
                        shutil.copytree(source, destination, dirs_exist_ok=True)
                    else:
                        destination.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, destination / source.name)
            self.assertFalse((target / 'secrets').exists())
            self.assertFalse((target / 'auth.db').exists())
            result = subprocess.run(
                [sys.executable, '-I', '-c',
                 'import sys; sys.path.insert(0, "."); import server, r2_media, r2_reconcile; '
                 'print(r2_media.object_key("owner", "a" * 64))'],
                cwd=target, env=isolated_env(), capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'v1/owner/' + 'a' * 64)
            help_result = subprocess.run(
                [sys.executable, 'r2_reconcile.py', '--help'], cwd=target,
                env=isolated_env(), capture_output=True, text=True, timeout=20)
            self.assertEqual(help_result.returncode, 0, help_result.stderr)

    def test_partial_r2_configuration_exits_before_initializing_data(self):
        # Regression: any partial/blank tuple must fail closed, not local-only.
        configurations = [{key: value for key, value in zip(R2_ENV, values) if value} for values in (
            ('a' * 32, '', ''), ('', 'sanyulog-media', ''), ('', '', '/restricted/r2.json'),
            ('a' * 32, 'sanyulog-media', ''), ('a' * 32, '', '/restricted/r2.json'),
            ('', 'sanyulog-media', '/restricted/r2.json'),
            ('a' * 32, 'sanyulog-media', ' '))]
        configurations.append(dict.fromkeys(R2_ENV, ''))
        for config in configurations:
            with self.subTest(fields=[key for key, value in config.items() if value.strip()]), tempfile.TemporaryDirectory() as folder:
                data = Path(folder) / 'not-initialized'
                result = subprocess.run(
                    [sys.executable, str(ROOT / 'server.py'), '--data', str(data), '--port', '0'],
                    cwd=ROOT, env=isolated_env(**config), capture_output=True, text=True, timeout=20)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Cannot start:', result.stderr)
                self.assertNotIn('listening', result.stdout)
                self.assertFalse(data.exists())

    def test_configured_r2_public_responses_do_not_disclose_credentials(self):
        # Only external credential acquisition/S3 creation are substituted;
        # real encryption, store and HTTP responses remain under test.
        from r2_media import R2Credentials
        from test_r2_media import MemoryS3
        config = dict(zip(R2_ENV, ('a' * 32, 'sanyulog-media', '/restricted/r2.json')))
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, config), \
                patch('r2_media.R2Credentials.load', return_value=R2Credentials('test-access-marker', 'test-secret-marker')), \
                patch('r2_media.create_r2_client', return_value=MemoryS3()):
            key = Path(folder) / 'storage.key'
            key.write_bytes(bytes(range(32)))
            server = make_server(Path(folder) / 'data', 0, encryption_key_file=key)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                for path in ('/api/health', '/api/state', '/'):
                    with opener.open(f'http://127.0.0.1:{server.server_port}{path}', timeout=5) as response:
                        self.assertEqual(response.status, 200)
                        public = response.read().decode()
                        for private in ('test-access-marker', 'test-secret-marker', '/restricted/r2.json'):
                            self.assertNotIn(private, public)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_configured_lan_origin_works_and_foreign_origin_stays_blocked(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, isolated_env(), clear=True):
            try:
                server = make_server(folder, 0, host='127.0.0.1', allowed_origins=['http://process-log.example:8765'])
            except TypeError:
                self.fail('Configurable container/LAN binding is not implemented')
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def request(path, origin, data=None):
                headers = {'Host': 'process-log.example:8765', 'Origin': origin, 'Content-Type': 'application/json'}
                req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,
                                             data=json.dumps(data).encode() if data is not None else None, headers=headers)
                try:
                    return opener.open(req, timeout=5)
                except urllib.error.HTTPError as e:
                    return e
            try:
                with request('/api/projects', 'http://process-log.example:8765', {'name': 'LAN project'}) as response:
                    self.assertEqual(response.status, 200)
                with request('/api/projects', 'https://evil.example', {'name': 'bad'}) as response:
                    self.assertEqual(response.status, 403)
                with request('/api/health', 'http://process-log.example:8765') as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.load(response), {'ok': True})
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
