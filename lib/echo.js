/**
 * Echo suppression: don't wake the agent because of the agent.
 *
 * A watcher on a directory the agent is editing has an obvious failure mode.
 * The agent writes `src/app.ts`; the watcher fires; the agent is told
 * `src/app.ts` changed; it reads the file it just wrote; the write is already
 * recorded, so this one settles — but a build, a formatter or a test runner the
 * agent itself started will keep writing, and each write wakes the agent again.
 * The result is a loop that burns tokens and reads as if the workspace were
 * under attack by a stranger.
 *
 * The fix is a short-lived ledger of paths the agent is known to have touched.
 * A change to a path in that ledger, seen within the window, is recorded as
 * suppressed rather than delivered. The window is deliberately short: a file the
 * agent wrote ten minutes ago changing now is real news.
 *
 * @module dsh-folderwatch/lib/echo
 */

import { normalizePath } from './match.js'

/**
 * Tool argument names that carry a single path.
 *
 * `write` and `edit` both use `file_path`; `str_replace_editor` uses `path`.
 * Anything else is read from `command` text instead.
 */
const PATH_ARGUMENTS = ['file_path', 'path', 'filePath', 'target_file', 'notebook_path']

/** Shell tools whose command text may contain paths. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'powershell', 'shell'])

/**
 * Pull every path-shaped token out of a shell command line.
 *
 * This is a heuristic and is documented as one. A shell command's real effect is
 * unknowable without running it, so the ledger records what the text plausibly
 * names: quoted strings and bare tokens that look like paths (contain a
 * separator, or end in an extension). Missing a path means one extra
 * notification; recording a wrong one means a real change gets swallowed, so the
 * extraction stays conservative — no glob expansion, no interpolation guesses.
 *
 * @param {string} command - shell command text.
 * @returns {string[]} candidate paths.
 */
export function pathsFromCommand(command) {
  if (typeof command !== 'string' || command === '') return []
  const found = new Set()
  const quoted = command.matchAll(/["']([^"'\n]{2,200})["']/gu)
  for (const match of quoted) {
    const value = match[1]
    if (looksLikePath(value)) found.add(value)
  }
  for (const token of command.split(/[\s;|&()<>]+/u)) {
    /* Strip surrounding quotes before testing: the quoted-string pass above
     * already recorded the unquoted spelling, and keeping the quote characters
     * here would enter `"src/a.ts"` as a second, unmatchable key. */
    const value = token.replace(/^["']+|["']+$/gu, '').replace(/^[-+]+/u, '')
    if (looksLikePath(value)) found.add(value)
  }
  return [...found]
}

/**
 * Whether a token plausibly denotes a filesystem path.
 *
 * @param {string} value - candidate token.
 * @returns {boolean} true when it looks like a path.
 */
function looksLikePath(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 260) return false
  if (/^https?:\/\//iu.test(value)) return false
  if (/^--?[a-z]/iu.test(value)) return false
  const hasSeparator = /[\\/]/u.test(value)
  const hasExtension = /\.[a-z0-9]{1,8}$/iu.test(value)
  return hasSeparator || hasExtension
}

/**
 * Extract the paths a tool call is known to have touched.
 *
 * Only two cases are knowable: a filesystem tool naming a file, and a shell
 * command whose text names one. For a shell tool the extraction is a guess, so
 * the result is marked `certain: false` and the caller decides how much to trust
 * it. `write` and `edit` are certain.
 *
 * @param {string} toolName - name of the tool that ran.
 * @param {Record<string, unknown>} args - the tool's frozen arguments.
 * @returns {{ paths: string[], certain: boolean }} extracted paths and confidence.
 */
export function pathsFromToolCall(toolName, args) {
  if (typeof toolName !== 'string' || args === null || typeof args !== 'object') {
    return { paths: [], certain: false }
  }
  for (const key of PATH_ARGUMENTS) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return { paths: [value], certain: true }
  }
  if (SHELL_TOOLS.has(toolName) && typeof args.command === 'string') {
    return { paths: pathsFromCommand(args.command), certain: false }
  }
  return { paths: [], certain: false }
}

/**
 * Create a ledger of recently written paths.
 *
 * @param {{ windowMs?: number, limit?: number, now?: () => number, caseInsensitive?: boolean }} [options] - ledger options.
 * @returns {{
 *   record: (paths: string[], options?: { certain?: boolean }) => number,
 *   isEcho: (path: string) => boolean,
 *   suppress: (paths: string[]) => { kept: string[], suppressed: string[] },
 *   size: () => number,
 *   clear: () => void,
 * }} the ledger.
 */
export function createEchoLedger(options = {}) {
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : 2500
  const limit = Number.isFinite(options.limit) ? options.limit : 2000
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const foldCase = options.caseInsensitive !== false
  /** @type {Map<string, { at: number, certain: boolean }>} */
  const ledger = new Map()

  /**
   * Fold a path into the ledger's key form.
   *
   * @param {string} value - raw path.
   * @returns {string} key.
   */
  const keyOf = (value) => {
    const normalized = normalizePath(value)
    return foldCase ? normalized.toLowerCase() : normalized
  }

  /**
   * Forget entries that have aged out.
   *
   * @param {number} at - current time.
   * @returns {void}
   */
  function prune(at) {
    for (const [key, entry] of ledger) {
      if (at - entry.at > windowMs) ledger.delete(key)
    }
  }

  /**
   * Record paths the agent is known to have just touched.
   *
   * @param {string[]} paths - paths to record.
   * @param {{ certain?: boolean }} [flags] - whether the paths are certain.
   * @returns {number} how many entries are now held.
   */
  function record(paths, flags = {}) {
    const at = now()
    prune(at)
    for (const path of Array.isArray(paths) ? paths : []) {
      if (typeof path !== 'string' || path === '') continue
      ledger.set(keyOf(path), { at, certain: flags.certain !== false })
    }
    /* Bound the map so a long session cannot grow it without limit. */
    while (ledger.size > limit) {
      const oldest = ledger.keys().next()
      if (oldest.done === true) break
      ledger.delete(oldest.value)
    }
    return ledger.size
  }

  /**
   * Whether a path was recently written by the agent.
   *
   * @param {string} path - path to test.
   * @returns {boolean} true when the change is an echo.
   */
  function isEcho(path) {
    const at = now()
    const entry = ledger.get(keyOf(path))
    if (entry === undefined) return false
    if (at - entry.at > windowMs) {
      ledger.delete(keyOf(path))
      return false
    }
    return true
  }

  /**
   * Split paths into delivered and suppressed halves.
   *
   * @param {string[]} paths - changed paths.
   * @returns {{ kept: string[], suppressed: string[] }} the split.
   */
  function suppress(paths) {
    const kept = []
    const suppressed = []
    for (const path of Array.isArray(paths) ? paths : []) {
      if (isEcho(path)) suppressed.push(path)
      else kept.push(path)
    }
    return { kept, suppressed }
  }

  return {
    record,
    isEcho,
    suppress,
    size: () => ledger.size,
    clear: () => ledger.clear(),
  }
}

export { PATH_ARGUMENTS, SHELL_TOOLS }
