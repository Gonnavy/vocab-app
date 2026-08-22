// Persistence layer: localStorage-backed settings / word data / per-word progress.

const STORAGE_KEYS = {
  words: 'vocabApp.words',
  progress: 'vocabApp.progress',
  settings: 'vocabApp.settings',
};

const DEFAULT_SETTINGS = {
  darkMode: false,
  fontSize: 15, // px, 12-22 (card body text size)
  mode: 'memorize', // 'memorize' | 'meaning-test' | 'word-test'
  cols: 3, // 1-5
  count: 3, // 1-15, cards per feed page
  toolbarCollapsed: false,
  progressCollapsed: false,
};

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
