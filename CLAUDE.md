# CLAUDE.md

File ini memberikan panduan kepada Claude Code (claude.ai/code) saat bekerja dengan kode di repositori ini.

## Ringkasan proyek

SyncUp adalah aplikasi MVP untuk manajemen kerja tim (tugas/agenda/catatan per workspace) dengan backend Python stdlib, frontend single-page vanilla-JS, dan persistensi SQLite. Semua string antarmuka dan komentar kode berbahasa Indonesia — pertahankan teks dan pesan UI baru dalam bahasa itu.

# Preferensi Bahasa
- Selalu menjawab dan berkomunikasi dalam Bahasa Indonesia.

## Perintah

- Menjalankan server: `python server.py` — melayani aplikasi di `http://localhost:8000`. Satu-satunya dependensi adalah `bcrypt` (`pip install -r requirements.txt`).
- Inisialisasi skema SQLite: `python -m database init`
- Impor JSON lama: `python -m database import data.json` (juga dilakukan otomatis saat pertama kali dijalankan jika DB kosong)
- Menjalankan seluruh pengujian: `python -m unittest discover -s tests -v`
- Menjalankan satu pengujian: `python -m unittest discover -s tests -p test_server.py -k <substring-nama>`

Tidak ada tahap build, konfigurasi linter, atau framework di kedua sisi.

## Arsitektur

### Dict state in-memory adalah kontraknya

Seluruh state aplikasi adalah satu dict: `{ users, workspaces, activeUserId, activeWorkspaceId }`. Sebuah `workspace` membawa datanya sebagai list biasa — `tasks`, `events`, `notes`, `members`, `invites`, `tags`, `comments`, `activity`, dan `archived: {tasks, events}`. Bentuk yang sama mengalir melalui tiga lapisan:

- **Frontend (`app.js`)** memantulkannya di objek `app`; mutasi mengubah workspace in-memory dan menjadwalkan penyimpanan.
- **Backend (`server.py`)** memuatnya via `load_data()`, mengubahnya di handler, dan mempersistensinya via `save_data()`.
- **Database (`database.py`)** men-serialisasi list setiap workspace menjadi kolom blob JSON (`tasks_json`, `events_json`, …) dan mengembalikannya dengan `_workspace_from_row()`.

Saat menambahkan field workspace baru, Anda harus memperbarui ketiganya: daftar kolom `_empty_workspace()` / `_workspace_from_row()` / `save_data()` di `database.py`, normalisasi `applyWorkspace()` di `app.js`, dan daftar key yang diizinkan di `_handle_update_workspace` / `_handle_save_workspace` pada `server.py`.

### Simpan dokumen utuh, bukan API granular

Frontend tidak memiliki endpoint per-entitas. Ia mengirim seluruh dokumen workspace baik sebagai `POST /api/workspace/save` maupun `PATCH /api/workspaces/<id>`; server menormalkan (`_normalize_tasks`, `_normalize_events`) dan `database.save_data()` melakukan upsert seluruh state secara transaksional (`BEGIN IMMEDIATE`, hapus-lalu-masukkan-ulang `user_workspaces`). Di frontend, `saveWorkspaceSoon()` men-debounce penulisan sebesar 400 ms via `app.saveDebounced`. Mutasi baru harus mengikuti pola ini, bukan menambah endpoint sempit.

### Lapisan persistensi (`database.py`)

- Skema berada di `schema.sql` (dengan `_FALLBACK_SCHEMA` inline yang dipakai bila file hilang). Tabel: `users`, `workspaces` (kolom blob JSON), `user_workspaces` (join), `app_settings` (menyimpan `activeUserId` / `activeWorkspaceId`).
- `DB_LOCK` tingkat modul men-serialisasi koneksi; setiap `save_data` berjalan dalam transaksi eksplisit.
- **Pengujian melakukan monkey-patch `database.DB_FILE` ke file temp** — jangan pernah mengarahkan pengujian ke `syncup.db` asli, dan jangan pernah bergantung pada isi DB asli saat mengembangkan secara lokal.

### Rantai migrasi lama

`data.json` adalah penyimpanan file datar lama. Pada muatan pertama, `database.bootstrap_from_json()` mengimpornya saat DB kosong, kemudian `server.load_data()` menjalankan ulang `_migrate_legacy_data()` jika masih ada user yang menyematkan list. Logika migrasi (di `server.py`) mengangkat data tersemat milik user ke "Workspace Pribadi" per-user dan meningkatkan password plain-text menjadi bcrypt. Ekspor lama dicadangkan di `backups/`.

### Autentikasi

- Register/login mengeluarkan token bearer acak yang disimpan di dict `SESSIONS` dalam memori — **sesi hilang saat server dimulai ulang**. Frontend menyimpan token di `localStorage` (`syncup-token`) dan mengirimkannya sebagai `Authorization: Bearer <token>`.
- Password di-hash dengan bcrypt. Password plain-text lama tetap bisa diverifikasi dan di-hash ulang secara transparan saat login berhasil.
- `_public_user()` menghapus `passwordHash` sebelum objek user apa pun dikembalikan ke klien.

### Frontend (`app.js`, ~76 KB, satu file)

Bagian diberi nomor di komentar header: konstanta/helper → klien API → state aplikasi + persistensi → alur autentikasi → lapisan render (statistik, tugas/kanban, agenda, catatan, anggota, aktivitas, notifikasi, tag, komentar, pencarian, kalender) → mutasi → log aktivitas → notifikasi → perangkai UI (delegasi event, drag-drop, pintasan keyboard, tema, modal) → bootstrap. Konvensi utama:

- Objek `api` membungkus `fetch` dengan header token dan penanganan JSON.
- Objek `dom` menyimpan hasil lookup elemen saat dimuat.
- Render berbasis template string; mutasi memanggil `renderAll()` atau render ulang tertarget dan diakhiri `saveWorkspaceSoon()`.
- Preferensi UI (tema, aksen, draf) dan workspace aktif tersimpan di `localStorage`.

### Lapisan HTTP (`server.py`)

Menggunakan `ThreadingHTTPServer` + `BaseHTTPRequestHandler` — tanpa framework. Rute didispatch manual di `do_GET` / `do_POST` / `do_PATCH` / `do_DELETE`. File statis dilayani dengan pengaman path traversal (`_serve_file` memeriksa `commonpath`). Unggahan (`POST /api/upload`) mengurai `multipart/form-data` secara manual, memfilter ekstensi (`ALLOWED_UPLOAD_EXTS`), membatasi 10 MB, dan menyimpan di `uploads/` dengan nama file UUID.

## Catatan model data

- Status tugas: `backlog`, `ongoing`, `done` (juga dinormalkan ke boolean `done` lama).
- Prioritas tugas: `Tinggi`, `Sedang`, `Rendah`; perulangan: `none`, `daily`, `weekly`, `monthly`.
- Bentuk tugas mencakup `assigneeId`, `tags`, `comments`, `recurrence`, `recurrenceEnd`, `estimatedHours`, `actualSeconds` (pelacak waktu), `createdBy`/`createdAt`/`updatedAt`.
- Timestamp adalah string ISO UTC (`_iso_now()`).
