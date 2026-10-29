// Pure parsing of the hunks loadFileDiff returns (from the first `@@`, maybe
// cut by truncateHunks) into lines the pane draws itself. Never throws: a
// line it does not know is context.

import { HUNK_HEADER } from './git'

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta'

export type DiffLine = {
  kind: DiffLineKind
  /** `hunk` only: the first line number on the new side, absent when the header does not parse. */
  newStart?: number
  /** `hunk` only: the first line number on the old side, absent when the header does not parse. */
  oldStart?: number
  /** `hunk` only: the function context git prints after the header, absent when none. */
  ctx?: string
  /**
   * What to draw, safe for a Text: the `+`/`-`/` ` marker dropped, tabs
   * expanded, control characters replaced. A `hunk` keeps its whole header,
   * a `meta` line (`\ No newline at end of file`) its whole text.
   */
  text: string
}

/** Columns a tab advances to; the engine draws a prompt's tab as four spaces too. */
export const TAB_WIDTH = 4

const PURE_ADD_HEADER = /^@@ -0,0 \+\d+(?:,\d+)? @@/

// Text refuses control characters but tab and newline, and a line holds no
// newline; a CRLF's `\r` is dropped as `printable` drops it.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]

/** Terminal cells one code point takes: East Asian wide characters and emoji two, combining marks none. */
export const charWidth = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0

  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1
}

/** Tabs to spaces up to the next stop, a wide character counting two columns. */
export const expandTabs = (text: string, width = TAB_WIDTH): string => {
  if (!text.includes('\t')) return text
  let out = ''
  let column = 0
  for (const char of text) {
    if (char === '\t') {
      const pad = width - (column % width)
      out += ' '.repeat(pad)
      column += pad
    } else {
      out += char
      column += charWidth(char)
    }
  }

  return out
}

/** One line as a Text may draw it. */
export const cleanLine = (text: string): string =>
  expandTabs(text.replace(/\r$/, '').replace(CONTROL, '�'))

/** The lines of a hunks string, a trailing newline not making an empty last line. */
const splitLines = (hunks: string): string[] => {
  if (hunks === '') return []
  const lines = hunks.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  return lines
}

const parseLine = (line: string): DiffLine => {
  const marker = line[0]
  if (line.startsWith('@@')) {
    const match = line.match(HUNK_HEADER)
    const hunk: DiffLine = { kind: 'hunk', text: cleanLine(line) }
    if (match) {
      const oldStart = Number(match[1])
      if (Number.isSafeInteger(oldStart)) hunk.oldStart = oldStart
      const start = Number(match[2])
      if (Number.isSafeInteger(start)) hunk.newStart = start
      const ctx = cleanLine((match[3] ?? '').trim())
      if (ctx !== '') hunk.ctx = ctx
    }
    return hunk
  }
  if (marker === '+') return { kind: 'add', text: cleanLine(line.slice(1)) }
  if (marker === '-') return { kind: 'del', text: cleanLine(line.slice(1)) }
  if (marker === ' ') return { kind: 'ctx', text: cleanLine(line.slice(1)) }
  if (marker === '\\') return { kind: 'meta', text: cleanLine(line) }

  return { kind: 'ctx', text: cleanLine(line) }
}

/** Every line of `hunks`, in order, typed by its marker. */
export const parseHunks = (hunks: string): DiffLine[] => {
  if (typeof hunks !== 'string') return []

  return splitLines(hunks).map(parseLine)
}

/**
 * The source text of a file the hunks add whole: one `@@ -0,0 +…` hunk of
 * only `+` lines (a `\ No newline at end of file` allowed). The `+` markers
 * are dropped; tabs are kept for Code, which draws them itself; control
 * characters are replaced as `printable` does. Null for any other diff.
 */
export const addedSource = (hunks: string): string | null => {
  if (typeof hunks !== 'string') return null
  const lines = splitLines(hunks)
  if (lines.length < 2 || !PURE_ADD_HEADER.test(lines[0] ?? '')) return null

  const source: string[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith('+')) {
      source.push(line.slice(1).replace(/\r$/, '').replace(CONTROL, '�'))
    } else if (!line.startsWith('\\')) {
      return null
    }
  }

  return source.length > 0 ? source.join('\n') : null
}

/** True when the hunks add a whole file and nothing else. */
export const isPureAdd = (hunks: string): boolean => addedSource(hunks) !== null
