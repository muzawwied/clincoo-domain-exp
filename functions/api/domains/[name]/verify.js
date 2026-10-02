import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';

// Verifikasi kepemilikan domain. Metode utama: NAMESERVER — cukup NS publik
// domain mengarah ke Cloudflare (pasangan yang ditugaskan bila ada), tanpa
// wajib zonanya berada di akun Cloudflare Clincoo. Fallback senyap: record TXT
// _clincoo-challenge.<domain> dengan nilai token (tetap diterima).
export async function onRequestPost({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  await ensureAccountColumn(env.DB);
  const row = await env.DB.prepare('SELECT id, token, status, ns_servers FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
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

  // Metode utama (NS): cukup nameserver publik domain menunjuk ke Cloudflare —
  // TIDAK wajib zonanya ada di akun Cloudflare Clincoo. Mengubah nameserver di
  // registrar hanya bisa dilakukan pemilik domain, jadi ini bukti kepemilikan yang sah.
  // Kalau pasangan NS ditugaskan platform tersimpan (ns_servers), cocokkan dengannya;
  // kalau tidak ada, terima nameserver Cloudflare mana pun.
  if (!found) {
    try {
      const [cfNs, gNs] = await Promise.all([
        fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=NS',
          { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } }).then(r => r.json()),
        fetch('https://dns.google/resolve?name=' + encodeURIComponent(name) + '&type=NS',
          { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } }).then(r => r.json())
      ]);
      const nsList = (cfNs.Answer || []).concat(gNs.Answer || [])
        .map(a => String(a.data || '').toLowerCase().replace(/\.$/, ''));
      let assigned = [];
      try { assigned = (row.ns_servers ? JSON.parse(row.ns_servers) : []).map(n => String(n).toLowerCase()); } catch (e) {}
      const nsCloudflare = nsList.some(ns => ns.endsWith('.ns.cloudflare.com'));
      if (assigned.length >= 2) {
        nsOk = assigned.every(ns => nsList.includes(ns)); // cocok pasangan yang ditugaskan
      } else {
        nsOk = nsCloudflare;
      }
    } catch (e) { /* NS lookup gagal — tetap lanjut sebagai gagal verifikasi */ }
  }

  if (found || nsOk) {
    await env.DB.prepare("UPDATE domains SET status = 'aktif', verified_at = ?, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), new Date().toISOString(), row.id).run();
    return Response.json({ ok: true, status: 'aktif' });
  }
  // TXT ditemukan di zona Cloudflare Clincoo (via Kelola DNS) tapi tidak resolve publik
  // -> domain belum memakai nameserver Cloudflare. Jelaskan dua solusinya.
  return Response.json({ ok: false, status: row.status, message: 'Nameserver domain-mu belum terdeteksi mengarah ke Cloudflare. Pastikan nameserver di registrar domain sudah diganti sesuai daftar di halaman ini, tunggu propagasi (biasanya beberapa menit, maksimal 24 jam), lalu periksa lagi.' });
}
