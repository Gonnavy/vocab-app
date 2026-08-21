// Decode a CSV file's raw bytes, auto-detecting UTF-8 vs EUC-KR (CP949).
// Windows/Excel commonly saves Korean CSVs in EUC-KR; forcing UTF-8 on those
// produces mojibake. A non-fatal UTF-8 decode that yields replacement
// characters (U+FFFD) means the bytes aren't valid UTF-8, so we retry as
// EUC-KR. A leading BOM (from UTF-8-with-BOM exports) is stripped either way.
function decodeCSVBuffer(buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  let text = utf8;
  if (utf8.indexOf('�') !== -1) {
    try {
      text = new TextDecoder('euc-kr', { fatal: false }).decode(buffer);
    } catch (e) {
      text = utf8;
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

// Minimal CSV parser (handles quoted fields, commas/newlines inside quotes, CRLF).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function isTruthyFlag(v) {
  return ['1', 'true', 'yes', 'y', 'o', '참'].includes((v || '').trim().toLowerCase());
}

// Columns are positional — always category,word,meaning,example in that
// order, regardless of what the header row's cells actually say. The first
// row is always treated as a header and skipped. Rows sharing the same
// category+word are grouped into one word entry with multiple
// {meaning, example} pairs. Any text content (Korean/Hanja/Hiragana/Latin/
// digits/symbols) is accepted as-is; only a blank word is rejected.
//
// Optional progress-sync columns 5-8 (memorized,caution,important,checked)
// let a CSV exported from another device carry study progress along with
// the word list. Their presence is detected from the header row's column
// count so plain word-list CSVs (no such columns) are unaffected — imported
// words then get importedProgress=null and fall back to local defaults.
function rowsToWords(rows) {
  if (rows.length === 0) return [];

  const hasProgressCols = rows[0].length > 4;
  const words = [];
  const byKey = new Map();
  const keyCount = new Map();

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const category = (cols[0] || '').trim() || '미분류';
    const word = (cols[1] || '').trim();
    const meaning = (cols[2] || '').trim();
    const example = (cols[3] || '').trim();
    if (!word) continue;

    const baseKey = `${category}::${word}`;
    let entry = byKey.get(baseKey + '#last');
    if (!entry) {
      const n = keyCount.get(baseKey) || 0;
      keyCount.set(baseKey, n + 1);
      const id = n === 0 ? baseKey : `${baseKey}::${n}`;
      entry = {
        id,
        category,
        word,
        meanings: [],
        importedProgress: hasProgressCols
          ? { memorized: false, caution: false, important: false, checked: [] }
          : null,
      };
      words.push(entry);
      byKey.set(baseKey + '#last', entry);
    }

    if (meaning || example) entry.meanings.push({ meaning, example });

    if (hasProgressCols) {
      entry.importedProgress.memorized = isTruthyFlag(cols[4]);
      entry.importedProgress.caution = isTruthyFlag(cols[5]);
      entry.importedProgress.important = isTruthyFlag(cols[6]);
      if (meaning || example) entry.importedProgress.checked.push(isTruthyFlag(cols[7]));
    }
  }

  return words;
}

function parseCSVToWords(text) {
  return rowsToWords(parseCSV(text));
}

function csvField(value) {
  let str = String(value == null ? '' : value);
  // CSV/formula injection guard: a field starting with =, +, -, or @ gets
  // interpreted as a formula by Excel/Sheets when the file is opened there.
  // Since exported words can come from someone else's meaning/example text,
  // prefix a leading apostrophe to force plain-text — invisible in normal
  // CSV consumers, and it's exactly what spreadsheet apps expect to force
  // text formatting anyway.
  if (/^[=+\-@]/.test(str)) {
    str = "'" + str;
  }
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Inverse of parseCSVToWords: one row per {meaning, example} pair (or a
// single blank-meaning row for words with no meanings recorded). Also
// carries each word's study progress (memorized/caution/important, plus
// per-meaning checked state) in trailing columns so the file can be
// re-imported — on this device or another — with progress intact.
function wordsToCSV(words, progress) {
  const lines = ['category,word,meaning,example,memorized,caution,important,checked'];
  const flag = (b) => (b ? '1' : '0');
  for (const w of words) {
    const p = (progress && progress[w.id]) || { memorized: false, caution: false, important: false, checked: [] };
    const wordFlags = [flag(p.memorized), flag(p.caution), flag(p.important)];
    if (w.meanings.length === 0) {
      lines.push([csvField(w.category), csvField(w.word), '', '', ...wordFlags, ''].join(','));
      continue;
    }
    w.meanings.forEach((m, i) => {
      lines.push(
        [
          csvField(w.category),
          csvField(w.word),
          csvField(m.meaning),
          csvField(m.example),
          ...wordFlags,
          flag(Boolean(p.checked[i])),
        ].join(',')
      );
    });
  }
  return lines.join('\r\n');
}
