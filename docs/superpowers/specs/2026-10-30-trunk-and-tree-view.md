# worktree-diff v0.2：主干分支推断 + 树形视图

日期：2026-10-30
前置：`docs/superpowers/specs/2026-10-29-worktree-diff-pane.md`（v0.1）

## 问题

1. **主 checkout 对比错了 base。** 实际仓库：GitHub 默认分支是 `main`，团队真正的集成分支是 `feat/auth-ui`。主 checkout 停在 `feat/auth-ui`，所有 linked worktree 都 `Created from origin/feat/auth-ui`。
   - 主 checkout 上 `feat/auth-ui` 的 reflog 中超过 90 天的条目已被 `git gc --auto` 清掉（默认 `gc.reflogExpire`），最早一条是 `pull origin feat/auth-ui --ff-only: Fast-forward`，创建记录已不在，reflog 这一级拿不到结果。
   - upstream `origin/feat/auth-ui` 是自己的远程副本，按 v0.1 规则跳过。
   - 主 worktree 的分支就是它自己，跳过。
   - 最后落到 `origin/HEAD` = `origin/main`，显示 `↑5569 ↓14`，毫无意义。
   - linked worktree 基本正确：reflog 给出 `origin/feat/auth-ui`；reflog 丢失的分支退到主 worktree 的分支 `feat/auth-ui`。
2. **文件多时平铺列表难读**，用户想要按目录的树形视图。

## 设计

### A. base 推断

新增一个**仓库级「主干」（trunk）**设置，并且按 linked worktree 和主 checkout 分别走不同的推断顺序。

**trunk 设置**
- `/wt-diff trunk <ref>`：设置主干，例如 `/wt-diff trunk origin/feat/auth-ui`。
  - 存在 `$.store`，key 为 `trunk:<git common dir 绝对路径>`。同一仓库的所有 worktree 共享这一个值，跨 session 保留。
  - 设置前用 `rev-parse --verify` 校验，拒绝以 `-` 开头的 ref。
- `/wt-diff trunk`（不带参数）：清除设置。
- `/wt-diff status` 和 pane 头部的 source 标签会显示 `trunk`。

**linked worktree 的推断顺序**（与 v0.1 相比只多了第 4 步）
1. override（`/wt-diff base`，按 worktree 存）
2. reflog `Created from X`，不能是自己的副本
3. upstream，不能是自己的副本
4. **trunk 设置**（新）
5. 主 worktree 的分支
6. 默认分支（origin/HEAD → main/master/trunk/develop）

**主 checkout 的推断顺序**（新）
1. override
2. reflog `Created from X`，不能是自己的副本
3. **trunk 设置**，前提是 trunk 不是当前分支自己或它的副本
4. **自己的 upstream**（如 `origin/feat/auth-ui`）：显示还没推送的提交和未提交的改动。source 标签为 `upstream`。
5. 默认分支
6. 都没有：无 base（与 v0.1 相同）

效果：在主 checkout 的 `feat/auth-ui` 上，不需要任何设置，就会对比 `origin/feat/auth-ui`，看到的是「我本地还没推上去的东西」。

- 如果用户在主 checkout 做功能开发，分支的 reflog 还在（`Created from main`），第 2 步就能拿到 base，不受影响。
- 只有 reflog 丢失、又有自己的 upstream 时，才会退到「未推送」视图。这种情况可以用 `/wt-diff base` 或 `/wt-diff trunk` 纠正。

### B. 树形视图

**视图切换**
- `view: 'tree' | 'list'`，**默认 tree**。
- 用热键 `t` 或控制行上的按钮切换。
- 选择存在 `$.store`（key `view`），跨 session 保留。

**树的结构**
- 按路径把文件建成目录树，rename 放在新路径下。
- 单子目录链压缩成一行，与 VS Code 的 compact folders 相同：`src/app/api/`。
- 排序：同一层先目录后文件，各自按名字排序。

**目录行**
- 是一个 `plain` Button，key 为 `dir:<path>`，按下折叠或展开。
- 内容：`▾ name/` 或 `▸ name/`，右侧用灰色显示该目录下所有改动的合计 `+A −R`。
- 折叠的目录额外显示文件数 `(N)`。
- 默认全部展开。折叠状态存在 `$.state`：新增 `collapsedDirs: Shaped<string[]>`。刷新后已经不存在的目录会被剪掉。

**文件行**
- 结构与 v0.1 相同，只是按深度缩进（每层 2 格，最多缩进 bodyColumns 的 1/3），只显示文件名，不显示完整路径。
- rename 在文件名后用灰色显示 `← 旧路径`（按剩余宽度截断）。
- 状态字母、`●` 标记、计数和点开看 diff 的行为都不变。

**其他**
- 新增热键 `z`：折叠全部目录或全部展开，再按一次切回。原有的 `x` 仍然只用于收起所有 diff。
- list 视图与 v0.1 完全一致。`/wt-diff status` 的纯文本输出保持平铺，不受影响。
- 文本预算和 300 个文件的上限不变。被折叠目录里的文件不计入渲染预算。

### C. 其他
- `README.md`：推断顺序、trunk 命令、树形视图和热键都要更新。
- `plugin.json` 的 version 改为 `0.2.0`。改完同步到 dev-mods 副本，commit 和 push 等用户确认后再做。
- 用户的已安装副本靠 `claude plugin update worktree-diff` 加 `/reload-plugins` 更新。

## 验收
- 单元测试覆盖：
  - 主 checkout 的 6 级推断和 linked worktree 新增的 trunk 一级
  - trunk 命令的设置、清除和校验
  - 树的构建：压缩、排序、rename、聚合计数
  - 渲染：terminal 和 desktop 下的 tree、list、目录折叠、`t` 和 `z` 热键、缩进上限
- 端到端：在 scratchpad 复现「默认分支 main + 集成分支 feat/x + 主 checkout 停在 feat/x 且 reflog 过期 + upstream origin/feat/x」，主 checkout 显示 `feat/x → origin/feat/x   upstream`；同一仓库的 linked worktree 仍对比 `origin/feat/x`。
- `claude plugin validate`、`claude plugin test`、tsc 全部通过。
