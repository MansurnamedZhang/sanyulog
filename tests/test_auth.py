import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

class AuthTests(unittest.TestCase):
    def test_sessions_survive_restart_expire_and_revoke(self):
        from auth import Auth
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'auth.db'
            Auth.initialize(path, 'admin', 'test-password-12345')
            auth = Auth(path, days=7)
            self.assertIsNone(auth.login('admin', 'wrong', 'test-ip'))
            token = auth.login('admin', 'test-password-12345', 'test-ip')
            self.assertTrue(token)
            self.assertEqual(Auth(path).user(token), 'admin')
            self.assertNotIn(token.encode(), path.read_bytes())
            self.assertNotIn(b'test-password-12345', path.read_bytes())
            with patch('auth.time.time', return_value=__import__('time').time()+8*86400):
                self.assertIsNone(auth.user(token))
            auth.logout(token)
            self.assertIsNone(auth.user(token))
            one = auth.login('admin', 'test-password-12345', 'test-ip')
            two = auth.login('admin', 'test-password-12345', 'test-ip')
            self.assertTrue(auth.change_password(one, 'test-password-12345', 'another-password-67890', 'test-ip'))
            self.assertIsNone(auth.user(one))
            self.assertIsNone(auth.user(two))
            self.assertTrue(auth.login('admin', 'another-password-67890', 'test-ip'))

    def test_missing_config_refused_and_login_limited(self):
        from auth import Auth, RateLimited
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'auth.db'
            with self.assertRaises(ValueError): Auth(path)
            Auth.initialize(path, 'admin', 'test-password-12345')
            with self.assertRaises(ValueError): Auth.initialize(path, 'admin', 'replacement-password')
            auth = Auth(path)
            for _ in range(10): self.assertIsNone(auth.login('admin', 'bad', 'same-ip'))
            with self.assertRaises(RateLimited): auth.login('admin', 'test-password-12345', 'same-ip')

if __name__ == '__main__': unittest.main()
