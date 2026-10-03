import { requireAccount, ensureAccountColumn } from '../../shared/account.js';
import { notifyDomain, fire, ensureDomainExtraCols, issueOtp, verifyOtp, markOtpVerified, otpGraceActive } from '../../shared/notify.js';
import { nsPointsToCloudflare } from '../../shared/nscheck.js';

const SUB_API = 'https://app.clincoo.buzz/api/subscription?fields=plan';

// Ambang aktivitas mencurigakan: tambah domain >= 3 dalam 24 jam -> minta OTP.
// Tambah domain normal (1-2 sehari) TIDAK diminta OTP. Setelah OTP sukses, akun
// bebas OTP selama 1 jam (grace) supaya tidak diminta berulang-ulang.
const BURST_24H = 3;
const NS_SWEEP_MIN_H = 6;       // sweep NS tiap domain aktif maksimal sekali per 6 jam
const NS_ALERT_RESEND_MS = 6 * 3600 * 1000; // email "lepas dari NS" maks 1x / 6 jam

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

export async function onRequestGet({ env, request, waitUntil }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  await ensureAccountColumn(env.DB);
  await ensureDomainExtraCols(env.DB);
  const { results } = await env.DB.prepare('SELECT id, name, status, note, created_at, verified_at, token, ns_servers, COALESCE(last_ns_check, \'\') AS last_ns_check, COALESCE(ns_alert_at, \'\') AS ns_alert_at, COALESCE(updated_at, created_at) AS updated_at FROM domains WHERE account = ? ORDER BY created_at DESC').bind(account.id).all();
  const domains = results || [];
  // Sweep latar: domain AKTIF dicek nameservernya maksimal sekali per 6 jam.
  // Bila NS sudah tidak mengarah ke Cloudflare -> status kembali "pending" +
  // email peringatan "domain lepas dari nameserver" (maks 1x per 6 jam per domain).
  try {
    const sweep = sweepActiveDomains(env, request, account, domains);
    if (waitUntil) waitUntil(sweep);
  } catch (e) {}
  return Response.json({ ok: true, domains });
}

async function sweepActiveDomains(env, request, account, domains) {
  try { await ensureDomainExtraCols(env.DB); } catch (e) { return; }
  const now = Date.now();
  for (const d of domains.slice(0, 15)) {
    if (!d || d.status !== 'aktif') continue;
    const last = d.last_ns_check ? Date.parse(d.last_ns_check) : 0;
    if (last && now - last < NS_SWEEP_MIN_H * 3600 * 1000) continue;
    let assigned = [];
    try { assigned = d.ns_servers ? JSON.parse(d.ns_servers) : []; } catch (e) {}
    let ok = false;
    try { ok = await nsPointsToCloudflare(d.name, assigned); } catch (e) { ok = true; /* lookup gagal -> jangan salah tuduh */ }
    const nowIso = new Date().toISOString();
    if (ok) {
      await env.DB.prepare('UPDATE domains SET last_ns_check = ? WHERE id = ?').bind(nowIso, d.id).run().catch(() => {});
    } else {
      const prevAlert = d.ns_alert_at ? Date.parse(d.ns_alert_at) : 0;
      await env.DB.prepare("UPDATE domains SET status = 'pending', updated_at = ?, last_ns_check = ?, ns_alert_at = ? WHERE id = ?").bind(nowIso, nowIso, nowIso, d.id).run().catch(() => {});
      if (!prevAlert || now - prevAlert > NS_ALERT_RESEND_MS) {
        await notifyDomain(request, 'domain_ns_lost', d.name);
      }
    }
  }
}

export async function onRequestPost({ env, request, waitUntil }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_json' }, { status: 400 }); }
  const name = (body.name || '').trim().toLowerCase();
  if (!isValidDomain(name)) return Response.json({ ok: false, error: 'invalid_domain' }, { status: 400 });

  await ensureAccountColumn(env.DB);
  await ensureDomainExtraCols(env.DB);
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

  // ===== KEAMANAN: OTP hanya saat pola tambah domain tidak wajar =====
  // Normalnya tambah domain TIDAK minta OTP. OTP diminta bila >= BURST_24H domain
  // ditambahkan dalam 24 jam terakhir (indikasi akun dipakai pihak lain / bot).
  // Setelah OTP sukses, akun bebas OTP selama 1 jam.
  let recentCount = 0;
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM domains WHERE account = ? AND CAST(strftime('%s', created_at) AS INTEGER) > CAST(strftime('%s','now') AS INTEGER) - 86400").bind(account.id).first();
    recentCount = (r && r.c) || 0;
  } catch (e) {}
  const burst = recentCount >= BURST_24H;
  let grace = false;
  if (burst) grace = await otpGraceActive(env, account);

  if (burst && !grace) {
    if (body.otp) {
      const v = await verifyOtp(env, account, String(body.otp || ''));
      if (!v.ok) return Response.json({ ok: false, otp_required: true, error: v.reason, message: v.message }, { status: 400 });
      await markOtpVerified(env, account);
      const row = await insertDomain(env, account, name, body.note || '');
      // Tambah domain lewat jalur OTP = aktivitas sensitif -> email konfirmasi.
      fire(notifyDomain(request, 'domain_added', name, { otp_used: true }), waitUntil);
      return Response.json({ ok: true, exists: false, domain: row, otp_used: true });
    }
    const res = await issueOtp(env, request, account, waitUntil);
    return Response.json(res.body, { status: res.status });
  }

  const row = await insertDomain(env, account, name, body.note || '');
  // Tambah domain normal: cukup notifikasi in-app (senyap, tanpa email) biar tidak berisik.
  fire(notifyDomain(request, 'domain_added', name, { email: false }), waitUntil);
  return Response.json({ ok: true, exists: false, domain: row });
}

async function insertDomain(env, account, name, note) {
  const row = { id: makeId(), name, token: makeToken(), status: 'pending', note: note || '', created_at: new Date().toISOString(), verified_at: null, updated_at: new Date().toISOString() };
  await env.DB.prepare('INSERT INTO domains (id, name, token, status, note, created_at, verified_at, updated_at, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.name, row.token, row.status, row.note, row.created_at, null, row.updated_at, account.id).run();
  return row;
}
