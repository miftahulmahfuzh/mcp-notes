import { describe, expect, test } from 'claude-code/testing'

import { linkify, nodeCandidates, normalizeId, normalizeMovieId, normalizeNodeId, normalizeWallUrl, splitFences, wallFromMcpGet } from '../hooks/linkify'

// Made-up ids only. No real note's id or body belongs in this file.
const WALL = 'http://localhost:7317'
const L = (id: string) => `[${id}](${WALL}/?note=${id})`

type Row = readonly [name: string, input: string, expected: string]

const LINKED: readonly Row[] = [
  ['a lone id', 'See A-B32 for that.', `See ${L('A-B32')} for that.`],
  ['digits only', 'Saved as 7-123.', `Saved as ${L('7-123')}.`],
  ['at the start and end', 'A-B32', L('A-B32')],
  ['two ids, comma list', 'Q-9ZZ, K-4M7', `${L('Q-9ZZ')}, ${L('K-4M7')}`],
  ['in bold', 'Saved **A-B32**.', `Saved **${L('A-B32')}**.`],
  ['in parentheses', 'the note (A-B32) says', `the note (${L('A-B32')}) says`],
  ['in a list item', '- A-B32: groceries\n- K-4M7: rent', `- ${L('A-B32')}: groceries\n- ${L('K-4M7')}: rent`],
  ['in a table cell', '| A-B32 | groceries |', `| ${L('A-B32')} | groceries |`],
  ['before a sentence colon', 'A-B32: done', `${L('A-B32')}: done`],
  ['possessive', "A-B32's body", `${L('A-B32')}'s body`],
  ['after a fence closes', '```\nX-123\n```\nthen A-B32', `\`\`\`\nX-123\n\`\`\`\nthen ${L('A-B32')}`],
  ['beside a code span', '`X-123` and A-B32', `\`X-123\` and ${L('A-B32')}`],
  ['in link-less brackets', '[A-B32]', `[${L('A-B32')}]`],
]

const UNCHANGED: readonly (readonly [name: string, input: string])[] = [
  ['fenced code block', '```\nA-B32\n```'],
  ['fenced code with info string', '```ts\nconst id = "A-B32"\n```'],
  ['tilde fence', '~~~\nA-B32\n~~~'],
  ['unclosed fence runs to the end', '```\nA-B32\nK-4M7'],
  ['inline code span', 'run `get A-B32` now'],
  ['double-backtick code span', 'run ``a ` A-B32`` now'],
  ['existing link text', '[A-B32](http://localhost:7317/?note=A-B32)'],
  ['existing link URL', '[the note](http://localhost:7317/?note=A-B32)'],
  ['image alt', '![A-B32](pic.png)'],
  ['reference link', '[A-B32][1]'],
  ['reference definition', '[1]: http://localhost:7317/?note=A-B32'],
  ['autolink', '<http://localhost:7317/?note=A-B32>'],
  ['bare URL', 'open http://localhost:7317/?note=A-B32 now'],
  ['bare URL path', 'see https://example.com/A-B32/x'],
  ['www URL', 'www.example.com/A-B32'],
  ['relative path', './X-123.ts'],
  ['path segment', 'src/X-123/foo'],
  ['path, lower case', 'a-b32/foo'],
  ['file name', 'X-123.ts'],
  ['host:port or file:line', 'X-123:10'],
  ['windows path', 'C:\\X-123\\a'],
  ['lower-case hash segments', '3f2a-9b1c'],
  ['upper-case hash segments', '3F2A-9B1C'],
  ['upper-case UUID', '123E4567-E89B-12D3-A456-426614174000'],
  ['lower-case UUID', '123e4567-e89b-12d3-a456-426614174000'],
  ['longer: two before', 'AB-CDEF'],
  ['longer: four after', 'A-B32X'],
  ['longer: prefix letter', 'XA-B32'],
  ['longer: dashed chain', 'A-B32-C'],
  ['longer: dash before', 'X-A-B32'],
  ['issue key', 'UATP-2960'],
  ['lower-case word e-mail', 'send an e-mail'],
  ['lower-case word t-shirt', 'a t-shirt'],
  ['lower-case id', 'a-b32'],
  ['mixed case', 'A-b32'],
  ['no dash', 'AB32'],
  ['hashtag', '#A-B32'],
  ['email-ish', 'me@A-B32.example'],
  ['escaped', '\\A-B32'],
  ['underscore identifier', 'foo_A-B32'],
  ['query value', 'note=A-B32'],
  ['call', 'A-B32(1)'],
  ['index', 'A-B32[0]'],
  ['plain prose', 'Nothing to see here.'],
]

describe('linkify', () => {
  for (const [name, input, expected] of LINKED) {
    test(`links: ${name}`, () => {
      expect(linkify(input, WALL)).toBe(expected)
    })
  }

  for (const [name, input] of UNCHANGED) {
    test(`leaves alone: ${name}`, () => {
      expect(linkify(input, WALL)).toBe(input)
    })
  }

  test('is idempotent over every row', () => {
    for (const [, input] of [...LINKED, ...UNCHANGED.map(([n, i]) => [n, i, i] as const)]) {
      const once = linkify(input, WALL)
      expect(linkify(once, WALL)).toBe(once)
    }
  })

  test('known limitation: an upper-case word shaped like an id is linked', () => {
    // R-123 style tags and words like X-RAY share the shape; documented in the README.
    expect(linkify('X-RAY', WALL)).toBe(L('X-RAY'))
  })

  test('uses the wall it is given', () => {
    expect(linkify('A-B32', 'http://127.0.0.1:9000')).toBe('[A-B32](http://127.0.0.1:9000/?note=A-B32)')
  })
})

describe('node ids', () => {
  const N = (id: string) => `[${id}](${WALL}/projects?node=${id})`
  const known = { has: (id: string) => id === 'BE-XU' || id === '8C-OJ' }

  test('links only the node ids it is told exist', () => {
    expect(linkify('BE-XU spawned 8C-OJ, see CI-CD', WALL, known)).toBe(`${N('BE-XU')} spawned ${N('8C-OJ')}, see CI-CD`)
  })

  test('leaves node ids alone without a known set, and in code, links and paths', () => {
    expect(linkify('BE-XU', WALL)).toBe('BE-XU')
    expect(linkify('`BE-XU` and ./BE-XU.md and [BE-XU](x)', WALL, known)).toBe('`BE-XU` and ./BE-XU.md and [BE-XU](x)')
  })

  test('notes and nodes in one reply, idempotent', () => {
    const once = linkify('A-B32 came from BE-XU.', WALL, known)
    expect(once).toBe(`${L('A-B32')} came from ${N('BE-XU')}.`)
    expect(linkify(once, WALL, known)).toBe(once)
  })

  test('nodeCandidates lists what to ask about: whole, upper case, outside code, not all digits', () => {
    expect(nodeCandidates('BE-XU, CI-CD, BE-XU, `ZZ-ZZ`, 12-34, be-xu, AB-CDE, A-B32')).toEqual(['BE-XU', 'CI-CD'])
  })

  test('normalizeNodeId', () => {
    expect(normalizeNodeId(' be-xu ')).toBe('BE-XU')
    expect(normalizeNodeId('BEXU')).toBe('BE-XU')
    expect(normalizeNodeId('A-B32')).toBeNull()
  })
})

describe('splitFences', () => {
  test('separates prose and fenced code', () => {
    expect(splitFences('a\n```\nb\n```\nc')).toEqual([
      { isCode: false, text: 'a\n' },
      { isCode: true, text: '```\nb\n```\n' },
      { isCode: false, text: 'c' },
    ])
  })

  test('a shorter or other fence does not close', () => {
    expect(splitFences('````\n```\n~~~\n````\n')).toEqual([{ isCode: true, text: '````\n```\n~~~\n````\n' }])
  })
})

describe('normalizeId', () => {
  const rows: readonly (readonly [string, string | null])[] = [
    ['A-B32', 'A-B32'],
    ['a-b32', 'A-B32'],
    ['ab32', 'A-B32'],
    ['AB32', 'A-B32'],
    ['  k-4m7 ', 'K-4M7'],
    ['', null],
    ['A-B3', null],
    ['A-B321', null],
    ['AB-C32', null],
    ['A_B32', null],
    ['e-mail', null],
  ]
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(normalizeId(input)).toBe(expected)
    })
  }
})

describe('normalizeWallUrl', () => {
  const rows: readonly (readonly [string, string | null])[] = [
    ['http://localhost:7317', 'http://localhost:7317'],
    ['http://localhost:7317/', 'http://localhost:7317'],
    ['http://localhost:7317/mcp', 'http://localhost:7317'],
    [' http://localhost:8080/mcp/ ', 'http://localhost:8080'],
    ['https://notes.example/wall', 'https://notes.example/wall'],
    ['localhost:7317', null],
    ['ftp://localhost', null],
    ['http://localhost:7317/?x=1', null],
    ['http://localhost:7317/(x)', null],
    ["http://localhost:7317/'", null],
    ['', null],
  ]
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(normalizeWallUrl(input)).toBe(expected)
    })
  }
})

describe('wallFromMcpGet', () => {
  test('reads the URL line and drops /mcp', () => {
    const out = 'notes:\n  Scope: User config\n  Status: ✔ Connected\n  Type: http\n  URL: http://localhost:7400/mcp\n'
    expect(wallFromMcpGet(out)).toBe('http://localhost:7400')
  })

  test('null without a URL line, or for a stdio server', () => {
    expect(wallFromMcpGet('No MCP server found with name: notes')).toBe(null)
    expect(wallFromMcpGet('notes:\n  Type: stdio\n  Command: node server.js\n')).toBe(null)
  })
})

describe('movie ids', () => {
  const M = (id: string) => `[${id}](${WALL}/movies/${id})`

  test('a free-standing movie id links to the title page, never as a note', () => {
    expect(linkify('Watch M-23T4 tonight.', WALL)).toBe(`Watch ${M('M-23T4')} tonight.`)
    expect(linkify('MobLand (2025), M-8TR4: episode M-0T77.', WALL)).toBe(`MobLand (2025), ${M('M-8TR4')}: episode ${M('M-0T77')}.`)
    expect(linkify('note A-B32 and film M-0909', WALL)).toBe(`note ${L('A-B32')} and film ${M('M-0909')}`)
  })

  test('code, links, longer words and lower case are left alone', () => {
    for (const s of ['`M-23T4`', '```\nM-23T4\n```', `[M-23T4](${WALL}/movies/M-23T4)`, 'M-23T45', 'XM-23T4', 'm-23t4', 'M-23T4.mkv', 'src/M-23T4/x', 'M3GAN']) {
      expect(linkify(s, WALL)).toBe(s)
    }
  })

  test('linking twice changes nothing', () => {
    const once = linkify('M-23T4 and A-B32', WALL)
    expect(linkify(once, WALL)).toBe(once)
  })

  test('a movie id written as a note link is repaired to the movie link', () => {
    expect(linkify(`film [M-VYD0](${WALL}/?note=M-VYD0) here`, WALL)).toBe(`film ${M('M-VYD0')} here`)
    expect(linkify(`[the film](${WALL}/?note=m-vyd0)`, WALL)).toBe(`[the film](${WALL}/movies/M-VYD0)`)
    expect(linkify(`[M-VYD0](${WALL}/#M-VYD0)`, WALL)).toBe(M('M-VYD0'))
    // A real note link, and a movie link, are left exactly as written.
    for (const s of [L('A-B32'), M('M-VYD0'), `[x](${WALL}/?note=A-B32)`, '[M-VYD0](https://example.com/page?note=M-VYD0&x=1)']) expect(linkify(s, WALL)).toBe(s)
  })

  test('normalizeMovieId needs the dash', () => {
    expect(normalizeMovieId(' m-23t4 ')).toBe('M-23T4')
    expect(normalizeMovieId('M23T4')).toBe(null)
    expect(normalizeMovieId('A-B32')).toBe(null)
  })
})
