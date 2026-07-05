import importlib.util
import os
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('syncup_server', os.path.join(os.path.dirname(os.path.dirname(__file__)), 'server.py'))
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class ServerStorageTests(unittest.TestCase):
    def test_save_and_load_payload(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            original_data_file = server.DATA_FILE
            server.DATA_FILE = os.path.join(tmpdir, 'data.json')
            try:
                payload = {'users': [], 'activeUserId': None, 'state': {'tasks': []}}
                server.save_data(payload)
                self.assertEqual(server.load_data(), payload)
            finally:
                server.DATA_FILE = original_data_file


if __name__ == '__main__':
    unittest.main()
