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

import type { DiffMode, FileChange, FileDiff, Snapshot } from '../types'
import { computeSnapshot, git, loadFileDiff, summaryText, type GitDeps, type UntrackedCache } from './git'

type Dollar = EngineInterface
type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>

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
export const USAGE = [
  'Usage: /wt-diff [status | refresh | base [<ref>] | mode all|committed|uncommitted]',
  '  /wt-diff              open or close the Changes pane',
  '  /wt-diff status       print the changes as text',
  '  /wt-diff refresh      re-read git now',
  '  /wt-diff base <ref>   compare this worktree against <ref>; /wt-diff base clears it',
  '  /wt-diff mode <mode>  all (default), committed or uncommitted',
].join('\n')

// Change a tag when its value's shape changes: an older value then reads as the initial.
const snapshotAtom = atom({ plugin: 'worktree-diff', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const modeAtom = atom({ plugin: 'worktree-diff', key: 'mode' } as const, 'all')
const expandedAtom = atom({ plugin: 'worktree-diff', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})
const diffsAtom = atom({ plugin: 'worktree-diff', key: 'diffs' } as const, {}, {
  shape: 'diffs-1',
})
const refreshingAtom = atom({ plugin: 'worktree-diff', key: 'isRefreshing' } as const, false)

// ----------------------------------------------------------------- config

type AutoOpen = 'worktree' | 'always' | 'never'
type Config = { autoOpen: AutoOpen; pollSeconds: number; statusLine: boolean }

export const readConfig = (options: PluginOptions): Config => {
  const { autoOpen, pollSeconds, statusLine } = options
  const poll = pollSeconds === undefined ? 5 : Number(pollSeconds)

  return {
    autoOpen: autoOpen === 'always' || autoOpen === 'never' ? autoOpen : 'worktree',
    pollSeconds: Number.isFinite(poll) && poll > 0 ? poll : 0,
    statusLine: statusLine === true,
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

const charWidth = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0

  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1
}

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

export const statusLineText = (snapshot: Snapshot | null): string | undefined => {
  if (!snapshot || snapshot.totals.files === 0) return undefined
  const { added, removed } = snapshot.totals

  return `wt +${added} ${MINUS}${removed}`
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

const topLevel = async (deps: GitDeps, cwd: string): Promise<string | null> => {
  const top = await git(deps, cwd, ['rev-parse', '--show-toplevel'])
  const root = top.stdout.trim()

  return top.exitCode === 0 && root !== '' ? root : null
}

const baseKey = (root: string) => `base:${root}`

const storedBase = async ($: Dollar, root: string): Promise<string | null> => {
  try {
    const value = await $.store.get(baseKey(root))
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

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
// Losing it costs one more read of each untracked file.
const untrackedCache: UntrackedCache = new Map()

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

const openPane = async ($: Dollar, raise = false) => {
  const opened = await $.ui.open(raise ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE })
  if (opened.isPlaced) startPolling($)

  return opened
}

/** Loads the expanded files' diffs again; drops paths the snapshot no longer lists. */
const syncDiffs = async ($: Dollar, deps: GitDeps, snapshot: Snapshot) => {
  const byPath = new Map(snapshot.files.map(file => [file.path, file]))
  const expanded = await read($, expandedAtom)
  if (expanded.some(path => !byPath.has(path))) {
    await update($, expandedAtom, list => list.filter(path => byPath.has(path)))
  }
  const kept = expanded.filter(path => byPath.has(path))
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
      if (live.has(path) && !kept.includes(path)) out[path] = diff
    }
    for (const [path, diff] of loaded) if (live.has(path)) out[path] = diff

    return out
  })
}

const refreshOnce = async ($: Dollar, force: boolean): Promise<Snapshot | null> => {
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
  const root =
    previous !== null && previous.cwd === cwd && previous.isRepo
      ? previous.root
      : await topLevel(deps, cwd)
  const baseOverride = root === null ? null : await storedBase($, root)
  const snapshot = await computeSnapshot(deps, { cwd, mode, baseOverride })

  if ((await read($, modeAtom)) !== mode) {
    // The mode moved while git ran: this result is the old mode's.
    rerun = true
    return snapshot
  }
  if (previous?.signature !== snapshot.signature) await update($, snapshotAtom, () => snapshot)
  // A failed read lists nothing: keep what is open until git answers again.
  if (snapshot.error === undefined || snapshot.files.length > 0) await syncDiffs($, deps, snapshot)
  if (config.statusLine) $.ui.status(statusLineText(snapshot))
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

const toggleFile = async ($: Dollar, path: string) => {
  const list = await update($, expandedAtom, paths =>
    paths.includes(path) ? paths.filter(one => one !== path) : [...paths, path],
  )
  if (!list.includes(path)) {
    await update($, diffsAtom, diffs => without(diffs, path))
    return
  }
  const snapshot = await read($, snapshotAtom)
  const file = snapshot?.files.find(one => one.path === path)
  if (!snapshot || !file) return
  const diff = await loadFileDiff(gitDeps($), snapshot, file)
  // Collapsed again while it loaded.
  if (!(await read($, expandedAtom)).includes(path)) return
  await update($, diffsAtom, diffs => ({ ...diffs, [path]: diff }))
}

const collapseAll = async ($: Dollar) => {
  await update($, expandedAtom, () => [])
  await update($, diffsAtom, () => ({}))
}

const setMode = async ($: Dollar, mode: DiffMode) => {
  await update($, modeAtom, () => mode)
  await update($, diffsAtom, () => ({}))
  await refresh($, { force: true, isVisible: true })
}

const setBase = async ($: Dollar, ref: string | undefined): Promise<string> => {
  const deps = gitDeps($)
  const cwd = await $.session.cwd()
  const root = await topLevel(deps, cwd)
  if (root === null) return `Not a git repository: ${cwd}`

  if (ref === undefined) {
    await $.store.delete(baseKey(root))
    await refresh($, { force: true, isVisible: true })
    return `Base override cleared for ${root}.`
  }
  if (ref.startsWith('-')) return `Not a ref: ${ref}`
  const check = await git(deps, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (check.exitCode !== 0) return `Not a commit here: ${ref}`
  await $.store.set(baseKey(root), ref)
  await refresh($, { force: true, isVisible: true })

  return `Base set to ${ref} for ${root}.`
}

const togglePane = async ($: Dollar) => {
  const pane = await paneState($)
  if (pane?.isPlaced && pane.isShown) {
    await $.ui.close({ id: PANE })
    stopPolling()
    return 'Changes pane closed.'
  }
  // Open but undrawn, or a tab behind another pane, the person sees nothing:
  // this open places it, and `focus` raises a tab.
  const opened = await openPane($, pane?.isPlaced === true)
  background(refresh($, { force: true, isVisible: true }))

  return opened.isPlaced ? 'Changes pane opened.' : `Changes pane is waiting: ${opened.reason}`
}

const runCommand = async ($: Dollar, args: string): Promise<string> => {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(word => word !== '')
  switch (sub) {
    case '':
      return togglePane($)
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
      argumentHint: '[status | refresh | base [<ref>] | mode all|committed|uncommitted]',
      // Watching Claude's edits land is the point: none of it needs the turn over.
      immediate: true,
    })
    // State outlives a reload: a snapshot already there means this is one,
    // and a pane the person closed stays closed.
    const isReload = (await read($, snapshotAtom)) !== null
    wantsAutoOpen = e.isInteractive && !isReload && config.autoOpen !== 'never'
    // A reload that cut a visible pass short never cleared its marker.
    if (await read($, refreshingAtom)) await update($, refreshingAtom, () => false)
    background(refresh($))

    return next(e)
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

  // Drawn on every terminal screen, so it says early whether panes dock.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    learnLayout($, e.viewport?.isFullscreen)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui: Ui = $.ui.resolve(e)
    learnLayout($, e.viewport?.isFullscreen)
    startPolling($)
    const [snapshot, mode, expanded, diffs, isRefreshing] = await Promise.all([
      read($, snapshotAtom),
      read($, modeAtom),
      read($, expandedAtom),
      read($, diffsAtom),
      read($, refreshingAtom),
    ])

    return drawPane(ui, {
      snapshot,
      mode,
      expanded,
      diffs,
      isRefreshing,
      columns: Math.max(16, e.props.bodyColumns),
      surface: e.surface,
      onMode: picked => background(setMode($, picked)),
      onRefresh: () => background(refresh($, { force: true, isVisible: true })),
      onCollapse: () => background(collapseAll($)),
      onToggle: path => background(toggleFile($, path)),
    })
  })
}

// ---------------------------------------------------------------- drawing

type PaneModel = {
  snapshot: Snapshot | null
  mode: DiffMode
  expanded: readonly string[]
  diffs: Readonly<Record<string, FileDiff>>
  isRefreshing: boolean
  columns: number
  surface: RenderSurface
  onMode: (mode: DiffMode) => void
  onRefresh: () => void
  onCollapse: () => void
  onToggle: (path: string) => void
}

/**
 * `branch → ref` within `room` cells. The ref is what the pane compares
 * against, so the branch gives way first, cut in the middle.
 */
export const fitHeader = (branch: string, ref: string, room: number): string => {
  const whole = `${branch} → ${ref}`
  if (cellWidth(whole) <= room) return whole
  const fittedRef = fitPath(ref, Math.max(4, Math.min(cellWidth(ref), room - 3 - Math.min(cellWidth(branch), 8))))

  return `${fitPath(branch, Math.max(1, room - 3 - cellWidth(fittedRef)))} → ${fittedRef}`
}

const BUSY_CELLS = 2

const drawHeader = (ui: Ui, model: PaneModel, snapshot: Snapshot): RenderElement[] => {
  const { Box, Text } = ui
  const busy = model.isRefreshing ? <Text dimColor> …</Text> : null
  const branch = oneLine(snapshot.branch ?? `detached ${snapshot.head}`.trim())
  const { files, added, removed } = snapshot.totals
  const totals = (lead: string, note?: string) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      <Box flexDirection="row">
        <Text>{`${lead}${files} ${files === 1 ? 'file' : 'files'} · `}</Text>
        <Text color="success">{`+${added}`}</Text>
        <Text> </Text>
        <Text color="error">{`${MINUS}${removed}`}</Text>
      </Box>
      {note !== undefined ? <Text dimColor>{note}</Text> : null}
    </Box>
  )

  if (!snapshot.base) {
    const head = (
      <Box flexDirection="row">
        <Text bold wrap="truncate-end">
          {branch}
        </Text>
        {snapshot.head !== '' ? <Text dimColor>{'   '}no base</Text> : null}
        {busy}
      </Box>
    )
    // Uncommitted needs no base: its listing has totals like any other.
    return snapshot.mode === 'uncommitted' && snapshot.head !== '' ? [head, totals('')] : [head]
  }

  const { ref, source, mergeBase } = snapshot.base

  // The first line holds only what is compared; where from goes second, wrapping first.
  return [
    <Box flexDirection="row">
      <Text bold wrap="truncate-end">
        {fitHeader(branch, oneLine(ref), model.columns - BUSY_CELLS)}
      </Text>
      {busy}
    </Box>,
    totals(`↑${snapshot.ahead} ↓${snapshot.behind} · `, `${source} · ${mergeBase.slice(0, 7)}`),
  ]
}

// `plain` draws each hotkey beside its label (`a: all`); the current mode is
// bold there, and `primary` wherever a surface draws its own buttons.
const drawControls = (ui: Ui, model: PaneModel): RenderElement => {
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
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
            <Text bold>{mode}</Text>
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
      <Button key="refresh" label="refresh" hotkey="r" plain onPress={model.onRefresh} />
      {model.expanded.length > 0 ? (
        <Button key="collapse" label="collapse" hotkey="x" plain onPress={model.onCollapse} />
      ) : null}
    </Box>
  )
}

/** The empty state's words, or null when there are files to list. */
const emptyText = (snapshot: Snapshot): string | null => {
  if (snapshot.head === '') return 'No commits yet.'
  if (!snapshot.base && !snapshot.error && snapshot.mode !== 'uncommitted') {
    return 'No base branch found. Set one with /wt-diff base <ref>, or switch to uncommitted.'
  }
  if (snapshot.files.length > 0 || snapshot.error) return null

  return snapshot.mode === 'uncommitted' || !snapshot.base
    ? 'No uncommitted changes'
    : `No changes vs ${snapshot.base.ref}`
}

const drawRow = (ui: Ui, model: PaneModel, file: FileChange): RenderElement => {
  const { Button, Text } = ui
  // The snapshot's own mode: a switch shows the old rows until git answers.
  const mark = model.snapshot?.mode === 'all' ? (file.layer === 'committed' ? '  ' : '● ') : ''
  const lead = `${file.status} ${mark}`
  const counts = countParts(file)
  const countsLen = countsWidth(counts)
  const room = Math.max(4, model.columns - lead.length - (countsLen > 0 ? countsLen + 1 : 0))
  const path = oneLine(file.path)
  let name = fitPath(path, room)
  if (file.oldPath !== undefined) {
    const oldPath = oneLine(file.oldPath)
    const whole = `${oldPath} → ${path}`
    const half = Math.max(2, Math.floor((room - 3) / 2))
    name = cellWidth(whole) <= room ? whole : `${fitPath(oldPath, half)} → ${fitPath(path, room - 3 - half)}`
  }
  const statusColor = STATUS_COLOR[file.status]

  // A Button holds strings and Text only.
  const children: (string | RenderElement)[] = [
    statusColor ? <Text color={statusColor}>{file.status}</Text> : <Text dimColor>{file.status}</Text>,
    ` ${mark}`,
    model.expanded.includes(file.path) ? <Text bold>{name}</Text> : name,
  ]
  if (countsLen > 0) {
    // Right-align the counts where cells are monospace.
    const gap = model.columns - lead.length - cellWidth(name) - countsLen
    children.push(model.surface === 'terminal' ? ' '.repeat(Math.max(1, gap)) : '  ')
  }
  if (counts.added !== undefined) children.push(<Text color="success">{counts.added}</Text>)
  if (counts.added !== undefined && counts.removed !== undefined) children.push(' ')
  if (counts.removed !== undefined) children.push(<Text color="error">{counts.removed}</Text>)
  if (counts.other !== undefined) children.push(<Text dimColor>{counts.other}</Text>)

  return (
    <Button key={`file:${file.path}`} plain onPress={() => model.onToggle(file.path)}>
      {children}
    </Button>
  )
}

const drawDiff = (
  ui: Ui,
  file: FileChange,
  diff: FileDiff | undefined,
  room: number,
): { node: RenderElement; chars: number } => {
  const { Box, Code, Text } = ui
  const note = (text: string, isError = false) => ({
    node: (
      <Box paddingLeft={2}>
        {isError ? <Text color="error">{text}</Text> : <Text dimColor>{text}</Text>}
      </Box>
    ),
    chars: text.length,
  })

  if (diff === undefined) return note('loading…')
  if (diff.error !== undefined) return note(oneLine(diff.error), true)
  if (diff.isBinary) return note('Binary file')
  if (diff.hunks === '') return note('No textual changes')
  if (diff.hunks.length > room) return note('Diff hidden: too much is open. Collapse other files to see it.')

  const source = printable(diff.hunks)
  const more = diff.omittedLines > 0 ? `… ${diff.omittedLines} more lines — open in editor` : null

  return {
    node: (
      <Box flexDirection="column" marginBottom={1}>
        <Code format="diff" source={source} path={oneLine(file.path)} wrap="truncate-end" />
        {more !== null ? <Text dimColor>{more}</Text> : null}
      </Box>
    ),
    chars: source.length + (more?.length ?? 0),
  }
}

export const drawPane = (ui: Ui, model: PaneModel): RenderElement => {
  const { Box, Text } = ui
  const { snapshot } = model

  if (snapshot === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Reading git…</Text>
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
      </Box>
    )
  }

  const body: RenderElement[] = drawHeader(ui, model, snapshot)
  if (snapshot.head !== '') body.push(drawControls(ui, model))
  if (snapshot.error) body.push(<Text color="error">{`Error: ${oneLine(snapshot.error)}`}</Text>)

  const empty = emptyText(snapshot)
  if (empty !== null) {
    body.push(<Text dimColor>{empty}</Text>)
    return <Box flexDirection="column">{body}</Box>
  }

  // Every row is padded to the width, so the rows still to come take their
  // share of the budget before a diff does: none of them is cut off the end.
  let used = 0
  snapshot.files.forEach((file, index) => {
    body.push(drawRow(ui, model, file))
    used += model.columns
    if (!model.expanded.includes(file.path)) return
    const later = (snapshot.files.length - index - 1) * model.columns + TAIL_CHARS
    const drawn = drawDiff(ui, file, model.diffs[file.path], TEXT_BUDGET - used - later)
    body.push(drawn.node)
    used += drawn.chars
  })
  if (snapshot.omittedFiles > 0) body.push(<Text dimColor>{`… ${snapshot.omittedFiles} more files`}</Text>)

  return <Box flexDirection="column">{body}</Box>
}
