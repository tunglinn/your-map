# your-map

A personal, lightweight Google Maps replacement: Youbike stations, POIs, and
A→B navigation. No build step — one plain script file (`src/app.js`, no ES
modules/import maps), served as static files. Built for and tested against an
iPhone 6 (capped at iOS 12.5.7 / Safari 12), which is why the stack skips
anything newer than that: no import maps, no flexbox `gap`, no optional
chaining, no WebGL (Leaflet + raster tiles instead of a vector renderer).

## Run locally

```
npx serve .
```

(or any static file server — `python3 -m http.server`, etc.) then open the
printed URL. Geolocation requires HTTPS or `localhost`.

## Deploy (Cloudflare Pages, no CLI needed)

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git →
   pick this repo.
3. Framework preset: **None**. Build command: *(leave empty)*. Build output
   directory: `/`.
4. Deploy. Every push to `main` auto-deploys — no wrangler/CLI login needed.
5. On your iPhone, open the Pages URL in Safari → Share → **Add to Home Screen**.

## Deploy the Overpass proxy Worker (needed for POI search to work)

Calling `overpass-api.de` directly from the browser gets blocked (HTTP 406,
no CORS header — confirmed via real browser devtools). `worker/overpass-proxy.js`
fetches Overpass server-to-server instead, where CORS doesn't apply, and adds
a short edge cache along the way. (Rail stations and bus stops don't need
this anymore — see `data/README.md`, they're pre-baked static files now.)

1. Cloudflare dashboard → Workers & Pages → Create → **Worker**.
2. Open the Quick Edit code editor, replace its contents with
   `worker/overpass-proxy.js`, Deploy.
3. Tell Claude the resulting `*.workers.dev` URL — `OVERPASS_URL` in
   `src/app.js` is currently a placeholder pointing nowhere real.

## What's implemented

- Worldwide basemap: raster tiles from [OpenStreetMap's own tile server](https://tile.openstreetmap.org) via Leaflet (free, no key, no self-hosting, no WebGL). CARTO's free tiles used to work here too but now require a signed-up API key — switched off that.
- Youbike stations (live, Taipei) — official city feed, fetched directly (CORS-enabled), refreshed on load. Marker is a small square 🚲 badge whose color is the availability signal (green/amber/red); shrinks to a plain dot below zoom 16 to stay calm when zoomed out. Same dot/badge treatment for metro (🚇). Square badges vs. the round search-result pin is deliberate — square marks a category/ambient layer, round marks something you picked/searched.
- POI search (amenity/shop, name match) — on-demand only, via the search bar. Used to auto-query Overpass on every map pan/zoom; that hammered Overpass with a fresh request on every small pan and contributed to its flakiness, so it's now search-triggered instead.
- Bus stops (~9,400 across Taipei + New Taipei) and rail/MRT stations (~180) — pre-baked static files (`data/*.json`, see `data/README.md`), fetched once on load, filtered/rendered from memory from then on. No live Overpass dependency for these two, so none of Overpass's flakiness affects them, and it's lighter on battery than a live query on every pan/zoom. Bus stops still only render above zoom 16 (rendering cost, not network cost, at this point); rail stations show always (small enough dataset).
- Tap a marker → set as route start/end, or save to favorites (stored in IndexedDB, on-device only).
- Routing via OSRM. **Currently points at the public demo server with the `driving` profile as a placeholder** (see `src/app.js`) — it gets routing working end-to-end today, but doesn't know about bike safety and isn't meant to stay pointed there.
- Favorite-to-favorite routes are cached in IndexedDB after the first lookup, so navigating between two saved favorites works offline afterward.

## Next step: self-hosted bike-safe routing

The real routing engine — with a custom OSRM bicycle profile that prefers small/residential streets over primary roads — needs a small server, since no free hosted "route anywhere" API exists. `infra/setup-osrm.sh` provisions this on a DigitalOcean droplet. To move to this:

1. Create a DigitalOcean droplet: Ubuntu 24.04, cheapest plan (1GB is enough for a Taiwan-sized extract), any region.
2. SSH in and run `infra/setup-osrm.sh` (see comments inside for the manual steps if you'd rather run them yourself).
3. Point it at a domain via Cloudflare (either proxy the droplet's IP through Cloudflare DNS, or use a Cloudflare Tunnel to avoid opening any ports).
4. In `src/app.js`, change `OSRM_BASE_URL` to your domain and `OSRM_PROFILE` to `'bike'`.

Let me know once the droplet exists (or if you'd rather I walk you through creating it) and I'll wire it up.
