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
  // Overpass turned out to be intermittently flaky even after fixing the
  // User-Agent block (see git log) - fine for a live, viewport-scoped query
  // like amenity/shop POIs below, but rail stations and bus stops barely
  // change (new station maybe once a year), so those are pre-baked into
  // data/*.json instead: one static fetch, zero ongoing Overpass dependency,
  // filtered/rendered from memory from then on. Regenerate by hand
  // (see data/README.md) if a new station/stop needs adding.
  var OVERPASS_URL = 'https://overpass-proxy.tunglin.workers.dev';
  var POI_MIN_ZOOM = 16;
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
  var busLayer = L.layerGroup().addTo(map);
  var routeLayer = null;

  var panel = document.getElementById('panel');
  var panelContent = document.getElementById('panelContent');
  document.getElementById('closePanel').onclick = function () {
    panel.classList.remove('open');
    choosingStart = false; // cancel a pending "choose a starting point" prompt
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
            handleMarkerTap({
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
        if (!res.ok) {
          // The Worker forwards Overpass's response body verbatim even on
          // error - read it instead of discarding it, since a bare status
          // code hasn't been enough to diagnose this.
          return res.text().then(function (body) {
            throw new Error('Overpass ' + res.status + ': ' + body.slice(0, 300));
          });
        }
        return res.json();
      });
  }

  // ---------- POIs (amenity/shop — live, viewport-scoped, only when zoomed in) ----------
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
        ');out body 150;';
      console.log('POI refresh: querying bbox ' + bbox.join(','));
      runOverpass(q).then(function (data) {
        poiLayer.clearLayers();
        var shown = 0;
        data.elements.forEach(function (el) {
          if (!el.tags || !el.tags.name) return;
          shown++;
          var marker = L.circleMarker([el.lat, el.lon], {
            radius: 4, color: '#fff', weight: 1, fillColor: '#1971c2', fillOpacity: 0.9,
          }).addTo(poiLayer);
          marker.on('click', function () {
            handleMarkerTap({
              id: 'poi-' + el.id,
              name: el.tags.name,
              extra: el.tags.amenity || el.tags.shop || 'poi',
            }, [el.lat, el.lon]);
          });
        });
        console.log('POI refresh: showing ' + shown + ' of ' + data.elements.length + ' returned elements (rest had no name tag)');
      }).catch(function (err) { console.warn('POI refresh failed', err); showToast('POI load failed: ' + err.message); });
    }, 600);
  }

  // ---------- Rail/MRT stations + bus stops: pre-baked static data (data/README.md) ----------
  // Compact array format to keep the file small: [id, lat, lon, name, extraLabel].
  function loadStaticLayer(url, label) {
    console.log('Static layer (' + label + '): fetching ' + url);
    return fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (records) {
        console.log('Static layer (' + label + '): loaded ' + records.length + ' records');
        return records;
      })
      .catch(function (err) {
        console.warn(label + ' load failed', err);
        showToast(label + ' load failed: ' + err.message);
        return [];
      });
  }

  function renderStaticMarker(rec, layerGroup, markerRadius, color) {
    var marker = L.circleMarker([rec[1], rec[2]], {
      radius: markerRadius, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9,
    }).addTo(layerGroup);
    marker.on('click', function () {
      handleMarkerTap({ id: rec[0], name: rec[3], extra: rec[4] }, [rec[1], rec[2]]);
    });
  }

  var busStopsData = [];
  function refreshVisibleBusStops() {
    if (map.getZoom() < POI_MIN_ZOOM) { busLayer.clearLayers(); return; }
    var b = map.getBounds();
    var south = b.getSouth(), north = b.getNorth(), west = b.getWest(), east = b.getEast();
    busLayer.clearLayers();
    var shown = 0;
    busStopsData.forEach(function (rec) {
      var lat = rec[1], lon = rec[2];
      if (lat < south || lat > north || lon < west || lon > east) return;
      shown++;
      renderStaticMarker(rec, busLayer, 4, '#0c8599');
    });
    console.log('Bus stops: showing ' + shown + ' of ' + busStopsData.length + ' in view');
  }

  map.on('moveend', function () {
    refreshPois();
    refreshVisibleBusStops(); // local array filter, no network - cheap enough to skip debouncing
  });

  loadStaticLayer('data/transit-stations.json', 'Transit').then(function (records) {
    records.forEach(function (rec) { renderStaticMarker(rec, transitLayer, 5, '#862e9c'); });
  });
  loadStaticLayer('data/bus-stops.json', 'Bus stops').then(function (records) {
    busStopsData = records;
    refreshVisibleBusStops();
  });

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

  // Google-Maps-style flow: tapping a marker offers one primary action
  // (Navigate), not a pick-start/pick-end pair. Navigate auto-fills the tap
  // as the destination and tries geolocation for the start; only if that's
  // unavailable does it fall back to asking the user to choose one.
  var choosingStart = false;

  function selectFeature(feature, latlng) {
    feature.coords = latlng;
    showPanel(
      '<h3>' + feature.name + '</h3>' +
      (feature.extra ? '<p>' + feature.extra + '</p>' : '') +
      '<button id="navigateBtn" class="btn-primary">Navigate</button>' +
      '<button id="saveFav">★ Save</button>'
    );
    document.getElementById('navigateBtn').onclick = function () { startNavigationTo(feature); };
    document.getElementById('saveFav').onclick = function () {
      addFavorite(feature).then(function () {
        showPanel('<p>Saved "' + feature.name + '" to favorites.</p>');
      });
    };
  }

  // Any marker tap while choosingStart is active picks the start point
  // instead of opening the normal info panel - see promptChooseStart.
  function handleMarkerTap(feature, latlng) {
    feature.coords = latlng;
    if (choosingStart) {
      choosingStart = false;
      state.start = feature;
      maybeRoute();
      return;
    }
    selectFeature(feature, latlng);
  }

  function startNavigationTo(feature) {
    state.end = feature;
    if (state.start) { maybeRoute(); return; }
    showPanel('<p>Finding your location…</p>');
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.start = {
        id: null, name: 'Current location',
        coords: [pos.coords.latitude, pos.coords.longitude],
      };
      maybeRoute();
    }, function () {
      promptChooseStart();
    });
  }

  function promptChooseStart() {
    choosingStart = true;
    listFavorites().then(function (favs) {
      var favHtml = favs.length
        ? favs.map(function (f) {
            return '<div class="fav-item">' + f.name +
              ' <button data-start-id="' + f.id + '">Use as start</button></div>';
          }).join('')
        : '<p>No favorites saved yet.</p>';
      showPanel(
        '<h3>Choose a starting point</h3>' +
        '<p>Couldn\'t get your location. Tap a marker on the map, or pick a favorite:</p>' +
        favHtml
      );
      var buttons = panelContent.querySelectorAll('button[data-start-id]');
      for (var i = 0; i < buttons.length; i++) {
        (function (btn) {
          btn.onclick = function () {
            var id = btn.getAttribute('data-start-id');
            var fav = null;
            for (var j = 0; j < favs.length; j++) if (favs[j].id === id) fav = favs[j];
            choosingStart = false;
            state.start = fav;
            maybeRoute();
          };
        })(buttons[i]);
      }
    });
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

  loadYoubike(); // load once on open, not polled - battery over freshness
})();
