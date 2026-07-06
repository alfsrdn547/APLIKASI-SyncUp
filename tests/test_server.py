"""Tests for the SyncUp backend's persistence helpers and migration logic.

These tests intentionally avoid touching the real `data.json` by monkey-patching
`server.DATA_FILE` to point inside a temporary directory. They do not start the
HTTP server, so the JSON shape that comes back from the auth/workspace endpoints
is tested separately in `test_endpoints.py`.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
SPEC = importlib.util.spec_from_file_location('syncup_server', os.path.join(ROOT, 'server.py'))
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


def _set_datafile(data_path):
    """Monkey-patch `server.DATA_FILE` and return an `uninstall` callable."""
    original = server.DATA_FILE
    server.DATA_FILE = data_path

    def uninstall():
        server.DATA_FILE = original

    return uninstall


class PersistenceTests(unittest.TestCase):
    def test_save_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_file = os.path.join(tmp, 'data.json')
            uninstall = _set_datafile(data_file)
            try:
                payload = {
                    'users': [],
                    'workspaces': [],
                    'activeUserId': None,
                    'activeWorkspaceId': None,
                }
                server.save_data(payload)
                self.assertEqual(server.load_data(), payload)
            finally:
                uninstall()

    def test_save_is_atomic(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_file = os.path.join(tmp, 'data.json')
            uninstall = _set_datafile(data_file)
            try:
                server.save_data({'version': 1, 'users': [], 'workspaces': []})
                leftovers = [n for n in os.listdir(tmp) if n.endswith('.tmp')]
                self.assertEqual(leftovers, [])
            finally:
                uninstall()

    def test_concurrent_writes_do_not_corrupt(self):
        import threading

        with tempfile.TemporaryDirectory() as tmp:
            data_file = os.path.join(tmp, 'data.json')
            uninstall = _set_datafile(data_file)
            try:
                errors = []

                def writer(idx):
                    try:
                        for i in range(20):
                            server.save_data({
                                'version': i,
                                'users': [{'id': f'user-{idx}-{i}'}],
                                'workspaces': [],
                            })
                    except Exception as exc:  # pragma: no cover - error path
                        errors.append(exc)

                threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()

                self.assertEqual(errors, [])
                with open(data_file, 'r', encoding='utf-8') as fh:
                    json.load(fh)
            finally:
                uninstall()


class MigrationTests(unittest.TestCase):
    def test_legacy_user_with_embedded_data_is_migrated(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_file = os.path.join(tmp, 'data.json')
            legacy = {
                'users': [{
                    'id': 'u1',
                    'name': 'Alfi',
                    'email': 'a@a.co',
                    'password': 'plain',
                    'members': [{'id': 'm1', 'name': 'Demo', 'role': 'Lead'}],
                    'tasks': [{
                        'id': 't1', 'title': 'T', 'date': '2026-07-07',
                        'priority': 'Sedang', 'assignee': 'Demo', 'done': False,
                    }],
                    'events': [],
                    'notes': ['halo'],
                }],
                'activeUserId': 'u1',
                'state': {'members': [], 'tasks': [], 'events': [], 'notes': []},
            }
            with open(data_file, 'w', encoding='utf-8') as fh:
                json.dump(legacy, fh)
            uninstall = _set_datafile(data_file)
            try:
                data = server.load_data()
            finally:
                uninstall()
            user = data['users'][0]
            self.assertNotIn('tasks', user)
            self.assertNotIn('members', user)
            self.assertNotIn('password', user)
            self.assertIn('passwordHash', user)
            self.assertEqual(len(user['workspaceIds']), 1)
            workspace = data['workspaces'][0]
            self.assertEqual(workspace['ownerId'], 'u1')
            self.assertEqual(len(workspace['tasks']), 1)
            self.assertEqual(workspace['tasks'][0]['status'], 'backlog')

    def test_legacy_password_is_hashed_on_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_file = os.path.join(tmp, 'data.json')
            legacy = {
                'users': [{
                    'id': 'u1', 'name': 'X', 'email': 'x@x.co',
                    'password': 'plain', 'members': [], 'tasks': [], 'events': [], 'notes': [],
                }],
                'workspaces': [],
                'activeUserId': None,
                'activeWorkspaceId': None,
            }
            with open(data_file, 'w', encoding='utf-8') as fh:
                json.dump(legacy, fh)
            uninstall = _set_datafile(data_file)
            try:
                data = server.load_data()
            finally:
                uninstall()
            user = data['users'][0]
            self.assertTrue(user['passwordHash'].startswith('$2'))
            self.assertTrue(server._verify_password('plain', user['passwordHash']))


class PasswordHashingTests(unittest.TestCase):
    def test_hash_and_verify(self):
        h = server._hash_password('hunter2')
        self.assertTrue(h.startswith('$2'))
        self.assertTrue(server._verify_password('hunter2', h))
        self.assertFalse(server._verify_password('wrong', h))

    def test_legacy_plain_password_still_verifies(self):
        self.assertTrue(server._verify_password('plain', 'plain'))
        self.assertFalse(server._verify_password('plain', 'plain2'))


if __name__ == '__main__':
    unittest.main()
