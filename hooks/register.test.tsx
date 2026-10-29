import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cellWidth, fitHeader, fitPath, oneLine, printable, readConfig, statusLineText, USAGE } from './register'
import type { RunResult } from './git'

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

const PREFIX = ['git', '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false', '--no-optional-locks']

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
    opened: 0,
    openArgs: [] as unknown[],
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
    const answer = state.table[key] ?? fail(128, `fatal: unmocked: ${key}\n`)

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
    const text = state.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    const isLink = given.links?.includes(e.path) ?? false
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink } }
  })
  on('session.cwd', () => ({ value: state.cwd }))
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
              isFocused: false,
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
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    state.isOpen = false
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
  // The engine's own hint line, which tells the mod how the screen is laid out.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
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

  test('fitHeader keeps the base whole and cuts the branch in the middle', async () => {
    expect(fitHeader('feat', 'main', 40)).toBe('feat → main')
    const fitted = fitHeader('worktree-fuzzy-dancing-penguin', 'main', 28)
    expect(fitted).toMatch(/^worktree.*….*penguin → main$/)
    expect(cellWidth(fitted)).toBeLessThanOrEqual(28)
    const both = fitHeader('feat/HAR-123-login-form', 'origin/release/2026-10-long-name', 30)
    expect(both).toMatch(/ → /)
    expect(cellWidth(both)).toBeLessThanOrEqual(30)
  })

  test('readConfig fills defaults and refuses odd values', async () => {
    expect(readConfig({})).toEqual({ autoOpen: 'worktree', pollSeconds: 5, statusLine: false })
    expect(readConfig({ autoOpen: 'never', pollSeconds: 0, statusLine: true })).toEqual({
      autoOpen: 'never',
      pollSeconds: 0,
      statusLine: true,
    })
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
      expect((await ui.find({ type: 'Text', text: /feat → main/ }))?.text).toBe('feat → main')
      expect(await ui.find({ type: 'Text', text: /reflog · 73481c5/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /↑1 ↓1/ }))?.text).toBe('↑1 ↓1 · 7 files · ')
      expect((await ui.find({ type: 'Text', text: /^\+8$/ }))?.text).toBe('+8')
      expect((await ui.find({ type: 'Text', text: /^−3$/ }))?.text).toBe('−3')

      const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key)
      expect(keys).toEqual([
        'mode:all',
        'mode:committed',
        'mode:uncommitted',
        'refresh',
        'view',
        'file:a.txt',
        'file:bin.dat',
        'file:dir/ubin.bin',
        'file:gone.txt',
        'file:keep.txt',
        'file:src/new näme.txt',
        'file:untracked.md',
      ])
      expect((await ui.find({ key: 'mode:all' }))?.props.variant).toBe('primary')
      expect((await ui.find({ key: 'mode:committed' }))?.props.variant).toBeUndefined()
      // Plain, so the terminal draws each hotkey beside its label.
      for (const key of ['mode:all', 'mode:committed', 'mode:uncommitted', 'refresh']) {
        expect((await ui.find({ key }))?.props).toMatchObject({ plain: true })
      }
      expect((await ui.find({ key: 'mode:committed' }))?.props.hotkey).toBe('c')
      // Named for what a press does: back to the tree.
      expect((await ui.find({ key: 'view' }))?.props).toMatchObject({ label: 'tree', hotkey: 't', plain: true })

      const row = (await ui.find({ key: 'file:a.txt' }))?.text ?? ''
      expect(row).toMatch(/^M ● a\.txt +\+3 −1$/)
      if (surface === 'terminal') expect(row.length).toBe(60)
      expect((await ui.find({ key: 'file:bin.dat' }))?.text).toMatch(/^A {3}bin\.dat +bin$/)
      expect((await ui.find({ key: 'file:gone.txt' }))?.text).toMatch(/^D {3}gone\.txt +−2$/)
      expect((await ui.find({ key: 'file:src/new näme.txt' }))?.text).toMatch(
        /^R {3}src\/old name\.txt → src\/new näme\.txt +\+1$/,
      )
      expect((await ui.find({ key: 'file:untracked.md' }))?.text).toMatch(/^\? ● untracked\.md +\+3$/)
      await ui.unmount()
    }
  })

  test('a narrow pane cuts long paths in the middle', async ($, on) => {
    world(on, { store: { view: 'list' } })
    await wtDiff($, 'refresh')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 24 } })
    const row = (await ui.find({ key: 'file:src/new näme.txt' }))?.text ?? ''
    expect(row.length).toBeLessThanOrEqual(24)
    expect(row).toContain('…')
    expect(row).toContain('→')
    await ui.unmount()
  })

  test('pressing a file row loads its diff; pressing again folds it', async ($, on) => {
    const { state } = world(on)
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()

      await ui.press({ key: 'file:a.txt' })
      const code = await ui.find({ type: 'Code' })
      expect(code?.props).toMatchObject({ format: 'diff', source: HUNKS_A_ALL, path: 'a.txt', wrap: 'truncate-end' })
      expect(state.calls).toContain(`diff -M ${MB} -- :(literal)a.txt`)
      expect(await ui.find({ key: 'collapse' })).toBeDefined()

      await ui.press({ key: 'file:bin.dat' })
      expect((await ui.find({ type: 'Text', text: 'Binary file' }))?.text).toBe('Binary file')

      await ui.press({ key: 'collapse' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Binary file' })).toBeUndefined()

      await ui.press({ key: 'file:a.txt' })
      await ui.press({ key: 'file:a.txt' })
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
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
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toMatch(/^@@ -0,0 \+1,399 @@/)
    await ui.unmount()
  })

  test('switching mode lists that mode and reloads open diffs', async ($, on) => {
    const { state } = world(on, { store: { view: 'list' } })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'file:a.txt' })

      await ui.press({ key: 'mode:committed' })
      expect((await ui.find({ key: 'mode:committed' }))?.props.variant).toBe('primary')
      expect(await ui.find({ key: 'file:keep.txt' })).toBeUndefined()
      expect(await ui.find({ key: 'file:untracked.md' })).toBeUndefined()
      // No layer marks outside `all`.
      expect((await ui.find({ key: 'file:a.txt' }))?.text).toMatch(/^M a\.txt +\+2 −1$/)
      expect(state.calls).toContain(`diff -M ${MB} HEAD -- :(literal)a.txt`)
      expect(String((await ui.find({ type: 'Code' }))?.props.source)).toMatch(/^@@ -1,3 \+1,4 @@/)

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
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
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
      expect((await ui.find({ type: 'Text', text: /No base branch found/ }))?.text).toMatch(/\/wt-diff base <ref>/)
      expect(await ui.find({ key: 'mode:uncommitted' })).toBeDefined()
      await ui.unmount()
    }

    // The feat worktree with nothing changed.
    state.cwd = ROOT
    state.table = featTable({
      [`diff --numstat -z -M ${MB} --`]: ok(''),
      [`diff --name-status -z -M ${MB} --`]: ok(''),
      [`diff --name-only -z --no-renames ${MB} HEAD --`]: ok(''),
      'diff --name-only -z --no-renames HEAD --': ok(''),
      'ls-files --others --exclude-standard -z': ok(''),
      'rev-list --left-right --count main...HEAD': ok('1\t0\n'),
    })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /No changes/ }))?.text).toBe('No changes vs main')
      await ui.unmount()
    }
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
      expect((await ui.find({ key: `file:${odd}` }))?.text).toMatch(/^\? ● e\uFFFDsc\.txt +\+1$/)

      await ui.press({ key: 'file:a.txt' })
      const source = String((await ui.find({ type: 'Code' }))?.props.source)
      expect(source).toContain('+LINE2\uFFFD[31m')
      expect(source).toContain('\n+\uFFFD')

      await ui.press({ key: `file:${odd}` })
      const codes = await ui.findAll({ type: 'Code' })
      expect(codes.length).toBe(2)
      expect(String(codes[1]?.props.source)).toBe('@@ -0,0 +1 @@\n+\uFFFD[1mbold')
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
      const row = (await ui.find({ key: `file:${wide}` }))?.text ?? ''
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
      expect(await ui.find({ type: 'Text', text: /no base/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /files · $/ }))?.text).toBe('2 files · ')
      expect((await ui.find({ type: 'Text', text: /^\+2$/ }))?.text).toBe('+2')
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
        [`diff -M ${MB} -- :(literal)gone.txt`]: big('gone.txt'),
        [`diff -M ${MB} -- :(literal)keep.txt`]: big('keep.txt'),
      }),
    })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 1000 } })
    for (const key of ['file:a.txt', 'file:gone.txt', 'file:keep.txt']) await ui.press({ key })

    expect((await ui.findAll({ type: 'Code' })).map(code => code.props.path)).toEqual(['a.txt', 'gone.txt'])
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

  test('a refresh the person asked for shows … in the header until it lands', async ($, on) => {
    const { state } = world(on)
    await wtDiff($, 'refresh')
    const held = gate()
    const reached = gate()
    state.hold = held.promise
    state.onHold = reached.open
    const pending = wtDiff($, 'refresh')
    await reached.promise

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: ' …' }))?.text).toBe(' …')
    state.hold = undefined
    held.open()
    await pending
    expect(await ui.find({ type: 'Text', text: ' …' })).toBeUndefined()
    await ui.unmount()
  })

  test('a reload clears a … that the cut-short pass left behind', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: ' …' })).toBeUndefined()
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
    expect((await ui.find({ type: 'Text', text: /^Error:/ }))?.text).toBe('Error: git diff failed: fatal: index.lock')

    state.table = featTable()
    const before = state.calls.length
    await wtDiff($, 'refresh')
    expect(state.calls.slice(before)).toContain(`diff -M ${MB} -- :(literal)a.txt`)
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(HUNKS_A_ALL)
    expect(await ui.find({ key: 'collapse' })).toBeDefined()
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
    expect((await ui.find({ type: 'Text', text: /^Error:/ }))?.text).toBe('Error: git diff failed: output over 4 MiB')
    expect(await ui.find({ key: 'file:part' })).toBeUndefined()
    await ui.unmount()
  })

  test('a git failure shows its error', async ($, on) => {
    world(on, { table: featTable({ [`diff --numstat -z -M ${MB} --`]: fail(128, 'fatal: bad object\n') }) })
    await wtDiff($, 'refresh')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /^Error:/ }))?.text).toBe('Error: git diff failed: fatal: bad object')
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

/** The Buttons and Code blocks of a drawing, in document order: `file:a.txt`, `code:a.txt`. */
const order = (node: unknown, out: string[] = []): string[] => {
  if (node === null || typeof node !== 'object') return out
  const { type, key, props, children } = node as {
    type?: string
    key?: string
    props?: Record<string, unknown>
    children?: unknown
  }
  if (type === 'Button') out.push(String(key ?? props?.key ?? ''))
  else if (type === 'Code') out.push(`code:${String(props?.path)}`)
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
    ? (/^ */.exec((await ui.find({ key }))?.text ?? '')?.[0].length ?? 0)
    : Number((await ui.find({ key: `at:${key}` }))?.props.paddingLeft ?? 0)

/** A tree row at `cells` of indent whose label then reads `rest`. */
const expectRow = async (ui: Finder, surface: string, key: string, cells: number, rest: RegExp) => {
  expect(await indentOf(ui, surface, key)).toBe(cells)
  expect(((await ui.find({ key }))?.text ?? '').slice(surface === 'terminal' ? cells : 0)).toMatch(rest)
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

      const text = async (key: string) => (await ui.find({ key }))?.text ?? ''
      const row = (key: string, cells: number, rest: RegExp) => expectRow(ui, surface, key, cells, rest)
      await row('dir:deep/a/b', 0, /^▾ deep\/a\/b\/ +\+3$/)
      await row('file:deep/a/b/c.md', 2, /^\? ● c\.md +\+2$/)
      // Binary files add no lines: nothing to sum.
      expect(await text('dir:dir')).toBe('▾ dir/')
      await row('file:dir/ubin.bin', 2, /^\? ● ubin\.bin +bin$/)
      await row('dir:src', 0, /^▾ src\/ +\+5$/)
      await row('dir:src/lib', 2, /^▾ lib\/ +\+4$/)
      await row('file:src/lib/x.ts', 4, /^\? ● x\.ts +\+4$/)
      await row('file:src/new näme.txt', 2, /^R {3}new näme\.txt ← src\/old name\.txt +\+1$/)
      await row('file:a.txt', 0, /^M ● a\.txt +\+3 −1$/)
      // A native button drops leading spaces: elsewhere the indent is layout.
      if (surface !== 'terminal') {
        for (const key of TREE_KEYS) expect(await text(key)).toMatch(/^\S/)
      }
      // The sums are dim, a file's own counts in color.
      const src = await ui.find({ key: 'dir:src' })
      expect(JSON.stringify(src?.children)).toContain('dimColor')
      if (surface === 'terminal') {
        for (const key of TREE_KEYS) expect(cellWidth(await text(key))).toBe(key === 'dir:dir' ? 6 : 60)
      }
      await ui.unmount()
    }
  })

  test('removed lines add up in a directory row too', async ($, on) => {
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
    expect((await ui.find({ key: 'dir:lib' }))?.text).toMatch(/^▾ lib\/ +\+3 −3$/)
    await ui.unmount()
  })

  test('a directory row folds what is under it and says how many files', async ($, on) => {
    world(on, { table: treeTable(), files: treeFiles })
    await wtDiff($, 'refresh')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'dir:src' })
      expect((await ui.find({ key: 'dir:src' }))?.text).toMatch(/^▸ src\/ \(2\) +\+5$/)
      expect(await rowKeys(ui)).toEqual(TREE_KEYS.filter(key => !/^(dir|file):src\//.test(key)))

      await ui.press({ key: 'dir:src' })
      expect((await ui.find({ key: 'dir:src' }))?.text).toMatch(/^▾ src\/ +\+5$/)
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
      expect((await ui.find({ key: 'file:src/lib/x.ts' }))?.text).toMatch(/^\? ● src\/lib\/x\.ts +\+4$/)
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
      expect(await ui.find({ type: 'Code' })).toBeDefined()
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
      const lead = async (key: string) => /^ */.exec((await ui.find({ key }))?.text ?? '')?.[0].length
      expect(await lead('dir:p')).toBe(0)
      expect(await lead('dir:p/r')).toBe(2)
      expect(await lead('file:p/r/s.txt')).toBe(4)
      expect(await lead('dir:p/r/t/v')).toBe(columns === 60 ? 6 : 5)
      expect(await lead('file:p/r/t/v/w.txt')).toBe(columns === 60 ? 8 : 5)
      for (const button of await ui.findAll({ type: 'Button' })) {
        if (button.key?.startsWith('file:')) expect(cellWidth(button.text)).toBe(columns)
        if (button.key?.startsWith('dir:')) expect(cellWidth(button.text)).toBeLessThanOrEqual(columns)
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
      const text = async (key: string) => (await ui.find({ key }))?.text ?? ''
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
    const renamed = (await ui.find({ key: 'file:src/new näme.txt' }))?.text ?? ''
    expect(cellWidth(renamed)).toBe(40)
    expect(renamed).toMatch(/^ {2}R {3}new näme\.txt ← src\/old name\.txt +\+1$/)

    // No room for where it came from: the name alone.
    await ui.unmount()
    const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 22 } })
    const cut = (await narrow.find({ key: 'file:src/new näme.txt' }))?.text ?? ''
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
    expect((await ui.find({ key: 'dir:src/lib' }))?.text).toMatch(/^ {2}▾ /)
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
      '▾ .claude-plugin/ | +37',
      '  A   marketplace.json | +6',
      '  A   plugin.json | +31',
      '▾ assets/',
      '  A   icon.png | bin',
      '▾ docs/superpowers/ | +258',
      '  ▾ plans/ | +39',
      '    ▾ archive/',
      '      R   2026-10-29-worktree-diff-pane.md ← docs/su…pane.md',
      '    ? ● 2026-10-30-trunk-and-tree-view.md | +39',
      '  ▾ specs/ | +219',
      '    A   2026-10-29-worktree-diff-pane.md | +129',
      '    ? ● 2026-10-30-trunk-and-tree-view.md | +90',
      '▾ hooks/ | +5271',
      '  ▾ fixtures/ | +3',
      '    A   numstat.txt | +3',
      '  A ● git.test.ts | +1305',
      '  A ● git.ts | +934',
      '  A   hooks.json | +1',
      '  A ● register.test.tsx | +1612',
      '  A ● register.tsx | +1142',
      '  ? ● tree.test.ts | +148',
      '  ? ● tree.ts | +126',
      '▾ scripts/ | +2',
      '  A   sync.sh | +2',
      '▾ types/ | +88',
      '  A ● index.d.ts | +88',
      'D   .gitignore | −2',
      'M ● LICENSE | +1 −4',
      'A   README.md | +136',
    ]
    const shown = async (ui: Finder & Parameters<typeof rowKeys>[0]) =>
      Promise.all((await rowKeys(ui)).map(async key => (await ui.find({ key }))?.text ?? ''))
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lines = await shown(terminal)
    expect(lines.map(line => line.replace(/ {2,}(?=[+−b])/, ' | ').trimEnd())).toEqual(expected)
    // A file row and a counted directory row fill the width; the header sums every file.
    for (const line of lines) if (/[+−]\d+$|bin$/.test(line) || line.includes('←')) expect(cellWidth(line)).toBe(60)
    expect((await terminal.find({ key: 'dir:hooks' }))?.text).toMatch(/^▾ hooks\/ +\+5271$/)
    await terminal.press({ key: 'dir:docs/superpowers' })
    expect((await terminal.find({ key: 'dir:docs/superpowers' }))?.text).toMatch(/^▸ docs\/superpowers\/ \(4\) +\+258$/)
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

  test('no argument toggles the pane', async ($, on) => {
    const { state } = world(on, { isOpen: false })
    expect((await wtDiff($)).text).toBe('Changes pane opened.')
    expect(state.opened).toBe(1)
    expect((await wtDiff($, '')).text).toBe('Changes pane closed.')
    expect(state.isOpen).toBe(false)
  })

  test('a pane open but undrawn on a narrow terminal is opened, not closed', async ($, on) => {
    const { state } = world(on, { isOpen: true, isPlaced: false })
    expect((await wtDiff($)).text).toBe('Changes pane opened.')
    expect(state.opened).toBe(1)
    expect(state.isPlaced).toBe(true)
  })

  test('a pane that is a tab behind another is raised, not closed', async ($, on) => {
    const { state } = world(on, { isOpen: true, isPlaced: true, isShown: false })
    expect((await wtDiff($)).text).toBe('Changes pane opened.')
    expect(state.isOpen).toBe(true)
    expect(state.openArgs.at(-1)).toMatchObject({ id: 'worktree-diff', focus: true })
    // Shown now: the next /wt-diff closes it.
    expect((await wtDiff($)).text).toBe('Changes pane closed.')
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
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('feat/x → origin/feat/x')
    expect(drawn).toContain('upstream · 2d46dcc')
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
    expect(state.calls).toEqual([])
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
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('+EXTRA')

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
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
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
    // The kit raises events, not `$.ui.close`: close it the way /wt-diff does.
    expect((await wtDiff($)).text).toBe('Changes pane closed.')
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

  test('statusLine shows the totals', { options: { statusLine: true } }, async ($, on) => {
    const { state } = world(on, { isOpen: false })
    await wtDiff($, 'refresh')
    expect(state.statuses.at(-1)).toBe('wt +8 −3')
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
    expect((await wtDiff($)).text).toBe('Changes pane opened.')
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
    // The person closes it; the hot reload's session.start finds a snapshot.
    state.isOpen = false
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(state.opened).toBe(1)
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
