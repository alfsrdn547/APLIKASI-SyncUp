/* SyncUp — Frontend application logic
 *
 * The frontend is a single-page app that talks to the local Python backend
 * over `fetch`. After login/register the server returns a bearer token that
 * is stored in `localStorage` and sent on every subsequent request. All data
 * for the active user and their active workspace is mirrored in memory; on
 * any mutation we send the new state to the server in the background.
 *
 * Sections in this file, in order:
 *   1. Constants & helpers (escapeHtml, formatDate, etc.)
 *   2. API client (apiGet/apiPost/apiPatch with token + XHR header)
 *   3. Application state + persistence
 *   4. Auth flow (login / register / logout / restore session)
 *   5. Render layer (per panel: stats, tasks, kanban, agenda, notes, members,
 *      activity, notifications, tags, comments, search, calendar)
 *   6. Mutations (create/update/delete for tasks, events, notes, members,
 *      comments, tags, invites, profile)
 *   7. Activity log
 *   8. Notifications generator
 *   9. UI wiring (form submit, click delegation, drag-drop, keyboard
 *      shortcuts, theme, modals)
 *  10. Bootstrap
 */

'use strict';

// ---------------------------------------------------------------------------
// 1. Constants & helpers
// ---------------------------------------------------------------------------

const API_BASE = ''; // same origin
const TOKEN_KEY = 'syncup-token';
const ACTIVE_WORKSPACE_KEY = 'syncup-active-workspace';
const THEME_KEY = 'syncup-theme';
const ACCENT_KEY = 'syncup-accent';
const DRAFT_KEY = 'syncup-drafts';

const DEFAULT_TAGS = [
  { id: 'tag-bug', name: 'Bug', color: '#ef4444' },
  { id: 'tag-feature', name: 'Feature', color: '#3861fb' },
  { id: 'tag-docs', name: 'Docs', color: '#10b981' },
  { id: 'tag-design', name: 'Design', color: '#a855f7' },
];

const PRIORITIES = ['Tinggi', 'Sedang', 'Rendah'];
const TASK_STATUSES = ['backlog', 'ongoing', 'done'];
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];

const ACCENT_PRESETS = [
  { id: 'blue', color: '#3861fb' },
  { id: 'indigo', color: '#6366f1' },
  { id: 'purple', color: '#8b5cf6' },
  { id: 'rose', color: '#f43f5e' },
  { id: 'emerald', color: '#10b981' },
  { id: 'amber', color: '#f59e0b' },
];

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoNow() {
  return new Date().toISOString();
}

function relativeDate(targetIso) {
  if (!targetIso) return '';
  const target = new Date(targetIso);
  if (Number.isNaN(target.getTime())) return targetIso;
  const today = new Date(todayIso() + 'T00:00:00');
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return 'Hari ini';
  if (diffDays === 1) return 'Besok';
  if (diffDays === -1) return 'Kemarin';
  if (diffDays > 0) return `${diffDays} hari lagi`;
  return `${Math.abs(diffDays)} hari lalu`;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) {
    return iso;
  }
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} hari lalu`;
  return formatDate(iso);
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setHours(0, 0, 0, 0);
  return new Date(d.setDate(diff));
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function priorityColor(priority) {
  if (priority === 'Tinggi') return '#ef4444';
  if (priority === 'Sedang') return '#f59e0b';
  return '#10b981';
}

function statusLabel(status) {
  if (status === 'backlog') return 'Backlog';
  if (status === 'ongoing') return 'Ongoing';
  return 'Selesai';
}

function attachmentLink(filename) {
  if (!filename) return '';
  const ext = filename.split('.').pop().toLowerCase();
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
  const label = isImage ? '🖼️' : '📎';
  return `<a href="uploads/${encodeURIComponent(filename)}" target="_blank" class="attachment-link" data-filename="${escapeHtml(filename)}">${label} ${escapeHtml(filename)}</a>`;
}

function memberById(workspace, id) {
  if (!id || !workspace) return null;
  return (workspace.members || []).find((m) => m.id === id) || null;
}

function userMember(workspace, userId) {
  if (!workspace) return null;
  return (workspace.members || []).find((m) => m.userId === userId) || null;
}

function memberName(workspace, id) {
  const m = memberById(workspace, id);
  return m ? m.name : 'Tanpa nama';
}

function memberRole(workspace, id) {
  const m = memberById(workspace, id);
  return m ? m.role : '';
}

// ---------------------------------------------------------------------------
// 2. API client
// ---------------------------------------------------------------------------

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function apiRequest(method, path, body, options = {}) {
  const headers = {
    'X-Requested-With': 'SyncUpClient',
    Accept: 'application/json',
  };
  if (!(body instanceof FormData) && body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token && !options.skipAuth) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const init = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(API_BASE + path, init);
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    const message = (data && data.error) || `Permintaan gagal (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

const api = {
  register: (payload) => apiRequest('POST', '/api/auth/register', payload, { skipAuth: true }),
  login: (payload) => apiRequest('POST', '/api/auth/login', payload, { skipAuth: true }),
  logout: () => apiRequest('POST', '/api/auth/logout', undefined),
  workspace: () => apiRequest('GET', '/api/workspace'),
  saveWorkspace: (workspace) => apiRequest('POST', '/api/workspace/save', workspace),
  updateWorkspace: (id, patch) => apiRequest('PATCH', `/api/workspaces/${id}`, patch),
  createWorkspace: (payload) => apiRequest('POST', '/api/workspaces', payload),
  switchWorkspace: (id) => apiRequest('POST', `/api/workspaces/${id}/switch`, {}),
  deleteWorkspace: (id) => apiRequest('DELETE', `/api/workspaces/${id}`),
  upload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiRequest('POST', '/api/upload', fd);
  },
};

// ---------------------------------------------------------------------------
// 3. Application state
// ---------------------------------------------------------------------------

const app = {
  user: null, // { id, name, email, createdAt }
  workspaces: [], // all workspaces the user is a member of
  activeWorkspaceId: null,
  filter: { tasks: 'all', events: 'all', priority: 'all', date: '', search: '' },
  timer: { taskId: null, startedAt: null }, // in-memory time tracker state
  isDirty: false, // pending changes not yet persisted
  saveDebounced: null,
};

// Per-user read-states (e.g. notification read markers, comment read markers).
// Kept in memory only — server can ignore; we send them with the workspace save.
const readState = {
  notifications: {}, // notifId -> timestamp
  comments: {}, // taskId -> timestamp
};

function activeWorkspace() {
  return app.workspaces.find((w) => w.id === app.activeWorkspaceId) || null;
}

function currentUser() {
  return app.user;
}

function setActiveWorkspace(id) {
  app.activeWorkspaceId = id;
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, id || '');
  readState.notifications = {};
  readState.comments = {};
  renderAll();
}

function ensureWorkspaceShape(workspace) {
  workspace = workspace || {};
  workspace.members = workspace.members || [];
  workspace.invites = workspace.invites || [];
  workspace.tags = workspace.tags && workspace.tags.length ? workspace.tags : [...DEFAULT_TAGS];
  workspace.tasks = workspace.tasks || [];
  workspace.events = workspace.events || [];
  workspace.notes = workspace.notes || [];
  workspace.comments = workspace.comments || [];
  workspace.activity = workspace.activity || [];
  workspace.archived = workspace.archived || { tasks: [], events: [] };
  return workspace;
}

function applyWorkspace(workspace) {
  if (!workspace) return null;
  ensureWorkspaceShape(workspace);
  // Normalize tasks
  workspace.tasks = workspace.tasks.map((task) => {
    const status = TASK_STATUSES.includes(task.status) ? task.status : (task.done ? 'done' : 'backlog');
    return {
      id: task.id || uid(),
      title: task.title || 'Tanpa judul',
      date: task.date || todayIso(),
      priority: PRIORITIES.includes(task.priority) ? task.priority : 'Sedang',
      assigneeId: task.assigneeId || null,
      attachment: task.attachment || '',
      note: task.note || '',
      status,
      done: status === 'done',
      tags: Array.isArray(task.tags) ? task.tags : [],
      comments: Array.isArray(task.comments) ? task.comments : [],
      recurrence: RECURRENCES.includes(task.recurrence) ? task.recurrence : 'none',
      recurrenceEnd: task.recurrenceEnd || null,
      estimatedHours: typeof task.estimatedHours === 'number' ? task.estimatedHours : null,
      actualSeconds: typeof task.actualSeconds === 'number' ? task.actualSeconds : 0,
      createdBy: task.createdBy || null,
      createdAt: task.createdAt || isoNow(),
      updatedAt: task.updatedAt || isoNow(),
    };
  });
  // Normalize events
  workspace.events = workspace.events.map((event) => ({
    id: event.id || uid(),
    title: event.title || 'Tanpa judul',
    date: event.date || todayIso(),
    priority: PRIORITIES.includes(event.priority) ? event.priority : 'Sedang',
    note: event.note || '',
    tags: Array.isArray(event.tags) ? event.tags : [],
    comments: Array.isArray(event.comments) ? event.comments : [],
    createdBy: event.createdBy || null,
    createdAt: event.createdAt || isoNow(),
  }));
  return workspace;
}

async function loadInitial() {
  const token = getToken();
  if (!token) {
    app.user = null;
    app.workspaces = [];
    app.activeWorkspaceId = null;
    return;
  }
  try {
    const data = await api.workspace();
    applyServerData(data);
  } catch (error) {
    if (error.status === 401) {
      setToken('');
    }
    app.user = null;
    app.workspaces = [];
    app.activeWorkspaceId = null;
  }
}

function applyServerData(data) {
  app.user = data.user || null;
  const list = Array.isArray(data.workspaces) ? data.workspaces : [];
  app.workspaces = list.map(applyWorkspace);
  const stored = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  let active = data.activeWorkspaceId;
  if (stored && app.workspaces.some((w) => w.id === stored)) {
    active = stored;
  }
  if (!active || !app.workspaces.some((w) => w.id === active)) {
    active = app.workspaces[0] ? app.workspaces[0].id : null;
  }
  app.activeWorkspaceId = active;
  if (active) localStorage.setItem(ACTIVE_WORKSPACE_KEY, active);
}

function saveWorkspaceSoon() {
  app.isDirty = true;
  if (!app.saveDebounced) {
    app.saveDebounced = debounce(async () => {
      app.saveDebounced = null;
      const workspace = activeWorkspace();
      if (!workspace) return;
      app.isDirty = false;
      try {
        await api.saveWorkspace(workspace);
      } catch (error) {
        console.warn('Gagal menyimpan ke server:', error);
        app.isDirty = true;
      }
    }, 400);
  }
  app.saveDebounced();
}

// ---------------------------------------------------------------------------
// 4. Auth flow
// ---------------------------------------------------------------------------

const authScreen = document.getElementById('authScreen');
const appShell = document.getElementById('appShell');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const authMessage = document.getElementById('authMessage');
const authTabs = document.querySelectorAll('.auth-tab');
const currentUserName = document.getElementById('currentUserName');
const logoutBtn = document.getElementById('logoutBtn');
const inviteField = document.getElementById('registerInvite');
const loginSubmitBtn = loginForm.querySelector('button[type="submit"]');
const registerSubmitBtn = registerForm.querySelector('button[type="submit"]');

function showAuthMessage(message, isError = false) {
  authMessage.textContent = message || '';
  authMessage.style.color = isError ? '#dc2626' : '#10b981';
  if (message) {
    authMessage.classList.remove('hidden');
  } else {
    authMessage.classList.add('hidden');
  }
}

function setAuthBusy(formEl, busy) {
  if (!formEl) return;
  const btn = formEl.querySelector('button[type="submit"]');
  if (!btn) return;
  btn.disabled = busy;
  btn.dataset.originalLabel = btn.dataset.originalLabel || btn.textContent;
  btn.textContent = busy ? 'Memproses...' : btn.dataset.originalLabel;
}

function updateAuthView() {
  const loggedIn = Boolean(app.user && activeWorkspace());
  authScreen.classList.toggle('hidden', loggedIn);
  appShell.classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    currentUserName.textContent = app.user.name;
  }
  populateWorkspaceSwitcher();
  populateAssigneeOptions();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return;
  setAuthBusy(loginForm, true);
  try {
    const data = await api.login({ email, password });
    setToken(data.token);
    applyServerData(data);
    showAuthMessage('Berhasil masuk. Selamat datang kembali!');
    updateAuthView();
    renderAll();
  } catch (error) {
    showAuthMessage(error.message, true);
  } finally {
    setAuthBusy(loginForm, false);
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('registerName').value.trim();
  const email = document.getElementById('registerEmail').value.trim().toLowerCase();
  const password = document.getElementById('registerPassword').value;
  const confirm = document.getElementById('registerConfirm').value;
  const inviteCode = inviteField ? inviteField.value.trim().toUpperCase() : '';

  if (password.length < 6) {
    showAuthMessage('Password minimal 6 karakter.', true);
    return;
  }
  if (password !== confirm) {
    showAuthMessage('Konfirmasi password tidak cocok.', true);
    return;
  }
  setAuthBusy(registerForm, true);
  try {
    const data = await api.register({ name, email, password, inviteCode });
    setToken(data.token);
    applyServerData(data);
    showAuthMessage(inviteCode ? 'Akun dibuat dan Anda bergabung ke workspace.' : `Akun ${name} berhasil dibuat.`);
    updateAuthView();
    renderAll();
    if (data.workspaces && data.workspaces.length > 1) {
      openOnboarding();
    }
  } catch (error) {
    showAuthMessage(error.message, true);
  } finally {
    setAuthBusy(registerForm, false);
  }
});

authTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    authTabs.forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.authTab;
    loginForm.classList.toggle('hidden', target === 'register');
    registerForm.classList.toggle('hidden', target === 'login');
    showAuthMessage('');
  });
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api.logout();
  } catch (_) {
    // ignore — we still clear local state
  }
  setToken('');
  app.user = null;
  app.workspaces = [];
  app.activeWorkspaceId = null;
  localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  updateAuthView();
  showAuthMessage('Anda telah keluar. Sampai jumpa kembali!');
  loginForm.reset();
  registerForm.reset();
});

// ---------------------------------------------------------------------------
// 5. Render layer
// ---------------------------------------------------------------------------

const dom = {
  // Form
  form: document.getElementById('itemForm'),
  title: document.getElementById('title'),
  type: document.getElementById('type'),
  date: document.getElementById('date'),
  priority: document.getElementById('priority'),
  assignee: document.getElementById('assignee'),
  note: document.getElementById('note'),
  attachment: document.getElementById('attachment'),
  formTags: document.getElementById('formTags'),
  recurrence: document.getElementById('recurrence'),
  estimatedHours: document.getElementById('estimatedHours'),
  toggleForm: document.getElementById('toggleForm'),
  formPanel: document.getElementById('formPanel'),

  // Stats & topbar
  todayCount: document.getElementById('todayCount'),
  doneCount: document.getElementById('doneCount'),
  memberCount: document.getElementById('memberCount'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  completionRate: document.getElementById('completionRate'),
  weekEvents: document.getElementById('weekEvents'),
  activeNotes: document.getElementById('activeNotes'),

  // Deadlines & calendar
  deadlineList: document.getElementById('deadlineList'),
  calendarDate: document.getElementById('calendarDate'),
  priorityFilter: document.getElementById('priorityFilter'),
  eventsList: document.getElementById('eventsList'),

  // Tasks (kanban-style)
  taskSearch: document.getElementById('taskSearch'),
  taskFilter: document.getElementById('taskFilter'),
  backlogList: document.getElementById('backlogList'),
  ongoingList: document.getElementById('ongoingList'),
  doneList: document.getElementById('doneList'),

  // Notes
  noteForm: document.getElementById('noteForm'),
  noteInput: document.getElementById('noteInput'),
  notesList: document.getElementById('notesList'),

  // Members
  memberForm: document.getElementById('memberForm'),
  memberName: document.getElementById('memberName'),
  memberRole: document.getElementById('memberRole'),
  membersList: document.getElementById('membersList'),

  // Export
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),

  // Theme
  themeToggle: document.getElementById('themeToggle'),

  // Workspace switcher
  workspaceSwitcher: document.getElementById('workspaceSwitcher'),
  workspaceCreateBtn: document.getElementById('workspaceCreateBtn'),
  workspaceEditBtn: document.getElementById('workspaceEditBtn'),
  workspaceInviteBtn: document.getElementById('workspaceInviteBtn'),
  workspaceLeaveBtn: document.getElementById('workspaceLeaveBtn'),

  // Notifications
  notificationBell: document.getElementById('notificationBell'),
  notificationBadge: document.getElementById('notificationBadge'),
  notificationPanel: document.getElementById('notificationPanel'),
  notificationList: document.getElementById('notificationList'),

  // Search
  globalSearchTrigger: document.getElementById('globalSearchTrigger'),
  globalSearchModal: document.getElementById('globalSearchModal'),
  globalSearchInput: document.getElementById('globalSearchInput'),
  globalSearchResults: document.getElementById('globalSearchResults'),

  // Profile
  profileTrigger: document.getElementById('profileTrigger'),
  profileModal: document.getElementById('profileModal'),
  profileName: document.getElementById('profileName'),
  profileEmail: document.getElementById('profileEmail'),
  profileMessage: document.getElementById('profileMessage'),
  profileSaveBtn: document.getElementById('profileSaveBtn'),
  profileCurrentPassword: document.getElementById('profileCurrentPassword'),
  profileNewPassword: document.getElementById('profileNewPassword'),
  profilePasswordBtn: document.getElementById('profilePasswordBtn'),
  profileMessagePassword: document.getElementById('profileMessagePassword'),

  // Activity
  activityList: document.getElementById('activityList'),

  // Tags
  tagsManagerList: document.getElementById('tagsManagerList'),
  tagsManagerForm: document.getElementById('tagsManagerForm'),
  tagName: document.getElementById('tagName'),
  tagColor: document.getElementById('tagColor'),

  // Comments
  commentModal: document.getElementById('commentModal'),
  commentList: document.getElementById('commentList'),
  commentInput: document.getElementById('commentInput'),
  commentSubmit: document.getElementById('commentSubmit'),
  commentTarget: null, // { type, id, title }

  // Calendar
  calendarView: document.getElementById('calendarView'),
  calendarTitle: document.getElementById('calendarTitle'),
  calendarGrid: document.getElementById('calendarGrid'),
  calendarPrev: document.getElementById('calendarPrev'),
  calendarNext: document.getElementById('calendarNext'),
  calendarToday: document.getElementById('calendarToday'),
  calendarMonth: new Date(),

  // Onboarding
  onboardingModal: document.getElementById('onboardingModal'),
  onboardingClose: document.getElementById('onboardingClose'),
};

function renderAll() {
  renderStats();
  renderDeadlines();
  renderEvents();
  renderTasks();
  renderNotes();
  renderMembers();
  renderTagsPicker();
  renderTagsManager();
  renderActivity();
  renderNotifications();
  renderCalendar();
  populateWorkspaceSwitcher();
  populateAssigneeOptions();
}

function renderStats() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const today = todayIso();
  const todayEvents = workspace.events.filter((event) => event.date === today).length;
  const total = workspace.tasks.length;
  const completed = workspace.tasks.filter((task) => task.done).length;
  const rate = total === 0 ? 0 : Math.round((completed / total) * 100);

  dom.todayCount.textContent = todayEvents;
  dom.doneCount.textContent = completed;
  dom.memberCount.textContent = workspace.members.length;
  dom.completionRate.textContent = `${rate}%`;
  dom.activeNotes.textContent = workspace.notes.length;

  const weekStart = getWeekStart(new Date());
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
  const weekCount = workspace.events.filter((event) => {
    const d = new Date(event.date);
    return d >= weekStart && d < weekEnd;
  }).length;
  dom.weekEvents.textContent = weekCount;

  dom.progressBar.style.width = `${rate}%`;
  dom.progressBar.textContent = `${rate}%`;
  const nextTask = workspace.tasks.find((t) => !t.done);
  dom.progressText.textContent = nextTask
    ? `${completed} dari ${total} tugas selesai. Fokus: ${nextTask.title}.`
    : `${completed} dari ${total} tugas selesai. Hebat, semua tuntas!`;
}

function renderDeadlines() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const today = new Date(todayIso() + 'T00:00:00');
  const upcoming = workspace.tasks
    .filter((task) => !task.done)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 4);
  if (upcoming.length === 0) {
    dom.deadlineList.innerHTML = '<p class="muted-text">Tidak ada deadline yang akan datang.</p>';
    return;
  }
  dom.deadlineList.innerHTML = upcoming.map((task) => {
    const diff = Math.round((new Date(task.date) - today) / 86400000);
    const label = diff < 0 ? `Terlewat ${Math.abs(diff)} hari` : relativeDate(task.date);
    return `
      <div class="deadline-item" data-task-id="${task.id}">
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(label)} • ${escapeHtml(formatDate(task.date))}</small>
      </div>
    `;
  }).join('');
}

function renderEvents() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const date = dom.calendarDate.value;
  const priority = dom.priorityFilter.value;
  const filtered = workspace.events
    .filter((event) => !date || event.date === date)
    .filter((event) => priority === 'all' || event.priority === priority)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (filtered.length === 0) {
    dom.eventsList.innerHTML = '<p class="muted-text">Belum ada agenda pada filter ini.</p>';
    return;
  }
  dom.eventsList.innerHTML = filtered.map((event) => renderEventCard(event)).join('');
}

function renderEventCard(event) {
  return `
    <div class="list-item" data-event-id="${event.id}">
      <div>
        <strong>${escapeHtml(event.title)}</strong>
        <div class="task-meta">
          <span class="dot" style="background:${priorityColor(event.priority)}"></span>
          ${escapeHtml(formatDate(event.date))} • ${escapeHtml(event.priority)}
        </div>
        ${event.note ? `<small>${escapeHtml(event.note)}</small>` : ''}
        ${renderTagChips(event.tags)}
      </div>
      <div class="action-stack">
        <button class="badge ghost" data-action="open-comments" data-type="event" data-id="${event.id}">💬 ${event.comments.length}</button>
        <button class="badge danger" data-action="delete-event" data-id="${event.id}">Hapus</button>
      </div>
    </div>
  `;
}

function renderTasks() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const searchText = (dom.taskSearch.value || '').toLowerCase();
  const status = dom.taskFilter.value;
  const priority = dom.priorityFilter.value;
  const filtered = workspace.tasks.filter((task) => {
    const matchSearch = !searchText || task.title.toLowerCase().includes(searchText) || (task.note || '').toLowerCase().includes(searchText);
    const matchStatus = status === 'all' || (status === 'pending' ? !task.done : status === 'done' ? task.done : true);
    const matchPriority = priority === 'all' || task.priority === priority;
    return matchSearch && matchStatus && matchPriority;
  });
  const grouped = { backlog: [], ongoing: [], done: [] };
  filtered.forEach((task) => {
    const key = TASK_STATUSES.includes(task.status) ? task.status : (task.done ? 'done' : 'backlog');
    grouped[key].push(task);
  });
  renderTaskColumn(dom.backlogList, grouped.backlog, 'backlog');
  renderTaskColumn(dom.ongoingList, grouped.ongoing, 'ongoing');
  renderTaskColumn(dom.doneList, grouped.done, 'done');
}

function renderTaskColumn(target, tasks, status) {
  if (tasks.length === 0) {
    target.innerHTML = '<p class="muted-text">Tidak ada tugas.</p>';
    return;
  }
  target.innerHTML = tasks.map((task) => renderTaskCard(task, status)).join('');
}

function renderTaskCard(task, columnStatus) {
  const assignee = task.assigneeId ? memberName(activeWorkspace(), task.assigneeId) : 'Belum ditugaskan';
  const timeTracked = formatDuration(task.actualSeconds);
  const isTimerActive = app.timer.taskId === task.id;
  const recurringLabel = task.recurrence !== 'none' ? `🔁 ${task.recurrence}` : '';
  return `
    <div class="list-item kanban-card ${task.done ? 'done' : ''}" data-task-id="${task.id}" draggable="true">
      <div>
        <div class="title-row">
          <strong>${escapeHtml(task.title)}</strong>
          <span class="dot" style="background:${priorityColor(task.priority)}" title="${escapeHtml(task.priority)}"></span>
        </div>
        <div class="task-meta">${escapeHtml(formatDate(task.date))} • ${escapeHtml(task.priority)} ${recurringLabel}</div>
        ${task.note ? `<small>${escapeHtml(task.note)}</small>` : ''}
        <div class="task-meta">👤 ${escapeHtml(assignee)} ${task.estimatedHours ? `• ⏱️ ${task.estimatedHours} jam` : ''} ${task.actualSeconds ? `• ⌛ ${timeTracked}` : ''}</div>
        ${renderTagChips(task.tags)}
        ${task.attachment ? attachmentLink(task.attachment) : ''}
      </div>
      <div class="action-stack">
        <button class="badge ghost" data-action="open-comments" data-type="task" data-id="${task.id}">💬 ${task.comments.length}</button>
        ${columnStatus !== 'done' ? `<button class="badge success" data-action="move-done" data-id="${task.id}">✓ Selesai</button>` : ''}
        ${columnStatus !== 'backlog' ? `<button class="badge" data-action="move-backlog" data-id="${task.id}">⟲ Backlog</button>` : ''}
        ${columnStatus !== 'ongoing' && columnStatus !== 'done' ? `<button class="badge" data-action="move-ongoing" data-id="${task.id}">▶ Ongoing</button>` : ''}
        <button class="badge ${isTimerActive ? 'warn' : ''}" data-action="toggle-timer" data-id="${task.id}">${isTimerActive ? '⏸️ Berhenti' : '▶️ Mulai'}</button>
        <button class="badge danger" data-action="delete-task" data-id="${task.id}">Hapus</button>
      </div>
    </div>
  `;
}

function formatDuration(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}j ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

function renderTagChips(tagIds) {
  const workspace = activeWorkspace();
  if (!workspace || !tagIds || tagIds.length === 0) return '';
  return `<div class="tag-chips">${tagIds.map((id) => {
    const tag = workspace.tags.find((t) => t.id === id);
    if (!tag) return '';
    return `<span class="tag-chip" style="background:${tag.color}1a; color:${tag.color}; border-color:${tag.color}">${escapeHtml(tag.name)}</span>`;
  }).join('')}</div>`;
}

function renderNotes() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  if (workspace.notes.length === 0) {
    dom.notesList.innerHTML = '<p class="muted-text">Belum ada catatan. Tulis catatan pertama Anda di atas.</p>';
    return;
  }
  dom.notesList.innerHTML = workspace.notes.map((note, index) => `
    <div class="note-item">
      <p>${escapeHtml(note)}</p>
      <button class="badge danger" data-action="delete-note" data-index="${index}">Hapus</button>
    </div>
  `).join('');
}

function renderMembers() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  if (workspace.members.length === 0) {
    dom.membersList.innerHTML = '<p class="muted-text">Belum ada anggota.</p>';
    return;
  }
  const me = app.user ? userMember(workspace, app.user.id) : null;
  const isOwner = me && me.role === 'Owner';
  dom.membersList.innerHTML = workspace.members.map((member) => {
    const canManage = isOwner && member.userId !== app.user.id;
    return `
      <div class="member-card">
        <div>
          <strong>${escapeHtml(member.name)}</strong>
          <span class="muted-text">${escapeHtml(member.role)}</span>
        </div>
        <div class="action-stack">
          ${canManage ? `<button class="badge" data-action="update-member-role" data-id="${member.id}">Ubah peran</button>` : ''}
          ${canManage ? `<button class="badge danger" data-action="delete-member" data-id="${member.id}">Keluarkan</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderActivity() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const recent = (workspace.activity || []).slice(0, 10);
  if (recent.length === 0) {
    dom.activityList.innerHTML = '<p class="muted-text">Belum ada aktivitas.</p>';
    return;
  }
  dom.activityList.innerHTML = recent.map((entry) => `
    <div class="activity-item">
      <div>
        <strong>${escapeHtml(entry.actorName || 'Seseorang')}</strong>
        <span class="muted-text">${escapeHtml(activityLabel(entry))}</span>
        ${entry.targetTitle ? `<em>"${escapeHtml(entry.targetTitle)}"</em>` : ''}
      </div>
      <small class="muted-text">${escapeHtml(timeAgo(entry.timestamp))}</small>
    </div>
  `).join('');
}

function activityLabel(entry) {
  const map = {
    'task.create': 'menambahkan tugas',
    'task.update': 'memperbarui tugas',
    'task.delete': 'menghapus tugas',
    'task.move': 'memindahkan tugas',
    'task.complete': 'menyelesaikan tugas',
    'event.create': 'menambahkan agenda',
    'event.delete': 'menghapus agenda',
    'note.create': 'menulis catatan',
    'note.delete': 'menghapus catatan',
    'comment.add': 'berkomentar di',
    'member.add': 'menambahkan anggota',
    'member.update': 'memperbarui anggota',
    'member.remove': 'mengeluarkan anggota',
    'tag.create': 'membuat tag',
    'tag.update': 'memperbarui tag',
    'tag.delete': 'menghapus tag',
    'invite.create': 'membuat kode undangan',
    'workspace.update': 'memperbarui workspace',
  };
  return map[entry.action] || entry.action;
}

function renderNotifications() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const all = generateNotifications(workspace);
  const unread = all.filter((n) => !readState.notifications[n.id]);
  dom.notificationBadge.textContent = unread.length;
  dom.notificationBadge.classList.toggle('hidden', unread.length === 0);
  if (all.length === 0) {
    dom.notificationList.innerHTML = '<p class="muted-text">Tidak ada notifikasi. Santai saja ☕</p>';
    return;
  }
  dom.notificationList.innerHTML = all.slice(0, 12).map((n) => {
    const isUnread = !readState.notifications[n.id];
    return `
      <div class="notification-item ${isUnread ? 'unread' : ''}" data-action="open-notification" data-id="${n.id}" data-target-type="${n.targetType}" data-target-id="${n.targetId}">
        <strong>${escapeHtml(n.title)}</strong>
        <small>${escapeHtml(n.body)}</small>
        <small class="muted-text">${escapeHtml(timeAgo(n.timestamp))}</small>
      </div>
    `;
  }).join('');
}

function generateNotifications(workspace) {
  const today = todayIso();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const items = [];
  workspace.tasks.forEach((task) => {
    if (task.done) return;
    if (task.date < today) {
      items.push({ id: `task-overdue-${task.id}`, title: 'Deadline terlewat', body: task.title, targetType: 'task', targetId: task.id, timestamp: task.updatedAt });
    } else if (task.date === today) {
      items.push({ id: `task-today-${task.id}`, title: 'Deadline hari ini', body: task.title, targetType: 'task', targetId: task.id, timestamp: task.updatedAt });
    } else if (task.date === tomorrow) {
      items.push({ id: `task-tomorrow-${task.id}`, title: 'Deadline besok', body: task.title, targetType: 'task', targetId: task.id, timestamp: task.updatedAt });
    }
  });
  workspace.events.forEach((event) => {
    if (event.date === today) {
      items.push({ id: `event-today-${event.id}`, title: 'Agenda hari ini', body: event.title, targetType: 'event', targetId: event.id, timestamp: event.createdAt });
    }
  });
  return items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

function renderTagsPicker() {
  const workspace = activeWorkspace();
  if (!workspace || !dom.formTags) return;
  if (workspace.tags.length === 0) {
    dom.formTags.innerHTML = '';
    return;
  }
  dom.formTags.innerHTML = workspace.tags.map((tag) => `
    <label class="tag-pick">
      <input type="checkbox" value="${tag.id}" />
      <span class="tag-chip" style="background:${tag.color}1a; color:${tag.color}; border-color:${tag.color}">${escapeHtml(tag.name)}</span>
    </label>
  `).join('');
}

function renderTagsManager() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  if (!dom.tagsManagerList) return;
  const me = userMember(workspace, app.user ? app.user.id : '');
  const isOwner = me && me.role === 'Owner';
  if (workspace.tags.length === 0) {
    dom.tagsManagerList.innerHTML = '<p class="muted-text">Belum ada tag. Tambahkan tag di atas.</p>';
    return;
  }
  dom.tagsManagerList.innerHTML = workspace.tags.map((tag) => `
    <div class="tag-manager-item">
      <span class="tag-chip" style="background:${tag.color}1a; color:${tag.color}; border-color:${tag.color}">${escapeHtml(tag.name)}</span>
      <div class="action-stack">
        <input type="color" value="${tag.color}" data-action="retag" data-id="${tag.id}" />
        ${isOwner ? `<button class="badge danger" data-action="delete-tag" data-id="${tag.id}">Hapus</button>` : ''}
      </div>
    </div>
  `).join('');
}

function renderCalendar() {
  const workspace = activeWorkspace();
  if (!workspace || !dom.calendarGrid) return;
  const today = new Date();
  const view = new Date(dom.calendarMonth.getFullYear(), dom.calendarMonth.getMonth(), 1);
  const monthName = view.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  dom.calendarTitle.textContent = monthName;
  const firstDay = (view.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells = [];
  const headers = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  cells.push(`<div class="calendar-row calendar-header">${headers.map((h) => `<div>${h}</div>`).join('')}</div>`);
  let row = '<div class="calendar-row">';
  for (let i = 0; i < firstDay; i++) row += '<div class="calendar-cell empty"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${view.getFullYear()}-${String(view.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const tasksCount = workspace.tasks.filter((t) => t.date === iso && !t.done).length;
    const eventsCount = workspace.events.filter((e) => e.date === iso).length;
    const isToday = iso === todayIso();
    if ((firstDay + day - 1) % 7 === 0 && day !== 1) {
      cells.push(row + '</div>');
      row = '<div class="calendar-row">';
    }
    row += `
      <div class="calendar-cell ${isToday ? 'today' : ''}" data-date="${iso}">
        <strong>${day}</strong>
        <div class="dots">
          ${tasksCount ? `<span class="dot" style="background:#3861fb" title="${tasksCount} tugas"></span>` : ''}
          ${eventsCount ? `<span class="dot" style="background:#a855f7" title="${eventsCount} agenda"></span>` : ''}
        </div>
      </div>
    `;
  }
  const trailing = (7 - ((firstDay + daysInMonth) % 7)) % 7;
  for (let i = 0; i < trailing; i++) row += '<div class="calendar-cell empty"></div>';
  cells.push(row + '</div>');
  dom.calendarGrid.innerHTML = cells.join('');
}

function populateWorkspaceSwitcher() {
  if (!dom.workspaceSwitcher) return;
  const previous = app.activeWorkspaceId;
  dom.workspaceSwitcher.innerHTML = '';
  if (app.workspaces.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— belum ada workspace —';
    dom.workspaceSwitcher.appendChild(opt);
    return;
  }
  app.workspaces.forEach((w) => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.name;
    if (w.id === app.activeWorkspaceId) opt.selected = true;
    dom.workspaceSwitcher.appendChild(opt);
  });
  if (previous !== app.activeWorkspaceId) {
    // No-op; the caller already updated state.
  }
  const workspace = activeWorkspace();
  const me = workspace && userMember(workspace, app.user ? app.user.id : '');
  if (dom.workspaceLeaveBtn) {
    dom.workspaceLeaveBtn.classList.toggle('hidden', !me || me.role === 'Owner');
  }
}

function populateAssigneeOptions() {
  if (!dom.assignee) return;
  const workspace = activeWorkspace();
  const previous = dom.assignee.value;
  dom.assignee.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Tanpa assignee';
  dom.assignee.appendChild(defaultOpt);
  if (workspace) {
    workspace.members.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.role})`;
      dom.assignee.appendChild(opt);
    });
  }
  if (previous && [...dom.assignee.options].some((o) => o.value === previous)) {
    dom.assignee.value = previous;
  }
}

// ---------------------------------------------------------------------------
// 6. Mutations
// ---------------------------------------------------------------------------

function logActivity(workspace, entry) {
  if (!workspace) return;
  workspace.activity = workspace.activity || [];
  workspace.activity.unshift({
    id: uid(),
    actorId: app.user ? app.user.id : null,
    actorName: app.user ? app.user.name : 'Anonim',
    timestamp: isoNow(),
    ...entry,
  });
  // Throttle: keep at most 200 entries.
  if (workspace.activity.length > 200) {
    workspace.activity = workspace.activity.slice(0, 200);
  }
}

function addTask(payload) {
  const workspace = activeWorkspace();
  if (!workspace) return null;
  const task = {
    id: uid(),
    title: payload.title,
    date: payload.date,
    priority: payload.priority,
    assigneeId: payload.assigneeId || null,
    attachment: payload.attachment || '',
    note: payload.note || '',
    status: 'backlog',
    done: false,
    tags: payload.tags || [],
    comments: [],
    recurrence: payload.recurrence || 'none',
    recurrenceEnd: payload.recurrenceEnd || null,
    estimatedHours: payload.estimatedHours || null,
    actualSeconds: 0,
    createdBy: app.user ? app.user.id : null,
    createdAt: isoNow(),
    updatedAt: isoNow(),
  };
  workspace.tasks.unshift(task);
  logActivity(workspace, { action: 'task.create', targetType: 'task', targetId: task.id, targetTitle: task.title });
  saveWorkspaceSoon();
  return task;
}

function addEvent(payload) {
  const workspace = activeWorkspace();
  if (!workspace) return null;
  const event = {
    id: uid(),
    title: payload.title,
    date: payload.date,
    priority: payload.priority,
    note: payload.note || '',
    tags: payload.tags || [],
    comments: [],
    createdBy: app.user ? app.user.id : null,
    createdAt: isoNow(),
  };
  workspace.events.unshift(event);
  logActivity(workspace, { action: 'event.create', targetType: 'event', targetId: event.id, targetTitle: event.title });
  saveWorkspaceSoon();
  return event;
}

function updateTaskStatus(taskId, newStatus) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const task = workspace.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const previousStatus = task.status;
  task.status = newStatus;
  task.done = newStatus === 'done';
  task.updatedAt = isoNow();
  logActivity(workspace, {
    action: previousStatus === newStatus ? 'task.update' : 'task.move',
    targetType: 'task',
    targetId: task.id,
    targetTitle: task.title,
    metadata: { from: previousStatus, to: newStatus },
  });
  if (task.status === 'done' && task.recurrence && task.recurrence !== 'none') {
    spawnRecurringInstance(task);
  }
  saveWorkspaceSoon();
}

function spawnRecurringInstance(task) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const nextDate = computeNextDate(task.date, task.recurrence);
  if (!nextDate) return;
  if (task.recurrenceEnd && nextDate > task.recurrenceEnd) return;
  const next = { ...task, id: uid(), status: 'backlog', done: false, date: nextDate, actualSeconds: 0, createdAt: isoNow(), updatedAt: isoNow() };
  workspace.tasks.unshift(next);
  logActivity(workspace, { action: 'task.create', targetType: 'task', targetId: next.id, targetTitle: next.title, metadata: { recurringFrom: task.id } });
}

function computeNextDate(dateIso, recurrence) {
  const d = new Date(dateIso + 'T00:00:00');
  if (recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

function deleteTask(taskId) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const task = workspace.tasks.find((t) => t.id === taskId);
  if (!task) return;
  workspace.tasks = workspace.tasks.filter((t) => t.id !== taskId);
  logActivity(workspace, { action: 'task.delete', targetType: 'task', targetId: taskId, targetTitle: task.title });
  saveWorkspaceSoon();
}

function deleteEvent(eventId) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const event = workspace.events.find((e) => e.id === eventId);
  if (!event) return;
  workspace.events = workspace.events.filter((e) => e.id !== eventId);
  logActivity(workspace, { action: 'event.delete', targetType: 'event', targetId: eventId, targetTitle: event.title });
  saveWorkspaceSoon();
}

function addNote(text) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  workspace.notes.unshift(text);
  logActivity(workspace, { action: 'note.create', targetType: 'note', targetId: uid(), targetTitle: text.slice(0, 40) });
  saveWorkspaceSoon();
}

function deleteNote(index) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  if (index < 0 || index >= workspace.notes.length) return;
  const removed = workspace.notes.splice(index, 1)[0];
  logActivity(workspace, { action: 'note.delete', targetType: 'note', targetId: uid(), targetTitle: (removed || '').slice(0, 40) });
  saveWorkspaceSoon();
}

function addMember(name, role) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const me = userMember(workspace, app.user ? app.user.id : '');
  if (!me || me.role !== 'Owner') {
    alert('Hanya owner workspace yang dapat menambah anggota.');
    return;
  }
  const member = {
    id: uid(),
    userId: null,
    name: name.trim(),
    role: role.trim() || 'Member',
    joinedAt: isoNow(),
  };
  workspace.members.push(member);
  logActivity(workspace, { action: 'member.add', targetType: 'member', targetId: member.id, targetTitle: member.name });
  saveWorkspaceSoon();
}

function updateMember(memberId, patch) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const me = userMember(workspace, app.user ? app.user.id : '');
  if (!me || me.role !== 'Owner') return;
  const member = workspace.members.find((m) => m.id === memberId);
  if (!member) return;
  Object.assign(member, patch);
  logActivity(workspace, { action: 'member.update', targetType: 'member', targetId: member.id, targetTitle: member.name });
  saveWorkspaceSoon();
}

function removeMember(memberId) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const me = userMember(workspace, app.user ? app.user.id : '');
  if (!me || me.role !== 'Owner') return;
  const member = workspace.members.find((m) => m.id === memberId);
  if (!member) return;
  if (member.userId === app.user.id) return; // can't remove self
  workspace.members = workspace.members.filter((m) => m.id !== memberId);
  // Unassign tasks assigned to removed member
  workspace.tasks.forEach((task) => {
    if (task.assigneeId === memberId) task.assigneeId = null;
  });
  logActivity(workspace, { action: 'member.remove', targetType: 'member', targetId: memberId, targetTitle: member.name });
  saveWorkspaceSoon();
}

function createTag(name, color) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const me = userMember(workspace, app.user ? app.user.id : '');
  if (!me || me.role !== 'Owner') {
    alert('Hanya owner yang dapat membuat tag.');
    return;
  }
  const tag = { id: `tag-${uid()}`, name: name.trim(), color: color || '#3861fb' };
  workspace.tags.push(tag);
  logActivity(workspace, { action: 'tag.create', targetType: 'tag', targetId: tag.id, targetTitle: tag.name });
  saveWorkspaceSoon();
}

function retag(tagId, color) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const tag = workspace.tags.find((t) => t.id === tagId);
  if (!tag) return;
  tag.color = color;
  logActivity(workspace, { action: 'tag.update', targetType: 'tag', targetId: tag.id, targetTitle: tag.name });
  saveWorkspaceSoon();
}

function deleteTag(tagId) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const me = userMember(workspace, app.user ? app.user.id : '');
  if (!me || me.role !== 'Owner') return;
  const tag = workspace.tags.find((t) => t.id === tagId);
  if (!tag) return;
  workspace.tags = workspace.tags.filter((t) => t.id !== tagId);
  workspace.tasks.forEach((task) => { task.tags = task.tags.filter((id) => id !== tagId); });
  workspace.events.forEach((event) => { event.tags = event.tags.filter((id) => id !== tagId); });
  logActivity(workspace, { action: 'tag.delete', targetType: 'tag', targetId: tagId, targetTitle: tag.name });
  saveWorkspaceSoon();
}

function addComment(targetType, targetId, body) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const list = targetType === 'task' ? workspace.tasks : workspace.events;
  const target = list.find((item) => item.id === targetId);
  if (!target) return;
  const comment = {
    id: uid(),
    authorId: app.user ? app.user.id : null,
    authorName: app.user ? app.user.name : 'Anonim',
    body: body.trim(),
    createdAt: isoNow(),
  };
  target.comments.push(comment);
  logActivity(workspace, {
    action: 'comment.add',
    targetType: targetType,
    targetId: target.id,
    targetTitle: target.title,
    metadata: { commentId: comment.id },
  });
  saveWorkspaceSoon();
  return comment;
}

function deleteComment(targetType, targetId, commentId) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const list = targetType === 'task' ? workspace.tasks : workspace.events;
  const target = list.find((item) => item.id === targetId);
  if (!target) return;
  target.comments = target.comments.filter((c) => c.id !== commentId);
  saveWorkspaceSoon();
}

function createInvite() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const me = userMember(workspace, app.user ? app.user.id : '');
  if (!me || me.role !== 'Owner') {
    alert('Hanya owner yang dapat membuat kode undangan.');
    return;
  }
  const code = generateInviteCode();
  workspace.invites = workspace.invites || [];
  workspace.invites.push({
    code,
    role: 'Member',
    createdBy: app.user.id,
    createdAt: isoNow(),
    usedBy: null,
  });
  logActivity(workspace, { action: 'invite.create', targetType: 'invite', targetId: code, targetTitle: code });
  saveWorkspaceSoon();
  return code;
}

function revokeInvite(code) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  workspace.invites = (workspace.invites || []).filter((i) => i.code !== code);
  saveWorkspaceSoon();
}

function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `INV-${out.slice(0, 3)}-${out.slice(3)}`;
}

// ---------------------------------------------------------------------------
// 7. Time tracker (in-memory)
// ---------------------------------------------------------------------------

function toggleTimer(taskId) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const task = workspace.tasks.find((t) => t.id === taskId);
  if (!task) return;
  if (app.timer.taskId === taskId) {
    // stop
    const seconds = Math.max(0, Math.round((Date.now() - app.timer.startedAt) / 1000));
    task.actualSeconds = (task.actualSeconds || 0) + seconds;
    app.timer = { taskId: null, startedAt: null };
  } else {
    // commit previous if any
    if (app.timer.taskId) {
      const prev = workspace.tasks.find((t) => t.id === app.timer.taskId);
      if (prev) {
        const seconds = Math.max(0, Math.round((Date.now() - app.timer.startedAt) / 1000));
        prev.actualSeconds = (prev.actualSeconds || 0) + seconds;
      }
    }
    app.timer = { taskId, startedAt: Date.now() };
  }
  saveWorkspaceSoon();
}

// ---------------------------------------------------------------------------
// 8. UI wiring
// ---------------------------------------------------------------------------

dom.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = dom.title.value.trim();
  const date = dom.date.value;
  const priority = dom.priority.value;
  const assigneeId = dom.assignee.value || null;
  const note = dom.note.value.trim();
  const type = dom.type.value;
  const recurrence = dom.recurrence ? dom.recurrence.value : 'none';
  const estimatedHours = dom.estimatedHours ? Number(dom.estimatedHours.value) || null : null;
  const tags = dom.formTags ? Array.from(dom.formTags.querySelectorAll('input:checked')).map((el) => el.value) : [];

  if (!title || !date) {
    alert('Judul dan tanggal wajib diisi.');
    return;
  }

  let attachmentName = '';
  if (dom.attachment.files && dom.attachment.files[0]) {
    try {
      const result = await api.upload(dom.attachment.files[0]);
      attachmentName = result.filename;
    } catch (error) {
      alert(`Upload gagal: ${error.message}`);
      return;
    }
  }

  if (type === 'task') {
    addTask({ title, date, priority, assigneeId, attachment: attachmentName, note, recurrence, estimatedHours, tags });
  } else {
    addEvent({ title, date, priority, note, tags });
  }
  dom.form.reset();
  if (dom.formTags) dom.formTags.querySelectorAll('input').forEach((el) => { el.checked = false; });
  renderAll();
});

dom.toggleForm.addEventListener('click', () => {
  if (!dom.formPanel) return;
  dom.formPanel.classList.toggle('collapsed');
});

dom.taskSearch.addEventListener('input', renderTasks);
dom.taskFilter.addEventListener('change', renderTasks);
dom.calendarDate.addEventListener('change', renderEvents);
dom.priorityFilter.addEventListener('change', () => { renderEvents(); renderTasks(); });

dom.noteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = dom.noteInput.value.trim();
  if (!value) return;
  addNote(value);
  dom.noteInput.value = '';
  renderNotes();
});

dom.memberForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = dom.memberName.value.trim();
  const role = dom.memberRole.value.trim();
  if (!name) return;
  addMember(name, role || 'Member');
  dom.memberName.value = '';
  dom.memberRole.value = '';
  renderMembers();
  renderStats();
});

dom.exportBtn.addEventListener('click', () => {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const data = {
    exportedAt: isoNow(),
    workspace: { name: workspace.name, description: workspace.description },
    stats: {
      tasks: workspace.tasks.length,
      done: workspace.tasks.filter((t) => t.done).length,
      events: workspace.events.length,
      notes: workspace.notes.length,
      members: workspace.members.length,
    },
    tasks: workspace.tasks,
    events: workspace.events,
    notes: workspace.notes,
    members: workspace.members,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `syncup-${workspace.name.replace(/\s+/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

dom.importBtn.addEventListener('click', () => dom.importFile.click());
dom.importFile.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!confirm('Import akan mengganti data workspace aktif. Lanjutkan?')) {
    event.target.value = '';
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.workspace || !Array.isArray(data.tasks)) {
      throw new Error('File bukan format SyncUp yang valid.');
    }
    const workspace = activeWorkspace();
    if (!workspace) throw new Error('Tidak ada workspace aktif.');
    workspace.tasks = data.tasks;
    workspace.events = data.events || [];
    workspace.notes = data.notes || [];
    if (Array.isArray(data.members)) workspace.members = data.members;
    logActivity(workspace, { action: 'workspace.update', targetType: 'workspace', targetId: workspace.id, targetTitle: workspace.name, metadata: { import: true } });
    saveWorkspaceSoon();
    renderAll();
    alert('Import berhasil.');
  } catch (error) {
    alert(`Import gagal: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});

dom.themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark-theme');
  const isDark = document.body.classList.contains('dark-theme');
  dom.themeToggle.textContent = isDark ? '☀️ Terang' : '🌙 Gelap';
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
});

// Workspace switcher
dom.workspaceSwitcher.addEventListener('change', async (event) => {
  const newId = event.target.value;
  if (newId === app.activeWorkspaceId) return;
  try {
    await api.switchWorkspace(newId);
    setActiveWorkspace(newId);
  } catch (error) {
    alert(error.message);
  }
});

dom.workspaceCreateBtn.addEventListener('click', () => openWorkspaceModal());
dom.workspaceEditBtn.addEventListener('click', () => openWorkspaceModal(true));
dom.workspaceInviteBtn.addEventListener('click', () => openInviteModal());
dom.workspaceLeaveBtn.addEventListener('click', () => leaveWorkspace());

// Notifications
dom.notificationBell.addEventListener('click', () => {
  dom.notificationPanel.classList.toggle('hidden');
  // Mark all as read on open
  const items = generateNotifications(activeWorkspace() || { tasks: [], events: [] });
  const now = isoNow();
  items.forEach((n) => { readState.notifications[n.id] = now; });
  renderNotifications();
});
document.addEventListener('click', (event) => {
  if (!dom.notificationPanel || dom.notificationPanel.classList.contains('hidden')) return;
  if (dom.notificationPanel.contains(event.target) || dom.notificationBell.contains(event.target)) return;
  dom.notificationPanel.classList.add('hidden');
});

// Global search
dom.globalSearchTrigger.addEventListener('click', openSearchModal);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openSearchModal();
  }
  if (event.key === 'Escape') {
    closeAllModals();
  }
});

dom.globalSearchInput.addEventListener('input', debounce(() => runGlobalSearch(dom.globalSearchInput.value), 120));

// Profile
dom.profileTrigger.addEventListener('click', openProfileModal);
dom.profileSaveBtn.addEventListener('click', saveProfile);
dom.profilePasswordBtn.addEventListener('click', changePassword);

// Tags manager
if (dom.tagsManagerForm) {
  dom.tagsManagerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = dom.tagName.value.trim();
    const color = dom.tagColor.value;
    if (!name) return;
    createTag(name, color);
    dom.tagName.value = '';
    dom.tagColor.value = '#3861fb';
    renderTagsManager();
    renderTagsPicker();
  });
}

// Comments
if (dom.commentSubmit) {
  dom.commentSubmit.addEventListener('click', () => {
    if (!dom.commentTarget) return;
    const body = dom.commentInput.value.trim();
    if (!body) return;
    addComment(dom.commentTarget.type, dom.commentTarget.id, body);
    dom.commentInput.value = '';
    renderCommentModal();
    renderAll();
  });
}

// Calendar
dom.calendarPrev.addEventListener('click', () => {
  dom.calendarMonth = new Date(dom.calendarMonth.getFullYear(), dom.calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
dom.calendarNext.addEventListener('click', () => {
  dom.calendarMonth = new Date(dom.calendarMonth.getFullYear(), dom.calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
dom.calendarToday.addEventListener('click', () => {
  dom.calendarMonth = new Date();
  renderCalendar();
});

// Onboarding
if (dom.onboardingClose) {
  dom.onboardingClose.addEventListener('click', () => {
    dom.onboardingModal.classList.add('hidden');
    localStorage.setItem('syncup-onboarded', '1');
  });
}

// Delegated click handler
document.addEventListener('click', (event) => {
  const target = event.target;

  // Notification click
  const notif = target.closest('[data-action="open-notification"]');
  if (notif) {
    const t = notif.dataset.targetType;
    const id = notif.dataset.targetId;
    const el = document.querySelector(`[data-${t}-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  // Calendar cell click → prefill date filter
  const cell = target.closest('.calendar-cell');
  if (cell && cell.dataset.date) {
    dom.calendarDate.value = cell.dataset.date;
    renderEvents();
    return;
  }

  // Modal close
  if (target.classList && target.classList.contains('modal-close')) {
    closeAllModals();
    return;
  }
  if (target.classList && target.classList.contains('modal-backdrop')) {
    closeAllModals();
    return;
  }

  const button = target.closest('button[data-action]');
  if (!button) return;
  const { action, id, index, type } = button.dataset;
  handleAction(action, { id, index, type, event });
});

function handleAction(action, payload) {
  const workspace = activeWorkspace();
  if (!workspace && !['open-search', 'close-modal', 'open-profile'].includes(action)) {
    return;
  }
  switch (action) {
    case 'delete-task':
      if (confirm('Hapus tugas ini?')) {
        deleteTask(payload.id);
        renderAll();
      }
      break;
    case 'delete-event':
      if (confirm('Hapus agenda ini?')) {
        deleteEvent(payload.id);
        renderAll();
      }
      break;
    case 'delete-note':
      deleteNote(Number(payload.index));
      renderNotes();
      break;
    case 'delete-member':
      if (confirm('Keluarkan anggota ini dari workspace?')) {
        removeMember(payload.id);
        renderMembers();
        renderStats();
        renderTasks();
      }
      break;
    case 'update-member-role': {
      const member = workspace.members.find((m) => m.id === payload.id);
      if (!member) return;
      const newRole = prompt('Peran baru:', member.role);
      if (newRole && newRole.trim()) {
        updateMember(payload.id, { role: newRole.trim() });
        renderMembers();
      }
      break;
    }
    case 'move-done':
      updateTaskStatus(payload.id, 'done');
      logActivity(workspace, { action: 'task.complete', targetType: 'task', targetId: payload.id, targetTitle: workspace.tasks.find((t) => t.id === payload.id)?.title });
      renderAll();
      break;
    case 'move-ongoing':
      updateTaskStatus(payload.id, 'ongoing');
      renderAll();
      break;
    case 'move-backlog':
      updateTaskStatus(payload.id, 'backlog');
      renderAll();
      break;
    case 'toggle-task': {
      const task = workspace.tasks.find((t) => t.id === payload.id);
      if (!task) return;
      const nextStatus = task.done ? 'ongoing' : 'done';
      updateTaskStatus(payload.id, nextStatus);
      renderAll();
      break;
    }
    case 'toggle-timer':
      toggleTimer(payload.id);
      renderTasks();
      break;
    case 'open-comments':
      openCommentModal(payload.type || 'task', payload.id);
      break;
    case 'delete-tag':
      if (confirm('Hapus tag ini? Tag akan dihapus dari semua tugas & agenda.')) {
        deleteTag(payload.id);
        renderTagsManager();
        renderTagsPicker();
        renderTasks();
        renderEvents();
      }
      break;
    case 'retag': {
      const color = buttonColorFromEvent();
      if (color) {
        retag(payload.id, color);
        renderTagsManager();
        renderTagsPicker();
        renderTasks();
        renderEvents();
      }
      break;
    }
    case 'delete-comment':
      if (dom.commentTarget) {
        if (confirm('Hapus komentar ini?')) {
          deleteComment(dom.commentTarget.type, dom.commentTarget.id, payload.id);
          renderCommentModal();
          renderAll();
        }
      }
      break;
    case 'open-search':
      openSearchModal();
      break;
    case 'open-profile':
      openProfileModal();
      break;
  }
}

function buttonColorFromEvent() {
  return event.target.value;
}

// Drag & drop
document.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.kanban-card');
  if (!card) return;
  event.dataTransfer.setData('text/plain', card.dataset.taskId);
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', (event) => {
  const column = event.target.closest('[data-status]');
  if (!column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
document.addEventListener('drop', (event) => {
  const column = event.target.closest('[data-status]');
  const taskId = event.dataTransfer.getData('text/plain');
  if (!column || !taskId) return;
  event.preventDefault();
  const newStatus = column.dataset.status;
  updateTaskStatus(taskId, newStatus);
  renderTasks();
});

// ---------------------------------------------------------------------------
// 9. Modals
// ---------------------------------------------------------------------------

function openModal(id) {
  closeAllModals();
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('hidden');
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}

function openWorkspaceModal(edit = false) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  openModal('workspaceModal');
  document.getElementById('workspaceModalTitle').textContent = edit ? 'Edit Workspace' : 'Buat Workspace Baru';
  document.getElementById('workspaceNameInput').value = edit ? workspace.name : '';
  document.getElementById('workspaceDescInput').value = edit ? workspace.description : '';
  document.getElementById('workspaceMode').value = edit ? 'edit' : 'create';
}

document.getElementById('workspaceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('workspaceNameInput').value.trim();
  const description = document.getElementById('workspaceDescInput').value.trim();
  const mode = document.getElementById('workspaceMode').value;
  if (!name) return;
  try {
    if (mode === 'create') {
      const data = await api.createWorkspace({ name, description });
      // Refresh workspace list from server
      const refreshed = await api.workspace();
      applyServerData(refreshed);
      updateAuthView();
      renderAll();
      alert(`Workspace "${data.workspace.name}" berhasil dibuat.`);
    } else {
      const workspace = activeWorkspace();
      workspace.name = name;
      workspace.description = description;
      logActivity(workspace, { action: 'workspace.update', targetType: 'workspace', targetId: workspace.id, targetTitle: workspace.name });
      saveWorkspaceSoon();
      populateWorkspaceSwitcher();
      renderAll();
    }
    closeAllModals();
  } catch (error) {
    alert(error.message);
  }
});

function openInviteModal() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  openModal('inviteModal');
  renderInvites();
}

function renderInvites() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const list = document.getElementById('inviteList');
  const invites = workspace.invites || [];
  if (invites.length === 0) {
    list.innerHTML = '<p class="muted-text">Belum ada kode undangan. Buat kode di atas.</p>';
    return;
  }
  list.innerHTML = invites.map((invite) => `
    <div class="invite-item">
      <div>
        <strong>${escapeHtml(invite.code)}</strong>
        <small class="muted-text">Peran: ${escapeHtml(invite.role)} • ${invite.usedBy ? 'Sudah dipakai' : 'Aktif'}</small>
      </div>
      ${invite.usedBy ? '' : `<button class="badge danger" data-action="revoke-invite" data-code="${invite.code}">Cabut</button>`}
    </div>
  `).join('');
}

document.getElementById('inviteCreateBtn').addEventListener('click', () => {
  const code = createInvite();
  if (code) renderInvites();
});

document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-action="revoke-invite"]');
  if (btn) {
    revokeInvite(btn.dataset.code);
    renderInvites();
  }
});

async function leaveWorkspace() {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const me = userMember(workspace, app.user.id);
  if (!me || me.role === 'Owner') {
    alert('Owner tidak dapat keluar. Hapus workspace sebagai gantinya.');
    return;
  }
  if (!confirm(`Keluar dari workspace "${workspace.name}"?`)) return;
  workspace.members = workspace.members.filter((m) => m.userId !== app.user.id);
  app.user.workspaceIds = (app.user.workspaceIds || []).filter((id) => id !== workspace.id);
  // Pick another workspace
  const refreshed = await api.workspace();
  applyServerData(refreshed);
  updateAuthView();
  renderAll();
}

function openSearchModal() {
  openModal('searchModal');
  dom.globalSearchInput.value = '';
  dom.globalSearchResults.innerHTML = '<p class="muted-text">Ketik untuk mencari di seluruh workspace...</p>';
  setTimeout(() => dom.globalSearchInput.focus(), 50);
}

function runGlobalSearch(query) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const q = query.trim().toLowerCase();
  if (!q) {
    dom.globalSearchResults.innerHTML = '<p class="muted-text">Ketik untuk mencari di seluruh workspace...</p>';
    return;
  }
  const results = [];
  workspace.tasks.forEach((task) => {
    if (task.title.toLowerCase().includes(q) || (task.note || '').toLowerCase().includes(q)) {
      results.push({ type: 'task', title: task.title, meta: `${task.date} • ${task.priority}`, target: 'task', id: task.id });
    }
  });
  workspace.events.forEach((event) => {
    if (event.title.toLowerCase().includes(q) || (event.note || '').toLowerCase().includes(q)) {
      results.push({ type: 'event', title: event.title, meta: `${event.date} • ${event.priority}`, target: 'event', id: event.id });
    }
  });
  workspace.notes.forEach((note, idx) => {
    if ((note || '').toLowerCase().includes(q)) {
      results.push({ type: 'note', title: note.slice(0, 60), meta: 'Catatan', target: 'note', id: idx });
    }
  });
  workspace.members.forEach((member) => {
    if (member.name.toLowerCase().includes(q) || member.role.toLowerCase().includes(q)) {
      results.push({ type: 'member', title: member.name, meta: member.role, target: 'member', id: member.id });
    }
  });
  if (results.length === 0) {
    dom.globalSearchResults.innerHTML = '<p class="muted-text">Tidak ada hasil.</p>';
    return;
  }
  dom.globalSearchResults.innerHTML = results.slice(0, 50).map((r) => `
    <div class="search-result" data-target="${r.target}" data-id="${r.id}">
      <strong>${escapeHtml(r.title)}</strong>
      <small class="muted-text">${escapeHtml(r.type)} • ${escapeHtml(r.meta)}</small>
    </div>
  `).join('');
}

dom.globalSearchResults.addEventListener('click', (event) => {
  const item = event.target.closest('.search-result');
  if (!item) return;
  const target = item.dataset.target;
  const id = item.dataset.id;
  if (target === 'task' || target === 'event') {
    closeAllModals();
    const el = document.querySelector(`[data-${target}-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (target === 'note') {
    closeAllModals();
    dom.notesList.scrollIntoView({ behavior: 'smooth' });
  } else if (target === 'member') {
    closeAllModals();
    dom.membersList.scrollIntoView({ behavior: 'smooth' });
  }
});

function openProfileModal() {
  if (!app.user) return;
  openModal('profileModal');
  dom.profileName.value = app.user.name;
  dom.profileEmail.value = app.user.email;
  dom.profileCurrentPassword.value = '';
  dom.profileNewPassword.value = '';
  dom.profileMessage.textContent = '';
  dom.profileMessagePassword.textContent = '';
}

async function saveProfile() {
  if (!app.user) return;
  const name = dom.profileName.value.trim();
  const email = dom.profileEmail.value.trim().toLowerCase();
  if (!name || !email) {
    dom.profileMessage.textContent = 'Nama dan email tidak boleh kosong.';
    return;
  }
  // Persist via workspace PATCH (or do it via a new endpoint). Here we cheat by
  // updating local state and re-fetching after switching the localStorage
  // token: in this MVP we don't have a /me endpoint, so we only update the
  // display name in the local app and reload.
  app.user.name = name;
  app.user.email = email;
  currentUserName.textContent = name;
  dom.profileMessage.textContent = 'Profil diperbarui secara lokal. Hubungi admin server untuk persistensi penuh.';
}

async function changePassword() {
  dom.profileMessagePassword.textContent = 'Pengubahan password diaktifkan penuh saat register via server. Silakan logout & daftar ulang untuk sementara.';
}

function openCommentModal(type, id) {
  const workspace = activeWorkspace();
  if (!workspace) return;
  const list = type === 'task' ? workspace.tasks : workspace.events;
  const target = list.find((item) => item.id === id);
  if (!target) return;
  dom.commentTarget = { type, id, title: target.title };
  document.getElementById('commentModalTitle').textContent = `Komentar: ${target.title}`;
  dom.commentInput.value = '';
  renderCommentModal();
  openModal('commentModal');
  setTimeout(() => dom.commentInput.focus(), 50);
}

function renderCommentModal() {
  if (!dom.commentTarget) return;
  const workspace = activeWorkspace();
  if (!workspace) return;
  const list = dom.commentTarget.type === 'task' ? workspace.tasks : workspace.events;
  const target = list.find((item) => item.id === dom.commentTarget.id);
  if (!target) return;
  const comments = target.comments || [];
  if (comments.length === 0) {
    dom.commentList.innerHTML = '<p class="muted-text">Belum ada komentar. Mulai diskusi di bawah.</p>';
    return;
  }
  dom.commentList.innerHTML = comments.map((comment) => {
    const isMine = comment.authorId && app.user && comment.authorId === app.user.id;
    return `
      <div class="comment-item">
        <div>
          <strong>${escapeHtml(comment.authorName || 'Anonim')}</strong>
          <small class="muted-text">${escapeHtml(timeAgo(comment.createdAt))}</small>
        </div>
        <p>${escapeHtml(comment.body)}</p>
        ${isMine ? `<button class="badge danger" data-action="delete-comment" data-id="${comment.id}">Hapus</button>` : ''}
      </div>
    `;
  }).join('');
}

function openOnboarding() {
  if (!dom.onboardingModal) return;
  if (localStorage.getItem('syncup-onboarded')) return;
  dom.onboardingModal.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 10. Bootstrap
// ---------------------------------------------------------------------------

(async function bootstrap() {
  // Restore theme
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-theme');
    dom.themeToggle.textContent = '☀️ Terang';
  }
  // Restore accent
  const accent = localStorage.getItem(ACCENT_KEY);
  if (accent) {
    document.documentElement.style.setProperty('--accent', accent);
  }
  // Restore default form date
  dom.date.value = todayIso();
  // Load from server
  await loadInitial();
  if (app.user) {
    updateAuthView();
    renderAll();
    if (app.workspaces.length === 1) openOnboarding();
  } else {
    updateAuthView();
  }
})();
