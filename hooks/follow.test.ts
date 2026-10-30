import { describe, expect, test } from 'claude-code/testing'

import {
  bashFollowPath,
  followPath,
  isFollowable,
  leadingCdTargets,
  normalizePath,
  parentDir,
  pickTarget,
  resolvePath,
} from './follow'

const HOME = '/Users/me'
const CWD = '/repo/main'

describe('normalizePath', () => {
  test('drops empty and . segments, folds .., never climbs above the root', async () => {
    expect(normalizePath('/a/./b/../c/')).toBe('/a/c')
    expect(normalizePath('//a//b')).toBe('/a/b')
    expect(normalizePath('/a/../../..')).toBe('/')
    expect(normalizePath('/')).toBe('/')
  })
  test('leaves a path that is not absolute unchanged', async () => {
    expect(normalizePath('a/../b')).toBe('a/../b')
    expect(normalizePath('')).toBe('')
  })
})

describe('resolvePath', () => {
  test('an absolute path stands, normalised', async () => {
    expect(resolvePath('/x/y/../z', CWD, HOME)).toBe('/x/z')
  })

  test('a relative path resolves from the base', async () => {
    expect(resolvePath('wt', CWD, HOME)).toBe('/repo/main/wt')
    expect(resolvePath('../wt-a', CWD, HOME)).toBe('/repo/wt-a')
    expect(resolvePath('./a/./b/..', CWD, HOME)).toBe('/repo/main/a')
    expect(resolvePath('.', CWD, HOME)).toBe(CWD)
  })

  test('~ and ~/ expand to home; ~user does not resolve', async () => {
    expect(resolvePath('~', CWD, HOME)).toBe(HOME)
    expect(resolvePath('~/code/wt', CWD, HOME)).toBe('/Users/me/code/wt')
    expect(resolvePath('~other/x', CWD, HOME)).toBeNull()
  })

  test('null without what it needs', async () => {
    expect(resolvePath('~/x', CWD, '')).toBeNull()
    expect(resolvePath('wt', '', HOME)).toBeNull()
    expect(resolvePath('wt', 'relative/base', HOME)).toBeNull()
  })
})

describe('parentDir', () => {
  test('the directory above, the root for a top-level entry', async () => {
    expect(parentDir('/a/b/c.ts')).toBe('/a/b')
    expect(parentDir('/c.ts')).toBe('/')
  })
})

describe('leadingCdTargets', () => {
  test('one cd, then anything', async () => {
    expect(leadingCdTargets('cd /wt && npm test')).toEqual(['/wt'])
    expect(leadingCdTargets('cd /wt; git status | head -5 > out.txt')).toEqual(['/wt'])
    expect(leadingCdTargets('cd /wt')).toEqual(['/wt'])
    expect(leadingCdTargets('  cd /wt  &&  ls')).toEqual(['/wt'])
    expect(leadingCdTargets('cd /wt&&ls')).toEqual(['/wt'])
  })

  test('a chain gives every target in order', async () => {
    expect(leadingCdTargets('cd a && cd b && npm test')).toEqual(['a', 'b'])
    expect(leadingCdTargets('cd a; pushd b; make')).toEqual(['a', 'b'])
    expect(leadingCdTargets('cd a\ncd b\nmake')).toEqual(['a', 'b'])
    expect(leadingCdTargets('cd a &&\n  cd b &&\n  make')).toEqual(['a', 'b'])
  })

  test('the chain stops at the first other command, whatever follows it', async () => {
    expect(leadingCdTargets('cd a && echo $HOME && cd b')).toEqual(['a'])
    expect(leadingCdTargets('cd a && (cd b && make)')).toEqual(['a'])
    expect(leadingCdTargets('cd a && FOO=1 cd b')).toEqual(['a'])
    expect(leadingCdTargets('cd a; # then build')).toEqual(['a'])
  })

  test('quotes and escapes come off', async () => {
    expect(leadingCdTargets("cd '/my dir/$x' && ls")).toEqual(['/my dir/$x'])
    expect(leadingCdTargets('cd "/my dir/wt" && ls')).toEqual(['/my dir/wt'])
    expect(leadingCdTargets('cd /my\\ dir && ls')).toEqual(['/my dir'])
    expect(leadingCdTargets('cd "/a\\"b\\\\c\\d"')).toEqual(['/a"b\\c\\d'])
    expect(leadingCdTargets("cd /a/'b c'/d")).toEqual(['/a/b c/d'])
  })

  test('~ stays to expand unquoted; quoted it is a directory named ~', async () => {
    expect(leadingCdTargets('cd ~/wt && ls')).toEqual(['~/wt'])
    expect(leadingCdTargets('cd ~')).toEqual(['~'])
    expect(leadingCdTargets('cd "~/wt"')).toEqual(['./~/wt'])
    expect(leadingCdTargets('cd \\~')).toEqual(['./~'])
    expect(leadingCdTargets('cd a~b')).toEqual(['a~b'])
  })

  test('-- and -L/-P options; a bare cd goes home', async () => {
    expect(leadingCdTargets('cd -- -odd && ls')).toEqual(['-odd'])
    expect(leadingCdTargets('cd -P /wt')).toEqual(['/wt'])
    expect(leadingCdTargets('cd -L -- /wt')).toEqual(['/wt'])
    expect(leadingCdTargets('pushd -- /wt')).toEqual(['/wt'])
    expect(leadingCdTargets('cd && ls')).toEqual(['~'])
  })

  test('gives up on an expansion anywhere in the chain', async () => {
    expect(leadingCdTargets('cd $WT && ls')).toEqual([])
    expect(leadingCdTargets('cd ${WT}/x')).toEqual([])
    expect(leadingCdTargets('cd "$WT"')).toEqual([])
    expect(leadingCdTargets('cd $(git rev-parse --show-toplevel)')).toEqual([])
    expect(leadingCdTargets('cd "`pwd`/x"')).toEqual([])
    expect(leadingCdTargets('cd `pwd`')).toEqual([])
    expect(leadingCdTargets('cd /wt* && ls')).toEqual([])
    expect(leadingCdTargets('cd /w?')).toEqual([])
    expect(leadingCdTargets('cd /w[tx]')).toEqual([])
    expect(leadingCdTargets('cd /{a,b}')).toEqual([])
    expect(leadingCdTargets('cd /a && cd $B && ls')).toEqual([])
  })

  test('gives up on any shell operator other than && ; and newline after a cd', async () => {
    expect(leadingCdTargets('cd /wt || exit 1')).toEqual([])
    expect(leadingCdTargets('cd /wt | cat')).toEqual([])
    expect(leadingCdTargets('cd /wt |& cat')).toEqual([])
    expect(leadingCdTargets('cd /wt & ls')).toEqual([])
    expect(leadingCdTargets('cd /wt 2>/dev/null && ls')).toEqual([])
    expect(leadingCdTargets('cd /wt >/dev/null')).toEqual([])
    expect(leadingCdTargets('cd /wt < x')).toEqual([])
    expect(leadingCdTargets('cd /wt;; ls')).toEqual([])
    expect(leadingCdTargets('cd /a && cd /b || true')).toEqual([])
    expect(leadingCdTargets('cd /wt # go')).toEqual([])
  })

  test('gives up on a cd it cannot place', async () => {
    expect(leadingCdTargets('cd - && ls')).toEqual([])
    expect(leadingCdTargets('cd a b')).toEqual([])
    expect(leadingCdTargets('cd ""')).toEqual([])
    expect(leadingCdTargets('cd -e /wt')).toEqual([])
    expect(leadingCdTargets('pushd')).toEqual([])
    expect(leadingCdTargets('pushd +1')).toEqual([])
    expect(leadingCdTargets('pushd -2')).toEqual([])
    expect(leadingCdTargets('pushd -n /wt')).toEqual([])
    expect(leadingCdTargets("cd '/unclosed")).toEqual([])
    expect(leadingCdTargets('cd "/unclosed')).toEqual([])
    expect(leadingCdTargets('cd /wt \\\n && ls')).toEqual([])
    expect(leadingCdTargets('cd /wt\\')).toEqual([])
  })

  test('nothing when the command does not start with cd', async () => {
    expect(leadingCdTargets('npm test')).toEqual([])
    expect(leadingCdTargets('ls && cd /wt')).toEqual([])
    expect(leadingCdTargets('git -C /wt status')).toEqual([])
    expect(leadingCdTargets('(cd /wt && make)')).toEqual([])
    expect(leadingCdTargets('builtin cd /wt')).toEqual([])
    expect(leadingCdTargets('cdx /wt')).toEqual([])
    expect(leadingCdTargets('$CD /wt')).toEqual([])
    expect(leadingCdTargets('# cd /wt')).toEqual([])
    expect(leadingCdTargets('')).toEqual([])
    expect(leadingCdTargets('   \n ')).toEqual([])
  })
})

describe('bashFollowPath', () => {
  test('relative from the session cwd, each step from the one before', async () => {
    expect(bashFollowPath('cd ../wt-a && npm test', CWD, HOME)).toBe('/repo/wt-a')
    expect(bashFollowPath('cd /repo && cd wt-b && make', CWD, HOME)).toBe('/repo/wt-b')
    expect(bashFollowPath('cd /a && cd /b', CWD, HOME)).toBe('/b')
    expect(bashFollowPath('cd ~/wt && ls', CWD, HOME)).toBe('/Users/me/wt')
    expect(bashFollowPath('cd', CWD, HOME)).toBe(HOME)
    expect(bashFollowPath('cd "~"', CWD, HOME)).toBe('/repo/main/~')
  })

  test('null when there is no chain or a step does not resolve', async () => {
    expect(bashFollowPath('npm test', CWD, HOME)).toBeNull()
    expect(bashFollowPath('cd $WT', CWD, HOME)).toBeNull()
    expect(bashFollowPath('cd ~bob/wt', CWD, HOME)).toBeNull()
    expect(bashFollowPath('cd /a && cd ~bob', CWD, HOME)).toBeNull()
    expect(bashFollowPath('cd ~/wt', CWD, '')).toBeNull()
  })
})

describe('followPath', () => {
  test('a file tool points at its file\'s directory', async () => {
    expect(followPath('Edit', { file_path: '/repo/wt-a/src/a.ts', old_string: 'a', new_string: 'b' }, CWD, HOME)).toBe(
      '/repo/wt-a/src',
    )
    expect(followPath('Write', { file_path: '/repo/wt-a/new.md', content: '' }, CWD, HOME)).toBe('/repo/wt-a')
    expect(followPath('MultiEdit', { file_path: '/repo/wt-b/x/../y/z.ts', edits: [] }, CWD, HOME)).toBe(
      '/repo/wt-b/y',
    )
    expect(followPath('NotebookEdit', { notebook_path: '/repo/wt-c/nb.ipynb', new_source: '' }, CWD, HOME)).toBe(
      '/repo/wt-c',
    )
  })

  test('a relative or ~ file path resolves first', async () => {
    expect(followPath('Edit', { file_path: 'src/a.ts' }, CWD, HOME)).toBe('/repo/main/src')
    expect(followPath('Write', { file_path: '~/.claude/notes.md' }, CWD, HOME)).toBe('/Users/me/.claude')
  })

  test('Bash follows its leading cd chain', async () => {
    expect(followPath('Bash', { command: 'cd ../wt-a && npm test' }, CWD, HOME)).toBe('/repo/wt-a')
    expect(followPath('Bash', { command: 'npm test' }, CWD, HOME)).toBeNull()
  })

  test('null for other tools and unreadable input', async () => {
    expect(followPath('Read', { file_path: '/repo/wt-a/a.ts' }, CWD, HOME)).toBeNull()
    expect(followPath('Grep', { pattern: 'x', path: '/repo/wt-a' }, CWD, HOME)).toBeNull()
    expect(followPath('EnterWorktree', { path: '/repo/wt-a' }, CWD, HOME)).toBeNull()
    expect(followPath('Edit', {}, CWD, HOME)).toBeNull()
    expect(followPath('Edit', { file_path: 42 }, CWD, HOME)).toBeNull()
    expect(followPath('Edit', { file_path: '' }, CWD, HOME)).toBeNull()
    expect(followPath('NotebookEdit', { file_path: '/repo/wt-a/nb.ipynb' }, CWD, HOME)).toBeNull()
    expect(followPath('Bash', { command: ['cd', '/wt'] }, CWD, HOME)).toBeNull()
    expect(followPath('Edit', { file_path: '~bob/a.ts' }, CWD, HOME)).toBeNull()
  })
})

describe('pickTarget', () => {
  test('pinned, then followed, then the session cwd', async () => {
    expect(pickTarget('/repo/pin', '/repo/follow', CWD)).toBe('/repo/pin')
    expect(pickTarget(null, '/repo/follow', CWD)).toBe('/repo/follow')
    expect(pickTarget(undefined, undefined, CWD)).toBe(CWD)
    expect(pickTarget('/repo/pin', null, CWD)).toBe('/repo/pin')
    expect(pickTarget(null, null, CWD)).toBe(CWD)
  })
})

describe('isFollowable', () => {
  test('only a worktree of the session repository', async () => {
    expect(isFollowable('/repo/main/.git', '/repo/main/.git')).toBe(true)
    expect(isFollowable('/repo/main/.git/', '/repo/main/./.git')).toBe(true)
    expect(isFollowable('/Users/me/.claude/.git', '/repo/main/.git')).toBe(false)
  })

  test('any repository when the session is in none', async () => {
    expect(isFollowable('/elsewhere/.git', null)).toBe(true)
    expect(isFollowable('/elsewhere/.git', '')).toBe(true)
  })

  test('never a path outside any repository', async () => {
    expect(isFollowable(null, '/repo/main/.git')).toBe(false)
    expect(isFollowable('', null)).toBe(false)
  })
})
