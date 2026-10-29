# worktree-diff

A Claude Code mod that docks a **Changes** pane beside the conversation. It shows what the
current git worktree changed compared with the branch it was created from: every file with
its added and removed line counts, and the unified diff of any file you open. The pane
refreshes itself after Claude edits files or runs commands, so you can follow the branch's
changes without switching to another tool.

```
feat/login → main
↑3 ↓1 · 5 files · +120 −34  reflog · a1b2c3d
a: all  c: committed  u: uncommitted  r: refresh
M ● src/app.ts                +12 −3
A   src/new.ts                   +40
R   old.ts → new.ts            +1 −1
? ● notes.md                      +5
```

`●` marks a file that has changes not committed yet. Press a row to open its diff and press
it again to close it. On a narrow pane the branch name is shortened in the middle so the base
it is compared with stays readable.

## Install

At the prompt of a terminal session:

```
/plugin install worktree-diff --marketplace sudoviber/worktree-diff
```

From a shell:

```
claude plugin install worktree-diff --marketplace sudoviber/worktree-diff
```

To run it from a local checkout for one session instead, use
`claude --plugin-dir <path to this folder>`.

## Usage

| Command | What it does |
|---|---|
| `/wt-diff` | Open the pane, or close it if it is on screen (a pane hidden behind another pane's tab is brought to the front) |
| `/wt-diff status` | Refresh, then print the changes as plain text |
| `/wt-diff refresh` | Re-read git now |
| `/wt-diff base <ref>` | Compare this worktree against `<ref>` from now on (kept across sessions) |
| `/wt-diff base` | Forget that override and go back to the inferred base |
| `/wt-diff mode all\|committed\|uncommitted` | Choose what is compared |

`/wt-diff` runs at once even while Claude is still working, so you can open the pane to watch
edits as they land.

Keys while the pane has the keyboard (ctrl+x tab, or a click): `a` / `c` / `u` switch the mode,
`r` refreshes, `x` closes every open diff. The pane prints each key next to its button.

### Modes

- **all** (default): from the merge-base with the base branch to the working tree. This covers
  commits on the branch, staged and unstaged edits, and untracked files.
- **committed**: from the merge-base to `HEAD`. This is what a pull request would show.
- **uncommitted**: from `HEAD` to the working tree. It needs no base branch, so it still lists
  changes when the base shares no history with the branch (an orphan branch, a shallow clone);
  the pane then shows that as an error above the list.

The comparison point is `git merge-base <base> HEAD`, so commits that landed on the base
branch after you branched off never show up as deletions. The header shows how far the
branch is ahead of the base (↑) and behind it (↓).

### How the base branch is found

The base is found by trying these in order. The pane header names the one that applied.

1. **override**: the ref set with `/wt-diff base <ref>` for this worktree.
2. **reflog**: the branch's creation entry, `branch: Created from <ref>`, which
   `git worktree add -b feat ../wt main` and `git checkout -b` leave behind. A start point
   written relative to a branch (`main~2`, `origin/main^`) counts as that branch. A branch
   created from `HEAD` or from something that moves with it (`HEAD~2`, `@~1`, `@{-1}`,
   `FETCH_HEAD`, `ORIG_HEAD`), or from its own remote copy, skips this step.
3. **upstream**: the branch's upstream, unless it is just the remote copy of the same branch.
4. **main-worktree**: the branch checked out in the repository's main worktree.
5. **default-branch**: `origin/HEAD`, then the first of `main`, `master`, `trunk` or `develop`
   that exists.

If none of these applies, the pane says so. You can still use **uncommitted** mode, or set a
base with `/wt-diff base <ref>`.

### When it refreshes

- After Claude's Edit, Write, MultiEdit, NotebookEdit, Bash, EnterWorktree and ExitWorktree
  tool calls (subagents' calls included), and at the end of every turn. Refreshes wait 300 ms
  for a burst of edits to settle.
- Every few seconds while the pane is on screen, to catch edits made in your editor or another
  terminal. A tick that comes while the previous read is still running is skipped, so a slow
  repository is never read back to back. Untracked files whose size and modification time have
  not changed are not read again.
- When you press refresh or switch modes.

While the pane is closed, automatic refreshes are skipped unless the status line option is on.

The mod only reads git. It runs every command with `--no-optional-locks` and
`GIT_OPTIONAL_LOCKS=0`, so it never takes `index.lock` from a git command you or Claude are
running. It also never stages anything.

## Settings

Set these in the config menu (`/config`) or under `pluginConfigs` in settings:

| Field | Default | Meaning |
|---|---|---|
| `autoOpen` | `worktree` | `worktree`: open the pane when the session starts in, or enters, a linked worktree. `always`: in any git repository. `never`: only with `/wt-diff`. |
| `pollSeconds` | `5` | How often the open pane re-reads git. `0` turns polling off. |
| `statusLine` | `false` | Show `wt +added −removed` in the status line. |

An automatic open happens only where the pane docks as a sidebar beside the conversation: the
fullscreen layout, once the terminal is 144 columns wide. Until it is that wide the pane is
not drawn and does not poll. On the main-screen layout (`CLAUDE_CODE_NO_FLICKER=0`, tmux by
default) a pane would sit inline above the prompt, so nothing opens by itself there. `/wt-diff`
opens it on any layout and at any width.

## Limits

- At most 300 files are listed, and the last row says how many more there are. Tracked
  changes fill the list first, so an untracked folder that is not in `.gitignore` yet
  (`build/`, `.venv/`) cannot push them out. Untracked files left off the list count no lines,
  so the `+` total is then lower than git's.
- A single file's diff is cut at 400 lines or 30,000 characters, and the cut is marked with
  "… N more lines".
- An untracked file over 1 MiB, or one that contains NUL bytes, is shown as binary.
- Each git command has a 15 second timeout. A failure appears in the pane as an error instead
  of the list. So does a file list longer than 4 MiB of git output.
- Control characters in a diff or a path (an ANSI escape, a form feed) are drawn as `�`.

## License

MIT. See [LICENSE](LICENSE).
