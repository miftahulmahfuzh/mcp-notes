// node mcp.mjs <url> <tool> [json-args]: call one notesd MCP tool and print the result.
// Run from an mcp-notes checkout (resolves @modelcontextprotocol/sdk from its node_modules).
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const [url, tool, rawArgs = '{}'] = process.argv.slice(2)
if (!url || !tool) {
  console.error('usage: node mcp.mjs <url> <tool> [json-args]')
  process.exit(2)
}

const require = createRequire(path.join(process.cwd(), 'package.json'))
const load = (spec) => import(pathToFileURL(require.resolve(spec)).href)
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = await load('@modelcontextprotocol/sdk/client/streamableHttp.js')

const client = new Client({ name: 'verify-notesd', version: '1' })
await client.connect(new StreamableHTTPClientTransport(new URL(url)))
try {
  if (tool === '--list') {
    const { tools } = await client.listTools()
    console.log(tools.map((t) => t.name).join('\n'))
  } else {
    console.log(`> ${tool} ${rawArgs}`)
    const result = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) })
    if (result.isError) console.log('< ERROR')
    for (const part of result.content ?? []) console.log(part.type === 'text' ? part.text : JSON.stringify(part))
    if (result.isError) process.exitCode = 1
  }
} finally {
  await client.close()
}
