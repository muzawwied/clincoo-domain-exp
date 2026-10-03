import { requireAccount, ensureAccountColumn } from '../../../../shared/account.js';
import { ensureZone } from '../../../../shared/cloudflare.js';

// PENYIMPANAN LOKAL (D1) — fallback bila zona domain TIDAK bisa dikelola lewat
// Cloudflare Clincoo (mis. domain sudah terdaftar di akun Cloudflare lain, atau
// ditolak Cloudflare). Record tetap bisa disimpan & dikelola di halaman ini —
// user tinggal menyalinnya ke penyedia DNS domain-mu. Jadi fitur domain tidak
// "ngandelin" domain harus terdaftar di Cloudflare dulu.
async function ensureLocalDns(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS domain_dns_records (
    id TEXT PRIMARY KEY, domain TEXT, type TEXT, name TEXT, content TEXT,
    ttl INTEGER, proxied INTEGER, priority INTEGER, created_at TEXT)`).run();
}
function localId() { return 'loc' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function listLocal(env, name) {
  const { results } = await env.DB.prepare('SELECT id, type, name, content, ttl, proxied, priority, created_at FROM domain_dns_records WHERE domain = ? ORDER BY created_at').bind(name).all();
  return (results || []).map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: !!r.proxied, priority: r.priority, local: true }));
}
const LOCAL_NOTE = 'Domain ini tidak dikelola lewat jaringan Clincoo (mis. sudah terdaftar di layanan DNS lain). Record yang kamu simpan di sini tetap tersimpan di Clincoo — salin juga record berikut ke penyedia DNS domain-mu agar aktif.';

async function owned(env, account, name) {
  await ensureAccountColumn(env.DB);
  return await env.DB.prepare('SELECT id FROM domains WHERE account = ? AND name = ?').bind(account.id, name).first();
}

async function zoneStatus(zid, token) {
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + encodeURIComponent(zid),
      { headers: { Authorization: 'Bearer ' + token }, cf: { cacheTtl: 0 } });
    const data = await res.json();
    return (data.success && data.result) ? (data.result.status || 'pending') : 'pending';
  } catch (e) { return 'pending'; }
}

export async function onRequestGet({ env, request, params }) {
  const { account, error } = await requireAccount(request);
  if (error) return error;
  const name = decodeURIComponent(params.name || '').toLowerCase();
  if (!await owned(env, account, name)) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  await ensureLocalDns(env.DB);
  const localRecords = await listLocal(env, name);
  if (!env.CF_API_TOKEN) return Response.json({ ok: true, managed: false, records: localRecords, message: LOCAL_NOTE });

  // Zona dibuat otomatis di akun Cloudflare Clincoo bila belum ada — pelanggan tak perlu
  // menambahkannya sendiri lewat dashboard Cloudflare dulu. BILA GAGAL (domain dipakai
  // akun lain/ditolak), jatuh ke penyimpanan lokal — halaman tetap bisa dipakai.
  const zone = await ensureZone(name, env.CF_API_TOKEN);
  if (zone.error) return Response.json({ ok: true, managed: false, records: localRecords, message: LOCAL_NOTE });
  const zid = zone.id;

  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + zid + '/dns_records?per_page=100',
    { headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN } });
  const data = await res.json();
  if (!data.success) return Response.json({ ok: true, managed: false, records: localRecords, message: LOCAL_NOTE });
  const records = (data.result || []).map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied }));
  const zstatus = await zoneStatus(zid, env.CF_API_TOKEN);
  return Response.json({ ok: true, managed: true, zone_id: zid, zone_status: zstatus, records, local_records: localRecords });
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
  await ensureLocalDns(env.DB);

  const saveLocal = async () => {
    const rec = {
      id: localId(), type, name: rname, content,
      ttl: parseInt(body.ttl) > 0 ? parseInt(body.ttl) : 1,
      proxied: ['A', 'AAAA', 'CNAME'].includes(type) ? body.proxied === true : false,
      priority: type === 'MX' ? (parseInt(body.priority) > 0 ? parseInt(body.priority) : 10) : null
    };
    await env.DB.prepare('INSERT INTO domain_dns_records (id, domain, type, name, content, ttl, proxied, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(rec.id, name, rec.type, rec.name, rec.content, rec.ttl, rec.proxied ? 1 : 0, rec.priority, new Date().toISOString()).run();
    return Response.json({ ok: true, managed: false, record: Object.assign({ local: true }, rec), message: LOCAL_NOTE });
  };

  if (!env.CF_API_TOKEN) return saveLocal();
  const zone = await ensureZone(name, env.CF_API_TOKEN);
  if (zone.error) return saveLocal();
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
  if (!data.success) {
    // Record Cloudflare ditolak (mis. CNAME root dsb.) -> simpan lokal supaya
    // user tetap bisa mencatat record & menerapkannya di penyedia DNS-mu.
    return saveLocal();
  }
  const r = data.result;
  await env.DB.prepare('UPDATE domains SET updated_at = ? WHERE account = ? AND name = ?').bind(new Date().toISOString(), account.id, name).run();
  return Response.json({ ok: true, record: { id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied } });
}
