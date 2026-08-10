"""Tests for the SyncUp backend's persistence helpers and migration logic.

These tests avoid touching the real database by monkey-patching
`database.DB_FILE` to point inside a temporary directory.
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


def _set_db(db_path):
    """Monkey-patch `database.DB_FILE` and return an `uninstall` callable."""
    original = server.database.DB_FILE
    server.database.DB_FILE = db_path

    def uninstall():
        server.database.DB_FILE = original

    return uninstall


def _set_datafile(data_path):
    """Legacy JSON path used for migration / bootstrap tests."""
    original = server.DATA_FILE
    server.DATA_FILE = data_path

    def uninstall():
        server.DATA_FILE = original

    return uninstall


class PersistenceTests(unittest.TestCase):
    def test_save_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_file = os.path.join(tmp, 'syncup.db')
            uninstall_db = _set_db(db_file)
            uninstall_json = _set_datafile(os.path.join(tmp, 'no-import.json'))
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
                uninstall_json()
                uninstall_db()

    def test_save_is_atomic(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_file = os.path.join(tmp, 'syncup.db')
            uninstall_db = _set_db(db_file)
            uninstall_json = _set_datafile(os.path.join(tmp, 'no-import.json'))
            try:
                server.save_data({'users': [], 'workspaces': [], 'activeUserId': None, 'activeWorkspaceId': None})
                self.assertTrue(os.path.isfile(db_file))
            finally:
                uninstall_json()
                uninstall_db()

    def test_concurrent_writes_do_not_corrupt(self):
        import threading

        with tempfile.TemporaryDirectory() as tmp:
            db_file = os.path.join(tmp, 'syncup.db')
            uninstall_db = _set_db(db_file)
            uninstall_json = _set_datafile(os.path.join(tmp, 'no-import.json'))
            try:
                errors = []

                def writer(idx):
                    try:
                        for i in range(20):
                            server.save_data({
                                'users': [{'id': f'user-{idx}-{i}', 'name': 'U', 'email': f'u{idx}{i}@x.co', 'passwordHash': 'x', 'workspaceIds': []}],
                                'workspaces': [],
                                'activeUserId': None,
                                'activeWorkspaceId': None,
                            })
                    except Exception as exc:  # pragma: no cover - error path
                        errors.append(exc)

                threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()

                self.assertEqual(errors, [])
                server.load_data()
            finally:
                uninstall_json()
                uninstall_db()


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
            uninstall_db = _set_db(os.path.join(tmp, 'syncup.db'))
            uninstall_json = _set_datafile(data_file)
            try:
                data = server.load_data()
            finally:
                uninstall_json()
                uninstall_db()
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
            uninstall_db = _set_db(os.path.join(tmp, 'syncup.db'))
            uninstall_json = _set_datafile(data_file)
            try:
                data = server.load_data()
            finally:
                uninstall_json()
                uninstall_db()
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
