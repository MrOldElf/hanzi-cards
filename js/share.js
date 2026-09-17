import { ImportError } from './errors.js';

/*
 * Уровень целиком упаковывается в ссылку: https://…/#import=z<данные>
 * Данные — сжатый JSON в base64url. Часть после «#» не отправляется на сервер,
 * так что карточки никуда не уходят, а сайт остаётся статическим.
 */

const MARKER = '#import=';

export const isLevelLink = (text) => text.includes(MARKER);

export async function levelToLink(level) {
  const payload = {
    t: level.title,
    d: level.description || undefined,
    c: level.cards.map((c) => [c.hanzi, c.pinyin, c.translation]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const base = location.origin + location.pathname;
  if (typeof CompressionStream !== 'undefined') {
    return `${base}${MARKER}z${toBase64Url(await transform(bytes, new CompressionStream('deflate-raw')))}`;
  }
  return `${base}${MARKER}j${toBase64Url(bytes)}`;
}

export async function resultFromLink(text) {
  const start = text.indexOf(MARKER);
  if (start < 0) throw new ImportError('Это не ссылка на уровень.');
  const data = text.slice(start + MARKER.length).trim().split(/\s/)[0];
  const kind = data[0];

  try {
    let bytes = fromBase64Url(data.slice(1));
    if (kind === 'z') {
      if (typeof DecompressionStream === 'undefined') {
        throw new ImportError('Браузер слишком старый, чтобы открыть эту ссылку. Обновите браузер или попросите файл уровня.');
      }
      bytes = await transform(bytes, new DecompressionStream('deflate-raw'));
    } else if (kind !== 'j') {
      throw new Error('unknown format');
    }

    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const cards = (Array.isArray(payload.c) ? payload.c : [])
      .filter(Array.isArray)
      .map(([hanzi, pinyin, translation]) => ({
        hanzi: String(hanzi ?? '').trim(),
        pinyin: String(pinyin ?? '').trim(),
        translation: String(translation ?? '').trim(),
      }))
      .filter((c) => c.hanzi);
    if (!cards.length) throw new Error('empty');

    return {
      levels: [{ title: String(payload.t || 'Новый уровень').trim(), description: String(payload.d || ''), cards }],
      skippedLines: [],
    };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('Ссылка повреждена или обрезана. Попросите отправить её ещё раз.');
  }
}

async function transform(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}
