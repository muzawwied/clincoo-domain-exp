# clincoo-domain-exp

Eksperimen UI: halaman CRUD domain dengan style Clincoo. Semua data dan verifikasi **disimulasikan** di browser (localStorage) — tidak ada API eksternal.

## Halaman

| Halaman | Isi |
|---|---|
| `index.html` | Daftar domain (tabel CRUD): empty state, cari, tambah, hapus, menu aksi per domain |
| `tambah/index.html` | Input nama domain, validasi format + cek duplikat, CTA "Lanjutkan" muncul saat domain valid |
| `verifikasi/index.html` | Verifikasi kepemilikan: tab **TXT / Nameserver**, tombol "Periksa Verifikasi" (simulasi: percobaan ke-2 berhasil) → status domain menjadi **aktif**; opsi "Verifikasi nanti saja" → status pending. Nilai TXT stabil per domain (hash), tidak berubah saat reload |
| `kelola/dns/index.html` | Kelola record DNS: tambah/hapus record (A, AAAA, CNAME, TXT, MX), pilih tipe via popover |
| `kelola/ssl/index.html` | Mode enkripsi (flexible/full/strict) + versi TLS minimum |
| `kelola/cache/index.html` | Tingkat cache, Development Mode, Purge Cache (simulasi + waktu terakhir dibersihkan) |
| `kelola/zone/index.html` | Pause/aktifkan zone |

## Catatan style

Mengikuti style Clincoo: Tailwind CDN (darkMode `.dark-mode`), Lucide 1.41.0, Inter, accent color via `--accent-color` (localStorage `clinqoo_accent`), tema `clinqoo_theme`, header ala halaman profil (back button bulat + judul).

Data tersimpan di localStorage key `clincoo_exp_domains` (daftar domain) dan `clincoo_exp_<nama>_<domain>` (pengaturan per domain).

Deploy statis: buka `index.html` langsung, GitHub Pages, atau Cloudflare Pages.

## Riwayat rapikan (Sep 2026)

- `app.html` dihapus: file halaman "Integrasi" dari aplikasi utama yang tidak sengaja masuk ke repo eksperimen ini (sidebar & API-nya tidak ada di repo ini).
- Verifikasi domain kini benar-benar mengubah status menjadi aktif (sebelumnya tidak ada alur yang mengeset `aktif`, semua domain selamanya "belum terverifikasi").
