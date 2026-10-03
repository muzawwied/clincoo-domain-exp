// Jembatan notifikasi domain -> backend utama Clincoo (/api/domain-notify).
// Dipanggil dengan Bearer token milik user yang sedang melakukan aksi, jadi email
// hanya pernah dikirim ke pemilik akun itu sendiri. Best-effort: kegagalan kirim
// tidak boleh menggagalkan aksi utama (tambah/hapus/verifikasi domain).
const NOTIFY_URL = 'https://app.clincoo.buzz/api/domain-notify';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export async function notifyDomain(request, type, domain, extra) {
  try {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return false;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'User-Agent': UA },
      body: JSON.stringify(Object.assign({ type: type, domain: domain }, extra || {})),
      signal: ctrl.signal,
      cf: { cacheTtl: 0 }
    });
    clearTimeout(tid);
    try { return !!(res.ok && (await res.json()).ok); } catch (e) { return false; }
  } catch (e) {
    return false;
  }
}

// Jalankan promise di background bila waitUntil tersedia (tidak menahan respons),
// kalau tidak tersedia, jalankan sinkron (aman juga).
export function fire(promise, waitUntil) {
  if (waitUntil) { try { waitUntil(promise); return; } catch (e) {} }
  return promise;
}

// ===== Kolom tambahan tabel domains (lazily, sekali per isolate) =====
let extraColsPromise = null;
export async function ensureDomainExtraCols(db) {
  if (!extraColsPromise) {
    extraColsPromise = (async () => {
      await db.prepare('ALTER TABLE domains ADD COLUMN last_ns_check TEXT').run().catch(() => {});
      await db.prepare('ALTER TABLE domains ADD COLUMN ns_alert_at TEXT').run().catch(() => {});
      await db.prepare('CREATE TABLE IF NOT EXISTS domain_otp (account TEXT PRIMARY KEY, code_hash TEXT, expires_at TEXT, attempts INTEGER DEFAULT 0, created_at TEXT, verified_at TEXT)').run().catch(() => {});
      await db.prepare('CREATE TABLE IF NOT EXISTS domain_otp_log (account TEXT, created_at TEXT)').run().catch(() => {});
    })();
  }
  await extraColsPromise;
}

// ===== OTP =====
const OTP_TTL_MS = 10 * 60 * 1000;   // kode berlaku 10 menit
const OTP_GRACE_MS = 60 * 60 * 1000;  // setelah OTP sukses, bebas OTP 1 jam
const OTP_COOLDOWN_MS = 60 * 1000;    // kirim ulang kode minimal 60 detik
const OTP_MAX_SEND_10MIN = 3;         // maksimal 3 kode per 10 menit
const OTP_MAX_ATTEMPTS = 6;

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return 'email akunmu';
  const at = email.indexOf('@');
  if (at <= 0) return 'email akunmu';
  const local = email.slice(0, at);
  const dom = email.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return head + '***@' + dom;
}

// Terbitkan kode OTP baru (atau kembalikan status cooldown). Hasil: {body, status}
export async function issueOtp(env, request, account, waitUntil) {
  const db = env.DB;
  await ensureDomainExtraCols(db);
  const now = Date.now();

  // Rate limit pengiriman: maksimal OTP_MAX_SEND_10MIN kode per 10 menit.
  try {
    await db.prepare("DELETE FROM domain_otp_log WHERE account = ? AND CAST(strftime('%s', created_at) AS INTEGER) < CAST(strftime('%s','now') AS INTEGER) - 1800").bind(account.id).run();
  } catch (e) {}
  let sent = 0;
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM domain_otp_log WHERE account = ? AND CAST(strftime('%s', created_at) AS INTEGER) > CAST(strftime('%s','now') AS INTEGER) - 600").bind(account.id).first();
    sent = (r && r.count) || 0;
  } catch (e) {}
  if (sent >= OTP_MAX_SEND_10MIN) {
    return { status: 429, body: { ok: false, otp_required: true, error: 'otp_rate_limited', message: 'Terlalu banyak permintaan kode verifikasi. Tunggu sekitar 10 menit lalu coba lagi.' } };
  }

  // Cooldown: kode terakhir belum 60 detik — jangan kirim ulang.
  let row = null;
  try { row = await db.prepare('SELECT created_at FROM domain_otp WHERE account = ?').bind(account.id).first(); } catch (e) {}
  if (row && row.created_at) {
    const age = now - Date.parse(row.created_at);
    if (!isNaN(age) && age < OTP_COOLDOWN_MS) {
      return { status: 200, body: { ok: false, otp_required: true, otp_sent: false, message: 'Kode verifikasi baru saja dikirim. Periksa email ' + maskEmail(account.email) + ' — kode berlaku 10 menit.' } };
    }
  }

  // Terbitkan kode baru.
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const codeHash = await sha256hex(account.id + ':' + code);
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
  const createdAt = new Date(now).toISOString();
  await db.prepare('INSERT INTO domain_otp (account, code_hash, expires_at, attempts, created_at, verified_at) VALUES (?, ?, ?, 0, ?, NULL) ON CONFLICT(account) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at, verified_at = NULL')
    .bind(account.id, codeHash, expiresAt, createdAt).run();
  try { await db.prepare('INSERT INTO domain_otp_log (account, created_at) VALUES (?, ?)').bind(account.id, createdAt).run(); } catch (e) {}

  fire(notifyDomain(request, 'domain_otp', 'clincoo.app', { code: code }), waitUntil);
  return { status: 200, body: { ok: false, otp_required: true, otp_sent: true, email_hint: maskEmail(account.email), message: 'Aktivitas penambahan domain tidak biasa terdeteksi. Kode verifikasi dikirim ke ' + maskEmail(account.email) + ' — masukkan kode itu untuk melanjutkan.' } };
}

// Verifikasi kode OTP. Hasil: {ok, reason, message}
export async function verifyOtp(env, account, code) {
  const db = env.DB;
  await ensureDomainExtraCols(db);
  const row = await db.prepare('SELECT code_hash, expires_at, attempts FROM domain_otp WHERE account = ?').bind(account.id).first();
  if (!row) return { ok: false, reason: 'no_otp', message: 'Kode verifikasi tidak ditemukan. Minta kode baru lewat halaman verifikasi domain.' };
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { ok: false, reason: 'expired', message: 'Kode verifikasi kedaluwarsa (berlaku 10 menit). Minta kode baru lewat halaman verifikasi domain.' };
  }
  if ((row.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts', message: 'Terlalu banyak percobaan kode salah. Minta kode baru lewat halaman verifikasi domain.' };
  }
  const hash = await sha256hex(account.id + ':' + String(code || '').trim());
  if (hash !== row.code_hash) {
    await db.prepare('UPDATE domain_otp SET attempts = attempts + 1 WHERE account = ?').bind(account.id).run();
    return { ok: false, reason: 'wrong', message: 'Kode verifikasi salah. Periksa kembali kode di emailmu.' };
  }
  return { ok: true };
}

// Tandai OTP sukses -> grace 1 jam (bebas OTP utk tambah domain berikutnya).
export async function markOtpVerified(env, account) {
  const db = env.DB;
  await db.prepare('UPDATE domain_otp SET verified_at = ?, attempts = 0 WHERE account = ?').bind(new Date().toISOString(), account.id).run().catch(() => {});
}

// Apakah akun ini sedang dalam masa grace OTP (baru saja lolos verifikasi)?
export async function otpGraceActive(env, account) {
  try {
    const row = await env.DB.prepare('SELECT verified_at FROM domain_otp WHERE account = ?').bind(account.id).first();
    return !!(row && row.verified_at && (Date.now() - Date.parse(row.verified_at)) < OTP_GRACE_MS && !isNaN(Date.parse(row.verified_at)));
  } catch (e) { return false; }
}
