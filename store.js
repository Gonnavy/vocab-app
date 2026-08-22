// Persistence layer: localStorage-backed settings / word data / per-word progress.

const STORAGE_KEYS = {
  words: 'vocabApp.words',
  progress: 'vocabApp.progress',
  settings: 'vocabApp.settings',
};

// Bump whenever a stored shape changes and add a step to PROGRESS_MIGRATIONS
// / SETTINGS_MIGRATIONS (keyed by the version the step upgrades *to*) rather
// than special-casing old saves inline elsewhere — runMigrations() replays
// only the steps a given save is actually behind on.
const SCHEMA_VERSION = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const SRS_INTERVAL_DAYS = [1, 2, 4, 8, 16, 32]; // stage 1..6 -> days until next due

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// version 1 -> 2: SRS fields (stage/due) didn't exist before — backfill so
// every record has them. A word already marked memorized is assumed to be
// reasonably well known already (stage 2, due in that stage's interval);
// anything else starts as due immediately (stage 0, due today), same as a
// brand-new word.
const PROGRESS_MIGRATIONS = {
  2: (progress) => {
    const midnight = todayMidnight();
    for (const id of Object.keys(progress)) {
      const p = progress[id];
      if (typeof p.stage !== 'number') p.stage = p.memorized ? 2 : 0;
      if (typeof p.due !== 'number') {
        p.due = p.stage > 0 ? midnight + SRS_INTERVAL_DAYS[p.stage - 1] * DAY_MS : midnight;
      }
    }
  },
};

// No settings fields have needed a migration yet — the structure is here so
// the next field addition follows the same pattern as PROGRESS_MIGRATIONS.
const SETTINGS_MIGRATIONS = {};

// Runs every step strictly after `fromVersion` up to SCHEMA_VERSION, in
// order, mutating `subject` in place. A save already at SCHEMA_VERSION runs
// nothing.
function runMigrations(migrations, fromVersion, subject) {
  for (let v = fromVersion + 1; v <= SCHEMA_VERSION; v++) {
    const step = migrations[v];
    if (step) step(subject);
  }
  return subject;
}

const DEFAULT_SETTINGS = {
  darkMode: false,
  fontSize: 15, // px, 12-22 (card body text size)
  mode: 'memorize', // 'memorize' | 'meaning-test' | 'word-test'
  cols: 3, // 1-5
  count: 3, // 1-15, cards per feed page
  examples: true, // show/hide example sentences on cards
  device: 'auto', // 'auto' | 'pc' | 'mobile' — 'auto' follows the real viewport; the toolbar toggle forces the other one
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

// Stored as { schema, data } so the version lives alongside the map rather
// than inside it (a reserved key in the {id: progress} map itself would
// collide with real word ids). A save from before this wrapper existed is
// the bare {id: progress} map at schema 1.
function loadProgress() {
  const raw = readJSON(STORAGE_KEYS.progress, null);
  if (!raw) return {};
  const hasWrapper = raw && typeof raw === 'object' && typeof raw.schema === 'number';
  const fromVersion = hasWrapper ? raw.schema : 1;
  const data = hasWrapper ? raw.data || {} : raw;
  return runMigrations(PROGRESS_MIGRATIONS, fromVersion, data);
}

function saveProgress(progress) {
  writeJSON(STORAGE_KEYS.progress, { schema: SCHEMA_VERSION, data: progress });
}

function loadSettings() {
  const raw = readJSON(STORAGE_KEYS.settings, {});
  const fromVersion = typeof raw.schema === 'number' ? raw.schema : 1;
  runMigrations(SETTINGS_MIGRATIONS, fromVersion, raw);
  raw.schema = SCHEMA_VERSION; // now current, whether or not any step actually ran
  return Object.assign({}, DEFAULT_SETTINGS, raw);
}

function saveSettings(settings) {
  writeJSON(STORAGE_KEYS.settings, Object.assign({ schema: SCHEMA_VERSION }, settings));
}

function defaultProgressFor(word) {
  return {
    memorized: false, // 미암기(false) / 암기(true)
    important: false,
    checked: (word.meanings || []).map(() => false),
    stage: 0, // 0-6, spaced-repetition step — see SRS_INTERVAL_DAYS
    due: todayMidnight(), // epoch ms; a new word is due for review immediately
  };
}
