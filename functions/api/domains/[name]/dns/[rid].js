import { requireAccount, ensureAccountColumn } from '../../../../_account.js';

export async function onRequestDelete({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  const rid = params.rid || '';
  await ensureAccountColumn(env.DB);
  const row = await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });
  const res = await fetch('https://api.cloudflare.com/client/v4/zones?name=' + encodeURIComponent(name) + '&per_page=1',
    { headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN } });
  const data = await res.json();
  if (!data.success || !data.result || !data.result.length) return Response.json({ ok: false, error: 'zone_not_found', message: 'Domain ini belum berada di akun Cloudflare-mu.' }, { status: 404 });
  const zid = data.result[0].id;
  const del = await fetch('https://api.cloudflare.com/client/v4/zones/' + zid + '/dns_records/' + encodeURIComponent(rid), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN }
  });
  const ddata = await del.json();
  if (!ddata.success) return Response.json({ ok: false, error: 'cf_error', message: (ddata.errors || []).map(e => e.message).join('; ') }, { status: 400 });
  await env.DB.prepare('UPDATE domains SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), row.id).run();
  return Response.json({ ok: true });
}
