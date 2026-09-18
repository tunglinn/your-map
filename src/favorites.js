const DB_NAME = 'your-map';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('favorites')) {
        db.createObjectStore('favorites', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('routes')) {
        // key: `${fromId}|${toId}` (order-independent, sorted)
        db.createObjectStore('routes', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

export async function addFavorite(fav) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'favorites', 'readwrite').put(fav);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function listFavorites() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'favorites', 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function removeFavorite(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'favorites', 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function routeKey(fromId, toId) {
  return [fromId, toId].sort().join('|');
}

export async function cacheRoute(fromId, toId, route) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'routes', 'readwrite').put({ key: routeKey(fromId, toId), route, cachedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedRoute(fromId, toId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'routes', 'readonly').get(routeKey(fromId, toId));
    req.onsuccess = () => resolve(req.result ? req.result.route : null);
    req.onerror = () => reject(req.error);
  });
}
