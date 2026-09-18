// ponytail: OSRM_BASE_URL points at the public demo server with the "driving"
// profile as a placeholder so routing works end-to-end today. It does NOT
// know about bike safety (no small-street preference) and isn't meant for
// real use long-term. Swap to the self-hosted Taiwan OSRM (infra/setup-osrm.sh)
// once the droplet is up, and change PROFILE to 'cycling' — no other code changes.
const OSRM_BASE_URL = 'https://router.project-osrm.org';
const PROFILE = 'driving';

export async function getRoute([lon1, lat1], [lon2, lat2]) {
  const url = `${OSRM_BASE_URL}/route/v1/${PROFILE}/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error(data.message || data.code);
  const route = data.routes[0];
  return {
    geometry: route.geometry, // GeoJSON LineString
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    steps: route.legs[0].steps.map((s) => s.name || s.maneuver.type),
  };
}

export function addRouteLayer(map) {
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    paint: { 'line-color': '#2b8a3e', 'line-width': 4 },
  });
}

export function drawRoute(map, geometry) {
  map.getSource('route').setData({ type: 'Feature', geometry, properties: {} });
}

export function clearRoute(map) {
  map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
}
