import { GitHub, GitHubError } from './github.js';
import * as store from './store.js';
import { normalizeEntry, search, sortResults, sourceLine, toBibtex, fold, snippet, authorKey, venueKey, parseAuthors } from './library.js';
import { OpenAlex, buildLibraryIndex, findInLibrary, workToBibtex, workToEntry, citeKeyFor, titleKey, asDoi } from './openalex.js';

// ---------------------------------------------------------------- estado

const state = {
  settings: store.loadSettings(),
  gh: null,
  entries: [],
  byKey: new Map(),
  tree: null,              // Map ruta → {sha, size}
  libSha: null,
  flags: {},               // marcas confirmadas en GitHub
  flagsSha: null,
  pending: [],             // cambios de marcas aún no enviados
  adds: new Map(),         // cola para añadir a la biblioteca (pendientes/{clave}.json en GitHub): clave → {path, sha, item}
  addOps: [],              // altas y bajas de la cola aún no enviadas
  addsStatus: {},          // pendientes/_estado.json: lo que el Mac no pudo importar
  addsStatusSha: null,
  cached: new Map(),       // PDFs guardados en el dispositivo: clave → sha
  query: '',
  filter: { kind: 'all', value: '', label: '' },   // all | pdf | flagged | topic | author | year | venue
  sortChoice: null,        // null = automático (relevancia si hay búsqueda, si no, más recientes)
  results: [],
  selectedKey: null,
  lastSync: null,
  syncing: false,
  syncError: null,
  viewerKey: null,
  viewerBlob: null,
  mode: 'library',         // library | web («Buscar artículos» en OpenAlex)
  libIndex: null,          // DOI y título → clave, para marcar los resultados que ya están en la biblioteca
  web: {
    query: '', searchMode: 'topic', sort: 'relevance', sortAuto: false, fromYear: '',
    results: [], authors: [], sources: [], count: 0, page: 1,
    loading: false, error: null, searched: false, context: null, selectedId: null,
  },
  libAuthors: new Map(),   // clave de autor → nº de referencias en la biblioteca
  libVenues: new Map(),    // clave de revista → nº de referencias en la biblioteca
  libOa: null,             // {sha, byId: id de OpenAlex → clave, byKey: clave → id, authors, sources, topics}
  disc: {                  // «Descubrir»: novedades elegidas a partir de la biblioteca
    items: [], at: 0, loading: false, error: null, selectedId: null,
    query: '', reason: 'all', days: 30, sort: 'relevance', newIds: new Set(),
  },
  discDismissed: new Set(),
  oaInfo: new Map(),       // clave de la biblioteca → {id, cited, refs} en OpenAlex
};

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#app'), q: $('#q'), filters: $('#filters'), count: $('#count'), sort: $('#sort'), results: $('#results'),
  detail: $('#detail'), status: $('#sync-status'), toast: $('#toast'),
  viewer: $('#viewer'), viewerTitle: $('#viewer-title'), viewerScroll: $('#viewer-scroll'), viewerPages: $('#viewer-pages'),
  viewerProgress: $('#viewer-progress'), viewerProgressFill: $('#viewer-progress-fill'), viewerProgressText: $('#viewer-progress-text'),
  viewerFlag: $('#viewer-flag'), zoomLabel: $('#zoom-label'),
  flagDialog: $('#flag-dialog'), flagNote: $('#flag-note'), flagDialogEntry: $('#flag-dialog-entry'),
  addDialog: $('#add-dialog'), addForm: $('#add-form'), addEntry: $('#add-entry'), addKey: $('#add-key'),
  addTags: $('#add-tags'), addNewTag: $('#add-newtag'), addNote: $('#add-note'), addPdfRow: $('#add-pdf-row'),
  addPdf: $('#add-pdf'), addPdfNote: $('#add-pdf-note'), addError: $('#add-error'),
  settingsDialog: $('#settings-dialog'), settingsForm: $('#settings-form'), settingsError: $('#settings-error'),
  settingsTitle: $('#settings-title'), settingsExtra: $('#settings-extra'), offlineSummary: $('#offline-summary'),
  offlineProgress: $('#offline-progress'), offlineProgressFill: $('#offline-progress-fill'),
  btnSaveAll: $('#btn-save-all'),
};

const wide = matchMedia('(min-width: 820px)');
let viewer = null;          // PdfViewer, se carga al abrir el primer PDF
let downloadAbort = null;
let flagChain = Promise.resolve();
let addChain = Promise.resolve();

// ---------------------------------------------------------------- utilidades

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  els.toast.classList.remove('out');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    els.toast.classList.add('out');
    setTimeout(() => { els.toast.hidden = true; }, 250);
  }, 2600);
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'otro dispositivo';
}

const isMacDesktop = () => /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints <= 1;

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `a las ${hm}`;
  return `el ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}, ${hm}`;
}

function formatMB(bytes) {
  return `${(bytes / 1048576).toLocaleString('es-ES', { maximumFractionDigits: bytes < 10485760 ? 1 : 0 })} MB`;
}

function apiBase() {
  return state.settings?.apiBase || localStorage.getItem('anaquel.apiBase') || 'https://api.github.com';
}

function makeClient(settings) {
  return new GitHub({ ...settings, apiBase: apiBase() });
}

// ---------------------------------------------------------------- datos

function setLibrary(data) {
  const list = Array.isArray(data?.entries) ? data.entries : [];
  state.entries = list.map(normalizeEntry).filter((e) => e.key);
  state.byKey = new Map(state.entries.map((e) => [e.key, e]));
  state.libIndex = buildLibraryIndex(state.entries);
  state.libAuthors = new Map();
  state.libVenues = new Map();
  for (const e of state.entries) {
    for (const k of e.authorKeys) state.libAuthors.set(k, (state.libAuthors.get(k) || 0) + 1);
    if (e.venueKey) state.libVenues.set(e.venueKey, (state.libVenues.get(e.venueKey) || 0) + 1);
  }
  if (state.selectedKey && !state.byKey.has(state.selectedKey)) state.selectedKey = null;
}

function effectiveFlags() {
  const out = { ...state.flags };
  for (const op of state.pending) {
    if (op.op === 'set') out[op.key] = op.value; else delete out[op.key];
  }
  return out;
}

function pdfInfo(e) {
  if (!e?.pdf) return null;
  return state.tree ? state.tree.get(e.pdf) || null : { sha: state.cached.get(e.key) || '', size: 0 };
}

const hasPdf = (e) => !!pdfInfo(e);

async function loadLocal() {
  const [lib, meta, tree, flags, pending, cached, adds, addOps, addsStatus] = await Promise.all([
    store.get('library'), store.get('meta'), store.get('tree'), store.get('flags'), store.get('pendingFlags'), store.cachedPdfs(),
    store.get('adds'), store.get('addOps'), store.get('addsStatus'),
  ]);
  const [discFeed, discDismissed] = await Promise.all([store.get('discFeed'), store.get('discDismissed')]);
  if (discFeed?.items) Object.assign(state.disc, { items: discFeed.items, at: discFeed.at || 0, newIds: new Set(discFeed.newIds || []) });
  if (discDismissed) state.discDismissed = new Set(discDismissed);
  if (adds) state.adds = new Map(adds);
  if (addOps) state.addOps = addOps;
  if (addsStatus) { state.addsStatus = addsStatus.data || {}; state.addsStatusSha = addsStatus.sha || null; }
  if (lib) setLibrary(lib);
  if (meta) { state.libSha = meta.libSha || null; state.lastSync = meta.lastSync || null; state.flagsSha = meta.flagsSha || null; }
  if (tree) state.tree = new Map(tree);
  if (flags) state.flags = flags;
  if (pending) state.pending = pending;
  state.cached = cached;
}

async function persistMeta() {
  await store.set('meta', { libSha: state.libSha, lastSync: state.lastSync, flagsSha: state.flagsSha });
}

async function persistFlags() {
  await Promise.all([store.set('flags', state.flags), store.set('pendingFlags', state.pending), persistMeta()]);
}

async function refresh({ quiet = false } = {}) {
  if (!state.gh || state.syncing) return;
  state.syncing = true;
  state.syncError = null;
  if (!quiet) renderStatus();
  els.app.classList.add('is-syncing');
  try {
    const tree = await state.gh.tree();
    const items = new Map(tree.items.filter((i) => i.type === 'blob').map((i) => [i.path, { sha: i.sha, size: i.size }]));
    const lib = items.get('library.json');
    if (!lib) throw new Error('El repositorio todavía no tiene library.json. Ejecuta el script de sincronización en el Mac.');
    if (lib.sha !== state.libSha || !state.entries.length) {
      const data = await (await state.gh.blob(lib.sha)).json();
      setLibrary(data);
      state.libSha = lib.sha;
      await store.set('library', data);
    }
    state.tree = items;
    await store.set('tree', [...items]);
    await syncFlags(items.get('flags.json')?.sha || null);
    await syncAdds(items);
    state.lastSync = Date.now();
    warmFeed();
    await persistMeta();
  } catch (err) {
    state.syncError = err;
    console.warn(err);
  } finally {
    state.syncing = false;
    els.app.classList.remove('is-syncing');
    renderAll();
  }
}

async function syncFlags(remoteSha) {
  if (!state.pending.length && remoteSha && remoteSha === state.flagsSha) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    let remote = { format: 1, flags: {} };
    let sha = null;
    try {
      const r = await state.gh.getJson('flags.json');
      remote = r.data || remote;
      sha = r.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const flags = { ...(remote.flags || {}) };
    if (!state.pending.length) {
      state.flags = flags;
      state.flagsSha = sha;
      await persistFlags();
      return;
    }
    const ops = [...state.pending];
    for (const op of ops) {
      if (op.op === 'set') flags[op.key] = op.value; else delete flags[op.key];
    }
    const message = ops.length === 1
      ? `${ops[0].op === 'set' ? 'Marcar' : 'Quitar marca de'} ${ops[0].key} (${deviceLabel()})`
      : `Actualizar ${ops.length} marcas (${deviceLabel()})`;
    try {
      const newSha = await state.gh.putJson('flags.json', { format: 1, flags }, sha, message);
      state.flags = flags;
      state.flagsSha = newSha || null;
      state.pending = state.pending.slice(ops.length);
      await persistFlags();
      if (!state.pending.length) return;
    } catch (err) {
      if (err.status === 409 || err.status === 422) continue;
      throw err;
    }
  }
  throw new Error('No se pudieron guardar las marcas porque el archivo cambió varias veces seguidas. Vuelve a intentarlo.');
}

function pushFlags() {
  flagChain = flagChain.then(async () => {
    if (!state.gh || !navigator.onLine) { renderStatus(); return; }
    try {
      await syncFlags(null);
      state.syncError = null;
    } catch (err) {
      state.syncError = err;
    }
    renderStatus();
  });
  return flagChain;
}

async function setFlag(key, note) {
  state.pending.push({ op: 'set', key, value: { note: note.trim(), at: new Date().toISOString(), device: deviceLabel() } });
  await store.set('pendingFlags', state.pending);
  renderAll({ animateFlag: key });
  toast('Marcada para editar en el Mac');
  pushFlags();
}

async function clearFlag(key) {
  state.pending.push({ op: 'unset', key });
  await store.set('pendingFlags', state.pending);
  renderAll();
  toast('Marca quitada');
  pushFlags();
}


// ---------------------------------------------------------------- descubrir (novedades a partir de la biblioteca)

const DISC_SORTS = [['relevance', 'Más relevantes'], ['recent', 'Más recientes']];
const DISC_FETCH_DAYS = 90;
const DISC_TTL = 12 * 3600 * 1000;
const DISC_REASONS = [['all', 'Todo'], ['cites', 'Citan tu biblioteca'], ['author', 'Tus autores'], ['journal', 'Tus revistas']];
const DISC_WINDOWS = [[7, 'Última semana'], [30, 'Último mes'], [90, '3 meses']];
const DAY = 864e5;
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
let feedPromise = null;

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d) ? '' : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');
};

async function persistFeed() {
  const d = state.disc;
  await store.set('discFeed', { at: d.at, items: d.items, newIds: [...d.newIds] });
}

/** Los ids que definen el perfil: tus referencias, tus autores más frecuentes, tus revistas y tus temas. */
function discProfile() {
  const p = state.libOa;
  // Con una biblioteca pequeña (o con pocos DOI) puede que nadie llegue al mínimo: entonces vale con aparecer una vez.
  const top = (m, k, min) => {
    const ranked = [...m].sort((a, b) => b[1].n - a[1].n);
    const strong = ranked.filter(([, x]) => x.n >= min);
    return (strong.length ? strong : ranked).slice(0, k).map(([id]) => id);
  };
  return {
    libIds: [...p.byId.keys()],
    authorIds: top(p.authors, 30, 2),
    sourceIds: top(p.sources, 12, 2),
    topicIds: top(p.topics, 10, 2),
  };
}

/** Carga el perfil (si hace falta) y actualiza las novedades si tienen más de 12 horas. */
function warmFeed() {
  if (!state.settings || !navigator.onLine || !state.entries.length) return;
  Promise.resolve(ensureLibraryIds()).then(() => loadFeed());
}

function loadFeed({ force = false } = {}) {
  const d = state.disc;
  if (feedPromise) return feedPromise;
  if (!state.settings || !navigator.onLine) return null;
  if (!force && d.at && Date.now() - d.at < DISC_TTL) return null;
  feedPromise = (async () => {
    if (!state.libOa) await ensureLibraryIds();
    if (!state.libOa?.byId.size) return;
    d.loading = true;
    d.error = null;
    if (state.mode === 'discover') { renderDiscList(); renderStatus(); }
    try {
      const fromDate = new Date(Date.now() - DISC_FETCH_DAYS * DAY).toISOString().slice(0, 10);
      const found = await oa().discover({ ...discProfile(), fromDate });
      const items = [...found.values()].map(({ work, via }) => ({ work, via: [...via] }));
      const seenList = (await store.get('discSeen')) || [];
      const seen = new Set(seenList);
      // La primera vez no se marca nada como nuevo: sería todo.
      d.newIds = seenList.length ? new Set(items.map((i) => i.work.id).filter((id) => !seen.has(id))) : new Set();
      for (const i of items) seen.add(i.work.id);
      await store.set('discSeen', [...seen].slice(-6000));
      if (d.selectedId && !items.some((i) => i.work.id === d.selectedId)) d.selectedId = null;
      d.items = items;
      d.at = Date.now();
      await persistFeed();
    } catch (err) {
      d.error = err;
    } finally {
      d.loading = false;
    }
    renderTabBadge();
    if (state.mode === 'discover') renderAll();
  })().finally(() => { feedPromise = null; });
  return feedPromise;
}

/** Por qué se recomienda cada trabajo, con una puntuación para ordenar. */
function discScored() {
  const d = state.disc;
  const p = state.libOa;
  const now = Date.now();
  const out = [];
  const minAuthorN = p && [...p.authors.values()].some((a) => a.n >= 2) ? 2 : 1;
  for (const it of d.items) {
    const w = it.work;
    if (state.discDismissed.has(w.id) || findInLibrary(w, state.libIndex)) continue;
    // Citar un clásico muy citado dice menos que citar un trabajo especializado: cada cita pesa según lo citado que esté.
    const citedIds = p ? [...new Set(w.refIds.filter((r) => p.byId.has(r)))] : [];
    citedIds.sort((a, b) => (p.citedById.get(a) || 0) - (p.citedById.get(b) || 0));
    const cited = citedIds.map((r) => p.byId.get(r));
    const citeWeight = citedIds.reduce((sum, r) => sum + Math.min(2, Math.max(0.5, 3 / Math.log10((p.citedById.get(r) || 0) + 10))), 0);
    const authors = p ? (w.authorIds || []).map((a) => p.authors.get(a)).filter((a) => a && a.n >= minAuthorN) : [];
    const src = p?.sources.get((w.sourceId || '').split('/').pop());
    const topic = p?.topics.get(w.topicId);
    const journal = it.via.includes('journal') && src ? src.name : '';
    const age = w.date ? Math.max(0, (now - Date.parse(`${w.date}T12:00:00`)) / DAY) : DISC_FETCH_DAYS;
    let score = 0;
    if (cited.length) score += Math.min(12, 2 + 2 * citeWeight);
    for (const a of authors.slice(0, 3)) score += 3 + Math.min(a.n, 10) / 2;
    if (journal) score += 3;
    else if (topic && topic.n >= 3) score += 1;
    score += Math.max(0, 1 - age / DISC_FETCH_DAYS);
    out.push({ w, via: it.via, cited, authors, journal, score, age, isNew: d.newIds.has(w.id) });
  }
  return out;
}

function discVisible() {
  const d = state.disc;
  const q = fold(d.query.trim());
  const words = q ? q.split(/\s+/) : [];
  const list = discScored().filter((x) => {
    if (x.age > d.days) return false;
    if (d.reason === 'cites' && !x.cited.length) return false;
    if (d.reason === 'author' && !x.authors.length) return false;
    if (d.reason === 'journal' && !x.journal) return false;
    if (words.length) {
      const hay = fold(`${x.w.title} ${x.w.authors.map((a) => `${a.first} ${a.last}`).join(' ')} ${x.w.venue}`);
      if (!words.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const byDate = (a, b) => (b.w.date || '').localeCompare(a.w.date || '');
  return list.sort(d.sort === 'recent' ? byDate : (a, b) => b.score - a.score || byDate(a, b));
}

function discReasonsHtml(x) {
  const parts = [];
  if (x.cited.length) {
    const e = state.byKey.get(x.cited[0]);
    const first = e ? entryLabel(e) : x.cited[0];
    parts.push(x.cited.length > 1 ? `Cita ${first} y ${x.cited.length - 1} más de tu biblioteca` : `Cita ${first}, de tu biblioteca`);
  }
  if (x.authors.length) parts.push(`Nuevo de ${x.authors.slice(0, 2).map((a) => a.name).join(' y ')}`);
  if (x.journal && parts.length < 2) parts.push(`En ${x.journal}, sobre tus temas`);
  return parts.slice(0, 2).map((t) => `<span class="row-reason">${esc(t)}</span>`).join('');
}

function renderDiscFilters() {
  const d = state.disc;
  let html = DISC_REASONS.map(([v, l]) => `<button type="button" class="chip" aria-pressed="${d.reason === v}" data-kind="disc-reason" data-value="${v}">${l}</button>`).join('');
  html += '<span class="chip-sep" aria-hidden="true"></span>';
  html += DISC_WINDOWS.map(([v, l]) => `<button type="button" class="chip" aria-pressed="${d.days === v}" data-kind="disc-days" data-value="${v}">${l}</button>`).join('');
  els.filters.innerHTML = html;
}

function handleDiscFilter(b) {
  const d = state.disc;
  if (b.dataset.kind === 'disc-reason') d.reason = b.dataset.value;
  else if (b.dataset.kind === 'disc-days') d.days = Number(b.dataset.value);
  renderDiscFilters();
  renderDiscList();
  els.results.scrollTop = 0;
}

function renderDiscList() {
  const d = state.disc;
  els.sort.value = d.sort;
  if (!state.settings) {
    els.count.textContent = '';
    els.results.innerHTML = '<li class="empty">Conecta tu biblioteca en Ajustes para ver novedades.</li>';
    return;
  }
  if (!d.items.length) {
    els.count.textContent = d.loading ? 'Buscando…' : '';
    els.results.innerHTML = d.loading ? '<li class="empty">Buscando novedades a partir de tu biblioteca…</li>'
      : d.error ? `<li class="empty">${esc(d.error.message)}<div><button type="button" class="btn" data-act="disc-retry">Reintentar</button></div></li>`
        : !navigator.onLine ? '<li class="empty">Sin conexión. Las novedades se buscarán cuando vuelvas a tenerla.</li>'
          : state.libOa && !state.libOa.byId.size ? '<li class="empty">Para recomendarte artículos, tus referencias necesitan DOI.</li>'
            : '<li class="empty">Preparando tus novedades…</li>';
    return;
  }
  const list = discVisible();
  const nNew = list.filter((x) => x.isNew).length;
  els.count.textContent = `${list.length} ${list.length === 1 ? 'novedad' : 'novedades'}${nNew ? `, ${nNew} ${nNew === 1 ? 'nueva' : 'nuevas'}` : ''}`;
  if (!list.length) {
    els.results.innerHTML = `<li class="empty">${d.query.trim() ? `Nada coincide con «${esc(d.query.trim())}».`
      : d.days < DISC_FETCH_DAYS ? 'Nada con este filtro en este periodo. Prueba con «3 meses».' : 'Nada con este filtro.'}</li>`;
    return;
  }
  const adds = effectiveAdds();
  els.results.innerHTML = list.map((x) => workRowHtml(x.w, adds, { isNew: x.isNew, reasons: discReasonsHtml(x) })).join('')
    + (d.error ? `<li class="more"><p class="more-error">No se pudieron actualizar: ${esc(d.error.message)}</p><button type="button" class="btn" data-act="disc-retry">Reintentar</button></li>` : '');
}

/** Número de novedades sin ver en la pestaña. */
function renderTabBadge() {
  const tab = document.querySelector('.mode-switch [data-mode="discover"]');
  if (!tab) return;
  const n = state.disc.newIds.size ? discScored().filter((x) => x.isNew && x.age <= DISC_FETCH_DAYS).length : 0;
  let badge = tab.querySelector('.tab-count');
  if (!n) { badge?.remove(); tab.setAttribute('aria-label', 'Descubrir'); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'tab-count'; tab.append(badge); }
  badge.textContent = n > 99 ? '99+' : String(n);
  tab.setAttribute('aria-label', `Descubrir, ${n} ${n === 1 ? 'novedad nueva' : 'novedades nuevas'}`);
}

function discWhyHtml(w) {
  const x = discScored().find((i) => i.w.id === w.id);
  const parts = [];
  if (x?.cited.length) {
    const shown = x.cited.slice(0, 6).map((k) => {
      const e = state.byKey.get(k);
      return `<button type="button" class="facet" data-act="web-open-lib" data-key="${esc(k)}">${esc(e ? entryLabel(e) : k)}</button>`;
    });
    const rest = x.cited.length - shown.length;
    parts.push(`Cita ${x.cited.length === 1 ? 'un trabajo' : `${x.cited.length} trabajos`} de tu biblioteca: ${shown.join(', ')}${rest > 0 ? ` y ${rest} más` : ''}.`);
  }
  if (x?.authors.length) {
    parts.push(`${x.authors.length > 1 ? 'Autores' : 'Autor'} con varias referencias en tu biblioteca: ${esc(x.authors.map((a) => `${a.name} (${a.n})`).join(', '))}.`);
  }
  if (x?.journal) parts.push(`Publicado en ${esc(x.journal)}, una de tus revistas, sobre ${esc(w.topicName || 'tus temas')}.`);
  return `<div class="entry-affinity disc-why">${parts.length ? `<p>${parts.join(' ')}</p>` : ''}`
    + '<button type="button" class="link-btn" data-act="disc-hide">No me interesa</button></div>';
}

async function dismissWork(id) {
  const d = state.disc;
  state.discDismissed.add(id);
  d.newIds.delete(id);
  if (d.selectedId === id) {
    d.selectedId = null;
    if (!wide.matches) backToList();
  }
  await Promise.all([store.set('discDismissed', [...state.discDismissed].slice(-6000)), persistFeed()]);
  renderAll();
  toast('No volverá a aparecer en este dispositivo');
}

// ---------------------------------------------------------------- añadir a la biblioteca
// Cada alta es un archivo pendientes/{clave}.json en anaquel-datos. El script del Mac lo mete en
// library.db (y descarga el PDF en abierto) en la siguiente sincronización y borra el archivo.
// La app solo crea y borra archivos de la cola, y el Mac solo los borra: así nunca chocan.

const QUEUE_DIR = 'pendientes/';

async function persistAdds() {
  await Promise.all([
    store.set('adds', [...state.adds]), store.set('addOps', state.addOps),
    store.set('addsStatus', { data: state.addsStatus, sha: state.addsStatusSha }),
  ]);
}

async function syncAdds(items) {
  const next = new Map();
  let statusSha = null;
  for (const [path, info] of items) {
    if (!path.startsWith(QUEUE_DIR) || !path.endsWith('.json')) continue;
    const name = path.slice(QUEUE_DIR.length, -5);
    if (!name || name.includes('/')) continue;
    if (name === '_estado') { statusSha = info.sha; continue; }
    if (name.startsWith('_')) continue;
    const old = state.adds.get(name);
    let item = old && old.sha === info.sha ? old.item : null;
    if (!item) {
      try { item = await (await state.gh.blob(info.sha)).json(); } catch (err) { console.warn(err); continue; }
    }
    next.set(name, { path, sha: info.sha, item });
  }
  if (statusSha !== state.addsStatusSha) {
    try {
      state.addsStatus = statusSha ? (await (await state.gh.blob(statusSha)).json()) || {} : {};
      state.addsStatusSha = statusSha;
    } catch (err) { console.warn(err); }
  }
  state.adds = next;
  await persistAdds();
  if (state.addOps.length) await pushAdds();
}

async function sendAddOps() {
  while (state.addOps.length) {
    const op = state.addOps[0];
    const path = `${QUEUE_DIR}${op.key}.json`;
    if (op.op === 'add') {
      try {
        const sha = await state.gh.createFile(path, JSON.stringify(op.item, null, 1) + '\n', `Añadir a la biblioteca: ${op.key} (${deviceLabel()})`);
        state.adds.set(op.key, { path, sha, item: op.item });
      } catch (err) {
        // 422: ya hay en la cola un archivo con esa clave (enviado antes desde este u otro dispositivo).
        if (err.status !== 422) throw err;
      }
    } else {
      for (let attempt = 0; attempt < 2; attempt++) {
        let sha = attempt === 0 ? state.adds.get(op.key)?.sha : null;
        try {
          if (!sha) sha = (await state.gh.getJson(path)).sha;
          await state.gh.deleteFile(path, sha, `Quitar de la cola: ${op.key} (${deviceLabel()})`);
          break;
        } catch (err) {
          if (err.status === 404) break;              // el Mac ya la había importado
          if ((err.status === 409 || err.status === 422) && attempt === 0) continue;
          throw err;
        }
      }
      state.adds.delete(op.key);
    }
    if (state.addOps[0] === op) state.addOps.shift();
    await persistAdds();
  }
}

function pushAdds() {
  addChain = addChain.then(async () => {
    if (!state.gh || !navigator.onLine || !state.addOps.length) { renderStatus(); return; }
    try {
      await sendAddOps();
      state.syncError = null;
    } catch (err) {
      state.syncError = err;
    }
    renderAll();
  });
  return addChain;
}

function effectiveAdds() {
  const out = new Map(state.adds);
  for (const op of state.addOps) {
    if (op.op === 'add') out.set(op.key, { item: op.item, local: true }); else out.delete(op.key);
  }
  return out;
}

/** ¿Está este resultado de OpenAlex en la cola? Devuelve {key, item, local} o null. */
function queuedFor(w, adds = effectiveAdds()) {
  const doi = w.doi?.toLowerCase();
  for (const [key, a] of adds) {
    const it = a.item || {};
    if ((it.openalex && it.openalex === w.id) || (doi && it.fields?.doi?.toLowerCase() === doi)) return { key, ...a };
  }
  return null;
}

/** Igual que normalizeTag() de la extensión de Raycast: minúsculas y espacios o guiones → «_». */
const normalizeTag = (t) => String(t).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');

function libraryTags() {
  const counts = new Map();
  for (const e of state.entries) {
    for (const t of e.topics || []) {
      const n = normalizeTag(t);
      if (n) counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

function keyTaken(key) {
  const k = key.toLowerCase();
  return [...state.byKey.keys(), ...effectiveAdds().keys()].some((x) => x.toLowerCase() === k);
}

function uniqueKey(base) {
  if (!keyTaken(base)) return base;
  for (const c of 'bcdefghijklmnopqrstuvwxyz') if (!keyTaken(base + c)) return base + c;
  return base + Date.now().toString(36);
}

let addDraft = null;

function askAdd(w) {
  if (!state.gh) { toast('Conecta primero con GitHub en Ajustes.'); return; }
  addDraft = { w, tags: [] };
  els.addEntry.textContent = `${w.authorsShort ? w.authorsShort + ' ' : ''}${w.year ? `(${w.year}) ` : ''}${w.title}`;
  els.addKey.value = uniqueKey(citeKeyFor(w));
  els.addNewTag.value = '';
  els.addNote.value = '';
  els.addError.hidden = true;
  els.addPdfRow.hidden = !w.pdfUrl;
  els.addPdf.checked = !!w.pdfUrl;
  els.addPdfNote.textContent = w.pdfUrl ? ''
    : w.oaUrl ? 'Tiene versión en abierto, pero sin enlace directo al PDF: el Mac no puede descargarlo. Añádelo tú cuando lo tengas.'
      : 'No tiene PDF en abierto. Añádelo tú cuando lo tengas.';
  renderAddTags();
  els.addDialog.showModal();
}

function renderAddTags() {
  const all = [...new Set([...addDraft.tags, ...libraryTags()])];
  els.addTags.innerHTML = all.length
    ? all.map((t) => `<button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="${addDraft.tags.includes(t)}">${esc(t)}</button>`).join('')
    : '<span class="tag-empty">Tu biblioteca todavía no tiene etiquetas.</span>';
}

function takeNewTags() {
  const added = els.addNewTag.value.split(',').map(normalizeTag).filter(Boolean);
  for (const t of added) if (!addDraft.tags.includes(t)) addDraft.tags.push(t);
  els.addNewTag.value = '';
  return added.length;
}

els.addTags.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tag]');
  if (!b) return;
  const t = b.dataset.tag;
  addDraft.tags = addDraft.tags.includes(t) ? addDraft.tags.filter((x) => x !== t) : [...addDraft.tags, t];
  b.setAttribute('aria-pressed', String(addDraft.tags.includes(t)));
});

els.addNewTag.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ',') {
    ev.preventDefault();
    if (takeNewTags()) renderAddTags();
  }
});

els.addKey.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.preventDefault(); });

els.addForm.addEventListener('submit', (ev) => {
  if (ev.submitter?.value !== 'ok') return;
  takeNewTags();
  const key = els.addKey.value.trim();
  const err = !key ? 'Escribe una clave.'
    : !/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(key) ? 'La clave solo puede llevar letras sin acentos, números y los signos _ : . -'
      : keyTaken(key) ? 'Ya hay una referencia o un artículo en la cola con esa clave.' : '';
  if (err) {
    ev.preventDefault();
    els.addError.textContent = err;
    els.addError.hidden = false;
    els.addKey.focus();
  }
});

els.addDialog.addEventListener('close', () => {
  if (els.addDialog.returnValue === 'ok' && addDraft) {
    queueAdd(addDraft.w, els.addKey.value.trim(), addDraft.tags, els.addNote.value, els.addPdf.checked && !els.addPdfRow.hidden);
  }
  addDraft = null;
});

async function queueAdd(w, key, tags, note, downloadPdf) {
  const fields = workToEntry(w, key);
  if (tags.length) fields.source_topic = tags.join(', ');
  if (note.trim()) fields.notes = note.trim();
  const item = {
    format: 1, key, openalex: w.id, fields, bibtex: workToBibtex(w, key),
    pdf_url: downloadPdf ? w.pdfUrl : '', landing_url: w.oaUrl || w.url || '',
    added_at: new Date().toISOString(), device: deviceLabel(),
  };
  state.addOps.push({ op: 'add', key, item });
  await persistAdds();
  renderAll();
  toast('En cola: el Mac lo añadirá en la próxima sincronización');
  pushAdds();
}

async function unqueue(key) {
  state.addOps.push({ op: 'remove', key });
  await persistAdds();
  renderAll();
  toast('Quitado de la cola');
  pushAdds();
}

function queuedNoteHtml(q) {
  const err = state.addsStatus?.[q.key]?.error;
  const when = q.local ? 'Se enviará en cuanto haya conexión.' : 'El Mac lo añadirá a tu biblioteca en la próxima sincronización.';
  return `<div class="queue-note${err ? ' has-error' : ''}">`
    + `<p><strong>En cola para añadir</strong> con la clave <code>${esc(q.key)}</code>${q.item?.fields?.source_topic ? `, etiquetas: ${esc(q.item.fields.source_topic)}` : ''}. ${when}</p>`
    + (err ? `<p class="queue-error">El Mac no pudo añadirlo: ${esc(err)}</p>` : '')
    + `<button type="button" class="link-btn" data-act="web-unqueue" data-key="${esc(q.key)}">Quitar de la cola</button></div>`;
}

// ---------------------------------------------------------------- lista

function computeResults() {
  const flags = effectiveFlags();
  let list = state.entries;
  const f = state.filter;
  if (f.kind === 'pdf') list = list.filter(hasPdf);
  else if (f.kind === 'flagged') list = list.filter((e) => flags[e.key]);
  else if (f.kind === 'topic') list = list.filter((e) => e.topics.includes(f.value));
  else if (f.kind === 'author') list = list.filter((e) => e.authorKeys.includes(f.value));
  else if (f.kind === 'year') list = list.filter((e) => e.year === f.value);
  else if (f.kind === 'venue') list = list.filter((e) => e.venueKey === f.value);
  const res = search(list, state.query);
  state.results = sortResults(res, effectiveSort());
}

function effectiveSort() {
  const hasQuery = !!state.query.trim();
  const mode = state.sortChoice || (hasQuery ? 'relevance' : 'year-desc');
  return mode === 'relevance' && !hasQuery ? 'year-desc' : mode;
}

function renderSort() {
  const hasQuery = !!state.query.trim();
  els.sort.closest('.sort').hidden = false;
  els.sort.querySelector('option[value="relevance"]').disabled = !hasQuery;
  els.sort.value = effectiveSort();
}

function renderFilters() {
  if (state.mode === 'web') { renderWebFilters(); return; }
  if (state.mode === 'discover') { renderDiscFilters(); return; }
  const flags = effectiveFlags();
  const nFlag = state.entries.filter((e) => flags[e.key]).length;
  const nPdf = state.entries.filter(hasPdf).length;
  const topics = new Map();
  for (const e of state.entries) for (const t of e.topics) topics.set(t, (topics.get(t) || 0) + 1);
  const f = state.filter;
  const chip = (kind, label, n, value = '') => {
    const on = f.kind === kind && (kind !== 'topic' || f.value === value);
    return `<button type="button" class="chip${kind === 'flagged' ? ' chip-flag' : ''}" aria-pressed="${on}" data-kind="${kind}" data-value="${esc(value)}">${esc(label)}${n != null ? `<span class="chip-n">${n}</span>` : ''}</button>`;
  };
  let html = '';
  const FACETS = { author: 'Autor', year: 'Año', venue: 'Fuente' };
  if (FACETS[f.kind]) {
    const n = state.entries.filter((e) => (f.kind === 'author' ? e.authorKeys.includes(f.value)
      : f.kind === 'year' ? e.year === f.value : e.venueKey === f.value)).length;
    html += `<button type="button" class="chip chip-facet" aria-pressed="true" data-kind="clear" title="Quitar el filtro">`
      + `<span class="chip-k">${FACETS[f.kind]}:</span><span class="chip-v">${esc(f.label)}</span><span class="chip-n">${n}</span>`
      + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
  }
  html += chip('all', 'Todas', null) + chip('pdf', 'Con PDF', nPdf);
  if (nFlag || f.kind === 'flagged') html += chip('flagged', 'Marcadas', nFlag);
  for (const [t, n] of [...topics].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) html += chip('topic', t, n, t);
  els.filters.innerHTML = html;
}

function snippetHtml(e, hit) {
  if (!hit) return '';
  const sn = snippet(hit.field === 'abstract' ? e.abstract : e.notes, hit.token);
  if (!sn) return '';
  const label = hit.field === 'abstract' ? 'Resumen' : 'Notas';
  return `<span class="row-snippet"><span class="row-snippet-label">${label}:</span> ${esc(sn.pre)}${sn.hit ? `<mark>${esc(sn.hit)}</mark>` : ''}${esc(sn.post)}</span>`;
}

function rowHtml(e, flags, hit = null) {
  const flagged = !!flags[e.key];
  const pdf = hasPdf(e);
  const offline = pdf && state.cached.has(e.key);
  const sel = e.key === state.selectedKey;
  return `<li><button type="button" class="row${flagged ? ' is-flagged' : ''}" data-key="${esc(e.key)}"${sel ? ' aria-current="true"' : ''}>`
    + `<span class="row-year">${esc(e.year || '—')}</span>`
    + `<span class="row-body"><span class="row-title"><span class="hl">${esc(e.title)}</span></span>`
    + `<span class="row-sub"><span class="row-authors">${esc(e.authorsShort || 'Sin autor')}</span>${e.venue ? `<span class="row-venue">${esc(e.venue)}</span>` : ''}</span>`
    + snippetHtml(e, hit) + `</span>`
    + `<span class="row-marks">${pdf ? `<span class="mark-pdf${offline ? ' is-offline' : ''}" title="${offline ? 'PDF guardado en este dispositivo' : 'Tiene PDF'}">PDF</span>` : ''}</span>`
    + `</button></li>`;
}

function renderList() {
  renderTabBadge();
  if (state.mode === 'web') { renderWebList(); return; }
  if (state.mode === 'discover') { renderDiscList(); return; }
  computeResults();
  renderSort();
  const flags = effectiveFlags();
  const n = state.results.length;
  const total = state.entries.length;
  els.count.textContent = !total ? '' : n === total ? `${total} referencias` : `${n} de ${total}`;
  if (!total) {
    els.results.innerHTML = '';
    return;
  }
  if (!n) {
    const q = state.query.trim();
    els.results.innerHTML = `<li class="empty">${q
      ? `Nada coincide con «${esc(q)}». Prueba con el apellido del autor, el año o una etiqueta.`
      : 'No hay referencias con este filtro.'}</li>`;
    return;
  }
  els.results.innerHTML = state.results.map((r) => rowHtml(r.entry, flags, r.hiddenHit)).join('');
}

function renderStatus() {
  const nQueue = effectiveAdds().size;
  const queueText = nQueue ? ` ${nQueue === 1 ? '1 artículo en cola para añadir.' : `${nQueue} artículos en cola para añadir.`}` : '';
  if (state.mode === 'web') {
    els.status.textContent = `Resultados de OpenAlex${state.settings?.openalexKey ? '' : ' (sin clave)'}.${queueText}`;
    els.status.dataset.tone = '';
    return;
  }
  if (state.mode === 'discover') {
    const d = state.disc;
    els.status.textContent = (d.loading ? 'Buscando novedades…'
      : d.at ? `Novedades de OpenAlex, actualizadas ${formatTime(d.at)}.` : 'Novedades de OpenAlex.') + queueText;
    els.status.dataset.tone = '';
    return;
  }
  const pending = state.pending.length;
  const pendingText = pending ? ` ${pending === 1 ? '1 marca pendiente de enviar.' : `${pending} marcas pendientes de enviar.`}` : '';
  let text;
  let tone = '';
  if (!state.settings) text = 'Sin conectar.';
  else if (state.syncing) text = 'Actualizando…';
  else if (state.syncError) {
    const offline = !navigator.onLine || state.syncError.status === 0;
    text = offline ? 'Sin conexión. Estás viendo la copia guardada.' : state.syncError.message;
    tone = offline ? 'offline' : 'error';
  } else if (state.lastSync) text = `Actualizado ${formatTime(state.lastSync)}.`;
  else text = '';
  els.status.textContent = text + pendingText + queueText;
  els.status.dataset.tone = tone;
}

// ---------------------------------------------------------------- ficha

function renderDetail({ animateFlag } = {}) {
  if (state.mode !== 'library') { renderWorkDetail(); return; }
  const e = state.byKey.get(state.selectedKey);
  if (!e) {
    els.detail.innerHTML = state.entries.length
      ? `<div class="detail-empty"><p>Elige una referencia para ver su ficha.</p>${isMacDesktop() ? '<p class="hint">Pulsa <kbd>/</kbd> para buscar y las flechas para moverte por la lista.</p>' : ''}</div>`
      : setupHtml();
    return;
  }
  const flags = effectiveFlags();
  const flag = flags[e.key];
  const pdf = hasPdf(e);
  const src = sourceLine(e);
  const facet = (kind, value, label, text = label) =>
    `<button type="button" class="facet" data-act="facet" data-kind="${kind}" data-value="${esc(value)}" data-label="${esc(label)}" title="Ver todas las referencias de ${kind === 'year' ? 'este año' : kind === 'author' ? 'este autor' : 'esta fuente'}">${esc(text)}</button>`;
  const kind = [e.typeLabel ? esc(e.typeLabel) : '', e.year ? facet('year', e.year, e.year) : ''].filter(Boolean).join(', ');
  const names = e.authors.map((a, i) => facet('author', e.authorKeys[i], a.first ? `${a.first} ${a.last}` : a.last));
  const byHtml = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  const link = e.doi
    ? `<a class="entry-link" href="https://doi.org/${esc(e.doi)}" target="_blank" rel="noopener">doi.org/${esc(e.doi)}</a>`
    : e.url ? `<a class="entry-link" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : '';
  const source = src.map((s, i) => (i === 0 && e.venue ? `<cite>${e.venueKey ? facet('venue', e.venueKey, e.venue) : esc(s)}</cite>` : esc(s))).join(', ');

  els.detail.innerHTML = `
    <article class="entry${flag ? ' is-flagged' : ''}${animateFlag === e.key ? ' flag-animate' : ''}">
      <button type="button" class="back" data-act="back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>anaquel
      </button>
      ${kind || e.topics.length ? `<div class="entry-meta">
        ${kind ? `<span class="entry-kind">${kind}</span>` : ''}
        ${e.topics.map((t) => `<button type="button" class="tag" data-act="facet" data-kind="topic" data-value="${esc(t)}" data-label="${esc(t)}" title="Ver todas las referencias con esta etiqueta">${esc(t)}</button>`).join('')}
      </div>` : ''}
      <h2 class="entry-title"><span class="hl">${esc(e.title)}</span></h2>
      ${byHtml ? `<p class="entry-authors">${byHtml}${e.editorsOnly ? ' (ed.)' : ''}</p>` : ''}
      ${source || link ? `<p class="entry-source">${source}${source && link ? '. ' : ''}${link}</p>` : ''}

      <div class="entry-actions">
        <button type="button" class="btn primary" data-act="pdf"${pdf ? '' : ' disabled'}>${pdf ? 'Abrir PDF' : 'Sin PDF'}</button>
        ${flag
          ? '<button type="button" class="btn flag-on" data-act="unflag">Quitar marca</button>'
          : '<button type="button" class="btn" data-act="flag">Marcar para editar</button>'}
        <button type="button" class="btn key-btn" data-act="copy-key" title="Copiar la clave" aria-label="Copiar la clave ${esc(e.key)}">
          <span class="key-text">${esc(e.key)}</span>
          <svg class="i-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
          <svg class="i-done" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
        </button>
      </div>

      ${flag ? `<p class="flag-note"><strong>Marcada para editar</strong> desde ${esc(flag.device || 'otro dispositivo')}${flag.at ? ` ${esc(formatTime(flag.at))}` : ''}${flag.note ? `: ${esc(flag.note)}` : '.'}</p>` : ''}

      ${oaLinksHtml(e)}

      <details class="entry-bib">
        <summary>BibTeX</summary>
        <pre>${esc(toBibtex(e))}</pre>
      </details>

      ${e.abstract ? `<section class="entry-section"><h3>Resumen</h3><p class="prose">${highlightTerms(e.abstract)}</p></section>` : ''}
      ${e.notes ? `<section class="entry-section"><h3>Notas</h3><p class="prose">${highlightTerms(e.notes)}</p></section>` : ''}
      ${e.keywords.length ? `<p class="entry-keywords"><span>Palabras clave:</span> ${esc(e.keywords.join(', '))}</p>` : ''}
    </article>`;
  loadOaInfo(e);
}

/** Resalta en el texto las palabras de la búsqueda actual (sin distinguir acentos). */
function highlightTerms(text) {
  const tokens = fold(state.query).split(/\s+/).filter((t) => t.length > 1);
  const folded = fold(text);
  if (!tokens.length || folded.length !== text.length) return esc(text);
  const ranges = [];
  for (const t of tokens) {
    let i = folded.indexOf(t);
    while (i !== -1) { ranges.push([i, i + t.length]); i = folded.indexOf(t, i + t.length); }
  }
  if (!ranges.length) return esc(text);
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    out += esc(text.slice(pos, a)) + `<mark>${esc(text.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(text.slice(pos));
}

function setupHtml() {
  if (!state.settings) {
    return `<div class="detail-empty setup">
      <h2>Conecta tu biblioteca</h2>
      <p>Esta app lee la copia de tu biblioteca que el Mac sube a un repositorio privado de GitHub.</p>
      <button type="button" class="btn primary" data-act="settings">Conectar con GitHub</button>
    </div>`;
  }
  if (state.syncing) return '<div class="detail-empty"><p>Cargando la biblioteca…</p></div>';
  if (state.syncError) return `<div class="detail-empty"><p>${esc(state.syncError.message)}</p><button type="button" class="btn" data-act="refresh">Reintentar</button></div>`;
  return '<div class="detail-empty"><p>La biblioteca está vacía.</p></div>';
}

function renderAll(opts) {
  renderFilters();
  renderList();
  renderDetail(opts);
  renderStatus();
  els.viewerFlag.classList.toggle('is-on', !!(state.viewerKey && effectiveFlags()[state.viewerKey]));
}

// ---------------------------------------------------------------- navegación

function select(key, { push = true, focusDetail = false } = {}) {
  state.selectedKey = key;
  for (const b of els.results.querySelectorAll('.row[aria-current]')) b.removeAttribute('aria-current');
  const row = els.results.querySelector(`.row[data-key="${CSS.escape(key)}"]`);
  row?.setAttribute('aria-current', 'true');
  renderDetail();
  if (!wide.matches) {
    els.app.dataset.view = 'detail';
    els.detail.scrollTop = 0;
    if (push) history.pushState({ key }, '');
  }
  if (focusDetail) els.detail.focus({ preventScroll: true });
}

function backToList() {
  els.app.dataset.view = 'list';
  const row = state.mode !== 'library'
    ? els.results.querySelector(`.row[data-wid="${CSS.escape(workBucket().selectedId || '')}"]`)
    : els.results.querySelector(`.row[data-key="${CSS.escape(state.selectedKey || '')}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function moveSelection(delta) {
  if (state.mode !== 'library') {
    const list = state.mode === 'discover' ? discVisible().map((x) => x.w) : state.web.results;
    if (!list.length) return;
    const i = list.findIndex((w) => w.id === workBucket().selectedId);
    const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
    if (!next) return;
    selectWork(next.id, { push: false });
    els.results.querySelector(`.row[data-wid="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!state.results.length) return;
  const idx = state.results.findIndex((r) => r.entry.key === state.selectedKey);
  const next = state.results[Math.min(state.results.length - 1, Math.max(0, idx + delta))];
  if (!next) return;
  select(next.entry.key, { push: false });
  els.results.querySelector(`.row[data-key="${CSS.escape(next.entry.key)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- marcas

function askFlag(key) {
  const e = state.byKey.get(key);
  if (!e) return;
  els.flagDialogEntry.textContent = `${e.authorsShort ? e.authorsShort + ' ' : ''}${e.year ? `(${e.year}) ` : ''}${e.title}`;
  els.flagNote.value = '';
  els.flagDialog.dataset.key = key;
  els.flagDialog.showModal();
  setTimeout(() => els.flagNote.focus(), 50);
}

els.flagDialog.addEventListener('close', () => {
  if (els.flagDialog.returnValue === 'ok') setFlag(els.flagDialog.dataset.key, els.flagNote.value);
});

// ---------------------------------------------------------------- lector de PDF

function showProgress(text, pct) {
  els.viewerProgress.hidden = false;
  els.viewerProgressText.textContent = text;
  els.viewerProgressFill.style.width = pct == null ? '0' : `${Math.round(pct * 100)}%`;
  els.viewerProgress.classList.toggle('indeterminate', pct == null);
}

async function readWithProgress(res, total, onProgress) {
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  return new Blob(chunks, { type: 'application/pdf' });
}

async function getPdfBlob(e, { onProgress, signal } = {}) {
  const info = pdfInfo(e);
  if (!info) throw new Error('Esta referencia no tiene PDF en el repositorio.');
  let blob = await store.getPdf(e.key, state.tree ? info.sha : null);
  if (blob) return blob;
  if (!state.gh || !navigator.onLine) throw new Error('Este PDF no está guardado en el dispositivo y ahora no hay conexión.');
  const res = await state.gh.blob(info.sha, signal);
  blob = await readWithProgress(res, info.size, onProgress || (() => {}));
  blob = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
  await store.putPdf(e.key, info.sha, blob);
  state.cached.set(e.key, info.sha);
  return blob;
}

async function openPdf(key) {
  const e = state.byKey.get(key);
  if (!e) return;
  state.viewerKey = key;
  els.viewerTitle.textContent = `${e.authorsShort ? e.authorsShort + ', ' : ''}${e.year ? e.year + '. ' : ''}${e.title}`;
  els.viewerFlag.classList.toggle('is-on', !!effectiveFlags()[key]);
  els.viewer.hidden = false;
  document.body.classList.add('viewer-open');
  showProgress('Abriendo…', null);
  downloadAbort?.abort();
  downloadAbort = new AbortController();
  try {
    const blob = await getPdfBlob(e, {
      signal: downloadAbort.signal,
      onProgress: (p) => showProgress(`Descargando ${Math.round(p * 100)} %`, p),
    });
    if (state.viewerKey !== key) return;
    state.viewerBlob = blob;
    if (!viewer) {
      const { PdfViewer } = await import('./pdfviewer.js');
      viewer = new PdfViewer(els.viewerScroll, els.viewerPages, { onZoom: (z) => { els.zoomLabel.textContent = `${Math.round(z * 100)} %`; } });
    }
    await viewer.open(new Uint8Array(await blob.arrayBuffer()));
    els.zoomLabel.textContent = '100 %';
    els.viewerProgress.hidden = true;
    renderList();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn(err);
    showProgress(err instanceof GitHubError || err.message ? err.message : 'No se pudo abrir el PDF.', 0);
    els.viewerProgress.classList.add('is-error');
  }
}

async function closeViewer() {
  downloadAbort?.abort();
  els.viewer.hidden = true;
  els.viewerProgress.classList.remove('is-error');
  document.body.classList.remove('viewer-open');
  state.viewerKey = null;
  state.viewerBlob = null;
  await viewer?.close();
}

async function shareViewerPdf() {
  const e = state.byKey.get(state.viewerKey);
  if (!e || !state.viewerBlob) return;
  const file = new File([state.viewerBlob], `${e.key}.pdf`, { type: 'application/pdf' });
  if (isMacDesktop()) {
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return;
  }
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: e.title }); } catch { /* cancelado */ }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

els.viewer.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-v]');
  if (!b) return;
  const v = b.dataset.v;
  if (v === 'close') closeViewer();
  else if (v === 'zoom-in') viewer?.zoomIn();
  else if (v === 'zoom-out') viewer?.zoomOut();
  else if (v === 'zoom-fit') viewer?.zoomFit();
  else if (v === 'share') shareViewerPdf();
  else if (v === 'flag' && state.viewerKey) {
    if (effectiveFlags()[state.viewerKey]) clearFlag(state.viewerKey); else askFlag(state.viewerKey);
  }
});

// Pellizcar para ampliar (Safari en iPhone/iPad y trackpad del Mac).
let gestureBase = 1;
els.viewerScroll.addEventListener('gesturestart', (ev) => { ev.preventDefault(); gestureBase = 1; });
els.viewerScroll.addEventListener('gesturechange', (ev) => {
  ev.preventDefault();
  gestureBase = ev.scale;
  els.viewerPages.style.transform = `scale(${ev.scale})`;
});
els.viewerScroll.addEventListener('gestureend', (ev) => {
  ev.preventDefault();
  els.viewerPages.style.transform = '';
  if (viewer && Math.abs(gestureBase - 1) > 0.05) viewer.setZoom(viewer.zoom * gestureBase);
});
els.viewerScroll.addEventListener('wheel', (ev) => {
  if (!ev.ctrlKey || !viewer) return;   // pellizco en trackpad fuera de Safari
  ev.preventDefault();
  clearTimeout(els.viewerScroll.wheelT);
  els.viewerScroll.wheelZ = (els.viewerScroll.wheelZ || 1) * Math.exp(-ev.deltaY / 200);
  els.viewerPages.style.transform = `scale(${els.viewerScroll.wheelZ})`;
  els.viewerScroll.wheelT = setTimeout(() => {
    els.viewerPages.style.transform = '';
    viewer.setZoom(viewer.zoom * els.viewerScroll.wheelZ);
    els.viewerScroll.wheelZ = 1;
  }, 180);
}, { passive: false });

// ---------------------------------------------------------------- ajustes

function openSettings({ firstRun = false } = {}) {
  const s = state.settings || {};
  $('#set-owner').value = s.owner || '';
  $('#set-repo').value = s.repo || 'anaquel-datos';
  $('#set-branch').value = s.branch || 'main';
  $('#set-token').value = '';
  $('#set-token').required = !s.token;
  $('#set-openalex').value = s.openalexKey || '';
  els.settingsTitle.textContent = state.settings ? 'Ajustes' : 'Conectar con GitHub';
  $('#settings-save').textContent = state.settings ? 'Guardar' : 'Conectar';
  $('#settings-cancel').hidden = firstRun && !state.settings;
  els.settingsError.hidden = true;
  els.settingsExtra.hidden = !state.settings;
  updateOfflineSummary();
  els.settingsDialog.showModal();
}

async function updateOfflineSummary() {
  const withPdf = state.entries.filter(hasPdf);
  const saved = withPdf.filter((e) => state.cached.has(e.key)).length;
  const est = await store.storageEstimate();
  els.offlineSummary.textContent = withPdf.length
    ? `${saved} de ${withPdf.length} PDFs guardados en este dispositivo${est?.usage ? ` (${formatMB(est.usage)} en uso)` : ''}. Los que abres se guardan solos.`
    : 'Los PDFs que abres se guardan en este dispositivo.';
  els.btnSaveAll.hidden = !withPdf.length || saved === withPdf.length;
}

els.settingsForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const owner = $('#set-owner').value.trim();
  const repo = $('#set-repo').value.trim();
  const branch = $('#set-branch').value.trim() || 'main';
  const token = $('#set-token').value.trim() || state.settings?.token || '';
  const openalexKey = $('#set-openalex').value.trim();
  if (!owner || !repo || !token) return;
  const next = { ...(state.settings || {}), owner, repo, branch, token, openalexKey };
  const btn = $('#settings-save');
  btn.disabled = true;
  btn.textContent = 'Comprobando…';
  els.settingsError.hidden = true;
  try {
    const gh = makeClient(next);
    await gh.repoInfo();
    if (openalexKey && openalexKey !== state.settings?.openalexKey) {
      // Consulta individual: comprueba la clave sin gastar presupuesto.
      try {
        await new OpenAlex({ apiKey: openalexKey, base: localStorage.getItem('anaquel.openalexBase') || undefined })
          .get('/works/W2169879729', { select: 'id' });
      } catch (err) {
        throw new Error(err.status === 401 || err.status === 403
          ? 'OpenAlex no acepta esta clave. Cópiala de nuevo desde openalex.org/settings/api, o deja el campo vacío para buscar sin clave.'
          : err.message);
      }
    }
    const sameRepo = state.settings && state.settings.owner === owner && state.settings.repo === repo && state.settings.branch === branch;
    if (!sameRepo) {
      state.libSha = null; state.flagsSha = null; state.tree = null; state.flags = {}; state.pending = [];
      state.adds = new Map(); state.addOps = []; state.addsStatus = {}; state.addsStatusSha = null;
      Object.assign(state.disc, { items: [], at: 0, newIds: new Set(), selectedId: null }); state.discDismissed = new Set();
      state.entries = []; state.byKey = new Map(); state.selectedKey = null;
      await store.clearData();
    }
    state.settings = next;
    state.gh = gh;
    store.saveSettings(next);
    els.settingsDialog.close();
    await store.requestPersistence();
    await refresh();
    if (!state.syncError) toast(`Conectado: ${state.entries.length} referencias`);
  } catch (err) {
    els.settingsError.textContent = err.message || 'No se pudo conectar.';
    els.settingsError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = state.settings ? 'Guardar' : 'Conectar';
  }
});

$('#settings-cancel').addEventListener('click', () => els.settingsDialog.close());

els.btnSaveAll.addEventListener('click', async () => {
  const todo = state.entries.filter((e) => {
    const info = pdfInfo(e);
    return info && state.cached.get(e.key) !== info.sha;
  });
  if (!todo.length) return;
  els.btnSaveAll.disabled = true;
  els.offlineProgress.hidden = false;
  let done = 0;
  let failed = 0;
  for (const e of todo) {
    els.btnSaveAll.textContent = `Guardando ${done + 1} de ${todo.length}…`;
    try { await getPdfBlob(e); } catch { failed++; }
    done++;
    els.offlineProgressFill.style.width = `${(done / todo.length) * 100}%`;
  }
  els.btnSaveAll.disabled = false;
  els.btnSaveAll.textContent = 'Guardar todos los PDFs';
  els.offlineProgress.hidden = true;
  toast(failed ? `${todo.length - failed} PDFs guardados; ${failed} no se pudieron descargar` : `${todo.length} PDFs guardados en este dispositivo`);
  updateOfflineSummary();
  renderList();
});

$('#btn-forget').addEventListener('click', async () => {
  if (!confirm('Se borrarán el token, la copia de la biblioteca y los PDFs guardados en este dispositivo. Tu biblioteca en GitHub y en OneDrive no se toca.')) return;
  store.clearSettings();
  await Promise.all([store.clearData(), store.clearPdfs()]);
  location.reload();
});

// ---------------------------------------------------------------- eventos

let searchT;
els.q.addEventListener('input', () => {
  if (state.mode === 'web') { state.web.query = els.q.value; return; }   // en OpenAlex se busca al pulsar Intro
  if (state.mode === 'discover') {
    clearTimeout(searchT);
    searchT = setTimeout(() => { state.disc.query = els.q.value; renderDiscList(); els.results.scrollTop = 0; }, 80);
    return;
  }
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    state.query = els.q.value;
    renderList();
    els.results.scrollTop = 0;
  }, 80);
});

els.q.addEventListener('keydown', (ev) => {
  if (state.mode === 'discover') {
    if (ev.key === 'Enter') { ev.preventDefault(); els.q.blur(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSelection(state.disc.selectedId ? 1 : 0); }
    else if (ev.key === 'Escape' && els.q.value) { els.q.value = ''; state.disc.query = ''; renderDiscList(); }
    return;
  }
  if (state.mode === 'web') {
    if (ev.key === 'Enter') { ev.preventDefault(); runWebSearch(); if (!wide.matches) els.q.blur(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSelection(state.web.selectedId ? 1 : 0); }
    else if (ev.key === 'Escape' && els.q.value) { els.q.value = ''; state.web.query = ''; }
    return;
  }
  if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSelection(state.selectedKey ? 1 : 0); }
  else if (ev.key === 'Enter' && state.results.length) {
    ev.preventDefault();
    const key = state.selectedKey || state.results[0].entry.key;
    select(key);
    els.q.blur();
  } else if (ev.key === 'Escape' && els.q.value) { els.q.value = ''; state.query = ''; renderList(); }
});

els.sort.addEventListener('change', () => {
  if (state.mode === 'discover') {
    state.disc.sort = els.sort.value;
    renderDiscList();
    els.results.scrollTop = 0;
    return;
  }
  if (state.mode === 'web') {
    const prev = state.web.sort;
    state.web.sort = els.sort.value;
    state.web.sortAuto = false;
    const sameSet = (prev === 'relevance' && state.web.sort === 'affinity') || state.web.searchMode === 'semantic';
    if (state.web.sort === 'affinity' && sameSet && state.web.results.length && !state.web.context) {
      applyAffinity();
      renderWebList();
    } else if (state.web.searched && (state.web.context || !['author', 'journal'].includes(state.web.searchMode))) {
      runWebSearch();
    }
    return;
  }
  // Elegir «Más recientes» sin búsqueda equivale al modo automático.
  state.sortChoice = els.sort.value === 'year-desc' && !state.query.trim() ? null : els.sort.value;
  renderList();
  els.results.scrollTop = 0;
});

els.filters.addEventListener('click', (ev) => {
  const b = ev.target.closest('.chip');
  if (!b) return;
  if (state.mode === 'web') { handleWebFilter(b); return; }
  if (state.mode === 'discover') { handleDiscFilter(b); return; }
  const kind = b.dataset.kind;
  const value = b.dataset.value || '';
  const same = state.filter.kind === kind && state.filter.value === value;
  state.filter = same || kind === 'all' || kind === 'clear' ? { kind: 'all', value: '', label: '' } : { kind, value, label: value };
  renderFilters();
  renderList();
  els.results.scrollTop = 0;
});

els.results.addEventListener('click', (ev) => {
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'web-more') { runWebSearch({ append: true }); return; }
  if (act === 'web-retry') { runWebSearch({ append: false, retry: true }); return; }
  if (act === 'disc-retry') { loadFeed({ force: true }); return; }
  const row = ev.target.closest('.row');
  if (!row) return;
  if (suppressRowClick) { suppressRowClick = false; ev.preventDefault(); return; }
  if (row.dataset.aid) {
    const a = state.web.authors.find((x) => x.id === row.dataset.aid);
    if (a) showRelated('author', { id: a.id, label: a.name });
    return;
  }
  if (row.dataset.sid) {
    const src = state.web.sources.find((x) => x.id === row.dataset.sid);
    if (src) showRelated('source', { id: src.id, label: src.name });
    return;
  }
  if (row.dataset.wid) selectWork(row.dataset.wid); else select(row.dataset.key);
});

// ---------------------------------------------------------------- menú de la lista (pulsación larga / clic derecho)

const menu = Object.assign(document.createElement('div'), { className: 'ctx-menu', hidden: true });
menu.setAttribute('role', 'menu');
document.body.append(menu);
let pressTimer = null;
let pressOrigin = null;
let suppressRowClick = false;

function openMenu(row, x, y, { fromTouch = false } = {}) {
  if (row.dataset.aid || row.dataset.sid) return;
  const item = (m, label) => `<button type="button" role="menuitem" data-m="${m}">${label}</button>`;
  if (row.dataset.wid) {
    const w = workList().find((r) => r.id === row.dataset.wid);
    if (!w) return;
    const inLib = findInLibrary(w, state.libIndex);
    menu.dataset.key = '';
    menu.dataset.wid = w.id;
    menu.innerHTML = `<p class="ctx-title">${esc(w.authorsShort ? `${w.authorsShort}${w.year ? ` (${w.year})` : ''}` : w.title)}</p>`
      + item('w-bib', 'Copiar BibTeX') + (w.doi ? item('w-doi', 'Copiar DOI') : '')
      + (w.url ? item('w-web', w.doi ? 'Ver en la editorial' : 'Ver en la web') : '')
      + (inLib ? item('w-lib', 'Ver en mi biblioteca') : queuedFor(w) ? '' : item('w-add', 'Añadir a la biblioteca…'))
      + (state.mode === 'discover' ? item('w-hide', 'No me interesa') : '');
  } else {
    const e = state.byKey.get(row.dataset.key);
    if (!e) return;
    menu.dataset.key = e.key;
    menu.dataset.wid = '';
    const label = e.authorsShort ? `${e.authorsShort}${e.year ? ` (${e.year})` : ''}` : e.key;
    menu.innerHTML = `<p class="ctx-title">${esc(label)}</p>` + item('bib', 'Copiar BibTeX') + item('key', 'Copiar clave')
      + (hasPdf(e) ? item('pdf', 'Abrir PDF') : '');
  }
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(Math.max(8, fromTouch ? x - w / 2 : x), innerWidth - w - 8);
  let top = fromTouch ? y - h - 14 : y;          // con el dedo, encima para que no lo tape
  if (top < 8) top = Math.min(y + 14, innerHeight - h - 8);
  if (top + h > innerHeight - 8) top = innerHeight - h - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  row.classList.add('is-pressed');
  if (!fromTouch) menu.querySelector('button')?.focus({ preventScroll: true });
}

function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  for (const r of els.results.querySelectorAll('.row.is-pressed')) r.classList.remove('is-pressed');
}

menu.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-m]');
  if (!b) return;
  if (menu.dataset.wid) {
    const w = workList().find((r) => r.id === menu.dataset.wid);
    closeMenu();
    if (!w) return;
    if (b.dataset.m === 'w-bib') await copy(workToBibtex(w), 'BibTeX copiado');
    else if (b.dataset.m === 'w-doi') await copy(w.doi, 'DOI copiado');
    else if (b.dataset.m === 'w-web') window.open(w.url, '_blank', 'noopener');
    else if (b.dataset.m === 'w-lib') openInLibrary(findInLibrary(w, state.libIndex));
    else if (b.dataset.m === 'w-add') askAdd(w);
    else if (b.dataset.m === 'w-hide') dismissWork(w.id);
    return;
  }
  const key = menu.dataset.key;
  const e = state.byKey.get(key);
  closeMenu();
  if (!e) return;
  if (b.dataset.m === 'bib') await copy(toBibtex(e), 'BibTeX copiado');
  else if (b.dataset.m === 'key') await copy(key, 'Clave copiada');
  else if (b.dataset.m === 'pdf') openPdf(key);
});

menu.addEventListener('keydown', (ev) => {
  const items = [...menu.querySelectorAll('[data-m]')];
  const i = items.indexOf(document.activeElement);
  if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); }
});

els.results.addEventListener('pointerdown', (ev) => {
  const row = ev.target.closest('.row');
  suppressRowClick = false;
  if (!row || ev.pointerType === 'mouse') return;   // con ratón o trackpad se usa el clic derecho
  pressOrigin = { x: ev.clientX, y: ev.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    suppressRowClick = true;
    openMenu(row, pressOrigin.x, pressOrigin.y, { fromTouch: true });
  }, 500);
});
els.results.addEventListener('pointermove', (ev) => {
  if (pressOrigin && Math.hypot(ev.clientX - pressOrigin.x, ev.clientY - pressOrigin.y) > 10) clearTimeout(pressTimer);
});
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) els.results.addEventListener(t, () => clearTimeout(pressTimer));
els.results.addEventListener('scroll', () => { clearTimeout(pressTimer); closeMenu(); }, { passive: true });
els.results.addEventListener('contextmenu', (ev) => {
  const row = ev.target.closest('.row');
  if (!row) return;
  ev.preventDefault();
  clearTimeout(pressTimer);
  const same = row.dataset.wid ? menu.dataset.wid === row.dataset.wid : menu.dataset.key === row.dataset.key;
  if (menu.hidden || !same) openMenu(row, ev.clientX, ev.clientY, { fromTouch: ev.pointerType === 'touch' });
});
document.addEventListener('pointerdown', (ev) => {
  if (!menu.hidden && !menu.contains(ev.target) && !ev.target.closest('.row.is-pressed')) closeMenu();
}, true);
window.addEventListener('resize', closeMenu);

els.detail.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const key = state.selectedKey;
  const e = state.byKey.get(key);
  switch (b.dataset.act) {
    case 'back': if (history.state?.key || history.state?.wid) history.back(); else backToList(); break;
    case 'pdf': openPdf(key); break;
    case 'flag': askFlag(key); break;
    case 'unflag': clearFlag(key); break;
    case 'copy-key':
      if (await copy(key, 'Clave copiada')) {
        b.classList.add('is-copied');
        setTimeout(() => b.classList.remove('is-copied'), 1400);
      }
      break;
    case 'copy-bib': if (e) await copy(toBibtex(e), 'BibTeX copiado'); break;
    case 'facet': applyFacet(b.dataset.kind, b.dataset.value, b.dataset.label); break;
    case 'oa-cites':
    case 'oa-refs': {
      if (!e) break;
      b.disabled = true;
      const id = await resolveOaWork(e);
      b.disabled = false;
      if (id) showRelated(b.dataset.act === 'oa-cites' ? 'cites' : 'refs', { id, label: entryLabel(e) });
      break;
    }
    case 'web-open-lib': openInLibrary(b.dataset.key); break;
    case 'web-copy-bib': { const w = currentWork(); if (w) await copy(workToBibtex(w), 'BibTeX copiado'); break; }
    case 'web-add': { const w = currentWork(); if (w) askAdd(w); break; }
    case 'disc-hide': { const w = currentWork(); if (w) dismissWork(w.id); break; }
    case 'web-unqueue': unqueue(b.dataset.key); break;
    case 'web-source': {
      const w = currentWork();
      if (w?.sourceId) showRelated('source', { id: w.sourceId, label: w.venue });
      break;
    }
    case 'web-cites':
    case 'web-refs': {
      const w = currentWork();
      if (w) showRelated(b.dataset.act === 'web-cites' ? 'cites' : 'refs', { id: w.id, label: entryLabel(w) });
      break;
    }
    case 'settings': openSettings({ firstRun: true }); break;
    case 'refresh': refresh(); break;
    default: break;
  }
});

/** Filtra la lista por un autor, un año, una fuente o una etiqueta pulsados en la ficha. */
function applyFacet(kind, value, label) {
  state.filter = { kind, value, label };
  els.q.value = '';
  state.query = '';
  renderFilters();
  renderList();
  els.results.scrollTop = 0;
  els.filters.scrollLeft = 0;
  if (!wide.matches) {
    if (history.state?.key) history.back(); else backToList();
  } else {
    els.results.querySelector(`.row[data-key="${CSS.escape(state.selectedKey || '')}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
    return true;
  } catch {
    toast('No se pudo copiar al portapapeles');
    return false;
  }
}

$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-refresh').addEventListener('click', () => {
  if (!state.settings) { openSettings({ firstRun: true }); return; }
  refresh(); pushFlags(); pushAdds();
  if (state.mode === 'discover') loadFeed({ force: true });
});

window.addEventListener('popstate', () => {
  if (!els.viewer.hidden) { closeViewer(); return; }
  if (!wide.matches) backToList();
});

wide.addEventListener('change', () => { if (wide.matches) els.app.dataset.view = 'list'; });

document.addEventListener('keydown', (ev) => {
  if (els.settingsDialog.open || els.flagDialog.open || els.addDialog.open || !menu.hidden) return;
  const typing = ev.target.matches('input, textarea, select');
  if (!els.viewer.hidden) {
    if (ev.key === 'Escape') closeViewer();
    else if ((ev.metaKey || ev.ctrlKey) && (ev.key === '+' || ev.key === '=')) { ev.preventDefault(); viewer?.zoomIn(); }
    else if ((ev.metaKey || ev.ctrlKey) && ev.key === '-') { ev.preventDefault(); viewer?.zoomOut(); }
    else if ((ev.metaKey || ev.ctrlKey) && ev.key === '0') { ev.preventDefault(); viewer?.zoomFit(); }
    return;
  }
  if ((ev.key === '/' && !typing) || ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k')) {
    ev.preventDefault();
    if (!wide.matches) backToList();
    els.q.focus();
    els.q.select();
    return;
  }
  if (typing) return;
  if (ev.key === 'ArrowDown' || ev.key === 'j') { ev.preventDefault(); moveSelection(1); }
  else if (ev.key === 'ArrowUp' || ev.key === 'k') { ev.preventDefault(); moveSelection(-1); }
  else if (state.mode === 'library' && ev.key === 'Enter' && state.selectedKey && hasPdf(state.byKey.get(state.selectedKey))) { ev.preventDefault(); openPdf(state.selectedKey); }
  else if (state.mode === 'library' && ev.key === 'f' && state.selectedKey) {
    ev.preventDefault();
    if (effectiveFlags()[state.selectedKey]) clearFlag(state.selectedKey); else askFlag(state.selectedKey);
  } else if (ev.key === 'Escape' && !wide.matches && els.app.dataset.view === 'detail') backToList();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.gh && (!state.lastSync || Date.now() - state.lastSync > 5 * 60 * 1000)) {
    refresh({ quiet: true });
  }
});

window.addEventListener('online', () => { if (state.gh) { refresh({ quiet: true }); pushFlags(); pushAdds(); } });
window.addEventListener('offline', renderStatus);


// ---------------------------------------------------------------- buscar artículos (OpenAlex)

const LIB_SORTS = [['relevance', 'Más relevantes'], ['year-desc', 'Más recientes'], ['year-asc', 'Más antiguas'], ['author', 'Autor'], ['title', 'Título']];
const WEB_SORTS = [['relevance', 'Más relevantes'], ['affinity', 'Afines a tu biblioteca'], ['cited', 'Más citados'], ['recent', 'Más recientes']];
const MODE_LABELS = { topic: 'Tema', author: 'Autor', journal: 'Revista', semantic: 'Descripción' };
const CONTEXT_LABELS = { cites: 'Citan a', refs: 'Referencias de', author: 'Autor', source: 'Revista' };
const CONTEXT_PLACEHOLDERS = {
  cites: 'Buscar entre los que lo citan', refs: 'Buscar entre sus referencias',
  author: 'Buscar entre sus trabajos', source: 'Buscar en esta revista',
};
const MODE_PLACEHOLDERS = {
  topic: 'Palabras clave o DOI',
  author: 'Nombre o apellido',
  journal: 'Nombre de la revista',
  semantic: 'Una frase o un resumen',
};
let tiesVersion = 0;
let libIdsPromise = null;
const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
let webAbort = null;

function oa() {
  return new OpenAlex({ apiKey: state.settings?.openalexKey || '', base: localStorage.getItem('anaquel.openalexBase') || undefined });
}

const fmtN = (n) => Number(n || 0).toLocaleString('es-ES');
const entryLabel = (x) => `${x.authorsShort || 'Sin autor'}${x.year ? ` (${x.year})` : ''}`;
const workBucket = () => (state.mode === 'discover' ? state.disc : state.web);
const workList = () => (state.mode === 'discover' ? state.disc.items.map((i) => i.work) : state.web.results);
const currentWork = () => workList().find((w) => w.id === workBucket().selectedId) || null;

function setMode(mode) {
  if (state.mode === mode) return;
  closeMenu();
  if (state.mode === 'library') state.query = els.q.value;
  else if (state.mode === 'web') state.web.query = els.q.value;
  else state.disc.query = els.q.value;
  state.mode = mode;
  els.app.dataset.mode = mode;
  for (const b of document.querySelectorAll('.mode-switch [data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  els.q.value = mode === 'library' ? state.query : mode === 'web' ? state.web.query : state.disc.query;
  els.q.placeholder = mode === 'library' ? 'Título, autor, año, etiqueta, clave…' : mode === 'web' ? webPlaceholder() : 'Filtrar las novedades';
  els.q.setAttribute('aria-label', mode === 'library' ? 'Buscar en la biblioteca' : mode === 'web' ? 'Buscar artículos en OpenAlex' : 'Filtrar las novedades');
  els.sort.innerHTML = (mode === 'library' ? LIB_SORTS : mode === 'web' ? WEB_SORTS : DISC_SORTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  els.sort.closest('.sort').hidden = false;
  els.results.scrollTop = 0;
  if (!wide.matches) els.app.dataset.view = 'list';
  renderAll();
  if (mode === 'web') ensureLibraryIds();
  if (mode === 'discover') warmFeed();
}

document.querySelector('.mode-switch').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-mode]');
  if (!b) return;
  setMode(b.dataset.mode);
  if (b.dataset.mode === 'web' && !state.web.searched && wide.matches) els.q.focus();
});

function webPlaceholder() {
  const w = state.web;
  return w.context ? CONTEXT_PLACEHOLDERS[w.context.kind] : MODE_PLACEHOLDERS[w.searchMode];
}

function renderWebFilters() {
  const w = state.web;
  const y = new Date().getFullYear();
  let html = '';
  if (w.context) {
    html += `<button type="button" class="chip chip-facet" aria-pressed="true" data-kind="web-clear" title="Quitar">`
      + `<span class="chip-k">${CONTEXT_LABELS[w.context.kind]}:</span><span class="chip-v">${esc(w.context.label)}</span>${X_ICON}</button>`;
  }
  if (state.mode === 'web') els.q.placeholder = webPlaceholder();
  if (!w.context) {
    for (const [m, label] of Object.entries(MODE_LABELS)) {
      html += `<button type="button" class="chip chip-mode" aria-pressed="${w.searchMode === m}" data-kind="web-mode" data-value="${m}">${label}</button>`;
    }
    html += '<span class="chip-sep" aria-hidden="true"></span>';
  }
  const yearChip = (v, label) => `<button type="button" class="chip" aria-pressed="${w.fromYear === v}" data-kind="web-year" data-value="${v}">${label}</button>`;
  html += yearChip('', 'Cualquier año') + yearChip(String(y - 4), 'Últimos 5 años') + yearChip(String(y - 9), 'Últimos 10 años');
  els.filters.innerHTML = html;
}

function handleWebFilter(b) {
  const w = state.web;
  if (b.dataset.kind === 'web-clear') {
    Object.assign(w, { context: null, results: [], count: 0, searched: false, selectedId: null, error: null, query: '' });
    if (w.sortAuto) { w.sort = 'relevance'; w.sortAuto = false; }
    els.q.value = '';
    renderAll();
    if (wide.matches) els.q.focus();
    return;
  }
  if (b.dataset.kind === 'web-mode') {
    w.searchMode = b.dataset.value;
    renderWebFilters();
    if (els.q.value.trim()) runWebSearch();
    else { Object.assign(w, { results: [], authors: [], sources: [], searched: false, context: null, error: null }); renderWebList(); renderDetail(); }
    if (wide.matches) els.q.focus();
    return;
  }
  if (b.dataset.kind === 'web-year') {
    w.fromYear = b.dataset.value || '';
    renderWebFilters();
    if (w.searched) runWebSearch();
  }
}

function workRowHtml(w, adds, extra = null) {
  const inLib = findInLibrary(w, state.libIndex);
  const queued = !inLib && queuedFor(w, adds);
  const sel = w.id === workBucket().selectedId;
  return `<li><button type="button" class="row row-web${inLib ? ' in-lib' : ''}" data-wid="${esc(w.id)}"${sel ? ' aria-current="true"' : ''}>`
    + (extra && w.date
      ? `<span class="row-year row-day"><span class="d">${Number(w.date.slice(8, 10))}</span>${esc(MONTHS[Number(w.date.slice(5, 7)) - 1] || '')}</span>`
      : `<span class="row-year">${esc(w.year || '—')}</span>`)
    + `<span class="row-body"><span class="row-title">${esc(w.title)}</span>`
    + `<span class="row-sub"><span class="row-authors">${esc(w.authorsShort || 'Sin autor')}</span>${w.venue && state.web.context?.kind !== 'source' ? `<span class="row-venue">${esc(w.venue)}</span>` : ''}</span>`
    + (extra
      ? `<span class="row-meta">${extra.isNew ? '<span class="badge-new">Nuevo</span>' : ''}${w.date ? '' : `<span>${esc(w.year)}</span>`}${queued ? '<span class="badge-queue">En cola</span>' : ''}${w.isOa ? '<span class="badge-oa">Acceso abierto</span>' : ''}</span>${extra.reasons}</span>`
      : `<span class="row-meta">${w.cited ? `${fmtN(w.cited)} ${w.cited === 1 ? 'cita' : 'citas'}` : 'Sin citas'}${queued ? '<span class="badge-queue">En cola</span>' : ''}${w.isOa ? '<span class="badge-oa">Acceso abierto</span>' : ''}${tieReason(w)}</span></span>`)
    + `<span class="row-marks">${inLib ? '<span class="badge-lib" title="Ya está en tu biblioteca" aria-label="Ya está en tu biblioteca"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>' : ''}</span>`
    + `</button></li>`;
}

function renderWebList() {
  const w = state.web;
  const relOff = !!w.context && !w.query;
  // Las listas de autores y revistas no se ordenan: el selector solo sirve para trabajos.
  els.sort.closest('.sort').hidden = !w.context && ['author', 'journal'].includes(w.searchMode) && w.searched;
  els.sort.value = relOff && w.sort === 'relevance' ? 'cited' : w.sort;
  const rel = els.sort.querySelector('option[value="relevance"]');
  if (rel) rel.disabled = relOff;
  if (w.error && !w.results.length) {
    els.count.textContent = '';
    els.results.innerHTML = `<li class="empty">${esc(w.error.message)}<div><button type="button" class="btn" data-act="web-retry">Reintentar</button></div></li>`;
    return;
  }
  if (w.loading && !w.results.length) {
    els.count.textContent = w.context ? 'Cargando…' : 'Buscando…';
    els.results.innerHTML = '';
    return;
  }
  if (!w.searched) {
    els.count.textContent = '';
    els.results.innerHTML = `<li class="empty web-intro">
      <p><strong>Tema:</strong> palabras del título o del resumen, o un DOI. Para una frase exacta, ponla entre comillas: "voiced stops".</p>
      <p><strong>Autor:</strong> busca a una persona y ve todos sus trabajos.</p>
      <p><strong>Revista:</strong> busca una revista y ve todo lo que ha publicado. Con la revista elegida, el buscador busca dentro de ella.</p>
      <p><strong>Descripción:</strong> escribe una frase o pega un resumen entero y encuentra trabajos parecidos.</p>
      <p>Pulsa Intro para buscar. Lo que ya está en tu biblioteca lleva una marca de verificación, y «Afines a tu biblioteca» ordena por cuántas de tus referencias cita cada trabajo.</p></li>`;
    return;
  }
  if (w.searchMode === 'journal' && !w.context) {
    els.count.textContent = w.sources.length ? `${w.sources.length} ${w.sources.length === 1 ? 'revista' : 'revistas'}` : '';
    els.results.innerHTML = w.sources.length
      ? w.sources.map(sourceRowHtml).join('')
      : `<li class="empty">No encuentro revistas llamadas «${esc(w.query)}». Prueba con menos palabras o con el nombre completo.</li>`;
    return;
  }
  if (w.searchMode === 'author' && !w.context) {
    els.count.textContent = w.authors.length ? `${w.authors.length} ${w.authors.length === 1 ? 'autor' : 'autores'}` : '';
    els.results.innerHTML = w.authors.length
      ? w.authors.map(authorRowHtml).join('')
      : `<li class="empty">No encuentro autores llamados «${esc(w.query)}». Prueba con el apellido solo o con nombre y apellido.</li>`;
    return;
  }
  els.count.textContent = `${fmtN(w.count)} ${w.count === 1 ? 'resultado' : 'resultados'}`;
  if (!w.results.length) {
    els.results.innerHTML = `<li class="empty">${w.context ? (w.query ? `Nada coincide con «${esc(w.query)}» en esta lista.` : 'OpenAlex no tiene trabajos en esta lista.') : `Nada coincide con «${esc(w.query)}» en OpenAlex. Prueba con otras palabras o en inglés.`}</li>`;
    return;
  }
  const more = w.searchMode !== 'semantic' || w.context ? w.results.length < Math.min(w.count, 500) : false;
  const moreHtml = more
    ? `<li class="more"><button type="button" class="btn" data-act="web-more"${w.loading ? ' disabled' : ''}>${w.loading ? 'Cargando…' : 'Cargar más resultados'}</button>${w.error ? `<p class="more-error">${esc(w.error.message)}</p>` : ''}</li>`
    : '';
  const adds = effectiveAdds();
  els.results.innerHTML = w.results.map((r) => workRowHtml(r, adds)).join('') + moreHtml;
}

async function runWebSearch({ append = false } = {}) {
  const w = state.web;
  if (!append) {
    const q = els.q.value.trim();
    if (w.context) {
      // Con una lista activa (revista, autor, citas), el buscador busca dentro de ella.
      if (w.sortAuto) w.sort = q ? 'relevance' : (w.context.kind === 'cites' || w.context.kind === 'refs' ? 'cited' : 'recent');
      w.query = q;
    } else if (q) {
      w.query = q;
    }
    w.authors = [];
    w.sources = [];
    if (!w.context && !w.query) return;
    w.page = 1;
    w.results = [];
    w.selectedId = null;
  } else {
    w.page += 1;
  }
  const ctrl = new AbortController();
  webAbort?.abort();
  webAbort = ctrl;
  w.loading = true;
  w.error = null;
  w.searched = true;
  renderWebFilters();
  renderWebList();
  if (!append) { renderDetail(); els.results.scrollTop = 0; }
  try {
    const apiSort = w.sort === 'affinity' ? (w.context && !w.query ? 'cited' : 'relevance') : w.sort;
    const opts = { sort: apiSort, fromYear: w.fromYear, page: w.page, signal: ctrl.signal };
    let res;
    if (w.context) {
      const listOpts = { ...opts, query: w.query };
      res = w.context.kind === 'author' ? await oa().byAuthor(w.context.id, listOpts)
        : w.context.kind === 'source' ? await oa().bySource(w.context.id, listOpts)
          : await oa().related(w.context.id, w.context.kind, listOpts);
    } else if (w.searchMode === 'journal') {
      w.sources = rankSources(await oa().searchSources(w.query, { signal: ctrl.signal }));
      res = { count: 0, results: [] };
    } else if (w.searchMode === 'author') {
      w.authors = rankAuthors(await oa().searchAuthors(w.query, { signal: ctrl.signal }));
      res = { count: 0, results: [] };
    } else if (w.searchMode === 'topic' && asDoi(w.query)) {
      try {
        res = { count: 1, results: [await oa().byDoi(asDoi(w.query), { signal: ctrl.signal })] };
      } catch (err) {
        if (err.status !== 404) throw err;
        res = { count: 0, results: [] };
      }
    } else res = await oa().search(w.query, { ...opts, mode: w.searchMode });
    if (webAbort !== ctrl) return;
    w.count = res.count;
    const seen = new Set(w.results.map((x) => x.id));
    w.results = w.results.concat(res.results.filter((x) => !seen.has(x.id)));
    if (w.sort === 'affinity') applyAffinity();
  } catch (err) {
    if (err.name === 'AbortError' || webAbort !== ctrl) return;
    w.error = err;
    if (append) w.page -= 1;
  }
  ensureLibraryIds();
  w.loading = false;
  renderWebList();
  renderStatus();
}

function selectWork(id, { push = true } = {}) {
  workBucket().selectedId = id;
  if (state.mode === 'discover' && state.disc.newIds.delete(id)) {
    els.results.querySelector(`.row[data-wid="${CSS.escape(id)}"] .badge-new`)?.remove();
    persistFeed();
    renderTabBadge();
  }
  for (const b of els.results.querySelectorAll('.row[aria-current]')) b.removeAttribute('aria-current');
  els.results.querySelector(`.row[data-wid="${CSS.escape(id)}"]`)?.setAttribute('aria-current', 'true');
  renderDetail();
  if (!wide.matches) {
    els.app.dataset.view = 'detail';
    els.detail.scrollTop = 0;
    if (push) history.pushState({ wid: id }, '');
  }
}

function renderWorkDetail() {
  const w = currentWork();
  if (!w && state.mode === 'discover') {
    els.detail.innerHTML = `<div class="detail-empty disc-about"><p>Novedades de los últimos tres meses elegidas a partir de tu biblioteca: trabajos que citan tus referencias, trabajos nuevos de los autores que más tienes y artículos de tus revistas sobre tus temas.</p><p>Se actualizan solas cada 12 horas. Las que no habías visto llevan la etiqueta «Nuevo».</p></div>`;
    return;
  }
  if (!w) {
    const sw = state.web;
    const hint = !sw.searched ? 'Los resultados de la búsqueda aparecerán en la lista.'
      : !sw.context && sw.searchMode === 'journal' ? 'Elige una revista para ver todo lo que ha publicado.'
        : !sw.context && sw.searchMode === 'author' ? 'Elige a una persona para ver sus trabajos.'
          : 'Elige un resultado para ver su ficha.';
    els.detail.innerHTML = `<div class="detail-empty"><p>${hint}</p></div>`;
    return;
  }
  const inLib = findInLibrary(w, state.libIndex);
  const kind = [w.typeLabel, w.year].filter(Boolean).join(', ');
  const vol = w.volume ? (w.issue ? `${w.volume}(${w.issue})` : w.volume) : '';
  const venueHtml = !w.venue ? ''
    : w.sourceId ? `<cite><button type="button" class="facet" data-act="web-source" title="Ver todo lo publicado en esta revista">${esc(w.venue)}</button></cite>`
      : `<cite>${esc(w.venue)}</cite>`;
  const source = [venueHtml, esc(vol), esc(w.pages)].filter(Boolean).join(', ');
  const link = w.doi ? `<a class="entry-link" href="https://doi.org/${esc(w.doi)}" target="_blank" rel="noopener">doi.org/${esc(w.doi)}</a>` : '';
  const names = w.authors.map((a) => (a.first ? `${a.first} ${a.last}` : a.last));
  const by = names.length > 12 ? `${names.slice(0, 10).join(', ')} y ${names.length - 10} más`
    : names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  const openUrl = w.pdfUrl || (w.oaUrl && w.oaUrl !== w.url ? w.oaUrl : '');
  const queued = inLib ? null : queuedFor(w);
  const primaryTaken = !!inLib || !queued;
  els.detail.innerHTML = `
    <article class="entry entry-web">
      <button type="button" class="back" data-act="back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>${state.mode === 'discover' ? 'Novedades' : 'Resultados'}
      </button>
      <div class="entry-meta">
        ${kind ? `<span class="entry-kind">${esc(state.mode === 'discover' && w.date ? [w.typeLabel, fmtDate(w.date)].filter(Boolean).join(', ') : kind)}</span>` : ''}
        ${inLib ? '<span class="badge-lib-lg">En tu biblioteca</span>' : ''}
        ${queued ? '<span class="badge-queue badge-queue-lg">En cola</span>' : ''}
        ${w.isOa ? '<span class="badge-oa">Acceso abierto</span>' : ''}
      </div>
      <h2 class="entry-title">${esc(w.title)}</h2>
      ${by ? `<p class="entry-authors">${esc(by)}</p>` : ''}
      ${source || link ? `<p class="entry-source">${source}${source && link ? '. ' : ''}${link}</p>` : ''}

      <div class="entry-actions">
        ${inLib ? `<button type="button" class="btn primary" data-act="web-open-lib" data-key="${esc(inLib)}">Ver en mi biblioteca</button>` : ''}
        ${!inLib && !queued ? '<button type="button" class="btn primary" data-act="web-add">Añadir a la biblioteca</button>' : ''}
        ${openUrl ? `<a class="btn${primaryTaken ? '' : ' primary'}" href="${esc(openUrl)}" target="_blank" rel="noopener">${w.pdfUrl ? 'PDF en abierto' : 'Versión en abierto'}</a>` : ''}
        ${w.url ? `<a class="btn${primaryTaken || openUrl ? '' : ' primary'}" href="${esc(w.url)}" target="_blank" rel="noopener">${w.doi ? 'Ver en la editorial' : 'Ver en la web'}</a>` : ''}
        <button type="button" class="btn" data-act="web-copy-bib">Copiar BibTeX</button>
      </div>

      ${queued ? queuedNoteHtml(queued) : ''}
      ${state.mode === 'discover' ? discWhyHtml(w) : tiesHtml(w)}

      <div class="entry-links">
        <span class="entry-links-label">En OpenAlex</span>
        <button type="button" class="link-btn" data-act="web-cites"${w.cited ? '' : ' disabled'}>Quién lo cita <span class="n">${fmtN(w.cited)}</span></button>
        <button type="button" class="link-btn" data-act="web-refs"${w.refs ? '' : ' disabled'}>Qué cita <span class="n">${fmtN(w.refs)}</span></button>
      </div>

      <details class="entry-bib">
        <summary>BibTeX</summary>
        <pre>${esc(workToBibtex(w))}</pre>
      </details>

      ${w.abstract
        ? `<section class="entry-section"><h3>Resumen</h3><p class="prose">${esc(w.abstract)}</p></section>`
        : '<p class="entry-note">OpenAlex no tiene el resumen de este trabajo.</p>'}
    </article>`;
}

function openInLibrary(key) {
  if (!key || !state.byKey.has(key)) return;
  setMode('library');
  select(key);
  els.results.querySelector(`.row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** Carga en la lista los trabajos que citan a una referencia (cites) o los que esta cita (refs). */
function showRelated(kind, ref) {
  const fromDetail = !wide.matches && els.app.dataset.view === 'detail';
  if (state.mode !== 'web') setMode('web');
  const w = state.web;
  w.context = { kind, id: ref.id, label: ref.label };
  if (w.sort === 'relevance' || w.sortAuto) {
    w.sort = kind === 'author' || kind === 'source' ? 'recent' : 'cited';
    w.sortAuto = true;
  }
  els.q.value = '';
  w.query = '';
  runWebSearch();
  if (fromDetail || !wide.matches) {
    if (history.state?.key || history.state?.wid) history.back(); else backToList();
  }
}


// Afinidad con la biblioteca: cuántas de tus referencias cita un trabajo y qué autores compartís.

function libraryTies(w) {
  if (w._ties && w._tiesV === tiesVersion) return w._ties;
  const byId = state.libOa?.byId;
  const cited = byId ? [...new Set(w.refIds.filter((id) => byId.has(id)).map((id) => byId.get(id)))] : [];
  const authors = w.authors.filter((a) => state.libAuthors.has(authorKey(a))).map((a) => a.last);
  const venue = !!(w.venue && state.libVenues.has(venueKey(w.venue)));
  w._ties = { cited, authors, venue, score: cited.length * 3 + Math.min(authors.length, 3) * 2 + (venue ? 1 : 0) };
  w._tiesV = tiesVersion;
  return w._ties;
}

function tieReason(w) {
  const t = libraryTies(w);
  if (t.cited.length) return `<span class="reason">Cita ${t.cited.length} de tu biblioteca</span>`;
  if (t.authors.length) return `<span class="reason">${t.authors.length > 1 ? 'Autores' : 'Autor'} en tu biblioteca: ${esc(t.authors.slice(0, 2).join(', '))}</span>`;
  return '';
}

function tiesHtml(w) {
  const t = libraryTies(w);
  const parts = [];
  if (t.cited.length) {
    const shown = t.cited.slice(0, 6).map((k) => {
      const e = state.byKey.get(k);
      return `<button type="button" class="facet" data-act="web-open-lib" data-key="${esc(k)}">${esc(e ? entryLabel(e) : k)}</button>`;
    });
    const rest = t.cited.length - shown.length;
    parts.push(`Cita ${t.cited.length === 1 ? 'un trabajo' : `${t.cited.length} trabajos`} de tu biblioteca: ${shown.join(', ')}${rest > 0 ? ` y ${rest} más` : ''}.`);
  }
  if (t.authors.length) parts.push(`${t.authors.length > 1 ? 'Autores' : 'Autor'} que ya tienes en tu biblioteca: ${esc(t.authors.join(', '))}.`);
  return parts.length ? `<p class="entry-affinity">${parts.join(' ')}</p>` : '';
}

/** Orden «Afines a tu biblioteca»: por vínculos con tus referencias, sin perder el orden de relevancia en los empates. */
function applyAffinity() {
  const w = state.web;
  const order = new Map(w.results.map((r, i) => [r.id, i]));
  w.results = [...w.results].sort((a, b) => libraryTies(b).score - libraryTies(a).score || order.get(a.id) - order.get(b.id));
}

/** Revistas: primero las que ya aparecen en tu biblioteca; después, revistas antes que repositorios u otras fuentes. */
function rankSources(list) {
  const typeBonus = { journal: 100, conference: 50, 'book series': 40 };
  return list
    .map((x, i) => {
      const inLib = state.libVenues.get(venueKey(x.name)) || 0;
      return { ...x, inLib, _s: (inLib ? 1000 + inLib : 0) + (typeBonus[x.type] || 0) - i * 0.01 };
    })
    .sort((a, b) => b._s - a._s);
}

const SOURCE_TYPES = { conference: 'Congreso', repository: 'Repositorio', 'book series': 'Colección', ebook_platform: 'Libros', metadata: 'Índice' };
const SOURCE_STOP = /^(the|and|of|for|on|in|des|der|die|del|de|la|el|los|las|und|et|journal|revista)$/i;

function sourceRowHtml(x) {
  const words = x.name.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const main = words.filter((t) => !SOURCE_STOP.test(t));
  const pick = main.length >= 2 ? main : words.filter((t) => !/^(the|of|for|on|in|and|de|del|la|el)$/i.test(t));
  const initials = (pick.slice(0, 2).map((t) => t[0]).join('') || '?').toUpperCase();
  const type = SOURCE_TYPES[x.type] || '';
  const meta = [`${fmtN(x.works)} ${x.works === 1 ? 'trabajo' : 'trabajos'}`]
    .concat(type ? `<span class="badge-oa">${type}</span>` : [])
    .concat(x.inLib ? `<span class="reason">${x.inLib} en tu biblioteca</span>` : []);
  return `<li><button type="button" class="row row-author row-source" data-sid="${esc(x.id)}">`
    + `<span class="author-avatar source-avatar" aria-hidden="true">${esc(initials)}</span>`
    + `<span class="row-body"><span class="row-title">${esc(x.name)}</span>`
    + `<span class="row-sub"><span class="row-authors">${esc(x.publisher || (x.issn ? `ISSN ${x.issn}` : 'Editorial sin datos'))}</span></span>`
    + `<span class="row-meta">${meta.join('')}</span>`
    + `</span><span class="row-marks">${x.inLib ? '<span class="badge-lib" title="Tienes artículos de esta revista"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>' : ''}</span>`
    + `</button></li>`;
}

/** Autores: primero los que ya están en tu biblioteca y los que trabajan en lenguaje o habla. */
function rankAuthors(list) {
  const LANG = /lingu|phonet|phonol|language|speech|prosod|spanish|hispan|syntax|semantic|morpholog|dialect|bilingual/i;
  return list
    .map((a, i) => {
      const [parsed] = parseAuthors(a.name);
      const inLib = parsed ? state.libAuthors.get(authorKey(parsed)) || 0 : 0;
      const lang = a.topics.some((t) => LANG.test(t));
      return { ...a, inLib, lang, _s: (inLib ? 1000 + inLib : 0) + (lang ? 100 : 0) - i * 0.01 };
    })
    .sort((x, y) => y._s - x._s);
}

function authorRowHtml(a) {
  const initials = a.name.split(/\s+/).filter(Boolean).map((p) => p[0]).filter((c) => /\p{L}/u.test(c)).slice(0, 2).join('').toUpperCase();
  return `<li><button type="button" class="row row-author" data-aid="${esc(a.id)}">`
    + `<span class="author-avatar" aria-hidden="true">${esc(initials)}</span>`
    + `<span class="row-body"><span class="row-title">${esc(a.name)}</span>`
    + `<span class="row-sub"><span class="row-authors">${esc(a.institution || 'Institución desconocida')}</span></span>`
    + `<span class="row-meta">${fmtN(a.works)} ${a.works === 1 ? 'trabajo' : 'trabajos'}${a.inLib ? `<span class="reason">${a.inLib} en tu biblioteca</span>` : ''}</span>`
    + (a.topics.length ? `<span class="row-snippet">${esc(a.topics.slice(0, 2).join('; '))}</span>` : '')
    + `</span><span class="row-marks">${a.inLib ? '<span class="badge-lib" title="Tienes trabajos suyos"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>' : ''}</span>`
    + `</button></li>`;
}

/** Busca (una vez por versión de la biblioteca) el identificador de OpenAlex de tus referencias con DOI. */
const LIB_CACHE_V = 2;

/**
 * Enlaza las referencias con OpenAlex (por DOI) y arma el perfil de la biblioteca: autores, revistas y temas.
 * Guarda cada DOI ya consultado, así que después de una sincronización solo se consultan los nuevos.
 */
function ensureLibraryIds() {
  if (!state.entries.length || !navigator.onLine) return null;
  const sha = state.libSha || 'local';
  if (state.libOa?.sha === sha) return null;
  if (libIdsPromise) return libIdsPromise;
  libIdsPromise = (async () => {
    let cache = await store.get('oaLibCache');
    if (cache?.v !== LIB_CACHE_V) cache = { v: LIB_CACHE_V, byDoi: {} };
    const now = Date.now();
    const withDoi = state.entries.filter((e) => e.doi);
    const todo = [...new Set(withDoi.map((e) => e.doi.toLowerCase()))].filter((d) => {
      const c = cache.byDoi[d];
      return !c || (c.miss && now - c.miss > 7 * 864e5);   // los que OpenAlex no conocía se reintentan cada semana
    });
    if (todo.length) {
      const recs = await oa().libraryRecords(todo);
      for (const d of todo) cache.byDoi[d] = recs.get(d) || { miss: now };
      await store.set('oaLibCache', cache);
    }
    state.libOa = buildLibProfile(sha, withDoi, cache.byDoi);
    tiesVersion++;
    if (state.mode === 'web') {
      if (state.web.sort === 'affinity') applyAffinity();
      renderWebList();
      renderDetail();
    } else if (state.mode === 'discover') {
      renderDiscList();
    }
  })().catch((err) => console.warn('No se pudieron enlazar las referencias con OpenAlex', err)).finally(() => { libIdsPromise = null; });
  return libIdsPromise;
}

function buildLibProfile(sha, withDoi, byDoi) {
  const pairs = [];
  const citedById = new Map();
  const authors = new Map();
  const sources = new Map();
  const topics = new Map();
  const bump = (m, [id, name]) => {
    const x = m.get(id) || { name, n: 0 };
    x.n++;
    m.set(id, x);
  };
  for (const e of withDoi) {
    const r = byDoi[e.doi.toLowerCase()];
    if (!r || r.miss) continue;
    pairs.push([r.id, e.key]);
    citedById.set(r.id, r.cited || 0);
    for (const a of r.authors || []) bump(authors, a);
    if (r.source) bump(sources, r.source);
    if (r.topic) bump(topics, r.topic);
  }
  return { sha, byId: new Map(pairs), byKey: new Map(pairs.map(([id, k]) => [k, id])), citedById, authors, sources, topics };
}

// Citas de las referencias de la biblioteca

function oaLinksHtml(e) {
  const info = state.oaInfo.get(e.key);
  const n = (v) => (typeof v === 'number' ? ` <span class="n">${fmtN(v)}</span>` : '');
  return `<div class="entry-links" data-oa-key="${esc(e.key)}">
        <span class="entry-links-label">En OpenAlex</span>
        <button type="button" class="link-btn" data-act="oa-cites"${info && !info.cited ? ' disabled' : ''}>Quién lo cita${n(info?.cited)}</button>
        <button type="button" class="link-btn" data-act="oa-refs"${info && !info.refs ? ' disabled' : ''}>Qué cita${n(info?.refs)}</button>
      </div>`;
}

/** Con DOI, consulta (gratis) el trabajo en OpenAlex para mostrar cuántas citas y referencias tiene. */
async function loadOaInfo(e) {
  if (!e?.doi || state.oaInfo.has(e.key) || !navigator.onLine) return;
  state.oaInfo.set(e.key, undefined);
  try {
    const w = await oa().byDoi(e.doi);
    state.oaInfo.set(e.key, { id: w.id, cited: w.cited, refs: w.refs });
  } catch {
    state.oaInfo.delete(e.key);
    return;
  }
  const el = els.detail.querySelector(`.entry-links[data-oa-key="${CSS.escape(e.key)}"]`);
  if (el && state.mode === 'library' && state.selectedKey === e.key) el.outerHTML = oaLinksHtml(e);
}

/** Identificador de OpenAlex de una referencia: por DOI o, si no tiene, buscando su título. */
async function resolveOaWork(e) {
  const known = state.oaInfo.get(e.key);
  if (known?.id) return known.id;
  const fromLib = state.libOa?.byKey.get(e.key);
  if (fromLib) return fromLib;
  try {
    if (e.doi) {
      const w = await oa().byDoi(e.doi);
      state.oaInfo.set(e.key, { id: w.id, cited: w.cited, refs: w.refs });
      return w.id;
    }
    const { results } = await oa().search(e.title, { perPage: 5 });
    const t = titleKey(e.title);
    const y = Number(e.year) || 0;
    const hit = results.find((r) => titleKey(r.title) === t && (!y || !r.year || Math.abs(Number(r.year) - y) <= 1));
    if (hit) {
      state.oaInfo.set(e.key, { id: hit.id, cited: hit.cited, refs: hit.refs });
      return hit.id;
    }
    toast('No encuentro esta referencia en OpenAlex');
  } catch (err) {
    toast(err.message || 'No se pudo consultar OpenAlex');
  }
  return null;
}

// ---------------------------------------------------------------- arranque

async function start() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker', err));
  }
  await loadLocal();
  if (state.settings?.token) state.gh = makeClient(state.settings);
  renderAll();
  if (!state.settings) {
    openSettings({ firstRun: true });
    return;
  }
  await refresh({ quiet: !!state.entries.length });
  if (state.pending.length) pushFlags();
}

start();
