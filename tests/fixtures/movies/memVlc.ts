import type { VlcCommand, VlcEndpoint, VlcReply, VlcState, VlcStatusReader } from '../../../src/movies/vlc/http.js';
import type { PlayerEnv, VlcLaunch, VlcLauncher } from '../../../src/movies/vlc/launch.js';

export interface MemInstance {
  password: string;
  state: VlcState;
  time: number;
  length: number;
  up: boolean;
}

export class MemVlc implements VlcLauncher, VlcStatusReader {
  readonly launches: VlcLaunch[] = [];
  readonly instances = new Map<number, MemInstance>();
  /** The length a pl_play loads. */
  length = 7200;
  /** False: launched instances never answer (HTTP interface not up). */
  httpUp = true;
  failLaunch = false;

  async launch(_env: PlayerEnv, l: VlcLaunch): Promise<void> {
    if (this.failLaunch) throw new Error('spawn vlc.exe ENOENT');
    this.launches.push(l);
    // Like the probe: stopped, length unknown, --start-time not honored.
    this.instances.set(l.port, { password: l.password, state: 'stopped', time: 0, length: 0, up: this.httpUp });
  }

  private reply(ep: VlcEndpoint): VlcReply {
    const i = this.instances.get(ep.port);
    if (i === undefined || !i.up) return { kind: 'gone' };
    if (i.password !== ep.password) return { kind: 'unauthorized' };
    return { kind: 'ok', status: { state: i.state, time: i.time, length: i.length } };
  }

  async status(_curl: string, ep: VlcEndpoint): Promise<VlcReply> {
    return this.reply(ep);
  }

  async command(_curl: string, ep: VlcEndpoint, cmd: VlcCommand): Promise<VlcReply> {
    const i = this.instances.get(ep.port);
    if (i !== undefined && i.up && i.password === ep.password) {
      if (cmd.command === 'pl_play') {
        i.state = 'playing';
        i.length = this.length;
      } else {
        i.time = cmd.val;
      }
    }
    return this.reply(ep);
  }

  /** The VLC on `port` exits (its window was closed). */
  exit(port: number): void {
    this.instances.delete(port);
  }

  /** Some other VLC (not ours) holds `port`. */
  occupy(port: number, password: string): void {
    this.instances.set(port, { password, state: 'playing', time: 10, length: 100, up: true });
  }

  at(port: number): MemInstance {
    const i = this.instances.get(port);
    if (i === undefined) throw new Error(`no VLC on ${port}`);
    return i;
  }
}
