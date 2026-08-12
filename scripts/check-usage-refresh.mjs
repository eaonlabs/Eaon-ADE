/*
 * Checks the access-token refresh in the authenticated usage path.
 *
 * Written after the same "That sign-in has expired" message kept coming back
 * even though the account was plainly still signed in — the refresh token
 * underneath the stale access token was good for weeks. Nothing here ever
 * spent it. `fetch` is stubbed to a fake token endpoint; no real token, no
 * real network call, ever touches this script.
 *
 *   node scripts/check-usage-refresh.mjs
 */

import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-usage-refresh-'))
const CREDS = path.join(tmp, '.credentials.json')
const PROJECTS = path.join(tmp, 'projects')

let pass = 0
const failures = []
function check(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${extra}` : ''}`)
  }
}

function writeCreds(oauth, extra = {}) {
  fs.writeFileSync(CREDS, JSON.stringify({ claudeAiOauth: oauth, ...extra }, null, 2))
}

/* ---- module under test ---------------------------------------------------- */

const outfile = path.join(tmp, 'usage.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/usage.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'e', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const app = { getPath: () => ${JSON.stringify(tmp)}, getVersion: () => '0.0.0-test' }`,
          loader: 'js'
        }))
      }
    }
  ]
})

const { anthropicUsage, resetUsageCache, setUsagePaths } = await import(outfile)
setUsagePaths({ projects: () => PROJECTS, credentials: () => CREDS })

/* ---- a fake token endpoint, and a fake usage endpoint behind it ---------- */

let refreshCalls = 0
let usageCalls = 0
let refreshMode = 'ok'

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('/v1/oauth/token')) {
    refreshCalls += 1
    const req = init?.body ? JSON.parse(String(init.body)) : {}
    if (req.grant_type !== 'refresh_token' || !req.refresh_token || !req.client_id) {
      return new Response('', { status: 400 })
    }
    if (refreshMode === 'denied') return new Response('', { status: 400 })
    if (refreshMode === 'network-fail') throw new Error('ECONNRESET')
    if (refreshMode === 'ok-no-expiry') {
      return new Response(JSON.stringify({ access_token: 'fresh-token-no-exp' }), { status: 200 })
    }
    if (refreshMode === 'ok-rotate') {
      return new Response(
        JSON.stringify({
          access_token: 'fresh-token-rotated',
          refresh_token: 'rotated-refresh-token',
          expires_in: 28800,
          refresh_token_expires_in: 7776000
        }),
        { status: 200 }
      )
    }
    return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 28800 }), {
      status: 200
    })
  }
  if (href.includes('/api/oauth/usage')) {
    usageCalls += 1
    const auth = init?.headers?.authorization ?? ''
    if (!auth.includes('fresh-token') && !auth.includes('still-valid')) {
      return new Response('', { status: 401 })
    }
    return new Response(
      JSON.stringify({
        five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600e3).toISOString() },
        seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86400e3).toISOString() }
      }),
      { status: 200 }
    )
  }
  return realFetch(url, init)
}

try {
  console.log('\na token nowhere near expiry is used as-is')
  writeCreds({
    accessToken: 'still-valid',
    expiresAt: Date.now() + 3600e3,
    refreshToken: 'rt-1',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x'
  })
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  const fresh = await anthropicUsage()
  check('no refresh attempted', refreshCalls === 0, refreshCalls)
  check('the usage call went out', usageCalls === 1, usageCalls)
  check('and it succeeded', fresh.source === 'anthropic', fresh.source)

  console.log('\nan expired access token is refreshed before being given up on')
  writeCreds(
    {
      accessToken: 'stale-token',
      expiresAt: Date.now() - 3600e3,
      refreshToken: 'rt-2',
      refreshTokenExpiresAt: Date.now() + 30 * 86400e3,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x'
    },
    { mcpOAuth: { someServer: { accessToken: 'unrelated', clientId: 'abc' } } }
  )
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  refreshMode = 'ok'
  const refreshed = await anthropicUsage()
  check('the refresh was made', refreshCalls === 1, refreshCalls)
  check('and the usage call followed it', usageCalls === 1, usageCalls)
  check('using the new token, not the stale one', refreshed.source === 'anthropic', refreshed.source)
  check('no error is shown for a refresh that worked', refreshed.error === undefined, refreshed.error)

  const onDisk = JSON.parse(fs.readFileSync(CREDS, 'utf8'))
  check('the new access token is on disk', onDisk.claudeAiOauth.accessToken === 'fresh-token')
  check('the expiry moved into the future', onDisk.claudeAiOauth.expiresAt > Date.now())
  check(
    'the refresh token is unchanged when none was reissued',
    onDisk.claudeAiOauth.refreshToken === 'rt-2',
    onDisk.claudeAiOauth.refreshToken
  )
  check(
    'unrelated top-level data survived the write untouched',
    onDisk.mcpOAuth?.someServer?.accessToken === 'unrelated'
  )
  const mode = fs.statSync(CREDS).mode & 0o777
  check('the file keeps the mode Claude Code itself uses', mode === 0o600, mode.toString(8))

  console.log('\na rotated refresh token is kept for next time')
  writeCreds({
    accessToken: 'stale-2',
    expiresAt: Date.now() - 1000,
    refreshToken: 'rt-3',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshMode = 'ok-rotate'
  await anthropicUsage()
  const rotated = JSON.parse(fs.readFileSync(CREDS, 'utf8'))
  check(
    'the rotated refresh token replaces the old one',
    rotated.claudeAiOauth.refreshToken === 'rotated-refresh-token'
  )
  check('its own expiry was recorded', rotated.claudeAiOauth.refreshTokenExpiresAt > Date.now())

  console.log('\na response with no expires_in keeps the old expiry rather than guessing')
  writeCreds({
    accessToken: 'stale-3',
    expiresAt: Date.now() - 1000,
    refreshToken: 'rt-4',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshMode = 'ok-no-expiry'
  await anthropicUsage()
  const kept = JSON.parse(fs.readFileSync(CREDS, 'utf8'))
  check('the old (already past) expiry is left as-is, not invented', kept.claudeAiOauth.expiresAt < Date.now())

  console.log('\nAnthropic rejects the refresh token: the honest message')
  // refreshTokenExpiresAt says this should still be good — deliberately, to
  // prove the server's own answer decides this, not a locally cached guess.
  writeCreds({
    accessToken: 'stale-4',
    expiresAt: Date.now() - 1000,
    refreshToken: 'rt-5',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshCalls = 0
  refreshMode = 'denied'
  const dead = await anthropicUsage()
  check('exactly one refresh was attempted', refreshCalls === 1, refreshCalls)
  check('falls back to the transcripts', dead.source === 'local', dead.source)
  check(
    'with the original message',
    dead.error === 'That sign-in has expired. Open Claude Code once to refresh it.',
    dead.error
  )

  console.log('\nrefresh token still good but the refresh call itself fails')
  writeCreds({
    accessToken: 'stale-5',
    expiresAt: Date.now() - 1000,
    refreshToken: 'rt-6',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshCalls = 0
  refreshMode = 'network-fail'
  const flaky = await anthropicUsage()
  check('one refresh attempt was made', refreshCalls === 1, refreshCalls)
  check('this is a hiccup, not "sign in again"', /Could not refresh/.test(flaky.error ?? ''), flaky.error)
  check('it does not claim the sign-in expired', !/has expired/.test(flaky.error ?? ''), flaky.error)
  const untouched = JSON.parse(fs.readFileSync(CREDS, 'utf8'))
  check('the file is not touched by a failed refresh', untouched.claudeAiOauth.accessToken === 'stale-5')

  console.log('\na struggling refresh backs off instead of retrying every 90s')
  refreshCalls = 0
  for (let i = 0; i < 10; i += 1) await anthropicUsage()
  check('no further refresh attempts while backed off', refreshCalls === 0, refreshCalls)

  console.log('\nconcurrent readers of one expired token share one refresh')
  writeCreds({
    accessToken: 'stale-6',
    expiresAt: Date.now() - 1000,
    refreshToken: 'rt-7',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  refreshMode = 'ok'
  const together = await Promise.all(Array.from({ length: 8 }, () => anthropicUsage()))
  check('eight readers, one refresh', refreshCalls === 1, refreshCalls)
  check('and they all get an answer', together.every((r) => r.source === 'anthropic'))
} finally {
  globalThis.fetch = realFetch
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailed:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
