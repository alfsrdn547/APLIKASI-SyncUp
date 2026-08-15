"""SyncUp backend server.

A small threaded HTTP server that serves the static frontend, the JSON workspace
API, and the multi-user auth + workspace management endpoints. Application state
is persisted in SQLite (`syncup.db`); legacy `data.json` is imported once when
the database is empty.
"""

import json
import os
import re
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import bcrypt

import database

ROOT = os.path.dirname(__file__)
DATA_FILE = os.path.join(ROOT, 'data.json')
UPLOAD_DIR = os.path.join(ROOT, 'uploads')
BACKUP_DIR = os.path.join(ROOT, 'backups')

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(BACKUP_DIR, exist_ok=True)

# In-memory session store. Token -> { userId, createdAt }.
# Sessions are lost on restart, which is acceptable for a local MVP.
SESSIONS: dict = {}
SESSIONS_LOCK = threading.Lock()

# ---- Constants --------------------------------------------------------------

VALID_PRIORITIES = {'Tinggi', 'Sedang', 'Rendah'}
VALID_TASK_STATUS = {'backlog', 'ongoing', 'done'}
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
ALLOWED_UPLOAD_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.doc', '.docx', '.zip'}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

DEFAULT_TAGS = [
    {'id': 'tag-bug', 'name': 'Bug', 'color': '#ef4444'},
    {'id': 'tag-feature', 'name': 'Feature', 'color': '#3861fb'},
    {'id': 'tag-docs', 'name': 'Docs', 'color': '#10b981'},
    {'id': 'tag-design', 'name': 'Design', 'color': '#a855f7'},
]


# ---- Helpers ----------------------------------------------------------------

def _empty_workspace(name, owner_id, owner_name):
    """Return a fresh workspace with sensible defaults."""
    return {
        'id': str(uuid.uuid4()),
        'name': name,
        'description': '',
        'ownerId': owner_id,
        'createdAt': _iso_now(),
        'members': [
            {
                'id': str(uuid.uuid4()),
                'userId': owner_id,
                'name': owner_name,
                'role': 'Owner',
                'joinedAt': _iso_now(),
            }
        ],
        'invites': [],
        'tags': list(DEFAULT_TAGS),
        'tasks': [],
        'events': [],
        'notes': [],
        'comments': [],   # workspace-level index of recent comment activity
        'activity': [],   # workspace-level activity log
        'archived': {'tasks': [], 'events': []},
    }


def _iso_now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _today_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).date().isoformat()


def _public_user(user):
    """Strip the password hash before returning a user object to the client."""
    return {
        'id': user['id'],
        'name': user['name'],
        'email': user['email'],
        'createdAt': user.get('createdAt'),
    }


def _hash_password(password):
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def _verify_password(password, stored):
    """Verify against either a bcrypt hash or (legacy) plain text and
    transparently re-hash to bcrypt on a successful legacy match."""
    if stored.startswith('$2'):
        return bcrypt.checkpw(password.encode('utf-8'), stored.encode('utf-8'))
    return stored == password


def _migrate_legacy_user(user, data):
    """If a user record is in the old embedded-data shape, lift the embedded
    lists into a new workspace and rewrite the user to the new minimal shape.
    Returns the (possibly mutated) data dict.
    """
    if 'workspaceIds' in user:
        return data  # already migrated

    legacy_keys = {'members', 'tasks', 'events', 'notes'}
    has_legacy_data = bool(legacy_keys.intersection(user.keys()))
    has_plain_password = 'password' in user and 'passwordHash' not in user

    if not has_legacy_data and not has_plain_password:
        # Already on the new shape; just make sure they have a workspace.
        if not user.get('workspaceIds'):
            workspace = _empty_workspace('Workspace Pribadi', user['id'], user['name'])
            data.setdefault('workspaces', []).append(workspace)
            user['workspaceIds'] = [workspace['id']]
        return data

    if not has_legacy_data and has_plain_password:
        # User is new-shape but still has a plain password; promote it.
        user['passwordHash'] = _hash_password(user.pop('password'))
        if not user.get('workspaceIds'):
            workspace = _empty_workspace('Workspace Pribadi', user['id'], user['name'])
            data.setdefault('workspaces', []).append(workspace)
            user['workspaceIds'] = [workspace['id']]
        return data

    # Old shape: data is embedded under the user record.
    workspace = _empty_workspace('Workspace Pribadi', user['id'], user['name'])
    workspace['members'] = user.get('members') or workspace['members']
    workspace['tasks'] = _normalize_tasks(user.get('tasks') or [])
    workspace['events'] = user.get('events') or []
    workspace['notes'] = user.get('notes') or []
    data.setdefault('workspaces', []).append(workspace)
    user['workspaceIds'] = [workspace['id']]
    for k in legacy_keys:
        user.pop(k, None)
    if 'password' in user and 'passwordHash' not in user:
        user['passwordHash'] = _hash_password(user.pop('password'))
    else:
        user.pop('password', None)
    return data


def _migrate_legacy_data(data):
    """Apply _migrate_legacy_user to every user; also wrap a flat top-level
    `state` block (old shape) into a workspace if present and no user
    workspaces exist yet.
    """
    data.setdefault('users', [])
    data.setdefault('workspaces', [])
    data.setdefault('activeUserId', None)
    data.setdefault('activeWorkspaceId', None)

    for user in data['users']:
        data = _migrate_legacy_user(user, data)

    return data


def _normalize_tasks(tasks):
    out = []
    for task in tasks:
        status = task.get('status') or ('done' if task.get('done') else 'backlog')
        if status not in VALID_TASK_STATUS:
            status = 'backlog'
        normalized = dict(task)
        normalized['status'] = status
        normalized['done'] = status == 'done'
        # Migrate legacy assignee (name) -> assigneeId (None when unknown).
        if 'assigneeId' not in normalized:
            normalized['assigneeId'] = None
        normalized.setdefault('tags', [])
        normalized.setdefault('comments', [])
        normalized.setdefault('recurrence', 'none')
        normalized.setdefault('estimatedHours', None)
        normalized.setdefault('actualSeconds', 0)
        out.append(normalized)
    return out


def _normalize_events(events):
    out = []
    for event in events:
        normalized = dict(event)
        normalized.setdefault('tags', [])
        normalized.setdefault('comments', [])
        out.append(normalized)
    return out


# ---- Persistence (SQLite via database.py) -----------------------------------

def load_data():
    """Load from SQLite (import legacy data.json once if DB is empty)."""
    database.bootstrap_from_json(DATA_FILE, BACKUP_DIR, migrate_fn=_migrate_legacy_data)
    data = database.load_data()

    # Re-run migration if an older export still embeds lists on user records.
    if any('members' in u or 'tasks' in u for u in data.get('users', [])):
        backup_path = os.path.join(BACKUP_DIR, 'data.pre-migration.json')
        try:
            with open(backup_path, 'w', encoding='utf-8') as fh:
                json.dump(data, fh, indent=2, ensure_ascii=False)
        except OSError:
            pass
        data = _migrate_legacy_data(data)
        save_data(data)

    data.setdefault('workspaces', [])
    data.setdefault('activeWorkspaceId', None)
    return data


def save_data(payload):
    """Persist application state to SQLite."""
    database.save_data(payload)


# ---- Request helpers --------------------------------------------------------

def _read_json(handler):
    length = int(handler.headers.get('Content-Length', 0) or 0)
    if length == 0:
        return {}
    body = handler.rfile.read(length).decode('utf-8')
    if not body:
        return {}
    return json.loads(body)


def _send_json(handler, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    handler.end_headers()
    handler.wfile.write(body)


def _send_error(handler, status, message):
    _send_json(handler, {'ok': False, 'error': message}, status=status)


def _require_auth(handler):
    """Return (user, None) on success or (None, response_handler) on failure."""
    auth = handler.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        _send_error(handler, 401, 'Token tidak ditemukan. Silakan login ulang.')
        return None, True
    token = auth[7:].strip()
    with SESSIONS_LOCK:
        session = SESSIONS.get(token)
    if not session:
        _send_error(handler, 401, 'Sesi tidak valid. Silakan login ulang.')
        return None, True

    data = load_data()
    user = next((u for u in data['users'] if u['id'] == session['userId']), None)
    if not user:
        _send_error(handler, 401, 'Pengguna tidak ditemukan.')
        return None, True
    return (user, data, token), None


def _require_member(user, data, workspace_id):
    """Return workspace if user is a member, else send 403 and return None."""
    workspace = next((w for w in data['workspaces'] if w['id'] == workspace_id), None)
    if not workspace:
        return None
    is_member = any(m['userId'] == user['id'] for m in workspace['members'])
    if not is_member:
        return None
    return workspace


# ---- HTTP handler -----------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Quieter access log; uncomment to debug.
        return

    # ----- CORS preflight -----
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        self.end_headers()

    # ----- GET -----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'

        if path == '/api/workspace':
            auth = self._authed()
            if not auth:
                return
            user, data, _ = auth
            workspace = _resolve_workspace(user, data)
            _send_json(self, {
                'users': [_public_user(u) for u in data['users']],
                'workspaces': [w for w in data['workspaces']
                               if any(m['userId'] == user['id'] for m in w['members'])],
                'activeUserId': user['id'],
                'activeWorkspaceId': workspace['id'] if workspace else None,
                'workspace': workspace,
            })
            return

        if path in ('', '/', '/index.html', '/login', '/login.html'):
            self._serve_file(os.path.join(ROOT, 'index.html'), 'text/html; charset=utf-8')
            return

        if path in ('/app', '/app.html'):
            self._serve_file(os.path.join(ROOT, 'app.html'), 'text/html; charset=utf-8')
            return

        if path.startswith('/uploads/'):
            self._serve_file(os.path.join(ROOT, path.lstrip('/')), None)
            return

        # Static files
        self._serve_file(os.path.join(ROOT, path.lstrip('/')), None)
        return

    # ----- POST -----
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'

        if path == '/api/auth/register':
            self._handle_register()
            return

        if path == '/api/auth/login':
            self._handle_login()
            return

        if path == '/api/auth/logout':
            self._handle_logout()
            return

        if path == '/api/workspaces':
            self._handle_create_workspace()
            return

        if path == '/api/upload':
            self._handle_upload()
            return

        if path.startswith('/api/workspaces/') and path.endswith('/switch'):
            self._handle_switch_workspace(path)
            return

        if path == '/api/workspace/save':
            self._handle_save_workspace()
            return

        _send_error(self, 404, 'Endpoint tidak ditemukan.')

    # ----- PATCH -----
    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'
        parts = [p for p in path.split('/') if p]
        # /api/workspaces/<id>
        if len(parts) == 3 and parts[0] == 'api' and parts[1] == 'workspaces':
            self._handle_update_workspace(parts[2])
            return
        _send_error(self, 404, 'Endpoint tidak ditemukan.')

    # ----- DELETE -----
    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip('/') or '/'
        parts = [p for p in path.split('/') if p]
        if len(parts) == 3 and parts[0] == 'api' and parts[1] == 'workspaces':
            self._handle_delete_workspace(parts[2])
            return
        _send_error(self, 404, 'Endpoint tidak ditemukan.')

    # ----- Authenticated static & utility -----
    def _authed(self):
        result = _require_auth(self)
        if result[1]:
            return None
        return result[0]

    def _serve_file(self, file_path, content_type):
        file_path = os.path.normpath(file_path)
        if os.path.commonpath([ROOT, file_path]) != ROOT or not os.path.isfile(file_path):
            _send_error(self, 404, 'File tidak ditemukan.')
            return
        if content_type is None:
            ext = os.path.splitext(file_path)[1].lower()
            content_type = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
                '.pdf': 'application/pdf',
            }.get(ext, 'application/octet-stream')
        with open(file_path, 'rb') as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ----- Endpoint handlers -----
    def _handle_register(self):
        try:
            payload = _read_json(self)
        except json.JSONDecodeError:
            return _send_error(self, 400, 'Body request tidak valid.')

        name = (payload.get('name') or '').strip()
        email = (payload.get('email') or '').strip().lower()
        password = payload.get('password') or ''
        invite_code = (payload.get('inviteCode') or '').strip().upper() or None

        if not name or len(name) < 2:
            return _send_error(self, 400, 'Nama minimal 2 karakter.')
        if not EMAIL_RE.match(email):
            return _send_error(self, 400, 'Format email tidak valid.')
        if len(password) < 6:
            return _send_error(self, 400, 'Password minimal 6 karakter.')

        data = load_data()
        if any(u['email'].lower() == email for u in data['users']):
            return _send_error(self, 409, 'Email sudah terdaftar.')

        user = {
            'id': str(uuid.uuid4()),
            'name': name,
            'email': email,
            'passwordHash': _hash_password(password),
            'createdAt': _iso_now(),
            'workspaceIds': [],
        }
        data['users'].append(user)

        # Optionally join a workspace via invite code.
        joined_workspace = None
        if invite_code:
            for workspace in data['workspaces']:
                for invite in workspace.get('invites', []):
                    if invite.get('code') == invite_code and not invite.get('usedBy'):
                        role = invite.get('role') or 'Member'
                        workspace['members'].append({
                            'id': str(uuid.uuid4()),
                            'userId': user['id'],
                            'name': user['name'],
                            'role': role,
                            'joinedAt': _iso_now(),
                        })
                        invite['usedBy'] = user['id']
                        invite['usedAt'] = _iso_now()
                        user['workspaceIds'].append(workspace['id'])
                        joined_workspace = workspace
                        break
                if joined_workspace:
                    break

        if not joined_workspace:
            # Create a personal workspace.
            workspace = _empty_workspace(f'Workspace {name}', user['id'], user['name'])
            data['workspaces'].append(workspace)
            user['workspaceIds'].append(workspace['id'])

        data['activeUserId'] = user['id']
        data['activeWorkspaceId'] = user['workspaceIds'][0]
        save_data(data)

        token = self._issue_token(user['id'])
        _send_json(self, {
            'ok': True,
            'token': token,
            'user': _public_user(user),
            'workspaces': data['workspaces'],
            'activeWorkspaceId': data['activeWorkspaceId'],
        })

    def _handle_login(self):
        try:
            payload = _read_json(self)
        except json.JSONDecodeError:
            return _send_error(self, 400, 'Body request tidak valid.')

        email = (payload.get('email') or '').strip().lower()
        password = payload.get('password') or ''

        data = load_data()
        user = next((u for u in data['users'] if u['email'].lower() == email), None)
        if not user or not _verify_password(password, user.get('passwordHash') or user.get('password') or ''):
            return _send_error(self, 401, 'Email atau password salah.')

        # If the user only has a plain-text password (legacy), upgrade to bcrypt now.
        if 'passwordHash' not in user or not user['passwordHash'].startswith('$2'):
            user['passwordHash'] = _hash_password(password)
            user.pop('password', None)
            save_data(data)

        # Ensure the user has at least one workspace.
        if not user.get('workspaceIds'):
            workspace = _empty_workspace(f'Workspace {user["name"]}', user['id'], user['name'])
            data['workspaces'].append(workspace)
            user['workspaceIds'] = [workspace['id']]
            save_data(data)

        active_workspace_id = data.get('activeWorkspaceId')
        if active_workspace_id not in user.get('workspaceIds', []):
            active_workspace_id = user['workspaceIds'][0]
            data['activeWorkspaceId'] = active_workspace_id
            save_data(data)

        token = self._issue_token(user['id'])
        _send_json(self, {
            'ok': True,
            'token': token,
            'user': _public_user(user),
            'workspaces': data['workspaces'],
            'activeWorkspaceId': active_workspace_id,
        })

    def _handle_logout(self):
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            token = auth[7:].strip()
            with SESSIONS_LOCK:
                SESSIONS.pop(token, None)
        _send_json(self, {'ok': True})

    def _issue_token(self, user_id):
        token = secrets.token_urlsafe(32)
        with SESSIONS_LOCK:
            SESSIONS[token] = {'userId': user_id, 'createdAt': _iso_now()}
        return token

    def _handle_create_workspace(self):
        auth = self._authed()
        if not auth:
            return
        user, data, _ = auth
        try:
            payload = _read_json(self)
        except json.JSONDecodeError:
            return _send_error(self, 400, 'Body tidak valid.')
        name = (payload.get('name') or '').strip()
        description = (payload.get('description') or '').strip()
        if len(name) < 2:
            return _send_error(self, 400, 'Nama workspace minimal 2 karakter.')

        workspace = _empty_workspace(name, user['id'], user['name'])
        workspace['description'] = description
        data['workspaces'].append(workspace)
        user.setdefault('workspaceIds', []).append(workspace['id'])
        data['activeWorkspaceId'] = workspace['id']
        save_data(data)
        _send_json(self, {'ok': True, 'workspace': workspace})

    def _handle_update_workspace(self, workspace_id):
        auth = self._authed()
        if not auth:
            return
        user, data, _ = auth
        workspace = _require_member(user, data, workspace_id)
        if not workspace:
            return _send_error(self, 404, 'Workspace tidak ditemukan.')
        if workspace['ownerId'] != user['id']:
            return _send_error(self, 403, 'Hanya owner yang dapat mengubah workspace.')

        try:
            payload = _read_json(self)
        except json.JSONDecodeError:
            return _send_error(self, 400, 'Body tidak valid.')

        if 'name' in payload:
            name = (payload['name'] or '').strip()
            if len(name) < 2:
                return _send_error(self, 400, 'Nama minimal 2 karakter.')
            workspace['name'] = name
        if 'description' in payload:
            workspace['description'] = (payload['description'] or '').strip()
        if 'tasks' in payload:
            workspace['tasks'] = _normalize_tasks(payload['tasks'] or [])
        if 'events' in payload:
            workspace['events'] = _normalize_events(payload['events'] or [])
        if 'notes' in payload:
            workspace['notes'] = [str(n) for n in (payload['notes'] or [])]
        if 'members' in payload:
            workspace['members'] = payload['members']
        if 'tags' in payload:
            workspace['tags'] = payload['tags']
        if 'invites' in payload:
            workspace['invites'] = payload['invites']
        if 'activity' in payload:
            workspace['activity'] = payload['activity']
        if 'comments' in payload:
            workspace['comments'] = payload['comments']
        if 'archived' in payload:
            workspace['archived'] = payload['archived']

        save_data(data)
        _send_json(self, {'ok': True, 'workspace': workspace})

    def _handle_delete_workspace(self, workspace_id):
        auth = self._authed()
        if not auth:
            return
        user, data, _ = auth
        workspace = next((w for w in data['workspaces'] if w['id'] == workspace_id), None)
        if not workspace:
            return _send_error(self, 404, 'Workspace tidak ditemukan.')
        if workspace['ownerId'] != user['id']:
            return _send_error(self, 403, 'Hanya owner yang dapat menghapus workspace.')
        data['workspaces'] = [w for w in data['workspaces'] if w['id'] != workspace_id]
        user['workspaceIds'] = [wid for wid in user.get('workspaceIds', []) if wid != workspace_id]
        if data.get('activeWorkspaceId') == workspace_id:
            data['activeWorkspaceId'] = user['workspaceIds'][0] if user['workspaceIds'] else None
        save_data(data)
        _send_json(self, {'ok': True})

    def _handle_switch_workspace(self, path):
        auth = self._authed()
        if not auth:
            return
        user, data, _ = auth
        # path = /api/workspaces/<id>/switch
        parts = [p for p in path.split('/') if p]
        workspace_id = parts[2] if len(parts) >= 4 else None
        workspace = _require_member(user, data, workspace_id)
        if not workspace:
            return _send_error(self, 404, 'Workspace tidak ditemukan.')
        data['activeWorkspaceId'] = workspace_id
        save_data(data)
        _send_json(self, {'ok': True, 'workspace': workspace})

    def _handle_save_workspace(self):
        """Save arbitrary workspace fields. Mirrors PATCH /api/workspaces/<id>
        but lets the client send the whole workspace document in one shot.
        """
        auth = self._authed()
        if not auth:
            return
        user, data, _ = auth
        try:
            payload = _read_json(self)
        except json.JSONDecodeError:
            return _send_error(self, 400, 'Body tidak valid.')
        workspace_id = payload.get('id')
        workspace = _require_member(user, data, workspace_id)
        if not workspace:
            return _send_error(self, 404, 'Workspace tidak ditemukan.')

        for key in ('name', 'description', 'tasks', 'events', 'notes', 'members',
                    'tags', 'invites', 'activity', 'comments', 'archived'):
            if key in payload:
                value = payload[key]
                if key == 'tasks':
                    value = _normalize_tasks(value or [])
                elif key == 'events':
                    value = _normalize_events(value or [])
                elif key == 'notes':
                    value = [str(n) for n in (value or [])]
                workspace[key] = value

        save_data(data)
        _send_json(self, {'ok': True, 'workspace': workspace})

    def _handle_upload(self):
        auth = self._authed()
        if not auth:
            return

        content_type = self.headers.get('Content-Type', '')
        if 'multipart/form-data' not in content_type:
            return _send_error(self, 400, 'Content-Type harus multipart/form-data.')

        content_length = int(self.headers.get('Content-Length', 0) or 0)
        if content_length > MAX_UPLOAD_BYTES:
            return _send_error(self, 413, f'Ukuran file maksimal {MAX_UPLOAD_BYTES // (1024*1024)} MB.')

        boundary = content_type.split('boundary=', 1)[1].strip().strip('"').encode()
        raw = self.rfile.read(content_length)
        parts = raw.split(b'--' + boundary)
        uploaded_filename = None
        for part in parts:
            if b'filename=' not in part or b'Content-Type' not in part:
                continue
            header_blob = part.split(b'\r\n\r\n', 1)[0]
            headers = header_blob.split(b'\r\n')
            disposition = next((h for h in headers if h.lower().startswith(b'content-disposition')), b'')
            if b'filename="' not in disposition:
                continue
            original_name = disposition.split(b'filename="', 1)[1].split(b'"', 1)[0].decode('utf-8', 'ignore')
            safe_base = re.sub(r'[^A-Za-z0-9._-]', '_', os.path.basename(original_name)) or 'file'
            ext = os.path.splitext(safe_base)[1].lower()
            if ext not in ALLOWED_UPLOAD_EXTS:
                return _send_error(self, 415, f'Tipe file {ext} tidak diizinkan.')
            unique_name = f'{uuid.uuid4().hex}{ext}'
            body = part.split(b'\r\n\r\n', 1)[1]
            body = body.rsplit(b'\r\n--', 1)[0]
            target_path = os.path.join(UPLOAD_DIR, unique_name)
            with open(target_path, 'wb') as fh:
                fh.write(body)
            uploaded_filename = unique_name
            break

        if not uploaded_filename:
            return _send_error(self, 400, 'File tidak ditemukan dalam request.')

        _send_json(self, {'ok': True, 'filename': uploaded_filename})


def _resolve_workspace(user, data):
    """Find the active workspace for the user (fall back to the first one)."""
    workspace_id = data.get('activeWorkspaceId')
    for w in data['workspaces']:
        if w['id'] == workspace_id and any(m['userId'] == user['id'] for m in w['members']):
            return w
    for w in data['workspaces']:
        if any(m['userId'] == user['id'] for m in w['members']):
            return w
    return None


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8000), Handler)
    print('Server SyncUp berjalan di http://127.0.0.1:8000')
    print(f'Database: {database.DB_FILE}')
    print(f'Upload tersimpan di: {UPLOAD_DIR}')
    server.serve_forever()
