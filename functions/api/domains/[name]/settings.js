export async function onRequestGet({ env, params }) {
  const name = decodeURIComponent(params.name || '').toLowerCase();
  const { results } = await env.DB.prepare('SELECT k, v FROM domain_settings WHERE domain = ?').bind(name).all();
  const settings = {};
  (results || []).forEach(r => { settings[r.k] = r.v; });
  return Response.json({ ok: true, settings });
}

export async function onRequestPost({ env, params, request }) {
  const name = decodeURIComponent(params.name || '').toLowerCase();
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_json' }, { status: 400 }); }
  const entries = Object.entries(body).filter(([k, v]) => typeof k === 'string' && typeof v !== 'object');
  if (!entries.length) return Response.json({ ok: false, error: 'empty' }, { status: 400 });
  for (const [k, v] of entries) {
    await env.DB.prepare('INSERT INTO domain_settings (domain, k, v) VALUES (?, ?, ?) ON CONFLICT (domain, k) DO UPDATE SET v = excluded.v')
      .bind(name, k, String(v)).run();
  }
  return Response.json({ ok: true });
}
