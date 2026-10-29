import { describe, expect, test } from 'claude-code/testing'

import type { FileChange, Snapshot } from '../types'
import {
  computeSnapshot,
  countLines,
  git,
  GIT_PREFIX,
  hashString,
  isLinked,
  loadFileDiff,
  parseNameStatusZ,
  parseNumstatZ,
  parsePathsZ,
  parseReflogCreatedFrom,
  parseWorktreeListPorcelain,
  resolveBase,
  snapshotSignature,
  splitHunks,
  stableStartPoint,
  summaryText,
  truncateHunks,
  type GitDeps,
  type RunResult,
} from './git'

// Every fixture below is the exact stdout/stderr real git 2.54 printed in a
// throwaway repo: `main` with a.txt, keep.txt, "src/old name.txt", gone.txt;
// `git worktree add -b feat ../t1-wt main`; on feat a commit editing a.txt,
// renaming to "src/new näme.txt", deleting gone.txt, adding binary bin.dat;
// main then moved on one commit; feat's worktree left with a.txt edited,
// keep.txt staged, untracked untracked.md and binary dir/ubin.bin. Only the
// scratch directory's absolute prefix is shortened to /w.
const REPO = '/w/t1-repo'
const ROOT = '/w/t1-wt'
const MB = '73481c517fc2281f8cce4efd1db9924969e17976'
const MAIN_SHA = '1dfc5da93a873c05245d17f21969887d1d0d6fe4'

const ok = (stdout: string): Partial<RunResult> => ({ exitCode: 0, stdout })
const fail = (exitCode: number, stderr: string, stdout = ''): Partial<RunResult> => ({
  exitCode,
  stdout,
  stderr,
})

const NOT_A_REPO = fail(128, 'fatal: not a git repository (or any of the parent directories): .git\n')
const NO_UPSTREAM = fail(128, "fatal: no upstream configured for branch 'feat'\n")
const NO_ORIGIN_HEAD = fail(128, 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n')
const NOT_A_COMMIT = fail(1, '')

const PORCELAIN_FEAT =
  `worktree ${REPO}\nHEAD ${MAIN_SHA}\nbranch refs/heads/main\n\n` +
  `worktree ${ROOT}\nHEAD e47b652208a1df9b8a3cbff954e65fc4b24fd4db\nbranch refs/heads/feat\n\n`
const PORCELAIN_ALL =
  PORCELAIN_FEAT +
  `worktree /w/t1-wt2\nHEAD ${MAIN_SHA}\nbranch refs/heads/fromhead\n\n` +
  `worktree /w/t1-wt3\nHEAD ${MAIN_SHA}\ndetached\n\n`

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
const DIFF_A_HEAD =
  'diff --git a/a.txt b/a.txt\nindex f75f249..8ce4ec5 100644\n--- a/a.txt\n+++ b/a.txt\n' +
  '@@ -2,3 +2,4 @@ line1\n LINE2\n line3\n line4\n+extra\n'
const DIFF_RENAME =
  'diff --git a/src/old name.txt b/src/new näme.txt\nsimilarity index 94%\n' +
  'rename from src/old name.txt\nrename to src/new näme.txt\nindex 569fb63..41bc544 100644\n' +
  '--- a/src/old name.txt\t\n+++ b/src/new näme.txt\t\n' +
  '@@ -18,3 +18,4 @@ row 17\n row 18\n row 19\n row 20\n+row 21\n'
const DIFF_GONE =
  'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex a290ced..0000000\n' +
  '--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-del\n-me\n'
const DIFF_UNTRACKED_MD =
  'diff --git a/untracked.md b/untracked.md\nnew file mode 100644\nindex 0000000..77ff240\n' +
  '--- /dev/null\n+++ b/untracked.md\n@@ -0,0 +1,3 @@\n+u1\n+u2\n+u3\n'
const DIFF_UNTRACKED_BIN =
  'diff --git a/dir/ubin.bin b/dir/ubin.bin\nnew file mode 100644\nindex 0000000..d5d0b8b\n' +
  'Binary files /dev/null and b/dir/ubin.bin differ\n'

type Answer = Partial<RunResult> | ((cwd: string) => Partial<RunResult> | Promise<Partial<RunResult>>)
type Call = { key: string; argv: string[]; cwd: string }

const HARDENED_DIFF = ['diff', '--no-color', '--no-ext-diff']

/**
 * A runner answering by the args after git's fixed prefix (and, for diff,
 * after its hardening flags), which it insists every call carries.
 */
const fakeDeps = (
  table: Record<string, Answer>,
  files: Record<string, { text: string | null; size?: number; mtimeMs?: number; isLink?: boolean }> = {},
  now = 1000,
  untrackedCache?: GitDeps['untrackedCache'],
) => {
  const calls: Call[] = []
  const reads: string[] = []
  const deps: GitDeps = {
    run: async (argv, cwd) => {
      expect(argv.slice(0, GIT_PREFIX.length)).toEqual([...GIT_PREFIX])
      let rest = argv.slice(GIT_PREFIX.length)
      if (rest[0] === 'diff') {
        expect(rest.slice(0, 3)).toEqual(HARDENED_DIFF)
        rest = ['diff', ...rest.slice(3)]
      }
      const key = rest.join(' ')
      calls.push({ key, argv, cwd })
      const answer = table[key]
      const given = typeof answer === 'function' ? await answer(cwd) : answer
      const result = given ?? fail(128, `fatal: unmocked: ${key}\n`)

      return { exitCode: 0, stdout: '', stderr: '', ...result }
    },
    readText: async path => {
      reads.push(path)
      return files[path]?.text ?? null
    },
    fileInfo: async path => {
      const file = files[path]
      return file
        ? { size: file.size ?? (file.text ?? '').length, mtimeMs: file.mtimeMs ?? 0, isLink: file.isLink === true }
        : null
    },
    now: async () => now,
    ...(untrackedCache ? { untrackedCache } : {}),
  }

  return { deps, calls, reads }
}

/** The feat worktree, as real git answered there. */
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
  ...overrides,
})

const featFiles = {
  [`${ROOT}/untracked.md`]: { text: 'u1\nu2\nu3\n' },
  [`${ROOT}/dir/ubin.bin`]: { text: 'x\0y' },
}

const file = (path: string, rest: Partial<FileChange> = {}): FileChange => ({
  path,
  status: 'M',
  added: 0,
  removed: 0,
  isBinary: false,
  layer: 'committed',
  ...rest,
})

// ---------------------------------------------------------------- parsers

describe('parsers', () => {
  test('numstat -z: plain, binary, deletion and rename entries', async () => {
    expect(parseNumstatZ(NUMSTAT_ALL)).toEqual([
      { path: 'a.txt', added: 3, removed: 1, isBinary: false },
      { path: 'bin.dat', added: 0, removed: 0, isBinary: true },
      { path: 'gone.txt', added: 0, removed: 2, isBinary: false },
      { path: 'keep.txt', added: 1, removed: 0, isBinary: false },
      { path: 'src/new näme.txt', oldPath: 'src/old name.txt', added: 1, removed: 0, isBinary: false },
    ])
  })

  test('numstat -z: a path holding a tab, and empty output', async () => {
    expect(parseNumstatZ('2\t0\tweird\tname\0')).toEqual([
      { path: 'weird\tname', added: 2, removed: 0, isBinary: false },
    ])
    expect(parseNumstatZ('')).toEqual([])
  })

  test('name-status -z: letters, rename score, copy, type change', async () => {
    expect(parseNameStatusZ(NAMES_ALL)).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'bin.dat' },
      { status: 'D', path: 'gone.txt' },
      { status: 'M', path: 'keep.txt' },
      { status: 'R', path: 'src/new näme.txt', oldPath: 'src/old name.txt' },
    ])
    expect(parseNameStatusZ('C075\0a\0b\0T\0link\0U\0c\0X\0d\0')).toEqual([
      { status: 'C', path: 'b', oldPath: 'a' },
      { status: 'T', path: 'link' },
      { status: 'U', path: 'c' },
      { status: 'M', path: 'd' },
    ])
  })

  test('paths -z', async () => {
    expect(parsePathsZ(UNTRACKED)).toEqual(['dir/ubin.bin', 'untracked.md'])
    expect(parsePathsZ('')).toEqual([])
  })

  test('reflog: the oldest line names the creation point', async () => {
    expect(parseReflogCreatedFrom('commit: feat1\nbranch: Created from main\n')).toBe('main')
    expect(parseReflogCreatedFrom('branch: Created from HEAD\n')).toBe('HEAD')
    expect(parseReflogCreatedFrom('branch: Created from origin/release/1.2\n')).toBe('origin/release/1.2')
    // main's own reflog (real): created by its first commit, not from a branch.
    expect(parseReflogCreatedFrom('commit: main2\ncommit (initial): init\n')).toBeNull()
    // Only the oldest line counts.
    expect(parseReflogCreatedFrom('branch: Created from x\ncommit: y\n')).toBeNull()
    expect(parseReflogCreatedFrom('')).toBeNull()
  })

  test('worktree list --porcelain: branches, detached and bare', async () => {
    expect(parseWorktreeListPorcelain(PORCELAIN_ALL)).toEqual([
      { path: REPO, head: MAIN_SHA, branch: 'main', isDetached: false, isBare: false },
      {
        path: ROOT,
        head: 'e47b652208a1df9b8a3cbff954e65fc4b24fd4db',
        branch: 'feat',
        isDetached: false,
        isBare: false,
      },
      { path: '/w/t1-wt2', head: MAIN_SHA, branch: 'fromhead', isDetached: false, isBare: false },
      { path: '/w/t1-wt3', head: MAIN_SHA, branch: null, isDetached: true, isBare: false },
    ])
    expect(parseWorktreeListPorcelain('worktree /w/bare.git\nbare\n\n')).toEqual([
      { path: '/w/bare.git', head: null, branch: null, isDetached: false, isBare: true },
    ])
  })

  test('countLines counts a last line without a newline', async () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('\n\n')).toBe(2)
  })

  test('splitHunks drops every file header, rename lines included', async () => {
    expect(splitHunks(DIFF_RENAME)).toBe('@@ -18,3 +18,4 @@ row 17\n row 18\n row 19\n row 20\n+row 21')
    expect(splitHunks(DIFF_UNTRACKED_BIN)).toBe('')
    expect(splitHunks('')).toBe('')
    // Two files (a rename git did not pair): both headers go, both hunks stay.
    expect(splitHunks(DIFF_GONE + DIFF_A_HEAD)).toBe(
      '@@ -1,2 +0,0 @@\n-del\n-me\n@@ -2,3 +2,4 @@ line1\n LINE2\n line3\n line4\n+extra',
    )
  })

  test('hashString is deterministic and spreads', async () => {
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
    expect(hashString('')).toMatch(/^[0-9a-f]+$/)
  })
})

// --------------------------------------------------------------- truncate

describe('truncateHunks', () => {
  const bigHunk = (n: number, width = 1) =>
    [`@@ -1,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+${String(i).padEnd(width, 'x')}`)].join('\n')

  test('under the cap the hunks pass whole', async () => {
    expect(truncateHunks('@@ -1 +1 @@\n-a\n+b')).toEqual({ hunks: '@@ -1 +1 @@\n-a\n+b', omittedLines: 0 })
  })

  test('cut at 400 lines, the last header rewritten to what is kept', async () => {
    const { hunks, omittedLines } = truncateHunks(bigHunk(1000))
    const lines = hunks.split('\n')
    expect(lines).toHaveLength(400)
    expect(lines[0]).toBe('@@ -1,0 +1,399 @@')
    expect(omittedLines).toBe(601)
  })

  test('cut at 30k characters', async () => {
    const { hunks, omittedLines } = truncateHunks(bigHunk(300, 199))
    expect(hunks.length).toBeLessThanOrEqual(30_000)
    const kept = hunks.split('\n').length
    expect(kept + omittedLines).toBe(301)
    expect(hunks.split('\n')[0]).toBe(`@@ -1,0 +1,${kept - 1} @@`)
  })

  test('a cut in the second hunk leaves the first header alone', async () => {
    const source = '@@ -1,2 +1,2 @@ ctx\n a\n-b\n+c\n@@ -10,4 +10,4 @@\n x\n-y\n+z\n w\n v'
    const { hunks, omittedLines } = truncateHunks(source, 8)
    expect(hunks).toBe('@@ -1,2 +1,2 @@ ctx\n a\n-b\n+c\n@@ -10,2 +10,2 @@\n x\n-y\n+z')
    expect(omittedLines).toBe(2)
  })

  test('a cut right after a header drops that header, which counts as no line', async () => {
    const source = '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d'
    expect(truncateHunks(source, 4)).toEqual({ hunks: '@@ -1 +1 @@\n-a\n+b', omittedLines: 2 })
  })

  test('a single line past the char cap is cut short, not lost', async () => {
    const { hunks, omittedLines } = truncateHunks(`@@ -0,0 +1 @@\n+${'x'.repeat(40_000)}`)
    expect(hunks.length).toBeLessThanOrEqual(30_000)
    expect(hunks.startsWith('@@ -0,0 +1,1 @@\n+xxx')).toBe(true)
    expect(hunks.endsWith('x…')).toBe(true)
    expect(omittedLines).toBe(0)

    const rest = truncateHunks(`@@ -1,3 +1,3 @@\n+${'y'.repeat(100)}\n a\n b`, 400, 50)
    expect(rest.hunks).toBe(`@@ -1,0 +1,1 @@\n+${'y'.repeat(17)}…`)
    expect(rest.omittedLines).toBe(2)
  })

  test('only the first body line is cut short; later long lines are dropped', async () => {
    const { hunks, omittedLines } = truncateHunks(`@@ -1,2 +1,2 @@\n-a\n+${'z'.repeat(100)}\n b`, 400, 50)
    expect(hunks).toBe('@@ -1,1 +1,0 @@\n-a')
    expect(omittedLines).toBe(2)
  })
})

// ------------------------------------------------------------------- base

describe('resolveBase', () => {
  const ctx = { root: ROOT, branch: 'feat' }

  test('1. an override wins, once it names a commit', async () => {
    const { deps } = fakeDeps(featTable({ 'rev-parse --verify --quiet v1.0^{commit}': ok('abc\n') }))
    expect(await resolveBase(deps, ctx, 'v1.0')).toEqual({ ref: 'v1.0', source: 'override' })
  })

  test('1. an override that names no commit rejects', async () => {
    const { deps } = fakeDeps(featTable({ 'rev-parse --verify --quiet nope^{commit}': NOT_A_COMMIT }))
    await expect(resolveBase(deps, ctx, 'nope')).rejects.toThrow(/Base override "nope"/)
  })

  test('2. the branch reflog: Created from main', async () => {
    const { deps } = fakeDeps(featTable())
    expect(await resolveBase(deps, ctx)).toEqual({ ref: 'main', source: 'reflog' })
  })

  test('2. a reflog ref that no longer exists falls through', async () => {
    const { deps } = fakeDeps(
      featTable({
        'reflog show --format=%gs refs/heads/feat': ok('branch: Created from gone-branch\n'),
        'rev-parse --verify --quiet gone-branch^{commit}': NOT_A_COMMIT,
      }),
    )
    expect(await resolveBase(deps, ctx)).toEqual({ ref: 'main', source: 'main-worktree' })
  })

  test('3. Created from HEAD falls to the upstream', async () => {
    const { deps } = fakeDeps(
      featTable({
        'reflog show --format=%gs refs/heads/feat': ok('branch: Created from HEAD\n'),
        'rev-parse --abbrev-ref feat@{upstream}': ok('origin/main\n'),
      }),
    )
    expect(await resolveBase(deps, ctx)).toEqual({ ref: 'origin/main', source: 'upstream' })
  })

  test("3. the branch's own remote copy is no base", async () => {
    const { deps } = fakeDeps(
      featTable({
        'reflog show --format=%gs refs/heads/feat': ok('branch: Created from HEAD\n'),
        'rev-parse --abbrev-ref feat@{upstream}': ok('origin/feat\n'),
      }),
    )
    expect(await resolveBase(deps, ctx)).toEqual({ ref: 'main', source: 'main-worktree' })
  })

  // Real reflogs of a branch checked out from its remote copy:
  // `git worktree add ../wt feat` (DWIM) and `git checkout -b feat origin/feat`.
  for (const created of ['refs/remotes/origin/feat', 'origin/feat']) {
    test(`2. Created from ${created} is the branch's own copy, no base`, async () => {
      const { deps } = fakeDeps(
        featTable({
          'reflog show --format=%gs refs/heads/feat': ok(`branch: Created from ${created}\n`),
          'rev-parse --verify --quiet origin/feat^{commit}': ok('abc\n'),
          'rev-parse --verify --quiet refs/remotes/origin/feat^{commit}': ok('abc\n'),
          'rev-parse --abbrev-ref feat@{upstream}': ok('origin/feat\n'),
        }),
      )
      expect(await resolveBase(deps, ctx)).toEqual({ ref: 'main', source: 'main-worktree' })
    })
  }

  test('2. a start point is named the way it means one commit', async () => {
    expect(stableStartPoint('main')).toBe('main')
    expect(stableStartPoint('main^')).toBe('main')
    expect(stableStartPoint('origin/main~3')).toBe('origin/main')
    expect(stableStartPoint('v1.0~2^2')).toBe('v1.0')
    expect(stableStartPoint('1dfc5da')).toBe('1dfc5da')
    expect(stableStartPoint('user@host')).toBe('user@host')
    for (const moving of ['HEAD', 'HEAD~2', '@', '@~1', '@{-1}', 'main@{u}', 'FETCH_HEAD', 'ORIG_HEAD', 'main^{}', 'a..b', 'HEAD:x']) {
      expect(stableStartPoint(moving)).toBeNull()
    }
  })

  // Real reflogs: `git worktree add -b b4 ../wt HEAD~2`, `git checkout -b b5 main^`.
  test('2. Created from HEAD~2 would move with HEAD: it falls through', async () => {
    const { deps, calls } = fakeDeps(
      featTable({ 'reflog show --format=%gs refs/heads/feat': ok('commit: w1\nbranch: Created from HEAD~2\n') }),
    )
    expect(await resolveBase(deps, ctx)).toEqual({ ref: 'main', source: 'main-worktree' })
    expect(calls.some(c => c.key.includes('HEAD~2'))).toBe(false)
  })

  test('2. Created from main^ compares against main', async () => {
    const { deps } = fakeDeps(
      featTable({ 'reflog show --format=%gs refs/heads/feat': ok('branch: Created from main^\n') }),
    )
    expect(await resolveBase(deps, ctx)).toEqual({ ref: 'main', source: 'reflog' })
  })

  test('2. a full ref name is shown short', async () => {
    const { deps } = fakeDeps(
      featTable({
        'reflog show --format=%gs refs/heads/feat': ok('branch: Created from refs/remotes/origin/main\n'),
        'rev-parse --verify --quiet origin/main^{commit}': ok(`${MAIN_SHA}\n`),
      }),
    )
    expect(await resolveBase(deps, ctx)).toEqual({ ref: 'origin/main', source: 'reflog' })
  })

  test("4. the main worktree's branch (EnterWorktree-style branch)", async () => {
    const { deps } = fakeDeps(
      featTable({
        'reflog show --format=%gs refs/heads/fromhead': ok('branch: Created from HEAD\n'),
        'rev-parse --abbrev-ref fromhead@{upstream}': fail(
          128,
          "fatal: no upstream configured for branch 'fromhead'\n",
        ),
        'worktree list --porcelain': ok(PORCELAIN_ALL),
      }),
    )
    expect(await resolveBase(deps, { root: '/w/t1-wt2', branch: 'fromhead' })).toEqual({
      ref: 'main',
      source: 'main-worktree',
    })
  })

  test('4. a detached HEAD skips reflog and upstream', async () => {
    const { deps, calls } = fakeDeps(featTable({ 'worktree list --porcelain': ok(PORCELAIN_ALL) }))
    expect(await resolveBase(deps, { root: '/w/t1-wt3', branch: null })).toEqual({
      ref: 'main',
      source: 'main-worktree',
    })
    expect(calls.some(c => c.key.startsWith('reflog') || c.key.includes('@{upstream}'))).toBe(false)
  })

  // The main checkout itself, on main tracking origin/main.
  const mainCheckout = (overrides: Record<string, Answer>) =>
    featTable({
      'reflog show --format=%gs refs/heads/main': ok('commit: main2\ncommit (initial): init\n'),
      'rev-parse --abbrev-ref main@{upstream}': ok('origin/main\n'),
      ...overrides,
    })

  test('5. the default branch: origin/HEAD', async () => {
    const { deps } = fakeDeps(
      mainCheckout({
        'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
        'rev-parse --verify --quiet origin/main^{commit}': ok(`${MAIN_SHA}\n`),
      }),
    )
    expect(await resolveBase(deps, { root: REPO, branch: 'main' })).toEqual({
      ref: 'origin/main',
      source: 'default-branch',
    })
  })

  test('5. no origin/HEAD: the first local default branch that is not this one', async () => {
    const { deps } = fakeDeps(
      mainCheckout({
        'rev-parse --verify --quiet master^{commit}': NOT_A_COMMIT,
        'rev-parse --verify --quiet trunk^{commit}': ok('abc\n'),
      }),
    )
    expect(await resolveBase(deps, { root: REPO, branch: 'main' })).toEqual({
      ref: 'trunk',
      source: 'default-branch',
    })
  })

  test('6. nothing applies: null', async () => {
    const { deps } = fakeDeps(
      mainCheckout({
        'rev-parse --verify --quiet master^{commit}': NOT_A_COMMIT,
        'rev-parse --verify --quiet trunk^{commit}': NOT_A_COMMIT,
        'rev-parse --verify --quiet develop^{commit}': NOT_A_COMMIT,
      }),
    )
    expect(await resolveBase(deps, { root: REPO, branch: 'main' })).toBeNull()
  })
})

// --------------------------------------------------------------- snapshot

describe('computeSnapshot', () => {
  test('all: commits, staged, unstaged and untracked, each with its layer', async () => {
    const { deps, calls } = fakeDeps(featTable(), featFiles)
    const snapshot = await computeSnapshot(deps, { cwd: `${ROOT}/src`, mode: 'all' })

    expect(snapshot.error).toBeUndefined()
    expect(snapshot).toMatchObject({
      cwd: `${ROOT}/src`,
      isRepo: true,
      root: ROOT,
      isLinkedWorktree: true,
      branch: 'feat',
      head: 'e47b652',
      base: { ref: 'main', source: 'reflog', mergeBase: MB },
      ahead: 1,
      behind: 1,
      mode: 'all',
      omittedFiles: 0,
      totals: { added: 8, removed: 3, files: 7 },
      refreshedAt: 1000,
    })
    expect(snapshot.files).toEqual([
      file('a.txt', { added: 3, removed: 1, layer: 'both' }),
      file('bin.dat', { status: 'A', isBinary: true }),
      file('dir/ubin.bin', { status: '?', isBinary: true, layer: 'uncommitted' }),
      file('gone.txt', { status: 'D', removed: 2 }),
      file('keep.txt', { added: 1, layer: 'uncommitted' }),
      file('src/new näme.txt', { status: 'R', oldPath: 'src/old name.txt', added: 1 }),
      file('untracked.md', { status: '?', added: 3, layer: 'uncommitted' }),
    ])

    // The first rev-parse runs in the session cwd, everything after in the root.
    expect(calls[0]).toMatchObject({ key: 'rev-parse --show-toplevel', cwd: `${ROOT}/src` })
    expect(calls.slice(1).every(c => c.cwd === ROOT)).toBe(true)
  })

  test('committed: merge-base to HEAD, no untracked files', async () => {
    const { deps, calls, reads } = fakeDeps(featTable(), featFiles)
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'committed' })

    expect(snapshot.files).toEqual([
      file('a.txt', { added: 2, removed: 1 }),
      file('bin.dat', { status: 'A', isBinary: true }),
      file('gone.txt', { status: 'D', removed: 2 }),
      file('src/new näme.txt', { status: 'R', oldPath: 'src/old name.txt', added: 1 }),
    ])
    expect(snapshot.totals).toEqual({ added: 3, removed: 3, files: 4 })
    expect(calls.some(c => c.key.startsWith('ls-files'))).toBe(false)
    expect(reads).toEqual([])
  })

  test('uncommitted: HEAD to the working tree, untracked included', async () => {
    const { deps } = fakeDeps(featTable(), featFiles)
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'uncommitted' })

    expect(snapshot.base?.ref).toBe('main')
    expect(snapshot.files).toEqual([
      file('a.txt', { added: 1, layer: 'uncommitted' }),
      file('dir/ubin.bin', { status: '?', isBinary: true, layer: 'uncommitted' }),
      file('keep.txt', { added: 1, layer: 'uncommitted' }),
      file('untracked.md', { status: '?', added: 3, layer: 'uncommitted' }),
    ])
    expect(snapshot.totals).toEqual({ added: 5, removed: 0, files: 4 })
  })

  test('maxFiles caps the list; untracked files past it are not read', async () => {
    const { deps, reads } = fakeDeps(featTable(), featFiles)
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'all', maxFiles: 2 })

    expect(snapshot.files.map(f => f.path)).toEqual(['a.txt', 'bin.dat'])
    expect(snapshot.omittedFiles).toBe(5)
    expect(snapshot.totals.files).toBe(7)
    expect(reads).toEqual([])
  })

  test('under the cap tracked changes come first: an unignored directory cannot crowd them out', async () => {
    const venv = Array.from({ length: 400 }, (_, i) => `.venv/lib/m${String(i).padStart(3, '0')}.py`)
    const files = Object.fromEntries(venv.map(path => [`${ROOT}/${path}`, { text: 'x\n' }]))
    const { deps, reads } = fakeDeps(
      featTable({
        [`diff --numstat -z -M ${MB} --`]: ok('3\t1\tsrc/app.ts\0'),
        [`diff --name-status -z -M ${MB} --`]: ok('M\0src/app.ts\0'),
        'ls-files --others --exclude-standard -z': ok(venv.map(path => `${path}\0`).join('')),
      }),
      files,
    )
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'all', maxFiles: 300 })

    expect(snapshot.files.length).toBe(300)
    // Listed by path all the same, so the tracked file sorts after `.venv/`.
    expect(snapshot.files.at(-1)?.path).toBe('src/app.ts')
    expect(snapshot.files[0]?.path).toBe('.venv/lib/m000.py')
    expect(snapshot.omittedFiles).toBe(101)
    expect(snapshot.totals).toEqual({ added: 3 + 299, removed: 1, files: 401 })
    expect(reads.length).toBe(299)
  })

  test('an unchanged untracked file is read once; a new size or mtime reads it again', async () => {
    const cache: NonNullable<GitDeps['untrackedCache']> = new Map()
    const run = async (files: Parameters<typeof fakeDeps>[1]) => {
      const { deps, reads } = fakeDeps(featTable(), files, 1000, cache)
      const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'all' })
      return { snapshot, reads }
    }

    const first = await run(featFiles)
    expect(first.reads.sort()).toEqual([`${ROOT}/dir/ubin.bin`, `${ROOT}/untracked.md`])
    const second = await run(featFiles)
    expect(second.reads).toEqual([])
    expect(second.snapshot.files).toEqual(first.snapshot.files)

    const third = await run({ ...featFiles, [`${ROOT}/untracked.md`]: { text: 'u1\nu2\nu4\n', mtimeMs: 5 } })
    expect(third.reads).toEqual([`${ROOT}/untracked.md`])
    const fourth = await run({ ...featFiles, [`${ROOT}/untracked.md`]: { text: 'u1\n' } })
    expect(fourth.reads).toEqual([`${ROOT}/untracked.md`])
    expect(fourth.snapshot.files.find(f => f.path === 'untracked.md')?.added).toBe(1)

    // A file no longer listed is forgotten.
    const { deps } = fakeDeps(featTable({ 'ls-files --others --exclude-standard -z': ok('untracked.md\0') }), featFiles, 1000, cache)
    await computeSnapshot(deps, { cwd: ROOT, mode: 'all' })
    expect([...cache.keys()]).toEqual([`${ROOT}/untracked.md`])
  })

  test('an untracked file over 1 MiB is binary, never read', async () => {
    const { deps, reads } = fakeDeps(
      featTable({ 'ls-files --others --exclude-standard -z': ok('big.log\0') }),
      { [`${ROOT}/big.log`]: { text: 'x\n', size: 2 * 1024 * 1024 } },
    )
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'uncommitted' })

    expect(snapshot.files.find(f => f.path === 'big.log')).toEqual(
      file('big.log', { status: '?', isBinary: true, layer: 'uncommitted' }),
    )
    expect(reads).toEqual([])
  })

  test('an untracked symbolic link counts one line, its target, never what it points at', async () => {
    // Real git: `git diff --no-index /dev/null link.txt` is `+long.txt`, no newline.
    const { deps, reads } = fakeDeps(
      featTable({ 'ls-files --others --exclude-standard -z': ok('link.txt\0') }),
      { [`${ROOT}/link.txt`]: { text: 'l1\nl2\nl3\n', isLink: true } },
    )
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'uncommitted' })

    expect(snapshot.files.find(f => f.path === 'link.txt')).toEqual(
      file('link.txt', { status: '?', added: 1, layer: 'uncommitted' }),
    )
    expect(reads).toEqual([])
  })

  test('nested repositories and linked worktrees inside are not untracked files', async () => {
    const { deps, reads } = fakeDeps(
      featTable({ 'ls-files --others --exclude-standard -z': ok('.claude/worktrees/wtx/\0nested/\0untracked.md\0') }),
      featFiles,
    )
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'uncommitted' })

    expect(snapshot.files.filter(f => f.status === '?').map(f => f.path)).toEqual(['untracked.md'])
    expect(reads).toEqual([`${ROOT}/untracked.md`])
  })

  test('a file named HEAD: every diff ends its revisions with --', async () => {
    for (const mode of ['all', 'committed', 'uncommitted'] as const) {
      const { deps, calls } = fakeDeps(
        featTable({ 'ls-files --others --exclude-standard -z': ok('HEAD\0') }),
        { [`${ROOT}/HEAD`]: { text: 'h\n' } },
      )
      const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode })
      expect(snapshot.error).toBeUndefined()
      const diffs = calls.filter(c => c.key.startsWith('diff '))
      expect(diffs.length).toBeGreaterThan(0)
      expect(diffs.every(c => c.argv.at(-1) === '--')).toBe(true)
    }
  })

  test('the signature ignores the time and follows the content', async () => {
    const a = await computeSnapshot(fakeDeps(featTable(), featFiles, 1).deps, { cwd: ROOT, mode: 'all' })
    const b = await computeSnapshot(fakeDeps(featTable(), featFiles, 2).deps, { cwd: ROOT, mode: 'all' })
    const c = await computeSnapshot(
      fakeDeps(featTable({ [`diff --numstat -z -M ${MB} --`]: ok(NUMSTAT_ALL.replace('3\t1', '4\t1')) }), featFiles).deps,
      { cwd: ROOT, mode: 'all' },
    )
    const d = await computeSnapshot(fakeDeps(featTable(), featFiles).deps, { cwd: ROOT, mode: 'committed' })

    expect(a.refreshedAt).not.toBe(b.refreshedAt)
    expect(a.signature).toBe(b.signature)
    expect(a.signature).toBe(snapshotSignature(a))
    expect(c.signature).not.toBe(a.signature)
    expect(d.signature).not.toBe(a.signature)
  })

  test('not a git repository: empty, no error', async () => {
    const { deps, calls } = fakeDeps({ 'rev-parse --show-toplevel': NOT_A_REPO })
    const snapshot = await computeSnapshot(deps, { cwd: '/w/t1-notrepo', mode: 'all' })

    expect(snapshot).toMatchObject({ isRepo: false, root: '', files: [], base: null })
    expect(snapshot.error).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test('another rev-parse failure is an error', async () => {
    const { deps } = fakeDeps({
      'rev-parse --show-toplevel': fail(128, 'fatal: this operation must be run in a work tree\n'),
    })
    const snapshot = await computeSnapshot(deps, { cwd: '/w/bare.git', mode: 'all' })

    expect(snapshot).toMatchObject({ isRepo: false, error: 'fatal: this operation must be run in a work tree' })
  })

  test('a repo with no commits: branch known, no head, no base', async () => {
    const { deps } = fakeDeps({
      'rev-parse --show-toplevel': ok('/w/t1-empty\n'),
      'rev-parse --path-format=absolute --git-dir --git-common-dir': ok('/w/t1-empty/.git\n/w/t1-empty/.git\n'),
      'symbolic-ref --short -q HEAD': ok('main\n'),
      'rev-parse --verify --quiet --short HEAD': NOT_A_COMMIT,
    })
    const snapshot = await computeSnapshot(deps, { cwd: '/w/t1-empty', mode: 'all' })

    expect(snapshot).toMatchObject({
      isRepo: true,
      isLinkedWorktree: false,
      branch: 'main',
      head: '',
      base: null,
      files: [],
    })
    expect(snapshot.error).toBeUndefined()
  })

  test('a detached HEAD compares against the main worktree branch', async () => {
    const { deps } = fakeDeps(
      featTable({
        'rev-parse --show-toplevel': ok('/w/t1-wt3\n'),
        'rev-parse --path-format=absolute --git-dir --git-common-dir': ok(
          `${REPO}/.git/worktrees/t1-wt3\n${REPO}/.git\n`,
        ),
        'symbolic-ref --short -q HEAD': fail(1, ''),
        'rev-parse --verify --quiet --short HEAD': ok('1dfc5da\n'),
        'worktree list --porcelain': ok(PORCELAIN_ALL),
        'merge-base main HEAD': ok(`${MAIN_SHA}\n`),
        'rev-list --left-right --count main...HEAD': ok('0\t0\n'),
        [`diff --numstat -z -M ${MAIN_SHA} --`]: ok(''),
        [`diff --name-status -z -M ${MAIN_SHA} --`]: ok(''),
        [`diff --name-only -z --no-renames ${MAIN_SHA} HEAD --`]: ok(''),
        'ls-files --others --exclude-standard -z': ok(''),
      }),
    )
    const snapshot = await computeSnapshot(deps, { cwd: '/w/t1-wt3', mode: 'all' })

    expect(snapshot.error).toBeUndefined()
    expect(snapshot).toMatchObject({
      branch: null,
      head: '1dfc5da',
      base: { ref: 'main', source: 'main-worktree', mergeBase: MAIN_SHA },
      files: [],
    })
  })

  test('no base: empty in all mode, uncommitted changes still listed', async () => {
    const noBase = featTable({
      'reflog show --format=%gs refs/heads/feat': ok('branch: Created from HEAD\n'),
      'worktree list --porcelain': ok(`worktree ${ROOT}\nHEAD abc\nbranch refs/heads/feat\n\n`),
      'rev-parse --verify --quiet main^{commit}': NOT_A_COMMIT,
      'rev-parse --verify --quiet master^{commit}': NOT_A_COMMIT,
      'rev-parse --verify --quiet trunk^{commit}': NOT_A_COMMIT,
      'rev-parse --verify --quiet develop^{commit}': NOT_A_COMMIT,
    })
    const all = await computeSnapshot(fakeDeps(noBase, featFiles).deps, { cwd: ROOT, mode: 'all' })
    expect(all).toMatchObject({ base: null, files: [], ahead: 0, behind: 0 })
    expect(all.error).toBeUndefined()

    const uncommitted = await computeSnapshot(fakeDeps(noBase, featFiles).deps, {
      cwd: ROOT,
      mode: 'uncommitted',
    })
    expect(uncommitted.base).toBeNull()
    expect(uncommitted.files.map(f => f.path)).toEqual(['a.txt', 'dir/ubin.bin', 'keep.txt', 'untracked.md'])
  })

  test('an override is used and named as such', async () => {
    const { deps } = fakeDeps(
      featTable({
        'rev-parse --verify --quiet main~0^{commit}': ok(`${MAIN_SHA}\n`),
        'merge-base main~0 HEAD': ok(`${MB}\n`),
        'rev-list --left-right --count main~0...HEAD': ok('1\t1\n'),
      }),
      featFiles,
    )
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'all', baseOverride: 'main~0' })
    expect(snapshot.base).toEqual({ ref: 'main~0', source: 'override', mergeBase: MB })
  })

  test('a bad override is an error, not a rejection', async () => {
    const { deps } = fakeDeps(featTable({ 'rev-parse --verify --quiet nope^{commit}': NOT_A_COMMIT }))
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'all', baseOverride: 'nope' })
    expect(snapshot.error).toMatch(/Base override "nope"/)
    expect(snapshot).toMatchObject({ isRepo: true, branch: 'feat', base: null, files: [] })
  })

  test('unrelated histories: no merge-base is an error', async () => {
    const { deps } = fakeDeps(featTable({ 'merge-base main HEAD': fail(1, '') }))
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'all' })
    expect(snapshot.error).toBe('No common ancestor between main and HEAD')
    expect(snapshot.base).toBeNull()
  })

  // An orphan worktree (`git worktree add --orphan`) after a commit and an edit.
  test('no merge-base: uncommitted still lists HEAD to the working tree, beside the error', async () => {
    const { deps } = fakeDeps(featTable({ 'merge-base main HEAD': fail(1, '') }), featFiles)
    const snapshot = await computeSnapshot(deps, { cwd: ROOT, mode: 'uncommitted' })
    expect(snapshot.error).toBe('No common ancestor between main and HEAD')
    expect(snapshot.base).toBeNull()
    expect(snapshot.files.map(f => f.path)).toEqual(['a.txt', 'dir/ubin.bin', 'keep.txt', 'untracked.md'])
    expect(summaryText(snapshot)).toContain('M a.txt  +1 -0')
  })

  test('git before 2.31 echoes --path-format: a linked worktree is told by its git dir', async () => {
    expect(isLinked(`${REPO}/.git/worktrees/t1-wt\n${REPO}/.git\n`)).toBe(true)
    expect(isLinked(`${REPO}/.git\n${REPO}/.git\n`)).toBe(false)
    expect(isLinked('--path-format=absolute\n.git\n.git\n')).toBe(false)
    expect(isLinked(`--path-format=absolute\n${REPO}/.git/worktrees/t1-wt\n${REPO}/.git\n`)).toBe(true)
    expect(isLinked('--path-format=absolute\n/abs/sub/.git/modules/m\n.git\n')).toBe(false)

    const { deps } = fakeDeps(
      featTable({
        'rev-parse --path-format=absolute --git-dir --git-common-dir': ok('--path-format=absolute\n.git\n.git\n'),
      }),
      featFiles,
    )
    expect((await computeSnapshot(deps, { cwd: ROOT, mode: 'all' })).isLinkedWorktree).toBe(false)
  })

  test('a failing diff and a runner that rejects both land in error', async () => {
    const failing = await computeSnapshot(
      fakeDeps(featTable({ [`diff --numstat -z -M ${MB} --`]: fail(128, 'fatal: bad object\n') })).deps,
      { cwd: ROOT, mode: 'all' },
    )
    expect(failing.error).toBe('git diff failed: fatal: bad object')

    const timedOut = await computeSnapshot(
      fakeDeps(
        featTable({
          'rev-list --left-right --count main...HEAD': () => Promise.reject(new Error('timed out after 15000 ms')),
        }),
        featFiles,
      ).deps,
      { cwd: ROOT, mode: 'all' },
    )
    expect(timedOut.error).toBe('timed out after 15000 ms')
    expect(timedOut.signature).toMatch(/^[0-9a-f]+$/)
  })
})

// -------------------------------------------------------------- file diff

describe('loadFileDiff', () => {
  const snapshotOf = async (mode: Snapshot['mode']) =>
    computeSnapshot(fakeDeps(featTable(), featFiles).deps, { cwd: ROOT, mode })

  test('a tracked file in all mode: merge-base to the working tree', async () => {
    const snapshot = await snapshotOf('all')
    const { deps, calls } = fakeDeps({ [`diff -M ${MB} -- :(literal)a.txt`]: ok(DIFF_A_ALL) })
    const diff = await loadFileDiff(deps, snapshot, file('a.txt', { added: 3, removed: 1, layer: 'both' }))

    expect(diff).toEqual({
      hunks: '@@ -1,3 +1,5 @@\n line1\n-line2\n+LINE2\n line3\n+line4\n+extra',
      isBinary: false,
      omittedLines: 0,
      signature: snapshot.signature,
    })
    expect(calls[0]?.cwd).toBe(ROOT)
  })

  test('committed and uncommitted pick their revisions', async () => {
    const committed = await snapshotOf('committed')
    const one = fakeDeps({ [`diff -M ${MB} HEAD -- :(literal)gone.txt`]: ok(DIFF_GONE) })
    expect((await loadFileDiff(one.deps, committed, file('gone.txt', { status: 'D' }))).hunks).toBe(
      '@@ -1,2 +0,0 @@\n-del\n-me',
    )

    const uncommitted = await snapshotOf('uncommitted')
    const two = fakeDeps({ 'diff -M HEAD -- :(literal)a.txt': ok(DIFF_A_HEAD) })
    expect((await loadFileDiff(two.deps, uncommitted, file('a.txt'))).hunks).toBe(
      '@@ -2,3 +2,4 @@ line1\n LINE2\n line3\n line4\n+extra',
    )
  })

  test('a rename names both paths', async () => {
    const snapshot = await snapshotOf('all')
    const { deps } = fakeDeps({
      [`diff -M ${MB} -- :(literal)src/new näme.txt :(literal)src/old name.txt`]: ok(DIFF_RENAME),
    })
    const diff = await loadFileDiff(
      deps,
      snapshot,
      file('src/new näme.txt', { status: 'R', oldPath: 'src/old name.txt' }),
    )
    expect(diff.hunks).toBe('@@ -18,3 +18,4 @@ row 17\n row 18\n row 19\n row 20\n+row 21')
  })

  test('an untracked file: --no-index against /dev/null, exit 1 is normal', async () => {
    const snapshot = await snapshotOf('all')
    const { deps } = fakeDeps({
      'diff --no-index -- /dev/null untracked.md': { exitCode: 1, stdout: DIFF_UNTRACKED_MD },
    })
    const diff = await loadFileDiff(deps, snapshot, file('untracked.md', { status: '?', layer: 'uncommitted' }))
    expect(diff).toMatchObject({ hunks: '@@ -0,0 +1,3 @@\n+u1\n+u2\n+u3', isBinary: false })
    expect(diff.error).toBeUndefined()
  })

  test('an untracked file gone meanwhile is an error', async () => {
    const snapshot = await snapshotOf('all')
    const { deps } = fakeDeps({
      'diff --no-index -- /dev/null missing.md': fail(1, "error: Could not access 'missing.md'\n"),
    })
    const diff = await loadFileDiff(deps, snapshot, file('missing.md', { status: '?' }))
    expect(diff.error).toBe("git diff failed: error: Could not access 'missing.md'")
  })

  test('binary: known from numstat without running git, or from the diff', async () => {
    const snapshot = await snapshotOf('all')
    const none = fakeDeps({})
    expect(await loadFileDiff(none.deps, snapshot, file('bin.dat', { isBinary: true }))).toMatchObject({
      hunks: '',
      isBinary: true,
    })
    expect(none.calls).toHaveLength(0)

    const { deps } = fakeDeps({
      'diff --no-index -- /dev/null dir/ubin.bin': { exitCode: 1, stdout: DIFF_UNTRACKED_BIN },
    })
    expect((await loadFileDiff(deps, snapshot, file('dir/ubin.bin', { status: '?' }))).isBinary).toBe(true)
  })

  test('a long diff is cut and says how much is left', async () => {
    const snapshot = await snapshotOf('all')
    const body = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join('\n')
    const { deps } = fakeDeps({
      [`diff -M ${MB} -- :(literal)big.txt`]: ok(
        `diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,1000 @@\n${body}\n`,
      ),
    })
    const diff = await loadFileDiff(deps, snapshot, file('big.txt', { status: 'A' }))
    expect(diff.hunks.split('\n')).toHaveLength(400)
    expect(diff.hunks.startsWith('@@ -0,0 +1,399 @@\n+line 0\n')).toBe(true)
    expect(diff.omittedLines).toBe(601)
  })

  test('git failing is an error, and no base in all mode is too', async () => {
    const snapshot = await snapshotOf('all')
    const { deps } = fakeDeps({})
    expect((await loadFileDiff(deps, snapshot, file('a.txt'))).error).toMatch(/^git diff failed: fatal: unmocked/)

    const baseless = { ...snapshot, base: null }
    expect((await loadFileDiff(deps, baseless, file('a.txt'))).error).toBe('No base to diff against')
  })
})

// ---------------------------------------------------------------- summary

describe('summaryText', () => {
  test('the feat worktree in all mode', async () => {
    const snapshot = await computeSnapshot(fakeDeps(featTable(), featFiles).deps, { cwd: ROOT, mode: 'all' })
    expect(summaryText(snapshot)).toBe(
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
  })

  test('committed mode carries no layer marks; a cap says what it left out', async () => {
    const snapshot = await computeSnapshot(fakeDeps(featTable(), featFiles).deps, {
      cwd: ROOT,
      mode: 'committed',
      maxFiles: 1,
    })
    expect(summaryText(snapshot).split('\n').slice(2)).toEqual(['M a.txt  +2 -1', '… 3 more files'])
  })

  test('the empty states', async () => {
    const notRepo = await computeSnapshot(fakeDeps({ 'rev-parse --show-toplevel': NOT_A_REPO }).deps, {
      cwd: '/w/x',
      mode: 'all',
    })
    expect(summaryText(notRepo)).toBe('Not a git repository: /w/x')

    const clean = await computeSnapshot(
      fakeDeps(
        featTable({
          [`diff --numstat -z -M ${MB} --`]: ok(''),
          [`diff --name-status -z -M ${MB} --`]: ok(''),
          'ls-files --others --exclude-standard -z': ok(''),
        }),
      ).deps,
      { cwd: ROOT, mode: 'all' },
    )
    expect(summaryText(clean).split('\n').at(-1)).toBe('No changes vs main')

    const cleanWorktree = await computeSnapshot(
      fakeDeps(
        featTable({
          'diff --numstat -z -M HEAD --': ok(''),
          'diff --name-status -z -M HEAD --': ok(''),
          'ls-files --others --exclude-standard -z': ok(''),
        }),
      ).deps,
      { cwd: ROOT, mode: 'uncommitted' },
    )
    expect(summaryText(cleanWorktree).split('\n').at(-1)).toBe('No uncommitted changes')

    const empty = await computeSnapshot(
      fakeDeps({
        'rev-parse --show-toplevel': ok('/w/e\n'),
        'rev-parse --path-format=absolute --git-dir --git-common-dir': ok('/w/e/.git\n/w/e/.git\n'),
        'symbolic-ref --short -q HEAD': ok('main\n'),
        'rev-parse --verify --quiet --short HEAD': NOT_A_COMMIT,
      }).deps,
      { cwd: '/w/e', mode: 'all' },
    )
    expect(summaryText(empty)).toBe('main\nNo commits yet.')

    const failing = await computeSnapshot(
      fakeDeps(featTable({ 'merge-base main HEAD': fail(1, '') })).deps,
      { cwd: ROOT, mode: 'all' },
    )
    expect(summaryText(failing)).toBe('feat\nError: No common ancestor between main and HEAD')
  })

  test('no base names the command that sets one', async () => {
    const snapshot: Snapshot = {
      ...(await computeSnapshot(fakeDeps(featTable(), featFiles).deps, { cwd: ROOT, mode: 'all' })),
      base: null,
      files: [],
    }
    expect(summaryText(snapshot)).toBe('feat\nNo base branch found. Set one with /wt-diff base <ref>.')
  })
})

describe('git helper', () => {
  test('prefixes every call; hardens diff only', async () => {
    const seen: string[][] = []
    const deps: GitDeps = {
      run: async argv => {
        seen.push(argv)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      readText: async () => null,
      fileInfo: async () => null,
      now: async () => 0,
    }
    await git(deps, '/w', ['status'])
    await git(deps, '/w', ['diff', '--stat'])
    expect(seen).toEqual([
      ['git', '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false', '--no-optional-locks', 'status'],
      ['git', '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--stat'],
    ])
  })
})
