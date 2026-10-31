import { EventEmitter } from 'node:events';

export type ChatOp = 'created' | 'updated' | 'deleted' | 'restored';

/** One chat row change. `GET /api/events` writes it as `event: chat {op, thread_id, id}`. */
export interface ChatChange {
  type: 'chat';
  op: ChatOp;
  thread_id: string;
  /** The message id. */
  id: string;
}

export type ChatChangeListener = (change: ChatChange) => void;

/** In-process bus for chat writes. ChatService is the only emitter, always after commit. */
export class ChatEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(op: ChatOp, threadId: string, id: string): void {
    const change: ChatChange = { type: 'chat', op, thread_id: threadId, id };
    this.emitter.emit('chat', change);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: ChatChangeListener): () => void {
    this.emitter.on('chat', listener);
    return () => {
      this.emitter.off('chat', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('chat');
  }
}
