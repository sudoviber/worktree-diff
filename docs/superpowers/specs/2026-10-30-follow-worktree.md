# worktree-diff v0.5：跟随 Claude 实际工作的 worktree

日期：2026-10-30
状态：用户已确认（自动跟随 + 可手动固定 + `o` 选 worktree）

## 问题
pane 现在固定显示 session 工作目录（`$.session.cwd()`）所在的 worktree。常见的工作流是 session 停在主 checkout，Claude 用 `git worktree add` 建一个 worktree，之后用 `cd <worktree> && …` 或者带绝对路径的 Edit/Write 在里面开发（用户 CLAUDE.md 里的 Linear 流程就是这样）。这时 pane 显示的是主 checkout，提示「No changes」，Claude 真正在改的 worktree 反而看不到。

## 设计

### 目标 worktree
`target = pinned ?? followed ?? session cwd`
- `pinned` 和 `followed` 都存在 `$.state`，只在当前 session 有效，热重载后保留，新 session 从头开始。
- 每次刷新都对 target 计算快照，`/wt-diff status` 也用 target。base override 本来就按 worktree 根目录存，trunk 本来就按 git common dir 存，所以切换 target 后会自动套用该 worktree 自己的设置。

### 自动跟随（followed）
- 在下列工具调用**成功之后**（`await next(e)`，没有被 deny，也不是 isError）记录路径，主 agent 和子 agent 的调用都算：
  - Edit / Write / MultiEdit：`file_path` 所在目录
  - NotebookEdit：`notebook_path` 所在目录
  - Bash：命令开头连续的 `cd <dir>`（以及 `pushd <dir>`）里**最后一个**目标，例如 `cd a && cd b && npm test` 取 `b`。
    - 支持单引号和双引号、`~`、`--`。
    - 相对路径按 session cwd 解析。
    - 遇到 `$VAR`、命令替换或无法解析的写法时放弃，不记录。
  - EnterWorktree / ExitWorktree：沿用 v0.2 的逻辑（session cwd 变了，followed 清空，回到 session cwd）。
- 用 `git rev-parse --show-toplevel` 把记录下来的路径换成 worktree 根目录，不是 git 仓库就忽略。
- **只跟随同一个仓库**：session cwd 在 git 仓库里时，只有 git common dir 相同的 worktree 才会被跟随。这样 Claude 改 `~/.claude` 下的 memory 文件或别的仓库时，pane 不会跳走。session cwd 不在任何仓库里时，什么都可以跟随。
- 记录下来的根目录和当前 followed 相同时，什么都不做。不同时更新 followed，然后刷新（沿用现有的去抖）。
- **worktree 被删除**（比如 `git worktree remove` 之后）：刷新时发现 target 目录已经不存在或不再是 git 仓库，就清掉 followed 和 pinned 里失效的那一个，退回下一级，并在头部提示一次「worktree removed — back to <name>」。

### 手动固定（pinned）
- `/wt-diff at <path>`：路径按 session cwd 解析，校验是 git worktree 后固定，回复 `Showing <name> (pinned)`。
- `/wt-diff at`：清除固定，回到自动跟随。
- pane 里按 `o`：在 pane 主体区域列出 session 所在仓库的全部 worktree（`git worktree list --porcelain`）。
  - 第一项是 `auto`，后面每一项显示 worktree 目录名、分支（detached 时显示短 sha）、路径（dim），当前 target 带标记。
  - `j`/`k` 移动，`Enter` 或 `l` 选中：选 `auto` 等于清除固定，选其他项就固定到该 worktree。`o` 或 `h` 退出列表不做改变。
  - 列表中的项用 plain Button 画，鼠标点击即选中。
  - side 和 inline 两种视图都支持；列表期间按键提示行显示对应的键。

### 头部
- target 不等于 session cwd 时，在头部分支行上方加一行 dim 文字：`⌂ <worktree 目录名>` 加上 `· auto`（跟随）或 `· pinned`（固定）。target 就是 session cwd 时不显示这一行，和 v0.4 一致。
- 退回提示（worktree 已删除）显示在这一行，持续到下一次 target 变化。

### 自动打开
- autoOpen 为 `worktree` 时：followed 第一次变成一个 linked worktree，并且 pane 在本 session 里没有被用户关掉过，就按现有规则自动打开（只在侧栏停靠的布局下，不抢焦点）。

## 不变的部分
base 推断、模式、tree/list、side 和 inline 视图、键盘（多一个 `o`）、透明背景、状态栏、轮询（对 target 轮询）。

## 验收
- 纯函数单测：
  - Bash 开头 cd 的解析：引号、`~`、`--`、多个 cd 取最后一个、pushd、变量放弃、`cd` 不在开头时忽略、相对路径。
  - target 的优先级。
  - 只跟随同一仓库的过滤。
- 集成测试（terminal 和 desktop）：
  - Edit 绝对路径进入另一个 worktree 后，pane 切过去，头部显示 `⌂ name · auto`。
  - Bash `cd wt && …` 同样能切过去。
  - 改 `~/.claude` 下的文件不切换。
  - `/wt-diff at` 固定和清除；pinned 优先于 followed。
  - `o` 列表的显示、选择、取消、点击。
  - worktree 被删除后退回。
  - EnterWorktree 会清空 followed。
  - `/wt-diff status` 用的是 target。
  - 第一次跟随进 linked worktree 时自动打开，用户关过 pane 后不再自动打开。
- validate、test、tsc 全部通过；README.md 和 README.zh-CN.md 都要更新；version 改为 0.5.0。
