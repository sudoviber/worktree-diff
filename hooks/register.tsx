import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  PluginOptions,
  Register,
  RenderElement,
  RenderSurface,
  Timer,
  ToolCallResult,
} from 'claude-code'

import type { DiffMode, FileChange, FileDiff, Snapshot, ViewMode, WorktreeChoice, WorktreePicker } from '../types'
import {
  commonDirOf,
  computeSnapshot,
  DIRS_ARGS,
  git,
  isLinked,
  loadFileDiff,
  parseWorktreeListPorcelain,
  repoDirs,
  shortRef,
  stableStartPoint,
  summaryText,
  type GitDeps,
  type RepoDirs,
  type UntrackedCache,
} from './git'
import { addedSource, charWidth, parseHunks, type DiffLine } from './diff-lines'
import {
  clampOffset,
  moveCursor,
  moveDiff,
  numberHunks,
  paneLayout,
  refreshedTreeWindow,
  rowBudget,
  scrollBy,
  treeWindow,
  wheelRegion,
  windowHunks,
  type CursorMove,
  type DiffMove,
  type NumberedDiff,
  type PaneLayout,
  type Region,
  type RowBudget,
} from './layout'
import { baseName, buildTree, dirPaths, isAllFolded, visibleRows, type Tree, type TreeDir, type TreeRow } from './tree'
import { followPath, isFollowable, normalizePath, parentDir, pickTarget, resolvePath } from './follow'

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
  { hotkey: 'o', label: 'worktree' },
] as const
type NavKey = (typeof NAV_KEYS)[number]['hotkey']
/** The `o` list's keys, in both views: the same letters, each a Button of its own only while the list shows. */
const PICK_KEYS = [
  { hotkey: 'j', label: 'down' },
  { hotkey: 'k', label: 'up' },
  { hotkey: 'l', label: 'select' },
  { hotkey: 'h', label: 'back' },
  { hotkey: 'o', label: 'back' },
  { hotkey: 'q', label: 'close' },
] as const
type PickKey = (typeof PICK_KEYS)[number]['hotkey']
/**
 * diffView side: one Button per hotkey, each acting by the region the keys are
 * in. Half a page up is `b`: `u` stays the uncommitted tab. Drawn in this
 * order on the hint row, which shows as many as fit; the rest still press.
 */
const SIDE_KEYS: Record<Region, readonly { hotkey: SideKey; label: string }[]> = {
  tree: [
    { hotkey: 'j', label: 'down' },
    { hotkey: 'k', label: 'up' },
    { hotkey: 'l', label: 'open' },
    { hotkey: 'w', label: 'diff' },
    { hotkey: 'h', label: 'fold' },
    { hotkey: 'q', label: 'close' },
    { hotkey: 'd', label: 'page' },
    { hotkey: 'b', label: 'back' },
    { hotkey: 'g', label: 'top' },
    { hotkey: 'e', label: 'end' },
    { hotkey: 'o', label: 'worktree' },
  ],
  diff: [
    { hotkey: 'j', label: 'down' },
    { hotkey: 'k', label: 'up' },
    { hotkey: 'd', label: 'page' },
    { hotkey: 'b', label: 'back' },
    { hotkey: 'n', label: 'next' },
    { hotkey: 'p', label: 'prev' },
    { hotkey: 'h', label: 'tree' },
    { hotkey: 'q', label: 'close' },
    { hotkey: 'g', label: 'top' },
    { hotkey: 'e', label: 'end' },
    { hotkey: 'w', label: 'tree' },
    { hotkey: 'o', label: 'worktree' },
  ],
}
export type SideKey = 'j' | 'k' | 'd' | 'b' | 'n' | 'p' | 'g' | 'e' | 'l' | 'h' | 'w' | 'q' | 'o'
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
// They move the session itself: what Claude was followed into gives way.
const MOVE_TOOLS = new Set(['EnterWorktree', 'ExitWorktree'])
const ARGUMENT_HINT =
  '[close | status | refresh | at [<path>] | base [<ref>] | trunk [<ref>] | mode all|committed|uncommitted]'
export const USAGE = [
  `Usage: /wt-diff ${ARGUMENT_HINT}`,
  '  /wt-diff              open the Changes pane and give it the keyboard',
  '  /wt-diff close        close the Changes pane',
  '  /wt-diff status       print the changes as text',
  '  /wt-diff refresh      re-read git now',
  '  /wt-diff at <path>    show the worktree at <path> instead of the one Claude works in; /wt-diff at follows again',
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
const cursorAtom = atom({ plugin: 'worktree-diff', key: 'cursor' } as const, null, { shape: 'cursor-1' })
const regionAtom = atom({ plugin: 'worktree-diff', key: 'region' } as const, 'tree', { shape: 'region-1' })
const diffOffsetAtom = atom({ plugin: 'worktree-diff', key: 'diffOffset' } as const, 0, { shape: 'offset-1' })
const treeOffsetAtom = atom({ plugin: 'worktree-diff', key: 'treeOffset' } as const, 0, { shape: 'offset-1' })
const pinnedAtom = atom({ plugin: 'worktree-diff', key: 'pinned' } as const, null, { shape: 'pinned-1' })
const followedAtom = atom({ plugin: 'worktree-diff', key: 'followed' } as const, null, { shape: 'followed-1' })
const fallbackAtom = atom({ plugin: 'worktree-diff', key: 'fallback' } as const, null, { shape: 'fallback-1' })
const pickerAtom = atom({ plugin: 'worktree-diff', key: 'picker' } as const, null, { shape: 'picker-1' })
const followOpensAtom = atom({ plugin: 'worktree-diff', key: 'followOpens' } as const, true, { shape: 'follow-opens-1' })

// ----------------------------------------------------------------- config

type AutoOpen = 'worktree' | 'always' | 'never'
/** quiet: a modified file's lines in their own colours, no background; engine: the engine's diff view. */
type DiffStyle = 'quiet' | 'engine'
/** transparent: the terminal's own background shows through the pane; theme: the surface's pane fill. */
type PaneBackground = 'transparent' | 'theme'
/** side: the cursor's file in a region beside the tree; inline: each opened file under its row. */
type DiffView = 'side' | 'inline'
type Config = {
  autoOpen: AutoOpen
  pollSeconds: number
  statusLine: boolean
  diffStyle: DiffStyle
  paneBackground: PaneBackground
  diffView: DiffView
}

export const readConfig = (options: PluginOptions): Config => {
  const { autoOpen, pollSeconds, statusLine, diffStyle, paneBackground, diffView } = options
  const poll = pollSeconds === undefined ? 5 : Number(pollSeconds)

  return {
    autoOpen: autoOpen === 'always' || autoOpen === 'never' ? autoOpen : 'worktree',
    pollSeconds: Number.isFinite(poll) && poll > 0 ? poll : 0,
    statusLine: statusLine === true,
    diffStyle: diffStyle === 'engine' ? 'engine' : 'quiet',
    paneBackground: paneBackground === 'theme' ? 'theme' : 'transparent',
    diffView: diffView === 'inline' ? 'inline' : 'side',
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

// ----------------------------------------------------------------- target

/** Where the pane's worktree comes from: a pin, Claude's last tool call, or the session itself. */
type Level = 'pinned' | 'followed' | 'session'

/** The directory the pane shows (pickTarget), where it comes from, and the session's own directory. */
const targetNow = async ($: Dollar): Promise<{ path: string; level: Level; session: string }> => {
  const [pinned, followed, session] = await Promise.all([read($, pinnedAtom), read($, followedAtom), $.session.cwd()])
  const level: Level = pinned !== null ? 'pinned' : followed !== null ? 'followed' : 'session'

  return { path: pickTarget(pinned, followed, session), level, session }
}

const sameDir = (a: string, b: string) => normalizePath(a) === normalizePath(b)

const homeDir = async ($: Dollar): Promise<string> => {
  try {
    return (await $.env.get('HOME')) ?? ''
  } catch {
    return ''
  }
}

const isDir = async ($: Dollar, path: string): Promise<boolean> => {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

/** `path`, or the nearest directory above it that exists; null when none does. */
const nearestDir = async ($: Dollar, path: string): Promise<string | null> => {
  let dir = path
  while (!(await isDir($, dir))) {
    if (dir === '/') return null
    dir = parentDir(dir)
  }

  return dir
}

const removedNotice = (name: string) => `worktree removed — back to ${name}`

/** The root of the worktree `dir` is in; null outside one. */
const toplevel = async (deps: GitDeps, dir: string): Promise<string | null> => {
  const top = await git(deps, dir, ['rev-parse', '--show-toplevel'])
  const root = top.stdout.trim()

  return top.exitCode === 0 && root !== '' ? root : null
}

/**
 * Whether the worktree rooted at `root` is gone: its directory, or git's word
 * that it is none (or, nested in another worktree, is that one); a git that
 * only failed keeps it.
 */
const isGone = async ($: Dollar, deps: GitDeps, root: string): Promise<boolean> => {
  if (!(await isDir($, root))) return true
  const top = await git(deps, root, ['rev-parse', '--show-toplevel'])

  return top.exitCode === 0 ? !sameDir(top.stdout.trim(), root) : /not a git repository/i.test(top.stderr)
}

/** The session directory's worktree and repository, kept while the session stays there. */
let sessionRepo: { cwd: string; dirs: RepoDirs } | undefined

/**
 * The session directory's worktree and repository; null when git says it is
 * in none, undefined when git failed to say (timed out, locked): no answer.
 */
const sessionDirs = async (deps: GitDeps, cwd: string): Promise<RepoDirs | null | undefined> => {
  if (sessionRepo?.cwd === cwd) return sessionRepo.dirs
  const top = await git(deps, cwd, ['rev-parse', '--show-toplevel'])
  const root = top.stdout.trim()
  if (top.exitCode !== 0 || root === '') return /not a git repository/i.test(top.stderr) ? null : undefined
  const dirs = await git(deps, root, DIRS_ARGS)
  const gitCommonDir = dirs.exitCode === 0 ? commonDirOf(dirs.stdout, root) : ''
  if (gitCommonDir === '') return undefined
  // Outside a repository is read again next time.
  sessionRepo = { cwd, dirs: { root, gitCommonDir } }

  return sessionRepo.dirs
}

/** Follows run one after another, in the order their calls ran: the last one's worktree stands. */
let followChain: Promise<void> = Promise.resolve()

const inFollow = (work: () => Promise<void>): Promise<void> => {
  followChain = followChain.then(work).catch(() => undefined)

  return followChain
}

/** A new worktree for the pane drops the last one's removal notice. */
const setFollowed = async ($: Dollar, value: string | null) => {
  if ((await read($, followedAtom)) !== value) await update($, followedAtom, () => value)
  if ((await read($, fallbackAtom)) !== null) await update($, fallbackAtom, () => null)
}

const setPinned = async ($: Dollar, value: string | null) => {
  if ((await read($, pinnedAtom)) !== value) await update($, pinnedAtom, () => value)
  if ((await read($, fallbackAtom)) !== null) await update($, fallbackAtom, () => null)
}

/**
 * Whether a Bash call that errored ran: core's error text says the exit code
 * of a command that ran and failed. A call refused beneath the plugin (a
 * hook, a rule, the person at the prompt) comes back errored with the reason alone.
 */
const hasRun = (ran: ToolCallResult): boolean =>
  ran.deny === undefined && /\bExit code -?\d+\b/.test(ran.text ?? (typeof ran.result === 'string' ? ran.result : ''))

/**
 * After a tool call that ran: the worktree its path is in becomes the one
 * the pane follows, if it is one of the session repository's (any, with the
 * session outside one); the session's own worktree clears it. The first
 * linked worktree followed opens the pane, unless the person closed it.
 * A relative path is read from `start`, where the call ran (a subagent's own
 * directory); `isExact` takes the path only where a directory stands.
 */
const follow = async ($: Dollar, tool: string, input: object, start: string, isExact: boolean) => {
  const path = followPath(tool, input, start, await homeDir($))
  if (path === null) return
  const dir = isExact ? ((await isDir($, path)) ? path : null) : await nearestDir($, path)
  if (dir === null) return
  const deps = gitDeps($)
  const root = await toplevel(deps, dir)
  if (root === null) return
  // The session's own, not the call's: a subagent's worktree is followed too.
  const own = await sessionDirs(deps, await $.session.cwd())
  // Without git's word on the session's repository, any could pass the filter.
  if (own === undefined) return
  const followed = await read($, followedAtom)
  if (own !== null && sameDir(root, own.root)) {
    if (followed === null) return
    // `cd <main> && git worktree remove <wt>`: said here, as a refresh would have.
    if (await isGone($, deps, followed)) {
      await update($, followedAtom, () => null)
      if ((await read($, pinnedAtom)) === null) await update($, fallbackAtom, () => removedNotice(baseName(own.root)))
    } else {
      await setFollowed($, null)
    }
    schedule($)
    return
  }
  if (followed !== null && sameDir(root, followed)) return
  const dirs = await git(deps, root, DIRS_ARGS)
  if (dirs.exitCode !== 0 || !isFollowable(commonDirOf(dirs.stdout, root), own?.gitCommonDir ?? null)) return
  await setFollowed($, root)
  if (isLinked(dirs.stdout) && !isHeadless && config.autoOpen !== 'never' && (await read($, followOpensAtom))) {
    await update($, followOpensAtom, () => false)
    wantsAutoOpen = true
  }
  schedule($)
}

/**
 * The snapshot of the worktree the pane shows. A pinned or followed one that
 * is gone (removed, or no longer a worktree: git answers for another, as for
 * a directory left inside the main checkout) gives way to the next in line,
 * and `removed` says so; a git that only failed keeps it.
 */
const targetSnapshot = async (
  $: Dollar,
  deps: GitDeps,
  mode: DiffMode,
  previous: Snapshot | null,
): Promise<{ snapshot: Snapshot; removed: boolean }> => {
  let removed = false
  for (;;) {
    const { path, level } = await targetNow($)
    if (level === 'session' || (await isDir($, path))) {
      // A pinned or followed path is a worktree's root: a repository rooted elsewhere is not that worktree.
      const isOwn = (snapshot: Snapshot) => level === 'session' || !snapshot.isRepo || sameDir(snapshot.root, path)
      const dirs: RepoDirs | null =
        previous !== null && previous.cwd === path && previous.isRepo && previous.gitCommonDir !== '' && isOwn(previous)
          ? previous
          : await repoDirs(deps, path)
      const baseOverride = dirs === null ? null : await storedRef($, baseKey(dirs.root))
      const trunk = dirs === null || dirs.gitCommonDir === '' ? null : await storedRef($, trunkKey(dirs.gitCommonDir))
      const snapshot = await computeSnapshot(deps, { cwd: path, mode, baseOverride, trunk })
      if (isOwn(snapshot) && (level === 'session' || snapshot.isRepo || snapshot.error !== undefined)) {
        return { snapshot, removed }
      }
    }
    // A follow may have moved it meanwhile: only this one goes.
    const drop = (value: string | null) => (value === path ? null : value)
    if (level === 'pinned') await update($, pinnedAtom, drop)
    else await update($, followedAtom, drop)
    removed = true
  }
}

/** The `o` list's key for a choice; `auto` for none. */
const pickKey = (choice: WorktreeChoice | undefined): string =>
  choice === undefined ? 'pick:auto' : `pick:${oneLine(choice.path)}`

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
/** Whether session.start said no one watches: nothing would ever draw an open, so none is armed. */
let isHeadless = false
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
/** diffView side: the regions on screen, for the wheel; none while the `o` list or a notice stands in their place, and lost on a reload until the next drawing. */
let frame: Frame | undefined
/** diffView side: the regions as last drawn, kept while the `o` list covers them: where the ring goes and how far a key moves. */
let laid: Frame | undefined
/** diffView side: the wait before the cursor's file is read, so keys held down read only where they stop. */
let preview: Timer | undefined

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

/** Body columns the side view asks the dock for: the engine holds it to 45% of the terminal. */
const SIDE_COLUMNS = 120

// Every open sets the backdrop and the width anew; left out, the surface's own fill stands.
const paneArgs = (raise: boolean) => ({
  id: PANE,
  title: TITLE,
  ...(raise ? { focus: true as const } : {}),
  ...(config.paneBackground === 'transparent' ? { backgroundColor: 'transparent' } : {}),
  ...(config.diffView === 'side' ? { columns: SIDE_COLUMNS } : {}),
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
  const mode = await read($, modeAtom)
  const previous = await read($, snapshotAtom)
  const { snapshot, removed } = await targetSnapshot($, deps, mode, previous)

  if ((await read($, modeAtom)) !== mode) {
    // The mode moved while git ran: this result is the old mode's.
    rerun = true
    return snapshot
  }
  // Another worktree: a diff read in the last one is not this one's, even under the same path.
  // The session's cd within its worktree is the same one.
  if (previous !== null && (previous.root || previous.cwd) !== (snapshot.root || snapshot.cwd)) {
    await update($, diffsAtom, () => ({}))
    await putDiffOffset($, 0)
  }
  if (previous?.signature !== snapshot.signature) await update($, snapshotAtom, () => snapshot)
  if (removed) {
    const back = removedNotice(baseName(snapshot.root || snapshot.cwd))
    await update($, fallbackAtom, () => back)
  }
  // A failed read lists nothing: keep what is open until git answers again.
  if (snapshot.error === undefined || snapshot.files.length > 0) {
    if (config.diffView === 'side') {
      await pruneCollapsed($, snapshot)
      await syncSide($, deps, previous)
    } else {
      await syncDiffs($, deps, snapshot)
      await pruneCollapsed($, snapshot)
    }
  }
  if (config.statusLine) await showStatus($, snapshot)
  // Until a drawing says whether panes dock, the open stays pending.
  if (wantsAutoOpen && (isOpen || docksPanes !== undefined)) {
    // A follow while git ran: this is the last worktree's snapshot, and the next pass decides.
    if (!sameDir((await targetNow($)).path, snapshot.cwd)) {
      rerun = true
    } else {
      wantsAutoOpen = false
      if (!isOpen && docksPanes === true && shouldAutoOpen(snapshot)) background(openPane($))
    }
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
  if (config.diffView === 'side') await inTurn(() => settleCursor($))
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
  if (config.diffView === 'side') await settleCursor($)
}

/** Collapses every directory, nested ones too, or expands them all when the tree reads as all folded. */
const foldAll = async ($: Dollar) => {
  const snapshot = await read($, snapshotAtom)
  if (snapshot === null) return
  const tree = buildTree(snapshot.files)
  await update($, collapsedAtom, paths => (isAllFolded(tree, paths) ? [] : dirPaths(tree)))
  if (config.diffView === 'side') await inTurn(() => settleCursor($))
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
  const { path: cwd } = await targetNow($)
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
  const { path: cwd } = await targetNow($)
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
export const FOCUSED_SIDE = 'Changes pane focused — j/k move · w diff/tree · esc back · q close'
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

  return { ...listingOf(snapshot, view, collapsedDirs), snapshot, collapsedDirs }
}

/** A snapshot's rows in a view; `total` counts the `… N more files` line after them too. */
const listingOf = (snapshot: Snapshot | null, view: ViewMode, collapsedDirs: readonly string[]) => {
  const tree = view === 'tree' && snapshot?.isRepo === true ? buildTree(snapshot.files) : null
  const rows = listedRows(snapshot, tree, collapsedDirs).map(navRow)

  return { rows, total: rows.length + (rows.length > 0 && (snapshot?.omittedFiles ?? 0) > 0 ? 1 : 0) }
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
  const { rows } = await listingNow($)
  const key =
    config.diffView === 'side'
      ? sideRing(laid?.layout, await read($, regionAtom), keptCursor([], rows, await read($, cursorAtom)))
      : ringStart(rows.map(row => row.key))
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
  if (!isFocused) return UNFOCUSED

  return config.diffView === 'side' ? FOCUSED_SIDE : FOCUSED
}

/** The pane closed: the `o` list with it; closed by the person (q, the command, the close mark), never opened again for a follow. */
const noteClosed = async ($: Dollar, isPerson: boolean) => {
  if (isPerson && (await read($, followOpensAtom))) await update($, followOpensAtom, () => false)
  if ((await read($, pickerAtom)) !== null) await update($, pickerAtom, () => null)
}

const closePane = async ($: Dollar) => {
  if ((await paneState($)) === undefined) return 'Changes pane is not open.'
  await $.ui.close({ id: PANE })
  stopPolling()
  await noteClosed($, true)

  return 'Changes pane closed.'
}

/** `/wt-diff at <path>`: pins the worktree at `path`; no path follows Claude again. */
const pinAt = async ($: Dollar, raw: string): Promise<string> => {
  const arg = raw.replace(/^(['"])(.*)\1$/, '$2')
  if (arg === '') {
    await setPinned($, null)
    await refresh($, { force: true, isVisible: true })
    return 'Unpinned: following the worktree Claude works in.'
  }
  const path = resolvePath(arg, await $.session.cwd(), await homeDir($))
  if (path === null) return `Not a path: ${arg}`
  const root = (await isDir($, path)) ? await toplevel(gitDeps($), path) : null
  if (root === null) return `Not a git worktree: ${path}`
  await setPinned($, root)
  await refresh($, { force: true, isVisible: true })

  return `Showing ${baseName(root)} (pinned)`
}

/**
 * Opens the `o` list: auto, then every worktree of the session's repository
 * (the shown one's, with the session outside any), the cursor on the pin.
 */
const openPicker = async ($: Dollar) => {
  const deps = gitDeps($)
  const { path, session } = await targetNow($)
  const args = ['worktree', 'list', '--porcelain']
  let listed = await git(deps, session, args)
  if (listed.exitCode !== 0 && path !== session) listed = await git(deps, path, args)
  const choices: WorktreeChoice[] =
    listed.exitCode !== 0
      ? []
      : parseWorktreeListPorcelain(listed.stdout)
          .filter(entry => !entry.isBare && !entry.isPrunable)
          .map(entry => ({ path: entry.path, branch: entry.branch, head: (entry.head ?? '').slice(0, 7) }))
  const pinned = await read($, pinnedAtom)
  const at = pinned === null ? 0 : choices.findIndex(choice => sameDir(choice.path, pinned)) + 1
  await update($, pickerAtom, () => ({ at, choices }))
  await focusRow($, pickKey(choices[at - 1]))
}

/** The ring back where the keys act once the list is gone: the cursor's row, or the row it last held. */
const ringBack = async ($: Dollar) => {
  if ((await paneState($))?.isFocused !== true) return
  const { rows } = await listingNow($)
  const key =
    config.diffView === 'side'
      ? sideRing(laid?.layout, await read($, regionAtom), keptCursor([], rows, await read($, cursorAtom)))
      : ringStart(rows.map(row => row.key))
  if (key !== undefined) await focusRow($, key)
}

const closePicker = async ($: Dollar) => {
  await update($, pickerAtom, () => null)
  await ringBack($)
}

/** A choice in the list: auto (null) follows Claude again, a worktree pins it. The next key waits for the list to close, not for git. */
const choose = async ($: Dollar, path: string | null) => {
  await update($, pickerAtom, () => null)
  if ((await read($, pinnedAtom)) !== path) {
    await setPinned($, path)
    background(refresh($, { force: true, isVisible: true }))
  }
  await ringBack($)
}

/** A key while the list shows: j/k move, l picks, h and o go back, q closes the pane. */
const pressPicker = async ($: Dollar, picker: WorktreePicker, key: PickKey) => {
  if (key === 'q') {
    await closePane($)
    return
  }
  if (key === 'o' || key === 'h') {
    await closePicker($)
    return
  }
  if (key === 'l') {
    await choose($, picker.choices[picker.at - 1]?.path ?? null)
    return
  }
  const at = Math.max(0, Math.min(picker.choices.length, picker.at + (key === 'j' ? 1 : -1)))
  if (at === picker.at) return
  await update($, pickerAtom, now => (now === null ? null : { ...now, at }))
  await focusRow($, pickKey(picker.choices[at - 1]))
}

const isPickKey = (key: string): key is PickKey => PICK_KEYS.some(one => one.hotkey === key)

/**
 * The keys' one Button each, by mode: while the list shows, its own; `o`
 * opens it. True when the press was the list's.
 */
const pressedPicker = async ($: Dollar, key: string): Promise<boolean> => {
  const picker = await read($, pickerAtom)
  if (picker !== null) {
    if (isPickKey(key)) await pressPicker($, picker, key)
    return true
  }
  if (key !== 'o') return false
  await openPicker($)
  return true
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
  key: Exclude<NavKey, 'q' | 'o'>,
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

/** A key Button's press: the list's while it shows, o opens it, q closes the pane; the rest do what navAction says. */
const pressNav = async ($: Dollar, key: NavKey) => {
  if ((await pressedPicker($, key)) || key === 'o') return
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

// -------------------------------------------------------------- side view

/** diffView side: the cursor, the region the keys act on, and where each region's window starts. */
export type SideState = { cursor: string | null; region: Region; diffOffset: number; treeOffset: number }

/** The regions as last drawn: their layout, the body's rows as split, and the rows of the tree and of the diff each window shows. */
export type Frame = { layout: PaneLayout; budget: RowBudget; treeRows: number; diffRows: number }

/** With one region shown and that the diff, the cursor's row is not drawn: the ring waits on h's Button, which goes back. */
const SINGLE_DIFF_RING = 'nav:h'

/** Where the side view's ring sits: on the cursor's row, or on h's Button while the diff alone shows. */
export const sideRing = (layout: PaneLayout | undefined, region: Region, cursor: string | null): string | undefined =>
  region === 'diff' && layout?.kind === 'single' ? SINGLE_DIFF_RING : (cursor ?? undefined)

/** How far a key moves before the pane is first drawn after a reload. */
const FALLBACK_ROWS = 10
/** The cursor stands this long before its file is read. */
const PREVIEW_MS = 120
/** Diffs kept for files the cursor left, so going back shows them at once. */
const PREVIEW_KEEP = 16

// Each writes only a value that differs: a write draws the pane again.
const putCursor = async ($: Dollar, value: string) => {
  if ((await read($, cursorAtom)) !== value) await update($, cursorAtom, () => value)
}
const putRegion = async ($: Dollar, value: Region) => {
  if ((await read($, regionAtom)) !== value) await update($, regionAtom, () => value)
}
const putDiffOffset = async ($: Dollar, value: number) => {
  if ((await read($, diffOffsetAtom)) !== value) await update($, diffOffsetAtom, () => value)
}
const putTreeOffset = async ($: Dollar, value: number) => {
  if ((await read($, treeOffsetAtom)) !== value) await update($, treeOffsetAtom, () => value)
}

/**
 * Where the cursor goes on the rows listed now (`after`): it stays on its
 * row; one gone from what was listed (`before`) gives way to the nearest row
 * left, below it first; one a fold hides, to the directory that hides it;
 * otherwise the first row. Unchanged when nothing is listed.
 */
export const keptCursor = (
  before: readonly NavRow[],
  after: readonly NavRow[],
  cursor: string | null,
): string | null => {
  const first = after[0]
  if (first === undefined) return cursor
  if (cursor === null) return first.key
  const listed = new Set(after.map(row => row.key))
  if (listed.has(cursor)) return cursor
  const at = before.findIndex(row => row.key === cursor)
  if (at >= 0) {
    const near = before.slice(at + 1).find(row => listed.has(row.key)) ?? before.slice(0, at).reverse().find(row => listed.has(row.key))
    if (near !== undefined) return near.key
  }
  const path = cursor.slice(cursor.indexOf(':') + 1)
  let holder: NavRow | undefined
  for (const row of after) {
    if (row.kind === 'dir' && path.startsWith(`${row.path}/`) && row.path.length > (holder?.path.length ?? -1)) holder = row
  }

  return (holder ?? first).key
}

/** The index of the row the cursor shows on, as keptCursor places it; -1 with no rows. */
const cursorAt = (rows: readonly NavRow[], cursor: string | null): number => {
  const key = keptCursor([], rows, cursor)

  return rows.findIndex(row => row.key === key)
}

/** What the diff region shows for the cursor's row: rows a window slides over. */
export type SideBody =
  | { kind: 'none' }
  | { kind: 'note'; text: string; isError: boolean }
  | { kind: 'dir'; path: string; files: FileChange[] }
  | { kind: 'source'; path: string; lines: string[]; more: string | null }
  | { kind: 'lines'; path: string; diff: NumberedDiff; more: string | null }

const moreLines = (diff: FileDiff): string | null =>
  diff.omittedLines > 0 ? `… ${diff.omittedLines} more lines — open in editor` : null

/**
 * The body for `row`: a directory's files, a deleted file in a line, a file
 * added whole as source, any other as numbered diff lines; a note while its
 * diff is on its way, failed, binary or empty.
 */
export const sideBody = (snapshot: Snapshot | null, row: NavRow | undefined, diff: FileDiff | undefined): SideBody => {
  if (snapshot === null || row === undefined) return { kind: 'none' }
  if (row.kind === 'dir') {
    return { kind: 'dir', path: row.path, files: snapshot.files.filter(file => file.path.startsWith(`${row.path}/`)) }
  }
  const file = snapshot.files.find(one => one.path === row.path)
  if (file === undefined) return { kind: 'none' }
  const note = (text: string, isError = false): SideBody => ({ kind: 'note', text, isError })
  if (!needsDiff(file)) return note(`deleted · ${file.removed} ${file.removed === 1 ? 'line' : 'lines'}`, true)
  if (diff === undefined) return note('loading…')
  if (diff.error !== undefined) return note(oneLine(diff.error), true)
  if (diff.isBinary) return note('Binary file')
  if (diff.hunks === '') return note('No textual changes')
  const added = addedSource(diff.hunks)
  if (added !== null) return { kind: 'source', path: file.path, lines: added.split('\n'), more: moreLines(diff) }

  return { kind: 'lines', path: file.path, diff: numberHunks(diff.hunks), more: moreLines(diff) }
}

/** A body's rows, a hunk header and the `… more lines` line each one, and the row each hunk starts on. */
export const bodyRows = (body: SideBody): { total: number; hunkStarts: readonly number[] } => {
  switch (body.kind) {
    case 'none':
      return { total: 0, hunkStarts: [] }
    case 'note':
      return { total: 1, hunkStarts: [] }
    case 'dir':
      return { total: body.files.length, hunkStarts: [] }
    case 'source':
      return { total: body.lines.length + (body.more !== null ? 1 : 0), hunkStarts: [] }
    case 'lines':
      return { total: body.diff.lines.length + (body.more !== null ? 1 : 0), hunkStarts: body.diff.hunkStarts }
  }
}

/** The listing now, the row the cursor shows on and what the diff region shows for it. */
const sideNow = async ($: Dollar) => {
  const [listing, cursor, diffs] = await Promise.all([listingNow($), read($, cursorAtom), read($, diffsAtom)])
  const at = cursorAt(listing.rows, cursor)
  const row = listing.rows[at]
  const body = sideBody(listing.snapshot, row, row?.kind === 'file' ? diffs[row.path] : undefined)

  return { ...listing, cursor, at, row, body }
}

/** Keeps the diffs of the last files the cursor was on; `path`, just read, among them. */
export const keepRecent = (diffs: Readonly<Record<string, FileDiff>>, path: string): Record<string, FileDiff> => {
  const others = Object.keys(diffs).filter(key => key !== path)
  const out: Record<string, FileDiff> = {}
  for (const key of others.slice(Math.max(0, others.length - (PREVIEW_KEEP - 1)))) out[key] = diffs[key] as FileDiff
  if (diffs[path] !== undefined) out[path] = diffs[path]

  return out
}

/**
 * Reads the diff of the file the cursor is on into the pane. One kept shows
 * meanwhile, but is read again all the same: its snapshot's signature counts
 * lines, so an edit that keeps them leaves it equal.
 */
const loadPreview = async ($: Dollar, deps: GitDeps = gitDeps($)) => {
  const { snapshot, row } = await sideNow($)
  const file = row?.kind === 'file' ? snapshot?.files.find(one => one.path === row.path) : undefined
  if (!snapshot || !file || !needsDiff(file)) return
  const diff = await loadFileDiff(deps, snapshot, file)
  // A pass read a newer snapshot meanwhile: its own read follows.
  if ((await read($, snapshotAtom))?.signature !== snapshot.signature) return
  const now = (await read($, diffsAtom))[file.path]
  if (now !== undefined && sameDiff(now, diff) && now.signature === diff.signature) return
  await update($, diffsAtom, diffs => keepRecent({ ...without(diffs, file.path), [file.path]: diff }, file.path))
}

/** Reads the cursor's file once it stands still: keys held down read only where they stop. */
const previewSoon = ($: Dollar) => {
  preview?.cancel()
  preview = $.clock.after(PREVIEW_MS, () => {
    preview = undefined
    background(loadPreview($))
  })
}

/**
 * Keeps the cursor on a listed row (keptCursor, `before` what a refresh's
 * last pass listed) and the tree's window on it; a cursor that moved starts
 * its diff at the top, has it read and takes the ring along. After a refresh
 * the cursor that stayed keeps its place on screen, or out of view where a
 * wheel took it. Runs in a key's turn (inTurn): a press in flight would move
 * the cursor under it.
 */
const settleCursor = async ($: Dollar, before?: { rows: readonly NavRow[]; total: number }) => {
  const { rows, total } = await listingNow($)
  const cursor = await read($, cursorAtom)
  const key = keptCursor(before?.rows ?? [], rows, cursor)
  if (key === null || rows.length === 0) return
  if (key !== cursor) {
    await putCursor($, key)
    await putDiffOffset($, 0)
    previewSoon($)
  }
  const at = rows.findIndex(row => row.key === key)
  const offset = await read($, treeOffsetAtom)
  const height = laid?.treeRows ?? FALLBACK_ROWS
  const was = before !== undefined && key === cursor ? before.rows.findIndex(row => row.key === key) : -1
  await putTreeOffset($, refreshedTreeWindow(offset, was, before?.total ?? 0, at, total, height))
  // The ring's row is gone or hidden: left alone, the engine puts it elsewhere and Enter presses that.
  // While the `o` list shows the ring is on it, and the rows are not drawn.
  if (
    key !== cursor &&
    sideRing(laid?.layout, await read($, regionAtom), key) === key &&
    (await read($, pickerAtom)) === null
  ) {
    await focusRow($, key)
  }
}

/**
 * After a pass: the cursor on a row still listed, diffs read under another
 * snapshot dropped but the cursor's, and the cursor's file read again; under
 * another mode or base its diff starts at the top.
 */
/** Whether two snapshots diff against different things: another mode or base. */
const comparesOther = (one: Snapshot, other: Snapshot): boolean => one.mode !== other.mode || one.base?.ref !== other.base?.ref

const syncSide = async ($: Dollar, deps: GitDeps, previous: Snapshot | null) => {
  await inTurn(async () => {
    const [view, collapsedDirs, now] = await Promise.all([read($, viewAtom), read($, collapsedAtom), read($, snapshotAtom)])
    await settleCursor($, listingOf(previous, view, collapsedDirs))
    if (previous !== null && now !== null && comparesOther(previous, now)) await putDiffOffset($, 0)
  })
  const { snapshot, row } = await sideNow($)
  if (snapshot === null) return
  const isKept = (path: string, diff: FileDiff) =>
    diff.signature === snapshot.signature || (row?.kind === 'file' && row.path === path)
  if (Object.entries(await read($, diffsAtom)).some(([path, diff]) => !isKept(path, diff))) {
    await update($, diffsAtom, diffs => Object.fromEntries(Object.entries(diffs).filter(([path, diff]) => isKept(path, diff))))
  }
  await loadPreview($, deps)
}

/** Puts the cursor on the row keyed `key`, in the tree's window; `isRing`: the focus ring goes with it. */
const cursorTo = async ($: Dollar, rows: readonly NavRow[], total: number, key: string, isRing: boolean) => {
  const at = rows.findIndex(row => row.key === key)
  if (at < 0) return
  if ((await read($, cursorAtom)) !== key) {
    await putCursor($, key)
    await putDiffOffset($, 0)
    previewSoon($)
  }
  const offset = await read($, treeOffsetAtom)
  await putTreeOffset($, treeWindow(offset, at, total, laid?.treeRows ?? FALLBACK_ROWS))
  if (isRing) await focusRow($, key)
}

/** The keys act on the diff; with the diff alone shown, the ring waits on h's Button. */
const toDiff = async ($: Dollar) => {
  await putRegion($, 'diff')
  const ring = sideRing(laid?.layout, 'diff', null)
  if (ring !== undefined) await focusRow($, ring)
}

/** The keys act on the tree again, the ring on the cursor's row. */
const toTree = async ($: Dollar, row: NavRow | undefined) => {
  await putRegion($, 'tree')
  if (row !== undefined) await focusRow($, row.key)
}

const CURSOR_MOVES: Partial<Record<SideKey, CursorMove>> = {
  j: 'down',
  k: 'up',
  d: 'pageDown',
  b: 'pageUp',
  g: 'top',
  e: 'bottom',
}
const DIFF_MOVES: Partial<Record<SideKey, DiffMove>> = {
  j: 'down',
  k: 'up',
  d: 'pageDown',
  b: 'pageUp',
  n: 'nextHunk',
  p: 'prevHunk',
  g: 'top',
  e: 'bottom',
}

/**
 * A key Button's press in the side view, by the region the keys are in. In
 * the tree j/k/d/b/g/e move the cursor, w and l on a file go to the diff, h
 * and l on a directory fold, open and go in or up as v0.3's do. In the diff
 * the same letters scroll it, n/p by hunk, h and w go back to the tree.
 */
const pressSide = async ($: Dollar, key: SideKey) => {
  if (await pressedPicker($, key)) return
  if (key === 'q') {
    await closePane($)
    return
  }
  const [now, region] = await Promise.all([sideNow($), read($, regionAtom)])
  if (region === 'diff') {
    const move = DIFF_MOVES[key]
    if (move !== undefined) {
      const { total, hunkStarts } = bodyRows(now.body)
      const rows = laid?.diffRows ?? FALLBACK_ROWS
      await putDiffOffset($, moveDiff(await read($, diffOffsetAtom), move, { total, rows, hunkStarts }))
    } else if (key === 'h' || key === 'w') await toTree($, now.row)
    return
  }
  const move = CURSOR_MOVES[key]
  if (move !== undefined) {
    const to = now.rows[moveCursor(now.at, move, now.rows.length, laid?.treeRows ?? FALLBACK_ROWS)]
    if (to !== undefined) await cursorTo($, now.rows, now.total, to.key, true)
    return
  }
  const { row } = now
  if (key === 'w' || (key === 'l' && row?.kind === 'file')) {
    await toDiff($)
    return
  }
  if (row === undefined || (key !== 'l' && key !== 'h')) return
  const action = navAction(now.rows, row.key, key, one => one.kind === 'dir' && !now.collapsedDirs.includes(one.path))
  if (action === null) return
  if ('focus' in action) await cursorTo($, now.rows, now.total, action.focus, true)
  else if ('dir' in action) await toggleDir($, action.dir)
}

/**
 * A row pressed in the side view, by a click or Enter on the ring: the cursor
 * moves there and the keys act on the tree. Pressed where the cursor already
 * is, a file goes to the diff and a directory folds or opens.
 */
const pressRow = async ($: Dollar, key: string) => {
  const [now, region] = await Promise.all([sideNow($), read($, regionAtom)])
  const row = now.rows.find(one => one.key === key)
  if (row === undefined) return
  if (region === 'tree' && now.row?.key === key) {
    if (row.kind === 'file') await toDiff($)
    else await toggleDir($, row.path)
    return
  }
  await putRegion($, 'tree')
  await cursorTo($, now.rows, now.total, key, false)
}

/** A wheel tick over the regions: the one under the pointer moves its window; the cursor stays. */
const wheel = async ($: Dollar, pointer: { column: number; row: number }, by: number) => {
  const drawn = frame
  if (drawn === undefined) return
  const where = wheelRegion(drawn.layout, drawn.budget, pointer, await read($, regionAtom))
  if (where === null) return
  if (where === 'tree') {
    const { total } = await listingNow($)
    await putTreeOffset($, scrollBy(await read($, treeOffsetAtom), by, total, drawn.treeRows))
    return
  }
  const { total } = bodyRows((await sideNow($)).body)
  await putDiffOffset($, scrollBy(await read($, diffOffsetAtom), by, total, drawn.diffRows))
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
      if (!snapshot) return 'Could not read git.'
      // Says which worktree when it is not the session's own.
      const [pinned, followed] = await Promise.all([read($, pinnedAtom), read($, followedAtom)])
      const kind = snapshot.cwd === pinned ? 'pinned' : snapshot.cwd === followed ? 'auto' : null
      return `${kind === null ? '' : `⌂ ${snapshot.cwd} · ${kind}\n`}${summaryText(snapshot)}`
    }
    case 'at':
      // A path may hold blanks: the rest of the line as typed.
      return pinAt($, args.trim().slice(sub.length).trim())
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

/** The side view's state, read while drawing: the pane draws again as it changes. */
const readSide = async ($: Dollar): Promise<SideState> => {
  const [cursor, region, diffOffset, treeOffset] = await Promise.all([
    read($, cursorAtom),
    read($, regionAtom),
    read($, diffOffsetAtom),
    read($, treeOffsetAtom),
  ])

  return { cursor, region, diffOffset, treeOffset }
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
    isHeadless = !e.isInteractive
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

  // Main loop and subagents alike: a call that ran says where Claude works.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isMove = MOVE_TOOLS.has(tool)
    // Read in the hook: the call's own directory (a subagent's), as it started.
    const before = TRIGGER_TOOLS.has(tool) ? await $.session.cwd() : ''
    const ran = await next(e)
    try {
      if (TRIGGER_TOOLS.has(tool)) {
        // Only what happened: a denied or failed call moves nothing and leaves a closed pane closed.
        const isDone = ran.deny === undefined && ran.isError !== true
        if (isDone && isMove) {
          if ((await $.session.cwd()) !== before) {
            if (tool === 'EnterWorktree' && !isHeadless && config.autoOpen !== 'never') wantsAutoOpen = true
            background(inFollow(() => setFollowed($, null)))
          }
        } else if (!isMove && (isDone || (tool === 'Bash' && hasRun(ran)))) {
          // A failed Bash still ran its leading cd (`cd wt && npm test` with a test failing),
          // when the directory is there. git runs after the result is handed back.
          background(inFollow(() => follow($, tool, e, before, !isDone)))
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
    if (e.id === PANE) {
      stopPolling()
      background(noteClosed($, e.origin?.kind === 'person'))
    }

    return closed
  }).catch(($, e, next) => next(e))

  // Watched, never moved: where the ring is, for j/k and for where it starts next time.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny === undefined) noteFocus(e.plugin === PLUGIN ? e.element : undefined)

    return moved
  }).catch(($, e, next) => next(e))

  // The side view draws its own windows into a pane that never overflows: a
  // wheel over the regions moves the one under the pointer, not the body. The
  // engine raises it at the body's edges too (d.ts), so with nothing for it to
  // scroll as well. Its own scroll keys, a plugin's move, a wheel over the top
  // or the hint, and any over a body too short to fit go on as they were.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const { pointer } = e
    const drawn = frame
    if (
      config.diffView !== 'side' ||
      e.origin.kind !== 'person' ||
      pointer === undefined ||
      drawn === undefined ||
      wheelRegion(drawn.layout, drawn.budget, pointer, 'tree') === null
    ) {
      return next(e)
    }
    await inTurn(() => wheel($, pointer, e.by))

    return {}
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
    const isSide = config.diffView === 'side'
    const [snapshot, mode, expanded, diffs, isRefreshing, view, collapsedDirs, side, pinned, followed, fallback, picker] =
      await Promise.all([
        read($, snapshotAtom),
        read($, modeAtom),
        read($, expandedAtom),
        read($, diffsAtom),
        read($, refreshingAtom),
        read($, viewAtom),
        read($, collapsedAtom),
        isSide ? readSide($) : undefined,
        read($, pinnedAtom),
        read($, followedAtom),
        read($, fallbackAtom),
        read($, pickerAtom),
      ])
    const tree = view === 'tree' && snapshot?.isRepo === true ? buildTree(snapshot.files) : null
    const rows = listedRows(snapshot, tree, collapsedDirs)
    const columns = Math.max(16, e.props.bodyColumns)
    // The ring starts on the list's cursor while it shows; the side view's on the cursor's row, or on h's while the diff alone shows.
    const autoFocus =
      picker !== null
        ? pickKey(picker.choices[picker.at - 1])
        : side === undefined
          ? ringStart(rows.map(row => navRow(row).key))
          : sideRing(paneLayout(columns), side.region, keptCursor([], rows.map(navRow), side.cursor))
    const place = pinned ?? followed
    let drawn: Frame | undefined

    const pane = drawPane(ui, {
      snapshot,
      tree,
      rows,
      autoFocus,
      place: place === null ? null : { name: baseName(place), kind: pinned !== null ? 'pinned' : 'auto' },
      fallback,
      picker: picker === null ? null : { ...picker, pinned, shown: snapshot?.isRepo === true ? snapshot.root : null },
      isFocused: e.props.isFocused,
      bodyRows: e.props.scroll.bodyRows,
      mode,
      // Files opened in the inline view stay closed here: nothing for x to collapse.
      expanded: side === undefined ? expanded : [],
      diffs,
      isRefreshing,
      view,
      collapsedDirs,
      columns,
      surface: e.surface,
      diffStyle: config.diffStyle,
      side,
      onMode: picked => background(setMode($, picked)),
      onRefresh: () => background(refresh($, { force: true, isVisible: true })),
      onCollapse: () => background(collapseAll($)),
      onToggle: path => background(toggleFile($, path)),
      onView: () => background(toggleView($)),
      onDir: path => background(toggleDir($, path)),
      onFold: () => background(foldAll($)),
      onNav: key => background(inTurn(() => pressNav($, key))),
      onSide: key => background(inTurn(() => pressSide($, key))),
      onRow: key => background(inTurn(() => pressRow($, key))),
      onPick: path => background(inTurn(() => choose($, path))),
      onFrame: regions => {
        drawn = regions
      },
    })
    // A drawing without the regions (reading git, a notice, the `o` list) leaves none for the wheel to move.
    if (isSide) frame = drawn
    if (drawn !== undefined) laid = drawn

    return pane
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
  /** The worktree shown when not the session's own: its name, and whether pinned or followed. */
  place: { name: string; kind: 'auto' | 'pinned' } | null
  /** `worktree removed — back to <name>`, in the place line's stead. */
  fallback: string | null
  /** The `o` list while it shows, with the pin it ticks and the worktree on show it dots. */
  picker: (WorktreePicker & { pinned: string | null; shown: string | null }) | null
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
  /** diffView side: the cursor and the regions' windows; absent, the inline view. */
  side?: SideState
  onMode: (mode: DiffMode) => void
  onRefresh: () => void
  onCollapse: () => void
  onToggle: (path: string) => void
  onView: () => void
  onDir: (path: string) => void
  onFold: () => void
  onNav: (key: NavKey) => void
  onSide: (key: SideKey) => void
  /** A row pressed in the side view, by its key. */
  onRow: (key: string) => void
  /** A row of the `o` list pressed: a worktree's path, or null for auto. */
  onPick: (path: string | null) => void
  /** Told the regions' geometry as drawn, for the keys and the wheel. */
  onFrame: (frame: Frame) => void
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

/** The inline view's keys: the `o` list's while it shows. */
const navKeys = (model: PaneModel): readonly { hotkey: NavKey; label: string }[] =>
  model.picker !== null ? PICK_KEYS : NAV_KEYS

/** Rows drawKeys takes, its margin included; 0 where it draws nothing. */
const keysRows = (model: PaneModel): number => {
  if (model.isFocused) {
    const widths = [...navKeys(model).map(({ hotkey, label }) => plainCells(hotkey, label)), ESC_HINT.length]
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
  if (model.side !== undefined && model.isFocused) {
    return <Box marginTop={1}>{drawSideKeys(ui, model, model.side, false)}</Box>
  }
  if (model.isFocused) {
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={isTop ? 0 : 1} marginBottom={isTop ? 1 : 0}>
        {navKeys(model).map(({ hotkey, label }) => (
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
 * One dim row above the branch while the pane shows another worktree than
 * the session's: `⌂ <name> · auto` (followed) or `· pinned`; in its stead,
 * once one was removed, where the pane went back to.
 */
const drawPlace = (ui: Ui, model: PaneModel): RenderElement | null => {
  const { Text } = ui
  if (model.fallback !== null) {
    return (
      <Text color="warning" wrap="truncate-end">
        {clip(oneLine(model.fallback), model.columns)}
      </Text>
    )
  }
  if (model.place === null) return null
  const tail = ` · ${model.place.kind}`
  const name = fitPath(oneLine(model.place.name), Math.max(1, model.columns - 2 - tail.length))

  return <Text dimColor wrap="truncate-end">{`⌂ ${name}${tail}`}</Text>
}

/**
 * Two rows, three under the place line: the branch with ↑↓ at the right
 * edge, then what it is compared against with where that came from. Each
 * part is cut to fit beforehand, so the right side keeps its place.
 */
const drawHeader = (ui: Ui, model: PaneModel, snapshot: Snapshot): RenderElement[] => {
  const { Box, Text } = ui
  const { columns } = model
  const place = drawPlace(ui, model)
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
    ...(place !== null ? [place] : []),
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

/** The side view's cursor mark at the start of a row, and whether the row is the cursor's. */
type RowMark = { mark: RenderElement; isCursor: boolean }

const drawRow = (
  ui: Ui,
  model: PaneModel,
  file: FileChange,
  place?: Place,
  marked?: RowMark,
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
    model.expanded.includes(file.path) || marked?.isCursor === true ? (
      <Text weight="semibold">{name.slice(slash)}</Text>
    ) : (
      name.slice(slash)
    ),
  )

  const key = `file:${file.path}`
  const row = drawLine(
    ui,
    key,
    [
      ...(marked !== undefined ? [marked.mark] : []),
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

const drawDirRow = (
  ui: Ui,
  model: PaneModel,
  dir: TreeDir,
  depth: number,
  isCollapsed: boolean,
  marked?: RowMark,
): RenderElement => {
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
  const left: RenderElement[] = marked !== undefined ? [marked.mark] : []
  if (indent !== '') left.push(<Text>{indent}</Text>)
  const name = `${fitPath(oneLine(dir.name), room)}/`
  left.push(
    <Button key={key} plain onPress={() => model.onDir(dir.path)} {...autoFocusOn(model, key)}>
      <Text dimColor>{isCollapsed ? '▸ ' : '▾ '}</Text>
      {marked?.isCursor === true ? <Text weight="semibold">{name}</Text> : name}
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

/** Cells before a list row's name: the cursor's mark, then the pin's tick or the shown worktree's dot. */
const PICK_LEAD = 4

/**
 * The `o` list's rows `from` on, at most `count`, in `cells`: auto, then each
 * worktree's directory name, branch (or short sha) and path, dim, the path
 * giving way first. The cursor's row is marked, the pin ticked (auto when
 * none), the worktree on show dotted when not ticked; each name a Button, a
 * press picks it.
 */
const drawPickRows = (
  ui: Ui,
  model: PaneModel,
  picker: NonNullable<PaneModel['picker']>,
  cells: number,
  from: number,
  count: number,
): RenderElement[] => {
  const { Box, Button, Text } = ui
  const out: RenderElement[] = []
  for (let index = from; index < Math.min(picker.choices.length + 1, from + count); index++) {
    const choice = picker.choices[index - 1]
    const key = pickKey(choice)
    const isCursor = index === picker.at
    const isPinned = choice === undefined ? picker.pinned === null : picker.pinned !== null && sameDir(choice.path, picker.pinned)
    const isShown = choice !== undefined && picker.shown !== null && sameDir(choice.path, picker.shown)
    const room = Math.max(1, cells - PICK_LEAD)
    const name = fitPath(oneLine(choice === undefined ? 'auto' : baseName(choice.path)), room)
    const detail = oneLine(choice === undefined ? 'follow Claude' : (choice.branch ?? choice.head))
    let left = room - cellWidth(name)
    const branch = left >= 2 + NAME_MIN ? `  ${fitPath(detail, left - 2)}` : ''
    left -= cellWidth(branch)
    const path = choice !== undefined && left >= 2 + NAME_MIN * 2 ? `  ${fitPath(oneLine(choice.path), left - 2)}` : ''
    out.push(
      <Box key={`row:${key}`} flexDirection="row">
        {isCursor ? <Text color="suggestion">{'› '}</Text> : <Text>{'  '}</Text>}
        {isPinned ? (
          <Text color="success">{'✓ '}</Text>
        ) : isShown ? (
          <Text dimColor>{'• '}</Text>
        ) : (
          <Text>{'  '}</Text>
        )}
        <Button key={key} plain onPress={() => model.onPick(choice?.path ?? null)} {...autoFocusOn(model, key)}>
          {isCursor ? <Text weight="semibold">{name}</Text> : name}
        </Button>
        {branch !== '' ? <Text dimColor={choice === undefined}>{branch}</Text> : null}
        {path !== '' ? <Text dimColor>{path}</Text> : null}
      </Box>,
    )
  }

  return out
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

  // The `o` list under a screen with no listing, so its keys never act on rows unseen.
  const picked = model.picker === null ? null : drawPickRows(ui, model, model.picker, model.columns, 0, Infinity)
  const pickedBlock = picked === null ? null : <Box flexDirection="column" marginTop={1}>{picked}</Box>

  if (snapshot === null) {
    return (
      <Box flexDirection="column">
        {drawPlace(ui, model)}
        <Text dimColor>Reading git…</Text>
        {pickedBlock}
        {drawKeys(ui, model, false)}
      </Box>
    )
  }
  if (!snapshot.isRepo) {
    return (
      <Box flexDirection="column">
        {drawPlace(ui, model)}
        {snapshot.error ? (
          <Text color="error">{`Error: ${oneLine(snapshot.error)}`}</Text>
        ) : (
          <Text>Not a git repository</Text>
        )}
        <Text dimColor wrap="truncate-middle">
          {oneLine(snapshot.cwd)}
        </Text>
        {pickedBlock}
        {drawKeys(ui, model, false)}
      </Box>
    )
  }

  if (model.side !== undefined) return drawSide(ui, model, model.side, snapshot)

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

  // The `o` list in the listing's place.
  if (picked !== null && pickedBlock !== null) {
    body.push(pickedBlock)
    height += picked.length + 1
    return finish()
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

// ------------------------------------------------------- side view drawing

/** The side view's cursor mark and the space it leaves on every other row. */
const MARK_CELLS = 2
const SEPARATOR = '│'
/** The blank cell between the rule and each region's rows. */
const RULE_GAP = 1
const REGION_LABEL: Record<Region, string> = { tree: ' tree ', diff: ' diff ' }

/** Rows the hint row takes: the keys while the pane holds the keyboard, else on the terminal how to give it. */
const sideHintRows = (model: PaneModel): number => (model.isFocused || model.surface === 'terminal' ? 1 : 0)

/**
 * The region's keys as Buttons, dim, in the order SIDE_KEYS gives; `isClipped`:
 * one row, the ones past its end cut off but still pressed by their letters.
 */
const drawSideKeys = (ui: Ui, model: PaneModel, side: SideState, isClipped: boolean): RenderElement => {
  const { Box, Button } = ui
  const clip = isClipped ? { height: 1, overflow: 'hidden' as const } : {}
  const keys: readonly { hotkey: SideKey; label: string }[] = model.picker !== null ? PICK_KEYS : SIDE_KEYS[side.region]

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} {...clip}>
      {keys.map(({ hotkey, label }) => (
        <Button
          key={`nav:${hotkey}`}
          label={label}
          hotkey={hotkey}
          plain
          dimColor
          onPress={() => model.onSide(hotkey)}
          {...autoFocusOn(model, `nav:${hotkey}`)}
        />
      ))}
    </Box>
  )
}

/** A region's head: accented while the keys act on it, dim otherwise. */
const drawRegionHead = (ui: Ui, region: Region, side: SideState): RenderElement => {
  const { Text } = ui

  return side.region === region ? (
    <Text color="suggestion" weight="semibold">
      {REGION_LABEL[region]}
    </Text>
  ) : (
    <Text dimColor>{REGION_LABEL[region]}</Text>
  )
}

/** Counts of files that are not binary, summed. */
const sumCounts = (files: readonly FileChange[]): Counts => {
  let added = 0
  let removed = 0
  for (const file of files) {
    if (file.isBinary) continue
    added += file.added
    removed += file.removed
  }
  const counts: Counts = {}
  if (added > 0) counts.added = `+${added}`
  if (removed > 0) counts.removed = `${MINUS}${removed}`

  return counts
}

/**
 * What the diff region shows, in `cells` after its head: a file's status and
 * path, a directory's path and how many files, the counts at the right edge.
 */
const drawDiffTitle = (ui: Ui, snapshot: Snapshot, body: SideBody, row: NavRow | undefined, cells: number): RenderElement[] => {
  const { Text } = ui
  if (row === undefined || cells < 1 + NAME_MIN) return []
  if (body.kind === 'dir') {
    const counts = sumCounts(body.files)
    const tail = countsWidth(counts) > 0 ? countsWidth(counts) + 1 : 0
    const hasCounts = tail > 0 && cells - 2 - tail >= NAME_MIN
    const room = cells - 2 - (hasCounts ? tail : 0)
    // How many files gives way before the name does.
    const many = ` · ${body.files.length} ${body.files.length === 1 ? 'file' : 'files'}`
    const hasMany = room - many.length >= NAME_MIN
    const left = (
      <Text wrap="truncate-end">
        {' '}
        <Text weight="semibold">{`${fitPath(oneLine(row.path), Math.max(1, hasMany ? room - many.length : room))}/`}</Text>
        {hasMany ? <Text dimColor>{many}</Text> : null}
      </Text>
    )
    return hasCounts ? [left, drawCounts(ui, counts)] : [left]
  }
  const file = snapshot.files.find(one => one.path === row.path)
  if (file === undefined) return []
  const counts = countParts(file)
  const tail = countsWidth(counts) > 0 ? countsWidth(counts) + 1 : 0
  const hasCounts = tail > 0 && cells - 3 - tail >= NAME_MIN
  const room = Math.max(1, cells - 3 - (hasCounts ? tail : 0))
  const color = STATUS_COLOR[file.status]
  const left = (
    <Text wrap="truncate-end">
      {' '}
      {color !== undefined ? <Text color={color}>{file.status}</Text> : <Text dimColor>{file.status}</Text>}{' '}
      <Text weight="semibold">{fitPath(oneLine(file.path), room)}</Text>
    </Text>
  )

  return hasCounts ? [left, drawCounts(ui, counts)] : [left]
}

/** One row of a region: what it is at the left, the rest pushed to the right edge. */
const spread = (ui: Ui, parts: readonly RenderElement[]): RenderElement => {
  const { Box } = ui
  const [left, ...right] = parts

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">{left}</Box>
      {right}
    </Box>
  )
}

/** The listing's rows the tree's window shows, the cursor's marked; `… N more files` after the last. */
const drawTreeRegion = (
  ui: Ui,
  model: PaneModel,
  side: SideState,
  at: number,
  cells: number,
  rows: number,
): RenderElement[] => {
  const { Text } = ui
  const omitted = model.snapshot?.omittedFiles ?? 0
  const total = model.rows.length + (model.rows.length > 0 && omitted > 0 ? 1 : 0)
  const from = clampOffset(side.treeOffset, total, rows)
  // Each row as v0.3 draws it, in the cells the mark leaves; a press reaches the side view.
  const inner: PaneModel = {
    ...model,
    columns: Math.max(1, cells - MARK_CELLS),
    expanded: [],
    onToggle: path => model.onRow(`file:${path}`),
    onDir: path => model.onRow(`dir:${path}`),
  }
  const out: RenderElement[] = []
  for (let index = from; index < Math.min(total, from + rows); index++) {
    const row = model.rows[index]
    if (row === undefined) {
      out.push(<Text dimColor wrap="truncate-end">{`  … ${omitted} more files`}</Text>)
      continue
    }
    const isCursor = index === at
    const marked: RowMark = { mark: isCursor ? <Text color="suggestion">{'› '}</Text> : <Text>{'  '}</Text>, isCursor }
    out.push(
      row.kind === 'dir'
        ? drawDirRow(ui, inner, row.dir, row.depth, row.isCollapsed, marked)
        : drawRow(ui, inner, row.file, 'name' in row ? row : undefined, marked).node,
    )
  }

  return out
}

/** The rows of `body` the diff's window shows, each cut at `cells`. */
const drawDiffRegion = (
  ui: Ui,
  model: PaneModel,
  side: SideState,
  body: SideBody,
  cells: number,
  rows: number,
): RenderElement[] => {
  const { Code, Text } = ui
  const { total } = bodyRows(body)
  const from = clampOffset(side.diffOffset, total, rows)
  const end = Math.min(total, from + rows)
  const more = (count: number, text: string | null) =>
    text !== null && end > count ? [<Text dimColor wrap="truncate-end">{clip(text, cells)}</Text>] : []

  switch (body.kind) {
    case 'none':
      return []
    case 'note':
      return [
        body.isError ? (
          <Text color="error" wrap="truncate-end">
            {clip(body.text, cells)}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {clip(body.text, cells)}
          </Text>
        ),
      ]
    case 'dir':
      return body.files.slice(from, end).map(file => {
        const counts = countParts(file)
        const tail = countsWidth(counts) > 0 ? countsWidth(counts) + 1 : 0
        const name = fitPath(oneLine(file.path.slice(body.path.length + 1)), Math.max(NAME_MIN, cells - 2 - tail))
        const color = STATUS_COLOR[file.status]
        return spread(ui, [
          <Text wrap="truncate-end">
            {color !== undefined ? <Text color={color}>{file.status}</Text> : <Text dimColor>{file.status}</Text>}
            {` ${name}`}
          </Text>,
          ...(tail > 0 ? [drawCounts(ui, counts)] : []),
        ])
      })
    case 'source': {
      const shown = body.lines.slice(from, end)
      return [
        ...(shown.length > 0
          ? [<Code format="source" source={shown.join('\n')} path={oneLine(body.path)} startLine={from + 1} wrap="truncate-end" />]
          : []),
        ...more(body.lines.length, body.more),
      ]
    }
    case 'lines': {
      const count = Math.max(0, Math.min(end, body.diff.lines.length) - from)
      const nodes: RenderElement[] = []
      if (count > 0) {
        // The engine's view of the window's own hunks; one it cannot make draws quiet.
        const hunks = model.diffStyle === 'engine' ? windowHunks(body.diff, from, count) : null
        if (hunks !== null) {
          nodes.push(<Code format="diff" source={printable(hunks)} path={oneLine(body.path)} wrap="truncate-end" />)
        } else nodes.push(...drawLines(ui, body.diff.lines.slice(from, from + count), cells).nodes)
      }
      return [...nodes, ...more(body.diff.lines.length, body.more)]
    }
  }
}

/**
 * The tree and the diff: side by side from SPLIT_MIN_COLUMNS, a dim rule
 * between them, or one at a time. `height` rows exactly, the first the
 * heads; each region draws only the rows its window shows.
 */
const drawRegions = (ui: Ui, model: PaneModel, side: SideState, snapshot: Snapshot, budget: RowBudget): RenderElement => {
  const { Box, Text } = ui
  const { region: height, content } = budget
  const layout = paneLayout(model.columns)
  model.onFrame({ layout, budget, treeRows: content, diffRows: content })
  const rows = model.rows.map(navRow)
  const at = cursorAt(rows, side.cursor)
  const row = rows[at]
  const body = sideBody(snapshot, row, row?.kind === 'file' ? model.diffs[row.path] : undefined)
  // Side by side, a blank cell on each side of the rule keeps the counts and the diff's marks off it.
  const isSplit = layout.kind === 'split'
  const treeCells = isSplit ? layout.tree - RULE_GAP : layout.width
  const diffCells = isSplit ? layout.diff - RULE_GAP : layout.width
  const tree = (
    <Box key="side:tree" flexDirection="column" paddingRight={isSplit ? RULE_GAP : 0}>
      {drawTreeRegion(ui, model, side, at, treeCells, content)}
    </Box>
  )
  const diff = (
    <Box key="side:diff" flexDirection="column" paddingLeft={isSplit ? RULE_GAP : 0}>
      {drawDiffRegion(ui, model, side, body, diffCells, content)}
    </Box>
  )
  const label = REGION_LABEL.diff.length

  if (layout.kind === 'split') {
    const title = drawDiffTitle(ui, snapshot, body, row, layout.diff - label)
    return (
      <Box flexDirection="row" height={height} overflow="hidden">
        <Box flexDirection="column" width={layout.tree} flexShrink={0} height={height} overflow="hidden">
          {drawRegionHead(ui, 'tree', side)}
          {tree}
        </Box>
        <Box flexDirection="column" width={layout.separator} flexShrink={0}>
          <Text dimColor>{Array<string>(height).fill(SEPARATOR).join('\n')}</Text>
        </Box>
        <Box flexDirection="column" width={layout.diff} flexShrink={0} height={height} overflow="hidden">
          {spread(ui, [
            <Box flexDirection="row">
              {drawRegionHead(ui, 'diff', side)}
              {title[0] ?? null}
            </Box>,
            ...title.slice(1),
          ])}
          {diff}
        </Box>
      </Box>
    )
  }

  // One region: both heads, the shown one accented; the diff's says what it shows.
  const title = side.region === 'diff' ? drawDiffTitle(ui, snapshot, body, row, layout.width - 2 * label) : []

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {spread(ui, [
        <Box flexDirection="row">
          {drawRegionHead(ui, 'tree', side)}
          {drawRegionHead(ui, 'diff', side)}
          {title[0] ?? null}
        </Box>,
        ...title.slice(1),
      ])}
      {side.region === 'tree' ? tree : diff}
    </Box>
  )
}

/** The `o` list in the regions' place, as tall: its head, then the window of rows with the cursor in it. */
const drawPickRegion = (
  ui: Ui,
  model: PaneModel,
  picker: NonNullable<PaneModel['picker']>,
  budget: RowBudget,
): RenderElement => {
  const { Box, Text } = ui
  const from = treeWindow(0, picker.at, picker.choices.length + 1, budget.content)

  return (
    <Box flexDirection="column" height={budget.region} overflow="hidden">
      <Text color="suggestion" weight="semibold">
        {' worktrees '}
      </Text>
      {drawPickRows(ui, model, picker, model.columns, from, budget.content)}
    </Box>
  )
}

/**
 * The side view: v0.3's header, actions, tabs and summary on top, the
 * regions under them, the keys on the last row. As tall as the body exactly,
 * so the engine has nothing to scroll and each region keeps its own window.
 */
const drawSide = (ui: Ui, model: PaneModel, side: SideState, snapshot: Snapshot): RenderElement => {
  const { Box, Text } = ui
  const { tree } = model
  const top: RenderElement[] = drawHeader(ui, model, snapshot)
  let topRows = top.length
  if (snapshot.head !== '') {
    top.push(drawActions(ui, model, tree, true), drawTabs(ui, model))
    topRows += actionsRows(model, tree) + 1 + wrappedRows(MODES.map(tabCells), TAB_GAP, model.columns)
    const rule = drawRule(ui, model)
    if (rule !== null) {
      top.push(rule)
      topRows += 1
    }
  }
  const notice = noticeOf(snapshot)
  const isListed = isListedOf(snapshot, notice)
  if (notice === null) {
    top.push(drawSummary(ui, model, snapshot))
    topRows += 1
  } else if (isListed) {
    top.push(drawNotice(ui, notice, true))
    topRows += noticeRows(notice, true, model.columns)
  }
  const hint = sideHintRows(model)
  const budget = rowBudget(model.bodyRows, topRows, hint)

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={budget.top} overflow="hidden">
        {top}
      </Box>
      {model.picker !== null ? (
        drawPickRegion(ui, model, model.picker, budget)
      ) : isListed || notice === null ? (
        drawRegions(ui, model, side, snapshot, budget)
      ) : (
        <Box flexDirection="column" height={budget.region} overflow="hidden">
          {drawNotice(ui, notice, false)}
        </Box>
      )}
      {hint === 0 ? null : model.isFocused ? (
        drawSideKeys(ui, model, side, true)
      ) : (
        <Box height={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {FOCUS_HINT}
          </Text>
        </Box>
      )}
    </Box>
  )
}
