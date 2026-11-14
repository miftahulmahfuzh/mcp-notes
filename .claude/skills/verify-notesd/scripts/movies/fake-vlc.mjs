// fake-vlc.mjs: a stand-in for the Windows vlc.exe + curl.exe pair, for `verify.sh up --movies`.
//   node fake-vlc.mjs vlc     --state DIR -- <vlc args>    NOTESD_VLC_BIN: records the launch, then "plays"
//   node fake-vlc.mjs curl    --state DIR -- <curl args>   NOTESD_CURL_EXE: answers /requests/status.json
//   node fake-vlc.mjs control --state DIR args|status|commands|at SECONDS|quit
// Playback: time = base + seconds since base was set, capped at LENGTH (the fixture videos are 960 s).
// DIR/<port>.json is the live launch on that port; DIR/launches.jsonl and DIR/commands.jsonl are the record.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LENGTH = Number(process.env.FAKE_VLC_LENGTH ?? 960)
const MAX_LIFETIME_MS = 30 * 60 * 1000
const DEFAULT_PORT = 8080

const [mode, ...rest] = process.argv.slice(2)
const stateAt = rest.indexOf('--state')
if (!mode || stateAt < 0 || !rest[stateAt + 1]) {
  console.error('usage: fake-vlc.mjs vlc|curl|control --state DIR [-- args]')
  process.exit(2)
}
const stateDir = rest[stateAt + 1]
const sep = rest.indexOf('--')
const args = sep >= 0 ? rest.slice(sep + 1) : rest.slice(stateAt + 2)
mkdirSync(stateDir, { recursive: true })

const LAUNCHES = path.join(stateDir, 'launches.jsonl')
const COMMANDS = path.join(stateDir, 'commands.jsonl')
const statePath = (port) => path.join(stateDir, `${port}.json`)
const pidPath = (port) => path.join(stateDir, `${port}.pid`)
const quitPath = (port) => path.join(stateDir, `${port}.quit`)
const now = () => Date.now()

function readState(port) {
  try {
    return JSON.parse(readFileSync(statePath(port), 'utf8'))
  } catch {
    return null
  }
}
function writeState(s) {
  const tmp = `${statePath(s.port)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s))
  renameSync(tmp, statePath(s.port))
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const currentTime = (s) => (s.state === 'playing' ? Math.min(s.length, s.base + (now() - s.baseAt) / 1000) : s.base)

function statusJson(s) {
  const time = s.state === 'stopped' ? 0 : currentTime(s)
  const filename = s.file ? s.file.split(/[\\/]/).pop() : null
  return {
    apiversion: 3,
    version: '3.0.21 Vetinari (verify fake)',
    state: s.state,
    time: Math.floor(time),
    length: s.state === 'stopped' ? 0 : s.length,
    position: s.length ? time / s.length : 0,
    fullscreen: false,
    volume: 256,
    rate: 1,
    loop: false,
    repeat: false,
    random: false,
    information: { chapter: 0, title: 0, category: { meta: { filename } } },
  }
}

function runVlc() {
  const opt = (name) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}`) return args[i + 1] ?? null
      if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3)
    }
    return null
  }
  const port = Number(opt('http-port') ?? DEFAULT_PORT)
  const password = opt('http-password') ?? ''
  const start = Number(opt('start-time') ?? 0) || 0
  const file = args.filter((a) => !a.startsWith('-') && /[\\/]/.test(a)).at(-1) ?? null
  appendFileSync(LAUNCHES, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, port, start_time: start, file, argv: args })}\n`)
  rmSync(quitPath(port), { force: true })
  writeState({ pid: process.pid, port, password, file, length: LENGTH, state: 'playing', base: start, baseAt: now() })
  writeFileSync(pidPath(port), String(process.pid))
  const born = now()
  const leave = () => {
    const s = readState(port)
    if (s && s.pid === process.pid) {
      rmSync(statePath(port), { force: true })
      rmSync(pidPath(port), { force: true })
    }
    rmSync(quitPath(port), { force: true })
    process.exit(0)
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, leave)
  setInterval(() => {
    const s = readState(port)
    if (!s || s.pid !== process.pid) process.exit(0) // a newer launch took this port
    if (existsSync(quitPath(port)) || now() - born > MAX_LIFETIME_MS) leave()
  }, 200)
}

function applyCommand(s, params) {
  const command = params.get('command')
  if (!command) return
  const val = params.get('val')
  appendFileSync(COMMANDS, `${JSON.stringify({ at: new Date().toISOString(), port: s.port, command, val })}\n`)
  const t = currentTime(s)
  if (command === 'seek' && val != null) {
    const m = String(val).trim().match(/^([+-]?)(\d+(?:\.\d+)?)(%?)$/)
    if (!m) return
    const amount = m[3] ? (s.length * Number(m[2])) / 100 : Number(m[2])
    const target = m[1] === '+' ? t + amount : m[1] === '-' ? t - amount : amount
    s.base = Math.max(0, Math.min(s.length, target))
  } else if (command === 'pl_pause') {
    s.base = t
    s.state = s.state === 'playing' ? 'paused' : 'playing'
  } else if (command === 'pl_forcepause') {
    s.base = t
    s.state = 'paused'
  } else if (command === 'pl_play' || command === 'pl_forceresume') {
    s.base = t
    s.state = 'playing'
  } else if (command === 'pl_stop') {
    s.base = 0
    s.state = 'stopped'
  } else {
    return
  }
  s.baseAt = now()
  writeState(s)
}

function runCurl() {
  const valueFlags = new Set(['-u', '--user', '-m', '--max-time', '--connect-timeout', '-o', '--output', '-w', '--write-out',
    '-H', '--header', '-X', '--request', '-d', '--data', '--data-urlencode', '--retry', '-A', '--user-agent'])
  const shortValue = new Set(['u', 'm', 'o', 'w', 'H', 'X', 'd', 'A'])
  let url = null
  let user = null
  let fail = false
  let outFile = null
  let writeOut = null
  let get = false
  const data = []
  const take = (flag, v) => {
    if (flag === '-u' || flag === '--user') user = v
    else if (flag === '-o' || flag === '--output') outFile = v
    else if (flag === '-w' || flag === '--write-out') writeOut = v
    else if (flag === '-d' || flag === '--data' || flag === '--data-urlencode') data.push(v)
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^https?:\/\//i.test(a)) url = a
    else if (valueFlags.has(a)) take(a, args[++i])
    else if (a === '-f' || a === '--fail' || a === '--fail-with-body') fail = true
    else if (a === '-G' || a === '--get') get = true
    else if (/^-[A-Za-z]{2,}$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]
        if (c === 'f') fail = true
        else if (c === 'G') get = true
        else if (shortValue.has(c)) {
          take(`-${c}`, j === a.length - 1 ? args[++i] : a.slice(j + 1))
          break
        }
      }
    } else if (a.startsWith('-')) {
      // -s, -S, --silent, --show-error, --no-progress-meter, ...: no value, no effect here
    } else {
      console.error(`fake-curl: unexpected argument ${a}`)
      process.exit(2)
    }
  }
  if (!url) {
    console.error('fake-curl: no URL')
    process.exit(2)
  }
  const u = new URL(url)
  if (get) for (const kv of data) for (const [k, v] of new URLSearchParams(kv)) u.searchParams.append(k, v)
  const port = Number(u.port || 80)
  const s = readState(port)
  if (!s || !alive(s.pid)) {
    console.error(`curl: (7) Failed to connect to ${u.hostname} port ${port} after 0 ms: Couldn't connect to server`)
    process.exit(7)
  }
  const pass = user == null ? null : user.slice(user.indexOf(':') + 1)
  let code = 200
  let body
  if (s.password && pass !== s.password) {
    code = 401
    body = '<h1>401 Unauthorized</h1>'
  } else if (u.pathname === '/requests/status.json') {
    applyCommand(s, u.searchParams)
    body = JSON.stringify(statusJson(readState(port) ?? s))
  } else if (u.pathname === '/requests/playlist.json') {
    body = JSON.stringify({ type: 'node', name: '', children: [{ type: 'node', name: 'Playlist', children: [] }] })
  } else {
    code = 404
    body = '<h1>404 Not Found</h1>'
  }
  if (code >= 400 && fail) {
    console.error(`curl: (22) The requested URL returned error: ${code}`)
    process.exit(22)
  }
  if (outFile && outFile !== '-') {
    if (!/^(\/dev\/null|NUL)$/i.test(outFile)) writeFileSync(outFile, body)
  } else {
    process.stdout.write(body)
  }
  if (writeOut) {
    process.stdout.write(writeOut.replace(/%\{(http_code|response_code)\}/g, String(code)).replace(/\\n/g, '\n'))
  }
  process.exit(0)
}

function lastLaunch() {
  if (!existsSync(LAUNCHES)) return null
  const lines = readFileSync(LAUNCHES, 'utf8').trim().split('\n').filter(Boolean)
  return lines.length ? JSON.parse(lines.at(-1)) : null
}

async function runControl() {
  const [cmd, arg] = args
  const die = (msg) => {
    console.error(`fake-vlc: ${msg}`)
    process.exit(1)
  }
  if (cmd === 'args') {
    console.log(existsSync(LAUNCHES) ? readFileSync(LAUNCHES, 'utf8').trimEnd() : '(no launches)')
    return
  }
  if (cmd === 'commands') {
    console.log(existsSync(COMMANDS) ? readFileSync(COMMANDS, 'utf8').trimEnd() : '(no commands)')
    return
  }
  const last = lastLaunch()
  if (!last) die('VLC was never launched in this run')
  const s = readState(last.port)
  const live = s !== null && alive(s.pid)
  if (cmd === 'status') {
    console.log(JSON.stringify(live ? { live: true, pid: s.pid, file: s.file, ...statusJson(s) } : { live: false, port: last.port, file: last.file }, null, 2))
    return
  }
  if (!live) die(`no live fake VLC on port ${last.port}`)
  if (cmd === 'at') {
    const secs = Number(arg)
    if (!Number.isFinite(secs) || secs < 0) die('usage: control at SECONDS')
    s.base = Math.min(s.length, secs)
    s.baseAt = now()
    s.state = 'playing'
    writeState(s)
    console.log(`at: ${s.base}s of ${s.length}s (pid ${s.pid}, ${s.file})`)
    return
  }
  if (cmd === 'quit') {
    writeFileSync(quitPath(last.port), '')
    for (let i = 0; i < 50 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 100))
    if (alive(s.pid)) die(`pid ${s.pid} did not exit`)
    console.log(`quit: pid ${s.pid} exited (${s.file})`)
    return
  }
  die('usage: control args|status|commands|at SECONDS|quit')
}

if (mode === 'vlc') runVlc()
else if (mode === 'curl') runCurl()
else if (mode === 'control') await runControl()
else {
  console.error(`fake-vlc: unknown mode ${mode}`)
  process.exit(2)
}
