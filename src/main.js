import maplibregl from 'maplibre-gl';
import { loadYoubikeGeoJSON, addYoubikeLayer } from './youbike.js';
import { addPoiLayer, wirePoiRefresh } from './poi.js';
import { getRoute, addRouteLayer, drawRoute, clearRoute } from './routing.js';
import { addFavorite, listFavorites, removeFavorite, cacheRoute, getCachedRoute } from './favorites.js';

const TAIPEI_CENTER = [121.5654, 25.0330];

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: TAIPEI_CENTER,
  zoom: 15,
});

const panel = document.getElementById('panel');
const panelContent = document.getElementById('panelContent');
document.getElementById('closePanel').onclick = () => panel.classList.remove('open');

function showPanel(html) {
  panelContent.innerHTML = html;
  panel.classList.add('open');
}

// route endpoints currently selected: { id, name, coords: [lon, lat] }
const state = { start: null, end: null };

async function maybeRoute() {
  if (!state.start || !state.end) return;
  const cached = await getCachedRoute(state.start.id, state.end.id).catch(() => null);
  if (cached) {
    drawRoute(map, cached.geometry);
    renderRouteInfo(cached, true);
    return;
  }
  try {
    const route = await getRoute(state.start.coords, state.end.coords);
    drawRoute(map, route.geometry);
    renderRouteInfo(route, false);
    if (state.start.id && state.end.id) {
      await cacheRoute(state.start.id, state.end.id, route);
    }
  } catch (err) {
    showPanel(`<p>Routing failed: ${err.message}</p>`);
  }
}

function renderRouteInfo(route, fromCache) {
  const km = (route.distanceMeters / 1000).toFixed(1);
  const min = Math.round(route.durationSeconds / 60);
  showPanel(`
    <h3>${state.start.name} → ${state.end.name}</h3>
    <p>${km} km · ${min} min ${fromCache ? '(cached, offline-ready)' : ''}</p>
    <button id="clearRouteBtn">Clear route</button>
  `);
  document.getElementById('clearRouteBtn').onclick = () => {
    state.start = null;
    state.end = null;
    clearRoute(map);
    panel.classList.remove('open');
  };
}

function selectFeature(props, coords) {
  const feature = { id: props.id, name: props.name, coords };
  showPanel(`
    <h3>${props.name}</h3>
    ${props.bikes !== undefined ? `<p>🚲 ${props.bikes} bikes · 🅿️ ${props.docks} docks</p>` : ''}
    ${props.kind ? `<p>${props.kind}</p>` : ''}
    <button id="setStart">Set as start</button>
    <button id="setEnd">Set as end</button>
    <button id="saveFav">★ Save</button>
  `);
  document.getElementById('setStart').onclick = () => { state.start = feature; maybeRoute(); };
  document.getElementById('setEnd').onclick = () => { state.end = feature; maybeRoute(); };
  document.getElementById('saveFav').onclick = async () => {
    await addFavorite(feature);
    showPanel(`<p>Saved "${props.name}" to favorites.</p>`);
  };
}

async function renderFavorites() {
  const favs = await listFavorites();
  if (favs.length === 0) {
    showPanel('<p>No favorites yet. Tap a place on the map and hit ★ Save.</p>');
    return;
  }
  showPanel(`
    <h3>Favorites</h3>
    ${favs.map((f) => `
      <div class="fav-item">
        ${f.name}
        <button data-act="start" data-id="${f.id}">Start</button>
        <button data-act="end" data-id="${f.id}">End</button>
        <button data-act="del" data-id="${f.id}">🗑</button>
      </div>
    `).join('')}
  `);
  panelContent.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const fav = favs.find((f) => f.id === btn.dataset.id);
      if (btn.dataset.act === 'start') { state.start = fav; maybeRoute(); }
      if (btn.dataset.act === 'end') { state.end = fav; maybeRoute(); }
      if (btn.dataset.act === 'del') { await removeFavorite(fav.id); renderFavorites(); }
    };
  });
}

document.getElementById('favBtn').onclick = renderFavorites;

document.getElementById('locateBtn').onclick = () => {
  navigator.geolocation.getCurrentPosition((pos) => {
    const coords = [pos.coords.longitude, pos.coords.latitude];
    map.flyTo({ center: coords, zoom: 16 });
    state.start = { id: null, name: 'Current location', coords };
  }, (err) => showPanel(`<p>Location failed: ${err.message}</p>`));
};

map.on('load', async () => {
  addRouteLayer(map);
  addPoiLayer(map);
  wirePoiRefresh(map, (err) => console.warn('POI refresh failed', err));

  try {
    const youbikeData = await loadYoubikeGeoJSON();
    addYoubikeLayer(map, youbikeData);
  } catch (err) {
    console.warn('Youbike load failed', err);
  }

  map.on('click', 'youbike-points', (e) => {
    const f = e.features[0];
    selectFeature(f.properties, f.geometry.coordinates);
  });
  map.on('click', 'poi-points', (e) => {
    const f = e.features[0];
    selectFeature(f.properties, f.geometry.coordinates);
  });
  ['youbike-points', 'poi-points'].forEach((layer) => {
    map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
  });
});
