// Búsqueda de artículos en OpenAlex (https://openalex.org): metadatos abiertos (CC0) de la literatura científica.

import { fold, parseAuthors, authorsShort } from './library.js';

const FIELDS = [
  'id', 'doi', 'display_name', 'publication_year', 'type', 'authorships', 'primary_location',
  'cited_by_count', 'referenced_works_count', 'abstract_inverted_index', 'open_access', 'best_oa_location', 'biblio',
  'referenced_works', 'publication_date', 'primary_topic',
].join(',');

const DOI_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

/** Si el texto es un DOI, lo devuelve normalizado. */
export function asDoi(text) {
  const m = String(text || '').trim().match(DOI_RE);
  return m ? m[1].replace(/[.,;]+$/, '') : '';
}

export class OpenAlexError extends Error {
  constructor(status, reason) {
    super(OpenAlexError.describe(status, reason));
    this.status = status;
  }

  static describe(status, reason) {
    if (status === 0) return 'No hay conexión: la búsqueda de artículos necesita internet.';
    if (status === 401 || status === 403) return 'OpenAlex no acepta la clave guardada en Ajustes. Comprueba que está bien copiada o bórrala para buscar sin clave.';
    if (status === 429 && /budget/i.test(reason)) return 'Se ha agotado el uso gratuito de OpenAlex por hoy. Se renueva a medianoche UTC (las 16:00 en Reno). Con una clave gratuita tendrías diez veces más.';
    if (status === 429) return 'OpenAlex pide ir más despacio. Espera un segundo y vuelve a intentarlo.';
    return `OpenAlex respondió con un error ${status}.`;
  }
}

export class OpenAlex {
  constructor({ apiKey = '', base = 'https://api.openalex.org' } = {}) {
    this.apiKey = apiKey.trim();
    this.base = base.replace(/\/$/, '');
  }

  async get(path, params = {}, { signal } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    let res;
    try {
      res = await fetch(url, { headers, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new OpenAlexError(0);
    }
    if (!res.ok) {
      let reason = '';
      try { const j = await res.json(); reason = j.reason || j.message || j.error || ''; } catch { /* sin cuerpo */ }
      throw new OpenAlexError(res.status, String(reason));
    }
    return res.json();
  }

  /**
   * Búsqueda de trabajos.
   *  mode 'topic': palabras en título y resumen, reordenadas por un modelo (rerank) cuando se ordena por relevancia.
   *  mode 'semantic': búsqueda por significado; mejor con frases largas o un resumen entero (máx. 50 resultados).
   * sort: relevance | affinity | cited | recent (affinity se reordena en la app: aquí equivale a relevancia).
   */
  async search(query, { mode = 'topic', sort = 'relevance', fromYear = '', page = 1, perPage = 25, signal } = {}) {
    const filters = [];
    if (fromYear) filters.push(`publication_year:>${Number(fromYear) - 1}`);
    const byRelevance = sort === 'relevance' || sort === 'affinity';
    const params = { filter: filters.join(','), select: FIELDS };
    if (mode === 'semantic') {
      Object.assign(params, { 'search.semantic': query.slice(0, 2000), per_page: 50 });
    } else {
      Object.assign(params, {
        'search.title_and_abstract': query,
        rerank: byRelevance && page === 1 ? 'true' : '',
        sort: sort === 'cited' ? 'cited_by_count:desc' : sort === 'recent' ? 'publication_date:desc' : '',
        per_page: perPage,
        page,
      });
    }
    const data = await this.get('/works', params, { signal });
    let results = (data.results || []).map(normalizeWork);
    if (mode === 'semantic' && !byRelevance) {
      results = results.sort(sort === 'cited' ? (a, b) => b.cited - a.cited : (a, b) => (b.year || '').localeCompare(a.year || ''));
    }
    return { count: mode === 'semantic' ? results.length : (data.meta?.count || 0), results };
  }

  /** Autores cuyo nombre coincide, con sus temas principales para distinguir homónimos. */
  async searchAuthors(query, { signal } = {}) {
    const data = await this.get('/authors', {
      search: query, per_page: 15, select: 'id,display_name,works_count,cited_by_count,last_known_institutions,topics',
    }, { signal });
    return (data.results || []).map((a) => ({
      id: a.id,
      name: a.display_name,
      works: a.works_count || 0,
      cited: a.cited_by_count || 0,
      institution: a.last_known_institutions?.[0]?.display_name || '',
      topics: (a.topics || []).slice(0, 3).map((t) => t.display_name),
    }));
  }

  /** Revistas, actas y otras fuentes cuyo nombre coincide. */
  async searchSources(query, { signal } = {}) {
    const data = await this.get('/sources', {
      search: query, per_page: 15, select: 'id,display_name,host_organization_name,type,works_count,issn_l,summary_stats',
    }, { signal });
    return (data.results || []).map((x) => ({
      id: x.id,
      name: x.display_name,
      publisher: x.host_organization_name || '',
      type: x.type || '',
      works: x.works_count || 0,
      issn: x.issn_l || '',
      h: x.summary_stats?.h_index || 0,
    }));
  }

  /**
   * Lista filtrada (trabajos de un autor, de una revista, que citan o son citados por otro),
   * con búsqueda opcional dentro de la lista.
   */
  async filtered(filters, { query = '', sort = 'recent', fromYear = '', page = 1, perPage = 25, signal } = {}) {
    const f = [...filters];
    if (fromYear) f.push(`publication_year:>${Number(fromYear) - 1}`);
    const byRelevance = query && (sort === 'relevance' || sort === 'affinity');
    const data = await this.get('/works', {
      filter: f.join(','),
      'search.title_and_abstract': query || '',
      rerank: byRelevance && page === 1 ? 'true' : '',
      sort: byRelevance ? '' : sort === 'cited' || sort === 'affinity' ? 'cited_by_count:desc' : 'publication_date:desc',
      per_page: perPage, page, select: FIELDS,
    }, { signal });
    return { count: data.meta?.count || 0, results: (data.results || []).map(normalizeWork) };
  }

  /** Trabajos de un autor. */
  byAuthor(id, opts = {}) {
    return this.filtered([`authorships.author.id:${id.split('/').pop()}`], opts);
  }

  /** Trabajos publicados en una revista o fuente. */
  bySource(id, opts = {}) {
    return this.filtered([`primary_location.source.id:${id.split('/').pop()}`], opts);
  }

  /** Identificadores de OpenAlex para una lista de DOI (50 por petición; cada una cuesta lo mínimo). */
  async resolveDois(dois, { signal } = {}) {
    const out = new Map();
    const clean = [...new Set(dois.map((d) => d.toLowerCase()).filter((d) => d && !/[|,]/.test(d)))];
    for (let i = 0; i < clean.length; i += 50) {
      const chunk = clean.slice(i, i + 50);
      const data = await this.get('/works', { filter: `doi:${chunk.join('|')}`, per_page: 50, select: 'id,doi' }, { signal });
      for (const w of data.results || []) {
        const doi = (w.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
        if (doi) out.set(doi, w.id.split('/').pop());
      }
    }
    return out;
  }

  /**
   * Para el perfil de la biblioteca: por cada DOI, su id, sus autores, su revista y su tema en OpenAlex.
   * Devuelve un Map doi → registro (solo los DOI que OpenAlex conoce).
   */
  async libraryRecords(dois, { signal } = {}) {
    const out = new Map();
    const clean = [...new Set(dois.map((d) => d.toLowerCase()).filter((d) => d && !/[|,]/.test(d)))];
    for (let i = 0; i < clean.length; i += 50) {
      const chunk = clean.slice(i, i + 50);
      const data = await this.get('/works', {
        filter: `doi:${chunk.join('|')}`, per_page: 50, select: 'id,doi,authorships,primary_location,primary_topic,cited_by_count',
      }, { signal });
      for (const w of data.results || []) {
        const doi = (w.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
        if (!doi) continue;
        const src = w.primary_location?.source;
        out.set(doi, {
          id: w.id.split('/').pop(),
          cited: w.cited_by_count || 0,
          authors: (w.authorships || []).filter((a) => a.author?.id).map((a) => [a.author.id.split('/').pop(), a.author.display_name || '']),
          source: src?.id ? [src.id.split('/').pop(), src.display_name || ''] : null,
          topic: w.primary_topic?.id ? [w.primary_topic.id.split('/').pop(), w.primary_topic.display_name || ''] : null,
        });
      }
    }
    return out;
  }

  /**
   * Novedades para «Descubrir», publicadas desde `fromDate` (AAAA-MM-DD):
   *  - cites: trabajos que citan alguna referencia de la biblioteca;
   *  - author: trabajos nuevos de los autores que más aparecen en ella;
   *  - journal: artículos de sus revistas sobre sus temas.
   * Devuelve un Map id → { work, via: Set }.
   */
  async discover({ libIds = [], authorIds = [], sourceIds = [], topicIds = [], fromDate, signal } = {}) {
    const base = [`from_publication_date:${fromDate}`, 'type:article|book-chapter|preprint|dissertation|book|review', 'is_retracted:false'];
    const jobs = [];
    for (let i = 0; i < libIds.length; i += 100) jobs.push(['cites', [`cites:${libIds.slice(i, i + 100).join('|')}`]]);
    if (authorIds.length) jobs.push(['author', [`authorships.author.id:${authorIds.join('|')}`]]);
    if (sourceIds.length && topicIds.length) {
      jobs.push(['journal', [`primary_location.source.id:${sourceIds.join('|')}`, `primary_topic.id:${topicIds.join('|')}`]]);
    }
    const out = new Map();
    const run = async ([via, filters]) => {
      for (let page = 1; page <= 3; page++) {
        const data = await this.get('/works', {
          filter: [...filters, ...base].join(','), sort: 'publication_date:desc', per_page: 100, page, select: FIELDS,
        }, { signal });
        for (const raw of data.results || []) {
          const id = raw.id;
          if (!out.has(id)) out.set(id, { work: normalizeWork(raw), via: new Set() });
          out.get(id).via.add(via);
        }
        if ((data.meta?.count || 0) <= page * 100) break;
      }
    };
    // De cuatro en cuatro, para no saturar la API.
    for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(run));
    return out;
  }

  /** Trabajos que citan a `id` (kind = 'cites') o que `id` cita (kind = 'refs'). */
  related(id, kind, opts = {}) {
    const short = id.split('/').pop();
    return this.filtered([kind === 'cites' ? `cites:${short}` : `cited_by:${short}`], { sort: 'cited', ...opts });
  }

  /** Busca un trabajo por DOI (consulta individual: no gasta presupuesto). */
  async byDoi(doi, { signal } = {}) {
    const data = await this.get(`/works/doi:${encodeURIComponent(doi)}`, { select: FIELDS }, { signal });
    return normalizeWork(data);
  }
}

// ---------------------------------------------------------------- normalización

const TYPE_LABELS = {
  article: 'Artículo', review: 'Revisión', 'book-chapter': 'Capítulo', book: 'Libro', dissertation: 'Tesis',
  preprint: 'Preprint', 'proceedings-article': 'Actas', dataset: 'Datos', report: 'Informe', editorial: 'Editorial',
  letter: 'Carta', erratum: 'Fe de erratas', other: 'Otro',
};

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function abstractFromIndex(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  return stripTags(words.filter((w) => w !== undefined).join(' '));
}

export function normalizeWork(w) {
  const doi = (w.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  const authors = (w.authorships || []).map((a) => {
    const name = a.author?.display_name || a.raw_author_name || '';
    const [parsed] = parseAuthors(name);
    return parsed || { last: name, first: '' };
  });
  const src = w.primary_location?.source || {};
  const b = w.biblio || {};
  const isConference = src.type === 'conference';
  const type = w.type === 'article' && isConference ? 'proceedings-article' : (w.type || 'other');
  const pages = b.first_page ? (b.last_page && b.last_page !== b.first_page ? `${b.first_page}–${b.last_page}` : b.first_page) : '';
  return {
    id: w.id,
    doi,
    title: stripTags(w.display_name) || '(sin título)',
    year: w.publication_year ? String(w.publication_year) : '',
    type,
    typeLabel: TYPE_LABELS[type] || '',
    authors,
    authorsShort: authorsShort(authors),
    venue: stripTags(src.display_name || ''),
    sourceId: src.id || '',
    sourceType: src.type || '',
    volume: b.volume || '',
    issue: b.issue || '',
    pages,
    cited: w.cited_by_count || 0,
    refs: w.referenced_works_count || 0,
    abstract: abstractFromIndex(w.abstract_inverted_index),
    isOa: !!w.open_access?.is_oa,
    pdfUrl: w.best_oa_location?.pdf_url || '',
    oaUrl: w.open_access?.oa_url || w.best_oa_location?.landing_page_url || '',
    url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url || ''),
    refIds: (w.referenced_works || []).map((r) => r.split('/').pop()),
    date: w.publication_date || '',
    authorIds: (w.authorships || []).map((a) => (a.author?.id || '').split('/').pop()).filter(Boolean),
    topicId: (w.primary_topic?.id || '').split('/').pop(),
    topicName: w.primary_topic?.display_name || '',
  };
}

// ---------------------------------------------------------------- relación con la biblioteca

export function titleKey(title) {
  return fold(title).replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
}

/** Índices para saber si un resultado ya está en la biblioteca: por DOI y por título + año. */
export function buildLibraryIndex(entries) {
  const byDoi = new Map();
  const byTitle = new Map();
  for (const e of entries) {
    if (e.doi) byDoi.set(e.doi.toLowerCase(), e.key);
    const t = titleKey(e.title);
    if (t.length > 12) {
      const list = byTitle.get(t) || [];
      list.push({ key: e.key, year: Number(e.year) || 0 });
      byTitle.set(t, list);
    }
  }
  return { byDoi, byTitle };
}

export function findInLibrary(work, index) {
  if (!index) return null;
  if (work.doi && index.byDoi.has(work.doi.toLowerCase())) return index.byDoi.get(work.doi.toLowerCase());
  const list = index.byTitle.get(titleKey(work.title));
  if (!list) return null;
  const y = Number(work.year) || 0;
  const hit = list.find((c) => !y || !c.year || Math.abs(c.year - y) <= 1);
  return hit ? hit.key : null;
}

// ---------------------------------------------------------------- BibTeX

const STOP = new Set(['the', 'a', 'an', 'on', 'of', 'in', 'and', 'for', 'to', 'at', 'by', 'from', 'with', 'is', 'are',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'en', 'y', 'e', 'o', 'por', 'para', 'con', 'al',
  'le', 'les', 'des', 'du', 'et', 'der', 'die', 'das', 'und', 'what', 'how', 'why', 'when', 'do', 'does']);

/** Clave al estilo de la biblioteca: apellido + año + primera palabra significativa del título (p. ej., aylett2004smooth). */
export function citeKeyFor(work) {
  const last = fold(work.authors[0]?.last || 'anon').split(/[\s-]+/).pop().replace(/[^a-z]/g, '') || 'anon';
  const word = fold(work.title).split(/[^a-z0-9]+/).find((w) => w.length > 1 && !STOP.has(w)) || '';
  return `${last}${work.year || ''}${word}`;
}

function bibEscape(s) {
  return String(s).replace(/([&%$#_])/g, '\\$1');
}

const BIB_TYPES = { article: 'article', review: 'article', 'book-chapter': 'incollection', book: 'book', dissertation: 'phdthesis',
  'proceedings-article': 'inproceedings', preprint: 'misc' };

/**
 * Campos de la base de datos (columnas de library.db) para añadir un trabajo a la biblioteca.
 * Texto en Unicode, sin escapes de LaTeX, como guarda add_entry.py.
 */
export function workToEntry(work, key = citeKeyFor(work)) {
  const type = BIB_TYPES[work.type] || 'misc';
  const f = {
    cite_key: key,
    entry_type: type,
    title: work.title,
    author: work.authors.map((a) => (a.first ? `${a.last}, ${a.first}` : a.last)).join(' and '),
    year: work.year,
    volume: work.volume,
    number: work.issue,
    pages: work.pages.replace('–', '--'),
    doi: work.doi,
    url: work.doi ? '' : work.url,
    abstract: work.abstract,
  };
  if (type === 'article' || type === 'misc') f.journal = work.venue;
  else if (type === 'incollection' || type === 'inproceedings') f.booktitle = work.venue;
  else if (type === 'phdthesis') f.school = work.venue;
  else if (type === 'book') f.publisher = work.venue;
  for (const k of Object.keys(f)) if (!f[k]) delete f[k];
  return f;
}

export function workToBibtex(work, key = citeKeyFor(work)) {
  const type = BIB_TYPES[work.type] || 'misc';
  const fields = [];
  const add = (k, v) => { if (v) fields.push(`  ${k} = {${v}}`); };
  add('author', work.authors.map((a) => (a.first ? `${a.last}, ${a.first}` : a.last)).map(bibEscape).join(' and '));
  add('title', bibEscape(work.title));
  if (type === 'article') add('journal', bibEscape(work.venue));
  else if (type === 'incollection' || type === 'inproceedings') add('booktitle', bibEscape(work.venue));
  else if (type === 'phdthesis') add('school', bibEscape(work.venue));
  else if (type === 'misc' && work.venue) add('howpublished', bibEscape(work.venue));
  add('year', work.year);
  add('volume', work.volume);
  add('number', work.issue);
  add('pages', work.pages.replace('–', '--'));
  add('doi', work.doi);
  if (!work.doi) add('url', work.url);
  if (work.type === 'preprint') add('note', 'Preprint');
  return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}
