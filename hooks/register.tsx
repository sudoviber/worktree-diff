import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  PluginOptions,
  Register,
  RenderElement,
  RenderSurface,
  Timer,
} from 'claude-code'

import type { DiffMode, FileChange, FileDiff, Snapshot, ViewMode } from '../types'
import {
  computeSnapshot,
  git,
  loadFileDiff,
  repoDirs,
  shortRef,
  stableStartPoint,
  summaryText,
  type GitDeps,
  type RepoDirs,
  type UntrackedCache,
} from './git'
import { addedSource, charWidth, parseHunks, type DiffLine } from './diff-lines'
import { baseName, buildTree, dirPaths, isAllFolded, visibleRows, type Tree, type TreeDir, type TreeRow } from './tree'

type Dollar = EngineInterface
type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>

const PLUGIN = 'worktree-diff'
const PANE = 'worktree-diff'
const TITLE = 'Changes'
const DEBOUNCE_MS = 300
const GIT_TIMEOUT_MS = 15_000
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
// The engine draws a tree's first 100k characters; stay clear of the cut.
const TEXT_BUDGET = 90_000
// The `… N more files` row and the slack around it.
const TAIL_CHARS = 200
const MODES = ['all', 'committed', 'uncommitted'] as const
const MODE_HOTKEY: Record<DiffMode, string> = { all: 'a', committed: 'c', uncommitted: 'u' }
// Hotkeys take lowercase only, so the last row is `e`, not `G`. None of them is a control's (a c u r t z x).
const NAV_KEYS = [
  { hotkey: 'j', label: 'down' },
  { hotkey: 'k', label: 'up' },
  { hotkey: 'h', label: 'fold' },
  { hotkey: 'l', label: 'open' },
  { hotkey: 'g', label: 'top' },
  { hotkey: 'e', label: 'end' },
  { hotkey: 'q', label: 'close' },
] as const
type NavKey = (typeof NAV_KEYS)[number]['hotkey']
const isNavKey = (key: string) => key.startsWith('nav:')
const isRowKey = (key: string) => key.startsWith('file:') || key.startsWith('dir:')
// Compared by name: a build may not register every one of them.
const TRIGGER_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'EnterWorktree',
  'ExitWorktree',
])
const ARGUMENT_HINT = '[close | status | refresh | base [<ref>] | trunk [<ref>] | mode all|committed|uncommitted]'
export const USAGE = [
  `Usage: /wt-diff ${ARGUMENT_HINT}`,
  '  /wt-diff              open the Changes pane and give it the keyboard',
  '  /wt-diff close        close the Changes pane',
  '  /wt-diff status       print the changes as text',
  '  /wt-diff refresh      re-read git now',
  '  /wt-diff base <ref>   compare this worktree against <ref>; /wt-diff base clears it',
  "  /wt-diff trunk <ref>  the repository's integration branch, for all its worktrees; /wt-diff trunk clears it",
  '  /wt-diff mode <mode>  all (default), committed or uncommitted',
].join('\n')

// Change a tag when its value's shape changes: an older value then reads as the initial.
const snapshotAtom = atom({ plugin: 'worktree-diff', key: 'snapshot' } as const, null, {
  shape: 'snapshot-2',
})
const modeAtom = atom({ plugin: 'worktree-diff', key: 'mode' } as const, 'all')
const expandedAtom = atom({ plugin: 'worktree-diff', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})
const diffsAtom = atom({ plugin: 'worktree-diff', key: 'diffs' } as const, {}, {
  shape: 'diffs-1',
})
const refreshingAtom = atom({ plugin: 'worktree-diff', key: 'isRefreshing' } as const, false)
const viewAtom = atom({ plugin: 'worktree-diff', key: 'view' } as const, 'tree')
const collapsedAtom = atom({ plugin: 'worktree-diff', key: 'collapsedDirs' } as const, [], {
  shape: 'collapsed-1',
})

// ----------------------------------------------------------------- config

type AutoOpen = 'worktree' | 'always' | 'never'
/** quiet: a modified file's lines in their own colours, no background; engine: the engine's diff view. */
type DiffStyle = 'quiet' | 'engine'
/** transparent: the terminal's own background shows through the pane; theme: the surface's pane fill. */
type PaneBackground = 'transparent' | 'theme'
type Config = {
  autoOpen: AutoOpen
  pollSeconds: number
  statusLine: boolean
  diffStyle: DiffStyle
  paneBackground: PaneBackground
}

export const readConfig = (options: PluginOptions): Config => {
  const { autoOpen, pollSeconds, statusLine, diffStyle, paneBackground } = options
  const poll = pollSeconds === undefined ? 5 : Number(pollSeconds)

  return {
    autoOpen: autoOpen === 'always' || autoOpen === 'never' ? autoOpen : 'worktree',
    pollSeconds: Number.isFinite(poll) && poll > 0 ? poll : 0,
    statusLine: statusLine === true,
    diffStyle: diffStyle === 'engine' ? 'engine' : 'quiet',
    paneBackground: paneBackground === 'theme' ? 'theme' : 'transparent',
  }
}

// ------------------------------------------------------------------- text

const MINUS = '−'

export const isMode = (value: string): value is DiffMode =>
  (MODES as readonly string[]).includes(value)

// Text, Code and Button labels refuse control characters but tab and newline
// (git calls a file holding ESC or ^L text); a CRLF's `\r` is dropped.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** Multi-line text the engine accepts: a diff, a command's answer. */
export const printable = (text: string): string =>
  text.replace(/\r(?=\n|$)/g, '').replace(CONTROL, '�')

/** One line the engine accepts: a path, a ref, a label. */
export const oneLine = (text: string): string => text.replace(LINE_CONTROL, '�')

/** Terminal cells a string takes: East Asian wide characters and emoji count two. */
export const cellWidth = (text: string): number => {
  let cells = 0
  for (const char of text) cells += charWidth(char)

  return cells
}

/** The longest start (or end) of `text` within `cells`, never splitting a code point. */
const takeCells = (text: string, cells: number, fromEnd = false): string => {
  const chars = Array.from(text)
  if (fromEnd) chars.reverse()
  const kept: string[] = []
  let used = 0
  for (const char of chars) {
    used += charWidth(char)
    if (used > cells) break
    kept.push(char)
  }
  if (fromEnd) kept.reverse()

  return kept.join('')
}

/** Cuts the middle out of a path to fit `max` cells: `src/…/file.ts`. */
export const fitPath = (path: string, max: number): string => {
  if (cellWidth(path) <= max) return path
  if (max <= 1) return '…'
  const parts = path.split('/')
  const name = parts[parts.length - 1] ?? path
  if (parts.length > 2) {
    // The first directory, then as many trailing segments as fit.
    for (let from = 2; from < parts.length; from++) {
      const fitted = `${parts[0]}/…/${parts.slice(from).join('/')}`
      if (cellWidth(fitted) <= max) return fitted
    }
  }
  if (parts.length > 1 && cellWidth(name) + 2 <= max) return `…/${name}`
  const keepEnd = Math.ceil((max - 1) / 2)

  return `${takeCells(path, max - 1 - keepEnd)}…${takeCells(path, keepEnd, true)}`
}

type Counts = { added?: string; removed?: string; other?: string }

const countParts = (file: FileChange): Counts => {
  if (file.isBinary) return { other: 'bin' }
  const parts: Counts = {}
  if (file.added > 0 || file.status === '?') parts.added = `+${file.added}`
  if (file.removed > 0) parts.removed = `${MINUS}${file.removed}`

  return parts
}

const countsWidth = ({ added, removed, other }: Counts) =>
  [added, removed, other].filter(part => part !== undefined).join(' ').length

const STATUS_COLOR: Partial<Record<FileChange['status'], string>> = {
  A: 'success',
  D: 'error',
  M: 'warning',
  R: 'suggestion',
  C: 'suggestion',
  T: 'warning',
  U: 'error',
}

/** The listing in a few words for the status line: `5 files +202 −34`. */
export const statusLineText = (snapshot: Snapshot | null): string | undefined => {
  if (!snapshot || snapshot.totals.files === 0) return undefined
  const { added, removed, files } = snapshot.totals

  return `${files} ${files === 1 ? 'file' : 'files'} +${added} ${MINUS}${removed}`
}

const sameDiff = (a: FileDiff | undefined, b: FileDiff) =>
  a !== undefined &&
  a.hunks === b.hunks &&
  a.isBinary === b.isBinary &&
  a.omittedLines === b.omittedLines &&
  a.error === b.error

const without = <T,>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const copy = { ...record }
  delete copy[key]

  return copy
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Work no one awaits: a failure there is dropped, never an unhandled rejection. */
const background = (work: Promise<unknown>) => {
  work.catch(() => undefined)
}

// ------------------------------------------------------------------- deps

const gitDeps = ($: Dollar): GitDeps => ({
  run: async (argv, cwd) => {
    try {
      const { exitCode, stdout, stderr, isStdoutTruncated } = await $.process.run(argv, {
        cwd,
        env: GIT_ENV,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      // A cut `-z` list ends mid-path: fail it rather than list a bogus file.
      // One file's diff is cut to its line cap anyway.
      if (isStdoutTruncated && argv.includes('-z')) {
        return { exitCode: 1, stdout: '', stderr: 'output over 4 MiB' }
      }
      return { exitCode, stdout, stderr }
    } catch (error) {
      // Could not start, or timed out: read as a failed git call.
      return { exitCode: 1, stdout: '', stderr: errorText(error) }
    }
  },
  readText: async path => {
    try {
      return await $.fs.read(path)
    } catch {
      return null
    }
  },
  fileInfo: async path => {
    try {
      const { size, mtimeMs, isLink } = await $.fs.stat(path)
      return { size, mtimeMs, isLink }
    } catch {
      return null
    }
  },
  now: () => $.clock.now(),
  untrackedCache,
})

// A base override is the worktree's own; the trunk is the repository's, shared by its worktrees.
const baseKey = (root: string) => `base:${root}`
const trunkKey = (gitCommonDir: string) => `trunk:${gitCommonDir}`

const storedRef = async ($: Dollar, key: string): Promise<string | null> => {
  try {
    const value = await $.store.get(key)
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

// The person's choice of view, kept across sessions; state mirrors it for drawing.
const VIEW_KEY = 'view'

export const isView = (value: unknown): value is ViewMode => value === 'tree' || value === 'list'

// --------------------------------------------------------------- register

type RefreshRequest = { force?: boolean; isVisible?: boolean }

// Options and scheduling only, never what the pane draws: a reload drops
// these, and the session.start it raises rebuilds them. `$` may only be
// handed to top-level functions, so they live here rather than in register.
let config: Config = readConfig({})
let debounce: Timer | undefined
let poll: Timer | undefined
let inflight: Promise<Snapshot | null> | undefined
let rerun = false
let isForced = false
let isVisible = false
let wantsAutoOpen = false
/** Whether the surface docks a pane beside the transcript; undefined until a drawing says. */
let docksPanes: boolean | undefined
/** Whether this load of the module has mirrored the stored view into state. */
let isViewLoaded = false
/** Presses of `t` this load of the module: a read of the store begun before one is stale. */
let viewToggles = 0
/** What this load of the module last put in the status line. */
let shownStatus: string | undefined
// Losing it costs one more read of each untracked file.
const untrackedCache: UntrackedCache = new Map()

/** A row of the pane's listing, as j/k/h/l walk it. */
export type NavRow = { key: string; kind: 'file' | 'dir'; path: string; depth: number }
/** The element the pane's focus ring holds, as `ui.focus` last said; lost on a reload, read as no row. */
let focusedKey: string | undefined
/** The last row the ring held: where it starts when the pane takes the keyboard again. */
let lastRowKey: string | undefined
/** Moves of the ring onto a row this load of the module: one since a check means the person moved it. */
let rowMoves = 0
/** The key presses still running, one after another: each reads where the last one left the ring. */
let navChain: Promise<void> = Promise.resolve()

/** The pane as `$.ui.panes()` lists it; open but undrawn on a narrow terminal is `isPlaced: false`, a tab behind another `isShown: false`. */
const paneState = async ($: Dollar) => {
  try {
    return (await $.ui.panes()).find(pane => pane.id === PANE)
  } catch {
    return undefined
  }
}

// Polls only while the pane is drawn; its render starts it once a terminal widens.
// A tick while a pass runs is dropped, so a slow repo never runs git back to back.
const startPolling = ($: Dollar) => {
  if (poll !== undefined || config.pollSeconds <= 0) return
  poll = $.clock.every(config.pollSeconds * 1000, () => {
    if (inflight === undefined) background(refresh($))
  })
}

const stopPolling = () => {
  poll?.cancel()
  poll = undefined
}

const schedule = ($: Dollar) => {
  debounce?.cancel()
  debounce = $.clock.after(DEBOUNCE_MS, () => {
    debounce = undefined
    background(refresh($))
  })
}

const shouldAutoOpen = (snapshot: Snapshot) =>
  config.autoOpen === 'always'
    ? snapshot.isRepo
    : config.autoOpen === 'worktree' && snapshot.isLinkedWorktree

/**
 * Learns from a drawing whether panes dock. An unasked open is a sidebar
 * only where they do; on the main screen it would sit inline above the
 * prompt, so a pending auto-open waits for this and runs once it is true.
 */
const learnLayout = ($: Dollar, isFullscreen: boolean | undefined) => {
  if (isFullscreen === undefined || docksPanes === isFullscreen) return
  docksPanes = isFullscreen
  if (!isFullscreen) wantsAutoOpen = false
  else if (wantsAutoOpen) schedule($)
}

// Every open sets the backdrop anew; left out, the surface's own fill stands.
const paneArgs = (raise: boolean) => ({
  id: PANE,
  title: TITLE,
  ...(raise ? { focus: true as const } : {}),
  ...(config.paneBackground === 'transparent' ? { backgroundColor: 'transparent' } : {}),
})

/** A reload with the pane on screen opens it again, so a changed backdrop applies at once. */
const reapplyLook = async ($: Dollar) => {
  const pane = await paneState($)
  if (pane?.isPlaced === true && pane.isShown) await $.ui.open(paneArgs(false))
}

const openPane = async ($: Dollar, raise = false) => {
  const opened = await $.ui.open(paneArgs(raise))
  if (opened.isPlaced) startPolling($)

  return opened
}

/** Whether drawDiff reads a file's diff: a deleted text file is drawn from its counts alone. */
const needsDiff = (file: FileChange): boolean => file.status !== 'D' || file.isBinary

/** Loads the expanded files' diffs again; drops paths the snapshot no longer lists. */
const syncDiffs = async ($: Dollar, deps: GitDeps, snapshot: Snapshot) => {
  const byPath = new Map(snapshot.files.map(file => [file.path, file]))
  const expanded = await read($, expandedAtom)
  if (expanded.some(path => !byPath.has(path))) {
    await update($, expandedAtom, list => list.filter(path => byPath.has(path)))
  }
  const listed = expanded.filter(path => byPath.has(path))
  const kept = listed.filter(path => needsDiff(byPath.get(path) as FileChange))
  const loaded = await Promise.all(
    kept.map(async path => {
      const file = byPath.get(path) as FileChange
      return [path, await loadFileDiff(deps, snapshot, file)] as const
    }),
  )

  const current = await read($, diffsAtom)
  const isStale =
    Object.keys(current).some(path => !kept.includes(path)) ||
    loaded.some(([path, diff]) => !sameDiff(current[path], diff))
  if (!isStale) return
  // A row pressed meanwhile has its own diff on the way: keep it.
  const live = new Set(await read($, expandedAtom))
  await update($, diffsAtom, latest => {
    const out: Record<string, FileDiff> = {}
    for (const [path, diff] of Object.entries(latest)) {
      if (live.has(path) && !listed.includes(path)) out[path] = diff
    }
    for (const [path, diff] of loaded) if (live.has(path)) out[path] = diff

    return out
  })
}

/**
 * The totals in the status line, for a surface that draws no tail on the
 * prompt's hint line; the terminal alone has them at the end of that line.
 */
const showStatus = async ($: Dollar, snapshot: Snapshot) => {
  let surfaces: readonly RenderSurface[] = []
  try {
    surfaces = await $.session.surfaces()
  } catch {
    // Read as the terminal alone.
  }
  const text = surfaces.some(surface => surface !== 'terminal') ? statusLineText(snapshot) : undefined
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

/** Puts the last totals in the status line, or takes them out, for the surfaces attached now. */
const syncStatus = async ($: Dollar) => {
  const snapshot = await read($, snapshotAtom)
  if (snapshot !== null) await showStatus($, snapshot)
}

/** Mirrors the stored view into state, once per load of the module. */
const loadView = async ($: Dollar) => {
  if (isViewLoaded) return
  isViewLoaded = true
  const toggles = viewToggles
  let stored: unknown
  try {
    stored = await $.store.get(VIEW_KEY)
  } catch {
    return
  }
  // A `t` pressed while the store answered has written its own choice.
  if (toggles !== viewToggles) return
  if (isView(stored) && stored !== (await read($, viewAtom))) await update($, viewAtom, () => stored)
}

/** Drops collapsed directories the snapshot no longer has. */
const pruneCollapsed = async ($: Dollar, snapshot: Snapshot) => {
  const collapsed = await read($, collapsedAtom)
  if (collapsed.length === 0) return
  const live = new Set(dirPaths(buildTree(snapshot.files)))
  if (collapsed.every(path => live.has(path))) return
  await update($, collapsedAtom, paths => paths.filter(path => live.has(path)))
}

const refreshOnce = async ($: Dollar, force: boolean): Promise<Snapshot | null> => {
  await loadView($)
  const pane = await paneState($)
  const isOpen = pane !== undefined
  if (pane?.isPlaced && pane.isShown) startPolling($)
  else stopPolling()
  // Nobody looks while the pane is closed, unless a command or option reads it.
  // An undrawn one still follows triggers, so it is current once placed.
  if (!force && !isOpen && !config.statusLine && !wantsAutoOpen) return null

  const deps = gitDeps($)
  const cwd = await $.session.cwd()
  const mode = await read($, modeAtom)
  const previous = await read($, snapshotAtom)
  const dirs: RepoDirs | null =
    previous !== null && previous.cwd === cwd && previous.isRepo && previous.gitCommonDir !== ''
      ? previous
      : await repoDirs(deps, cwd)
  const baseOverride = dirs === null ? null : await storedRef($, baseKey(dirs.root))
  const trunk = dirs === null || dirs.gitCommonDir === '' ? null : await storedRef($, trunkKey(dirs.gitCommonDir))
  const snapshot = await computeSnapshot(deps, { cwd, mode, baseOverride, trunk })

  if ((await read($, modeAtom)) !== mode) {
    // The mode moved while git ran: this result is the old mode's.
    rerun = true
    return snapshot
  }
  if (previous?.signature !== snapshot.signature) await update($, snapshotAtom, () => snapshot)
  // A failed read lists nothing: keep what is open until git answers again.
  if (snapshot.error === undefined || snapshot.files.length > 0) {
    await syncDiffs($, deps, snapshot)
    await pruneCollapsed($, snapshot)
  }
  if (config.statusLine) await showStatus($, snapshot)
  // Until a drawing says whether panes dock, the open stays pending.
  if (wantsAutoOpen && (isOpen || docksPanes !== undefined)) {
    wantsAutoOpen = false
    if (!isOpen && docksPanes === true && shouldAutoOpen(snapshot)) background(openPane($))
  }

  return snapshot
}

/**
 * Single flight: a call while one runs asks for one more pass after it and
 * shares its promise, which settles with the last pass's snapshot.
 */
const refresh = ($: Dollar, request: RefreshRequest = {}): Promise<Snapshot | null> => {
  if (request.force) isForced = true
  if (request.isVisible) isVisible = true
  if (inflight !== undefined) {
    rerun = true
    return inflight
  }

  const run = async () => {
    let latest: Snapshot | null = null
    try {
      for (;;) {
        rerun = false
        const force = isForced
        const shows = isVisible
        isForced = false
        isVisible = false
        try {
          if (shows) await update($, refreshingAtom, () => true)
          latest = (await refreshOnce($, force)) ?? latest
        } catch {
          // A refresh that fails leaves the last snapshot up.
        }
        if (shows) await update($, refreshingAtom, () => false).catch(() => false)
        if (!rerun) break
      }
    } finally {
      inflight = undefined
    }

    return latest
  }
  inflight = run()

  return inflight
}

/** Opens or closes a file's diff, dropping a closed one's text; true when it opened, its text not yet read. */
const flipFile = async ($: Dollar, path: string): Promise<boolean> => {
  const list = await update($, expandedAtom, paths =>
    paths.includes(path) ? paths.filter(one => one !== path) : [...paths, path],
  )
  if (list.includes(path)) return true
  await update($, diffsAtom, diffs => without(diffs, path))
  return false
}

const toggleFile = async ($: Dollar, path: string) => {
  if (await flipFile($, path)) await loadDiff($, path)
}

/** Reads an opened file's diff into the pane. */
const loadDiff = async ($: Dollar, path: string) => {
  const snapshot = await read($, snapshotAtom)
  const file = snapshot?.files.find(one => one.path === path)
  if (!snapshot || !file || !needsDiff(file)) return
  const diff = await loadFileDiff(gitDeps($), snapshot, file)
  // Collapsed again while it loaded.
  if (!(await read($, expandedAtom)).includes(path)) return
  await update($, diffsAtom, diffs => ({ ...diffs, [path]: diff }))
}

const collapseAll = async ($: Dollar) => {
  await update($, expandedAtom, () => [])
  await update($, diffsAtom, () => ({}))
}

const toggleView = async ($: Dollar) => {
  isViewLoaded = true
  viewToggles += 1
  await update($, viewAtom, view => (view === 'tree' ? 'list' : 'tree'))
  try {
    await $.store.set(VIEW_KEY, await read($, viewAtom))
  } catch {
    // Kept for this session only.
  }
}

const toggleDir = async ($: Dollar, path: string) => {
  await update($, collapsedAtom, paths =>
    paths.includes(path) ? paths.filter(one => one !== path) : [...paths, path],
  )
}

/** Collapses every directory, nested ones too, or expands them all when the tree reads as all folded. */
const foldAll = async ($: Dollar) => {
  const snapshot = await read($, snapshotAtom)
  if (snapshot === null) return
  const tree = buildTree(snapshot.files)
  await update($, collapsedAtom, paths => (isAllFolded(tree, paths) ? [] : dirPaths(tree)))
}

const setMode = async ($: Dollar, mode: DiffMode) => {
  await update($, modeAtom, () => mode)
  await update($, diffsAtom, () => ({}))
  await refresh($, { force: true, isVisible: true })
}

/** Why `ref` cannot be stored as a base or trunk, checked in the worktree `root`; null when it can. */
const refProblem = async (deps: GitDeps, root: string, ref: string): Promise<string | null> => {
  if (ref.startsWith('-')) return `Not a ref: ${ref}`
  const check = await git(deps, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])

  return check.exitCode === 0 ? null : `Not a commit here: ${ref}`
}

const setBase = async ($: Dollar, ref: string | undefined): Promise<string> => {
  const deps = gitDeps($)
  const cwd = await $.session.cwd()
  const dirs = await repoDirs(deps, cwd)
  if (dirs === null) return `Not a git repository: ${cwd}`
  const { root } = dirs

  if (ref === undefined) {
    await $.store.delete(baseKey(root))
    await refresh($, { force: true, isVisible: true })
    return `Base override cleared for ${root}.`
  }
  const problem = await refProblem(deps, root, ref)
  if (problem !== null) return problem
  await $.store.set(baseKey(root), ref)
  await refresh($, { force: true, isVisible: true })

  return `Base set to ${ref} for ${root}.`
}

const setTrunk = async ($: Dollar, ref: string | undefined): Promise<string> => {
  const deps = gitDeps($)
  const cwd = await $.session.cwd()
  const dirs = await repoDirs(deps, cwd)
  if (dirs === null) return `Not a git repository: ${cwd}`
  const { root, gitCommonDir } = dirs
  if (gitCommonDir === '') return `Could not find the git directory of ${root}.`

  if (ref === undefined) {
    await $.store.delete(trunkKey(gitCommonDir))
    await refresh($, { force: true, isVisible: true })
    return `Trunk cleared for ${gitCommonDir}.`
  }
  const problem = await refProblem(deps, root, ref)
  if (problem !== null) return problem
  // Shared by every worktree, it must name the same thing in each.
  if (stableStartPoint(ref) !== ref) return `Not a branch name: ${ref}`
  // A branch by its full name, so `team/x` is never read as remote team's `x`.
  const full = await git(deps, root, ['rev-parse', '--symbolic-full-name', ref])
  const fullName = full.exitCode === 0 ? full.stdout.trim() : ''
  const stored = /^refs\/(?:heads|remotes)\//.test(fullName) ? fullName : ref
  await $.store.set(trunkKey(gitCommonDir), stored)
  await refresh($, { force: true, isVisible: true })

  return `Trunk set to ${shortRef(stored)} for every worktree of ${gitCommonDir}.`
}

export const FOCUSED = 'Changes pane focused — j/k move · enter open · esc back · q close'
export const UNFOCUSED = 'Changes pane opened — ctrl+x tab to focus'

/** Where the ring starts on these rows: the row it last held, else the first. */
const ringStart = (keys: readonly string[]): string | undefined =>
  lastRowKey !== undefined && keys.includes(lastRowKey) ? lastRowKey : keys[0]

/**
 * The rows as the pane lists them now, in order: read from state, so a key
 * pressed before the redraw sees what the last one folded or opened.
 */
const listingNow = async ($: Dollar) => {
  const [snapshot, view, collapsedDirs] = await Promise.all([
    read($, snapshotAtom),
    read($, viewAtom),
    read($, collapsedAtom),
  ])
  const tree = view === 'tree' && snapshot?.isRepo === true ? buildTree(snapshot.files) : null

  return { rows: listedRows(snapshot, tree, collapsedDirs).map(navRow), collapsedDirs }
}

/**
 * A pane that took the keyboard before git was read drew no row to start the
 * ring on, and autoFocus acts only as it takes the keys: once read, the ring
 * goes where autoFocus would have put it, unless the person moved it since.
 */
const ringOnFirstRows = async ($: Dollar, refreshed: Promise<Snapshot | null>) => {
  const moves = rowMoves
  await refreshed
  if (rowMoves !== moves || (await paneState($))?.isFocused !== true) return
  const key = ringStart((await listingNow($)).rows.map(row => row.key))
  // Not yet drawn, the row is waited for.
  if (key !== undefined) await focusRow($, key)
}

/**
 * Opens the pane, or places it if undrawn, or raises it from behind another
 * tab, and asks for the keyboard: the engine grants it over an empty
 * composer, which it is once a command is entered, and refuses it otherwise.
 */
const focusPane = async ($: Dollar) => {
  const isUnread = (await read($, snapshotAtom)) === null
  const opened = await openPane($, true)
  const refreshed = refresh($, { force: true, isVisible: true })
  if (!opened.isPlaced) {
    background(refreshed)
    return `Changes pane is waiting: ${opened.reason}`
  }
  const isFocused = (await paneState($))?.isFocused === true
  background(isUnread && isFocused ? ringOnFirstRows($, refreshed) : refreshed)

  return isFocused ? FOCUSED : UNFOCUSED
}

const closePane = async ($: Dollar) => {
  if ((await paneState($)) === undefined) return 'Changes pane is not open.'
  await $.ui.close({ id: PANE })
  stopPolling()

  return 'Changes pane closed.'
}

/** Keeps where the ring is; a press of a key's own Button leaves the row it acts from. */
const noteFocus = (key: string | undefined) => {
  if (key !== undefined && isNavKey(key)) return
  focusedKey = key
  if (key === undefined || !isRowKey(key)) return
  lastRowKey = key
  rowMoves += 1
}

/**
 * Moves the ring onto a row and scrolls it into view; a refusal (the pane lost
 * the keys) is dropped. `isTop`: the pane goes back to its start first, so the
 * header and the key hints above the rows show again.
 */
export const focusRow = async ($: Dollar, key: string, isTop = false) => {
  try {
    if ((await $.ui.focus({ requestId: PANE, key })).deny !== undefined) return
  } catch {
    return
  }
  noteFocus(key)
  try {
    if (isTop) await $.ui.scroll({ to: 'start', in: PANE })
  } catch {
    // The row is still scrolled to below.
  }
  try {
    // After the start too, in case the header is taller than the pane.
    await $.ui.scroll({ to: { key }, in: PANE })
  } catch {
    // Still focused; the engine keeps the ring in view on its own.
  }
}

/** What a key does: move the ring to a row, or press a directory or a file row. */
export type NavAction = { focus: string } | { dir: string } | { file: string } | null

/** The directory row a row sits in: the nearest one above it that is less deep. */
const parentRow = (rows: readonly NavRow[], at: number): NavRow | undefined => {
  const depth = rows[at]?.depth ?? 0
  for (let index = at - 1; index >= 0; index--) {
    const row = rows[index] as NavRow
    if (row.depth < depth) return row.kind === 'dir' ? row : undefined
  }
  return undefined
}

/**
 * What a key does on the rows as listed, the ring on `focused`. Off any row
 * j goes to the first and k to the last; neither goes past an end. h folds
 * an open directory or goes up to the one above; l opens a folded directory
 * or a file's diff, or goes into an open directory. `isOpen`: a directory
 * unfolded, a file's diff open.
 */
export const navAction = (
  rows: readonly NavRow[],
  focused: string | undefined,
  key: Exclude<NavKey, 'q'>,
  isOpen: (row: NavRow) => boolean,
): NavAction => {
  const at = focused === undefined ? -1 : rows.findIndex(row => row.key === focused)
  const row = rows[at]
  const to = (index: number): NavAction => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, index))]
    return target === undefined || target === row ? null : { focus: target.key }
  }
  if (key === 'j') return to(at < 0 ? 0 : at + 1)
  if (key === 'k') return to(at < 0 ? rows.length - 1 : at - 1)
  if (key === 'g') return to(0)
  if (key === 'e') return to(rows.length - 1)
  if (row === undefined) return null
  if (key === 'l') {
    if (!isOpen(row)) return row.kind === 'dir' ? { dir: row.path } : { file: row.path }
    const child = rows[at + 1]
    return row.kind === 'dir' && child !== undefined && child.depth > row.depth ? { focus: child.key } : null
  }
  if (row.kind === 'dir' && isOpen(row)) return { dir: row.path }
  const parent = parentRow(rows, at)

  return parent === undefined ? null : { focus: parent.key }
}

/** A key Button's press: q closes the pane; the rest do what navAction says. */
const pressNav = async ($: Dollar, key: NavKey) => {
  if (key === 'q') {
    await closePane($)
    return
  }
  const [{ rows, collapsedDirs }, expanded] = await Promise.all([
    listingNow($),
    key === 'l' ? read($, expandedAtom) : ([] as readonly string[]),
  ])
  const action = navAction(rows, focusedKey, key, row =>
    row.kind === 'dir' ? !collapsedDirs.includes(row.path) : expanded.includes(row.path),
  )
  if (action === null) return
  if ('focus' in action) await focusRow($, action.focus, key === 'g')
  else if ('dir' in action) await toggleDir($, action.dir)
  // The next key waits for the open, not for git.
  else if (await flipFile($, action.file)) background(loadDiff($, action.file))
}

/**
 * Runs a key's press once the ones before it have settled: each reads where
 * the last one left the ring, so j pressed twice fast moves two rows.
 */
export const inTurn = (press: () => Promise<void>): Promise<void> => {
  navChain = navChain.then(press).catch(() => undefined)

  return navChain
}

const runCommand = async ($: Dollar, args: string): Promise<string> => {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(word => word !== '')
  switch (sub) {
    case '':
      return focusPane($)
    case 'close':
      return rest.length > 0 ? USAGE : closePane($)
    case 'status': {
      const snapshot = await refresh($, { force: true })
      return snapshot ? summaryText(snapshot) : 'Could not read git.'
    }
    case 'refresh': {
      const snapshot = await refresh($, { force: true, isVisible: true })
      return snapshot ? `Refreshed: ${summaryText(snapshot).split('\n')[0]}` : 'Could not read git.'
    }
    case 'base':
      return rest.length > 1 ? USAGE : setBase($, rest[0])
    case 'trunk':
      return rest.length > 1 ? USAGE : setTrunk($, rest[0])
    case 'mode': {
      const mode = rest[0] ?? ''
      if (rest.length !== 1 || !isMode(mode)) return USAGE
      await setMode($, mode)
      return `Mode: ${mode}`
    }
    default:
      return USAGE
  }
}

export const register: Register = (on, options) => {
  config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wt-diff',
      description: 'Show what this worktree changed versus the branch it came from',
      argumentHint: ARGUMENT_HINT,
      // Watching Claude's edits land is the point: none of it needs the turn over.
      immediate: true,
    })
    // State outlives a reload: a snapshot already there means this is one,
    // and a pane the person closed stays closed.
    const isReload = (await read($, snapshotAtom)) !== null
    wantsAutoOpen = e.isInteractive && !isReload && config.autoOpen !== 'never'
    // A reload that cut a visible pass short never cleared its marker.
    if (await read($, refreshingAtom)) await update($, refreshingAtom, () => false)
    // An earlier load's status line, maybe in an older wording, or with the option since turned off.
    shownStatus = undefined
    $.ui.status(undefined)
    if (isReload) background(reapplyLook($))
    background(refresh($))

    return next(e)
  })

  // A phone or the desktop joining an idle session sees the totals without
  // waiting for a refresh; the last one leaving takes the copy off the terminal.
  on('session.attach', async ($, e, next) => {
    const joined = await next(e)
    if (config.statusLine) background(syncStatus($))

    return joined
  })

  on('session.detach', async ($, e, next) => {
    const left = await next(e)
    // An ending session has no line left to tidy.
    if (config.statusLine && e.reason !== 'end') background(syncStatus($))

    return left
  })

  on('command.run', { command: 'wt-diff' }, async ($, e) => {
    try {
      learnLayout($, e.presentation?.isFullscreen)
      return { text: printable(await runCommand($, e.args)) }
    } catch (error) {
      return { text: `wt-diff: ${errorText(error)}` }
    }
  })

  on('tool.call', async ($, e, next) => {
    const isEnter = String(e.tool) === 'EnterWorktree' && config.autoOpen !== 'never'
    const before = isEnter ? await $.session.cwd() : ''
    const ran = await next(e)
    try {
      if (TRIGGER_TOOLS.has(String(e.tool))) {
        // Only a move that happened: a denied or failed call leaves a closed pane closed.
        if (isEnter && ran.deny === undefined && ran.isError !== true && (await $.session.cwd()) !== before) {
          wantsAutoOpen = true
        }
        schedule($)
      }
    } catch {
      // Scheduling never stands in the way of the tool's result.
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    try {
      schedule($)
    } catch {
      // The next trigger schedules again.
    }

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) stopPolling()

    return closed
  }).catch(($, e, next) => next(e))

  // Watched, never moved: where the ring is, for j/k and for where it starts next time.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny === undefined) noteFocus(e.plugin === PLUGIN ? e.element : undefined)

    return moved
  }).catch(($, e, next) => next(e))

  // Drawn on every terminal screen, so it says early whether panes dock. With
  // statusLine on, the terminal's line ends with the totals; reading the
  // snapshot here redraws it when the snapshot changes.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    learnLayout($, e.viewport?.isFullscreen)
    if (!config.statusLine || e.surface !== 'terminal') return next(e)
    const text = statusLineText(await read($, snapshotAtom))
    if (text === undefined) return next(e)
    const tail = e.props.tail ? `${e.props.tail} · ${text}` : `· ${text}`

    return next({ ...e, props: { ...e.props, tail } })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui: Ui = $.ui.resolve(e)
    learnLayout($, e.viewport?.isFullscreen)
    startPolling($)
    const [snapshot, mode, expanded, diffs, isRefreshing, view, collapsedDirs] = await Promise.all([
      read($, snapshotAtom),
      read($, modeAtom),
      read($, expandedAtom),
      read($, diffsAtom),
      read($, refreshingAtom),
      read($, viewAtom),
      read($, collapsedAtom),
    ])
    const tree = view === 'tree' && snapshot?.isRepo === true ? buildTree(snapshot.files) : null
    const rows = listedRows(snapshot, tree, collapsedDirs)
    const autoFocus = ringStart(rows.map(row => navRow(row).key))

    return drawPane(ui, {
      snapshot,
      tree,
      rows,
      autoFocus,
      isFocused: e.props.isFocused,
      bodyRows: e.props.scroll.bodyRows,
      mode,
      expanded,
      diffs,
      isRefreshing,
      view,
      collapsedDirs,
      columns: Math.max(16, e.props.bodyColumns),
      surface: e.surface,
      diffStyle: config.diffStyle,
      onMode: picked => background(setMode($, picked)),
      onRefresh: () => background(refresh($, { force: true, isVisible: true })),
      onCollapse: () => background(collapseAll($)),
      onToggle: path => background(toggleFile($, path)),
      onView: () => background(toggleView($)),
      onDir: path => background(toggleDir($, path)),
      onFold: () => background(foldAll($)),
      onNav: key => background(inTurn(() => pressNav($, key))),
    })
  })
}

// ---------------------------------------------------------------- drawing

/** A row of the listing: the tree's rows, or the list's files. */
type ListRow = TreeRow | { kind: 'file'; file: FileChange }

type PaneModel = {
  snapshot: Snapshot | null
  /** The snapshot's tree in the tree view; null in the list. */
  tree: Tree | null
  rows: readonly ListRow[]
  /** The row Button the ring starts on when the pane takes the keyboard. */
  autoFocus: string | undefined
  isFocused: boolean
  /** The rows the pane's window shows at once. */
  bodyRows: number
  mode: DiffMode
  expanded: readonly string[]
  diffs: Readonly<Record<string, FileDiff>>
  isRefreshing: boolean
  view: ViewMode
  collapsedDirs: readonly string[]
  columns: number
  surface: RenderSurface
  diffStyle: DiffStyle
  onMode: (mode: DiffMode) => void
  onRefresh: () => void
  onCollapse: () => void
  onToggle: (path: string) => void
  onView: () => void
  onDir: (path: string) => void
  onFold: () => void
  onNav: (key: NavKey) => void
}

const navRow = (row: ListRow): NavRow =>
  row.kind === 'dir'
    ? { key: `dir:${row.dir.path}`, kind: 'dir', path: row.dir.path, depth: row.depth }
    : { key: `file:${row.file.path}`, kind: 'file', path: row.file.path, depth: 'depth' in row ? row.depth : 0 }

/** Cells a Button draws when plain: `h: label`. */
const plainCells = (hotkey: string, label: string) => hotkey.length + 2 + label.length

/** How many rows items of these widths take in a wrapping row. */
const wrappedRows = (widths: readonly number[], gap: number, columns: number): number => {
  let rows = 0
  let used = 0
  for (const width of widths) {
    if (rows === 0 || used + gap + width > columns) {
      rows += 1
      used = width
    } else used += gap + width
  }

  return Math.max(1, rows)
}

/** Rows a wrapping text takes in `cells`. */
const textRows = (text: string, cells: number): number => Math.max(1, Math.ceil(cellWidth(text) / Math.max(1, cells)))

const ESC_HINT = 'esc: back'
/** Rows the keys leave spare before they stay at the end: the height drawPane counts is no more than an estimate. */
const KEYS_SPARE_ROWS = 2
const FOCUS_HINT = 'ctrl+x tab to focus'

/** Rows drawKeys takes, its margin included; 0 where it draws nothing. */
const keysRows = (model: PaneModel): number => {
  if (model.isFocused) {
    const widths = [...NAV_KEYS.map(({ hotkey, label }) => plainCells(hotkey, label)), ESC_HINT.length]
    return wrappedRows(widths, 2, model.columns) + 1
  }
  return model.surface === 'terminal' ? textRows(FOCUS_HINT, model.columns) + 1 : 0
}

/**
 * The keys, dim: while the pane holds the keyboard, Buttons that carry the
 * hotkeys (a hotkey presses only a Button drawn); before, on the terminal,
 * how to give it the keyboard. Under the controls (`isTop`) or at the end.
 */
const drawKeys = (ui: Ui, model: PaneModel, isTop: boolean): RenderElement | null => {
  const { Box, Button, Text } = ui
  if (model.isFocused) {
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={isTop ? 0 : 1} marginBottom={isTop ? 1 : 0}>
        {NAV_KEYS.map(({ hotkey, label }) => (
          <Button key={`nav:${hotkey}`} label={label} hotkey={hotkey} plain dimColor onPress={() => model.onNav(hotkey)} />
        ))}
        <Text dimColor>{ESC_HINT}</Text>
      </Box>
    )
  }
  if (model.surface !== 'terminal') return null

  return (
    <Box flexDirection="column" marginTop={isTop ? 0 : 1} marginBottom={isTop ? 1 : 0}>
      <Text dimColor>{FOCUS_HINT}</Text>
    </Box>
  )
}

/** The ring's start on the row Button keyed `key`, if it is that one. */
const autoFocusOn = (model: PaneModel, key: string): { autoFocus?: true } =>
  model.autoFocus === key ? { autoFocus: true } : {}

/**
 * Two rows: the branch with ↑↓ at the right edge, then what it is compared
 * against with where that came from. Each part is cut to fit beforehand, so
 * the right side keeps its place.
 */
const drawHeader = (ui: Ui, model: PaneModel, snapshot: Snapshot): RenderElement[] => {
  const { Box, Text } = ui
  const { columns } = model
  const branch = oneLine(snapshot.branch ?? `detached ${snapshot.head}`.trim())
  const base = snapshot.head === '' ? null : snapshot.base
  const { ahead, behind } = snapshot

  // ↻ keeps its cell, drawn or not: a refresh moves nothing.
  const marks: RenderElement[] = [<Text dimColor>{model.isRefreshing ? '↻' : ' '}</Text>]
  if (base !== null) {
    marks.push(
      <Text> </Text>,
      ahead > 0 ? <Text>{`↑${ahead}`}</Text> : <Text dimColor>{`↑${ahead}`}</Text>,
      <Text> </Text>,
      behind > 0 ? <Text color="warning">{`↓${behind}`}</Text> : <Text dimColor>{`↓${behind}`}</Text>,
    )
  }
  const marksCells = base === null ? 1 : 2 + cellWidth(`↑${ahead} ↓${behind}`)
  const rows = [
    <Box flexDirection="row" justifyContent="space-between">
      <Text weight="semibold" wrap="truncate-end">
        {fitPath(branch, Math.max(1, columns - marksCells - 2))}
      </Text>
      <Box flexDirection="row">{marks}</Box>
    </Box>,
  ]
  if (snapshot.head === '') return rows

  if (base === null) {
    rows.push(
      <Box flexDirection="row">
        <Text dimColor>{'vs —  '}</Text>
        <Text color="warning" wrap="truncate-end">
          no base branch
        </Text>
      </Box>,
    )
    return rows
  }

  // Where the base came from gives way first, then the sha, then the ref is cut.
  const ref = oneLine(base.ref)
  const sha = base.mergeBase.slice(0, 7)
  const from =
    [`${base.source} · ${sha}`, sha].find(tail => 3 + cellWidth(ref) + 2 + cellWidth(tail) <= columns) ?? ''
  const refRoom = columns - 3 - (from === '' ? 0 : cellWidth(from) + 2)
  rows.push(
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        <Text dimColor>{'vs '}</Text>
        <Text wrap="truncate-end">{fitPath(ref, Math.max(1, refRoom))}</Text>
      </Box>
      {from !== '' ? <Text dimColor>{from}</Text> : null}
    </Box>,
  )

  return rows
}

// Secondary actions, dim at rest and at full strength under the focus or the
// pointer. The view and fold buttons are named for what a press does, as
// refresh and collapse are.
const drawActions = (ui: Ui, model: PaneModel, tree: Tree | null, hasMargin: boolean): RenderElement => {
  const { Box, Button } = ui

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginBottom={hasMargin ? 1 : 0}>
      <Button key="refresh" label="refresh" hotkey="r" plain dimColor onPress={model.onRefresh} />
      <Button
        key="view"
        label={model.view === 'tree' ? 'list' : 'tree'}
        hotkey="t"
        plain
        dimColor
        onPress={model.onView}
      />
      {tree !== null && tree.dirs.length > 0 ? (
        <Button
          key="fold"
          label={isAllFolded(tree, model.collapsedDirs) ? 'unfold' : 'fold'}
          hotkey="z"
          plain
          dimColor
          onPress={model.onFold}
        />
      ) : null}
      {model.expanded.length > 0 ? (
        <Button key="collapse" label="collapse" hotkey="x" plain dimColor onPress={model.onCollapse} />
      ) : null}
    </Box>
  )
}

/** Rows the controls take, wrapped, their margin left out. */
const actionsRows = (model: PaneModel, tree: Tree | null): number => {
  const widths = [plainCells('r', 'refresh'), plainCells('t', model.view === 'tree' ? 'list' : 'tree')]
  if (tree !== null && tree.dirs.length > 0) {
    widths.push(plainCells('z', isAllFolded(tree, model.collapsedDirs) ? 'unfold' : 'fold'))
  }
  if (model.expanded.length > 0) widths.push(plainCells('x', 'collapse'))

  return wrappedRows(widths, 2, model.columns)
}

const TAB_GAP = 3
/** A plain Button with a hotkey draws `a: all`: the letter, a colon and a space, then the label. */
const tabCells = (mode: DiffMode) => MODE_HOTKEY[mode].length + 2 + mode.length
/** The tab row on one line; narrower, it wraps and the rule cannot point at a tab. */
const TABS_CELLS = MODES.reduce((sum, mode) => sum + tabCells(mode), 0) + TAB_GAP * (MODES.length - 1)

/** Draws the rule under the tabs, or, wrapped, underlines the current one. */
const isTabRuled = (model: PaneModel) => model.surface === 'terminal' && model.columns >= TABS_CELLS

// The current mode at full strength and semibold; `primary` wherever a surface
// draws its own buttons. The others dim.
const drawTabs = (ui: Ui, model: PaneModel): RenderElement => {
  const { Box, Button, Text } = ui
  const isUnderlined = model.surface === 'terminal' && !isTabRuled(model)

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={TAB_GAP}>
      {MODES.map(mode =>
        mode === model.mode ? (
          <Button
            key={`mode:${mode}`}
            label={mode}
            hotkey={MODE_HOTKEY[mode]}
            plain
            variant="primary"
            onPress={() => model.onMode(mode)}
          >
            {isUnderlined ? (
              <Text weight="semibold" underline>
                {mode}
              </Text>
            ) : (
              <Text weight="semibold">{mode}</Text>
            )}
          </Button>
        ) : (
          <Button
            key={`mode:${mode}`}
            label={mode}
            hotkey={MODE_HOTKEY[mode]}
            plain
            dimColor
            onPress={() => model.onMode(mode)}
          />
        ),
      )}
    </Box>
  )
}

/** A full-width rule under the tabs, heavy under the current one; the terminal only, where cells line up. */
const drawRule = (ui: Ui, model: PaneModel): RenderElement | null => {
  const { Box, Text } = ui
  const { columns } = model
  if (model.surface !== 'terminal') return null
  if (!isTabRuled(model)) return <Text color="subtle">{'─'.repeat(columns)}</Text>
  const index = MODES.indexOf(model.mode)
  const offset = MODES.slice(0, index).reduce((sum, mode) => sum + tabCells(mode) + TAB_GAP, 0)
  const width = tabCells(model.mode)

  return (
    <Box flexDirection="row">
      {offset > 0 ? <Text color="subtle">{'─'.repeat(offset)}</Text> : null}
      <Text color="suggestion">{'━'.repeat(width)}</Text>
      {columns - offset - width > 0 ? <Text color="subtle">{'─'.repeat(columns - offset - width)}</Text> : null}
    </Box>
  )
}

const LEGEND_CELLS = 46

/** The current listing in one row: how many files, how many not committed yet in `all`, the line totals. */
const drawSummary = (ui: Ui, model: PaneModel, snapshot: Snapshot): RenderElement => {
  const { Box, Text } = ui
  const { files, added, removed } = snapshot.totals
  const lead = `${files} ${files === 1 ? 'file' : 'files'}`
  const totals = `+${added} ${MINUS}${removed}`
  const open = snapshot.mode === 'all' ? snapshot.files.filter(file => file.layer !== 'committed').length : 0
  const mark = `  ● ${open}`
  const room = model.columns - cellWidth(lead) - 2 - cellWidth(totals)
  const legend: RenderElement[] = []
  if (open > 0 && room >= cellWidth(mark)) {
    legend.push(<Text color="suggestion">{mark}</Text>)
    if (model.columns >= LEGEND_CELLS && room >= cellWidth(mark) + 12) legend.push(<Text dimColor> uncommitted</Text>)
  }

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        <Text>{lead}</Text>
        {legend}
      </Box>
      <Text>
        <Text color="success">{`+${added}`}</Text> <Text color="error">{`${MINUS}${removed}`}</Text>
      </Text>
    </Box>
  )
}

/** A line of a notice's hint: dim words, the letters a press acts on, and a command to type. */
type HintLine = readonly (string | { press: string } | { code: string })[]

/** What the pane says in place of a listing, or above one a failed read kept. */
type Notice = { glyph: string; tone: 'success' | 'warning' | 'error'; title: string; hint: readonly HintLine[] }

/** The notice for this snapshot, or null when there are files to list and nothing to say. */
const noticeOf = (snapshot: Snapshot): Notice | null => {
  if (snapshot.head === '') {
    const hint = [['Changes show up here after the first commit.']]
    return { glyph: '!', tone: 'warning', title: 'No commits yet', hint }
  }
  if (snapshot.error) {
    const hint = [[oneLine(snapshot.error)], [{ press: 'r' }, ' to retry']]
    return { glyph: '✕', tone: 'error', title: 'git failed', hint }
  }
  if (!snapshot.base && snapshot.mode !== 'uncommitted') {
    return {
      glyph: '!',
      tone: 'warning',
      title: 'Nothing to compare against',
      hint: [
        ['Set one with ', { code: '/wt-diff base <ref>' }, ','],
        ['or press ', { press: 'u' }, ' for uncommitted changes.'],
      ],
    }
  }
  if (snapshot.files.length > 0) return null

  return {
    glyph: '✓',
    tone: 'success',
    title:
      snapshot.mode === 'uncommitted' || !snapshot.base
        ? 'No uncommitted changes'
        : `No changes vs ${oneLine(snapshot.base.ref)}`,
    // An edit reaches `committed` only once it is committed.
    hint: [
      [snapshot.mode === 'committed' ? 'Commits on this branch will show up here.' : 'Edits will show up here as you work.'],
    ],
  }
}

/** Rows drawNotice takes, its margins included. */
const noticeRows = (notice: Notice, isAboveRows: boolean, columns: number): number =>
  2 +
  (isAboveRows ? 1 : 0) +
  notice.hint.reduce(
    (sum, line) =>
      sum + textRows(line.map(part => (typeof part === 'string' ? part : 'press' in part ? part.press : part.code)).join(''), columns - 2),
    0,
  )

const drawNotice = (ui: Ui, notice: Notice, isAboveRows: boolean): RenderElement => {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={isAboveRows ? 1 : 0}>
      <Text>
        <Text color={notice.tone}>{`${notice.glyph} `}</Text>
        <Text weight="semibold">{notice.title}</Text>
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {notice.hint.map(line => (
          <Text>
            {line.map(part =>
              typeof part === 'string' ? (
                <Text dimColor>{part}</Text>
              ) : 'press' in part ? (
                <Text color="suggestion">{part.press}</Text>
              ) : (
                <Text>{part.code}</Text>
              ),
            )}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

/**
 * Leading cells of a tree row at `depth`: two a level, at most a third of the
 * width, and never the cells the rest of the row (`rest`) needs.
 */
const indentCells = (depth: number, columns: number, rest: number): number =>
  Math.max(0, Math.min(depth * 2, Math.floor(columns / 3), columns - rest))

/** The indent as text: spaces where cells are monospace, none where a native button would drop them. */
const indentText = (model: PaneModel, cells: number): string => (model.surface === 'terminal' ? ' '.repeat(cells) : '')

/** Elsewhere a row is indented by its Box: a number of cells on every surface. */
const indented = (ui: Ui, model: PaneModel, cells: number, key: string, row: RenderElement): RenderElement => {
  const { Box } = ui
  if (model.surface === 'terminal' || cells === 0) return row

  // A column, so the row inside stretches to the width and its counts reach the edge.
  return (
    <Box key={`at:${key}`} flexDirection="column" paddingLeft={cells}>
      {row}
    </Box>
  )
}

/** The fewest cells a row's name keeps. */
const NAME_MIN = 4

/** A row's counts, for its right edge: each in its color, or all dim. */
const drawCounts = (ui: Ui, { added, removed, other }: Counts, isDim = false): RenderElement => {
  const { Text } = ui
  if (isDim) return <Text dimColor>{[added, removed, other].filter(part => part !== undefined).join(' ')}</Text>
  const parts: (string | RenderElement)[] = []
  if (added !== undefined) parts.push(<Text color="success">{added}</Text>)
  if (added !== undefined && removed !== undefined) parts.push(' ')
  if (removed !== undefined) parts.push(<Text color="error">{removed}</Text>)
  if (other !== undefined) parts.push(<Text dimColor>{other}</Text>)

  return <Text>{parts}</Text>
}

/**
 * A row: what it is on the left, its counts pushed to the right edge. Only
 * the name is a Button, so the focus inverts the name and nothing more. A
 * Box key with a control character in it is dropped.
 */
const drawLine = (ui: Ui, key: string, left: RenderElement[], right: RenderElement | null): RenderElement => {
  const { Box } = ui

  return (
    <Box key={`row:${oneLine(key)}`} flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">{left}</Box>
      {right}
    </Box>
  )
}

/** In the tree: where the row sits and the name it shows. */
type Place = { depth: number; name: string }

/** A file row, and the cell its name starts at: where its diff lines up. */
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)
const isSameDir = (a: string, b: string): boolean => dirOf(a) === dirOf(b)

const drawRow = (
  ui: Ui,
  model: PaneModel,
  file: FileChange,
  place?: Place,
): { node: RenderElement; nameCol: number } => {
  const { Button, Text } = ui
  // The snapshot's own mode: a switch shows the old rows until git answers.
  const isLayered = model.snapshot?.mode === 'all'
  const counts = countParts(file)
  const countsLen = countsWidth(counts)
  // At least a cell between the name and the counts.
  const tail = countsLen > 0 ? countsLen + 1 : 0
  // `M ● ` or `M   ` in `all`, else `M `.
  const own = isLayered ? 4 : 2
  const cells = place === undefined ? 0 : indentCells(place.depth, model.columns, own + tail + NAME_MIN)
  const room = Math.max(NAME_MIN, model.columns - cells - own - tail)
  const name = fitPath(oneLine(place?.name ?? file.path), room)
  // A rename: the name first, where it came from in what room is left. In the
  // tree a rename within its directory says only the old name, as the row does.
  const left = room - cellWidth(name) - 3
  const oldName =
    file.oldPath !== undefined && place !== undefined && isSameDir(file.oldPath, file.path)
      ? baseName(file.oldPath)
      : file.oldPath
  const from = oldName !== undefined && left >= 4 ? ` ← ${fitPath(oneLine(oldName), left)}` : ''

  const statusColor = STATUS_COLOR[file.status]
  const indent = indentText(model, cells)
  const lead: (string | RenderElement)[] = indent === '' ? [] : [indent]
  lead.push(statusColor ? <Text color={statusColor}>{file.status}</Text> : <Text dimColor>{file.status}</Text>)
  if (!isLayered) lead.push(' ')
  else if (file.layer === 'committed') lead.push('   ')
  else lead.push(' ', <Text color="suggestion">●</Text>, ' ')

  // In the list a path's directories are dim; an open file's name is semibold.
  const slash = name.lastIndexOf('/') + 1
  const label: (string | RenderElement)[] = []
  if (slash > 0) label.push(<Text dimColor>{name.slice(0, slash)}</Text>)
  label.push(
    model.expanded.includes(file.path) ? <Text weight="semibold">{name.slice(slash)}</Text> : name.slice(slash),
  )

  const key = `file:${file.path}`
  const row = drawLine(
    ui,
    key,
    [
      <Text>{lead}</Text>,
      <Button key={key} plain onPress={() => model.onToggle(file.path)} {...autoFocusOn(model, key)}>
        {label}
      </Button>,
      ...(from !== '' ? [<Text dimColor>{from}</Text>] : []),
    ],
    countsLen > 0 ? drawCounts(ui, counts) : null,
  )

  return { node: indented(ui, model, cells, key, row), nameCol: cells + own }
}

const drawDirRow = (ui: Ui, model: PaneModel, dir: TreeDir, depth: number, isCollapsed: boolean): RenderElement => {
  const { Button, Text } = ui
  // An open directory's files say their own counts; a folded one sums them.
  const counts: Counts = {}
  if (isCollapsed && dir.added > 0) counts.added = `+${dir.added}`
  if (isCollapsed && dir.removed > 0) counts.removed = `${MINUS}${dir.removed}`
  const countsLen = countsWidth(counts)
  // The arrow, the slash and the sums; a name first, then `(N)`, then the indent.
  const fixed = 3 + (countsLen > 0 ? countsLen + 1 : 0)
  const folded = isCollapsed ? ` (${dir.fileCount})` : ''
  const count = model.columns - fixed - NAME_MIN >= folded.length ? folded : ''
  const cells = indentCells(depth, model.columns, fixed + count.length + NAME_MIN)
  const room = Math.max(NAME_MIN, model.columns - cells - fixed - count.length)
  const indent = indentText(model, cells)

  const key = `dir:${dir.path}`
  const left: RenderElement[] = []
  if (indent !== '') left.push(<Text>{indent}</Text>)
  left.push(
    <Button key={key} plain onPress={() => model.onDir(dir.path)} {...autoFocusOn(model, key)}>
      <Text dimColor>{isCollapsed ? '▸ ' : '▾ '}</Text>
      {`${fitPath(oneLine(dir.name), room)}/`}
    </Button>,
  )
  if (count !== '') left.push(<Text dimColor>{count}</Text>)

  return indented(ui, model, cells, key, drawLine(ui, key, left, countsLen > 0 ? drawCounts(ui, counts, true) : null))
}

/**
 * A line cut to just past `cells`: no more text than is drawn, still wide
 * enough for Text to mark the cut. A wide character across the edge is kept
 * whole, or the cut would fit and show no ellipsis.
 */
const clip = (text: string, cells: number): string => {
  if (text.length * 2 <= cells || cellWidth(text) <= cells) return text
  const cut = takeCells(text, cells + 1)

  return cellWidth(cut) > cells ? cut : takeCells(text, cells + 2)
}

/** A diff line's marker and colour; a hunk header is drawn on its own. */
const LINE_LOOK: Record<Exclude<DiffLine['kind'], 'hunk'>, { mark: string; color?: string }> = {
  add: { mark: '+ ', color: 'success' },
  del: { mark: '- ', color: 'error' },
  ctx: { mark: '  ' },
  meta: { mark: '' },
}

/**
 * A hunk header as `@@ <first new line>`; a hunk that leaves nothing on the
 * new side (`+0,0`) names its first old line, `@@ −<line>`, instead.
 */
const hunkHead = (line: DiffLine, cells: number): string => {
  if (line.newStart === undefined) return clip(line.text, cells)
  if (line.newStart === 0 && line.oldStart !== undefined) return `@@ −${line.oldStart}`

  return `@@ ${line.newStart}`
}

/**
 * A modified file's lines, each in its colour on the pane's own background:
 * `+`/`-` lines in success/error, context and hunk headers dim, a header as
 * `@@ <first new line>  <function>` (see hunkHead). Every line is cut at `cells`.
 */
const drawLines = (ui: Ui, lines: readonly DiffLine[], cells: number): { nodes: RenderElement[]; chars: number } => {
  const { Text } = ui
  let chars = 0
  const nodes = lines.map(line => {
    if (line.kind === 'hunk') {
      const head = hunkHead(line, cells)
      const ctx = line.newStart !== undefined && line.ctx !== undefined ? clip(line.ctx, cells - head.length - 2) : ''
      chars += head.length + (ctx === '' ? 0 : ctx.length + 2)
      return (
        <Text dimColor wrap="truncate-end">
          {head}
          {ctx !== '' ? '  ' : null}
          {ctx !== '' ? <Text italic>{ctx}</Text> : null}
        </Text>
      )
    }
    const { mark, color } = LINE_LOOK[line.kind]
    // An empty line still takes its row.
    const text = clip(`${mark}${line.text}`, cells) || ' '
    chars += text.length
    return color !== undefined ? (
      <Text color={color} wrap="truncate-end">
        {text}
      </Text>
    ) : (
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
    )
  })

  return { nodes, chars }
}

/**
 * An open file's diff, under its row from the cell its name starts at
 * (`nameCol`): a file added whole as source with line numbers, a deleted one
 * as a line, any other as drawLines draws it, or the engine's diff view
 * under diffStyle `engine`. `chars` is the text it draws; past `room` it is
 * hidden instead.
 */
const drawDiff = (
  ui: Ui,
  model: PaneModel,
  file: FileChange,
  diff: FileDiff | undefined,
  room: number,
  nameCol: number,
): { node: RenderElement; chars: number; rows: number } => {
  const { Box, Code, Text } = ui
  const cells = Math.max(1, model.columns - nameCol)
  // Rows below include the margin under it.
  const note = (text: string, isError = false) => ({
    node: (
      <Box flexDirection="column" paddingLeft={nameCol} marginBottom={1}>
        {isError ? <Text color="error">{text}</Text> : <Text dimColor>{text}</Text>}
      </Box>
    ),
    chars: text.length,
    rows: textRows(text, cells) + 1,
  })
  const shown = (body: RenderElement | RenderElement[], chars: number, lines: number) => {
    const more = diff !== undefined && diff.omittedLines > 0 ? `… ${diff.omittedLines} more lines — open in editor` : null
    const total = chars + (more?.length ?? 0)
    if (total > room) return note('Diff hidden: too much is open. Collapse other files to see it.')
    return {
      node: (
        <Box key={`diff:${oneLine(file.path)}`} flexDirection="column" paddingLeft={nameCol} marginBottom={1}>
          {body}
          {more !== null ? <Text dimColor>{more}</Text> : null}
        </Box>
      ),
      chars: total,
      rows: lines + (more !== null ? 1 : 0) + 1,
    }
  }

  // Its lines are all gone: how many says enough.
  if (!needsDiff(file)) {
    return note(`deleted · ${file.removed} ${file.removed === 1 ? 'line' : 'lines'}`, true)
  }
  if (diff === undefined) return note('loading…')
  if (diff.error !== undefined) return note(oneLine(diff.error), true)
  if (diff.isBinary) return note('Binary file')
  if (diff.hunks === '') return note('No textual changes')
  // Past what one drawing takes, before any of it is parsed.
  if (diff.hunks.length > room) return note('Diff hidden: too much is open. Collapse other files to see it.')

  const path = oneLine(file.path)
  const added = addedSource(diff.hunks)
  if (added !== null) {
    // The engine draws the line numbers: the tree holds the source alone.
    return shown(
      <Code format="source" source={added} path={path} startLine={1} wrap="truncate-end" />,
      added.length,
      added.split('\n').length,
    )
  }
  if (model.diffStyle === 'engine') {
    const source = printable(diff.hunks)
    return shown(<Code format="diff" source={source} path={path} wrap="truncate-end" />, source.length, source.split('\n').length)
  }
  const { nodes, chars } = drawLines(ui, parseHunks(diff.hunks), cells)

  return shown(nodes, chars, nodes.length)
}

/** Whether rows are listed: no notice, or a failed read that kept what it listed before. */
const isListedOf = (snapshot: Snapshot, notice: Notice | null): boolean =>
  notice === null || (Boolean(snapshot.error) && snapshot.head !== '' && snapshot.files.length > 0)

/** The rows the pane lists, in drawing order: a collapsed directory's files are none; no listing, no rows. */
const listedRows = (snapshot: Snapshot | null, tree: Tree | null, collapsedDirs: readonly string[]): ListRow[] => {
  if (snapshot === null || !snapshot.isRepo || !isListedOf(snapshot, noticeOf(snapshot))) return []

  return tree === null
    ? snapshot.files.map(file => ({ kind: 'file' as const, file }))
    : visibleRows(tree, new Set(collapsedDirs))
}

export const drawPane = (ui: Ui, model: PaneModel): RenderElement => {
  const { Box, Text } = ui
  const { snapshot, tree } = model

  if (snapshot === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Reading git…</Text>
        {drawKeys(ui, model, false)}
      </Box>
    )
  }
  if (!snapshot.isRepo) {
    return (
      <Box flexDirection="column">
        {snapshot.error ? (
          <Text color="error">{`Error: ${oneLine(snapshot.error)}`}</Text>
        ) : (
          <Text>Not a git repository</Text>
        )}
        <Text dimColor wrap="truncate-middle">
          {oneLine(snapshot.cwd)}
        </Text>
        {drawKeys(ui, model, false)}
      </Box>
    )
  }

  const body: RenderElement[] = drawHeader(ui, model, snapshot)
  // Roughly the rows drawn: whether the keys still show at the end.
  let height = body.length
  let controlsAt = -1
  // The rule is text as wide as the pane: it takes its share of the budget.
  let used = 0
  if (snapshot.head !== '') {
    controlsAt = body.length
    body.push(drawActions(ui, model, tree, true), drawTabs(ui, model))
    height += actionsRows(model, tree) + 1 + wrappedRows(MODES.map(tabCells), TAB_GAP, model.columns)
    const rule = drawRule(ui, model)
    if (rule !== null) {
      body.push(rule)
      used += model.columns
      height += 1
    }
  }

  /**
   * The keys go at the end, where they push nothing down, while all of it
   * fits the window; past that they would scroll out of reach, so they sit
   * under the controls instead. The count matches the painter's to the row,
   * and a surface may draw a row or two more: the end needs that much spare.
   */
  const finish = () => {
    const keys = keysRows(model)
    if (controlsAt >= 0 && keys > 0 && height + keys + KEYS_SPARE_ROWS > model.bodyRows) {
      body.splice(controlsAt, 1, drawActions(ui, model, tree, false), drawKeys(ui, model, true) as RenderElement)
    } else {
      const drawn = drawKeys(ui, model, false)
      if (drawn !== null) body.push(drawn)
    }

    return <Box flexDirection="column">{body}</Box>
  }

  const notice = noticeOf(snapshot)
  const isListed = isListedOf(snapshot, notice)
  if (notice === null) {
    body.push(drawSummary(ui, model, snapshot))
    height += 1
  } else {
    body.push(drawNotice(ui, notice, isListed))
    height += noticeRows(notice, isListed, model.columns)
  }
  if (!isListed) return finish()

  const { rows } = model
  // A row is at most the width, so the rows still to come take their share
  // of the budget before a diff does: none of them is cut off the end.
  let lastDepth = 0
  let isAfterDiff = false
  rows.forEach((row, index) => {
    used += model.columns
    const place = 'name' in row ? row : undefined
    const depth = row.kind === 'dir' ? row.depth : (place?.depth ?? 0)
    const drawn =
      row.kind === 'dir'
        ? { node: drawDirRow(ui, model, row.dir, row.depth, row.isCollapsed), nameCol: 0 }
        : drawRow(ui, model, row.file, place)
    // A top-level row after a nested one starts a group; a diff's own margin already parts them.
    const isGroup = depth === 0 && lastDepth > 0 && !isAfterDiff
    body.push(
      isGroup ? (
        <Box flexDirection="column" marginTop={1}>
          {drawn.node}
        </Box>
      ) : (
        drawn.node
      ),
    )
    height += isGroup ? 2 : 1
    lastDepth = depth
    isAfterDiff = false
    if (row.kind === 'dir' || !model.expanded.includes(row.file.path)) return
    const later = (rows.length - index - 1) * model.columns + TAIL_CHARS
    const diff = drawDiff(ui, model, row.file, model.diffs[row.file.path], TEXT_BUDGET - used - later, drawn.nameCol)
    body.push(diff.node)
    used += diff.chars
    height += diff.rows
    isAfterDiff = true
  })
  if (snapshot.omittedFiles > 0) {
    body.push(<Text dimColor>{`… ${snapshot.omittedFiles} more files`}</Text>)
    height += 1
  }

  return finish()
}
