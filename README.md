# your-map

A personal, lightweight Google Maps replacement: Youbike stations, POIs, and
A→B navigation. No build step — plain HTML/JS with native ES modules, served
as static files.

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

## What's implemented

- Worldwide basemap via [OpenFreeMap](https://openfreemap.org) (free, no key, no self-hosting).
- Youbike stations (live, Taipei) — official city feed, fetched directly (CORS-enabled), refreshed on load.
- POIs (amenity/shop) via the public Overpass API, refreshed on map move, only above zoom 16 to keep marker count low on an older phone.
- Tap a marker → set as route start/end, or save to favorites (stored in IndexedDB, on-device only).
- Routing via OSRM. **Currently points at the public demo server with the `driving` profile as a placeholder** (see `src/routing.js`) — it gets routing working end-to-end today, but doesn't know about bike safety and isn't meant to stay pointed there.
- Favorite-to-favorite routes are cached in IndexedDB after the first lookup, so navigating between two saved favorites works offline afterward.

## Next step: self-hosted bike-safe routing

The real routing engine — with a custom OSRM bicycle profile that prefers small/residential streets over primary roads — needs a small server, since no free hosted "route anywhere" API exists. `infra/setup-osrm.sh` provisions this on a DigitalOcean droplet. To move to this:

1. Create a DigitalOcean droplet: Ubuntu 24.04, cheapest plan (1GB is enough for a Taiwan-sized extract), any region.
2. SSH in and run `infra/setup-osrm.sh` (see comments inside for the manual steps if you'd rather run them yourself).
3. Point it at a domain via Cloudflare (either proxy the droplet's IP through Cloudflare DNS, or use a Cloudflare Tunnel to avoid opening any ports).
4. In `src/routing.js`, change `OSRM_BASE_URL` to your domain and `PROFILE` to `'bike'`.

Let me know once the droplet exists (or if you'd rather I walk you through creating it) and I'll wire it up.
