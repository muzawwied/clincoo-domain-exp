export async function onRequestGet() {
  return Response.json({ ok: true, service: 'clincoo-domain', time: new Date().toISOString() });
}
