// Pure git logic: runs commands through injected deps, parses their output
// and computes snapshots. Nothing here touches `$`, so tests drive it whole.
import type {
  BaseInfo,
  BaseSource,
  DiffMode,
  FileChange,
  FileDiff,
  FileStatus,
  Snapshot,
} from '../types'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type Runner = (argv: string[], cwd: string) => Promise<RunResult>

export type FileInfo = { size: number; mtimeMs: number; isLink: boolean }

/** What an untracked file counted, by absolute path, for as long as its size and mtime hold. */
export type UntrackedCache = Map<string, { size: number; mtimeMs: number; added: number; isBinary: boolean }>

export type GitDeps = {
  run: Runner
  readText: (absPath: string) => Promise<string | null>
  /** What the path leads to (size, mtime) and whether the path is a symbolic link; null when it cannot be read. */
  fileInfo: (absPath: string) => Promise<FileInfo | null>
  now: () => Promise<number>
  /** Kept across snapshots so an unchanged untracked file is not read again. */
  untrackedCache?: UntrackedCache
}

export const GIT_PREFIX = [
  'git',
  '-c',
  'core.quotePath=false',
  // Blank context lines keep their leading space, so hunks stay parseable.
  '-c',
  'diff.suppressBlankEmpty=false',
  '--no-optional-locks',
] as const

export const MAX_UNTRACKED_BYTES = 1024 * 1024
export const MAX_DIFF_LINES = 400
export const MAX_DIFF_CHARS = 30_000
export const DEFAULT_MAX_FILES = 300

/** The one way this module runs git: fixed global options, diff hardened. */
export const git = (deps: GitDeps, cwd: string, args: readonly string[]) => {
  const rest =
    args[0] === 'diff'
      ? ['diff', '--no-color', '--no-ext-diff', ...args.slice(1)]
      : [...args]

  return deps.run([...GIT_PREFIX, ...rest], cwd)
}

export class GitError extends Error {}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

/** Runs git and rejects unless it exits with one of `okCodes`. */
const gitOk = async (
  deps: GitDeps,
  cwd: string,
  args: readonly string[],
  okCodes: readonly number[] = [0],
) => {
  const result = await git(deps, cwd, args)
  if (!okCodes.includes(result.exitCode)) {
    const why = firstLine(result.stderr) || `exit ${result.exitCode}`
    throw new GitError(`git ${args[0]} failed: ${why}`)
  }

  return result
}

const trimEnd = (text: string) => text.replace(/\n+$/, '')

// ---------------------------------------------------------------- parsers

export type NumstatEntry = {
  path: string
  oldPath?: string
  added: number
  removed: number
  isBinary: boolean
}

/** `git diff --numstat -z`: `a\tr\tpath\0`, or `a\tr\t\0old\0new\0` for a rename. */
export const parseNumstatZ = (out: string): NumstatEntry[] => {
  const tokens = out.split('\0')
  const entries: NumstatEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (token === '') continue
    const tab1 = token.indexOf('\t')
    const tab2 = tab1 < 0 ? -1 : token.indexOf('\t', tab1 + 1)
    if (tab2 < 0) continue
    const a = token.slice(0, tab1)
    const r = token.slice(tab1 + 1, tab2)
    const isBinary = a === '-' && r === '-'
    const counts = {
      added: isBinary ? 0 : Number(a) || 0,
      removed: isBinary ? 0 : Number(r) || 0,
      isBinary,
    }
    const path = token.slice(tab2 + 1)
    if (path !== '') {
      entries.push({ path, ...counts })
      continue
    }
    const oldPath = tokens[i + 1] ?? ''
    const newPath = tokens[i + 2] ?? ''
    i += 2
    entries.push({ path: newPath, oldPath, ...counts })
  }

  return entries
}

export type NameStatusEntry = {
  status: FileStatus
  path: string
  oldPath?: string
}

const toStatus = (letter: string): FileStatus => {
  switch (letter) {
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
      return letter
    default:
      return 'M'
  }
}

/** `git diff --name-status -z`: `M\0path\0`, `R094\0old\0new\0`. */
export const parseNameStatusZ = (out: string): NameStatusEntry[] => {
  const tokens = out.split('\0')
  const entries: NameStatusEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (token === '') continue
    const letter = token[0] ?? ''
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1] ?? ''
      const path = tokens[i + 2] ?? ''
      i += 2
      entries.push({ status: letter, path, oldPath })
    } else {
      const path = tokens[i + 1] ?? ''
      i += 1
      entries.push({ status: toStatus(letter), path })
    }
  }

  return entries
}

/** `\0`-separated paths, as `git ls-files -z` and `--name-only -z` print them. */
export const parsePathsZ = (out: string): string[] =>
  out.split('\0').filter(path => path !== '')

/** The ref a branch was created from: the oldest reflog line, `branch: Created from <X>`. */
export const parseReflogCreatedFrom = (out: string): string | null => {
  const lines = out.split('\n').filter(line => line.trim() !== '')
  const oldest = lines[lines.length - 1]
  const match = oldest?.match(/^branch: Created from (.+)$/)

  return match?.[1]?.trim() || null
}

/**
 * The branch HEAD left when it first checked out `branch`: the oldest
 * `checkout: moving from <X> to <branch>` line of HEAD's reflog. Null when
 * there is none, or HEAD was detached then (X is a commit id).
 */
export const parseCheckoutFrom = (out: string, branch: string): string | null => {
  let from: string | null = null
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^checkout: moving from (\S+) to (\S+)$/)
    if (match?.[2] === branch) from = match[1] ?? null
  }

  return from === null || /^[0-9a-f]{40,64}$/.test(from) ? null : from
}

export type WorktreeEntry = {
  path: string
  head: string | null
  /** Short branch name (`main`), null when detached or bare. */
  branch: string | null
  isDetached: boolean
  isBare: boolean
}

export const parseWorktreeListPorcelain = (out: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        isDetached: false,
        isBare: false,
      }
      entries.push(current)
    } else if (current === null) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'detached') {
      current.isDetached = true
    } else if (line === 'bare') {
      current.isBare = true
    }
  }

  return entries
}

/** Newlines in a text, plus one for a last line without its own. */
export const countLines = (text: string): number => {
  if (text === '') return 0
  let count = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++

  return text.endsWith('\n') ? count : count + 1
}

/**
 * The hunks of a unified diff: every file header (`diff --git`, `index`,
 * `---`, `+++`, rename lines) dropped, each `@@` hunk kept whole.
 */
export const splitHunks = (diff: string): string => {
  const kept: string[] = []
  let isInHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) {
      isInHunk = false
    } else if (line.startsWith('@@')) {
      isInHunk = true
      kept.push(line)
    } else if (isInHunk) {
      kept.push(line)
    }
  }

  return trimEnd(kept.join('\n'))
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * Cuts hunks to `maxLines` lines and `maxChars` characters, rewriting the
 * last hunk's header to the lines kept so it still parses as a diff.
 * `omittedLines` counts the diff lines dropped, never `@@` headers. A first
 * body line too long for the budget (minified code) is cut short with `…`
 * instead of dropped, so something always shows.
 */
export const truncateHunks = (
  hunks: string,
  maxLines = MAX_DIFF_LINES,
  maxChars = MAX_DIFF_CHARS,
): { hunks: string; omittedLines: number } => {
  if (hunks === '') return { hunks, omittedLines: 0 }
  const lines = hunks.split('\n')
  const kept: string[] = []
  let chars = 0
  let hasBody = false
  let isLineCut = false
  for (const line of lines) {
    if (kept.length >= maxLines) break
    const isHeader = line.startsWith('@@')
    if (chars + line.length + 1 > maxChars) {
      if (!hasBody && !isHeader) {
        // Slack for the `…` and the header growing when its counts are rewritten.
        kept.push(`${line.slice(0, Math.max(1, maxChars - chars - 16))}…`)
        isLineCut = true
      }
      break
    }
    kept.push(line)
    chars += line.length + 1
    if (!isHeader) hasBody = true
  }
  if (kept.length >= lines.length && !isLineCut) return { hunks, omittedLines: 0 }

  const omittedLines = lines.slice(kept.length).filter(l => !l.startsWith('@@')).length
  let headerAt = -1
  for (let i = kept.length - 1; i >= 0; i--) {
    if ((kept[i] ?? '').startsWith('@@')) {
      headerAt = i
      break
    }
  }
  if (headerAt >= 0) {
    const body = kept.slice(headerAt + 1)
    const match = (kept[headerAt] ?? '').match(HUNK_HEADER)
    if (body.length === 0) {
      kept.splice(headerAt)
    } else if (match) {
      const oldCount = body.filter(l => l[0] === ' ' || l[0] === '-').length
      const newCount = body.filter(l => l[0] === ' ' || l[0] === '+').length
      kept[headerAt] = `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3] ?? ''}`
    }
  }

  return { hunks: kept.join('\n'), omittedLines }
}

// ------------------------------------------------------------------- base

export type BaseContext = {
  /** Worktree root every command runs in. */
  root: string
  /** Current branch, null when detached. */
  branch: string | null
  /** A linked worktree, as opposed to the repository's main checkout. */
  isLinked: boolean
  /** The repository's integration branch, as `/wt-diff trunk` set it; null when unset. */
  trunk?: string | null
}

export type ResolvedBase = { ref: string; source: BaseSource }

const isCommit = async (deps: GitDeps, root: string, ref: string) =>
  (await git(deps, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).exitCode === 0

const DEFAULT_BRANCHES = ['main', 'master', 'trunk', 'develop'] as const

/** `refs/heads/x` → `x`, `refs/remotes/origin/x` → `origin/x`; others as given. */
export const shortRef = (ref: string): string => ref.replace(/^refs\/(?:heads|remotes)\//, '')

/**
 * A reflog start point as a name that means the same commit on every
 * refresh: `main~2` and `origin/main^` → the branch they walk back from.
 * Null for what moves with HEAD or by itself (`HEAD~2`, `@~1`, `@{-1}`,
 * `FETCH_HEAD`, `ORIG_HEAD`) and for expressions no name is left of.
 */
export const stableStartPoint = (from: string): string | null => {
  const name = from.replace(/(?:[~^]\d*)+$/, '')
  if (name === '' || name === '@' || /[~^:]|@\{|\.\./.test(name)) return null
  if (/^[A-Z_]*HEAD$/.test(name)) return null

  return name
}

/**
 * Whether a ref is the branch itself or a remote copy of it (`origin/feat`
 * for `feat`), which says nothing about where the branch started.
 */
export const isOwnCopy = (ref: string, branch: string): boolean => {
  const name = shortRef(ref)

  return name === branch || name.replace(/^[^/]+\//, '') === branch
}

/**
 * Whether the trunk is the branch or a remote copy of it. `/wt-diff trunk`
 * stores a branch by its full name, so `refs/heads/team/x` is a local branch,
 * never a copy of `x`; only a short name falls back to guessing a remote.
 */
export const isTrunkOwnCopy = (trunk: string, branch: string): boolean =>
  trunk.startsWith('refs/heads/') ? shortRef(trunk) === branch : isOwnCopy(trunk, branch)

/**
 * The trunk as a name to compare against, null when it cannot be one: it
 * reads as an option, moves with HEAD (`HEAD~2`, `@{u}`), or is the branch's
 * own copy.
 */
const usableTrunk = (trunk: string | null | undefined, branch: string | null): string | null => {
  if (!trunk) return null
  const name = shortRef(trunk)
  if (name.startsWith('-') || stableStartPoint(name) !== name) return null

  return branch !== null && isTrunkOwnCopy(trunk, branch) ? null : name
}

const upstreamOf = async (deps: GitDeps, root: string, branch: string): Promise<string> => {
  const up = await git(deps, root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])

  return up.exitCode === 0 ? up.stdout.trim() : ''
}

/** Where HEAD came from when it first checked out the branch, as a stable name. */
const checkedOutFrom = async (deps: GitDeps, root: string, branch: string): Promise<string | null> => {
  const log = await git(deps, root, ['reflog', 'show', '--format=%gs', 'HEAD'])
  const from = log.exitCode === 0 ? parseCheckoutFrom(log.stdout, branch) : null

  return from === null ? null : stableStartPoint(from)
}

/** `origin/HEAD`, else the first of main, master, trunk, develop that exists and is not this branch. */
const defaultBranch = async (
  deps: GitDeps,
  root: string,
  branch: string | null,
): Promise<ResolvedBase | null> => {
  const originHead = await git(deps, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const remoteDefault = originHead.exitCode === 0 ? originHead.stdout.trim() : ''
  if (remoteDefault !== '' && (await isCommit(deps, root, remoteDefault))) {
    return { ref: remoteDefault, source: 'default-branch' }
  }
  for (const name of DEFAULT_BRANCHES) {
    if (name !== branch && (await isCommit(deps, root, name))) {
      return { ref: name, source: 'default-branch' }
    }
  }

  return null
}

/**
 * The branch this worktree is compared against. A linked worktree: override,
 * the branch's creation reflog, its upstream, the trunk, the main worktree's
 * branch, the default branch. The main checkout, which is often the trunk
 * itself: override, reflog (`Created from HEAD` read back from HEAD's
 * reflog), the trunk, its own upstream (what is not pushed yet), the default
 * branch. On the trunk itself the main checkout skips the reflog; with a
 * creation entry that names no base it skips its own upstream. Neither the
 * reflog nor an upstream nor the trunk counts when it is the branch's own
 * copy, except the main checkout's upstream. Null when none applies; rejects
 * only for an override that names no commit.
 */
export const resolveBase = async (
  deps: GitDeps,
  ctx: BaseContext,
  override?: string | null,
): Promise<ResolvedBase | null> => {
  const { root, branch, isLinked: isLinkedWorktree, trunk } = ctx

  if (override) {
    if (!(await isCommit(deps, root, override))) {
      throw new GitError(`Base override "${override}" is not a commit (clear it with /wt-diff base)`)
    }
    return { ref: override, source: 'override' }
  }

  // On the trunk itself the reflog says only where the trunk began, which
  // the user has just said is not the point: compare against what is not pushed.
  const isOnTrunk = !isLinkedWorktree && branch !== null && !!trunk && isTrunkOwnCopy(trunk, branch)
  // A creation entry that names no base (`Created from HEAD` with nothing
  // to recover) keeps the main checkout off its own upstream, as in v0.1.
  let isCreationUnusable = false

  if (branch !== null && !isOnTrunk) {
    const reflog = await git(deps, root, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`])
    const created = reflog.exitCode === 0 ? parseReflogCreatedFrom(reflog.stdout) : null
    // Stored as written: `HEAD~2` would be read against today's HEAD.
    const named = created === null ? null : stableStartPoint(shortRef(created))
    let from = named
    // `git checkout -b x` with no start point: HEAD's reflog still says
    // which branch it was on then.
    if (created !== null && named === null && !isLinkedWorktree && /^(?:HEAD|@)(?:[~^]\d*)*$/.test(created)) {
      from = await checkedOutFrom(deps, root, branch)
    }
    // A branch checked out from its remote copy (`git worktree add ../wt
    // topic` DWIM) started at origin/topic, which is no base.
    if (from !== null && !isOwnCopy(from, branch) && (await isCommit(deps, root, from))) {
      return { ref: from, source: 'reflog' }
    }
    isCreationUnusable = created !== null && named === null
  }

  // The trunk compared against itself is no base: on it, fall to what follows.
  const trunkRef = usableTrunk(trunk, branch)

  if (!isLinkedWorktree) {
    if (trunkRef !== null && (await isCommit(deps, root, trunkRef))) return { ref: trunkRef, source: 'trunk' }
    const upstream = branch === null || isCreationUnusable ? '' : await upstreamOf(deps, root, branch)
    if (upstream !== '') return { ref: upstream, source: 'upstream' }
    return defaultBranch(deps, root, branch)
  }

  if (branch !== null) {
    const upstream = await upstreamOf(deps, root, branch)
    if (upstream !== '' && !isOwnCopy(upstream, branch)) return { ref: upstream, source: 'upstream' }
  }
  if (trunkRef !== null && (await isCommit(deps, root, trunkRef))) return { ref: trunkRef, source: 'trunk' }

  const list = await git(deps, root, ['worktree', 'list', '--porcelain'])
  const main = list.exitCode === 0 ? parseWorktreeListPorcelain(list.stdout)[0] : undefined
  if (main?.branch && main.branch !== branch && (await isCommit(deps, root, main.branch))) {
    return { ref: main.branch, source: 'main-worktree' }
  }

  return defaultBranch(deps, root, branch)
}

// --------------------------------------------------------------- snapshot

export type SnapshotRequest = {
  cwd: string
  mode: DiffMode
  baseOverride?: string | null
  /** The repository's trunk, stored under its git common dir. */
  trunk?: string | null
  maxFiles?: number
}

/** cyrb53: a fast, well-spread 53-bit string hash, as hex. */
export const hashString = (text: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

type Unsigned = Omit<Snapshot, 'signature' | 'refreshedAt'>

/** The signature a snapshot carries: everything but `signature` and `refreshedAt`. */
export const snapshotSignature = (snapshot: Unsigned): string =>
  hashString(
    JSON.stringify([
      snapshot.cwd,
      snapshot.isRepo,
      snapshot.error ?? null,
      snapshot.root,
      snapshot.gitCommonDir,
      snapshot.isLinkedWorktree,
      snapshot.branch,
      snapshot.head,
      snapshot.base && [snapshot.base.ref, snapshot.base.source, snapshot.base.mergeBase],
      snapshot.ahead,
      snapshot.behind,
      snapshot.mode,
      snapshot.files.map(f => [f.path, f.oldPath ?? null, f.status, f.added, f.removed, f.isBinary, f.layer]),
      snapshot.omittedFiles,
      [snapshot.totals.added, snapshot.totals.removed, snapshot.totals.files],
    ]),
  )

const finish = async (deps: GitDeps, snapshot: Unsigned): Promise<Snapshot> => {
  let refreshedAt = 0
  try {
    refreshedAt = await deps.now()
  } catch {
    // A clock that fails leaves the time at zero; the rest still stands.
  }

  return { ...snapshot, signature: snapshotSignature(snapshot), refreshedAt }
}

const emptySnapshot = (cwd: string, mode: DiffMode): Unsigned => ({
  cwd,
  isRepo: false,
  root: '',
  gitCommonDir: '',
  isLinkedWorktree: false,
  branch: null,
  head: '',
  base: null,
  ahead: 0,
  behind: 0,
  mode,
  files: [],
  omittedFiles: 0,
  totals: { added: 0, removed: 0, files: 0 },
})

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const joinPath = (root: string, path: string) => `${root.replace(/\/+$/, '')}/${path}`

/** Line count of an untracked file, or binary when too big or holding NUL. */
const countUntracked = async (
  deps: GitDeps,
  absPath: string,
): Promise<{ added: number; isBinary: boolean }> => {
  try {
    const info = await deps.fileInfo(absPath)
    // Git stores a link as its target path: one line, whatever it points at.
    if (info?.isLink) return { added: 1, isBinary: false }
    if (info && info.size > MAX_UNTRACKED_BYTES) return { added: 0, isBinary: true }
    const cached = info ? deps.untrackedCache?.get(absPath) : undefined
    if (cached && info && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return { added: cached.added, isBinary: cached.isBinary }
    }
    const text = await deps.readText(absPath)
    if (text === null) return { added: 0, isBinary: false }
    const counted = text.includes('\0')
      ? { added: 0, isBinary: true }
      : { added: countLines(text), isBinary: false }
    if (info) deps.untrackedCache?.set(absPath, { size: info.size, mtimeMs: info.mtimeMs, ...counted })

    return counted
  } catch {
    return { added: 0, isBinary: false }
  }
}

type Unlayered = Omit<FileChange, 'layer'>

/** Joins numstat counts onto name-status letters, keyed by path. */
const mergeEntries = (numstat: NumstatEntry[], names: NameStatusEntry[]): Unlayered[] => {
  const statusOf = new Map(names.map(n => [n.path, n]))
  const seen = new Set<string>()
  const files: Unlayered[] = []
  for (const entry of numstat) {
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    const named = statusOf.get(entry.path)
    const oldPath = entry.oldPath ?? named?.oldPath
    files.push({
      path: entry.path,
      ...(oldPath !== undefined ? { oldPath } : {}),
      status: named?.status ?? (oldPath !== undefined ? 'R' : 'M'),
      added: entry.added,
      removed: entry.removed,
      isBinary: entry.isBinary,
    })
  }

  return files
}

/** The revisions a mode diffs, given the merge-base. */
export const modeSpec = (mode: DiffMode, mergeBase: string): string[] => {
  switch (mode) {
    case 'committed':
      return [mergeBase, 'HEAD']
    case 'uncommitted':
      return ['HEAD']
    default:
      return [mergeBase]
  }
}

// The trailing `--` keeps a file named like a revision (`HEAD`) from being ambiguous.
const namesOnly = (spec: readonly string[]) => ['diff', '--name-only', '-z', '--no-renames', ...spec, '--']

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const UNTRACKED_BATCH = 16

/**
 * Lists the changed files of a mode, sorted by path. `mergeBase` is null
 * only for `uncommitted`, which needs no base. Under the cap tracked changes
 * come first, so an unignored build directory cannot crowd them out.
 */
const listFiles = async (
  deps: GitDeps,
  root: string,
  mode: DiffMode,
  mergeBase: string | null,
  maxFiles: number,
): Promise<Pick<Snapshot, 'files' | 'omittedFiles' | 'totals'>> => {
  const spec = mergeBase === null ? ['HEAD'] : modeSpec(mode, mergeBase)
  const isLayered = mode === 'all' && mergeBase !== null
  const [numstat, names, untracked, inCommits, inWorktree] = await Promise.all([
    gitOk(deps, root, ['diff', '--numstat', '-z', '-M', ...spec, '--']),
    gitOk(deps, root, ['diff', '--name-status', '-z', '-M', ...spec, '--']),
    mode === 'committed'
      ? null
      : gitOk(deps, root, ['ls-files', '--others', '--exclude-standard', '-z']),
    isLayered ? gitOk(deps, root, namesOnly([mergeBase, 'HEAD'])) : null,
    isLayered ? gitOk(deps, root, namesOnly(['HEAD'])) : null,
  ])

  const committedNames = new Set(inCommits ? parsePathsZ(inCommits.stdout) : [])
  const worktreeNames = new Set(inWorktree ? parsePathsZ(inWorktree.stdout) : [])
  const layerOf = (file: Unlayered): FileChange['layer'] => {
    if (mode !== 'all') return mode
    const touches = (set: Set<string>) =>
      set.has(file.path) || (file.oldPath !== undefined && set.has(file.oldPath))
    // What the commits did not touch can only have changed in the working tree.
    if (file.status === '?' || !touches(committedNames)) return 'uncommitted'

    return touches(worktreeNames) ? 'both' : 'committed'
  }

  const tracked = mergeEntries(parseNumstatZ(numstat.stdout), parseNameStatusZ(names.stdout))
  const trackedPaths = new Set(tracked.map(f => f.path))
  const untrackedFiles: Unlayered[] = (untracked ? parsePathsZ(untracked.stdout) : [])
    // A trailing `/` is a nested repository or linked worktree, not a file.
    .filter(path => !path.endsWith('/') && !trackedPaths.has(path))
    .map(path => ({ path, status: '?', added: 0, removed: 0, isBinary: false }))

  const all = [...tracked.sort(byPath), ...untrackedFiles.sort(byPath)]
  const listed = all.slice(0, Math.max(0, maxFiles)).sort(byPath)

  // Only listed untracked files are read; past the cap they count no lines.
  const listedUntracked = listed.filter(file => file.status === '?')
  for (let i = 0; i < listedUntracked.length; i += UNTRACKED_BATCH) {
    await Promise.all(
      listedUntracked.slice(i, i + UNTRACKED_BATCH).map(async file => {
        Object.assign(file, await countUntracked(deps, joinPath(root, file.path)))
      }),
    )
  }
  const cache = deps.untrackedCache
  if (cache) {
    // Forget this worktree's files that are gone or no longer listed.
    const keep = new Set(listedUntracked.map(file => joinPath(root, file.path)))
    const prefix = joinPath(root, '')
    for (const path of cache.keys()) if (path.startsWith(prefix) && !keep.has(path)) cache.delete(path)
  }

  const totals = { added: 0, removed: 0, files: all.length }
  for (const file of all) {
    totals.added += file.added
    totals.removed += file.removed
  }

  return {
    files: listed.map(file => ({ ...file, layer: layerOf(file) })),
    omittedFiles: all.length - listed.length,
    totals,
  }
}

/**
 * Whether `rev-parse --path-format=absolute --git-dir --git-common-dir`
 * describes a linked worktree. Git before 2.31 echoes the flag it does not
 * know, then prints both dirs unresolved: there a linked one is told by its
 * git dir, always `<common>/worktrees/<name>`.
 */
export const isLinked = (stdout: string): boolean => {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines[0]?.startsWith('--')) {
    const [, gitDir = '', commonDir = ''] = lines
    return lines.length === 3 && gitDir !== commonDir && /\/worktrees\/[^/]+\/?$/.test(gitDir)
  }
  const [gitDir = '', commonDir = ''] = lines

  return lines.length === 2 && gitDir !== commonDir
}

/** `/a/./b/../c/` → `/a/c`. */
const normalizePath = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return `/${parts.join('/')}`
}

/**
 * The common dir out of the same output, absolute. Git before 2.31 may
 * answer it relative to where it ran, the worktree `root`.
 */
export const commonDirOf = (stdout: string, root: string): string => {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  const dir = (lines[0]?.startsWith('--') ? lines[2] : lines[1]) ?? ''
  if (dir === '') return ''

  return normalizePath(dir.startsWith('/') ? dir : joinPath(root, dir))
}

const DIRS_ARGS = ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'] as const

export type RepoDirs = { root: string; gitCommonDir: string }

/**
 * The worktree root and the repository's common dir, as `computeSnapshot`
 * finds them; null outside a repository, an empty common dir when only it
 * failed.
 */
export const repoDirs = async (deps: GitDeps, cwd: string): Promise<RepoDirs | null> => {
  const top = await git(deps, cwd, ['rev-parse', '--show-toplevel'])
  const root = top.stdout.trim()
  if (top.exitCode !== 0 || root === '') return null
  const dirs = await git(deps, root, DIRS_ARGS)

  return { root, gitCommonDir: dirs.exitCode === 0 ? commonDirOf(dirs.stdout, root) : '' }
}

/**
 * The worktree's changes in `mode` versus its base. Never rejects: a git
 * failure lands in `error`, beside whatever was learnt before it.
 */
export const computeSnapshot = async (
  deps: GitDeps,
  request: SnapshotRequest,
): Promise<Snapshot> => {
  const { cwd, mode, baseOverride, trunk, maxFiles = DEFAULT_MAX_FILES } = request
  const snapshot = emptySnapshot(cwd, mode)

  try {
    const top = await git(deps, cwd, ['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) {
      if (!/not a git repository/i.test(top.stderr)) {
        snapshot.error = firstLine(top.stderr) || `git rev-parse exited ${top.exitCode}`
      }
      return await finish(deps, snapshot)
    }
    const root = top.stdout.trim()
    snapshot.isRepo = true
    snapshot.root = root

    const [dirs, symbolic, head] = await Promise.all([
      gitOk(deps, root, DIRS_ARGS),
      git(deps, root, ['symbolic-ref', '--short', '-q', 'HEAD']),
      git(deps, root, ['rev-parse', '--verify', '--quiet', '--short', 'HEAD']),
    ])
    snapshot.isLinkedWorktree = isLinked(dirs.stdout)
    snapshot.gitCommonDir = commonDirOf(dirs.stdout, root)
    const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : ''
    snapshot.branch = branch === '' ? null : branch
    snapshot.head = head.exitCode === 0 ? head.stdout.trim() : ''

    // A repo with no commits has nothing to diff against yet.
    if (snapshot.head === '') return await finish(deps, snapshot)

    const resolved = await resolveBase(
      deps,
      { root, branch: snapshot.branch, isLinked: snapshot.isLinkedWorktree, trunk },
      baseOverride,
    )
    if (resolved === null) {
      // Uncommitted changes need no base, so that mode still lists them.
      if (mode === 'uncommitted') Object.assign(snapshot, await listFiles(deps, root, mode, null, maxFiles))
      return await finish(deps, snapshot)
    }

    const mb = await git(deps, root, ['merge-base', resolved.ref, 'HEAD'])
    const mergeBase = mb.stdout.trim()
    if (mb.exitCode !== 0 || mergeBase === '') {
      const why = `No common ancestor between ${resolved.ref} and HEAD`
      if (mode !== 'uncommitted') throw new GitError(why)
      // An orphan branch or a shallow clone: HEAD to the working tree still stands.
      snapshot.error = why
      Object.assign(snapshot, await listFiles(deps, root, mode, null, maxFiles))
      return await finish(deps, snapshot)
    }
    const base: BaseInfo = { ...resolved, mergeBase }
    snapshot.base = base

    const [counts, listing] = await Promise.all([
      gitOk(deps, root, ['rev-list', '--left-right', '--count', `${resolved.ref}...HEAD`]),
      listFiles(deps, root, mode, mergeBase, maxFiles),
    ])
    const [behind = '0', ahead = '0'] = counts.stdout.trim().split(/\s+/)
    snapshot.behind = Number(behind) || 0
    snapshot.ahead = Number(ahead) || 0
    Object.assign(snapshot, listing)
  } catch (error) {
    snapshot.error = errorText(error)
  }

  return finish(deps, snapshot)
}

// -------------------------------------------------------------- file diff

const isFailedNoIndex = (run: RunResult) =>
  run.exitCode > 1 || (run.exitCode === 1 && run.stdout === '' && run.stderr.trim() !== '')

/**
 * One file's unified diff under the snapshot's mode, cut to the per-file
 * cap. Never rejects: a failure lands in `error`.
 */
export const loadFileDiff = async (
  deps: GitDeps,
  snapshot: Snapshot,
  file: FileChange,
): Promise<FileDiff> => {
  const result: FileDiff = { hunks: '', isBinary: false, omittedLines: 0, signature: snapshot.signature }
  if (file.isBinary) return { ...result, isBinary: true }

  try {
    let out: string
    if (file.status === '?') {
      // --no-index exits 1 when the two differ, which they always do here.
      const run = await git(deps, snapshot.root, ['diff', '--no-index', '--', '/dev/null', file.path])
      if (isFailedNoIndex(run)) {
        throw new GitError(`git diff failed: ${firstLine(run.stderr) || `exit ${run.exitCode}`}`)
      }
      out = run.stdout
    } else {
      const spec = snapshot.base
        ? modeSpec(snapshot.mode, snapshot.base.mergeBase)
        : snapshot.mode === 'uncommitted'
          ? ['HEAD']
          : null
      if (spec === null) throw new GitError('No base to diff against')
      const paths = file.oldPath !== undefined ? [file.path, file.oldPath] : [file.path]
      const run = await gitOk(deps, snapshot.root, [
        'diff',
        '-M',
        ...spec,
        '--',
        ...paths.map(p => `:(literal)${p}`),
      ])
      out = run.stdout
    }

    if (/^Binary files .* differ$/m.test(out) || /^GIT binary patch$/m.test(out)) {
      return { ...result, isBinary: true }
    }

    return { ...result, ...truncateHunks(splitHunks(out)) }
  } catch (error) {
    return { ...result, error: errorText(error) }
  }
}

// ---------------------------------------------------------------- summary

const countsText = (file: FileChange) => {
  if (file.isBinary) return 'binary'
  if (file.status === '?') return `+${file.added}`

  return `+${file.added} -${file.removed}`
}

/** The plain-text summary `/wt-diff status` answers with. */
export const summaryText = (snapshot: Snapshot): string => {
  if (!snapshot.isRepo) {
    return snapshot.error
      ? `Error: ${snapshot.error}`
      : `Not a git repository: ${snapshot.cwd}`
  }

  const branch = snapshot.branch ?? `detached HEAD ${snapshot.head}`.trim()
  const lines: string[] = []
  if (snapshot.base) {
    const { ref, source, mergeBase } = snapshot.base
    const { files, added, removed } = snapshot.totals
    lines.push(`${branch} → ${ref}   ${source} · ${mergeBase.slice(0, 7)}`)
    lines.push(
      `↑${snapshot.ahead} ↓${snapshot.behind} · ${files} ${files === 1 ? 'file' : 'files'} · +${added} -${removed} · mode ${snapshot.mode}`,
    )
  } else {
    lines.push(branch)
  }
  if (snapshot.error) lines.push(`Error: ${snapshot.error}`)

  if (snapshot.head === '') {
    lines.push('No commits yet.')
    return lines.join('\n')
  }
  if (!snapshot.base && !snapshot.error) {
    lines.push('No base branch found. Set one with /wt-diff base <ref>.')
    if (snapshot.mode !== 'uncommitted') return lines.join('\n')
  }
  if (snapshot.files.length === 0) {
    const isWorktreeOnly = snapshot.mode === 'uncommitted' || !snapshot.base
    if (!snapshot.error) lines.push(isWorktreeOnly ? 'No uncommitted changes' : `No changes vs ${snapshot.base?.ref}`)
    return lines.join('\n')
  }

  for (const file of snapshot.files) {
    const mark = snapshot.mode === 'all' ? (file.layer === 'committed' ? '  ' : '● ') : ''
    const name = file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path
    lines.push(`${file.status} ${mark}${name}  ${countsText(file)}`)
  }
  if (snapshot.omittedFiles > 0) lines.push(`… ${snapshot.omittedFiles} more files`)

  return lines.join('\n')
}
