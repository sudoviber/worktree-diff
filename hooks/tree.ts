import type { FileChange } from '../types'

export type TreeDir = {
  /** The directory's full path, no trailing slash: `src/app/api`. */
  path: string
  /** What its row shows: the path below its parent, a single-child chain compacted (`src/app/api`). */
  name: string
  dirs: TreeDir[]
  files: FileChange[]
  /** Totals of every file below; a binary file counts as a file only. */
  added: number
  removed: number
  fileCount: number
}

/** The root: a directory with no path or name of its own. */
export type Tree = TreeDir

export type TreeRow =
  | { kind: 'dir'; depth: number; dir: TreeDir; isCollapsed: boolean }
  | { kind: 'file'; depth: number; file: FileChange; name: string }

// The listing's own order: plain code-unit comparison.
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const emptyDir = (path: string, name: string): TreeDir => ({
  path,
  name,
  dirs: [],
  files: [],
  added: 0,
  removed: 0,
  fileCount: 0,
})

/** The last segment of a path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const compact = (dir: TreeDir): TreeDir => {
  let node = dir
  // A directory holding one directory and nothing else shares its row.
  while (node.files.length === 0 && node.dirs.length === 1) {
    const only = node.dirs[0] as TreeDir
    node = { ...only, name: `${node.name}/${only.name}` }
  }

  return { ...node, dirs: node.dirs.map(compact) }
}

const finish = (dir: TreeDir): TreeDir => {
  const dirs = dir.dirs.map(finish).sort((a, b) => byText(a.name, b.name))
  const files = [...dir.files].sort((a, b) => byText(baseName(a.path), baseName(b.path)))
  let added = 0
  let removed = 0
  let fileCount = files.length
  for (const file of files) {
    if (file.isBinary) continue
    added += file.added
    removed += file.removed
  }
  for (const sub of dirs) {
    added += sub.added
    removed += sub.removed
    fileCount += sub.fileCount
  }

  return { ...dir, dirs, files, added, removed, fileCount }
}

/**
 * Builds the directory tree of `files` (a rename under its new path):
 * within a level, directories first, then files, each by name.
 */
export const buildTree = (files: readonly FileChange[]): Tree => {
  const root = emptyDir('', '')
  const byPath = new Map<string, TreeDir>([['', root]])
  const dirOf = (path: string): TreeDir => {
    const known = byPath.get(path)
    if (known !== undefined) return known
    const cut = path.lastIndexOf('/')
    const parent = dirOf(cut < 0 ? '' : path.slice(0, cut))
    const dir = emptyDir(path, path.slice(cut + 1))
    parent.dirs.push(dir)
    byPath.set(path, dir)

    return dir
  }
  for (const file of files) {
    const cut = file.path.lastIndexOf('/')
    dirOf(cut < 0 ? '' : file.path.slice(0, cut)).files.push(file)
  }
  const sorted = finish(root)

  // The root keeps its own row-less place; only what is under it compacts.
  return { ...sorted, dirs: sorted.dirs.map(compact) }
}

/** Every directory's path, outermost first. */
export const dirPaths = (tree: Tree): string[] => {
  const out: string[] = []
  const walk = (dir: TreeDir) => {
    for (const sub of dir.dirs) {
      out.push(sub.path)
      walk(sub)
    }
  }
  walk(tree)

  return out
}

/** The rows drawn: a collapsed directory's own row, nothing below it. */
export const visibleRows = (tree: Tree, collapsed: ReadonlySet<string>): TreeRow[] => {
  const rows: TreeRow[] = []
  const walk = (dir: TreeDir, depth: number) => {
    for (const sub of dir.dirs) {
      const isCollapsed = collapsed.has(sub.path)
      rows.push({ kind: 'dir', depth, dir: sub, isCollapsed })
      if (!isCollapsed) walk(sub, depth + 1)
    }
    for (const file of dir.files) rows.push({ kind: 'file', depth, file, name: baseName(file.path) })
  }
  walk(tree, 0)

  return rows
}

/**
 * Whether the tree reads as all folded: it has a directory row and every
 * one shown is collapsed. Directories hidden under a collapsed one do not
 * count, so a new one appearing there, or inner ones never folded, change
 * nothing on screen and nothing here.
 */
export const isAllFolded = (tree: Tree, collapsed: readonly string[]): boolean => {
  const dirs = visibleRows(tree, new Set(collapsed)).filter(row => row.kind === 'dir')

  return dirs.length > 0 && dirs.every(row => row.isCollapsed)
}
