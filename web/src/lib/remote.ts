import type { Note } from '../types';

/** A note's images and files whose originals live on another machine, and which machines hold them. */
export interface RemoteFiles {
  count: number;
  /** Host names in first-seen order; null hosts are left out. */
  hosts: string[];
}

export function remoteFilesOf(note: Note): RemoteFiles {
  let count = 0;
  const hosts: string[] = [];
  for (const f of [...note.images, ...(note.files ?? [])]) {
    if (f.available) continue;
    count++;
    if (f.host && !hosts.includes(f.host)) hosts.push(f.host);
  }
  return { count, hosts };
}

/** "GPD", "GPD and K-NES", or "another device" when no host is known. */
export function hostsLabel(hosts: string[]): string {
  if (hosts.length === 0) return 'another device';
  if (hosts.length === 1) return hosts[0];
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`;
}

/** The delete confirmation's question, or null when every file is on this machine. */
export function remoteDeleteQuestion(note: Note): string | null {
  const { count, hosts } = remoteFilesOf(note);
  if (count === 0) return null;
  return `${note.id} has ${count === 1 ? '1 file' : `${count} files`} on ${hostsLabel(hosts)}. Delete it anyway?`;
}
