// Pemeriksaan nameserver publik domain — dipakai sweep berkala (GET /api/domains)
// untuk mendeteksi domain aktif yang "lepas" dari Cloudflare.
export async function nsPointsToCloudflare(name, assigned) {
  let nsList = [];
  try {
    const [cfNs, gNs] = await Promise.all([
      fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=NS', { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } }).then(r => r.json()).catch(() => ({})),
      fetch('https://dns.google/resolve?name=' + encodeURIComponent(name) + '&type=NS', { headers: { accept: 'application/dns-json' }, cf: { cacheTtl: 0 } }).then(r => r.json()).catch(() => ({}))
    ]);
    nsList = ((cfNs && cfNs.Answer) || []).concat((gNs && gNs.Answer) || [])
      .map(a => String(a.data || '').toLowerCase().replace(/\.$/, ''));
  } catch (e) { return false; }
  if (!nsList.length) return false;
  let assignedList = [];
  try { assignedList = (assigned || []).map(n => String(n).toLowerCase()); } catch (e) {}
  if (assignedList.length >= 2) {
    return assignedList.every(ns => nsList.includes(ns));
  }
  return nsList.some(ns => ns.endsWith('.ns.cloudflare.com'));
}
