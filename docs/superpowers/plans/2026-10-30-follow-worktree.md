# worktree-diff v0.5 跟随 worktree：实施计划

Spec：`docs/superpowers/specs/2026-10-30-follow-worktree.md`

## T1 纯函数（hooks/follow.ts + 测试）
Bash 开头 cd/pushd 解析、路径解析（~、相对、..）、target 优先级、同仓库过滤判定。

## T2 接入（register.tsx + 测试）
followed/pinned state；tool.call 后记录并换算根目录；刷新改用 target；worktree 删除回退；头部 ⌂ 行；`/wt-diff at`；`o` worktree 列表（side/inline）；自动打开规则；status 用 target。

## T3 文档：README en/zh，version 0.5.0。

## T4 评审 → 终审（真实 git 端到端：主 checkout + 多个 worktree，cd/Edit 跟随、删除回退、跨仓库不跟随；API 与回归）→ 对抗验证 → 修复 → 收尾（同步 dev-mods，不 commit）。

## 执行中的判断记录
- T1：cd 链里后一个相对路径按前一个 cd 的落点解析（与 shell 一致，如 `cd /repo && cd wt` 得 `/repo/wt`），只有第一个按 session cwd；链中任一 cd 无法确定（`$`、反引号、glob、花括号、重定向、`|`/`||`/`&`、`cd -`、多个参数、`pushd` 栈操作或 `-n`）就整条放弃；`cd` 只接受 `-L`/`-P`/`--` 选项，带引号的 `~` 视为名为 `~` 的目录；不处理 CDPATH。
- T2：followed 跟随回 session 自己的 worktree 时直接清为 null，所以「⌂ · auto」只在真正跟随到别的 worktree 时出现；固定到 session 自己的 worktree 时仍显示「⌂ name · pinned」，让人知道处于固定状态。
- T2：worktree 被删除的判定是目录不存在，或目录还在但 git 明确回答不是仓库；git 的其他失败（超时等）保留当前 target，不回退。
- T2：「用户关过 pane」除了 person 来源的 ui.close，也包括按 q 和 `/wt-diff close`；测试工具无法触发 person 来源的 ui.close，测试用 `/wt-diff close` 和 q 代替。
- T2：自动打开在跟随当下用 rev-parse 判断是否 linked，第一次跟随进 linked worktree 就用掉这次机会（pane 已经开着也算）。
- T2：`o` 列表里的勾号标在生效中的选择上（未固定勾 auto，固定时勾该 worktree），光标初始停在勾号上；提示行为 `j: down  k: up  l: select  h: back  o: back  q: close`。
- T2：`o: worktree` 加进 side 和 inline 的常规按键行末尾；inline 在 60 列下按键行因此多折一行，相关旧测试按新输出更新。
- T2：`/wt-diff at` 后面的路径取整行余下部分（允许空格，去掉一层成对引号），必须是已存在的目录；不带路径时回复 `Unpinned: following the worktree Claude works in.`；`/wt-diff status` 在 target 不是 session 时首行加 `⌂ <root> · auto|pinned`。
- T2：target 切换（snapshot.cwd 变化）时清空已读的 diff，并把 diff 窗口回到顶部，避免同名文件显示上一个 worktree 的 diff。
- T2：跟随用的 git 调用在工具结果返回后于后台按调用顺序串行执行，最后一次生效；session 所在仓库的 root 和 common dir 按 cwd 缓存；git.ts 只为复用参数而导出 DIRS_ARGS。
- T2 修复：相对路径的基准改为工具调用开始前在 hook 内读到的 `$.session.cwd()`（子 agent 读到的是它自己的目录，前台 cd 改了 session cwd 也不影响）；判断「同一仓库」仍用后台读到的 session 自己的 cwd。
- T2 修复：session 所在仓库的 git 失败（超时、锁等，stderr 不是 not a git repository，或 common dir 读不到）时本次不跟随，只有 git 明确说不在仓库里才放开同仓库过滤。
- T2 修复（偏离 spec「不是 isError」）：Bash 结果是 isError 但没有被 deny 时，开头 cd 链解析出的目录恰好存在（不向上找最近的目录）就照样跟随，覆盖 `cd wt && npm test` 测试失败这类常见情况。
- T2 修复：`o` 列表过滤掉 porcelain 里带 `prunable` 的 worktree（目录已被直接删掉）；WorktreeEntry 加 isPrunable。
- T2 修复：`o` 列表里没打勾的「当前显示的 worktree」在勾号位置画一个 dim 的 `•`，未固定时也能看出 pane 正显示哪个 worktree。
- T2 修复：session.start 的 isInteractive 为 false 时，跟随和 EnterWorktree 都不再预约自动打开，避免无人查看的 session 每次触发都跑 git。
- T3：除 version 外，plugin.json 里 autoOpen 的 description 也补上「Claude 第一次被跟随进 linked worktree 时」，与 README 的设置表一致。
- 对抗验证修复：固定或跟随的 target 在 git 回答的 toplevel 不是它自己时（删掉后目录又被重建、嵌在主 checkout 里的 `.claude/worktrees/<name>`）也算已删除，退回下一级并提示。
- 对抗验证修复：`cd <main> && git worktree remove <wt>` 让 follow 回到 session 自己的 worktree 时，先看被跟随的 worktree 是否已删除（目录不在，或 git 的 toplevel 不是它），已删除就直接写删除提示，不再静默清掉。
- 对抗验证修复（收窄上面「isError 的 Bash 照样跟随」）：只有结果文本里带 core 的 `Exit code N` 才算命令跑过；被 hook、权限规则或用户拒绝的调用（isError 但只有拒绝理由）不跟随。
- 对抗验证修复：刷新结尾消费「跟随后自动打开」前重读 target，和本次 snapshot 不一致（git 运行期间发生了跟随）就再跑一轮，由读到新 target 的那一轮决定是否打开。
- 对抗验证修复：「换了 worktree」改为比较 snapshot 的 root（不在仓库时比较 cwd），session 在同一 worktree 里 cd 进子目录不再清空 diff、不再回到顶部。
- 对抗验证修复：side 视图另存最后一次画出的 regions（laid），`o` 列表或提示盖住 regions 时保留，焦点环回位、按键步长和刷新时树窗口都用它；滚轮仍只认当前屏上的 regions。test kit 跑不了 mod 自己的 `$.ui.focus`，回位落点不能直接断言，回归测试改测列表期间刷新后树窗口不跳。
