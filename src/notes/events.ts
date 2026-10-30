import { EventEmitter } from 'node:events';

export type NoteOp = 'created' | 'updated' | 'deleted' | 'restored';

export interface NoteEvent {
  type: 'note';
  op: NoteOp;
  id: string;
}

export type NoteEventListener = (event: NoteEvent) => void;

/**
 * In-process bus for note changes. The notes service is the only emitter; SSE (phase 6) and
 * anything else that wants to react to writes subscribe with `on`.
 */
export class NoteEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE connection; no artificial cap.
    this.emitter.setMaxListeners(0);
  }

  emit(op: NoteOp, id: string): void {
    const event: NoteEvent = { type: 'note', op, id };
    this.emitter.emit('note', event);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: NoteEventListener): () => void {
    this.emitter.on('note', listener);
    return () => {
      this.emitter.off('note', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('note');
  }
}
