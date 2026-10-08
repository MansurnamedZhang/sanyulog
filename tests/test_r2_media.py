"""Private ciphertext boundary tests; never contact R2 or use real credentials."""
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import traceback
import unittest
from unittest.mock import patch

from storage_crypto import StorageCipher
from r2_media import R2Credentials, R2Error, R2Mirror, create_r2_client, object_key


class S3Failure(Exception):
    def __init__(self, code):
        self.response = {'Error': {'Code': code}, 'ResponseMetadata': {'HTTPStatusCode': int(code)}}
        super().__init__('SDK diagnostic with fake-secret and fake-access')


class MemoryS3:
    """External S3 boundary double, including conditional writes and metadata."""
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.fail = None
        self.corrupt_head = False
        self.corrupt_get = False
        self.race = None

    def check(self, operation):
        self.calls.append(operation)
        if self.fail == operation:
            raise S3Failure('403')

    def put_object(self, *, Bucket, Key, Body, Metadata, ContentType, IfNoneMatch):
        self.check('put')
        if self.race:
            self.objects[(Bucket, Key)] = self.race
            self.race = None
        if IfNoneMatch != '*':
            raise AssertionError('creation must be conditional')
        if (Bucket, Key) in self.objects:
            raise S3Failure('412')
        self.objects[(Bucket, Key)] = (Body, dict(Metadata), ContentType)
        return {'ETag': 'not-a-sha256'}

    def head_object(self, *, Bucket, Key):
        self.check('head')
        if (Bucket, Key) not in self.objects:
            raise S3Failure('404')
        body, metadata, content_type = self.objects[(Bucket, Key)]
        return {'ContentLength': len(body) + int(self.corrupt_head),
                'Metadata': dict(metadata), 'ContentType': content_type, 'ETag': 'not-a-sha256'}

    def get_object(self, *, Bucket, Key):
        self.check('get')
        if (Bucket, Key) not in self.objects:
            raise S3Failure('404')
        body, metadata, content_type = self.objects[(Bucket, Key)]
        return {'Body': io.BytesIO(body + (b'!' if self.corrupt_get else b'')),
                'ContentLength': len(body), 'Metadata': dict(metadata), 'ContentType': content_type,
                'ETag': 'not-a-sha256'}

    def delete_object(self, *, Bucket, Key):
        self.check('delete')
        self.objects.pop((Bucket, Key), None)
        return {}


class R2MirrorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        key = Path(self.tmp.name) / 'storage.key'
        key.write_bytes(bytes(range(32)))
        self.cipher = StorageCipher(key)
        self.plaintext = b'private attachment'
        self.digest = hashlib.sha256(self.plaintext).hexdigest()
        self.blob = self.cipher.encrypt(self.plaintext, 'attachment:' + self.digest)
        self.client = MemoryS3()
        self.mirror = R2Mirror(self.client, 'sanyulog-media')

    def upload(self, blob=None):
        self.mirror.put_ciphertext('owner', self.digest, blob or self.blob, self.cipher)

    def test_keys_use_account_isolation(self):
        self.assertEqual(object_key('owner', 'a' * 64), 'v1/owner/' + 'a' * 64)
        self.assertEqual(object_key('0' * 32, 'a' * 64), 'v1/' + '0' * 32 + '/' + 'a' * 64)

    def test_invalid_keys_are_rejected_before_sdk_access(self):
        for account, digest in [('..', self.digest), ('owner/../other', self.digest),
                                ('A' * 32, self.digest), ('owner', '../x'),
                                ('owner', 'A' * 64), ('owner', 'a' * 63), (None, self.digest)]:
            with self.subTest(account=account, digest=digest):
                for method, args in [(self.mirror.get_ciphertext, (account, digest)),
                                     (self.mirror.delete_ciphertext, (account, digest)),
                                     (self.mirror.put_ciphertext, (account, digest, self.blob, self.cipher))]:
                    with self.assertRaises(ValueError):
                        method(*args)
        self.assertEqual(self.client.calls, [])

    def test_upload_reads_back_same_ciphertext_and_metadata(self):
        self.upload()
        self.assertEqual(self.mirror.get_ciphertext('owner', self.digest), self.blob)
        body, metadata, content_type = next(iter(self.client.objects.values()))
        self.assertEqual(body, self.blob)
        self.assertEqual(metadata['ciphertext-sha256'], hashlib.sha256(self.blob).hexdigest())
        self.assertEqual(content_type, 'application/octet-stream')
        self.assertLess(self.client.calls.index('put'), self.client.calls.index('get'))
        self.assertEqual(self.client.calls[-3:], ['get', 'head', 'get'])

    def test_same_plaintext_with_different_nonce_keeps_existing_blob(self):
        self.upload()
        replacement = self.cipher.encrypt(self.plaintext, 'attachment:' + self.digest)
        self.assertNotEqual(replacement, self.blob)
        self.upload(replacement)
        self.assertEqual(self.mirror.get_ciphertext('owner', self.digest), self.blob)

    def test_existing_conflicting_content_is_never_overwritten(self):
        wrong = self.cipher.encrypt(b'wrong', 'attachment:' + self.digest)
        self.client.objects[('sanyulog-media', 'v1/owner/' + self.digest)] = (
            wrong, {'ciphertext-sha256': hashlib.sha256(wrong).hexdigest()}, 'application/octet-stream')
        with self.assertRaises(R2Error):
            self.upload()
        self.assertEqual(next(iter(self.client.objects.values()))[0], wrong)
        self.assertNotIn('put', self.client.calls)

    def test_concurrent_creation_validates_winner_without_overwriting(self):
        other_nonce = self.cipher.encrypt(self.plaintext, 'attachment:' + self.digest)
        self.client.race = (other_nonce, {'ciphertext-sha256': hashlib.sha256(other_nonce).hexdigest()},
                            'application/octet-stream')
        self.upload()
        self.assertEqual(self.mirror.get_ciphertext('owner', self.digest), other_nonce)

    def test_plaintext_wrong_hash_and_wrong_key_are_rejected(self):
        for blob, cipher in [(self.plaintext, self.cipher),
                             (self.cipher.encrypt(b'wrong', 'attachment:' + self.digest), self.cipher),
                             (self.blob, StorageCipher())]:
            with self.subTest(blob=blob[:8]):
                with self.assertRaises(R2Error):
                    self.mirror.put_ciphertext('owner', self.digest, blob, cipher)
        self.assertFalse(self.client.objects)

    def test_head_size_and_get_bytes_are_verified(self):
        for kind in ('corrupt_head', 'corrupt_get'):
            with self.subTest(kind=kind):
                self.client.objects.clear()
                setattr(self.client, kind, True)
                with self.assertRaises(R2Error):
                    self.upload()
                setattr(self.client, kind, False)

    def test_metadata_sha256_is_not_replaced_by_etag(self):
        self.upload()
        key = ('sanyulog-media', 'v1/owner/' + self.digest)
        body, _, content_type = self.client.objects[key]
        for metadata in ({}, {'ciphertext-sha256': '0' * 64}):
            self.client.objects[key] = (body, metadata, content_type)
            with self.assertRaises(R2Error):
                self.mirror.get_ciphertext('owner', self.digest)

    def test_delete_is_account_scoped_and_idempotent(self):
        self.upload()
        self.mirror.put_ciphertext('1' * 32, self.digest, self.blob, self.cipher)
        self.mirror.delete_ciphertext('owner', self.digest)
        self.mirror.delete_ciphertext('owner', self.digest)
        self.assertEqual(self.mirror.get_ciphertext('1' * 32, self.digest), self.blob)
        with self.assertRaises(R2Error):
            self.mirror.get_ciphertext('owner', self.digest)

    def test_sdk_errors_are_sanitized_in_exception_and_traceback(self):
        for operation in ('head', 'put', 'get', 'delete'):
            with self.subTest(operation=operation):
                self.client.fail = None
                self.client.objects.clear()
                if operation == 'get':
                    self.upload()
                self.client.fail = operation
                try:
                    if operation == 'delete':
                        self.mirror.delete_ciphertext('owner', self.digest)
                    elif operation == 'get':
                        self.mirror.get_ciphertext('owner', self.digest)
                    else:
                        self.upload()
                except R2Error as error:
                    rendered = ''.join(traceback.format_exception(error))
                    self.assertNotIn('fake-secret', rendered)
                    self.assertNotIn('fake-access', rendered)
                else:
                    self.fail('SDK failure was accepted')


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'r2.json'
        self.path.write_text(json.dumps({'access_key_id': 'fake-access', 'secret_access_key': 'fake-secret'}))
        self.path.chmod(0o600)

    @unittest.skipUnless(os.name == 'posix', 'credential privacy requires Linux/POSIX permissions')
    def test_private_file_loads_without_exposing_secrets_in_repr(self):
        credentials = R2Credentials.load(self.path)
        self.assertEqual(credentials.access_key_id, 'fake-access')
        self.assertEqual(credentials.secret_access_key, 'fake-secret')
        self.assertNotIn('fake-', repr(credentials))

    @unittest.skipUnless(os.name == 'posix', 'credential privacy requires Linux/POSIX permissions')
    def test_group_or_world_access_is_rejected(self):
        for mode in (0o640, 0o604, 0o666):
            self.path.chmod(mode)
            with self.assertRaises(R2Error):
                R2Credentials.load(self.path)

    @unittest.skipUnless(os.name == 'posix', 'symlink creation and private permissions require POSIX')
    def test_symbolic_link_is_rejected(self):
        link = self.path.with_name('link.json')
        link.symlink_to(self.path)
        with self.assertRaises(R2Error):
            R2Credentials.load(link)

    @unittest.skipUnless(os.name == 'posix', 'credential privacy requires Linux/POSIX permissions')
    def test_schema_and_parse_errors_do_not_leak_contents(self):
        for content in ('fake-secret invalid JSON', '{}',
                        '{"access_key_id":"fake-access","secret_access_key":""}',
                        '{"access_key_id":"fake-access","secret_access_key":"fake-secret","extra":1}'):
            self.path.write_text(content)
            with self.assertRaises(R2Error) as result:
                R2Credentials.load(self.path)
            self.assertNotIn('fake-', str(result.exception))

    @unittest.skipUnless(os.name == 'nt', 'Windows-only fail-closed boundary')
    def test_windows_acl_privacy_is_not_assumed(self):
        with self.assertRaises(R2Error):
            R2Credentials.load(self.path)

    def test_client_uses_private_endpoint_with_bounded_timeouts(self):
        credentials = R2Credentials('fake-access', 'fake-secret')
        import boto3
        with patch.object(boto3, 'client', return_value='client') as factory:
            self.assertEqual(create_r2_client('a' * 32, credentials), 'client')
        args = factory.call_args.kwargs
        self.assertEqual(args['endpoint_url'], 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com')
        self.assertEqual(args['region_name'], 'auto')
        self.assertGreater(args['config'].connect_timeout, 0)
        self.assertLessEqual(args['config'].connect_timeout, 10)
        self.assertLessEqual(args['config'].read_timeout, 30)
        with self.assertRaises(ValueError):
            create_r2_client('../attacker', credentials)

    def test_client_creation_failure_is_sanitized(self):
        import boto3
        with patch.object(boto3, 'client', side_effect=RuntimeError('fake-secret')):
            with self.assertRaises(R2Error) as result:
                create_r2_client('a' * 32, R2Credentials('fake-access', 'fake-secret'))
        self.assertNotIn('fake-', str(result.exception))
