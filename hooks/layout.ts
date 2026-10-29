// Pure geometry of the side diff: how the pane splits into a tree and a
// diff region, how many rows each gets, which slice of each is drawn, and
// the diff text a slice hands the engine's Code. No $: register.tsx keeps
// the state and calls these.

import { parseHunks, type DiffLine } from './diff-lines'

// ----------------------------------------------------------------- columns

/** Body columns from which the tree and the diff sit side by side. */
export const SPLIT_MIN_COLUMNS = 80
const TREE_SHARE = 0.38
const TREE_MIN = 28
const TREE_MAX = 48
/** The dim `│` between the two regions. */
export const SEPARATOR_CELLS = 1

export type Region = 'tree' | 'diff'

export type PaneLayout =
  | { kind: 'split'; columns: number; tree: number; separator: number; diff: number }
  /** One region at a time, as wide as the pane. */
  | { kind: 'single'; columns: number; width: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** A count as a whole number of at least 0; anything not finite is 0. */
const whole = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

/**
 * The split from SPLIT_MIN_COLUMNS: the tree takes 38% (28 to 48 cells),
 * one cell for the separator, the diff the rest. Narrower, one region.
 */
export const paneLayout = (columns: number): PaneLayout => {
  const width = whole(columns)
  if (width < SPLIT_MIN_COLUMNS) return { kind: 'single', columns: width, width }
  const tree = clamp(Math.round(width * TREE_SHARE), TREE_MIN, TREE_MAX)

  return { kind: 'split', columns: width, tree, separator: SEPARATOR_CELLS, diff: width - tree - SEPARATOR_CELLS }
}

/**
 * The region under a body column (a wheel's `pointer.column`): the tree's
 * cells are the tree's, the separator and past it the diff's. With one
 * region shown, that one.
 */
export const regionAt = (layout: PaneLayout, column: number, shown: Region): Region => {
  if (layout.kind === 'single') return shown

  return column < layout.tree ? 'tree' : 'diff'
}

// -------------------------------------------------------------------- rows

/** The regions' head row: ` tree ` / ` diff ` and what the diff shows. */
export const REGION_HEAD_ROWS = 1

export type RowBudget = {
  /** Rows above the regions: header, actions, tabs, rule, summary. */
  top: number
  /** Rows of the regions, their head row included. */
  region: number
  /** Rows under the head: what a tree or diff window shows. */
  content: number
  /** The key hint at the bottom. */
  hint: number
  /** Whether it all fits `bodyRows`; when not, a region still gets a row of content. */
  fits: boolean
}

/**
 * Splits `bodyRows` into a fixed top, the regions and the hint row, so the
 * whole draws exactly `bodyRows` and the engine has nothing to scroll. Too
 * few rows still leave the regions one row of content.
 */
export const rowBudget = (bodyRows: number, topRows: number, hintRows: number, headRows = REGION_HEAD_ROWS): RowBudget => {
  const top = whole(topRows)
  const hint = whole(hintRows)
  const head = whole(headRows)
  const left = whole(bodyRows) - top - hint
  const region = Math.max(head + 1, left)

  return { top, region, content: region - head, hint, fits: left >= head + 1 }
}

/**
 * The region a wheel tick over a body cell moves: over the regions' rows,
 * heads included, the one regionAt says. Null over the rows above or the
 * hint, and whenever the whole does not fit: the engine scrolls the body then.
 */
export const wheelRegion = (
  layout: PaneLayout,
  budget: RowBudget,
  pointer: { column: number; row: number },
  shown: Region,
): Region | null => {
  if (!budget.fits || pointer.row < budget.top || pointer.row >= budget.top + budget.region) return null

  return regionAt(layout, pointer.column, shown)
}

// ----------------------------------------------------------------- windows

/** How far `d`/`b` move: half the window, at least a row. */
export const halfPage = (rows: number): number => Math.max(1, Math.floor(whole(rows) / 2))

/** The last offset that still fills the window, 0 when everything fits. */
export const maxOffset = (total: number, rows: number): number => Math.max(0, whole(total) - Math.max(1, whole(rows)))

/** An offset kept within the content. */
export const clampOffset = (offset: number, total: number, rows: number): number =>
  clamp(whole(offset), 0, maxOffset(total, rows))

/**
 * The tree window's offset with the cursor in it, moved as little as it
 * takes: up to the cursor above it, down until it is the last row below.
 */
export const treeWindow = (offset: number, cursor: number, total: number, rows: number): number => {
  const height = Math.max(1, whole(rows))
  let from = clampOffset(offset, total, height)
  if (total <= 0 || !Number.isFinite(cursor) || cursor < 0) return from
  const at = clamp(Math.floor(cursor), 0, whole(total) - 1)
  if (at < from) from = at
  else if (at >= from + height) from = at - height + 1

  return clampOffset(from, total, height)
}

/**
 * The tree window's offset once a refresh changed the rows under it, the
 * cursor on the same row: one that showed (row `was` of `wasTotal`) keeps
 * its place on screen; one a wheel took out of view leaves the window where
 * it is. `was` -1, not listed before: the window follows it as treeWindow.
 */
export const refreshedTreeWindow = (
  offset: number,
  was: number,
  wasTotal: number,
  cursor: number,
  total: number,
  rows: number,
): number => {
  if (!Number.isFinite(was) || was < 0) return treeWindow(offset, cursor, total, rows)
  const height = Math.max(1, whole(rows))
  const from = clampOffset(offset, wasTotal, height)
  if (was < from || was >= from + height) return offset

  return treeWindow(Math.max(0, from + cursor - was), cursor, total, height)
}

export type CursorMove = 'down' | 'up' | 'pageDown' | 'pageUp' | 'top' | 'bottom'

/**
 * The cursor after a move in the tree, never past either end; -1 with no
 * rows. Off any row, as v0.3's j/k: down, pageDown and top land on the
 * first row, up, pageUp and bottom on the last.
 */
export const moveCursor = (cursor: number, move: CursorMove, total: number, rows: number): number => {
  const count = whole(total)
  if (count === 0) return -1
  const at = Number.isFinite(cursor) ? Math.floor(cursor) : -1
  if (at < 0 || at >= count) return move === 'down' || move === 'pageDown' || move === 'top' ? 0 : count - 1
  const step = { down: 1, up: -1, pageDown: halfPage(rows), pageUp: -halfPage(rows), top: -count, bottom: count }[move]

  return clamp(at + step, 0, count - 1)
}

export type DiffMove = 'down' | 'up' | 'pageDown' | 'pageUp' | 'nextHunk' | 'prevHunk' | 'top' | 'bottom'

export type DiffWindow = {
  /** Rows of the diff body. */
  total: number
  /** Rows the window shows. */
  rows: number
  /** The row each hunk header sits on, ascending. */
  hunkStarts: readonly number[]
}

/**
 * The diff window's offset after a move: a row, half a window, to the next
 * or previous hunk header's row, to either end; always within the content,
 * a hunk past the last full window landing on that window.
 */
export const moveDiff = (offset: number, move: DiffMove, { total, rows, hunkStarts }: DiffWindow): number => {
  const from = clampOffset(offset, total, rows)
  const to = (row: number) => clampOffset(row, total, rows)
  switch (move) {
    case 'down':
      return to(from + 1)
    case 'up':
      return to(from - 1)
    case 'pageDown':
      return to(from + halfPage(rows))
    case 'pageUp':
      return to(from - halfPage(rows))
    case 'top':
      return 0
    case 'bottom':
      return maxOffset(total, rows)
    case 'nextHunk': {
      const next = hunkStarts.find(start => start > from)
      return next === undefined ? from : to(next)
    }
    case 'prevHunk': {
      const before = hunkStarts.filter(start => start < from)
      const prev = before[before.length - 1]
      return prev === undefined ? from : to(prev)
    }
  }
}

/** The offset a wheel's `by` rows away, within the content. */
export const scrollBy = (offset: number, by: number, total: number, rows: number): number =>
  clampOffset(clampOffset(offset, total, rows) + (Number.isFinite(by) ? Math.trunc(by) : 0), total, rows)

// -------------------------------------------------------------- diff model

export type NumberedLine = DiffLine & {
  /** The hunk it belongs to, counting from 0; -1 before any header. */
  hunk: number
  /** Its old-side line number: context and removed lines. */
  oldNo?: number
  /** Its new-side line number: context and added lines. */
  newNo?: number
  /**
   * Where each side stands at this line: its own number, or for a line the
   * side lacks the next one. Absent where the hunk header does not parse.
   */
  oldAt?: number
  newAt?: number
}

export type NumberedDiff = {
  lines: NumberedLine[]
  /** The index of each hunk header in `lines`. */
  hunkStarts: number[]
}

// HUNK_HEADER drops the counts; a count of 0 moves the start back a line.
const HEADER_COUNTS = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Where a side starts: git writes a side with no lines as the line before it. */
const sideStart = (start: string | undefined, count: string | undefined): number | undefined => {
  const at = Number(start)
  if (!Number.isSafeInteger(at)) return undefined

  return count !== undefined && Number(count) === 0 ? at + 1 : at
}

/**
 * The lines parseHunks reads from `hunks`, each with its line numbers on
 * either side, counted from its hunk's header. Never throws.
 */
export const numberHunks = (hunks: string): NumberedDiff => {
  const lines: NumberedLine[] = []
  const hunkStarts: number[] = []
  let hunk = -1
  let oldAt: number | undefined
  let newAt: number | undefined
  for (const line of parseHunks(hunks)) {
    if (line.kind === 'hunk') {
      hunk += 1
      hunkStarts.push(lines.length)
      const match = line.text.match(HEADER_COUNTS)
      oldAt = match ? sideStart(match[1], match[2]) : undefined
      newAt = match ? sideStart(match[3], match[4]) : undefined
      if (oldAt === undefined || newAt === undefined) oldAt = newAt = undefined
      lines.push({ ...line, hunk })
      continue
    }
    const numbered: NumberedLine = { ...line, hunk }
    if (oldAt !== undefined && newAt !== undefined) {
      numbered.oldAt = oldAt
      numbered.newAt = newAt
      if (line.kind === 'ctx' || line.kind === 'del') numbered.oldNo = oldAt
      if (line.kind === 'ctx' || line.kind === 'add') numbered.newNo = newAt
      if (line.kind === 'ctx' || line.kind === 'del') oldAt += 1
      if (line.kind === 'ctx' || line.kind === 'add') newAt += 1
    }
    lines.push(numbered)
  }

  return { lines, hunkStarts }
}

const MARK: Record<'add' | 'del' | 'ctx', string> = { add: '+', del: '-', ctx: ' ' }

/** One run of body lines as a hunk: a header counting just these lines. */
const runHunk = (run: readonly NumberedLine[], ctx: string | undefined): string | null => {
  const first = run[0]
  if (first?.oldAt === undefined || first.newAt === undefined) return null
  let oldCount = 0
  let newCount = 0
  const body: string[] = []
  for (const line of run) {
    if (line.kind === 'meta') {
      body.push(line.text)
      continue
    }
    if (line.kind === 'hunk' || line.oldAt === undefined) return null
    if (line.kind !== 'add') oldCount += 1
    if (line.kind !== 'del') newCount += 1
    body.push(`${MARK[line.kind]}${line.text}`)
  }
  const oldStart = oldCount === 0 ? first.oldAt - 1 : first.oldAt
  const newStart = newCount === 0 ? first.newAt - 1 : first.newAt
  const head = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${ctx !== undefined ? ` ${ctx}` : ''}`

  return [head, ...body].join('\n')
}

/**
 * The rows `offset` to `offset + rows` of a numbered diff as hunks Code's
 * diff format reads: each stretch between headers under a header of its
 * own, numbered and counted for the lines it keeps, a real header's function
 * context kept when the window holds that header. Lines keep their cleaned
 * text (tabs expanded). Null when the slice holds no line to draw or a hunk
 * whose header does not parse: draw it another way.
 */
export const windowHunks = (diff: NumberedDiff, offset: number, rows: number): string | null => {
  const from = clampOffset(offset, diff.lines.length, rows)
  const slice = diff.lines.slice(from, from + Math.max(1, whole(rows)))
  const hunks: string[] = []
  let isBroken = false
  let run: NumberedLine[] = []
  let ctx: string | undefined
  const close = () => {
    // A `\ No newline` whose line is above the window has nothing to follow.
    while (run[0]?.kind === 'meta') run.shift()
    if (run.length > 0) {
      const hunk = runHunk(run, ctx)
      if (hunk === null) isBroken = true
      else hunks.push(hunk)
    }
    run = []
    ctx = undefined
  }
  for (const line of slice) {
    if (line.kind === 'hunk') {
      close()
      ctx = line.ctx
      continue
    }
    run.push(line)
  }
  close()
  if (isBroken || hunks.length === 0) return null

  return hunks.join('\n')
}
