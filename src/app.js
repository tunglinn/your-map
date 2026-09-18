// Single plain script, no ES modules / import maps — iPhone 6 tops out at iOS 12.5.7
// (Safari 12), which predates import maps (Safari 16.4+) and can't be assumed to
// parse modern library bundles. Leaflet + raster tiles avoids WebGL entirely too,
// which matters on decade-old hardware. Keep this file ES5-friendly: no optional
// chaining (?.), no nullish coalescing (??), no class fields.
(function () {
  'use strict';

  // ---------- Debug console: mirrors console.log/warn/error + uncaught errors
  // into an on-screen, copyable panel. iOS 12 Safari has no quick remote-
  // inspector loop (needs a Mac + cable), so this is how bugs get seen and
  // relayed at all. Complements the toast below: toast is a glanceable
  // "something failed" ping, this is the full detail log to copy/paste. ----------
  var LOG_MAX_LINES = 300;
  var logLines = [];
  function renderLog() {
    var el = document.getElementById('debugConsoleText');
    if (el) el.value = logLines.join('\n');
  }
  function pushLog(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'string') { parts.push(a); continue; }
      // Error objects JSON.stringify to "{}" (message/stack aren't
      // enumerable) - pull the useful bits out explicitly instead.
      if (a instanceof Error) { parts.push(a.name + ': ' + a.message); continue; }
      try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); }
    }
    var stamp = new Date().toISOString().substr(11, 8);
    logLines.push('[' + stamp + '] ' + level + ': ' + parts.join(' '));
    if (logLines.length > LOG_MAX_LINES) logLines.shift();
    renderLog();
  }
  ['log', 'warn', 'error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      pushLog(level, arguments);
      original.apply(console, arguments);
    };
  });
  window.onerror = function (message, url, line, col) {
    pushLog('error', [message + ' (' + url + ':' + line + ':' + col + ')']);
  };
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason && e.reason.message ? e.reason.message : e.reason;
    pushLog('error', ['Unhandled promise rejection: ' + reason]);
  });

  var TAIPEI_CENTER = [25.0330, 121.5654]; // Leaflet uses [lat, lon]
  var YOUBIKE_URL = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json';
  // ponytail: calling overpass-api.de directly from the browser got HTTP 406
  // with no CORS header (confirmed via real browser devtools, not just this
  // project's sandbox) - likely origin-based blocking somewhere in front of
  // it. Routed through a Cloudflare Worker (worker/overpass-proxy.js) that
  // fetches Overpass server-to-server instead, where CORS doesn't apply.
  // PLACEHOLDER until deployed - see worker/overpass-proxy.js for how.
  var OVERPASS_URL = 'https://overpass-proxy.tunglin.workers.dev';
  var POI_MIN_ZOOM = 16;
  // Fixed bbox covering the Taipei Metro + New Taipei service area (data we
  // gather is Taipei-scoped even though the basemap itself is worldwide).
  var TRANSIT_BBOX = [24.95, 121.35, 25.25, 121.75];
  // ponytail: public OSRM demo, driving profile — placeholder to get routing
  // working end-to-end. No bike-safety weighting yet. Swap once the self-hosted
  // Taiwan OSRM (infra/setup-osrm.sh) is up: change these two constants only.
  var OSRM_BASE_URL = 'https://router.project-osrm.org';
  var OSRM_PROFILE = 'driving';

  var map = L.map('map').setView(TAIPEI_CENTER, 15);
  // ponytail: CARTO's free basemap tiles now require a signed-up API key
  // (they locked this down after this was first wired up). OSM's own tile
  // server needs no key at all and is the standard Leaflet-quickstart
  // choice; their usage policy just asks that apps with real traffic
  // self-host or use a paid provider instead of this - fine for a single
  // personal user, revisit if that ever stops being true.
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: 'abc',
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  var poiLayer = L.layerGroup().addTo(map);
  var youbikeLayer = L.layerGroup().addTo(map);
  var transitLayer = L.layerGroup().addTo(map);
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

  // Background layer fetches (Youbike/POI/transit) fail silently to
  // console.warn otherwise — invisible on an iPhone with no attached
  // console. Surface them on-screen so they're diagnosable on-device.
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 5000);
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
    console.log('Youbike: fetching ' + YOUBIKE_URL);
    fetch(YOUBIKE_URL)
      .then(function (res) { return res.json(); })
      .then(function (stations) {
        youbikeLayer.clearLayers();
        var shown = 0;
        stations.forEach(function (s) {
          if (s.act !== '1') return;
          shown++;
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
        console.log('Youbike: loaded ' + shown + ' active stations (of ' + stations.length + ' total)');
      })
      .catch(function (err) { console.warn('Youbike load failed', err); showToast('Youbike load failed: ' + err.message); });
  }

  // ---------- Overpass, via our Worker proxy (shared by POIs/bus stops and rail/MRT stations) ----------
  function runOverpass(q) {
    return fetch(OVERPASS_URL + '?data=' + encodeURIComponent(q))
      .then(function (res) {
        if (!res.ok) throw new Error('Overpass ' + res.status);
        return res.json();
      });
  }

  // ---------- POIs + bus stops (viewport-scoped, only when zoomed in) ----------
  var POI_COLORS = { bus_stop: '#0c8599', default: '#1971c2' };
  var poiTimer = null;
  function refreshPois() {
    clearTimeout(poiTimer);
    poiTimer = setTimeout(function () {
      if (map.getZoom() < POI_MIN_ZOOM) {
        poiLayer.clearLayers();
        console.log('POI refresh: skipped, zoom ' + map.getZoom() + ' < min ' + POI_MIN_ZOOM);
        return;
      }
      var b = map.getBounds();
      var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      var q = '[out:json][timeout:15];(' +
        'node["amenity"](' + bbox.join(',') + ');' +
        'node["shop"](' + bbox.join(',') + ');' +
        'node["highway"="bus_stop"](' + bbox.join(',') + ');' +
        ');out body 150;';
      console.log('POI refresh: querying bbox ' + bbox.join(','));
      runOverpass(q).then(function (data) {
        poiLayer.clearLayers();
        var shown = 0;
        data.elements.forEach(function (el) {
          if (!el.tags || !el.tags.name) return;
          shown++;
          var isBusStop = el.tags.highway === 'bus_stop';
          var marker = L.circleMarker([el.lat, el.lon], {
            radius: 4, color: '#fff', weight: 1,
            fillColor: isBusStop ? POI_COLORS.bus_stop : POI_COLORS.default,
            fillOpacity: 0.9,
          }).addTo(poiLayer);
          marker.on('click', function () {
            selectFeature({
              id: 'poi-' + el.id,
              name: el.tags.name,
              extra: isBusStop ? 'Bus stop' : (el.tags.amenity || el.tags.shop || 'poi'),
            }, [el.lat, el.lon]);
          });
        });
        console.log('POI refresh: showing ' + shown + ' of ' + data.elements.length + ' returned elements (rest had no name tag)');
      }).catch(function (err) { console.warn('POI refresh failed', err); showToast('POI load failed: ' + err.message); });
    }, 600);
  }
  map.on('moveend', refreshPois);

  // ---------- Rail / MRT stations (always on — small dataset, whole metro area) ----------
  function loadTransitStations() {
    // railway=station/halt covers most rail mapping; public_transport=station
    // (scoped to subway=yes so it doesn't also pull in every bus station) is
    // an alternate tagging style some Taipei MRT stations use instead of/
    // alongside railway=station.
    var q = '[out:json][timeout:20];(' +
      'node["railway"="station"](' + TRANSIT_BBOX.join(',') + ');' +
      'node["railway"="halt"](' + TRANSIT_BBOX.join(',') + ');' +
      'node["public_transport"="station"]["subway"="yes"](' + TRANSIT_BBOX.join(',') + ');' +
      ');out body 300;';
    console.log('Transit: querying bbox ' + TRANSIT_BBOX.join(','));
    runOverpass(q).then(function (data) {
      transitLayer.clearLayers();
      var shown = 0;
      data.elements.forEach(function (el) {
        if (!el.tags || !el.tags.name) return;
        shown++;
        var marker = L.circleMarker([el.lat, el.lon], {
          radius: 5, color: '#fff', weight: 1, fillColor: '#862e9c', fillOpacity: 0.9,
        }).addTo(transitLayer);
        marker.on('click', function () {
          selectFeature({
            id: 'rail-' + el.id,
            name: el.tags.name,
            extra: el.tags.network || (el.tags.station === 'subway' ? 'MRT station' : 'Rail station'),
          }, [el.lat, el.lon]);
        });
      });
      console.log('Transit: showing ' + shown + ' of ' + data.elements.length + ' returned elements (rest had no name tag)');
    }).catch(function (err) { console.warn('Transit load failed', err); showToast('Transit load failed: ' + err.message); });
  }

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

  var debugConsole = document.getElementById('debugConsole');
  document.getElementById('consoleBtn').onclick = function () {
    debugConsole.classList.toggle('open');
    renderLog();
  };
  document.getElementById('debugConsoleClose').onclick = function () {
    debugConsole.classList.remove('open');
  };
  document.getElementById('debugConsoleClear').onclick = function () {
    logLines = [];
    renderLog();
  };

  loadYoubike();
  setInterval(loadYoubike, 60000); // live availability changes constantly; refetch every minute
  loadTransitStations(); // static dataset (stations don't move) — load once
})();
