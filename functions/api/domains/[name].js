export async function onRequestDelete({ env, params }) {
  const name = decodeURIComponent(params.name || '').toLowerCase();
  const r = await env.DB.prepare('DELETE FROM domains WHERE name = ?').bind(name).run();
  await env.DB.prepare('DELETE FROM domain_settings WHERE domain = ?').bind(name).run();
  return Response.json({ ok: true, deleted: r.meta.changes > 0 });
}
