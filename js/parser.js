import { ImportError } from './errors.js';
import { isLegacyXls, isZip, readXlsx } from './xlsx.js';

/*
 * Чтение файлов уровней.
 *
 * 1. Таблица (CSV / TXT / TSV или книга Excel .xlsx), по строке на карточку:
 *        #название: Урок 5. Еда
 *        #описание: Продукты и напитки
 *        иероглиф;пиньинь;перевод
 *        米饭;mǐfàn;рис
 *    Разделитель в тексте определяется автоматически: табуляция, «;», «|» или «,».
 *    Каждая строка «#название:» начинает новый уровень. В .xlsx каждый лист — отдельный уровень.
 *
 * 2. JSON: {"title": "...", "description": "...", "cards": [{"hanzi": "...", "pinyin": "...", "translation": "..."}]}
 *    или {"levels": [ ...такие же объекты... ]}.
 *
 * Результат: { levels: [{ title, description, cards: [{ hanzi, pinyin, translation }] }], skippedLines: [номера строк] }
 */

const TITLE_KEYS = new Set(['название', 'title', 'урок', 'уровень', 'тема', 'level', 'name']);
const DESCRIPTION_KEYS = new Set(['описание', 'description', 'desc']);
const HEADER_WORDS = new Set(['иероглиф', 'иероглифы', 'hanzi', 'character', 'слово', '汉字']);

export async function parseBytes(buffer, fallbackTitle) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (isZip(bytes)) return parseXlsx(bytes, fallbackTitle);
  if (isLegacyXls(bytes)) {
    throw new ImportError('Старый формат Excel (.xls) не поддерживается.\n\nСохраните таблицу как «Книга Excel (.xlsx)» или CSV.');
  }
  return parseText(decode(bytes), fallbackTitle);
}

export function parseText(rawText, fallbackTitle) {
  const text = rawText.replace(/^﻿/, '');
  const trimmed = text.trimStart();
  const result = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? { levels: parseJson(trimmed, fallbackTitle), skippedLines: [] }
    : parseTable(text, fallbackTitle);
  if (!result.levels.length) {
    throw new ImportError('В файле не найдено ни одной карточки.\n\nКаждая строка должна выглядеть так:\nиероглиф;пиньинь;перевод');
  }
  return result;
}

// ---------- кодировка ----------

function decode(bytes) {
  const startsWith = (...prefix) => bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
  if (startsWith(0xEF, 0xBB, 0xBF)) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (startsWith(0xFF, 0xFE)) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(0xFE, 0xFF)) return new TextDecoder('utf-16be').decode(bytes.subarray(2));

  const strict = (label) => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  const utf8 = strict('utf-8');
  if (utf8 !== null) return utf8;
  // таблицы, сохранённые китайской версией Excel
  const gb = strict('gb18030');
  if (gb !== null && /[㐀-鿿]/.test(gb)) return gb;

  throw new ImportError(
    'Не удалось прочитать файл: неизвестная кодировка.\n\nВ Excel сохраните файл как «Книга Excel (.xlsx)» или «CSV UTF-8».',
  );
}

// ---------- таблица ----------

function parseTable(text, fallbackTitle) {
  const lines = text.split(/\r\n|\n|\r/);
  const delimiter = detectDelimiter(lines);
  const rows = lines.map((raw) => {
    const body = directiveBody(raw);
    if (body === null) return { cells: splitFields(raw, delimiter) };
    const parts = body.includes(':') ? [body] : splitFields(body, delimiter);
    return directive(parts[0], parts.slice(1));
  });
  return parseRows(rows, fallbackTitle);
}

async function parseXlsx(bytes, fallbackTitle) {
  let sheets;
  try {
    sheets = await readXlsx(bytes);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`Не удалось прочитать таблицу Excel: ${e?.message ?? e}`);
  }
  sheets = sheets.filter((sheet) => sheet.rows.some((row) => row.some((cell) => cell !== '')));

  const levels = [];
  const skipped = [];
  for (const sheet of sheets) {
    const rows = sheet.rows.map((cells) => {
      const first = cells[0] ?? '';
      return first.startsWith('#')
        ? directive(first.slice(1).trim(), cells.slice(1))
        // столбцы правее C — например, заметки учителя — не учитываются
        : { cells: cells.slice(0, 3) };
    });
    const title = sheets.length === 1 ? fallbackTitle : sheet.name.trim() || fallbackTitle;
    const result = parseRows(rows, title);
    levels.push(...result.levels);
    skipped.push(...result.skippedLines);
  }
  if (!levels.length) {
    throw new ImportError('В таблице не найдено ни одной карточки.\n\nСтолбцы: A — иероглиф, B — пиньинь, C — перевод.');
  }
  return { levels, skippedLines: [...new Set(skipped)].sort((a, b) => a - b) };
}

/** rows: { key, value } — служебная строка, { cells } — карточка. */
function parseRows(rows, fallbackTitle) {
  const levels = [];
  const skippedLines = [];
  let title = null;
  let description = '';
  let cards = [];
  let headerChecked = false;

  const flush = () => {
    if (cards.length) levels.push({ title: title ?? fallbackTitle, description, cards });
    title = null;
    description = '';
    cards = [];
  };

  rows.forEach((row, index) => {
    if (row.key !== undefined) {
      if (TITLE_KEYS.has(row.key)) {
        flush();
        title = row.value.trim() || null;
      } else if (DESCRIPTION_KEYS.has(row.key)) {
        description = row.value;
      }
      // остальное — просто комментарий
      return;
    }

    const fields = [...row.cells];
    while (fields.length && fields[fields.length - 1] === '') fields.pop();
    if (!fields.length) return;

    if (!headerChecked) {
      headerChecked = true;
      if (HEADER_WORDS.has(fields[0].toLowerCase())) return;
    }

    const [hanzi, pinyin = ''] = fields;
    const translation = fields.slice(2).filter(Boolean).join(', ');
    if (fields.length < 3 || !hanzi || (!pinyin && !translation)) {
      skippedLines.push(index + 1);
    } else {
      cards.push({ hanzi, pinyin, translation });
    }
  });
  flush();
  return { levels, skippedLines };
}

function detectDelimiter(lines) {
  const data = lines.filter((line) => line.trim() && directiveBody(line) === null);
  if (data.some((line) => line.includes('\t'))) return '\t';
  if (data.some((line) => line.includes(';'))) return ';';
  if (data.some((line) => line.includes('|'))) return '|';
  return ',';
}

/** Текст после «#», если строка служебная (название, описание, комментарий). */
function directiveBody(raw) {
  let line = raw.trim().replace(/[;,\t| ]+$/, '');
  // Excel и Google Таблицы берут ячейку в кавычки, если в ней есть запятая
  if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
    line = line.slice(1, -1).replaceAll('""', '"').trim();
  }
  return line.startsWith('#') ? line.slice(1).trim() : null;
}

/** «название: Урок 5» или «название» + значение в следующих ячейках. */
function directive(body, rest) {
  const colon = body.indexOf(':');
  const key = (colon >= 0 ? body.slice(0, colon) : body).trim().toLowerCase();
  const value = colon >= 0 ? body.slice(colon + 1).replace(/^[;,\t| ]+|[;,\t| ]+$/g, '') : '';
  return { key, value: value || rest.filter(Boolean).join(' ') };
}

function splitFields(line, delimiter) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes && c === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"' && (inQuotes || field.trim() === '')) {
      inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) {
      out.push(field.trim());
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field.trim());
  return out;
}

// ---------- JSON ----------

function parseJson(text, fallbackTitle) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    throw new ImportError(`Ошибка в JSON-файле: ${e.message}`);
  }
  if (Array.isArray(root)) {
    const first = root[0];
    if (first && typeof first === 'object' && !Array.isArray(first) && 'cards' in first) {
      return levelsFromJson(root, fallbackTitle);
    }
    const cards = cardsFromJson(root);
    return cards.length ? [{ title: fallbackTitle, description: '', cards }] : [];
  }
  if (root && typeof root === 'object') {
    if (Array.isArray(root.levels)) return levelsFromJson(root.levels, fallbackTitle);
    const level = levelFromJson(root, fallbackTitle);
    return level ? [level] : [];
  }
  throw new ImportError('Неизвестный формат JSON-файла');
}

function levelsFromJson(array, fallbackTitle) {
  return array
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => levelFromJson(item, fallbackTitle))
    .filter(Boolean);
}

function levelFromJson(obj, fallbackTitle) {
  const cards = cardsFromJson(Array.isArray(obj.cards) ? obj.cards : []);
  if (!cards.length) return null;
  return {
    title: firstString(obj, 'title', 'name', 'название') || fallbackTitle,
    description: firstString(obj, 'description', 'описание'),
    cards,
  };
}

function cardsFromJson(array) {
  return array
    .map((item) => {
      // короткая запись: ["你好", "nǐ hǎo", "привет"]
      if (Array.isArray(item)) {
        const [hanzi, pinyin, translation] = item.map((v) => String(v ?? '').trim());
        return hanzi ? { hanzi, pinyin: pinyin ?? '', translation: translation ?? '' } : null;
      }
      if (item && typeof item === 'object') {
        const hanzi = firstString(item, 'hanzi', 'character', 'char', 'word', 'иероглиф');
        return hanzi
          ? {
            hanzi,
            pinyin: firstString(item, 'pinyin', 'phonetic', 'transcription', 'пиньинь', 'фонетика'),
            translation: firstString(item, 'translation', 'meaning', 'translate', 'перевод'),
          }
          : null;
      }
      return null;
    })
    .filter(Boolean);
}

function firstString(obj, ...keys) {
  for (const key of keys) {
    const value = obj[key];
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return '';
}
