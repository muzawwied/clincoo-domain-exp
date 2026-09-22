export async function onRequestDelete({ env, params }) {
  const name = decodeURIComponent(params.name || '').toLowerCase();
  const rid = params.rid || '';
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
  return Response.json({ ok: true });
}
