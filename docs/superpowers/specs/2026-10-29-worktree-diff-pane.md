# worktree-diff：Claude Code 侧边栏显示 worktree 相对来源分支的改动

日期：2026-10-29
状态：用户已授权直接实现（"开始吧，我睡觉了"），以下设计决策由 Claude 代定，有分歧处在「决策记录」里说明。

## 目标

在 Claude Code（终端 fullscreen 布局）右侧停靠一个 pane，实时显示**当前 session 所在 worktree 相对它的来源分支**的全部改动：
文件列表 + 增删行数，点开单个文件看 unified diff。Claude 改完文件后自动刷新，不需要切到别的工具。

## 形态

Claude Code mod（function hooks 插件），名字 `worktree-diff`：

```
worktree-diff/
  .claude-plugin/plugin.json      name/version/description/types/userConfig
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              事件 hook、命令、pane 渲染、刷新调度
  hooks/git.ts                    纯 git 逻辑：跑命令、解析输出、算快照（不依赖 UI）
  hooks/*.test.ts(x)              claude plugin test 跑的测试
  types/index.d.ts                $.state 契约 + 共享类型
```

开发目录：`~/.claude/dev-mods/<session-id>/worktree-diff/`（引擎热加载这里）。
完成后同步一份到本仓库根目录（仓库根即插件根，可做 marketplace）。

## 核心语义

### 1. 定位仓库
- 每次刷新都重新取 `$.session.cwd()`（EnterWorktree / `/cd` 会改变它），`git rev-parse --show-toplevel` 得到 worktree 根，之后所有 git 命令都以根为 cwd。
- `git rev-parse --git-dir` ≠ `--git-common-dir`（都 `--path-format=absolute`）⇒ 是 linked worktree。主 checkout 也能用（对比默认分支），非 git 目录显示空状态。
- `git rev-parse --abbrev-ref HEAD`；`HEAD` 表示 detached。

### 2. 推断来源分支（base），按优先级
1. **用户覆盖**：`/wt-diff base <ref>` 设定，存在 `$.store`，key 为 `base:<worktree 根绝对路径>`，跨 session 保留。`/wt-diff base`（无参数）清除。
2. **分支 reflog**：`git reflog show --format=%gs refs/heads/<branch>` 的**最后一行**（最早一条）形如 `branch: Created from <X>`。X 不是 `HEAD`、且 `git rev-parse --verify --quiet <X>^{commit}` 成功 ⇒ base = X。（`git worktree add -b feat path main` 会留下 `Created from main`。）
3. **upstream**：`git rev-parse --abbrev-ref <branch>@{upstream}`，若去掉 remote 前缀后与当前分支名不同（不是"自己的远程副本"）⇒ base = upstream。
4. **主 worktree 的分支**：`git worktree list --porcelain` 第一条的 `branch refs/heads/<X>`，X 存在且 ≠ 当前分支 ⇒ base = X。
5. **默认分支**：`git symbolic-ref --short refs/remotes/origin/HEAD`（如 `origin/main`）；否则依次试本地 `main`、`master`、`trunk`、`develop`，第一个存在且 ≠ 当前分支的。
6. 都失败 ⇒ 无 base，空状态提示 `/wt-diff base <ref>`。
- 快照记录 `base.source`（override/reflog/upstream/main-worktree/default-branch），在 pane 头部以小字显示，方便用户知道是怎么推断的。

### 3. 对比点
- 用 **merge-base**（`git merge-base <base> HEAD`），不是 base 的最新提交：来源分支之后的新提交不会显示成"被删掉"。
- 同时显示 ahead/behind：`git rev-list --left-right --count <base>...HEAD` ⇒ 「↑ahead ↓behind」。

### 4. 三种模式（`mode`，默认 `all`）
| mode | 含义 | numstat 命令 |
|---|---|---|
| `all` | merge-base → 工作区（含已提交 + 暂存 + 未暂存 + 未跟踪） | `git diff --numstat -z -M <mb>` + 未跟踪 |
| `committed` | merge-base → HEAD（分支上的提交） | `git diff --numstat -z -M <mb> HEAD` |
| `uncommitted` | HEAD → 工作区（还没提交的） | `git diff --numstat -z -M HEAD` + 未跟踪 |

- 状态字母用同参数的 `--name-status -z -M`。
- 未跟踪：`git ls-files --others --exclude-standard -z`，状态 `?`，行数用 `$.fs.read` 读文件数换行（大于 1 MiB 或含 NUL 视为 binary / 不计行数）。
- `all` 模式下每个文件额外标注 `layer`：只在提交里改了（committed）、只在工作区改了（uncommitted）、两者都有（both）。由 `<mb>..HEAD` 与 `HEAD..工作区` 两份 name 列表求得。pane 里 uncommitted/both 的文件带一个 `●` 标记（"还没提交"）。
- 所有 git 调用：`git -c core.quotePath=false --no-optional-locks ...`、`diff` 加 `--no-color --no-ext-diff`，环境变量 `GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`：**不抢 index.lock**，不和用户/Claude 正在跑的 git 命令冲突，也不被用户的 diff 配置影响。
- 二进制文件：numstat 为 `-\t-`，记 `isBinary`，展开时显示 "Binary file"。

### 5. 单文件 diff（按需加载）
- 点文件行才加载，缓存在 `$.state`，刷新时只重拉已展开的文件。
- 跟踪文件：`git diff --no-color --no-ext-diff -M <spec> -- <path>`（rename 时带上 oldPath）。
- 未跟踪：`git diff --no-color --no-index -- /dev/null <path>`（退出码 1 属正常）。
- 渲染用 `Code format="diff"`，只传 `@@` 起的 hunk（去掉 `diff --git`/`index`/`---`/`+++` 头）；单文件超过 400 行或 30k 字符截断，并提示 "… N more lines — open in editor"。整个 pane 文本预算 < 90k 字符（引擎每棵树只画前 100k）。

### 6. 刷新调度
- 触发：
  - `tool.call` 之后（`await next(e)` 完成后）：Edit、Write、MultiEdit、NotebookEdit、Bash、EnterWorktree、ExitWorktree。注意要包括子 agent 的调用（同一 worktree 被改）。
  - `turn.complete`。
  - 定时轮询：userConfig `pollSeconds`（默认 5，0 关闭），只在 pane 打开时跑——捕捉用户在编辑器/别的终端里的改动。
  - pane 上的「refresh」按钮 / `r` 热键 / `/wt-diff refresh`。
- 去抖 300ms；同一时间只跑一个刷新，跑的时候又来请求就在结束后再跑一次（不排队多次）。
- 只在结果真正变化时写 `$.state`（比较签名），避免无意义重绘。
- 单条 git 命令超时 15s；失败写入 `snapshot.error` 显示在 pane 里，不抛。

### 7. Pane
- id `worktree-diff`，title `Changes`。
- 自动打开（userConfig `autoOpen`，`worktree`(默认) | `always` | `never`）：
  - `worktree`：session.start 时、以及 EnterWorktree 之后，cwd 是 linked worktree 就 `$.ui.open`（不等待结果）。
  - `always`：在任何 git 仓库都打开。
  - 引擎规则：未经请求的打开要终端 ≥144 列才放置，否则等待——这是引擎行为，不用处理。
- `/wt-diff`：打开（已打开则关闭）。`/wt-diff status`：返回纯文本摘要（同时便于 `claude -p` 端到端测试）。
- 布局（宽度按 `e.props.bodyColumns` 自适应，路径过长从中间省略 `src/…/file.ts`）：
  ```
  feat/login → main   reflog · a1b2c3d
  ↑3 ↓1 · 5 files · +120 −34
  [all] committed  uncommitted   [⟳]
  M ● src/app.ts                +12 −3
  A   src/new.ts                   +40
  R   old.ts → new.ts            +1 −1
  ?   notes.md                      +5
  ▾ 展开的文件下方显示 Code diff
  ```
  - 每个文件行是一个 `plain` Button（`key` = `file:<path>`），按下切换展开。
  - 模式切换 3 个 Button（hotkey `a`/`c`/`u`），刷新 Button（hotkey `r`），全部折叠（hotkey `x`）。
  - 增删数用颜色：`+` green / `−` red（用主题 key `success`/`error` 如果存在，否则原色名）。
  - 空状态：不是 git 仓库 / 找不到 base / 没有改动（"No changes vs main"）/ git 出错。
  - 文件超过 300 个只列前 300，末行写 "… N more files"。
- 多 surface：terminal 为主；desktop/vscode/mobile 用 `$.ui.resolve(e)` 拿到的元素，不用 surface 没有的元素。

### 8. 状态（`$.state`，契约在 types/index.d.ts）
- `snapshot`：最新快照（`Shaped<Snapshot | null>`）。
- `mode`：`'all' | 'committed' | 'uncommitted'`。
- `expanded`：展开的文件路径列表。
- `diffs`：`Record<path, FileDiff>` 已加载的单文件 diff。
- `isRefreshing`：头部显示一个小的 `…`。
- 模块变量（热重载会丢）只放调度用的计时器/锁，丢了也会在 session.start 重建。

### 9. userConfig
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoOpen` | string，options `worktree`/`always`/`never` | `worktree` | 何时自动打开 pane |
| `pollSeconds` | number | 5 | pane 打开时的轮询间隔，0 关闭 |
| `statusLine` | boolean | false | 是否在状态栏显示 `wt +120 −34` |

## 决策记录（用户睡觉中，Claude 代定）
- **用 merge-base 而不是 base tip**：符合 GitHub PR 的 "Files changed" 语义，用户最常见的心智模型。
- **默认 `all` 模式含未提交改动**：用户的痛点是"Claude 改完文件看不到改动"，改动大多还没提交。
- **base 推断用 reflog 优先**：`git worktree add -b <branch> <path> <base>` 会留下 `Created from <branch>`；Claude Code 自己的 EnterWorktree 可能只留 `Created from HEAD`，此时退到主 worktree 的分支（通常就是来源分支）。推断错了可用 `/wt-diff base <ref>` 覆盖并持久化。
- **不改 index、不写仓库**：只读 git，`--no-optional-locks`；绝不 `git add -N`。
- **不做 agent 视图切换**（查看子 agent transcript 时显示它的 worktree）：AgentInfo 不暴露 worktreePath，留作后续。
- **不做"在编辑器打开"**：避免依赖用户编辑器配置；按钮可后续加。
- **与内置 diff 面板的区别**：Claude Code 自带的 diff 面板对比的是本 session 的编辑；本 mod 对比的是整个分支相对来源分支，二者互补。

## 验收
1. `claude plugin validate` 无错误；`tsc -p` 类型检查通过。
2. `claude plugin test` 全绿：git 输出解析（numstat/name-status -z、rename、binary、未跟踪、reflog、worktree list）、base 推断各分支、快照计算（mock `process.run`）、pane 在 terminal/desktop 渲染文件列表/空状态/展开 diff、模式切换、命令。
3. 端到端：在 scratchpad 建真实仓库 + `git worktree add -b feat`，做提交、未提交修改、未跟踪文件、rename、binary，用 `claude -p --plugin-dir <mod> "/wt-diff status"` 拿到的摘要与 `git diff` 结果一致。
