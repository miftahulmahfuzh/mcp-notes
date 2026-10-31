/**
 * The model replies to a bubble by STARTING its answer with `[msg:ID]`. The server strips that
 * marker into `reply_to`; a `[msg:ID]` anywhere else is just text. Streaming: the filter holds back
 * the start of the answer until it knows whether a marker is there, so the marker never flashes
 * in the panel. Text that cannot start a marker is released at once.
 */

/** The longest start of an answer held back while it could still be a marker. */
export const CITATION_LOOKAHEAD = 16;

const MARKER = /^\[msg:([0-9a-z]{4})\]/i;
/** Any proper prefix of a marker: `[`, `[m`, ..., `[msg:K7F2` (without the closing bracket). */
const MARKER_PREFIX = /^\[(?:m(?:s(?:g(?::[0-9a-z]{0,4})?)?)?)?$/i;

/** Whole-text form: the leading marker's id (upper case) and the text without it. */
export function parseLeadingCitation(text: string): { replyTo: string | null; text: string } {
  const lead = text.replace(/^\s+/, '');
  const m = MARKER.exec(lead);
  if (m === null || m[1] === undefined) return { replyTo: null, text };
  return { replyTo: m[1].toUpperCase(), text: lead.slice(m[0].length).replace(/^\s+/, '') };
}

type State = 'buffering' | 'stripping' | 'passthrough';

export class CitationFilter {
  private state: State = 'buffering';
  private pending = '';
  private emitted = '';
  private cited: string | null = null;

  /** Feeds one delta; returns the text to send now (may be ''). */
  push(chunk: string): string {
    let out: string;
    switch (this.state) {
      case 'passthrough':
        out = chunk;
        break;
      case 'stripping':
        out = chunk.replace(/^\s+/, '');
        if (out !== '') this.state = 'passthrough';
        break;
      case 'buffering':
        out = this.scan(chunk);
        break;
    }
    this.emitted += out;
    return out;
  }

  /**
   * A non-text event (a status caption) arrived. Held text that is not just whitespace goes out
   * now, to keep the order; with nothing (or only whitespace) held, keep waiting for a marker,
   * because answers usually start after the tool calls.
   */
  flush(): string {
    if (this.state !== 'buffering' || this.pending.trim() === '') return '';
    const out = this.release();
    this.emitted += out;
    return out;
  }

  /** The stream ended: whatever is still held goes out as text. */
  end(): string {
    if (this.state !== 'buffering' || this.pending === '') return '';
    const out = this.release();
    this.emitted += out;
    return out;
  }

  /** The cited id (syntactically valid, upper case), or null. Not checked against the database. */
  get replyTo(): string | null {
    return this.cited;
  }

  /** Everything sent so far: the answer without its marker. */
  get text(): string {
    return this.emitted;
  }

  private scan(chunk: string): string {
    this.pending += chunk;
    const lead = this.pending.replace(/^\s+/, '');
    const m = MARKER.exec(lead);
    if (m !== null && m[1] !== undefined) {
      this.cited = m[1].toUpperCase();
      this.pending = '';
      const rest = lead.slice(m[0].length).replace(/^\s+/, '');
      this.state = rest === '' ? 'stripping' : 'passthrough';
      return rest;
    }
    if ((lead === '' || MARKER_PREFIX.test(lead)) && this.pending.length < CITATION_LOOKAHEAD) return '';
    return this.release();
  }

  private release(): string {
    const out = this.pending;
    this.pending = '';
    this.state = 'passthrough';
    return out;
  }
}
