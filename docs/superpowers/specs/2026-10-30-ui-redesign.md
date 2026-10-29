# worktree-diff v0.3：界面重设计（Quiet + SCM 标签条）

日期：2026-10-30
状态：用户在三套设计稿（Quiet / SCM / Cards）和评审合成稿中选定了合成稿。

## 要解决的问题（来自用户截图）
- 头部三行挤在一起，分支、base、计数同一种灰，没有层次。
- 控制行是一串密集文字，当前模式不显眼。
- 焦点行整行反色（引擎对 Button 整个 label 加 inverse，而 label 里塞了补齐空格），白底绿底很刺眼。
- diff 新增行是整片绿底，各区块之间没有留白或分隔。
- 状态栏 `⚠ worktree-diff: wt +18 -0` 像警告。

## 设计总述
以 Quiet 为底：分区靠空行而不是画框，颜色只用来表达含义，只有文件名会反色，修改文件的 diff 用前景色逐行画。在此基础上嫁接以下几处：
- 从 SCM 拿来四样：(1) 模式标签条下面画一条分隔线，当前标签正下方用 ━（suggestion），其余用 ─（subtle）。当前模式一眼就能看到，这条线也把导航和内容隔开。(2) 一行跟着当前模式变的摘要「5 files  ● 2 uncommitted  +202 −34」，放在标签条下面，因为这些计数本来就随模式变。(3) 新增和未跟踪文件改用 <Code format="source" startLine={1}> 画：去掉 hunk 头和每行开头的 +，有语法高亮和 dim 行号，没有绿块。截图里那片绿块正是这种情况。(4) ↻ 在 ↑↓ 左边预留 2 格，刷新时布局不跳；删除的文件只显示一行。
- 从 Cards 拿来三样：list 视图里目录部分画成 dim、文件名画成 text；hot reload 时调一次 $.ui.status(undefined)，清掉旧的 ⚠ 状态；论证了 ANSI 主题下只有前景色 diff 安静，用它作为 quiet diff 做默认的理由。
- 不采用：Cards 的边框卡片和 chip（太占宽度，chip 在反色下画成什么样没验证）；SCM 的 gutter、├└ 树线和底部工具栏（42 列太挤，工具栏会被滚出视野，tree.ts 要改）；quote 左侧细条（字形没有实测）；hover 下划线（依赖带 key 的 Box）。
- 工具栏 r/t/z/x 放在 header 下面，label 部分 dim（hotkey 字母由引擎画成 suggestion，不随 dimColor 变暗），作为次要操作，打开 pane 时就能看到。
- 全部只用 Box/Text/Button/Code 和 ThemeKey，type Ui 的 Pick 不用改。用到的 weight(:13499)、paddingX/marginY(:1004–1012)、alignItems(:987)、startLine(:1692)、format(:1662)、PromptHint.tail(:10894) 都在 d.ts 里核对过。

## 效果图（│ 为 pane 边界，右侧为注释）
```
(1) tree 视图，55 列，mode=all。login-form.tsx 持有焦点，session.ts 已展开。│ 是 pane 边界（不会画出来），右侧是注释。

│feat/auth-ui-polish                             ↻ ↑3 ↓1│  R1 branch weight=semibold · ↻ dim (refresh only, 2 cells reserved) · ↑3 text · ↓1 warning
│vs origin/feat/auth-ui                 reflog · 8b05b1d│  R2 "vs" dim · ref text · source·sha dim (drop "reflog" then sha when tight)
│r: refresh  t: list  z: fold  x: collapse              │  R3 actions: plain Button dimColor (full strength on focus/pointer)
│                                                       │  Box marginTop=1 (no text budget)
│a: all   c: committed   u: uncommitted                 │  R5 tabs: active not dim, label semibold; others dimColor; hotkey letter = engine suggestion
│━━━━━━─────────────────────────────────────────────────│  R6 rule: ━ suggestion under active tab, ─ subtle
│5 files  ● 2 uncommitted                       +202 −34│  R7 summary (follows mode): "5 files" text · "● 2 uncommitted" suggestion/dim · +success −error
│▾ docs/specs/                                          │  dir row: Button plain holds only "▾ docs/specs/" (▾ dim); no count while open
│  A   ui-spec.md                                    +80│  A success · name text · +80 success
│                                                       │  marginTop 1 before a depth-0 row after a deeper one (skip after a diff)
│▾ src/auth/                                            │
│  M ● login-form.tsx                            +96 −30│  FOCUS: only "login-form.tsx" inverts; M warning · ● suggestion · counts outside Button
│  R   session.ts ← token.ts                      +12 −4│  expanded: name semibold · R suggestion · "← token.ts" dim
│      @@ 12  export async function getSession(req) {   │  diff Box paddingLeft = name column · "@@ 12" dim, ctx dim italic
│        const token = readCookie(req)                  │  context: dim
│      - const raw = readToken(req)                     │  - line: error fg, no background
│      + const raw = readSession(req)                   │  + line: success fg, no background
│      + if (!raw) return null                          │
│        return decode(raw)                             │
│      @@ 40  export async function refresh(req, res) { │
│      - await rotate(token)                            │
│      + await rotateSession(raw)                       │
│                                                       │  diff Box marginBottom 1
│? ● scratch.md                                      +14│  ? dim → keep existing map · ● suggestion
│A   banner.png                                      bin│  bin dim

(2) 42 列。展开的是新增文件，按 source 视图画。

│feat/auth-ui-polish                  ↑3 ↓1│
│vs origin/feat/auth-ui    reflog · 8b05b1d│
│r: refresh  t: list  z: fold  x: collapse │
│                                          │
│a: all   c: committed   u: uncommitted    │
│━━━━━━────────────────────────────────────│
│5 files  ● 2                      +202 −34│  legend shortens to "● 2" under 46 cols
│▾ docs/specs/                             │
│  A   ui-spec.md                       +80│
│       1 # UI spec                        │  added/untracked: <Code format="source" startLine={1}> — syntax colour, dim gutter, NO green block
│       2                                  │
│       3 Branch on row one, ↑↓ on its ri… │
│       4 The base ref sits under it, wi…  │
│      … 76 more lines — open in editor    │  dim note, same paddingLeft
│                                          │
│▾ src/auth/                               │
│  M ● login-form.tsx               +96 −30│  collapsed dir would read "▸ src/auth/ (2)  +108 −34" all dim
│  R   session.ts ← token.ts         +12 −4│
│                                          │
│? ● scratch.md                         +14│

(3) 空状态，55 列。

│feat/auth-ui-polish                               ↑0 ↓0│  ↑0 ↓0 both dim
│vs origin/feat/auth-ui                 reflog · 8b05b1d│
│r: refresh  t: list                                    │  z/x hidden as today
│                                                       │
│a: all   c: committed   u: uncommitted                 │
│━━━━━━─────────────────────────────────────────────────│  no summary row when empty
│                                                       │
│✓ No changes vs origin/feat/auth-ui                    │  ✓ success · sentence text
│  Edits will show up here as you work.                 │  dim

(3b) 没有 base，55 列。git 报错时版式相同，换成「✕ git failed」（error），下面是 dim 的 git 原文（wrap）和「r to retry」。

│feat/auth-ui-polish                                    │
│vs —  no base branch                                   │  "vs —" dim · "no base branch" warning
│r: refresh  t: list                                    │
│                                                       │
│a: all   c: committed   u: uncommitted                 │
│━━━━━━─────────────────────────────────────────────────│
│                                                       │
│! Nothing to compare against                           │  ! warning · title text semibold
│  Set one with /wt-diff base <ref>,                    │  dim; command text
│  or press u for uncommitted changes.                  │  dim; "u" suggestion
```

## 颜色与样式约定
所有颜色都用 ThemeKey 或 dimColor，没有原始颜色。
- 分支名：Text weight="semibold"，默认色 text。
- 次要信息，一律 dimColor：vs、base 来源·sha、↑0/↓0、↻、目录的 ▾▸ 和折叠后的 (N)/计数、@@ N、diff 上下文行、bin、← old、「… N more lines」、空状态副句、list 视图的目录部分。
- ↑N（N>0）用 text；↓N（N>0）用 warning，提示该 rebase 了。
- 模式标签条：当前模式不 dim，label 用 semibold；其余两个用 Button dimColor。hotkey 字母由引擎画成 suggestion，插件改不了，三个标签的 hotkey 字母颜色相同，当前标签只靠 label 的亮度、粗细和下面的 ━ 区分。
- 标签下划线：━ 用 suggestion，长度等于当前标签宽度（3+label.length），偏移是前面各标签宽度加上每处 3 列间距的累加；其余部分画 ─，用 subtle。标签条折行时（宽度小于 38）不画 ━，改给当前 label 加 underline。
- 动作按钮 r/t/z/x：plain Button dimColor，指针悬停或聚焦时恢复全亮。dimColor 只作用在「: label」上，hotkey 字母仍是全亮的 suggestion（真引擎 2.1.312 实测，插件没有 prop 能改）。
- 状态字母沿用现有映射：A 用 success，D/U 用 error，M/T 用 warning，R/C 用 suggestion，? 用 dim。
- ●（未提交，只在 mode=all 时出现）：suggestion。摘要行的「● 2 uncommitted」同时充当图例，其中数字用 suggestion，单词用 dim。
- 计数：+N 用 success，−N 用 error，为 0 的一侧在文件行省略；目录汇总只在折叠时显示，整体 dim。
- 展开的文件：文件名 semibold。
- 焦点：引擎画的反色，插件关不掉，现在只覆盖文件名或「▾ dir/」那几格。
- diff（diffStyle=quiet，修改的文件）：+ 行用 success 前景色，- 行用 error 前景色，上下文行 dim，hunk 头写成「@@ <新起始行>  <函数上下文 italic>」并整行 dim。不画行号，也不画底色。
- 新增和未跟踪文件：引擎 Code 的 source 视图，带语法高亮，行号槽是 dim。
- 删除的文件：一行 Text color=error，写「deleted · N lines」。
- 提示块：! 用 warning，✕ 用 error，✓ 用 success；标题 semibold，正文 dim，可操作的字母用 suggestion。
- 间距：Box 的 margin/padding 不占文字预算。分隔线每条占 columns 个字符，要计入预算。

## 实现清单
只改 hooks/register.tsx（另配一个纯函数文件），tree.ts 不用改。
1. drawHeader 改成两行，每行是 Box row justifyContent="space-between"。R1 左边是分支名，先按 columns−cellWidth(右侧)−2 用 fitPath 截好；右边是 [↻ 或两个空格] ↑N ↓N。R2 左边是 vs + ref，右边是 source · sha，窄时先去掉 source 再去掉 sha。删掉 fitHeader 里的 → 和行尾的「 …」。没有 base 时 R2 写「vs —  no base branch」，不画 ↑↓。
2. drawControls 拆成两个函数。
   - drawActions：Box row flexWrap columnGap=2，放 r/t/z/x 四个 plain Button，全部 dimColor，出现条件不变；下面接 marginBottom=1。
   - drawTabs：Box row columnGap=3，放三个模式 Button。当前模式不加 dimColor，children 改为 <Text weight="semibold">；其余加 dimColor。variant=primary 保留给 desktop。
3. 新增 drawRule(activeIndex, columns)：画 <Text color="suggestion">━×w</Text><Text color="subtle">─×rest</Text>，偏移按 ASCII label 计算。columns<38 时画纯 ─，当前 label 改加 underline。这条线计入预算。
4. 新增 drawSummary：左边是「N files」，mode=all 时接「  ● k uncommitted」（宽度小于 46 时只写「● k」）；右边是 +/−。列表为空、出错、没有 base 时不画这一行。
5. drawRow 和 drawDirRow 改为 <Box key="row:<path>" flexDirection="row" justifyContent="space-between">，左侧再套一个 Box row，依次是缩进 Text、状态字母 Text、' ● ' 或三个空格、<Button key="file:<path>" plain onPress>{name}</Button>、dim 的 ← old；右侧放计数。删掉 gapBefore 和所有补齐空格，room 和 fitPath 预截断保留。目录行的 Button 只包「▾ name/」，▾ 用 dim Text 写进 children；只在折叠时在右侧画 dim 的 (N) 和计数。非 terminal surface 的 indented 路径不动。
6. drawPane 记录上一行的深度：深度 0 的行如果接在更深的行后面，外包 <Box marginTop={1}>；上一项是 diff 时不加。
7. 新建纯函数文件 hooks/diff-lines.ts：parseHunks(hunks) 返回 DiffLine[]，类型是 {kind:'hunk'|'add'|'del'|'ctx'|'meta', newStart?, ctx?, text}；isPureAdd(hunks) 在只有一个 @@ -0,0 hunk 且全是 + 行时为真。tab 展开成空格，每行过 printable；不认识的行按 ctx 处理，绝不抛异常。配单元测试。
8. drawDiff 按顺序判断：
   - 纯新增：<Code format="source" path startLine={1} wrap="truncate-end" source={去掉 + 前缀}/>
   - 删除的文件：一行 error Text
   - 其他：diffStyle==='engine' 时走原来的 Code diff，否则逐行画 Text wrap="truncate-end"
   三种都包在 <Box flexDirection="column" paddingLeft={nameCol} marginBottom={1}>。note() 的 paddingLeft 也改成 nameCol。预算 chars 改为按实际画出的字符累加。
9. emptyText 改成返回 {glyph, tone, title, hint}，画成两三行：空状态是 ✓/success，没有 base 是 !/warning，git 出错是 ✕/error。
10. 状态栏：statusLine=true 时，terminal 上不再调 $.ui.status，改在已有的 PromptHint hook 里返回 next({...e, props:{...e.props, tail:'· 5 files +202 −34'}})；其他 surface 仍用 status('5 files +202 −34')，去掉 wt。加载时调一次 $.ui.status(undefined) 清掉旧的。snapshot 写入后如果 PromptHint 不重绘，补一次 $.ui.invalidate。
11. Config 增加 diffStyle: 'quiet'|'engine'，默认 quiet。bold 全部换成 weight="semibold"。同步更新 README.md 的配置表和 statusLine 说明，以及 hooks/register.test.tsx 里涉及 drawPane、fitHeader、statusLineText 的断言。

## 风险与需要实测的点
需要实测或注意的点：
1. 焦点反色插件关不掉，只能把范围缩到文件名。代价是点计数区域不再触发展开。不要依赖 hover={{inverse:false}}，d.ts 和引擎源码的说法互相矛盾。
2. justifyContent="space-between" 配合引擎给 Button 外包的 flexShrink 0 Box，能不能把计数贴到右缘，要实测。如果不行，退回按 cellWidth 计算补齐，但补齐空格要放在 Button 外面。
3. 标签下划线的偏移靠 ASCII 宽度计算，如果引擎画 plain Button 的「a: 」前缀和我们算的不一样，━ 会画歪。用一次截图核对；标签条折行时已有降级。
4. 自己逐行画 diff 会失去修改文件的语法高亮和词级 diff，用 diffStyle:'engine' 兜底。展开多个文件时会有上千个 Text 元素，d.ts 没写元素上限，需要看一下性能；连续同类的行可以合并，但多行 Text 下 truncate-end 是否逐行生效没有验证，先逐行画。
5. 纯新增文件只有在 hunk 完整时才走 source 视图。被 MAX_DIFF_LINES 截断时仍可用，后面接「… N more lines」，因为 source 模式不需要解析 hunk。
6. 亮色主题下，subtle 的 ─ 和 dim 的上下文行可能偏淡，要在 light 主题下目测一次。太淡的话，上下文行改回默认 text。
7. ━ ─ ● ▾ ↑ ↓ − ← ↻ 都可能是 East Asian Ambiguous 宽度。终端设成「ambiguous 按双宽」时，右对齐会错位。这个问题现在就有，可以选做一个 ASCII glyph 回退。
8. PromptHint 的 tail 会不会跟着 snapshot 更新没有验证，兜底办法是调 $.ui.invalidate。
9. 内容前的固定行数从 4 行增加到 7 行（header 2、actions 1、空行 1、tabs 1、rule 1、summary 1），换来层级清楚。如果嫌高，可以先去掉 actions 下面的空行。
10. 重绘频率不变：没有自定义焦点标记，也不新增 atom。

## 验收
- `claude plugin validate`、`claude plugin test`、tsc 全部通过；已有行为（模式、树/列表、折叠、展开 diff、命令、刷新）不回归。
- 新增测试：diff-lines.ts 解析（hunk/add/del/ctx、tab、坏输入不抛）、isPureAdd；渲染在 terminal/desktop 下的头部两行、标签下划线位置（含窄宽降级）、摘要行、焦点 Button 只包文件名、计数在 Button 之外、深度 0 行前的空行、三种空状态、diffStyle=engine 回退、statusLine 走 PromptHint tail。
- 42、55、75 列下逐行宽度不超过 bodyColumns（测试里断言）。
