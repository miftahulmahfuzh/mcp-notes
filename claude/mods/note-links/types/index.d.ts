/** The wall note-links found from `claude mcp get notes` this session; '' while unknown. */
export type NoteLinksWall = string

declare module 'claude-code' {
  interface PluginState {
    'note-links': { wall: NoteLinksWall }
  }
}
