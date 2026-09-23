import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import {
  ChevronLeft,
  Code2,
  Eye,
  File,
  FileText,
  Folder,
  RefreshCw,
  Save,
  Search,
  SquareStack
} from 'lucide-react'
import type { DirEntry } from '@shared/types'
import { useStore } from '../store/useStore'
import { basename } from '../lib/util'
import { FilePreviewBody, previewKindFor } from './FilePreviewBody'

/** Reads through the same custom properties as the rest of the app, so the
 *  editor repaints with the theme without being rebuilt. */
const THEME = EditorView.theme({
  // Full-strength foreground: this is code, and anything the highlighter does
  // not claim is an identifier, which should read as text rather than as an
  // aside. The muted greys are spent deliberately, on comments and punctuation.
  '&': { color: 'var(--text-hi)', backgroundColor: 'transparent', height: '100%' },
  '.cm-content': { caretColor: 'var(--accent)', fontFamily: 'var(--font-mono)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-wash)'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-dim)',
    border: 'none'
  },
  '.cm-activeLine': { backgroundColor: 'var(--ink-300)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-mid)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-panels': { backgroundColor: 'var(--ink-300)', color: 'var(--text-hi)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-wash)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-wash)', outline: '1px solid var(--accent-edge)' }
})

/**
 * What the code actually looks like.
 *
 * `basicSetup` brings CodeMirror's own default highlighting, which is built for
 * a white page — its blues and greens are near-black, and on this app's ink the
 * only tokens that survive are strings and comments. That is why code here read
 * as red and grey: everything else was being painted, just in colours that could
 * not be seen. This replaces it (a non-fallback highlighter takes precedence
 * over the default) with one drawn from the active theme.
 *
 * Colours arrive as custom properties rather than literals, so the whole thing
 * repaints when the theme changes without the editor being rebuilt.
 */
export const HIGHLIGHT = HighlightStyle.define([
  // Keywords and the words that control flow.
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.modifier,
      t.self,
      t.null
    ],
    color: 'var(--syn-keyword)'
  },
  // Text the program carries around.
  {
    tag: [t.string, t.special(t.string), t.docString, t.character, t.inserted],
    color: 'var(--syn-string)'
  },
  // Values that are literally themselves.
  {
    tag: [t.number, t.integer, t.float, t.bool, t.atom, t.unit, t.constant(t.name)],
    color: 'var(--syn-number)'
  },
  // Things you call.
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
      t.macroName,
      t.labelName
    ],
    color: 'var(--syn-function)'
  },
  // Things that name a shape.
  {
    tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.standard(t.typeName)],
    color: 'var(--syn-type)'
  },
  // Markup, and the escapes that behave like it.
  {
    tag: [t.tagName, t.angleBracket, t.regexp, t.escape, t.deleted, t.color],
    color: 'var(--syn-tag)'
  },
  { tag: [t.attributeName], color: 'var(--syn-attr)' },
  { tag: [t.attributeValue], color: 'var(--syn-string)' },
  {
    tag: [t.propertyName, t.definition(t.propertyName), t.variableName, t.definition(t.variableName)],
    color: 'var(--syn-name)'
  },
  {
    tag: [
      t.operator,
      t.arithmeticOperator,
      t.logicOperator,
      t.compareOperator,
      t.bitwiseOperator,
      t.updateOperator,
      t.definitionOperator,
      t.typeOperator,
      t.derefOperator
    ],
    color: 'var(--syn-operator)'
  },
  {
    tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.paren, t.brace],
    color: 'var(--syn-punct)'
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta, t.processingInstruction],
    color: 'var(--syn-comment)',
    fontStyle: 'italic'
  },
  { tag: [t.invalid], color: 'var(--syn-invalid)' },

  // Prose. Markdown is a first-class thing to be reading in here.
  { tag: [t.heading], color: 'var(--syn-heading)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--syn-link)', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700', color: 'var(--syn-name)' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.quote], color: 'var(--syn-comment)' },
  { tag: [t.list], color: 'var(--syn-keyword)' },
  { tag: [t.monospace], color: 'var(--syn-string)' }
])

function languageFor(file: string): Extension[] {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext))
    return [javascript({ typescript: ext.startsWith('ts'), jsx: ext.endsWith('x') })]
  if (ext === 'json') return [json()]
  if (['md', 'markdown', 'mdx'].includes(ext)) return [markdown()]
  if (ext === 'py') return [python()]
  if (ext === 'rs') return [rust()]
  if (['css', 'scss', 'less'].includes(ext)) return [css()]
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return [html()]
  return []
}

export function EditorPanel({
  cwd,
  workspaceId
}: {
  cwd: string
  /** Present whenever this is mounted from a real workspace — lets the
   *  currently open file be split out into its own grid pane. */
  workspaceId?: string
}): React.JSX.Element {
  const notify = useStore((s) => s.notify)
  const addPane = useStore((s) => s.addPane)

  const [dir, setDir] = useState(cwd)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<DirEntry[] | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [doc, setDoc] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [autosave, setAutosave] = useState(false)
  /**
   * Markdown opens rendered by default — README is a document to read far
   * more often than it is one to edit — with a toggle back to the raw,
   * editable source. Images and PDFs have no source to toggle to at all;
   * `previewLocked` says so, so the toggle button does not appear for them.
   */
  const [previewOn, setPreviewOn] = useState(false)
  /** What preview mode actually renders — a snapshot taken at toggle time. */
  const [liveMarkdown, setLiveMarkdown] = useState<string | undefined>(undefined)

  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimer = useRef<number | null>(null)
  /** A line a search hit asked for, consumed once its view exists. */
  const pendingLine = useRef<number | null>(null)
  // The editor's change listener is created once per file, so it reads these
  // through refs rather than closing over stale state.
  const autosaveRef = useRef(autosave)
  const fileRef = useRef<string | null>(null)

  useEffect(() => {
    autosaveRef.current = autosave
  }, [autosave])

  useEffect(() => setDir(cwd), [cwd])

  const load = useCallback((): void => {
    window.eaon.fs
      .list(dir)
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [dir])

  useEffect(load, [load])

  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    const id = window.setTimeout(() => {
      window.eaon.fs.search(cwd, query).then(setHits)
    }, 220)
    return () => window.clearTimeout(id)
  }, [query, cwd])

  const save = useCallback(async (): Promise<void> => {
    const view = viewRef.current
    const target = fileRef.current
    if (!view || !target) return
    await window.eaon.fs.write(target, view.state.doc.toString())
    setDirty(false)
  }, [])

  const open = async (path: string): Promise<void> => {
    const kind = previewKindFor(path)

    // An image or a PDF has no text to read at all — asking fs.read for one
    // is exactly the request that used to end in "Binary file — Eaon can't
    // show this one." FilePreviewBody does its own fetch over the binary-safe
    // door, so this just points it at the path and gets out of the way.
    if (kind === 'image' || kind === 'pdf') {
      fileRef.current = null
      setDirty(false)
      setDoc(null)
      setFile(path)
      setPreviewOn(true)
      // No live editor exists for this file yet, so there is no in-progress
      // buffer to prefer over disk — see the note on liveMarkdown below.
      setLiveMarkdown(undefined)
      return
    }

    try {
      const { text, truncated } = await window.eaon.fs.read(path)
      fileRef.current = path
      setDirty(false)
      setFile(path)
      setDoc(text)
      setPreviewOn(kind === 'markdown')
      // A fresh file has nothing typed into it yet. Leaving the previous
      // file's snapshot here would render file A's content mislabelled as
      // file B the moment this one opens already in preview mode.
      setLiveMarkdown(undefined)
      if (truncated) {
        notify({
          kind: 'info',
          title: 'Showing the first 2 MB',
          text: `${basename(path)} is too large to open in full.`
        })
      }
    } catch (err) {
      notify({
        kind: 'error',
        title: 'Could not open that file',
        text: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // CodeMirror mounts here, not in open(), because the host element does not
  // exist until React has rendered the newly selected file.
  useEffect(() => {
    const host = hostRef.current
    if (!host || file === null || doc === null) return
    viewRef.current?.destroy()
    viewRef.current = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          THEME,
          // After basicSetup on purpose: its default highlighter is registered
          // as a fallback, so this one supersedes it rather than fighting it.
          syntaxHighlighting(HIGHLIGHT),
          ...languageFor(file),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            setDirty(true)
            if (saveTimer.current) window.clearTimeout(saveTimer.current)
            saveTimer.current = window.setTimeout(() => {
              if (autosaveRef.current) void save()
            }, 900)
          })
        ]
      })
    })
    // Now that the view exists for this doc, honour a line a search hit asked
    // for. Clamped, because a hit's line can outrun the file if it changed on
    // disk between the search and the click.
    const want = pendingLine.current
    pendingLine.current = null
    if (want != null) {
      const view = viewRef.current
      const at = view.state.doc.line(Math.min(Math.max(1, want), view.state.doc.lines))
      view.dispatch({
        selection: { anchor: at.from },
        effects: EditorView.scrollIntoView(at.from, { y: 'center' })
      })
    }

    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [file, doc, save])

  // The file tree hands a path over through the store rather than by prop:
  // the tree lives in its own dock tab, so there is no parent to thread it
  // through. Cleared once opened, so re-selecting the same file works.
  const editorTarget = useStore((s) => s.editorTarget)
  const clearEditorTarget = useStore((s) => s.clearEditorTarget)
  useEffect(() => {
    if (!editorTarget) return
    // The line is handed to the effect that builds the view, not dispatched
    // here. This effect runs before that one — the view is destroyed and
    // rebuilt for every file — so a selection set from here is wiped by the
    // rebuild a moment later. Measured: the cursor landed on line 1 every time.
    pendingLine.current = editorTarget.line ?? null
    void open(editorTarget.path)
    clearEditorTarget()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorTarget])

  const kind = file ? previewKindFor(file) : 'unsupported'
  const previewLocked = kind === 'image' || kind === 'pdf'

  const togglePreview = (): void => {
    if (!previewOn) {
      // Snapshot what is actually in the buffer right now, edited or not —
      // rendering the copy on disk would either lag behind what was just
      // typed or, worse, quietly hide it the moment preview is turned on.
      setLiveMarkdown(viewRef.current?.state.doc.toString() ?? doc ?? undefined)
    }
    setPreviewOn((v) => !v)
  }

  const shown = hits ?? entries
  const atRoot = dir === cwd

  return (
    <div className="panel">
      <div className="panel-bar">
        <div className="field">
          <Search size={13} color="var(--text-dim)" />
          <input
            value={query}
            placeholder="Find a file"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find a file"
          />
        </div>
        <button className="icon-btn" onClick={load} title="Refresh" aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-btn"
          data-on={autosave}
          onClick={() => setAutosave((v) => !v)}
          title="Autosave"
          aria-label="Autosave"
        >
          <FileText size={14} />
        </button>
        <button
          className="icon-btn"
          data-on={dirty}
          disabled={!dirty}
          onClick={save}
          title="Save"
          aria-label="Save"
        >
          <Save size={14} />
        </button>
      </div>

      <div className="panel-split">
        <div className="panel-side">
          {!hits && !atRoot && (
            <button
              className="tree-row"
              onClick={() => setDir(dir.replace(/\/[^/]+\/?$/, '') || '/')}
            >
              <ChevronLeft size={13} />
              <span className="tree-name">Up a level</span>
            </button>
          )}
          {shown.length === 0 && (
            <p style={{ padding: 10, fontSize: 12, color: 'var(--text-dim)' }}>
              {hits ? 'No files match.' : 'This folder is empty.'}
            </p>
          )}
          {shown.map((e) => (
            <button
              className="tree-row"
              key={e.path}
              data-dir={e.isDir}
              data-on={file === e.path}
              onClick={() => (e.isDir ? setDir(e.path) : open(e.path))}
              title={e.path}
            >
              {e.isDir ? <Folder size={13} /> : <File size={13} />}
              <span className="tree-name">{e.name}</span>
            </button>
          ))}
        </div>

        <div className="panel-main">
          {file ? (
            <>
              <div
                className="panel-bar"
                style={{ borderBottom: '1px solid var(--line-100)', gap: 6 }}
              >
                <span
                  className="mono"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11,
                    color: 'var(--text-mid)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    direction: 'rtl'
                  }}
                  title={file}
                >
                  {file}
                </span>
                {dirty && <span className="chip">unsaved</span>}
                {autosave && <span className="chip">autosave on</span>}
                {!previewLocked && kind === 'markdown' && (
                  <button className="icon-btn" data-on={previewOn} onClick={togglePreview} title={previewOn ? 'Show raw source' : 'Show rendered preview'} aria-label={previewOn ? 'Show raw source' : 'Show rendered preview'}>
                    {previewOn ? <Code2 size={14} /> : <Eye size={14} />}
                  </button>
                )}
                {workspaceId && kind !== 'unsupported' && (
                  <button
                    className="icon-btn"
                    onClick={() =>
                      addPane(workspaceId, { kind: 'preview', previewPath: file })
                    }
                    title="Open in its own pane, beside your terminals"
                    aria-label="Open in its own pane"
                  >
                    <SquareStack size={14} />
                  </button>
                )}
              </div>

              {/*
                The editor stays mounted underneath a shown preview rather
                than being unmounted for one — CodeMirror does not persist its
                buffer through a destroy/recreate cycle, so toggling preview
                would otherwise discard whatever was typed and never saved.
              */}
              {(previewOn || previewLocked) && (
                <div className="fp-scroll">
                  <FilePreviewBody
                    path={file}
                    markdownOverride={kind === 'markdown' ? liveMarkdown : undefined}
                  />
                </div>
              )}
              <div className="editor-host" ref={hostRef} hidden={previewOn || previewLocked} />
            </>
          ) : (
            <div className="empty">
              <strong>Pick a file from the list.</strong>
              <span>Edits save with the button above, or turn on autosave.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
