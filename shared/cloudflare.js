// ID akun Cloudflare yang menaungi SEMUA zona domain pelanggan (akun backend Clincoo/Clinqoo,
// tempat zona clincoo.buzz & clinqoo.biz.id juga berada). Token CF_API_TOKEN sudah memiliki
// izin Zone:Create di akun ini (diverifikasi via probe non-destruktif ke POST /zones).
const CF_ACCOUNT_ID = '59db6147da9378dbff365a8d52243fcf';

async function findZoneId(name, token) {
  const res = await fetch('https://api.cloudflare.com/client/v4/zones?name=' + encodeURIComponent(name) + '&per_page=1',
    { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!data.success || !data.result || !data.result.length) return null;
  return data.result[0].id;
}

async function createZone(name, token) {
  const res = await fetch('https://api.cloudflare.com/client/v4/zones', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, account: { id: CF_ACCOUNT_ID } })
  });
  const data = await res.json();
  if (!data.success || !data.result) {
    return { error: 'zone_create_failed', message: (data.errors || []).map(e => e.message).join('; ') || 'Gagal menambahkan domain ini ke Cloudflare.' };
  }
  return { id: data.result.id, name_servers: data.result.name_servers || [] };
}

// Pastikan zona Cloudflare utk domain ini ADA di akun Clincoo — kalau belum ada, buat otomatis
// lewat API (menggantikan langkah manual "tambahkan dulu di dashboard Cloudflare").
// Hasil sukses: { id, created: boolean, name_servers?: string[] }.
// Hasil gagal (mis. domain sudah dipakai di akun Cloudflare lain / ditolak Cloudflare): { error, message }.
export async function ensureZone(name, token) {
  const existing = await findZoneId(name, token);
  if (existing) return { id: existing, created: false };
  const created = await createZone(name, token);
  if (created.error) return created;
  return { id: created.id, created: true, name_servers: created.name_servers };
}
