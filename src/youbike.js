// Official Taipei Youbike 2.0 real-time feed. Confirmed CORS: Access-Control-Allow-Origin: *
// (city-wide file, ~1300 stations, ~1MB — fine for a single personal fetch)
const YOUBIKE_URL = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json';

export async function loadYoubikeGeoJSON() {
  const res = await fetch(YOUBIKE_URL);
  const stations = await res.json();
  return {
    type: 'FeatureCollection',
    features: stations
      .filter((s) => s.act === '1')
      .map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
        properties: {
          id: `youbike-${s.sno}`,
          name: s.sna.replace(/^YouBike2\.0_/, ''),
          bikes: s.available_rent_bikes,
          docks: s.available_return_bikes,
          total: s.Quantity,
          updated: s.updateTime,
        },
      })),
  };
}

export function addYoubikeLayer(map, geojson) {
  map.addSource('youbike', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'youbike-points',
    type: 'circle',
    source: 'youbike',
    minzoom: 13,
    paint: {
      'circle-radius': 5,
      'circle-color': [
        'interpolate', ['linear'], ['get', 'bikes'],
        0, '#d9480f',
        3, '#f08c00',
        8, '#2b8a3e',
      ],
      'circle-stroke-width': 1,
      'circle-stroke-color': '#fff',
    },
  });
}
