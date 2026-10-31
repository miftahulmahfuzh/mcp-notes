/**
 * One EventSource on /api/events for the whole page (phase 9). The wall store (`note` events) and
 * the history page (`chat` events) subscribe here instead of each opening a connection. The source
 * opens on the first subscriber and closes when the last one leaves; a test that stubs
 * `EventSource` and unmounts gets a fresh source next time. Without `EventSource` (jsdom) it is a no-op.
 *
 * Handlers get the raw Event; a `MessageEvent` carries `data`. Fakes in tests may call with nothing.
 */
export const EVENTS_URL = '/api/events';

type Listener = (e: Event | undefined) => void;

let source: EventSource | null = null;
const listeners = new Map<string, Set<Listener>>();
const bound = new Set<string>();

function subscriberCount(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}

export function subscribeEvents(type: string, fn: (e: Event | undefined) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  if (source === null) source = new EventSource(EVENTS_URL);
  // A fresh wrapper per subscription: the same function subscribed twice counts twice.
  const entry: Listener = (e) => fn(e);
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(entry);
  if (!bound.has(type)) {
    bound.add(type);
    source.addEventListener(type, (e?: Event) => {
      for (const l of Array.from(listeners.get(type) ?? [])) l(e);
    });
  }
  let off = false;
  return () => {
    if (off) return;
    off = true;
    listeners.get(type)?.delete(entry);
    if (subscriberCount() === 0) {
      source?.close();
      source = null;
      listeners.clear();
      bound.clear();
    }
  };
}
