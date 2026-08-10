# SyncUp

Aplikasi MVP untuk manajemen kerja tim dengan fitur:

- Dashboard ringkasan aktivitas
- Form tambah tugas atau agenda
- Daftar tugas yang bisa ditandai selesai
- Agenda mendatang
- Catatan cepat
- Data tersimpan di SQLite (`syncup.db`); impor otomatis dari `data.json` jika DB masih kosong

## Cara menjalankan

Jalankan server backend lokal dari folder project:

```bash
python server.py
```

Lalu buka http://localhost:8000

### Database

- File database: `syncup.db` (SQLite, tidak perlu server DB terpisah)
- Skema: lihat `schema.sql`
- Inisialisasi manual: `python -m database init`
- Impor dari JSON: `python -m database import data.json`

Jika Python belum tersedia, instal Python terlebih dahulu lalu jalankan perintah di atas.
