import { refLabel, type ResolveAttempt, type ResolveOutcome, type StreamRef } from '../../types.js';
import type { SessionTorrent } from '../../sessions.js';
import { heightRank, pickFile, type TorrentCandidate } from '../find/index.js';
import { audioLanguages, describeProbe, type MediaProbe } from '../probe.js';
import { RemuxError } from '../remux.js';
import { hasEnglishSubtitleFile } from '../subtitles/files.js';
import type { TorrentHandle } from '../types.js';
import { HEIGHT_SETTLE_MS, MAX_TORRENT_TRIES, NO_FILE_LIST, PROBE_MIN_MS, TORRENT_OPEN_TIMEOUT_MS, TORRENT_RACE_WIDTH, TORRENT_SETTLE_MS, torrentLabel } from './constants.js';
import type { SourceContext } from './context.js';
import { chooseOrder, deliveryText, filmKbpsOf, remuxTimeoutOutcome, type Delivery } from './delivery.js';
import { probeWhileDelivering } from './probeWhileDelivering.js';
import { refusalOf, standIn } from './refusal.js';
import { foundIn, messageOf, pad, seconds, sleep } from './text.js';
import { trackersOf } from './trackers.js';
import type { FindQuery, NoteFailure, OpenedTorrent, Passed, PlayFacts, Raced, Racer, Tried, TorrentProgress, TorrentResolve } from './types.js';

/**
 * The race: up to TORRENT_RACE_WIDTH candidates opened side by side, each up to its header (race), the best of
 * those whose header arrived chosen by its swarm (chooseOrder), and the chosen one made the session's torrent
 * (finish). Every torrent that does not play lets go of itself. Used by every way a torrent plays: resolve, the
 * shuffle (next), a pasted magnet, a kept download by its info hash.
 */

/**
 * Opens up to TORRENT_RACE_WIDTH candidates side by side, in the finder's order, and plays the best of those whose
 * header arrives (chooseOrder), giving the others TORRENT_SETTLE_MS to arrive too. A torrent that fails makes room
 * for the next candidate, up to MAX_TORRENT_TRIES in all and until `deadline`. The ones not chosen leave their
 * swarms at once and stay first in line for the shuffle button. `attempts` are in the finder's order.
 */
export async function tryCandidates(
  ctx: SourceContext,
  ref: StreamRef,
  query: FindQuery,
  candidates: readonly TorrentCandidate[],
  play: PlayFacts,
  deadline: number,
  progress?: (progress: TorrentProgress) => void,
  note?: NoteFailure,
  /** Torrents of the same play that a later round tries (the dub-named ones): a racer with no header gives way to them too. */
  after = 0,
): Promise<TorrentResolve> {
  const { opts, now, log, hands } = ctx;
  const pool = candidates.slice(0, MAX_TORRENT_TRIES);
  const results = new Map<number, ResolveAttempt>();
  const passed: Passed[] = [];
  const running = new Map<number, { racer: Racer; done: Promise<void>; c: TorrentCandidate }>();
  let next = 0;
  const attemptsNow = (): ResolveAttempt[] => [...results.entries()].sort((a, b) => a[0] - b[0]).map(([, a]) => a);
  const report = (): void => {
    if (progress === undefined) return;
    const names = [...running.values()].map((r) => r.c.name);
    progress({ stage: names.length === 0 ? 'choosing a torrent' : `opening ${names.length} torrent${names.length === 1 ? '' : 's'}: ${names.join('; ')}`, attempts: attemptsNow() });
  };
  const launch = (): void => {
    while (running.size < TORRENT_RACE_WIDTH && next < pool.length && deadline - now() > 0) {
      const position = next++;
      const c = pool[position]!;
      // Torrents that wait for a slot: the ones of this round not opened yet, then a later round's, while the budget can still try one.
      const waiting = (): number => (deadline - now() < TORRENT_OPEN_TIMEOUT_MS + PROBE_MIN_MS ? 0 : pool.length - next + after);
      const racer = race(ctx, ref, query, c, position, play, deadline - now(), waiting);
      const done = racer.result.then((raced) => {
        if (!running.delete(position)) return;
        if (raced.ok) passed.push(raced.passed);
        else {
          results.set(position, raced.attempt);
          if (raced.attempt.outcome !== 'skipped') log(`[notesd] torrent: ${refLabel(ref)}: ${c.name} (${c.infoHash.slice(0, 8)}) lost: ${raced.attempt.outcome} after ${raced.attempt.took_s ?? 0} s, ${raced.attempt.detail}`);
          if (raced.attempt.outcome !== 'skipped') note?.(c, raced.lasting === true, `${raced.attempt.outcome}: ${raced.attempt.detail}`);
        }
        report();
      });
      running.set(position, { racer, done, c });
    }
    report();
  };
  for (;;) {
    if (passed.length === 0) launch();
    if (running.size === 0 && passed.length === 0) break;
    if (passed.length === 0) {
      await Promise.race([...running.values()].map((r) => r.done));
      if (passed.length === 0) continue;
      // One header is here: the others still opening get a moment to arrive too, then the swarms are compared. A racer
      // of a preferred height (1080p while a 720p arrived) gets longer: it plays when it arrives, and gives up by itself
      // when its swarm stalls.
      const bestHeight = Math.min(...passed.map((p) => heightRank(p.height)));
      const better = [...running.values()].filter((r) => heightRank(r.c.release.height) < bestHeight);
      const settleMs = Math.min(better.length > 0 ? (opts.heightSettleMs ?? HEIGHT_SETTLE_MS) : (opts.settleMs ?? TORRENT_SETTLE_MS), deadline - now());
      if (running.size > 0 && settleMs > 0) {
        if (better.length > 0) log(`[notesd] torrent: ${refLabel(ref)}: ${passed[0]!.c.name} arrived; waiting up to ${Math.round(settleMs / 1000)} s for ${better.map((r) => r.c.name).join('; ')} (preferred height)`);
        const timer = sleep(settleMs);
        await Promise.race([Promise.all((better.length > 0 ? better : [...running.values()]).map((r) => r.done)), timer.done]);
        timer.clear();
      }
    }
    const best = chooseOrder(passed, (p) => hands.deliveryOf(p))[0]!;
    passed.splice(passed.indexOf(best), 1);
    const delivery = hands.deliveryOf(best);
    const won = await finish(ctx, ref, query, best, play, delivery, Math.max(PROBE_MIN_MS, deadline - now()));
    results.set(best.position, won.attempt);
    if (!won.ok) {
      best.drop();
      note?.(best.c, false, `${won.attempt.outcome}: ${won.attempt.detail}`);
      continue;
    }
    const later: TorrentCandidate[] = [];
    for (const p of chooseOrder(passed, (x) => hands.deliveryOf(x))) {
      log(`[notesd] torrent: ${refLabel(ref)}: ${p.c.name} (${p.c.infoHash.slice(0, 8)}) lost: its header arrived too (${p.height ?? '?'}p${deliveryText(hands.deliveryOf(p))}); ${best.c.name} was chosen`);
      results.set(p.position, {
        provider: torrentLabel(p.c.name),
        outcome: 'skipped',
        took_s: p.tookS,
        detail: `its header arrived too (${p.c.seeds} seeds${deliveryText(hands.deliveryOf(p))}); ${best.c.name} was chosen`,
      });
      p.drop();
      later.push(p.c);
    }
    for (const [position, r] of [...running.entries()].sort((a, b) => a[0] - b[0])) {
      running.delete(position);
      log(`[notesd] torrent: ${refLabel(ref)}: ${r.c.name} (${r.c.infoHash.slice(0, 8)}) lost: still opening (${hands.receivedText(r.c.infoHash)}) when ${best.c.name} was chosen`);
      r.racer.cancel();
      results.set(position, { provider: torrentLabel(r.c.name), outcome: 'skipped', took_s: null, detail: `still opening when ${best.c.name} was chosen` });
      later.push(r.c);
    }
    // The same object, not a copy: the sync and a late subtitle chain write into it.
    won.torrent.candidates = [...later, ...candidates.slice(next)];
    return { ok: true, torrent: won.torrent, source: won.source, attempts: [...attemptsNow(), ...won.subtitleAttempts] };
  }
  return { ok: false, error: 'no_source', attempts: attemptsNow() };
}

/**
 * One candidate up to its header: the file list from the swarm, the film's file, its selection, and ffprobe reading
 * the header through the file route. A torrent that fails lets go of itself; one that passes stays selected (it
 * keeps downloading) until it is chosen or dropped.
 */
export function race(ctx: SourceContext, ref: StreamRef, query: FindQuery, c: TorrentCandidate, position: number, play: PlayFacts, budgetMs: number, waiting: () => number = () => 0): Racer {
  const { opts, now, hands, ears } = ctx;
  const started = now();
  // `held`: this racer's `use` counted it as a user of the torrent; only then is there a hold to give back.
  const state = { cancelled: false, opened: false, held: false, gone: false };
  const drop = (): void => {
    if (!state.opened || state.gone) return;
    state.gone = true;
    hands.dropNow(c.infoHash, state.held);
  };
  // The index that listed it ends the detail: a release of another film comes from some index's listing, and only the attempt says which.
  const attempt = (outcome: ResolveOutcome, detail: string): ResolveAttempt => ({ provider: torrentLabel(c.name), outcome, took_s: seconds(started, now()), detail: outcome === 'skipped' ? detail : `${detail}${foundIn(c)}` });
  const fail = (outcome: ResolveOutcome, detail: string, lasting = false): Raced => {
    drop();
    return { ok: false, attempt: attempt(outcome, detail), lasting };
  };
  const left = (): Raced => fail('skipped', 'another torrent was chosen');
  const run = async (): Promise<Raced> => {
    let opened: OpenedTorrent;
    try {
      opened = await opts.swarm.open({ infoHash: c.infoHash, trackers: trackersOf(opts, c), name: c.name, ref, release: c.release }, { timeoutMs: Math.min(TORRENT_OPEN_TIMEOUT_MS, budgetMs) });
    } catch (err) {
      // Released too: an open that gave up may still have left the torrent in the swarm.
      state.opened = true;
      return fail('no_stream', `${NO_FILE_LIST} (${messageOf(err)})`);
    }
    state.opened = true;
    if (state.cancelled) return left();
    try {
      const picked = pickFile(opened.files, query);
      if (picked === null) {
        return fail('no_stream', ref.kind === 'tv' ? `the torrent holds no file of S${pad(ref.season)}E${pad(ref.episode)}` : 'the torrent holds no video file', true);
      }
      // Set before the call: the swarm counts the user at once, and a cancel while the row is written must give it back.
      state.held = true;
      try {
        await opts.swarm.use(c.infoHash, [picked.video, ...picked.subtitles]);
      } catch (err) {
        state.held = false;
        throw err;
      }
      if (state.cancelled) return left();
      const probedFile = opened.files.find((f) => f.index === picked.video);
      ctx.log(
        `[notesd] torrent: ${refLabel(ref)}: ${c.name} (${c.infoHash.slice(0, 8)}): probing ${probedFile?.path ?? `file ${picked.video}`} (file ${picked.video} of ${opened.files.length}, ${((probedFile?.length ?? 0) / 1e6).toFixed(0)} MB${picked.subtitles.length > 0 ? `, ${picked.subtitles.length} subtitle file${picked.subtitles.length === 1 ? '' : 's'} beside it` : ''}), its first and last pieces first`,
      );
      opts.swarm.headFirst?.(c.infoHash, picked.video);
      const manifestUrl = opts.swarm.localUrl(c.infoHash, picked.video);
      const probed = await probeWhileDelivering(
        { opts, now, receivedText: (hash) => hands.receivedText(hash) },
        `${opts.localBase()}${manifestUrl}`,
        c.infoHash,
        budgetMs - (now() - started),
        () => state.cancelled,
        waiting,
      );
      if (state.cancelled) return left();
      if (!probed.ok) return fail(probed.outcome, probed.detail);
      const probe: MediaProbe = probed.probe;
      ears.noteTags(c.infoHash, c.name, audioLanguages(probe));
      if (state.cancelled) return left();
      const refusal = refusalOf(probe, play.audioLang, opts.remux ?? null);
      if (refusal !== null) return fail(refusal.outcome, refusal.detail, true);
      const videoName = opened.files.find((f) => f.index === picked.video)?.name ?? '';
      return {
        ok: true,
        passed: { position, c, opened, video: picked.video, subtitles: picked.subtitles, probe, height: c.release.height ?? null, english: hasEnglishSubtitleFile(opened.files, picked.subtitles, videoName), tookS: seconds(started, now()), drop },
      };
    } catch (err) {
      return fail('error', messageOf(err));
    }
  };
  return {
    cancel: () => {
      state.cancelled = true;
      drop();
    },
    result: run(),
  };
}

/** The chosen torrent becomes the session's: the address the page plays (a remux starts here), then its subtitles. */
export async function finish(ctx: SourceContext, ref: StreamRef, query: FindQuery, p: Passed, play: PlayFacts, delivery: Delivery | null, budgetMs: number): Promise<Tried> {
  const { opts, now, hands, pages, subtitles } = ctx;
  const { c, probe } = p;
  const audioLang = play.audioLang;
  try {
    let page: { manifestUrl: string; manifestKind: 'mp4' | 'hls' };
    const before = hands.receivedBytes(c.infoHash);
    const waitFrom = now();
    try {
      page = await pages.fileForPage(c.infoHash, p.video, probe, audioLang, budgetMs);
    } catch (err) {
      const after = hands.receivedBytes(c.infoHash);
      const got = before === null || after === null ? null : Math.max(0, after - before);
      const meanwhile = got === null ? '' : `; ${(got / 1e6).toFixed(1)} MB came in while it waited ${seconds(waitFrom, now())} s (${hands.receivedText(c.infoHash)})`;
      const filmKbps = filmKbpsOf(p.opened.files.find((f) => f.index === p.video)?.length ?? null, probe.durationS);
      const outcome = err instanceof RemuxError && err.code === 'remux_timeout' ? remuxTimeoutOutcome(got, filmKbps) : 'unplayable';
      const detail =
        outcome === 'no_stream'
          ? `${describeProbe(probe)}: the swarm sent too little for the remux's first segment (${messageOf(err)}${meanwhile})`
          : `${describeProbe(probe)}: the remux did not start (${messageOf(err)}${meanwhile})`;
      return { ok: false, attempt: { provider: torrentLabel(c.name), outcome, took_s: p.tookS, detail } };
    }
    hands.noteDuration(c.infoHash, probe, p.video);
    const stop = new AbortController();
    const torrent: SessionTorrent = {
      infoHash: c.infoHash,
      fileIndex: p.video,
      selected: [p.video, ...p.subtitles],
      name: c.name,
      index: c.index,
      seeds: c.seeds,
      state: 'downloading',
      height: probe.video?.height ?? c.release.height ?? null,
      manifestUrl: page.manifestUrl,
      manifestKind: page.manifestKind,
      subtitles: [],
      subtitleRev: 0,
      candidates: [],
      durationS: probe.durationS,
      filmKbps: filmKbpsOf(p.opened.files.find((f) => f.index === p.video)?.length ?? null, probe.durationS),
      candidate: c,
      held: true,
      imdbId: play.imdbId,
      query,
      stop,
    };
    const subtitleAttempts = await subtitles.start(
      torrent,
      {
        ref,
        imdbId: play.imdbId,
        infoHash: c.infoHash,
        release: c.name,
        files: p.opened.files,
        fileIndex: p.video,
        subtitleIndexes: p.subtitles,
        handle: p.opened.read === undefined ? null : (p.opened as Pick<TorrentHandle, 'read'>),
        probe,
        audioLang,
        resumeS: play.resumeS,
        cloudTried: play.cloudTried,
        localBase: opts.localBase(),
        signal: stop.signal,
      },
      { ref, imdbId: play.imdbId, infoHash: c.infoHash, fileIndex: p.video, durationS: probe.durationS },
    );
    torrent.state = await pages.state(torrent);
    const detail = `${describeProbe(probe)}${page.manifestKind === 'hls' ? ', remuxed' : ''}, ${c.seeds} seeds${deliveryText(delivery)}`;
    return { ok: true, torrent, source: standIn(torrent, probe, audioLang, p.tookS), attempt: { provider: torrentLabel(c.name), outcome: 'resolved', took_s: p.tookS, detail }, subtitleAttempts };
  } catch (err) {
    return { ok: false, attempt: { provider: torrentLabel(c.name), outcome: 'error', took_s: p.tookS, detail: messageOf(err) } };
  }
}
