# Static data

`transit-stations.json` and `bus-stops.json` are pre-baked snapshots from
Overpass (OpenStreetMap), not live queries — see the comment above
`loadStaticLayer` in `src/app.js` for why. Both are a flat array of
`[id, lat, lon, name, extraLabel]` records (not GeoJSON) to keep the files
small.

Regenerate when a station/stop is added, moved, or renamed (rare — maybe
once a year for MRT). `overpass-api.de` has an unexplained block on some
User-Agent strings (see git log around the Cloudflare Worker changes) — the
`-H "User-Agent: ..."` below works around it, and Overpass is also
intermittently flaky regardless (retry a few times on failure).

```bash
UA="your-map-personal-project/1.0"
BASE="https://overpass-api.de/api/interpreter"

# Rail / MRT stations
Q='[out:json][timeout:25];(node["railway"="station"](24.95,121.35,25.25,121.75);node["railway"="halt"](24.95,121.35,25.25,121.75);node["public_transport"="station"]["subway"="yes"](24.95,121.35,25.25,121.75););out body 300;'
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")
curl -s -H "User-Agent: $UA" "$BASE?data=$ENCODED" -o rail_raw.json

# Bus stops
Q='[out:json][timeout:25];node["highway"="bus_stop"](24.95,121.35,25.25,121.75);out body 10000;'
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")
curl -s -H "User-Agent: $UA" "$BASE?data=$ENCODED" -o bus_raw.json
```

Then convert to the compact format:

```python
import json

def compact(path, id_prefix, network_fallback=None):
    d = json.load(open(path))
    out = []
    for e in d['elements']:
        tags = e.get('tags', {})
        name = tags.get('name')
        if not name:
            continue
        extra = tags.get('network') or network_fallback or 'poi'
        out.append([id_prefix + str(e['id']), round(e['lat'], 6), round(e['lon'], 6), name, extra])
    return out

rail = compact('rail_raw.json', 'rail-', 'MRT station')
bus = compact('bus_raw.json', 'poi-', 'Bus stop')

json.dump(rail, open('transit-stations.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump(bus, open('bus-stops.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
```

Both bboxes are the same as `TRANSIT_BBOX` was in `src/app.js` (Taipei
Metro + New Taipei service area): `24.95,121.35,25.25,121.75`.
