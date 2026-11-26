// Lector de PDF basado en PDF.js: páginas en columna, renderizado bajo demanda y capa de texto seleccionable.

import * as pdfjsLib from '../pdfjs/pdf.min.mjs';

const VENDOR = new URL('../pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';

const MAX_CANVAS_PIXELS = 12_000_000;   // límite prudente para iPhone/iPad
const KEEP_RENDERED = 6;                // páginas con canvas en memoria
const PAGE_GAP = 14;

export class PdfViewer {
  constructor(scrollEl, pagesEl, { onZoom } = {}) {
    this.scrollEl = scrollEl;
    this.pagesEl = pagesEl;
    this.onZoom = onZoom || (() => {});
    this.doc = null;
    this.zoom = 1;
    this.pages = [];          // [{n, el, w, h, rendered, task}]
    this.rendered = new Set();
    this.observer = new IntersectionObserver((entries) => this.#onIntersect(entries), {
      root: scrollEl, rootMargin: '600px 0px',
    });
    this.resizeObserver = new ResizeObserver(() => this.#scheduleRelayout());
    this.resizeObserver.observe(scrollEl);
    this.lastWidth = 0;
  }

  async open(data) {
    await this.close();
    const task = pdfjsLib.getDocument({
      data,
      cMapUrl: VENDOR + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: VENDOR + 'standard_fonts/',
      wasmUrl: VENDOR + 'wasm/',
      iccUrl: VENDOR + 'iccs/',
      isEvalSupported: false,
      enableXfa: false,
    });
    this.loadingTask = task;
    this.doc = await task.promise;
    this.zoom = 1;
    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.baseSize = { w: vp.width, h: vp.height };
    this.pages = [];
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= this.doc.numPages; n++) {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = n;
      el.setAttribute('aria-label', `Página ${n} de ${this.doc.numPages}`);
      this.pages.push({ n, el, w: vp.width, h: vp.height, rendered: false, task: null, sized: n === 1 });
      frag.append(el);
    }
    this.pagesEl.append(frag);
    this.#layout();
    for (const p of this.pages) this.observer.observe(p.el);
    this.scrollEl.scrollTop = 0;
    return this.doc.numPages;
  }

  async close() {
    this.observer.disconnect();
    for (const p of this.pages) p.task?.cancel();
    this.pages = [];
    this.rendered.clear();
    this.pagesEl.replaceChildren();
    if (this.loadingTask) { try { await this.loadingTask.destroy(); } catch { /* nada */ } }
    this.loadingTask = null;
    this.doc = null;
  }

  availableWidth() {
    return Math.max(200, this.scrollEl.clientWidth - 2 * PAGE_GAP);
  }

  /** Escala CSS para que la página quepa a lo ancho, por el zoom del usuario. */
  scaleFor(p) {
    return (this.availableWidth() / p.w) * this.zoom;
  }

  #layout() {
    for (const p of this.pages) {
      const s = this.scaleFor(p);
      p.el.style.width = `${Math.floor(p.w * s)}px`;
      p.el.style.height = `${Math.floor(p.h * s)}px`;
    }
    this.lastWidth = this.scrollEl.clientWidth;
  }

  #scheduleRelayout() {
    if (!this.doc || Math.abs(this.scrollEl.clientWidth - this.lastWidth) < 8) return;
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => this.#rerenderAll(), 150);
  }

  #onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const p = this.pages[Number(entry.target.dataset.page) - 1];
      if (p && !p.rendered) this.#render(p);
    }
  }

  async #render(p) {
    if (!this.doc || p.rendered) return;
    p.rendered = true;
    this.rendered.add(p.n);
    this.#evict(p.n);
    try {
      const page = await this.doc.getPage(p.n);
      const vp1 = page.getViewport({ scale: 1 });
      if (!p.sized) { p.w = vp1.width; p.h = vp1.height; p.sized = true; }
      const scale = this.scaleFor(p);
      const viewport = page.getViewport({ scale });
      p.el.style.width = `${Math.floor(viewport.width)}px`;
      p.el.style.height = `${Math.floor(viewport.height)}px`;
      p.el.style.setProperty('--scale-factor', scale);
      p.el.style.setProperty('--total-scale-factor', scale);

      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const ratio = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';

      p.task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await p.task.promise;
      if (!p.rendered) { canvas.width = canvas.height = 0; return; }
      p.el.replaceChildren(canvas, textDiv);
      try {
        const textLayer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
        await textLayer.render();
      } catch { /* sin capa de texto: el PDF se sigue viendo */ }
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('Error al dibujar la página', p.n, err);
      p.rendered = false;
      this.rendered.delete(p.n);
    } finally {
      p.task = null;
    }
  }

  /** Libera el canvas de las páginas más lejanas para no agotar la memoria del iPhone. */
  #evict(current) {
    if (this.rendered.size <= KEEP_RENDERED) return;
    const far = [...this.rendered].sort((a, b) => Math.abs(b - current) - Math.abs(a - current));
    while (this.rendered.size > KEEP_RENDERED && far.length) {
      const n = far.shift();
      if (Math.abs(n - current) <= 2) break;
      const p = this.pages[n - 1];
      p.task?.cancel();
      for (const c of p.el.querySelectorAll('canvas')) { c.width = 0; c.height = 0; }
      p.el.replaceChildren();
      p.rendered = false;
      this.rendered.delete(n);
    }
  }

  currentPage() {
    const mid = this.scrollEl.scrollTop + this.scrollEl.clientHeight / 3;
    for (const p of this.pages) if (p.el.offsetTop + p.el.offsetHeight > mid) return p.n;
    return 1;
  }

  async #rerenderAll() {
    if (!this.doc) return;
    const n = this.currentPage();
    const p = this.pages[n - 1];
    const offset = p ? (this.scrollEl.scrollTop - p.el.offsetTop) / Math.max(1, p.el.offsetHeight) : 0;
    for (const q of this.pages) {
      q.task?.cancel();
      for (const c of q.el.querySelectorAll('canvas')) { c.width = 0; c.height = 0; }
      q.el.replaceChildren();
      q.rendered = false;
    }
    this.rendered.clear();
    this.#layout();
    if (p) this.scrollEl.scrollTop = p.el.offsetTop + offset * p.el.offsetHeight;
    // El IntersectionObserver no vuelve a avisar de lo que ya era visible.
    for (const q of this.pages) { this.observer.unobserve(q.el); this.observer.observe(q.el); }
    this.onZoom(this.zoom);
  }

  setZoom(z) {
    const next = Math.min(4, Math.max(0.5, Math.round(z * 100) / 100));
    if (next === this.zoom) return;
    this.zoom = next;
    this.#rerenderAll();
  }

  zoomIn() { this.setZoom(this.zoom * 1.25); }
  zoomOut() { this.setZoom(this.zoom / 1.25); }
  zoomFit() { this.setZoom(1); }
}
