import { useEffect, useSyncExternalStore } from 'react';
import { fetchCapabilities, type Capabilities } from '../api';

/** What the page assumes until notesd answers, and keeps if it never does. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({ reveal: false });

let current: Capabilities = NO_CAPABILITIES;
let started = false;
const listeners = new Set<() => void>();

function publish(next: Capabilities): void {
  if (next.reveal === current.reveal) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): Capabilities {
  return current;
}

/** Starts the single `GET /api/capabilities` of this page; later calls are no-ops. Errors leave `{ reveal: false }`. */
export function loadCapabilities(): void {
  if (started) return;
  started = true;
  fetchCapabilities().then(publish, () => {
    // Quiet by design: no capabilities endpoint (older daemon, offline) simply means no reveal icon.
  });
}

/** The daemon's capabilities, fetched once per page. `{ reveal: false }` until known and on any error. */
export function useCapabilities(): Capabilities {
  useEffect(() => {
    loadCapabilities();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Tests only. With no argument: forget the fetch so the next mount fetches again, value back to false.
 * With a value: prime the store with it and mark the fetch as done, so nothing is fetched.
 */
export function resetCapabilitiesForTests(next?: Capabilities): void {
  started = next !== undefined;
  current = next ? { reveal: next.reveal } : NO_CAPABILITIES;
  for (const l of listeners) l();
}
