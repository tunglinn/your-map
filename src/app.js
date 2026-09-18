// Single plain script, no ES modules / import maps — iPhone 6 tops out at iOS 12.5.7
// (Safari 12), which predates import maps (Safari 16.4+) and can't be assumed to
// parse modern library bundles. Leaflet + raster tiles avoids WebGL entirely too,
// which matters on decade-old hardware. Keep this file ES5-friendly: no optional
// chaining (?.), no nullish coalescing (??), no class fields.
(function () {
  'use strict';

  var TAIPEI_CENTER = [25.0330, 121.5654]; // Leaflet uses [lat, lon]
  var YOUBIKE_URL = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json';
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  var POI_MIN_ZOOM = 16;
  // ponytail: public OSRM demo, driving profile — placeholder to get routing
  // working end-to-end. No bike-safety weighting yet. Swap once the self-hosted
  // Taiwan OSRM (infra/setup-osrm.sh) is up: change these two constants only.
  var OSRM_BASE_URL = 'https://router.project-osrm.org';
  var OSRM_PROFILE = 'driving';

  var map = L.map('map').setView(TAIPEI_CENTER, 15);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }).addTo(map);

  var poiLayer = L.layerGroup().addTo(map);
  var youbikeLayer = L.layerGroup().addTo(map);
  var routeLayer = null;

  var panel = document.getElementById('panel');
  var panelContent = document.getElementById('panelContent');
  document.getElementById('closePanel').onclick = function () {
    panel.classList.remove('open');
  };
  function showPanel(html) {
    panelContent.innerHTML = html;
    panel.classList.add('open');
  }

  // ---------- IndexedDB: favorites + cached routes ----------
  var DB_NAME = 'your-map';
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('favorites')) db.createObjectStore('favorites', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('routes')) db.createObjectStore('routes', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function storeOp(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var store = db.transaction(storeName, mode).objectStore(storeName);
        var req = fn(store);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function addFavorite(fav) { return storeOp('favorites', 'readwrite', function (s) { return s.put(fav); }); }
  function listFavorites() { return storeOp('favorites', 'readonly', function (s) { return s.getAll(); }); }
  function removeFavorite(id) { return storeOp('favorites', 'readwrite', function (s) { return s.delete(id); }); }
  function routeKey(a, b) { return [a, b].sort().join('|'); }
  function cacheRoute(fromId, toId, route) {
    return storeOp('routes', 'readwrite', function (s) {
      return s.put({ key: routeKey(fromId, toId), route: route, cachedAt: Date.now() });
    });
  }
  function getCachedRoute(fromId, toId) {
    return storeOp('routes', 'readonly', function (s) { return s.get(routeKey(fromId, toId)); })
      .then(function (rec) { return rec ? rec.route : null; });
  }

  // ---------- Youbike ----------
  function loadYoubike() {
    fetch(YOUBIKE_URL)
      .then(function (res) { return res.json(); })
      .then(function (stations) {
        youbikeLayer.clearLayers();
        stations.forEach(function (s) {
          if (s.act !== '1') return;
          var color = s.available_rent_bikes >= 8 ? '#2b8a3e' : s.available_rent_bikes >= 3 ? '#f08c00' : '#d9480f';
          var marker = L.circleMarker([s.latitude, s.longitude], {
            radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9,
          }).addTo(youbikeLayer);
          marker.on('click', function () {
            selectFeature({
              id: 'youbike-' + s.sno,
              name: s.sna.replace(/^YouBike2\.0_/, ''),
              extra: '🚲 ' + s.available_rent_bikes + ' bikes · 🅿️ ' + s.available_return_bikes + ' docks',
            }, [s.latitude, s.longitude]);
          });
        });
      })
      .catch(function (err) { console.warn('Youbike load failed', err); });
  }

  // ---------- POIs ----------
  function overpassQuery(bbox) {
    var q = '[out:json][timeout:15];(' +
      'node["amenity"](' + bbox.join(',') + ');' +
      'node["shop"](' + bbox.join(',') + ');' +
      ');out body 100;';
    return fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(q) })
      .then(function (res) {
        if (!res.ok) throw new Error('Overpass ' + res.status);
        return res.json();
      });
  }
  var poiTimer = null;
  function refreshPois() {
    clearTimeout(poiTimer);
    poiTimer = setTimeout(function () {
      if (map.getZoom() < POI_MIN_ZOOM) { poiLayer.clearLayers(); return; }
      var b = map.getBounds();
      var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      overpassQuery(bbox).then(function (data) {
        poiLayer.clearLayers();
        data.elements.forEach(function (el) {
          if (!el.tags || !el.tags.name) return;
          var marker = L.circleMarker([el.lat, el.lon], {
            radius: 4, color: '#fff', weight: 1, fillColor: '#1971c2', fillOpacity: 0.9,
          }).addTo(poiLayer);
          marker.on('click', function () {
            selectFeature({
              id: 'poi-' + el.id,
              name: el.tags.name,
              extra: el.tags.amenity || el.tags.shop || 'poi',
            }, [el.lat, el.lon]);
          });
        });
      }).catch(function (err) { console.warn('POI refresh failed', err); });
    }, 600);
  }
  map.on('moveend', refreshPois);

  // ---------- Routing ----------
  function getRoute(fromLatLng, toLatLng) {
    var url = OSRM_BASE_URL + '/route/v1/' + OSRM_PROFILE + '/' +
      fromLatLng[1] + ',' + fromLatLng[0] + ';' + toLatLng[1] + ',' + toLatLng[0] +
      '?overview=full&geometries=geojson&steps=true';
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('OSRM ' + res.status);
      return res.json();
    }).then(function (data) {
      if (data.code !== 'Ok') throw new Error(data.message || data.code);
      var route = data.routes[0];
      return { geometry: route.geometry, distanceMeters: route.distance, durationSeconds: route.duration };
    });
  }
  function drawRoute(geometry) {
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON(geometry, { style: { color: '#2b8a3e', weight: 4 } }).addTo(map);
  }
  function clearRouteLine() {
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  }

  // ---------- Selection / route state ----------
  var state = { start: null, end: null };

  function maybeRoute() {
    if (!state.start || !state.end) return;
    getCachedRoute(state.start.id, state.end.id).catch(function () { return null; }).then(function (cached) {
      if (cached) {
        drawRoute(cached.geometry);
        renderRouteInfo(cached, true);
        return;
      }
      getRoute(state.start.coords, state.end.coords).then(function (route) {
        drawRoute(route.geometry);
        renderRouteInfo(route, false);
        if (state.start.id && state.end.id) cacheRoute(state.start.id, state.end.id, route);
      }).catch(function (err) {
        showPanel('<p>Routing failed: ' + err.message + '</p>');
      });
    });
  }

  function renderRouteInfo(route, fromCache) {
    var km = (route.distanceMeters / 1000).toFixed(1);
    var min = Math.round(route.durationSeconds / 60);
    showPanel(
      '<h3>' + state.start.name + ' → ' + state.end.name + '</h3>' +
      '<p>' + km + ' km · ' + min + ' min' + (fromCache ? ' (cached, offline-ready)' : '') + '</p>' +
      '<button id="clearRouteBtn">Clear route</button>'
    );
    document.getElementById('clearRouteBtn').onclick = function () {
      state.start = null; state.end = null; clearRouteLine(); panel.classList.remove('open');
    };
  }

  function selectFeature(feature, latlng) {
    feature.coords = latlng;
    showPanel(
      '<h3>' + feature.name + '</h3>' +
      (feature.extra ? '<p>' + feature.extra + '</p>' : '') +
      '<button id="setStart">Set as start</button>' +
      '<button id="setEnd">Set as end</button>' +
      '<button id="saveFav">★ Save</button>'
    );
    document.getElementById('setStart').onclick = function () { state.start = feature; maybeRoute(); };
    document.getElementById('setEnd').onclick = function () { state.end = feature; maybeRoute(); };
    document.getElementById('saveFav').onclick = function () {
      addFavorite(feature).then(function () {
        showPanel('<p>Saved "' + feature.name + '" to favorites.</p>');
      });
    };
  }

  function renderFavorites() {
    listFavorites().then(function (favs) {
      if (favs.length === 0) {
        showPanel('<p>No favorites yet. Tap a place on the map and hit ★ Save.</p>');
        return;
      }
      var html = '<h3>Favorites</h3>' + favs.map(function (f) {
        return '<div class="fav-item">' + f.name +
          ' <button data-act="start" data-id="' + f.id + '">Start</button>' +
          ' <button data-act="end" data-id="' + f.id + '">End</button>' +
          ' <button data-act="del" data-id="' + f.id + '">🗑</button></div>';
      }).join('');
      showPanel(html);
      var buttons = panelContent.querySelectorAll('button[data-act]');
      for (var i = 0; i < buttons.length; i++) {
        (function (btn) {
          btn.onclick = function () {
            var fav = null;
            for (var j = 0; j < favs.length; j++) if (favs[j].id === btn.getAttribute('data-id')) fav = favs[j];
            var act = btn.getAttribute('data-act');
            if (act === 'start') { state.start = fav; maybeRoute(); }
            if (act === 'end') { state.end = fav; maybeRoute(); }
            if (act === 'del') { removeFavorite(fav.id).then(renderFavorites); }
          };
        })(buttons[i]);
      }
    });
  }
  document.getElementById('favBtn').onclick = renderFavorites;

  document.getElementById('locateBtn').onclick = function () {
    navigator.geolocation.getCurrentPosition(function (pos) {
      var latlng = [pos.coords.latitude, pos.coords.longitude];
      map.setView(latlng, 16);
      state.start = { id: null, name: 'Current location', coords: latlng };
    }, function (err) {
      showPanel('<p>Location failed: ' + err.message + '</p>');
    });
  };

  loadYoubike();
})();
