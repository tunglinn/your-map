// Public Overpass API — free, global, CORS-enabled. Only query when zoomed in
// enough that the bbox is small (old phone: fewer markers, smaller payload).
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const MIN_ZOOM = 16;

function buildQuery(bbox) {
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:15];(
    node["amenity"](${s},${w},${n},${e});
    node["shop"](${s},${w},${n},${e});
  );out body 100;`;
}

export async function queryPois(bbox) {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(buildQuery(bbox)),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = await res.json();
  return {
    type: 'FeatureCollection',
    features: data.elements
      .filter((el) => el.tags && el.tags.name)
      .map((el) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
        properties: {
          id: `poi-${el.id}`,
          name: el.tags.name,
          kind: el.tags.amenity || el.tags.shop || 'poi',
        },
      })),
  };
}

export function addPoiLayer(map) {
  map.addSource('pois', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'poi-points',
    type: 'circle',
    source: 'pois',
    minzoom: MIN_ZOOM,
    paint: {
      'circle-radius': 4,
      'circle-color': '#1971c2',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#fff',
    },
  });
}

export function wirePoiRefresh(map, onError) {
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (map.getZoom() < MIN_ZOOM) {
        map.getSource('pois').setData({ type: 'FeatureCollection', features: [] });
        return;
      }
      const b = map.getBounds();
      try {
        const geojson = await queryPois([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
        map.getSource('pois').setData(geojson);
      } catch (err) {
        onError?.(err);
      }
    }, 600);
  };
  map.on('moveend', refresh);
  return refresh;
}
