# Torrent ranking: evidence for the 2026-12-04 decision

**Decided 2026-11-27: option 2 with a 1.5x margin.** Among racers that do not deliver, a delivery ratio at least 1.5
times the other's wins before the English subtitle file (`RATIO_MARGIN`, `chooseOrder` in
`src/directStream/torrent/source/delivery.ts`); within 1.5x the old order decides. Row 39 now picks NOMA (4.1x);
row 11 stays ArtymKo (YTS is 1.2x). `chosenText` names the deciding step in every "was chosen" line.

Status before the decision: evidence only. Nothing here changes code. The owner put every torrent ranking change off to a decision on
2026-12-04; this file collects what the unbounded torrent soak of 2026-11-27 showed about one rule, so that
decision has the rows in front of it.

Sources: the soak's running note (mcp-notes note 2-IFP, rows 5 and 19), `stream_play_log` rows 11 and 39 on the
local Postgres (read-only), and the live daemon's log lines for those asks.

## The rule in question

`chooseOrder` (`src/directStream/torrent/source/delivery.ts`) orders the racers whose headers arrived:

1. one whose swarm `delivers()` before one that does not (a rate at or above the film's bitrate, or at least
   `HEALTHY_PEERS` (6) peers for a film of 8 Mbps or less);
2. the preferred height (1080p, then 720p, 2160p, 480p);
3. one whose files hold an English subtitle file;
4. more peers connected;
5. the finder's order.

When **no** racer delivers, step 1 ties, the heights usually tie at 1080p, and step 3 (English subtitle file) decides
before the rate is looked at. The rate a swarm reaches relative to the film's bitrate is never compared.

## Row 39: Miracle in Cell No. 7 (2019, Turkish, TMDB movie 637920)

Asked 2026-11-27 06:51:32 UTC. Two headers arrived; neither racer `delivers()`:

| Release | Peers | Rate | Film bitrate | Rate / bitrate | English subtitle file (inferred) |
| --- | --- | --- | --- | --- | --- |
| `Miracle.in.Cell.No.7.2019.1080p.WEB.h264-NOMA` | 3 | 2.9 Mbps | 3.1 Mbps | 94 % | no |
| `Чудо в камере №7 / ... [2019 WEB-DL 1080p] Dub (Okko) + 2x MVO + Kaz MVO + Sub (Rus Eng Tur) + Original Tur` | 1 | 1.5 Mbps | 6.6 Mbps | 23 % | yes |

The subtitle column is inferred: had NOMA held an English file too, step 4 (3 peers against 1) would have chosen it.
The Russian multi-audio release was chosen (log: `NOMA ... lost: its header arrived too (1080p listed; 3 peers
connected, 2.9 Mbps for a 3.1 Mbps film); Чудо в камере №7 ... was chosen`). The Turkish track was found and played
(original language kept), so the choice was not wrong on language.

What the play did (`stream_play_log` row 39): first frame 169 ms, then **9 stalls, 97.5 s stalled in 168.9 s
played**, and one automatic switch, `the torrent kept stalling`, to the NOMA torrent the ranking had passed over.

## Row 11: Confessions (Kokuhaku, 2010, Japanese, TMDB movie 54186)

Asked 2026-11-27 06:04:17 UTC. Three headers arrived; none `delivers()`:

| Release | Peers | Rate | Film bitrate | Rate / bitrate |
| --- | --- | --- | --- | --- |
| `Confessions.Kokuhaku.2010.BDRip.1080p.H265.ArtymKo` (chosen) | 4 | 1.9 Mbps | 6.0 Mbps | 32 % |
| `Confessions (2010) [1080p] [BluRay] [5.1] [YTS] [YIFY]` | 5 | 1.0 Mbps | 2.6 Mbps | 38 % |
| `Confessions [Kokuhaku] (2010) 1080p BluRay x264 DTS-SARTRE` | 2 | 0.5 Mbps | 4.7 Mbps | 11 % |

All three are 1080p. YTS had more peers, so with step 3 tied YTS would have won step 4; ArtymKo winning means step 3
(an English subtitle file among its files) decided. The log names only the outcome, not the step: that reading is
inferred from the order, not logged.

What the play did (`stream_play_log` row 11): first frame 333 ms, **3 stalls, 258.7 s stalled for 50.0 s played**,
no switch, closed by the owner's soak moving on. The note's first minute had no stall; the stalling came after.

## What the two rows suggest, and what they do not

- In both, every racer fell short of its bitrate, and the one chosen reached a smaller share of its bitrate (23 %,
  32 %) than one passed over (94 %, 38 %). Both chosen plays stalled for long stretches; row 39's daemon switched
  by itself to the very torrent the ranking had passed over.
- The soak's suggestion: among racers that do not deliver, compare the delivery ratio (rate / film bitrate) before
  the English subtitle file. In row 39 that picks NOMA (94 %), in row 11 YTS (38 %).
- Against it: an English subtitle file is the R3.2 preference, and a torrent without one leans on Wyzie or the
  whisper tier for its subtitle (row 39's NOMA has none). The ratio is measured over the few seconds before the
  header, from 1 to 5 peers, so it is noisy. A rule might need a margin (for example, the ratio wins only when it
  is at least twice the other's) rather than a plain swap. Two rows are not many.
- Not in question: step 1 (`delivers()` first) and the height step. Neither row argues against them.

## Decision to make on 2026-12-04

1. Leave `chooseOrder` as it is, or
2. compare the delivery ratio before the English subtitle file when no racer delivers, with or without a margin.

Whichever is chosen, `deliveryText` could also name the step that decided (`chosen for its English subtitle
file`), so the next soak's log says it instead of leaving it to be inferred, as row 11's had to be.
