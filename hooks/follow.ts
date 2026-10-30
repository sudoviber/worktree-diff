// Pure logic for following the worktree Claude works in: which directory a
// tool call points at, how a path resolves, which worktree the pane shows
// and which ones it may follow. No $: register.tsx runs git and keeps state.

// ------------------------------------------------------------------ paths

/**
 * `/a/./b/../c/` → `/a/c`; `..` stops at the root. Only for absolute paths:
 * anything else comes back unchanged.
 */
export const normalizePath = (path: string): string => {
  if (!path.startsWith('/')) return path
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return `/${parts.join('/')}`
}

/**
 * `path` as an absolute, normalised path: `~` and `~/…` from `home`, a
 * relative path from `base`. Null for `~user`, or when what it needs
 * (`home`, an absolute `base`) is missing.
 */
export const resolvePath = (path: string, base: string, home: string): string | null => {
  if (path === '~' || path.startsWith('~/')) {
    if (!home.startsWith('/')) return null

    return normalizePath(`${home}/${path.slice(1)}`)
  }
  if (path.startsWith('~')) return null
  if (path.startsWith('/')) return normalizePath(path)
  if (!base.startsWith('/')) return null

  return normalizePath(`${base}/${path}`)
}

/** The directory holding an absolute, normalised path; `/` for the root. */
export const parentDir = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'

// ------------------------------------------------------------------- bash

type Word = { text: string; quoted: boolean }

const BLANK = new Set([' ', '\t'])
// Where an unquoted word ends.
const METACHAR = new Set(['|', '&', ';', '<', '>', '(', ')', '\n'])
// Expansions this parser does not perform: one of them, unquoted, gives up.
const EXPANDS = new Set(['$', '`', '*', '?', '[', '{'])

const skipBlanks = (text: string, at: number): number => {
  let i = at
  while (i < text.length && BLANK.has(text[i] as string)) i++

  return i
}

/**
 * One shell word from `at` (blanks before it skipped), quotes removed: the
 * word, or `empty` at a metacharacter or the end, or null for anything it
 * would have to expand or cannot close.
 */
const readWord = (command: string, at: number): { word: Word | 'empty'; next: number } | null => {
  let i = skipBlanks(command, at)
  let text = ''
  let quoted = false
  const start = i
  while (i < command.length) {
    const c = command[i] as string
    if (BLANK.has(c) || METACHAR.has(c)) break
    if (c === '#' && i === start) return null
    if (EXPANDS.has(c)) return null
    if (c === '\\') {
      const escaped = command[i + 1]
      if (escaped === undefined || escaped === '\n') return null
      text += escaped
      quoted = quoted || i === start
      i += 2
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return null
      text += command.slice(i + 1, end)
      quoted = quoted || i === start
      i = end + 1
      continue
    }
    if (c === '"') {
      const atQuote = i === start
      i++
      for (;;) {
        const d = command[i]
        if (d === undefined) return null
        if (d === '"') break
        if (d === '$' || d === '`') return null
        if (d === '\\') {
          const escaped = command[i + 1]
          if (escaped === undefined || escaped === '\n') return null
          // Inside double quotes a backslash escapes only these.
          if ('$`"\\'.includes(escaped)) {
            text += escaped
            i += 2
            continue
          }
        }
        text += d
        i++
      }
      quoted = quoted || atQuote
      i++
      continue
    }
    text += c
    i++
  }

  return { word: i === start ? 'empty' : { text, quoted }, next: i }
}

type Separator = 'and' | 'then' | 'end'

/** What follows a simple command: `&&`, `;` or a newline, the end, or null for anything else. */
const readSeparator = (command: string, at: number): { separator: Separator; next: number } | null => {
  const i = skipBlanks(command, at)
  if (i >= command.length) return { separator: 'end', next: i }
  if (command.startsWith('&&', i)) return { separator: 'and', next: i + 2 }
  if (command.startsWith(';;', i) || command.startsWith(';&', i)) return null
  if (command[i] === ';' || command[i] === '\n') return { separator: 'then', next: i + 1 }

  return null
}

/**
 * The directory one `cd` or `pushd` moves to, as written (`~` kept when it
 * would expand), or null when it cannot be told: `cd -`, options other than
 * `-L`/`-P`/`--`, a pushd stack move, more than one operand.
 */
const cdOperand = (name: string, args: Word[]): string | null => {
  let rest = args
  while (rest[0] !== undefined && rest[0].text.startsWith('-') && rest[0].text !== '-') {
    const option = rest[0].text
    rest = rest.slice(1)
    if (option === '--') break
    if (name !== 'cd' || !/^-[LP]+$/.test(option)) return null
  }
  if (rest.length > 1) return null
  const operand = rest[0]
  // A bare cd goes home; a bare pushd swaps the stack.
  if (operand === undefined) return name === 'cd' ? '~' : null
  if (operand.text === '' || operand.text === '-') return null
  if (name === 'pushd' && /^[+-]\d+$/.test(operand.text)) return null
  // A quoted `~` is a directory named `~`.
  if (operand.quoted && operand.text.startsWith('~')) return `./${operand.text}`

  return operand.text
}

/**
 * The targets of the `cd`/`pushd` commands a Bash command starts with,
 * in order: `cd a && cd 'b c'; pushd d && make` gives `a`, `b c`, `d`. Only
 * simple `cd X` commands joined by `&&`, `;` or newlines count, and the chain
 * stops at the first other command. Empty when the command does not start
 * with one, or when any of them cannot be read with certainty: an expansion
 * (`$VAR`, `$(…)`, backticks, globs, braces), a redirection, a pipe, `||`,
 * `&` or a subshell. CDPATH is not consulted.
 */
export const leadingCdTargets = (command: string): string[] => {
  const targets: string[] = []
  let at = 0
  for (;;) {
    // Blank lines between the commands are fine.
    while (at < command.length && (command[at] === '\n' || BLANK.has(command[at] as string))) at++
    const first = readWord(command, at)
    if (first === null || first.word === 'empty') return targets
    const name = first.word.text
    if (name !== 'cd' && name !== 'pushd') return targets
    const args: Word[] = []
    let next = first.next
    for (;;) {
      const read = readWord(command, next)
      if (read === null) return []
      next = read.next
      if (read.word === 'empty') break
      args.push(read.word)
    }
    const operand = cdOperand(name, args)
    const separator = readSeparator(command, next)
    if (operand === null || separator === null) return []
    targets.push(operand)
    if (separator.separator === 'end') return targets
    at = separator.next
  }
}

/**
 * Where the `cd` chain a Bash command starts with lands, each step from the
 * one before, the first from `cwd`; null when it has none or one cannot be
 * resolved.
 */
export const bashFollowPath = (command: string, cwd: string, home: string): string | null => {
  const targets = leadingCdTargets(command)
  if (targets.length === 0) return null
  let dir = cwd
  for (const target of targets) {
    const next = resolvePath(target, dir, home)
    if (next === null) return null
    dir = next
  }

  return dir
}

// ------------------------------------------------------------------ calls

// Compared by name: a build may not register every one of them.
const FILE_KEYS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * The directory a tool call points the pane at: a file tool's file's
 * directory, or where a Bash command's leading `cd` chain lands. Null for
 * other tools or input it cannot read.
 */
export const followPath = (tool: string, input: object, cwd: string, home: string): string | null => {
  const fields = input as Record<string, unknown>
  if (tool === 'Bash') {
    const command = fields['command']

    return typeof command === 'string' ? bashFollowPath(command, cwd, home) : null
  }
  const key = FILE_KEYS[tool]
  if (key === undefined) return null
  const path = fields[key]
  if (typeof path !== 'string' || path === '') return null
  const resolved = resolvePath(path, cwd, home)

  return resolved === null ? null : parentDir(resolved)
}

// ----------------------------------------------------------------- target

/** The worktree the pane shows: pinned, else followed, else the session's. */
export const pickTarget = (
  pinned: string | null | undefined,
  followed: string | null | undefined,
  sessionCwd: string,
): string => pinned ?? followed ?? sessionCwd

const sameDir = (a: string, b: string) => normalizePath(a) === normalizePath(b)

/**
 * Whether a worktree with git common dir `candidate` may be followed: one of
 * the session repository's worktrees, or any repository when the session is
 * not in one (`session` null). A candidate outside any repository never is.
 */
export const isFollowable = (candidate: string | null, session: string | null): boolean => {
  if (candidate === null || candidate === '') return false
  if (session === null || session === '') return true

  return sameDir(candidate, session)
}
