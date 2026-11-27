# Token-Maxxing Session — 2026-11-27: Guides vs Code Audit

## 🎯 Achievement / End Result
- **Goal of the burn:** Audit every guide under `docs/guide` (except `streaming.md`) and the root README against the code, claim by claim; fix drifted docs; list doc-right/code-wrong cases without touching code; make the verify-notesd feature map name a proof for every user-facing feature.
- **Concrete changes:** 12 guides plus `README.md`, `docs/guide/README.md` and `docs/ROADMAP` fixed (about 60 doc fixes); `docs/plans/2026-11-27-guide-audit-findings.md` written; feature map extended (new `claude-code.md`, `connectors.md`, `database.md`; an index row for the unindexed `streaming.md`; entries added in wall, recycle-bin, search, chat, images-files, projects, adversary, dword, movies; stale entries corrected).
- **Real value delivered:**
  - The docs every future agent session reads first now match the code: one database per machine instead of a shared Neon; eight `movies_*` tools; five dword write statements and tools; the install's missing local-database step; missing chat captions and allowed tools; missing background jobs and pages; search's deleted filter; fork detection by record uuid; and more.
  - Four real code bugs and seven stale strings are recorded with file:line, ready to fix; four owner decisions are listed.
  - Every user-facing feature now has a named proof, and the new journeys were driven on a verify-notesd throwaway daemon.
- **Branch:** token-maxxing-2026-11-27-guides-vs-code-audit
- **Merge status:** merged (commit 2889041, landed by coordinator orch-stream-play-log)
- **Approx token burn:** very high (12 Opus auditors, relaunched and resumed after two usage-limit interruptions) 🔥

## Context & Motivation
The idea was assigned by the coordinator (orch-stream-play-log), with no menu. Docs are what every future agent session reads first, and nothing checks prose claims the way `docs:check` checks references, so drift accumulates silently.

## What We Did (blow-by-blow)
- One Opus auditor subagent per guide, with a shared brief: movies split in two, 12 in all (movies, sessions, wall, chat, claude-code, architecture, connectors, adversary, search, install, guide README, root README).
- The lead checked every reported code finding and a sample of the doc fixes against the source, then wrote the feature-map entries and the findings file.
- The run was interrupted twice by usage limits (Fable quota, then the 5-hour limit). The auditors were relaunched on Opus 5.5, then resumed with their context. A green WIP checkpoint commit (f8aac58) was made in between.
- New feature-map journeys driven on a throwaway daemon: /mcp 405/403, capture header 403, bin same-origin 403, static fallback, capabilities, deleted-only search, similar_images off, SQL guard, files dedupe, inbox, photo remove/restore/purge, hook spawn+claim, ids/known, NOTESD_HOST refusal. Two entries were corrected from that run (capabilities reveal is true on WSL; inbox logs "(already stored)").

## Code / Design Details
Code findings (doc right, code wrong), all in `docs/plans/2026-11-27-guide-audit-findings.md`, code untouched:
- A /adversary URL with a twin's or lower-case id never loads (`AdversaryPage.tsx:76`).
- /redo counts against the daily reviewer cap (`service.ts:319-335` + `reviewsRepo.ts` DEEP).
- The note-level Show in Explorer icon can show and do nothing (`files.ts:171` vs `reveal.ts:277`).
- `install.sh` does not check `notes-link.mjs` (`install.sh:157-160`).
- Seven stale strings: `dword_vocab_lookup` description, `status.ts` comments, `replyEmbeddings` comment, `scripts/movies/doc-check.sh`, the `configuration.md` DWORD_USER_EMAIL row, `verify.sh` not pinning NOTESD_SEER_DISPATCH.
- Four owner decisions: `install.sh` ignores NOTESD_PORT; Review now never retries a twice-failed pick (rereview unreachable); the 50/day vocab cap blocks origin-only attach; SVG/BMP drop is logged only.

## Decisions & Trade-offs
- Doc/code conflicts where the doc was right were not fixed in code in this session; they went to the findings file so the audit stays doc-only and reviewable.
- Opus auditors per guide, accepting the burn, because claim-by-claim checking needs full context of each subsystem.
- The lead verified every code finding itself rather than trusting auditors, since a false bug report costs more than a missed one.

## Follow-ups & YAGNI notes
- Fix the four code findings and seven stale strings in the findings file.
- Owner to decide the four open questions.
- `streaming.md` was deliberately out of scope.

## Appendix
- Proof: `npm run typecheck` pass; `npm test` 415 files / 4744 tests pass; `npm run test:int` 108 files / 1083 tests pass; `npm run docs:check` current.
- Commits: f8aac58 (WIP checkpoint), 9608ba4 (the audit).
