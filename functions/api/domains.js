function isValidDomain(s) {
  if (!s || typeof s !== 'string') return false;
  s = s.trim().toLowerCase();
  if (s.length > 253 || /\s/.test(s)) return false;
  if (!/^[a-z0-9.-]+$/.test(s)) return false;
  const parts = s.split('.');
  if (parts.length < 2) return false;
  if (!/^[a-z]{2,}$/.test(parts[parts.length - 1])) return false;
  return parts.every(p => p && p.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(p));
}
function makeId() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function makeToken() {
  return 'clincoo-verify=' + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare('SELECT id, name, status, note, created_at, verified_at, token FROM domains ORDER BY created_at DESC').all();
  return Response.json({ ok: true, domains: results });
}

export async function onRequestPost({ env, request }) {
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_json' }, { status: 400 }); }
  const name = (body.name || '').trim().toLowerCase();
  if (!isValidDomain(name)) return Response.json({ ok: false, error: 'invalid_domain' }, { status: 400 });

  const existing = await env.DB.prepare('SELECT id, name, status, note, created_at, verified_at, token FROM domains WHERE name = ?').bind(name).first();
  if (existing) return Response.json({ ok: true, exists: true, domain: existing });

  const row = { id: makeId(), name, token: makeToken(), status: 'pending', note: body.note || '', created_at: new Date().toISOString(), verified_at: null };
  await env.DB.prepare('INSERT INTO domains (id, name, token, status, note, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.name, row.token, row.status, row.note, row.created_at, null).run();
  return Response.json({ ok: true, exists: false, domain: row });
}
