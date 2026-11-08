export interface GraphDbSnapshot<R> {
  fingerprint: string;
  at: number;
  rows: R[];
  more: boolean;
  total: number;
}

/** Max age of a cached snapshot even when the fingerprint is unchanged (cross-repo parent/child_count moves no row of this repo). */
export const GRAPH_CACHE_MAX_AGE_MS = 5 * 60_000;
export const GRAPH_CACHE_MAX_ENTRIES = 16;

export class GraphCache<R> {
  private readonly map = new Map<string, GraphDbSnapshot<R>>();
  get(key: string, fingerprint: string, now: number): GraphDbSnapshot<R> | null {
    const hit = this.map.get(key);
    if (!hit || hit.fingerprint !== fingerprint || now - hit.at > GRAPH_CACHE_MAX_AGE_MS) return null;
    this.map.delete(key);
    this.map.set(key, hit); // LRU touch
    return hit;
  }
  set(key: string, snap: GraphDbSnapshot<R>): void {
    this.map.delete(key);
    this.map.set(key, snap);
    while (this.map.size > GRAPH_CACHE_MAX_ENTRIES) this.map.delete(this.map.keys().next().value as string);
  }
  clear(): void {
    this.map.clear();
  }
}
