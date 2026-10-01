// Identifikasi akun Clincoo dari Bearer token — divalidasi lewat backend utama (/api/auth/me).
// Data domain discope per akun: hanya pemilik yang melihat & mengelola domainnya.
const AUTH_ME_URL = 'https://app.clincoo.buzz/api/auth/me';

export async function getAccount(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : '';
  if (!token) return null;
  try {
    // FIX: backend utama menolak /api/auth/* yang tidak membawa User-Agent browser
    // (anti-bot). Panggilan server-ke-server dari Worker ini tidak mengirim UA sama
    // sekali -> selalu dibalas 403 "Ditolak." -> user asli yang sudah login tetap
    // dianggap "Login diperlukan." Kirim UA browser yang sah supaya lolos filter itu.
    const res = await fetch(AUTH_ME_URL, {
      headers: {
        Authorization: 'Bearer ' + token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      },
      cf: { cacheTtl: 0 }
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.authenticated || !d.user) return null;
    return { id: d.user.id, email: (d.user.email || '').toLowerCase(), admin: d.user.role === 'admin' };
  } catch (e) {
    return null;
  }
}

export async function requireAccount(request) {
  const account = await getAccount(request);
  if (!account) return { error: Response.json({ ok: false, error: 'login_required', message: 'Login diperlukan.' }, { status: 401 }) };
  return { account };
}

// Audit #7: kolom account pasti sudah ada setelah pemanggilan pertama —
// jalankan ALTER TABLE sekali per isolate, bukan di setiap request API.
let accountColPromise = null;
export async function ensureAccountColumn(db) {
  if (!accountColPromise) {
    accountColPromise = db.prepare('ALTER TABLE domains ADD COLUMN account TEXT').run().catch(() => {});
  }
  await accountColPromise;
}
