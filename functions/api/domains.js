import { requireAccount, ensureAccountColumn } from '../../shared/account.js';

const SUB_API = 'https://app.clincoo.buzz/api/subscription?fields=plan';

// Audit #4: ambil paket akun dari backend utama. Gagal/lambat -> null (fail-open,
// konsisten dengan gerbang CTA di frontend) supaya user valid tidak terblokir.
async function getPlan(request) {
  try {
    const t = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!t) return null;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(SUB_API, { headers: { Authorization: 'Bearer ' + t }, signal: ctrl.signal, cf: { cacheTtl: 0 } });
    clearTimeout(tid);
    if (!res.ok) return null;
    const d = await res.json();
    return (d && d.plan) ? d.plan : null;
  } catch (e) { return null; }
}

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

export async function onRequestGet({ env, request }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  await ensureAccountColumn(env.DB);
  const { results } = await env.DB.prepare('SELECT id, name, status, note, created_at, verified_at, token, COALESCE(updated_at, created_at) AS updated_at FROM domains WHERE account = ? ORDER BY created_at DESC').bind(account.id).all();
  return Response.json({ ok: true, domains: results });
}

export async function onRequestPost({ env, request }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_json' }, { status: 400 }); }
  const name = (body.name || '').trim().toLowerCase();
  if (!isValidDomain(name)) return Response.json({ ok: false, error: 'invalid_domain' }, { status: 400 });

  await ensureAccountColumn(env.DB);
  const existing = await env.DB.prepare('SELECT id, name, status, note, created_at, verified_at, token FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
  if (existing) return Response.json({ ok: true, exists: true, domain: existing });

  // Audit #4: kuota domain per paket — Starter maksimal 1 domain, admin bebas.
  if (!account.admin) {
    const plan = await getPlan(request);
    if (plan === 'Starter') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM domains WHERE account = ?').bind(account.id).first();
      if ((row && row.count || 0) >= 1) {
        return Response.json({ ok: false, error: 'plan_required', plan: 'Starter', message: 'Kuota domain paket Starter hanya 1 domain. Upgrade ke Pro atau Bisnis untuk menambah domain lagi.' }, { status: 402 });
      }
    }
  }

  const row = { id: makeId(), name, token: makeToken(), status: 'pending', note: body.note || '', created_at: new Date().toISOString(), verified_at: null, updated_at: new Date().toISOString() };
  await env.DB.prepare('INSERT INTO domains (id, name, token, status, note, created_at, verified_at, updated_at, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.name, row.token, row.status, row.note, row.created_at, null, row.updated_at, account.id).run();
  return Response.json({ ok: true, exists: false, domain: row });
}
