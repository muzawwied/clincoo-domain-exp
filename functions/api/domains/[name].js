import { requireAccount, ensureAccountColumn } from '../../_account.js';

export async function onRequestDelete({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  await ensureAccountColumn(env.DB);
  const row = await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
  if (!row) return Response.json({ ok: true, deleted: false });
  const r = await env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(row.id).run();
  await env.DB.prepare('DELETE FROM domain_settings WHERE domain = ?').bind(name).run();
  return Response.json({ ok: true, deleted: r.meta.changes > 0 });
}
