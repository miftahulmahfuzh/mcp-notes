// Language codes as streams and TMDB write them, brought to one form: the ISO 639-1 code where
// there is one. TMDB gives 639-1 ("ko"); an MPEG-TS or MP4 track gives 639-2 ("kor", "eng"); a
// manifest gives either, a region tag ("en-US") or a name ("Korean").

/** 639-2 (both forms) and common names -> 639-1. */
const TO_TWO = new Map(
  Object.entries({
    en: ['eng', 'english'],
    ko: ['kor', 'korean'],
    ja: ['jpn', 'japanese'],
    zh: ['chi', 'zho', 'cmn', 'yue', 'cn', 'chinese', 'mandarin', 'cantonese'],
    es: ['spa', 'spanish', 'espanol', 'castellano', 'latino'],
    fr: ['fre', 'fra', 'french', 'francais'],
    de: ['ger', 'deu', 'german', 'deutsch'],
    it: ['ita', 'italian', 'italiano'],
    pt: ['por', 'portuguese', 'portugues'],
    ru: ['rus', 'russian'],
    hi: ['hin', 'hindi'],
    ta: ['tam', 'tamil'],
    te: ['tel', 'telugu'],
    ml: ['mal', 'malayalam'],
    kn: ['kan', 'kannada'],
    bn: ['ben', 'bengali'],
    mr: ['mar', 'marathi'],
    pa: ['pan', 'punjabi'],
    ur: ['urd', 'urdu'],
    id: ['ind', 'indonesian', 'bahasa'],
    ms: ['may', 'msa', 'malay'],
    th: ['tha', 'thai'],
    vi: ['vie', 'vietnamese'],
    tl: ['tgl', 'fil', 'tagalog', 'filipino'],
    tr: ['tur', 'turkish'],
    ar: ['ara', 'arabic'],
    fa: ['per', 'fas', 'persian', 'farsi'],
    he: ['heb', 'hebrew', 'iw'],
    pl: ['pol', 'polish'],
    nl: ['dut', 'nld', 'dutch'],
    sv: ['swe', 'swedish'],
    no: ['nor', 'nob', 'nno', 'nb', 'nn', 'norwegian'],
    da: ['dan', 'danish'],
    fi: ['fin', 'finnish'],
    is: ['ice', 'isl', 'icelandic'],
    cs: ['cze', 'ces', 'czech'],
    sk: ['slo', 'slk', 'slovak'],
    hu: ['hun', 'hungarian'],
    ro: ['rum', 'ron', 'romanian'],
    bg: ['bul', 'bulgarian'],
    el: ['gre', 'ell', 'greek'],
    uk: ['ukr', 'ukrainian'],
    sr: ['srp', 'serbian'],
    hr: ['hrv', 'croatian'],
    ca: ['cat', 'catalan'],
    la: ['lat', 'latin'],
  }).flatMap(([two, others]) => [[two, two], ...others.map((other) => [other, two])]),
);

/** Tags that name no language. */
const NO_LANGUAGE = new Set(['', 'und', 'unk', 'mul', 'zxx', 'mis', 'qaa', 'xx', 'unknown', 'undefined', 'default', 'original', 'audio']);

/**
 * One language tag in the common form: "eng", "en-US", "English" are "en"; a code with no 639-1
 * form stays as it is, lower case ("haw"); null when the tag names no language ("und", "").
 */
export function normalizeLang(tag) {
  const text = String(tag ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
  const head = text.split(/[-_\s(]/)[0] ?? '';
  if (NO_LANGUAGE.has(text) || NO_LANGUAGE.has(head)) return null;
  const known = TO_TWO.get(text) ?? TO_TWO.get(head);
  if (known !== undefined) return known;
  return /^[a-z]{2,3}$/.test(head) ? head : null;
}

/** The distinct languages of some tags, in order; tags that name none are dropped. */
export function languagesOf(tags) {
  const out = [];
  for (const tag of tags) {
    const lang = normalizeLang(tag);
    if (lang !== null && !out.includes(lang)) out.push(lang);
  }
  return out;
}
