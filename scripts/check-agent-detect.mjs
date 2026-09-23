/*
 * Checks the "what is running in this pane right now" detection behind the
 * pane header's mark and name.
 *
 * The header used to show whatever the pane was *opened* as, forever. Close
 * Codex, type `opencode`, and it still claimed Codex. This is the matcher that
 * fixes that, tested against the shapes real CLIs actually take in `ps` —
 * a compiled binary is its own argv[0], an npm-installed one is `node
 * /path/to/thing`, and a folder that merely has an agent's name in it is
 * neither.
 *
 *   node scripts/check-agent-detect.mjs
 */

import { build } from 'esbuild'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

const outfile = path.join(os.tmpdir(), `agent-detect-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(root, 'src/main/session-watch.ts')],
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
          contents: `export const app = { getPath: () => ${JSON.stringify(os.tmpdir())} }`,
          loader: 'js'
        }))
      }
    }
  ]
})
const { runningAgentOf, anyAgentUnder, agentOf } = await import(outfile)

console.log('\nthe shapes a real CLI takes in ps')
check('a compiled binary is its own argv[0]', runningAgentOf('/usr/local/bin/opencode') === 'opencode')
check('with arguments after it', runningAgentOf('/usr/local/bin/opencode --port 3000') === 'opencode')
check('an npm CLI runs under node', runningAgentOf('node /Users/x/.nvm/bin/codex') === 'codex')
check('…and under bun', runningAgentOf('bun /Users/x/bin/kimi') === 'kimi')
check('a bare name on PATH', runningAgentOf('claude') === 'claude')
check('grok', runningAgentOf('/opt/homebrew/bin/grok --always-approve') === 'grok')
check("mistral's binary is `vibe`, not `mistral`", runningAgentOf('vibe --trust') === 'mistral')

console.log('\nwhat must NOT be mistaken for an agent')
// The whole reason matching is on words rather than a substring search.
check(
  'a shell sitting in a folder named after an agent',
  runningAgentOf('-zsh /Users/x/projects/codex-rewrite') === null,
  runningAgentOf('-zsh /Users/x/projects/codex-rewrite')
)
check('a plain login shell', runningAgentOf('-zsh') === null)
check('an editor that merely mentions one', runningAgentOf('vim claude.md') === null)
check('bash is not a runtime that fronts an agent', runningAgentOf('/bin/bash /tmp/codex') === null)
check('an unknown binary', runningAgentOf('/usr/bin/top') === null)

console.log('\nit sees every agent, not only the resumable ones')
// `agentOf` answers "can this pane's conversation be reopened" and only Claude
// can, so it is deliberately narrow. The header asks a different question.
check('agentOf still recognises claude', agentOf('claude') === 'claude')
check('agentOf ignores opencode, by design', agentOf('/usr/local/bin/opencode') === null)
check('runningAgentOf does not', runningAgentOf('/usr/local/bin/opencode') === 'opencode')

console.log('\nwalking down from the pane shell')
const tree = (rows) => {
  const kids = new Map()
  for (const r of rows) {
    const list = kids.get(r.ppid)
    if (list) list.push(r)
    else kids.set(r.ppid, [r])
  }
  return kids
}
// shell 100 -> npm 200 -> the agent 300
check(
  'found several levels below the shell',
  anyAgentUnder(100, tree([
    { pid: 200, ppid: 100, args: '/bin/sh -c opencode' },
    { pid: 300, ppid: 200, args: '/usr/local/bin/opencode' }
  ])) === 'opencode'
)
check(
  'nothing under a shell that is just a shell',
  anyAgentUnder(100, tree([{ pid: 200, ppid: 100, args: 'vim notes.md' }])) === null
)
// An agent that spawns a nested copy of itself is common; the outer one is the
// pane's, which is what breadth-first guarantees.
check(
  'the outer agent wins over one it spawned',
  anyAgentUnder(100, tree([
    { pid: 200, ppid: 100, args: '/usr/local/bin/claude' },
    { pid: 300, ppid: 200, args: '/usr/local/bin/opencode' }
  ])) === 'claude'
)
check(
  'a cycle does not hang the walk',
  anyAgentUnder(100, tree([
    { pid: 200, ppid: 100, args: 'sh' },
    { pid: 100, ppid: 200, args: 'sh' }
  ])) === null
)
check('an empty table is simply nothing', anyAgentUnder(100, tree([])) === null)

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
