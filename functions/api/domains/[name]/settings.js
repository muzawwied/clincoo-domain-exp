import { requireAccount, ensureAccountColumn } from '../../../_account.js';

async function owned(env, account, name) {
  await ensureAccountColumn(env.DB);
  return await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
}

export async function onRequestGet({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  if (!await owned(env, account, name)) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  const { results } = await env.DB.prepare('SELECT k, v FROM domain_settings WHERE domain = ?').bind(name).all();
  const settings = {};
  (results || []).forEach(r => { settings[r.k] = r.v; });
  return Response.json({ ok: true, settings });
}

export async function onRequestPost({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  if (!await owned(env, account, name)) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_json' }, { status: 400 }); }
  const entries = Object.entries(body).filter(([k, v]) => typeof k === 'string' && typeof v !== 'object');
  if (!entries.length) return Response.json({ ok: false, error: 'empty' }, { status: 400 });
  for (const [k, v] of entries) {
    await env.DB.prepare('INSERT INTO domain_settings (domain, k, v) VALUES (?, ?, ?) ON CONFLICT (domain, k) DO UPDATE SET v = excluded.v')
      .bind(name, k, String(v)).run();
    await env.DB.prepare('UPDATE domains SET updated_at = ? WHERE account = ? AND name = ?').bind(new Date().toISOString(), account.id, name).run();
  }
  return Response.json({ ok: true });
}
