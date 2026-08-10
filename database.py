"""SQLite persistence for SyncUp.

Replaces flat `data.json` with a relational store while keeping the same
in-memory dict shape expected by `server.py`.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(ROOT, 'syncup.db')
SCHEMA_FILE = os.path.join(ROOT, 'schema.sql')

DB_LOCK = threading.Lock()

_DEFAULT_ARCHIVED = {'tasks': [], 'events': []}


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_schema() -> None:
    with DB_LOCK:
        conn = _connect()
        try:
            if os.path.isfile(SCHEMA_FILE):
                with open(SCHEMA_FILE, 'r', encoding='utf-8') as fh:
                    conn.executescript(fh.read())
            else:
                conn.executescript(_FALLBACK_SCHEMA)
            conn.commit()
        finally:
            conn.close()


_FALLBACK_SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL,
    created_at TEXT,
    members_json TEXT NOT NULL DEFAULT '[]',
    invites_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    tasks_json TEXT NOT NULL DEFAULT '[]',
    events_json TEXT NOT NULL DEFAULT '[]',
    notes_json TEXT NOT NULL DEFAULT '[]',
    comments_json TEXT NOT NULL DEFAULT '[]',
    activity_json TEXT NOT NULL DEFAULT '[]',
    archived_json TEXT NOT NULL DEFAULT '{"tasks":[],"events":[]}'
);
CREATE TABLE IF NOT EXISTS user_workspaces (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def is_empty() -> bool:
    init_schema()
    with DB_LOCK:
        conn = _connect()
        try:
            count = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            ws_count = conn.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0]
            return count == 0 and ws_count == 0
        finally:
            conn.close()


def bootstrap_from_json(
    json_path: str,
    backup_dir: str | None = None,
    migrate_fn=None,
) -> bool:
    """Import legacy data.json into SQLite when the database is empty."""
    if not is_empty() or not os.path.isfile(json_path):
        return False
    with open(json_path, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
    if migrate_fn is not None:
        data = migrate_fn(data)
    save_data(data)
    if backup_dir:
        os.makedirs(backup_dir, exist_ok=True)
        try:
            shutil.copy2(json_path, os.path.join(backup_dir, 'data.pre-sqlite.json'))
        except OSError:
            pass
    return True


def _json_load(raw: str | None, default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def _workspace_from_row(row: sqlite3.Row) -> dict:
    return {
        'id': row['id'],
        'name': row['name'],
        'description': row['description'] or '',
        'ownerId': row['owner_id'],
        'createdAt': row['created_at'],
        'members': _json_load(row['members_json'], []),
        'invites': _json_load(row['invites_json'], []),
        'tags': _json_load(row['tags_json'], []),
        'tasks': _json_load(row['tasks_json'], []),
        'events': _json_load(row['events_json'], []),
        'notes': _json_load(row['notes_json'], []),
        'comments': _json_load(row['comments_json'], []),
        'activity': _json_load(row['activity_json'], []),
        'archived': _json_load(row['archived_json'], dict(_DEFAULT_ARCHIVED)),
    }


def _user_from_row(row: sqlite3.Row, workspace_ids: list[str]) -> dict:
    user = {
        'id': row['id'],
        'name': row['name'],
        'email': row['email'],
        'passwordHash': row['password_hash'],
        'workspaceIds': workspace_ids,
    }
    if row['created_at']:
        user['createdAt'] = row['created_at']
    return user


def load_data() -> dict:
    init_schema()
    with DB_LOCK:
        conn = _connect()
        try:
            ws_by_user: dict[str, list[str]] = {}
            for uid, wid in conn.execute(
                'SELECT user_id, workspace_id FROM user_workspaces ORDER BY user_id'
            ):
                ws_by_user.setdefault(uid, []).append(wid)

            users = []
            for row in conn.execute('SELECT * FROM users ORDER BY email'):
                users.append(_user_from_row(row, ws_by_user.get(row['id'], [])))

            workspaces = []
            for row in conn.execute('SELECT * FROM workspaces ORDER BY created_at, name'):
                workspaces.append(_workspace_from_row(row))

            settings = {
                r['key']: json.loads(r['value'])
                for r in conn.execute('SELECT key, value FROM app_settings')
            }

            return {
                'users': users,
                'workspaces': workspaces,
                'activeUserId': settings.get('activeUserId'),
                'activeWorkspaceId': settings.get('activeWorkspaceId'),
            }
        finally:
            conn.close()


def save_data(payload: dict) -> None:
    init_schema()
    users = payload.get('users') or []
    workspaces = payload.get('workspaces') or []
    payload_ids = {w['id'] for w in workspaces}

    with DB_LOCK:
        conn = _connect()
        try:
            conn.execute('BEGIN IMMEDIATE')

            for user in users:
                conn.execute(
                    """
                    INSERT INTO users (id, name, email, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        email = excluded.email,
                        password_hash = excluded.password_hash,
                        created_at = excluded.created_at
                    """,
                    (
                        user['id'],
                        user['name'],
                        user['email'],
                        user.get('passwordHash') or user.get('password') or '',
                        user.get('createdAt'),
                    ),
                )

            for wid in (r[0] for r in conn.execute('SELECT id FROM workspaces')):
                if wid not in payload_ids:
                    conn.execute('DELETE FROM workspaces WHERE id = ?', (wid,))

            for workspace in workspaces:
                archived = workspace.get('archived')
                if archived is None:
                    archived = dict(_DEFAULT_ARCHIVED)
                conn.execute(
                    """
                    INSERT INTO workspaces (
                        id, name, description, owner_id, created_at,
                        members_json, invites_json, tags_json, tasks_json,
                        events_json, notes_json, comments_json, activity_json, archived_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        description = excluded.description,
                        owner_id = excluded.owner_id,
                        created_at = excluded.created_at,
                        members_json = excluded.members_json,
                        invites_json = excluded.invites_json,
                        tags_json = excluded.tags_json,
                        tasks_json = excluded.tasks_json,
                        events_json = excluded.events_json,
                        notes_json = excluded.notes_json,
                        comments_json = excluded.comments_json,
                        activity_json = excluded.activity_json,
                        archived_json = excluded.archived_json
                    """,
                    (
                        workspace['id'],
                        workspace['name'],
                        workspace.get('description') or '',
                        workspace['ownerId'],
                        workspace.get('createdAt'),
                        json.dumps(workspace.get('members') or [], ensure_ascii=False),
                        json.dumps(workspace.get('invites') or [], ensure_ascii=False),
                        json.dumps(workspace.get('tags') or [], ensure_ascii=False),
                        json.dumps(workspace.get('tasks') or [], ensure_ascii=False),
                        json.dumps(workspace.get('events') or [], ensure_ascii=False),
                        json.dumps(workspace.get('notes') or [], ensure_ascii=False),
                        json.dumps(workspace.get('comments') or [], ensure_ascii=False),
                        json.dumps(workspace.get('activity') or [], ensure_ascii=False),
                        json.dumps(archived, ensure_ascii=False),
                    ),
                )

            conn.execute('DELETE FROM user_workspaces')
            for user in users:
                for wid in user.get('workspaceIds') or []:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO user_workspaces (user_id, workspace_id)
                        VALUES (?, ?)
                        """,
                        (user['id'], wid),
                    )

            for key in ('activeUserId', 'activeWorkspaceId'):
                conn.execute(
                    """
                    INSERT INTO app_settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (key, json.dumps(payload.get(key))),
                )

            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def import_from_json(json_path: str) -> None:
    with open(json_path, 'r', encoding='utf-8') as fh:
        save_data(json.load(fh))


if __name__ == '__main__':
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == 'init':
        init_schema()
        print(f'Skema SyncUp siap di {DB_FILE}')
    elif len(sys.argv) > 2 and sys.argv[1] == 'import':
        import_from_json(sys.argv[2])
        print(f'Data diimpor ke {DB_FILE}')
    else:
        print('Usage: python -m database init | python -m database import <path/to/data.json>')
