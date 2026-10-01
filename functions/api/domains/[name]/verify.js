import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';

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

  // Metode alternatif: nameserver domain mengarah ke ns1/ns2.clincoo.buzz
  if (!found) {
    try {
      const res = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=NS',
        { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } });
      const data = await res.json();
      nsOk = (data.Answer || []).some(a => {
        const ns = String(a.data || '').toLowerCase().replace(/\.$/, '');
        return ns.endsWith('.clincoo.buzz');
      });
    } catch (e) { /* NS lookup gagal — tetap lanjut sebagai gagal verifikasi */ }
  }

  if (found || nsOk) {
    await env.DB.prepare("UPDATE domains SET status = 'aktif', verified_at = ?, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), new Date().toISOString(), row.id).run();
    return Response.json({ ok: true, status: 'aktif' });
  }
  return Response.json({ ok: false, status: row.status, message: 'Verifikasi belum terdeteksi. Pastikan record TXT tersimpan, atau nameserver domain sudah diarahkan ke ns1/ns2.clincoo.buzz, lalu periksa lagi.' });
}
