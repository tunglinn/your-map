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
  var BUS_STOP_MIN_ZOOM = 16; // POI search has no zoom gate - it's on-demand, not automatic
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

  // ---------- Route bar: persistent (survives the bottom panel opening/
  // closing) so start/destination and "you're picking a start point now"
  // stay visible while the user is off tapping markers on the map. ----------
  var routeBarEl = document.getElementById('routeBar');
  var startLabelEl = document.getElementById('startLabel');
  var endLabelEl = document.getElementById('endLabel');
  var choosingStart = false;
  var locatingStart = false;

  function updateRouteBar() {
    if (!state.end) {
      routeBarEl.classList.remove('open');
      searchBarEl.classList.remove('hidden');
      return;
    }
    routeBarEl.classList.add('open');
    searchBarEl.classList.add('hidden');
    endLabelEl.textContent = state.end.name;
    if (state.start) {
      startLabelEl.textContent = state.start.name;
      startLabelEl.className = 'label';
    } else if (locatingStart) {
      startLabelEl.textContent = 'Locating…';
      startLabelEl.className = 'label';
    } else if (choosingStart) {
      startLabelEl.textContent = 'Choose starting point — tap a marker on the map';
      startLabelEl.className = 'label active';
    } else {
      startLabelEl.textContent = 'Choose starting point';
      startLabelEl.className = 'label';
    }
  }

  // Tap the start row to (re)pick it, same as Google Maps letting you tap
  // either field - only once geolocation has settled, so a tap can't race
  // against an in-flight getCurrentPosition() callback.
  startLabelEl.onclick = function () {
    if (state.end && !locatingStart) promptChooseStart();
  };

  document.getElementById('cancelRouteBtn').onclick = function () {
    state.start = null;
    state.end = null;
    choosingStart = false;
    locatingStart = false;
    clearRouteLine();
    updateRouteBar();
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

  // Emoji-on-a-colored-circle marker, same reasoning as the search pin: no
  // image asset request, no risk of a default icon's path failing to
  // resolve. One icon instance can be reused across many L.marker calls.
  function makeBadgeIcon(emoji, bgColor) {
    return L.divIcon({
      html: '<div class="marker-badge" style="background:' + bgColor + ';">' + emoji + '</div>',
      className: 'marker-badge-icon',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
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
          // Badge color IS the availability signal (green/amber/red), same
          // thresholds as before - just moved from a plain dot to the icon's
          // background since emoji glyphs can't be recolored via CSS.
          var color = s.available_rent_bikes >= 8 ? '#81b98f' : s.available_rent_bikes >= 3 ? '#d9ae6e' : '#c98a7d';
          var marker = L.marker([s.latitude, s.longitude], { icon: makeBadgeIcon('🚲', color) }).addTo(youbikeLayer);
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

  // ---------- POI search (on-demand only) ----------
  // Used to auto-query Overpass on every map pan/zoom at high enough zoom -
  // meant well (keep marker count low) but still hammered Overpass with a
  // fresh request on every small pan, which didn't help its reliability.
  // Now Overpass is only hit when the user actually searches for something.
  function escapeOverpassRegex(s) {
    return s.replace(/["\\.*+?^${}()|[\]]/g, '\\$&');
  }

  // A pin (not a small dot) so search hits stand out from the always-on
  // Youbike/transit/bus layers - emoji + divIcon needs no image assets (no
  // extra network request, and no risk of Leaflet's default marker icon
  // silently failing to resolve its image path from a plain CDN include).
  var searchPinIcon = L.divIcon({
    html: '<div class="search-pin-emoji">📍</div>',
    className: 'search-pin-icon',
    iconSize: [26, 32],
    iconAnchor: [13, 30],
  });

  function runPoiSearch(query) {
    var trimmed = query.trim();
    if (!trimmed) return;
    var safe = escapeOverpassRegex(trimmed);
    var b = map.getBounds();
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    var q = '[out:json][timeout:15];(' +
      'node["amenity"]["name"~"' + safe + '",i](' + bbox.join(',') + ');' +
      'node["shop"]["name"~"' + safe + '",i](' + bbox.join(',') + ');' +
      ');out body 30;';
    console.log('POI search: "' + trimmed + '" in current view');
    runOverpass(q).then(function (data) {
      poiLayer.clearLayers();
      var results = [];
      data.elements.forEach(function (el) {
        if (!el.tags || !el.tags.name) return;
        var feature = {
          id: 'poi-' + el.id,
          name: el.tags.name,
          extra: el.tags.amenity || el.tags.shop || 'poi',
        };
        var latlng = [el.lat, el.lon];
        results.push({ feature: feature, latlng: latlng });
        var marker = L.marker(latlng, { icon: searchPinIcon }).addTo(poiLayer);
        marker.on('click', function () { handleMarkerTap(feature, latlng); });
      });
      console.log('POI search: ' + results.length + ' result(s) for "' + trimmed + '"');
      renderSearchResults(trimmed, results);
    }).catch(function (err) { console.warn('POI search failed', err); showToast('Search failed: ' + err.message); });
  }

  function renderSearchResults(query, results) {
    if (results.length === 0) {
      showPanel('<p>No results for "' + query + '".</p>');
      return;
    }
    var html = '<h3>' + results.length + ' result' + (results.length === 1 ? '' : 's') + ' for "' + query + '"</h3>' +
      results.map(function (r, i) {
        return '<div class="result-item" data-result-index="' + i + '">' +
          '<div>' + r.feature.name + '</div>' +
          '<div class="result-sub">' + r.feature.extra + '</div>' +
          '</div>';
      }).join('');
    showPanel(html);
    var rows = panelContent.querySelectorAll('[data-result-index]');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        row.onclick = function () {
          var r = results[Number(row.getAttribute('data-result-index'))];
          map.panTo(r.latlng); // bring the tapped result's pin into view
          handleMarkerTap(r.feature, r.latlng);
        };
      })(rows[i]);
    }
  }

  var searchBarEl = document.getElementById('searchBar');
  var searchInputEl = document.getElementById('searchInput');
  document.getElementById('searchBtn').onclick = function () { runPoiSearch(searchInputEl.value); };
  searchInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') runPoiSearch(searchInputEl.value);
  });

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

  var busStopIcon = makeBadgeIcon('🚏', '#6fa3ac');
  var metroIcon = makeBadgeIcon('🚇', '#9c7aa8');

  function renderStaticMarker(rec, layerGroup, icon) {
    var marker = L.marker([rec[1], rec[2]], { icon: icon }).addTo(layerGroup);
    marker.on('click', function () {
      handleMarkerTap({ id: rec[0], name: rec[3], extra: rec[4] }, [rec[1], rec[2]]);
    });
  }

  var busStopsData = [];
  function refreshVisibleBusStops() {
    if (map.getZoom() < BUS_STOP_MIN_ZOOM) { busLayer.clearLayers(); return; }
    var b = map.getBounds();
    var south = b.getSouth(), north = b.getNorth(), west = b.getWest(), east = b.getEast();
    busLayer.clearLayers();
    var shown = 0;
    busStopsData.forEach(function (rec) {
      var lat = rec[1], lon = rec[2];
      if (lat < south || lat > north || lon < west || lon > east) return;
      shown++;
      renderStaticMarker(rec, busLayer, busStopIcon);
    });
    console.log('Bus stops: showing ' + shown + ' of ' + busStopsData.length + ' in view');
  }

  // Bus stops still refresh on pan/zoom - it's a local array filter, no
  // network call, so it doesn't contribute to the Overpass load problem.
  map.on('moveend', refreshVisibleBusStops);

  loadStaticLayer('data/transit-stations.json', 'Transit').then(function (records) {
    records.forEach(function (rec) { renderStaticMarker(rec, transitLayer, metroIcon); });
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
    updateRouteBar();
    var km = (route.distanceMeters / 1000).toFixed(1);
    var min = Math.round(route.durationSeconds / 60);
    showPanel('<p>' + km + ' km · ' + min + ' min' + (fromCache ? ' (cached, offline-ready)' : '') + '</p>');
  }

  // Google-Maps-style flow: tapping a marker offers one primary action
  // (Navigate), not a pick-start/pick-end pair. Navigate auto-fills the tap
  // as the destination and tries geolocation for the start; only if that's
  // unavailable does it fall back to asking the user to choose one.
  // (choosingStart/locatingStart/updateRouteBar are declared up near the
  // routeBar DOM refs, close to the element they render into.)

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
      updateRouteBar();
      maybeRoute();
      return;
    }
    selectFeature(feature, latlng);
  }

  function startNavigationTo(feature) {
    state.end = feature;
    // The persistent bar now carries destination/start - free the map to
    // tap (picking a start point needs the map, not the bottom sheet).
    panel.classList.remove('open');
    if (state.start) { updateRouteBar(); maybeRoute(); return; }
    locatingStart = true;
    updateRouteBar();
    navigator.geolocation.getCurrentPosition(function (pos) {
      locatingStart = false;
      state.start = {
        id: null, name: 'Current location',
        coords: [pos.coords.latitude, pos.coords.longitude],
      };
      updateRouteBar();
      maybeRoute();
    }, function () {
      locatingStart = false;
      promptChooseStart();
    });
  }

  function promptChooseStart() {
    choosingStart = true;
    updateRouteBar(); // bar's start row switches to the active "tap a marker" state
    listFavorites().then(function (favs) {
      var favHtml = favs.length
        ? favs.map(function (f) {
            return '<div class="fav-item">' + f.name +
              ' <button data-start-id="' + f.id + '">Use as start</button></div>';
          }).join('')
        : '<p>No favorites saved yet.</p>';
      showPanel(
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
            updateRouteBar();
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
      choosingStart = false;
      updateRouteBar();
      if (state.end) maybeRoute();
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
