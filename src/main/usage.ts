import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { projectsRoot, setProjectsRoot } from './sessions'
import {
  WINDOWS,
  billedOf,
  limitsFor,
  modelLabel,
  type ModelUse,
  type UsageReport,
  type UsageWindow
} from '../shared/usage'

/**
 * Reading the plan's spend off the transcripts Claude Code already keeps.
 *
 * There is a lot of it — nearly half a gigabyte written in a week here — so the
 * whole file is read exactly once. After that only the bytes appended since the
 * last look are parsed, because a transcript is append-only and its length is
 * enough to know what is new. That is the difference between a readout that can
 * refresh every few seconds and one that re-reads 466 MB to tell you the same
 * number.
 */

interface Event {
  /**
   * The request this line belongs to.
   *
   * Claude Code writes one assistant message as several lines — four out of
   * five here — each repeating the same cumulative usage. The id is what tells
   * them apart from genuinely separate requests, and counting by line instead
   * inflates the total by about 62%.
   */
  rid: string
  t: number
  model: string
  input: number
  cacheCreate: number
  cacheRead: number
  output: number
}

interface FileCursor {
  /** How far into the file has already been parsed. */
  offset: number
  events: Event[]
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Longest window we ever report on; nothing older is worth keeping. */
const KEEP_MS = WEEK_MS

const cursors = new Map<string, FileCursor>()
/** Guards against two refreshes overlapping and counting the same bytes twice. */
let running: Promise<UsageReport> | null = null

/*
 * Asking Anthropic is a network call, and it was being made like a local read.
 *
 * The readout refreshes itself every ninety seconds and again on every manual
 * press, and each of those went straight out to the network — for a pair of
 * percentages that move over hours. Anthropic answered 429, and the reply to
 * being rate limited was to ask again ninety seconds later, and again, which is
 * how it stayed that way. Nothing here retried, nothing waited, and nothing
 * remembered the answer it already had.
 *
 * So a good answer is kept and reused, one request is made at a time however
 * many readers ask, and a refusal is respected: after a 429 nothing is sent
 * until the moment Anthropic named, or a doubling wait if it named none.
 */

/** How long an answer stays good. Percentages do not move faster than this. */
const ANTHROPIC_FRESH_MS = 5 * 60 * 1000

/** First wait after a refusal that came with no `Retry-After`, then doubling. */
const BACKOFF_FIRST_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60 * 1000

let anthropicCache: { at: number; report: UsageReport } | null = null
let anthropicInflight: Promise<UsageReport> | null = null
/** Epoch ms before which nothing may be sent. */
let blockedUntil = 0
let backoffMs = 0

/**
 * When Anthropic says to come back. Seconds or an HTTP date, per the header's
 * definition; anything unreadable falls through to the doubling wait, because a
 * header we cannot parse is not a reason to ignore the refusal.
 */
function retryAfterMs(header: string | null): number {
  if (!header) return 0
  const secs = Number(header)
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, BACKOFF_MAX_MS)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), BACKOFF_MAX_MS) : 0
}

/** "4m" — how long until it is worth asking again. */
function waitLabel(ms: number): string {
  const mins = Math.ceil(ms / 60_000)
  return mins <= 1 ? 'a minute' : `${mins} minutes`
}

/*
 * Whose transcripts are being counted.
 *
 * The account that is active owns them. Reading `~/.claude` regardless would
 * add a second account's spend to the first account's readout, which is the
 * kind of wrong that looks plausible.
 */
let resolveCredentialsFile: () => string = () =>
  path.join(os.homedir(), '.claude', '.credentials.json')

export function setUsagePaths(paths: {
  projects: () => string
  credentials: () => string
  /** True when no second account is active. Only then does the keychain hold
   * the credentials for the account being counted. */
  isDefaultAccount?: () => boolean
  /** Test seam. Left out, the real login keychain is read. */
  keychain?: () => string | null
}): void {
  setProjectsRoot(paths.projects)
  resolveCredentialsFile = paths.credentials
  if (paths.isDefaultAccount) isDefaultAccount = paths.isDefaultAccount
  if (paths.keychain) readKeychain = paths.keychain
  keychainMemo = null
}

/* Falls back to comparing paths, which is right for the shipped wiring and
 * keeps anything that has not been told otherwise away from the keychain. */
let isDefaultAccount: () => boolean = () =>
  resolveCredentialsFile() === path.join(os.homedir(), '.claude', '.credentials.json')

/*
 * Where the credentials actually live on a Mac.
 *
 * `~/.claude/.credentials.json` is not the live copy here. Claude Code stores
 * its OAuth material in the login keychain under this service name and stops
 * writing the file; measured on this machine, the file's access token was 118
 * hours stale and last written five days earlier, while the keychain's copy
 * had six hours left on it and a refresh token good for a month — with Claude
 * Code running the whole time. Reading the file and reporting what it found is
 * why "That sign-in has expired" kept coming back and why the advice attached
 * to it never worked: opening Claude Code refreshes the keychain, which the
 * app was not looking at.
 *
 * The file is still the right answer for a second account, which lives in its
 * own `CLAUDE_CONFIG_DIR` and is not in the keychain at all.
 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

let readKeychain: () => string | null = () => {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return out.trim() || null
  } catch {
    // No entry, an older Claude Code that still uses the file, or a locked
    // keychain. All three mean "ask the file instead", not "no credentials".
    return null
  }
}

/** `security` is a subprocess and this is read on every poll; a few seconds of
 * memo keeps a 90-second cadence from spawning one each time. */
let keychainMemo: { at: number; raw: Record<string, unknown> | null } | null = null
const KEYCHAIN_MEMO_MS = 15_000

function keychainCredentials(): Record<string, unknown> | null {
  if (keychainMemo && Date.now() - keychainMemo.at < KEYCHAIN_MEMO_MS) return keychainMemo.raw
  let parsed: Record<string, unknown> | null = null
  const raw = readKeychain()
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      parsed = null
    }
  }
  keychainMemo = { at: Date.now(), raw: parsed }
  return parsed
}

interface LoadedCredentials {
  oauth: OauthFields
  /** Which copy answered — it decides who is allowed to refresh. */
  source: 'keychain' | 'file'
  file: string
}

/**
 * The freshest credentials available, and where they came from.
 *
 * The keychain is consulted only for the default account. A workspace pinned
 * to another account resolves to that account's own config dir, and the
 * keychain would hand back the wrong person's token — the exact "wrong that
 * looks plausible" the projects root already guards against.
 */
function loadCredentials(): LoadedCredentials | null {
  const file = resolveCredentialsFile()
  if (isDefaultAccount()) {
    const raw = keychainCredentials()
    const oauth = raw?.claudeAiOauth as OauthFields | undefined
    if (oauth?.accessToken) return { oauth, source: 'keychain', file }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth?: OauthFields }
    if (!raw.claudeAiOauth) return null
    return { oauth: raw.claudeAiOauth, source: 'file', file }
  } catch {
    return null
  }
}

function projectsDir(): string {
  return projectsRoot()
}

async function transcripts(): Promise<string[]> {
  const root = projectsDir()
  const out: string[] = []
  let entries: string[]
  try {
    entries = await fsp.readdir(root)
  } catch {
    return out
  }
  const cutoff = Date.now() - KEEP_MS
  for (const dir of entries) {
    let files: string[]
    try {
      files = await fsp.readdir(path.join(root, dir))
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(root, dir, name)
      try {
        // A transcript untouched for a week cannot hold anything in range, and
        // skipping it here is what keeps the first scan to the files that
        // matter rather than all 185 of them.
        if ((await fsp.stat(file)).mtimeMs < cutoff && !cursors.has(file)) continue
      } catch {
        continue
      }
      out.push(file)
    }
  }
  return out
}

/**
 * Parse whatever is new in one transcript.
 *
 * Streamed rather than read whole: these files reach hundreds of megabytes, and
 * holding one in memory to count a few hundred numbers out of it would be a
 * poor trade. Lines are filtered on a substring before being handed to
 * JSON.parse — most of a transcript is user turns and tool output with no usage
 * on them at all, and parsing those is the bulk of the work avoided.
 */
async function scanFile(file: string): Promise<void> {
  let size = 0
  try {
    size = (await fsp.stat(file)).size
  } catch {
    return
  }

  let cursor = cursors.get(file)
  // A file that shrank was rotated or rewritten; everything known about it is
  // no longer trustworthy, so it is read again from the start.
  if (!cursor || size < cursor.offset) {
    cursor = { offset: 0, events: [] }
    cursors.set(file, cursor)
  }
  if (size === cursor.offset) return

  const stream = fs.createReadStream(file, { start: cursor.offset, encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of lines) {
      if (line.length < 40) continue
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue

      let row: {
        type?: string
        timestamp?: string
        requestId?: string
        uuid?: string
        message?: { model?: string; usage?: Record<string, number> }
      }
      try {
        row = JSON.parse(line)
      } catch {
        // A half-written final line is normal on a live session; the next pass
        // picks it up, because the offset only advances past what parsed.
        continue
      }

      if (row.type !== 'assistant' || !row.message?.usage || !row.timestamp) continue
      const t = Date.parse(row.timestamp)
      if (!Number.isFinite(t)) continue

      const u = row.message.usage
      cursor.events.push({
        // Without a request id there is nothing to group by, so the line's own
        // uuid stands in and it is counted once, on its own.
        rid: row.requestId || row.uuid || `${t}:${row.message.model}`,
        t,
        model: row.message.model ?? 'unknown',
        input: u.input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0
      })
    }
    cursor.offset = size
  } finally {
    lines.close()
    stream.close()
  }

}

function readCredentials(): { plan: string; tier: string } {
  // Only the plan name and tier are read. The tokens beside them are not touched
  // unless the authenticated source is switched on, which is a separate door.
  const got = loadCredentials()
  if (!got) return { plan: '', tier: '' }
  return { plan: got.oauth.subscriptionType ?? '', tier: got.oauth.rateLimitTier ?? '' }
}

/** Fold the events inside one window into per-model totals. */
function summarise(
  events: Event[],
  spec: (typeof WINDOWS)[number],
  limit: number,
  now: number
): UsageWindow {
  /*
   * A block window opens on the first message after a gap as long as the window
   * itself, and closes five hours later — which is how the limit it stands for
   * actually behaves. Measuring it as a rolling five hours instead made the
   * countdown mean "when the oldest thing drops off", a number that slides
   * forward every time you speak and never matches what the agent tells you.
   */
  let from = now - spec.spanMs
  let opensAt = 0
  if (spec.kind === 'block') {
    /*
     * Blocks tile forward rather than there being only one.
     *
     * Work through a long day and the first block closes while you are still
     * going; the next message opens the next one. Looking only for a gap as
     * long as the window found a single start hours back, called it expired,
     * and reported nothing used at all — during a session that was plainly
     * spending. Opening a new block whenever a message falls outside the
     * current one covers both cases: a long pause and a long stretch.
     */
    let start = 0
    for (const e of events) {
      if (!start || e.t - start >= spec.spanMs) start = e.t
    }
    // A block that has already run its course counts nothing.
    opensAt = start && now - start < spec.spanMs ? start : 0
    from = opensAt || now + 1
  }

  const inWindow = events.filter((e) => e.t >= from)

  const byModel = new Map<string, ModelUse>()
  let used = 0
  let oldest = Infinity

  for (const e of inWindow) {
    let m = byModel.get(e.model)
    if (!m) {
      m = {
        model: e.model,
        label: modelLabel(e.model),
        input: 0,
        cacheCreate: 0,
        cacheRead: 0,
        output: 0,
        billed: 0
      }
      byModel.set(e.model, m)
    }
    m.input += e.input
    m.cacheCreate += e.cacheCreate
    m.cacheRead += e.cacheRead
    m.output += e.output
    const billed = billedOf(e)
    m.billed += billed
    used += billed
    if (e.t < oldest) oldest = e.t
  }

  return {
    ...spec,
    used,
    limit,
    pct: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
    /*
     * A block closes at a knowable moment. A rolling window has none, so it
     * reports when its oldest activity ages out and the interface says
     * "rolling" rather than dressing that up as a reset.
     */
    resetsAt:
      spec.kind === 'block'
        ? opensAt
          ? opensAt + spec.spanMs
          : 0
        : Number.isFinite(oldest)
          ? oldest + spec.spanMs
          : now,
    models: [...byModel.values()].sort((a, b) => b.billed - a.billed)
  }
}

/**
 * Read the plan's spend from disk.
 *
 * Overlapping calls share one pass. Without that, a refresh landing on top of
 * the first slow scan would parse the same bytes twice and double the totals,
 * because both would advance the same cursors.
 */
export function localUsage(limitOverrides?: Partial<Record<'session' | 'week', number>>): Promise<UsageReport> {
  if (running) return running
  running = (async () => {
    const started = Date.now()
    const { plan, tier } = readCredentials()
    const files = await transcripts()

    for (const file of files) {
      try {
        await scanFile(file)
      } catch {
        /* one unreadable transcript must not lose the rest of the report */
      }
    }

    const now = Date.now()
    const cutoff = now - KEEP_MS

    /*
     * Deduplicated here rather than as each line is read.
     *
     * Doing it at parse time needs a set of everything seen so far, and an
     * incremental scan only reads what is new — so the sibling lines of one
     * message, arriving after the last look, had nothing to be recognised
     * against and were counted a second time. The total then crept upwards for
     * as long as the app stayed open and snapped back on restart. Deciding it
     * here, with every event in hand, does not care which pass read what. It
     * also catches one request appearing in two transcripts, which is what a
     * resumed or forked session produces.
     */
    const counted = new Set<string>()
    const events: Event[] = []
    for (const [file, cursor] of cursors) {
      if (!files.includes(file)) continue
      // Older than the longest window and it can never be counted again.
      if (cursor.events.length && cursor.events[0].t < cutoff) {
        cursor.events = cursor.events.filter((e) => e.t >= cutoff)
      }
      for (const e of cursor.events) {
        if (counted.has(e.rid)) continue
        counted.add(e.rid)
        events.push(e)
      }
    }
    events.sort((a, b) => a.t - b.t)

    const base = limitsFor(tier)
    return {
      source: 'local' as const,
      at: now,
      tookMs: now - started,
      plan,
      tier,
      messages: events.length,
      windows: WINDOWS.map((spec) =>
        summarise(events, spec, limitOverrides?.[spec.id] ?? base[spec.id], now)
      )
    }
  })().finally(() => {
    running = null
  })
  return running
}

/** Drop everything learned, so the next read starts from scratch. */
export function resetUsageCache(): void {
  cursors.clear()
  // A different account's figures are not this one's, and a refusal earned
  // under one token should not silence the next.
  anthropicCache = null
  blockedUntil = 0
  backoffMs = 0
}

/**
 * Where Claude Code exchanges a refresh token for a new access token.
 *
 * Not documented, and not guessed either — read out of the CLI's own shipped
 * code (`2.1.228`, static strings): `TOKEN_URL` resolves to
 * `https://platform.claude.com/v1/oauth/token`, and `CLIENT_ID` next to it is
 * `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, the same id the sign-in flow in
 * `account-login.ts` connects to. Both endpoints belong to one client.
 */
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** Refresh ahead of the deadline, not at it — a request in flight when the
 * clock ticks over must not itself read as expired. */
const EXPIRY_SLACK_MS = 60_000

/** One refresh in flight per credentials file, so two callers racing the same
 * expired token do not both spend the refresh token at once. */
const refreshing = new Map<string, Promise<RefreshResult>>()

interface OauthFields {
  accessToken?: string
  expiresAt?: number
  refreshToken?: string
  refreshTokenExpiresAt?: number
  subscriptionType?: string
  rateLimitTier?: string
}

/**
 * What came back, in the two shapes that matter to the caller.
 *
 * Not a single `null` for every kind of failure. Anthropic's own answer is
 * what decides whether a sign-in is actually dead — `refreshTokenExpiresAt`
 * is a number this app wrote down once and could simply be wrong, wrong being
 * a clock that drifted or a token the server chose to extend. `denied` is the
 * server saying no; `unreachable` is everything else, from a dropped
 * connection to a 500, and neither is a reason to send someone to sign in
 * again.
 */
type RefreshResult = { ok: true; token: string } | { ok: false; reason: 'denied' | 'unreachable' }

/**
 * Exchanges the refresh token for a new access token and writes it back to the
 * credentials file — the same file Claude Code itself reads and refreshes.
 *
 * Every other key in the file is carried through untouched. It holds more
 * than this one account's OAuth material — `mcpOAuth` entries for whatever
 * else is connected — and only `claudeAiOauth` is this function's to change.
 * Written aside and renamed, so a crash mid-write cannot leave a half file,
 * and given the mode Claude Code itself creates it with: a plain rename would
 * otherwise hand a credentials file to the process umask instead.
 */
async function refreshCredentials(file: string): Promise<RefreshResult> {
  const existing = refreshing.get(file)
  if (existing) return existing

  const attempt = (async (): Promise<RefreshResult> => {
    let raw: Record<string, unknown>
    let oauth: OauthFields
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      oauth = (raw.claudeAiOauth as OauthFields | undefined) ?? {}
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    // Nothing to even try refreshing with is not a rejection from Anthropic.
    if (!oauth.refreshToken) return { ok: false, reason: 'unreachable' }

    let res: Response
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: oauth.refreshToken,
          client_id: CLIENT_ID
        })
      })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    // A rejected grant is the one answer that means the sign-in itself is
    // gone rather than the network having a bad moment. 400 and 401 are what
    // an OAuth token endpoint returns for `invalid_grant` — a revoked or
    // already-superseded refresh token — and 403 for one Anthropic will not
    // honour at all. Anything else unsuccessful (5xx, a stray 429) is the
    // server having trouble, not a verdict on the sign-in.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'denied' }
    }
    if (!res.ok) return { ok: false, reason: 'unreachable' }

    let body: {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      refresh_token_expires_in?: number
    }
    try {
      body = (await res.json()) as typeof body
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (!body.access_token) return { ok: false, reason: 'unreachable' }

    const now = Date.now()
    const nextOauth: OauthFields = {
      ...oauth,
      accessToken: body.access_token,
      expiresAt: body.expires_in ? now + body.expires_in * 1000 : oauth.expiresAt,
      // A server that does not rotate the refresh token does not resend one;
      // the one already on disk is still the current one in that case.
      refreshToken: body.refresh_token ?? oauth.refreshToken,
      refreshTokenExpiresAt: body.refresh_token_expires_in
        ? now + body.refresh_token_expires_in * 1000
        : oauth.refreshTokenExpiresAt
    }

    try {
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ ...raw, claudeAiOauth: nextOauth }, null, 2), {
        mode: 0o600
      })
      fs.renameSync(tmp, file)
    } catch {
      // The refresh worked even if the write did not; the new token is still
      // good for this one request.
    }
    return { ok: true, token: body.access_token }
  })().finally(() => {
    refreshing.delete(file)
  })

  refreshing.set(file, attempt)
  return attempt
}

/**
 * Ask Anthropic directly, using the credentials Claude Code already holds.
 *
 * This is the only way to the real percentages — the plan's ceiling is reported
 * at request time and is written down nowhere — and it is the reason this path
 * is off until it is switched on: it reads the OAuth token out of
 * `~/.claude/.credentials.json` and makes an authenticated request as you.
 *
 * The endpoint is not a documented one. It is what the CLI itself calls, so it
 * can change without notice; a failure here falls back to the local reading
 * rather than leaving the readout empty.
 */
async function requestAnthropicUsage(): Promise<UsageReport> {
  const started = Date.now()
  const fallback = async (error: string): Promise<UsageReport> => ({
    ...(await localUsage()),
    error
  })

  let token = ''
  let plan = ''
  let tier = ''
  /* At most one refresh per check. The pre-flight below and the 401 retry
   * further down are two ways of reaching the same conclusion, and a token
   * that was just replaced does not need replacing again. */
  let refreshed = false
  const creds = loadCredentials()
  if (!creds) return fallback('No Claude credentials found on this machine.')
  const { oauth, source, file } = creds
  token = oauth.accessToken ?? ''
  plan = oauth.subscriptionType ?? ''
  tier = oauth.rateLimitTier ?? ''

  /*
   * A stale access token is the ordinary state of a machine nobody has opened
   * `claude` on today; it is not a dead sign-in. Who is allowed to do
   * something about it depends entirely on where it came from.
   *
   * From the keychain: nobody here. That copy is Claude Code's own, and a
   * refresh can rotate the refresh token — spending it would hand this app a
   * working token and leave Claude Code holding one the server has just
   * retired. Breaking the user's CLI sign-in to put a percentage in a popover
   * is not a trade worth making, and it is not needed: Claude Code refreshes
   * that entry itself on its next run, so the advice in the message is finally
   * true when it is shown for this reason.
   *
   * From a file: this app is the only thing that will ever refresh it, so it
   * does, and writes the result back the way Claude Code would have.
   */
  const stale = !oauth.expiresAt || oauth.expiresAt < Date.now() + EXPIRY_SLACK_MS
  if (stale && source === 'keychain') {
    return fallback('That sign-in has expired. Open Claude Code once to refresh it.')
  }
  if (stale && oauth.refreshToken) {
    refreshed = true
    const got = await refreshCredentials(file)
    if (got.ok) {
      token = got.token
    } else if (got.reason === 'denied') {
      return fallback('That sign-in has expired. Open Claude Code once to refresh it.')
    } else {
      // Unreachable, not rejected — a network hiccup, not a dead sign-in.
      // Backed off the same as a 429 below, or a struggling network gets
      // asked again every ninety seconds forever, which is the exact shape
      // of the bug this whole path exists to avoid.
      backoffMs = Math.min(Math.max(backoffMs * 2, BACKOFF_FIRST_MS), BACKOFF_MAX_MS)
      blockedUntil = Date.now() + backoffMs
      return fallback(`Could not refresh that sign-in. Trying again in ${waitLabel(backoffMs)}.`)
    }
  }
  if (!token) return fallback('No Claude credentials found on this machine.')

  let body: Record<string, { utilization?: number; resets_at?: string }>
  const ask = (bearer: string): Promise<Response> =>
    fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${bearer}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
        // An unnamed client is the easiest kind to throttle.
        'user-agent': `EaonADE/${app.getVersion()}`
      }
    })
  try {
    let res = await ask(token)

    /*
     * A token whose `expiresAt` is still in the future can be refused anyway:
     * a clock that drifted, a sign-out somewhere else, a rotation this app did
     * not see. The pre-flight check above reads our own note about the token;
     * this reads Anthropic's answer about it, and Anthropic wins. One refresh,
     * one retry, then take the reply at face value — without this, a 401 fell
     * to the generic branch below and backed off for minutes at a time while
     * the refresh token sitting on disk would have fixed it immediately.
     */
    if ((res.status === 401 || res.status === 403) && !refreshed && source === 'file') {
      refreshed = true
      const got = await refreshCredentials(file)
      if (got.ok) {
        token = got.token
        res = await ask(token)
      } else if (got.reason === 'denied') {
        return fallback('That sign-in has expired. Open Claude Code once to refresh it.')
      }
    }
    if (res.status === 429) {
      const named = retryAfterMs(res.headers.get('retry-after'))
      backoffMs = named || Math.min(Math.max(backoffMs * 2, BACKOFF_FIRST_MS), BACKOFF_MAX_MS)
      blockedUntil = Date.now() + backoffMs
      return fallback(
        `Anthropic is limiting these checks. Showing your transcripts; trying again in ${waitLabel(backoffMs)}.`
      )
    }
    if (!res.ok) {
      // Anything else is worth a pause too, or a broken endpoint is asked the
      // same question every ninety seconds for as long as the app is open.
      backoffMs = Math.min(Math.max(backoffMs * 2, BACKOFF_FIRST_MS), BACKOFF_MAX_MS)
      blockedUntil = Date.now() + backoffMs
      return fallback(`Anthropic replied ${res.status}. Trying again in ${waitLabel(backoffMs)}.`)
    }
    body = (await res.json()) as typeof body
  } catch (err) {
    return fallback(`Could not reach Anthropic: ${err instanceof Error ? err.message : err}`)
  }

  const now = Date.now()
  const read = (key: string): { pct: number; resetsAt: number } | null => {
    const row = body[key]
    if (!row || typeof row.utilization !== 'number') return null
    const at = row.resets_at ? Date.parse(row.resets_at) : NaN
    return { pct: row.utilization, resetsAt: Number.isFinite(at) ? at : now }
  }

  const five = read('five_hour')
  const week = read('seven_day')
  if (!five && !week) return fallback('Anthropic returned no usage for this account.')

  // Per-model rows come back as their own seven-day windows.
  const perModel: ModelUse[] = []
  for (const [key, row] of Object.entries(body)) {
    const m = /^seven_day_([a-z0-9]+)$/.exec(key)
    if (!m || typeof row?.utilization !== 'number') continue
    perModel.push({
      model: m[1],
      label: m[1].charAt(0).toUpperCase() + m[1].slice(1),
      input: 0,
      cacheCreate: 0,
      cacheRead: 0,
      output: 0,
      // Percent, not tokens: this source reports proportion and never counts.
      billed: row.utilization
    })
  }

  const windowFor = (spec: (typeof WINDOWS)[number], got: typeof five): UsageWindow => ({
    ...spec,
    used: got ? got.pct : 0,
    // 100 so `used` reads directly as the percentage it already is.
    limit: 100,
    pct: got ? Math.min(100, got.pct) : 0,
    resetsAt: got ? got.resetsAt : now,
    models: spec.id === 'week' ? perModel.sort((a, b) => b.billed - a.billed) : []
  })

  const report: UsageReport = {
    source: 'anthropic',
    at: now,
    tookMs: now - started,
    plan,
    tier,
    messages: 0,
    windows: [windowFor(WINDOWS[0], five), windowFor(WINDOWS[1], week)]
  }
  anthropicCache = { at: now, report }
  backoffMs = 0
  blockedUntil = 0
  return report
}

/**
 * The authenticated readout, rationed.
 *
 * Three things stand between a reader and the network, and each of them was
 * missing: an answer that is still good is handed back rather than asked for
 * again, readers arriving together share one request rather than making one
 * each, and a refusal is waited out rather than argued with.
 */
export async function anthropicUsage(): Promise<UsageReport> {
  const now = Date.now()

  if (anthropicCache && now - anthropicCache.at < ANTHROPIC_FRESH_MS) {
    return anthropicCache.report
  }

  if (now < blockedUntil) {
    // Anthropic asked to be left alone, so it is. The last good figures are
    // better than nothing; the transcripts are better than nothing at all.
    const wait = waitLabel(blockedUntil - now)
    if (anthropicCache) {
      return {
        ...anthropicCache.report,
        error: `Anthropic is limiting these checks. Showing the last figures; trying again in ${wait}.`
      }
    }
    return {
      ...(await localUsage()),
      error: `Anthropic is limiting these checks. Showing your transcripts; trying again in ${wait}.`
    }
  }

  if (anthropicInflight) return anthropicInflight
  anthropicInflight = requestAnthropicUsage().finally(() => {
    anthropicInflight = null
  })
  return anthropicInflight
}
