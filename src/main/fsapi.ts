import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import type { DirEntry } from '../shared/types'
import type { GrepFileHits, GrepMatch, GrepResult } from '../shared/grep'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo', '.cache',
  'target', 'venv', '.venv', '__pycache__', '.DS_Store', 'coverage', '.parcel-cache'
])

const MAX_READ = 2 * 1024 * 1024

/**
 * Images and PDFs are legitimately bigger than the text cap, but a multi-
 * hundred-megabyte file base64-encoded and sent whole across IPC would still
 * jank the renderer on receipt — so this is generous, not unlimited.
 */
const MAX_BINARY_READ = 24 * 1024 * 1024

/** Extensions the preview pane knows what to do with. Nothing else is guessed at. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf'
}

export function mimeFor(file: string): string | null {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? null
}

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: DirEntry[] = []
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    const full = path.join(dir, entry.name)
    let size = 0
    if (entry.isFile()) {
      try {
        size = (await fs.stat(full)).size
      } catch {
        /* dangling symlink */
      }
    }
    out.push({ name: entry.name, path: full, isDir: entry.isDirectory(), size })
  }
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
  return out
}

export async function readFile(file: string): Promise<{ text: string; truncated: boolean }> {
  const stat = await fs.stat(file)
  if (stat.size > MAX_READ) {
    const handle = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_READ)
      await handle.read(buf, 0, MAX_READ, 0)
      return { text: buf.toString('utf8'), truncated: true }
    } finally {
      await handle.close()
    }
  }
  const buf = await fs.readFile(file)
  // A NUL byte in the first block is the usual tell for a binary file.
  if (buf.subarray(0, 4096).includes(0)) {
    throw new Error('Binary file — Eaon can’t show this one.')
  }
  return { text: buf.toString('utf8'), truncated: false }
}

/**
 * Bytes, for the one class of file that is never valid UTF-8 text: images and
 * PDFs. `readFile` refuses these on sight — the NUL check that keeps a
 * genuinely binary file out of the text editor also keeps every image and
 * PDF out — so a preview needs a door of its own.
 *
 * Returned as base64 because that is what has to happen to the bytes anyway:
 * the renderer's Content-Security-Policy admits `data:`/`blob:` sources but
 * not `file:`, so a `file://` src is silently dropped and nothing this
 * function's *caller* does can fix that — the bytes have to cross the IPC
 * bridge and become a `data:` URL, the same trip `saveDropped` already makes
 * in the other direction for a dropped image with no path of its own.
 */
export async function readBinary(
  file: string
): Promise<{ base64: string; mime: string; truncated: boolean }> {
  const mime = mimeFor(file)
  if (!mime) throw new Error('Not a previewable file type.')

  const stat = await fs.stat(file)
  if (stat.size > MAX_BINARY_READ) {
    // A truncated image or PDF is not a smaller version of the real one —
    // both formats need their own trailer/footer bytes to decode at all — so
    // this is a refusal, not a partial read the way the text path allows.
    throw new Error(
      `That file is ${Math.round(stat.size / 1024 / 1024)} MB, over the ${Math.round(MAX_BINARY_READ / 1024 / 1024)} MB preview limit.`
    )
  }

  const buf = await fs.readFile(file)
  return { base64: buf.toString('base64'), mime, truncated: false }
}

export async function writeFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, 'utf8')
}

export async function searchFiles(root: string, query: string, limit = 60): Promise<DirEntry[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits: DirEntry[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (hits.length >= limit || depth > 7) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (hits.length >= limit) return
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.name.toLowerCase().includes(needle)) {
        hits.push({ name: entry.name, path: full, isDir: false, size: 0 })
      }
    }
  }

  await walk(root, 0)
  return hits
}

/* ---- searching inside files --------------------------------------------- */

/**
 * Hard ceilings on a content search.
 *
 * A one-character query against a real repository matches effectively
 * everything, and every hit costs a line of text across the IPC bridge. These
 * are low enough that the worst query anyone can type is still a cheap one,
 * and the result says when it has hit them rather than presenting a slice as
 * though it were the whole answer.
 */
const MAX_GREP_HITS = 200
const MAX_GREP_FILES = 50

/** Per file, so one generated file cannot use up the whole budget alone. */
const MAX_HITS_PER_FILE = 20

/** Files above this are generated, minified or data. Searching them is noise. */
const MAX_GREP_FILE_SIZE = 1024 * 1024

/**
 * How much of a matching line travels back.
 *
 * A minified bundle is one line of several megabytes. Sending it whole so the
 * UI can show sixty characters of it would be the most expensive thing this
 * feature does, per hit.
 */
const MAX_LINE = 400

/**
 * Trim a long line down to something worth sending, keeping the match in it.
 *
 * Cutting from the left alone would send the first 400 characters of a
 * minified line and none of what was found. The window follows the match and
 * the offsets are moved to match, so the caller highlights the same
 * characters it would have without the trim.
 */
function clipLine(
  text: string,
  start: number,
  end: number
): { text: string; start: number; end: number } {
  if (text.length <= MAX_LINE) return { text, start, end }
  const margin = Math.max(0, Math.floor((MAX_LINE - (end - start)) / 2))
  const from = Math.max(0, start - margin)
  const to = Math.min(text.length, from + MAX_LINE)
  const head = from > 0 ? '…' : ''
  const tail = to < text.length ? '…' : ''
  return {
    text: head + text.slice(from, to) + tail,
    start: start - from + head.length,
    end: Math.min(end - from + head.length, MAX_LINE + head.length)
  }
}

/**
 * Where a line matches, computed here for both backends.
 *
 * ripgrep reports byte offsets into a UTF-8 line; JavaScript indexes UTF-16
 * code units, so those two disagree the moment a line contains anything
 * outside ASCII — an accent earlier in the line would shift the highlight off
 * the word it belongs to. Finding the offset in JS instead means the GPU path
 * and the fallback highlight identically, and neither can drift.
 */
function matchIn(line: string, needle: string): { start: number; end: number } | null {
  const at = line.toLowerCase().indexOf(needle)
  return at === -1 ? null : { start: at, end: at + needle.length }
}

/** Collect a file's matches, respecting the per-file ceiling. */
function hitsInText(text: string, needle: string): GrepMatch[] {
  const out: GrepMatch[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < MAX_HITS_PER_FILE; i += 1) {
    const raw = lines[i].replace(/\r$/, '')
    const found = matchIn(raw, needle)
    if (!found) continue
    const clipped = clipLine(raw, found.start, found.end)
    out.push({ line: i + 1, text: clipped.text, start: clipped.start, end: clipped.end })
  }
  return out
}

/** Resolved once per run: asking a login shell costs a few hundred ms. */
let ripgrepPath: string | null | undefined

/**
 * Search file contents under `root`.
 *
 * Uses ripgrep when it is on the machine and walks the tree when it is not.
 * Both are given the same rules on purpose — the same skipped directories, the
 * same size ceiling, a literal (not regular-expression) query, case
 * insensitive, both ordered by path — because a search box whose answers
 * depend on whether a particular binary happens to be installed is one nobody
 * can trust. That is also why ripgrep is run with `--no-ignore`: left to
 * itself it honours `.gitignore`, and then the same query in the same folder
 * would return different things on two machines.
 *
 * They agree on which files match. Where they can still part company is the
 * last file before the cap, since the two walk the tree in orders that differ
 * in the corners (`b-x.ts` sorts before `b/` as a path and after it as a
 * name). A query that hits the cap is being told it is a slice regardless.
 *
 * The query is passed as an argument, never through a shell, and is matched
 * literally. Someone searching for `(` is looking for a bracket, not writing a
 * pattern that fails to compile.
 */
export async function grepFiles(
  root: string,
  query: string,
  which?: (bin: string) => Promise<string | null>
): Promise<GrepResult> {
  const needle = query.trim().toLowerCase()
  const empty: GrepResult = {
    files: [],
    total: 0,
    cappedHits: false,
    cappedFiles: false,
    tool: 'walk'
  }
  // One character matches everything and answers nothing.
  if (needle.length < 2 || !root) return empty

  if (ripgrepPath === undefined && which) {
    ripgrepPath = await which('rg')
  }

  if (ripgrepPath) {
    try {
      return await grepWithRipgrep(ripgrepPath, root, needle)
    } catch {
      // Any trouble at all and the walk answers instead — a search that works
      // is worth more than one that insists on being fast.
    }
  }
  return grepByWalking(root, needle)
}

/**
 * ripgrep, read as a stream and stopped once the caps are reached.
 *
 * Streamed rather than buffered: a short query against a large repository
 * produces more output than it is worth holding, and the point of the caps is
 * that the work stops, not that the answer is trimmed after all of it is done.
 */
async function grepWithRipgrep(rg: string, root: string, needle: string): Promise<GrepResult> {
  const args = [
    '--json',
    '--fixed-strings',
    '--ignore-case',
    // See grepFiles: determinism across machines beats honouring .gitignore.
    '--no-ignore',
    '--hidden',
    /*
     * Ordered by path, which also means single-threaded.
     *
     * Not a preference. ripgrep searches in parallel and reports files as they
     * finish, so without this the same query run twice comes back in a
     * different order — and because the search stops at the file cap, a
     * different *set* of files as well. Measured on this repository: five runs
     * of one query, five different answers. Sorting costs the parallelism, and
     * buys a search box that agrees with itself.
     */
    '--sort=path',
    `--max-filesize=${MAX_GREP_FILE_SIZE}`,
    `--max-count=${MAX_HITS_PER_FILE}`
  ]
  for (const dir of SKIP_DIRS) args.push('--glob', `!${dir}`)
  args.push('--', needle, root)

  return new Promise<GrepResult>((resolve, reject) => {
    const proc = spawn(rg, args, { cwd: root })
    const byFile = new Map<string, GrepFileHits>()
    let total = 0
    let cappedHits = false
    let cappedFiles = false
    let done = false
    let carry = ''

    const finish = (): void => {
      if (done) return
      done = true
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      resolve({
        files: [...byFile.values()],
        total,
        cappedHits,
        cappedFiles,
        tool: 'ripgrep'
      })
    }

    proc.on('error', (err) => {
      if (!done) {
        done = true
        reject(err)
      }
    })

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (done) return
      carry += chunk
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''

      for (const line of lines) {
        if (!line) continue
        let row: {
          type?: string
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
        }
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row.type !== 'match' || !row.data) continue
        const file = row.data.path?.text
        const text = row.data.lines?.text
        const at = row.data.line_number
        if (!file || text === undefined || !at) continue

        // ripgrep says which lines match; where in the line is worked out
        // here, so both backends highlight the same characters.
        const found = matchIn(text.replace(/\n$/, ''), needle)
        if (!found) continue

        let entry = byFile.get(file)
        if (!entry) {
          if (byFile.size >= MAX_GREP_FILES) {
            cappedFiles = true
            finish()
            return
          }
          entry = { path: file, name: path.basename(file), hits: [] }
          byFile.set(file, entry)
        }
        if (entry.hits.length >= MAX_HITS_PER_FILE) continue

        const clipped = clipLine(text.replace(/\n$/, ''), found.start, found.end)
        entry.hits.push({ line: at, text: clipped.text, start: clipped.start, end: clipped.end })
        total += 1
        if (total >= MAX_GREP_HITS) {
          cappedHits = true
          finish()
          return
        }
      }
    })

    proc.on('close', finish)
  })
}

/**
 * The fallback: the same walk `searchFiles` does, reading each file.
 *
 * Same skipped directories and same depth limit, so the set of files
 * considered matches the one the filename search looks at. Binary files are
 * recognised the way `readFile` recognises them — a NUL in the first block —
 * rather than by extension, because the point is to avoid printing bytes as
 * text and a file's name is only a guess about that.
 */
async function grepByWalking(root: string, needle: string): Promise<GrepResult> {
  const files: GrepFileHits[] = []
  let total = 0
  let cappedHits = false
  let cappedFiles = false

  async function walk(dir: string, depth: number): Promise<void> {
    if (cappedHits || cappedFiles || depth > 7) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Same reason ripgrep is given `--sort=path`: readdir hands back whatever
    // order the filesystem happens to hold, and the file cap turns an order
    // into a choice of which files are in the answer at all.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      if (cappedHits || cappedFiles) return
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      let buf: Buffer
      try {
        if ((await fs.stat(full)).size > MAX_GREP_FILE_SIZE) continue
        buf = await fs.readFile(full)
      } catch {
        continue
      }
      // The same tell readFile uses. An extension is only a guess.
      if (buf.subarray(0, 4096).includes(0)) continue

      const hits = hitsInText(buf.toString('utf8'), needle)
      if (!hits.length) continue

      if (files.length >= MAX_GREP_FILES) {
        cappedFiles = true
        return
      }
      const room = MAX_GREP_HITS - total
      if (hits.length >= room) {
        files.push({ path: full, name: entry.name, hits: hits.slice(0, room) })
        total = MAX_GREP_HITS
        cappedHits = true
        return
      }
      files.push({ path: full, name: entry.name, hits })
      total += hits.length
    }
  }

  await walk(root, 0)
  return { files, total, cappedHits, cappedFiles, tool: 'walk' }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Park a dropped payload on disk and hand back its path.
 *
 * Most drops carry a real file and keep their own path — that one is better,
 * because the agent then reads the file you actually dropped. This is for the
 * other kind: an image dragged straight out of a web page or a screenshot tool
 * arrives as bytes with nowhere to point at. Writing it out is what turns it
 * into something a terminal can name.
 */
export async function saveDropped(name: string, bytes: Uint8Array): Promise<string> {
  const dir = path.join(app.getPath('temp'), 'eaon-ade-drops')
  await fs.mkdir(dir, { recursive: true })

  // Keep the extension — it is how everything downstream knows it is an image —
  // and throw away anything else that could climb out of this folder.
  const safe = path.basename(name || 'dropped').replace(/[^\w.-]+/g, '-').slice(-64) || 'dropped'
  const stamp = Date.now().toString(36)
  const ext = path.extname(safe)
  const stem = ext ? safe.slice(0, -ext.length) : safe
  const target = path.join(dir, `${stem || 'image'}-${stamp}${ext}`)

  await fs.writeFile(target, bytes)
  return target
}
