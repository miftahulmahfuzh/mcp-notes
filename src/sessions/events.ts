import { EventEmitter } from 'node:events';

/** A session's stored context may have changed (an ingest write committed). Carries no values: listeners re-read. */
export interface SessionContextEvent {
  type: 'context';
  sessionId: string;
}

export type SessionEventListener = (event: SessionContextEvent) => void;

/**
 * In-process bus for session context changes. The ingest observer below is the only emitter;
 * each open GET /api/sessions/:nodeId/context/stream subscribes with `on`. The other laptop's
 * ingest never reaches this bus: its sessions are polled (phase 4).
 */
export class SessionEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open context stream; no artificial cap.
    this.emitter.setMaxListeners(0);
  }

  emitContext(sessionId: string): void {
    const event: SessionContextEvent = { type: 'context', sessionId };
    this.emitter.emit('context', event);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: SessionEventListener): () => void {
    this.emitter.on('context', listener);
    return () => {
      this.emitter.off('context', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('context');
  }
}

/** The part of an ingest batch (src/sessions/ingest.ts IngestBatch) the context observer reads. */
export interface ContextBatchLike {
  sessionId: string;
  fromOffset: number;
  /** Parsed records of the batch, copied fork records excluded (ingest drops them before this). */
  records: readonly Record<string, unknown>[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A main-chain (not sidechain) assistant record that carries a usage object. */
function isMainChainAssistantWithUsage(record: Record<string, unknown>): boolean {
  if (record.type !== 'assistant' || record.isSidechain === true) return false;
  const message = record.message;
  return isObject(message) && isObject(message.usage);
}

/**
 * True when a committed batch can have moved the session's stored context:
 * - it holds a main-chain assistant record with usage (the unit of change, phase 1 R1.2), or
 * - it was a read from byte 0 (a first read, a shrunk file, a fork re-read). Such a read replaces
 *   the stored context, and a fork's copied context (R1.4) arrives through records the batch does not list.
 * Sidechain records, user records and bookkeeping never move it.
 */
export function batchMovesContext(batch: ContextBatchLike): boolean {
  if (batch.fromOffset === 0) return true;
  return batch.records.some(isMainChainAssistantWithUsage);
}

/** Ingest observer: after a committed write that can have moved a session's context, tell the bus. Never throws. */
export function sessionContextObserver(events: SessionEvents): { onBatch(batch: ContextBatchLike): void } {
  return {
    onBatch(batch: ContextBatchLike): void {
      if (batchMovesContext(batch)) events.emitContext(batch.sessionId);
    },
  };
}
