import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  branchNameFor,
  toneOfGithubIssue,
  toneOfGithubPr,
  toneOfLinear,
  type LinearTeam,
  type PrDetail,
  type PrFile,
  type TaskFetch,
  type WorkItem
} from '../shared/tasks'
import { credentialFor } from './integrations'

const run = promisify(execFile)

/**
 * Pull requests, issues and Linear tickets, fetched where they live.
 *
 * GitHub and GitLab go through their own CLIs rather than their REST APIs,
 * for the same reason the integrations layer proves connectivity that way:
 * `gh` already holds a refreshable token, already knows which repository the
 * working directory belongs to, and already handles GitHub Enterprise hosts.
 * Re-implementing any of that against raw HTTP would be a second, worse copy
 * of something the user has already set up.
 *
 * Linear has no CLI, so it is the one provider spoken to directly — over its
 * GraphQL API, with a key read from the integrations module. That key stays
 * in this process: it is used to set a header and is never part of anything
 * returned to a caller.
 */

const CLI_TIMEOUT_MS = 20_000
const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'

/** How many of each kind to ask for. A panel nobody scrolls needs no more. */
const PAGE = 30

/**
 * A failure a person can act on.
 *
 * `ENOENT` from `execFile` means one of two completely different things —
 * the binary is not on PATH, or the working directory does not exist — and
 * Node gives the same message for both. Reporting "spawn gh ENOENT" for a
 * workspace whose folder was deleted sends the user off to install a tool
 * they already have, so the two cases are separated here by asking the
 * filesystem which one it actually was.
 */
function explain(err: unknown, bin: string, cwd: string): string {
  const e = err as { code?: string; stderr?: string; stdout?: string; message?: string }
  if (e.code === 'ENOENT') {
    return existsSync(cwd)
      ? `${bin} is not on your PATH.`
      : 'That workspace folder no longer exists.'
  }
  const text = (e.stderr || e.stdout || e.message || String(err)).trim()
  return text.split('\n')[0].slice(0, 200)
}

/**
 * One note per distinct problem.
 *
 * Pull requests and issues are fetched separately, so a missing CLI or a
 * dead folder fails twice and would otherwise be reported twice — the same
 * sentence, stacked, which reads like two different faults.
 */
function dedupe(notes: TaskFetch['notes']): TaskFetch['notes'] {
  const seen = new Set<string>()
  return notes.filter((n) => {
    const key = `${n.provider}:${n.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/* ------------------------------------------------------------------------ *
 * GitHub, through gh
 * ------------------------------------------------------------------------ */

interface GhAuthor {
  login?: string
  name?: string
}

interface GhPr {
  number: number
  title: string
  state: string
  isDraft: boolean
  url: string
  headRefName: string
  author?: GhAuthor | null
  labels?: { name: string }[]
  updatedAt?: string
  reviewDecision?: string | null
  body?: string
}

interface GhIssue {
  number: number
  title: string
  state: string
  url: string
  author?: GhAuthor | null
  labels?: { name: string }[]
  updatedAt?: string
  body?: string
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

export async function githubItems(cwd: string): Promise<TaskFetch> {
  const items: WorkItem[] = []
  const notes: TaskFetch['notes'] = []

  try {
    const out = await gh(cwd, [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      String(PAGE),
      '--json',
      'number,title,state,isDraft,url,headRefName,author,labels,updatedAt,reviewDecision,body'
    ])
    for (const pr of JSON.parse(out || '[]') as GhPr[]) {
      items.push({
        id: `github:pr:${pr.number}`,
        provider: 'github',
        kind: 'pr',
        ref: `#${pr.number}`,
        title: pr.title,
        state: pr.isDraft ? 'Draft' : pr.state,
        tone: toneOfGithubPr(pr.state, pr.isDraft),
        author: pr.author?.login ?? null,
        url: pr.url,
        // A PR's head branch is real and already pushed, so a worktree can
        // check it out rather than inventing a name.
        branch: pr.headRefName,
        branchExists: true,
        labels: (pr.labels ?? []).map((l) => l.name),
        updatedAt: pr.updatedAt ?? null,
        // `||`, not `??`: gh sends an empty string — not null — for a PR
        // nobody has reviewed, and `?? null` would let that through to be
        // rendered as a blank review badge.
        reviewDecision: pr.reviewDecision || null,
        body: pr.body?.trim() || null
      })
    }
  } catch (err) {
    notes.push({ provider: 'github', message: explain(err, 'gh', cwd) })
  }

  try {
    const out = await gh(cwd, [
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      String(PAGE),
      '--json',
      'number,title,state,url,author,labels,updatedAt,body'
    ])
    for (const issue of JSON.parse(out || '[]') as GhIssue[]) {
      const base = { ref: `#${issue.number}`, title: issue.title }
      items.push({
        id: `github:issue:${issue.number}`,
        provider: 'github',
        kind: 'issue',
        ...base,
        state: issue.state,
        tone: toneOfGithubIssue(issue.state),
        author: issue.author?.login ?? null,
        url: issue.url,
        // Nothing exists yet — this is a suggestion for a branch to cut.
        branch: branchNameFor(base),
        branchExists: false,
        labels: (issue.labels ?? []).map((l) => l.name),
        updatedAt: issue.updatedAt ?? null,
        reviewDecision: null,
        body: issue.body?.trim() || null
      })
    }
  } catch (err) {
    notes.push({ provider: 'github', message: explain(err, 'gh', cwd) })
  }

  return { items, notes: dedupe(notes) }
}

/**
 * Approve a pull request.
 *
 * Deliberately the only write this module performs against a repository, and
 * deliberately not wired to anything that could fire without an explicit
 * click — approving someone's code is a statement made in your name.
 */
export async function approvePr(
  cwd: string,
  number: number,
  body?: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const args = ['pr', 'review', String(number), '--approve']
    if (body?.trim()) args.push('--body', body.trim())
    const out = await gh(cwd, args)
    return { ok: true, message: out.trim() || `Approved #${number}.` }
  } catch (err) {
    return { ok: false, message: explain(err, 'gh', cwd) }
  }
}

/**
 * Pull requests at a chosen state, for the Pull requests page.
 *
 * Deliberately NOT a widening of `githubItems`. That list answers "what should
 * I pick up", so open-only is correct there — a merged PR in it is noise you
 * cannot act on. This page asks a different question ("show me this repo's
 * pull requests"), and its Merged tab could never fill while the only fetch in
 * the module was `--state open`: the rows were not being filtered out in the
 * renderer, they were never fetched. Found by the session that built the page.
 */
export async function pullRequests(
  cwd: string,
  state: 'open' | 'merged' | 'all'
): Promise<TaskFetch> {
  const items: WorkItem[] = []
  const notes: TaskFetch['notes'] = []
  try {
    const out = await gh(cwd, [
      'pr',
      'list',
      '--state',
      state,
      '--limit',
      String(PAGE),
      '--json',
      'number,title,state,isDraft,url,headRefName,author,labels,updatedAt,reviewDecision,body'
    ])
    for (const pr of JSON.parse(out || '[]') as GhPr[]) {
      items.push({
        id: `github:pr:${pr.number}`,
        provider: 'github',
        kind: 'pr',
        ref: `#${pr.number}`,
        title: pr.title,
        state: pr.isDraft ? 'Draft' : pr.state,
        tone: toneOfGithubPr(pr.state, pr.isDraft),
        author: pr.author?.login ?? null,
        url: pr.url,
        branch: pr.headRefName,
        branchExists: true,
        labels: (pr.labels ?? []).map((l) => l.name),
        updatedAt: pr.updatedAt ?? null,
        reviewDecision: pr.reviewDecision || null,
        body: pr.body?.trim() || null
      })
    }
  } catch (err) {
    notes.push({ provider: 'github', message: explain(err, 'gh', cwd) })
  }
  return { items, notes: dedupe(notes) }
}

/**
 * A pull request's changeset — the diffstat and the per-file breakdown,
 * for the review panel's Files tab. One `gh pr view` call; the byte-for-byte
 * same shape `gh` already hands back, so nothing here reinterprets it.
 */
export async function prDetail(cwd: string, number: number): Promise<PrDetail | { error: string }> {
  try {
    const out = await gh(cwd, [
      'pr',
      'view',
      String(number),
      '--json',
      'number,title,url,baseRefName,additions,deletions,changedFiles,files'
    ])
    return JSON.parse(out) as PrDetail & { files: PrFile[] }
  } catch (err) {
    return { error: explain(err, 'gh', cwd) }
  }
}

/**
 * A pull request's full diff, split into one entry per file.
 *
 * `gh pr diff` has no way to ask for a single file's patch — the whole
 * changeset comes back as one unified diff, `diff --git a/<path> b/<path>`
 * headers marking where each file starts. Split on that boundary rather than
 * re-fetching per file: the Files tab already lists every path from
 * {@link prDetail}, and asking `gh` once for the lot is one round trip
 * instead of N.
 *
 * A renamed file's header reads `diff --git a/<old> b/<new>` — the *new*
 * path is what the Files tab lists (that is what `gh pr view --json files`
 * calls `path`), so the key is taken from the `b/` side.
 */
export async function prDiff(cwd: string, number: number): Promise<Record<string, string>> {
  const out = await gh(cwd, ['pr', 'diff', String(number)])
  const byFile: Record<string, string> = {}
  const header = /^diff --git a\/.*? b\/(.*)$/
  let path: string | null = null
  let lines: string[] = []
  const flush = (): void => {
    if (path) byFile[path] = lines.join('\n')
  }
  for (const line of out.split('\n')) {
    const m = header.exec(line)
    if (m) {
      flush()
      path = m[1]
      lines = [line]
    } else {
      lines.push(line)
    }
  }
  flush()
  return byFile
}

/**
 * Leave a review — approve, request changes, or just comment — on a pull
 * request. `approvePr` above is the one write this module made before this
 * panel existed; this is its general form, for the Review tab's three
 * buttons. Left as a sibling rather than rewriting `approvePr` in terms of
 * it, so the existing call site keeps working exactly as it did.
 */
export async function reviewPr(
  cwd: string,
  number: number,
  event: 'approve' | 'comment' | 'request-changes',
  body?: string
): Promise<{ ok: boolean; message: string }> {
  const flag = event === 'approve' ? '--approve' : event === 'comment' ? '--comment' : '--request-changes'
  const args = ['pr', 'review', String(number), flag]
  if (body?.trim()) args.push('--body', body.trim())
  // A plain comment needs *something* said — gh itself refuses an empty body
  // for --comment, and failing here with a clear reason beats a bare exec error.
  if (event === 'comment' && !body?.trim()) {
    return { ok: false, message: 'A comment needs something written in it.' }
  }
  try {
    const out = await gh(cwd, args)
    const verb = event === 'approve' ? 'Approved' : event === 'request-changes' ? 'Requested changes on' : 'Commented on'
    return { ok: true, message: out.trim() || `${verb} #${number}.` }
  } catch (err) {
    return { ok: false, message: explain(err, 'gh', cwd) }
  }
}

/* ------------------------------------------------------------------------ *
 * GitLab, through glab
 * ------------------------------------------------------------------------ */

interface GlabMr {
  iid: number
  title: string
  state: string
  web_url: string
  source_branch: string
  draft?: boolean
  work_in_progress?: boolean
  author?: { username?: string } | null
  labels?: string[]
  updated_at?: string
  description?: string
}

interface GlabIssue {
  iid: number
  title: string
  state: string
  web_url: string
  author?: { username?: string } | null
  labels?: string[]
  updated_at?: string
  description?: string
}

/**
 * glab's JSON is the GitLab REST payload passed straight through, so the
 * field names here are snake_case and quite different from gh's — one more
 * reason everything is normalised into WorkItem before it leaves this file.
 */
export async function gitlabItems(cwd: string): Promise<TaskFetch> {
  const items: WorkItem[] = []
  const notes: TaskFetch['notes'] = []

  const call = async (args: string[]): Promise<string> => {
    const { stdout } = await run('glab', args, {
      cwd,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    })
    return stdout
  }

  try {
    const out = await call(['mr', 'list', '--output', 'json', '--per-page', String(PAGE)])
    for (const mr of JSON.parse(out || '[]') as GlabMr[]) {
      const draft = Boolean(mr.draft ?? mr.work_in_progress)
      items.push({
        id: `gitlab:pr:${mr.iid}`,
        provider: 'gitlab',
        kind: 'pr',
        ref: `!${mr.iid}`,
        title: mr.title,
        state: draft ? 'Draft' : mr.state,
        tone: draft ? 'draft' : mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
        author: mr.author?.username ?? null,
        url: mr.web_url,
        branch: mr.source_branch,
        branchExists: true,
        labels: mr.labels ?? [],
        updatedAt: mr.updated_at ?? null,
        reviewDecision: null,
        body: mr.description?.trim() || null
      })
    }
  } catch (err) {
    notes.push({ provider: 'gitlab', message: explain(err, 'glab', cwd) })
  }

  try {
    const out = await call(['issue', 'list', '--output', 'json', '--per-page', String(PAGE)])
    for (const issue of JSON.parse(out || '[]') as GlabIssue[]) {
      const base = { ref: `#${issue.iid}`, title: issue.title }
      items.push({
        id: `gitlab:issue:${issue.iid}`,
        provider: 'gitlab',
        kind: 'issue',
        ...base,
        state: issue.state,
        tone: issue.state === 'closed' ? 'closed' : 'open',
        author: issue.author?.username ?? null,
        url: issue.web_url,
        branch: branchNameFor(base),
        branchExists: false,
        labels: issue.labels ?? [],
        updatedAt: issue.updated_at ?? null,
        reviewDecision: null,
        body: issue.description?.trim() || null
      })
    }
  } catch (err) {
    notes.push({ provider: 'gitlab', message: explain(err, 'glab', cwd) })
  }

  return { items, notes: dedupe(notes) }
}

/* ------------------------------------------------------------------------ *
 * Linear, over GraphQL
 * ------------------------------------------------------------------------ */

/**
 * One GraphQL round trip.
 *
 * The API key is read at call time and used only as a header value. It is
 * never returned, never logged, and never part of the thrown error — the
 * error text is deliberately the response status and Linear's own message,
 * both of which are safe to show.
 */
async function linear<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const key = credentialFor('LINEAR_API_KEY')
  if (!key) throw new Error('LINEAR_API_KEY is not set.')

  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Personal API keys go in raw; only OAuth tokens take a Bearer prefix.
      authorization: key
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(CLI_TIMEOUT_MS)
  })

  if (!res.ok) throw new Error(`Linear replied ${res.status}.`)
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(json.errors[0].message)
  if (!json.data) throw new Error('Linear returned no data.')
  return json.data
}

interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  url: string
  branchName: string
  updatedAt: string
  state: { name: string; type: string }
  assignee: { displayName?: string; name?: string } | null
  labels: { nodes: { name: string }[] }
  description: string | null
}

export async function linearItems(): Promise<TaskFetch> {
  const items: WorkItem[] = []
  const notes: TaskFetch['notes'] = []

  try {
    const data = await linear<{ issues: { nodes: LinearIssueNode[] } }>(
      `query Assigned($first: Int!) {
        issues(first: $first, filter: { completedAt: { null: true }, canceledAt: { null: true } }) {
          nodes {
            id identifier title url branchName updatedAt description
            state { name type }
            assignee { displayName name }
            labels { nodes { name } }
          }
        }
      }`,
      { first: PAGE }
    )

    for (const node of data.issues.nodes) {
      items.push({
        id: `linear:issue:${node.identifier}`,
        provider: 'linear',
        kind: 'issue',
        ref: node.identifier,
        title: node.title,
        state: node.state.name,
        tone: toneOfLinear(node.state.type),
        author: node.assignee?.displayName ?? node.assignee?.name ?? null,
        url: node.url,
        // Linear generates a branch name per issue. It is a suggestion until
        // someone actually pushes it, which is exactly what branchExists says.
        branch: node.branchName || null,
        branchExists: false,
        labels: node.labels.nodes.map((l) => l.name),
        updatedAt: node.updatedAt,
        reviewDecision: null,
        body: node.description?.trim() || null
      })
    }
  } catch (err) {
    notes.push({ provider: 'linear', message: err instanceof Error ? err.message : String(err) })
  }

  return { items, notes: dedupe(notes) }
}

export async function linearTeams(): Promise<LinearTeam[]> {
  try {
    const data = await linear<{ teams: { nodes: LinearTeam[] } }>(
      `query { teams(first: 50) { nodes { id key name } } }`
    )
    return data.teams.nodes
  } catch {
    return []
  }
}

export async function createLinearIssue(input: {
  teamId: string
  title: string
  description?: string
}): Promise<{ ok: boolean; message: string; url?: string }> {
  try {
    const data = await linear<{
      issueCreate: { success: boolean; issue: { identifier: string; url: string } | null }
    }>(
      `mutation New($teamId: String!, $title: String!, $description: String) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
          success
          issue { identifier url }
        }
      }`,
      { teamId: input.teamId, title: input.title, description: input.description || undefined }
    )
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      return { ok: false, message: 'Linear refused the issue.' }
    }
    return {
      ok: true,
      message: `Created ${data.issueCreate.issue.identifier}.`,
      url: data.issueCreate.issue.url
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------------------------------------------------ *
 * Everything at once
 * ------------------------------------------------------------------------ */

/**
 * Every provider, in parallel, with failures kept rather than thrown.
 *
 * One provider being unreachable — no `gh`, no Linear key, a repo with no
 * remote — must not empty the whole panel. Each contributes what it has and
 * explains what it could not do.
 */
export async function allItems(cwd: string): Promise<TaskFetch> {
  const [github, gitlab, linearRes] = await Promise.all([
    githubItems(cwd),
    gitlabItems(cwd),
    linearItems()
  ])

  const merged: TaskFetch = {
    items: [...github.items, ...gitlab.items, ...linearRes.items],
    notes: dedupe([...github.notes, ...gitlab.notes, ...linearRes.notes])
  }

  // Newest first, undated last — a list ordered by provider would bury the
  // thing you touched five minutes ago underneath a stale backlog.
  merged.items.sort((a, b) => {
    if (!a.updatedAt && !b.updatedAt) return 0
    if (!a.updatedAt) return 1
    if (!b.updatedAt) return -1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return merged
}
