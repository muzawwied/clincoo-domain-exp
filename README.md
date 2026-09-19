# clincoo-domain-exp

Eksperimen UI: halaman CRUD domain dengan style Clincoo. Semua data dan verifikasi **disimulasikan** di browser (localStorage) — tidak ada API eksternal.

## Halaman

| Halaman | Isi |
|---|---|
| `index.html` | Daftar domain (tabel CRUD): empty state, tambah, edit catatan, hapus |
| `tambah/index.html` | Input nama domain, validasi format, CTA "Lanjutkan" muncul saat domain valid |
| `verifikasi/index.html` | Verifikasi kepemilikan: record TXT / nameserver (tab), tombol periksa (simulasi: percobaan ke-2 berhasil), CTA "Selesai" kembali ke daftar |

## Catatan style

Mengikuti style Clincoo: Tailwind CDN (darkMode `.dark-mode`), Lucide 1.41.0, Inter, accent color via `--accent-color` (localStorage `clinqoo_accent`), tema `clinqoo_theme`, header ala halaman profil (back button bulat + judul + avatar bulat bg-accent).

Data tersimpan di localStorage key `clincoo_exp_domains`.

Deploy statis: buka `index.html` langsung, GitHub Pages, atau Cloudflare Pages.
