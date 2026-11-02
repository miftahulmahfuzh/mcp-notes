import type { SummarizeRequest, Summarizer } from '../../src/sessions/summarize.js';

/**
 * Deterministic offline Summarizer. The summary is "Summary of <node line>: <first prompt line>",
 * built from the input so tests can assert what the model saw.
 */
export class FakeSummarizer implements Summarizer {
  readonly model = 'fake-haiku';
  /** Every request, in call order (failed ones included). */
  readonly calls: SummarizeRequest[] = [];
  delayMs = 0;
  private failuresLeft = 0;
  private failure: Error = new Error('fake summarizer: scripted failure');
  /** Fixed answer; null = derive from the input. */
  answer: string | null = null;

  failNext(n = 1, error?: Error): void {
    this.failuresLeft = n;
    this.failure = error ?? new Error('fake summarizer: scripted failure');
  }

  async summarize(req: SummarizeRequest): Promise<string> {
    this.calls.push(req);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        req.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('summary aborted'));
          },
          { once: true },
        );
      });
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    if (this.answer !== null) return this.answer;
    const lines = req.input.split('\n');
    const node = lines[0] ?? '';
    const firstPrompt = lines.find((l) => /^1\. /.test(l))?.slice(3) ?? '';
    return `Summary of ${node}: ${firstPrompt}`;
  }
}

export function createFakeSummarizer(): FakeSummarizer {
  return new FakeSummarizer();
}
