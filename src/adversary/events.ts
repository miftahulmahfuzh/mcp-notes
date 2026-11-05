import { EventEmitter } from 'node:events';

export type AdversaryOp = 'verdict' | 'mark' | 'toggle' | 'run';

/** One reviewer change (contract C4). Phase 5 writes it on GET /api/events as `event: adversary`. */
export interface AdversaryChange {
  type: 'adversary';
  op: AdversaryOp;
  strategy_id?: string;
  session_date?: string;
}

export type AdversaryChangeListener = (change: AdversaryChange) => void;

/** In-process bus for reviewer writes. AdversaryService is the only emitter, always after the write committed. */
export class AdversaryEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(change: { op: AdversaryOp; strategy_id?: string; session_date?: string }): void {
    const event: AdversaryChange = { type: 'adversary', ...change };
    this.emitter.emit('adversary', event);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: AdversaryChangeListener): () => void {
    this.emitter.on('adversary', listener);
    return () => {
      this.emitter.off('adversary', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('adversary');
  }
}
