#!/usr/bin/env node
// The /idlix skill's command. The work is in claude/streaming (cli.mjs and sites/idlix.mjs).
// Usage: search.mjs [--play] <title> [year] | search.mjs --play-url <url>
import { main } from '../../streaming/cli.mjs';

process.exitCode = await main('idlix', process.argv.slice(2));
