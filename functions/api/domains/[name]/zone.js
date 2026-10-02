// Zona Cloudflare milik domain (di akun Clincoo) — sumber nameserver asli untuk verifikasi NS.
// GET  /api/domains/:name/zone -> { ok, zone: { name_servers } | null }
// POST /api/domains/:name/zone -> pastikan zona ada (buat bila perlu), balikin name_servers.
// Nameserver yang sudah diketahui disimpan di D1 (kolom ns_servers) supaya request
// berikutnya TIDAK perlu round-trip ke API Cloudflare lagi — inilah yang bikin tab
// Nameserver terasa lama saat pertama dibuka.
import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';
import { findZoneId, ensureZone } from '../../../../shared/cloudflare.js';

// Migrasi kolom ns_servers — sekali per isolate, abaikan error duplicate column.
let nsColPromise = null;
function ensureNsColumn(db) {
  if (!nsColPromise) {
    nsColPromise = db.prepare('ALTER TABLE domains ADD COLUMN ns_servers TEXT').run().catch(() => {});
  }
  return nsColPromise;
}

async function zoneDetail(name, token) {
  const id = await findZoneId(name, token);
  if (!id) return null;
  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + encodeURIComponent(id),
    { headers: { Authorization: 'Bearer ' + token }, cf: { cacheTtl: 0 } });
  const data = await res.json();
  if (!data.success || !data.result) return null;
  return { id: data.result.id, status: data.result.status, name_servers: data.result.name_servers || [] };
}

async function requireOwnedRow(env, account, name) {
  await ensureAccountColumn(env.DB);
  await ensureNsColumn(env.DB);
  return env.DB.prepare('SELECT id, ns_servers FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
}

function parseSaved(row) {
  if (row && row.ns_servers) {
    try { const ns = JSON.parse(row.ns_servers); if (Array.isArray(ns) && ns.length) return ns; } catch (e) {}
  }
  return null;
}

async function saveNs(env, rowId, ns) {
  await env.DB.prepare('UPDATE domains SET ns_servers = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(ns), new Date().toISOString(), rowId).run();
}

export async function onRequestGet({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });
  const name = decodeURIComponent(params.name || '').toLowerCase();
  const row = await requireOwnedRow(env, account, name);
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  const saved = parseSaved(row);
  if (saved) return Response.json({ ok: true, zone: { name_servers: saved } });
  const zone = env.CF_API_TOKEN ? await zoneDetail(name, env.CF_API_TOKEN) : null;
  if (zone && zone.name_servers.length) { await saveNs(env, row.id, zone.name_servers); return Response.json({ ok: true, zone: zone }); }
  return Response.json({ ok: true, zone: null });
}

export async function onRequestPost({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });
  const name = decodeURIComponent(params.name || '').toLowerCase();
  const row = await requireOwnedRow(env, account, name);
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  // Jalur cepat: nameserver sudah pernah diambil & tersimpan di D1 — balas instan.
  const saved = parseSaved(row);
  if (saved) return Response.json({ ok: true, created: false, name_servers: saved });

  const zone = await ensureZone(name, env.CF_API_TOKEN);
  if (zone.error) return Response.json({ ok: false, error: zone.error, message: zone.message }, { status: 400 });
  let ns = zone.name_servers || [];
  if (!zone.created) {
    // Zona sudah ada dari interaksi sebelumnya (mis. menambah record DNS) —
    // ambil pasangan nameserver yang ditugaskan untuk zona ini.
    const detail = await zoneDetail(name, env.CF_API_TOKEN);
    ns = (detail && detail.name_servers) || [];
  }
  if (ns.length) await saveNs(env, row.id, ns);
  return Response.json({ ok: true, created: !!zone.created, name_servers: ns });
}
