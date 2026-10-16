/**
 * Path normalisation and glob matching for folder watches.
 *
 * Everything here is pure: strings in, booleans out. That matters because the
 * matching rules are where a folder watcher goes wrong — a pattern that silently
 * never matches, or a Windows path that fails to match its own POSIX spelling —
 * and pure functions are the only part of a watcher that can be tested
 * exhaustively without a filesystem.
 *
 * @module dsh-folderwatch/lib/match
 */

/** Separator used internally. Every path is folded to POSIX form before use. */
const SEP = '/'

/**
 * Fold a path into the single spelling the matcher compares.
 *
 * Windows emits backslashes from some APIs and forward slashes from others, and
 * users write both. Folding here means `src\a.ts`, `./src/a.ts` and `src//a.ts`
 * are one string, so a pattern written in either dialect matches.
 *
 * @param {string} value - raw path.
 * @returns {string} folded path, without a trailing separator.
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  let out = value.replaceAll('\\', SEP)
  out = out.replace(/\/{2,}/gu, SEP)
  if (out.length > 1 && out.endsWith(SEP)) out = out.slice(0, -1)
  if (out.startsWith('./')) out = out.slice(2)
  return out
}

/**
 * Whether path comparison should ignore case.
 *
 * Windows and macOS filesystems are case-insensitive by default, so a watch on
 * `Docs` must still see `docs/report.pdf`. Linux is case-sensitive and folding
 * there would create false positives, so the platform decides.
 *
 * @param {string} [platform] - `process.platform`, injectable for tests.
 * @returns {boolean} true when case should be folded.
 */
export function caseInsensitive(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Compile one glob pattern into an anchored regular expression.
 *
 * Supported syntax, which is the subset a watcher actually needs:
 * `**` (any depth), `*` (within one segment), `?` (one character), `{a,b}`
 * (alternation). Anything else is escaped, so a pattern containing `.` or `+`
 * behaves literally instead of as a regex metacharacter.
 *
 * A pattern with no separator is treated as basename-only, so `*.md` matches
 * `notes/readme.md`. That is the intuitive reading and the one users type.
 *
 * @param {string} pattern - glob pattern.
 * @param {{ caseInsensitive?: boolean }} [options] - matching options.
 * @returns {RegExp} anchored matcher over folded paths.
 */
export function compileGlob(pattern, options = {}) {
  const folded = normalizePath(pattern)
  const flags = options.caseInsensitive === true ? 'iu' : 'u'
  const body = translate(folded)
  /* A bare pattern (no slash) matches the final segment at any depth. */
  const prefix = folded.includes(SEP) ? '^' : '^(?:.*/)?'
  return new RegExp(`${prefix}${body}$`, flags)
}

/**
 * Translate glob syntax into a regex body.
 *
 * @param {string} pattern - folded glob pattern.
 * @returns {string} regex source without anchors.
 */
function translate(pattern) {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      const doubled = pattern[index + 1] === '*'
      if (doubled) {
        /* `**\/` may match nothing at all, which is what makes `**\/*.md`
         * match `readme.md` in the watched root itself. */
        const followedBySlash = pattern[index + 2] === SEP
        out += followedBySlash ? '(?:.*/)?' : '.*'
        index += followedBySlash ? 2 : 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index)
      if (close !== -1) {
        const alternatives = pattern.slice(index + 1, close).split(',')
        out += `(?:${alternatives.map((part) => translate(part)).join('|')})`
        index = close
        continue
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return out
}

/**
 * Whether a path matches any of the supplied patterns.
 *
 * `!`-prefixed patterns are negations and are evaluated first, so an ignore list
 * can carve exceptions out of a broad include.
 *
 * @param {string} path - path to test, relative or absolute.
 * @param {string[]} patterns - glob patterns; empty means "match everything".
 * @param {{ caseInsensitive?: boolean }} [options] - matching options.
 * @returns {boolean} true when the path is selected.
 */
export function matchesAny(path, patterns, options = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true
  const target = normalizePath(path)
  const negatives = patterns.filter((pattern) => pattern.startsWith('!'))
  const positives = patterns.filter((pattern) => !pattern.startsWith('!'))
  const flag = options.caseInsensitive === true

  for (const pattern of negatives) {
    if (compileGlob(pattern.slice(1), { caseInsensitive: flag }).test(target)) return false
  }
  if (positives.length === 0) return true
  return positives.some((pattern) => compileGlob(pattern, { caseInsensitive: flag }).test(target))
}

/**
 * Whether a path should be skipped while walking a tree.
 *
 * An ignore entry without a separator is matched against the final segment, so
 * `node_modules` prunes that directory at any depth — which is what everyone
 * means when they write it. An entry with a separator is matched against the
 * full relative path, so `build/*.map` can be narrow.
 *
 * `!`-prefixed entries re-include, and are checked last: a broad ignore with a
 * narrow exception is the common shape (`['**', '!src/**']`).
 *
 * @param {string} path - relative path of the entry being considered.
 * @param {string[]} ignore - ignore patterns.
 * @param {{ caseInsensitive?: boolean }} [options] - matching options.
 * @returns {boolean} true when the entry should not be walked or reported.
 */
export function isIgnored(path, ignore, options = {}) {
  if (!Array.isArray(ignore) || ignore.length === 0) return false
  const target = normalizePath(path)
  const flag = options.caseInsensitive === true
  let ignored = false

  for (const raw of ignore) {
    if (typeof raw !== 'string' || raw === '') continue
    const negated = raw.startsWith('!')
    const pattern = normalizePath(negated ? raw.slice(1) : raw)
    if (pattern === '') continue
    const matcher = compileGlob(pattern, { caseInsensitive: flag })
    /* A bare pattern names an entry at any depth, so it is tested against every
     * segment rather than only the last one. Callers hand this function whole
     * paths — `node_modules/pkg/index.js` — and gitignore semantics say a file
     * inside an ignored directory is ignored too. Testing only the basename
     * would report that file as watched. */
    const subjects = pattern.includes(SEP) ? [target] : segments(target)
    if (!subjects.some((subject) => matcher.test(subject))) continue
    ignored = !negated
  }
  return ignored
}

/**
 * Split a folded path into its segments.
 *
 * @param {string} path - folded path.
 * @returns {string[]} segments, without empty entries.
 */
function segments(path) {
  return path.split(SEP).filter((part) => part !== '')
}

/**
 * Convert an absolute path into the form patterns are written against.
 *
 * Watches declare a root; patterns are written relative to it. Returning `null`
 * for a path outside the root is deliberate — an event that escapes the watched
 * tree is not something the caller asked to hear about.
 *
 * @param {string} absolute - absolute path of the changed entry.
 * @param {string} root - absolute watched root.
 * @param {{ caseInsensitive?: boolean }} [options] - matching options.
 * @returns {string | null} relative POSIX path, or null when outside the root.
 */
export function relativeTo(absolute, root, options = {}) {
  const target = normalizePath(absolute)
  const base = normalizePath(root)
  if (base === '') return target
  const fold = options.caseInsensitive === true
  const left = fold ? target.toLowerCase() : target
  const right = fold ? base.toLowerCase() : base
  if (left === right) return ''
  if (!left.startsWith(`${right}/`)) return null
  return target.slice(base.length + 1)
}

/**
 * Resolve a user-supplied path against a workspace root.
 *
 * Relative paths are resolved against the root rather than the process working
 * directory: an agent's notion of "here" is its workspace, and the plugin's own
 * cwd is an implementation detail it must not leak.
 *
 * @param {string} value - path as the caller wrote it.
 * @param {string} root - absolute workspace root, when known.
 * @param {(value: string) => string} resolve - `node:path` resolve, injected.
 * @returns {string} absolute folded path.
 */
export function resolveWatchPath(value, root, resolve) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') throw new Error('a watch needs a path')
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/]{1,2})/u.test(raw)
  const base = isAbsolute || typeof root !== 'string' || root === '' ? undefined : root
  return normalizePath(base === undefined ? resolve(raw) : resolve(base, raw))
}
