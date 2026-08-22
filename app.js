// Main application: state, rendering, event handling.
// Relies on globals from csv.js and store.js (no bundler / plain <script> includes).

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
  mobileDrawerOpen: false, // mobile-only: hamburger-triggered left drawer
  mobileDrawerView: 'progress', // 'progress' | 'settings', which drawer page is showing
  helpOpen: false,
  viewDrawerOpen: false, // toolbar's sliders-horizontal toggle — font size/examples/filter/reset
  editMode: false,
  editSelectedIds: new Set(), // word ids marked (via drag) for bulk delete while editing
  editHistory: [], // {words, progress} snapshots, most-recent last — reset each time edit mode is entered
  session: null, // { queue: id[], i, revealed, known, again, finished } | null — see startSession()
  search: {
    query: '',
    scope: 'word-meaning', // 'word-meaning' | 'word' | 'meaning'
    advancedOpen: false,
    memorized: false,
    unmemorized: false,
    important: false,
    useRegex: true, // interpret query as a regular expression instead of a literal substring (default on)
    categories: null, // Set, lazily initialized when advanced search opens
  },
};

const SEARCH_SCOPE_OPTIONS = [
  { value: 'word-meaning', label: '표제어+뜻' },
  { value: 'word', label: '표제어' },
  { value: 'meaning', label: '뜻' },
];

const NEW_WORD_CATEGORY = '생성 단어';

resyncProgress(words);

// ---------- state helpers ----------

function resyncProgress(list) {
  let changed = false;
  const seen = new Set();
  for (const w of list) {
    seen.add(w.id);

    // A CSV carrying progress columns (e.g. exported from another device)
    // always wins for words it names — that's the point of syncing. The
    // CSV format has no stage/due (see csv.js), so those aren't part of what
    // "wins" here — carry over the existing SRS schedule if there was one,
    // otherwise fall back to the same defaults the migration in store.js
    // uses for a word with no history.
    if (w.importedProgress) {
      const ip = w.importedProgress;
      const existing = progress[w.id];
      const memorized = Boolean(ip.memorized);
      progress[w.id] = {
        memorized,
        important: Boolean(ip.important),
        checked: w.meanings.map((_, i) => Boolean(ip.checked[i])),
        stage: existing ? existing.stage : memorized ? 2 : 0,
        due: existing
          ? existing.due
          : memorized
          ? todayMidnight() + SRS_INTERVAL_DAYS[1] * DAY_MS
          : todayMidnight(),
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

// 보기 드로어의 "진행률 초기화" — every word's study state (memorized/
// important/checked/SRS stage+due) back to its defaults. Words themselves
// and their categories/meanings are untouched.
function resetAllProgress() {
  for (const w of words) {
    progress[w.id] = defaultProgressFor(w);
  }
  saveProgress(progress);
  render();
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

// New-word ids only need to be unique and stable — never regenerated from
// the (editable) word text — so progress/selection stay attached to the
// right card even after the user retypes the headword.
function makeNewWordId() {
  return 'new::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
}

// If a specific category was the whole reason the feed narrowed down to
// what's visible, the new word joins it — otherwise (viewing "전체", or a
// search that could span several categories) there's no single obvious
// category to drop it in, so it goes to its own NEW_WORD_CATEGORY instead.
// Either way, the view is switched to exactly that category afterward so
// the blank card is immediately visible and ready to type into.
function createNewWord() {
  pushEditHistory();
  const useSpecificCategory = !isSearchActive() && Boolean(ui.activeCategory);
  const category = useSpecificCategory ? ui.activeCategory : NEW_WORD_CATEGORY;
  const id = makeNewWordId();
  const newWord = { id, category, word: '', meanings: [{ meaning: '', example: '' }], importedProgress: null };
  words.push(newWord);
  progress[id] = defaultProgressFor(newWord);
  saveWords(words);
  saveProgress(progress);

  if (!useSpecificCategory) {
    ui.search.query = '';
    ui.search.memorized = false;
    ui.search.unmemorized = false;
    ui.search.important = false;
    ui.search.categories = null;
    ui.activeCategory = category;
    ui.filterMode = null;
    deactivateShuffle();
  }
  resetPaging();

  const displayList = getDisplayWords();
  const ordinal = displayList.findIndex((w) => w.id === id) + 1;
  if (ordinal > 0) jumpToWordOrdinal(ordinal);
  else render();

  requestAnimationFrame(() => {
    const input = document.querySelector(`.edit-word-input[data-id="${id}"]`);
    if (input) input.focus();
  });
}

// Run when edit mode turns off: a "+ 새 뜻 추가" row nobody typed anything
// into (meaning and example both still blank) is dropped rather than
// saved as a permanent empty entry. Doesn't touch words with zero
// meanings to begin with — that's a normal, pre-existing state, not
// leftover cruft from this session.
function cleanupBlankMeanings() {
  let changed = false;
  for (const w of words) {
    const kept = w.meanings.filter((m) => (m.meaning || '').trim() || (m.example || '').trim());
    if (kept.length !== w.meanings.length) {
      w.meanings = kept;
      changed = true;
    }
  }
  if (changed) saveWords(words);
}

// ---------- edit mode: undo history ----------
// Snapshots go in before an editing-type change (word/category/meaning text,
// add/delete meaning, add/delete word, reorder) — never for study-progress
// changes (memorized/important/checked), which aren't part of editing at
// all. A continuous run of typing is one step: see the 'input' listener
// below, which only calls this once per 1.2s-idle burst rather than per
// keystroke.
const EDIT_HISTORY_LIMIT = 30;

function pushEditHistory() {
  ui.editHistory.push({
    words: JSON.parse(JSON.stringify(words)),
    progress: JSON.parse(JSON.stringify(progress)),
  });
  if (ui.editHistory.length > EDIT_HISTORY_LIMIT) ui.editHistory.shift();
}

function undoEdit() {
  if (!ui.editHistory.length) return;
  const snapshot = ui.editHistory.pop();
  words = snapshot.words;
  progress = snapshot.progress;
  saveWords(words);
  saveProgress(progress);
  ui.editSelectedIds = new Set();
  render();
}

// Shared by every edit-field's 'input' listener so a burst of keystrokes —
// even across different fields/rows — collapses into a single undo step.
// Only the first keystroke after 1.2s of quiet pushes a snapshot; the
// pending timer just marks "still mid-burst".
let editHistoryTypingTimer = null;

function noteEditHistoryTyping() {
  if (editHistoryTypingTimer === null) pushEditHistory();
  clearTimeout(editHistoryTypingTimer);
  editHistoryTypingTimer = setTimeout(() => {
    editHistoryTypingTimer = null;
  }, 1200);
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
// Memorized and the per-meaning checks are two views of the same judgment,
// so they're kept in lockstep in both directions: flipping the word-level
// toggle drives every check to that value (here), and checking the last
// remaining meaning flips the word to memorized (see setMeaningChecked).
function toggleMemorized(id) {
  const p = progress[id];
  if (!p) return;
  p.memorized = !p.memorized;
  if (Array.isArray(p.checked)) p.checked = p.checked.map(() => p.memorized);
  saveProgress(progress);
  render();
}

// The other half of that pairing. Only *completing* the set turns memorized
// on, and unchecking any one turns it back off — so the word-level state
// never claims more than the checks actually support.
function setMeaningChecked(id, index, value) {
  const p = progress[id];
  if (!p || !Array.isArray(p.checked)) return;
  p.checked[index] = value;
  const total = p.checked.length;
  p.memorized = total > 0 && p.checked.every(Boolean);
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

// 20-cell bar, one cell per 5% — filled count always floors from the raw
// ratio (never from an already-rounded display percentage), so a cell only
// fills once its full 5% share is reached. See computeStats' memoBarFilled/
// importantBarFilled.
function barFilledCount(count, total) {
  if (!total) return 0;
  return Math.floor(((count / total) * 100) / 5);
}

// 7 buckets — today, +1 .. +6 — counting how many words are due on each of
// the next 7 calendar days. Anything already overdue (due before today's
// start — shouldn't normally happen, but "다시 보기" sets due=now which can
// be any moment today) lands in the "today" bucket rather than being
// dropped or going negative.
function computeForecast() {
  const midnight = todayMidnight();
  const counts = new Array(7).fill(0);
  for (const w of words) {
    const p = progress[w.id];
    if (!p) continue;
    const dayOffset = Math.floor((p.due - midnight) / DAY_MS);
    counts[Math.max(0, Math.min(6, dayOffset))]++;
  }
  return counts;
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
    memoBarFilled: barFilledCount(memorized, total),
    unmemorized,
    // "중요" is independent of memorized — its own 20-cell strip/percentage,
    // never derived from or combined with the memorized ratio.
    important,
    importantRate: total ? Math.round((important / total) * 100) : 0,
    importantBarFilled: barFilledCount(important, total),
    byCategory,
    forecast: computeForecast(),
  };
}

// ---------- SRS (spaced repetition) ----------

// Strictly "due right now" — no fallback — so the toolbar/drawer badge
// never counts words that only show up because the queue would otherwise
// be empty (see dueWords() below, which does fall back).
function countDueToday() {
  const now = Date.now();
  return words.filter((w) => progress[w.id] && progress[w.id].due <= now).length;
}

// The actual session queue: due words first (earliest due first), or — if
// nothing is due — unmemorized words, so a caught-up learner can still
// start a session instead of hitting an empty one.
function dueWords() {
  const now = Date.now();
  const due = words.filter((w) => progress[w.id] && progress[w.id].due <= now);
  if (due.length) return due.sort((a, b) => progress[a.id].due - progress[b.id].due);
  return words.filter((w) => !isMemorized(w));
}

function startSession() {
  const queue = dueWords().map((w) => w.id);
  if (!queue.length) return;
  ui.session = { queue, i: 0, revealed: false, known: 0, again: 0, finished: false };
  ui.editMode = false; // a session and the edit table don't coexist
  ui.mobileDrawerOpen = false;
  render();
}

function sessionReveal() {
  const s = ui.session;
  if (!s || s.finished) return;
  s.revealed = true;
  render();
}

function advanceSession() {
  const s = ui.session;
  s.i++;
  s.revealed = false;
  if (s.i >= s.queue.length) s.finished = true;
  render();
}

function sessionKnow() {
  const s = ui.session;
  if (!s || s.finished) return;
  const p = progress[s.queue[s.i]];
  if (p) {
    p.stage = Math.min(6, p.stage + 1);
    p.due = Date.now() + SRS_INTERVAL_DAYS[p.stage - 1] * DAY_MS;
    saveProgress(progress);
  }
  s.known++;
  advanceSession();
}

function sessionAgain() {
  const s = ui.session;
  if (!s || s.finished) return;
  const p = progress[s.queue[s.i]];
  if (p) {
    p.stage = 0;
    p.due = Date.now();
    saveProgress(progress);
  }
  s.again++;
  advanceSession();
}

function endSession() {
  ui.session = null;
  render();
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
// no memorized/important checkbox, regex mode on) — used both to decide
// whether a search is "active" with an empty query, and to badge the
// advanced-search button.
function isSearchAdvancedActive() {
  const s = ui.search;
  if (s.memorized || s.unmemorized || s.important || !s.useRegex) return true;
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
// Regex mode is on by default; "정규식 미사용" in advanced search opts back
// out to plain substring matching — with it off, "*", ".", "\" etc. in a
// query are just literal characters to look for, never special syntax. An
// invalid pattern (regex mode only) matches nothing rather than throwing or
// silently falling back to a literal search.
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

// Every icon in the app renders through this — a single Lucide set (no
// emoji, no ad-hoc inline SVGs) so the icon language stays consistent.
// lucide.createIcons() (called at the end of render()) swaps each
// <i data-lucide="..."> placeholder for the matching inline SVG.
function icon(name, size) {
  return `<i data-lucide="${name}" width="${size}" height="${size}" stroke-width="1.5"></i>`;
}

function render() {
  document.body.classList.toggle('dark', settings.darkMode);
  document.body.classList.toggle('force-mobile', settings.device === 'mobile');
  document.body.classList.toggle('force-pc', settings.device === 'pc');

  document.documentElement.style.setProperty('--card-font-size', settings.fontSize + 'px');

  const app = document.getElementById('app');

  const filtered = getDisplayWords();
  clampStartIndex(filtered.length);
  const windowWords = filtered.slice(ui.startIndex, ui.startIndex + settings.count);
  if (ui.focusedIndex !== null && ui.focusedIndex >= windowWords.length) {
    ui.focusedIndex = windowWords.length ? windowWords.length - 1 : null;
  }

  // Progress panel is a fixed-width column of the 2-column .main grid; the
  // feed takes the remaining 1fr. Cards inside the feed are minmax(0,1fr)
  // tracks, so nothing here needs to solve for a card width in pixels —
  // #app just gets a max-width from CSS and the grid divides what's left.
  const progressW = settings.progressCollapsed ? 40 : 268;

  const mainInnerHtml = ui.session
    ? renderSessionView()
    : renderFeedPanel(filtered, windowWords) + renderProgressPanel();

  app.innerHTML =
    renderMobileTopBar() +
    renderToolbar() +
    `<div class="main ${ui.session ? 'main-session' : ''}" style="--progress-w: ${progressW}px;">` +
    mainInnerHtml +
    '</div>' +
    renderMobileDrawer() +
    (ui.exportOpen ? renderExportPanel() : '') +
    (ui.search.advancedOpen ? renderAdvancedSearchPanel() : '') +
    (ui.helpOpen ? renderHelpPanel() : '');

  // Edit fields need their height set from actual rendered content (font
  // metrics/wrapping aren't known until they're in the DOM), so this can't
  // happen as part of the HTML string above — it has to run after
  // insertion. Only matters in edit mode; harmless no-op otherwise since
  // no .edit-field elements exist.
  if (ui.editMode) autoResizeEditFields();

  // Swap every <i data-lucide="..."> placeholder just inserted above for
  // its real inline SVG.
  if (window.lucide) lucide.createIcons();
}

// scrollHeight measures the content+padding box, but these fields are
// box-sizing:border-box (global reset), where the `height` CSS property
// includes the border too — setting height straight to scrollHeight comes
// up one border-width short on each edge, clipping the last line by a
// couple px. Reading the actual border width (rather than hardcoding the
// CSS's current 1px) keeps this correct if that ever changes.
function autoResizeField(el) {
  const cs = getComputedStyle(el);
  const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + borderY + 'px';
}

function autoResizeEditFields() {
  document.querySelectorAll('.edit-field').forEach(autoResizeField);
}

// Label/icon always show the DESTINATION — what clicking switches you TO —
// never the current state. Showing "PC" while already on PC (a real past
// bug) meant clicking it flipped you to mobile, which read as exactly
// backwards: a button that says PC should be the one that gets you to PC.
function renderDeviceToggleButton(extraClass, showLabel) {
  const goingToMobile = !isMobileLayout();
  const label = goingToMobile ? '모바일' : 'PC';
  return `<button class="${extraClass}" data-action="toggle-device" aria-label="${label}로 전환">${icon(
    goingToMobile ? 'smartphone' : 'monitor',
    16
  )}${showLabel ? ' ' + label : ''}</button>`;
}

function renderMobileTopBar() {
  return `
  <div class="mobile-topbar">
    <button class="hamburger-btn" data-action="open-mobile-drawer" aria-label="메뉴 열기">${icon('menu', 19)}</button>
    <span class="mobile-topbar-title">단어장</span>
    ${renderSearchBar()}
    ${renderDeviceToggleButton('mobile-device-toggle-btn', false)}
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
    }" data-action="open-advanced-search" aria-label="고급 검색">${icon('list-filter', 15)}</button>
  </div>`;
}

// Full-screen takeover while ui.session is active — see render()'s early
// return. Rendered instead of (never alongside) the toolbar/feed/progress
// panel.
function renderSessionView() {
  const s = ui.session;

  // Skip past any queued id that no longer exists (e.g. deleted mid-session)
  // by advancing the plain state in place — not via advanceSession(), which
  // calls render() itself and would race with the render() call already in
  // progress for this pass.
  while (!s.finished && !words.some((w) => w.id === s.queue[s.i])) {
    s.i++;
    s.revealed = false;
    if (s.i >= s.queue.length) s.finished = true;
  }

  if (s.finished) {
    const stats = computeStats();
    return `
    <div class="session-screen session-complete">
      <div class="session-complete-line">암기함 ${s.known} · 다시 보기 ${s.again} — 진행률 ${stats.memoRate}%</div>
      <div class="session-complete-actions">
        <button class="btn btn-primary" data-action="session-restart">남은 단어로 다시</button>
        <button class="btn" data-action="end-session">단어장으로</button>
      </div>
    </div>`;
  }

  const id = s.queue[s.i];
  const word = words.find((w) => w.id === id);
  const p = progress[id] || defaultProgressFor(word);

  const stripHtml = s.queue
    .map((_, i) => `<div class="session-strip-cell ${i < s.i ? 'done' : ''}"></div>`)
    .join('');

  const bodyHtml = s.revealed
    ? `<div class="session-meanings">${word.meanings
        .map(
          (m, i) => `
        <div class="session-meaning">
          ${m.meaning ? `<div class="meaning">${i + 1}. ${escapeHtml(m.meaning)}</div>` : ''}
          ${m.example ? `<div class="example">${escapeHtml(m.example)}</div>` : ''}
        </div>`
        )
        .join('')}</div>`
    : `<button class="session-reveal-btn" data-action="session-reveal">뜻 보기 (Space)</button>`;

  return `
  <div class="session-screen">
    <div class="session-header">
      <span class="session-title">복습 세션</span>
      <span class="session-count">${s.i + 1} / ${s.queue.length}</span>
      <div class="session-strip">${stripHtml}</div>
      <button class="session-close-btn" data-action="end-session">${icon('x', 15)} 세션 종료</button>
    </div>
    <div class="session-body">
      <div class="session-word-row">
        <span class="session-word">${escapeHtml(word.word)}</span>
        <span class="session-category">${escapeHtml(word.category)}</span>
      </div>
      ${bodyHtml}
    </div>
    <div class="session-footer">
      <div class="session-actions">
        <button class="btn btn-primary" data-action="session-know">${icon('check', 15)} 암기함</button>
        <button class="btn" data-action="session-again">${icon('rotate-ccw', 15)} 다시 보기</button>
        <button class="btn ${p.important ? 'session-important-active' : ''}" data-action="session-toggle-important" data-id="${escapeHtml(
    id
  )}">${icon('bookmark', 15)} 중요</button>
      </div>
      <div class="session-key-hints">Space 뜻 · Enter 암기함 · → 다시 보기</div>
    </div>
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

// Shared by the desktop progress panel and the mobile drawer's progress
// view — same stats markup either way, just wrapped in different chrome
// (panel header + collapse toggle vs. drawer header + close button).
function renderProgressBody(stats) {
  const memoBarHtml = Array.from(
    { length: 20 },
    (_, i) => `<div class="bar-cell ${i < stats.memoBarFilled ? 'filled' : ''}"></div>`
  ).join('');
  const importantBarHtml = Array.from(
    { length: 20 },
    (_, i) => `<div class="bar-cell ${i < stats.importantBarFilled ? 'filled' : ''}"></div>`
  ).join('');

  const perCategoryHtml = stats.byCategory
    .map((c) => {
      const chip = (label, key, count) => {
        const isActive = ui.activeCategory === c.category && ui.filterMode === key;
        return `<button class="cat-chip ${isActive ? 'active' : ''}" data-action="stat-category-filter" data-category="${escapeHtml(
          c.category
        )}" data-filter="${key}">${label} ${count}개</button>`;
      };
      const collapsed = ui.collapsedCategories.has(c.category);
      // Clicking the category name itself does what the old "전체" chip
      // did (see the "tab" action) — that's why there's no 전체 chip below.
      const nameActive = ui.activeCategory === c.category && !ui.filterMode;
      return `
      <div class="cat-stat">
        <div class="cat-stat-header">
          <button class="cat-fold-btn ${collapsed ? 'collapsed' : ''}" data-action="toggle-fold" data-category="${escapeHtml(
        c.category
      )}" aria-label="접기/펼치기">${icon('chevron-down', 14)}</button>
          <span class="cat-stat-name ${nameActive ? 'active' : ''}" data-action="tab" data-category="${escapeHtml(
        c.category
      )}">${escapeHtml(c.category)}</span>
          <span class="cat-stat-bar"><span class="cat-stat-bar-fill" style="width:${c.rate}%"></span></span>
          <span class="cat-stat-rate">${c.rate}%</span>
        </div>
        ${
          collapsed
            ? ''
            : `<div class="cat-chip-group">${chip('미암기', 'unmemorized', c.unmemorized)}${chip(
                '중요',
                'important',
                c.important
              )}</div>`
        }
      </div>`;
    })
    .join('');

  // height = 6 + (n/peak)*42 — peak floors at 1 so an all-zero week still
  // draws every bar at the 6px "empty" floor instead of dividing by zero.
  const forecastPeak = Math.max(1, ...stats.forecast);
  const forecastLabels = ['오늘', '+1', '+2', '+3', '+4', '+5', '+6'];
  const forecastHtml = stats.forecast
    .map((n, i) => {
      const height = Math.round(6 + (n / forecastPeak) * 42);
      return `
      <div class="forecast-bar-col">
        ${n > 0 ? `<span class="forecast-bar-value">${n}</span>` : ''}
        <div class="forecast-bar ${n === 0 ? 'empty' : ''}" style="height:${height}px" aria-label="${
        forecastLabels[i]
      } 복습 예정 ${n}개"></div>
        <span class="forecast-bar-label">${forecastLabels[i]}</span>
      </div>`;
    })
    .join('');

  return `
    <div class="progress-numbers">
      <div class="progress-percent">${stats.memoRate}<span class="unit">%</span></div>
      <div class="progress-count">${stats.memorized} / ${stats.total} 단어</div>
    </div>
    <div class="bar-20 memo-bar" aria-label="암기율 ${stats.memoRate}%">${memoBarHtml}</div>
    <div class="important-strip-row">
      <span class="important-strip-label">중요</span>
      <div class="bar-20 important-strip" aria-label="중요 표시 ${stats.importantRate}%">${importantBarHtml}</div>
      <span class="important-strip-pct">${stats.importantRate}%</span>
    </div>
    <div class="progress-legend">
      <span class="legend-item"><span class="legend-swatch legend-memo"></span>암기 ${stats.memorized}</span>
      <span class="legend-item"><span class="legend-swatch legend-important"></span>중요 ${stats.important}</span>
      <span class="legend-item"><span class="legend-swatch legend-unmemo"></span>미암기 ${stats.unmemorized}</span>
    </div>
    <div class="forecast-section">
      <div class="forecast-title">복습 예정 · 7일</div>
      <div class="forecast-bars">${forecastHtml}</div>
    </div>
    <div class="cat-stats">${perCategoryHtml}</div>`;
}

function renderMobileProgressView() {
  const stats = computeStats();
  const dueTodayCount = countDueToday();

  return `
    <div class="drawer-header">
      진행률
      <button class="drawer-close-btn" data-action="close-mobile-drawer" aria-label="닫기">${icon('x', 17)}</button>
    </div>
    <button class="drawer-settings-btn ${dueTodayCount > 0 ? 'due-active' : ''}" data-action="start-session">${icon(
    'graduation-cap',
    17
  )} 오늘 복습 ${dueTodayCount}</button>
    ${renderProgressBody(stats)}
    <button class="drawer-settings-btn" data-action="open-help">${icon('circle-help', 17)} 사용법</button>
    <button class="drawer-settings-btn" data-action="open-mobile-settings">${icon('settings', 17)} 설정</button>
  `;
}

function renderMobileSettingsView() {
  const modeLabels = { memorize: '암기', 'meaning-test': '의미 테스트', 'word-test': '단어 테스트' };
  const modeOptionsHtml = Object.keys(modeLabels)
    .map(
      (m) =>
        `<option value="${m}" ${m === settings.mode ? 'selected' : ''}>${escapeHtml(
          modeLabels[m]
        )}</option>`
    )
    .join('');

  return `
    <div class="drawer-header">
      <button class="drawer-back-btn" data-action="back-to-progress" aria-label="뒤로">${icon('arrow-left', 17)}</button>
      설정
      <button class="drawer-close-btn" data-action="close-mobile-drawer" aria-label="닫기">${icon('x', 17)}</button>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">데이터</div>
      <button class="btn btn-open" data-action="open-csv">${icon('folder-open', 15)} 열기</button>
      <button class="btn" data-action="open-export">${icon('download', 15)} 내보내기</button>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">화면</div>
      <button class="chip-btn icon-toggle-btn ${settings.darkMode ? 'active' : ''}" data-action="toggle-dark" aria-label="${
    settings.darkMode ? '라이트 모드로 전환' : '다크 모드로 전환'
  }">${icon(settings.darkMode ? 'sun' : 'moon', 16)}</button>
      ${renderDeviceToggleButton('chip-btn icon-toggle-btn', true)}
      ${stepperControl('글자 크기', settings.fontSize, 'font-size-dec', 'font-size-inc')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">레이아웃</div>
      <label class="opt">
        모드
        <select data-action="select-mode">${modeOptionsHtml}</select>
      </label>
      ${stepperControl('열', settings.cols, 'cols-dec', 'cols-inc')}
      ${stepperControl('개수', settings.count, 'count-dec', 'count-inc')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">보기</div>
      <button class="chip-btn ${settings.examples ? 'active' : ''}" data-action="toggle-examples">예문 ${
    settings.examples ? '표시' : '숨김'
  }</button>
      <div class="chip-group">
        ${['all', 'unmemorized', 'important']
          .map((key) => {
            const labels = { all: '전체', unmemorized: '미암기만', important: '중요만' };
            const current = ui.filterMode === 'unmemorized' ? 'unmemorized' : ui.filterMode === 'important' ? 'important' : 'all';
            return `<button class="chip-btn ${key === current ? 'active' : ''}" data-action="view-drawer-filter" data-filter="${key}">${
              labels[key]
            }</button>`;
          })
          .join('')}
      </div>
      <button class="btn" data-action="reset-progress">${icon('rotate-ccw', 15)} 진행률 초기화</button>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">단어 편집</div>
      <button class="chip-btn ${ui.editMode ? 'active' : ''}" data-action="toggle-edit-mode">편집 모드</button>
    </div>
  `;
}

const MODE_LABELS = { memorize: '암기', 'meaning-test': '의미', 'word-test': '단어' };

function renderModeSegment() {
  return `
    <div class="mode-segment">
      ${Object.keys(MODE_LABELS)
        .map(
          (m) =>
            `<button class="mode-segment-btn ${m === settings.mode ? 'active' : ''}" data-action="select-mode-btn" data-mode="${m}">${
              MODE_LABELS[m]
            }</button>`
        )
        .join('')}
    </div>`;
}

function renderToolbar() {
  const dueTodayCount = countDueToday();

  if (settings.toolbarCollapsed) {
    return `
  <div class="toolbar collapsed">
    <button class="panel-toggle" data-action="toggle-toolbar-collapse" aria-label="설정 펼치기">${icon(
      'chevron-down',
      15
    )} 설정</button>
  </div>`;
  }

  return `
  <div class="toolbar">
    <div class="toolbar-row">
      <div class="toolbar-brand">
        <span class="brand-name">단어장</span>
        <span class="brand-count">${words.length} WORDS</span>
      </div>
      <div class="toolbar-group">
        <button class="btn btn-open" data-action="open-csv">${icon('folder-open', 15)} 열기</button>
        <button class="btn" data-action="open-export">${icon('download', 15)} 내보내기</button>
        <button class="btn" data-action="open-help">${icon('circle-help', 15)} 사용법</button>
      </div>
      <div class="toolbar-group">
        ${renderModeSegment()}
        <button class="chip-btn icon-toggle-btn ${dueTodayCount > 0 ? 'due-active' : ''}" data-action="start-session">${icon(
    'graduation-cap',
    16
  )} 오늘 복습 ${dueTodayCount}</button>
        <button class="chip-btn icon-toggle-btn ${ui.shuffleActive ? 'active' : ''}" data-action="toggle-shuffle">${icon(
    'shuffle',
    16
  )} 무작위</button>
      </div>
      <div class="toolbar-group">
        ${stepperControl('열', settings.cols, 'cols-dec', 'cols-inc', 'layout-grid')}
        ${stepperControl('개수', settings.count, 'count-dec', 'count-inc', 'list')}
        <button class="chip-btn icon-toggle-btn ${settings.darkMode ? 'active' : ''}" data-action="toggle-dark" aria-label="${
    settings.darkMode ? '라이트 모드로 전환' : '다크 모드로 전환'
  }">${icon(settings.darkMode ? 'sun' : 'moon', 16)}</button>
        <button class="chip-btn icon-toggle-btn ${ui.viewDrawerOpen ? 'active' : ''}" data-action="toggle-view-drawer" aria-label="보기 설정">${icon(
    'sliders-horizontal',
    16
  )}</button>
      </div>
      <div class="toolbar-group toolbar-group-right">
        ${renderDeviceToggleButton('chip-btn icon-toggle-btn', true)}
        <button class="chip-btn ${ui.editMode ? 'active' : ''}" data-action="toggle-edit-mode">${icon(
    'pencil',
    15
  )} 편집 모드</button>
        <button class="panel-toggle" data-action="toggle-toolbar-collapse" aria-label="설정 접기">${icon(
          'chevron-up',
          15
        )} 접기</button>
      </div>
    </div>
    ${ui.viewDrawerOpen ? renderViewDrawer() : ''}
  </div>`;
}

function renderViewDrawer() {
  const filterLabels = { all: '전체', unmemorized: '미암기만', important: '중요만' };
  const currentFilterKey = ui.filterMode === 'unmemorized' ? 'unmemorized' : ui.filterMode === 'important' ? 'important' : 'all';
  return `
  <div class="view-drawer">
    ${stepperControl('글자 크기', settings.fontSize, 'font-size-dec', 'font-size-inc')}
    <button class="chip-btn ${settings.examples ? 'active' : ''}" data-action="toggle-examples">예문 ${
    settings.examples ? '표시' : '숨김'
  }</button>
    <div class="opt">
      필터
      <div class="chip-group">
        ${Object.keys(filterLabels)
          .map(
            (key) =>
              `<button class="chip-btn ${key === currentFilterKey ? 'active' : ''}" data-action="view-drawer-filter" data-filter="${key}">${
                filterLabels[key]
              }</button>`
          )
          .join('')}
      </div>
    </div>
    <button class="btn view-drawer-reset" data-action="reset-progress">${icon('rotate-ccw', 15)} 진행률 초기화</button>
  </div>`;
}

// iconName replaces the visible text label with an icon (label still lands
// on the wrapper as a title/aria-label) — used for 열/개수 in the toolbar,
// which show as icon+stepper rather than a Korean label there.
function stepperControl(label, value, decAction, incAction, iconName) {
  const labelHtml = iconName ? icon(iconName, 15) : label;
  return `
      <label class="opt" ${iconName ? `title="${label}" aria-label="${label}"` : ''}>
        ${labelHtml}
        <span class="stepper">
          <button data-action="${decAction}" aria-label="${label} 줄이기">−</button>
          <span class="stepper-value">${value}</span>
          <button data-action="${incAction}" aria-label="${label} 키우기">+</button>
        </span>
      </label>`;
}

function renderFeedPanel(filtered, windowWords) {
  const currentCategoryLabel = isSearchActive() ? '검색 결과' : ui.activeCategory || '전체';

  // "1–6 / 15" — the range of the page currently on screen out of the whole
  // filtered set, not a single cursor position.
  const rangeEnd = Math.min(ui.startIndex + settings.count, filtered.length);
  const positionText = filtered.length
    ? `${ui.startIndex + 1}–${rangeEnd} / ${filtered.length}`
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

  // Edit mode swaps the card grid for the editable table (see
  // renderEditableRow) — search/filter/pagination all still feed the same
  // windowWords either way, so they apply to the table exactly like they do
  // to the feed.
  const feedBodyHtml = ui.editMode
    ? `<div class="edit-table">
         <div class="edit-table-header">
           <span>분류</span>
           <span>표제어</span>
           <span>뜻</span>
         </div>
         ${cardsHtml || emptyStateHtml}
       </div>
       <button class="edit-add-word-btn" data-action="edit-add-word">${icon('plus', 16)} 단어 추가</button>`
    : `<div class="cards" style="grid-template-columns: repeat(${settings.cols}, minmax(0, 1fr));">${
        cardsHtml || emptyStateHtml
      }</div>`;

  // Non-edit: the range label sits right beside the title. Edit: the count
  // of what's being edited plus the undo/bulk-delete controls take its place.
  const headerRightHtml = ui.editMode
    ? `<span class="current-category-label">${windowWords.length} / ${filtered.length}개 편집 중</span>
       <button class="btn" data-action="undo-edit" ${ui.editHistory.length ? '' : 'disabled'}>${icon(
        'undo-2',
        15
      )} 되돌리기</button>
       <button class="edit-trash-btn ${
         ui.editSelectedIds.size ? 'has-selection' : ''
       }" data-action="edit-bulk-delete" aria-label="선택한 단어 삭제">${icon('trash-2', 16)}</button>`
    : `<span class="position-indicator">${positionText}</span>`;

  return `
  <section class="feed-panel">
    <div class="feed-header-row">
      <div class="feed-header">${escapeHtml(currentCategoryLabel)}</div>
      ${headerRightHtml}
      ${renderSearchBar()}
    </div>
    <div class="feed-nav-row">
      ${renderJumpBox(filtered.length)}
      ${paginationBar}
    </div>
    ${feedBodyHtml}
    <div class="feed-footer">
      <span class="feed-key-hints">Space 암기 · Enter 중요 · ←→ 이동</span>
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
  if (settings.device === 'mobile') return true;
  if (settings.device === 'pc') return false;
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
  // covers single-page stepping, and the extra icon row eats too much width
  // on a phone screen for what it adds. Just the tappable page numbers remain.
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
    } aria-label="맨 처음 페이지">${icon('chevrons-left', 15)}</button>
    <button class="page-nav-btn" data-action="page-back5" ${
      atFirst ? 'disabled' : ''
    } aria-label="5페이지 뒤로">${icon('rewind', 15)}</button>
    <button class="page-nav-btn" data-action="page-prev" ${
      atFirst ? 'disabled' : ''
    } aria-label="이전 페이지">${icon('chevron-left', 15)}</button>
    <div class="page-num-list">${pageButtons}</div>
    <button class="page-nav-btn" data-action="page-next" ${
      atLast ? 'disabled' : ''
    } aria-label="다음 페이지">${icon('chevron-right', 15)}</button>
    <button class="page-nav-btn" data-action="page-fwd5" ${
      atLast ? 'disabled' : ''
    } aria-label="5페이지 앞으로">${icon('fast-forward', 15)}</button>
    <button class="page-nav-btn" data-action="page-last" ${
      atLast ? 'disabled' : ''
    } aria-label="맨 마지막 페이지">${icon('chevrons-right', 15)}</button>
  </div>`;
}

function renderCard(word, index, focused) {
  const p = progress[word.id] || defaultProgressFor(word);
  if (ui.editMode) return renderEditableRow(word, p, index);

  const revealed = ui.revealedIds.has(word.id) || settings.mode === 'memorize';

  const wordVisible = settings.mode !== 'word-test' || revealed;
  const meaningsVisible = settings.mode !== 'meaning-test' || revealed;

  const dictUrl = 'https://dict.naver.com/dict.search?query=' + encodeURIComponent(word.word);
  const importantClass = p.important ? ' important' : '';
  // Bookmark + dict-search live together at the card's top-right; the
  // left slot is a plain spacer so the headword still sits visually
  // centered between two equal-width grid columns.
  const bookmarkHtml = `<button type="button" class="card-bookmark${
    p.important ? ' active' : ''
  }" data-action="toggle-important-click" data-id="${escapeHtml(word.id)}" aria-label="중요 표시 전환">${icon(
    'bookmark',
    15
  )}</button>`;
  const cardIconsHtml = `<span class="card-word-icons">${bookmarkHtml}<a class="dict-link" href="${escapeHtml(
    dictUrl
  )}" target="_blank" rel="noopener noreferrer" title="네이버 사전에서 검색" aria-label="네이버 사전에서 검색">${icon(
    'search',
    14
  )}</a></span>`;
  const wordHtml = wordVisible
    ? `<div class="card-word${importantClass}"><span class="card-word-spacer" aria-hidden="true"></span><span class="card-word-text">${escapeHtml(
        word.word
      )}</span>${cardIconsHtml}</div>`
    : `<div class="card-word placeholder${importantClass}">탭하여 단어 보기</div>`;

  let meaningsHtml;
  if (meaningsVisible) {
    meaningsHtml = word.meanings.length
      ? word.meanings
          .map((m, i) => {
            const checked = Boolean(p.checked[i]);
            return `
            <div class="meaning-item ${checked ? 'checked' : ''}" data-action="toggle-checked" data-id="${escapeHtml(
              word.id
            )}" data-index="${i}">
              <button class="check-btn ${checked ? 'checked' : ''}" data-action="toggle-checked" data-id="${escapeHtml(
                word.id
              )}" data-index="${i}" aria-label="${i + 1}번 뜻 암기 확인">${i + 1}</button>
              <div class="meaning-text">
                ${m.meaning ? `<div class="meaning">${escapeHtml(m.meaning)}</div>` : ''}
                ${settings.examples && m.example ? `<div class="example">${escapeHtml(m.example)}</div>` : ''}
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
  )}" data-index="${index}">
    ${wordHtml}
    <div class="card-meanings">${meaningsHtml}</div>
    <div class="card-footer">
      <span class="card-category">${escapeHtml(word.category)}</span>
      <span class="card-stage-dots" aria-label="복습 단계 ${p.stage}/6">${Array.from(
    { length: 6 },
    (_, i) => `<span class="card-stage-dot ${i < p.stage ? 'filled' : ''}"></span>`
  ).join('')}</span>
    </div>
  </div>`;
}

// Edit mode replaces the card grid with a plain table: one row per word
// (분류 | 표제어 | 뜻 전체 전시), inputs instead of static text — see the
// 'focusout' handler for how edits get committed (on leaving a field, not
// per keystroke: re-rendering mid-edit would tear out the very field being
// typed into, the same class of bug the search box's IME composition had).
// A word with no meanings yet still gets one blank editable row so there's
// somewhere to type a first one.
function renderEditableRow(word, p, index) {
  const selected = ui.editSelectedIds.has(word.id);
  const meanings = word.meanings.length ? word.meanings : [{ meaning: '', example: '' }];
  const meaningsHtml = meanings
    .map(
      (m, i) => `
      <div class="edit-meaning-row" data-id="${escapeHtml(word.id)}" data-index="${i}">
        <span class="edit-meaning-grip" draggable="true" aria-label="드래그하여 순서 변경">${icon(
          'grip-vertical',
          15
        )}</span>
        <span class="edit-meaning-index">${i + 1}</span>
        <div class="edit-meaning-fields">
          <textarea class="edit-field edit-meaning-input" rows="1" data-action="edit-meaning" data-id="${escapeHtml(
            word.id
          )}" data-index="${i}" placeholder="뜻">${escapeHtml(m.meaning)}</textarea>
          <textarea class="edit-field edit-example-input" rows="1" data-action="edit-example" data-id="${escapeHtml(
            word.id
          )}" data-index="${i}" placeholder="예시 (선택)">${escapeHtml(m.example)}</textarea>
        </div>
        <button class="edit-meaning-delete" data-action="edit-delete-meaning" data-id="${escapeHtml(
          word.id
        )}" data-index="${i}" aria-label="뜻 삭제">${icon('minus', 15)}</button>
      </div>`
    )
    .join('');

  return `
  <div class="edit-row ${selected ? 'edit-selected' : ''}" data-id="${escapeHtml(word.id)}" data-index="${index}">
    <textarea class="edit-field edit-inline-field edit-category-input" rows="1" data-action="edit-category" data-id="${escapeHtml(
      word.id
    )}" placeholder="분류">${escapeHtml(word.category)}</textarea>
    <div class="edit-row-word">
      <textarea class="edit-field edit-inline-field edit-word-input" rows="1" data-action="edit-word" data-id="${escapeHtml(
        word.id
      )}" placeholder="표제어">${escapeHtml(word.word)}</textarea>
      <button class="edit-word-delete-btn" data-action="edit-delete-word" data-id="${escapeHtml(
        word.id
      )}" aria-label="단어 삭제">${icon('trash-2', 15)}</button>
    </div>
    <div class="edit-row-meanings">
      ${meaningsHtml}
      <button class="edit-add-meaning-btn" data-action="edit-add-meaning" data-id="${escapeHtml(
        word.id
      )}">+ 뜻 추가</button>
    </div>
  </div>`;
}

function renderProgressPanel() {
  const stats = computeStats();

  if (settings.progressCollapsed) {
    return `
  <aside class="progress-panel collapsed">
    <button class="panel-toggle" data-action="toggle-progress-collapse" aria-label="진행률 펼치기">${icon(
      'chevron-left',
      15
    )}</button>
  </aside>`;
  }

  return `
  <aside class="progress-panel">
    <div class="progress-header">
      진행률
      <button class="panel-toggle" data-action="toggle-progress-collapse" aria-label="진행률 접기">${icon(
        'chevron-right',
        15
      )}</button>
    </div>
    ${renderProgressBody(stats)}
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
        <button class="modal-close" data-action="close-export">${icon('x', 17)}</button>
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
        <button class="modal-close" data-action="close-advanced-search">${icon('x', 17)}</button>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">검색 방식</div>
        <div class="chip-group">
          <button class="chip-btn ${
            !s.useRegex ? 'active' : ''
          }" data-action="search-filter-toggle" data-filter="useRegex">정규식 미사용</button>
        </div>
        <div class="modal-hint">기본적으로 검색어를 정규표현식으로 해석합니다. "정규식 미사용"을 누르면 <code>* . \\</code> 같은 특수문자도 그냥 일반 글자로 검색됩니다.</div>
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
        <button class="modal-close" data-action="close-help">${icon('x', 17)}</button>
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
          <li><b>메뉴 아이콘</b> — 진행률·분류별 통계, 사용법, 설정</li>
        </ul>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">검색</div>
        <ul class="help-list">
          <li>검색창 왼쪽에서 범위 선택 — <b>표제어+뜻</b>(기본) / 표제어 / 뜻</li>
          <li>결과는 단어 분류별로 묶이고, 그 안에서 가나다순으로 정렬됩니다</li>
          <li><b>고급 검색 아이콘</b> — 암기/미암기/중요, 단어 분류로 좁혀서 검색 (분류는 암기·중요 조건과 AND로 결합됩니다)</li>
          <li>기본적으로 검색어를 <b>정규표현식</b>으로 해석합니다. 고급 검색에서 <b>정규식 미사용</b>을 누르면 <code>* . \\</code> 같은 특수문자도 그냥 일반 글자로 검색됩니다</li>
        </ul>
      </div>
      <div class="modal-section">
        <div class="modal-section-title">카드 표시</div>
        <ul class="help-list">
          <li><b>스틸 배경 채움</b> (카드 전체) — 암기된 단어</li>
          <li><b>표제어 밑줄 + 북마크 아이콘</b> — 중요 단어</li>
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
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
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
  // Suspended in edit mode — a click there means "select for bulk delete"
  // (see setupEditSelection), a different meaning entirely.
  let focusChanged = false;
  if (!ui.editMode) {
    const cardEl = e.target.closest('.word-card');
    const newFocus = cardEl ? Number(cardEl.getAttribute('data-index')) : null;
    focusChanged = newFocus !== ui.focusedIndex;
    ui.focusedIndex = newFocus;
  }

  // Two ways to trigger each of these: an exact click on the backdrop
  // itself (dimmed area around the modal — never has other content
  // covering that exact point, so an exact e.target check is enough), or
  // anywhere inside the .modal-close button — which now wraps a Lucide
  // icon <svg>, so e.target when actually clicking it is the icon, not the
  // button; closest('.modal-close...') is needed to still catch that
  // rather than only matching a direct click on the button element itself.
  // .modal-close is never reused on the backdrop, so this can't accidentally
  // match a click elsewhere inside the modal's content.
  if (
    (e.target.dataset && e.target.dataset.action === 'close-export') ||
    e.target.closest('.modal-close[data-action="close-export"]')
  ) {
    ui.exportOpen = false;
    render();
    return;
  }

  if (
    (e.target.dataset && e.target.dataset.action === 'close-mobile-drawer') ||
    e.target.closest('.drawer-close-btn[data-action="close-mobile-drawer"]')
  ) {
    ui.mobileDrawerOpen = false;
    render();
    return;
  }

  if (
    (e.target.dataset && e.target.dataset.action === 'close-advanced-search') ||
    e.target.closest('.modal-close[data-action="close-advanced-search"]')
  ) {
    ui.search.advancedOpen = false;
    render();
    return;
  }

  if (
    (e.target.dataset && e.target.dataset.action === 'close-help') ||
    e.target.closest('.modal-close[data-action="close-help"]')
  ) {
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
    settings.fontSize = Math.max(12, settings.fontSize - 1);
    saveSettings(settings);
    render();
    return;
  }
  const fontInc = e.target.closest('[data-action="font-size-inc"]');
  if (fontInc) {
    settings.fontSize = Math.min(22, settings.fontSize + 1);
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

  const editModeBtn = e.target.closest('[data-action="toggle-edit-mode"]');
  if (editModeBtn) {
    if (ui.editMode) cleanupBlankMeanings(); // leaving edit mode — drop any "새 뜻 추가" rows nobody filled in
    ui.editMode = !ui.editMode;
    ui.editSelectedIds = new Set();
    ui.focusedIndex = null;
    if (ui.editMode) ui.editHistory = []; // fresh undo stack each time edit mode is entered
    render();
    return;
  }

  const undoEditBtn = e.target.closest('[data-action="undo-edit"]');
  if (undoEditBtn) {
    undoEdit();
    return;
  }

  const startSessionBtn = e.target.closest('[data-action="start-session"]');
  if (startSessionBtn) {
    startSession();
    return;
  }

  const endSessionBtn = e.target.closest('[data-action="end-session"]');
  if (endSessionBtn) {
    endSession();
    return;
  }

  const sessionRestartBtn = e.target.closest('[data-action="session-restart"]');
  if (sessionRestartBtn) {
    startSession();
    return;
  }

  const sessionRevealBtn = e.target.closest('[data-action="session-reveal"]');
  if (sessionRevealBtn) {
    sessionReveal();
    return;
  }

  const sessionKnowBtn = e.target.closest('[data-action="session-know"]');
  if (sessionKnowBtn) {
    sessionKnow();
    return;
  }

  const sessionAgainBtn = e.target.closest('[data-action="session-again"]');
  if (sessionAgainBtn) {
    sessionAgain();
    return;
  }

  const sessionImportantBtn = e.target.closest('[data-action="session-toggle-important"]');
  if (sessionImportantBtn) {
    toggleImportant(sessionImportantBtn.getAttribute('data-id'));
    return;
  }

  const editAddMeaningBtn = e.target.closest('[data-action="edit-add-meaning"]');
  if (editAddMeaningBtn) {
    const id = editAddMeaningBtn.getAttribute('data-id');
    const w = words.find((x) => x.id === id);
    if (w) {
      pushEditHistory();
      w.meanings.push({ meaning: '', example: '' });
      saveWords(words);
      render();
      const newIndex = w.meanings.length - 1;
      requestAnimationFrame(() => {
        const field = document.querySelector(`.edit-meaning-input[data-id="${id}"][data-index="${newIndex}"]`);
        if (field) field.focus();
      });
    }
    return;
  }

  const editDeleteMeaningBtn = e.target.closest('[data-action="edit-delete-meaning"]');
  if (editDeleteMeaningBtn) {
    const id = editDeleteMeaningBtn.getAttribute('data-id');
    const index = Number(editDeleteMeaningBtn.getAttribute('data-index'));
    const w = words.find((x) => x.id === id);
    if (w && w.meanings[index]) {
      pushEditHistory();
      w.meanings.splice(index, 1);
      const p = progress[id];
      if (p && Array.isArray(p.checked)) p.checked.splice(index, 1);
      saveWords(words);
      saveProgress(progress);
      render();
    }
    return;
  }

  const editDeleteWordBtn = e.target.closest('[data-action="edit-delete-word"]');
  if (editDeleteWordBtn) {
    const id = editDeleteWordBtn.getAttribute('data-id');
    const w = words.find((x) => x.id === id);
    if (w && confirm(`"${w.word || '(빈 단어)'}" 단어를 삭제하시겠습니까?`)) {
      pushEditHistory();
      words = words.filter((x) => x.id !== id);
      delete progress[id];
      ui.editSelectedIds.delete(id);
      saveWords(words);
      saveProgress(progress);
      render();
    }
    return;
  }

  const editAddWordBtn = e.target.closest('[data-action="edit-add-word"]');
  if (editAddWordBtn) {
    createNewWord();
    return;
  }

  const editBulkDeleteBtn = e.target.closest('[data-action="edit-bulk-delete"]');
  if (editBulkDeleteBtn) {
    if (ui.editSelectedIds.size === 0) return;
    if (confirm(`선택한 ${ui.editSelectedIds.size}개 단어를 삭제하시겠습니까?`)) {
      pushEditHistory();
      words = words.filter((w) => !ui.editSelectedIds.has(w.id));
      for (const id of ui.editSelectedIds) delete progress[id];
      ui.editSelectedIds = new Set();
      saveWords(words);
      saveProgress(progress);
      render();
    }
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

  const statCategoryFilter = e.target.closest('[data-action="stat-category-filter"]');
  if (statCategoryFilter) {
    const cat = statCategoryFilter.getAttribute('data-category');
    const filter = statCategoryFilter.getAttribute('data-filter') || null; // '' (전체 칩) normalizes to "no filter"
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

  const bookmarkBtn = e.target.closest('[data-action="toggle-important-click"]');
  if (bookmarkBtn) {
    toggleImportant(bookmarkBtn.getAttribute('data-id'));
    return;
  }

  const checkBtn = e.target.closest('[data-action="toggle-checked"]');
  if (checkBtn) {
    const id = checkBtn.getAttribute('data-id');
    const index = Number(checkBtn.getAttribute('data-index'));
    const p = progress[id];
    if (p && Array.isArray(p.checked)) setMeaningChecked(id, index, !p.checked[index]);
    return;
  }

  const darkBtn = e.target.closest('[data-action="toggle-dark"]');
  if (darkBtn) {
    settings.darkMode = !settings.darkMode;
    saveSettings(settings);
    render();
    return;
  }

  const modeSegBtn = e.target.closest('[data-action="select-mode-btn"]');
  if (modeSegBtn) {
    settings.mode = modeSegBtn.getAttribute('data-mode');
    saveSettings(settings);
    ui.revealedIds.clear();
    render();
    return;
  }

  const viewDrawerToggleBtn = e.target.closest('[data-action="toggle-view-drawer"]');
  if (viewDrawerToggleBtn) {
    ui.viewDrawerOpen = !ui.viewDrawerOpen;
    render();
    return;
  }

  const deviceToggleBtn = e.target.closest('[data-action="toggle-device"]');
  if (deviceToggleBtn) {
    // Force the opposite of whatever's currently in effect (real viewport,
    // if this hadn't been touched yet) — from here it just alternates
    // between the two forced states.
    settings.device = isMobileLayout() ? 'pc' : 'mobile';
    saveSettings(settings);
    render();
    return;
  }

  const examplesToggleBtn = e.target.closest('[data-action="toggle-examples"]');
  if (examplesToggleBtn) {
    settings.examples = !settings.examples;
    saveSettings(settings);
    render();
    return;
  }

  const viewDrawerFilterBtn = e.target.closest('[data-action="view-drawer-filter"]');
  if (viewDrawerFilterBtn) {
    const key = viewDrawerFilterBtn.getAttribute('data-filter');
    ui.filterMode = key === 'all' ? null : key;
    ui.activeCategory = null;
    deactivateShuffle();
    resetPaging();
    render();
    return;
  }

  const resetProgressBtn = e.target.closest('[data-action="reset-progress"]');
  if (resetProgressBtn) {
    if (confirm('모든 단어의 진행률(암기·중요·복습 일정)을 초기화하시겠습니까?')) {
      resetAllProgress();
    }
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
  const modeSelect = e.target.closest('[data-action="select-mode"]');
  if (modeSelect) {
    settings.mode = modeSelect.value;
    saveSettings(settings);
    ui.revealedIds.clear();
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

// ---------- edit mode: grow fields with their content as you type ----------
// Purely a style mutation on the one field being typed into — no render(),
// so it can safely run on every keystroke without the focus-loss risk that
// rules out re-rendering here (see the focusout handler below).
document.getElementById('app').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.classList || !el.classList.contains('edit-field')) return;
  autoResizeField(el);
  noteEditHistoryTyping();
});

// ---------- edit mode: commit field edits on blur, not per keystroke ----------
// 'focusout' (the bubbling version of 'blur') fires reliably before any
// other click-driven action processes, since the browser always blurs a
// focused field before a click elsewhere is handled — so committing only
// here (never on 'input') is enough to not lose in-progress edits, while
// completely avoiding a render() while the user is still typing. That
// matters more here than for the search box: edit mode can have dozens of
// input/textarea fields on screen at once, and re-rendering on every
// keystroke in any of them would tear out whichever one is focused, same
// as the search box's IME bug but multiplied across every field.
document.getElementById('app').addEventListener('focusout', (e) => {
  const target = e.target;
  if (!target.classList) return;

  if (target.classList.contains('edit-category-input')) {
    const w = words.find((x) => x.id === target.getAttribute('data-id'));
    if (w) {
      w.category = target.value.trim() || '미분류';
      saveWords(words);
    }
    return;
  }

  if (target.classList.contains('edit-word-input')) {
    const w = words.find((x) => x.id === target.getAttribute('data-id'));
    if (w) {
      w.word = target.value.trim();
      saveWords(words);
    }
    return;
  }

  if (target.classList.contains('edit-meaning-input') || target.classList.contains('edit-example-input')) {
    const w = words.find((x) => x.id === target.getAttribute('data-id'));
    if (!w) return;
    const idx = Number(target.getAttribute('data-index'));
    if (!w.meanings[idx]) w.meanings[idx] = { meaning: '', example: '' };
    if (target.classList.contains('edit-meaning-input')) w.meanings[idx].meaning = target.value.trim();
    else w.meanings[idx].example = target.value.trim();
    saveWords(words);
    return;
  }
});

// ---------- swipe paging (touch only, so mouse/trackpad use on PC is untouched) ----------

(function setupSwipeNavigation() {
  const SWIPE_MIN_DISTANCE = 70; // px — small drags/taps don't page, keeps it from feeling twitchy
  const SWIPE_MAX_OFF_AXIS_RATIO = 0.6; // vertical drift allowed, relative to horizontal distance
  const SWIPE_MAX_DURATION = 700; // ms — a slow drag reads as scrolling intent, not a swipe

  let touch = null;
  const appEl = document.getElementById('app');

  appEl.addEventListener('pointerdown', (e) => {
    if (ui.editMode) return; // a drag across cards now means "select for deletion" — see setupEditSelection
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
    if (ui.editMode) return; // edit mode redefines card interaction entirely — see setupEditSelection
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

// ---------- edit mode: drag across cards to mark them for bulk delete ----------
// A single tap/click is just a zero-distance drag — toggling the one card
// it landed on — so there's no separate "click to select" path to keep in
// sync with this. Touching a field/button instead lets that control handle
// its own click (editing text, the × delete, etc.) rather than toggling
// selection underneath it.
(function setupEditSelection() {
  const appEl = document.getElementById('app');
  let dragging = false;
  let touchedIds = null;

  function isInteractiveTarget(el) {
    return Boolean(el.closest('input, textarea, button, select, a, .edit-meaning-grip'));
  }

  function toggleSelected(id) {
    if (ui.editSelectedIds.has(id)) ui.editSelectedIds.delete(id);
    else ui.editSelectedIds.add(id);
    render();
  }

  appEl.addEventListener('pointerdown', (e) => {
    if (!ui.editMode) return;
    if (isInteractiveTarget(e.target)) return;
    const card = e.target.closest('.edit-row');
    if (!card) return;
    dragging = true;
    touchedIds = new Set([card.getAttribute('data-id')]);
    toggleSelected(card.getAttribute('data-id'));
  });

  appEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const card = el && el.closest('.edit-row');
    if (!card) return;
    const id = card.getAttribute('data-id');
    if (touchedIds.has(id)) return; // already toggled once during this drag
    touchedIds.add(id);
    toggleSelected(id);
  });

  function endDrag() {
    dragging = false;
    touchedIds = null;
  }
  appEl.addEventListener('pointerup', endDrag);
  appEl.addEventListener('pointercancel', endDrag);
})();

// ---------- edit mode: drag a meaning's grip to reorder within its word ----------
// Native HTML5 drag-and-drop, scoped to mouse/pointer devices (touch has no
// equivalent here — reordering on mobile just isn't supported). Only the
// grip is draggable (not the whole row), so dragging inside the textareas
// still just selects text as normal. setDragImage swaps in the whole row so
// what visibly moves is the row, not the small grip icon.
(function setupMeaningDrag() {
  const appEl = document.getElementById('app');
  let dragState = null; // { id, fromIndex }

  function clearDropMarkers() {
    document.querySelectorAll('.edit-meaning-row.drop-before, .edit-meaning-row.drop-after').forEach((r) => {
      r.classList.remove('drop-before', 'drop-after');
    });
  }

  appEl.addEventListener('dragstart', (e) => {
    const grip = e.target.closest('.edit-meaning-grip');
    if (!grip) return;
    const row = grip.closest('.edit-meaning-row');
    if (!row) return;
    dragState = { id: row.getAttribute('data-id'), fromIndex: Number(row.getAttribute('data-index')) };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setDragImage(row, 20, 20);
    } catch (err) {
      // ignore — cosmetic only, reordering still works without it
    }
  });

  appEl.addEventListener('dragover', (e) => {
    if (!dragState) return;
    const row = e.target.closest('.edit-meaning-row');
    if (!row || row.getAttribute('data-id') !== dragState.id) return;
    e.preventDefault();
    clearDropMarkers();
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    row.classList.add(before ? 'drop-before' : 'drop-after');
  });

  appEl.addEventListener('drop', (e) => {
    if (!dragState) return;
    const row = e.target.closest('.edit-meaning-row');
    clearDropMarkers();
    const { id, fromIndex } = dragState;
    dragState = null;
    if (!row || row.getAttribute('data-id') !== id) return;
    e.preventDefault();
    const overIndex = Number(row.getAttribute('data-index'));
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    let toIndex = before ? overIndex : overIndex + 1;
    if (toIndex === fromIndex || toIndex === fromIndex + 1) return; // dropped back where it started

    const w = words.find((x) => x.id === id);
    if (!w) return;
    pushEditHistory();
    const [movedMeaning] = w.meanings.splice(fromIndex, 1);
    if (toIndex > fromIndex) toIndex -= 1; // the splice above shifted everything after fromIndex left by one
    w.meanings.splice(toIndex, 0, movedMeaning);

    // checked state (and thus each meaning's numbering) rides along with it
    const p = progress[id];
    if (p && Array.isArray(p.checked)) {
      const [movedChecked] = p.checked.splice(fromIndex, 1);
      p.checked.splice(toIndex, 0, movedChecked);
    }

    saveWords(words);
    saveProgress(progress);
    render();
  });

  appEl.addEventListener('dragend', () => {
    dragState = null;
    document.querySelectorAll('.edit-meaning-row.dragging').forEach((r) => r.classList.remove('dragging'));
    clearDropMarkers();
  });
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

  if (ui.session) {
    if (ui.session.finished) return; // completion screen only has its own buttons
    if (e.code === 'Space') {
      e.preventDefault();
      sessionReveal();
      return;
    }
    if (e.key === 'Enter') {
      sessionKnow();
      return;
    }
    if (e.key === 'ArrowRight') {
      sessionAgain();
      return;
    }
    return;
  }

  if (ui.editMode) return; // card focus/Space/Enter don't apply while editing

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
