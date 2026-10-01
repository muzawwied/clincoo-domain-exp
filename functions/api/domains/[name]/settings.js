import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';
import { ensureZone } from '../../../../shared/cloudflare.js';

async function owned(env, account, name) {
  await ensureAccountColumn(env.DB);
  return await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
}

async function cfJson(res) {
  const d = await res.json().catch(() => ({ success: false }));
  return { ok: !!d.success, errors: (d.errors || []).map(e => e.message).join('; ') };
}

// Audit #5: pengaturan SSL/Cache/Zone kini benar-benar diterapkan ke Cloudflare API
// (pola yang sama dengan Kelola DNS, memakai env.CF_API_TOKEN).
// Kunci yang tidak dipetakan tetap hanya tersimpan ke domain_settings (tidak berubah perilaku).
const SSL_MODES = ['off', 'flexible', 'full', 'strict'];
const CACHE_LEVELS = ['off', 'basic', 'simplified', 'aggressive'];

async function applyToCloudflare(env, name, k, v) {
  if (!env.CF_API_TOKEN) return { applied: false, reason: 'no_token' };
  const zone = await ensureZone(name, env.CF_API_TOKEN);
  if (zone.error) return { applied: false, reason: zone.error };
  const zid = zone.id;
  const api = 'https://api.cloudflare.com/client/v4/zones/' + zid;
  const H = { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' };
  try {
    if (k === 'ssl_mode') {
      const mode = SSL_MODES.includes(String(v)) ? String(v) : null;
      if (!mode) return { applied: false, reason: 'invalid_value' };
      const r = await cfJson(await fetch(api + '/settings/ssl', { method: 'PATCH', headers: H, body: JSON.stringify({ value: mode }) }));
      return { applied: r.ok, errors: r.errors };
    }
    if (k === 'min_tls') {
      const r = await cfJson(await fetch(api + '/settings/min_tls_version', { method: 'PATCH', headers: H, body: JSON.stringify({ value: String(v) }) }));
      return { applied: r.ok, errors: r.errors };
    }
    if (k === 'https') {
      const r = await cfJson(await fetch(api + '/settings/always_use_https', { method: 'PATCH', headers: H, body: JSON.stringify({ value: v === 'on' ? 'on' : 'off' }) }));
      return { applied: r.ok, errors: r.errors };
    }
    if (k === 'cache_level') {
      const level = CACHE_LEVELS.includes(String(v)) ? String(v) : 'basic';
      const r = await cfJson(await fetch(api + '/settings/cache_level', { method: 'PATCH', headers: H, body: JSON.stringify({ value: level }) }));
      return { applied: r.ok, errors: r.errors };
    }
    if (k === 'devmode') {
      // Development Mode: aktifkan via POST, matikan via DELETE (edge action Cloudflare).
      const r = v === 'on'
        ? await cfJson(await fetch(api + '/settings/development_mode', { method: 'POST', headers: H }))
        : await cfJson(await fetch(api + '/settings/development_mode', { method: 'DELETE', headers: H }));
      return { applied: r.ok, errors: r.errors };
    }
    if (k === 'zone') {
      const r = await cfJson(await fetch(api, { method: 'PATCH', headers: H, body: JSON.stringify({ paused: v === 'paused' }) }));
      return { applied: r.ok, errors: r.errors };
    }
    if (k === 'purged_at') {
      // Tombol "Bersihkan Cache" menyimpan timestamp — jalankan purge asli juga.
      const r = await cfJson(await fetch(api + '/purge_cache', { method: 'POST', headers: H, body: JSON.stringify({ purge_everything: true }) }));
      return { applied: r.ok, errors: r.errors };
    }
  } catch (e) {
    return { applied: false, reason: 'network_error' };
  }
  return { applied: false, reason: 'unmapped_key' };
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
  // Terapkan ke Cloudflare untuk kunci yang dipetakan. Zone tidak ditemukan / token absen
  // -> tetap ok (nilai tersimpan), info penerapan dikembalikan di field "applied".
  const applied = {};
  for (const [k, v] of entries) {
    applied[k] = await applyToCloudflare(env, name, k, v);
  }
  return Response.json({ ok: true, applied });
}
