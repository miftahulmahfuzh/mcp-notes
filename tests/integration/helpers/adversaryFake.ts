import { AdversaryEvents, type AdversaryChange } from '../../../src/adversary/events.js';
import type { AdversaryService, AdversaryStatus, ReviewNowOptions, RunSummary } from '../../../src/adversary/service.js';
import type { ToggleState } from '../../../src/adversary/toggle.js';

/**
 * A stand-in for phase 4's AdversaryService with the real event bus: the API and SSE tests drive
 * the routes, never the reviewer. Records what the routes asked of it.
 */
export interface FakeAdversary {
  service: AdversaryService;
  events: AdversaryEvents;
  toggles: { on: boolean; host: string }[];
  reviews: (ReviewNowOptions | undefined)[];
  emit(change: Omit<AdversaryChange, 'type'>): void;
}

export function fakeAdversary(): FakeAdversary {
  const events = new AdversaryEvents();
  const toggles: { on: boolean; host: string }[] = [];
  const reviews: (ReviewNowOptions | undefined)[] = [];
  let toggle: ToggleState = { on: true, changed_at: null, host: null };
  const summary: RunSummary = {
    trigger: 'manual', host: 'test-host', started_at: '2026-11-05T02:00:00.000Z', finished_at: '2026-11-05T02:00:01.000Z',
    reviewed: 0, reused: 0, drafted: 0, failed: 0, late: 0, skipped_budget: 0, marks: 0, leases_lost: 0, error: null,
  };
  const status = (): AdversaryStatus => ({
    host: 'test-host', auto: toggle, running: null, schema: 'ready', daily_cap: 15, used_today: 0,
    next_poll_at: null, last_run: null, models: { gather: 'sonnet', verdict: 'opus' },
  });
  const service = {
    events,
    host: 'test-host',
    async getToggle(): Promise<ToggleState> {
      return toggle;
    },
    async setToggle(on: boolean, host: string): Promise<ToggleState> {
      toggle = { on, changed_at: '2026-11-05T02:00:00.000Z', host };
      toggles.push({ on, host });
      events.emit({ op: 'toggle' });
      return toggle;
    },
    async status(): Promise<AdversaryStatus> {
      return status();
    },
    async reviewNow(options?: ReviewNowOptions): Promise<RunSummary> {
      reviews.push(options);
      return summary;
    },
  };
  return {
    service: service as unknown as AdversaryService,
    events,
    toggles,
    reviews,
    emit: (change) => events.emit(change),
  };
}
