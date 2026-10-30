# worktree-diff

English | [简体中文](README.zh-CN.md)

A Claude Code mod that docks a **Changes** pane beside the conversation. It shows what a git
worktree changed compared with the branch it was created from: every file with its added and
removed line counts in a tree on the left, and the diff of the file under the cursor in a
region of its own on the right. The pane refreshes itself after Claude edits files or runs
commands, so you can follow the branch's changes without switching to another tool.

The worktree it shows is the one Claude works in, even when the session itself stays in the
main checkout and Claude edits another worktree by its path or with `cd <worktree> && …`. You
can also pin one yourself. See [Which worktree it shows](#which-worktree-it-shows).

```
feat/login                                                                       ↑3 ↓1
vs main                                                               reflog · a1b2c3d
r: refresh  t: list  z: fold

a: all   c: committed   u: uncommitted
━━━━━━────────────────────────────────────────────────────────────────────────────────
5 files  ● 2 uncommitted                                                       +10 −15
 tree                            │ diff  M src/app.ts                            +2 −2
  ▾ src/                         │ @@ 14  export function start() {
›   M ● app.ts             +2 −2 │   const port = readPort()
    A   new.ts                +2 │ - listen(3000)
    R   main.ts ← index.ts +1 −1 │ + listen(port)
  ? ● notes.md                +5 │   log('ready')
  D   old.txt                −12 │ @@ 31  export function stop() {
                                 │ - server.close()
                                 │ + server?.close()
j: down  k: up  l: open  w: diff  h: fold  q: close  d: page  b: back  g: top  e: end
```

The header names the branch, how far it is ahead of its base (↑) and behind it (↓), and the
base it is compared with. When the pane shows another worktree than the session's, a line
above the branch names it (see [The place line](#the-place-line)). Under the actions, the line beneath the mode tabs marks the current
mode, and the row after it sums up that mode's listing.

Files are shown as a tree of folders by default. A chain of folders that each hold only one
folder is drawn as one row (`src/app/api/`). A folded folder says how many files it holds and
adds up the lines changed below it. A renamed file sits under its new path, with its old name
after `←`, or its old path if it moved from another folder. The flat list always gives the old
path. `●` marks a file that has changes not committed yet. On a narrow pane long names are
shortened in the middle.

### The tree and the diff

The pane is split into a fixed top (the header, actions, mode tabs and summary), the two
regions under it, and a row of keys at the bottom. Together they are exactly as tall as the
pane, so the pane itself never scrolls: the tree and the diff each scroll on their own.

- **Side by side**, once the pane is 80 columns wide or more: the tree on the left (38% of the
  width, 28 to 48 columns), a dim `│`, and the diff in the rest.
- **One at a time** on a narrower pane: the tree or the diff fills the width, and the head row
  names both, the one shown highlighted:

  ```
   tree  diff  M src/app.ts                    +2 −2
  ```

The cursor, `›` with the name in bold, is the tree's selected row. The diff region always
shows what is under it, and follows it as it moves: the cursor stands still for 120 ms before
a file's diff is read, so holding `j` down reads only the file it stops on. The last 16 files
read are kept, so going back to one shows it at once while it is read again, in case it changed;
a refresh reads the file under the cursor again. Moving the cursor to another row, switching
modes or changing the base starts the diff at the top.

The keys act on one region at a time, and its head (` tree ` or ` diff `) is highlighted.
`w` switches between them. In the tree, `l` (or `Enter`) on a file goes to the diff; in the
diff, `h` goes back to the tree.

What the diff region shows, under a head row with the file's status, path and counts:

- A changed file: its lines in color with no background, added lines in green after `+`,
  removed lines in red after `-`, unchanged lines dim. Each hunk starts with `@@`, the line
  number it starts at in the new file, and the function it is in when git names one. A hunk
  that leaves no lines in the new file gives its line number in the old file instead, as
  `@@ −1`. To use Claude Code's own diff view instead, set `diffStyle` to `engine`.
- A new or untracked file: its source, with syntax colors and line numbers.
- A folder: the files under it, each with its status and counts; the head gives the folder's
  path, how many files it holds and their totals.
- A deleted file: one line that says how many lines it had. A binary file, a file with no
  textual changes, a diff still being read and a diff that failed each get one line too.

If a refresh drops the row the cursor is on, the cursor moves to the nearest row left, below it
first. If a fold hides it, it moves to the folder that hides it.

To open diffs under their rows in the list instead, as before version 0.4, set `diffView` to
`inline` (see [Inline view](#inline-view)).

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
| `/wt-diff status` | Refresh, then print the changes of the worktree the pane shows as plain text |
| `/wt-diff refresh` | Re-read git now |
| `/wt-diff at <path>` | Show the worktree at `<path>` instead of the one Claude works in (pin it) |
| `/wt-diff at` | Unpin, and follow the worktree Claude works in again |
| `/wt-diff base <ref>` | Compare the worktree the pane shows against `<ref>` from now on (kept across sessions) |
| `/wt-diff base` | Forget that override and go back to the inferred base |
| `/wt-diff trunk <ref>` | Name the repository's integration branch (for example `origin/feat/auth-ui`), shared by all its worktrees and kept across sessions |
| `/wt-diff trunk` | Forget the integration branch |
| `/wt-diff mode all\|committed\|uncommitted` | Choose what is compared |

`/wt-diff` runs at once even while Claude is still working, so you can open the pane to watch
edits as they land.

`/wt-diff status` always prints a flat list. When the pane shows another worktree than the
session's, its first line is `⌂ <path> · auto` or `⌂ <path> · pinned`.

### Which worktree it shows

The pane shows one worktree at a time, the first of:

1. **pinned**: a worktree you chose with `/wt-diff at <path>` or from the `o` list.
2. **followed**: the worktree Claude last worked in, other than the session's own.
3. **the session's**: the worktree the session's working directory is in.

The pinned and the followed worktree last for the session: they survive `/reload-plugins`,
and a new session starts with neither. Everything the pane does acts on the worktree it
shows: refreshes and polling, `/wt-diff status`, `/wt-diff base` and `/wt-diff trunk`. A base
set with `/wt-diff base` belongs to one worktree and a trunk to one repository, so each
worktree is compared with its own.

#### Following Claude

After each of Claude's tool calls that ran (not denied, and not failed), subagents' calls
included, the pane looks at where the call pointed:

- **Edit**, **Write**, **MultiEdit**: the folder of `file_path`. **NotebookEdit**: the folder
  of `notebook_path`. A file in a folder that does not exist yet counts from the nearest
  folder above it that does.
- **Bash**: where the `cd` (or `pushd`) commands at the start of the command land.
  `cd ../app-login && npm test` follows `../app-login`, and `cd /code/app && cd wt; make`
  follows `/code/app/wt`: each `cd` goes on from the one before, the first from the folder
  the call started in. Quotes, `~` and `--` are understood. The whole command is passed over
  when any of its leading `cd`s cannot be read for sure: a variable, `$(…)`, backticks, a
  glob or braces, a redirection, a pipe, `||`, `&`, `cd -`, or more than one operand. A `cd`
  after another command (`npm test && cd wt`) does not count, and `CDPATH` is not consulted.
  A Bash call that failed after its `cd` ran (`cd wt && npm test` with a failing test, its
  exit code in the result) is still followed, as long as the folder it landed in exists. A
  call refused before it ran (you declined it, or a hook or permission rule denied it) is not.
- Any other tool (Read, Grep, …): nothing.

The folder is turned into the root of its worktree (`git rev-parse --show-toplevel`), and the
pane follows it only if it belongs to the same repository as the session: one of its
worktrees, sharing its git directory. So when Claude writes its memory under `~/.claude`, or
edits a file in another repository, the pane stays where it is. With the session outside any
git repository, a worktree of any repository is followed. If git cannot tell which repository
the session is in (it timed out, say), the call is passed over.

A call back in the session's own worktree stops following. EnterWorktree and ExitWorktree move
the session itself, so once they change its folder the followed worktree is dropped and the
pane shows the session's new one. The git commands this takes run after the tool's result has
been handed back to Claude, one call after another, so the last call's worktree stands.

#### Pinning

- `/wt-diff at <path>` pins the worktree that `<path>` is in. The rest of the line is the path,
  spaces included, with one pair of quotes around it taken off; a relative path is read from
  the session's folder, and `~` is your home folder. Any git worktree can be pinned, of this
  repository or another. The reply is `Showing <name> (pinned)`, or `Not a path: …` or
  `Not a git worktree: …` when it cannot be shown.
- `/wt-diff at` with nothing after it unpins, and the pane follows Claude again.
- `o` in the pane opens the worktree list.

A pin wins over a followed worktree, so the pane stays put while Claude works elsewhere.

#### The worktree list

`o` lists `auto` first, then every worktree of the session's repository (of the shown one's,
when the session is in none), as `git worktree list` gives them. A bare repository and a
worktree whose folder was deleted without `git worktree remove` are left out. In the side view
the list takes the regions' place, under a ` worktrees ` head; in the inline view it takes the
file list's place.

```
 worktrees
› ✓ auto  follow Claude
  • app-login  feat/login  /code/app-login
    app  main  /code/app
    app-fix  3f2a9c1  /code/app-fix
```

Each row has the cursor `›`, a mark, the worktree's folder name, its branch (the short commit
for a detached `HEAD`) and its path, dim. On a narrow pane the path goes first, then the
branch. `✓` marks what is in force: `auto` while nothing is pinned, else the pinned worktree.
A dim `•` marks the worktree the pane shows, when it has no `✓`. The cursor starts on the `✓`.

| Key | What it does |
|---|---|
| `j` / `k` | Move the cursor down / up |
| `l` or `Enter` | Pick the row: `auto` unpins, a worktree is pinned |
| `h` or `o` | Close the list and change nothing |
| `q` | Close the pane |

A click on a row picks it too. While the list shows, the bottom row lists its keys
(`j: down  k: up  l: select  h: back  o: back  q: close`). Once it closes, the keys act where
they did before.

#### The place line

While the pane shows another worktree than the session's, a dim line above the branch names
it, with `auto` for a followed worktree and `pinned` for a pinned one:

```
⌂ app-login · auto
feat/login                                                                       ↑3 ↓1
vs main                                                               reflog · a1b2c3d
```

A pin on the session's own worktree shows the line too (`⌂ app · pinned`), so you can tell
that the pane will not follow Claude. With neither, the line is not drawn, as before 0.5.

#### When a worktree goes away

At each refresh, a pinned or followed worktree whose folder is gone, or that git says is no
longer a worktree, is dropped, and the pane goes back to the next in line: from pinned to
followed, from followed to the session's. A folder left behind inside the main checkout
(`.claude/worktrees/<name>` that a dev server writes to again) counts as gone, since git then
answers for the main checkout. The place line then says
`worktree removed — back to <name>` in the warning color, until the pane next follows or pins
a worktree. The same goes for a Bash call that removes the followed worktree from the
session's own folder (`cd <main> && git worktree remove <wt>`). A git command that only
failed (a timeout) keeps the worktree where it is.

#### Opening on its own

With `autoOpen` set to `worktree` (the default) or `always`, the first time in a session that
Claude is followed into a linked worktree (one made with `git worktree add`), the pane opens
as it does when a session starts: only where it docks as a sidebar, and without taking the
keyboard (see [Settings](#settings)). This happens once a session, the pane already being open
included, and not at all once you have closed the pane in this session, with `q`,
`/wt-diff close`, ctrl+x x or its close mark. `never` turns it off, and so does a
non-interactive session.

### Keyboard

Keys reach the pane only while it has the keyboard; otherwise they go to the prompt.
`/wt-diff` gives it the keyboard (Claude Code hands it over only while the prompt is empty, as
it is right after a command), and so do ctrl+x tab and a click on the pane. Esc gives the
keyboard back to the prompt and leaves the pane open.

| Key | In the tree | In the diff |
|---|---|---|
| `j` / `k` | Move the cursor to the next / previous row (a file or a folder); the tree scrolls to keep it in view and the diff follows it | Scroll down / up a line |
| `d` / `b` | Move the cursor half a region down / up | Scroll half a region down / up |
| `n` / `p` | — | Go to the next / previous hunk |
| `g` / `e` | Go to the first / last row | Go to the top / bottom (`e` for end: keys are read lowercase, so `G` acts as `g`) |
| `l` | On a file, go to the diff. On a folded folder, unfold it; on an open folder, go to its first row | — |
| `h` | Fold an open folder; on a file or a folded folder, go to the folder above it | Go back to the tree |
| `w` | Go to the diff | Go back to the tree |
| `o` | Open the [worktree list](#the-worktree-list) | Same |
| `Enter` | Press the row the focus is on, as a click does: on the cursor's row, a file goes to the diff and a folder folds or unfolds | Go back to the tree |
| `q` | Close the pane (ctrl+x x closes it too) | Same |
| `a` / `c` / `u` | Switch the mode | Same |
| `r` | Refresh | Same |
| `t` | Switch between the tree and a flat list (the choice is kept across sessions) | Same |
| `z` | Fold every folder, or unfold them all again | Same |
| `Tab` | Move between the rows and the buttons | Same |
| `Esc` | Give the keyboard back to the prompt | Same |

Half a region up is `b` (back), not `u`, because `u` stays the **uncommitted** tab.

The focus ring stays on the cursor's row, so `Enter` presses it. When the pane takes the
keyboard, the focus starts there, or on the first row. With one region shown and that the
diff, the ring waits on the `h` key at the bottom instead, so `Enter` goes back to the tree
there too.

The bottom row lists the keys of the region the keys act on, each with what a press does
(`w: diff` in the tree, `w: tree` in the diff). It is one row high: on a narrow pane the keys
past its end are cut off, but they still work. Without the keyboard, the terminal shows
`ctrl+x tab to focus` there instead. Each button at the top also shows its key next to its
name, named for what a press does (`t: list` in the tree, `t: tree` in the list).

### Mouse

- A click on a row of the tree moves the cursor there, and the keys act on the tree. A click
  on the row the cursor is already on, while the keys act on the tree, presses it: a file goes
  to the diff, a folder folds or unfolds.
- The wheel scrolls the region under the pointer: over the tree, the tree's rows (the cursor
  stays where it is, even out of view, and refreshes leave the tree where it is, until the next
  key brings the cursor back); over the `│` or the diff, the diff.

### Inline view

With `diffView` set to `inline` the pane works as it did before version 0.4: there is no diff
region, and a file's diff opens under its row in the list, lined up under the file's name. It
is drawn as the diff region draws it. The keys are:

| Key | What it does |
|---|---|
| `j` / `k` | Move to the next / previous row (a file or a folder) and scroll it into view. From no row, `j` goes to the first row and `k` to the last |
| `Enter` | Press the row: open or close a file's diff, fold or unfold a folder |
| `h` | Fold an open folder; on a file or a folded folder, go to the folder above it |
| `l` | Unfold a folded folder or open a file's diff; on an open folder, go to its first row |
| `g` / `e` | Go to the first / last row; `g` also scrolls the pane back to its top |
| `x` | Close every open diff |
| `o` | Open the [worktree list](#the-worktree-list) in the list's place |

`q`, `a` / `c` / `u`, `r`, `t`, `z`, `Tab` and `Esc` do what they do in the tree above. A click
on a file's name opens its diff and a second click closes it; a click on a folder row folds it.

The pane scrolls as a whole, with the arrow keys and the wheel, when its content is taller than
the pane. When the pane takes the keyboard, the focus starts on the row it was last on, or on
the first row. While the pane has the keyboard it lists `j` `k` `h` `l` `g` `e` `q` `o` at its
bottom, or under the buttons at the top when the listing is taller than the pane; there they
show when the pane opens and scroll away with the rows, and `g` brings them back.

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
  for a burst of edits to settle. A call that moves the pane to another worktree refreshes it
  too.
- Every few seconds while the pane is on screen, to catch edits made in your editor or another
  terminal. A tick that comes while the previous read is still running is skipped, so a slow
  repository is never read back to back. Untracked files whose size and modification time have
  not changed are not read again.
- When you press refresh or switch modes, and when you pin or unpin a worktree.

Every refresh reads the worktree the pane shows.

While the pane is closed, automatic refreshes are skipped unless the status line option is on.

The mod only reads git. It runs every command with `--no-optional-locks` and
`GIT_OPTIONAL_LOCKS=0`, so it never takes `index.lock` from a git command you or Claude are
running. It also never stages anything.

## Settings

Set these in the config menu (`/config`) or under `pluginConfigs` in settings:

| Field | Default | Meaning |
|---|---|---|
| `autoOpen` | `worktree` | `worktree`: open the pane when the session starts in, or enters, a linked worktree, or the first time Claude is followed into one. `always`: in any git repository, and on that first follow too. `never`: only with `/wt-diff`. |
| `pollSeconds` | `5` | How often the open pane re-reads git. `0` turns polling off. |
| `statusLine` | `false` | Show the file count and line totals, such as `· 5 files +202 −34`, at the end of the hint line under the prompt. On a surface that does not draw that line, such as the desktop app, they appear in the status line instead; while the desktop app is attached, the terminal shows them in both places. |
| `diffView` | `side` | `side`: the diff of the file under the cursor in a region of its own, beside the tree or, on a narrow pane, in its place. `inline`: a file's diff opens under its row in the list, as before version 0.4. |
| `diffStyle` | `quiet` | `quiet`: a changed file's lines in green and red text, with no background. `engine`: Claude Code's own diff view, with syntax colors and line numbers. New files are shown as source either way. |
| `paneBackground` | `transparent` | `transparent`: the pane draws no fill of its own, so your terminal's background (color, image or blur) shows through and the pane blends with the conversation. `theme`: Claude Code's own pane fill. |

An automatic open happens only where the pane docks as a sidebar beside the conversation: the
fullscreen layout, once the terminal is 144 columns wide. Until it is that wide the pane is
not drawn and does not poll. On the main-screen layout (`CLAUDE_CODE_NO_FLICKER=0`, tmux by
default) a pane would sit inline above the prompt, so nothing opens by itself there. `/wt-diff`
opens it on any layout and at any width.

With `diffView` set to `side`, the pane asks the dock to be 120 columns wide. Claude Code holds
a docked pane to 45% of the terminal, so the tree and the diff sit side by side (80 columns of
pane) once the terminal is about 178 columns wide; on a 200-column terminal the pane gets about
90. A width you drag the dock to wins over the request. The inline view asks for no width.

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
- A line of a diff wider than its region (or the pane, in the inline view) is cut at the edge
  with `…`. There is no scrolling sideways.
- Claude Code does not redraw a pane when only its height changes. After you make the terminal
  taller or shorter, the regions keep their old height until something in the pane changes: a
  key, a click, or a refresh that finds new changes.
- A pane too short for the top, a region head, one row of each region and the key row draws
  past its bottom; it then scrolls as a whole, and the wheel scrolls the whole pane.
- The pane's line-drawing glyphs (the `─━` rule under the tabs, the `│` between the regions, `●`,
  `↑↓`, `←`) are East Asian Ambiguous width. A terminal set to draw ambiguous characters as
  wide gives each two cells, so the rule wraps onto a second line and right-aligned counts
  shift.

## License

MIT. See [LICENSE](LICENSE).
