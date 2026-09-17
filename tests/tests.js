import { ImportError } from '../js/errors.js';
import { parseBytes, parseText } from '../js/parser.js';
import { levelToLink, resultFromLink } from '../js/share.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assertEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`ожидалось ${e}\n получено ${a}`);
}

async function assertRejects(fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ImportError) return;
    throw new Error(`ожидалась ImportError, получено ${e}`);
  }
  throw new Error('ожидалась ошибка');
}

const card = (hanzi, pinyin, translation) => ({ hanzi, pinyin, translation });
const bytesOf = (text) => new TextEncoder().encode(text);
const fetchBytes = async (path) => new Uint8Array(await (await fetch(path)).arrayBuffer());

/** Zip без сжатия — чтобы собрать .xlsx прямо в тесте. */
function zip(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034B50, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(header.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014B50, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---------- текст ----------

test('CSV из Excel: BOM, точка с запятой, пустые ячейки', async () => {
  const text = '#название: Урок 5;;\r\nиероглиф;пиньинь;перевод\r\n米饭;mǐfàn;рис\r\n茶;chá;чай;;\r\n';
  const r = await parseBytes(new Uint8Array([0xEF, 0xBB, 0xBF, ...bytesOf(text)]), 'file');
  assertEqual(r.levels.map((l) => l.title), ['Урок 5']);
  assertEqual(r.levels[0].cards, [card('米饭', 'mǐfàn', 'рис'), card('茶', 'chá', 'чай')]);
  assertEqual(r.skippedLines, []);
});

test('CSV из Google Таблиц: кавычки и запятые', async () => {
  const text = '"#название: Урок 1, часть 2",,\n你好,nǐ hǎo,"привет, здравствуйте"\n再见,zàijiàn,до свидания\n';
  const level = (await parseBytes(bytesOf(text), 'file')).levels[0];
  assertEqual(level.title, 'Урок 1, часть 2');
  assertEqual(level.cards[0].translation, 'привет, здравствуйте');
  assertEqual(level.cards.length, 2);
});

test('запятые без кавычек склеиваются в перевод', () => {
  const level = parseText('日,rì,солнце, день', 'file').levels[0];
  assertEqual(level.cards, [card('日', 'rì', 'солнце, день')]);
  assertEqual(level.title, 'file');
});

test('UTF-16 с табуляцией', async () => {
  const text = '水\tshuǐ\tвода\n火\thuǒ\tогонь';
  const utf16 = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    utf16[i * 2] = text.charCodeAt(i) & 0xFF;
    utf16[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  const r = await parseBytes(new Uint8Array([0xFF, 0xFE, ...utf16]), 'f');
  assertEqual(r.levels[0].cards.length, 2);
});

test('несколько уровней в тексте и строки с ошибками', () => {
  const text = [
    '# просто комментарий',
    '#название: Первый',
    '#описание: Описание первого',
    '一;yī;один',
    'плохая строка',
    '#название: Второй',
    '二;èr;два',
    '三;;',
  ].join('\n');
  const r = parseText(text, 'f');
  assertEqual(r.levels.map((l) => l.title), ['Первый', 'Второй']);
  assertEqual(r.levels[0].description, 'Описание первого');
  assertEqual(r.skippedLines, [5, 8]);
});

test('JSON: один уровень, несколько уровней, массив карточек', () => {
  assertEqual(parseText('{"title":"A","cards":[{"hanzi":"人","pinyin":"rén","translation":"человек"}]}', 'f').levels[0].title, 'A');
  const multi = '{"levels":[{"title":"A","cards":[["人","rén","человек"]]},{"title":"B","cards":[{"hanzi":"山","pinyin":"shān","translation":"гора"}]}]}';
  assertEqual(parseText(multi, 'f').levels.map((l) => l.title), ['A', 'B']);
  assertEqual(parseText('[{"hanzi":"山","pinyin":"shān","translation":"гора"}]', 'f').levels[0].title, 'f');
});

test('ошибки: пустой файл, битый JSON, текст без разделителей', async () => {
  await assertRejects(() => parseText('', 'f'));
  await assertRejects(() => parseText('{broken', 'f'));
  await assertRejects(() => parseText('просто текст без разделителей', 'f'));
});

// ---------- Excel ----------

test('пример .xlsx (openpyxl): два листа — два уровня', async () => {
  const r = await parseBytes(await fetchBytes('../examples/primer.xlsx'), 'primer');
  assertEqual(r.levels.map((l) => l.title), ['Урок 8. Транспорт', 'Урок 9. Время']);
  assertEqual(r.levels[0].description, 'Как добраться до места');
  assertEqual(r.levels.map((l) => l.cards.length), [8, 8]);
  assertEqual(r.levels[0].cards[4], card('公共汽车', 'gōnggòng qìchē', 'автобус'));
  assertEqual(r.skippedLines, []);
});

test('.xlsx как у Excel: общие строки, префиксы, пропуски, столбцы правее C', async () => {
  const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const bytes = zip({
    'xl/workbook.xml': `<x:workbook ${ns} ${rel}><x:sheets><x:sheet name="Лист1" sheetId="1" r:id="rId7"/></x:sheets></x:workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Target="worksheets/data.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<x:sst ${ns}><x:si><x:t>水</x:t></x:si><x:si><x:r><x:t>shu</x:t></x:r><x:r><x:t>ǐ</x:t></x:r></x:si><x:si><x:t>вода</x:t></x:si><x:si><x:t>火</x:t></x:si></x:sst>`,
    'xl/worksheets/data.xml': `<x:worksheet ${ns}><x:sheetData>
      <x:row r="2"><x:c r="A2" t="s"><x:v>0</x:v></x:c><x:c r="B2" t="s"><x:v>1</x:v></x:c><x:c r="C2" t="s"><x:v>2</x:v></x:c></x:row>
      <x:row r="4"><x:c r="A4" t="s"><x:v>3</x:v></x:c><x:c r="C4" t="s"><x:v>2</x:v></x:c></x:row>
      <x:row r="5"><x:c r="A5" t="s"><x:v>3</x:v></x:c><x:c r="D5"><x:v>42</x:v></x:c></x:row>
    </x:sheetData></x:worksheet>`,
  });
  const r = await parseBytes(bytes, 'урок из файла');
  assertEqual(r.levels.map((l) => l.title), ['урок из файла']);
  assertEqual(r.levels[0].cards, [card('水', 'shuǐ', 'вода'), card('火', '', 'вода')]);
  assertEqual(r.skippedLines, [5]);
});

test('.xls и пустой архив отклоняются', async () => {
  await assertRejects(() => parseBytes(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]), 'f'));
  await assertRejects(() => parseBytes(zip({ 'docProps/app.xml': '<a/>' }), 'f'));
});

// ---------- файлы сайта ----------

test('базовые уровни и примеры читаются', async () => {
  const basic = await parseBytes(await fetchBytes('../levels/basic.json'), 'basic');
  assertEqual(basic.levels.length, 4);
  assertEqual(basic.levels.reduce((n, l) => n + l.cards.length, 0), 40);
  assertEqual((await parseBytes(await fetchBytes('../examples/primer.csv'), 'f')).levels[0].cards.length, 10);
  assertEqual((await parseBytes(await fetchBytes('../examples/primer.json'), 'f')).levels.length, 2);
});

// ---------- ссылки ----------

test('ссылка: уровень туда и обратно', async () => {
  const level = {
    title: 'Урок «Тест» & <проверка>',
    description: 'описание',
    cards: [card('你好', 'nǐ hǎo', 'привет, здравствуйте'), card('谢谢', 'xièxie', 'спасибо')],
  };
  const link = await levelToLink(level);
  if (!/#import=z[A-Za-z0-9_-]+$/.test(link)) throw new Error(`странная ссылка: ${link}`);
  const r = await resultFromLink(`Лови уровень: ${link} `);
  assertEqual(r.levels, [level]);
});

test('ссылка: 100 карточек помещаются в сообщение Telegram', async () => {
  const cards = Array.from({ length: 100 }, (_, i) => card(`汉字${i}`, `hànzì ${i}`, `иероглиф номер ${i}`));
  const link = await levelToLink({ title: 'Большой', description: '', cards });
  if (link.length > 4096) throw new Error(`длина ${link.length}`);
});

test('ссылка: обрезанная и чужая отклоняются', async () => {
  const link = await levelToLink({ title: 'A', description: '', cards: [card('人', 'rén', 'человек')] });
  await assertRejects(() => resultFromLink(link.slice(0, -6)));
  await assertRejects(() => resultFromLink('https://example.com/#import=xyz'));
});

// ---------- запуск ----------

const list = document.getElementById('results');
let failed = 0;
for (const { name, fn } of tests) {
  const li = document.createElement('li');
  try {
    await fn();
    li.className = 'ok';
    li.textContent = `✓ ${name}`;
  } catch (e) {
    failed++;
    li.className = 'fail';
    li.textContent = `✗ ${name}\n${e.message}`;
  }
  list.append(li);
}
document.getElementById('summary').textContent = failed
  ? `Провалено: ${failed} из ${tests.length}`
  : `Все тесты прошли: ${tests.length}`;
window.testResult = { total: tests.length, failed };
