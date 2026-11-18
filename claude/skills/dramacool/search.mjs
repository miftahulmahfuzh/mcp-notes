#!/usr/bin/env node
// The /dramacool skill's command. The work is in claude/streaming (cli.mjs and sites/dramacool.mjs).
// Usage: search.mjs [--play] <title> [year] [--episode <n> [--season <n>]] | search.mjs --play-url <url>
import { main } from '../../streaming/cli.mjs';

process.exitCode = await main('dramacool', process.argv.slice(2));
