#!/usr/bin/env node
// The /lk21 skill's command. The work is in claude/streaming (cli.mjs and sites/lk21.mjs).
// Usage: search.mjs [--play] <title> [year] | search.mjs --play-url <url>
import { main } from '../../streaming/cli.mjs';

process.exitCode = await main('lk21', process.argv.slice(2));
