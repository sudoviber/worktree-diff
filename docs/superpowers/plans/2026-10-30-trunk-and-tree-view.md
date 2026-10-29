# worktree-diff v0.2 实施计划

Spec：`docs/superpowers/specs/2026-10-30-trunk-and-tree-view.md`（用户已确认：主 checkout 对比自己的 upstream；树形视图按 spec）

源码以仓库根为准；完成后同步到本 session 的 dev-mods 热加载副本。检查：`claude plugin validate`、`claude plugin test`、tsc（mod 目录外的 tsconfig）。

## T1 base 推断 + trunk
- `types/index.d.ts`：`BaseSource` 加 `'trunk'`；Snapshot 记录 git common dir（trunk 的 store key 要用）。
- `git.ts`：`resolveBase` 增加 `isLinked`、`trunk` 两个输入，按 spec §A 走两条顺序；主 checkout 的 own upstream 一级。
- `register.tsx`：`/wt-diff trunk [<ref>]` 命令（校验、`$.store` key `trunk:<common dir>`），刷新时读 trunk 传入；USAGE/summary 文案。
- 测试：两条顺序每一级、trunk 是自己副本时跳过、命令设置/清除/校验。

## T2 树形视图
- 新文件 `hooks/tree.ts`（纯函数）：`buildTree(files)` → 压缩单子目录链、目录在前排序、聚合 +/−/文件数；`visibleRows(tree, collapsed)` → 带深度的扁平行。
- `types/index.d.ts`：`collapsedDirs: Shaped<string[]>`；`ViewMode = 'tree' | 'list'`。
- `register.tsx`：view 存 `$.store`（`view`）并镜像进 `$.state` 供渲染；`t` 切换、`z` 全部折叠/展开；目录行 Button `dir:<path>`；文件行缩进（每层 2 格，上限 bodyColumns/3）、只显示文件名、rename 显示 `← 旧路径`；刷新后剪掉不存在的目录；list 视图不变。
- 测试：tree.ts 单测 + terminal/desktop 渲染。

## T3 端到端
scratchpad 复现：默认分支 main、集成分支 feat/x、主 checkout 停在 feat/x 且 reflog 过期（`git reflog expire --expire=now --all`）、upstream origin/feat/x（本地 bare remote）；linked worktree 从 origin/feat/x 建。`claude -p --plugin-dir <repo> "/wt-diff status"` 分别在主 checkout 与 linked worktree 验证；再测 `/wt-diff trunk`。

## T4 终审 + 收尾
多视角评审 → 对抗验证 → 修复；README、version 0.2.0；同步 dev-mods；不 commit。

## 执行中的判断记录
- T1：linked worktree 的 trunk 一级也做"自己或自己的副本"判断（spec 只对主 checkout 写了），命中则落到主 worktree 分支；trunk 以 `-` 开头或已不是 commit（分支被删）时同样跳过，不报错。
- T1：主 checkout 的 own upstream 一级不做 isOwnCopy 过滤（这一级本来就是要对比自己的远程副本），也不再走"主 worktree 分支"一级（主 worktree 就是它自己）；默认分支一级沿用 v0.1（origin/HEAD 不过滤副本）。
- T1：trunk 的 store key 用 `rev-parse --path-format=absolute --git-common-dir` 的结果（git < 2.31 回显参数、给相对路径时按 worktree root 拼成绝对路径并规整 `..`）；register 刷新时 cwd 未变就复用上一份 snapshot 的 root 和 gitCommonDir，否则先跑一次 `repoDirs`。snapshot 的 shape tag 升到 `snapshot-2`。
- T1：register 测试原来按 `--git-common-dir` 那条 rev-parse 数刷新次数，`repoDirs` 也会跑它，改为按只有 computeSnapshot 才跑的 `symbolic-ref --short -q HEAD` 计数。
- T1 评审修复：`/wt-diff trunk` 额外拒绝随 HEAD 变化的写法（`HEAD`、`@`、`HEAD~2`、`main~1`、`@{u}`、`@{-1}`、`FETCH_HEAD` 等，即 `stableStartPoint(ref) !== ref`），提示 `Not a branch name: <ref>`；resolveBase 对 store 里的同类值也直接跳过。tag 和 commit sha 仍可设置（spec 只要求 `rev-parse --verify`）。
- T1 评审修复：trunk 存储前用 `rev-parse --symbolic-full-name` 规整，分支存成 `refs/heads/...` / `refs/remotes/...` 全名（tag、sha、有歧义的名字按原样存）；判断「自己的副本」时 `refs/heads/` 只比完整分支名（`team/x` 不再被当成 `x` 的远程副本），`refs/remotes/` 去掉 remote 段，短名沿用 v0.1 的启发式。显示和 git 调用用 `shortRef` 后的短名，与 reflog 一级一致。
- T2：目录行的合计 `+A −R` 与文件行一致，省略为 0 的一侧；目录下只有 binary（两侧都是 0）时不显示计数。折叠时的 `(N)` 与合计都用灰色。
- T2：控制行按钮按"按下会做什么"命名（与 refresh、collapse 一致）：tree 视图显示 `t: list`，list 视图显示 `t: tree`；`z: fold`，全部已折叠时为 `z: unfold`。`z` 只在 tree 视图且有目录时出现。
- T2：`z` 折叠时包括嵌套目录（展开父目录后子目录仍是折叠的）；"全部已折叠"按当前树的所有目录判断。目录排序用压缩前的首段名，与列表一样按 code unit 比较。
- T2：view 的 store→state 镜像在每次模块加载后的第一次刷新里读一次 `$.store`（模块级标记，热重载后再读一次）；切换时先改 state 再把 state 的值写回 store，store 写失败只影响跨 session 保留。
- T2：rename 在 tree 里先保证文件名，`← 旧路径` 只在剩余宽度至少 4 格时显示。剪掉不存在目录的时机与 syncDiffs 相同（无 error 或有文件），切换 mode 后另一模式里没有的目录也会被剪掉。
- T2：register 测试的 `world()` 改用自写的内存 store（`mock.store` 与测试自己的 `store.set` hook 不能同时注册），以便断言 view 写进了 store；v0.1 的三个列表专项测试预置 `view: 'list'`，作为"list 视图与 v0.1 一致"的覆盖。
- T2 评审修复：树的缩进在 terminal 仍是按钮文字里的前导空格；其他 surface 改为用 `<Box paddingLeft={格数}>` 包住该行按钮（d.ts 写明数字 padding 在每个 surface 上都是字符格数），按钮文字不带前导空格。未在真实 desktop 上目测确认。
- T2 评审修复：窄窗格里先保证文件名（至少 4 格）和计数，其次是折叠目录的 `(N)`，最后才是缩进：缩进上限再与剩余空间挂钩，`(N)` 放不下时省略。计数本身不省略（与 v0.1 列表一致），所以计数极长、窗格极窄时仍可能超宽。
- T4 终审修复：主 checkout 的分支 reflog 是 `Created from HEAD`（及 `HEAD~N`、`@`，`git checkout -b x` / `git switch -c x` 不写起点）时，从 HEAD 自己的 reflog 里取最早一条 `checkout: moving from <X> to <branch>` 的 X 作为 reflog 一级（X 同样过 stableStartPoint、自己副本、isCommit 检查；X 是 commit id 即建分支时 detached 的不用）；取不到时跳过「自己的 upstream」一级，按 v0.1 落到默认分支（trunk 一级仍在前）。`@{-1}`、`FETCH_HEAD` 等不走 HEAD reflog，直接按「创建条目不可用」处理。linked worktree 不读 HEAD reflog，保持 v0.1 行为。
- T4 终审修复：主 checkout 的 reflog 是 `Created from <自己的远程副本>`（新 clone 里 `git checkout feat/x` DWIM、`gh pr checkout`）时**维持现状**，仍走自己的 upstream（「未推送」视图）而不是默认分支：这正是用户集成分支 reflog 未过期时的形态，改成默认分支会退回「对比 main」；要对比别的分支用 `/wt-diff trunk` 或 `/wt-diff base`。
- T4 终审修复（偏离 spec 顺序）：主 checkout 已设 trunk 且当前分支就是 trunk 或其副本时，跳过 reflog 一级直接走自己的 upstream；否则 `/wt-diff trunk <自己>` 回成功、pane 却仍显示 reflog 的创建点。
- T4 终审修复：`z` 与控制行的 fold/unfold 改按「当前可见的目录行是否全部折叠」判断（至少一个目录行），被折叠父目录挡住的子目录不计；按下 fold 仍写入全部目录。
- T4 终审修复：loadView 与 `t` 的竞态用模块级计数挡住（toggleView 加一，loadView 在 store.get 返回后发现计数变了就不写 state）。测试 harness 的 engine 没有 `$.state`、也无法在 loadView 等待期间让 pane 已有 snapshot，所以这条没有加回归测试，只靠代码审查。
- T4：README 推断顺序拆成 linked worktree / 主 checkout 两节，补 trunk 命令、树形视图、`t`/`z`、更新已安装副本（`claude plugin update worktree-diff` 后 `/reload-plugins`）；plugin.json version 0.2.0。
