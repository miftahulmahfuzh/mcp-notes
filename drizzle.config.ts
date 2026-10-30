import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit runs outside the daemon, so it loads .env.local itself (the same file
// src/config.ts reads). Migrations go to the DIRECT (unpooled) Neon host only.
loadEnv({ path: '.env.local', quiet: true })

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// Choose by host, not by key name: the owner's .env.local has the two names swapped
// (DATABASE_URL holds the direct host). Whichever of the two is direct wins.
const candidates = [process.env.DATABASE_URL_UNPOOLED, process.env.DATABASE_URL]
  .map((v) => v?.trim())
  .filter((v): v is string => !!v)
const url = candidates.find((u) => {
  const host = hostOf(u)
  return host !== null && !host.includes('-pooler')
})
if (!url) {
  throw new Error(
    'No direct (unpooled) Postgres URL in DATABASE_URL_UNPOOLED or DATABASE_URL. drizzle-kit must ' +
      'use the DIRECT Neon connection string (the host without "-pooler"); running migrations ' +
      'through the pooler is unsupported. Add it to .env.local.',
  )
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
