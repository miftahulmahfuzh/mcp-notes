// Note id: [0-9A-Z]-[0-9A-Z]{3}, matched case-insensitively and not inside a longer token.
const ID_RE = /(?<![0-9A-Za-z-])([0-9A-Za-z])-([0-9A-Za-z]{3})(?![0-9A-Za-z-])/g;

/** Ids of loaded notes mentioned in `text`, in order of first mention, returned in the notes' own casing. */
export function extractUsedIds(text: string, known: Iterable<string>): string[] {
  const byUpper = new Map<string, string>();
  for (const k of known) byUpper.set(k.toUpperCase(), k);
  const out: string[] = [];
  for (const m of text.matchAll(ID_RE)) {
    const id = byUpper.get(`${m[1]}-${m[2]}`.toUpperCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
