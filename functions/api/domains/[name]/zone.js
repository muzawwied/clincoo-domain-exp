// Zona Cloudflare milik domain (di akun Clincoo) — sumber nameserver asli untuk verifikasi NS.
// GET  /api/domains/:name/zone -> { ok, zone: { id, status, name_servers } | null }
// POST /api/domains/:name/zone -> buat zona bila belum ada, balikin name_servers yang ditugaskan.
import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';
import { findZoneId, ensureZone } from '../../../../shared/cloudflare.js';

async function zoneDetail(name, token) {
  const id = await findZoneId(name, token);
  if (!id) return { ok: true, zone: null };
  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + encodeURIComponent(id),
    { headers: { Authorization: 'Bearer ' + token }, cf: { cacheTtl: 0 } });
  const data = await res.json();
  if (!data.success || !data.result) return { ok: true, zone: null };
  const z = data.result;
  return { ok: true, zone: { id: z.id, status: z.status, name_servers: z.name_servers || [] } };
}

export async function onRequestGet({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });
  const name = decodeURIComponent(params.name || '').toLowerCase();
  await ensureAccountColumn(env.DB);
  const row = await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  return Response.json(await zoneDetail(name, env.CF_API_TOKEN));
}

export async function onRequestPost({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });
  const name = decodeURIComponent(params.name || '').toLowerCase();
  await ensureAccountColumn(env.DB);
  const row = await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  const zone = await ensureZone(name, env.CF_API_TOKEN);
  if (zone.error) return Response.json({ ok: false, error: zone.error, message: zone.message }, { status: 400 });
  return Response.json({ ok: true, created: !!zone.created, name_servers: zone.name_servers || [] });
}
