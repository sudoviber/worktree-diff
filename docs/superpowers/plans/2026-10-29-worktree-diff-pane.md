# worktree-diff 实施计划

Spec：`docs/superpowers/specs/2026-10-29-worktree-diff-pane.md`
Mod 目录（热加载）：Claude Code 会话的 dev-mods 目录 `~/.claude/dev-mods/<session-id>/worktree-diff`
已就绪：`.claude-plugin/plugin.json`、`hooks/hooks.json`、`types/index.d.ts`（共享类型 + `$.state` 契约）

检查命令（每个任务都要跑）：
- `claude plugin validate <mod>`
- `claude plugin test <mod>`
- 类型检查：在 mod 目录外放一个 tsconfig（取 API 类型文件头部的模板，include 该类型文件和 mod 的 `hooks/`、`types/`），`npx -y -p typescript@5.6.3 tsc -p <该目录>`（mod 被引擎加载后也可 `tsc -p <mod>`）

## T1 git 逻辑（hooks/git.ts + hooks/git.test.ts）
纯逻辑，不 import UI。导出：
- `type Runner = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>`
- `type GitDeps = { run: Runner; readText: (absPath: string) => Promise<string | null>; fileSize: (absPath: string) => Promise<number | null>; now: () => Promise<number> }`
- 解析函数：`parseNumstatZ`、`parseNameStatusZ`、`parseReflogCreatedFrom`、`parseWorktreeListPorcelain`、`splitHunks`（取第一个 `@@` 起的内容）
- `resolveBase(deps, ctx, override?)` 按 spec §2 顺序
- `computeSnapshot(deps, { cwd, mode, baseOverride, maxFiles = 300 }): Promise<Snapshot>`：永不 reject，出错写 `error`
- `loadFileDiff(deps, snapshot, file): Promise<FileDiff>`：按 spec §5，含截断
- `summaryText(snapshot): string`：`/wt-diff status` 用的纯文本
- 所有 git 调用走统一的 `git(deps, root, args)`：带 `-c core.quotePath=false --no-optional-locks`，diff 带 `--no-color --no-ext-diff`
验收：测试覆盖各解析器、base 推断五条路径 + 无 base、三种 mode、layer 计算、binary、rename、未跟踪、非仓库、空仓库（无提交）、detached HEAD。

## T2 Mod 主体（hooks/register.tsx + hooks/register.test.tsx）
- atoms 对应 types/index.d.ts 的五个 key，Shaped 的加 shape tag
- GitDeps 用 `$.process.run`（env `GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`，timeout 15s）、`$.fs`、`$.clock.now()` 实现
- 刷新调度（spec §6）：去抖、单飞 + 尾随一次、签名比较、展开文件 diff 重拉
- 事件：session.start（注册命令、自动打开、启动轮询）、tool.call（写类工具之后刷新）、turn.complete、ui.close（停轮询）
- 命令 `/wt-diff [status|refresh|base <ref>|base|mode <m>]`
- `ui.render` Pane（spec §7）：头部、模式按钮、文件行 Button、展开的 Code diff、空状态、宽度自适应
- userConfig（spec §9）写进 plugin.json
- README.md（安装、用法、base 推断规则、命令）
验收：测试在 terminal/desktop 渲染列表、空状态、展开 diff、模式切换、命令文本；validate/tsc 通过。

## T3 端到端
scratchpad 建真实仓库 + worktree，构造各种改动，`claude -p --plugin-dir <mod> "/wt-diff status"` 与 `git diff` 对照；把发现的 bug 修掉。

## T4 终审
多视角评审整个 mod（正确性/git 边界、引擎 API 用法、UI/性能），确认后修复，再跑全部检查。最后同步到仓库根目录。

## 执行中的判断记录
（workflow 结束后补充）
- T1：当前分支用 `git symbolic-ref --short -q HEAD` 而非 spec 的 `rev-parse --abbrev-ref HEAD`：后者在无提交仓库里报错（exit 128），前者能拿到未出生分支名，detached 时 exit 1 ⇒ branch null。HEAD 短 sha 用 `rev-parse --verify --quiet --short HEAD`，为空即"无提交"（snapshot.head === ''，base null，不设 error）。
- T1：layer 用 `diff --name-only -z --no-renames <mb> HEAD` 与 `diff --name-only -z --no-renames HEAD` 两份列表（rename 的新旧路径都在列表里）；规则：commits 没碰过 ⇒ uncommitted，否则工作区也碰过 ⇒ both，否则 committed。
- T1：找不到 base 时 `uncommitted` 模式仍列出改动（HEAD→工作区不需要 base），all/committed 为空列表。
- T1：文件按路径排序（跟踪与未跟踪混排）；超过 maxFiles 的未跟踪文件不读取、不计行数（totals.files 仍是总数，totals.added 只含已读的未跟踪文件），避免未忽略的大目录拖慢刷新。
- T1：单文件 diff 截断时重写最后一个 hunk 头的行数，保证截断后仍是合法 unified diff（引擎对解析失败的 `format="diff"` 会退化为纯文本）；splitHunks 去掉所有文件头（不只第一个 `@@` 前），pathspec 用 `:(literal)`。
- T1：签名只看 numstat 计数等字段，同一行连续改两次（+1 −1 不变）签名不变 ⇒ T2 刷新时应总是重拉已展开文件的 diff 并比较 hunks，签名只用来决定是否写 snapshot。
- T1：`claude plugin test` 下测试文件可直接 `import { … } from './git'`（已实测）。summaryText 用 ASCII `-`（便于 e2e 与 git numstat 对照），pane 里用 `−`。
- T1 评审修正：reflog 步骤也做 spec §3 的“自己的远程副本”判断（`git worktree add ../wt topic` DWIM 与 `checkout -b topic origin/topic` 会留下 `Created from [refs/remotes/]origin/topic`），命中则继续往下推断；`refs/heads/`、`refs/remotes/` 前缀缩短后显示。未跟踪列表里以 `/` 结尾的条目（嵌套仓库、`.claude/worktrees/*` 下的 linked worktree）直接过滤，不显示。所有 `diff` 列表命令在 revision 后加 `--`（防同名文件 `HEAD` 歧义）。truncateHunks 在第一行 body 就超字符预算时硬截该行并加 `…`；omittedLines 只计被丢的非 `@@` 行。
- T2：validate 要求 `$` 只能传给文件顶层声明的函数（不能传给 register 内部的闭包），所以调度状态（计时器、单飞锁、config、待自动打开标记）都放在模块顶层变量，register 只登记 hook；热重载丢失后由再次触发的 session.start → refresh 里的 `$.ui.panes()` 检查恢复轮询。
- T2：pane 关着且 statusLine 关时，自动触发（tool.call / turn.complete / 轮询）不跑 git；`/wt-diff` 打开、status、refresh、base、mode 以及待自动打开时强制刷新。
- T2：`isRefreshing` 只在用户发起的刷新（按钮、命令、切换模式）时置位，轮询和工具触发的刷新不写它，避免每 5 秒两次无意义重绘。
- T2：自动打开只在首次 session.start（state 里还没有 snapshot，即不是热重载）且 `isInteractive` 时判断；EnterWorktree 之后再判断一次。用户关掉的 pane 不会因热重载/改配置被重新打开。
- T2：每次刷新都重拉已展开文件的 diff（签名不含行内容），内容变了才写 `diffs`；snapshot 带 error 时不裁剪 expanded，避免一次 git 失败把展开的文件全折叠。
- T2：`/wt-diff base <ref>` 拒绝以 `-` 开头的 ref（防止被当成 git 选项），并用 `rev-parse --verify --quiet <ref>^{commit}` 校验。
- T2：行内计数省略为 0 的一侧（`A … +40`、`D … −2`），binary 显示 `bin`；终端按 bodyColumns 右对齐，desktop 不补空格。README 的安装命令按仓库 remote 写 `sudoviber/worktree-diff`，T4 同步时需补 `.claude-plugin/marketplace.json`。
- T2 评审修正：控制字符（ESC、^L 等）在 register.tsx 的绘制层统一替换为 U+FFFD（`printable` 用于 Code source 与命令输出，保留 \t\n、去掉 CRLF 的 \r；`oneLine` 用于路径、ref、cwd、错误），没有改 git.ts，snapshot 与 summaryText 的原始数据不变；Button key 仍用原路径（引擎只拒 label，不拒 key）。
- T2 评审修正：`isPlaced: false`（未被要求打开、终端窄于 144 列）的 pane 视为“看不见”：`/wt-diff` 对它执行打开而不是关闭，且不轮询；Pane 的 ui.render 里调用 `startPolling`，终端变宽被画出时恢复轮询。tool.call / turn.complete 触发仍会刷新它，保证画出时数据是新的。
- T2 评审修正：stdout 被截断（>4 MiB）时只把带 `-z` 的列表命令当作失败（`output over 4 MiB` 进 snapshot.error）；单文件 diff 本来就截到 400 行，不受影响。行宽按终端单元格计算（CJK/emoji 记 2），fitPath 按码点切，不会切开代理对。`/wt-diff` 注册为 `immediate: true`。
- T2 评审修正：测试套件只能触发事件，没有 `$.ui.close`（从测试 hook 的 `$` 调用会被拒：“its hooks module does not call it”），所以“关闭后停止轮询”只能经 `/wt-diff` 的关闭路径测试；person 关闭走的 ui.close hook 无法在 `claude plugin test` 里覆盖，兜底是下一次轮询发现 pane 不在后自行停掉。
- T3：真实 git 端到端发现未跟踪的符号链接被跟随读取目标文件计行（`link.txt → long.txt` 显示 +50），而 git 存的是链接目标路径（`git diff --no-index` 为 1 行）。GitDeps 的 `fileSize` 改为 `fileInfo: (absPath) => Promise<{ size; isLink } | null>`（register 用 `$.fs.stat` 的 `isLink`），链接一律计 1 行、非 binary。
- T3：`GIT_PREFIX` 增加 `-c diff.suppressBlankEmpty=false`：用户开了该配置时空白上下文行会丢掉前导空格，截断计数与 `Code format="diff"` 解析都会出错。summaryText 单数写 `1 file`（与 pane 一致）。
- T3：`mode` 存在 `$.state`，不跨 `claude -p` 进程保留（`--resume` 也不保留）；base 覆盖存在 `$.store`，跨进程保留。多命令 e2e 用 `claude -p --input-format stream-json` 在同一进程里依次发送。
- T3：已知且保留的与 git 差异：未跟踪文件 >1 MiB 记 binary（spec §4）；超过 300 个文件时未列出的未跟踪文件不计行数（350 个未跟踪文件显示 +600，git 为 +700）。
- 终审修正：reflog 的 `Created from <X>` 按原样存，相对 HEAD 或会自己跳的起点（`HEAD~N`、`@~N`、`@{…}`、`FETCH_HEAD`、`ORIG_HEAD`）每次刷新都会重新求值、差异窗口漂移，所以这一级直接跳过，落到 upstream / main-worktree；`main~2`、`origin/main^` 这类相对某个分支的写法去掉 `~N`/`^N` 后按该分支用（`stableStartPoint`）。没有采用"取 reflog 最早一条的 sha"，因为 base 名会变成 sha，也失去 behind 计数。
- 终审修正：300 个文件的上限先给跟踪文件，剩余名额再给未跟踪文件，列出后仍按路径排序显示（取代 T1 的"混排后截断"）；未列出的未跟踪文件仍不计行数，README Limits 已写明 `+` 总数会偏小。
- 终审修正：找到 base 但没有 merge-base（orphan、无关历史、shallow）时，uncommitted 模式仍列出 HEAD→工作区并把 `No common ancestor…` 写进 error；all/committed 仍只报错。register 的 syncDiffs 条件改为"无 error 或有文件"。
- 终审修正：未跟踪文件计数按 绝对路径+size+mtimeMs 缓存（`GitDeps.untrackedCache`，register 模块级 Map，热重载丢了只是多读一次），`fileInfo` 多返回 mtimeMs；每次列表后剔除本 worktree 不再列出的路径。轮询 tick 在已有刷新进行时直接丢弃，不再排 rerun。
- 终审修正：git < 2.31 会把 `--path-format=absolute` 原样回显，`isLinked` 识别这种输出后改按 git dir 是否形如 `<common>/worktrees/<name>` 判断。
- 终审修正：自动打开只在面板会停靠为侧栏（`viewport.isFullscreen === true`）时进行；布局从 PromptHint 的透传 `ui.render` hook、Pane 渲染和 `command.run` 的 presentation 得知，未知时自动打开挂起，得知 true 后经 schedule 补开，得知 false（主屏 inline）则取消。spec §7 说"144 列以下等待是引擎行为，不用处理"，主屏布局 spec 没覆盖，这里补上。
- 终审修正：EnterWorktree 只有调用成功（无 deny、非 isError）且前后 `$.session.cwd()` 变了才触发自动打开；`/wt-diff` 只在 pane `isPlaced && isShown` 时关闭，被别的 pane 挡在后面的 tab 用 `open({ focus: true })` 提到前面；轮询也只在 isShown 时进行。session.start 里把残留的 `isRefreshing` 复位为 false（热重载打断可见刷新的情况）。
- 终审修正：pane 头部第一行只放 `branch → ref`（按 bodyColumns 预先截断，先从中间截分支名，ref 始终可见），`source · sha` 挪到第二行 totals 后面（flexWrap，窄时折到下一行），与 spec §7 示例布局不同。模式/刷新/折叠按钮改为 `plain`（终端显示 `a: all` 这样的热键），当前模式用加粗子 Text 标出，同时保留 `variant="primary"` 给其他 surface。展开 diff 的文本预算预留后续每行 columns 个字符和 200 字符尾部，避免引擎 100k 截断吃掉列表尾部。
- 收尾：同步到仓库根时 `.claude-plugin/marketplace.json` 在任务要求的字段外多加了一句 `description`，否则 `claude plugin validate` 报 "No marketplace description" 警告；mod 目录与仓库根两份 marketplace.json、.gitignore 保持一致。剩余的 ICON_MISSING 只是 plugin directory 提示，不影响校验结果，暂不加图标。
- 收尾 e2e（scratchpad/ship，`git worktree add -b feat ../wt main` + 两个提交、rename、删除、未跟踪文本、未跟踪 binary、main 之后又前进一个提交）：`/wt-diff status` 输出 `feat → main reflog`、`↑2 ↓1 · 5 files · +9 -1`，各文件行数与 `git diff --numstat -M <merge-base>` 加未跟踪文件一致。
