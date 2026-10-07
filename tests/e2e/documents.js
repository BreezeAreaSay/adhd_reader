/*
 * Test documents for the viewer, built on the fly: a PDF printed by Chromium (with running headers,
 * page numbers, a bookmark outline and Russian text), an EPUB 3 book, an FB2 book in Windows-1251
 * (also zipped) and a plain text file.
 */
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');

const PIXEL = fs.readFileSync(path.join(__dirname, '../fixtures/pixel.png'));

const EN = (n) =>
  `This is paragraph number ${n}. Careful reading takes focus, and long lines of dense text tire the eyes quickly. ` +
  'That is why the text is split into comfortable parts and the beginnings of words are emphasised, so the eye finds an anchor in every line.';
const RU = (n) =>
  `Это абзац номер ${n}. Внимательное чтение требует сосредоточенности, а длинные строки плотного текста быстро утомляют глаза. ` +
  'Поэтому текст разбит на удобные части, а начала слов выделены, чтобы взгляд находил опору в каждой строке.';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A five-page A5 PDF: "Focus and Reading", a Russian chapter and a third part. */
async function makePdf(context) {
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Focus and Reading</title><style>
      body { margin: 0; font: 11pt/1.4 "DejaVu Serif", serif; }
      h1 { font-size: 24pt; } h2 { font-size: 16pt; }
      p { margin: 0 0 8pt; text-align: justify; }
    </style></head><body>
    <h1>Focus and Reading</h1>
    ${range(1, 8).map((n) => `<p>${EN(n)}</p>`).join('')}
    <h2>Глава вторая: о чтении</h2>
    ${range(1, 10).map((n) => `<p>${RU(n)}</p>`).join('')}
    <h2>Third part</h2>
    ${range(20, 29).map((n) => `<p>${EN(n)}</p>`).join('')}
  </body></html>`);
  const pdf = await page.pdf({
    format: 'A5',
    outline: true,
    tagged: true, // Chromium builds the outline from the tagged structure
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center">Focus and Reading — sample</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center"><span class="pageNumber"></span></div>',
    margin: { top: '50px', bottom: '50px', left: '40px', right: '40px' },
  });
  await page.close();
  return pdf;
}

/** A PDF page with nothing but a picture, like a scan. */
async function makeScannedPdf(context) {
  const page = await context.newPage();
  const image = `data:image/png;base64,${PIXEL.toString('base64')}`;
  await page.setContent(`<!doctype html><body style="margin:0">${range(1, 3).map(() => `<img src="${image}" style="display:block;width:100%;height:95vh;break-after:page">`).join('')}</body>`);
  const pdf = await page.pdf({ format: 'A5' });
  await page.close();
  return pdf;
}

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title>
<link rel="stylesheet" href="../style.css"/><style>p { color: red; }</style></head><body>${body}</body></html>`;
}

/** An EPUB 3 book: two chapters, a picture, a link between chapters, a script that must not run. */
function makeEpub() {
  const files = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">test-book</dc:identifier>
    <dc:title>Тестовая книга</dc:title>
    <dc:creator>Анна Автор</dc:creator>
    <dc:language>ru</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="img" href="images/pixel.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`),
    'OEBPS/nav.xhtml': strToU8(
      xhtml(
        'Contents',
        `<nav epub:type="toc"><ol>
          <li><a href="text/chapter1.xhtml">Глава первая</a></li>
          <li><a href="text/chapter2.xhtml">Глава вторая</a><ol><li><a href="text/chapter2.xhtml#part">Часть вторая</a></li></ol></li>
        </ol></nav>`,
      ),
    ),
    'OEBPS/style.css': strToU8('body { background: black; }'),
    'OEBPS/images/pixel.png': PIXEL,
    'OEBPS/text/chapter1.xhtml': strToU8(
      xhtml(
        'One',
        `<h1>Глава первая</h1>${range(1, 6).map((n) => `<p>${RU(n)}</p>`).join('')}
         <p><img src="../images/pixel.png" alt="pixel"/></p>
         <p>Перейти <a href="chapter2.xhtml#part">ко второй части</a>.</p>
         <script>window.__bookScriptRan = true;</script>
         <p onclick="window.__bookScriptRan = true">Последний абзац первой главы.</p>`,
      ),
    ),
    'OEBPS/text/chapter2.xhtml': strToU8(
      xhtml('Two', `<h1>Глава вторая</h1>${range(7, 12).map((n) => `<p>${RU(n)}</p>`).join('')}<h2 id="part">Часть вторая</h2>${range(13, 18).map((n) => `<p>${RU(n)}</p>`).join('')}`),
    ),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** Windows-1251 for the characters the test books use. */
function cp1251(text) {
  const special = { 'Ё': 0xa8, 'ё': 0xb8, '«': 0xab, '»': 0xbb, '—': 0x97, '–': 0x96, '…': 0x85, '№': 0xb9 };
  const out = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code >= 0x410 && code <= 0x44f) out.push(code - 0x410 + 0xc0);
    else if (special[char]) out.push(special[char]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

/** An FB2 book in Windows-1251: two sections, an epigraph, a poem, a footnote and a cover picture. */
function makeFb2({ zipped = false } = {}) {
  const xml = `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description><title-info>
    <author><first-name>Иван</first-name><last-name>Писатель</last-name></author>
    <book-title>Книга в кодировке 1251</book-title><lang>ru</lang>
  </title-info></description>
  <body>
    <title><p>Книга в кодировке 1251</p></title>
    <section>
      <title><p>Глава 1</p><p>Начало</p></title>
      <epigraph><p>Читать — значит думать чужой головой.</p><text-author>Кто-то</text-author></epigraph>
      ${range(1, 5).map((n) => `<p>${RU(n)}</p>`).join('')}
      <p>Здесь есть сноска<a l:href="#n1" type="note">[1]</a> и <emphasis>курсив</emphasis>.</p>
      <image l:href="#cover.png"/>
    </section>
    <section>
      <title><p>Глава 2</p></title>
      <poem><stanza><v>Строка стихотворения первая,</v><v>строка стихотворения вторая.</v></stanza></poem>
      ${range(6, 10).map((n) => `<p>${RU(n)}</p>`).join('')}
    </section>
  </body>
  <body name="notes">
    <section id="n1"><title><p>1</p></title><p>Текст сноски.</p></section>
  </body>
  <binary id="cover.png" content-type="image/png">${PIXEL.toString('base64')}</binary>
</FictionBook>`;
  const bytes = cp1251(xml);
  return zipped ? Buffer.from(zipSync({ 'book.fb2': bytes })) : bytes;
}

function makeTxt() {
  return Buffer.from(['ГЛАВА ПЕРВАЯ', '', RU(1), '', RU(2), '', 'Глава вторая', '', RU(3), '', RU(4), ''].join('\n'), 'utf-8');
}

module.exports = { makePdf, makeScannedPdf, makeEpub, makeFb2, makeTxt, EN, RU };
