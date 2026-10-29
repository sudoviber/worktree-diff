import { describe, expect, test } from 'claude-code/testing'

import { splitHunks, truncateHunks } from './git'
import {
  clampOffset,
  halfPage,
  maxOffset,
  moveCursor,
  moveDiff,
  numberHunks,
  paneLayout,
  refreshedTreeWindow,
  regionAt,
  rowBudget,
  scrollBy,
  treeWindow,
  wheelRegion,
  windowHunks,
  type CursorMove,
  type DiffMove,
  type NumberedDiff,
} from './layout'

// Real `git diff` output (diff.context=3, as loadFileDiff runs it unless
// noted), fed through splitHunks the way loadFileDiff does. multi.txt is
// `line 1`..`line 30` with line 2 changed, 15–16 removed, two added after 28.
const MULTI = [
  'diff --git a/multi.txt b/multi.txt',
  'index ac9837c..d40142c 100644',
  '--- a/multi.txt',
  '+++ b/multi.txt',
  '@@ -1,5 +1,5 @@',
  ' line 1',
  '-line 2',
  '+LINE 2',
  ' line 3',
  ' line 4',
  ' line 5',
  '@@ -12,8 +12,6 @@ line 11',
  ' line 12',
  ' line 13',
  ' line 14',
  '-line 15',
  '-line 16',
  ' line 17',
  ' line 18',
  ' line 19',
  '@@ -26,5 +24,7 @@ line 25',
  ' line 26',
  ' line 27',
  ' line 28',
  '+new a',
  '+new b',
  ' line 29',
  ' line 30',
  '',
].join('\n')

// The same change with -U0: hunks whose one side has no lines, and counts of one left out.
const MULTI_U0 = [
  'diff --git a/multi.txt b/multi.txt',
  'index ac9837c..d40142c 100644',
  '--- a/multi.txt',
  '+++ b/multi.txt',
  '@@ -2 +2 @@ line 1',
  '-line 2',
  '+LINE 2',
  '@@ -15,2 +14,0 @@ line 14',
  '-line 15',
  '-line 16',
  '@@ -28,0 +27,2 @@ line 28',
  '+new a',
  '+new b',
  '',
].join('\n')

// And with -U1.
const MULTI_U1 = [
  'diff --git a/multi.txt b/multi.txt',
  'index ac9837c..d40142c 100644',
  '--- a/multi.txt',
  '+++ b/multi.txt',
  '@@ -1,3 +1,3 @@',
  ' line 1',
  '-line 2',
  '+LINE 2',
  ' line 3',
  '@@ -14,4 +14,2 @@ line 13',
  ' line 14',
  '-line 15',
  '-line 16',
  ' line 17',
  '@@ -28,2 +26,4 @@ line 27',
  ' line 28',
  '+new a',
  '+new b',
  ' line 29',
  '',
].join('\n')

const FUNCTION = [
  'diff --git a/ctx.js b/ctx.js',
  'index 0d5cc6f..f659a7e 100644',
  '--- a/ctx.js',
  '+++ b/ctx.js',
  '@@ -7,7 +7,7 @@ function b() {',
  '   three',
  '   four',
  '   five',
  '-  six',
  '+  SIX',
  '   seven',
  '   eight',
  ' }',
  '',
].join('\n')

const NO_NEWLINE = [
  'diff --git a/nonl.txt b/nonl.txt',
  'index 66455a1..1741196 100644',
  '--- a/nonl.txt',
  '+++ b/nonl.txt',
  '@@ -1,3 +1,3 @@',
  ' x',
  ' y',
  '-z',
  '\\ No newline at end of file',
  '+Z',
  '\\ No newline at end of file',
  '',
].join('\n')

// The first two lines removed: a hunk at the very top.
const HEAD_DELETED = [
  'diff --git a/dels.txt b/dels.txt',
  'index ba38ef5..21b097f 100644',
  '--- a/dels.txt',
  '+++ b/dels.txt',
  '@@ -1,5 +1,3 @@',
  '-keep 1',
  '-keep 2',
  ' keep 3',
  ' keep 4',
  ' keep 5',
  '',
].join('\n')

// An intent-to-add file (`git add -N`), one line tab-indented.
const ADDED = [
  'diff --git a/added.txt b/added.txt',
  'new file mode 100644',
  'index 0000000..7d722a5',
  '--- /dev/null',
  '+++ b/added.txt',
  '@@ -0,0 +1,3 @@',
  '+alpha',
  '+\tbeta',
  '+gamma',
  '',
].join('\n')

const FIXTURES: Record<string, string> = {
  MULTI,
  MULTI_U0,
  MULTI_U1,
  FUNCTION,
  NO_NEWLINE,
  HEAD_DELETED,
  ADDED,
}

/** A numbered line as `kind old new text`, `.` for a side it lacks. */
const show = (diff: NumberedDiff) =>
  diff.lines.map(l => `${l.kind} ${l.oldNo ?? '.'} ${l.newNo ?? '.'} ${l.kind === 'hunk' ? '' : l.text}`.trimEnd())

const HEADER = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/

describe('paneLayout', () => {
  test('splits from 80 body columns, one region below', async () => {
    expect(paneLayout(79)).toEqual({ kind: 'single', columns: 79, width: 79 })
    expect(paneLayout(70)).toEqual({ kind: 'single', columns: 70, width: 70 })
    expect(paneLayout(80)).toEqual({ kind: 'split', columns: 80, tree: 30, separator: 1, diff: 49 })
    expect(paneLayout(90)).toEqual({ kind: 'split', columns: 90, tree: 34, separator: 1, diff: 55 })
    expect(paneLayout(120)).toEqual({ kind: 'split', columns: 120, tree: 46, separator: 1, diff: 73 })
  })

  test('the tree takes 38%, held between 28 and 48 cells', async () => {
    expect(paneLayout(200)).toEqual({ kind: 'split', columns: 200, tree: 48, separator: 1, diff: 151 })
    expect(paneLayout(127)).toEqual({ kind: 'split', columns: 127, tree: 48, separator: 1, diff: 78 })
    expect((paneLayout(124) as { tree: number }).tree).toBe(47)
    for (let columns = 80; columns <= 300; columns++) {
      const layout = paneLayout(columns)
      if (layout.kind !== 'split') throw new Error(`single at ${columns}`)
      expect(layout.tree).toBeGreaterThanOrEqual(28)
      expect(layout.tree).toBeLessThanOrEqual(48)
      expect(layout.tree + layout.separator + layout.diff).toBe(columns)
      expect(layout.diff).toBeGreaterThan(layout.tree)
    }
  })

  test('a width that is not a count is none', async () => {
    expect(paneLayout(Number.NaN)).toEqual({ kind: 'single', columns: 0, width: 0 })
    expect(paneLayout(-5)).toEqual({ kind: 'single', columns: 0, width: 0 })
    expect(paneLayout(95.7)).toEqual(paneLayout(95))
  })
})

describe('regionAt', () => {
  test('the tree cells are the tree, the separator and past it the diff', async () => {
    const layout = paneLayout(90)
    expect(regionAt(layout, 0, 'diff')).toBe('tree')
    expect(regionAt(layout, 33, 'diff')).toBe('tree')
    expect(regionAt(layout, 34, 'tree')).toBe('diff')
    expect(regionAt(layout, 89, 'tree')).toBe('diff')
  })

  test('one region shown: always that one', async () => {
    const layout = paneLayout(70)
    expect(regionAt(layout, 0, 'diff')).toBe('diff')
    expect(regionAt(layout, 60, 'tree')).toBe('tree')
  })
})

describe('rowBudget', () => {
  test('the top, the regions and the hint make up bodyRows exactly', async () => {
    expect(rowBudget(30, 7, 1)).toEqual({ top: 7, region: 22, content: 21, hint: 1, fits: true })
    for (let bodyRows = 10; bodyRows <= 60; bodyRows++) {
      const budget = rowBudget(bodyRows, 7, 1)
      expect(budget.top + budget.region + budget.hint).toBe(bodyRows)
      expect(budget.content).toBe(budget.region - 1)
      expect(budget.fits).toBe(true)
    }
  })

  test('too few rows still leave a row of content, and say it does not fit', async () => {
    expect(rowBudget(9, 7, 1)).toEqual({ top: 7, region: 2, content: 1, hint: 1, fits: false })
    expect(rowBudget(10, 7, 1)).toEqual({ top: 7, region: 2, content: 1, hint: 1, fits: true })
    expect(rowBudget(4, 7, 1)).toEqual({ top: 7, region: 2, content: 1, hint: 1, fits: false })
    expect(rowBudget(0, 0, 0)).toEqual({ top: 0, region: 2, content: 1, hint: 0, fits: false })
  })

  test('no hint row, or no head row', async () => {
    expect(rowBudget(20, 6, 0)).toEqual({ top: 6, region: 14, content: 13, hint: 0, fits: true })
    expect(rowBudget(20, 6, 1, 0)).toEqual({ top: 6, region: 13, content: 13, hint: 1, fits: true })
  })
})

describe('wheelRegion', () => {
  test('the regions rows, heads included, go by column; the top and the hint are the engine’s', async () => {
    const layout = paneLayout(90)
    const budget = rowBudget(24, 7, 1)
    expect(wheelRegion(layout, budget, { column: 3, row: 6 }, 'tree')).toBeNull()
    expect(wheelRegion(layout, budget, { column: 3, row: 7 }, 'diff')).toBe('tree')
    expect(wheelRegion(layout, budget, { column: 60, row: 22 }, 'tree')).toBe('diff')
    expect(wheelRegion(layout, budget, { column: 60, row: 23 }, 'tree')).toBeNull()
    expect(wheelRegion(layout, budget, { column: 3, row: -1 }, 'tree')).toBeNull()
    expect(wheelRegion(paneLayout(70), budget, { column: 3, row: 10 }, 'diff')).toBe('diff')
  })

  test('a body that does not fit is the engine’s to scroll, wherever the pointer is', async () => {
    const budget = rowBudget(9, 7, 1)
    expect(budget.fits).toBe(false)
    expect(wheelRegion(paneLayout(90), budget, { column: 3, row: 7 }, 'tree')).toBeNull()
  })
})

describe('windows', () => {
  test('half a window, at least a row', async () => {
    expect(halfPage(21)).toBe(10)
    expect(halfPage(2)).toBe(1)
    expect(halfPage(1)).toBe(1)
    expect(halfPage(0)).toBe(1)
  })

  test('offsets stay within the content', async () => {
    expect(maxOffset(24, 10)).toBe(14)
    expect(maxOffset(5, 10)).toBe(0)
    expect(maxOffset(5, 0)).toBe(4)
    expect(clampOffset(20, 24, 10)).toBe(14)
    expect(clampOffset(-3, 24, 10)).toBe(0)
    expect(clampOffset(3.9, 24, 10)).toBe(3)
    expect(clampOffset(Number.NaN, 24, 10)).toBe(0)
    expect(clampOffset(7, 0, 10)).toBe(0)
  })

  test('scrollBy moves by the wheel within the content', async () => {
    expect(scrollBy(3, 1, 24, 10)).toBe(4)
    expect(scrollBy(3, -5, 24, 10)).toBe(0)
    expect(scrollBy(13, 3, 24, 10)).toBe(14)
    expect(scrollBy(2, 1, 5, 10)).toBe(0)
    expect(scrollBy(2, Number.NaN, 24, 10)).toBe(2)
    expect(scrollBy(50, -1, 24, 10)).toBe(13)
  })
})

describe('treeWindow', () => {
  test('a cursor in the window moves nothing', async () => {
    expect(treeWindow(5, 5, 40, 10)).toBe(5)
    expect(treeWindow(5, 14, 40, 10)).toBe(5)
  })

  test('the window follows the cursor by as little as it takes', async () => {
    expect(treeWindow(5, 15, 40, 10)).toBe(6)
    expect(treeWindow(5, 4, 40, 10)).toBe(4)
    expect(treeWindow(0, 39, 40, 10)).toBe(30)
    expect(treeWindow(30, 0, 40, 10)).toBe(0)
  })

  test('a window left past a shrunk list is pulled back', async () => {
    expect(treeWindow(30, 3, 8, 10)).toBe(0)
    expect(treeWindow(30, 12, 15, 10)).toBe(5)
  })

  test('a cursor past the end counts as the last row; none moves nothing', async () => {
    expect(treeWindow(0, 99, 40, 10)).toBe(30)
    expect(treeWindow(7, -1, 40, 10)).toBe(7)
    expect(treeWindow(7, 3, 0, 10)).toBe(0)
  })

  test('walking the cursor keeps it in view, moving the window only at its edges', async () => {
    const total = 37
    const rows = 9
    const moves: CursorMove[] = ['down', 'down', 'pageDown', 'bottom', 'up', 'pageUp', 'pageUp', 'top', 'pageDown']
    let cursor = 0
    let offset = 0
    for (let i = 0; i < 200; i++) {
      const move = moves[(i * 7) % moves.length] as CursorMove
      cursor = moveCursor(cursor, move, total, rows)
      const next = treeWindow(offset, cursor, total, rows)
      expect(cursor).toBeGreaterThanOrEqual(next)
      expect(cursor).toBeLessThan(next + rows)
      if (cursor >= offset && cursor < offset + rows) expect(next).toBe(offset)
      offset = next
    }
  })
})

describe('refreshedTreeWindow', () => {
  test('a cursor that showed keeps its place on screen as rows come and go above it', async () => {
    // Row 7 of 40, shown 3rd from the top of a window at 5.
    expect(refreshedTreeWindow(5, 7, 40, 7, 40, 10)).toBe(5)
    expect(refreshedTreeWindow(5, 7, 40, 9, 42, 10)).toBe(7)
    expect(refreshedTreeWindow(5, 7, 40, 4, 37, 10)).toBe(2)
    // Pulled back where the list ends, the cursor still in the window.
    expect(refreshedTreeWindow(5, 7, 40, 7, 12, 10)).toBe(2)
  })

  test('a cursor a wheel took out of view leaves the window where it is', async () => {
    expect(refreshedTreeWindow(20, 3, 40, 3, 40, 10)).toBe(20)
    expect(refreshedTreeWindow(20, 3, 40, 5, 42, 10)).toBe(20)
    expect(refreshedTreeWindow(0, 15, 40, 15, 40, 10)).toBe(0)
  })

  test('a cursor not listed before is followed as treeWindow does', async () => {
    expect(refreshedTreeWindow(20, -1, 40, 3, 40, 10)).toBe(3)
    expect(refreshedTreeWindow(0, -1, 0, 15, 40, 10)).toBe(6)
  })
})

describe('moveCursor', () => {
  test('a row, half a window, either end, never past them', async () => {
    expect(moveCursor(3, 'down', 10, 6)).toBe(4)
    expect(moveCursor(3, 'up', 10, 6)).toBe(2)
    expect(moveCursor(3, 'pageDown', 10, 6)).toBe(6)
    expect(moveCursor(3, 'pageUp', 10, 6)).toBe(0)
    expect(moveCursor(3, 'top', 10, 6)).toBe(0)
    expect(moveCursor(3, 'bottom', 10, 6)).toBe(9)
    expect(moveCursor(9, 'down', 10, 6)).toBe(9)
    expect(moveCursor(0, 'up', 10, 6)).toBe(0)
    expect(moveCursor(8, 'pageDown', 10, 6)).toBe(9)
  })

  test('no rows, no cursor; off any row, down starts at the first and up at the last', async () => {
    expect(moveCursor(3, 'down', 0, 6)).toBe(-1)
    expect(moveCursor(-1, 'down', 10, 6)).toBe(0)
    expect(moveCursor(-1, 'pageDown', 10, 6)).toBe(0)
    expect(moveCursor(Number.NaN, 'down', 10, 6)).toBe(0)
    expect(moveCursor(-1, 'up', 10, 6)).toBe(9)
    expect(moveCursor(-1, 'pageUp', 10, 6)).toBe(9)
    expect(moveCursor(Number.NaN, 'up', 10, 6)).toBe(9)
    expect(moveCursor(-1, 'top', 10, 6)).toBe(0)
    expect(moveCursor(-1, 'bottom', 10, 6)).toBe(9)
    expect(moveCursor(42, 'up', 10, 6)).toBe(9)
    expect(moveCursor(42, 'down', 10, 6)).toBe(0)
  })
})

describe('numberHunks', () => {
  test('numbers each side from its hunk header', async () => {
    const diff = numberHunks(splitHunks(MULTI))
    expect(diff.hunkStarts).toEqual([0, 7, 16])
    expect(show(diff)).toEqual([
      'hunk . .',
      'ctx 1 1 line 1',
      'del 2 . line 2',
      'add . 2 LINE 2',
      'ctx 3 3 line 3',
      'ctx 4 4 line 4',
      'ctx 5 5 line 5',
      'hunk . .',
      'ctx 12 12 line 12',
      'ctx 13 13 line 13',
      'ctx 14 14 line 14',
      'del 15 . line 15',
      'del 16 . line 16',
      'ctx 17 15 line 17',
      'ctx 18 16 line 18',
      'ctx 19 17 line 19',
      'hunk . .',
      'ctx 26 24 line 26',
      'ctx 27 25 line 27',
      'ctx 28 26 line 28',
      'add . 27 new a',
      'add . 28 new b',
      'ctx 29 29 line 29',
      'ctx 30 30 line 30',
    ])
    expect(diff.lines.map(l => l.hunk)).toEqual([...Array(7).fill(0), ...Array(9).fill(1), ...Array(8).fill(2)])
  })

  test('a side with no lines starts after the line its header names', async () => {
    const diff = numberHunks(splitHunks(MULTI_U0))
    expect(show(diff)).toEqual([
      'hunk . .',
      'del 2 . line 2',
      'add . 2 LINE 2',
      'hunk . .',
      'del 15 . line 15',
      'del 16 . line 16',
      'hunk . .',
      'add . 27 new a',
      'add . 28 new b',
    ])
    // Where the side without the line stands: the next line it has.
    expect(diff.lines.slice(4, 6).map(l => l.newAt)).toEqual([14 + 1, 14 + 1])
    expect(diff.lines.slice(7).map(l => l.oldAt)).toEqual([28 + 1, 28 + 1])
  })

  test('a file added whole numbers only its new side', async () => {
    expect(show(numberHunks(splitHunks(ADDED)))).toEqual(['hunk . .', 'add . 1 alpha', 'add . 2     beta', 'add . 3 gamma'])
  })

  test('a `\\ No newline` line takes no number', async () => {
    expect(show(numberHunks(splitHunks(NO_NEWLINE)))).toEqual([
      'hunk . .',
      'ctx 1 1 x',
      'ctx 2 2 y',
      'del 3 . z',
      'meta . . \\ No newline at end of file',
      'add . 3 Z',
      'meta . . \\ No newline at end of file',
    ])
  })

  test('a header it cannot read leaves its lines unnumbered, the next hunk numbered again', async () => {
    const diff = numberHunks(['@@ broken @@', '+a', ' b', '@@ -4,1 +4,1 @@', '-c', '+C'].join('\n'))
    expect(diff.hunkStarts).toEqual([0, 3])
    expect(show(diff)).toEqual(['hunk . .', 'add . . a', 'ctx . . b', 'hunk . .', 'del 4 . c', 'add . 4 C'])
    expect(diff.lines[1]?.oldAt).toBeUndefined()
  })

  test('cut hunks still number, their last header rewritten', async () => {
    const { hunks } = truncateHunks(splitHunks(MULTI), 10)
    const diff = numberHunks(hunks)
    expect(diff.hunkStarts).toEqual([0, 7])
    expect(show(diff).slice(7)).toEqual(['hunk . .', 'ctx 12 12 line 12', 'ctx 13 13 line 13'])
  })

  test('nothing, or no string, is no lines', async () => {
    expect(numberHunks('')).toEqual({ lines: [], hunkStarts: [] })
    expect(numberHunks(undefined as unknown as string)).toEqual({ lines: [], hunkStarts: [] })
  })
})

describe('moveDiff', () => {
  const diff = numberHunks(splitHunks(MULTI))
  const window = { total: diff.lines.length, rows: 10, hunkStarts: diff.hunkStarts }
  const move = (offset: number, step: DiffMove) => moveDiff(offset, step, window)

  test('a row, half a window, either end, never past them', async () => {
    expect(window.total).toBe(24)
    expect(move(0, 'down')).toBe(1)
    expect(move(14, 'down')).toBe(14)
    expect(move(1, 'up')).toBe(0)
    expect(move(0, 'up')).toBe(0)
    expect(move(3, 'pageDown')).toBe(8)
    expect(move(12, 'pageDown')).toBe(14)
    expect(move(8, 'pageUp')).toBe(3)
    expect(move(3, 'pageUp')).toBe(0)
    expect(move(9, 'top')).toBe(0)
    expect(move(0, 'bottom')).toBe(14)
  })

  test('to the next and previous hunk header', async () => {
    expect(move(0, 'nextHunk')).toBe(7)
    expect(move(3, 'nextHunk')).toBe(7)
    expect(move(9, 'prevHunk')).toBe(7)
    expect(move(7, 'prevHunk')).toBe(0)
    expect(move(0, 'prevHunk')).toBe(0)
  })

  test('a hunk past the last full window lands on that window', async () => {
    expect(move(7, 'nextHunk')).toBe(14)
    expect(move(14, 'nextHunk')).toBe(14)
    expect(move(14, 'prevHunk')).toBe(7)
  })

  test('an offset left past the content is pulled back first', async () => {
    expect(move(50, 'up')).toBe(13)
    expect(move(50, 'nextHunk')).toBe(14)
    expect(moveDiff(6, 'down', { total: 4, rows: 10, hunkStarts: [0] })).toBe(0)
  })

  test('no hunks, no jump', async () => {
    const plain = { total: 30, rows: 10, hunkStarts: [] }
    expect(moveDiff(5, 'nextHunk', plain)).toBe(5)
    expect(moveDiff(5, 'prevHunk', plain)).toBe(5)
  })
})

describe('windowHunks', () => {
  test('the whole diff gives back the hunks git wrote', async () => {
    for (const hunks of [MULTI, MULTI_U1, FUNCTION, NO_NEWLINE, HEAD_DELETED].map(splitHunks)) {
      const diff = numberHunks(hunks)
      expect(windowHunks(diff, 0, diff.lines.length)).toBe(hunks)
    }
  })

  test('counts of one are written out, sides with no lines kept as git writes them', async () => {
    const diff = numberHunks(splitHunks(MULTI_U0))
    expect(windowHunks(diff, 0, 99)).toBe(
      [
        '@@ -2,1 +2,1 @@ line 1',
        '-line 2',
        '+LINE 2',
        '@@ -15,2 +14,0 @@ line 14',
        '-line 15',
        '-line 16',
        '@@ -28,0 +27,2 @@ line 28',
        '+new a',
        '+new b',
      ].join('\n'),
    )
  })

  test('a window from inside a hunk gets a header of its own, no function context', async () => {
    const diff = numberHunks(splitHunks(MULTI))
    expect(windowHunks(diff, 3, 6)).toBe(
      ['@@ -3,3 +2,4 @@', '+LINE 2', ' line 3', ' line 4', ' line 5', '@@ -12,1 +12,1 @@ line 11', ' line 12'].join('\n'),
    )
    expect(windowHunks(diff, 11, 4)).toBe(['@@ -15,4 +15,2 @@', '-line 15', '-line 16', ' line 17', ' line 18'].join('\n'))
  })

  test('a slice of only added or only removed lines starts its empty side where git would', async () => {
    const diff = numberHunks(splitHunks(MULTI))
    // Just `+new a`, `+new b`: after old line 28, as -U0 writes it.
    expect(windowHunks(diff, 20, 2)).toBe(['@@ -28,0 +27,2 @@', '+new a', '+new b'].join('\n'))
    // Just `-line 15`, `-line 16`: after new line 14.
    expect(windowHunks(diff, 11, 2)).toBe(['@@ -15,2 +14,0 @@', '-line 15', '-line 16'].join('\n'))
    const added = numberHunks(splitHunks(ADDED))
    expect(windowHunks(added, 2, 2)).toBe(['@@ -0,0 +2,2 @@', '+    beta', '+gamma'].join('\n'))
  })

  test('a `\\ No newline` stays under its line, dropped when its line is above the window', async () => {
    const diff = numberHunks(splitHunks(NO_NEWLINE))
    expect(windowHunks(diff, 3, 2)).toBe(['@@ -3,1 +2,0 @@', '-z', '\\ No newline at end of file'].join('\n'))
    expect(windowHunks(diff, 4, 3)).toBe(['@@ -3,0 +3,1 @@', '+Z', '\\ No newline at end of file'].join('\n'))
  })

  test('a window past the end is pulled back to a full one', async () => {
    const diff = numberHunks(splitHunks(FUNCTION))
    expect(windowHunks(diff, 40, 3)).toBe(['@@ -11,3 +11,3 @@', '   seven', '   eight', ' }'].join('\n'))
  })

  test('nothing to draw, or a header it cannot read: null', async () => {
    const diff = numberHunks(splitHunks(MULTI))
    expect(windowHunks(diff, 0, 1)).toBeNull()
    expect(windowHunks(numberHunks(''), 0, 10)).toBeNull()
    expect(windowHunks(numberHunks(['@@ broken @@', '+a'].join('\n')), 0, 10)).toBeNull()
    const nonl = numberHunks(splitHunks(NO_NEWLINE))
    expect(windowHunks(nonl, 6, 1)).toBeNull()
  })

  test('every window of every fixture reads back as the lines it shows', async () => {
    for (const [name, raw] of Object.entries(FIXTURES)) {
      const diff = numberHunks(splitHunks(raw))
      for (let rows = 1; rows <= diff.lines.length; rows++) {
        for (let offset = 0; offset + rows <= diff.lines.length; offset++) {
          const text = windowHunks(diff, offset, rows)
          const shown = diff.lines.slice(offset, offset + rows).filter(l => l.kind !== 'hunk')
          while (shown[0]?.kind === 'meta') shown.shift()
          // A leading `\ No newline` after a header is dropped too.
          const body = shown.filter((l, i) => !(l.kind === 'meta' && (i === 0 || shown[i - 1]?.hunk !== l.hunk)))
          if (body.length === 0) {
            expect(text).toBeNull()
            continue
          }
          if (text === null) throw new Error(`${name} ${offset}+${rows}: null`)
          const back = numberHunks(text)
          for (const at of back.hunkStarts) {
            const match = (back.lines[at]?.text ?? '').match(HEADER)
            if (match === null) throw new Error(`${name} ${offset}+${rows}: bad header ${back.lines[at]?.text}`)
            const own = back.lines.filter(l => l.hunk === back.lines[at]?.hunk && l.kind !== 'hunk')
            expect(own.filter(l => l.kind === 'ctx' || l.kind === 'del').length).toBe(Number(match[2]))
            expect(own.filter(l => l.kind === 'ctx' || l.kind === 'add').length).toBe(Number(match[4]))
          }
          const key = (l: NumberedDiff['lines'][number]) => `${l.kind} ${l.oldNo ?? '.'} ${l.newNo ?? '.'} ${l.text}`
          expect(back.lines.filter(l => l.kind !== 'hunk').map(key)).toEqual(body.map(key))
        }
      }
    }
  })
})
