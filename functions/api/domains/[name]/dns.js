async function zoneId(name, token) {
  const res = await fetch('https://api.cloudflare.com/client/v4/zones?name=' + encodeURIComponent(name) + '&per_page=1',
    { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!data.success || !data.result || !data.result.length) return null;
  return data.result[0].id;
}

export async function onRequestGet({ env, params }) {
  const name = decodeURIComponent(params.name || '').toLowerCase();
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });
  const zid = await zoneId(name, env.CF_API_TOKEN);
  if (!zid) return Response.json({ ok: false, error: 'zone_not_found', message: 'Domain ini belum berada di akun Cloudflare-mu.' });
  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + zid + '/dns_records?per_page=100',
    { headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN } });
  const data = await res.json();
  if (!data.success) return Response.json({ ok: false, error: 'cf_error', message: (data.errors || []).map(e => e.message).join('; ') }, { status: 502 });
  const records = (data.result || []).map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied }));
  return Response.json({ ok: true, zone_id: zid, records });
}

export async function onRequestPost({ env, params, request }) {
  const name = decodeURIComponent(params.name || '').toLowerCase();
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: 'bad_json' }, { status: 400 }); }
  const type = (body.type || '').toUpperCase();
  if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX'].includes(type)) return Response.json({ ok: false, error: 'invalid_type' }, { status: 400 });
  const rname = (body.name || '').trim();
  const content = (body.content || '').trim();
  if (!rname || !content) return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  if (!env.CF_API_TOKEN) return Response.json({ ok: false, error: 'no_token' }, { status: 500 });

  const zid = await zoneId(name, env.CF_API_TOKEN);
  if (!zid) return Response.json({ ok: false, error: 'zone_not_found', message: 'Domain ini belum berada di akun Cloudflare-mu.' }, { status: 404 });

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
  return Response.json({ ok: true, record: { id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied } });
}
