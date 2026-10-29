import { describe, expect, test } from 'claude-code/testing'

import type { FileChange } from '../types'
import { baseName, buildTree, dirPaths, isAllFolded, visibleRows, type TreeDir, type TreeRow } from './tree'

const file = (path: string, fields: Partial<FileChange> = {}): FileChange => ({
  path,
  status: 'M',
  added: 1,
  removed: 0,
  isBinary: false,
  layer: 'committed',
  ...fields,
})

/** A row as one line: `dir src/app/` or `file a.txt`, indented two a level. */
const show = (row: TreeRow) =>
  `${'  '.repeat(row.depth)}${row.kind === 'dir' ? `${row.isCollapsed ? '+' : '-'} ${row.dir.name}/` : row.name}`

const dir = (tree: TreeDir, path: string): TreeDir | undefined => {
  for (const sub of tree.dirs) {
    if (sub.path === path) return sub
    const found = dir(sub, path)
    if (found !== undefined) return found
  }
  return undefined
}

describe('buildTree', () => {
  test('directories first, then files, each by name as the list sorts', async () => {
    const tree = buildTree([
      file('b.txt'),
      file('A.txt'),
      file('lib/z.ts'),
      file('lib/a.ts'),
      file('Docs/readme.md'),
      file('a.txt'),
    ])
    expect(visibleRows(tree, new Set()).map(show)).toEqual([
      '- Docs/',
      '  readme.md',
      '- lib/',
      '  a.ts',
      '  z.ts',
      'A.txt',
      'a.txt',
      'b.txt',
    ])
  })

  test('a chain of single-child directories is one row, keyed by its deepest path', async () => {
    const tree = buildTree([
      file('src/app/api/route.ts'),
      file('src/app/api/util.ts'),
      file('src/app/page.tsx'),
      file('docs/a/b/c.md'),
      file('top.txt'),
    ])
    expect(visibleRows(tree, new Set()).map(show)).toEqual([
      '- docs/a/b/',
      '  c.md',
      '- src/app/',
      '  - api/',
      '    route.ts',
      '    util.ts',
      '  page.tsx',
      'top.txt',
    ])
    expect(dirPaths(tree)).toEqual(['docs/a/b', 'src/app', 'src/app/api'])
    expect(dir(tree, 'src/app')?.name).toBe('src/app')
    expect(dir(tree, 'src/app/api')?.name).toBe('api')
  })

  test('a lone chain at the root compacts too, files under it keep their depth', async () => {
    const rows = visibleRows(buildTree([file('a/b/c/d.txt'), file('a/b/c/e/f.txt')]), new Set())
    expect(rows.map(show)).toEqual(['- a/b/c/', '  - e/', '    f.txt', '  d.txt'])
  })

  test('a rename sits under its new path', async () => {
    const renamed = file('new/place.ts', { status: 'R', oldPath: 'old/place.ts' })
    const tree = buildTree([renamed])
    expect(dirPaths(tree)).toEqual(['new'])
    const rows = visibleRows(tree, new Set())
    expect(rows[1]).toEqual({ kind: 'file', depth: 1, file: renamed, name: 'place.ts' })
  })

  test('each directory adds up what is below it; a binary file counts as a file only', async () => {
    const tree = buildTree([
      file('src/a.ts', { added: 3, removed: 1 }),
      file('src/lib/b.ts', { added: 2, removed: 4 }),
      file('src/lib/c.png', { status: 'A', isBinary: true, added: 0, removed: 0 }),
      file('src/lib/d.bin', { isBinary: true, added: 7, removed: 7 }),
      file('root.txt', { added: 9, removed: 9 }),
    ])
    expect(dir(tree, 'src')).toMatchObject({ added: 5, removed: 5, fileCount: 4 })
    expect(dir(tree, 'src/lib')).toMatchObject({ added: 2, removed: 4, fileCount: 3 })
    expect(tree).toMatchObject({ added: 14, removed: 14, fileCount: 5 })
  })

  test('a deleted file and a new directory of the same name both stand', async () => {
    const rows = visibleRows(buildTree([file('x', { status: 'D' }), file('x/y.txt', { status: 'A' })]), new Set())
    expect(rows.map(show)).toEqual(['- x/', '  y.txt', 'x'])
  })

  test('nothing changed is an empty tree', async () => {
    const tree = buildTree([])
    expect(visibleRows(tree, new Set())).toEqual([])
    expect(dirPaths(tree)).toEqual([])
  })
})

describe('visibleRows', () => {
  const tree = buildTree([
    file('src/app/api/route.ts'),
    file('src/app/page.tsx'),
    file('src/lib/x.ts'),
    file('a.txt'),
  ])

  test('a collapsed directory keeps its row and hides what is below', async () => {
    expect(visibleRows(tree, new Set(['src/app'])).map(show)).toEqual([
      '- src/',
      '  + app/',
      '  - lib/',
      '    x.ts',
      'a.txt',
    ])
    expect(visibleRows(tree, new Set(['src'])).map(show)).toEqual(['+ src/', 'a.txt'])
  })

  test('an inner directory stays collapsed under a collapsed one, and shows so once that opens', async () => {
    const all = new Set(dirPaths(tree))
    expect(visibleRows(tree, all).map(show)).toEqual(['+ src/', 'a.txt'])
    all.delete('src')
    expect(visibleRows(tree, all).map(show)).toEqual(['- src/', '  + app/', '  + lib/', 'a.txt'])
  })

  test('a path collapsed that the tree no longer has changes nothing', async () => {
    expect(visibleRows(tree, new Set(['gone', 'src/ap'])).map(show)).toEqual(
      visibleRows(tree, new Set()).map(show),
    )
  })

  test('all folded is what the rows show: hidden inner directories do not count', async () => {
    expect(isAllFolded(tree, [])).toBe(false)
    expect(isAllFolded(tree, ['src/app', 'src/lib'])).toBe(false)
    // Only the top row folded by hand: every row drawn is folded.
    expect(isAllFolded(tree, ['src'])).toBe(true)
    expect(isAllFolded(tree, dirPaths(tree))).toBe(true)
    // A new directory under a folded one changes nothing on screen.
    const grown = buildTree([file('src/app/api/route.ts'), file('src/app/page.tsx'), file('src/lib/x.ts'), file('src/new/c.ts')])
    expect(isAllFolded(grown, dirPaths(tree))).toBe(true)
    expect(isAllFolded(buildTree([file('a.txt')]), [])).toBe(false)
  })

  test('baseName is the last segment', async () => {
    expect(baseName('a/b/c.txt')).toBe('c.txt')
    expect(baseName('c.txt')).toBe('c.txt')
  })
})
