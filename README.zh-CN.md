# worktree-diff

[English](README.md) | 简体中文

一个 Claude Code mod：在对话旁边停靠一个 **Changes** 面板，显示当前 git worktree 相对于它的来源分支改了什么。面板里列出每个文件的增删行数，点开任意文件即可查看它的 unified diff。Claude 改完文件或执行命令后，面板会自动刷新，不用切到别的工具就能跟上分支上的改动。

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

头部第一行是分支名，以及它领先 base 多少个提交（↑）、落后多少个（↓）。第二行是对比的 base 分支。操作按钮下面是模式标签，标签下的横线标出当前模式，再下一行是当前模式下的文件数和增删行数合计。

文件默认按目录树显示。一串只含一个子目录的目录会合并成一行（如 `src/app/api/`）。点目录行可以折叠，折叠后会显示里面有几个文件，以及下面所有改动的行数合计。改名的文件放在新路径下，`←` 后面是旧文件名；如果是从别的目录移过来的，则显示旧路径。平铺列表视图里始终显示旧路径。

`●` 表示这个文件还有没提交的改动。点文件名打开它的 diff，再点一次关闭。面板较窄时，过长的名字会从中间省略。

打开的 diff 与文件名左对齐。修改过的文件只用前景色区分，不铺底色：新增行是绿色、以 `+` 开头，删除行是红色、以 `-` 开头，未改动的行变暗。每个 hunk 以 `@@` 开头，后面是它在新文件中的起始行号，git 能识别时还会附上所在的函数名。如果某个 hunk 在新文件里一行都没留下，就改为显示它在旧文件中的行号，写作 `@@ −1`。新增文件和未跟踪文件按源码显示，带语法高亮和行号。删除的文件只显示一行，说明它原来有多少行。想改用 Claude Code 自带的 diff 视图，把 `diffStyle` 设为 `engine`。

## 安装

在终端里的 Claude Code 输入框中执行：

```
/plugin install worktree-diff --marketplace sudoviber/worktree-diff
```

或者在 shell 里执行：

```
claude plugin install worktree-diff --marketplace sudoviber/worktree-diff
```

如果只想在某一个 session 里从本地代码加载，用 `claude --plugin-dir <本仓库目录>`。

把已安装的版本更新到最新，在 shell 里执行：

```
claude plugin update worktree-diff
```

然后在已经打开的 session 里执行 `/reload-plugins`，不用重启就能加载新版本。

## 用法

| 命令 | 作用 |
|---|---|
| `/wt-diff` | 打开面板并把键盘交给它（面板被别的面板的 tab 挡住时会被提到前面） |
| `/wt-diff close` | 关闭面板 |
| `/wt-diff status` | 刷新后以纯文本输出改动 |
| `/wt-diff refresh` | 立即重新读取 git |
| `/wt-diff base <ref>` | 此后把这个 worktree 和 `<ref>` 对比（跨 session 保留） |
| `/wt-diff base` | 清除上面的设置，回到自动推断的 base |
| `/wt-diff trunk <ref>` | 指定仓库的集成分支（如 `origin/feat/auth-ui`），仓库里所有 worktree 共用，跨 session 保留 |
| `/wt-diff trunk` | 清除集成分支设置 |
| `/wt-diff mode all\|committed\|uncommitted` | 选择对比范围 |

Claude 还在工作时，`/wt-diff` 也会立即执行，所以可以边打开面板边看改动陆续出现。

`/wt-diff status` 始终输出平铺列表。

### 键盘操作

只有面板拿到键盘时，按键才会作用到面板上，否则会打进输入框。`/wt-diff`、ctrl+x tab、用鼠标点面板，都能把键盘交给面板。Claude Code 只在输入框为空时才会把键盘交出去，刚执行完一条命令时输入框正好是空的。按 Esc 把键盘还给输入框，面板保持打开。

| 键 | 作用 |
|---|---|
| `j` / `k` | 移到下一行 / 上一行（文件或目录），并滚动到可见位置。当前不在任何行上时，`j` 去第一行，`k` 去最后一行 |
| `Enter` | 按下当前行：打开或关闭文件的 diff，折叠或展开目录 |
| `h` | 折叠已展开的目录；在文件或已折叠的目录上时，跳到上一级目录 |
| `l` | 展开已折叠的目录，或打开文件的 diff；在已展开的目录上时，跳到它的第一行 |
| `g` / `e` | 跳到第一行 / 最后一行；`g` 同时把面板滚回顶部（`e` 取 end 之意：按键一律按小写读取，所以 `G` 等同于 `g`，会回到顶部） |
| `q` | 关闭面板（ctrl+x x 也可以） |
| `a` / `c` / `u` | 切换模式 |
| `r` | 刷新 |
| `t` | 在目录树和平铺列表之间切换（选择会跨 session 保留） |
| `z` | 折叠全部目录，再按一次全部展开 |
| `x` | 关闭所有已打开的 diff |
| `Tab` | 在各行和按钮之间移动 |
| `Esc` | 把键盘还给输入框 |

内容超过面板高度时，方向键用来滚动面板；`j` 和 `k` 用来在行之间移动。面板拿到键盘时，焦点落在上次停留的那一行，没有的话落在第一行。

每个按钮在名字旁边标出自己的按键，名字表示按下后会做什么（目录树里显示 `t: list`，平铺列表里显示 `t: tree`）。面板拿着键盘时，底部还会列出 `j` `k` `h` `l` `g` `e` `q`。如果列表比面板还高，这一行改放在顶部按钮下面：面板打开时可以看到，随列表滚动会滚走，按 `g` 就能回来。面板没有键盘时，终端在同一位置显示 `ctrl+x tab to focus`。

### 模式

- **all**（默认）：从与 base 分支的 merge-base 到工作区。包括分支上的提交、已暂存和未暂存的修改，以及未跟踪文件。
- **committed**：从 merge-base 到 `HEAD`，也就是一个 pull request 会显示的内容。
- **uncommitted**：从 `HEAD` 到工作区。这个模式不需要 base 分支，所以即使 base 和当前分支没有共同历史（孤儿分支、浅克隆），它也能列出改动；此时面板会在列表上方显示一条错误提示。

对比点是 `git merge-base <base> HEAD`，所以你拉出分支之后 base 分支上新增的提交，不会显示成被删除。头部显示分支领先 base 多少（↑）、落后多少（↓）。

### base 分支怎么确定

插件按顺序尝试下面几种来源，用第一个能得到结果的，面板头部会标出用的是哪一种。linked worktree（用 `git worktree add` 建的）和仓库的主 checkout 用两套不同的顺序，因为主 checkout 往往就停在集成分支上。

在 linked worktree 里：

1. **override**：用 `/wt-diff base <ref>` 给这个 worktree 设置的 ref。
2. **reflog**：分支的创建记录 `branch: Created from <ref>`，`git worktree add -b feat ../wt main` 和 `git checkout -b` 都会留下这条记录。相对某个分支写的起点（`main~2`、`origin/main^`）按那个分支算。如果分支是从 `HEAD`、从会随 HEAD 变化的写法（`HEAD~2`、`@~1`、`@{-1}`、`FETCH_HEAD`、`ORIG_HEAD`），或者从它自己的远程副本建出来的，跳过这一步。
3. **upstream**：分支的 upstream，但如果它只是同一个分支的远程副本，则跳过。
4. **trunk**：用 `/wt-diff trunk <ref>` 设置的集成分支，但如果它就是当前分支或其远程副本，则跳过。
5. **main-worktree**：仓库主 worktree 上 checkout 的那个分支。
6. **default-branch**：先试 `origin/HEAD`，再依次试 `main`、`master`、`trunk`、`develop`，取第一个存在的。

在主 checkout 里：

1. **override**，同上。
2. **reflog**，同上，另外多一条：如果分支是从 `HEAD` 建的（`git checkout -b feat` 没写起点），就从 `HEAD` 自己的 reflog 里找出建分支那一刻 `HEAD` 所在的分支。当前就在 trunk 上时跳过这一步。
3. **trunk**，但如果它就是当前分支或其远程副本，则跳过。
4. **upstream**：分支自己的 upstream，即使它就是同一个分支的远程副本。这时面板显示的是还没推送的提交和还没提交的改动。只有在以下情况才会走到这一步：分支的创建记录已经没了（reflog 过期，或者分支是 clone 时带来的）；创建记录指向它自己的远程副本；或者当前分支就是 trunk。
5. **default-branch**，同上。

所以一直停在集成分支上的主 checkout，不需要任何设置就能看到自己还没推送的内容。如果推断出的 base 不对，可以用 `/wt-diff trunk <ref>` 一次性设好集成分支，或者用 `/wt-diff base <ref>` 只给当前 worktree 指定 base。trunk 必须是一个在每个 worktree 里都指向同一个东西的分支、tag 或 commit，所以 `HEAD`、`@{u}`、`main~1` 这类写法会被拒绝。

如果以上都不适用，面板会明确说明。这时仍然可以用 **uncommitted** 模式，或者用 `/wt-diff base <ref>` 指定 base。

### 什么时候刷新

- Claude 每次调用 Edit、Write、MultiEdit、NotebookEdit、Bash、EnterWorktree、ExitWorktree 之后（包括子 agent 的调用），以及每一轮结束时。刷新会等 300 毫秒，让连续的编辑先落定。
- 面板显示在屏幕上时，每隔几秒刷新一次，用来发现你在编辑器或别的终端里做的修改。如果上一次读取还没结束，这一次就跳过，所以即使仓库很慢，也不会接连不断地读 git。大小和修改时间都没变的未跟踪文件不会重复读取。
- 按下刷新或切换模式时。

面板关闭时，除非打开了状态栏选项，否则不做自动刷新。

这个 mod 只读 git。所有命令都带 `--no-optional-locks` 和 `GIT_OPTIONAL_LOCKS=0`，不会和你或 Claude 正在跑的 git 命令抢 `index.lock`，也从不暂存任何东西。

## 设置

在配置菜单（`/config`）里设置，或者写在 settings 的 `pluginConfigs` 下：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `autoOpen` | `worktree` | `worktree`：session 在 linked worktree 里启动或进入 linked worktree 时打开面板。`always`：在任何 git 仓库里都打开。`never`：只在执行 `/wt-diff` 时打开。 |
| `pollSeconds` | `5` | 面板打开时重新读取 git 的间隔（秒）。`0` 关闭轮询。 |
| `statusLine` | `false` | 在输入框下方提示行的末尾显示文件数和增删行数合计，如 `· 5 files +202 −34`。在不画这一行的界面上（比如桌面应用），改为显示在状态栏里；桌面应用连着时，终端会在两处都显示。 |
| `diffStyle` | `quiet` | `quiet`：修改过的文件用绿色和红色文字显示改动行，不铺底色。`engine`：使用 Claude Code 自带的 diff 视图，带语法高亮和行号。新增文件无论哪种设置都按源码显示。 |
| `paneBackground` | `transparent` | `transparent`：面板不画自己的底色，透出终端本身的背景（颜色、背景图或毛玻璃），和对话区融为一体。`theme`：使用 Claude Code 自带的面板底色。 |

只有当面板会作为侧边栏停靠在对话旁边时，才会自动打开：也就是 fullscreen 布局，并且终端宽度达到 144 列。宽度不够时面板不会画出来，也不会轮询。在主屏布局下（`CLAUDE_CODE_NO_FLICKER=0`，tmux 默认就是这种），面板会出现在输入框上方而不是侧边，所以不会自动打开。`/wt-diff` 在任何布局、任何宽度下都能打开它。

## 限制

- 最多列出 300 个文件，最后一行会说明还有多少个没列出。已跟踪文件的改动优先占用名额，所以还没加进 `.gitignore` 的未跟踪目录（`build/`、`.venv/`）不会把它们挤出列表。没列出的未跟踪文件不计行数，这时 `+` 的合计会比 git 的结果少。
- 单个文件的 diff 超过 400 行或 30,000 个字符时会被截断，截断处标注「… N more lines」。
- 超过 1 MiB 或含有 NUL 字节的未跟踪文件按二进制文件显示。
- 每条 git 命令的超时是 15 秒。失败时面板显示错误信息而不是文件列表；git 输出的文件列表超过 4 MiB 时也一样。
- diff 或路径里的控制字符（ANSI 转义、换页符等）显示为 `�`。修改过的文件里，tab 会展开成空格，对齐到下一个 4 列的倍数，宽字符（中日韩文字）按 2 列计算。
- 比面板还宽的 diff 行会在边缘截断，以 `…` 结尾。
- 面板里的线条和符号（标签下的 `─━`、`●`、`▾`、`↑↓`、`←`）属于 East Asian Ambiguous 宽度。如果终端设置成把这类字符画成双宽，每个字符会占两格，标签下的横线会折到第二行，右对齐的计数也会错位。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
