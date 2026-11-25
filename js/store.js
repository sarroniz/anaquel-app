// Almacenamiento local: ajustes (localStorage), datos (IndexedDB) y PDFs (Cache Storage).

const SETTINGS_KEY = 'anaquel.settings';
const DB_NAME = 'anaquel';
const STORE = 'kv';
export const PDF_CACHE = 'anaquel-pdfs';

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || null; } catch { return null; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* modo privado */ }
}

export function clearSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* nada */ }
}

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function get(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch { return undefined; }
}

export async function set(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); } catch (err) { console.warn('No se pudo guardar', key, err); }
}

export async function clearData() {
  try { await tx('readwrite', (s) => s.clear()); } catch { /* nada */ }
}

// ---------------------------------------------------------------- PDFs

function pdfRequest(key) {
  return new Request(new URL(`__pdf/${encodeURIComponent(key)}`, location.href).href);
}

export async function getPdf(key, sha) {
  if (!('caches' in self)) return null;
  const cache = await caches.open(PDF_CACHE);
  const res = await cache.match(pdfRequest(key));
  if (!res) return null;
  if (sha && res.headers.get('x-sha') !== sha) return null;
  return res.blob();
}

export async function putPdf(key, sha, blob) {
  if (!('caches' in self)) return;
  const cache = await caches.open(PDF_CACHE);
  await cache.put(pdfRequest(key), new Response(blob, {
    headers: { 'Content-Type': 'application/pdf', 'x-sha': sha || '', 'Content-Length': String(blob.size) },
  }));
}

/** Map clave → sha de los PDFs guardados en el dispositivo. */
export async function cachedPdfs() {
  const out = new Map();
  if (!('caches' in self)) return out;
  const cache = await caches.open(PDF_CACHE);
  for (const req of await cache.keys()) {
    const key = decodeURIComponent(new URL(req.url).pathname.split('/__pdf/')[1] || '');
    const res = await cache.match(req);
    if (key) out.set(key, res?.headers.get('x-sha') || '');
  }
  return out;
}

export async function clearPdfs() {
  if ('caches' in self) await caches.delete(PDF_CACHE);
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* no disponible */ }
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
