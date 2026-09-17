import { ImportError } from './errors.js';

/*
 * Минимальное чтение книги Excel (.xlsx) без библиотек:
 * .xlsx — это zip-архив с XML-файлами листов и общей таблицей строк.
 * Распаковка — встроенным DecompressionStream (Safari 16.4+, Chrome 80+).
 */

const MAX_ENTRY_SIZE = 20 * 1024 * 1024;

export const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04;

/** Старый двоичный формат .xls. */
export const isLegacyXls = (b) => b.length >= 4 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;

/** @returns {Promise<{ name: string, rows: string[][] }[]>} */
export async function readXlsx(bytes) {
  const entries = await unzip(bytes, (name) => name.startsWith('xl/') && (name.endsWith('.xml') || name.endsWith('.rels')));
  const workbook = entries.get('xl/workbook.xml');
  if (!workbook) throw new ImportError('Архив не похож на таблицу Excel (.xlsx).');

  const sharedStrings = entries.has('xl/sharedStrings.xml') ? parseSharedStrings(entries.get('xl/sharedStrings.xml')) : [];
  const targets = entries.has('xl/_rels/workbook.xml.rels') ? parseRelationships(entries.get('xl/_rels/workbook.xml.rels')) : new Map();

  const sheets = [];
  elements(parseXml(workbook), 'sheet').forEach((sheet, index) => {
    const id = prefixedAttribute(sheet, 'id');
    const target = id && targets.get(id);
    const path = target ? resolvePath(target) : `xl/worksheets/sheet${index + 1}.xml`;
    const data = entries.get(path);
    if (data) sheets.push({ name: sheet.getAttribute('name') ?? '', rows: parseSheet(data, sharedStrings) });
  });
  return sheets;
}

// ---------- zip ----------

async function unzip(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054B50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ImportError('Файл повреждён: не удалось открыть архив .xlsx.');

  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const result = new Map();

  for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
    if (view.getUint32(offset, true) !== 0x02014B50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = names.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/^\//, '');
    offset += 46 + nameLength + extraLength + commentLength;

    if (!wanted(name)) continue;
    if (size > MAX_ENTRY_SIZE) throw new ImportError('Таблица слишком большая.');

    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(start, start + compressedSize);
    if (method === 0) result.set(name, raw);
    else if (method === 8) result.set(name, await inflate(raw));
    else throw new ImportError('Файл .xlsx сжат неподдерживаемым способом.');
  }
  return result;
}

async function inflate(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ImportError('Этот браузер не умеет открывать файлы .xlsx. Обновите браузер или загрузите уровень в формате CSV.');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length > MAX_ENTRY_SIZE) throw new ImportError('Таблица слишком большая.');
  return out;
}

// ---------- XML ----------

function parseXml(bytes) {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new ImportError('Файл .xlsx повреждён.');
  return doc.documentElement;
}

const elements = (root, localName) => Array.from(root.getElementsByTagNameNS('*', localName));

/** Атрибут с префиксом пространства имён (r:id), независимо от самого префикса. */
function prefixedAttribute(element, localName) {
  for (const attr of element.attributes) {
    if (attr.localName === localName && attr.name.includes(':')) return attr.value;
  }
  return null;
}

const resolvePath = (target) => (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);

function parseRelationships(bytes) {
  return new Map(elements(parseXml(bytes), 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
}

function parseSharedStrings(bytes) {
  return elements(parseXml(bytes), 'si').map((si) =>
    elements(si, 't')
      // <rPh> — фонетическая подсказка японского Excel, её текст не нужен
      .filter((t) => t.parentNode?.localName !== 'rPh')
      .map((t) => t.textContent)
      .join(''),
  );
}

function parseSheet(bytes, sharedStrings) {
  const rows = new Map();
  let nextRow = 1;
  let lastRow = 0;

  for (const row of elements(parseXml(bytes), 'row')) {
    const r = parseInt(row.getAttribute('r'), 10);
    const rowIndex = Number.isFinite(r) ? r : nextRow;
    nextRow = rowIndex + 1;

    const cells = [];
    let nextColumn = 0;
    for (const cell of elements(row, 'c')) {
      const column = columnIndex(cell.getAttribute('r') ?? '') ?? nextColumn;
      nextColumn = column + 1;
      const v = elements(cell, 'v')[0]?.textContent ?? '';
      let value;
      switch (cell.getAttribute('t')) {
        case 's': value = sharedStrings[parseInt(v, 10)] ?? ''; break;
        case 'inlineStr': value = elements(cell, 't').map((t) => t.textContent).join(''); break;
        case 'b': value = v === '1' ? 'TRUE' : 'FALSE'; break;
        default: value = v;
      }
      cells[column] = value.trim();
    }
    rows.set(rowIndex, Array.from(cells, (c) => c ?? ''));
    lastRow = Math.max(lastRow, rowIndex);
  }
  return Array.from({ length: lastRow }, (_, i) => rows.get(i + 1) ?? []);
}

/** «C12» → 2 */
function columnIndex(ref) {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0];
  if (!letters) return null;
  return [...letters.toUpperCase()].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}
