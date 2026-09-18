// Cloudflare Worker: proxies Overpass API requests server-to-server.
//
// Why this exists: the browser calling https://overpass-api.de directly was
// getting HTTP 406 with no Access-Control-Allow-Origin header - confirmed via
// a real browser's devtools, not just this project's sandbox. Since CORS only
// applies to browser requests, a Worker fetching Overpass itself sidesteps
// whatever origin/policy issue was causing that, and gives us a debugging
// channel we can actually see (Cloudflare dashboard Worker logs) instead of
// only whatever a client happens to paste back.
//
// Deploy via the Cloudflare dashboard (no build step, no wrangler needed):
// Workers & Pages -> Create -> Worker -> paste this file's contents into the
// Quick Edit editor -> Deploy. Then tell Claude the resulting *.workers.dev
// URL so OVERPASS_URL in src/app.js can be pointed at it.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const data = url.searchParams.get('data');
    if (!data) {
      return new Response('Missing "data" query param', { status: 400, headers: CORS_HEADERS });
    }

    const overpassUrl = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(data);
    // Short edge cache: repeated identical queries (e.g. the fixed transit
    // bbox) get served from Cloudflare instead of hitting Overpass again.
    const res = await fetch(overpassUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: Object.assign(
        { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
        CORS_HEADERS
      ),
    });
  },
};
