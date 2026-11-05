import { describe, expect, it } from 'vitest';
import { AdversaryEvents, type AdversaryChange } from '../../../src/adversary/events.js';
import { ADVERSARY_TOGGLE_KEY, TOGGLE_DEFAULT, parseToggle, readToggle, writeToggle, type SettingsStore } from '../../../src/adversary/toggle.js';

function memoryStore(): SettingsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async getSetting(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async putSetting(key, value) {
      values.set(key, value);
    },
  };
}

describe('the adversary.auto toggle', () => {
  it('reads absent or malformed values as on', () => {
    expect(parseToggle(null)).toEqual(TOGGLE_DEFAULT);
    expect(parseToggle({ on: 'no' })).toEqual(TOGGLE_DEFAULT);
    expect(parseToggle({ on: false })).toEqual({ on: false, changed_at: null, host: null });
  });

  it('writes {on, changed_at, host} under adversary.auto and reads it back', async () => {
    const store = memoryStore();
    expect(await readToggle(store)).toEqual(TOGGLE_DEFAULT);
    const state = await writeToggle(store, false, 'gpd', new Date('2026-11-05T01:02:03Z'));
    expect(state).toEqual({ on: false, changed_at: '2026-11-05T01:02:03.000Z', host: 'gpd' });
    expect(store.values.get(ADVERSARY_TOGGLE_KEY)).toEqual(state);
    expect(await readToggle(store)).toEqual(state);
    await expect(writeToggle(store, true, ' ', new Date())).rejects.toThrow(TypeError);
  });
});

describe('AdversaryEvents', () => {
  it('delivers {type: adversary, op, ...} until unsubscribed', () => {
    const events = new AdversaryEvents();
    const seen: AdversaryChange[] = [];
    const off = events.on((c) => seen.push(c));
    events.emit({ op: 'verdict', strategy_id: 'A-GT', session_date: '2031-01-14' });
    off();
    events.emit({ op: 'run' });
    expect(seen).toEqual([{ type: 'adversary', op: 'verdict', strategy_id: 'A-GT', session_date: '2031-01-14' }]);
    expect(events.listenerCount()).toBe(0);
  });
});
