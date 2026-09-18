# Static data

`transit-stations.json` and `bus-stops.json` are pre-baked snapshots from
Overpass (OpenStreetMap), not live queries — see the comment above
`loadStaticLayer` in `src/app.js` for why.

- `bus-stops.json`: `[id, lat, lon, name, extraLabel]`.
- `transit-stations.json`: `[id, lat, lon, name, extraLabel, colors]`, where
  `colors` is an array of hex colors — one per MRT/LRT line the station
  serves. A plain rail/TRA/THSR station with no matched line has a single
  fallback color (`#9c7aa8`). `src/app.js`'s `renderTransit()` draws a solid
  badge for one color, vertical stripes for 2+ (interchange stations).

Regenerate when a station/stop is added, moved, or renamed (rare — maybe
once a year for MRT).

**If `overpass-api.de` is unreachable directly** (this has happened - not
just the occasional 406/flakiness noted below, but a hard connection
refusal from whatever network you're running this from, likely from
sending it too many requests in a short window during development): route
the same query through the deployed Worker instead, which hits Overpass
from Cloudflare's network rather than yours -
`https://overpass-proxy.tunglin.workers.dev/?data=<query>` (GET, no
User-Agent header needed - the Worker sets one). If that also doesn't work,
other public Overpass mirrors exist (e.g. `overpass.kumi.systems`) as a
further fallback before giving up on Overpass entirely - GitHub datasets
that looked promising in practice (`leoluyi/taipei_mrt`,
`AtkinsChang/taipei-mrt-station-data`) turned out to have no color/line
data at all, and TDX's GTFS static mirror needs OAuth registration, so
Overpass (via whichever path reaches it) is still the most practical
source for now.

`overpass-api.de` also has an unexplained block on some User-Agent strings
even when reachable (see git log around the Cloudflare Worker changes) -
the `-H "User-Agent: ..."` below works around it when querying directly.

```bash
UA="your-map-personal-project/1.0"
BASE="https://overpass-api.de/api/interpreter"
# Or, if overpass-api.de is unreachable directly:
# BASE="https://overpass-proxy.tunglin.workers.dev"

# Rail / MRT / TRA / THSR station nodes
Q='[out:json][timeout:25];(node["railway"="station"](24.95,121.35,25.25,121.75);node["railway"="halt"](24.95,121.35,25.25,121.75);node["public_transport"="station"]["subway"="yes"](24.95,121.35,25.25,121.75););out body 300;'
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")
curl -s -H "User-Agent: $UA" "$BASE?data=$ENCODED" -o rail_raw.json

# Subway + light_rail route relations - these carry the per-line "colour"
# tag and list their stations as members (role stop/stop_entry_only/
# stop_exit_only). This is how transit-stations.json's colors are built.
Q='[out:json][timeout:60];relation["route"="subway"](24.95,121.35,25.25,121.75);out body;'
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")
curl -s -H "User-Agent: $UA" "$BASE?data=$ENCODED" -o routes_raw.json

Q='[out:json][timeout:60];relation["route"="light_rail"](24.95,121.35,25.25,121.75);out body;'
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")
curl -s -H "User-Agent: $UA" "$BASE?data=$ENCODED" -o routes_lr_raw.json

# Bus stops
Q='[out:json][timeout:25];node["highway"="bus_stop"](24.95,121.35,25.25,121.75);out body 10000;'
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")
curl -s -H "User-Agent: $UA" "$BASE?data=$ENCODED" -o bus_raw.json
```

Then convert to the compact format:

```python
import json

FALLBACK_COLOR = '#9c7aa8'
STOP_ROLES = {'stop', 'stop_entry_only', 'stop_exit_only'}

routes = json.load(open('routes_raw.json'))['elements']
routes += json.load(open('routes_lr_raw.json'))['elements']

station_colors = {}  # node id -> set of hex colors
for rel in routes:
    colour = rel.get('tags', {}).get('colour')
    if not colour:
        continue
    for m in rel.get('members', []):
        if m.get('type') == 'node' and m.get('role') in STOP_ROLES:
            station_colors.setdefault(m['ref'], set()).add(colour.upper())

rail = json.load(open('rail_raw.json'))['elements']
out = []
for e in rail:
    tags = e.get('tags', {})
    name = tags.get('name')
    if not name:
        continue
    colors = sorted(station_colors.get(e['id'], [])) or [FALLBACK_COLOR]
    network = tags.get('network') or ('MRT station' if tags.get('station') == 'subway' else 'Rail station')
    out.append(['rail-' + str(e['id']), round(e['lat'], 6), round(e['lon'], 6), name, network, colors])

json.dump(out, open('transit-stations.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

def compact_bus(path):
    d = json.load(open(path))
    out = []
    for e in d['elements']:
        tags = e.get('tags', {})
        if not tags.get('name'):
            continue
        out.append(['poi-' + str(e['id']), round(e['lat'], 6), round(e['lon'], 6), tags['name'], 'Bus stop'])
    return out

json.dump(compact_bus('bus_raw.json'), open('bus-stops.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
```

Known gap: New Taipei Metro's Circular Line wasn't captured by the
`route=subway`/`route=light_rail` queries above (its relation(s) weren't
found in the results this was generated from) - those stations, along with
plain TRA/THSR stations, fall back to the neutral color rather than a real
line color. About 105 of 183 stations got a real line color as of when
this was last generated; worth re-checking if that matters more later.

Both bboxes are the same as `TRANSIT_BBOX` was in `src/app.js` (Taipei
Metro + New Taipei service area): `24.95,121.35,25.25,121.75`.
