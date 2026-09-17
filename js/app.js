import { ImportError } from './errors.js';
import { parseBytes, parseText } from './parser.js';
import { isLevelLink, levelToLink, resultFromLink } from './share.js';
import { speaker } from './speech.js';
import * as store from './storage.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const app = document.getElementById('app');
const dialog = document.getElementById('dialog');
const fileInput = document.getElementById('file-input');

const state = {
  builtIn: [],
  builtInStatus: 'loading', // loading | ready | error
  user: store.loadUserLevels(),
  completions: store.getCompletions(),
};

let currentScreen = null;
let screenActions = {};
let screenCleanup = null;
let dialogActions = {};
/** Экран открыт переходом из списка — «Назад» может просто вернуться по истории. */
let pushedFromList = false;

// ---------- утилиты ----------

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function cardsCount(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word = 'карточек';
  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) word = 'карточка';
    else if (mod10 >= 2 && mod10 <= 4) word = 'карточки';
  }
  return `${n} ${word}`;
}

const ICONS = {
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  file: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isTouch = () => matchMedia('(pointer: coarse)').matches;

function baseName(fileName) {
  const name = fileName.replace(/^.*[\\/]/, '');
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'Новый уровень';
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function copyText(text, fallbackField) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallbackField) return false;
    fallbackField.select();
    return document.execCommand('copy');
  }
}

function toast(text) {
  if (!text) return;
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

const allLevels = () => [...state.builtIn, ...state.user];
const findLevel = (id) => allLevels().find((l) => l.id === id);

function refreshUser() {
  state.user = store.loadUserLevels();
  state.completions = store.getCompletions();
}

// ---------- экраны и диалоги ----------

function setScreen(name, html, actions, cleanup = null) {
  screenCleanup?.();
  screenCleanup = cleanup;
  if (currentScreen !== name) window.scrollTo(0, 0);
  currentScreen = name;
  screenActions = actions;
  app.innerHTML = html;
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  const action = el && screenActions[el.dataset.action];
  if (action) {
    e.preventDefault();
    action(el);
  }
});

function openDialog(html, actions = {}) {
  dialog.innerHTML = `<div class="sheet">${html}</div>`;
  dialogActions = { close: closeDialog, ...actions };
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  if (dialog.open) dialog.close();
  dialog.innerHTML = '';
  dialogActions = {};
}

dialog.addEventListener('click', (e) => {
  if (e.target === dialog) {
    closeDialog();
    return;
  }
  const el = e.target.closest('[data-action]');
  const action = el && dialogActions[el.dataset.action];
  if (action) {
    e.preventDefault();
    action(el);
  }
});

function showMessage(title, text) {
  openDialog(`
    <h2>${esc(title)}</h2>
    <p class="pre">${esc(text)}</p>
    <div class="dialog-buttons"><button class="btn text" data-action="close">OK</button></div>`);
}

function showError(error) {
  console.error(error);
  const text = error instanceof ImportError || error?.message?.startsWith('Не удалось')
    ? error.message
    : `Не удалось прочитать данные: ${error?.message ?? error}`;
  showMessage('Не получилось', text);
}

function navigate(hash) {
  pushedFromList = true;
  location.hash = hash;
}

function goHome() {
  if (pushedFromList) {
    pushedFromList = false;
    history.back();
  } else {
    location.replace('#/');
  }
}

function route() {
  const { hash } = location;

  if (hash.startsWith('#import=')) {
    const link = location.href;
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    renderList();
    importFromLink(link);
    return;
  }

  if (hash.startsWith('#/study/')) {
    const level = findLevel(decodeURIComponent(hash.slice('#/study/'.length)));
    if (level) return renderStudy(level);
    if (state.builtInStatus === 'loading') {
      setScreen('loading', '<p class="center muted">Загрузка…</p>', {});
      return;
    }
  }

  if (hash === '#/help') return renderHelp();

  if (hash && hash !== '#/') history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  renderList();
}

// ---------- список уровней ----------

function renderList() {
  pushedFromList = false;
  document.title = 'Иероглифы';

  let builtInHtml;
  if (state.builtIn.length) builtInHtml = state.builtIn.map(levelItem).join('');
  else if (state.builtInStatus === 'loading') builtInHtml = '<p class="muted pad">Загрузка…</p>';
  else builtInHtml = '<p class="muted pad">Не удалось загрузить базовые уровни. Проверьте подключение к интернету.</p>';

  const userHtml = state.user.length
    ? state.user.map(levelItem).join('')
    : `<div class="empty">
        <p>Здесь появятся уровни, которые вы загрузите, например файл или ссылка от учителя.</p>
        <button class="btn text" data-action="import">Загрузить уровень</button>
        <button class="btn text" data-action="help">Как сделать файл?</button>
      </div>`;

  setScreen('list', `
    <header class="topbar">
      <h1>Китайские карточки</h1>
      <button class="icon-btn" data-action="help" aria-label="Помощь" title="Помощь">${icon('info')}</button>
    </header>
    <main class="list">
      <h2 class="section">Базовые уровни</h2>
      ${builtInHtml}
      <h2 class="section">Мои уровни</h2>
      ${userHtml}
    </main>
    <button class="fab" data-action="import">${icon('add')}<span>Загрузить уровень</span></button>`, {
    help: () => navigate('#/help'),
    import: openImportSheet,
    open: (el) => navigate(`#/study/${encodeURIComponent(el.dataset.id)}`),
    menu: (el) => {
      const level = findLevel(el.dataset.id);
      if (level) openLevelMenu(level);
    },
  });
}

function levelItem(level) {
  const completions = state.completions[level.id] || 0;
  const saved = store.loadSession(level);
  const session = saved && (saved.mistakes > 0 || saved.queue.length < level.cards.length) ? saved : null;
  const preview = [...(level.cards[0]?.hanzi ?? '')].slice(0, 2).join('');

  const meta = [esc(cardsCount(level.cards.length))];
  if (session) meta.push(`<span class="in-progress">начат: ${level.cards.length - session.queue.length} из ${level.cards.length}</span>`);
  if (completions) meta.push(`<span class="done">✓ пройден${completions > 1 ? ` ×${completions}` : ''}</span>`);

  return `
    <article class="level">
      <button class="level-main" data-action="open" data-id="${esc(level.id)}">
        <span class="level-icon ${[...preview].length > 1 ? 'two' : ''}" lang="zh-CN">${esc(preview)}</span>
        <span class="level-text">
          <span class="level-title">${esc(level.title)}</span>
          ${level.description ? `<span class="level-desc">${esc(level.description)}</span>` : ''}
          <span class="level-meta">${meta.join(' · ')}</span>
        </span>
      </button>
      <button class="icon-btn" data-action="menu" data-id="${esc(level.id)}" aria-label="Действия с уровнем">${icon('more')}</button>
    </article>`;
}

function openLevelMenu(level) {
  const hasProgress = (state.completions[level.id] || 0) > 0 || store.loadSession(level) !== null;
  openDialog(`
    <h2>${esc(level.title)}</h2>
    <button class="menu-item" data-action="link">${icon('link')}<span>Отправить ссылкой<small>Ученик откроет ссылку, и уровень добавится</small></span></button>
    <button class="menu-item" data-action="file">${icon('download')}<span>${isTouch() ? 'Отправить файлом' : 'Скачать файл'}<small>Файл уровня в формате JSON</small></span></button>
    ${hasProgress ? `<button class="menu-item" data-action="reset">${icon('refresh')}<span>Сбросить прогресс</span></button>` : ''}
    ${level.builtIn ? '' : `<button class="menu-item danger" data-action="delete">${icon('delete')}<span>Удалить</span></button>`}
    <div class="dialog-buttons"><button class="btn text" data-action="close">Закрыть</button></div>`, {
    link: () => shareLink(level),
    file: () => {
      closeDialog();
      shareFile(level);
    },
    reset: () => {
      store.resetProgress(level.id);
      refreshUser();
      closeDialog();
      renderList();
      toast('Прогресс сброшен');
    },
    delete: () => confirmDelete(level),
  });
}

function confirmDelete(level) {
  openDialog(`
    <h2>Удалить уровень?</h2>
    <p>«${esc(level.title)}» и прогресс по нему будут удалены с этого устройства.</p>
    <div class="dialog-buttons">
      <button class="btn text" data-action="close">Отмена</button>
      <button class="btn text danger" data-action="confirm">Удалить</button>
    </div>`, {
    confirm: () => {
      try {
        store.deleteLevel(level.id);
      } catch (e) {
        showError(e);
        return;
      }
      refreshUser();
      closeDialog();
      renderList();
      toast('Уровень удалён');
    },
  });
}

async function shareLink(level) {
  let url;
  try {
    url = await levelToLink(level);
  } catch (e) {
    showError(e);
    return;
  }
  const long = url.length > 3500;
  openDialog(`
    <h2>Ссылка на уровень</h2>
    <p>Отправьте её ученикам в мессенджер. По ссылке откроется приложение и предложит добавить уровень «${esc(level.title)}».</p>
    ${long ? `<p class="warn">Уровень большой: в ссылке ${url.length} символов, она может не поместиться в одно сообщение. Надёжнее отправить файлом.</p>` : ''}
    <textarea class="link-box" rows="3" readonly>${esc(url)}</textarea>
    <div class="dialog-buttons">
      <button class="btn text" data-action="close">Закрыть</button>
      <button class="btn text" data-action="copy">Копировать</button>
      ${navigator.share ? '<button class="btn primary" data-action="share">Поделиться</button>' : ''}
    </div>`, {
    copy: async (el) => {
      if (await copyText(url, dialog.querySelector('.link-box'))) el.textContent = 'Скопировано ✓';
    },
    share: () => {
      navigator.share({ title: level.title, text: `Уровень «${level.title}»: карточки с иероглифами`, url }).catch(() => {});
    },
  });
}

async function shareFile(level) {
  const json = JSON.stringify({ title: level.title, description: level.description || '', cards: level.cards }, null, 2);
  const name = level.title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'уровень';
  const file = new File([json], `${name}.json`, { type: 'application/json' });

  if (isTouch() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: level.title });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- импорт ----------

function openImportSheet() {
  openDialog(`
    <h2>Загрузить уровень</h2>
    <button class="option" data-action="pick">${icon('file')}<span><b>Выбрать файл</b><small>Excel (.xlsx), CSV или JSON</small></span></button>
    <label class="paste-label" for="paste-area">
      <b>Или вставьте ссылку на уровень</b>
      <small>Можно вставить и строки таблицы: иероглиф;пиньинь;перевод</small>
    </label>
    <textarea id="paste-area" rows="3" placeholder="Ссылка или текст" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
    <div class="dialog-buttons">
      <button class="btn text" data-action="close">Отмена</button>
      <button class="btn primary" data-action="paste">Добавить</button>
    </div>`, {
    pick: () => {
      closeDialog();
      fileInput.click();
    },
    paste: async () => {
      const field = dialog.querySelector('#paste-area');
      const text = field.value.trim();
      if (!text) {
        field.focus();
        return;
      }
      try {
        showImportPreview(isLevelLink(text) ? await resultFromLink(text) : parseText(text, 'Новый уровень'));
      } catch (e) {
        showError(e);
      }
    },
  });
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  try {
    if (file.size > MAX_FILE_SIZE) throw new ImportError('Файл слишком большой (больше 5 МБ).');
    showImportPreview(await parseBytes(await file.arrayBuffer(), baseName(file.name)));
  } catch (e) {
    showError(e);
  }
});

async function importFromLink(link) {
  try {
    showImportPreview(await resultFromLink(link), link);
  } catch (e) {
    showError(e);
  }
}

function showImportPreview(result, fromLink = null) {
  const existing = new Set(state.user.map((l) => l.title.toLowerCase()));
  const levelsHtml = result.levels.map((level) => `
    <div class="preview-level">
      <div><b>«${esc(level.title)}»</b>: ${esc(cardsCount(level.cards.length))}</div>
      ${existing.has(level.title.toLowerCase()) ? '<div class="small muted">заменит уровень с таким же названием</div>' : ''}
      ${level.cards.slice(0, 3).map((c) => `<div class="sample"><span lang="zh-CN">${esc(c.hanzi)}</span> · ${esc(c.pinyin)} · ${esc(c.translation)}</div>`).join('')}
      ${level.cards.length > 3 ? '<div class="sample">…</div>' : ''}
    </div>`).join('');

  const skipped = result.skippedLines;
  const skippedHtml = skipped.length
    ? `<p class="warn">Пропущены строки с ошибками: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? '…' : ''}.<br>Формат строки: иероглиф;пиньинь;перевод</p>`
    : '';

  // На iPhone приложение с экрана «Домой» и Safari хранят данные раздельно,
  // а мессенджеры открывают ссылки во встроенном браузере.
  const outsideApp = fromLink && isTouch() && !isStandalone();
  const noteHtml = outsideApp
    ? `<div class="note">
        Если «Иероглифы» установлены на экран «Домой», эта страница открыта не в приложении.
        Скопируйте ссылку, откройте приложение и вставьте её: «Загрузить уровень» → поле для ссылки.
        <button class="btn text" data-action="copy-link">Скопировать ссылку</button>
      </div>`
    : '';

  const count = result.levels.length;
  openDialog(`
    <h2>${count === 1 ? 'Добавить уровень?' : `Добавить уровни (${count})?`}</h2>
    ${levelsHtml}${skippedHtml}${noteHtml}
    <div class="dialog-buttons">
      <button class="btn text" data-action="close">Отмена</button>
      <button class="btn primary" data-action="confirm">Добавить</button>
    </div>`, {
    'copy-link': async (el) => {
      if (await copyText(fromLink)) el.textContent = 'Скопировано ✓';
    },
    confirm: () => {
      let summary;
      try {
        summary = store.importLevels(result.levels);
      } catch (e) {
        showError(e);
        return;
      }
      refreshUser();
      closeDialog();
      route();
      toast([
        summary.added && `Добавлено уровней: ${summary.added}`,
        summary.updated && `Обновлено уровней: ${summary.updated}`,
      ].filter(Boolean).join(' · '));
    },
  });
}

// ---------- прохождение уровня ----------

/*
 * Карточки идут по кругу в случайном порядке.
 * «Знаю» убирает карточку из колоды; «Не знаю» показывает ответ, и карточка уходит в конец.
 * Уровень пройден, когда на каждой карточке нажато «Знаю».
 * Незаконченное прохождение сохраняется и продолжается при следующем открытии.
 */
function renderStudy(level) {
  const total = level.cards.length;
  const fresh = () => ({ queue: shuffle([...level.cards.keys()]), mistakes: 0, failed: false, revealed: false });
  let s = store.loadSession(level) ?? fresh();
  let completedReported = false;

  document.title = `${level.title} — Иероглифы`;

  const onKey = (e) => {
    if (dialog.open || e.altKey || e.ctrlKey || e.metaKey || !s.queue.length) return;
    const onControl = e.target.closest?.('button, a, input, textarea');
    switch (e.key) {
      case ' ':
      case 'Enter':
        if (onControl) return;
        e.preventDefault();
        if (s.failed) next(); else flip();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        flip();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (s.failed) next(); else know();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (s.failed) next(); else dontKnow();
        break;
      default:
    }
  };

  const unsubscribe = speaker.onChange(() => {
    const button = app.querySelector('.speak');
    if (button) button.hidden = !speaker.available;
  });

  setScreen('study', `
    <header class="topbar">
      <button class="icon-btn" data-action="back" aria-label="Назад" title="Назад">${icon('back')}</button>
      <h1>${esc(level.title)}</h1>
      <button class="icon-btn" data-action="restart" aria-label="Начать заново" title="Начать заново">${icon('refresh')}</button>
    </header>
    <main class="study">
      <div class="progress" role="progressbar" aria-label="Выучено" aria-valuemin="0" aria-valuemax="${total}"><div class="progress-bar"></div></div>
      <div class="counts"><span class="known"></span><span class="left"></span></div>
      <div class="stage"></div>
      <div class="actions"></div>
    </main>`, {
    back: goHome,
    home: goHome,
    restart,
    again: restart,
    flip,
    know,
    dontknow: dontKnow,
    next,
    speak: () => {
      const card = currentCard();
      if (card) speaker.speak(card.hanzi);
    },
  }, () => {
    document.removeEventListener('keydown', onKey);
    unsubscribe();
    speaker.stop();
  });
  document.addEventListener('keydown', onKey);

  const $ = (selector) => app.querySelector(selector);

  function currentCard() {
    return s.queue.length ? level.cards[s.queue[0]] : null;
  }

  function save() {
    if (s.queue.length) store.saveSession(level, s);
    else store.clearSession(level.id);
  }

  function renderCard(animate) {
    const known = total - s.queue.length;
    $('.progress-bar').style.width = `${(known / total) * 100}%`;
    $('.progress').setAttribute('aria-valuenow', known);
    $('.known').textContent = `Знаю: ${known} из ${total}`;
    $('.left').textContent = `Осталось: ${s.queue.length}`;

    const card = currentCard();
    if (!card) {
      renderFinish();
      return;
    }
    const length = Math.min([...card.hanzi].length, 5);
    $('.stage').innerHTML = `
      <div class="flashcard${animate ? ' enter' : ''}${s.revealed ? ' revealed' : ''}" data-action="flip"
           role="button" tabindex="0" aria-expanded="${s.revealed}">
        <div class="hanzi len${length}" lang="zh-CN">${esc(card.hanzi)}</div>
        <div class="answer"><div>
          ${card.pinyin ? `<div class="pinyin">${esc(card.pinyin)}</div>` : ''}
          ${card.translation ? `<div class="translation">${esc(card.translation)}</div>` : ''}
          <button class="speak" data-action="speak"${speaker.available ? '' : ' hidden'}>${icon('volume')}Произнести</button>
        </div></div>
        <div class="hint">Нажмите на карточку, чтобы увидеть подсказку</div>
      </div>`;
    renderActions();
  }

  function renderActions() {
    $('.actions').innerHTML = s.failed
      ? '<button class="btn big primary" data-action="next">Дальше</button>'
      : `<button class="btn big outline danger" data-action="dontknow">Не знаю</button>
         <button class="btn big success" data-action="know">Знаю</button>`;
  }

  function setRevealed(revealed) {
    s.revealed = revealed;
    const card = $('.flashcard');
    card.classList.toggle('revealed', revealed);
    card.setAttribute('aria-expanded', revealed);
  }

  function flip() {
    if (!currentCard()) return;
    setRevealed(!s.revealed);
    save();
  }

  function know() {
    if (!currentCard() || s.failed) return;
    s.queue.shift();
    s.revealed = false;
    save();
    renderCard(true);
  }

  function dontKnow() {
    if (!currentCard() || s.failed) return;
    s.mistakes++;
    s.failed = true;
    setRevealed(true);
    save();
    renderActions();
  }

  function next() {
    if (!s.failed) return;
    s.queue.push(s.queue.shift());
    s.failed = false;
    s.revealed = false;
    save();
    renderCard(true);
  }

  function restart() {
    s = fresh();
    completedReported = false;
    store.clearSession(level.id);
    renderCard(true);
  }

  function renderFinish() {
    if (!completedReported) {
      completedReported = true;
      store.markCompleted(level.id);
      state.completions = store.getCompletions();
    }
    $('.actions').innerHTML = '';
    $('.stage').innerHTML = `
      <div class="finish">
        <div class="emoji" aria-hidden="true">🎉</div>
        <h2>Уровень пройден!</h2>
        <p class="big-text">Выучено: ${esc(cardsCount(total))}</p>
        <p class="muted">${s.mistakes ? `Нажатий «Не знаю»: ${s.mistakes}` : 'Ни одного «Не знаю», отлично!'}</p>
        <button class="btn primary" data-action="again">Пройти ещё раз</button>
        <button class="btn outline" data-action="home">К списку уровней</button>
      </div>`;
  }

  renderCard(false);
}

// ---------- помощь ----------

function renderHelp() {
  document.title = 'Помощь — Иероглифы';
  setScreen('help', `
    <header class="topbar">
      <button class="icon-btn" data-action="back" aria-label="Назад" title="Назад">${icon('back')}</button>
      <h1>Помощь</h1>
    </header>
    <main class="help">
      <h2>Установка на телефон</h2>
      <p><b>iPhone:</b> откройте сайт в Safari → кнопка «Поделиться» → «На экран „Домой“».</p>
      <p><b>Android:</b> откройте сайт в Chrome → меню ⋮ → «Установить приложение» или «Добавить на главный экран».</p>
      <p>После первого открытия приложение работает и без интернета.</p>

      <h2>Для учителя: как сделать уровень</h2>
      <ol>
        <li>Создайте таблицу в Excel или Google Таблицах: столбец A — иероглиф, B — пиньинь, C — перевод.</li>
        <li>В первую ячейку можно написать название: <code>#название: Урок 5</code>, ниже — <code>#описание: …</code></li>
        <li>Каждый лист книги Excel — отдельный уровень. Без строки <code>#название:</code> уровень назовётся по имени листа.</li>
        <li>Сохраните файл (.xlsx или CSV) и загрузите в приложение: «Загрузить уровень» → «Выбрать файл».</li>
      </ol>
      <pre lang="zh-CN">#название: Урок 5. Еда
#описание: Продукты и напитки
иероглиф;пиньинь;перевод
米饭;mǐfàn;рис
茶;chá;чай</pre>
      <p>Если загрузить уровень с уже существующим названием, он обновится.</p>

      <h2>Как отправить уровень ученикам</h2>
      <p><b>Ссылкой</b> удобнее всего: загрузите уровень себе, нажмите ⋮ рядом с ним → «Отправить ссылкой». Для очень больших уровней (сотни карточек) ссылка может не поместиться в сообщение, тогда отправьте файлом.</p>
      <p><b>Файлом:</b> отправьте саму таблицу или ⋮ → «Отправить файлом».</p>

      <h2>Для ученика</h2>
      <p><b>Ссылка:</b> нажмите на неё, откроется сайт и предложит добавить уровень. Если приложение установлено на экран «Домой», лучше скопировать ссылку (долгое нажатие → «Копировать»), открыть приложение → «Загрузить уровень» и вставить её в поле.</p>
      <p><b>Файл:</b> сохраните его на телефон (на iPhone — «Сохранить в Файлы»), затем «Загрузить уровень» → «Выбрать файл».</p>

      <h2>Примеры файлов</h2>
      <div class="downloads">
        <a class="btn tonal" href="examples/primer.xlsx" download="пример_уровней.xlsx">Excel</a>
        <a class="btn tonal" href="examples/primer.csv" download="пример_уровня.csv">CSV</a>
        <a class="btn tonal" href="examples/primer.json" download="пример_уровней.json">JSON</a>
      </div>

      <h2>Озвучка</h2>
      <p>Кнопка «Произнести» использует голоса, встроенные в телефон. Если китайского голоса нет, кнопка не появится. На iPhone голос можно добавить: Настройки → Универсальный доступ → Устный контент → Голоса → Китайский.</p>

      <h2>Где хранятся данные</h2>
      <p>Уровни и прогресс хранятся только на этом устройстве, в памяти браузера. Если удалить приложение с экрана «Домой» или очистить данные сайта, они пропадут.</p>

      <p class="muted small">На компьютере: пробел — подсказка, → — «Знаю», ← — «Не знаю», Enter — «Дальше».</p>
    </main>`, { back: goHome });
}

// ---------- запуск ----------

async function loadBuiltIn() {
  try {
    const response = await fetch('levels/index.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const files = await response.json();
    const levels = [];
    for (const file of files) {
      try {
        const r = await fetch(`levels/${encodeURI(file)}`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const result = await parseBytes(await r.arrayBuffer(), baseName(file));
        for (const level of result.levels) {
          let id = `site:${level.title}`;
          while (levels.some((l) => l.id === id)) id += '+';
          levels.push({ ...level, id, builtIn: true });
        }
      } catch (e) {
        console.warn(`Не удалось загрузить levels/${file}`, e);
      }
    }
    state.builtIn = levels;
    state.builtInStatus = 'ready';
  } catch (e) {
    console.warn('Не удалось загрузить список базовых уровней', e);
    state.builtInStatus = 'error';
  }
  if (currentScreen === 'list' || currentScreen === 'loading') route();
}

window.addEventListener('hashchange', route);
route();
loadBuiltIn();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
}
if (isStandalone()) {
  navigator.storage?.persist?.().catch(() => {});
}
