export async function onRequestPost({ env, params }) {
  const name = decodeURIComponent(params.name || '').toLowerCase();
  const row = await env.DB.prepare('SELECT id, token, status FROM domains WHERE name = ?').bind(name).first();
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const challenge = '_clincoo-challenge.' + name;
  let found = false, answerData = [];
  try {
    const res = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(challenge) + '&type=TXT',
      { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } });
    const data = await res.json();
    answerData = (data.Answer || []).map(a => (a.data || '').replace(/^"|"$/g, ''));
    found = answerData.includes(row.token);
  } catch (e) {
    return Response.json({ ok: false, error: 'dns_lookup_failed' }, { status: 502 });
  }

  if (found) {
    await env.DB.prepare("UPDATE domains SET status = 'aktif', verified_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
    return Response.json({ ok: true, status: 'aktif' });
  }
  return Response.json({ ok: false, status: row.status, message: 'Record TXT belum terdeteksi di DNS publik. Pastikan record sudah tersimpan di penyedia domain-mu, lalu periksa lagi.' });
}
