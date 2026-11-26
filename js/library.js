// Normalización de entradas, búsqueda y formato.

const TEX_ACCENTS = {
  "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄',
  '.': '̇', 'u': '̆', 'v': '̌', 'H': '̋', 'c': '̧', 'k': '̨', 'r': '̊',
};
const TEX_SYMBOLS = {
  '\\ss': 'ß', '\\o': 'ø', '\\O': 'Ø', '\\ae': 'æ', '\\AE': 'Æ', '\\oe': 'œ', '\\OE': 'Œ', '\\aa': 'å', '\\AA': 'Å',
  '\\l': 'ł', '\\L': 'Ł', '\\i': 'ı', '\\j': 'ȷ', '\\DJ': 'Đ', '\\dj': 'đ', '\\&': '&', '\\%': '%', '\\_': '_', '\\$': '$', '\\#': '#',
};

/** Convierte restos de LaTeX ({\'a}, \~n, --, ~) a texto normal. */
export function cleanTex(input) {
  if (input == null) return '';
  let s = String(input);
  if (!/[\\{}~]|--/.test(s)) return s.trim();
  // \'{a}  \'a  {\'a}  \v{z}  \c{c}
  s = s.replace(/\\([`'^"~=.uvHckr])\s*\{?\s*(\\[ij]|[A-Za-z])\s*\}?/g, (_, acc, ch) => {
    const base = ch === '\\i' ? 'i' : ch === '\\j' ? 'j' : ch;
    return (base + TEX_ACCENTS[acc]).normalize('NFC');
  });
  s = s.replace(/\\(ss|o|O|ae|AE|oe|OE|aa|AA|l|L|i|j|DJ|dj)(?![A-Za-z])/g, (m) => TEX_SYMBOLS[m] ?? m);
  s = s.replace(/\\[&%_$#]/g, (m) => TEX_SYMBOLS[m]);
  s = s.replace(/\\(textit|emph|textbf|textsc|textrm|mathrm|text)\s*\{([^{}]*)\}/g, '$2');
  s = s.replace(/---/g, '—').replace(/--/g, '–').replace(/(?<!\\)~/g, ' ');
  s = s.replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

export function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function lowerMap(raw) {
  const m = {};
  for (const [k, v] of Object.entries(raw)) m[k.toLowerCase()] = v;
  return m;
}

function first(m, names) {
  for (const n of names) {
    const v = m[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
  }
  return '';
}

function splitList(s) {
  if (!s) return [];
  return [...new Set(String(s).split(/[,;]/).map((t) => t.trim()).filter(Boolean))];
}

/** "Apellido, Nombre and Nombre Apellido" → [{last, first}] */
export function parseAuthors(str) {
  if (!str) return [];
  return cleanTex(str)
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => {
      if (a.includes(',')) {
        const [last, ...rest] = a.split(',');
        return { last: last.trim(), first: rest.join(',').trim() };
      }
      const parts = a.split(/\s+/);
      if (parts.length === 1) return { last: a, first: '' };
      // Partículas: de, del, van, von, da… forman parte del apellido.
      let i = parts.length - 1;
      while (i > 0 && /^(de|del|de la|van|von|der|da|di|du|le|la|dos|das)$/i.test(parts[i - 1])) i--;
      return { last: parts.slice(i).join(' '), first: parts.slice(0, i).join(' ') };
    });
}

export function authorsShort(list) {
  if (!list.length) return '';
  if (list.length === 1) return list[0].last;
  if (list.length === 2) return `${list[0].last} y ${list[1].last}`;
  return `${list[0].last} et al.`;
}

export function authorsFull(list) {
  const names = list.map((a) => (a.first ? `${a.first} ${a.last}` : a.last));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

const TYPE_LABELS = {
  article: 'Artículo', book: 'Libro', incollection: 'Capítulo', inbook: 'Capítulo', inproceedings: 'Actas',
  conference: 'Actas', phdthesis: 'Tesis doctoral', mastersthesis: 'Tesis de máster', thesis: 'Tesis',
  techreport: 'Informe', report: 'Informe', misc: 'Otro', unpublished: 'Inédito', online: 'Web', manual: 'Manual',
};

export function normalizeEntry(raw) {
  const m = lowerMap(raw);
  const key = first(m, ['_key', 'cite_key', 'citekey', 'citation_key', 'bibkey', 'key', 'id']);
  const title = cleanTex(first(m, ['title']));
  const authorRaw = first(m, ['author', 'authors']);
  const editorRaw = first(m, ['editor', 'editors']);
  const authors = parseAuthors(authorRaw || editorRaw);
  const yearRaw = first(m, ['year', 'date']);
  const year = (yearRaw.match(/\d{4}/) || [''])[0];
  const type = fold(first(m, ['entry_type', 'entrytype', 'bibtype', 'type'])).replace(/^@/, '');
  const venue = cleanTex(first(m, ['journal', 'journaltitle', 'booktitle', 'school', 'institution', 'howpublished', 'publisher']));
  const publisher = cleanTex(first(m, ['publisher']));
  const doi = first(m, ['doi']).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
  const topics = splitList(first(m, ['source_topic', 'topics', 'topic', 'tema']));
  const keywords = splitList(cleanTex(first(m, ['keywords', 'tags'])));
  const notes = first(m, ['notes', 'notas', 'note', 'annote', 'comment']);
  const abstract = cleanTex(first(m, ['abstract']));
  const e = {
    key, raw, title: title || '(sin título)', authors, authorsShort: authorsShort(authors), year, type,
    typeLabel: TYPE_LABELS[type] || '', venue, publisher: publisher !== venue ? publisher : '',
    volume: first(m, ['volume']), number: first(m, ['number', 'issue']), pages: cleanTex(first(m, ['pages'])),
    doi, url: first(m, ['url']), topics, keywords, notes, abstract, pdf: raw._pdf || '',
    editorsOnly: !authorRaw && !!editorRaw,
  };
  e._f = {
    key: fold(key),
    title: ' ' + fold(e.title),
    authors: ' ' + fold(authors.map((a) => `${a.first} ${a.last}`).join(' ')),
    lasts: authors.map((a) => fold(a.last)),
    topics: topics.map(fold),
    venue: ' ' + fold(venue + ' ' + publisher),
    keywords: ' ' + fold(keywords.join(' ')),
    abstract: ' ' + fold(abstract),
    notes: ' ' + fold(notes),
    doi: fold(doi),
  };
  e.sortAuthor = e._f.lasts[0] || '~';
  e.sortTitle = fold(e.title).replace(/^(the|a|an|el|la|los|las|un|una)\s+/, '');
  return e;
}

/**
 * Devuelve [{entry, score, hiddenHit}] para la consulta; sin consulta, score 0.
 * hiddenHit indica que alguna palabra solo aparece en el resumen o en las notas
 * (la lista muestra entonces un fragmento para que se vea por qué ha salido).
 */
export function search(entries, query) {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries.map((entry) => ({ entry, score: 0, hiddenHit: null }));
  const out = [];
  for (const entry of entries) {
    const f = entry._f;
    let total = 0;
    let ok = true;
    let hiddenHit = null;
    for (const t of tokens) {
      let s = 0;
      if (f.key === t) s += 60; else if (f.key.startsWith(t)) s += 14; else if (f.key.includes(t)) s += 4;
      if (f.title.includes(' ' + t)) s += 12; else if (f.title.includes(t)) s += 6;
      if (f.lasts.some((l) => l === t)) s += 14; else if (f.authors.includes(' ' + t)) s += 9; else if (f.authors.includes(t)) s += 3;
      if (/^\d{4}$/.test(t) && entry.year === t) s += 10;
      if (f.topics.some((x) => x === t)) s += 8; else if (f.topics.some((x) => x.includes(t))) s += 4;
      if (f.venue.includes(' ' + t)) s += 4;
      if (f.keywords.includes(t)) s += 3;
      if (f.doi && t.length > 3 && f.doi.includes(t)) s += 10;
      const visible = s > 0;
      let hidden = 0;
      if (f.abstract.includes(' ' + t)) hidden += 4; else if (f.abstract.includes(t)) hidden += 2;
      if (f.notes.includes(' ' + t)) hidden += 3; else if (f.notes.includes(t)) hidden += 2;
      if (!visible && hidden && !hiddenHit) hiddenHit = { token: t, field: f.abstract.includes(t) ? 'abstract' : 'notes' };
      s += hidden;
      if (!s) { ok = false; break; }
      total += s;
    }
    if (ok) out.push({ entry, score: total, hiddenHit });
  }
  return out;
}

/** Fragmento de ~110 caracteres alrededor de la primera aparición de token: {pre, hit, post}. */
export function snippet(text, token, width = 110) {
  const folded = fold(text);
  const i = folded.indexOf(token);
  if (i === -1) return null;
  const sameLength = folded.length === text.length;
  const start = Math.max(0, i - Math.round(width * 0.35));
  const end = Math.min(text.length, i + token.length + Math.round(width * 0.65));
  // Ajustar a límites de palabra
  let a = start === 0 ? 0 : text.indexOf(' ', start) + 1 || start;
  let b = end === text.length ? end : text.lastIndexOf(' ', end);
  if (b <= i + token.length) b = end;
  if (a > i) a = start;
  const pre = (a > 0 ? '…' : '') + text.slice(a, i);
  const hit = sameLength ? text.slice(i, i + token.length) : '';
  const post = text.slice(sameLength ? i + token.length : i, b) + (b < text.length ? '…' : '');
  return { pre, hit, post };
}

export function sortResults(results, mode) {
  const byYearDesc = (a, b) => (b.entry.year || '0').localeCompare(a.entry.year || '0');
  const cmp = {
    'relevance': (a, b) => b.score - a.score || byYearDesc(a, b) || a.entry.sortAuthor.localeCompare(b.entry.sortAuthor),
    'year-desc': (a, b) => byYearDesc(a, b) || a.entry.sortAuthor.localeCompare(b.entry.sortAuthor),
    'year-asc': (a, b) => (a.entry.year || '9999').localeCompare(b.entry.year || '9999') || a.entry.sortAuthor.localeCompare(b.entry.sortAuthor),
    'author': (a, b) => a.entry.sortAuthor.localeCompare(b.entry.sortAuthor, 'es') || (a.entry.year || '').localeCompare(b.entry.year || ''),
    'title': (a, b) => a.entry.sortTitle.localeCompare(b.entry.sortTitle, 'es'),
  }[mode] || (() => 0);
  return results.sort(cmp);
}

/** "Revista, 47(1), 31–56" */
export function sourceLine(e) {
  const parts = [];
  if (e.venue) parts.push(e.venue);
  let vol = e.volume || '';
  if (vol && e.number) vol += `(${e.number})`; else if (!vol && e.number) vol = `n.º ${e.number}`;
  if (vol) parts.push(vol);
  if (e.pages) parts.push(e.pages.replace(/-+/g, '–'));
  if (e.publisher) parts.push(e.publisher);
  return parts;
}

const BIB_FIELDS = ['author', 'editor', 'title', 'journal', 'journaltitle', 'booktitle', 'year', 'date', 'month', 'volume', 'number',
  'issue', 'pages', 'edition', 'series', 'chapter', 'publisher', 'address', 'location', 'school', 'institution',
  'organization', 'howpublished', 'note', 'doi', 'url', 'isbn', 'issn'];

export function toBibtex(e) {
  const m = lowerMap(e.raw);
  const type = e.type || 'misc';
  const lines = [];
  for (const f of BIB_FIELDS) {
    const v = m[f];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    lines.push(`  ${f} = {${String(v).trim()}}`);
  }
  return `@${type}{${e.key},\n${lines.join(',\n')}\n}`;
}

export function hasLatexLeftovers(s) {
  return /\\[a-zA-Z'`^"~]/.test(s || '');
}
