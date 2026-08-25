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
let lastAuth = ''
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
    if (refreshMode === 'ok-still-bad') {
      return new Response(JSON.stringify({ access_token: 'refreshed-but-bad', expires_in: 28800 }), {
        status: 200
      })
    }
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
    lastAuth = auth
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
  /* ---- the server's answer outranks our own timestamp ------------------- */

  console.log('\na token Anthropic refuses is refreshed even when our clock says it is fine')
  writeCreds({
    accessToken: 'stale-7',
    // Far in the future: the pre-flight check has no reason to act.
    expiresAt: Date.now() + 6 * 3600e3,
    refreshToken: 'rt-8',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  refreshMode = 'ok'
  const skewed = await anthropicUsage()
  check('the 401 triggered a refresh', refreshCalls === 1, refreshCalls)
  check('and the request was retried', usageCalls === 2, usageCalls)
  check('so the readout is live, not a backoff message', skewed.source === 'anthropic', skewed.error)

  console.log('\ncredentials with no expiresAt are refreshed, not trusted')
  writeCreds({
    accessToken: 'stale-8',
    refreshToken: 'rt-9',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  const noExp = await anthropicUsage()
  check('a missing timestamp still refreshes', refreshCalls === 1, refreshCalls)
  check('and it succeeded first try', usageCalls === 1, usageCalls)
  check('the readout is live', noExp.source === 'anthropic', noExp.error)

  console.log('\nno refresh token and no timestamp: the access token is still tried')
  writeCreds({ accessToken: 'still-valid' })
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  const bare = await anthropicUsage()
  check('nothing to refresh with, so nothing attempted', refreshCalls === 0, refreshCalls)
  check('the token was used anyway', usageCalls === 1, usageCalls)
  check('and it worked', bare.source === 'anthropic', bare.error)

  console.log('\na 401 whose refresh is denied says sign in again, not "Anthropic replied 401"')
  writeCreds({
    accessToken: 'stale-9',
    expiresAt: Date.now() + 6 * 3600e3,
    refreshToken: 'rt-10',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshCalls = 0
  refreshMode = 'denied'
  const revoked = await anthropicUsage()
  check('it names the real problem', /has expired/.test(revoked.error ?? ''), revoked.error)
  check('not the status code', !/replied 401/.test(revoked.error ?? ''), revoked.error)

  console.log('\none refresh per check, even when the fresh token is refused too')
  writeCreds({
    accessToken: 'stale-10',
    expiresAt: Date.now() - 1000,
    refreshToken: 'rt-11',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  refreshMode = 'ok-still-bad'
  await anthropicUsage()
  check('the refresh token is spent once, not twice', refreshCalls === 1, refreshCalls)
  // The pre-flight refresh already spent this check's one attempt, so the 401
  // that follows is taken at face value rather than starting the cycle again.
  check('and the 401 after it is not retried', usageCalls === 1, usageCalls)
  refreshMode = 'ok'
  /* ---- the login keychain, which is where a Mac actually keeps these ----- */

  const useKeychain = (json) =>
    setUsagePaths({
      projects: () => PROJECTS,
      credentials: () => CREDS,
      isDefaultAccount: () => true,
      keychain: () => (json === null ? null : JSON.stringify(json))
    })
  const useFileOnly = () =>
    setUsagePaths({ projects: () => PROJECTS, credentials: () => CREDS, isDefaultAccount: () => false })

  console.log('\nthe keychain wins over a stale file')
  // Exactly the shape found on the real machine: the file five days behind,
  // the keychain current, Claude Code running the whole time.
  writeCreds({
    accessToken: 'stale-file-token',
    expiresAt: Date.now() - 118 * 3600e3,
    refreshToken: 'rt-file',
    refreshTokenExpiresAt: Date.now() + 86 * 3600e3
  })
  useKeychain({
    claudeAiOauth: {
      accessToken: 'still-valid',
      expiresAt: Date.now() + 6.4 * 3600e3,
      refreshToken: 'rt-keychain',
      refreshTokenExpiresAt: Date.now() + 27 * 86400e3,
      subscriptionType: 'max'
    }
  })
  resetUsageCache()
  refreshCalls = 0
  usageCalls = 0
  lastAuth = ''
  const kc = await anthropicUsage()
  check('no refresh was needed', refreshCalls === 0, refreshCalls)
  check('the keychain token was the one sent', lastAuth.includes('still-valid'), lastAuth.slice(0, 24))
  check('and the readout is live', kc.source === 'anthropic', kc.error)
  check('no "sign-in has expired"', !/has expired/.test(kc.error ?? ''), kc.error)

  console.log('\na stale keychain token is reported, never refreshed')
  // The safety case. Refreshing here can rotate the refresh token and leave
  // Claude Code holding one the server just retired — breaking the CLI's own
  // sign-in to fill in a percentage.
  useKeychain({
    claudeAiOauth: {
      accessToken: 'keychain-stale',
      expiresAt: Date.now() - 3600e3,
      refreshToken: 'rt-keychain',
      refreshTokenExpiresAt: Date.now() + 27 * 86400e3
    }
  })
  resetUsageCache()
  refreshCalls = 0
  const kcStale = await anthropicUsage()
  check('the keychain refresh token is never spent', refreshCalls === 0, refreshCalls)
  check('and the advice given is the one that works', /Open Claude Code/.test(kcStale.error ?? ''), kcStale.error)

  console.log('\nno keychain entry falls back to the file')
  writeCreds({
    accessToken: 'still-valid',
    expiresAt: Date.now() + 3600e3,
    refreshToken: 'rt-file2',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  useKeychain(null)
  resetUsageCache()
  usageCalls = 0
  lastAuth = ''
  const noKc = await anthropicUsage()
  check('the file answered instead', noKc.source === 'anthropic', noKc.error)
  check('using the file token', lastAuth.includes('still-valid'), lastAuth.slice(0, 24))

  console.log('\na second account never reads the keychain')
  writeCreds({
    accessToken: 'stale-acct2',
    expiresAt: Date.now() - 3600e3,
    refreshToken: 'rt-acct2',
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3
  })
  useFileOnly()
  resetUsageCache()
  refreshCalls = 0
  refreshMode = 'ok'
  const acct2 = await anthropicUsage()
  check('it refreshed its own file instead', refreshCalls === 1, refreshCalls)
  check('and got a live readout', acct2.source === 'anthropic', acct2.error)
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
