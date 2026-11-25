import { GitHub, GitHubError } from './github.js';
import * as store from './store.js';
import { normalizeEntry, search, sortResults, sourceLine, authorsFull, toBibtex } from './library.js';

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
  cached: new Map(),       // PDFs guardados en el dispositivo: clave → sha
  query: '',
  filter: { kind: 'all', topic: '' },
  sortChoice: null,        // null = automático (relevancia si hay búsqueda, si no, más recientes)
  results: [],
  selectedKey: null,
  lastSync: null,
  syncing: false,
  syncError: null,
  viewerKey: null,
  viewerBlob: null,
};

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#app'), q: $('#q'), filters: $('#filters'), count: $('#count'), sort: $('#sort'), results: $('#results'),
  detail: $('#detail'), status: $('#sync-status'), toast: $('#toast'),
  viewer: $('#viewer'), viewerTitle: $('#viewer-title'), viewerScroll: $('#viewer-scroll'), viewerPages: $('#viewer-pages'),
  viewerProgress: $('#viewer-progress'), viewerProgressFill: $('#viewer-progress-fill'), viewerProgressText: $('#viewer-progress-text'),
  viewerFlag: $('#viewer-flag'), zoomLabel: $('#zoom-label'),
  flagDialog: $('#flag-dialog'), flagNote: $('#flag-note'), flagDialogEntry: $('#flag-dialog-entry'),
  settingsDialog: $('#settings-dialog'), settingsForm: $('#settings-form'), settingsError: $('#settings-error'),
  settingsTitle: $('#settings-title'), settingsExtra: $('#settings-extra'), offlineSummary: $('#offline-summary'),
  offlineProgress: $('#offline-progress'), offlineProgressFill: $('#offline-progress-fill'),
  btnSaveAll: $('#btn-save-all'),
};

const wide = matchMedia('(min-width: 820px)');
let viewer = null;          // PdfViewer, se carga al abrir el primer PDF
let downloadAbort = null;
let flagChain = Promise.resolve();

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
  const [lib, meta, tree, flags, pending, cached] = await Promise.all([
    store.get('library'), store.get('meta'), store.get('tree'), store.get('flags'), store.get('pendingFlags'), store.cachedPdfs(),
  ]);
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
    state.lastSync = Date.now();
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

// ---------------------------------------------------------------- lista

function computeResults() {
  const flags = effectiveFlags();
  let list = state.entries;
  const f = state.filter;
  if (f.kind === 'pdf') list = list.filter(hasPdf);
  else if (f.kind === 'flagged') list = list.filter((e) => flags[e.key]);
  else if (f.kind === 'topic') list = list.filter((e) => e.topics.includes(f.topic));
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
  els.sort.querySelector('option[value="relevance"]').disabled = !hasQuery;
  els.sort.value = effectiveSort();
}

function renderFilters() {
  const flags = effectiveFlags();
  const nFlag = state.entries.filter((e) => flags[e.key]).length;
  const nPdf = state.entries.filter(hasPdf).length;
  const topics = new Map();
  for (const e of state.entries) for (const t of e.topics) topics.set(t, (topics.get(t) || 0) + 1);
  const f = state.filter;
  const chip = (kind, label, n, topic = '') => {
    const on = f.kind === kind && (kind !== 'topic' || f.topic === topic);
    return `<button type="button" class="chip${kind === 'flagged' ? ' chip-flag' : ''}" aria-pressed="${on}" data-kind="${kind}" data-topic="${esc(topic)}">${esc(label)}${n != null ? `<span class="chip-n">${n}</span>` : ''}</button>`;
  };
  let html = chip('all', 'Todas', null) + chip('pdf', 'Con PDF', nPdf);
  if (nFlag || f.kind === 'flagged') html += chip('flagged', 'Marcadas', nFlag);
  for (const [t, n] of [...topics].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) html += chip('topic', t, n, t);
  els.filters.innerHTML = html;
}

function rowHtml(e, flags) {
  const flagged = !!flags[e.key];
  const pdf = hasPdf(e);
  const offline = pdf && state.cached.has(e.key);
  const sel = e.key === state.selectedKey;
  return `<li><button type="button" class="row${flagged ? ' is-flagged' : ''}" data-key="${esc(e.key)}"${sel ? ' aria-current="true"' : ''}>`
    + `<span class="row-year">${esc(e.year || '—')}</span>`
    + `<span class="row-body"><span class="row-title"><span class="hl">${esc(e.title)}</span></span>`
    + `<span class="row-sub"><span class="row-authors">${esc(e.authorsShort || 'Sin autor')}</span>${e.venue ? `<span class="row-venue">${esc(e.venue)}</span>` : ''}</span></span>`
    + `<span class="row-marks">${pdf ? `<span class="mark-pdf${offline ? ' is-offline' : ''}" title="${offline ? 'PDF guardado en este dispositivo' : 'Tiene PDF'}">PDF</span>` : ''}</span>`
    + `</button></li>`;
}

function renderList() {
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
  els.results.innerHTML = state.results.map((r) => rowHtml(r.entry, flags)).join('');
}

function renderStatus() {
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
  els.status.textContent = text + pendingText;
  els.status.dataset.tone = tone;
}

// ---------------------------------------------------------------- ficha

function renderDetail({ animateFlag } = {}) {
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
  const by = authorsFull(e.authors);
  const rawRows = Object.entries(e.raw)
    .filter(([k]) => !k.startsWith('_'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  els.detail.innerHTML = `
    <article class="entry${flag ? ' is-flagged' : ''}${animateFlag === e.key ? ' flag-animate' : ''}">
      <button type="button" class="back" data-act="back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>anaquel
      </button>
      <p class="entry-kind">${esc([e.typeLabel, e.year].filter(Boolean).join(', '))}</p>
      <h2 class="entry-title"><span class="hl">${esc(e.title)}</span></h2>
      ${by ? `<p class="entry-authors">${esc(by)}${e.editorsOnly ? ' (ed.)' : ''}</p>` : ''}
      ${src.length ? `<p class="entry-source">${src.map((s, i) => (i === 0 && e.venue ? `<cite>${esc(s)}</cite>` : esc(s))).join(', ')}</p>` : ''}

      <div class="entry-actions">
        <button type="button" class="btn primary" data-act="pdf"${pdf ? '' : ' disabled'}>${pdf ? 'Abrir PDF' : 'Sin PDF'}</button>
        ${flag
          ? '<button type="button" class="btn flag-on" data-act="unflag">Quitar marca</button>'
          : '<button type="button" class="btn" data-act="flag">Marcar para editar</button>'}
        <button type="button" class="btn quiet" data-act="copy-key">Copiar clave</button>
        <button type="button" class="btn quiet" data-act="copy-bib">Copiar BibTeX</button>
      </div>

      ${flag ? `<p class="flag-note"><strong>Marcada para editar</strong> desde ${esc(flag.device || 'otro dispositivo')}${flag.at ? ` ${esc(formatTime(flag.at))}` : ''}${flag.note ? `: ${esc(flag.note)}` : '.'}</p>` : ''}

      <dl class="entry-fields">
        <dt>Clave</dt><dd><code>${esc(e.key)}</code></dd>
        ${e.topics.length ? `<dt>Etiquetas</dt><dd class="tags">${e.topics.map((t) => `<button type="button" class="tag" data-act="topic" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}</dd>` : ''}
        ${e.doi ? `<dt>DOI</dt><dd><a href="https://doi.org/${esc(e.doi)}" target="_blank" rel="noopener">${esc(e.doi)}</a></dd>` : ''}
        ${e.url && !e.doi ? `<dt>Enlace</dt><dd><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url.replace(/^https?:\/\//, ''))}</a></dd>` : ''}
        ${e.keywords.length ? `<dt>Palabras clave</dt><dd>${esc(e.keywords.join(', '))}</dd>` : ''}
      </dl>

      ${e.notes ? `<section class="entry-section"><h3>Notas</h3><p class="prose">${esc(e.notes)}</p></section>` : ''}
      ${e.abstract ? `<section class="entry-section"><h3>Resumen</h3><p class="prose">${esc(e.abstract)}</p></section>` : ''}

      <details class="entry-raw">
        <summary>Todos los campos de la base de datos</summary>
        <dl>${rawRows}</dl>
      </details>
    </article>`;
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
  const row = els.results.querySelector(`.row[data-key="${CSS.escape(state.selectedKey || '')}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function moveSelection(delta) {
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
  if (!owner || !repo || !token) return;
  const next = { ...(state.settings || {}), owner, repo, branch, token };
  const btn = $('#settings-save');
  btn.disabled = true;
  btn.textContent = 'Comprobando…';
  els.settingsError.hidden = true;
  try {
    const gh = makeClient(next);
    await gh.repoInfo();
    const sameRepo = state.settings && state.settings.owner === owner && state.settings.repo === repo && state.settings.branch === branch;
    if (!sameRepo) {
      state.libSha = null; state.flagsSha = null; state.tree = null; state.flags = {}; state.pending = [];
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
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    state.query = els.q.value;
    renderList();
    els.results.scrollTop = 0;
  }, 80);
});

els.q.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSelection(state.selectedKey ? 1 : 0); }
  else if (ev.key === 'Enter' && state.results.length) {
    ev.preventDefault();
    const key = state.selectedKey || state.results[0].entry.key;
    select(key);
    els.q.blur();
  } else if (ev.key === 'Escape' && els.q.value) { els.q.value = ''; state.query = ''; renderList(); }
});

els.sort.addEventListener('change', () => {
  // Elegir «Más recientes» sin búsqueda equivale al modo automático.
  state.sortChoice = els.sort.value === 'year-desc' && !state.query.trim() ? null : els.sort.value;
  renderList();
  els.results.scrollTop = 0;
});

els.filters.addEventListener('click', (ev) => {
  const b = ev.target.closest('.chip');
  if (!b) return;
  const kind = b.dataset.kind;
  const topic = b.dataset.topic;
  const same = state.filter.kind === kind && state.filter.topic === topic;
  state.filter = same || kind === 'all' ? { kind: 'all', topic: '' } : { kind, topic };
  renderFilters();
  renderList();
  els.results.scrollTop = 0;
});

els.results.addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (row) select(row.dataset.key);
});

els.detail.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const key = state.selectedKey;
  const e = state.byKey.get(key);
  switch (b.dataset.act) {
    case 'back': if (history.state?.key) history.back(); else backToList(); break;
    case 'pdf': openPdf(key); break;
    case 'flag': askFlag(key); break;
    case 'unflag': clearFlag(key); break;
    case 'copy-key': await copy(key, 'Clave copiada'); break;
    case 'copy-bib': if (e) await copy(toBibtex(e), 'BibTeX copiado'); break;
    case 'topic':
      state.filter = { kind: 'topic', topic: b.dataset.topic };
      renderFilters(); renderList();
      if (!wide.matches) backToList();
      break;
    case 'settings': openSettings({ firstRun: true }); break;
    case 'refresh': refresh(); break;
    default: break;
  }
});

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('No se pudo copiar al portapapeles'); }
}

$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-refresh').addEventListener('click', () => {
  if (!state.settings) openSettings({ firstRun: true }); else { refresh(); pushFlags(); }
});

window.addEventListener('popstate', () => {
  if (!els.viewer.hidden) { closeViewer(); return; }
  if (!wide.matches) backToList();
});

wide.addEventListener('change', () => { if (wide.matches) els.app.dataset.view = 'list'; });

document.addEventListener('keydown', (ev) => {
  if (els.settingsDialog.open || els.flagDialog.open) return;
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
  else if (ev.key === 'Enter' && state.selectedKey && hasPdf(state.byKey.get(state.selectedKey))) { ev.preventDefault(); openPdf(state.selectedKey); }
  else if (ev.key === 'f' && state.selectedKey) {
    ev.preventDefault();
    if (effectiveFlags()[state.selectedKey]) clearFlag(state.selectedKey); else askFlag(state.selectedKey);
  } else if (ev.key === 'Escape' && !wide.matches && els.app.dataset.view === 'detail') backToList();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.gh && (!state.lastSync || Date.now() - state.lastSync > 5 * 60 * 1000)) {
    refresh({ quiet: true });
  }
});

window.addEventListener('online', () => { if (state.gh) { refresh({ quiet: true }); pushFlags(); } });
window.addEventListener('offline', renderStatus);

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
