import { describe, expect, mock, test as kitTest, type Engine, type TestBody, type TestOptions } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import {
  cellWidth,
  fitPath,
  FOCUSED,
  FOCUSED_SIDE,
  focusRow,
  inTurn,
  keepRecent,
  keptCursor,
  navAction,
  oneLine,
  printable,
  readConfig,
  sideRing,
  statusLineText,
  USAGE,
  type NavRow,
} from './register'
import type { RunResult } from './git'

/** v0.3's tests: the inline view, each opened file under its row, unless a test says otherwise. */
const test = (name: string, ...rest: readonly [TestBody] | readonly [TestOptions, TestBody]) => {
  const [given, body] = rest.length === 1 ? [{}, rest[0]] : rest
  kitTest(name, { ...given, options: { diffView: 'inline', ...given.options } }, body)
}
/** The side view, the default. */
const sideTest = kitTest

// Real git 2.54 output from the throwaway feat worktree git.test.ts describes:
// commits on feat edit a.txt, rename "src/old name.txt", delete gone.txt and
// add binary bin.dat; the worktree has a.txt edited, keep.txt staged and
// untracked untracked.md and dir/ubin.bin.
const REPO = '/w/t1-repo'
const ROOT = '/w/t1-wt'
const MB = '73481c517fc2281f8cce4efd1db9924969e17976'
const MAIN_SHA = '1dfc5da93a873c05245d17f21969887d1d0d6fe4'

type Answer = Partial<RunResult & { isStdoutTruncated: boolean }>
const ok = (stdout: string): Answer => ({ exitCode: 0, stdout })
const fail = (exitCode: number, stderr: string): Answer => ({ exitCode, stdout: '', stderr })

const NOT_A_REPO = fail(128, 'fatal: not a git repository (or any of the parent directories): .git\n')
const NO_UPSTREAM = fail(128, "fatal: no upstream configured for branch 'feat'\n")
const NO_ORIGIN_HEAD = fail(128, 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n')

const PORCELAIN_FEAT =
  `worktree ${REPO}\nHEAD ${MAIN_SHA}\nbranch refs/heads/main\n\n` +
  `worktree ${ROOT}\nHEAD e47b652208a1df9b8a3cbff954e65fc4b24fd4db\nbranch refs/heads/feat\n\n`

const NUMSTAT_ALL =
  '3\t1\ta.txt\0-\t-\tbin.dat\0' +
  '0\t2\tgone.txt\0' +
  '1\t0\tkeep.txt\0' +
  '1\t0\t\0src/old name.txt\0src/new näme.txt\0'
const NAMES_ALL =
  'M\0a.txt\0A\0bin.dat\0D\0gone.txt\0M\0keep.txt\0R094\0src/old name.txt\0src/new näme.txt\0'
const NUMSTAT_COMMITTED =
  '2\t1\ta.txt\0-\t-\tbin.dat\0' + '0\t2\tgone.txt\0' + '1\t0\t\0src/old name.txt\0src/new näme.txt\0'
const NAMES_COMMITTED = 'M\0a.txt\0A\0bin.dat\0D\0gone.txt\0R094\0src/old name.txt\0src/new näme.txt\0'
const NUMSTAT_WORKTREE = '1\t0\ta.txt\0' + '1\t0\tkeep.txt\0'
const NAMES_WORKTREE = 'M\0a.txt\0M\0keep.txt\0'
const NAMES_ONLY_COMMITTED = 'a.txt\0bin.dat\0gone.txt\0src/new näme.txt\0src/old name.txt\0'
const NAMES_ONLY_WORKTREE = 'a.txt\0keep.txt\0'
const UNTRACKED = 'dir/ubin.bin\0untracked.md\0'

const DIFF_A_ALL =
  'diff --git a/a.txt b/a.txt\nindex 83db48f..8ce4ec5 100644\n--- a/a.txt\n+++ b/a.txt\n' +
  '@@ -1,3 +1,5 @@\n line1\n-line2\n+LINE2\n line3\n+line4\n+extra\n'
const HUNKS_A_ALL = '@@ -1,3 +1,5 @@\n line1\n-line2\n+LINE2\n line3\n+line4\n+extra'
const DIFF_A_COMMITTED =
  'diff --git a/a.txt b/a.txt\nindex 83db48f..f75f249 100644\n--- a/a.txt\n+++ b/a.txt\n' +
  '@@ -1,3 +1,4 @@\n line1\n-line2\n+LINE2\n line3\n+line4\n'

const featTable = (overrides: Record<string, Answer> = {}): Record<string, Answer> => ({
  'rev-parse --show-toplevel': ok(`${ROOT}\n`),
  'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(
    `${REPO}/.git/worktrees/t1-wt\n${REPO}/.git\n`,
  ),
  'symbolic-ref --short -q HEAD': ok('feat\n'),
  'rev-parse --verify --quiet --short HEAD': ok('e47b652\n'),
  'reflog show --format=%gs refs/heads/feat': ok('commit: feat1\nbranch: Created from main\n'),
  'rev-parse --verify --quiet main^{commit}': ok(`${MAIN_SHA}\n`),
  'rev-parse --abbrev-ref feat@{upstream}': NO_UPSTREAM,
  'worktree list --porcelain': ok(PORCELAIN_FEAT),
  'symbolic-ref --short refs/remotes/origin/HEAD': NO_ORIGIN_HEAD,
  'merge-base main HEAD': ok(`${MB}\n`),
  'rev-list --left-right --count main...HEAD': ok('1\t1\n'),
  [`diff --numstat -z -M ${MB} --`]: ok(NUMSTAT_ALL),
  [`diff --name-status -z -M ${MB} --`]: ok(NAMES_ALL),
  [`diff --numstat -z -M ${MB} HEAD --`]: ok(NUMSTAT_COMMITTED),
  [`diff --name-status -z -M ${MB} HEAD --`]: ok(NAMES_COMMITTED),
  'diff --numstat -z -M HEAD --': ok(NUMSTAT_WORKTREE),
  'diff --name-status -z -M HEAD --': ok(NAMES_WORKTREE),
  [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(NAMES_ONLY_COMMITTED),
  'diff --name-only -z --no-renames HEAD --': ok(NAMES_ONLY_WORKTREE),
  'ls-files --others --exclude-standard -z': ok(UNTRACKED),
  [`diff -M ${MB} -- :(literal)a.txt`]: ok(DIFF_A_ALL),
  [`diff -M ${MB} HEAD -- :(literal)a.txt`]: ok(DIFF_A_COMMITTED),
  ...overrides,
})

const featFiles: Record<string, string> = {
  [`${ROOT}/untracked.md`]: 'u1\nu2\nu3\n',
  [`${ROOT}/dir/ubin.bin`]: 'x\0y',
}

// Only a snapshot pass asks for the branch: one call per pass.
const PASS_MARK = 'symbolic-ref --short -q HEAD'

const PREFIX = ['git', '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false', '-c', 'diff.context=3', '--no-optional-locks']

/** The args after git's fixed prefix, diff's hardening flags dropped. */
const keyOf = (argv: readonly string[]) => {
  expect(argv.slice(0, PREFIX.length)).toEqual(PREFIX)
  const rest = argv.slice(PREFIX.length)
  if (rest[0] === 'diff') {
    expect(rest.slice(1, 3)).toEqual(['--no-color', '--no-ext-diff'])
    return ['diff', ...rest.slice(3)].join(' ')
  }

  return rest.join(' ')
}

type World = {
  table?: Record<string, Answer>
  /** Answers that differ by the directory git runs in, over `table`. */
  byCwd?: Record<string, Record<string, Answer>>
  /** Directories `$.fs.stat` finds. */
  dirs?: readonly string[]
  files?: Record<string, string>
  /** Paths `$.fs.stat` calls symbolic links. */
  links?: readonly string[]
  cwd?: string
  isOpen?: boolean
  isPlaced?: boolean
  /** A placed pane that is a tab behind another plugin's. */
  isShown?: boolean
  /** What `$.store` holds at the start. */
  store?: Record<string, unknown>
  /** What `$.session.surfaces()` answers; the terminal alone by default. */
  surfaces?: readonly RenderSurface[]
}

/** A promise a test settles by hand. */
const gate = () => {
  let open = () => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })

  return { promise, open }
}

/** Stands for the engine beneath the plugin: git, the files, the session, the pane. */
const world = (on: On, given: World = {}) => {
  const state = {
    table: given.table ?? featTable(),
    byCwd: given.byCwd ?? {},
    dirs: new Set(given.dirs ?? [REPO, ROOT]),
    files: given.files ?? featFiles,
    cwd: given.cwd ?? ROOT,
    isOpen: given.isOpen ?? true,
    isPlaced: given.isPlaced ?? true,
    isShown: given.isShown ?? true,
    /** Where EnterWorktree moves the session; a string deny refuses it instead. */
    enter: { cwd: ROOT, deny: undefined as string | undefined, isError: false },
    /** While set, every git call waits on it, after calling `onHold`. */
    hold: undefined as Promise<void> | undefined,
    onHold: () => {},
    calls: [] as string[],
    /** `$.store`'s contents. */
    store: new Map<string, unknown>(Object.entries(given.store ?? {})),
    panesCalls: 0,
    inits: [] as unknown[],
    statuses: [] as (string | undefined)[],
    surfaces: given.surfaces ?? (['terminal'] as readonly RenderSurface[]),
    opened: 0,
    openArgs: [] as unknown[],
    /** Whether an open asking for the keyboard gets it: false as over text in the composer. */
    grantsFocus: true,
    isFocused: false,
    /** The moves of the pane's body that reached the engine. */
    scrolls: [] as unknown[],
  }
  const clock = mock.clock(on, { now: 1_000 })
  // As mock.store, but open to the test.
  on('store.get', (_, e) => ({ value: state.store.get(e.key) }))
  on('store.set', (_, e) => {
    state.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    state.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...state.store.keys()] }))
  on('process.run', async (_, e) => {
    const key = keyOf(e.argv)
    state.calls.push(key)
    state.inits.push(e.init)
    if (state.hold) {
      state.onHold()
      await state.hold
    }
    const answer = state.byCwd[e.init?.cwd ?? '']?.[key] ?? state.table[key] ?? fail(128, `fatal: unmocked: ${key}\n`)

    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
        ...answer,
      },
    }
  })
  on('fs.read', (_, e) => {
    const text = state.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', (_, e) => {
    if (state.dirs.has(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    const text = state.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    const isLink = given.links?.includes(e.path) ?? false
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink } }
  })
  on('session.cwd', () => ({ value: state.cwd }))
  on('session.surfaces', () => ({ value: state.surfaces }))
  // The engine keeps the roster; a test sets state.surfaces itself.
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.detach', (_, e) => ({ clientId: e.clientId }))
  on('command.register', () => ({ value: { command: 'wt-diff' } }))
  on('ui.panes', () => {
    state.panesCalls += 1
    return {
      value: state.isOpen
        ? [
            {
              id: 'worktree-diff',
              title: 'Changes',
              isShown: state.isPlaced && state.isShown,
              isFocused: state.isFocused,
              isPlaced: state.isPlaced,
            },
          ]
        : [],
    }
  })
  // Every open in these tests is asked for, so placed at any width.
  on('ui.open', (_, e) => {
    state.opened += 1
    state.openArgs.push(e)
    state.isOpen = true
    state.isPlaced = true
    state.isShown = true
    if (e.focus === true) state.isFocused = state.grantsFocus
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    state.isOpen = false
    state.isFocused = false
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'EnterWorktree') return { result: {} }
    if (state.enter.deny !== undefined) return { deny: state.enter.deny }
    if (state.enter.isError) return { result: {}, isError: true }
    state.cwd = state.enter.cwd
    return { result: {} }
  })
  on('turn.complete', () => ({ text: '' }))
  // The person's move of the pane's ring, raised by a test, lands where it is asked.
  on('ui.focus', () => ({}))
  on('ui.scroll', (_, e) => {
    state.scrolls.push(e)
    return {}
  })
  // The engine's own hint line, which tells the mod how the screen is laid out; a tail ends it.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tail ? `${e.props.hint} ${e.props.tail}` : e.props.hint}</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return { state, clock }
}

const PANE = {
  plugin: 'worktree-diff',
  component: 'Pane',
  requestId: 'worktree-diff',
  props: {
    title: 'Changes',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

/** Draws the prompt's hint line once, on the fullscreen layout or the main screen. */
const drawHint = async ($: Engine, isFullscreen: boolean) => {
  const ui = await $.ui.mount({
    plugin: 'worktree-diff',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    viewport: { columns: 160, rows: 40, isFullscreen },
  })
  await ui.unmount()
}

/** Types `/wt-diff <args>` at the prompt, as the person does. */
const wtDiff = ($: Engine, args = '') =>
  $.command.run({
    command: 'wt-diff',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

// ----------------------------------------------------------------- paint

/** An element as `drawn()` and `find()` give it: plain data. */
type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** A Space in cells: across, or down. */
const space = (value: unknown, isDown = false): number => {
  if (typeof value === 'number') return value
  const steps: Record<string, readonly [number, number]> = { xs: [1, 0], sm: [1, 0], md: [2, 1], lg: [3, 1], xl: [4, 2] }
  return typeof value === 'string' ? (steps[value]?.[isDown ? 1 : 0] ?? 0) : 0
}

const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object') return ''
  return ((node as Drawn).children ?? []).map(textOf).join('')
}

/** As the terminal draws a Button: plain is `h: label`, else `[ label ]`. */
const buttonText = (node: Drawn): string => {
  const { label, hotkey, plain } = node.props ?? {}
  const inner = (node.children ?? []).length > 0 ? textOf(node) : String(label ?? '')
  if (plain !== true) return `[ ${inner} ]`
  return typeof hotkey === 'string' ? `${hotkey}: ${inner}` : inner
}

/** Splits `text` after at most `cells` cells, whole code points. */
const splitCells = (text: string, cells: number): [string, string] => {
  let used = 0
  let head = ''
  for (const char of text) {
    used += cellWidth(char)
    if (used > cells) break
    head += char
  }
  return [head, text.slice(head.length)]
}

const cutCells = (text: string, cells: number): string =>
  cellWidth(text) <= cells ? text : `${splitCells(text, Math.max(0, cells - 1))[0]}…`

const wrapCells = (text: string, cells: number): string[] => {
  const lines: string[] = []
  let rest = text
  while (cellWidth(rest) > cells && cells > 0) {
    const [head, tail] = splitCells(rest, cells)
    lines.push(head)
    rest = tail
  }
  return [...lines, rest]
}

const padCells = (text: string, cells: number): string => text + ' '.repeat(Math.max(0, cells - cellWidth(text)))

/** A Code's line numbers, as wide as the last and a space; none without `startLine`. */
const gutterOf = (props: Record<string, unknown>): number =>
  typeof props.startLine === 'number' && props.format !== 'diff'
    ? String(props.startLine + String(props.source).split('\n').length - 1).length + 1
    : 0

/** The cells a node takes on one row, nothing wrapped. */
const natural = (node: unknown): number => {
  if (typeof node === 'string') return cellWidth(node)
  const { type, props = {}, children = [] } = node as Drawn
  if (type === 'Text') return Math.max(...textOf(node).split('\n').map(cellWidth))
  if (type === 'Button') return cellWidth(buttonText(node as Drawn))
  if (type === 'Code') return gutterOf(props) + Math.max(...String(props.source).split('\n').map(cellWidth))
  if (typeof props.width === 'number') return props.width
  const pad = space(props.paddingLeft ?? props.paddingX ?? props.padding) + space(props.paddingRight ?? props.paddingX ?? props.padding)
  const sizes = children.map(natural)
  if (props.flexDirection === 'column') return Math.max(0, ...sizes) + pad
  return sizes.reduce((sum, size) => sum + size, 0) + space(props.columnGap ?? props.gap) * Math.max(0, sizes.length - 1) + pad
}

/** A row Box's children: each at its own width, wrapped if it wraps, spread if it spreads; never shrunk. */
const paintRow = (kids: unknown[], width: number, props: Record<string, unknown>): string[] => {
  const gap = space(props.columnGap ?? props.gap)
  const sizes = kids.map(natural)
  const groups: number[][] = [[]]
  let used = 0
  sizes.forEach((size, index) => {
    const group = groups[groups.length - 1] as number[]
    if (props.flexWrap === 'wrap' && group.length > 0 && used + gap + size > width) {
      groups.push([index])
      used = size
    } else {
      used += (group.length > 0 ? gap : 0) + size
      group.push(index)
    }
  })
  return groups.flatMap(group => {
    const total = group.reduce((sum, index) => sum + (sizes[index] ?? 0), 0) + gap * Math.max(0, group.length - 1)
    const extra = props.justifyContent === 'space-between' && group.length > 1 ? Math.max(0, width - total) : 0
    const blocks = group.map(index => paint(kids[index], sizes[index] ?? 0))
    const height = Math.max(0, ...blocks.map(block => block.length))
    return Array.from({ length: height }, (_, row) =>
      group
        .map((index, at) => {
          const spread = at === 0 ? 0 : gap + Math.floor((extra * at) / (group.length - 1)) - Math.floor((extra * (at - 1)) / (group.length - 1))
          return ' '.repeat(spread) + padCells(blocks[at]?.[row] ?? '', sizes[index] ?? 0)
        })
        .join(''),
    )
  })
}

/**
 * The lines a terminal prints for `node` in `width` cells: a rough flexbox
 * that never shrinks a child, so a row too wide for the pane shows as one.
 * Code is its source, each line cut as `truncate-end` does.
 */
const paint = (node: unknown, width: number): string[] => {
  if (typeof node === 'string') return [node]
  const { type, props = {}, children = [] } = node as Drawn
  if (type === 'Text') {
    const lines = textOf(node).split('\n')
    return String(props.wrap ?? 'wrap').startsWith('truncate')
      ? lines.map(line => cutCells(line, width))
      : lines.flatMap(line => wrapCells(line, width))
  }
  if (type === 'Button') return [buttonText(node as Drawn)]
  if (type === 'Code') {
    const gutter = gutterOf(props)
    return String(props.source)
      .split('\n')
      .map((line, index) => {
        const number = gutter > 0 ? `${String(Number(props.startLine) + index).padStart(gutter - 1)} ` : ''
        return number + (props.wrap === 'truncate-end' ? cutCells(line, width - gutter) : line)
      })
  }
  const left = space(props.paddingLeft ?? props.paddingX ?? props.padding)
  const right = space(props.paddingRight ?? props.paddingX ?? props.padding)
  const top = space(props.marginTop ?? props.marginY ?? props.margin, true)
  const bottom = space(props.marginBottom ?? props.marginY ?? props.margin, true)
  const inner = width - left - right
  const laid =
    props.flexDirection === 'column' ? children.flatMap(kid => paint(kid, inner)) : paintRow(children, inner, props)
  // A fixed height cuts what is past it and fills what is short of it.
  const lines =
    typeof props.height === 'number'
      ? Array.from({ length: props.height }, (_, row) => laid[row] ?? '')
      : laid

  return [...Array<string>(top).fill(''), ...lines.map(line => ' '.repeat(left) + line), ...Array<string>(bottom).fill('')]
}

/** The whole pane as printed at `columns`, trailing spaces kept. */
const screen = async (ui: { drawn: () => Promise<unknown> }, columns: number): Promise<string[]> =>
  paint(await ui.drawn(), columns)

/** The lines above the terminal's dim `ctrl+x tab to focus` and its blank line. */
const aboveKeys = (lines: readonly string[]): string[] =>
  lines.at(-1)?.trimEnd() === 'ctrl+x tab to focus' ? lines.slice(0, -2) : [...lines]

/** One row as printed at `columns`: its row Box, the indent of a desktop wrapper left out. */
const rowLine = async (
  ui: { find: (query: { key: string }) => Promise<Drawn | undefined> },
  key: string,
  columns = 60,
): Promise<string> => {
  const row = await ui.find({ key: `row:${oneLine(key)}` })
  return row === undefined ? '' : paint(row, columns).join('\n')
}

/** The paths whose diff is drawn, in order. */
const opened = async (ui: { drawn: () => Promise<unknown> }): Promise<string[]> => {
  const out: string[] = []
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    const { key, props, children } = node as Drawn & { key?: string }
    const name = key ?? props?.key
    if (typeof name === 'string' && name.startsWith('diff:')) out.push(name.slice('diff:'.length))
    const kids = children ?? props?.children
    if (Array.isArray(kids)) kids.forEach(walk)
    else walk(kids)
  }
  walk(await ui.drawn())
  return out
}

/** An open file's diff as its lines read, Code's source split; undefined when none is drawn. */
const diffOf = async (
  ui: { find: (query: { key: string }) => Promise<Drawn | undefined> },
  path: string,
): Promise<string[] | undefined> => {
  const box = await ui.find({ key: `diff:${oneLine(path)}` })
  if (box === undefined) return undefined
  return (box.children ?? []).flatMap(kid => {
    const { type, props = {} } = kid as Drawn
    return type === 'Code' ? String(props.source).split('\n') : [textOf(kid)]
  })
}

// ------------------------------------------------------------------ pure

describe('helpers', () => {
  test('fitPath keeps the first directory and the file name', async () => {
    expect(fitPath('src/app.ts', 20)).toBe('src/app.ts')
    expect(fitPath('src/deep/nested/dir/file.ts', 20)).toBe('src/…/dir/file.ts')
    expect(fitPath('src/deep/nested/dir/file.ts', 12)).toBe('…/file.ts')
    expect(fitPath('averyveryverylongfilename.ts', 10)).toBe('aver…me.ts')
    expect(fitPath('abc', 1)).toBe('…')
    for (const max of [3, 5, 8, 13, 21]) {
      expect(fitPath('a/bb/ccc/dddd/eeeee/ffffff.txt', max).length).toBeLessThanOrEqual(max)
    }
  })

  test('readConfig fills defaults and refuses odd values', async () => {
    expect(readConfig({})).toEqual({
      autoOpen: 'worktree',
      pollSeconds: 5,
      statusLine: false,
      diffStyle: 'quiet',
      paneBackground: 'transparent',
      diffView: 'side',
    })
    expect(
      readConfig({
        autoOpen: 'never',
        pollSeconds: 0,
        statusLine: true,
        diffStyle: 'engine',
        paneBackground: 'theme',
        diffView: 'inline',
      }),
    ).toEqual({
      autoOpen: 'never',
      pollSeconds: 0,
      statusLine: true,
      diffStyle: 'engine',
      paneBackground: 'theme',
      diffView: 'inline',
    })
    expect(readConfig({ paneBackground: 'plaid' }).paneBackground).toBe('transparent')
    expect(readConfig({ diffView: 'beside' }).diffView).toBe('side')
    expect(readConfig({ diffStyle: 'loud' }).diffStyle).toBe('quiet')
    expect(readConfig({ autoOpen: 'sometimes', pollSeconds: -3 }).autoOpen).toBe('worktree')
    expect(readConfig({ pollSeconds: -3 }).pollSeconds).toBe(0)
  })

  test('statusLineText is empty without changes', async () => {
    expect(statusLineText(null)).toBeUndefined()
  })

  test('printable and oneLine keep only what the engine draws', async () => {
    expect(printable('+a\x1b[31m\n+\f\n\tx\r\ny\r')).toBe('+a\uFFFD[31m\n+\uFFFD\n\tx\ny')
    expect(oneLine('a\x1bb\nc\td\x7f')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFD')
  })

  test('cellWidth counts wide characters twice; fitPath fits cells, whole code points', async () => {
    expect(cellWidth('文档/说明.md')).toBe(12)
    expect(cellWidth('a😀b')).toBe(4)
    expect(cellWidth('näme')).toBe(4)
    expect(fitPath('文档/说明.md', 12)).toBe('文档/说明.md')
    for (const max of [3, 6, 9, 10, 15]) {
      expect(cellWidth(fitPath('文档/很长的目录/说明文件.md', max))).toBeLessThanOrEqual(max)
      const fitted = fitPath('😀😀😀😀😀😀😀😀😀😀.txt', max)
      expect(cellWidth(fitted)).toBeLessThanOrEqual(max)
      // No surrogate half left over from a cut through an emoji.
      expect(Array.from(fitted).every(char => char.length === 2 || !/[\uD800-\uDFFF]/.test(char))).toBe(true)
    }
  })
})

// ------------------------------------------------------------------ pane

describe('pane', () => {
  test('the list view lists the files under a header, as v0.1 did, on terminal and desktop', async ($, on) => {
    world(on, { store: { view: 'list' } })
    await wtDiff($, 'refresh')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const lines = await screen(ui, 60)
      // Two header rows, the actions and a blank, the tabs, the rule on the terminal, the summary.
      expect(lines.slice(0, 5).map(line => line.trimEnd())).toEqual([
        `feat${' '.repeat(51)}↑1 ↓1`,
        `vs main${' '.repeat(37)}reflog · 73481c5`,
        'r: refresh  t: tree',
        '',
        'a: all   c: committed   u: uncommitted',
      ])
      const summary = lines[surface === 'terminal' ? 6 : 5] ?? ''
      expect(summary).toMatch(/^7 files {2}● 4 uncommitted +\+8 −3$/)
      expect(cellWidth(summary)).toBe(60)
      // The branch is semibold, ↓ in warning: the base moved on.
      expect((await ui.find({ type: 'Text', text: 'feat' }))?.props).toMatchObject({ weight: 'semibold' })
      expect((await ui.find({ type: 'Text', text: '↓1' }))?.props).toMatchObject({ color: 'warning' })
      expect((await ui.find({ type: 'Text', text: '  ● 4' }))?.props).toMatchObject({ color: 'suggestion' })

      const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key)
      expect(keys).toEqual([
        'refresh',
        'view',
        'mode:all',
        'mode:committed',
        'mode:uncommitted',
        'file:a.txt',
        'file:bin.dat',
        'file:dir/ubin.bin',
        'file:gone.txt',
        'file:keep.txt',
        'file:src/new näme.txt',
        'file:untracked.md',
      ])
      expect((await ui.find({ key: 'mode:all' }))?.props.variant).toBe('primary')
      expect((await ui.find({ key: 'mode:all' }))?.props.dimColor).toBeUndefined()
      expect(JSON.stringify((await ui.find({ key: 'mode:all' }))?.children)).toContain('"weight":"semibold"')
      expect((await ui.find({ key: 'mode:committed' }))?.props.variant).toBeUndefined()
      // Plain, so the terminal draws each hotkey beside its label; all but the current mode dim.
      for (const key of ['mode:committed', 'mode:uncommitted', 'refresh', 'view']) {
        expect((await ui.find({ key }))?.props).toMatchObject({ plain: true, dimColor: true })
      }
      expect((await ui.find({ key: 'mode:committed' }))?.props.hotkey).toBe('c')
      // Named for what a press does: back to the tree.
      expect((await ui.find({ key: 'view' }))?.props).toMatchObject({ label: 'tree', hotkey: 't', plain: true })

      const row = await rowLine(ui, 'file:a.txt')
      expect(row).toMatch(/^M ● a\.txt +\+3 −1$/)
      expect(cellWidth(row)).toBe(60)
      expect(await rowLine(ui, 'file:bin.dat')).toMatch(/^A {3}bin\.dat +bin$/)
      expect(await rowLine(ui, 'file:gone.txt')).toMatch(/^D {3}gone\.txt +−2$/)
      expect(await rowLine(ui, 'file:src/new näme.txt')).toMatch(/^R {3}src\/new näme\.txt ← src\/old name\.txt +\+1$/)
      expect(await rowLine(ui, 'file:untracked.md')).toMatch(/^\? ● untracked\.md +\+3$/)
      // The Button is the path alone, its directories dim; the counts sit outside it.
      expect((await ui.find({ key: 'file:a.txt' }))?.text).toBe('a.txt')
      const nested = await ui.find({ key: 'file:dir/ubin.bin' })
      expect(nested?.text).toBe('dir/ubin.bin')
      expect(nested?.children[0]).toMatchObject({ type: 'Text', props: { dimColor: true }, children: ['dir/'] })
      await ui.unmount()
    }
  })

  test('a narrow pane cuts long paths in the middle', async ($, on) => {
    world(on, { store: { view: 'list' } })
    await wtDiff($, 'refresh')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 18 } })
    const row = await rowLine(ui, 'file:src/new näme.txt', 18)
    expect(row).toBe('R   src/n…e.txt +1')
    // No room for where it came from: the name alone.
    expect((await ui.find({ key: 'file:src/new näme.txt' }))?.text).toBe('src/n…e.txt')
    await ui.unmount()
  })

  test('pressing a file row loads its diff; pressing again folds it', async ($, on) => {
    const { state } = world(on)
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await opened(ui)).toEqual([])

      await ui.press({ key: 'file:a.txt' })
      // Quiet: each line in its colour, a marker and no background; the header its new line number.
      expect(await diffOf(ui, 'a.txt')).toEqual(['@@ 1', '  line1', '- line2', '+ LINE2', '  line3', '+ line4', '+ extra'])
      expect((await ui.find({ type: 'Text', text: '+ LINE2' }))?.props).toEqual({ color: 'success', wrap: 'truncate-end' })
      expect((await ui.find({ type: 'Text', text: '- line2' }))?.props).toEqual({ color: 'error', wrap: 'truncate-end' })
      expect((await ui.find({ type: 'Text', text: '  line1' }))?.props).toEqual({ dimColor: true, wrap: 'truncate-end' })
      expect((await ui.find({ type: 'Text', text: '@@ 1' }))?.props).toEqual({ dimColor: true, wrap: 'truncate-end' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      expect(state.calls).toContain(`diff -M ${MB} -- :(literal)a.txt`)
      expect(await ui.find({ key: 'collapse' })).toBeDefined()

      await ui.press({ key: 'file:bin.dat' })
      expect((await ui.find({ type: 'Text', text: 'Binary file' }))?.text).toBe('Binary file')

      await ui.press({ key: 'collapse' })
      expect(await opened(ui)).toEqual([])
      expect(await ui.find({ type: 'Text', text: 'Binary file' })).toBeUndefined()

      await ui.press({ key: 'file:a.txt' })
      await ui.press({ key: 'file:a.txt' })
      expect(await opened(ui)).toEqual([])
      await ui.unmount()
    }
  })

  test('a diff past the cap says how many lines it left out', async ($, on) => {
    const body = Array.from({ length: 500 }, (_, i) => `+line ${i}`).join('\n')
    world(on, {
      table: featTable({
        [`diff -M ${MB} -- :(literal)a.txt`]: ok(`diff --git a/a.txt b/a.txt\n@@ -0,0 +1,500 @@\n${body}\n`),
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'file:a.txt' })

    expect((await ui.find({ type: 'Text', text: /more lines/ }))?.text).toBe(
      '… 101 more lines — open in editor',
    )
    // Cut, a file added whole is still source: 399 lines, numbered from 1.
    const code = await ui.find({ type: 'Code' })
    expect(code?.props).toMatchObject({ format: 'source', path: 'a.txt', startLine: 1, wrap: 'truncate-end' })
    const lines = String(code?.props.source).split('\n')
    expect(lines.length).toBe(399)
    expect(lines.slice(0, 2)).toEqual(['line 0', 'line 1'])
    expect((await diffOf(ui, 'a.txt'))?.at(-1)).toBe('… 101 more lines — open in editor')
    await ui.unmount()
  })

  test('a hunk header reads its new line number and function; tabs, blank and no-newline lines draw', async ($, on) => {
    const diff =
      'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n' +
      '@@ -10,4 +10,4 @@ func main() {\n' +
      ' \tx := 1\n-\ty := 2\n+\ty := 3\n \n' +
      '@@ -40 +40 @@\n-end\n\\ No newline at end of file\n+end\n\\ No newline at end of file\n'
    world(on, { table: featTable({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(diff) }), store: { view: 'list' } })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'file:a.txt' })
      expect(await diffOf(ui, 'a.txt')).toEqual([
        '@@ 10  func main() {',
        '      x := 1',
        '-     y := 2',
        '+     y := 3',
        '  ',
        '@@ 40',
        '- end',
        '\\ No newline at end of file',
        '+ end',
        '\\ No newline at end of file',
      ])
      // The header dim, its function italic; the no-newline note dim.
      expect((await ui.find({ type: 'Text', text: '@@ 10  func main() {' }))?.children).toMatchObject([
        '@@ 10',
        '  ',
        { type: 'Text', props: { italic: true }, children: ['func main() {'] },
      ])
      expect((await ui.find({ type: 'Text', text: '\\ No newline at end of file' }))?.props).toMatchObject({ dimColor: true })
      await ui.press({ key: 'file:a.txt' })
      await ui.unmount()
    }
  })

  test('a hunk leaving nothing on the new side names its first old line', async ($, on) => {
    // A tracked file emptied but kept: git says `+0,0`, a line that is not there.
    const diff = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +0,0 @@\n-line1\n-line2\n'
    world(on, { table: featTable({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(diff) }), store: { view: 'list' } })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'file:a.txt' })
    expect(await diffOf(ui, 'a.txt')).toEqual(['@@ −1', '- line1', '- line2'])
    await ui.unmount()
  })

  test('a file added whole is source with line numbers; a deleted one is one line', async ($, on) => {
    const { state } = world(on, {
      table: featTable({
        'diff --no-index -- /dev/null untracked.md': {
          exitCode: 1,
          stdout: 'diff --git a/untracked.md b/untracked.md\n@@ -0,0 +1,3 @@\n+u1\n+\tu2\n+u3\n',
        },
      }),
      store: { view: 'list' },
    })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'file:untracked.md' })
      // No `+`, no hunk header, no green block: the engine's source view, its tab kept for it to draw.
      expect((await ui.find({ type: 'Code' }))?.props).toEqual({
        format: 'source',
        source: 'u1\n\tu2\nu3',
        path: 'untracked.md',
        startLine: 1,
        wrap: 'truncate-end',
      })

      await ui.press({ key: 'file:gone.txt' })
      const gone = await ui.find({ type: 'Text', text: /^deleted/ })
      expect(gone?.text).toBe('deleted · 2 lines')
      expect(gone?.props).toMatchObject({ color: 'error' })
      expect(await opened(ui)).toEqual(['untracked.md'])
      // Drawn from its counts: no git diff for it, on press or on refresh.
      await wtDiff($, 'refresh')
      expect(state.calls.filter(key => key.startsWith('diff') && key.includes('gone.txt'))).toEqual([])
      await ui.press({ key: 'collapse' })
      await ui.unmount()
    }
  })

  test('diffStyle engine draws a modified file with the engine diff view', { options: { diffStyle: 'engine' } }, async ($, on) => {
    world(on, { store: { view: 'list' } })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'file:a.txt' })
      expect((await ui.find({ type: 'Code' }))?.props).toEqual({
        format: 'diff',
        source: HUNKS_A_ALL,
        path: 'a.txt',
        wrap: 'truncate-end',
      })
      expect(await ui.find({ type: 'Text', text: '+ LINE2' })).toBeUndefined()
      // A deleted file is still one line.
      await ui.press({ key: 'file:gone.txt' })
      expect((await ui.find({ type: 'Text', text: /^deleted/ }))?.text).toBe('deleted · 2 lines')
      await ui.press({ key: 'collapse' })
      await ui.unmount()
    }
  })

  test('a quiet diff spends only the cells it draws: long lines are cut to the pane', async ($, on) => {
    const big = (name: string) =>
      ok(
        `diff --git a/${name} b/${name}\n@@ -1,175 +1,175 @@\n` +
          // Under the 30,000-character cap, so nothing is cut before the pane draws it.
          Array.from({ length: 175 }, (_, i) => `-${String(i).padEnd(79, 'x')}\n+${String(i).padEnd(79, 'y')}`).join('\n') +
          '\n',
      )
    world(on, {
      table: featTable({
        [`diff -M ${MB} -- :(literal)a.txt`]: big('a.txt'),
        [`diff -M ${MB} -- :(literal)keep.txt`]: big('keep.txt'),
        [`diff -M ${MB} -- :(literal)src/new näme.txt :(literal)src/old name.txt`]: big('src/new näme.txt'),
      }),
      store: { view: 'list' },
    })
    await wtDiff($, 'refresh')
    const keys = ['file:a.txt', 'file:keep.txt', 'file:src/new näme.txt']
    // As wide as its lines: two diffs fill the budget, the third waits.
    const wide = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 1000 } })
    for (const key of keys) await wide.press({ key })
    expect(await opened(wide)).toEqual(['a.txt', 'keep.txt'])
    expect(await wide.find({ type: 'Text', text: /^Diff hidden/ })).toBeDefined()
    await wide.unmount()

    // At 60 columns each line keeps a cell past the edge, for the ellipsis: all three fit.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await opened(ui)).toEqual(['a.txt', 'keep.txt', 'src/new näme.txt'])
    const lines = (await diffOf(ui, 'a.txt')) ?? []
    expect(lines.length).toBe(351)
    expect(lines[1]).toBe(`- ${'0'.padEnd(55, 'x')}`)
    const screenLines = await screen(ui, 60)
    for (const line of screenLines) expect(cellWidth(line)).toBeLessThanOrEqual(60)
    expect(screenLines.find(line => line.includes('- 0x'))?.trimEnd()).toBe(`    - ${'0'.padEnd(53, 'x')}…`)
    await ui.unmount()
  })

  test('a line cut across a wide character still ends in an ellipsis', async ($, on) => {
    world(on, {
      table: featTable({
        [`diff -M ${MB} -- :(literal)a.txt`]: ok(
          `diff --git a/a.txt b/a.txt\n@@ -1 +1 @@ ${'函数'.repeat(40)}\n-x\n+${'中文'.repeat(40)}\n`,
        ),
      }),
      store: { view: 'list' },
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'file:a.txt' })
    // 56 cells for the lines: one cell past them is half of a wide character.
    const screenLines = await screen(ui, 60)
    for (const line of screenLines) expect(cellWidth(line)).toBeLessThanOrEqual(60)
    expect(screenLines.find(line => line.includes('+ 中'))?.trimEnd()).toBe(`    + ${'中文'.repeat(13)}…`)
    expect(screenLines.find(line => line.includes('@@ 1'))?.trimEnd()).toBe(`    @@ 1  ${'函数'.repeat(12)}…`)
    await ui.press({ key: 'collapse' })
    await ui.unmount()
  })

  test('switching mode lists that mode and reloads open diffs', async ($, on) => {
    const { state } = world(on, { store: { view: 'list' } })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'file:a.txt' })
      // An open file's name is semibold.
      expect((await ui.find({ key: 'file:a.txt' }))?.children).toMatchObject([
        { type: 'Text', props: { weight: 'semibold' }, children: ['a.txt'] },
      ])

      await ui.press({ key: 'mode:committed' })
      expect((await ui.find({ key: 'mode:committed' }))?.props.variant).toBe('primary')
      expect(await ui.find({ key: 'file:keep.txt' })).toBeUndefined()
      expect(await ui.find({ key: 'file:untracked.md' })).toBeUndefined()
      // No layer marks outside `all`.
      expect(await rowLine(ui, 'file:a.txt')).toMatch(/^M a\.txt +\+2 −1$/)
      // The summary follows the mode: no legend outside `all`.
      expect((await screen(ui, 60)).find(line => /^\d+ files? /.test(line))).toMatch(/^4 files +\+3 −3$/)
      expect(state.calls).toContain(`diff -M ${MB} HEAD -- :(literal)a.txt`)
      expect(await diffOf(ui, 'a.txt')).toEqual(['@@ 1', '  line1', '- line2', '+ LINE2', '  line3', '+ line4'])

      await ui.press({ key: 'mode:uncommitted' })
      const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key)
      expect(keys.filter(key => key?.startsWith('file:'))).toEqual([
        'file:a.txt',
        'file:dir/ubin.bin',
        'file:keep.txt',
        'file:untracked.md',
      ])
      // Back to `all`, nothing open, for the next surface: state outlives a mount.
      await ui.press({ key: 'mode:all' })
      await ui.press({ key: 'file:a.txt' })
      expect(await opened(ui)).toEqual([])
      await ui.unmount()
    }
  })

  test('empty states: not a repository, no base, no changes', async ($, on) => {
    const { state } = world(on, { table: { 'rev-parse --show-toplevel': NOT_A_REPO }, cwd: '/tmp/plain' })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /Not a git repository/ }))?.text).toBe('Not a git repository')
      expect(await ui.find({ type: 'Text', text: '/tmp/plain' })).toBeDefined()
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      await ui.unmount()
    }

    // The main checkout on main, nothing else to compare with.
    state.cwd = REPO
    state.table = {
      'rev-parse --show-toplevel': ok(`${REPO}\n`),
      'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(`${REPO}/.git\n${REPO}/.git\n`),
      'symbolic-ref --short -q HEAD': ok('main\n'),
      'rev-parse --verify --quiet --short HEAD': ok('1dfc5da\n'),
      'reflog show --format=%gs refs/heads/main': ok('commit: main2\ncommit (initial): init\n'),
      'rev-parse --abbrev-ref main@{upstream}': NO_UPSTREAM,
      'worktree list --porcelain': ok(`worktree ${REPO}\nHEAD ${MAIN_SHA}\nbranch refs/heads/main\n\n`),
      'symbolic-ref --short refs/remotes/origin/HEAD': NO_ORIGIN_HEAD,
      'rev-parse --verify --quiet master^{commit}': fail(1, ''),
      'rev-parse --verify --quiet trunk^{commit}': fail(1, ''),
      'rev-parse --verify --quiet develop^{commit}': fail(1, ''),
    }
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const lines = aboveKeys(await screen(ui, 60)).map(line => line.trimEnd())
      expect(lines.slice(0, 2)).toEqual(['main', 'vs —  no base branch'])
      // No summary: the notice under a blank line is what follows the tabs.
      const at = lines.indexOf('! Nothing to compare against')
      expect(lines.slice(at - 1)).toEqual([
        '',
        '! Nothing to compare against',
        '  Set one with /wt-diff base <ref>,',
        '  or press u for uncommitted changes.',
      ])
      expect((await ui.find({ type: 'Text', text: /^! $/ }))?.props).toMatchObject({ color: 'warning' })
      expect((await ui.find({ type: 'Text', text: /^Nothing to compare against$/ }))?.props).toMatchObject({ weight: 'semibold' })
      expect((await ui.find({ type: 'Text', text: /^u$/ }))?.props).toMatchObject({ color: 'suggestion' })
      // The command to type in the text color, the words around it dim.
      expect((await ui.find({ type: 'Text', text: /^\/wt-diff base <ref>$/ }))?.props).toEqual({})
      expect((await ui.find({ type: 'Text', text: /^Set one with $/ }))?.props).toMatchObject({ dimColor: true })
      expect(await ui.find({ key: 'mode:uncommitted' })).toBeDefined()
      await ui.unmount()
    }

    // The feat worktree with nothing changed.
    state.cwd = ROOT
    state.table = featTable({
      [`diff --numstat -z -M ${MB} --`]: ok(''),
      [`diff --name-status -z -M ${MB} --`]: ok(''),
      [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(''),
      [`diff --numstat -z -M ${MB} HEAD --`]: ok(''),
      [`diff --name-status -z -M ${MB} HEAD --`]: ok(''),
      'diff --name-only -z --no-renames HEAD --': ok(''),
      'ls-files --others --exclude-standard -z': ok(''),
      'rev-list --left-right --count main...HEAD': ok('1\t0\n'),
    })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const lines = aboveKeys(await screen(ui, 60)).map(line => line.trimEnd())
      expect(lines.slice(-3)).toEqual(['', '✓ No changes vs main', '  Edits will show up here as you work.'])
      expect(lines.some(line => /files?\b/.test(line))).toBe(false)
      expect((await ui.find({ type: 'Text', text: /^✓ $/ }))?.props).toMatchObject({ color: 'success' })
      // The line's own words, inside the line.
      const words = (await ui.findAll({ type: 'Text', text: /^Edits will show up here as you work\.$/ })).pop()
      expect(words?.props).toMatchObject({ dimColor: true })
      await ui.unmount()
    }

    // `committed` lists no edit until it is committed.
    await wtDiff($, 'mode committed')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lines = aboveKeys(await screen(ui, 60)).map(line => line.trimEnd())
    expect(lines.slice(-2)).toEqual(['✓ No changes vs main', '  Commits on this branch will show up here.'])
    await ui.unmount()
  })

  test('control characters in a diff or a path still draw', async ($, on) => {
    const odd = 'e\x1bsc.txt'
    world(on, {
      table: featTable({
        'ls-files --others --exclude-standard -z': ok(`${UNTRACKED}${odd}\0`),
        [`diff -M ${MB} -- :(literal)a.txt`]: ok(
          DIFF_A_ALL.replace('+LINE2', '+LINE2\x1b[31m').replace('+extra', '+\f'),
        ),
        [`diff --no-index -- /dev/null ${odd}`]: {
          exitCode: 1,
          stdout: `diff --git a/${odd} b/${odd}\n@@ -0,0 +1 @@\n+\x1b[1mbold\r\n`,
        },
      }),
      files: { ...featFiles, [`${ROOT}/${odd}`]: '\x1b[1mbold\r\n' },
    })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await rowLine(ui, `file:${odd}`)).toMatch(/^\? ● e\uFFFDsc\.txt +\+1$/)

      await ui.press({ key: 'file:a.txt' })
      const lines = await diffOf(ui, 'a.txt')
      expect(lines).toContain('+ LINE2\uFFFD[31m')
      expect(lines).toContain('+ \uFFFD')

      await ui.press({ key: `file:${odd}` })
      expect(await opened(ui)).toEqual(['a.txt', oneLine(odd)])
      expect((await ui.find({ type: 'Code' }))?.props.source).toBe('\uFFFD[1mbold')
      await ui.press({ key: 'collapse' })
      await ui.unmount()
    }
  })

  test('wide-character paths right-align by terminal cells', async ($, on) => {
    const wide = '文档/说明.md'
    world(on, {
      table: featTable({ 'ls-files --others --exclude-standard -z': ok(`${UNTRACKED}${wide}\0`) }),
      files: { ...featFiles, [`${ROOT}/${wide}`]: 'a\nb\n' },
    })
    await wtDiff($, 'refresh')
    for (const columns of [60, 16]) {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
      const row = await rowLine(ui, `file:${wide}`, columns)
      expect(row).toMatch(/\+2$/)
      expect(cellWidth(row)).toBe(columns)
      await ui.unmount()
    }
  })

  test('uncommitted with no base still shows the totals', async ($, on) => {
    world(on, {
      cwd: REPO,
      table: {
        'rev-parse --show-toplevel': ok(`${REPO}\n`),
        'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(`${REPO}/.git\n${REPO}/.git\n`),
        'symbolic-ref --short -q HEAD': ok('main\n'),
        'rev-parse --verify --quiet --short HEAD': ok('1dfc5da\n'),
        'reflog show --format=%gs refs/heads/main': ok('commit: main2\ncommit (initial): init\n'),
        'rev-parse --abbrev-ref main@{upstream}': NO_UPSTREAM,
        'worktree list --porcelain': ok(`worktree ${REPO}\nHEAD ${MAIN_SHA}\nbranch refs/heads/main\n\n`),
        'symbolic-ref --short refs/remotes/origin/HEAD': NO_ORIGIN_HEAD,
        'rev-parse --verify --quiet master^{commit}': fail(1, ''),
        'rev-parse --verify --quiet trunk^{commit}': fail(1, ''),
        'rev-parse --verify --quiet develop^{commit}': fail(1, ''),
        'diff --numstat -z -M HEAD --': ok(NUMSTAT_WORKTREE),
        'diff --name-status -z -M HEAD --': ok(NAMES_WORKTREE),
        'ls-files --others --exclude-standard -z': ok(''),
      },
    })
    await wtDiff($, 'mode uncommitted')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /no base/ }))?.props).toMatchObject({ color: 'warning' })
      expect((await screen(ui, 60)).find(line => line.startsWith('2 files'))).toMatch(/^2 files +\+2 −0$/)
      // No ↑↓ with nothing to count them from.
      expect(await ui.find({ type: 'Text', text: /↑/ })).toBeUndefined()
      expect(await ui.find({ key: 'file:keep.txt' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('past the text budget a diff is hidden, not cut', async ($, on) => {
    const big = (name: string) =>
      ok(
        `diff --git a/${name} b/${name}\n@@ -0,0 +1,350 @@\n` +
          Array.from({ length: 350 }, (_, i) => `+${String(i).padEnd(99, 'x')}`).join('\n') +
          '\n',
      )
    world(on, {
      table: featTable({
        [`diff -M ${MB} -- :(literal)a.txt`]: big('a.txt'),
        [`diff -M ${MB} -- :(literal)keep.txt`]: big('keep.txt'),
        'diff --no-index -- /dev/null untracked.md': { exitCode: 1, stdout: big('untracked.md').stdout },
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 1000 } })
    for (const key of ['file:a.txt', 'file:keep.txt', 'file:untracked.md']) await ui.press({ key })

    expect((await ui.findAll({ type: 'Code' })).map(code => code.props.path)).toEqual(['a.txt', 'keep.txt'])
    expect((await ui.find({ type: 'Text', text: /^Diff hidden/ }))?.text).toBe(
      'Diff hidden: too much is open. Collapse other files to see it.',
    )
    await ui.unmount()
  })

  test('the budget keeps room for every row after an open diff', async ($, on) => {
    const names = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`)
    const big = (name: string) =>
      ok(
        `diff --git a/${name} b/${name}\n@@ -0,0 +1,290 @@\n` +
          Array.from({ length: 290 }, (_, i) => `+${String(i).padEnd(99, 'x')}`).join('\n') +
          '\n',
      )
    world(on, {
      table: featTable({
        [`diff --numstat -z -M ${MB} --`]: ok(names.map(name => `1\t0\t${name}\0`).join('')),
        [`diff --name-status -z -M ${MB} --`]: ok(names.map(name => `M\0${name}\0`).join('')),
        [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(names.map(name => `${name}\0`).join('')),
        'ls-files --others --exclude-standard -z': ok(''),
        ...Object.fromEntries(names.slice(0, 3).map(name => [`diff -M ${MB} -- :(literal)${name}`, big(name)])),
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 70 } })
    for (const name of names.slice(0, 3)) await ui.press({ key: `file:${name}` })

    // Two diffs and 300 padded rows fill the budget: the third waits.
    expect((await ui.findAll({ type: 'Code' })).map(code => code.props.path)).toEqual(['f000.txt', 'f001.txt'])
    expect(await ui.find({ type: 'Text', text: /^Diff hidden/ })).toBeDefined()
    expect(await ui.find({ key: 'file:f299.txt' })).toBeDefined()
    await ui.unmount()
  })

  test('a refresh the person asked for shows ↻ in the header until it lands', async ($, on) => {
    const { state } = world(on)
    await wtDiff($, 'refresh')
    const held = gate()
    const reached = gate()
    state.hold = held.promise
    state.onHold = reached.open
    const pending = wtDiff($, 'refresh')
    await reached.promise

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const busy = (await screen(ui, 60))[0] ?? ''
    expect(busy).toMatch(/^feat +↻ ↑1 ↓1$/)
    state.hold = undefined
    held.open()
    await pending
    // Its cells stay: nothing moves when it goes.
    const idle = (await screen(ui, 60))[0] ?? ''
    expect(idle).toBe(busy.replace('↻', ' '))
    expect(await ui.find({ type: 'Text', text: '↻' })).toBeUndefined()
    await ui.unmount()
  })

  test('a reload clears a ↻ that the cut-short pass left behind', async ($, on) => {
    const { state } = world(on)
    await wtDiff($, 'refresh')
    const held = gate()
    const reached = gate()
    state.hold = held.promise
    state.onHold = reached.open
    const pending = wtDiff($, 'refresh')
    await reached.promise
    // The reload's session.start: a snapshot is there, so it is one.
    state.hold = undefined
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '↻' })).toBeUndefined()
    held.open()
    await pending
    await ui.unmount()
  })

  test('an open diff survives a failed read and is back when git answers', async ($, on) => {
    const { state } = world(on)
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'file:a.txt' })

    state.table = featTable({ [`diff --numstat -z -M ${MB} --`]: fail(128, 'fatal: index.lock\n') })
    await wtDiff($, 'refresh')
    // No list read: the notice alone, no rows.
    expect((await ui.find({ type: 'Text', text: /git failed/ }))?.text).toBe('✕ git failed')
    expect(await ui.find({ key: 'file:a.txt' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /index\.lock/ }))?.text).toBe('git diff failed: fatal: index.lock')

    state.table = featTable()
    const before = state.calls.length
    await wtDiff($, 'refresh')
    expect(state.calls.slice(before)).toContain(`diff -M ${MB} -- :(literal)a.txt`)
    expect((await diffOf(ui, 'a.txt'))?.[0]).toBe('@@ 1')
    expect(await ui.find({ key: 'collapse' })).toBeDefined()
    await ui.unmount()
  })

  // An orphan branch: uncommitted still lists HEAD to the working tree, under the error.
  test('a failure that kept its rows draws the notice above them, with no summary', async ($, on) => {
    world(on, { store: { view: 'list' }, table: featTable({ 'merge-base main HEAD': fail(1, '') }) })
    await wtDiff($, 'mode uncommitted')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lines = (await screen(ui, 60)).map(line => line.trimEnd())
    const at = lines.indexOf('✕ git failed')
    expect(lines.slice(at, at + 4)).toEqual([
      '✕ git failed',
      '  No common ancestor between main and HEAD',
      '  r to retry',
      '',
    ])
    expect(lines[at + 4]).toMatch(/^M a\.txt +\+1$/)
    expect(lines.some(line => /^\d+ files? /.test(line))).toBe(false)
    expect(await ui.find({ key: 'file:untracked.md' })).toBeDefined()
    await ui.unmount()
  })

  test('a list cut at 4 MiB reads as a failure, not a bogus file', async ($, on) => {
    world(on, {
      table: featTable({
        [`diff --numstat -z -M ${MB} --`]: { exitCode: 0, stdout: '3\t1\ta.txt\0' + '1\t0\tpart', isStdoutTruncated: true },
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /4 MiB/ }))?.text).toBe('git diff failed: output over 4 MiB')
    expect(await ui.find({ key: 'file:part' })).toBeUndefined()
    await ui.unmount()
  })

  test('a git failure shows its error', async ($, on) => {
    world(on, { table: featTable({ [`diff --numstat -z -M ${MB} --`]: fail(128, 'fatal: bad object\n') }) })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /bad object/ }))?.text).toBe('git diff failed: fatal: bad object')
    expect((await ui.find({ type: 'Text', text: /^✕ $/ }))?.props).toMatchObject({ color: 'error' })
    expect((await ui.find({ type: 'Text', text: /to retry/ }))?.text).toBe('r to retry')
    await ui.unmount()
  })

  test('before the first refresh it says it is reading', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Reading git…')
    await ui.unmount()
  })
})

// --------------------------------------------------------------- command

// ------------------------------------------------------------------ tree

// The feat worktree with three more untracked files: a chain to compact and a nested src/lib.
const treeTable = (overrides: Record<string, Answer> = {}) =>
  featTable({
    'ls-files --others --exclude-standard -z': ok(`${UNTRACKED}deep/a/b/c.md\0deep/a/b/d.md\0src/lib/x.ts\0`),
    ...overrides,
  })
const treeFiles: Record<string, string> = {
  ...featFiles,
  [`${ROOT}/deep/a/b/c.md`]: '1\n2\n',
  [`${ROOT}/deep/a/b/d.md`]: '1\n',
  [`${ROOT}/src/lib/x.ts`]: '1\n2\n3\n4\n',
}

const TREE_KEYS = [
  'dir:deep/a/b',
  'file:deep/a/b/c.md',
  'file:deep/a/b/d.md',
  'dir:dir',
  'file:dir/ubin.bin',
  'dir:src',
  'dir:src/lib',
  'file:src/lib/x.ts',
  'file:src/new näme.txt',
  'file:a.txt',
  'file:bin.dat',
  'file:gone.txt',
  'file:keep.txt',
  'file:untracked.md',
]

const rowKeys = async (ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' }))
    .map(button => button.key ?? '')
    .filter(key => key.startsWith('dir:') || key.startsWith('file:'))

/** The Buttons and open diffs of a drawing, in document order: `file:a.txt`, `code:a.txt`. */
const order = (node: unknown, out: string[] = []): string[] => {
  if (node === null || typeof node !== 'object') return out
  const { type, key, props, children } = node as {
    type?: string
    key?: string
    props?: Record<string, unknown>
    children?: unknown
  }
  if (type === 'Button') out.push(String(key ?? props?.key ?? ''))
  else if (String(key ?? props?.key ?? '').startsWith('diff:')) out.push(`code:${String(key ?? props?.key).slice('diff:'.length)}`)
  const kids = children ?? props?.children
  if (Array.isArray(kids)) for (const kid of kids) order(kid, out)
  else order(kids, out)

  return out
}

type Found = { text: string; props: Record<string, unknown> } | undefined
type Finder = { find: (query: { key: string }) => Promise<Found> }

/** A tree row's indent: leading spaces on terminal, its Box's padding elsewhere. */
const indentOf = async (ui: Finder, surface: string, key: string): Promise<number> =>
  surface === 'terminal'
    ? (/^ */.exec(await rowLine(ui, key))?.[0].length ?? 0)
    : Number((await ui.find({ key: `at:${key}` }))?.props.paddingLeft ?? 0)

/** A tree row at `cells` of indent that then reads `rest`. */
const expectRow = async (ui: Finder, surface: string, key: string, cells: number, rest: RegExp) => {
  expect(await indentOf(ui, surface, key)).toBe(cells)
  expect((await rowLine(ui, key)).slice(surface === 'terminal' ? cells : 0)).toMatch(rest)
}

describe('tree view', () => {
  test('is the default: directories first, chains compacted, names alone, on terminal and desktop', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await rowKeys(ui)).toEqual(TREE_KEYS)
      expect((await ui.find({ key: 'view' }))?.props).toMatchObject({ label: 'list', hotkey: 't', plain: true })
      expect((await ui.find({ key: 'fold' }))?.props).toMatchObject({ label: 'fold', hotkey: 'z', plain: true })

      const text = (key: string) => rowLine(ui, key)
      const row = (key: string, cells: number, rest: RegExp) => expectRow(ui, surface, key, cells, rest)
      // An open directory leaves the counts to its files.
      await row('dir:deep/a/b', 0, /^▾ deep\/a\/b\/$/)
      await row('file:deep/a/b/c.md', 2, /^\? ● c\.md +\+2$/)
      expect(await text('dir:dir')).toBe('▾ dir/')
      await row('file:dir/ubin.bin', 2, /^\? ● ubin\.bin +bin$/)
      await row('dir:src', 0, /^▾ src\/$/)
      await row('dir:src/lib', 2, /^▾ lib\/$/)
      await row('file:src/lib/x.ts', 4, /^\? ● x\.ts +\+4$/)
      // A rename within its directory says only the old name.
      await row('file:src/new näme.txt', 2, /^R {3}new näme\.txt ← old name\.txt +\+1$/)
      await row('file:a.txt', 0, /^M ● a\.txt +\+3 −1$/)
      // A native button drops leading spaces: elsewhere the indent is layout.
      if (surface !== 'terminal') {
        for (const key of TREE_KEYS) expect(await text(key)).toMatch(/^\S/)
      }
      // Only the name is the Button, the arrow dim in it; a file's counts in color, outside it.
      expect((await ui.find({ key: 'dir:src' }))?.children).toEqual([
        { type: 'Text', props: { dimColor: true }, children: ['▾ '] },
        'src/',
      ])
      expect((await ui.find({ key: 'file:a.txt' }))?.text).toBe('a.txt')
      expect(JSON.stringify((await ui.find({ key: 'row:file:a.txt' }))?.children.at(-1))).toContain('"color":"success"')
      if (surface === 'terminal') {
        // A file row reaches the edge; an open directory row ends at its name.
        for (const key of TREE_KEYS) {
          expect(cellWidth(await text(key))).toBe(key.startsWith('file:') ? 60 : (await text(key)).trimEnd().length)
        }
      }
      await ui.unmount()
    }
  })

  test('removed lines add up in a folded directory row too', async ($, on) => {
    world(on, {
      table: featTable({
        [`diff --numstat -z -M ${MB} --`]: ok('3\t1\tlib/a.txt\0' + '0\t2\tlib/gone.txt\0'),
        [`diff --name-status -z -M ${MB} --`]: ok('M\0lib/a.txt\0D\0lib/gone.txt\0'),
        [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok('lib/a.txt\0lib/gone.txt\0'),
        'diff --name-only -z --no-renames HEAD --': ok(''),
        'ls-files --others --exclude-standard -z': ok(''),
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'dir:lib' })
    expect(await rowLine(ui, 'dir:lib')).toMatch(/^▸ lib\/ \(2\) +\+3 −3$/)
    await ui.unmount()
  })

  test('a directory row folds what is under it and says how many files', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'dir:src' })
      expect(await rowLine(ui, 'dir:src')).toMatch(/^▸ src\/ \(2\) +\+5$/)
      expect((await ui.find({ key: 'dir:src' }))?.text).toBe('▸ src/')
      // The count and the sums are dim.
      const row = await ui.find({ key: 'row:dir:src' })
      expect(JSON.stringify(row?.children[0])).toContain('{"type":"Text","props":{"dimColor":true},"children":[" (2)"]}')
      expect(row?.children[1]).toEqual({ type: 'Text', props: { dimColor: true }, children: ['+5'] })
      expect(await rowKeys(ui)).toEqual(TREE_KEYS.filter(key => !/^(dir|file):src\//.test(key)))

      await ui.press({ key: 'dir:src' })
      expect(await rowLine(ui, 'dir:src')).toBe('▾ src/')
      expect(await rowKeys(ui)).toEqual(TREE_KEYS)
      await ui.unmount()
    }
  })

  test('z folds every directory, and opens them all once all are folded', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'dir:src/lib' })
      await ui.press({ key: 'fold' })
      expect(await rowKeys(ui)).toEqual([
        'dir:deep/a/b',
        'dir:dir',
        'dir:src',
        'file:a.txt',
        'file:bin.dat',
        'file:gone.txt',
        'file:keep.txt',
        'file:untracked.md',
      ])
      expect((await ui.find({ key: 'fold' }))?.props.label).toBe('unfold')
      // The inner one stays folded when its parent opens.
      await ui.press({ key: 'dir:src' })
      await expectRow(ui, surface, 'dir:src/lib', 2, /^▸ lib\/ \(1\) +\+4$/)
      expect((await ui.find({ key: 'fold' }))?.props.label).toBe('fold')

      await ui.press({ key: 'fold' })
      await ui.press({ key: 'fold' })
      expect(await rowKeys(ui)).toEqual(TREE_KEYS)
      expect((await ui.find({ key: 'fold' }))?.props.label).toBe('fold')
      await ui.unmount()
    }
  })

  test('z reads every drawn directory folded by hand as all folded: one press opens them', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    for (const key of ['dir:deep/a/b', 'dir:dir', 'dir:src']) await ui.press({ key })
    expect((await ui.find({ key: 'fold' }))?.props.label).toBe('unfold')
    await ui.press({ key: 'fold' })
    expect(await rowKeys(ui)).toEqual(TREE_KEYS)
    expect((await ui.find({ key: 'fold' }))?.props.label).toBe('fold')
    await ui.unmount()
  })

  test('t switches to the list and back, and keeps the choice in the store', async ($, on) => {
    const { state } = world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'view' })
      expect(await rowKeys(ui)).toEqual([...TREE_KEYS].filter(key => key.startsWith('file:')).sort())
      expect(await rowLine(ui, 'file:src/lib/x.ts')).toMatch(/^\? ● src\/lib\/x\.ts +\+4$/)
      expect((await ui.find({ key: 'view' }))?.props.label).toBe('tree')
      expect(await ui.find({ key: 'fold' })).toBeUndefined()
      expect(state.store.get('view')).toBe('list')

      await ui.press({ key: 'view' })
      expect(await rowKeys(ui)).toEqual(TREE_KEYS)
      expect(state.store.get('view')).toBe('tree')
      await ui.unmount()
    }
  })

  test('a stored list view is what the pane opens on', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles, store: { view: 'list' } })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await rowKeys(ui)).every(key => key.startsWith('file:'))).toBe(true)
    await ui.unmount()
  })

  test('an open diff draws right under its row', async ($, on) => {
    world(on, {
      table: treeTable({
        'diff --no-index -- /dev/null src/lib/x.ts': {
          exitCode: 1,
          stdout: 'diff --git a/src/lib/x.ts b/src/lib/x.ts\n@@ -0,0 +1,4 @@\n+1\n+2\n+3\n+4\n',
        },
      }),
      files: treeFiles,
    })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'file:a.txt' })
      // A nested file's diff too: before its parent's next row, indent or not.
      await ui.press({ key: 'file:src/lib/x.ts' })
      const drawn = order(await ui.drawn())
      const after = (key: string) => drawn.slice(drawn.indexOf(key), drawn.indexOf(key) + 3)
      expect(after('file:a.txt')).toEqual(['file:a.txt', 'code:a.txt', 'file:bin.dat'])
      expect(after('file:src/lib/x.ts')).toEqual(['file:src/lib/x.ts', 'code:src/lib/x.ts', 'file:src/new näme.txt'])
      // Folding a directory above it leaves it open.
      await ui.press({ key: 'dir:src' })
      expect(await opened(ui)).toEqual(['a.txt'])
      await ui.press({ key: 'dir:src' })
      await ui.press({ key: 'file:a.txt' })
      await ui.press({ key: 'file:src/lib/x.ts' })
      await ui.unmount()
    }
  })

  test('indentation stops at a third of the width; rows fit a narrow pane', async ($, on) => {
    const deep = ['p/q.txt', 'p/r/s.txt', 'p/r/t/u.txt', 'p/r/t/v/w.txt']
    world(on, {
      table: featTable({ 'ls-files --others --exclude-standard -z': ok(deep.map(path => `${path}\0`).join('')) }),
      files: { ...featFiles, ...Object.fromEntries(deep.map(path => [`${ROOT}/${path}`, 'x\n'])) },
    })
    await wtDiff($, 'refresh')
    for (const columns of [60, 16]) {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
      const lead = async (key: string) => /^ */.exec(await rowLine(ui, key, columns))?.[0].length
      expect(await lead('dir:p')).toBe(0)
      expect(await lead('dir:p/r')).toBe(2)
      expect(await lead('file:p/r/s.txt')).toBe(4)
      expect(await lead('dir:p/r/t/v')).toBe(columns === 60 ? 6 : 5)
      expect(await lead('file:p/r/t/v/w.txt')).toBe(columns === 60 ? 8 : 5)
      for (const key of await rowKeys(ui)) {
        const row = await rowLine(ui, key, columns)
        if (key.startsWith('file:')) expect(cellWidth(row)).toBe(columns)
        else expect(cellWidth(row)).toBeLessThanOrEqual(columns)
      }
      await ui.unmount()
    }
  })

  test('a narrow pane gives a name and the counts their cells first, then (N), then the indent', async ($, on) => {
    // Siblings with no counts keep the chain from compacting.
    const paths = ['p/a.txt', 'p/r/b.txt', 'p/r/t/c.txt', 'p/r/t/v/w.md']
    world(on, {
      table: featTable({
        [`diff --numstat -z -M ${MB} --`]: ok(paths.map(path => `${path.endsWith('w.md') ? '12\t3' : '0\t0'}\t${path}\0`).join('')),
        [`diff --name-status -z -M ${MB} --`]: ok(paths.map(path => `M\0${path}\0`).join('')),
        [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(paths.map(path => `${path}\0`).join('')),
        'diff --name-only -z --no-renames HEAD --': ok(''),
        'ls-files --others --exclude-standard -z': ok(''),
      }),
    })
    await wtDiff($, 'refresh')
    for (const columns of [60, 16]) {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
      const text = (key: string) => rowLine(ui, key, columns)
      const file = await text('file:p/r/t/v/w.md')
      expect(cellWidth(file)).toBe(columns)
      expect(file).toMatch(columns === 60 ? /^ {8}M {3}w\.md +\+12 −3$/ : /^ M {3}w\.md +\+12 −3$/)

      await ui.press({ key: 'dir:p/r/t/v' })
      const dir = await text('dir:p/r/t/v')
      expect(cellWidth(dir)).toBe(columns)
      expect(dir).toMatch(columns === 60 ? /^ {6}▸ v\/ \(1\) +\+12 −3$/ : /^ {2}▸ v\/ +\+12 −3$/)
      await ui.press({ key: 'dir:p/r/t/v' })
      await ui.unmount()
    }
  })

  test('a narrow pane wraps the controls; a rename gives its old path the room left', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 40 } })
    // The innermost Box holding the view button.
    const controls = (await ui.findAll({ type: 'Box' }))
      .filter(box => JSON.stringify(box.children).includes('"view"'))
      .at(-1)
    expect(JSON.stringify(controls?.children)).toContain('"fold"')
    expect(controls?.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' })
    const renamed = await rowLine(ui, 'file:src/new näme.txt', 40)
    expect(cellWidth(renamed)).toBe(40)
    expect(renamed).toMatch(/^ {2}R {3}new näme\.txt ← old name\.txt +\+1$/)

    // No room for where it came from: the name alone.
    await ui.unmount()
    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 22 } })
    const cut = await rowLine(narrow, 'file:src/new näme.txt', 22)
    expect(cellWidth(cut)).toBe(22)
    expect(cut).not.toContain('←')
    await narrow.unmount()
  })

  test('a directory gone after a refresh leaves the collapsed list', async ($, on) => {
    const { state } = world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'dir:deep/a/b' })
    await ui.press({ key: 'dir:src/lib' })

    // deep/ is gone; src/lib comes back after.
    state.table = featTable()
    await wtDiff($, 'refresh')
    expect(await ui.find({ key: 'dir:deep/a/b' })).toBeUndefined()
    state.table = treeTable()
    await wtDiff($, 'refresh')
    expect((await ui.find({ key: 'dir:deep/a/b' }))?.text).toMatch(/^▾ /)
    expect(await rowLine(ui, 'dir:src/lib')).toMatch(/^ {2}▾ /)
    await ui.unmount()
  })

  test('a realistic 20-file change set reads as a tree', async ($, on) => {
    // Real git 2.54 output: this repository's own files on a branch off a base
    // holding LICENSE, .gitignore and the v0.1 plan; the plan moved to archive/,
    // .gitignore deleted, LICENSE and five sources edited in the worktree, the
    // v0.2 docs and tree sources untracked.
    const numstat =
      '6\t0\t.claude-plugin/marketplace.json\x0031\t0\t.claude-plugin/plugin.json\x000\t2\t.gitignore\x00' +
      '1\t4\tLICENSE\x00136\t0\tREADME.md\x00-\t-\tassets/icon.png\x00' +
      '0\t0\t\x00docs/superpowers/plans/2026-10-29-worktree-diff-pane.md\x00docs/superpowers/plans/archive/2026-10-29-worktree-diff-pane.md\x00' +
      '129\t0\tdocs/superpowers/specs/2026-10-29-worktree-diff-pane.md\x003\t0\thooks/fixtures/numstat.txt\x00' +
      '1305\t0\thooks/git.test.ts\x00934\t0\thooks/git.ts\x001\t0\thooks/hooks.json\x001612\t0\thooks/register.test.tsx\x00' +
      '1142\t0\thooks/register.tsx\x002\t0\tscripts/sync.sh\x0088\t0\ttypes/index.d.ts\x00'
    const names =
      'A\x00.claude-plugin/marketplace.json\x00A\x00.claude-plugin/plugin.json\x00D\x00.gitignore\x00M\x00LICENSE\x00' +
      'A\x00README.md\x00A\x00assets/icon.png\x00' +
      'R100\x00docs/superpowers/plans/2026-10-29-worktree-diff-pane.md\x00docs/superpowers/plans/archive/2026-10-29-worktree-diff-pane.md\x00' +
      'A\x00docs/superpowers/specs/2026-10-29-worktree-diff-pane.md\x00A\x00hooks/fixtures/numstat.txt\x00' +
      'A\x00hooks/git.test.ts\x00A\x00hooks/git.ts\x00A\x00hooks/hooks.json\x00A\x00hooks/register.test.tsx\x00' +
      'A\x00hooks/register.tsx\x00A\x00scripts/sync.sh\x00A\x00types/index.d.ts\x00'
    const committed =
      '.claude-plugin/marketplace.json\x00.claude-plugin/plugin.json\x00.gitignore\x00README.md\x00assets/icon.png\x00' +
      'docs/superpowers/plans/2026-10-29-worktree-diff-pane.md\x00docs/superpowers/plans/archive/2026-10-29-worktree-diff-pane.md\x00' +
      'docs/superpowers/specs/2026-10-29-worktree-diff-pane.md\x00hooks/fixtures/numstat.txt\x00hooks/git.test.ts\x00' +
      'hooks/git.ts\x00hooks/hooks.json\x00hooks/register.test.tsx\x00hooks/register.tsx\x00scripts/sync.sh\x00types/index.d.ts\x00'
    const untracked: Record<string, number> = {
      'docs/superpowers/plans/2026-10-30-trunk-and-tree-view.md': 39,
      'docs/superpowers/specs/2026-10-30-trunk-and-tree-view.md': 90,
      'hooks/tree.test.ts': 148,
      'hooks/tree.ts': 126,
    }
    world(on, {
      table: featTable({
        [`diff --numstat -z -M ${MB} --`]: ok(numstat),
        [`diff --name-status -z -M ${MB} --`]: ok(names),
        [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(committed),
        'diff --name-only -z --no-renames HEAD --': ok(
          'LICENSE\x00hooks/git.test.ts\x00hooks/git.ts\x00hooks/register.test.tsx\x00hooks/register.tsx\x00types/index.d.ts\x00',
        ),
        'ls-files --others --exclude-standard -z': ok(Object.keys(untracked).map(path => `${path}\x00`).join('')),
      }),
      files: Object.fromEntries(Object.entries(untracked).map(([path, n]) => [`${ROOT}/${path}`, 'x\n'.repeat(n)])),
    })
    await wtDiff($, 'refresh')

    // What each row reads, the gap before its counts shown as ` | `.
    const expected = [
      '▾ .claude-plugin/',
      '  A   marketplace.json | +6',
      '  A   plugin.json | +31',
      '▾ assets/',
      '  A   icon.png | bin',
      '▾ docs/superpowers/',
      '  ▾ plans/',
      '    ▾ archive/',
      // Moved to another directory: the old path in full, cut to fit.
      '      R   2026-10-29-worktree-diff-pane.md ← docs/su…pane.md',
      '    ? ● 2026-10-30-trunk-and-tree-view.md | +39',
      '  ▾ specs/',
      '    A   2026-10-29-worktree-diff-pane.md | +129',
      '    ? ● 2026-10-30-trunk-and-tree-view.md | +90',
      '▾ hooks/',
      '  ▾ fixtures/',
      '    A   numstat.txt | +3',
      '  A ● git.test.ts | +1305',
      '  A ● git.ts | +934',
      '  A   hooks.json | +1',
      '  A ● register.test.tsx | +1612',
      '  A ● register.tsx | +1142',
      '  ? ● tree.test.ts | +148',
      '  ? ● tree.ts | +126',
      '▾ scripts/',
      '  A   sync.sh | +2',
      '▾ types/',
      '  A ● index.d.ts | +88',
      'D   .gitignore | −2',
      'M ● LICENSE | +1 −4',
      'A   README.md | +136',
    ]
    const shown = async (ui: Finder & Parameters<typeof rowKeys>[0]) =>
      Promise.all((await rowKeys(ui)).map(key => rowLine(ui, key)))
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lines = await shown(terminal)
    expect(lines.map(line => line.replace(/ {2,}(?=[+−b])/, ' | ').trimEnd())).toEqual(expected)
    // A file row and a counted directory row fill the width; the header sums every file.
    for (const line of lines) if (/[+−]\d+$|bin$/.test(line) || line.includes('←')) expect(cellWidth(line)).toBe(60)
    await terminal.press({ key: 'dir:hooks' })
    expect(await rowLine(terminal, 'dir:hooks')).toMatch(/^▸ hooks\/ \(8\) +\+5271$/)
    await terminal.press({ key: 'dir:hooks' })
    await terminal.press({ key: 'dir:docs/superpowers' })
    expect(await rowLine(terminal, 'dir:docs/superpowers')).toMatch(/^▸ docs\/superpowers\/ \(4\) +\+258$/)
    expect((await rowKeys(terminal)).length).toBe(expected.length - 7)
    await terminal.press({ key: 'dir:docs/superpowers' })
    await terminal.unmount()

    // The same rows elsewhere, the indent as padding and the text unindented.
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await shown(desktop)).length).toBe(expected.length)
    await expectRow(desktop, 'desktop', 'file:docs/superpowers/plans/archive/2026-10-29-worktree-diff-pane.md', 6, /^R {3}2026-10-29/)
    await expectRow(desktop, 'desktop', 'file:hooks/tree.ts', 2, /^\? ● tree\.ts +\+126$/)
    await desktop.unmount()
  })

  test('files in a folded directory spend none of the text budget', async ($, on) => {
    const names = Array.from({ length: 300 }, (_, i) => `many/f${String(i).padStart(3, '0')}.txt`)
    const big = (name: string) =>
      ok(
        `diff --git a/${name} b/${name}\n@@ -0,0 +1,290 @@\n` +
          Array.from({ length: 290 }, (_, i) => `+${String(i).padEnd(99, 'x')}`).join('\n') +
          '\n',
      )
    const top = ['a.txt', 'b.txt', 'c.txt']
    const all = [...top, ...names].sort()
    world(on, {
      table: featTable({
        [`diff --numstat -z -M ${MB} --`]: ok(all.map(name => `1\t0\t${name}\0`).join('')),
        [`diff --name-status -z -M ${MB} --`]: ok(all.map(name => `M\0${name}\0`).join('')),
        [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(all.map(name => `${name}\0`).join('')),
        'ls-files --others --exclude-standard -z': ok(''),
        ...Object.fromEntries(top.map(name => [`diff -M ${MB} -- :(literal)${name}`, big(name)])),
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 70 } })
    for (const name of top) await ui.press({ key: `file:${name}` })
    // 300 open rows leave room for two diffs.
    expect((await ui.findAll({ type: 'Code' })).length).toBe(2)

    await ui.press({ key: 'dir:many' })
    expect((await ui.findAll({ type: 'Code' })).map(code => code.props.path)).toEqual(top)
    await ui.unmount()
  })
})

// -------------------------------------------------------------- keyboard

const FOCUSED_PANE = { ...PANE, props: { ...PANE.props, isFocused: true } } as const

/** The person moving the pane's ring: onto one of the mod's elements, or with none onto an engine stop. */
const personFocus = ($: Engine, element?: string) =>
  $.ui.focus({
    component: 'Pane',
    requestId: 'worktree-diff',
    ...(element !== undefined ? { element, plugin: 'worktree-diff' } : {}),
    origin: { kind: 'person' },
  } as never)

/** Presses the key Buttons in turn: `jjk`. */
const keys = async (ui: { press: (target: { key: string }) => Promise<unknown> }, presses: string) => {
  for (const key of presses) await ui.press({ key: `nav:${key}` })
}

/** The row Button the ring starts on, if any; there is at most one. */
const autoFocused = async (ui: { findAll: (query: { type: string }) => Promise<{ key?: string; props: Record<string, unknown> }[]> }) => {
  const marked = (await ui.findAll({ type: 'Button' })).filter(button => button.props.autoFocus === true)
  expect(marked.length).toBeLessThanOrEqual(1)
  return marked[0]?.key
}

/** The rows as the pane draws them, each at the depth its indent shows. */
const navRows = async (ui: Finder & Parameters<typeof rowKeys>[0], surface: string): Promise<NavRow[]> =>
  Promise.all(
    (await rowKeys(ui)).map(async key => ({
      key,
      kind: key.startsWith('dir:') ? ('dir' as const) : ('file' as const),
      path: key.slice(key.indexOf(':') + 1),
      depth: (await indentOf(ui, surface, key)) / 2,
    })),
  )

/** Where j (or k) takes the ring from `from`, again and again, until it stops. */
const walk = (rows: readonly NavRow[], from: string | undefined, key: 'j' | 'k'): string[] => {
  const seen: string[] = []
  let at = from
  for (let step = 0; step <= rows.length; step++) {
    const action = navAction(rows, at, key, () => true)
    if (action === null) break
    expect(action).toHaveProperty('focus')
    at = (action as { focus: string }).focus
    seen.push(at)
  }
  return seen
}

const FOLDED_SRC = TREE_KEYS.filter(key => !/^(dir|file):src\//.test(key))
const LIST_KEYS = TREE_KEYS.filter(key => key.startsWith('file:')).sort()

describe('keyboard', () => {
  test('j/k/g/e walk the tree rows as drawn, past a folded directory, and stop at either end', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...FOCUSED_PANE, surface })
      await ui.press({ key: 'dir:src' })
      const rows = await navRows(ui, surface)
      const open = () => true
      // Off any row (a reload lost it, or a control holds the ring) j starts at the first, k at the last.
      for (const off of [undefined, 'mode:all']) {
        expect(walk(rows, off, 'j')).toEqual(FOLDED_SRC)
        expect(walk(rows, off, 'k')).toEqual([...FOLDED_SRC].reverse())
      }
      expect(navAction(rows, 'file:a.txt', 'j', open)).toEqual({ focus: 'file:bin.dat' })
      expect(navAction(rows, 'file:a.txt', 'k', open)).toEqual({ focus: 'dir:src' })
      // Nothing past either end.
      expect(navAction(rows, FOLDED_SRC[0], 'k', open)).toBeNull()
      expect(navAction(rows, 'file:untracked.md', 'j', open)).toBeNull()
      expect(navAction(rows, 'file:a.txt', 'g', open)).toEqual({ focus: 'dir:deep/a/b' })
      expect(navAction(rows, 'dir:deep/a/b', 'g', open)).toBeNull()
      expect(navAction(rows, undefined, 'e', open)).toEqual({ focus: 'file:untracked.md' })
      expect(navAction(rows, 'file:untracked.md', 'e', open)).toBeNull()
      await ui.press({ key: 'dir:src' })
      await ui.unmount()
    }
  })

  test('j/k walk the list view in its order; h has no directory to go up to', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles, store: { view: 'list' } })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...FOCUSED_PANE, surface })
      const rows = await navRows(ui, surface)
      expect(walk(rows, undefined, 'j')).toEqual(LIST_KEYS)
      expect(walk(rows, LIST_KEYS.at(-1), 'k')).toEqual([...LIST_KEYS].reverse().slice(1))
      expect(navAction(rows, 'file:src/lib/x.ts', 'h', () => false)).toBeNull()
      expect(navAction(rows, 'file:src/lib/x.ts', 'l', () => false)).toEqual({ file: 'src/lib/x.ts' })
      await ui.unmount()
    }
  })

  test('h folds an open directory or goes up; l opens a folded one or a diff, or goes in', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...FOCUSED_PANE, surface: 'terminal' })
    const rows = await navRows(ui, 'terminal')
    await ui.unmount()
    const shut = new Set(['dir:src/lib', 'file:a.txt', 'file:src/lib/x.ts'])
    const isOpen = (row: NavRow) => !shut.has(row.key)
    const act = (focused: string | undefined, key: 'h' | 'l') => navAction(rows, focused, key, isOpen)

    // A file goes up to its directory, a folded directory to its parent.
    expect(act('file:src/lib/x.ts', 'h')).toEqual({ focus: 'dir:src/lib' })
    expect(act('dir:src/lib', 'h')).toEqual({ focus: 'dir:src' })
    expect(act('file:deep/a/b/d.md', 'h')).toEqual({ focus: 'dir:deep/a/b' })
    // An open directory folds.
    expect(act('dir:src', 'h')).toEqual({ dir: 'src' })
    // At the top level there is nowhere to go up to.
    expect(act('file:a.txt', 'h')).toBeNull()
    expect(navAction(rows, 'dir:src', 'h', () => false)).toBeNull()
    // A folded directory opens; an open one goes in, to its first row.
    expect(act('dir:src/lib', 'l')).toEqual({ dir: 'src/lib' })
    expect(act('dir:src', 'l')).toEqual({ focus: 'dir:src/lib' })
    expect(act('dir:deep/a/b', 'l')).toEqual({ focus: 'file:deep/a/b/c.md' })
    // A file opens its diff; one open already stays as it is.
    expect(act('file:a.txt', 'l')).toEqual({ file: 'a.txt' })
    expect(act('file:bin.dat', 'l')).toBeNull()
    // Off the rows neither does anything.
    for (const off of [undefined, 'refresh']) {
      expect(act(off, 'h')).toBeNull()
      expect(act(off, 'l')).toBeNull()
    }
  })

  test('h and l fold, open and load as the ring says, on terminal and desktop', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...FOCUSED_PANE, surface })
      await personFocus($, 'dir:src/lib')
      await keys(ui, 'h')
      expect(await rowKeys(ui)).not.toContain('file:src/lib/x.ts')
      await keys(ui, 'l')
      expect(await rowKeys(ui)).toEqual(TREE_KEYS)
      // Clicking a key's own Button moves the ring onto it: the row it acts from stays.
      await personFocus($, 'file:a.txt')
      await personFocus($, 'nav:l')
      await keys(ui, 'l')
      expect(await opened(ui)).toEqual(['a.txt'])
      await keys(ui, 'l')
      expect(await opened(ui)).toEqual(['a.txt'])
      // On a control, or one of the engine's stops, no row holds the ring: h and l do nothing.
      await personFocus($, 'refresh')
      await keys(ui, 'hl')
      await personFocus($)
      await keys(ui, 'hl')
      expect(await opened(ui)).toEqual(['a.txt'])
      expect(await rowKeys(ui)).toEqual(TREE_KEYS)
      await ui.press({ key: 'collapse' })
      await ui.unmount()
    }
  })

  test('h and l act on the rows as listed now, not as last drawn', async ($, on) => {
    world(on, {
      table: treeTable({
        'diff --no-index -- /dev/null src/lib/x.ts': {
          exitCode: 1,
          stdout: 'diff --git a/src/lib/x.ts b/src/lib/x.ts\n@@ -0,0 +1,4 @@\n+1\n+2\n+3\n+4\n',
        },
      }),
      files: treeFiles,
    })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...FOCUSED_PANE, surface })
      // Folded out of the listing, the row the ring was on is no row to act from.
      await ui.press({ key: 'dir:src' })
      await personFocus($, 'file:src/lib/x.ts')
      await keys(ui, 'l')
      expect(await rowKeys(ui)).toEqual(FOLDED_SRC)
      await ui.press({ key: 'dir:src' })
      expect(await opened(ui)).toEqual([])
      await personFocus($, 'file:src/lib/x.ts')
      await keys(ui, 'l')
      expect(await opened(ui)).toEqual(['src/lib/x.ts'])
      // Pressed together, the second key reads what the first folded.
      await personFocus($, 'dir:src')
      await Promise.all([ui.press({ key: 'nav:h' }), ui.press({ key: 'nav:l' })])
      expect(await rowKeys(ui)).toEqual(TREE_KEYS)
      await ui.press({ key: 'collapse' })
      await ui.unmount()
    }
  })

  test('l opens a diff at once and the next key does not wait for git to read it', async ($, on) => {
    const { state } = world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...FOCUSED_PANE, surface: 'terminal' })
    const held = gate()
    const reached = gate()
    state.hold = held.promise
    state.onHold = reached.open
    await personFocus($, 'file:a.txt')
    const loading = ui.press({ key: 'nav:l' })
    await reached.promise
    // While git reads a.txt, h folds the directory the ring moved to.
    await personFocus($, 'dir:src')
    const folding = keys(ui, 'h')
    // Behind the load, h would wait for git, which stays held: a second is ample.
    const { setTimeout } = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
    const isLate = await Promise.race([
      folding.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 1_000)),
    ])
    expect(isLate).toBe(false)
    expect(await rowKeys(ui)).not.toContain('dir:src/lib')
    state.hold = undefined
    held.open()
    await loading
    expect(await opened(ui)).toEqual(['a.txt'])
    await ui.press({ key: 'dir:src' })
    await ui.press({ key: 'collapse' })
    await ui.unmount()
  })

  test('a move the engine refuses, or cannot make, is dropped and nothing throws', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    // The kit has no `$.ui.focus` beneath a mod: each move there is a failed one.
    const ui = await $.ui.mount({ ...FOCUSED_PANE, surface: 'terminal' })
    await personFocus($, 'file:src/lib/x.ts')
    await keys(ui, 'jkgeh')
    expect(await rowKeys(ui)).toEqual(TREE_KEYS)
    await ui.unmount()

    // As the engine answers: a refusal, a failure, a scroll that fails.
    const asked: string[] = []
    const engine = (focus: () => Promise<unknown>, scroll: () => Promise<unknown> = async () => ({})) =>
      ({
        ui: {
          focus: async (args: { key: string }) => {
            asked.push(`focus ${args.key}`)
            return focus()
          },
          scroll: async (args: unknown) => {
            asked.push(`scroll ${JSON.stringify(args)}`)
            return scroll()
          },
        },
      }) as never
    await focusRow(engine(async () => ({ deny: 'the pane does not hold the keys' })), 'file:a.txt')
    expect(asked).toEqual(['focus file:a.txt'])
    await focusRow(engine(async () => Promise.reject(new Error('no surface'))), 'file:a.txt')
    expect(asked).toHaveLength(2)
    await focusRow(engine(async () => ({}), async () => Promise.reject(new Error('no surface'))), 'file:a.txt')
    expect(asked.slice(2)).toEqual(['focus file:a.txt', 'scroll {"to":{"key":"file:a.txt"},"in":"worktree-diff"}'])
    await focusRow(engine(async () => ({}), async () => ({ deny: 'nothing to scroll' })), 'file:bin.dat')
    expect(asked.at(-1)).toBe('scroll {"to":{"key":"file:bin.dat"},"in":"worktree-diff"}')
    // g goes back to the pane's start, the header and the key hints with it, then shows the row.
    await focusRow(engine(async () => ({})), 'dir:deep/a/b', true)
    expect(asked.slice(-3)).toEqual([
      'focus dir:deep/a/b',
      'scroll {"to":"start","in":"worktree-diff"}',
      'scroll {"to":{"key":"dir:deep/a/b"},"in":"worktree-diff"}',
    ])
    // A start that fails still shows the row.
    const before = asked.length
    await focusRow(engine(async () => ({}), async () => Promise.reject(new Error('no surface'))), 'dir:deep/a/b', true)
    expect(asked.slice(before)).toEqual([
      'focus dir:deep/a/b',
      'scroll {"to":"start","in":"worktree-diff"}',
      'scroll {"to":{"key":"dir:deep/a/b"},"in":"worktree-diff"}',
    ])
  })

  test('keys pressed faster than the ring moves run in turn, each from where the last left it', async () => {
    // The kit runs the mod apart from this import, so the turns are watched on a stand-in ring.
    let ring = 0
    const moves: string[] = []
    const press = (step: number) => async () => {
      const from = ring
      // A move lands a few ticks after it is asked, as one over IPC does.
      for (let tick = 0; tick < 5; tick++) await Promise.resolve()
      ring = from + step
      moves.push(`${from}→${ring}`)
    }
    await Promise.all([inTurn(press(1)), inTurn(press(1)), inTurn(press(-1))])
    expect(moves).toEqual(['0→1', '1→2', '2→1'])
    // One that fails leaves the next to run.
    await Promise.all([inTurn(async () => Promise.reject(new Error('gone'))), inTurn(press(1))])
    expect(moves.at(-1)).toBe('1→2')
  })

  test('the ring starts on the row it last held, else the first; with no rows, nowhere', async ($, on) => {
    const { state } = world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await autoFocused(ui)).toBe(TREE_KEYS[0])
      await personFocus($, 'file:src/lib/x.ts')
      await ui.redraw()
      expect(await autoFocused(ui)).toBe('file:src/lib/x.ts')
      // A control the ring moved to since is not where it starts again.
      await personFocus($, 'refresh')
      await ui.redraw()
      expect(await autoFocused(ui)).toBe('file:src/lib/x.ts')
      // Folded out of sight, that row is gone: the first takes it.
      await ui.press({ key: 'dir:src' })
      expect(await autoFocused(ui)).toBe(TREE_KEYS[0])
      await ui.press({ key: 'dir:src' })
      await personFocus($, TREE_KEYS[0])
      await ui.unmount()
    }

    // Nothing listed.
    state.table = featTable({
      [`diff --numstat -z -M ${MB} --`]: ok(''),
      [`diff --name-status -z -M ${MB} --`]: ok(''),
      [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(''),
      'diff --name-only -z --no-renames HEAD --': ok(''),
      'ls-files --others --exclude-standard -z': ok(''),
    })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...FOCUSED_PANE, surface })
      expect(await autoFocused(ui)).toBeUndefined()
      // The keys do nothing, and nothing throws.
      await keys(ui, 'jkghle')
      await ui.unmount()
    }
  })

  test('the keys show while the pane holds the keyboard; before, the terminal says how to give it', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const idle = await $.ui.mount({ ...PANE, surface })
      expect(await idle.find({ key: 'nav:j' })).toBeUndefined()
      const hint = await idle.find({ type: 'Text', text: 'ctrl+x tab to focus' })
      if (surface === 'terminal') expect(hint?.props).toMatchObject({ dimColor: true })
      else expect(hint).toBeUndefined()
      await idle.unmount()

      const ui = await $.ui.mount({ ...FOCUSED_PANE, surface })
      expect(await ui.find({ type: 'Text', text: 'ctrl+x tab to focus' })).toBeUndefined()
      const buttons = await ui.findAll({ type: 'Button' })
      const nav = buttons.filter(button => button.key?.startsWith('nav:'))
      expect(nav.map(button => [button.props.hotkey, button.props.label])).toEqual([
        ['j', 'down'],
        ['k', 'up'],
        ['h', 'fold'],
        ['l', 'open'],
        ['g', 'top'],
        ['e', 'end'],
        ['q', 'close'],
        ['o', 'worktree'],
      ])
      for (const button of nav) expect(button.props).toMatchObject({ plain: true, dimColor: true })
      expect((await ui.find({ type: 'Text', text: 'esc: back' }))?.props).toMatchObject({ dimColor: true })
      // No two Buttons share a hotkey: the later would win.
      await ui.press({ key: 'file:a.txt' })
      const hotkeys = (await ui.findAll({ type: 'Button' })).map(button => button.props.hotkey).filter(Boolean)
      expect(hotkeys).toContain('x')
      expect(new Set(hotkeys).size).toBe(hotkeys.length)
      await ui.press({ key: 'collapse' })
      if (surface === 'terminal') {
        // The end of the pane, wrapped at 60 columns.
        expect((await screen(ui, 60)).slice(-3).map(line => line.trimEnd())).toEqual([
          '',
          'j: down  k: up  h: fold  l: open  g: top  e: end  q: close',
          'o: worktree  esc: back',
        ])
      }
      await ui.unmount()
    }
  })

  test('past the window the keys sit under the controls, where they cannot scroll out of reach', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      for (const isFocused of [true, false]) {
        const props = { ...PANE.props, isFocused }
        // Everything fits in 40 rows: the keys come last.
        const roomy = await $.ui.mount({ ...PANE, props, surface })
        let drawn = order(await roomy.drawn())
        if (isFocused) expect(drawn.slice(-8)).toEqual(['nav:j', 'nav:k', 'nav:h', 'nav:l', 'nav:g', 'nav:e', 'nav:q', 'nav:o'])
        if (!isFocused && surface === 'terminal') {
          expect((await screen(roomy, 60)).at(-1)?.trimEnd()).toBe('ctrl+x tab to focus')
        }
        await roomy.unmount()

        const tight = await $.ui.mount({ ...PANE, props: { ...props, scroll: { offset: 0, bodyRows: 12 } }, surface })
        drawn = order(await tight.drawn())
        if (isFocused) {
          const at = drawn.indexOf('nav:j')
          expect(drawn.slice(at - 1, at + 9)).toEqual(['fold', 'nav:j', 'nav:k', 'nav:h', 'nav:l', 'nav:g', 'nav:e', 'nav:q', 'nav:o', 'mode:all'])
        }
        if (surface === 'terminal') {
          const lines = (await screen(tight, 60)).map(line => line.trimEnd())
          // Under the controls, then a blank line, then the tabs.
          expect(lines[2]).toBe('r: refresh  t: list  z: fold')
          expect(lines.slice(3, 6)).toEqual(
            isFocused
              ? ['j: down  k: up  h: fold  l: open  g: top  e: end  q: close', 'o: worktree  esc: back', '']
              : ['ctrl+x tab to focus', '', 'a: all   c: committed   u: uncommitted'],
          )
        }
        await tight.unmount()
      }
    }
  })

  test('the keys stay at the end only with rows to spare, so a surface that draws one more cannot hide them', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const isAtEnd = (lines: string[]) => /(^ctrl\+x tab to focus|esc: back)$/.test(lines.at(-1)?.trimEnd() ?? '')
    for (const columns of [30, 42, 60]) {
      for (const isFocused of [true, false]) {
        for (const isOpened of [false, true]) {
          const props = { ...PANE.props, bodyColumns: columns, isFocused }
          const ui = await $.ui.mount({ ...PANE, props, surface: 'terminal' })
          if (isOpened) for (const key of ['file:a.txt', 'file:src/lib/x.ts']) await ui.press({ key })
          await ui.redraw({ ...props, scroll: { offset: 0, bodyRows: 400 } })
          const painted = await screen(ui, columns)
          expect(isAtEnd(painted)).toBe(true)
          // Out by one: the keys would be the row past the window. Exactly fitting: no row to spare.
          for (const bodyRows of [painted.length - 1, painted.length + 1]) {
            await ui.redraw({ ...props, scroll: { offset: 0, bodyRows } })
            expect(isAtEnd(await screen(ui, columns))).toBe(false)
          }
          await ui.unmount()
        }
      }
    }
  })

  test('q closes the pane', async ($, on) => {
    const { state } = world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      state.isOpen = true
      const ui = await $.ui.mount({ ...FOCUSED_PANE, surface })
      await keys(ui, 'q')
      expect(state.isOpen).toBe(false)
      await ui.unmount()
    }
  })

  test('the usage names close', async ($, on) => {
    world(on)
    expect(USAGE).toContain('/wt-diff close')
    expect((await wtDiff($, 'nope')).text).toBe(USAGE)
  })
})

describe('/wt-diff', () => {
  test('status refreshes and answers the summary', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    const { text } = await wtDiff($, 'status')

    expect(text).toBe(
      [
        'feat → main   reflog · 73481c5',
        '↑1 ↓1 · 7 files · +8 -3 · mode all',
        'M ● a.txt  +3 -1',
        'A   bin.dat  binary',
        '? ● dir/ubin.bin  binary',
        'D   gone.txt  +0 -2',
        'M ● keep.txt  +1 -0',
        'R   src/old name.txt → src/new näme.txt  +1 -0',
        '? ● untracked.md  +3',
      ].join('\n'),
    )
    // Every git call runs lock-free in the C locale, with a timeout.
    expect(state.inits[0]).toEqual({ cwd: ROOT, env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, timeoutMs: 15000 })
  })

  test('an untracked symbolic link counts one line, as git stores it', async ($, on) => {
    const link = `${ROOT}/link.txt`
    world(on, {
      isOpen: false,
      table: featTable({ 'ls-files --others --exclude-standard -z': ok('link.txt\0') }),
      files: { [link]: 'l1\nl2\nl3\n' },
      links: [link],
    })
    const { text } = await wtDiff($, 'status')

    expect(text).toContain('? ● link.txt  +1')
    expect(text).toContain('6 files · +6 -3')
  })

  test('no argument opens the pane and asks for the keyboard, again and again; close closes it', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    expect((await wtDiff($)).text).toBe('Changes pane focused — j/k move · enter open · esc back · q close')
    expect(state.opened).toBe(1)
    expect(state.openArgs.at(-1)).toMatchObject({ id: 'worktree-diff', focus: true })
    // On screen already: focused again, not closed.
    expect((await wtDiff($, '')).text).toBe(FOCUSED)
    expect(state.opened).toBe(2)
    expect(state.openArgs.at(-1)).toMatchObject({ focus: true })
    expect(state.isOpen).toBe(true)

    expect((await wtDiff($, 'close')).text).toBe('Changes pane closed.')
    expect(state.isOpen).toBe(false)
    expect((await wtDiff($, 'close')).text).toBe('Changes pane is not open.')
    expect((await wtDiff($, 'close now')).text).toBe(USAGE)
  })

  test('the pane opens with a transparent backdrop by default', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    await wtDiff($)
    expect(state.openArgs.at(-1)).toMatchObject({ id: 'worktree-diff', backgroundColor: 'transparent' })
  })

  test('paneBackground theme leaves the surface its own fill', { options: { paneBackground: 'theme' } }, async ($, on) => {
    const { state } = world(on, { isOpen: false })
    await wtDiff($)
    expect(state.openArgs.at(-1)).not.toHaveProperty('backgroundColor')
  })

  test('a pane open but undrawn on a narrow terminal is placed and focused', async ($, on) => {
    const { state } = world(on, { isOpen: true, isPlaced: false })
    expect((await wtDiff($)).text).toBe(FOCUSED)
    expect(state.opened).toBe(1)
    expect(state.openArgs.at(-1)).toMatchObject({ id: 'worktree-diff', focus: true })
    expect(state.isPlaced).toBe(true)
  })

  test('a pane the engine opens without the keyboard says how to give it', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    state.grantsFocus = false
    expect((await wtDiff($)).text).toBe('Changes pane opened — ctrl+x tab to focus')
    expect(state.isOpen).toBe(true)
    expect(state.openArgs.at(-1)).toMatchObject({ focus: true })
    state.grantsFocus = true
    expect((await wtDiff($)).text).toBe(FOCUSED)
  })

  test('a pane that is a tab behind another is raised and focused', async ($, on) => {
    const { state } = world(on, { isOpen: true, isPlaced: true, isShown: false })
    expect((await wtDiff($)).text).toBe(FOCUSED)
    expect(state.isOpen).toBe(true)
    expect(state.openArgs.at(-1)).toMatchObject({ id: 'worktree-diff', focus: true })
  })

  test('base <ref> is checked, stored per worktree and used; base alone clears it', async ($, on) => {
    const { state } = world(on, {
      table: featTable({
        'rev-parse --verify --quiet nope^{commit}': fail(1, ''),
        'rev-parse --verify --quiet v1^{commit}': ok(`${MAIN_SHA}\n`),
        'merge-base v1 HEAD': ok(`${MB}\n`),
        'rev-list --left-right --count v1...HEAD': ok('0\t1\n'),
      }),
    })
    expect((await wtDiff($, 'base nope')).text).toBe('Not a commit here: nope')
    expect((await wtDiff($, 'base --all')).text).toBe('Not a ref: --all')
    expect((await wtDiff($, 'base v1')).text).toBe(`Base set to v1 for ${ROOT}.`)

    const status = (await wtDiff($, 'status')).text ?? ''
    expect(status.split('\n')[0]).toBe('feat → v1   override · 73481c5')

    expect((await wtDiff($, 'base')).text).toBe(`Base override cleared for ${ROOT}.`)
    const again = (await wtDiff($, 'status')).text ?? ''
    expect(again.split('\n')[0]).toBe('feat → main   reflog · 73481c5')
    expect(state.calls.filter(key => key === 'merge-base v1 HEAD').length).toBeGreaterThan(0)
  })

  test('trunk <ref> is checked, stored per repository and used; trunk alone clears it', async ($, on) => {
    // The branch's reflog is lost and it tracks nothing: the main worktree's branch until a trunk is set.
    const { state } = world(on, {
      table: featTable({
        'reflog show --format=%gs refs/heads/feat': ok(''),
        'rev-parse --verify --quiet nope^{commit}': fail(1, ''),
        'rev-parse --verify --quiet v1^{commit}': ok(`${MAIN_SHA}\n`),
        'rev-parse --symbolic-full-name v1': ok('refs/tags/v1\n'),
        'merge-base v1 HEAD': ok(`${MB}\n`),
        'rev-list --left-right --count v1...HEAD': ok('0\t1\n'),
      }),
    })
    const first = (await wtDiff($, 'status')).text ?? ''
    expect(first.split('\n')[0]).toBe('feat → main   main-worktree · 73481c5')

    expect((await wtDiff($, 'trunk nope')).text).toBe('Not a commit here: nope')
    expect((await wtDiff($, 'trunk --all')).text).toBe('Not a ref: --all')
    expect(state.calls).not.toContain('rev-parse --verify --quiet --all^{commit}')
    expect((await wtDiff($, 'trunk a b')).text).toBe(USAGE)

    expect((await wtDiff($, 'trunk v1')).text).toBe(`Trunk set to v1 for every worktree of ${REPO}/.git.`)
    const status = (await wtDiff($, 'status')).text ?? ''
    expect(status.split('\n')[0]).toBe('feat → v1   trunk · 73481c5')

    expect((await wtDiff($, 'trunk')).text).toBe(`Trunk cleared for ${REPO}/.git.`)
    const again = (await wtDiff($, 'status')).text ?? ''
    expect(again.split('\n')[0]).toBe('feat → main   main-worktree · 73481c5')
  })

  test('trunk refuses what moves with HEAD: it would mean something else in each worktree', async ($, on) => {
    const { state } = world(on, {
      table: featTable({
        'reflog show --format=%gs refs/heads/feat': ok(''),
        'rev-parse --verify --quiet HEAD^{commit}': ok(`${MAIN_SHA}\n`),
        'rev-parse --verify --quiet HEAD~2^{commit}': ok(`${MAIN_SHA}\n`),
        'rev-parse --verify --quiet @{u}^{commit}': ok(`${MAIN_SHA}\n`),
        'rev-parse --verify --quiet @{-1}^{commit}': ok(`${MAIN_SHA}\n`),
      }),
    })
    for (const ref of ['HEAD', 'HEAD~2', '@{u}', '@{-1}']) {
      expect((await wtDiff($, `trunk ${ref}`)).text).toBe(`Not a branch name: ${ref}`)
    }
    expect(state.calls.some(key => key.startsWith('rev-parse --symbolic-full-name'))).toBe(false)
    expect(((await wtDiff($, 'status')).text ?? '').split('\n')[0]).toBe('feat → main   main-worktree · 73481c5')
  })

  test('trunk stores a branch by its full name: the local team/feat is no copy of feat', async ($, on) => {
    world(on, {
      table: featTable({
        'reflog show --format=%gs refs/heads/feat': ok(''),
        'rev-parse --verify --quiet team/feat^{commit}': ok(`${MAIN_SHA}\n`),
        'rev-parse --symbolic-full-name team/feat': ok('refs/heads/team/feat\n'),
        'merge-base team/feat HEAD': ok(`${MB}\n`),
        'rev-list --left-right --count team/feat...HEAD': ok('0\t1\n'),
      }),
    })
    expect((await wtDiff($, 'trunk team/feat')).text).toBe(
      `Trunk set to team/feat for every worktree of ${REPO}/.git.`,
    )
    expect(((await wtDiff($, 'status')).text ?? '').split('\n')[0]).toBe('feat → team/feat   trunk · 73481c5')
  })

  test('a stored remote trunk that is this branch\'s copy is skipped', async ($, on) => {
    world(on, {
      store: { [`trunk:${REPO}/.git`]: 'refs/remotes/team/feat' },
      table: featTable({ 'reflog show --format=%gs refs/heads/feat': ok('') }),
    })
    expect(((await wtDiff($, 'status')).text ?? '').split('\n')[0]).toBe('feat → main   main-worktree · 73481c5')
  })

  test('the trunk is shared: another worktree of the same repository compares against it', async ($, on) => {
    const lost = { 'reflog show --format=%gs refs/heads/feat': ok('') }
    const { state } = world(on, {
      table: featTable({
        ...lost,
        'rev-parse --verify --quiet v1^{commit}': ok(`${MAIN_SHA}\n`),
        'merge-base v1 HEAD': ok(`${MB}\n`),
        'rev-list --left-right --count v1...HEAD': ok('0\t1\n'),
      }),
    })
    expect((await wtDiff($, 'trunk v1')).text).toBe(`Trunk set to v1 for every worktree of ${REPO}/.git.`)

    // The session moves to a sibling worktree, branch fromhead, made from HEAD.
    state.cwd = '/w/t1-wt2'
    state.table = {
      ...state.table,
      'rev-parse --show-toplevel': ok('/w/t1-wt2\n'),
      'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(`${REPO}/.git/worktrees/t1-wt2\n${REPO}/.git\n`),
      'symbolic-ref --short -q HEAD': ok('fromhead\n'),
      'reflog show --format=%gs refs/heads/fromhead': ok('branch: Created from HEAD\n'),
      'rev-parse --abbrev-ref fromhead@{upstream}': fail(128, "fatal: no upstream configured for branch 'fromhead'\n"),
    }
    const status = (await wtDiff($, 'status')).text ?? ''
    expect(status.split('\n')[0]).toBe('fromhead → v1   trunk · 73481c5')

    // A base override stays with the worktree that set it.
    state.table['rev-parse --verify --quiet main^{commit}'] = ok(`${MAIN_SHA}\n`)
    expect((await wtDiff($, 'base main')).text).toBe('Base set to main for /w/t1-wt2.')
    expect(((await wtDiff($, 'status')).text ?? '').split('\n')[0]).toBe('fromhead → main   override · 73481c5')
    state.cwd = ROOT
    state.table = {
      ...state.table,
      'rev-parse --show-toplevel': ok(`${ROOT}\n`),
      'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(`${REPO}/.git/worktrees/t1-wt\n${REPO}/.git\n`),
      'symbolic-ref --short -q HEAD': ok('feat\n'),
    }
    expect(((await wtDiff($, 'status')).text ?? '').split('\n')[0]).toBe('feat → v1   trunk · 73481c5')
  })

  test('a stored trunk is read under the git common dir, from the first refresh', async ($, on) => {
    world(on, {
      store: { [`trunk:${REPO}/.git`]: 'v1', [`trunk:${ROOT}/.git`]: 'wrong' },
      table: featTable({
        'reflog show --format=%gs refs/heads/feat': ok(''),
        'rev-parse --verify --quiet v1^{commit}': ok(`${MAIN_SHA}\n`),
        'merge-base v1 HEAD': ok(`${MB}\n`),
        'rev-list --left-right --count v1...HEAD': ok('0\t1\n'),
      }),
    })
    expect(((await wtDiff($, 'status')).text ?? '').split('\n')[0]).toBe('feat → v1   trunk · 73481c5')
  })

  test('the main checkout of an integration branch, reflog expired, shows what is not pushed', async ($, on) => {
    // Real git 2.54 output: main checkout on feat/x (origin/HEAD is origin/main),
    // its reflog down to one commit, two commits not pushed, one behind,
    // main1.txt edited and untracked.txt new.
    const mb = '2d46dcceab4dd5d011258f668d7922708e707423'
    const root = '/w/main-co'
    world(on, {
      cwd: root,
      files: { [`${root}/untracked.txt`]: 'u1\nu2\nu3\n' },
      table: {
        'rev-parse --show-toplevel': ok(`${root}\n`),
        'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(`${root}/.git\n${root}/.git\n`),
        'symbolic-ref --short -q HEAD': ok('feat/x\n'),
        'rev-parse --verify --quiet --short HEAD': ok('78e5db8\n'),
        'reflog show --format=%gs refs/heads/feat/x': ok('commit: local 2\n'),
        'rev-parse --abbrev-ref feat/x@{upstream}': ok('origin/feat/x\n'),
        'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
        'merge-base origin/feat/x HEAD': ok(`${mb}\n`),
        'rev-list --left-right --count origin/feat/x...HEAD': ok('1\t2\n'),
        [`diff --numstat -z -M ${mb} --`]: ok('1\t0\tdocs/a.md\x001\t0\tmain1.txt\x002\t0\tsrc/app/api/route1.ts\x00'),
        [`diff --name-status -z -M ${mb} --`]: ok('A\x00docs/a.md\x00M\x00main1.txt\x00M\x00src/app/api/route1.ts\x00'),
        [`diff --name-only -z --no-renames ${mb} HEAD --`]: ok('docs/a.md\x00src/app/api/route1.ts\x00'),
        'diff --name-only -z --no-renames HEAD --': ok('main1.txt\x00'),
        'ls-files --others --exclude-standard -z': ok('untracked.txt\x00'),
      },
    })
    expect((await wtDiff($, 'status')).text).toBe(
      [
        'feat/x → origin/feat/x   upstream · 2d46dcc',
        '↑2 ↓1 · 4 files · +7 -0 · mode all',
        'A   docs/a.md  +1 -0',
        'M ● main1.txt  +1 -0',
        'M   src/app/api/route1.ts  +2 -0',
        '? ● untracked.txt  +3',
      ].join('\n'),
    )
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lines = await screen(ui, 60)
    expect(lines[0]).toMatch(/^feat\/x +↑2 ↓1$/)
    expect(lines[1]).toMatch(/^vs origin\/feat\/x +upstream · 2d46dcc$/)
    expect(await rowKeys(ui)).toEqual([
      'dir:docs',
      'file:docs/a.md',
      'dir:src/app/api',
      'file:src/app/api/route1.ts',
      'file:main1.txt',
      'file:untracked.txt',
    ])
    await ui.unmount()
  })

  test('the usage names the trunk command', async ($, on) => {
    world(on)
    expect(USAGE).toContain('/wt-diff trunk <ref>')
    expect((await wtDiff($, 'help')).text).toBe(USAGE)
  })

  test('mode switches the listing; bad arguments answer the usage', async ($, on) => {
    world(on)
    expect((await wtDiff($, 'mode committed')).text).toBe('Mode: committed')
    const status = (await wtDiff($, 'status')).text ?? ''
    expect(status.split('\n')[1]).toBe('↑1 ↓1 · 4 files · +3 -3 · mode committed')

    for (const args of ['mode', 'mode sideways', 'bogus', 'base a b']) {
      expect((await wtDiff($, args)).text).toBe(USAGE)
    }
  })
})

// ---------------------------------------------------------------- layout

const RENAME_DIFF = ok(
  'diff --git a/src/old name.txt b/src/new näme.txt\nsimilarity index 94%\n' +
    'rename from src/old name.txt\nrename to src/new näme.txt\n@@ -1,2 +1,3 @@\n one\n two\n+three\n',
)
const LONG_BRANCH = 'feat/HAR-123-polish-the-changes-pane-header'
const LONG_REF = 'origin/release/2026-10-the-long-integration-branch'

describe('layout', () => {
  test('the rule marks the current tab at 55 columns; at 36 the tabs wrap and its label is underlined', async ($, on) => {
    world(on)
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 55 } })
    for (const mode of ['committed', 'uncommitted', 'all'] as const) {
      await ui.press({ key: `mode:${mode}` })
      const lines = await screen(ui, 55)
      const at = lines.findIndex(line => line.startsWith('a: all'))
      expect(lines[at]?.trimEnd()).toBe('a: all   c: committed   u: uncommitted')
      const rule = lines[at + 1] ?? ''
      expect(rule).toMatch(/^─*━+─*$/)
      expect(cellWidth(rule)).toBe(55)
      // Right under the current tab's own cells: its hotkey, the colon and the label.
      const [from, to] = [rule.indexOf('━'), rule.lastIndexOf('━') + 1]
      expect(lines[at]?.slice(from, to)).toBe(`${mode[0]}: ${mode}`)
      expect((await ui.find({ type: 'Text', text: /━/ }))?.props).toMatchObject({ color: 'suggestion' })
      expect((await ui.find({ type: 'Text', text: /─/ }))?.props).toMatchObject({ color: 'subtle' })
      expect((await ui.find({ key: `mode:${mode}` }))?.children).toEqual([
        { type: 'Text', props: { weight: 'semibold' }, children: [mode] },
      ])
    }
    await ui.unmount()

    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 36 } })
    const lines = await screen(narrow, 36)
    const at = lines.findIndex(line => line.startsWith('a: all'))
    expect(lines.slice(at, at + 3).map(line => line.trimEnd())).toEqual([
      'a: all   c: committed',
      'u: uncommitted',
      '─'.repeat(36),
    ])
    expect((await narrow.find({ key: 'mode:all' }))?.children).toEqual([
      { type: 'Text', props: { weight: 'semibold', underline: true }, children: ['all'] },
    ])
    await narrow.unmount()

    // Elsewhere the surface marks the primary button itself: no rule.
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await desktop.find({ type: 'Text', text: /[━─]/ })).toBeUndefined()
    await desktop.unmount()
  })

  test('the summary follows the mode, its legend short under 46 columns', async ($, on) => {
    world(on)
    await wtDiff($, 'refresh')
    const summaryAt = async (columns: number) => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
      const line = (await screen(ui, columns)).find(row => /^\d+ files? /.test(row)) ?? ''
      await ui.unmount()
      return line
    }
    expect(await summaryAt(55)).toBe(`7 files  ● 4 uncommitted${' '.repeat(26)}+8 −3`)
    expect(await summaryAt(42)).toBe(`7 files  ● 4${' '.repeat(25)}+8 −3`)
    await wtDiff($, 'mode uncommitted')
    expect(await summaryAt(42)).toBe(`4 files${' '.repeat(30)}+5 −0`)
  })

  test('a top-level row after a nested one starts a group, unless a diff already parts them', async ($, on) => {
    world(on, { table: featTable({ [`diff -M ${MB} -- :(literal)src/new näme.txt :(literal)src/old name.txt`]: RENAME_DIFF }) })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 55 } })
    const before = (lines: string[], start: string) => {
      const at = lines.findIndex(line => line.startsWith(start))
      return [lines[at - 2] ?? '', lines[at - 1] ?? ''].map(line => line.trimEnd())
    }
    let lines = await screen(ui, 55)
    expect(before(lines, '▾ dir/')[1]).toMatch(/^7 files/)
    expect(before(lines, '▾ src/')[1]).toBe('')
    expect(before(lines, 'M ● a.txt')[1]).toBe('')
    expect(before(lines, 'A   bin.dat')[1]).toMatch(/^M ● a\.txt/)

    // The diff's own margin parts it from the next group: one blank, not two.
    await ui.press({ key: 'file:src/new näme.txt' })
    lines = await screen(ui, 55)
    const [twoUp, oneUp] = before(lines, 'M ● a.txt')
    expect(oneUp).toBe('')
    expect(twoUp).not.toBe('')
    // The diff starts under the name.
    const name = lines.findIndex(line => line.includes('new näme.txt'))
    expect(lines[name + 1]?.indexOf('@@')).toBe(lines[name]?.indexOf('new näme.txt'))
    await ui.unmount()
  })

  test('no line is wider than the pane at 42, 55 and 75 columns, in either view and every mode', async ($, on) => {
    const long = 'src/components/settings/notifications/EmailDigestPreferencesPanel.tsx'
    world(on, {
      table: treeTable({
        'symbolic-ref --short -q HEAD': ok(`${LONG_BRANCH}\n`),
        [`rev-parse --verify --quiet ${LONG_REF}^{commit}`]: ok(`${MAIN_SHA}\n`),
        [`merge-base ${LONG_REF} HEAD`]: ok(`${MB}\n`),
        [`rev-list --left-right --count ${LONG_REF}...HEAD`]: ok('12\t345\n'),
        'ls-files --others --exclude-standard -z': ok(`${UNTRACKED}deep/a/b/c.md\0deep/a/b/d.md\0src/lib/x.ts\0${long}\0`),
        [`diff -M ${MB} -- :(literal)src/new näme.txt :(literal)src/old name.txt`]: RENAME_DIFF,
        'diff --no-index -- /dev/null src/lib/x.ts': {
          exitCode: 1,
          stdout: `diff --git a/src/lib/x.ts b/src/lib/x.ts\n@@ -0,0 +1,4 @@\n+${'x'.repeat(120)}\n+2\n+3\n+4\n`,
        },
      }),
      files: { ...treeFiles, [`${ROOT}/${long}`]: 'a\n'.repeat(1234) },
      store: { [`base:${ROOT}`]: LONG_REF },
    })
    await wtDiff($, 'refresh')
    let isOpened = false
    for (const view of ['tree', 'list']) {
      for (const columns of [42, 55, 75]) {
        const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
        if (view === 'list' && (await ui.find({ key: 'view' }))?.props.label === 'list') await ui.press({ key: 'view' })
        if (!isOpened) {
          for (const key of ['file:a.txt', 'file:src/lib/x.ts', 'file:src/new näme.txt', 'dir:dir']) await ui.press({ key })
          isOpened = true
        }
        for (const mode of ['all', 'committed', 'uncommitted'] as const) {
          await ui.press({ key: `mode:${mode}` })
          const lines = await screen(ui, columns)
          for (const line of lines) {
            if (cellWidth(line) > columns) throw new Error(`${view} ${mode} at ${columns}: ${JSON.stringify(line)}`)
          }
          // The keys, under the controls or at the end, wrap within the pane too.
          for (const bodyRows of [8, 400]) {
            await ui.redraw({ ...PANE.props, bodyColumns: columns, isFocused: true, scroll: { offset: 0, bodyRows } })
            for (const line of await screen(ui, columns)) {
              if (cellWidth(line) > columns) throw new Error(`focused ${view} ${mode} at ${columns}: ${JSON.stringify(line)}`)
            }
          }
          await ui.redraw({ ...PANE.props, bodyColumns: columns })
          // The branch row and the summary reach the edge: their right sides line up.
          expect(cellWidth(lines[0] ?? '')).toBe(columns)
          expect(lines[0]).toMatch(/ ↑345 ↓12$/)
          expect(cellWidth(lines.find(line => /^\d+ files? /.test(line)) ?? '')).toBe(columns)
        }
        await ui.unmount()
      }
    }
  })

  test('the header cuts the branch in the middle and gives up where the base came from before the ref', async ($, on) => {
    world(on, {
      table: featTable({
        'symbolic-ref --short -q HEAD': ok(`${LONG_BRANCH}\n`),
        [`rev-parse --verify --quiet ${LONG_REF}^{commit}`]: ok(`${MAIN_SHA}\n`),
        [`merge-base ${LONG_REF} HEAD`]: ok(`${MB}\n`),
        [`rev-list --left-right --count ${LONG_REF}...HEAD`]: ok('0\t3\n'),
      }),
      store: { [`base:${ROOT}`]: LONG_REF },
    })
    await wtDiff($, 'refresh')
    const header = async (columns: number) => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
      const lines = (await screen(ui, columns)).slice(0, 2)
      await ui.unmount()
      return lines
    }
    expect(await header(75)).toEqual([
      `${LONG_BRANCH}${' '.repeat(75 - LONG_BRANCH.length - 5)}↑3 ↓0`,
      `vs ${LONG_REF}${' '.repeat(75 - 3 - LONG_REF.length - 18)}override · 73481c5`,
    ])
    // Where the base came from goes first, then the sha; the ref stays whole while it fits.
    expect(await header(62)).toEqual([
      `${LONG_BRANCH}${' '.repeat(62 - LONG_BRANCH.length - 5)}↑3 ↓0`,
      `vs ${LONG_REF}  73481c5`,
    ])
    expect(await header(55)).toEqual([`${LONG_BRANCH}${' '.repeat(55 - LONG_BRANCH.length - 5)}↑3 ↓0`, `vs ${LONG_REF}`])
    // Then both are cut in the middle, ↑↓ kept.
    expect(await header(42)).toEqual(['feat/HAR-123-pol…nges-pane-header    ↑3 ↓0', 'vs …/2026-10-the-long-integration-branch'])
  })
})

// --------------------------------------------------------------- refresh

describe('refresh', () => {
  test('an Edit schedules one debounced refresh; other tools do not', async ($, on) => {
    const { state, clock } = world(on)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.txt` })
    await clock.advance(1_000)
    expect(state.calls).toEqual([])

    const ran = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.txt`, old_string: 'a', new_string: 'b' })
    expect(ran).toEqual({ result: {} })
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/b.txt`, content: 'x' })
    await clock.advance(299)
    // Only what it follows is read meanwhile: the session's own worktree.
    expect(state.calls.filter(key => key === PASS_MARK)).toEqual([])
    await clock.advance(1)
    const passes = state.calls.filter(key => key === PASS_MARK)
    expect(passes.length).toBe(1)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'file:a.txt' })).toBeDefined()
    await ui.unmount()
  })

  test('with the pane closed nothing is read on a trigger', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await $.tool.call({ tool: 'Bash', command: 'touch x' })
    await clock.advance(1_000)
    expect(state.calls).toEqual([])
  })

  test('a changed worktree redraws the rows and the open diff', async ($, on) => {
    const { state, clock } = world(on)
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'file:a.txt' })

    // Same counts, new text: the signature holds, the diff still reloads.
    const edited = DIFF_A_ALL.replace('+extra', '+EXTRA')
    state.table = featTable({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(edited) })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.txt`, old_string: 'extra', new_string: 'EXTRA' })
    await clock.advance(300)
    await clock.settle()
    expect(await diffOf(ui, 'a.txt')).toContain('+ EXTRA')

    // a.txt reverted: its row and its open diff go.
    state.table = featTable({
      [`diff --numstat -z -M ${MB} --`]: ok('1\t0\tkeep.txt\0'),
      [`diff --name-status -z -M ${MB} --`]: ok('M\0keep.txt\0'),
      'ls-files --others --exclude-standard -z': ok(''),
    })
    await $.tool.call({ tool: 'Bash', command: 'git checkout a.txt' })
    await clock.advance(300)
    await clock.settle()
    expect(await ui.find({ key: 'file:a.txt' })).toBeUndefined()
    expect(await opened(ui)).toEqual([])
    expect(await ui.find({ key: 'file:keep.txt' })).toBeDefined()
    await ui.unmount()
  })

  test('turn.complete refreshes too', async ($, on) => {
    const { state, clock } = world(on)
    await $.turn.complete({ reason: 'answer', text: '' } as never)
    await clock.advance(300)
    expect(state.calls).toContain('rev-parse --show-toplevel')
  })

  test('the open pane polls', async ($, on) => {
    const { state, clock } = world(on)
    await wtDiff($, 'refresh')
    const before = state.calls.length
    await clock.advance(5_000)
    expect(state.calls.length).toBeGreaterThan(before)
  })

  test('a poll tick while a slow pass runs is dropped, not queued', async ($, on) => {
    const { state, clock } = world(on)
    await wtDiff($, 'refresh')
    const held = gate()
    const reached = gate()
    state.hold = held.promise
    state.onHold = reached.open
    const before = state.calls.length
    await clock.advance(5_000)
    await reached.promise
    // Three more ticks land while git is held.
    await clock.advance(15_000)
    state.hold = undefined
    held.open()
    await clock.settle()

    const passes = state.calls
      .slice(before)
      .filter(key => key === PASS_MARK)
    expect(passes.length).toBe(1)
  })

  test('a hidden tab does not poll', async ($, on) => {
    const { state, clock } = world(on, { isShown: false })
    await wtDiff($, 'refresh')
    const calls = state.calls.length
    await clock.advance(10_000)
    expect(state.calls.length).toBe(calls)
  })

  test('closing the pane stops the polling', async ($, on) => {
    const { state, clock } = world(on)
    await wtDiff($, 'refresh')
    // The kit raises events, not `$.ui.close`: close it the way /wt-diff close does.
    expect((await wtDiff($, 'close')).text).toBe('Changes pane closed.')
    const calls = state.calls.length
    const panes = state.panesCalls
    await clock.advance(10_000)
    expect(state.calls.length).toBe(calls)
    expect(state.panesCalls).toBe(panes)
  })

  test('an undrawn pane does not poll until it is drawn', async ($, on) => {
    const { state, clock } = world(on, { isPlaced: false })
    await wtDiff($, 'refresh')
    const panes = state.panesCalls
    await clock.advance(10_000)
    expect(state.panesCalls).toBe(panes)

    // The terminal widens: the surface draws it, and the poll begins.
    state.isPlaced = true
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const calls = state.calls.length
    await clock.advance(5_000)
    expect(state.calls.length).toBeGreaterThan(calls)
    await ui.unmount()
  })

  test('refreshes at once share one pass and at most one more', async ($, on) => {
    const { state } = world(on)
    const [one, two] = await Promise.all([wtDiff($, 'status'), wtDiff($, 'status')])
    expect(one.text).toBe(two.text)
    const passes = state.calls.filter(key => key === PASS_MARK)
    expect(passes.length).toBeGreaterThan(0)
    expect(passes.length).toBeLessThanOrEqual(2)
  })

  test('a mode switch while git runs reruns in the new mode', async ($, on) => {
    const { state } = world(on)
    await wtDiff($, 'refresh')
    const held = gate()
    const reached = gate()
    state.hold = held.promise
    state.onHold = reached.open
    const before = state.calls.length
    const pending = wtDiff($, 'refresh')
    await reached.promise
    const switching = wtDiff($, 'mode committed')
    state.hold = undefined
    held.open()
    await Promise.all([pending, switching])

    const passes = state.calls
      .slice(before)
      .filter(key => key === PASS_MARK)
    expect(passes.length).toBe(2)
    expect(state.calls.slice(before)).toContain(`diff --numstat -z -M ${MB} HEAD --`)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'mode:committed' }))?.props.variant).toBe('primary')
    expect(await ui.find({ key: 'file:keep.txt' })).toBeUndefined()
    await ui.unmount()
  })

  test('statusLine ends the terminal hint line with the totals, kept current', { options: { statusLine: true } }, async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    const hint = await $.ui.mount({
      plugin: 'worktree-diff',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      viewport: { columns: 160, rows: 40, isFullscreen: true },
    })
    // Nothing read yet: the line as the engine has it.
    expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
    await wtDiff($, 'refresh')
    expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts · 7 files +8 −3')
    // The terminal alone: no status line besides.
    expect(state.statuses.filter(text => text !== undefined)).toEqual([])

    // The pane closed, an edit still updates it.
    state.table = featTable({
      [`diff --numstat -z -M ${MB} --`]: ok('1\t0\tkeep.txt\0'),
      [`diff --name-status -z -M ${MB} --`]: ok('M\0keep.txt\0'),
      'ls-files --others --exclude-standard -z': ok(''),
    })
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/a.txt`, old_string: 'a', new_string: 'b' })
    await clock.advance(300)
    await clock.settle()
    expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts · 1 file +1 −0')
    await hint.unmount()
  })

  test('statusLine off leaves the hint line alone', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    await wtDiff($, 'refresh')
    const hint = await $.ui.mount({
      plugin: 'worktree-diff',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
    expect(state.statuses.filter(text => text !== undefined)).toEqual([])
    await hint.unmount()
  })

  test(
    'statusLine uses the status line where a surface draws no tail, and a reload clears an old one',
    { options: { statusLine: true } },
    async ($, on) => {
      const { state } = world(on, { isOpen: false, surfaces: ['terminal', 'desktop'] })
      await wtDiff($, 'refresh')
      expect(state.statuses.at(-1)).toBe('7 files +8 −3')
      // The desktop draws no tail: its hint line is left as it is.
      const hint = await $.ui.mount({
        plugin: 'worktree-diff',
        surface: 'desktop',
        component: 'PromptHint',
        props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
      })
      expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
      await hint.unmount()
      // Same totals: not set again.
      const count = state.statuses.length
      await wtDiff($, 'refresh')
      expect(state.statuses.length).toBe(count)

      // A reload clears what an earlier load left, then sets it again while the desktop is attached.
      await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
      await wtDiff($, 'refresh')
      expect(state.statuses.slice(count)).toEqual([undefined, '7 files +8 −3'])

      // With the terminal alone it clears and is not set again.
      const after = state.statuses.length
      state.surfaces = ['terminal']
      await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
      expect(state.statuses.at(-1)).toBeUndefined()
      await wtDiff($, 'refresh')
      expect(state.statuses.slice(after)).toEqual([undefined])
    },
  )

  test(
    'statusLine follows a surface joining or leaving an idle session, with no refresh between',
    { options: { statusLine: true } },
    async ($, on) => {
      const { state, clock } = world(on, { isOpen: false })
      await wtDiff($, 'refresh')
      expect(state.statuses.filter(text => text !== undefined)).toEqual([])

      state.surfaces = ['terminal', 'mobile']
      await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
      await clock.settle()
      expect(state.statuses.at(-1)).toBe('7 files +8 −3')

      state.surfaces = ['terminal']
      await $.session.detach({ surface: 'mobile', clientId: 'mobile:default', reason: 'detach' })
      await clock.settle()
      expect(state.statuses.at(-1)).toBeUndefined()
      const count = state.statuses.length

      // The session ending leaves it be.
      state.surfaces = ['terminal', 'mobile']
      await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
      await clock.settle()
      const shown = state.statuses.length
      expect(shown).toBe(count + 1)
      await $.session.detach({ surface: 'mobile', clientId: 'mobile:default', reason: 'end' })
      await clock.settle()
      expect(state.statuses.length).toBe(shown)
    },
  )

  test('statusLine off ignores a surface joining', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await wtDiff($, 'refresh')
    state.surfaces = ['terminal', 'mobile']
    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    await clock.settle()
    expect(state.statuses.filter(text => text !== undefined)).toEqual([])
  })
})

// ------------------------------------------------------------- auto-open

describe('auto-open', () => {
  test('a linked worktree opens the pane at start, where panes dock', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await drawHint($, true)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(1)
  })

  test('the open waits for a drawing to say panes dock', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(0)

    await drawHint($, true)
    await clock.advance(300)
    await clock.settle()
    expect(state.opened).toBe(1)
  })

  test('the main screen opens nothing unasked: it would sit inline above the prompt', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    await drawHint($, false)
    await clock.advance(1_000)
    expect(state.opened).toBe(0)

    // Nor after EnterWorktree; /wt-diff still opens it.
    state.cwd = REPO
    await $.tool.call({ tool: 'EnterWorktree', name: 'feat' } as never)
    await clock.advance(300)
    await clock.settle()
    expect(state.opened).toBe(0)
    expect((await wtDiff($)).text).toBe(FOCUSED)
  })

  test('a reload does not open it again, nor does a non-interactive start', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await drawHint($, true)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
    await clock.settle()
    expect(state.opened).toBe(0)

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(1)
    // A reload with the pane on screen opens it again so a new backdrop applies.
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(2)
    expect(state.openArgs.at(-1)).toMatchObject({ backgroundColor: 'transparent' })
    expect(state.openArgs.at(-1)).not.toHaveProperty('focus')
    // The person closes it; the hot reload's session.start finds a snapshot.
    state.isOpen = false
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(2)
  })

  test('the main checkout does not, under the default', async ($, on) => {
    const { state, clock } = world(on, {
      isOpen: false,
      table: featTable({
        'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(`${REPO}/.git\n${REPO}/.git\n`),
      }),
    })
    await drawHint($, true)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(0)
  })

  test('never means never', { options: { autoOpen: 'never' } }, async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(0)
    expect(state.calls).toEqual([])
  })

  test('EnterWorktree opens it after the move', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false, cwd: REPO })
    await drawHint($, true)
    await $.tool.call({ tool: 'EnterWorktree', name: 'feat' } as never)
    await clock.advance(300)
    await clock.settle()
    expect(state.opened).toBe(1)
  })

  test('a denied, failed or standing-still EnterWorktree leaves a closed pane closed', async ($, on) => {
    const { state, clock } = world(on, { isOpen: false })
    await drawHint($, true)
    const enter = async () => {
      await $.tool.call({ tool: 'EnterWorktree', name: 'feat' } as never)
      await clock.advance(300)
      await clock.settle()
    }

    state.enter.deny = 'no'
    await enter()
    state.enter.deny = undefined
    state.enter.isError = true
    await enter()
    state.enter.isError = false
    // Already in the worktree: the cwd does not move.
    await enter()
    expect(state.opened).toBe(0)
  })
})

// ------------------------------------------------------------------ side

/** Three hunks of a.txt, eight rows each as the diff region counts them. */
const hunkAt = (line: number) => `@@ -${line},6 +${line},6 @@ fn${line}()\n c1\n c2\n-old${line}\n+new${line}\n c3\n c4\n c5\n`
const LONG_A = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n${hunkAt(1)}${hunkAt(40)}${hunkAt(80)}`

/** The tree fixture, each untracked text file's diff readable. */
const sideTable = (overrides: Record<string, Answer> = {}) =>
  treeTable({
    'diff --no-index -- /dev/null deep/a/b/c.md': { exitCode: 1, stdout: 'diff --git a/deep/a/b/c.md b/deep/a/b/c.md\n@@ -0,0 +1,2 @@\n+1\n+2\n' },
    'diff --no-index -- /dev/null deep/a/b/d.md': { exitCode: 1, stdout: 'diff --git a/deep/a/b/d.md b/deep/a/b/d.md\n@@ -0,0 +1 @@\n+1\n' },
    'diff --no-index -- /dev/null src/lib/x.ts': {
      exitCode: 1,
      stdout: 'diff --git a/src/lib/x.ts b/src/lib/x.ts\n@@ -0,0 +1,4 @@\n+1\n+2\n+3\n+4\n',
    },
    ...overrides,
  })

/** The pane at `columns` and `bodyRows`, holding the keyboard unless told otherwise. */
const sidePane = (columns: number, bodyRows = 24, isFocused = true) =>
  ({ ...PANE, props: { ...PANE.props, bodyColumns: columns, isFocused, scroll: { offset: 0, bodyRows } } }) as const

type SideUi = Finder & Parameters<typeof rowKeys>[0] & Parameters<typeof screen>[0]

/** The row the cursor marks with `›`; at most one does. */
const cursorOf = async (ui: SideUi): Promise<string | undefined> => {
  const marked: string[] = []
  for (const key of await rowKeys(ui)) if ((await rowLine(ui, key, 200)).startsWith('›')) marked.push(key)
  expect(marked.length).toBeLessThanOrEqual(1)
  return marked[0]
}

/** The region whose head is accented. */
const regionOf = async (ui: Finder): Promise<string> => {
  const tree = await ui.find({ type: 'Text', text: ' tree ' } as never)
  const diff = await ui.find({ type: 'Text', text: ' diff ' } as never)
  expect([tree?.props.color, diff?.props.color].filter(color => color === 'suggestion')).toHaveLength(1)
  for (const head of [tree, diff]) if (head?.props.color !== 'suggestion') expect(head?.props.dimColor).toBe(true)
  return tree?.props.color === 'suggestion' ? 'tree' : 'diff'
}

/** A region's rows as printed in `cells`, the blank cell beside the rule left out, or undefined when it is not drawn. */
const regionLines = async (ui: Finder, region: 'tree' | 'diff', cells: number): Promise<string[] | undefined> => {
  const box = await ui.find({ key: `side:${region}` })
  if (box === undefined) return undefined
  return paint({ ...box, props: { ...box.props, paddingLeft: 0, paddingRight: 0 } }, cells).map(line => line.trimEnd())
}

/** The cells each region of the split takes at `columns`, as the layout gives them. */
const treeCells = (columns: number) => Math.min(48, Math.max(28, Math.round(columns * 0.38)))

/** The person's wheel over the pane's body at `column`, by default on a row of the regions. */
const wheelAt = ($: Engine, column: number, by: number, row = 12, bodyRows = 24) =>
  $.ui.scroll({
    component: 'Pane',
    requestId: 'worktree-diff',
    offset: 0,
    by,
    bodyRows,
    contentRows: bodyRows,
    origin: { kind: 'person' },
    pointer: { column, row },
  } as never)

describe('side view', () => {
  sideTest('the tree and the diff fill the body exactly, side by side from 80 columns, on terminal and desktop', async ($, on) => {
    world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      for (const columns of [70, 90, 120]) {
        for (const bodyRows of [12, 24, 40]) {
          for (const isFocused of [true, false]) {
            const ui = await $.ui.mount({ ...sidePane(columns, bodyRows, isFocused), surface })
            const lines = await screen(ui, columns)
            expect(lines).toHaveLength(bodyRows)
            for (const line of lines) {
              if (cellWidth(line) > columns) throw new Error(`${surface} at ${columns}: ${JSON.stringify(line)}`)
            }
            // The tree's head starts the regions, under the summary; the split draws the rule beside it.
            const head = lines.findIndex(line => line.startsWith(' tree '))
            expect(lines[head - 1]).toMatch(/^10 files {2}● 7 uncommitted/)
            const ruled = lines.slice(head).filter(line => [...line][treeCells(columns)] === '│')
            expect(ruled).toHaveLength(columns >= 80 ? bodyRows - head - (surface === 'terminal' || isFocused ? 1 : 0) : 0)
            if (columns < 80) expect(lines[head]?.trimEnd()).toBe(' tree  diff')
            else expect(lines[head]).toMatch(/^ tree +│ diff {2}deep\/a\/b\/ · 2 files +\+3$/)
            expect(await regionOf(ui)).toBe('tree')
            // The cursor starts on the first row, marked and semibold.
            expect(await cursorOf(ui)).toBe('dir:deep/a/b')
            expect(JSON.stringify((await ui.find({ key: 'dir:deep/a/b' }))?.children)).toContain('"weight":"semibold"')
            expect(await regionLines(ui, 'diff', 40)).toEqual(columns < 80 ? undefined : ['? c.md' + ' '.repeat(32) + '+2', '? d.md' + ' '.repeat(32) + '+1'])
            // Nothing to collapse: x is the inline view's.
            expect(await ui.find({ key: 'collapse' })).toBeUndefined()
            await ui.unmount()
          }
        }
      }
    }
  })

  sideTest('the pane asks for 120 columns, the inline view for none', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    expect((await wtDiff($)).text).toBe(FOCUSED_SIDE)
    expect(state.openArgs.at(-1)).toMatchObject({ id: 'worktree-diff', columns: 120, focus: true })
  })

  test('the inline view opens at the width it is given', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    expect((await wtDiff($)).text).toBe(FOCUSED)
    expect(state.openArgs.at(-1)).not.toHaveProperty('columns')
  })

  sideTest('the diff region reads the file under the cursor once it stands still, and shows a kept one while it reads it again', async ($, on) => {
    const { state, clock } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      // Each surface starts with nothing read: a switch of mode drops what was.
      await wtDiff($, 'mode committed')
      await wtDiff($, 'mode all')
      const ui = await $.ui.mount({ ...sidePane(120), surface })
      await keys(ui, 'g')
      const reads = () => state.calls.filter(call => call.startsWith('diff --no-index')).length
      const before = reads()
      // Passing over c.md to d.md reads d.md alone, once the cursor stands.
      await keys(ui, 'jj')
      expect(await cursorOf(ui)).toBe('file:deep/a/b/d.md')
      expect(await regionLines(ui, 'diff', 73)).toEqual(['loading…'])
      await clock.advance(119)
      expect(reads()).toBe(before)
      await clock.advance(1)
      expect(state.calls.slice(-1)).toEqual(['diff --no-index -- /dev/null deep/a/b/d.md'])
      const code = await ui.find({ type: 'Code' })
      expect(code?.props).toMatchObject({ format: 'source', source: '1', startLine: 1, path: 'deep/a/b/d.md' })
      expect((await screen(ui, 120)).find(line => line.includes('│ diff '))).toMatch(/│ diff {2}\? deep\/a\/b\/d\.md +\+1$/)
      // Back on c.md: read now; on d.md again: kept and shown at once, then read again.
      await keys(ui, 'k')
      await clock.advance(120)
      expect((await ui.find({ type: 'Code' }))?.props.source).toBe('1\n2')
      const read = reads()
      expect(read - before).toBe(2)
      await keys(ui, 'j')
      expect((await ui.find({ type: 'Code' }))?.props.source).toBe('1')
      await clock.advance(120)
      expect((await ui.find({ type: 'Code' }))?.props.source).toBe('1')
      expect(reads()).toBe(read + 1)
      // A modified file is drawn quiet, its path and counts in the head.
      await ui.press({ key: 'file:a.txt' })
      await clock.advance(120)
      expect(await regionLines(ui, 'diff', 73)).toEqual(['@@ 1', '  line1', '- line2', '+ LINE2', '  line3', '+ line4', '+ extra'])
      // A deleted file needs no read: its line says so.
      await ui.press({ key: 'file:gone.txt' })
      expect(await regionLines(ui, 'diff', 73)).toEqual(['deleted · 2 lines'])
      await ui.unmount()
    }
  })

  sideTest('in the tree j/k/d/b/g/e move the cursor and the window follows it', async ($, on) => {
    world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      // 5 rows of the tree show at once: 14 - 7 above - the heads - the hint.
      const ui = await $.ui.mount({ ...sidePane(120, 14), surface })
      const shown = async () => (await regionLines(ui, 'tree', 46))?.length
      await keys(ui, 'g')
      expect(await shown()).toBe(surface === 'terminal' ? 5 : 6)
      const walked: (string | undefined)[] = []
      for (let step = 0; step < TREE_KEYS.length; step++) {
        walked.push(await cursorOf(ui))
        await keys(ui, 'j')
      }
      expect(walked).toEqual(TREE_KEYS)
      // Past the end it stays; the window shows the last rows.
      expect(await cursorOf(ui)).toBe('file:untracked.md')
      expect((await regionLines(ui, 'tree', 46))?.at(-1)).toMatch(/^› \? ● untracked\.md +\+3$/)
      await keys(ui, 'k')
      expect(await cursorOf(ui)).toBe('file:keep.txt')
      await keys(ui, 'g')
      expect(await cursorOf(ui)).toBe('dir:deep/a/b')
      expect((await regionLines(ui, 'tree', 46))?.[0]).toMatch(/^› ▾ deep\/a\/b\//)
      // Half a window down and back.
      await keys(ui, 'd')
      expect(await cursorOf(ui)).toBe(TREE_KEYS[surface === 'terminal' ? 2 : 3])
      await keys(ui, 'b')
      expect(await cursorOf(ui)).toBe('dir:deep/a/b')
      await keys(ui, 'e')
      expect(await cursorOf(ui)).toBe('file:untracked.md')
      // n and p have no Button in the tree.
      expect(await ui.find({ key: 'nav:n' })).toBeUndefined()
      await keys(ui, 'g')
      await ui.unmount()
    }
  })

  sideTest('l and w go to the diff, h and w come back; on a directory h and l fold, open and move as v0.3', async ($, on) => {
    world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...sidePane(120), surface })
      await keys(ui, 'g')
      // On an open directory l goes in, h on a file goes up, h on an open directory folds it, l opens it.
      await keys(ui, 'l')
      expect(await cursorOf(ui)).toBe('file:deep/a/b/c.md')
      await keys(ui, 'h')
      expect(await cursorOf(ui)).toBe('dir:deep/a/b')
      await keys(ui, 'h')
      expect(await rowKeys(ui)).not.toContain('file:deep/a/b/c.md')
      expect(await regionOf(ui)).toBe('tree')
      await keys(ui, 'l')
      expect(await rowKeys(ui)).toContain('file:deep/a/b/c.md')
      // l on a file, or w, and the keys act on the diff; h or w come back.
      await keys(ui, 'jl')
      expect(await regionOf(ui)).toBe('diff')
      await keys(ui, 'h')
      expect(await regionOf(ui)).toBe('tree')
      await keys(ui, 'w')
      expect(await regionOf(ui)).toBe('diff')
      // In the diff j/k scroll it: the cursor stays where it is.
      await keys(ui, 'jk')
      expect(await cursorOf(ui)).toBe('file:deep/a/b/c.md')
      await keys(ui, 'w')
      expect(await regionOf(ui)).toBe('tree')
      await ui.unmount()
    }
  })

  sideTest('in the diff j/k/d/b/n/p/g/e scroll it and never past either end', async ($, on) => {
    const { clock } = world(on, { table: sideTable({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(LONG_A) }), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      // 24 rows: 15 of the diff show, of its 24.
      const ui = await $.ui.mount({ ...sidePane(120), surface })
      await ui.press({ key: 'file:keep.txt' })
      await ui.press({ key: 'file:a.txt' })
      await clock.advance(120)
      await keys(ui, 'w')
      const rows = surface === 'terminal' ? 15 : 16
      const first = async () => (await regionLines(ui, 'diff', 73))?.[0]
      expect(await first()).toBe('@@ 1  fn1()')
      expect((await regionLines(ui, 'diff', 73))?.length).toBe(rows)
      await keys(ui, 'j')
      expect(await first()).toBe('  c1')
      await keys(ui, 'k')
      expect(await first()).toBe('@@ 1  fn1()')
      await keys(ui, 'k')
      expect(await first()).toBe('@@ 1  fn1()')
      await keys(ui, 'n')
      expect(await first()).toBe('@@ 40  fn40()')
      // The last hunk is past the last full window: n stops there.
      await keys(ui, 'n')
      expect(await first()).toBe(surface === 'terminal' ? '  c1' : '@@ 40  fn40()')
      expect((await regionLines(ui, 'diff', 73))?.at(-1)).toBe('  c5')
      // From inside hunk 40 p goes to its start; from its start, to hunk 1.
      await keys(ui, 'p')
      expect(await first()).toBe(surface === 'terminal' ? '@@ 40  fn40()' : '@@ 1  fn1()')
      await keys(ui, 'p')
      expect(await first()).toBe('@@ 1  fn1()')
      // Half of 15 rows is 7, of 16 is 8.
      await keys(ui, 'd')
      expect(await first()).toBe(surface === 'terminal' ? '  c5' : '@@ 40  fn40()')
      await keys(ui, 'b')
      expect(await first()).toBe('@@ 1  fn1()')
      await keys(ui, 'e')
      expect((await regionLines(ui, 'diff', 73))?.at(-1)).toBe('  c5')
      await keys(ui, 'g')
      expect(await first()).toBe('@@ 1  fn1()')
      // Another file starts at its top.
      await keys(ui, 'e')
      await keys(ui, 'h')
      await keys(ui, 'j')
      await keys(ui, 'k')
      expect(await first()).toBe('@@ 1  fn1()')
      await ui.unmount()
    }
  })

  sideTest('diffStyle engine draws the window as hunks of its own; a file added whole as source from its first line shown', { options: { diffStyle: 'engine' } }, async ($, on) => {
    const { clock } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    // 3 rows of each region show.
    const ui = await $.ui.mount({ ...sidePane(120, 12), surface: 'terminal' })
    await keys(ui, 'ekkkk')
    expect(await cursorOf(ui)).toBe('file:a.txt')
    await clock.advance(120)
    // The header counts the lines the window keeps.
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ format: 'diff', path: 'a.txt', source: '@@ -1,2 +1,1 @@\n line1\n-line2' })
    await keys(ui, 'wjj')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -2,2 +2,2 @@\n-line2\n+LINE2\n line3')
    await keys(ui, 'hkk')
    expect(await cursorOf(ui)).toBe('file:src/lib/x.ts')
    await clock.advance(120)
    await keys(ui, 'we')
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ format: 'source', source: '2\n3\n4', startLine: 2 })
    await ui.unmount()
  })

  sideTest('below 80 columns one region shows at a time: l or w for the diff, h or w back', async ($, on) => {
    const { clock } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...sidePane(70), surface })
      await ui.press({ key: 'file:keep.txt' })
      await ui.press({ key: 'file:a.txt' })
      await clock.advance(120)
      expect(await regionLines(ui, 'diff', 70)).toBeUndefined()
      expect(await regionLines(ui, 'tree', 70)).toBeDefined()
      await keys(ui, 'l')
      expect(await regionLines(ui, 'tree', 70)).toBeUndefined()
      expect((await regionLines(ui, 'diff', 70))?.[0]).toBe('@@ 1')
      const lines = await screen(ui, 70)
      expect(lines.find(line => line.startsWith(' tree '))).toMatch(/^ tree {2}diff {2}M a\.txt +\+3 −1$/)
      expect(await regionOf(ui)).toBe('diff')
      await keys(ui, 'h')
      expect(await regionLines(ui, 'diff', 70)).toBeUndefined()
      await keys(ui, 'w')
      expect(await regionLines(ui, 'diff', 70)).toBeDefined()
      await keys(ui, 'w')
      expect(await regionOf(ui)).toBe('tree')
      await ui.unmount()
    }
  })

  sideTest('the hint row says the keys of the region they act on, each a Button of its own', async ($, on) => {
    world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...sidePane(120), surface })
      let columns = 120
      const last = async () => (await screen(ui, columns)).at(-1)?.trimEnd()
      if (surface === 'terminal') expect(await last()).toBe('j: down  k: up  l: open  w: diff  h: fold  q: close  d: page  b: back  g: top  e: end  o: worktree')
      await keys(ui, 'w')
      if (surface === 'terminal') {
        expect(await last()).toBe('j: down  k: up  d: page  b: back  n: next  p: prev  h: tree  q: close  g: top  e: end  w: tree  o: worktree')
      }
      // One row: what does not fit is cut, still pressed by its letter.
      await ui.redraw(sidePane(70).props)
      columns = 70
      if (surface === 'terminal') expect(await last()).toBe('j: down  k: up  d: page  b: back  n: next  p: prev  h: tree  q: close')
      expect(await screen(ui, 70)).toHaveLength(24)
      const hotkeys = (await ui.findAll({ type: 'Button' })).map(button => button.props.hotkey).filter(Boolean)
      expect(new Set(hotkeys).size).toBe(hotkeys.length)
      expect(hotkeys).not.toContain('x')
      for (const button of (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('nav:'))) {
        expect(button.props).toMatchObject({ plain: true, dimColor: true })
      }
      await keys(ui, 'w')
      // Without the keyboard: how to give it, on the terminal alone.
      await ui.redraw(sidePane(120, 24, false).props)
      columns = 120
      expect(await ui.find({ key: 'nav:j' })).toBeUndefined()
      expect(await screen(ui, 120)).toHaveLength(24)
      if (surface === 'terminal') expect(await last()).toBe('ctrl+x tab to focus')
      if (surface === 'terminal') expect((await ui.find({ type: 'Text', text: 'ctrl+x tab to focus' }))?.props.dimColor).toBe(true)
      else expect(await ui.find({ type: 'Text', text: 'ctrl+x tab to focus' })).toBeUndefined()
      await ui.unmount()
    }
  })

  sideTest('a row pressed takes the cursor and the keys to the tree; pressed again, a file goes to the diff, a directory folds', async ($, on) => {
    world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...sidePane(120), surface })
      await ui.press({ key: 'file:keep.txt' })
      expect(await cursorOf(ui)).toBe('file:keep.txt')
      expect(await regionOf(ui)).toBe('tree')
      await ui.press({ key: 'file:keep.txt' })
      expect(await regionOf(ui)).toBe('diff')
      await ui.press({ key: 'dir:src' })
      expect(await cursorOf(ui)).toBe('dir:src')
      expect(await regionOf(ui)).toBe('tree')
      expect(await rowKeys(ui)).toContain('dir:src/lib')
      await ui.press({ key: 'dir:src' })
      expect(await rowKeys(ui)).not.toContain('dir:src/lib')
      await ui.press({ key: 'dir:src' })
      expect(await rowKeys(ui)).toContain('dir:src/lib')
      // The ring starts on the cursor's row when the pane takes the keyboard.
      expect(await autoFocused(ui)).toBe('dir:src')
      await ui.unmount()
    }
  })

  sideTest('the wheel moves the window under the pointer and not the body; the scroll keys go to the engine', async ($, on) => {
    const { state, clock } = world(on, { table: sideTable({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(LONG_A) }), files: treeFiles })
    await wtDiff($, 'refresh')
    // 5 rows of each region show.
    const ui = await $.ui.mount({ ...sidePane(120, 14), surface: 'terminal' })
    // Over the tree: its window moves, the cursor stays where it is.
    await keys(ui, 'g')
    const treeTop = async () => (await regionLines(ui, 'tree', 46))?.[0]
    expect(await treeTop()).toMatch(/deep\/a\/b\//)
    await wheelAt($, 3, 2)
    expect(await treeTop()).toMatch(/d\.md/)
    expect(await cursorOf(ui)).toBeUndefined()
    await wheelAt($, 3, -5)
    expect(await treeTop()).toMatch(/deep\/a\/b\//)
    expect(await cursorOf(ui)).toBe('dir:deep/a/b')
    // Over the rule and past it: the diff's, whichever region the keys are in.
    await keys(ui, 'ekkkk')
    await clock.advance(120)
    expect((await regionLines(ui, 'diff', 73))?.[0]).toBe('@@ 1  fn1()')
    await wheelAt($, treeCells(120), 1)
    expect((await regionLines(ui, 'diff', 73))?.[0]).toBe('  c1')
    await wheelAt($, 100, 50)
    expect((await regionLines(ui, 'diff', 73))?.at(-1)).toBe('  c5')
    expect(await regionOf(ui)).toBe('tree')
    expect(state.scrolls).toEqual([])
    // The scroll keys carry no pointer: the engine's to move.
    await $.ui.scroll({
      component: 'Pane',
      requestId: 'worktree-diff',
      offset: 1,
      by: 1,
      bodyRows: 24,
      contentRows: 24,
      origin: { kind: 'person' },
    } as never)
    expect(state.scrolls).toHaveLength(1)
    await ui.unmount()
  })

  sideTest('a file gone after a refresh hands the cursor to the row below it; nothing listed is a notice as tall as the regions', async ($, on) => {
    const { state } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...sidePane(90), surface: 'terminal' })
    await ui.press({ key: 'file:gone.txt' })
    expect(await cursorOf(ui)).toBe('file:gone.txt')
    state.table = sideTable({
      [`diff --numstat -z -M ${MB} --`]: ok(NUMSTAT_ALL.replace('0\t2\tgone.txt\0', '')),
      [`diff --name-status -z -M ${MB} --`]: ok(NAMES_ALL.replace('D\0gone.txt\0', '')),
      [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(NAMES_ONLY_COMMITTED.replace('gone.txt\0', '')),
    })
    await wtDiff($, 'refresh')
    expect(await rowKeys(ui)).not.toContain('file:gone.txt')
    expect(await cursorOf(ui)).toBe('file:keep.txt')

    state.table = featTable({
      [`diff --numstat -z -M ${MB} --`]: ok(''),
      [`diff --name-status -z -M ${MB} --`]: ok(''),
      [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(''),
      'diff --name-only -z --no-renames HEAD --': ok(''),
      'ls-files --others --exclude-standard -z': ok(''),
    })
    await wtDiff($, 'refresh')
    const lines = await screen(ui, 90)
    expect(lines).toHaveLength(24)
    expect(lines.map(line => line.trimEnd())).toContain('✓ No changes vs main')
    expect(await ui.find({ key: 'side:tree' })).toBeUndefined()
    // The keys do nothing, and nothing throws.
    await keys(ui, 'jklhwdbgenp')
    await ui.unmount()
  })

  sideTest('z, t and a fold keep the cursor on a row that shows', async ($, on) => {
    world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...sidePane(120), surface: 'terminal' })
    await ui.press({ key: 'file:src/lib/x.ts' })
    await ui.press({ key: 'fold' })
    expect(await cursorOf(ui)).toBe('dir:src')
    await ui.press({ key: 'fold' })
    await ui.press({ key: 'file:src/lib/x.ts' })
    await ui.press({ key: 'view' })
    expect(await cursorOf(ui)).toBe('file:src/lib/x.ts')
    await ui.press({ key: 'view' })
    await ui.unmount()
  })

  sideTest('a wheel over the rows above the regions or the hint, or over a body too short to fit, is the engine’s', async ($, on) => {
    const { state } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    // 7 rows above the regions, the regions on rows 7 to 12, the hint on 13.
    const ui = await $.ui.mount({ ...sidePane(120, 14), surface: 'terminal' })
    await keys(ui, 'g')
    const treeTop = async () => (await regionLines(ui, 'tree', 46))?.[0]
    await wheelAt($, 3, 1, 6, 14)
    await wheelAt($, 3, 1, 13, 14)
    expect(state.scrolls).toHaveLength(2)
    expect(await treeTop()).toMatch(/deep\/a\/b\//)
    // The heads' row is the regions'.
    await wheelAt($, 3, 1, 7, 14)
    expect(state.scrolls).toHaveLength(2)
    expect(await treeTop()).toMatch(/c\.md/)
    // Too short for all of it: the body overflows and the engine scrolls it.
    await ui.redraw(sidePane(120, 8).props)
    await wheelAt($, 3, 1, 7, 8)
    expect(state.scrolls).toHaveLength(3)
    expect(await treeTop()).toMatch(/c\.md/)
    await ui.unmount()
  })

  sideTest('a refresh reads the cursor’s file again and drops the diffs read under an older snapshot', async ($, on) => {
    const { state, clock } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...sidePane(120), surface: 'terminal' })
    const reads = (name: string) => state.calls.filter(call => call === `diff --no-index -- /dev/null deep/a/b/${name}`).length
    await ui.press({ key: 'file:deep/a/b/c.md' })
    await clock.advance(120)
    await keys(ui, 'j')
    await clock.advance(120)
    expect([reads('c.md'), reads('d.md')]).toEqual([1, 1])
    // The same snapshot: the cursor's file is read again, the one it left kept, shown at once and read again.
    await wtDiff($, 'refresh')
    expect([reads('c.md'), reads('d.md')]).toEqual([1, 2])
    await keys(ui, 'k')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('1\n2')
    await clock.advance(120)
    expect(reads('c.md')).toBe(2)
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('1\n2')
    // A newer one: the cursor's file is read again; d.md, read under the old one, is dropped and read on the way back.
    state.table = sideTable({ [`diff --numstat -z -M ${MB} --`]: ok(NUMSTAT_ALL.replace('1\t0\tkeep.txt', '2\t0\tkeep.txt')) })
    await wtDiff($, 'refresh')
    expect([reads('c.md'), reads('d.md')]).toEqual([3, 2])
    await keys(ui, 'j')
    expect(await regionLines(ui, 'diff', 73)).toEqual(['loading…'])
    await clock.advance(120)
    expect(reads('d.md')).toBe(3)
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('1')
    await ui.unmount()
  })

  sideTest('a kept diff whose file changed but kept its line counts is read again, not shown stale', async ($, on) => {
    const { state, clock } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...sidePane(120), surface: 'terminal' })
    await ui.press({ key: 'file:deep/a/b/d.md' })
    await clock.advance(120)
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('1')
    await keys(ui, 'k')
    await clock.advance(120)
    // d.md's one line is another now: the same counts, the same snapshot, and a refresh reads only c.md.
    state.table = sideTable({
      'diff --no-index -- /dev/null deep/a/b/d.md': { exitCode: 1, stdout: 'diff --git a/deep/a/b/d.md b/deep/a/b/d.md\n@@ -0,0 +1 @@\n+one\n' },
    })
    await wtDiff($, 'refresh')
    await keys(ui, 'j')
    await clock.advance(120)
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('one')
    await ui.unmount()
  })

  sideTest('a refresh leaves the tree where the wheel took it; a cursor in view keeps its place on screen', async ($, on) => {
    const { state, clock } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    // 5 rows of the tree show.
    const ui = await $.ui.mount({ ...sidePane(120, 14), surface: 'terminal' })
    const treeTop = async () => (await regionLines(ui, 'tree', 46))?.[0]
    await keys(ui, 'g')
    await wheelAt($, 3, 2)
    expect(await treeTop()).toMatch(/d\.md/)
    // A poll with nothing changed, a refresh asked for, and one that changed what is listed.
    await clock.advance(5_000)
    expect(await treeTop()).toMatch(/d\.md/)
    await wtDiff($, 'refresh')
    expect(await treeTop()).toMatch(/d\.md/)
    state.table = sideTable({ [`diff --numstat -z -M ${MB} --`]: ok(NUMSTAT_ALL.replace('1\t0\tkeep.txt', '2\t0\tkeep.txt')) })
    await wtDiff($, 'refresh')
    expect(await treeTop()).toMatch(/d\.md/)
    expect(await cursorOf(ui)).toBeUndefined()
    // The next key brings the cursor back into view.
    await keys(ui, 'j')
    expect(await cursorOf(ui)).toBe('file:deep/a/b/c.md')
    expect(await treeTop()).toMatch(/c\.md/)
    // A row gone above a cursor in view: the cursor stays on its screen row.
    await keys(ui, 'jjj')
    expect(await cursorOf(ui)).toBe('file:dir/ubin.bin')
    const shown = (await regionLines(ui, 'tree', 46)) ?? []
    const row = shown.findIndex(line => line.startsWith('›'))
    state.table = sideTable({ 'ls-files --others --exclude-standard -z': ok(`${UNTRACKED}deep/a/b/d.md\0src/lib/x.ts\0`) })
    await wtDiff($, 'refresh')
    expect(await rowKeys(ui)).not.toContain('file:deep/a/b/c.md')
    expect(await cursorOf(ui)).toBe('file:dir/ubin.bin')
    expect(((await regionLines(ui, 'tree', 46)) ?? []).findIndex(line => line.startsWith('›'))).toBe(row)
    await ui.unmount()
  })

  sideTest('another mode starts the diff of the same file at its top', async ($, on) => {
    const { clock } = world(on, {
      table: sideTable({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(LONG_A), [`diff -M ${MB} HEAD -- :(literal)a.txt`]: ok(LONG_A) }),
      files: treeFiles,
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...sidePane(120), surface: 'terminal' })
    await ui.press({ key: 'file:keep.txt' })
    await ui.press({ key: 'file:a.txt' })
    await clock.advance(120)
    await keys(ui, 'wn')
    const first = async () => (await regionLines(ui, 'diff', 73))?.[0]
    expect(await first()).toBe('@@ 40  fn40()')
    await wtDiff($, 'mode committed')
    await clock.advance(120)
    expect(await cursorOf(ui)).toBe('file:a.txt')
    expect(await first()).toBe('@@ 1  fn1()')
    // A refresh in the same mode keeps where it is.
    await keys(ui, 'n')
    await wtDiff($, 'refresh')
    expect(await first()).toBe('@@ 40  fn40()')
    await ui.unmount()
  })

  sideTest('a cd within the worktree keeps the diff where it was: the same worktree, read from below its root', async ($, on) => {
    const { state, clock } = world(on, {
      table: sideTable({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(LONG_A) }),
      files: treeFiles,
      dirs: [REPO, ROOT, `${ROOT}/src`],
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...sidePane(120), surface: 'terminal' })
    await ui.press({ key: 'file:keep.txt' })
    await ui.press({ key: 'file:a.txt' })
    await clock.advance(120)
    await keys(ui, 'wn')
    const first = async () => (await regionLines(ui, 'diff', 73))?.[0]
    expect(await first()).toBe('@@ 40  fn40()')
    // As `cd src && bun test` leaves the session.
    state.cwd = `${ROOT}/src`
    await wtDiff($, 'refresh')
    await clock.advance(120)
    expect(await first()).toBe('@@ 40  fn40()')
    await ui.unmount()
  })

  sideTest('side by side, a blank cell sits on each side of the rule', async ($, on) => {
    const { clock } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const columns of [90, 120]) {
      const ui = await $.ui.mount({ ...sidePane(columns), surface: 'terminal' })
      await ui.press({ key: 'file:keep.txt' })
      await ui.press({ key: 'file:a.txt' })
      await clock.advance(120)
      const lines = await screen(ui, columns)
      const head = lines.findIndex(line => line.startsWith(' tree '))
      const cells = treeCells(columns)
      const ruled = lines.slice(head + 1).filter(line => [...line][cells] === '│')
      expect(ruled.length).toBeGreaterThan(5)
      for (const line of ruled) {
        expect([...line][cells - 1]).toBe(' ')
        if ([...line].length > cells + 1) expect([...line][cells + 1]).toBe(' ')
      }
      // The counts of the tree's rows and the diff's marks both a cell away.
      expect(ruled.some(line => /\+3 −1 │ - line2/.test(line) || /\+\d+ │ /.test(line))).toBe(true)
      expect(ruled.some(line => line.includes('│ + LINE2'))).toBe(true)
      await ui.unmount()
    }
  })

  test('keepRecent keeps the last 16 files read, the one just read among them', async () => {
    const diff = (signature: string) => ({ hunks: '', isBinary: false, omittedLines: 0, signature })
    const many: Record<string, ReturnType<typeof diff>> = {}
    for (let index = 0; index < 17; index++) many[`f${index}`] = diff(`s${index}`)
    const kept = keepRecent(many, 'f16')
    expect(Object.keys(kept)).toEqual(Array.from({ length: 16 }, (_, index) => `f${index + 1}`))
    // The one just read stays even when it was among the first in.
    expect(Object.keys(keepRecent(many, 'f0'))).toEqual([...Array.from({ length: 15 }, (_, index) => `f${index + 2}`), 'f0'])
    expect(keepRecent({ a: diff('1') }, 'b')).toEqual({ a: diff('1') })
  })

  sideTest('the ring sits on the cursor’s row, or on h’s Button while the diff alone shows', async ($, on) => {
    world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    const single = { kind: 'single', columns: 70, width: 70 } as const
    const split = { kind: 'split', columns: 120, tree: 46, separator: 1, diff: 73 } as const
    expect(sideRing(single, 'diff', 'file:a.txt')).toBe('nav:h')
    expect(sideRing(single, 'tree', 'file:a.txt')).toBe('file:a.txt')
    expect(sideRing(split, 'diff', 'file:a.txt')).toBe('file:a.txt')
    expect(sideRing(undefined, 'diff', null)).toBeUndefined()
    for (const columns of [70, 120]) {
      const ui = await $.ui.mount({ ...sidePane(columns), surface: 'terminal' })
      await ui.press({ key: 'file:keep.txt' })
      await ui.press({ key: 'file:a.txt' })
      expect(await autoFocused(ui)).toBe('file:a.txt')
      await keys(ui, 'l')
      expect(await autoFocused(ui)).toBe(columns < 80 ? 'nav:h' : 'file:a.txt')
      await keys(ui, 'h')
      expect(await autoFocused(ui)).toBe('file:a.txt')
      await ui.unmount()
    }
  })

  sideTest('a refresh under the o list keeps the tree’s window as drawn: the list hides the regions, not their size', async ($, on) => {
    const { state } = world(on, { table: sideTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    // 5 rows of the tree show; the cursor on the last.
    const ui = await $.ui.mount({ ...sidePane(120, 14), surface: 'terminal' })
    const treeTop = async () => (await regionLines(ui, 'tree', 46))?.[0]
    await keys(ui, 'e')
    const top = await treeTop()
    expect(top).toBeDefined()
    for (const back of ['h', 'o'] as const) {
      await keys(ui, 'o')
      expect(await regionLines(ui, 'tree', 46)).toBeUndefined()
      state.table = sideTable({ [`diff --numstat -z -M ${MB} --`]: ok(NUMSTAT_ALL.replace('1\t0\tkeep.txt', `${back === 'h' ? 2 : 3}\t0\tkeep.txt`)) })
      await wtDiff($, 'refresh')
      await keys(ui, back)
      expect(await treeTop()).toBe(top)
    }
    await ui.unmount()
  })

  test('keptCursor stays, gives way below then above, goes to what hides it, else to the first row', async () => {
    const row = (key: string, depth = 0): NavRow => ({
      key,
      kind: key.startsWith('dir:') ? 'dir' : 'file',
      path: key.slice(key.indexOf(':') + 1),
      depth,
    })
    const all = [row('dir:src'), row('dir:src/lib', 1), row('file:src/lib/x.ts', 2), row('file:src/y.ts', 1), row('file:z.ts')]
    expect(keptCursor(all, all, 'file:src/y.ts')).toBe('file:src/y.ts')
    expect(keptCursor(all, all, null)).toBe('dir:src')
    expect(keptCursor([], [], 'file:z.ts')).toBe('file:z.ts')
    // Gone: the row below it, or above at the end.
    expect(keptCursor(all, all.filter(one => one.key !== 'file:src/y.ts'), 'file:src/y.ts')).toBe('file:z.ts')
    expect(keptCursor(all, all.slice(0, 4), 'file:z.ts')).toBe('file:src/y.ts')
    // Hidden by a fold: the directory that hides it, the nearest.
    expect(keptCursor([], all.slice(0, 2).concat(all.slice(3)), 'file:src/lib/x.ts')).toBe('dir:src/lib')
    expect(keptCursor([], [all[0] as NavRow, all[4] as NavRow], 'file:src/lib/x.ts')).toBe('dir:src')
    expect(keptCursor([], [all[4] as NavRow], 'file:src/lib/x.ts')).toBe('file:z.ts')
  })
})

// ---------------------------------------------------------------- follow

// The session sits in the main checkout; Claude works in the feat worktree (ROOT) or a sibling (WT2).
const WT2 = '/w/t1-wt2'
const OTHER = '/x/other'
const HOME = '/home/me'
const DIRS_KEY = 'rev-parse --path-format=absolute --git-dir --git-common-dir'

const mainAnswers: Record<string, Answer> = {
  'rev-parse --show-toplevel': ok(`${REPO}\n`),
  [DIRS_KEY]: ok(`${REPO}/.git\n${REPO}/.git\n`),
  'symbolic-ref --short -q HEAD': ok('main\n'),
  'rev-parse --verify --quiet --short HEAD': ok('1dfc5da\n'),
}
const wt2Answers: Record<string, Answer> = {
  'rev-parse --show-toplevel': ok(`${WT2}\n`),
  [DIRS_KEY]: ok(`${REPO}/.git/worktrees/t1-wt2\n${REPO}/.git\n`),
  'symbolic-ref --short -q HEAD': ok('fromhead\n'),
  'reflog show --format=%gs refs/heads/fromhead': ok('branch: Created from HEAD\n'),
  'rev-parse --abbrev-ref fromhead@{upstream}': fail(128, "fatal: no upstream configured for branch 'fromhead'\n"),
}

/** The main checkout's session, its sibling worktrees, another repository and a home that is none. */
const followWorld = (on: On, given: World = {}) => {
  mock.env(on, { HOME })
  return world(on, {
    cwd: REPO,
    dirs: [REPO, ROOT, WT2, OTHER, `${HOME}/.claude`],
    ...given,
    byCwd: {
      [REPO]: mainAnswers,
      [WT2]: wt2Answers,
      [OTHER]: { 'rev-parse --show-toplevel': ok(`${OTHER}\n`), [DIRS_KEY]: ok(`${OTHER}/.git\n${OTHER}/.git\n`) },
      [`${HOME}/.claude`]: { 'rev-parse --show-toplevel': NOT_A_REPO },
      ...given.byCwd,
    },
  })
}

/** A tool call's follow, then the refresh it schedules, landed. */
const landed = async (clock: { settle: () => Promise<unknown>; advance: (ms: number) => Promise<unknown> }) => {
  await clock.settle()
  await clock.advance(300)
  await clock.settle()
}

/** The first line `/wt-diff status` answers: `⌂ <root> · auto|pinned` when the pane shows another worktree. */
const shown = async ($: Engine) => ((await wtDiff($, 'status')).text ?? '').split('\n')[0]

const editIn = ($: Engine, path: string, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId !== undefined ? { agentId } : {}) })

describe('follow', () => {
  test('an Edit by absolute path in another worktree moves the pane there, ⌂ above the branch, on terminal and desktop', async ($, on) => {
    const { clock } = followWorld(on)
    expect(await shown($)).toMatch(/^main/)
    await editIn($, `${ROOT}/src/new.ts`)
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const lines = await screen(ui, 60)
      expect(lines[0]?.trimEnd()).toBe('⌂ t1-wt · auto')
      expect(lines[1]).toMatch(/^feat/)
      expect((await ui.find({ type: 'Text', text: '⌂ t1-wt · auto' }))?.props.dimColor).toBe(true)
      for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(60)
      await ui.unmount()
    }
    // Narrow, the name is cut, never the line past the pane.
    await editIn($, `${WT2}/x`)
    await landed(clock)
    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 16 } })
    expect((await screen(narrow, 16))[0]?.trimEnd()).toBe('⌂ t1-wt2 · auto')
    await narrow.unmount()
  })

  sideTest('the side view grows its top by the ⌂ row and still fills the body exactly', async ($, on) => {
    const { clock } = followWorld(on, { table: sideTable(), files: treeFiles })
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    for (const surface of SURFACES) {
      for (const columns of [70, 120]) {
        for (const bodyRows of [12, 24]) {
          const ui = await $.ui.mount({ ...sidePane(columns, bodyRows), surface })
          const lines = await screen(ui, columns)
          expect(lines).toHaveLength(bodyRows)
          expect(lines[0]?.trimEnd()).toBe('⌂ t1-wt · auto')
          expect(lines[1]).toMatch(/^feat/)
          for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(columns)
          await ui.unmount()
        }
      }
    }
  })

  test('a Bash cd chain moves it too, a relative one from the session; a subagent’s call counts', async ($, on) => {
    const { clock } = followWorld(on)
    await $.tool.call({ tool: 'Bash', command: 'cd ../t1-wt2 && npm test', agentId: 'a1' })
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${WT2} · auto`)
    await $.tool.call({ tool: 'Bash', command: `cd ${ROOT}; git status` })
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    // Not at the start, or not to be read for sure: nothing moves.
    for (const command of ['npm test && cd ../t1-wt2', 'cd $WT && ls', `cd ${WT2} | cat`]) {
      await $.tool.call({ tool: 'Bash', command })
      await landed(clock)
      expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    }
  })

  test('work outside the session’s repository, a call that failed or was denied, or a Read moves nothing', async ($, on) => {
    // Beneath the plugin, ahead of the world's answer.
    on('tool.call', { tool: 'Write' }, (_, e, next) => (String(e.file_path).includes('denied') ? { deny: 'no' } : next(e)))
    on('tool.call', { tool: 'NotebookEdit' }, () => ({ result: {}, isError: true }))
    const { clock } = followWorld(on)
    await editIn($, `${HOME}/.claude/projects/memory/notes.md`)
    await editIn($, `${OTHER}/src/a.ts`)
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/denied.txt`, content: 'x' })
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/n.ipynb`, new_source: 'x' } as never)
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.txt` })
    await landed(clock)
    expect(await shown($)).toMatch(/^main/)

    // A MultiEdit that ran moves it; back in the session's own worktree it shows that again.
    await $.tool.call({ tool: 'MultiEdit', file_path: `${ROOT}/a.txt`, edits: [] } as never)
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    await editIn($, `${REPO}/README.md`)
    await landed(clock)
    expect(await shown($)).toMatch(/^main/)
  })

  test('a NotebookEdit that ran moves it by its notebook_path', async ($, on) => {
    const { clock } = followWorld(on)
    await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${WT2}/n.ipynb`, new_source: 'x' } as never)
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${WT2} · auto`)
  })

  test('a failed Bash follows its cd where the directory stands: the cd ran, a later command failed', async ($, on) => {
    // As core says it: the command's output, then its exit code.
    const failed = { result: 'Exit code 1\nFAIL a.test.ts', text: 'Exit code 1\nFAIL a.test.ts', isError: true as const }
    // Refused beneath the plugin (a hook, a rule, the person at the prompt): errored with the reason alone, nothing ran.
    const refused = { result: 'Error: The user rejected this call', text: 'The user rejected this call', isError: true as const }
    on('tool.call', { tool: 'Bash' }, (_, e) => {
      const command = String(e.command)
      return command.includes('deny') ? { deny: 'no' } : command.includes('rm -rf') ? refused : failed
    })
    const { clock } = followWorld(on)
    await $.tool.call({ tool: 'Bash', command: `cd ${WT2} && rm -rf dist` })
    await landed(clock)
    expect(await shown($)).toMatch(/^main/)
    // A directory that is not there: the cd itself failed, nothing above it is taken.
    await $.tool.call({ tool: 'Bash', command: `cd ${WT2}/gone && npm test` })
    await landed(clock)
    expect(await shown($)).toMatch(/^main/)
    await $.tool.call({ tool: 'Bash', command: `cd ${WT2} && deny` })
    await landed(clock)
    expect(await shown($)).toMatch(/^main/)
    await $.tool.call({ tool: 'Bash', command: `cd ${WT2} && npm test` })
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${WT2} · auto`)
  })

  test('a relative cd reads from where the call started, though the session moved meanwhile', async ($, on) => {
    // As a foreground cd would, beneath the plugin: the session's directory is elsewhere once the call is done.
    let move = () => {}
    on('tool.call', { tool: 'Bash' }, () => {
      move()
      return { result: {} }
    })
    const { state, clock } = followWorld(on, { byCwd: { [HOME]: { 'rev-parse --show-toplevel': NOT_A_REPO } } })
    move = () => {
      state.cwd = HOME
    }
    await $.tool.call({ tool: 'Bash', command: 'cd ../t1-wt2 && make' })
    await landed(clock)
    expect(state.cwd).toBe(HOME)
    expect(await shown($)).toBe(`⌂ ${WT2} · auto`)
  })

  test('a git that fails on the session’s repository follows nothing: it may be another one', async ($, on) => {
    // A directory of its own: what an earlier read of the repository's kept does not answer for it.
    const sub = `${REPO}/fails`
    const timedOut = fail(1, 'error: timed out\n')
    const { state, clock } = followWorld(on, { cwd: sub, dirs: [sub, REPO, ROOT, OTHER] })
    state.byCwd[sub] = { 'rev-parse --show-toplevel': timedOut }
    await editIn($, `${OTHER}/src/a.ts`)
    await landed(clock)
    expect(await shown($)).not.toMatch(/^⌂/)
    // Its common dir unread too.
    state.byCwd[sub] = { 'rev-parse --show-toplevel': ok(`${REPO}\n`) }
    state.byCwd[REPO] = { ...mainAnswers, [DIRS_KEY]: timedOut }
    await editIn($, `${OTHER}/src/a.ts`)
    await landed(clock)
    expect(await shown($)).not.toMatch(/^⌂/)
    // Answered, the filter holds: another repository is not followed, a sibling is.
    state.byCwd[REPO] = mainAnswers
    await editIn($, `${OTHER}/src/a.ts`)
    await landed(clock)
    expect(await shown($)).toMatch(/^main/)
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
  })

  test('outside any repository the session follows any worktree', async ($, on) => {
    const { clock } = followWorld(on, { cwd: HOME, dirs: [HOME, ROOT, OTHER], byCwd: { [HOME]: { 'rev-parse --show-toplevel': NOT_A_REPO } } })
    expect(await shown($)).toBe(`Not a git repository: ${HOME}`)
    await editIn($, `${OTHER}/a.ts`)
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${OTHER} · auto`)
  })

  test('/wt-diff at pins a worktree over what Claude follows; at alone follows again', async ($, on) => {
    const { state, clock } = followWorld(on)
    state.dirs.add(`${WT2}/src`)
    state.byCwd[`${WT2}/src`] = { 'rev-parse --show-toplevel': ok(`${WT2}\n`) }
    expect((await wtDiff($, 'at ../t1-wt2')).text).toBe('Showing t1-wt2 (pinned)')
    expect(await shown($)).toBe(`⌂ ${WT2} · pinned`)
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${WT2} · pinned`)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('⌂ t1-wt2 · pinned')
    await ui.unmount()

    expect((await wtDiff($, 'at')).text).toBe('Unpinned: following the worktree Claude works in.')
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    expect((await wtDiff($, `at "${WT2}/src"`)).text).toBe('Showing t1-wt2 (pinned)')
    expect((await wtDiff($, 'at /nope')).text).toBe('Not a git worktree: /nope')
    expect((await wtDiff($, 'at ~bob/x')).text).toBe('Not a path: ~bob/x')
    expect(await shown($)).toBe(`⌂ ${WT2} · pinned`)
    expect(USAGE).toContain('/wt-diff at <path>')
  })

  test('status, base and trunk act on the worktree shown', async ($, on) => {
    const { clock } = followWorld(on)
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    const status = ((await wtDiff($, 'status')).text ?? '').split('\n')
    expect(status.slice(0, 2)).toEqual([`⌂ ${ROOT} · auto`, 'feat → main   reflog · 73481c5'])
    expect((await wtDiff($, 'base main')).text).toBe(`Base set to main for ${ROOT}.`)
    expect(((await wtDiff($, 'status')).text ?? '').split('\n')[1]).toBe('feat → main   override · 73481c5')
  })

  test('a worktree removed gives way to the next in line and says so until the next move', async ($, on) => {
    const { state, clock } = followWorld(on)
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    await wtDiff($, `at ${WT2}`)
    // A git that only failed keeps it.
    state.byCwd[WT2] = { ...wt2Answers, 'rev-parse --show-toplevel': fail(1, 'error: timed out\n') }
    expect(await shown($)).toBe(`⌂ ${WT2} · pinned`)

    state.dirs.delete(WT2)
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('worktree removed — back to t1-wt')
    expect((await ui.find({ type: 'Text', text: 'worktree removed — back to t1-wt' }))?.props.color).toBe('warning')

    // No longer a worktree, though its directory stands: the session's own shows.
    state.byCwd[ROOT] = { 'rev-parse --show-toplevel': NOT_A_REPO }
    expect(await shown($)).toMatch(/^main/)
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('worktree removed — back to t1-repo')

    // The next move clears it.
    state.dirs.add(WT2)
    state.byCwd[WT2] = wt2Answers
    await editIn($, `${WT2}/a.txt`)
    await landed(clock)
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('⌂ t1-wt2 · auto')
    await ui.unmount()
  })

  test('a worktree inside the main checkout, removed while its directory comes back, gives way too', async ($, on) => {
    // .claude/worktrees/x2 removed, a dev server writing its build dir again: git answers for the main checkout there.
    const nested = `${REPO}/.claude/worktrees/x2`
    const { state, clock } = followWorld(on, {
      dirs: [REPO, nested, WT2],
      byCwd: { [nested]: { ...wt2Answers, 'rev-parse --show-toplevel': ok(`${nested}\n`) } },
    })
    await editIn($, `${nested}/a.txt`)
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${nested} · auto`)
    state.byCwd[nested] = { 'rev-parse --show-toplevel': ok(`${REPO}\n`) }
    expect(await shown($)).toMatch(/^main/)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('worktree removed — back to t1-repo')

    // Pinned, the same.
    state.byCwd[nested] = { ...wt2Answers, 'rev-parse --show-toplevel': ok(`${nested}\n`) }
    expect((await wtDiff($, `at ${nested}`)).text).toBe('Showing x2 (pinned)')
    state.byCwd[nested] = { 'rev-parse --show-toplevel': ok(`${REPO}\n`) }
    expect(await shown($)).toMatch(/^main/)
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('worktree removed — back to t1-repo')
    await ui.unmount()
  })

  test('cd to the main checkout to remove the worktree followed says it was removed', async ($, on) => {
    const nested = `${REPO}/.claude/worktrees/x2`
    const { state, clock } = followWorld(on, { dirs: [REPO, ROOT, WT2, nested] })
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    state.dirs.delete(ROOT)
    await $.tool.call({ tool: 'Bash', command: `cd ${REPO} && git worktree remove ${ROOT}` })
    await landed(clock)
    expect(await shown($)).toMatch(/^main/)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('worktree removed — back to t1-repo')

    // Its directory left behind inside the main checkout: gone as well.
    state.byCwd[nested] = { ...wt2Answers, 'rev-parse --show-toplevel': ok(`${nested}\n`) }
    await editIn($, `${nested}/a.txt`)
    await landed(clock)
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('⌂ x2 · auto')
    state.byCwd[nested] = { 'rev-parse --show-toplevel': ok(`${REPO}\n`) }
    await $.tool.call({ tool: 'Bash', command: `cd ${REPO} && git worktree remove --force .claude/worktrees/x2` })
    await landed(clock)
    expect((await screen(ui, 60))[0]?.trimEnd()).toBe('worktree removed — back to t1-repo')

    // A worktree that stands is left without a word: back in the session's own.
    await editIn($, `${WT2}/a.txt`)
    await landed(clock)
    await $.tool.call({ tool: 'Bash', command: `cd ${REPO} && git status` })
    await landed(clock)
    expect((await screen(ui, 60))[0]).toMatch(/^main/)
    await ui.unmount()
  })

  test('EnterWorktree clears what was followed: the session’s new worktree shows', async ($, on) => {
    const { state, clock } = followWorld(on)
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    state.enter.cwd = WT2
    await $.tool.call({ tool: 'EnterWorktree', name: 'wt2' } as never)
    await landed(clock)
    expect(await shown($)).toMatch(/^fromhead/)
  })
})

describe('worktree list', () => {
  const pickKeys = async (ui: { findAll: (query: { type: string }) => Promise<{ key?: string }[]> }) =>
    (await ui.findAll({ type: 'Button' })).map(button => button.key ?? '').filter(key => key.startsWith('pick:'))
  const navButtons = async (ui: { findAll: (query: { type: string }) => Promise<{ key?: string; props: Record<string, unknown> }[]> }) =>
    (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('nav:')).map(button => [button.props.hotkey, button.props.label])

  for (const diffView of ['side', 'inline'] as const) {
    kitTest(`o lists auto and every worktree; j/k move, l picks, h and o go back, a click picks (${diffView})`, { options: { diffView } }, async ($, on) => {
      followWorld(on, { cwd: ROOT })
      await wtDiff($, 'refresh')
      for (const surface of SURFACES) {
        const pane = diffView === 'side' ? sidePane(90) : FOCUSED_PANE
        const ui = await $.ui.mount({ ...pane, surface })
        await keys(ui, 'o')
        expect(await pickKeys(ui)).toEqual(['pick:auto', `pick:${REPO}`, `pick:${ROOT}`])
        expect(await navButtons(ui)).toEqual([
          ['j', 'down'],
          ['k', 'up'],
          ['l', 'select'],
          ['h', 'back'],
          ['o', 'back'],
          ['q', 'close'],
        ])
        const hotkeys = (await ui.findAll({ type: 'Button' })).map(button => button.props.hotkey).filter(Boolean)
        expect(new Set(hotkeys).size).toBe(hotkeys.length)
        expect(await autoFocused(ui)).toBe('pick:auto')
        expect(await rowLine(ui, 'pick:auto', 90)).toMatch(/^› ✓ auto {2}follow Claude/)
        expect(await rowLine(ui, `pick:${REPO}`, 90)).toBe(`    t1-repo  main  ${REPO}`)
        // Unpinned, the worktree on show is dotted.
        expect(await rowLine(ui, `pick:${ROOT}`, 90)).toMatch(/^ {2}• t1-wt {2}feat/)
        if (diffView === 'side') expect(await screen(ui, 90)).toHaveLength(24)

        // j and l: the main checkout, pinned.
        await keys(ui, 'jl')
        expect(await pickKeys(ui)).toEqual([])
        expect(await shown($)).toBe(`⌂ ${REPO} · pinned`)
        expect((await screen(ui, 90))[0]?.trimEnd()).toBe('⌂ t1-repo · pinned')
        // Again: the cursor and the tick on the pin; h goes back with nothing changed.
        await keys(ui, 'o')
        expect(await rowLine(ui, `pick:${REPO}`, 90)).toMatch(/^› ✓ t1-repo/)
        expect(await rowLine(ui, 'pick:auto', 90)).toMatch(/^ {4}auto/)
        expect(await rowLine(ui, `pick:${ROOT}`, 90)).toMatch(/^ {4}t1-wt/)
        await keys(ui, 'jjjh')
        expect(await pickKeys(ui)).toEqual([])
        expect(await shown($)).toBe(`⌂ ${REPO} · pinned`)
        // o goes back too; a click on auto follows again.
        await keys(ui, 'oo')
        expect(await pickKeys(ui)).toEqual([])
        await keys(ui, 'o')
        await ui.press({ key: 'pick:auto' })
        expect(await pickKeys(ui)).toEqual([])
        expect(await shown($)).toMatch(/^feat/)
        // The keys are the view's own again.
        expect((await navButtons(ui)).map(([hotkey]) => hotkey)).toContain('o')
        expect((await navButtons(ui)).map(([hotkey]) => hotkey)).toContain('g')
        await ui.unmount()
      }
    })
  }

  test('o says the detached worktree by its short sha; a click on a worktree pins it', async ($, on) => {
    followWorld(on, {
      cwd: ROOT,
      table: featTable({
        'worktree list --porcelain': ok(`${PORCELAIN_FEAT}worktree ${WT2}\nHEAD e47b652208a1df9b8a3cbff954e65fc4b24fd4db\ndetached\n\n`),
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...FOCUSED_PANE, surface: 'terminal' })
    await keys(ui, 'o')
    expect(await rowLine(ui, `pick:${WT2}`)).toBe(`    t1-wt2  e47b652  ${WT2}`)
    await ui.press({ key: `pick:${WT2}` })
    expect(await shown($)).toBe(`⌂ ${WT2} · pinned`)
    await ui.unmount()
  })

  test('o leaves out a worktree deleted without git worktree remove', async ($, on) => {
    followWorld(on, {
      cwd: ROOT,
      table: featTable({
        'worktree list --porcelain': ok(
          `${PORCELAIN_FEAT}worktree ${WT2}\nHEAD e47b652208a1df9b8a3cbff954e65fc4b24fd4db\nbranch refs/heads/fromhead\nprunable gitdir file points to non-existent location\n\n`,
        ),
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...FOCUSED_PANE, surface: 'terminal' })
    await keys(ui, 'o')
    expect(await pickKeys(ui)).toEqual(['pick:auto', `pick:${REPO}`, `pick:${ROOT}`])
    await ui.unmount()
  })
})

describe('auto-open on follow', () => {
  test('the first linked worktree followed opens the pane, where panes dock, without the keyboard', async ($, on) => {
    const { state, clock } = followWorld(on, { isOpen: false })
    await drawHint($, true)
    await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(0)
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    expect(state.opened).toBe(1)
    expect(state.openArgs.at(-1)).not.toHaveProperty('focus')
    // Once: closed by the plugin's own hand it stays closed on the next.
    state.isOpen = false
    await editIn($, `${WT2}/a.txt`)
    await landed(clock)
    expect(state.opened).toBe(1)
  })

  test('a pane the person closed is not opened for a follow', async ($, on) => {
    const { state, clock } = followWorld(on, { isOpen: true })
    await drawHint($, true)
    // The kit raises no ui.close of the person's: /wt-diff close is theirs too.
    expect((await wtDiff($, 'close')).text).toBe('Changes pane closed.')
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    expect(state.opened).toBe(0)
  })

  test('q counts as the person closing it', async ($, on) => {
    const { state, clock } = followWorld(on, { table: treeTable(), files: treeFiles })
    await drawHint($, true)
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...FOCUSED_PANE, surface: 'terminal' })
    await keys(ui, 'q')
    await ui.unmount()
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    expect(state.opened).toBe(0)
  })

  test('a session no one watches arms no open, and a closed pane reads no git on later triggers', async ($, on) => {
    const { state, clock } = followWorld(on, { isOpen: false })
    await drawHint($, true)
    await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: false })
    await clock.settle()
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    expect(state.opened).toBe(0)
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    const before = state.calls.length
    await $.turn.complete({ reason: 'answer', text: '' } as never)
    await clock.advance(300)
    await clock.settle()
    expect(state.calls.length).toBe(before)
  })

  test('a follow while a pass reads the last worktree opens the pane once the next pass reads this one', { options: { statusLine: true } }, async ($, on) => {
    const { state, clock } = followWorld(on, { isOpen: false })
    await drawHint($, true)
    await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
    await clock.settle()
    // A pass of the main checkout's, held at its first git call.
    const held = gate()
    let isHeld = false
    state.hold = held.promise
    state.onHold = () => {
      isHeld = true
    }
    await $.turn.complete({ reason: 'answer', text: '' } as never)
    await clock.advance(300)
    await clock.settle()
    expect(isHeld).toBe(true)
    state.hold = undefined
    // Followed meanwhile; the pass ends with the main checkout's snapshot before the follow's own refresh is due.
    await editIn($, `${ROOT}/a.txt`)
    await clock.settle()
    expect(state.opened).toBe(0)
    held.open()
    await landed(clock)
    expect(await shown($)).toBe(`⌂ ${ROOT} · auto`)
    expect(state.opened).toBe(1)
  })

  test('never opens nothing on a follow', { options: { autoOpen: 'never' } }, async ($, on) => {
    const { state, clock } = followWorld(on, { isOpen: false })
    await drawHint($, true)
    await editIn($, `${ROOT}/a.txt`)
    await landed(clock)
    expect(state.opened).toBe(0)
  })
})
