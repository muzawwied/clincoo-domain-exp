import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';
import { findZoneId } from '../../../../shared/cloudflare.js';

// Cek apakah TXT challenge tersimpan di zona Cloudflare Clincoo (dibuat lewat
// menu Kelola DNS). Kalau ya tapi domain belum memakai nameserver Cloudflare,
// record itu BELUM aktif publik — inilah penyebab umum "verifikasi belum
// terdeteksi" padahal user merasa sudah menambahkan TXT.
async function txtInClincooZone(name, token, challenge) {
  if (!token) return false;
  try {
    const zid = await findZoneId(name, token);
    if (!zid) return false;
    const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + encodeURIComponent(zid) + '/dns_records?type=TXT&name=' + encodeURIComponent(challenge) + '&per_page=5',
      { headers: { Authorization: 'Bearer ' + token }, cf: { cacheTtl: 0 } });
    const data = await res.json();
    return !!(data.success && data.result && data.result.length);
  } catch (e) { return false; }
}

export async function onRequestPost({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  await ensureAccountColumn(env.DB);
  const row = await env.DB.prepare('SELECT id, token, status FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const challenge = '_clincoo-challenge.' + name;
  let found = false, answerData = [], nsOk = false;
  try {
    const query = (base) => fetch(base + '?name=' + encodeURIComponent(challenge) + '&type=TXT',
      { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } }).then(r => r.json()).catch(() => ({}));
    const [cfData, gData] = await Promise.all([
      query('https://cloudflare-dns.com/dns-query'),
      query('https://dns.google/resolve')
    ]);
    const answers = (cfData.Answer || []).concat(gData.Answer || []);
    answerData = answers.map(a => (a.data || '').replace(/^"|"$/g, ''));
    found = answerData.includes(row.token);
  } catch (e) {
    return Response.json({ ok: false, error: 'dns_lookup_failed' }, { status: 502 });
  }

  // Metode alternatif: zona domain ada di akun Cloudflare Clincoo (dibuat lewat
  // /zone atau saat menambah record DNS) DAN registrar domain sudah mengarahkan
  // nameserver ke pasangan Cloudflare yang ditugaskan. Mengarahkan nameserver
  // hanya bisa dilakukan pemilik domain — sama seperti aktivasi zona Cloudflare.
  if (!found) {
    try {
      const [nsData, zoneId] = await Promise.all([
        fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=NS',
          { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } }).then(r => r.json()),
        env.CF_API_TOKEN ? findZoneId(name, env.CF_API_TOKEN) : Promise.resolve(null)
      ]);
      const nsCloudflare = (nsData.Answer || []).some(a => {
        const ns = String(a.data || '').toLowerCase().replace(/\.$/, '');
        return ns.endsWith('.ns.cloudflare.com');
      });
      nsOk = !!(zoneId && nsCloudflare);
    } catch (e) { /* NS lookup gagal — tetap lanjut sebagai gagal verifikasi */ }
  }

  if (found || nsOk) {
    await env.DB.prepare("UPDATE domains SET status = 'aktif', verified_at = ?, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), new Date().toISOString(), row.id).run();
    return Response.json({ ok: true, status: 'aktif' });
  }
  // TXT ditemukan di zona Cloudflare Clincoo (via Kelola DNS) tapi tidak resolve publik
  // -> domain belum memakai nameserver Cloudflare. Jelaskan dua solusinya.
  if (await txtInClincooZone(name, env.CF_API_TOKEN, challenge)) {
    return Response.json({ ok: false, status: row.status, message: 'Record TXT kamu tersimpan di zona Cloudflare Clincoo, tapi domain masih memakai nameserver lain — record itu belum aktif publik. Pilih salah satu: (1) tambahkan record TXT ini langsung di penyedia DNS domain-mu (dashboard registrar tempat domain dibeli), atau (2) arahkan nameserver domain-mu ke nameserver Cloudflare di tab Nameserver. Lalu periksa lagi.' });
  }
  return Response.json({ ok: false, status: row.status, message: 'Verifikasi belum terdeteksi. Tambahkan record TXT di penyedia DNS domain-mu (dashboard registrar tempat domain dibeli) — bukan lewat Kelola DNS Clincoo, karena record itu hanya aktif setelah domain memakai nameserver Cloudflare. Atau arahkan nameserver domain-mu ke Cloudflare (tab Nameserver). Setelah itu, tunggu beberapa menit lalu periksa lagi.' });
}
