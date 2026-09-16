import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { AGENTS, SESSION_FLAGS } from '../shared/types'
import { projectSlug, projectsRoot, sessionsRoot } from './sessions'
import type { PaneSessions } from './pane-sessions'

const exec = promisify(execFile)

/**
 * Working out which conversation each pane is holding.
 *
 * Almost no session is started by the app. You open a plain shell and type
 * `claude`, and nothing in the pane's record — created as a shell, with no
 * agent and no command — ever learns otherwise. On the next launch that pane
 * faithfully restores what was saved, which is a bare shell, and the work is
 * gone. Watching for it is the only way to know.
 *
 * The link from a pane to a conversation cannot be read off disk. A transcript
 * records the folder, the branch and the model, but nothing about the terminal
 * it was typed into — no pid, no tty — and on this machine the process table
 * will not surrender another process's environment either, so the marker the
 * pane's shell carries cannot be read back out of the agent beneath it. What
 * the app does have is the pane's own shell: it spawned it and knows its pid.
 * So the agent is found by walking down from there, and the conversation is
 * identified in one of three ways, in this order of confidence:
 *
 *   1. The agent says so. Claude Code writes `sessions/<pid>.json` under its
 *      configuration directory naming the conversation that process holds.
 *      Written by the process about itself, so it is exact.
 *   2. The command line names it — `--resume` or `--session-id`.
 *   3. A transcript appears that was not there when the agent started.
 *
 * The third came first and was, on its own, wrong about the case that matters
 * most. It can only recognise a conversation that *begins* while something is
 * watching, and the sessions people actually want back are the ones that have
 * been running for hours: their transcripts were already on disk before the app
 * opened, so no arrival ever came and eleven panes out of fifteen were restored
 * as bare shells. Asking the agent which conversation it is holding answers
 * that outright, and answers it the moment the pane is seen rather than only
 * when somebody next speaks. The other two remain as fallbacks.
 */

/** How often the process table is read. Cheap enough; one `ps` for every pane. */
const TICK_MS = 4000

/**
 * How far ahead of an agent a transcript may be filed and still be its own.
 * Covers the poll interval, since a conversation can be a few seconds old
 * before the agent that wrote it is first seen.
 */
const BIRTH_SLACK_MS = 15_000

export interface Proc {
  pid: number
  ppid: number
  args: string
}

/** What is currently running beneath one pane, and what is known about it. */
interface Watched {
  pid: number
  agentId: string
  cwd: string
  /** Conversations already on disk when this agent was first seen. */
  before: Set<string>
  firstSeen: number
  /** True once the conversation is known and written down. */
  settled: boolean
}

/** Agents whose conversations can be reopened, keyed by the binary they run as. */
const AGENT_BY_BIN = new Map(
  AGENTS.filter((a) => a.bin && SESSION_FLAGS[a.id]).map((a) => [a.bin, a.id])
)

/**
 * *Every* agent, keyed by its binary — not just the resumable ones.
 *
 * `AGENT_BY_BIN` above is deliberately narrow: it answers "can this pane's
 * conversation be reopened", and only Claude Code can. This one answers a
 * different question — "what is running in this pane right now" — which is
 * what the pane header's mark and name are showing. Close Codex, type
 * `opencode`, and the header has to stop claiming Codex even though neither
 * agent keeps a resumable session.
 */
const ANY_AGENT_BY_BIN = new Map(AGENTS.filter((a) => a.bin).map((a) => [a.bin, a.id]))

/** Which agent a command line is, counting every agent rather than only the
 *  resumable ones. Same word-boundary care as `agentOf`. */
export function runningAgentOf(args: string): string | null {
  const words = args.split(/\s+/)
  const first = ANY_AGENT_BY_BIN.get(path.basename(words[0] ?? ''))
  if (first) return first
  if (!RUNTIMES.has(path.basename(words[0] ?? ''))) return null
  return ANY_AGENT_BY_BIN.get(path.basename(words[1] ?? '')) ?? null
}

/**
 * The agent running under a pane's shell, counting every agent.
 *
 * Separate from `agentUnder` because that one stops at the first *resumable*
 * agent; this one stops at the first agent of any kind. Breadth first for the
 * same reason: an agent that spawns a nested copy of itself should still be
 * reported as the outer one.
 */
export function anyAgentUnder(shellPid: number, kids: Map<number, Proc[]>): string | null {
  const queue = [...(kids.get(shellPid) ?? [])]
  const seen = new Set<number>()
  while (queue.length) {
    const proc = queue.shift()!
    if (seen.has(proc.pid)) continue
    seen.add(proc.pid)
    const id = runningAgentOf(proc.args)
    if (id) return id
    queue.push(...(kids.get(proc.pid) ?? []))
  }
  return null
}

/** Runtimes that run an agent as a script, where the name is the next word along. */
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3'])

export const ID_RE = /--(?:resume|session-id)(?:\s+|=)([0-9a-fA-F-]{36})/

/**
 * Which agent a command line is, if any.
 *
 * Read off the words rather than searched for anywhere in the line, so a shell
 * sitting in a folder that merely has the name in its path is not mistaken for
 * the agent itself.
 */
export function agentOf(args: string): string | null {
  const words = args.split(/\s+/)
  const first = AGENT_BY_BIN.get(path.basename(words[0] ?? ''))
  if (first) return first
  if (!RUNTIMES.has(path.basename(words[0] ?? ''))) return null
  return AGENT_BY_BIN.get(path.basename(words[1] ?? '')) ?? null
}

async function processTable(): Promise<Proc[]> {
  const { stdout } = await exec('ps', ['-Ao', 'pid=,ppid=,args='], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8000
  })
  const out: Proc[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  return out
}

/**
 * The agent running under a pane's shell, if one is.
 *
 * Breadth first, so the agent you started is found rather than something it
 * spawned in turn — an agent running its own nested copy is common, and the
 * outer one is the pane's.
 */
export function agentUnder(shellPid: number, kids: Map<number, Proc[]>): Proc | null {
  const queue = [...(kids.get(shellPid) ?? [])]
  const seen = new Set<number>()
  while (queue.length) {
    const proc = queue.shift()!
    if (seen.has(proc.pid)) continue
    seen.add(proc.pid)
    if (agentOf(proc.args)) return proc
    queue.push(...(kids.get(proc.pid) ?? []))
  }
  return null
}

/**
 * Where a process is actually running.
 *
 * Asked of the process rather than assumed from the pane, because a folder
 * reached with `cd` is the one the transcript will be filed under, and that is
 * the folder the session has to be reopened from.
 */
async function cwdOf(pid: number): Promise<string> {
  try {
    const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 5000
    })
    const line = stdout.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1).trim() : ''
  } catch {
    // lsof is absent or refused. Attribution by arrival is lost for this pane;
    // a session the app launched still names itself on the command line.
    return ''
  }
}

/**
 * The conversation a running agent says it is holding.
 *
 * Claude Code keeps `sessions/<pid>.json` beside its transcripts, naming the
 * session, the folder and the process. It is written by the process about
 * itself, so it is exact, and it is there for the whole life of the session
 * rather than only at the moment one begins — which is what makes an agent that
 * was already mid-conversation identifiable at all.
 *
 * The recorded folder is checked against the folder the process is actually in.
 * A process id is reused eventually, and a file left behind by a dead agent
 * would otherwise hand a pane somebody else's conversation.
 */
export function sessionForPid(pid: number, cwd: string): { sessionId: string; cwd: string } | null {
  let row: { sessionId?: string; cwd?: string; pid?: number }
  try {
    row = JSON.parse(fsSync.readFileSync(path.join(sessionsRoot(), `${pid}.json`), 'utf8'))
  } catch {
    return null
  }
  if (!row?.sessionId || !/^[0-9a-fA-F-]{36}$/.test(row.sessionId)) return null
  if (typeof row.pid === 'number' && row.pid !== pid) return null
  // When the folder is known and disagrees, the file belongs to a different run.
  if (cwd && row.cwd && row.cwd !== cwd) return null
  return { sessionId: row.sessionId, cwd: row.cwd ?? cwd }
}

/** Every conversation filed under a folder, with when it was first written. */
async function transcriptsIn(cwd: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!cwd) return out
  const root = projectsRoot()
  const slug = projectSlug(cwd)
  let dirs: string[]
  try {
    dirs = (await fs.readdir(root)).filter((d) => d === slug || d.startsWith(`${slug}-`))
  } catch {
    return out
  }
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await fs.readdir(path.join(root, dir))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const st = await fs.stat(path.join(root, dir, name))
        // birthtime is what is wanted; ctime stands in where a filesystem
        // does not keep one.
        out.set(name.replace(/\.jsonl$/, ''), st.birthtimeMs || st.ctimeMs)
      } catch {
        /* it went away between listing and asking */
      }
    }
  }
  return out
}

export class SessionWatch {
  private timer: NodeJS.Timeout | null = null
  private watched = new Map<string, Watched>()
  /** Ticks never overlap; a slow `ps` must not start a second pass. */
  private busy = false
  /** What each pane was last reported as running, so only changes are sent. */
  private running = new Map<string, string>()

  constructor(
    private readonly pids: () => Map<string, number>,
    private readonly store: PaneSessions,
    /**
     * Told when the agent running in a pane changes — including to nothing.
     * Rides this tick rather than polling on its own: the process table is
     * already being read here, and reading it twice a tick to answer two
     * questions about the same processes would be waste.
     */
    private readonly onRunningAgent?: (paneId: string, agentId: string | null) => void
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    void this.tick()
  }

  /**
   * Stops looking. Called before the shells are killed on the way out, because
   * an agent disappearing is otherwise taken as one you closed — and every
   * agent disappears at once when the app quits, which would erase exactly the
   * record the next launch depends on.
   */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const panes = this.pids()
      for (const paneId of [...this.watched.keys()]) {
        if (!panes.has(paneId)) this.watched.delete(paneId)
      }
      if (!panes.size) return

      const kids = new Map<number, Proc[]>()
      for (const proc of await processTable()) {
        const list = kids.get(proc.ppid)
        if (list) list.push(proc)
        else kids.set(proc.ppid, [proc])
      }

      const open: { paneId: string; w: Watched }[] = []

      // What is running in each pane, for the header's mark and name. Done
      // for every pane before the session work below, because a pane with no
      // resumable agent still has an agent worth naming.
      if (this.onRunningAgent) {
        for (const [paneId, shellPid] of panes) {
          const now = anyAgentUnder(shellPid, kids) ?? ''
          if (this.running.get(paneId) !== now) {
            this.running.set(paneId, now)
            this.onRunningAgent(paneId, now || null)
          }
        }
        for (const paneId of [...this.running.keys()]) {
          if (!panes.has(paneId)) this.running.delete(paneId)
        }
      }

      for (const [paneId, shellPid] of panes) {
        const proc = agentUnder(shellPid, kids)
        if (!proc) {
          this.watched.delete(paneId)
          this.store.clear(paneId)
          continue
        }

        let w = this.watched.get(paneId)
        if (!w || w.pid !== proc.pid) {
          const cwd = await cwdOf(proc.pid)
          w = {
            pid: proc.pid,
            agentId: agentOf(proc.args) ?? '',
            cwd,
            before: new Set((await transcriptsIn(cwd)).keys()),
            firstSeen: Date.now(),
            settled: false
          }
          this.watched.set(paneId, w)
        }
        if (w.settled || !w.agentId) continue

        /*
         * What the agent says about itself, which beats anything inferred.
         *
         * Claude Code writes `sessions/<pid>.json` under its configuration
         * directory naming the conversation that process is holding. That
         * answers the question outright, and — the reason this exists — it
         * answers it for an agent that was already talking before anyone
         * started watching. Waiting for a transcript to appear can never
         * identify one of those: its transcript was already there.
         */
        const own = sessionForPid(proc.pid, w.cwd)
        if (own) {
          w.settled = true
          this.store.set(paneId, {
            agentId: w.agentId,
            sessionId: own.sessionId,
            cwd: own.cwd || w.cwd
          })
          continue
        }

        // Failing that, a command line that names the conversation.
        const named = ID_RE.exec(proc.args)?.[1]
        if (named) {
          w.settled = true
          this.store.set(paneId, { agentId: w.agentId, sessionId: named, cwd: w.cwd })
          continue
        }
        open.push({ paneId, w })
      }

      await this.attribute(open)
    } catch {
      // A failed read of the process table costs nothing but this pass.
    } finally {
      this.busy = false
    }
  }

  /**
   * Hands each newly written conversation to the pane most likely to have
   * written it: one whose agent was already running, and had none of its own,
   * when the file appeared.
   */
  private async attribute(open: { paneId: string; w: Watched }[]): Promise<void> {
    const byCwd = new Map<string, { paneId: string; w: Watched }[]>()
    for (const item of open) {
      if (!item.w.cwd) continue
      const list = byCwd.get(item.w.cwd)
      if (list) list.push(item)
      else byCwd.set(item.w.cwd, [item])
    }

    for (const [cwd, group] of byCwd) {
      const now = await transcriptsIn(cwd)
      // Oldest first, so conversations are handed out in the order they were
      // started rather than whatever order the directory happened to list in.
      const arrivals = [...now.entries()]
        .filter(([id]) => group.some(({ w }) => !w.before.has(id)))
        .sort((a, b) => a[1] - b[1])

      for (const [id, born] of arrivals) {
        const owner = group
          .filter(({ w }) => !w.settled && !w.before.has(id) && w.firstSeen - born < BIRTH_SLACK_MS)
          .sort((a, b) => b.w.firstSeen - a.w.firstSeen)[0]
        if (!owner) continue
        owner.w.settled = true
        this.store.set(owner.paneId, {
          agentId: owner.w.agentId,
          sessionId: id,
          cwd
        })
      }
    }
  }
}
