# worktree-diff v0.3 界面重设计：实施计划

Spec：`docs/superpowers/specs/2026-10-30-ui-redesign.md`（用户已选定合成稿）

源码以仓库根为准，完成后同步到 session 的 dev-mods 热加载副本；不 commit。检查：`claude plugin validate`、`claude plugin test`、tsc。

## T1 diff-lines.ts（纯函数，可与 T2 并行）
`hooks/diff-lines.ts` + `hooks/diff-lines.test.ts`：`parseHunks(hunks) → DiffLine[]`、`isPureAdd(hunks)`、去掉 `+` 前缀得到源码的辅助函数；tab 展开、不可打印字符处理、绝不抛异常。

## T2 版面（register.tsx 的 header / controls / rows / 间距 / 空状态）
spec 实现清单 1–6、9：两行头部（space-between，↻ 预留）、actions 行（dim）、tabs + 下划线 rule（窄宽降级为 underline）、摘要行、文件/目录行改为「只有名字在 Button 里、计数在外」的结构、深度 0 行前的空行、空状态三件套；bold → weight semibold。测试覆盖 terminal/desktop 和 42/55/75 列宽度。

## T3 diff 与状态栏（依赖 T1、T2）
spec 实现清单 7–8、10–11：quiet diff（前景色逐行画，缩进到文件名列）、纯新增文件走 `Code format="source" startLine={1}`、删除文件一行提示、`diffStyle: quiet|engine` 配置；statusLine 改走 PromptHint tail（非 terminal 用 status 且去掉 wt）、加载时清旧状态；README 与配置表。

## T4 终审 + 收尾
三视角评审（版面/视觉对照 spec 效果图——用测试 harness 的 `ui.drawn()` 把渲染树转成 ASCII 在 42/55/75 列对照；diff 正确性与预算；API 使用）→ 对抗验证 → 修复；version 0.3.0；同步 dev-mods。

## 执行中的判断记录
- T1：`addedSource(hunks)` 非纯新增返回 null（`isPureAdd` 即其非 null），源码保留 tab 交给 Code 自己画，只替换控制字符；不能解析的 `@@` 行记为无 `newStart` 的 hunk 而非 ctx；控制字符清理在 diff-lines.ts 里复制一份（`printable` 在 register.tsx，反向引用会成环），tab 宽 4 与引擎画 tab 的宽度一致。
- T2：tmux 里实测 claude 2.1.312，justifyContent space-between 能把计数和 ↑↓ 推到右缘，聚焦时只有文件名反色（风险 1、2 已验证）；没用补齐空格。行 Box 的 key 用 `row:file:<path>` / `row:dir:<path>`（同名的文件和目录可以并存），并过一遍 oneLine，因为带控制字符的 Box key 会被引擎丢掉。desktop 的缩进包装 Box 改成 column，否则行不撑满宽度。标签下划线只在 terminal 画，其他 surface 由 primary 按钮自己标出当前模式。展开的目录不再显示汇总，折叠后才显示 (N) 和 dim 计数。list 视图的改名也改成「新路径 ← 旧路径」，与树视图一致。出错时提示块画在保留的行上方；摘要行只在有文件可列、没有提示块时画。drawDiff 只加了 nameCol 参数（diff 与提示缩进到文件名列）和提示的 marginBottom、column 方向，diff 本身的画法留给 T3。
- T2 评审修正：提示行加了 `{ code }` 片段，整行不再 dim，只有文字片段 dim、命令用默认色（嵌套 Text 的 dimColor={false} 能否覆盖外层没有文档保证）；committed 模式的空状态副句改为「Commits on this branch will show up here.」；ambiguous 宽字符下的分割线只在 README 的 Limits 里写明，没做 ASCII 回退配置（spec 风险 7 列为可选）。
- T3：quiet diff 每行带 `+ `/`- `/两空格前缀（与效果图一致，不靠颜色也能分辨），按 pane 宽度预截到多出一格（留给 truncate-end 的省略号），预算按实际画出的字符累加；Code source 的行号由引擎画、不计入预算；纯新增在 diffStyle=engine 下也走 source 视图；删除文件不等 diff 加载就直接画「deleted · N lines」（N 取 numstat 的 removed），二进制的删除文件仍显示 Binary file；diff Box 加了 key `diff:<path>` 方便测试定位。statusLine：会话只有 terminal 时只走 PromptHint tail（hook 里 read snapshot 原子即订阅重绘，测试 harness 里验证过会更新，没加 invalidate），有非 terminal surface 附着时另调 status（此时终端上会和 tail 重复一份），文本不变时不重复调用；session.start 时清一次旧状态。
- T4 评审修正：树视图里同目录改名只显示旧文件名（「session.ts ← token.ts」），跨目录移动仍显示完整旧路径，list 视图不变；真引擎下 dimColor 的 plain Button 只把「: label」画暗，hotkey 字母仍是全亮 suggestion，这是引擎画法，动作行和标签条做不到整体 dim，spec 措辞已同步更正；GIT_PREFIX 固定 `diff.context=3`，用户的 diff.context=0 会让文件开头的修改看起来像整文件新增；expandTabs 按 charWidth 计列（宽字符两格），charWidth 挪到 diff-lines.ts 供两边共用；hunk 新侧为空（`+0,0`）时头部画成 `@@ −<旧起始行>`；挂 session.attach/detach（只观察），远程端进出时按已有快照立即更新 status，`reason: end` 时跳过；version 改为 0.3.0。
- 用户反馈 pane 灰底与透明/背景图终端割裂：新增 userConfig `paneBackground`（`transparent` 默认 | `theme`），每次 `$.ui.open` 带 `backgroundColor: "transparent"`；热重载时 pane 在屏上则重新 open 一次（不带 focus）让新背景立即生效。
