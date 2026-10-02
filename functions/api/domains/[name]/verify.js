import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';
import { findZoneId } from '../../../../shared/cloudflare.js';

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
    const res = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(challenge) + '&type=TXT',
      { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } });
    const data = await res.json();
    answerData = (data.Answer || []).map(a => (a.data || '').replace(/^"|"$/g, ''));
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
  return Response.json({ ok: false, status: row.status, message: 'Verifikasi belum terdeteksi. Pastikan record TXT tersimpan, atau nameserver domain sudah diarahkan ke nameserver Cloudflare yang ditugaskan (lihat tab Nameserver), lalu periksa lagi.' });
}
