// Checks whether a Japanese title can be read as a given romanized title, using every reading of each
// kanji (KANJIDIC2) rather than a single guess. Anime song titles often use uncommon readings: 炎 "Homura"
// (usually "honoo"), 紅蓮華 "Gurenge", 廻廻奇譚 "Kaikai Kitan".
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { toRomaji, toHiragana } = require("wanakana");

const dictionaryFile = path.join(__dirname, "data", "kanjidic2.xml.gz");
let readingsByKanji = null;

function normaliseRomaji(value) {
  return String(value || "").toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/([aeiou])\1+/g, "$1")
    .replace(/ou/g, "o")
    .replace(/wo/g, "o")
    .replace(/du/g, "zu")
    .replace(/di/g, "ji")
    .replace(/m(?=[bp])/g, "n")
    .replace(/([bcdfghjklmpqrstvwxyz])\1+/g, "$1");
}

const voiced = [["ch", "j"], ["sh", "j"], ["ts", "z"], ["k", "g"], ["s", "z"], ["t", "d"], ["h", "b"], ["h", "p"], ["f", "b"], ["f", "p"]];

// A reading plus the ways it changes inside words: voiced at the start (rendaku: 華 "ka" → "ga" in 紅蓮華)
// and shortened before a doubled consonant (学 "gaku" → "ga" in 学校 "gakkou").
function readingForms(kana) {
  const romaji = normaliseRomaji(toRomaji(kana));
  if (!romaji) return [];
  const forms = new Set([romaji]);
  for (const [plain, voice] of voiced) if (romaji.startsWith(plain)) forms.add(voice + romaji.slice(plain.length));
  for (const form of [...forms]) {
    const shortened = form.replace(/(tsu|chi|ku|ki)$/, "");
    if (shortened && shortened !== form) forms.add(shortened);
  }
  return [...forms];
}

function loadReadings() {
  if (readingsByKanji) return readingsByKanji;
  readingsByKanji = new Map();
  const xml = zlib.gunzipSync(fs.readFileSync(dictionaryFile)).toString("utf8");
  const entryPattern = /<character>([\s\S]*?)<\/character>/g;
  const readingPattern = /<reading r_type="ja_(?:on|kun)">([^<]+)<\/reading>|<nanori>([^<]+)<\/nanori>/g;
  for (const [, entry] of xml.matchAll(entryPattern)) {
    const literal = /<literal>([^<]+)<\/literal>/.exec(entry)?.[1];
    if (!literal) continue;
    const forms = new Set();
    for (const match of entry.matchAll(readingPattern)) {
      // Kun readings mark the okurigana (kana written after the kanji) with "." — the kanji itself is the part
      // before it. In compounds the kanji can also carry the whole word, often in its noun form
      // (語 "kata.ru" → 物語 "monoGATARI").
      const raw = (match[1] || match[2]).replace(/-/g, "");
      const [stem, okurigana] = raw.split(".");
      const readings = [stem];
      if (okurigana) {
        readings.push(stem + okurigana);
        const nounForm = { "る": "り", "く": "き", "す": "し", "つ": "ち", "う": "い", "む": "み", "ぶ": "び", "ぐ": "ぎ", "ぬ": "に" }[okurigana.slice(-1)];
        if (nounForm) readings.push(stem + okurigana.slice(0, -1) + nounForm);
      }
      for (const reading of readings) for (const form of readingForms(toHiragana(reading))) forms.add(form);
    }
    if (forms.size) readingsByKanji.set(literal, [...forms]);
  }
  return readingsByKanji;
}

// Whole-word readings from JMdict (data/word-readings.json.gz), for words read differently from their kanji
// one by one: 炎 "homura", 一途 "ichizu", 今日 "kyou".
const wordFile = path.join(__dirname, "data", "word-readings.json.gz");
let readingsByWord = null;

function loadWords() {
  if (!readingsByWord) {
    readingsByWord = new Map();
    try {
      const table = JSON.parse(zlib.gunzipSync(fs.readFileSync(wordFile)).toString("utf8"));
      for (const [word, readings] of Object.entries(table)) {
        readingsByWord.set(word, [...new Set(readings.flatMap(readingForms))]);
      }
    } catch (error) {
      console.error("Word readings unavailable:", error.message);
    }
  }
  return readingsByWord;
}

// Splits a title into units (a run of kana, a run of Latin letters/digits, or one other character), each with
// the romanized forms it may be read as on its own. Punctuation and symbols get no forms and are skipped.
function titleUnits(text) {
  const readings = loadReadings();
  const units = [];
  for (const unit of text.match(/[぀-ヿ]+|[a-zA-Z0-9]+|./gu) || []) {
    let forms = [];
    if (/^[぀-ヿ]+$/.test(unit)) forms = [normaliseRomaji(toRomaji(unit))];
    else if (/^[a-zA-Z0-9]+$/.test(unit)) forms = [normaliseRomaji(unit)];
    else if (unit === "々" && units.length) forms = units[units.length - 1].forms.flatMap(form => readingForms(toHiragana(toRomaji(form))));
    else if (readings.has(unit)) forms = readings.get(unit);
    else if (/[\p{L}\p{N}]/u.test(unit)) forms = null; // an unknown letter: the title can't be read
    units.push({ text: unit, forms: forms && forms.filter(Boolean) });
  }
  return units;
}

// True if the units can be read, in order, as exactly the target. Each step reads either one unit, or a run of
// units that together form a dictionary word.
function readsAs(units, target) {
  const words = loadWords();
  const states = units.map(() => new Set());
  states.push(new Set());
  states[0].add(0);
  for (let index = 0; index < units.length; index++) {
    if (!states[index].size) continue;
    const steps = [];
    if (units[index].forms === null) {
      // Unknown letters can only be read as part of a dictionary word.
    } else if (!units[index].forms.length) {
      steps.push({ next: index + 1, forms: [""] });
    } else {
      steps.push({ next: index + 1, forms: units[index].forms });
    }
    let word = units[index].text;
    for (let end = index + 1; end <= Math.min(units.length, index + 8); end++) {
      if (end > index + 1) word += units[end - 1].text;
      if (end > index + 1 || /[㐀-鿿]/.test(word)) {
        const forms = words.get(word);
        if (forms) steps.push({ next: end, forms });
      }
    }
    for (const position of states[index]) {
      for (const { next, forms } of steps) {
        for (const form of forms) {
          if (target.startsWith(form, position)) states[next].add(position + form.length);
        }
      }
    }
  }
  return states[units.length].has(target.length);
}

// Which of the candidate romanized titles the Japanese text could be read as.
function matchReadings(text, candidates) {
  const units = titleUnits(text);
  if (!units.length) return [];
  return candidates.filter(candidate => {
    const target = normaliseRomaji(candidate);
    return target.length >= 2 && readsAs(units, target);
  });
}

module.exports = { matchReadings, loadReadings, loadWords };
