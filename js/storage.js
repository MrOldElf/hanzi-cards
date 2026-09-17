/*
 * Всё хранится в localStorage этого браузера:
 * загруженные уровни, число прохождений и незаконченная сессия по каждому уровню.
 */

const LEVELS_KEY = 'hanzi.levels';
const COMPLETIONS_KEY = 'hanzi.completions';
const SESSION_PREFIX = 'hanzi.session.';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error('Не удалось сохранить данные: в хранилище браузера закончилось место или оно недоступно.');
  }
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ---------- уровни ----------

export function loadUserLevels() {
  const levels = read(LEVELS_KEY, []);
  return Array.isArray(levels) ? levels.filter((l) => l && l.id && l.title && Array.isArray(l.cards)) : [];
}

/** Добавляет уровни; уровень с уже существующим названием заменяется. */
export function importLevels(parsed) {
  const levels = loadUserLevels();
  let added = 0;
  let updated = 0;
  for (const p of parsed) {
    const index = levels.findIndex((l) => l.title.toLowerCase() === p.title.toLowerCase());
    if (index >= 0) {
      levels[index] = { ...levels[index], title: p.title, description: p.description, cards: p.cards };
      updated++;
    } else {
      levels.push({ id: newId(), title: p.title, description: p.description, cards: p.cards });
      added++;
    }
  }
  write(LEVELS_KEY, levels);
  return { added, updated };
}

export function deleteLevel(id) {
  write(LEVELS_KEY, loadUserLevels().filter((l) => l.id !== id));
  resetProgress(id);
}

// ---------- прогресс ----------

export const getCompletions = () => read(COMPLETIONS_KEY, {});

export function markCompleted(id) {
  const completions = getCompletions();
  completions[id] = (completions[id] || 0) + 1;
  write(COMPLETIONS_KEY, completions);
}

export function resetProgress(id) {
  const completions = getCompletions();
  delete completions[id];
  write(COMPLETIONS_KEY, completions);
  clearSession(id);
}

// ---------- незаконченное прохождение ----------

/** Отпечаток набора карточек: если учитель обновил уровень, старая сессия не подходит. */
function signature(level) {
  let hash = 0;
  for (const card of level.cards) {
    for (const ch of card.hanzi) hash = (hash * 31 + ch.codePointAt(0)) | 0;
  }
  return `${level.cards.length}:${hash}`;
}

export function loadSession(level) {
  const s = read(SESSION_PREFIX + level.id, null);
  if (!s || s.sig !== signature(level) || !Array.isArray(s.queue) || !s.queue.length) return null;
  if (s.queue.some((i) => !Number.isInteger(i) || i < 0 || i >= level.cards.length)) return null;
  return s;
}

export function saveSession(level, session) {
  try {
    localStorage.setItem(SESSION_PREFIX + level.id, JSON.stringify({ ...session, sig: signature(level) }));
  } catch {
    // не критично: прохождение просто начнётся заново
  }
}

export function clearSession(id) {
  try {
    localStorage.removeItem(SESSION_PREFIX + id);
  } catch {
    // ignore
  }
}
