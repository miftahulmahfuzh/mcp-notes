#!/usr/bin/env node
// The /flicksy skill's command. The work is in claude/streaming (cli.mjs and sites/flicksy.mjs).
// Usage: search.mjs [--play] <title> [year] | search.mjs --play-url <url>
import { main } from '../../streaming/cli.mjs';

process.exitCode = await main('flicksy', process.argv.slice(2));
