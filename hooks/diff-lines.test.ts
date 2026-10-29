import { describe, expect, test } from 'claude-code/testing'

import { addedSource, cleanLine, expandTabs, isPureAdd, parseHunks, type DiffLine } from './diff-lines'
import { splitHunks, truncateHunks } from './git'

// Real `git diff` output (as loadFileDiff runs it), fed through splitHunks
// the way loadFileDiff does, so the input is exactly what the pane gets.
const MODIFIED = [
  'diff --git a/mod.txt b/mod.txt',
  'index b64b08c..5bbfd10 100644',
  '--- a/mod.txt',
  '+++ b/mod.txt',
  '@@ -1,5 +1,5 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  ' d',
  ' e',
  '@@ -15,6 +15,7 @@ n',
  ' o',
  ' p',
  ' q',
  '-r',
  '+R',
  ' s',
  ' t',
  '+u',
  '',
].join('\n')

const TABS = [
  'diff --git a/tabs.txt b/tabs.txt',
  'index 1382e34..b48a1ae 100644',
  '--- a/tabs.txt',
  '+++ b/tabs.txt',
  '@@ -1,3 +1,4 @@',
  ' line1',
  ' \tindented',
  '+\t\tdeeper',
  ' line3',
  '',
].join('\n')

const NO_NEWLINE = [
  'diff --git a/nonl.txt b/nonl.txt',
  'index 20cbb4d..0ba6e66 100644',
  '--- a/nonl.txt',
  '+++ b/nonl.txt',
  '@@ -1 +1 @@',
  '-no newline',
  '\\ No newline at end of file',
  '+no newline changed',
  '\\ No newline at end of file',
  '',
].join('\n')

// diff.suppressBlankEmpty=false keeps a blank context line's space.
const BLANK_CONTEXT = [
  'diff --git a/blank.txt b/blank.txt',
  'index f7d4fc4..061ecc5 100644',
  '--- a/blank.txt',
  '+++ b/blank.txt',
  '@@ -1,3 +1,3 @@',
  ' x',
  ' ',
  '-y',
  '+Y',
  '',
].join('\n')

const DELETED = [
  'diff --git a/del.txt b/del.txt',
  'deleted file mode 100644',
  'index d3bc718..0000000',
  '--- a/del.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone',
  '-bye',
  '',
].join('\n')

const STAGED_NEW = [
  'diff --git a/added.txt b/added.txt',
  'new file mode 100644',
  'index 0000000..814f4a4',
  '--- /dev/null',
  '+++ b/added.txt',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '',
].join('\n')

// An untracked file, from `git diff --no-index -- /dev/null newfile.txt`.
const UNTRACKED = [
  'diff --git a/newfile.txt b/newfile.txt',
  'new file mode 100644',
  'index 0000000..70cc0a6',
  '--- /dev/null',
  '+++ b/newfile.txt',
  '@@ -0,0 +1,3 @@',
  '+hello',
  '+\tworld',
  '+end',
  '\\ No newline at end of file',
  '',
].join('\n')

// An empty untracked file: a header and no hunk at all.
const EMPTY_NEW = [
  'diff --git a/empty.txt b/empty.txt',
  'new file mode 100644',
  'index 0000000..e69de29',
  '',
].join('\n')

const kinds = (lines: DiffLine[]) => lines.map(l => `${l.kind}:${l.text}`)

describe('parseHunks', () => {
  test('types each line by its marker and drops the marker', async () => {
    expect(kinds(parseHunks(splitHunks(MODIFIED)))).toEqual([
      'hunk:@@ -1,5 +1,5 @@',
      'ctx:a',
      'del:b',
      'add:B',
      'ctx:c',
      'ctx:d',
      'ctx:e',
      'hunk:@@ -15,6 +15,7 @@ n',
      'ctx:o',
      'ctx:p',
      'ctx:q',
      'del:r',
      'add:R',
      'ctx:s',
      'ctx:t',
      'add:u',
    ])
  })

  test('a header carries the new start and its function context', async () => {
    const headers = parseHunks(splitHunks(MODIFIED)).filter(l => l.kind === 'hunk')
    expect(headers).toEqual([
      { kind: 'hunk', oldStart: 1, newStart: 1, text: '@@ -1,5 +1,5 @@' },
      { kind: 'hunk', oldStart: 15, newStart: 15, ctx: 'n', text: '@@ -15,6 +15,7 @@ n' },
    ])
    expect(parseHunks('@@ -12,7 +12,8 @@ export async function getSession(req) {')[0]).toEqual({
      kind: 'hunk',
      oldStart: 12,
      newStart: 12,
      ctx: 'export async function getSession(req) {',
      text: '@@ -12,7 +12,8 @@ export async function getSession(req) {',
    })
  })

  test('a CR or U+2028 in the function context keeps the header parsed', async () => {
    expect(parseHunks('@@ -3 +3 @@ a\rb')[0]).toEqual({ kind: 'hunk', oldStart: 3, newStart: 3, ctx: 'a�b', text: '@@ -3 +3 @@ a�b' })
    expect(parseHunks('@@ -3 +7 @@ a\u2028b')[0]).toMatchObject({ newStart: 7, ctx: 'a\u2028b' })
  })

  test('single-line headers without counts parse', async () => {
    expect(parseHunks(splitHunks(NO_NEWLINE))).toEqual([
      { kind: 'hunk', oldStart: 1, newStart: 1, text: '@@ -1 +1 @@' },
      { kind: 'del', text: 'no newline' },
      { kind: 'meta', text: '\\ No newline at end of file' },
      { kind: 'add', text: 'no newline changed' },
      { kind: 'meta', text: '\\ No newline at end of file' },
    ])
  })

  test('a blank context line stays an empty context line', async () => {
    expect(kinds(parseHunks(splitHunks(BLANK_CONTEXT)))).toEqual([
      'hunk:@@ -1,3 +1,3 @@',
      'ctx:x',
      'ctx:',
      'del:y',
      'add:Y',
    ])
  })

  test('tabs expand to stops of four after the marker', async () => {
    expect(kinds(parseHunks(splitHunks(TABS)))).toEqual([
      'hunk:@@ -1,3 +1,4 @@',
      'ctx:line1',
      'ctx:    indented',
      'add:        deeper',
      'ctx:line3',
    ])
    expect(expandTabs('ab\tc\t\td')).toBe('ab  c       d')
    expect(expandTabs('none')).toBe('none')
  })

  test('a wide character before a tab counts two columns', async () => {
    // The x lands on the stop an editor puts it on: cell 4, then cell 8.
    expect(expandTabs('中\tx')).toBe('中  x')
    expect(expandTabs('中文\tx')).toBe('中文    x')
    expect(expandTabs('abcd\tx')).toBe('abcd    x')
    expect(expandTabs('a中\tx')).toBe('a中 x')
    expect(kinds(parseHunks('@@ -1 +1 @@\n-中\tx\n+中文\tx'))).toEqual(['hunk:@@ -1 +1 @@', 'del:中  x', 'add:中文    x'])
  })

  test('control characters are replaced, a CRLF loses its CR', async () => {
    expect(parseHunks('@@ -1 +1 @@\n-old\r\n+a\u001b[31mred\u0007\r')).toEqual([
      { kind: 'hunk', oldStart: 1, newStart: 1, text: '@@ -1 +1 @@' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'a�[31mred�' },
    ])
    expect(cleanLine('a\rb\u007fc\u0085')).toBe('a�b�c�')
  })

  test('a deleted file is one hunk of removals', async () => {
    expect(kinds(parseHunks(splitHunks(DELETED)))).toEqual(['hunk:@@ -1,2 +0,0 @@', 'del:gone', 'del:bye'])
    expect(parseHunks(splitHunks(DELETED))[0]).toMatchObject({ oldStart: 1, newStart: 0 })
  })

  test('a hunk leaving nothing on the new side keeps its old start', async () => {
    // A tracked file emptied, or its top line dropped with no context.
    expect(parseHunks('@@ -1,2 +0,0 @@\n-a\n-b')[0]).toMatchObject({ oldStart: 1, newStart: 0 })
    expect(parseHunks('@@ -7 +6,0 @@\n-x')[0]).toMatchObject({ oldStart: 7, newStart: 6 })
  })

  test('a header truncateHunks rewrote still parses, a cut line keeps its marker', async () => {
    const { hunks } = truncateHunks(splitHunks(MODIFIED), 10)
    expect(kinds(parseHunks(hunks))).toEqual([
      'hunk:@@ -1,5 +1,5 @@',
      'ctx:a',
      'del:b',
      'add:B',
      'ctx:c',
      'ctx:d',
      'ctx:e',
      'hunk:@@ -15,2 +15,2 @@ n',
      'ctx:o',
      'ctx:p',
    ])
    const long = `@@ -0,0 +1 @@\n+${'x'.repeat(200)}`
    const cut = parseHunks(truncateHunks(long, 400, 50).hunks)
    expect(cut[1]?.kind).toBe('add')
    expect(cut[1]?.text.endsWith('…')).toBe(true)
  })

  test('malformed input never throws: unknown lines are context, a bad header has no start', async () => {
    expect(parseHunks('')).toEqual([])
    expect(parseHunks('\n')).toEqual([{ kind: 'ctx', text: '' }])
    expect(parseHunks('@@ garbage @@\nplain text\n+x')).toEqual([
      { kind: 'hunk', text: '@@ garbage @@' },
      { kind: 'ctx', text: 'plain text' },
      { kind: 'add', text: 'x' },
    ])
    expect(parseHunks('@@ -1 +99999999999999999999 @@')[0]).toEqual({
      kind: 'hunk',
      oldStart: 1,
      text: '@@ -1 +99999999999999999999 @@',
    })
    expect(parseHunks('@@')).toEqual([{ kind: 'hunk', text: '@@' }])
    expect(parseHunks(undefined as unknown as string)).toEqual([])
    expect(parseHunks(null as unknown as string)).toEqual([])
  })

  test('a trailing newline makes no empty last line', async () => {
    expect(kinds(parseHunks('@@ -1 +1 @@\n+a\n'))).toEqual(['hunk:@@ -1 +1 @@', 'add:a'])
  })
})

describe('isPureAdd / addedSource', () => {
  test('a staged new file is a pure add; its source loses the markers', async () => {
    const hunks = splitHunks(STAGED_NEW)
    expect(isPureAdd(hunks)).toBe(true)
    expect(addedSource(hunks)).toBe('one\ntwo')
  })

  test('an untracked file without a final newline: the meta line is not source', async () => {
    const hunks = splitHunks(UNTRACKED)
    expect(isPureAdd(hunks)).toBe(true)
    // Tabs stay: Code draws them itself.
    expect(addedSource(hunks)).toBe('hello\n\tworld\nend')
  })

  test('a blank added line stays a line', async () => {
    expect(addedSource('@@ -0,0 +1,3 @@\n+a\n+\n+b')).toBe('a\n\nb')
    expect(addedSource('@@ -0,0 +1 @@\n+only')).toBe('only')
  })

  test('a truncated pure add is still one', async () => {
    const full = `@@ -0,0 +1,500 @@\n${Array.from({ length: 500 }, (_, i) => `+line ${i + 1}`).join('\n')}`
    const { hunks, omittedLines } = truncateHunks(full)
    expect(omittedLines).toBeGreaterThan(0)
    expect(isPureAdd(hunks)).toBe(true)
    const source = addedSource(hunks) ?? ''
    expect(source.startsWith('line 1\nline 2\n')).toBe(true)
    expect(source.split('\n').length).toBe(399)
  })

  test('control characters are replaced, CRs at line ends dropped', async () => {
    expect(addedSource('@@ -0,0 +1,2 @@\n+a\r\n+b\u001bc')).toBe('a\nb�c')
  })

  test('anything else is not a pure add', async () => {
    expect(isPureAdd(splitHunks(MODIFIED))).toBe(false)
    expect(isPureAdd(splitHunks(DELETED))).toBe(false)
    expect(isPureAdd(splitHunks(NO_NEWLINE))).toBe(false)
    expect(isPureAdd(splitHunks(EMPTY_NEW))).toBe(false)
    // Two hunks, the second not from an empty side.
    expect(isPureAdd('@@ -0,0 +1 @@\n+a\n@@ -0,0 +5 @@\n+b')).toBe(false)
    // A file that was empty and gained lines, but with context: not whole.
    expect(isPureAdd('@@ -0,0 +1,2 @@\n+a\n b')).toBe(false)
    expect(isPureAdd('@@ -0,0 +1 @@')).toBe(false)
    expect(isPureAdd('+a\n+b')).toBe(false)
    expect(isPureAdd('')).toBe(false)
    expect(addedSource(undefined as unknown as string)).toBe(null)
  })
})
