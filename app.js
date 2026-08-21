// Main application: state, rendering, event handling.
// Relies on globals from csv.js and store.js (no bundler / plain <script> includes).

const CARD_GAP = 12;
const CARD_MIN_WIDTH = 270; // slider floor; also the default card width
const CARD_MAX_WIDTH = CARD_MIN_WIDTH * 2;
const CARD_MIN_HEIGHT = 200; // slider floor
const CARD_MAX_HEIGHT = CARD_MIN_HEIGHT * 2;

let words = loadWords();
let progress = loadProgress();
let settings = loadSettings();
const ui = {
  activeCategory: null, // null = all categories
  filterMode: null, // null | 'unmemorized' | 'important'
  startIndex: 0,
  revealedIds: new Set(), // transient: which cards are "flipped" in test modes
  focusedIndex: null, // index within current window; null = no card focused yet
  exportOpen: false,
  exportStatus: { all: true, unmemorized: false, important: false },
  exportCategories: null, // Set, lazily initialized when export panel opens
  collapsedCategories: new Set(), // category names folded in the progress panel
  shuffleActive: false,
  shuffledIds: null, // word ids in shuffled order, snapshot of the filtered range at shuffle time
  preShuffleStartIndex: 0, // restored when shuffle is toggled back off
  fitWidthActive: false,
  preFitCardWidth: null, // settings.cardWidth snapshot, restored when fit is toggled off
  mobileDrawerOpen: false, // mobile-only: hamburger-triggered left drawer
  mobileDrawerView: 'progress', // 'progress' | 'settings', which drawer page is showing
  helpOpen: false,
  search: {
    query: '',
    scope: 'word-meaning', // 'word-meaning' | 'word' | 'meaning'
    advancedOpen: false,
    memorized: false,
    unmemorized: false,
    important: false,
    useRegex: false, // interpret query as a regular expression instead of a literal substring
    categories: null, // Set, lazily initialized when advanced search opens
  },
};

const SEARCH_SCOPE_OPTIONS = [
  { value: 'word-meaning', label: '표제어+뜻' },
  { value: 'word', label: '표제어' },
  { value: 'meaning', label: '뜻' },
];

resyncProgress(words);

// ---------- state helpers ----------

function resyncProgress(list) {
  let changed = false;
  const seen = new Set();
  for (const w of list) {
    seen.add(w.id);

    // A CSV carrying progress columns (e.g. exported from another device)
    // always wins for words it names — that's the point of syncing.
    if (w.importedProgress) {
      const ip = w.importedProgress;
      progress[w.id] = {
        memorized: Boolean(ip.memorized),
        important: Boolean(ip.important),
        checked: w.meanings.map((_, i) => Boolean(ip.checked[i])),
      };
      changed = true;
      continue;
    }

    let p = progress[w.id];
    if (!p) {
      p = defaultProgressFor(w);
      progress[w.id] = p;
      changed = true;
      continue;
    }
    if (!Array.isArray(p.checked) || p.checked.length !== w.meanings.length) {
      p.checked = w.meanings.map((_, i) => Boolean(p.checked && p.checked[i]));
      changed = true;
    }
  }
  for (const id of Object.keys(progress)) {
    if (!seen.has(id)) {
      delete progress[id];
      changed = true;
    }
  }
  if (changed) saveProgress(progress);
}

function setWords(newWords) {
  words = newWords;
  resyncProgress(words);
  saveWords(words);
  ui.activeCategory = null;
  ui.filterMode = null;
  ui.exportCategories = null;
  deactivateShuffle();
  resetPaging();
  render();
}

function getCategories() {
  const seen = [];
  const set = new Set();
  for (const w of words) {
    if (!set.has(w.category)) {
      set.add(w.category);
      seen.push(w.category);
    }
  }
  return seen;
}

function isMemorized(word) {
  const p = progress[word.id];
  return Boolean(p && p.memorized);
}

// Shared by every trigger for these two toggles — PC keyboard shortcuts
// (Space/Enter) and mobile gestures (double-tap/long-press) alike, since
// there's no longer a button in the card markup to hang a click handler on.
function toggleMemorized(id) {
  const p = progress[id];
  if (!p) return;
  p.memorized = !p.memorized;
  saveProgress(progress);
  render();
}

function toggleImportant(id) {
  const p = progress[id];
  if (!p) return;
  p.important = !p.important;
  saveProgress(progress);
  render();
}

function computeStats() {
  const total = words.length;
  const memorized = words.filter(isMemorized).length;
  const unmemorized = total - memorized;
  const important = words.filter((w) => progress[w.id] && progress[w.id].important).length;

  const byCategory = getCategories().map((cat) => {
    const inCat = words.filter((w) => w.category === cat);
    const memoInCat = inCat.filter(isMemorized).length;
    return {
      category: cat,
      total: inCat.length,
      memorized: memoInCat,
      rate: inCat.length ? Math.round((memoInCat / inCat.length) * 100) : 0,
      unmemorized: inCat.length - memoInCat,
      important: inCat.filter((w) => progress[w.id] && progress[w.id].important).length,
    };
  });

  return {
    total,
    memorized,
    memoRate: total ? Math.round((memorized / total) * 100) : 0,
    unmemorized,
    important,
    byCategory,
  };
}

function matchesFilter(word, filter) {
  const p = progress[word.id];
  if (filter === 'unmemorized') return !p || !p.memorized;
  if (filter === 'important') return Boolean(p && p.important);
  return true;
}

function getFilteredWords() {
  let list = words;
  if (ui.activeCategory) list = list.filter((w) => w.category === ui.activeCategory);
  if (ui.filterMode) list = list.filter((w) => matchesFilter(w, ui.filterMode));
  return list;
}

// True once any advanced filter departs from its default (all categories,
// no memorized/important checkbox) — used both to decide whether a search
// is "active" with an empty query, and to badge the advanced-search button.
function isSearchAdvancedActive() {
  const s = ui.search;
  if (s.memorized || s.unmemorized || s.important || s.useRegex) return true;
  if (s.categories) {
    const allCats = getCategories();
    if (s.categories.size !== allCats.length) return true;
  }
  return false;
}

// A search is "active" the moment it would actually narrow or reorder the
// feed — either real query text, or a non-default advanced filter. This
// lets the advanced panel's checkboxes work on their own, with an empty
// query text treated as "match everything" within the scope.
function isSearchActive() {
  return Boolean(ui.search.query.trim()) || isSearchAdvancedActive();
}

// null when there's no query to validate, or when it isn't in regex mode —
// both cases where "is the pattern valid" doesn't apply.
function searchRegexError() {
  const s = ui.search;
  if (!s.useRegex || !s.query.trim()) return null;
  try {
    new RegExp(s.query.trim());
    return null;
  } catch (err) {
    return err.message;
  }
}

function matchesSearchScope(word, scope, matcher) {
  const wordMatch = matcher(word.word);
  const meaningMatch = word.meanings.some((m) => matcher(m.meaning || ''));
  if (scope === 'word') return wordMatch;
  if (scope === 'meaning') return meaningMatch;
  return wordMatch || meaningMatch;
}

// Search results are grouped by category (in the same order categories
// otherwise appear throughout the app) and sorted alphabetically within
// each group — a fixed, predictable order rather than the feed's normal
// category-tab/shuffle-driven display, which this bypasses entirely while
// a search is active (see getDisplayWords below).
//
// Regex mode is opt-in (the "정규식 사용" advanced-search toggle) precisely
// so that plain search stays free of surprises — with it off, "*", ".",
// "\" etc. in a query are just literal characters to look for, never
// special syntax. An invalid pattern (regex mode only) matches nothing
// rather than throwing or silently falling back to a literal search.
function getSearchResults() {
  const s = ui.search;
  const query = s.query.trim();
  const cats = s.categories;
  const categoryOrder = new Map(getCategories().map((c, i) => [c, i]));

  let matcher = () => true; // no query — everything passes this stage
  let regexInvalid = false;
  if (query) {
    if (s.useRegex) {
      try {
        const re = new RegExp(query, 'i');
        matcher = (text) => re.test(text);
      } catch (err) {
        regexInvalid = true;
      }
    } else {
      const q = query.toLowerCase();
      matcher = (text) => text.toLowerCase().includes(q);
    }
  }

  if (regexInvalid) return [];

  return words
    .filter((w) => {
      if (cats && !cats.has(w.category)) return false;
      if (!matchesSearchScope(w, s.scope, matcher)) return false;
      const p = progress[w.id];
      if (s.memorized || s.unmemorized) {
        const isMemo = Boolean(p && p.memorized);
        const memoOk = (s.memorized && isMemo) || (s.unmemorized && !isMemo);
        if (!memoOk) return false;
      }
      if (s.important && !(p && p.important)) return false;
      return true;
    })
    .sort((a, b) => {
      const catDiff = (categoryOrder.get(a.category) || 0) - (categoryOrder.get(b.category) || 0);
      if (catDiff !== 0) return catDiff;
      return a.word.localeCompare(b.word, 'ko');
    });
}

// Filtered range, reordered per the active shuffle snapshot (if any). Stats
// always read the plain word list / getFilteredWords(), never this — only
// display order for the feed itself is affected by shuffling. A search in
// progress takes over the source list entirely, ahead of category tab /
// filter-mode / shuffle — those resume once the search is cleared.
function getDisplayWords() {
  if (isSearchActive()) return getSearchResults();
  const filtered = getFilteredWords();
  if (!ui.shuffleActive || !ui.shuffledIds) return filtered;
  const byId = new Map(filtered.map((w) => [w.id, w]));
  return ui.shuffledIds.map((id) => byId.get(id)).filter(Boolean);
}

function deactivateShuffle() {
  ui.shuffleActive = false;
  ui.shuffledIds = null;
}

function currentPageNumber() {
  return Math.floor(ui.startIndex / settings.count) + 1;
}

function totalPageCount() {
  return Math.max(1, Math.ceil(getDisplayWords().length / settings.count));
}

function gotoPage(pageNum) {
  const total = totalPageCount();
  const clamped = Math.max(1, Math.min(total, pageNum));
  ui.startIndex = (clamped - 1) * settings.count;
  ui.revealedIds.clear();
  ui.focusedIndex = null;
  render();
}

function jumpToWordOrdinal(n) {
  const filtered = getDisplayWords();
  if (!Number.isFinite(n) || filtered.length === 0) return;
  const clamped = Math.max(1, Math.min(filtered.length, Math.floor(n)));
  const index = clamped - 1;
  ui.startIndex = Math.floor(index / settings.count) * settings.count;
  ui.focusedIndex = index - ui.startIndex;
  ui.revealedIds.clear();
  render();
}

function toggleShuffle() {
  if (ui.shuffleActive) {
    ui.startIndex = ui.preShuffleStartIndex || 0;
    deactivateShuffle();
  } else {
    const ids = getFilteredWords().map((w) => w.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = ids[i];
      ids[i] = ids[j];
      ids[j] = tmp;
    }
    ui.shuffledIds = ids;
    ui.preShuffleStartIndex = ui.startIndex;
    ui.shuffleActive = true;
    ui.startIndex = 0;
  }
  ui.revealedIds.clear();
  ui.focusedIndex = null;
  render();
}

function clampStartIndex(filteredLen) {
  if (filteredLen === 0) {
    ui.startIndex = 0;
    return;
  }
  if (ui.startIndex > filteredLen - 1) ui.startIndex = Math.max(0, filteredLen - 1);
  if (ui.startIndex < 0) ui.startIndex = 0;
}

function resetPaging() {
  ui.startIndex = 0;
  ui.revealedIds.clear();
  ui.focusedIndex = null;
}

// ---------- rendering ----------

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CIRCLED_NUMBERS = [
  '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
  '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
];
function circledNumber(n) {
  return CIRCLED_NUMBERS[n - 1] || `(${n})`;
}

const DICT_SEARCH_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';

function render() {
  document.body.classList.toggle('dark', settings.darkMode);
  document.getElementById('app').classList.toggle('full-width', settings.widthMode === 'full');

  const fontDef = FONT_OPTIONS.find((f) => f.value === settings.font) || FONT_OPTIONS[0];
  document.documentElement.style.setProperty('--card-font-family', fontDef.stack);
  document.documentElement.style.setProperty('--card-font-size', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--card-font-weight', settings.bold ? '700' : '400');

  const filtered = getDisplayWords();
  clampStartIndex(filtered.length);
  const windowWords = filtered.slice(ui.startIndex, ui.startIndex + settings.count);
  if (ui.focusedIndex !== null && ui.focusedIndex >= windowWords.length) {
    ui.focusedIndex = windowWords.length ? windowWords.length - 1 : null;
  }

  const progressW = settings.progressCollapsed ? 40 : settings.progressWidth || 260;
  const app = document.getElementById('app');

  // #app is sized to whichever is larger: the classic ~1200px default
  // (kept for readability at typical column counts) or whatever `cols`
  // cards actually need at the current card width (so more columns, or a
  // wider manual card-width setting, can widen the layout instead of
  // squeezing cards below a usable width) — capped at the viewport so it
  // never forces page-level horizontal scroll, and centered via
  // margin:auto. Setting an explicit width here (rather than relying on
  // CSS `fit-content`) also sidesteps nested-grid intrinsic-sizing quirks
  // that didn't reliably propagate the card grid's width up through
  // .main / .feed-nav in testing — with a definite width the grid's own
  // tracks size normally.
  if (settings.widthMode === 'full') {
    app.style.width = '';
  } else {
    // +4px: measured empirically — the .cards padding/negative-margin trick
    // (for focus-ring room) resolves a couple px tighter in practice than
    // the arithmetic below predicts, and without slack from the 1200px
    // floor to absorb it, the grid can end up ~2px wider than its
    // container and trigger a horizontal scrollbar.
    const cardsWidth = settings.cols * settings.cardWidth + (settings.cols - 1) * CARD_GAP + 4;
    const feedPanelWidth = cardsWidth + 16 * 2; // feed-panel padding
    const mainWidth = feedPanelWidth + 16 + 10 + 16 + progressW; // main gaps + handle
    const appWidth = mainWidth + 16 * 2; // #app padding
    const targetWidth = Math.max(appWidth, 1200);
    // documentElement.clientWidth (not CSS 100vw) — vw is defined off the
    // initial containing block and in practice doesn't subtract the
    // vertical scrollbar's own width, so a vw-based cap can still let the
    // app render a few px wider than what's actually available, which is
    // exactly enough to trigger a horizontal scrollbar. clientWidth is a
    // real post-layout measurement that already excludes the scrollbar.
    const viewportCap = document.documentElement.clientWidth - 24;
    app.style.width = Math.min(targetWidth, viewportCap) + 'px';
  }
  app.innerHTML =
    renderMobileTopBar() +
    renderToolbar() +
    `<div class="main" style="--progress-w: ${progressW}px;">` +
    renderFeedPanel(filtered, windowWords) +
    (settings.progressCollapsed ? '' : renderResizeHandle('resize-progress', 'v')) +
    renderProgressPanel() +
    '</div>' +
    renderMobileDrawer() +
    (ui.exportOpen ? renderExportPanel() : '') +
    (ui.search.advancedOpen ? renderAdvancedSearchPanel() : '') +
    (ui.helpOpen ? renderHelpPanel() : '');
}

function renderMobileTopBar() {
  return `
  <div class="mobile-topbar">
    <button class="hamburger-btn" data-action="open-mobile-drawer" aria-label="메뉴 열기">☰</button>
    <span class="mobile-topbar-title">단어장</span>
    ${renderSearchBar()}
  </div>`;
}

// Rendered twice — once for the PC placement (feed-header row) and once for
// the mobile placement (top bar) — same markup/state either way; CSS picks
// which copy is actually visible per breakpoint, same pattern as the
// desktop toolbar vs. the mobile drawer's settings view.
function renderSearchBar() {
  const scopeOptionsHtml = SEARCH_SCOPE_OPTIONS.map(
    (o) =>
      `<option value="${o.value}" ${o.value === ui.search.scope ? 'selected' : ''}>${escapeHtml(
        o.label
      )}</option>`
  ).join('');

  const regexError = searchRegexError();

  return `
  <div class="search-bar">
    <select class="search-scope" data-action="search-scope" aria-label="검색 범위">${scopeOptionsHtml}</select>
    <input type="text" class="search-input ${
      regexError ? 'search-input-invalid' : ''
    }" data-action="search-input" placeholder="검색" value="${escapeHtml(
    ui.search.query
  )}" aria-label="단어 검색" title="${regexError ? escapeHtml('잘못된 정규식: ' + regexError) : ''}" />
    <button class="search-advanced-btn ${
      isSearchAdvancedActive() ? 'active' : ''
    }" data-action="open-advanced-search" aria-label="고급 검색">⚙</button>
  </div>`;
}

function renderMobileDrawer() {
  if (!ui.mobileDrawerOpen) return '';
  const body = ui.mobileDrawerView === 'settings' ? renderMobileSettingsView() : renderMobileProgressView();
  return `
  <div class="mobile-drawer-backdrop" data-action="close-mobile-drawer">
    <aside class="mobile-drawer">${body}</aside>
  </div>`;
}

function renderMobileProgressView() {
  const stats = computeStats();

  const filterRow = (label, key) => `
    <div class="stat-row clickable ${ui.filterMode === key && !ui.activeCategory ? 'active' : ''}" data-action="stat-filter" data-filter="${key}">
      <span>${label}</span>
      <span>${stats[key]}개</span>
    </div>`;

  const perCategoryHtml = stats.byCategory
    .map((c) => {
      const subRow = (label, key) => {
        const isActive = ui.activeCategory === c.category && ui.filterMode === key;
        return `<div class="cat-sub-row ${isActive ? 'active' : ''}" data-action="stat-category-filter" data-category="${escapeHtml(
          c.category
        )}" data-filter="${key}"><span>${label}</span><span>${c[key]}개</span></div>`;
      };
      const collapsed = ui.collapsedCategories.has(c.category);
      return `
      <div class="cat-stat">
        <div class="cat-stat-header">
          <button class="cat-fold-btn ${collapsed ? 'collapsed' : ''}" data-action="toggle-fold" data-category="${escapeHtml(
        c.category
      )}" aria-label="접기/펼치기">▾</button>
          <span class="cat-stat-name" data-action="tab" data-category="${escapeHtml(c.category)}">${escapeHtml(
        c.category
      )}</span>
          <span class="cat-stat-rate">${c.rate}%</span>
        </div>
        ${
          collapsed
            ? ''
            : `${subRow('미암기', 'unmemorized')}${subRow('중요', 'important')}`
        }
      </div>`;
    })
    .join('');

  const allActive = !ui.filterMode && !ui.activeCategory;

  return `
    <div class="drawer-header">
      진행률
      <button class="drawer-close-btn" data-action="close-mobile-drawer" aria-label="닫기">×</button>
    </div>
    <div class="stat-row static">
      <span>전체 개수</span>
      <span>${stats.total}개</span>
    </div>
    <div class="stat-row static">
      <span>암기율</span>
      <span><small>${stats.total}개 중 ${stats.memorized}개</small> ${stats.memoRate}%</span>
    </div>
    <div class="stat-row clickable ${allActive ? 'active' : ''}" data-action="tab" data-category="">
      <span>전체 보기</span>
    </div>
    ${filterRow('미암기', 'unmemorized')}
    ${filterRow('중요', 'important')}
    <div class="cat-stats">${perCategoryHtml}</div>
    <button class="drawer-settings-btn" data-action="open-help">📖 사용법</button>
    <button class="drawer-settings-btn" data-action="open-mobile-settings">⚙ 설정</button>
  `;
}

function renderMobileSettingsView() {
  const fontOptionsHtml = FONT_OPTIONS.map(
    (f) =>
      `<option value="${f.value}" ${f.value === settings.font ? 'selected' : ''}>${escapeHtml(
        f.label
      )}</option>`
  ).join('');

  const modeLabels = { memorize: '암기', 'meaning-test': '의미 테스트', 'word-test': '단어 테스트' };
  const modeOptionsHtml = Object.keys(modeLabels)
    .map(
      (m) =>
        `<option value="${m}" ${m === settings.mode ? 'selected' : ''}>${escapeHtml(
          modeLabels[m]
        )}</option>`
    )
    .join('');

  const widthLabels = { contained: '기본 비율', full: '좌우 꽉차게' };
  const widthOptionsHtml = Object.keys(widthLabels)
    .map(
      (m) =>
        `<option value="${m}" ${m === settings.widthMode ? 'selected' : ''}>${escapeHtml(
          widthLabels[m]
        )}</option>`
    )
    .join('');

  return `
    <div class="drawer-header">
      <button class="drawer-back-btn" data-action="back-to-progress" aria-label="뒤로">←</button>
      설정
      <button class="drawer-close-btn" data-action="close-mobile-drawer" aria-label="닫기">×</button>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">데이터</div>
      <button class="btn btn-open" data-action="open-csv">열기</button>
      <button class="btn" data-action="open-export">내보내기</button>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">화면</div>
      <button class="chip-btn ${settings.darkMode ? 'active' : ''}" data-action="toggle-dark">다크모드</button>
      <label class="opt">
        폰트
        <select data-action="select-font">${fontOptionsHtml}</select>
      </label>
      ${stepperControl('글자 크기', settings.fontSize, 'font-size-dec', 'font-size-inc')}
      <button class="chip-btn ${settings.bold ? 'active' : ''}" data-action="toggle-bold">굵게</button>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">레이아웃</div>
      <label class="opt">
        레이아웃
        <select data-action="select-width">${widthOptionsHtml}</select>
      </label>
      <label class="opt">
        모드
        <select data-action="select-mode">${modeOptionsHtml}</select>
      </label>
      ${stepperControl('열', settings.cols, 'cols-dec', 'cols-inc')}
      ${stepperControl('개수', settings.count, 'count-dec', 'count-inc')}
      ${sliderControl('카드 가로', settings.cardWidth, CARD_MIN_WIDTH, Math.max(CARD_MAX_WIDTH, settings.cardWidth), 'card-width-slider')}
      ${sliderControl('카드 세로', settings.cardHeight, CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, 'card-height-slider')}
      <button class="chip-btn ${ui.fitWidthActive ? 'active' : ''}" data-action="fit-card-width">가로 맞춤</button>
    </div>
  `;
}

function renderResizeHandle(action, orientation) {
  return `<div class="resize-handle resize-${orientation}" data-action="${action}" title="드래그하여 크기 조절"></div>`;
}

function renderToolbar() {
  const fontOptionsHtml = FONT_OPTIONS.map(
    (f) =>
      `<option value="${f.value}" ${f.value === settings.font ? 'selected' : ''}>${escapeHtml(
        f.label
      )}</option>`
  ).join('');

  const modeLabels = { memorize: '암기', 'meaning-test': '의미 테스트', 'word-test': '단어 테스트' };
  const modeOptionsHtml = Object.keys(modeLabels)
    .map(
      (m) =>
        `<option value="${m}" ${m === settings.mode ? 'selected' : ''}>${escapeHtml(
          modeLabels[m]
        )}</option>`
    )
    .join('');

  const widthLabels = { contained: '기본 비율', full: '좌우 꽉차게' };
  const widthOptionsHtml = Object.keys(widthLabels)
    .map(
      (m) =>
        `<option value="${m}" ${m === settings.widthMode ? 'selected' : ''}>${escapeHtml(
          widthLabels[m]
        )}</option>`
    )
    .join('');

  const toolbarStyle = settings.toolbarHeight
    ? `style="height:${settings.toolbarHeight}px;overflow-y:auto;"`
    : '';

  if (settings.toolbarCollapsed) {
    return `
  <div class="toolbar collapsed">
    <button class="panel-toggle" data-action="toggle-toolbar-collapse" aria-label="설정 펼치기">▾ 설정</button>
  </div>`;
  }

  return `
  <div class="toolbar">
    <div class="toolbar-row" ${toolbarStyle}>
      <button class="btn btn-open" data-action="open-csv">열기</button>
      <button class="btn" data-action="open-export">내보내기</button>
      <button class="btn" data-action="open-help">사용법</button>
      <button class="chip-btn ${settings.darkMode ? 'active' : ''}" data-action="toggle-dark">다크모드</button>
      <label class="opt">
        폰트
        <select data-action="select-font">${fontOptionsHtml}</select>
      </label>
      ${stepperControl('글자 크기', settings.fontSize, 'font-size-dec', 'font-size-inc')}
      <button class="chip-btn ${settings.bold ? 'active' : ''}" data-action="toggle-bold">굵게</button>
      <label class="opt">
        레이아웃
        <select data-action="select-width">${widthOptionsHtml}</select>
      </label>
      <label class="opt">
        모드
        <select data-action="select-mode">${modeOptionsHtml}</select>
      </label>
      ${stepperControl('열', settings.cols, 'cols-dec', 'cols-inc')}
      ${stepperControl('개수', settings.count, 'count-dec', 'count-inc')}
      ${sliderControl('카드 가로', settings.cardWidth, CARD_MIN_WIDTH, Math.max(CARD_MAX_WIDTH, settings.cardWidth), 'card-width-slider')}
      ${sliderControl('카드 세로', settings.cardHeight, CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, 'card-height-slider')}
      <button class="chip-btn ${ui.fitWidthActive ? 'active' : ''}" data-action="fit-card-width">가로 맞춤</button>
      <button class="panel-toggle" data-action="toggle-toolbar-collapse" aria-label="설정 접기">▴ 접기</button>
    </div>
    ${renderResizeHandle('resize-toolbar', 'h')}
  </div>`;
}

function sliderControl(label, value, min, max, action) {
  return `
      <label class="opt slider-opt">
        ${label}
        <input type="range" min="${min}" max="${max}" step="1" value="${value}" data-action="${action}" />
        <span class="stepper-value">${value}</span>
      </label>`;
}

function stepperControl(label, value, decAction, incAction) {
  return `
      <label class="opt">
        ${label}
        <span class="stepper">
          <button data-action="${decAction}" aria-label="${label} 줄이기">−</button>
          <span class="stepper-value">${value}</span>
          <button data-action="${incAction}" aria-label="${label} 키우기">+</button>
        </span>
      </label>`;
}

function renderFeedPanel(filtered, windowWords) {
  const currentCategoryLabel = isSearchActive() ? '검색 결과' : ui.activeCategory || '전체';

  const positionText = filtered.length
    ? `${filtered.length}개 중 ${ui.startIndex + 1}번째`
    : words.length
    ? '표시할 단어가 없습니다'
    : 'CSV 파일을 불러오세요';

  const cardsHtml = windowWords.map((w, i) => renderCard(w, i, i === ui.focusedIndex)).join('');

  const emptyStateHtml =
    words.length === 0
      ? `<div class="cards-empty">
           <p>불러온 단어장이 없습니다</p>
           <button class="btn btn-primary" data-action="open-csv">CSV 열기</button>
         </div>`
      : '<div class="cards-empty">단어가 없습니다</div>';

  const paginationBar = renderPaginationBar(filtered.length);

  return `
  <section class="feed-panel">
    <div class="feed-header-row">
      <div class="feed-header">단어장 피드</div>
      <button class="chip-btn ${ui.shuffleActive ? 'active' : ''}" data-action="toggle-shuffle">무작위</button>
      <span class="current-category-label">${escapeHtml(currentCategoryLabel)}</span>
      ${renderSearchBar()}
    </div>
    <div class="position-indicator">${positionText}</div>
    <div class="feed-nav-row">
      ${renderJumpBox(filtered.length)}
      ${paginationBar}
    </div>
    <div class="cards" style="grid-template-columns: repeat(${settings.cols}, ${settings.cardWidth}px);">${
    cardsHtml || emptyStateHtml
  }</div>
    <div class="feed-nav-row">
      ${paginationBar}
    </div>
  </section>`;
}

function renderJumpBox(filteredLen) {
  return `
  <div class="jump-box">
    <input type="number" class="jump-input" min="1" max="${
      filteredLen || 1
    }" placeholder="번호" data-action="jump-input" aria-label="단어 순번으로 이동" />
  </div>`;
}

// Mobile shares the same JS-render path as desktop (no separate mobile
// bundle), so this is the one spot that needs to know the viewport class —
// the pagination bar's button count/set genuinely differs by device rather
// than just its CSS presentation. Safe without a resize listener: a phone
// stays "mobile" under this query across a portrait<->landscape rotation
// (the same two breakpoints the mobile CSS uses), so it can't go stale
// between renders the way a plain max-width check would.
function isMobileLayout() {
  return window.matchMedia(
    '(orientation: portrait) and (max-width: 560px), (orientation: landscape) and (max-height: 560px)'
  ).matches;
}

function renderPaginationBar(filteredLen) {
  const mobile = isMobileLayout();
  const totalPages = Math.max(1, Math.ceil(filteredLen / settings.count));
  const currentPage = Math.min(totalPages, currentPageNumber());

  const windowSize = mobile ? 7 : 10;
  let startPage = Math.max(1, currentPage - Math.floor(windowSize / 2));
  let endPage = Math.min(totalPages, startPage + windowSize - 1);
  startPage = Math.max(1, endPage - windowSize + 1);

  let pageButtons = '';
  for (let p = startPage; p <= endPage; p++) {
    pageButtons += `<button class="page-num-btn ${
      p === currentPage ? 'current' : ''
    }" data-action="goto-page" data-page="${p}">${p}</button>`;
  }

  // Mobile drops the step/jump icon buttons entirely — swiping already
  // covers single-page stepping, and the ⏮⏪⏩⏭ row eats too much width on
  // a phone screen for what it adds. Just the tappable page numbers remain.
  if (mobile) {
    return `
  <div class="pagination-bar">
    <div class="page-num-list">${pageButtons}</div>
  </div>`;
  }

  const atFirst = currentPage <= 1;
  const atLast = currentPage >= totalPages;

  return `
  <div class="pagination-bar">
    <button class="page-nav-btn" data-action="page-first" ${
      atFirst ? 'disabled' : ''
    } aria-label="맨 처음 페이지">⏮</button>
    <button class="page-nav-btn" data-action="page-back5" ${
      atFirst ? 'disabled' : ''
    } aria-label="5페이지 뒤로">⏪</button>
    <button class="page-nav-btn" data-action="page-prev" ${
      atFirst ? 'disabled' : ''
    } aria-label="이전 페이지">◀</button>
    <div class="page-num-list">${pageButtons}</div>
    <button class="page-nav-btn" data-action="page-next" ${
      atLast ? 'disabled' : ''
    } aria-label="다음 페이지">▶</button>
    <button class="page-nav-btn" data-action="page-fwd5" ${
      atLast ? 'disabled' : ''
    } aria-label="5페이지 앞으로">⏩</button>
    <button class="page-nav-btn" data-action="page-last" ${
      atLast ? 'disabled' : ''
    } aria-label="맨 마지막 페이지">⏭</button>
  </div>`;
}

function renderCard(word, index, focused) {
  const p = progress[word.id] || defaultProgressFor(word);
  const revealed = ui.revealedIds.has(word.id) || settings.mode === 'memorize';

  const wordVisible = settings.mode !== 'word-test' || revealed;
  const meaningsVisible = settings.mode !== 'meaning-test' || revealed;

  const dictUrl = 'https://dict.naver.com/dict.search?query=' + encodeURIComponent(word.word);
  const importantClass = p.important ? ' important' : '';
  const wordHtml = wordVisible
    ? `<div class="card-word${importantClass}"><span class="card-word-spacer" aria-hidden="true"></span><span class="card-word-text">${escapeHtml(
        word.word
      )}</span><a class="dict-link" href="${escapeHtml(
        dictUrl
      )}" target="_blank" rel="noopener noreferrer" title="네이버 사전에서 검색" aria-label="네이버 사전에서 검색">${DICT_SEARCH_ICON}</a></div>`
    : `<div class="card-word placeholder${importantClass}">탭하여 단어 보기</div>`;

  let meaningsHtml;
  if (meaningsVisible) {
    meaningsHtml = word.meanings.length
      ? word.meanings
          .map((m, i) => {
            const checked = Boolean(p.checked[i]);
            return `
            <div class="meaning-item ${checked ? 'checked' : ''}">
              <button class="check-btn ${checked ? 'checked' : ''}" data-action="toggle-checked" data-id="${escapeHtml(
                word.id
              )}" data-index="${i}" aria-label="${circledNumber(i + 1)}번 뜻 암기 확인">${circledNumber(
                i + 1
              )}</button>
              <div class="meaning-text">
                ${m.meaning ? `<div class="meaning">${escapeHtml(m.meaning)}</div>` : ''}
                ${m.example ? `<div class="example">${escapeHtml(m.example)}</div>` : ''}
              </div>
            </div>`;
          })
          .join('')
      : '<div class="meaning-empty">등록된 뜻이 없습니다</div>';
  } else {
    meaningsHtml = `<div class="meanings-placeholder">탭하여 뜻과 예시 보기</div>`;
  }

  return `
  <div class="word-card ${focused ? 'focused' : ''} ${p.memorized ? 'memorized' : ''}" data-action="card-reveal" data-id="${escapeHtml(
    word.id
  )}" data-index="${index}" style="min-height: ${settings.cardHeight}px;">
    ${wordHtml}
    <div class="card-meanings">${meaningsHtml}</div>
  </div>`;
}

function renderProgressPanel() {
  const stats = computeStats();

  const filterRow = (label, key) => `
    <div class="stat-row clickable ${ui.filterMode === key && !ui.activeCategory ? 'active' : ''}" data-action="stat-filter" data-filter="${key}">
      <span>${label}</span>
      <span>${stats[key]}개</span>
    </div>`;

  const perCategoryHtml = stats.byCategory
    .map((c) => {
      const subRow = (label, key) => {
        const isActive = ui.activeCategory === c.category && ui.filterMode === key;
        return `<div class="cat-sub-row ${isActive ? 'active' : ''}" data-action="stat-category-filter" data-category="${escapeHtml(
          c.category
        )}" data-filter="${key}"><span>${label}</span><span>${c[key]}개</span></div>`;
      };
      const collapsed = ui.collapsedCategories.has(c.category);
      return `
      <div class="cat-stat">
        <div class="cat-stat-header">
          <button class="cat-fold-btn ${collapsed ? 'collapsed' : ''}" data-action="toggle-fold" data-category="${escapeHtml(
        c.category
      )}" aria-label="접기/펼치기">▾</button>
          <span class="cat-stat-name" data-action="tab" data-category="${escapeHtml(c.category)}">${escapeHtml(
        c.category
      )}</span>
          <span class="cat-stat-rate">${c.rate}%</span>
        </div>
        ${
          collapsed
            ? ''
            : `${subRow('미암기', 'unmemorized')}${subRow('중요', 'important')}`
        }
      </div>`;
    })
    .join('');

  if (settings.progressCollapsed) {
    return `
  <aside class="progress-panel collapsed">
    <button class="panel-toggle" data-action="toggle-progress-collapse" aria-label="진행률 펼치기">◂</button>
  </aside>`;
  }

  return `
  <aside class="progress-panel">
    <div class="progress-header">
      진행률
      <button class="panel-toggle" data-action="toggle-progress-collapse" aria-label="진행률 접기">▸</button>
    </div>
    <div class="stat-row static">
      <span>전체 개수</span>
      <span>${stats.total}개</span>
    </div>
    <div class="stat-row static">
      <span>암기율</span>
      <span><small>${stats.total}개 중 ${stats.memorized}개</small> ${stats.memoRate}%</span>
    </div>
    <div class="stat-row clickable ${!ui.filterMode && !ui.activeCategory ? 'active' : ''}" data-action="tab" data-category="">
      <span>전체 보기</span>
    </div>
    ${filterRow('미암기', 'unmemorized')}
    ${filterRow('중요', 'important')}
    <div class="cat-stats">${perCategoryHtml}</div>
  </aside>`;
}

function renderExportPanel() {
  const categories = getCategories();
  if (!ui.exportCategories) ui.exportCategories = new Set(categories);

  const s = ui.exportStatus;
  const statusButton = (label, key) =>
    `<button class="chip-btn ${s[key] ? 'active' : ''}" data-action="export-status" data-status="${key}">${label}</button>`;

  const allCatsChecked = categories.length > 0 && categories.every((c) => ui.exportCategories.has(c));
  const categoryCheckboxes =
    `<button class="chip-btn ${allCatsChecked ? 'active' : ''}" data-action="export-category-all">전체 선택</button>` +
    categories
      .map(
        (c) =>
          `<button class="chip-btn ${
            ui.exportCategories.has(c) ? 'active' : ''
          }" data-action="export-category" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`
      )
      .join('');

  const matchCount = getExportMatches().length;

  return `
  <div class="modal-backdrop" data-action="close-export">
    <div class="modal">
      <div class="modal-header">
        내보내기
        <button class="modal-close" data-action="close-export">×</button>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">진행 상황</div>
        <div class="chip-group">
          ${statusButton('전체', 'all')}
          ${statusButton('미암기', 'unmemorized')}
          ${statusButton('중요단어', 'important')}
        </div>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">단어 분류</div>
        <div class="chip-group">
          ${categoryCheckboxes || '<div class="modal-empty">불러온 단어가 없습니다</div>'}
        </div>
      </div>
      <div class="modal-footer">
        <span class="export-count-preview">${matchCount}개 단어 내보내기</span>
        <button class="btn btn-primary" data-action="do-export">내보내기</button>
      </div>
    </div>
  </div>`;
}

function renderAdvancedSearchPanel() {
  const categories = getCategories();
  if (!ui.search.categories) ui.search.categories = new Set(categories);
  const s = ui.search;

  const filterChip = (label, key) =>
    `<button class="chip-btn ${s[key] ? 'active' : ''}" data-action="search-filter-toggle" data-filter="${key}">${label}</button>`;

  const allCatsChecked = categories.length > 0 && categories.every((c) => s.categories.has(c));
  const categoryChips =
    `<button class="chip-btn ${allCatsChecked ? 'active' : ''}" data-action="search-category-all">전체 선택</button>` +
    categories
      .map(
        (c) =>
          `<button class="chip-btn ${
            s.categories.has(c) ? 'active' : ''
          }" data-action="search-category-toggle" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`
      )
      .join('');

  const regexError = searchRegexError();
  const countText = regexError ? '정규식 오류' : `${getSearchResults().length}개 단어 검색됨`;

  return `
  <div class="modal-backdrop" data-action="close-advanced-search">
    <div class="modal">
      <div class="modal-header">
        고급 검색
        <button class="modal-close" data-action="close-advanced-search">×</button>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">검색 방식</div>
        <div class="chip-group">
          ${filterChip('정규식 사용', 'useRegex')}
        </div>
        ${
          s.useRegex
            ? `<div class="modal-hint">꺼져 있으면 <code>* . \\</code> 같은 특수문자도 그냥 일반 글자로 검색됩니다. 켜면 검색어를 정규표현식으로 해석합니다.</div>`
            : ''
        }
        ${regexError ? `<div class="modal-hint modal-hint-error">잘못된 정규식: ${escapeHtml(regexError)}</div>` : ''}
      </div>
      <div class="modal-section">
        <div class="modal-section-title">진행 상황</div>
        <div class="chip-group">
          ${filterChip('암기', 'memorized')}
          ${filterChip('미암기', 'unmemorized')}
          ${filterChip('중요', 'important')}
        </div>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">단어 분류</div>
        <div class="chip-group">
          ${categoryChips || '<div class="modal-empty">불러온 단어가 없습니다</div>'}
        </div>
      </div>
      <div class="modal-footer">
        <span class="export-count-preview">${countText}</span>
      </div>
    </div>
  </div>`;
}

function renderHelpPanel() {
  return `
  <div class="modal-backdrop" data-action="close-help">
    <div class="modal">
      <div class="modal-header">
        사용법
        <button class="modal-close" data-action="close-help">×</button>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">PC 단축키</div>
        <ul class="help-list">
          <li><b>방향키 / WASD</b> — 카드 포커스 이동 (페이지 끝에서 다음/이전 페이지로 자동 이동)</li>
          <li><b>Space</b> — 포커스된 카드 암기/미암기 체크</li>
          <li><b>Enter</b> — 포커스된 카드 중요 체크/해제</li>
          <li><b>Ctrl + ← / →</b> — 페이지 이동</li>
          <li><b>Ctrl + E</b> — 내보내기 창 열기/닫기</li>
        </ul>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">모바일 동작</div>
        <ul class="help-list">
          <li><b>좌우 스와이프</b> (카드 영역) — 페이지 이동</li>
          <li><b>더블탭</b> (카드) — 암기/미암기 체크</li>
          <li><b>길게 누르기</b> (카드) — 중요 체크/해제</li>
          <li><b>☰ 메뉴</b> — 진행률·분류별 통계, 사용법, 설정</li>
        </ul>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">검색</div>
        <ul class="help-list">
          <li>검색창 왼쪽에서 범위 선택 — <b>표제어+뜻</b>(기본) / 표제어 / 뜻</li>
          <li>결과는 단어 분류별로 묶이고, 그 안에서 가나다순으로 정렬됩니다</li>
          <li><b>⚙ 고급 검색</b> — 암기/미암기/중요, 단어 분류로 좁혀서 검색 (분류는 암기·중요 조건과 AND로 결합됩니다)</li>
          <li><b>정규식 사용</b>을 켜면 검색어를 정규표현식으로 해석합니다. 꺼져 있으면 <code>* . \\</code> 같은 특수문자도 그냥 일반 글자로 검색됩니다</li>
        </ul>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">카드 표시</div>
        <ul class="help-list">
          <li><b>초록 테두리</b> (카드 전체) — 암기된 단어</li>
          <li><b>골드 테두리</b> (표제어) — 중요 단어</li>
        </ul>
      </div>
    </div>
  </div>`;
}

function getExportMatches() {
  const s = ui.exportStatus;
  const cats = ui.exportCategories || new Set(getCategories());
  return words.filter((w) => {
    if (!cats.has(w.category)) return false;
    if (s.all) return true;
    if (!s.unmemorized && !s.important) return false;
    const p = progress[w.id];
    if (s.unmemorized && (!p || !p.memorized)) return true;
    if (s.important && p && p.important) return true;
    return false;
  });
}

function doExport() {
  const matches = getExportMatches();
  if (matches.length === 0) {
    alert('내보낼 단어가 없습니다.');
    return;
  }
  const csv = wordsToCSV(matches, progress);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `단어장_내보내기_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  ui.exportOpen = false;
  render();
}

// ---------- resize handles ----------

function startResize(kind, startEvent) {
  startEvent.preventDefault();
  // On touch, capturing the pointer to the handle keeps move/up events
  // targeted at this drag even if the finger strays off the thin strip —
  // touch contact points are far less precise than a mouse cursor.
  if (startEvent.target && startEvent.target.setPointerCapture) {
    try {
      startEvent.target.setPointerCapture(startEvent.pointerId);
    } catch (err) {
      // ignore — capture is a reliability nicety, not a requirement
    }
  }
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;

  const toolbarRow = document.querySelector('.toolbar-row');
  const mainEl = document.querySelector('.main');
  const progressPanel = document.querySelector('.progress-panel');

  const startToolbarH = (toolbarRow && toolbarRow.getBoundingClientRect().height) || 56;
  const startProgressW = (progressPanel && progressPanel.getBoundingClientRect().width) || 260;

  let pending = null;

  function onMove(e) {
    if (kind === 'resize-toolbar') {
      const newH = Math.max(56, Math.min(400, startToolbarH + (e.clientY - startY)));
      if (toolbarRow) {
        toolbarRow.style.height = newH + 'px';
        toolbarRow.style.overflowY = 'auto';
      }
      pending = newH;
    } else if (kind === 'resize-progress') {
      const newW = Math.max(180, Math.min(520, startProgressW - (e.clientX - startX)));
      if (mainEl) mainEl.style.setProperty('--progress-w', newW + 'px');
      pending = newW;
    }
  }

  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    if (pending == null) return;
    if (kind === 'resize-toolbar') settings.toolbarHeight = Math.round(pending);
    if (kind === 'resize-progress') settings.progressWidth = Math.round(pending);
    saveSettings(settings);
    render();
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

// ---------- events ----------

document.getElementById('csv-file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = decodeCSVBuffer(reader.result);
      const parsed = parseCSVToWords(text);
      setWords(parsed);
    } catch (err) {
      alert('CSV를 읽는 중 오류가 발생했습니다: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

document.getElementById('app').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-action^="resize-"]');
  if (handle) {
    startResize(handle.getAttribute('data-action'), e);
  }
});

document.getElementById('app').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-action="jump-input"]')) {
    // Without this, the same Enter keeps bubbling to the document-level
    // shortcut handler below, which — now that Enter toggles 중요 — would
    // immediately flip that flag on whatever word the jump just focused.
    e.stopPropagation();
    jumpToWordOrdinal(Number(e.target.value));
    e.target.value = '';
    e.target.blur();
  }
});

document.getElementById('app').addEventListener('click', (e) => {
  // Card focus: clicking anywhere inside a word-card focuses it; clicking
  // outside every card (toolbar, progress panel, feed chrome/background)
  // clears focus. Whichever branch below ends up handling the click will
  // render with this updated focus already applied; if nothing else
  // matches, the fallback render() at the bottom picks it up.
  const cardEl = e.target.closest('.word-card');
  const newFocus = cardEl ? Number(cardEl.getAttribute('data-index')) : null;
  const focusChanged = newFocus !== ui.focusedIndex;
  ui.focusedIndex = newFocus;

  // exact-target checks (must not fire when clicking descendants)
  if (e.target.dataset && e.target.dataset.action === 'close-export') {
    ui.exportOpen = false;
    render();
    return;
  }

  if (e.target.dataset && e.target.dataset.action === 'close-mobile-drawer') {
    ui.mobileDrawerOpen = false;
    render();
    return;
  }

  if (e.target.dataset && e.target.dataset.action === 'close-advanced-search') {
    ui.search.advancedOpen = false;
    render();
    return;
  }

  if (e.target.dataset && e.target.dataset.action === 'close-help') {
    ui.helpOpen = false;
    render();
    return;
  }

  const openBtn = e.target.closest('[data-action="open-csv"]');
  if (openBtn) {
    document.getElementById('csv-file-input').click();
    return;
  }

  const openExport = e.target.closest('[data-action="open-export"]');
  if (openExport) {
    if (!ui.exportCategories) ui.exportCategories = new Set(getCategories());
    ui.exportOpen = true;
    ui.search.advancedOpen = false;
    ui.helpOpen = false;
    render();
    return;
  }

  const openAdvancedSearch = e.target.closest('[data-action="open-advanced-search"]');
  if (openAdvancedSearch) {
    if (!ui.search.categories) ui.search.categories = new Set(getCategories());
    ui.search.advancedOpen = true;
    ui.exportOpen = false;
    ui.helpOpen = false;
    render();
    return;
  }

  const openHelp = e.target.closest('[data-action="open-help"]');
  if (openHelp) {
    ui.helpOpen = true;
    ui.exportOpen = false;
    ui.search.advancedOpen = false;
    render();
    return;
  }

  const searchFilterToggle = e.target.closest('[data-action="search-filter-toggle"]');
  if (searchFilterToggle) {
    const key = searchFilterToggle.getAttribute('data-filter');
    ui.search[key] = !ui.search[key];
    render();
    return;
  }

  const searchCategoryAllBtn = e.target.closest('[data-action="search-category-all"]');
  if (searchCategoryAllBtn) {
    const categories = getCategories();
    const allChecked = categories.length > 0 && categories.every((c) => ui.search.categories.has(c));
    ui.search.categories = allChecked ? new Set() : new Set(categories);
    render();
    return;
  }

  const searchCategoryBtn = e.target.closest('[data-action="search-category-toggle"]');
  if (searchCategoryBtn) {
    const cat = searchCategoryBtn.getAttribute('data-category');
    if (!ui.search.categories) ui.search.categories = new Set(getCategories());
    if (ui.search.categories.has(cat)) ui.search.categories.delete(cat);
    else ui.search.categories.add(cat);
    render();
    return;
  }

  const shuffleBtn = e.target.closest('[data-action="toggle-shuffle"]');
  if (shuffleBtn) {
    toggleShuffle();
    return;
  }

  const doExportBtn = e.target.closest('[data-action="do-export"]');
  if (doExportBtn) {
    doExport();
    return;
  }

  const fontDec = e.target.closest('[data-action="font-size-dec"]');
  if (fontDec) {
    settings.fontSize = Math.max(10, settings.fontSize - 1);
    saveSettings(settings);
    render();
    return;
  }
  const fontInc = e.target.closest('[data-action="font-size-inc"]');
  if (fontInc) {
    settings.fontSize = Math.min(32, settings.fontSize + 1);
    saveSettings(settings);
    render();
    return;
  }

  const colsDec = e.target.closest('[data-action="cols-dec"]');
  if (colsDec) {
    settings.cols = Math.max(1, settings.cols - 1);
    saveSettings(settings);
    resetPaging();
    render();
    return;
  }
  const colsInc = e.target.closest('[data-action="cols-inc"]');
  if (colsInc) {
    settings.cols = Math.min(5, settings.cols + 1);
    saveSettings(settings);
    resetPaging();
    render();
    return;
  }

  const countDec = e.target.closest('[data-action="count-dec"]');
  if (countDec) {
    settings.count = Math.max(1, settings.count - 1);
    saveSettings(settings);
    resetPaging();
    render();
    return;
  }
  const countInc = e.target.closest('[data-action="count-inc"]');
  if (countInc) {
    settings.count = Math.min(15, settings.count + 1);
    saveSettings(settings);
    resetPaging();
    render();
    return;
  }

  const fitCardWidth = e.target.closest('[data-action="fit-card-width"]');
  if (fitCardWidth) {
    if (ui.fitWidthActive) {
      // toggle off: restore whatever width was in effect before fitting
      settings.cardWidth = ui.preFitCardWidth != null ? ui.preFitCardWidth : settings.cardWidth;
      ui.fitWidthActive = false;
      ui.preFitCardWidth = null;
      saveSettings(settings);
      render();
    } else {
      const cardsEl = document.querySelector('.cards');
      if (cardsEl) {
        // floor (not round) guarantees cols*fit + gaps never exceeds the
        // measured available width, so no residual horizontal scroll —
        // only the minimum is enforced here, not the usual max, since the
        // whole point is to fill the feed exactly even if that's wider
        // than the slider's normal ceiling. clientWidth includes .cards'
        // own 5px-per-side padding (added earlier so the focus ring isn't
        // clipped), which isn't actually usable by the grid tracks, so
        // that has to come off the available amount too.
        const available = cardsEl.clientWidth - 14;
        const rawFit = Math.floor((available - (settings.cols - 1) * CARD_GAP) / settings.cols);
        ui.preFitCardWidth = settings.cardWidth;
        settings.cardWidth = Math.max(CARD_MIN_WIDTH, rawFit);
        ui.fitWidthActive = true;
        saveSettings(settings);
        render();
      }
    }
    return;
  }

  const foldBtn = e.target.closest('[data-action="toggle-fold"]');
  if (foldBtn) {
    const cat = foldBtn.getAttribute('data-category');
    if (ui.collapsedCategories.has(cat)) ui.collapsedCategories.delete(cat);
    else ui.collapsedCategories.add(cat);
    render();
    return;
  }

  const toolbarCollapseBtn = e.target.closest('[data-action="toggle-toolbar-collapse"]');
  if (toolbarCollapseBtn) {
    settings.toolbarCollapsed = !settings.toolbarCollapsed;
    saveSettings(settings);
    render();
    return;
  }

  const progressCollapseBtn = e.target.closest('[data-action="toggle-progress-collapse"]');
  if (progressCollapseBtn) {
    settings.progressCollapsed = !settings.progressCollapsed;
    saveSettings(settings);
    render();
    return;
  }

  const openDrawerBtn = e.target.closest('[data-action="open-mobile-drawer"]');
  if (openDrawerBtn) {
    ui.mobileDrawerOpen = true;
    ui.mobileDrawerView = 'progress';
    render();
    return;
  }

  const openMobileSettingsBtn = e.target.closest('[data-action="open-mobile-settings"]');
  if (openMobileSettingsBtn) {
    ui.mobileDrawerView = 'settings';
    render();
    return;
  }

  const backToProgressBtn = e.target.closest('[data-action="back-to-progress"]');
  if (backToProgressBtn) {
    ui.mobileDrawerView = 'progress';
    render();
    return;
  }

  const tab = e.target.closest('[data-action="tab"]');
  if (tab) {
    const cat = tab.getAttribute('data-category');
    ui.activeCategory = cat || null;
    ui.filterMode = null;
    deactivateShuffle();
    resetPaging();
    render();
    return;
  }

  const statFilter = e.target.closest('[data-action="stat-filter"]');
  if (statFilter) {
    const filter = statFilter.getAttribute('data-filter');
    const alreadyActive = ui.filterMode === filter && !ui.activeCategory;
    ui.filterMode = alreadyActive ? null : filter;
    ui.activeCategory = null;
    deactivateShuffle();
    resetPaging();
    render();
    return;
  }

  const statCategoryFilter = e.target.closest('[data-action="stat-category-filter"]');
  if (statCategoryFilter) {
    const cat = statCategoryFilter.getAttribute('data-category');
    const filter = statCategoryFilter.getAttribute('data-filter');
    const alreadyActive = ui.activeCategory === cat && ui.filterMode === filter;
    deactivateShuffle();
    if (alreadyActive) {
      ui.activeCategory = null;
      ui.filterMode = null;
    } else {
      ui.activeCategory = cat;
      ui.filterMode = filter;
    }
    resetPaging();
    render();
    return;
  }

  const gotoPageBtn = e.target.closest('[data-action="goto-page"]');
  if (gotoPageBtn && !gotoPageBtn.disabled) {
    gotoPage(Number(gotoPageBtn.getAttribute('data-page')));
    return;
  }
  const pageFirst = e.target.closest('[data-action="page-first"]');
  if (pageFirst && !pageFirst.disabled) {
    gotoPage(1);
    return;
  }
  const pageBack5 = e.target.closest('[data-action="page-back5"]');
  if (pageBack5 && !pageBack5.disabled) {
    gotoPage(currentPageNumber() - 5);
    return;
  }
  const pagePrev = e.target.closest('[data-action="page-prev"]');
  if (pagePrev && !pagePrev.disabled) {
    gotoPage(currentPageNumber() - 1);
    return;
  }
  const pageNext = e.target.closest('[data-action="page-next"]');
  if (pageNext && !pageNext.disabled) {
    gotoPage(currentPageNumber() + 1);
    return;
  }
  const pageFwd5 = e.target.closest('[data-action="page-fwd5"]');
  if (pageFwd5 && !pageFwd5.disabled) {
    gotoPage(currentPageNumber() + 5);
    return;
  }
  const pageLast = e.target.closest('[data-action="page-last"]');
  if (pageLast && !pageLast.disabled) {
    gotoPage(totalPageCount());
    return;
  }

  const checkBtn = e.target.closest('[data-action="toggle-checked"]');
  if (checkBtn) {
    const id = checkBtn.getAttribute('data-id');
    const index = Number(checkBtn.getAttribute('data-index'));
    const p = progress[id];
    if (p) {
      p.checked[index] = !p.checked[index];
      saveProgress(progress);
      render();
    }
    return;
  }

  const darkBtn = e.target.closest('[data-action="toggle-dark"]');
  if (darkBtn) {
    settings.darkMode = !settings.darkMode;
    saveSettings(settings);
    render();
    return;
  }

  const boldBtn = e.target.closest('[data-action="toggle-bold"]');
  if (boldBtn) {
    settings.bold = !settings.bold;
    saveSettings(settings);
    render();
    return;
  }

  const exportStatusBtn = e.target.closest('[data-action="export-status"]');
  if (exportStatusBtn) {
    const key = exportStatusBtn.getAttribute('data-status');
    ui.exportStatus[key] = !ui.exportStatus[key];
    render();
    return;
  }

  const exportCategoryAllBtn = e.target.closest('[data-action="export-category-all"]');
  if (exportCategoryAllBtn) {
    const categories = getCategories();
    const allChecked = categories.length > 0 && categories.every((c) => ui.exportCategories.has(c));
    ui.exportCategories = allChecked ? new Set() : new Set(categories);
    render();
    return;
  }

  const exportCategoryBtn = e.target.closest('[data-action="export-category"]');
  if (exportCategoryBtn) {
    const cat = exportCategoryBtn.getAttribute('data-category');
    if (!ui.exportCategories) ui.exportCategories = new Set(getCategories());
    if (ui.exportCategories.has(cat)) ui.exportCategories.delete(cat);
    else ui.exportCategories.add(cat);
    render();
    return;
  }

  // clicks on remaining nested form controls (select/range, still native)
  // are handled by the 'change' listener below — don't also flip the card
  if (e.target.closest('label, input')) return;

  const cardReveal = e.target.closest('[data-action="card-reveal"]');
  if (cardReveal && settings.mode !== 'memorize') {
    const id = cardReveal.getAttribute('data-id');
    if (ui.revealedIds.has(id)) {
      ui.revealedIds.delete(id);
    } else {
      ui.revealedIds.add(id);
    }
    render();
    return;
  }

  // nothing else matched (e.g. blank click on toolbar/progress background) —
  // still need to re-render if focus changed above
  if (focusChanged) render();
});

// Clicks landing outside #app entirely (the side margins around the
// centered layout) never reach the listener above — clear focus there too.
// Runs in the CAPTURE phase, before the #app listener's own render() call
// can replace the DOM out from under e.target — otherwise a click inside
// #app would detach e.target from #app mid-event and be misread as
// "outside" once bubbling reached this listener.
document.addEventListener(
  'click',
  (e) => {
    if (ui.focusedIndex !== null && !e.target.closest('#app')) {
      ui.focusedIndex = null;
      render();
    }
  },
  true
);

document.getElementById('app').addEventListener('change', (e) => {
  const fontSelect = e.target.closest('[data-action="select-font"]');
  if (fontSelect) {
    settings.font = fontSelect.value;
    saveSettings(settings);
    render();
    return;
  }

  const widthSelect = e.target.closest('[data-action="select-width"]');
  if (widthSelect) {
    settings.widthMode = widthSelect.value;
    saveSettings(settings);
    render();
    return;
  }

  const modeSelect = e.target.closest('[data-action="select-mode"]');
  if (modeSelect) {
    settings.mode = modeSelect.value;
    saveSettings(settings);
    ui.revealedIds.clear();
    render();
    return;
  }

  const cardWidthSlider = e.target.closest('[data-action="card-width-slider"]');
  if (cardWidthSlider) {
    settings.cardWidth = Number(cardWidthSlider.value);
    ui.fitWidthActive = false; // manual override supersedes a previous fit
    ui.preFitCardWidth = null;
    saveSettings(settings);
    render();
    return;
  }

  const cardHeightSlider = e.target.closest('[data-action="card-height-slider"]');
  if (cardHeightSlider) {
    settings.cardHeight = Number(cardHeightSlider.value);
    saveSettings(settings);
    render();
    return;
  }

  const searchScopeSelect = e.target.closest('[data-action="search-scope"]');
  if (searchScopeSelect) {
    ui.search.scope = searchScopeSelect.value;
    render();
    return;
  }

});

// The search box re-renders on every keystroke (so results update live),
// but render() replaces #app's entire innerHTML — a plain render() here
// would tear out the very input the user is typing into and drop focus
// mid-word. Capture/restore the caret around the render so typing feels
// uninterrupted. There are two <input class="search-input"> elements in the
// DOM (desktop's feed-header copy and mobile's top-bar copy); only one is
// ever visible at a time, so offsetParent picks out whichever one that is.
function renderPreservingSearchFocus() {
  const active = document.activeElement;
  const wasSearchFocused = Boolean(active && active.classList && active.classList.contains('search-input'));
  const selStart = wasSearchFocused ? active.selectionStart : null;
  const selEnd = wasSearchFocused ? active.selectionEnd : null;

  render();

  if (!wasSearchFocused) return;
  for (const el of document.querySelectorAll('.search-input')) {
    if (el.offsetParent !== null) {
      el.focus();
      el.setSelectionRange(selStart, selEnd);
      break;
    }
  }
}

// Korean (and other IME) input composes a syllable block from several
// keystrokes before it's "committed" — re-rendering mid-composition tears
// out the input element the IME is tracking, so each keystroke lands as if
// it were its own committed character instead of combining (e.g. "가늠"
// arriving as the separate jamo "ㄱㅏㄴㅡㅁ"). Skip the re-render while a
// composition is in progress and catch up once it ends.
document.getElementById('app').addEventListener('input', (e) => {
  const searchInput = e.target.closest('.search-input');
  if (!searchInput) return;
  ui.search.query = searchInput.value;
  if (e.isComposing) return;
  renderPreservingSearchFocus();
});

document.getElementById('app').addEventListener('compositionend', (e) => {
  const searchInput = e.target.closest('.search-input');
  if (!searchInput) return;
  ui.search.query = searchInput.value;
  renderPreservingSearchFocus();
});

// ---------- swipe paging (touch only, so mouse/trackpad use on PC is untouched) ----------

(function setupSwipeNavigation() {
  const SWIPE_MIN_DISTANCE = 70; // px — small drags/taps don't page, keeps it from feeling twitchy
  const SWIPE_MAX_OFF_AXIS_RATIO = 0.6; // vertical drift allowed, relative to horizontal distance
  const SWIPE_MAX_DURATION = 700; // ms — a slow drag reads as scrolling intent, not a swipe

  let touch = null;
  const appEl = document.getElementById('app');

  appEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (!e.target.closest('.cards')) return;
    touch = { x: e.clientX, y: e.clientY, t: Date.now() };
  });

  appEl.addEventListener('pointerup', (e) => {
    if (!touch || e.pointerType !== 'touch') {
      touch = null;
      return;
    }
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    const dt = Date.now() - touch.t;
    touch = null;
    if (dt > SWIPE_MAX_DURATION) return;
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return;
    if (Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_OFF_AXIS_RATIO) return;
    if (dx < 0) {
      if (currentPageNumber() < totalPageCount()) gotoPage(currentPageNumber() + 1);
    } else if (currentPageNumber() > 1) {
      gotoPage(currentPageNumber() - 1);
    }
  });

  appEl.addEventListener('pointercancel', () => {
    touch = null;
  });
})();

// ---------- card gestures: double-tap = 암기, long-press = 중요 ----------
// Mobile has no keyboard for the Space/Enter shortcuts below, so these
// gestures are the touch equivalent — same two actions, different trigger.
// Double-tap rides the browser's native dblclick synthesis from two quick
// taps (works on mouse too, which is harmless — PC already has Space/Enter
// for this). Long-press has no native event, so it's hand-rolled with a
// timer that a real swipe/scroll cancels via the move-distance check.

// Double-tap used to ride the browser's native dblclick synthesis, but
// right after a swipe, mobile browsers can sit on a "was this a fling or a
// tap" cooldown before they'll synthesize click/dblclick again — the
// double-tap would silently miss for a second or two right after paging.
// Tracking taps ourselves from pointerdown/pointerup sidesteps that
// cooldown entirely, and unifies the touch and mouse cases (a fast,
// same-spot mouse double-click behaves the same way).
(function setupCardGestures() {
  const appEl = document.getElementById('app');

  const LONG_PRESS_MS = 550;
  const MOVE_CANCEL_THRESHOLD = 10; // px — beyond this it's a drag/swipe, not a press
  const DOUBLE_TAP_MAX_INTERVAL_MS = 400;
  const DOUBLE_TAP_MAX_DISTANCE = 30; // px — finger placement isn't pixel-precise

  let timer = null;
  let startX = 0;
  let startY = 0;
  let pressedId = null;
  let firedLongPress = false;
  let lastTap = null; // { id, x, y, t } — first tap of a potential double-tap/click

  function clearPress() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pressedId = null;
  }

  appEl.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.word-card');
    if (!card) return;
    clearPress();
    startX = e.clientX;
    startY = e.clientY;
    pressedId = card.getAttribute('data-id');
    firedLongPress = false;

    if (e.pointerType === 'touch') {
      // PC already has Enter for this — no mouse long-press
      timer = setTimeout(() => {
        timer = null;
        firedLongPress = true;
        lastTap = null; // a long-press shouldn't combine with a tap that follows it
        toggleImportant(pressedId);
      }, LONG_PRESS_MS);
    }
  });

  appEl.addEventListener('pointermove', (e) => {
    if (!pressedId) return;
    if (Math.abs(e.clientX - startX) > MOVE_CANCEL_THRESHOLD || Math.abs(e.clientY - startY) > MOVE_CANCEL_THRESHOLD) {
      clearPress();
    }
  });

  appEl.addEventListener('pointerup', (e) => {
    // pressedId is already cleared above for anything that moved past the
    // threshold (a swipe/drag) or that already fired as a long-press —
    // only a clean, stationary tap/click reaches here.
    const wasCleanPress = Boolean(pressedId) && !firedLongPress;
    const card = e.target.closest('.word-card');
    clearPress();
    if (!wasCleanPress || !card) return;

    const id = card.getAttribute('data-id');
    const now = Date.now();
    if (
      lastTap &&
      lastTap.id === id &&
      now - lastTap.t < DOUBLE_TAP_MAX_INTERVAL_MS &&
      Math.abs(e.clientX - lastTap.x) < DOUBLE_TAP_MAX_DISTANCE &&
      Math.abs(e.clientY - lastTap.y) < DOUBLE_TAP_MAX_DISTANCE
    ) {
      toggleMemorized(id);
      lastTap = null;
    } else {
      lastTap = { id, x: e.clientX, y: e.clientY, t: now };
    }
  });

  appEl.addEventListener('pointercancel', clearPress);

  // Capture phase, so this runs before the big click handler further down —
  // a long-press already toggled 중요; without this, the click that follows
  // the pointerup would also flip the card's test-mode reveal state.
  document.addEventListener(
    'click',
    (e) => {
      if (!firedLongPress) return;
      firedLongPress = false;
      if (e.target.closest('.word-card')) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
})();

// ---------- keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    ui.exportOpen = !ui.exportOpen;
    if (ui.exportOpen && !ui.exportCategories) ui.exportCategories = new Set(getCategories());
    render();
    return;
  }

  const activeTag = document.activeElement && document.activeElement.tagName;
  const typing = activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA';

  if (ui.exportOpen) {
    if (e.key === 'Escape') {
      ui.exportOpen = false;
      render();
    }
    return;
  }

  if (typing) return;

  const filtered = getDisplayWords();
  const windowWords = filtered.slice(ui.startIndex, ui.startIndex + settings.count);

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if ((e.ctrlKey || e.metaKey) && (key === 'ArrowRight' || key === 'ArrowLeft')) {
    e.preventDefault();
    if (key === 'ArrowRight') {
      if (ui.startIndex + settings.count < filtered.length) {
        ui.startIndex += settings.count;
        ui.revealedIds.clear();
        ui.focusedIndex = null;
        render();
      }
    } else if (ui.startIndex > 0) {
      ui.startIndex = Math.max(0, ui.startIndex - settings.count);
      ui.revealedIds.clear();
      ui.focusedIndex = null;
      render();
    }
    return;
  }

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(key)) {
    if (windowWords.length === 0) return;
    e.preventDefault();
    if (ui.focusedIndex === null) {
      ui.focusedIndex = 0;
      render();
      return;
    }

    // At the first/last card, left/right step across the page boundary
    // instead of stopping — focuses the last card of the previous page,
    // or the first card of the next page.
    if ((key === 'ArrowLeft' || key === 'a') && ui.focusedIndex === 0) {
      if (ui.startIndex > 0) {
        ui.startIndex = Math.max(0, ui.startIndex - settings.count);
        const newWindowLen = Math.min(settings.count, filtered.length - ui.startIndex);
        ui.focusedIndex = Math.max(0, newWindowLen - 1);
        ui.revealedIds.clear();
        render();
      }
      return;
    }
    if ((key === 'ArrowRight' || key === 'd') && ui.focusedIndex === windowWords.length - 1) {
      if (ui.startIndex + settings.count < filtered.length) {
        ui.startIndex += settings.count;
        ui.focusedIndex = 0;
        ui.revealedIds.clear();
        render();
      }
      return;
    }

    let delta = 0;
    if (key === 'ArrowLeft' || key === 'a') delta = -1;
    else if (key === 'ArrowRight' || key === 'd') delta = 1;
    else if (key === 'ArrowUp' || key === 'w') delta = -settings.cols;
    else if (key === 'ArrowDown' || key === 's') delta = settings.cols;
    ui.focusedIndex = Math.max(0, Math.min(windowWords.length - 1, ui.focusedIndex + delta));
    render();
    return;
  }

  if (e.code === 'Space') {
    if (ui.focusedIndex === null || windowWords.length === 0) return;
    e.preventDefault();
    const w = windowWords[ui.focusedIndex];
    if (w) toggleMemorized(w.id);
    return;
  }

  if (key === 'Enter') {
    if (ui.focusedIndex === null || windowWords.length === 0) return;
    e.preventDefault();
    const w = windowWords[ui.focusedIndex];
    if (w) toggleImportant(w.id);
    return;
  }

});

render();

// ---------- PWA install-ability ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // no-op: e.g. running over file:// or plain http — app still works,
      // just without offline install support
    });
  });
}
