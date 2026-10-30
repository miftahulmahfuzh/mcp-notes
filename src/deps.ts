import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { NoteEvents } from './notes/events.js';
import type { NotesService } from './notes/service.js';

/** Everything the daemon wires together once at startup and hands to routes and background jobs. */
export interface AppDeps {
  config: Config;
  db: Db;
  events: NoteEvents;
  service: NotesService;
}
