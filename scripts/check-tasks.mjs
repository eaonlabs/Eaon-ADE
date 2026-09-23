/*
 * Checks the work-item layer: PR/issue normalisation, the credential
 * boundary, and checking out an existing branch into a worktree.
 *
 * `gh` and `glab` are stubbed with scripts that print real captured payload
 * shapes — the point is to pin how those payloads are *mapped*, which is
 * where a wrong field name or an inverted draft flag would actually live.
 * Linear is exercised against a stub HTTP server rather than the real API,
 * so the GraphQL request shape and the "no key ever leaves" guarantee are
 * both checked without needing anyone's account.
 *
 *   node scripts/check-tasks.mjs
 */

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-tasks-'))
const binDir = path.join(tmp, 'bin')
fs.mkdirSync(binDir, { recursive: true })

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

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/* ---- canary: the Linear key must never appear in any reply -------------- */

const LINEAR_CANARY = 'lin_api_CANARY_must_never_leave_main_process'

/* ---- stub gh ------------------------------------------------------------ */

// Shapes taken from real `gh ... --json` output on a live repository.
const GH_PRS = JSON.stringify([
  {
    number: 1,
    title: 'Windows support',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/1',
    headRefName: 'windows-support',
    author: { login: 'sanscreates' },
    labels: [{ name: 'enhancement' }],
    updatedAt: '2026-08-05T10:00:00Z',
    reviewDecision: 'APPROVED',
    body: 'Adds a Windows build and a smoke test that installs it for real.'
  },
  {
    number: 2,
    title: 'Work in progress',
    state: 'OPEN',
    isDraft: true,
    url: 'https://github.com/o/r/pull/2',
    headRefName: 'wip-thing',
    author: { login: 'someone' },
    labels: [],
    updatedAt: '2026-08-06T10:00:00Z',
    // An empty string, not null — this is what real `gh` actually sends for a
    // PR nobody has reviewed, confirmed against a live repository. The stub
    // said null at first and hid a bug where the blank string reached the UI.
    reviewDecision: '',
    // Blank, not absent — a body real gh sends for a PR with no description.
    body: ''
  }
])
const GH_ISSUES = JSON.stringify([
  {
    number: 7,
    title: 'Crash when the window is resized twice',
    state: 'OPEN',
    url: 'https://github.com/o/r/issues/7',
    author: { login: 'reporter' },
    labels: [{ name: 'bug' }],
    updatedAt: '2026-08-04T10:00:00Z',
    body: 'Resize twice in quick succession and the whole window goes blank.'
  }
])


// A PR's changeset, in the exact shape `gh pr view --json ...files` sends —
// confirmed against a live repository, changeType included. One added file,
// one renamed one, so the diff-splitting logic below has both to chew on.
const GH_PR_VIEW = JSON.stringify({
  number: 1,
  title: 'Windows support',
  url: 'https://github.com/o/r/pull/1',
  baseRefName: 'main',
  additions: 44,
  deletions: 3,
  changedFiles: 2,
  files: [
    { path: 'src/main/index.ts', additions: 40, deletions: 0, changeType: 'ADDED' },
    { path: 'src/renamed-to.ts', additions: 4, deletions: 3, changeType: 'RENAMED' }
  ]
})

// A two-file unified diff with a rename, so path-splitting has to read the
// `b/` side of the header rather than the `a/` side — a renamed file's own
// two names differ, and the Files tab lists the *new* one.
const GH_PR_DIFF = [
  'diff --git a/src/main/index.ts b/src/main/index.ts',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/src/main/index.ts',
  '@@ -0,0 +1,2 @@',
  '+first file',
  '+second line',
  'diff --git a/src/renamed-from.ts b/src/renamed-to.ts',
  'similarity index 90%',
  'rename from src/renamed-from.ts',
  'rename to src/renamed-to.ts',
  '--- a/src/renamed-from.ts',
  '+++ b/src/renamed-to.ts',
  '@@ -1,3 +1,4 @@',
  ' kept line',
  '-old line',
  '+new line',
  '+added line'
].join('\n')

fs.writeFileSync(
  path.join(binDir, 'gh'),
  [
    '#!/bin/bash',
    `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then cat <<'JSON'`,
    GH_PRS,
    'JSON',
    'exit 0; fi',
    `if [ "$1" = "issue" ] && [ "$2" = "list" ]; then cat <<'JSON'`,
    GH_ISSUES,
    'JSON',
    'exit 0; fi',
    `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat <<'JSON'`,
    GH_PR_VIEW,
    'JSON',
    'exit 0; fi',
    `if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then cat <<'DIFF'`,
    GH_PR_DIFF,
    'DIFF',
    'exit 0; fi',
    'if [ "$1" = "pr" ] && [ "$2" = "review" ]; then',
    `  printf '%s\\0' "$@" > ${JSON.stringify(path.join(tmp, 'review-argv'))}`,
    '  if [ "$4" = "--comment" ]; then echo "Commented on pull request #$3"; exit 0; fi',
    '  if [ "$4" = "--request-changes" ]; then echo "Requested changes on pull request #$3"; exit 0; fi',
    '  echo "Approved pull request #$3"; exit 0; fi',
    'echo "unexpected gh invocation: $*" >&2; exit 1'
  ].join('\n')
)
fs.chmodSync(path.join(binDir, 'gh'), 0o755)

// glab deliberately absent for most of the run, to prove one provider being
// missing does not empty the panel.

/* ---- stub Linear -------------------------------------------------------- */

let lastLinearRequest = null
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    lastLinearRequest = { headers: req.headers, body: JSON.parse(body || '{}') }
    const query = lastLinearRequest.body.query || ''
    res.setHeader('content-type', 'application/json')
    if (query.includes('teams')) {
      res.end(JSON.stringify({ data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] } } }))
      return
    }
    if (query.includes('issueCreate')) {
      res.end(
        JSON.stringify({
          data: { issueCreate: { success: true, issue: { identifier: 'ENG-99', url: 'https://linear.app/x/ENG-99' } } }
        })
      )
      return
    }
    res.end(
      JSON.stringify({
        data: {
          issues: {
            nodes: [
              {
                id: 'i1',
                identifier: 'ENG-42',
                title: 'Ship the thing',
                url: 'https://linear.app/x/ENG-42',
                branchName: 'eng-42-ship-the-thing',
                updatedAt: '2026-08-07T10:00:00Z',
                state: { name: 'In Progress', type: 'started' },
                assignee: { displayName: 'Sam' },
                labels: { nodes: [{ name: 'feature' }] }
              },
              {
                id: 'i2',
                identifier: 'ENG-43',
                title: 'Old finished thing',
                url: 'https://linear.app/x/ENG-43',
                branchName: 'eng-43-old',
                updatedAt: '2026-08-01T10:00:00Z',
                state: { name: 'Shipped', type: 'completed' },
                assignee: null,
                labels: { nodes: [] }
              }
            ]
          }
        }
      })
    )
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const linearPort = server.address().port

/* ---- build the module under test ---------------------------------------- */

const outfile = path.join(tmp, 'tasks.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/tasks.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  // Point the Linear client at the stub server, and feed it a canary key
  // through the same accessor the real integrations module provides.
  define: {
    'process.env.__EAON_TEST_LINEAR_ENDPOINT': JSON.stringify(`http://127.0.0.1:${linearPort}/`)
  },
  plugins: [
    {
      name: 'stub-integrations',
      setup(b) {
        b.onResolve({ filter: /\/integrations$/ }, () => ({ path: 'integrations-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export function credentialFor(name) {
            return name === 'LINEAR_API_KEY' ? ${JSON.stringify(LINEAR_CANARY)} : undefined
          }`,
          loader: 'js'
        }))
      }
    }
  ]
})

// The endpoint is a module constant; rewrite it in the built bundle rather
// than adding a test-only parameter to the real source.
let bundled = fs.readFileSync(outfile, 'utf8')
bundled = bundled.replace('https://api.linear.app/graphql', `http://127.0.0.1:${linearPort}/`)
fs.writeFileSync(outfile, bundled)

const tasks = await import(outfile)

const oldPath = process.env.PATH
process.env.PATH = `${binDir}:${oldPath}`

try {
  /* ---- 1. GitHub mapping ------------------------------------------------- */

  console.log('\nGitHub payloads map onto WorkItem')
  const gh = await tasks.githubItems(tmp)
  check('no errors from the stubbed gh', gh.notes.length === 0, JSON.stringify(gh.notes))
  check('two PRs and one issue came through', gh.items.length === 3, gh.items.length)

  const pr1 = gh.items.find((i) => i.id === 'github:pr:1')
  check('a PR keeps its number as a #ref', pr1?.ref === '#1', pr1?.ref)
  check('a PR carries its real head branch', pr1?.branch === 'windows-support', pr1?.branch)
  check('and is marked as an existing branch, not a suggestion', pr1?.branchExists === true)
  check('its author is the login', pr1?.author === 'sanscreates', pr1?.author)
  check('labels are flattened to names', JSON.stringify(pr1?.labels) === '["enhancement"]', JSON.stringify(pr1?.labels))
  check('the review decision survives', pr1?.reviewDecision === 'APPROVED', pr1?.reviewDecision)
  check('an open PR reads as open', pr1?.tone === 'open', pr1?.tone)

  const pr2 = gh.items.find((i) => i.id === 'github:pr:2')
  check('a draft PR reads as draft even though its state is OPEN', pr2?.tone === 'draft', pr2?.tone)
  check('and says Draft rather than OPEN', pr2?.state === 'Draft', pr2?.state)
  check(
    "gh's empty-string reviewDecision becomes null, not a blank badge",
    pr2?.reviewDecision === null,
    JSON.stringify(pr2?.reviewDecision)
  )

  check('a PR carries its body', pr1?.body === 'Adds a Windows build and a smoke test that installs it for real.', pr1?.body)
  check("gh's empty-string body becomes null, not a blank paragraph", pr2?.body === null, JSON.stringify(pr2?.body))

  const issue = gh.items.find((i) => i.id === 'github:issue:7')
  check('an issue has no real branch, so one is suggested', issue?.branchExists === false)
  check('an issue carries its body too', issue?.body === 'Resize twice in quick succession and the whole window goes blank.', issue?.body)
  check(
    'the suggestion is derived from its number and title',
    issue?.branch === 'eaon/7-crash-when-the-window-is-resized-twice',
    issue?.branch
  )

  /* ---- 2. Linear mapping and the credential boundary --------------------- */

  console.log('\nLinear, and the key that must not travel')
  const lin = await tasks.linearItems()
  check('no errors from the stubbed Linear', lin.notes.length === 0, JSON.stringify(lin.notes))
  check('both issues came through', lin.items.length === 2, lin.items.length)

  const eng42 = lin.items.find((i) => i.ref === 'ENG-42')
  check('a Linear identifier is used verbatim as the ref', Boolean(eng42))
  check('a "started" workflow state reads as open', eng42?.tone === 'open', eng42?.tone)
  check('the state name is shown as the team wrote it', eng42?.state === 'In Progress', eng42?.state)
  check("Linear's own generated branch name is used", eng42?.branch === 'eng-42-ship-the-thing', eng42?.branch)
  check('the assignee becomes the author column', eng42?.author === 'Sam', eng42?.author)

  const eng43 = lin.items.find((i) => i.ref === 'ENG-43')
  check('a "completed" state reads as merged regardless of its name', eng43?.tone === 'merged', eng43?.tone)

  check('the key was sent as an Authorization header', lastLinearRequest?.headers?.authorization === LINEAR_CANARY)
  check(
    'no Bearer prefix — Linear personal keys go raw',
    !String(lastLinearRequest?.headers?.authorization).startsWith('Bearer')
  )
  const linWire = JSON.stringify(lin)
  check('the key does not appear anywhere in the returned items', !linWire.includes(LINEAR_CANARY))

  const teams = await tasks.linearTeams()
  check('teams come back for the selector', teams.length === 1 && teams[0].key === 'ENG', JSON.stringify(teams))
  check('the teams reply carries no key either', !JSON.stringify(teams).includes(LINEAR_CANARY))

  const created = await tasks.createLinearIssue({ teamId: 't1', title: 'From Eaon', description: 'body' })
  check('creating an issue succeeds', created.ok, created.message)
  check('and reports the new identifier', created.message.includes('ENG-99'), created.message)
  check('the create reply carries no key', !JSON.stringify(created).includes(LINEAR_CANARY))
  check(
    'the mutation sent the team id it was given',
    lastLinearRequest?.body?.variables?.teamId === 't1',
    JSON.stringify(lastLinearRequest?.body?.variables)
  )

  /* ---- 3. a missing provider does not empty the panel -------------------- */

  console.log('\none provider being missing is survivable')
  const all = await tasks.allItems(tmp)
  check('GitHub and Linear items are both present', all.items.length === 5, all.items.length)
  check('glab, which is not installed, is reported rather than silent', all.notes.some((n) => n.provider === 'gitlab'))
  // PRs and issues are fetched separately, so a missing CLI fails twice.
  // Saying the same sentence twice reads as two different faults.
  check(
    'a provider that failed twice is only reported once',
    all.notes.filter((n) => n.provider === 'gitlab').length === 1,
    JSON.stringify(all.notes.filter((n) => n.provider === 'gitlab'))
  )
  check(
    'and the message names the tool to install',
    all.notes.find((n) => n.provider === 'gitlab')?.message === 'glab is not on your PATH.',
    all.notes.find((n) => n.provider === 'gitlab')?.message
  )
  check(
    'items are sorted newest first',
    all.items[0].updatedAt >= all.items[all.items.length - 1].updatedAt,
    all.items.map((i) => i.updatedAt).join(' ')
  )

  /* ---- 3b. ENOENT means two different things ----------------------------- */

  console.log('\na dead folder and a missing tool are told apart')
  // Node reports ENOENT for both "binary not on PATH" and "cwd is gone", and
  // reporting the wrong one sends the user to install a tool they already
  // have. Caught live: the panel said "spawn gh ENOENT" for a workspace whose
  // folder had been deleted, while gh was installed and working fine.
  const deadFolder = await tasks.githubItems(path.join(tmp, 'no-such-folder'))
  check(
    'a missing working folder is reported as a missing folder',
    deadFolder.notes[0]?.message === 'That workspace folder no longer exists.',
    deadFolder.notes[0]?.message
  )
  check(
    'and not blamed on the tool, which is installed',
    !/PATH/.test(deadFolder.notes[0]?.message ?? ''),
    deadFolder.notes[0]?.message
  )

  /* ---- 4. approving a PR ------------------------------------------------- */

  console.log('\napproving a pull request')
  const approved = await tasks.approvePr(tmp, 1, 'Looks right to me')
  check('approve reports success', approved.ok, approved.message)
  const reviewArgv = fs
    .readFileSync(path.join(tmp, 'review-argv'), 'utf8')
    .split('\0')
    .filter(Boolean)
  check('it called gh pr review --approve', reviewArgv.includes('--approve'), JSON.stringify(reviewArgv))
  check('on the right number', reviewArgv.includes('1'))
  check('with the body it was given', reviewArgv.includes('Looks right to me'))

  /* ---- 4b. a pull request's changeset, for the review panel ------------- */

  console.log("\na pull request's changeset, for the review panel")
  const detail = await tasks.prDetail(tmp, 1)
  check('no error came back', !('error' in detail), JSON.stringify(detail))
  check('the diffstat survives', detail.additions === 44 && detail.deletions === 3, JSON.stringify(detail))
  check('base branch is included, for the "-> main" chip', detail.baseRefName === 'main', detail.baseRefName)
  check('files keep their per-file counts and change kind', detail.files?.[0]?.changeType === 'ADDED', JSON.stringify(detail.files))
  check(
    'a bad PR number is reported, not thrown',
    'error' in (await tasks.prDetail(path.join(tmp, 'no-such-folder'), 1))
  )

  const diffs = await tasks.prDiff(tmp, 1)
  check('the added file is keyed by its own path', typeof diffs['src/main/index.ts'] === 'string', Object.keys(diffs))
  check(
    'its patch is the one addressed to it, not the other file',
    diffs['src/main/index.ts']?.includes('+first file') && !diffs['src/main/index.ts']?.includes('kept line'),
    diffs['src/main/index.ts']
  )
  check(
    "a renamed file is keyed by its NEW path — the one Files lists — not the old one",
    typeof diffs['src/renamed-to.ts'] === 'string' && diffs['src/renamed-from.ts'] === undefined,
    Object.keys(diffs)
  )
  check(
    "the renamed file's own hunk is intact",
    diffs['src/renamed-to.ts']?.includes('+new line') && diffs['src/renamed-to.ts']?.includes('+added line'),
    diffs['src/renamed-to.ts']
  )

  /* ---- 4c. leaving a review ----------------------------------------------- */

  console.log('\nleaving a review — comment and request changes, not just approve')
  fs.rmSync(path.join(tmp, 'review-argv'), { force: true })
  const commented = await tasks.reviewPr(tmp, 1, 'comment', 'Left a note inline.')
  check('a comment review reports success', commented.ok, commented.message)
  const commentArgv = fs.readFileSync(path.join(tmp, 'review-argv'), 'utf8').split('\0').filter(Boolean)
  check('it called gh pr review --comment', commentArgv.includes('--comment'), JSON.stringify(commentArgv))

  fs.rmSync(path.join(tmp, 'review-argv'), { force: true })
  const requested = await tasks.reviewPr(tmp, 1, 'request-changes', 'Please add a test.')
  check('a request-changes review reports success', requested.ok, requested.message)
  const requestArgv = fs.readFileSync(path.join(tmp, 'review-argv'), 'utf8').split('\0').filter(Boolean)
  check(
    'it called gh pr review --request-changes',
    requestArgv.includes('--request-changes'),
    JSON.stringify(requestArgv)
  )

  const emptyComment = await tasks.reviewPr(tmp, 1, 'comment', '   ')
  check('a comment with nothing written in it is refused', emptyComment.ok === false, JSON.stringify(emptyComment))
  check(
    'refused before gh is ever called, not by gh itself failing',
    emptyComment.message === 'A comment needs something written in it.',
    emptyComment.message
  )
} finally {
  process.env.PATH = oldPath
  server.close()
}

/* ---- 5. checking out an existing branch into a worktree ----------------- */

console.log('\nopening a worktree on a branch that already exists')

const wtOut = path.join(tmp, 'worktrees.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/worktrees.ts')],
  outfile: wtOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const wt = await import(wtOut)
wt.setBaseDir(path.join(tmp, 'trees'))

const repo = path.join(tmp, 'project')
fs.mkdirSync(repo, { recursive: true })
git(repo, 'init', '-b', 'main')
git(repo, 'config', 'user.email', 't@e.com')
git(repo, 'config', 'user.name', 'T')
fs.writeFileSync(path.join(repo, 'app.js'), 'export const answer = 0\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'initial')

// A branch that already exists locally, with work on it — standing in for a
// pull request's head branch after a fetch.
git(repo, 'checkout', '-q', '-b', 'feature/login')
fs.writeFileSync(path.join(repo, 'app.js'), 'export const answer = 1\n')
git(repo, 'commit', '-qam', 'work on the feature')
const featureTip = git(repo, 'rev-parse', 'HEAD').trim()
git(repo, 'checkout', '-q', 'main')

const opened = await wt.create({ cwd: repo, branch: 'feature/login', existing: true })
check('a worktree opens on the existing branch', opened.ok, opened.error)
check(
  'it checked out that branch, not a fresh one from HEAD',
  fs.readFileSync(path.join(opened.worktree.path, 'app.js'), 'utf8').includes('answer = 1')
)
check('and it is on the branch itself', opened.worktree.branch === 'feature/login', opened.worktree.branch)
check(
  "the base is the branch's own tip, so \"what changed\" means what you do next",
  opened.baseSha === featureTip,
  `${opened.baseSha} vs ${featureTip}`
)
const freshChange = await wt.change(opened.worktree.path, opened.baseSha)
check('so a freshly opened PR worktree reads as unchanged', freshChange.filesChanged === 0 && !freshChange.dirty)

const missing = await wt.create({ cwd: repo, branch: 'no/such/branch', existing: true })
check('asking for a branch that does not exist fails clearly', !missing.ok, missing.error)
check(
  'and says so rather than inventing one',
  /not here or on origin/.test(missing.error || ''),
  missing.error
)

// The ordinary path must be untouched by any of this.
const fresh = await wt.create({ cwd: repo, branch: 'eaon/brand-new' })
check('cutting a brand-new branch still works', fresh.ok, fresh.error)
check(
  'and starts from HEAD as it always did',
  fs.readFileSync(path.join(fresh.worktree.path, 'app.js'), 'utf8').includes('answer = 0')
)

/* ---- 6. promptForWorkItem, pure -------------------------------------------
 * What an agent actually reads once `openWorkItem`'s worktree is open. No
 * stub needed — it touches nothing but its argument — so it is bundled on
 * its own straight from shared/tasks.ts rather than through the gh-flavoured
 * module above.
 */

console.log("\nwhat an agent is told, once a PR's worktree is open")
const sharedOut = path.join(tmp, 'shared-tasks.mjs')
await build({
  entryPoints: [path.join(root, 'src/shared/tasks.ts')],
  outfile: sharedOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const shared = await import(sharedOut)

const prPrompt = shared.promptForWorkItem({
  kind: 'pr',
  ref: '#12',
  title: 'Windows support',
  body: 'Adds a Windows build.',
  url: 'https://github.com/o/r/pull/12'
})
check('a PR is framed as something to review', prPrompt.startsWith('Review and address pull request #12'), prPrompt)
check('the body is carried along', prPrompt.includes('Adds a Windows build.'), prPrompt)
check('so is a link back, for anything the prompt could not say', prPrompt.includes('https://github.com/o/r/pull/12'), prPrompt)

const issuePrompt = shared.promptForWorkItem({
  kind: 'issue',
  ref: '#7',
  title: 'Crash on resize',
  body: null,
  url: 'https://github.com/o/r/issues/7'
})
check('an issue is framed as something to work on, not review', issuePrompt.startsWith('Work on issue #7'), issuePrompt)
check('a missing body is just left out, not printed as "null"', !issuePrompt.includes('null'), issuePrompt)

const longBody = 'x'.repeat(2000)
const trimmedPrompt = shared.promptForWorkItem({
  kind: 'pr',
  ref: '#1',
  title: 'Big',
  body: longBody,
  url: 'https://github.com/o/r/pull/1'
})
check(
  "a runaway description is capped, not sent whole into the agent's prompt",
  trimmedPrompt.length < longBody.length,
  trimmedPrompt.length
)

/* ---- done ---------------------------------------------------------------- */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
