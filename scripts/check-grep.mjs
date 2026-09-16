/*
 * Checks searching inside files: that the two backends agree, that a capped
 * search is repeatable, and that a match is highlighted in the right place.
 *
 * The repeatability check is the one that matters. ripgrep searches in
 * parallel and reports each file as it finishes, so a hard file cap over it
 * silently picks whichever files happened to finish first — the same query run
 * twice came back with a different set, in a different order. That is invisible
 * in the UI and invisible in review; only running the same input twice and
 * comparing finds it.
 *
 *   node scripts/check-grep.mjs
 */

import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-grep-'))

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

const outfile = path.join(tmp, 'fsapi.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/fsapi.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['node:*'],
  plugins: [
    {
      // fsapi imports `app` only for the drop folder, which this never calls.
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const app = { getPath: () => ${JSON.stringify(tmp)} }`,
          loader: 'js'
        }))
      }
    }
  ]
})

/** The real resolver, so the ripgrep path is exercised when rg is installed. */
const which = (bin) =>
  new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-lic', `command -v ${bin}`], (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    )
  })
const noWhich = async () => null

/** A fresh module each time, so the cached ripgrep path never leaks between runs. */
let seq = 0
const load = async () => (await import(`${pathToFileURL(outfile).href}?n=${seq++}`)).grepFiles

/* ---- a tree to search ------------------------------------------------------ */

const tree = path.join(tmp, 'tree')
fs.mkdirSync(path.join(tree, 'src', 'deep'), { recursive: true })
fs.mkdirSync(path.join(tree, 'node_modules'), { recursive: true })
for (let i = 0; i < 60; i += 1) {
  fs.writeFileSync(path.join(tree, 'src', `f${String(i).padStart(3, '0')}.ts`), `const needle = ${i}\n`)
}
fs.writeFileSync(path.join(tree, 'src', 'deep', 'nested.ts'), 'a\nb\nthe needle is here\n')
fs.writeFileSync(path.join(tree, 'accents.txt'), 'héllo wörld — needle here\n')
fs.writeFileSync(path.join(tree, 'long.txt'), `${'x'.repeat(5000)}needle${'y'.repeat(5000)}\n`)
// Must never be searched, by either backend.
fs.writeFileSync(path.join(tree, 'node_modules', 'ignored.ts'), 'const needle = 1\n')
// Binary: a NUL in the first block, so it is skipped rather than printed.
fs.writeFileSync(path.join(tree, 'blob.bin'), Buffer.from([0x6e, 0x00, 0x65, 0x65, 0x64, 0x6c, 0x65]))

const shape = (r) =>
  r.files
    .map((f) => `${path.relative(tree, f.path)}:${f.hits.map((h) => h.line).join(',')}`)
    .sort()
    .join('|')

/* ---- the two backends agree ------------------------------------------------ */

const rgPath = await which('rg')
const withRg = await (await load())(tree, 'needle', which)
const walked = await (await load())(tree, 'needle', noWhich)

check('the walk backend answers', walked.tool === 'walk')
if (rgPath) {
  check('ripgrep is used when present', withRg.tool === 'ripgrep')
  check('both backends find the same files and lines', shape(withRg) === shape(walked), `${shape(withRg).slice(0, 80)} vs ${shape(walked).slice(0, 80)}`)
} else {
  console.log('  --   ripgrep not installed; cross-backend agreement not checked')
}

/* ---- a capped search is repeatable ----------------------------------------- */

const runs = []
for (let i = 0; i < 5; i += 1) runs.push(shape(await (await load())(tree, 'needle', which)))
check('five identical queries give one identical answer', new Set(runs).size === 1, `${new Set(runs).size} distinct results`)
check('the file cap was actually reached', walked.cappedFiles || walked.cappedHits)

/* ---- what is skipped ------------------------------------------------------- */

check('node_modules is never searched', !shape(walked).includes('node_modules'))
check('a binary file is skipped rather than printed', !shape(walked).includes('blob.bin'))

/* ---- offsets land on the match --------------------------------------------- */

const utf = path.join(tmp, 'utf')
fs.mkdirSync(utf, { recursive: true })
fs.copyFileSync(path.join(tree, 'accents.txt'), path.join(utf, 'accents.txt'))
fs.copyFileSync(path.join(tree, 'long.txt'), path.join(utf, 'long.txt'))

for (const [label, w] of [['ripgrep', which], ['walk', noWhich]]) {
  if (label === 'ripgrep' && !rgPath) continue
  const res = await (await load())(utf, 'needle', w)
  const all = res.files.flatMap((f) => f.hits)
  // ripgrep reports UTF-8 byte offsets and JS indexes UTF-16 code units; an
  // accent earlier in the line moves the highlight off the word unless the
  // offset is recomputed here. This is that, asserted.
  check(
    `${label}: every offset slices out the query, accented line included`,
    all.length > 0 && all.every((h) => h.text.slice(h.start, h.end).toLowerCase() === 'needle'),
    all.map((h) => JSON.stringify(h.text.slice(h.start, h.end))).join(' ')
  )
  check(
    `${label}: a multi-kilobyte line is clipped around its match`,
    all.some((h) => h.text.length <= 402 && h.text.includes('…'))
  )
}

/* ---- a query too short to mean anything ------------------------------------ */

const tiny = await (await load())(tree, 'n', which)
check('a one-character query is refused', tiny.total === 0 && tiny.files.length === 0)

/* ---- done ------------------------------------------------------------------ */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
