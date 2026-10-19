/* Tiny IndexedDB wrapper. All data stays on the phone inside the browser's database.
   Stores: committees (keyPath id), deposits (keyPath id, index committeeId), meta (key/value). */
'use strict';
const DB = (() => {
  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const r = indexedDB.open('commetty-book', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('committees', { keyPath: 'id' });
          db.createObjectStore('deposits', { keyPath: 'id' }).createIndex('committeeId', 'committeeId');
          db.createObjectStore('meta');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return opening;
  }
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const done = (t) => new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error); });
  const store = async (name, mode = 'readonly') => (await open()).transaction(name, mode).objectStore(name);

  return {
    all: async (name) => req((await store(name)).getAll()),
    get: async (name, key) => req((await store(name)).get(key)),
    put: async (name, value, key) => req((await store(name, 'readwrite')).put(value, key)),
    del: async (name, key) => req((await store(name, 'readwrite')).delete(key)),

    async deleteCommittee(id) {
      const t = (await open()).transaction(['committees', 'deposits'], 'readwrite');
      t.objectStore('committees').delete(id);
      const idx = t.objectStore('deposits').index('committeeId');
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { t.objectStore('deposits').delete(cur.primaryKey); cur.continue(); }
      };
      return done(t);
    },

    // replace=true wipes everything first (restore), otherwise upserts by id (merge).
    async load(committees, deposits, replace) {
      const t = (await open()).transaction(['committees', 'deposits'], 'readwrite');
      const cs = t.objectStore('committees'), ds = t.objectStore('deposits');
      if (replace) { cs.clear(); ds.clear(); }
      committees.forEach((c) => cs.put(c));
      deposits.forEach((d) => ds.put(d));
      return done(t);
    },
  };
})();
