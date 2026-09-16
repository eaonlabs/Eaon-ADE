import { siClaude, siGithubcopilot, siGooglegemini } from 'simple-icons'
import { Terminal } from 'lucide-react'
import grokUrl from '../assets/agents/grok.svg'
import kimiUrl from '../assets/agents/kimi.svg'
import mistralUrl from '../assets/agents/mistral.svg'
import opencodeUrl from '../assets/agents/opencode.svg'

/**
 * What is actually running in a pane, said with the agent's own mark.
 *
 * A pane header used to carry a status dot, a number and a handle — Ada, Bo,
 * Cleo — and nothing about which agent was inside it. With six panes in a grid
 * and three different CLIs among them, "which of these is Codex" was a question
 * you answered by reading the scrollback.
 *
 * Marks come from the vendors, not from hand-drawing: a wrong curve in a brand
 * mark reads as broken rather than stylised. Two sources, chosen per mark
 * rather than uniformly, because the two kinds behave differently:
 *
 * - **A path** (`simple-icons`, or one lifted from a vendor SVG that has
 *   exactly one path) can be recoloured. That matters for the monochrome
 *   marks — OpenAI's and Copilot's are solid black, which is invisible on
 *   every dark theme this app ships. Those are drawn in `currentColor` so
 *   they follow the header's text colour instead of disappearing.
 * - **A file** is used where the mark is genuinely multi-colour — gradients,
 *   masks, two-tone fills — because flattening those to one path would be a
 *   redrawing, not an import. Vite hands back a URL and the browser renders
 *   the vendor's own file untouched.
 */

/** OpenAI's lockup reduced to its single path, lifted from the vendor SVG
 *  (`chatgpt.svg`, one path, viewBox 1516x1536) so it can take currentColor. */
const OPENAI = {
  path: 'm1415.5 629.1c34.9-104.5 22.9-219-32.8-314.1-83.8-145.9-252.2-220.9-416.6-185.6-73.2-82.4-178.3-129.3-288.5-128.6-168.1-0.4-317.3 107.8-369 267.8-108 22.1-201.2 89.7-255.7 185.5-84.4 145.5-65.2 328.8 47.6 453.6-34.9 104.5-22.9 219 32.8 314.1 83.8 145.9 252.2 220.9 416.6 185.6 73.1 82.4 178.3 129.3 288.5 128.6 168.2 0.4 317.4-107.9 369.1-268 108-22.2 201.2-89.8 255.8-185.6 84.3-145.4 65-328.6-47.7-453.4zm-577.1 806.5c-67.3 0.1-132.5-23.4-184.1-66.5 2.3-1.3 6.4-3.6 9-5.2l305.7-176.5c15.7-8.9 25.3-25.6 25.2-43.5v-431l129.2 74.6c1.4 0.7 2.3 2 2.5 3.5v356.9c-0.2 158.7-128.8 287.4-287.5 287.7zm-618.1-264c-33.7-58.2-45.8-126.5-34.3-192.7 2.3 1.3 6.3 3.8 9.1 5.4l305.7 176.5c15.5 9.1 34.7 9.1 50.2 0l373.2-215.5v149.2c0.1 1.6-0.6 3.1-1.8 4l-309 178.4c-137.6 79.3-313.4 32.2-393-105.3zm-80.5-667.3c33.6-58.3 86.6-102.9 149.8-126.1 0 2.7-0.2 7.3-0.2 10.6v353.1c-0.1 18 9.5 34.6 25.1 43.5l373.2 215.4-129.2 74.6c-1.3 0.9-2.9 1.1-4.4 0.4l-309-178.5c-137.4-79.6-184.5-255.3-105.3-392.9zm1061.5 247l-373.2-215.5 129.2-74.5c1.3-0.9 2.9-1 4.3-0.4l309.1 178.4c137.6 79.5 184.7 255.5 105.3 393.1-33.7 58.2-86.6 102.9-149.7 126.1v-363.7c0.1-18-9.4-34.6-25-43.5zm128.6-193.5c-2.3-1.4-6.2-3.8-9.1-5.4l-305.7-176.6c-15.5-9-34.6-9-50.2 0l-373.2 215.5v-149.2c-0.1-1.5 0.6-3 1.8-4l309-178.2c137.7-79.4 313.7-32.2 393 105.5 33.5 58.2 45.7 126.2 34.3 192.4zm-808.4 265.9l-129.3-74.6c-1.4-0.7-2.3-2-2.5-3.5v-356.9c0.1-158.9 129-287.7 287.9-287.6 67.3 0 132.3 23.6 184 66.6-2.4 1.3-6.4 3.5-9.1 5.1l-305.7 176.6c-15.6 8.9-25.2 25.5-25.1 43.4l-0.2 430.8zm70.2-151.3l166.2-96 166.2 96v191.9l-166.2 96-166.2-96z',
  viewBox: '0 0 1516 1536'
}

type Mark =
  /** Drawn from a path. `mono` marks follow the text colour. */
  | { kind: 'path'; path: string; viewBox?: string; hex?: string; mono?: true; short: string }
  /** Rendered from the vendor's own file, colours and all. `onDark` marks were
   *  drawn for a dark background and carry white in them, so they get a fixed
   *  dark chip rather than being left to vanish on a light theme. */
  | { kind: 'file'; url: string; short: string; onDark?: true }
  /** No mark exists — a lettered chip in the agent's colour, honestly. */
  | { kind: 'letter'; hex: string; short: string }

const MARKS: Record<string, Mark> = {
  claude: { kind: 'path', path: siClaude.path, hex: siClaude.hex, short: 'Claude' },
  gemini: { kind: 'path', path: siGooglegemini.path, hex: siGooglegemini.hex, short: 'Gemini' },
  // Both solid black at source, so both follow the text colour instead.
  codex: { kind: 'path', path: OPENAI.path, viewBox: OPENAI.viewBox, mono: true, short: 'Codex' },
  copilot: { kind: 'path', path: siGithubcopilot.path, mono: true, short: 'Copilot' },
  opencode: { kind: 'file', url: opencodeUrl, short: 'OpenCode' },
  // The vendor ships this as `k-only-dark` — two paths, one blue and one
  // white. On a light theme the white K disappears and only a blue speck is
  // left, measured. The chip below is the same fixed-tone treatment the
  // integrations panel uses, so the artwork is never recoloured, just given
  // the background it was drawn against.
  kimi: { kind: 'file', url: kimiUrl, short: 'Kimi', onDark: true },
  mistral: { kind: 'file', url: mistralUrl, short: 'Mistral' },
  grok: { kind: 'file', url: grokUrl, short: 'Grok' },
  // Nothing maintained exists for Aider; a lettered chip rather than a bad
  // redrawing, the same honest omission Azure DevOps gets in Integrations.
  aider: { kind: 'letter', hex: '7C5CFF', short: 'Aider' },
  shell: { kind: 'letter', hex: '8A8781', short: 'Shell' }
}

/** What the header calls this agent. Shorter than `AgentDef.label`: the header
 *  is narrow, and "Claude Code" beside a Claude mark says Claude twice. */
export function agentShortName(agentId: string): string {
  return MARKS[agentId]?.short ?? agentId
}

export function AgentMark({
  agentId,
  size = 12
}: {
  agentId: string
  size?: number
}): React.JSX.Element {
  const mark = MARKS[agentId]

  // A plain shell is not a brand and should not be dressed as one.
  if (!mark || agentId === 'shell') {
    return <Terminal size={size} aria-hidden="true" style={{ color: 'var(--text-lo)' }} />
  }

  if (mark.kind === 'path') {
    return (
      <svg width={size} height={size} viewBox={mark.viewBox ?? '0 0 24 24'} aria-hidden="true">
        <path d={mark.path} fill={mark.mono ? 'currentColor' : `#${mark.hex}`} />
      </svg>
    )
  }

  if (mark.kind === 'file') {
    const img = (
      <img src={mark.url} width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block' }} />
    )
    if (!mark.onDark) return img
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'inline-grid',
          placeItems: 'center',
          width: size + 3,
          height: size + 3,
          borderRadius: 3,
          // Fixed, not a theme token: the point is that it does not follow the
          // theme, because the artwork inside it does not either.
          background: '#12161c'
        }}
      >
        {img}
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: size,
        height: size,
        borderRadius: 3,
        background: `#${mark.hex}`,
        color: '#fff',
        fontSize: Math.round(size * 0.66),
        fontWeight: 700,
        lineHeight: 1
      }}
    >
      {mark.short[0]}
    </span>
  )
}
