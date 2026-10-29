# worktree-diff

English | [简体中文](README.zh-CN.md)

A Claude Code mod that docks a **Changes** pane beside the conversation. It shows what the
current git worktree changed compared with the branch it was created from: every file with
its added and removed line counts, and the unified diff of any file you open. The pane
refreshes itself after Claude edits files or runs commands, so you can follow the branch's
changes without switching to another tool.

```
feat/login                           ↑3 ↓1
vs main                   reflog · a1b2c3d
r: refresh  t: list  z: fold  x: collapse

a: all   c: committed   u: uncommitted
━━━━━━────────────────────────────────────
5 files  ● 2                        +9 −14
▾ src/
  M ● app.ts                         +1 −1
      @@ 14  export function start() {
        const port = readPort()
      - listen(3000)
      + listen(port)
        log('ready')

  A   new.ts                            +2
      1 export const greet = (name) =>
      2   `Hello, ${name}`

  R   main.ts ← index.ts             +1 −1

? ● notes.md                            +5
D   old.txt                            −12
```

The header names the branch, how far it is ahead of its base (↑) and behind it (↓), and the
base it is compared with. Under the actions, the line beneath the mode tabs marks the current
mode, and the row after it sums up that mode's listing.

Files are shown as a tree of folders by default. A chain of folders that each hold only one
folder is drawn as one row (`src/app/api/`). Press a folder row to fold it; a folded folder
says how many files it holds and adds up the lines changed below it. A renamed file sits
under its new path, with its old name after `←`, or its old path if it moved from another
folder. The flat list always gives the old path.

`●` marks a file that has changes not committed yet. Press a file's name to open its diff and
press it again to close it. On a narrow pane long names are shortened in the middle.

An open diff lines up under the file's name. A changed file's lines are drawn in color with no
background: added lines in green after `+`, removed lines in red after `-`, unchanged lines dim.
Each hunk starts with `@@`, the line number it starts at in the new file, and the function it
is in when git names one. A hunk that leaves no lines in the new file gives its line number in
the old file instead, as `@@ −1`. A new or untracked file is shown as source, with syntax colors and
line numbers. A deleted file gets one line that says how many lines it had. To use Claude
Code's own diff view instead, set `diffStyle` to `engine`.

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

To update an installed copy to the latest version, run this from a shell:

```
claude plugin update worktree-diff
```

Then run `/reload-plugins` in any open session to load the new version without restarting it.

## Usage

| Command | What it does |
|---|---|
| `/wt-diff` | Open the pane and give it the keyboard (a pane hidden behind another pane's tab is brought to the front) |
| `/wt-diff close` | Close the pane |
| `/wt-diff status` | Refresh, then print the changes as plain text |
| `/wt-diff refresh` | Re-read git now |
| `/wt-diff base <ref>` | Compare this worktree against `<ref>` from now on (kept across sessions) |
| `/wt-diff base` | Forget that override and go back to the inferred base |
| `/wt-diff trunk <ref>` | Name the repository's integration branch (for example `origin/feat/auth-ui`), shared by all its worktrees and kept across sessions |
| `/wt-diff trunk` | Forget the integration branch |
| `/wt-diff mode all\|committed\|uncommitted` | Choose what is compared |

`/wt-diff` runs at once even while Claude is still working, so you can open the pane to watch
edits as they land.

`/wt-diff status` always prints a flat list.

### Keyboard

Keys reach the pane only while it has the keyboard; otherwise they go to the prompt.
`/wt-diff` gives it the keyboard (Claude Code hands it over only while the prompt is empty, as
it is right after a command), and so do ctrl+x tab and a click on the pane. Esc gives the
keyboard back to the prompt and leaves the pane open.

| Key | What it does |
|---|---|
| `j` / `k` | Move to the next / previous row (a file or a folder) and scroll it into view. From no row, `j` goes to the first row and `k` to the last |
| `Enter` | Press the row: open or close a file's diff, fold or unfold a folder |
| `h` | Fold an open folder; on a file or a folded folder, go to the folder above it |
| `l` | Unfold a folded folder or open a file's diff; on an open folder, go to its first row |
| `g` / `e` | Go to the first / last row; `g` also scrolls the pane back to its top (`e` for end: keys are read lowercase, so `G` acts as `g` and goes to the top) |
| `q` | Close the pane (ctrl+x x closes it too) |
| `a` / `c` / `u` | Switch the mode |
| `r` | Refresh |
| `t` | Switch between the tree and a flat list (the choice is kept across sessions) |
| `z` | Fold every folder, or unfold them all again |
| `x` | Close every open diff |
| `Tab` | Move between the rows and the buttons |
| `Esc` | Give the keyboard back to the prompt |

The arrow keys scroll the pane when its content is taller than the pane; `j` and `k` move
between rows. When the pane takes the keyboard, the focus starts on the row it was last on, or
on the first row.

Each button shows its key next to its name, named for what a press does (`t: list` in the tree,
`t: tree` in the list). While the pane has the keyboard it also lists `j` `k` `h` `l` `g` `e`
`q` at its bottom, or under the buttons at the top when the listing is taller than the pane;
there they show when the pane opens and scroll away with the rows, and `g` brings them back.
Otherwise the terminal shows `ctrl+x tab to focus` there.

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

The base is found by trying a list of sources in order, and the pane header names the one
that applied. A linked worktree (one made with `git worktree add`) and the repository's main
checkout use different lists, because the main checkout often sits on the integration branch
itself.

In a linked worktree:

1. **override**: the ref set with `/wt-diff base <ref>` for this worktree.
2. **reflog**: the branch's creation entry, `branch: Created from <ref>`, which
   `git worktree add -b feat ../wt main` and `git checkout -b` leave behind. A start point
   written relative to a branch (`main~2`, `origin/main^`) counts as that branch. A branch
   created from `HEAD` or from something that moves with it (`HEAD~2`, `@~1`, `@{-1}`,
   `FETCH_HEAD`, `ORIG_HEAD`), or from its own remote copy, skips this step.
3. **upstream**: the branch's upstream, unless it is just the remote copy of the same branch.
4. **trunk**: the integration branch set with `/wt-diff trunk <ref>`, unless it is this branch
   or its remote copy.
5. **main-worktree**: the branch checked out in the repository's main worktree.
6. **default-branch**: `origin/HEAD`, then the first of `main`, `master`, `trunk` or `develop`
   that exists.

In the main checkout:

1. **override**, as above.
2. **reflog**, as above, with one addition: for a branch created from `HEAD` (`git checkout -b
   feat` with no start point), the branch `HEAD` was on at that moment, read from `HEAD`'s own
   reflog. This step is skipped while you are on the trunk itself.
3. **trunk**, unless it is this branch or its remote copy.
4. **upstream**: the branch's own upstream, even when it is the remote copy of the same branch.
   The pane then shows what is not pushed yet plus what is not committed. This step is taken
   only when the branch has no creation entry left (its reflog expired, or it came from a
   clone), when the creation entry names its own remote copy, or when the branch is the trunk.
5. **default-branch**, as above.

So a main checkout that stays on the integration branch shows its unpushed work with no setup.
If the inferred base is wrong, set the integration branch once with `/wt-diff trunk <ref>`, or
set this worktree's base with `/wt-diff base <ref>`. The trunk must be a branch, tag or commit
that names the same thing in every worktree, so `HEAD`, `@{u}` and `main~1` are refused.

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
| `statusLine` | `false` | Show the file count and line totals, such as `· 5 files +202 −34`, at the end of the hint line under the prompt. On a surface that does not draw that line, such as the desktop app, they appear in the status line instead; while the desktop app is attached, the terminal shows them in both places. |
| `diffStyle` | `quiet` | `quiet`: a changed file's lines in green and red text, with no background. `engine`: Claude Code's own diff view, with syntax colors and line numbers. New files are shown as source either way. |
| `paneBackground` | `transparent` | `transparent`: the pane draws no fill of its own, so your terminal's background (color, image or blur) shows through and the pane blends with the conversation. `theme`: Claude Code's own pane fill. |

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
- Control characters in a diff or a path (an ANSI escape, a form feed) are drawn as `�`. In a
  changed file's lines a tab is drawn as spaces up to the next multiple of four columns, with a
  wide (CJK) character counting two.
- A line of a diff wider than the pane is cut at the edge with `…`.
- The pane's line-drawing glyphs (the `─━` rule under the tabs, `●`, `▾`, `↑↓`, `←`) are East Asian
  Ambiguous width. A terminal set to draw ambiguous characters as wide gives each two cells, so
  the rule wraps onto a second line and right-aligned counts shift.

## License

MIT. See [LICENSE](LICENSE).
