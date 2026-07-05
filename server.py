import json
import os
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(__file__)
DATA_FILE = os.path.join(ROOT, 'data.json')
UPLOAD_DIR = os.path.join(ROOT, 'uploads')
os.makedirs(UPLOAD_DIR, exist_ok=True)


def load_data():
    if not os.path.exists(DATA_FILE):
        return {'users': [], 'activeUserId': None, 'state': None}
    with open(DATA_FILE, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def save_data(payload):
    with open(DATA_FILE, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/workspace':
            self._send_json(load_data())
            return
        if parsed.path in ('/', '/index.html'):
            with open(os.path.join(ROOT, 'index.html'), 'rb') as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        file_path = os.path.normpath(os.path.join(ROOT, parsed.path.lstrip('/')))
        if os.path.commonpath([ROOT, file_path]) == ROOT and os.path.isfile(file_path):
            with open(file_path, 'rb') as fh:
                body = fh.read()
            ext = os.path.splitext(file_path)[1].lower()
            content_type = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
            }.get(ext, 'application/octet-stream')
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/workspace':
            length = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            save_data(payload)
            self._send_json({'ok': True})
            return

        if parsed.path == '/api/upload':
            content_type = self.headers.get('Content-Type', '')
            if 'multipart/form-data' not in content_type:
                self.send_response(400)
                self.end_headers()
                return

            boundary = content_type.split('boundary=', 1)[1].encode()
            data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            parts = data.split(b'--' + boundary)
            uploaded_name = ''
            for part in parts:
                if b'filename=' in part and b'Content-Type' in part:
                    lines = part.split(b'\r\n')
                    header = next((line for line in lines if b'filename=' in line), b'')
                    if header:
                        uploaded_name = header.split(b'filename="', 1)[1].split(b'"', 1)[0].decode('utf-8', 'ignore')
                        body = b'\r\n'.join(lines[lines.index(b'') + 1:])
                        body = body.split(b'\r\n--', 1)[0]
                        target_path = os.path.join(UPLOAD_DIR, uploaded_name)
                        with open(target_path, 'wb') as fh:
                            fh.write(body)
                        break

            self._send_json({'ok': True, 'filename': uploaded_name})
            return

        self.send_response(404)
        self.end_headers()


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8000), Handler)
    print('Server SyncUp berjalan di http://127.0.0.1:8000')
    server.serve_forever()
