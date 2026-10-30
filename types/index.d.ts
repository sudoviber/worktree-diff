export type DiffMode = 'all' | 'committed' | 'uncommitted'

export type ViewMode = 'tree' | 'list'

export type BaseSource =
  | 'override'
  | 'reflog'
  | 'upstream'
  | 'trunk'
  | 'main-worktree'
  | 'default-branch'

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export type FileChange = {
  path: string
  /** Set for a rename or copy: the path on the base side. */
  oldPath?: string
  status: FileStatus
  added: number
  removed: number
  isBinary: boolean
  /** In `all` mode: whether the change is in commits, the working tree, or both. */
  layer: 'committed' | 'uncommitted' | 'both'
}

export type BaseInfo = {
  /** The ref compared against, as resolved (`main`, `origin/main`). */
  ref: string
  source: BaseSource
  /** Full sha of `git merge-base <ref> HEAD`. */
  mergeBase: string
}

export type Snapshot = {
  /** The directory the snapshot was computed for: the worktree the pane shows, or the session's directory. */
  cwd: string
  isRepo: boolean
  /** A git failure worth showing; the rest of the snapshot is best effort. */
  error?: string
  /** `git rev-parse --show-toplevel`, absolute. Empty when not a repo. */
  root: string
  /** `git rev-parse --git-common-dir`, absolute: one per repository, shared by its worktrees. Empty when unknown. */
  gitCommonDir: string
  isLinkedWorktree: boolean
  /** Current branch, or null when HEAD is detached. */
  branch: string | null
  /** Short sha of HEAD, empty in a repo with no commits. */
  head: string
  base: BaseInfo | null
  ahead: number
  behind: number
  mode: DiffMode
  files: FileChange[]
  /** Files beyond the listed cap. */
  omittedFiles: number
  totals: { added: number; removed: number; files: number }
  /** Stable hash of everything above but time: equal means nothing changed. */
  signature: string
  refreshedAt: number
}

export type FileDiff = {
  /** Unified-diff hunks only (from the first `@@`), or '' for binary/empty. */
  hunks: string
  isBinary: boolean
  /** Diff lines dropped past the per-file cap; `@@` headers are not counted. */
  omittedLines: number
  /** The snapshot signature it was loaded under. */
  signature: string
  error?: string
}

/** A worktree the `o` list offers, as `git worktree list` gives it. */
export type WorktreeChoice = {
  path: string
  /** Short branch name, null when detached. */
  branch: string | null
  /** Short sha of its HEAD. */
  head: string
}

export type WorktreePicker = {
  /** The row the cursor is on: 0 is `auto`, then the worktrees in order. */
  at: number
  choices: WorktreeChoice[]
}

declare module 'claude-code' {
  interface PluginState {
    'worktree-diff': {
      snapshot: Shaped<Snapshot | null>
      mode: DiffMode
      expanded: Shaped<string[]>
      diffs: Shaped<Record<string, FileDiff>>
      isRefreshing: boolean
      /** Mirrors `$.store`'s `view`, which keeps it across sessions, for drawing. */
      view: ViewMode
      /** Paths of the tree's collapsed directories. */
      collapsedDirs: Shaped<string[]>
      /** diffView side: the row key (`file:<path>`, `dir:<path>`) the cursor is on; null before the first listing. */
      cursor: Shaped<string | null>
      /** diffView side: which region the keys act on. */
      region: Shaped<'tree' | 'diff'>
      /** diffView side: the first row of the diff the diff region shows. */
      diffOffset: Shaped<number>
      /** diffView side: the first row of the listing the tree region shows. */
      treeOffset: Shaped<number>
      /** The worktree root the person pinned the pane to (`/wt-diff at`, `o`); null follows Claude. */
      pinned: Shaped<string | null>
      /** The worktree root Claude last worked in, when not the session's own; null shows the session's. */
      followed: Shaped<string | null>
      /** `worktree removed — back to <name>`, shown until the pane's worktree changes again. */
      fallback: Shaped<string | null>
      /** The `o` list of worktrees; null while closed. */
      picker: Shaped<WorktreePicker | null>
      /** Whether following Claude into a linked worktree may still open the pane: once, and never after the person closed it. */
      followOpens: Shaped<boolean>
    }
  }
}
