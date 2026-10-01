import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';
import { ensureZone } from '../../../../shared/cloudflare.js';

async function owned(env, account, name) {
  await ensureAccountColumn(env.DB);
  return await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
}

export async function onRequestGet({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  if (!await owned(env, account, name)) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });
  // Zona dibuat otomatis di akun Cloudflare Clincoo bila belum ada — pelanggan tak perlu
  // menambahkannya sendiri lewat dashboard Cloudflare dulu.
  const zone = await ensureZone(name, env.CF_API_TOKEN);
  if (zone.error) return Response.json({ ok: false, error: zone.error, message: zone.message }, { status: 502 });
  const zid = zone.id;
  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + zid + '/dns_records?per_page=100',
    { headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN } });
  const data = await res.json();
  if (!data.success) return Response.json({ ok: false, error: 'cf_error', message: (data.errors || []).map(e => e.message).join('; ') }, { status: 502 });
  const records = (data.result || []).map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied }));
  return Response.json({ ok: true, zone_id: zid, records });
}

export async function onRequestPost({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  if (!await owned(env, account, name)) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_json' }, { status: 400 }); }
  const type = (body.type || '').toUpperCase();
  if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX'].includes(type)) return Response.json({ ok: false, error: 'invalid_type' }, { status: 400 });
  const rname = (body.name || '').trim();
  const content = (body.content || '').trim();
  if (!rname || !content) return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });

  const zone = await ensureZone(name, env.CF_API_TOKEN);
  if (zone.error) return Response.json({ ok: false, error: zone.error, message: zone.message }, { status: 502 });
  const zid = zone.id;

  const payload = { type, name: rname, content, ttl: parseInt(body.ttl) > 0 ? parseInt(body.ttl) : 1 };
  if (['A', 'AAAA', 'CNAME'].includes(type)) payload.proxied = body.proxied === true;
  if (type === 'MX') payload.priority = parseInt(body.priority) > 0 ? parseInt(body.priority) : 10;

  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + zid + '/dns_records', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.success) return Response.json({ ok: false, error: 'cf_error', message: (data.errors || []).map(e => e.message).join('; ') }, { status: 400 });
  const r = data.result;
  await env.DB.prepare('UPDATE domains SET updated_at = ? WHERE account = ? AND name = ?').bind(new Date().toISOString(), account.id, name).run();
  return Response.json({ ok: true, record: { id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied } });
}
