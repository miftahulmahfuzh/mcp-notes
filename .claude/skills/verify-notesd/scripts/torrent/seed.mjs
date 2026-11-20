#!/usr/bin/env node
// seed.mjs: the loopback swarm of `verify.sh up --torrent` (torrent-stream-source phase 1). No DHT, no
// tracker, no local discovery, no UPnP: a peer reaches it only by its address, so nothing leaves 127.0.0.1.
//
//   seed --film DIR --pack DIR --state STATE [--upload-kbps N]
//       Seeds the two folders from one client on a free port. Once it listens, writes STATE/fixture.json and
//       STATE/pack.json ({info_hash, name, trackers: [], port, piece_length, files: [{index, path, length}]}),
//       then one line a second to STATE/seeder.jsonl ({at, torrents: [{info_hash, peers, uploaded}]}).
//       Every folder that appears in STATE/seed/<name>/ (move it in whole: copy to a dot-name, then rename) is
//       seeded from the same client and port, and STATE/seeded/<name>.json is written in the same shape: the
//       fixtures of later phases (phase 5's MKV, phase 6's subtitle torrents, phase 8's silent film).
//       Runs until SIGTERM.
//   leech --info-hash H --peer HOST:PORT --file INDEX --bytes N --out DIR [--timeout-s S]
//       Joins only HOST:PORT (no PEX either), reads the first N bytes of file INDEX and prints
//       {bytes, seconds, bytes_per_s, peers}: how fast that peer uploads to a stranger.
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import WebTorrent from 'webtorrent'

const QUIET = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
const PIECE = 32768

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!name.startsWith('--') || i + 1 >= argv.length) throw new Error(`unexpected argument ${name}`)
    out[name.slice(2)] = argv[i + 1]
  }
  return out
}

function need(opts, name) {
  const value = opts[name]
  if (value === undefined || value === '') throw new Error(`--${name} is required`)
  return value
}

function writeJson(file, value) {
  writeFileSync(`${file}.part`, `${JSON.stringify(value)}\n`)
  renameSync(`${file}.part`, file)
}

function describe(torrent, port) {
  return {
    info_hash: torrent.infoHash,
    name: torrent.name,
    trackers: [],
    port,
    piece_length: torrent.pieceLength,
    files: torrent.files.map((f, index) => ({ index, path: f.path, length: f.length })),
  }
}

async function seed(opts) {
  const state = path.resolve(need(opts, 'state'))
  mkdirSync(state, { recursive: true })
  const kbps = opts['upload-kbps'] === undefined ? 0 : Number(opts['upload-kbps'])
  // TCP only, like the daemon's engine.
  const client = new WebTorrent({ ...QUIET, uploadLimit: kbps > 0 ? Math.round(kbps * 1000) : -1 })
  client.on('error', (err) => {
    console.error(`seed: ${err.message}`)
    process.exit(1)
  })
  const add = (dir) => new Promise((resolve) => client.seed(path.resolve(dir), { announce: [], pieceLength: PIECE }, resolve))
  const film = await add(need(opts, 'film'))
  const pack = await add(need(opts, 'pack'))
  if (!client.listening) await new Promise((resolve) => client.once('listening', resolve))
  const port = client.address().port
  writeJson(path.join(state, 'fixture.json'), describe(film, port))
  writeJson(path.join(state, 'pack.json'), describe(pack, port))
  console.log(`seed: ${film.name} ${film.infoHash} and ${pack.name} ${pack.infoHash} on 127.0.0.1:${port}`)
  // Later phases' fixtures: every folder moved into STATE/seed/<name>/ is seeded too, then STATE/seeded/<name>.json.
  const seedDir = path.join(state, 'seed')
  const seededDir = path.join(state, 'seeded')
  mkdirSync(seedDir, { recursive: true })
  mkdirSync(seededDir, { recursive: true })
  const extra = new Map()
  const watch = async () => {
    for (const name of readdirSync(seedDir)) {
      if (name.startsWith('.') || extra.has(name) || !statSync(path.join(seedDir, name)).isDirectory()) continue
      extra.set(name, null)
      const torrent = await add(path.join(seedDir, name))
      extra.set(name, torrent)
      writeJson(path.join(seededDir, `${name}.json`), describe(torrent, port))
      console.log(`seed: ${name} ${torrent.infoHash}`)
    }
  }
  setInterval(() => void watch().catch((err) => console.error(`seed: ${err.message}`)), 500)
  setInterval(() => {
    const torrents = [film, pack, ...[...extra.values()].filter((t) => t !== null)].map((t) => ({ info_hash: t.infoHash, peers: t.numPeers, uploaded: t.uploaded }))
    appendFileSync(path.join(state, 'seeder.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), torrents })}\n`)
  }, 1000)
  process.on('SIGTERM', () => client.destroy(() => process.exit(0)))
}

async function leech(opts) {
  const bytes = Number(need(opts, 'bytes'))
  if (!Number.isInteger(bytes) || bytes < 2) throw new Error('--bytes must be an integer of at least 2')
  const index = Number(need(opts, 'file'))
  const timeoutS = Number(opts['timeout-s'] ?? 120)
  const client = new WebTorrent({ ...QUIET, utPex: false })
  client.on('error', (err) => {
    console.log(JSON.stringify({ error: err.message }))
    process.exit(1)
  })
  const timer = setTimeout(() => {
    console.log(JSON.stringify({ error: `timeout after ${timeoutS} s` }))
    process.exit(1)
  }, timeoutS * 1000)
  const torrent = client.add(need(opts, 'info-hash'), { path: path.resolve(need(opts, 'out')), deselect: true, announce: [] })
  const peer = need(opts, 'peer')
  torrent.once('infoHash', () => torrent.addPeer(peer))
  if (!torrent.ready) await new Promise((resolve) => torrent.once('ready', resolve))
  const file = torrent.files[index]
  if (file === undefined) throw new Error(`the torrent has no file ${index}`)
  const iterator = file[Symbol.asyncIterator]({ start: 0, end: bytes - 1 })
  const started = Date.now()
  let got = 0
  while (got < bytes) {
    const next = await iterator.next()
    if (next.done) break
    got += next.value.length
  }
  await iterator.return?.()
  const seconds = (Date.now() - started) / 1000
  const taken = Math.min(got, bytes)
  console.log(JSON.stringify({ bytes: taken, seconds, bytes_per_s: Math.round(taken / seconds), peers: torrent.wires.map((w) => `${w.remoteAddress}:${w.remotePort}`) }))
  clearTimeout(timer)
  client.destroy(() => process.exit(0))
}

const [mode, ...rest] = process.argv.slice(2)
try {
  const opts = parseArgs(rest)
  if (mode === 'seed') await seed(opts)
  else if (mode === 'leech') await leech(opts)
  else {
    console.error('usage: seed.mjs seed --film DIR --pack DIR --state STATE [--upload-kbps N]\n       seed.mjs leech --info-hash H --peer HOST:PORT --file INDEX --bytes N --out DIR [--timeout-s S]')
    process.exit(2)
  }
} catch (err) {
  console.error(`seed.mjs: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
