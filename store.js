// Persistence layer: localStorage-backed settings / word data / per-word progress.

const STORAGE_KEYS = {
  words: 'vocabApp.words',
  progress: 'vocabApp.progress',
  settings: 'vocabApp.settings',
};

const DEFAULT_SETTINGS = {
  darkMode: false,
  font: 'kopub-batang',
  fontSize: 16,
  mode: 'memorize', // 'memorize' | 'meaning-test' | 'word-test'
  widthMode: 'contained', // 'contained' | 'full'
  cols: 3, // 1-5
  count: 3, // 1-15, cards per feed page
  cardHeight: 320, // px, 320-640 (CARD_MIN_HEIGHT to 2x)
  toolbarHeight: null, // px, null = auto
  progressWidth: null, // px, null = default (260)
  toolbarCollapsed: false,
  progressCollapsed: false,
};

const FONT_OPTIONS = [
  { value: 'kopub-batang', label: 'kopub 바탕체', stack: "'KoPubWorldBatang', 'Batang', serif" },
  { value: 'system', label: '시스템 기본', stack: "-apple-system, 'Malgun Gothic', sans-serif" },
  { value: 'gothic', label: '고딕체', stack: "'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif" },
  { value: 'serif', label: '명조체', stack: "'Batang', 'Nanum Myeongjo', serif" },
];

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to read', key, e);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('Failed to write', key, e);
  }
}

function loadWords() {
  return readJSON(STORAGE_KEYS.words, []);
}

function saveWords(words) {
  writeJSON(STORAGE_KEYS.words, words);
}

function loadProgress() {
  return readJSON(STORAGE_KEYS.progress, {});
}

function saveProgress(progress) {
  writeJSON(STORAGE_KEYS.progress, progress);
}

function loadSettings() {
  const saved = readJSON(STORAGE_KEYS.settings, {});
  return Object.assign({}, DEFAULT_SETTINGS, saved);
}

function saveSettings(settings) {
  writeJSON(STORAGE_KEYS.settings, settings);
}

function defaultProgressFor(word) {
  return {
    memorized: false, // 미암기(false) / 암기(true)
    important: false,
    checked: (word.meanings || []).map(() => false),
  };
}
