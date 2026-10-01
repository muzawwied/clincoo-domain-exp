// CORS untuk /api/* — izinkan halaman Clincoo (GitHub Pages) memakai API ini lintas-origin.
// Origin https://muzawwied.github.io mencakup aplikasi utama (/) dan situs exp (/clincoo-domain-exp/).
const ALLOWED_ORIGINS = ['https://muzawwied.github.io'];

function corsHeaders(origin) {
  const h = new Headers();
  if (ALLOWED_ORIGINS.includes(origin)) h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return h;
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function onRequest(context) {
  const response = await context.next();
  const origin = context.request.headers.get('Origin') || '';
  const h = new Headers(response.headers);
  if (ALLOWED_ORIGINS.includes(origin)) h.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, headers: h });
}
