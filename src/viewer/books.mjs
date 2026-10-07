/*
 * E-book formats for the document viewer: EPUB (2 and 3), FB2 (also zipped, any encoding) and plain
 * text. Each is turned into reading content — book sections, a table of contents, title, author and
 * language — built in the viewer's document. Book styles, scripts and fonts are never used.
 */
import { unzipSync, strFromU8 } from '../vendor/fflate.mjs';

const ADHDR = globalThis.ADHDR;
const XLINK = 'http://www.w3.org/1999/xlink';
const DC = 'http://purl.org/dc/elements/1.1/';
const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif' };

// --- format detection --------------------------------------------------------------------------------

function startsWith(bytes, text, at = 0) {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function zipEntryNames(bytes) {
  const names = [];
  unzipSync(bytes, {
    filter: (file) => {
      names.push(file.name);
      return false; // list only, don't inflate
    },
  });
  return names;
}

/** 'pdf' | 'epub' | 'fb2' | 'txt', or null for anything else. Looks at the content, not just the name. */
export function detectKind(bytes, name = '') {
  const head = latin1(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, 'PK\u0003\u0004')) {
    let names = [];
    try {
      names = zipEntryNames(bytes);
    } catch {
      return null;
    }
    if (names.includes('META-INF/container.xml')) return 'epub';
    if (names.some((n) => /\.fb2$/i.test(n))) return 'fb2';
    return null;
  }
  if (/<FictionBook[\s>]/.test(head)) return 'fb2';
  const binary = [...bytes.subarray(0, 512)].some((b) => b === 0);
  if (!binary && (/\.(txt|text|md)$/i.test(name) || !/\.\w{2,5}$/.test(name))) return 'txt';
  return null;
}

function latin1(bytes) {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** Decodes text: the declared encoding if any, else UTF-8, falling back to Windows-1251 (old Russian texts). */
function decodeText(bytes) {
  const declared = latin1(bytes.subarray(0, 200)).match(/encoding=["']([\w-]+)["']/i)?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // unknown label: try the defaults
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

// --- shared helpers -----------------------------------------------------------------------------------

function blobUrls() {
  const urls = [];
  return {
    make(bytes, type) {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      urls.push(url);
      return url;
    },
    revokeAll() {
      for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    },
  };
}

function imageType(path) {
  return IMAGE_TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

function text(node) {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Headings of the sections, for books without their own table of contents. */
function tocFromHeadings(sections) {
  const toc = [];
  for (const section of sections) {
    const heading = section.querySelector('h1, h2, h3');
    if (heading && text(heading)) {
      if (!heading.id) heading.id = `${section.id}-title`;
      toc.push({ label: text(heading), id: heading.id, level: 1 });
    }
  }
  return toc;
}

export async function parseBook(kind, bytes, { name, doc }) {
  if (kind === 'epub') return parseEpub(bytes, doc);
  if (kind === 'fb2') {
    if (startsWith(bytes, 'PK\u0003\u0004')) {
      const files = unzipSync(bytes, { filter: (file) => /\.fb2$/i.test(file.name) });
      const first = Object.values(files)[0];
      if (!first) throw new Error('no .fb2 inside the archive');
      return parseFb2(first, doc);
    }
    return parseFb2(bytes, doc);
  }
  return parseTxt(bytes, name, doc);
}

// --- EPUB -----------------------------------------------------------------------------------------------

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** Resolves a relative href inside the archive ("../images/a.jpg" from "OEBPS/text/") to an entry path. */
function resolvePath(base, href) {
  const parts = (base + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

function parseXml(source, type = 'application/xml') {
  const xml = new DOMParser().parseFromString(source, type);
  return xml.querySelector('parsererror') ? null : xml;
}

function parseEpub(bytes, doc) {
  const files = unzipSync(bytes);
  const read = (path) => (files[path] ? strFromU8(files[path]) : null);
  const container = parseXml(read('META-INF/container.xml') || '');
  const opfPath = container?.querySelector('rootfile')?.getAttribute('full-path');
  const opf = opfPath && parseXml(read(opfPath) || '');
  if (!opf) throw new Error('broken EPUB: no package document');
  const opfDir = dirname(opfPath);

  const dc = (tag) => text(opf.getElementsByTagNameNS(DC, tag)[0]);
  const manifest = new Map();
  for (const item of opf.querySelectorAll('manifest > item')) {
    manifest.set(item.getAttribute('id'), {
      path: resolvePath(opfDir, item.getAttribute('href') || ''),
      type: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }
  const spine = [...opf.querySelectorAll('spine > itemref')]
    .map((ref) => manifest.get(ref.getAttribute('idref')))
    .filter((item) => item && /x?html/.test(item.type));
  const chapterIndex = new Map(spine.map((item, i) => [item.path, i]));

  const blobs = blobUrls();
  const imageUrls = new Map();
  const imageUrl = (path) => {
    if (!files[path]) return null;
    if (!imageUrls.has(path)) imageUrls.set(path, blobs.make(files[path], imageType(path)));
    return imageUrls.get(path);
  };

  /** Maps a link inside the book to an id in the viewer: "#ch3" (chapter) or "#ch3-note1". */
  const linkTarget = (fromDir, href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const [path, hash] = href.split('#');
    const index = path ? chapterIndex.get(resolvePath(fromDir, path)) : undefined;
    if (index === undefined) return null;
    return `ch${index}${hash ? `-${hash}` : ''}`;
  };

  const sections = spine.map((item, index) => {
    const source = read(item.path) || '';
    const page = parseXml(source, 'application/xhtml+xml') || new DOMParser().parseFromString(source, 'text/html');
    const body = page.body || page.querySelector('body');
    const section = doc.createElement('section');
    section.className = 'book-section';
    section.id = `ch${index}`;
    if (!body) return section;
    const fromDir = dirname(item.path);

    // Cover pages often wrap the picture in <svg><image xlink:href="…">: keep it as a plain image.
    for (const svgImage of body.querySelectorAll('svg image')) {
      const href = svgImage.getAttributeNS(XLINK, 'href') || svgImage.getAttribute('href');
      if (href) svgImage.closest('svg').replaceWith(Object.assign(page.createElement('img'), { src: href }));
    }
    for (const node of [...body.childNodes]) section.append(doc.importNode(node, true));
    // Hrefs and srcs straight from the book, before the browser resolves them against the viewer URL.
    ADHDR.sanitizeContent(section, {
      idPrefix: `ch${index}-`,
      resolve: (value, attribute) => {
        if (attribute === 'href') {
          if (/^https?:|^mailto:/i.test(value)) return value;
          const target = linkTarget(fromDir, value);
          return target ? `#${target}` : null;
        }
        if (/^https?:/i.test(value)) return value;
        return imageUrl(resolvePath(fromDir, value));
      },
    });
    return section;
  });

  return {
    title: dc('title'),
    author: dc('creator'),
    lang: dc('language'),
    sections,
    toc: epubToc(opf, manifest, read, linkTarget) || tocFromHeadings(sections),
    cleanup: blobs.revokeAll,
  };
}

function epubToc(opf, manifest, read, linkTarget) {
  const toc = [];
  // EPUB 3: the navigation document.
  const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'));
  if (nav) {
    const page = parseXml(read(nav.path) || '', 'application/xhtml+xml');
    const list = page && ([...page.querySelectorAll('nav')].find((n) => (n.getAttribute('epub:type') || '').includes('toc')) || page.querySelector('nav'));
    const walk = (ol, level) => {
      for (const li of ol?.children || []) {
        if (li.localName !== 'li') continue;
        const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
        const id = a?.getAttribute('href') && linkTarget(dirname(nav.path), a.getAttribute('href'));
        if (a && text(a) && id) toc.push({ label: text(a), id, level });
        walk([...li.children].find((c) => c.localName === 'ol'), level + 1);
      }
    };
    walk(list?.querySelector('ol'), 1);
    if (toc.length) return toc;
  }
  // EPUB 2: the NCX file.
  const ncxId = opf.querySelector('spine')?.getAttribute('toc');
  const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml');
  const ncxDoc = ncx && parseXml(read(ncx.path) || '');
  const walkPoints = (parent, level) => {
    for (const point of parent?.children || []) {
      if (point.localName !== 'navPoint') continue;
      const label = text(point.querySelector('navLabel'));
      const src = point.querySelector('content')?.getAttribute('src');
      const id = src && linkTarget(dirname(ncx.path), src);
      if (label && id) toc.push({ label, id, level });
      walkPoints(point, level + 1);
    }
  };
  walkPoints(ncxDoc?.querySelector('navMap'), 1);
  return toc.length ? toc : null;
}

// --- FB2 ------------------------------------------------------------------------------------------------

function parseFb2(bytes, doc) {
  const xml = parseXml(decodeText(bytes));
  if (!xml) throw new Error('broken FB2 file');
  const blobs = blobUrls();
  const images = new Map();
  for (const binary of xml.querySelectorAll('binary')) {
    try {
      const raw = atob(binary.textContent.replace(/\s+/g, ''));
      const data = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      images.set(binary.getAttribute('id'), blobs.make(data, binary.getAttribute('content-type') || 'image/jpeg'));
    } catch {
      // broken image data: skip the picture
    }
  }
  const href = (node) => node.getAttributeNS(XLINK, 'href') || node.getAttribute('l:href') || node.getAttribute('xlink:href') || node.getAttribute('href') || '';
  const toc = [];
  let inNotes = false; // footnote bodies stay out of the table of contents

  const convert = (node, depth) => {
    if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.data);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const make = (tag, className) => {
      const out = doc.createElement(tag);
      if (className) out.className = className;
      if (node.getAttribute('id')) out.id = `fb2-${node.getAttribute('id')}`;
      for (const child of node.childNodes) {
        const converted = convert(child, depth);
        if (converted) out.append(converted);
      }
      return out;
    };
    switch (node.localName) {
      case 'section': {
        const out = make('section', depth === 0 ? 'book-section' : 'subsection');
        // Convert children one level deeper so nested titles become smaller headings.
        out.replaceChildren(...[...node.childNodes].map((child) => convert(child, depth + 1)).filter(Boolean));
        const title = out.querySelector(':scope > h2, :scope > h3, :scope > h4');
        if (title && text(title) && !inNotes) {
          if (!title.id) title.id = `fb2-t${toc.length}`;
          toc.push({ label: text(title), id: title.id, level: Math.min(3, depth + 1) });
        }
        return out;
      }
      case 'title': {
        const out = doc.createElement(depth <= 1 ? 'h2' : depth === 2 ? 'h3' : 'h4');
        out.textContent = [...node.querySelectorAll('p')].map(text).filter(Boolean).join(' — ') || text(node);
        return out;
      }
      case 'subtitle':
        return make('h4');
      case 'p':
        return make('p');
      case 'v':
        return make('p');
      case 'emphasis':
        return make('em');
      case 'strong':
        return make('strong');
      case 'strikethrough':
        return make('s');
      case 'sub':
      case 'sup':
      case 'code':
        return make(node.localName);
      case 'empty-line':
        return doc.createElement('br');
      case 'epigraph':
        return make('div', 'epigraph');
      case 'cite':
        return make('blockquote');
      case 'poem':
        return make('div', 'poem');
      case 'stanza':
        return make('div', 'stanza');
      case 'text-author':
        return make('p', 'text-author');
      case 'table':
      case 'tr':
      case 'td':
      case 'th':
        return make(node.localName);
      case 'image': {
        const url = images.get(href(node).replace(/^#/, ''));
        if (!url) return null;
        const img = doc.createElement('img');
        img.src = url;
        img.alt = node.getAttribute('alt') || '';
        return img;
      }
      case 'a': {
        const out = make('a');
        const target = href(node);
        if (target.startsWith('#')) out.setAttribute('href', `#fb2-${target.slice(1)}`);
        else if (/^https?:/i.test(target)) {
          out.setAttribute('href', target);
          out.setAttribute('target', '_blank');
          out.setAttribute('rel', 'noopener noreferrer');
        }
        if (node.getAttribute('type') !== 'note') return out;
        const sup = doc.createElement('sup');
        sup.append(out);
        return sup;
      }
      default: {
        // Unknown element: keep its content.
        const fragment = doc.createDocumentFragment();
        for (const child of node.childNodes) {
          const converted = convert(child, depth);
          if (converted) fragment.append(converted);
        }
        return fragment;
      }
    }
  };

  const info = xml.querySelector('description > title-info');
  const author = info?.querySelector('author');
  const authorName = author ? ['first-name', 'middle-name', 'last-name'].map((tag) => text(author.querySelector(tag))).filter(Boolean).join(' ') : '';
  const sections = [];
  for (const body of xml.querySelectorAll('FictionBook > body')) {
    const notes = /notes|comments/i.test(body.getAttribute('name') || '');
    if (notes) {
      inNotes = true;
      const section = convert(body, 1);
      inNotes = false;
      const wrapper = doc.createElement('section');
      wrapper.className = 'book-section notes';
      wrapper.id = `notes-${sections.length}`;
      wrapper.append(section);
      sections.push(wrapper);
      continue;
    }
    for (const child of body.children) {
      if (child.localName === 'section') sections.push(convert(child, 0));
      else if (child.localName === 'epigraph') {
        const section = doc.createElement('section');
        section.className = 'book-section';
        section.append(convert(child, 0));
        sections.push(section);
      }
    }
  }
  sections.forEach((section, i) => {
    if (!section.id) section.id = `fb2-s${i}`;
  });
  return {
    title: text(info?.querySelector('book-title')),
    author: authorName,
    lang: text(info?.querySelector('lang')),
    sections,
    toc,
    cleanup: blobs.revokeAll,
  };
}

// --- plain text -----------------------------------------------------------------------------------------

// (\b only knows Latin letters, so the end of a word is spelled out.)
const TXT_HEADING = /^(?:глава|часть|раздел|пролог|эпилог|chapter|part|prologue|epilogue|book)(?=[\s.:]|$)|^[IVXLC]+\.?$|^\d{1,3}\.?$/iu;

function parseTxt(bytes, name, doc) {
  const source = decodeText(bytes).replace(/\r\n?/g, '\n');
  // Paragraphs are separated by blank lines; in many books every line is a paragraph instead.
  const blocks = /\n[ \t]*\n/.test(source) ? source.split(/\n[ \t]*\n+/) : source.split('\n');
  const sections = [];
  const toc = [];
  let section = null;
  const newSection = () => {
    section = doc.createElement('section');
    section.className = 'book-section';
    section.id = `txt-s${sections.length}`;
    sections.push(section);
  };
  for (const raw of blocks) {
    const block = raw.replace(/\s+/g, ' ').trim();
    if (!block) continue;
    const heading = block.length <= 70 && (TXT_HEADING.test(block) || (block === block.toUpperCase() && /\p{Lu}{3}/u.test(block)));
    if (heading) {
      newSection();
      const h = doc.createElement('h2');
      h.textContent = block;
      h.id = `${section.id}-title`;
      section.append(h);
      toc.push({ label: block, id: h.id, level: 1 });
      continue;
    }
    if (!section) newSection();
    const p = doc.createElement('p');
    p.textContent = block;
    section.append(p);
  }
  return { title: name.replace(/\.(txt|text|md)$/i, ''), author: '', lang: '', sections, toc, cleanup: () => {} };
}
