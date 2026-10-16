/**
 * Directory snapshots: walk a tree and record what is in it.
 *
 * The watcher is built on snapshots rather than on raw `fs.watch` events. Raw
 * events are a hint that something happened, not a description of what: they
 * arrive twice on Windows, arrive without a name on some platforms, and miss
 * changes entirely when a buffer overflows. A snapshot diff answers the actual
 * question — "what is different from last time" — and gets renames, deletes and
 * bursts right by construction.
 *
 * @module dsh-folderwatch/lib/snapshot
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isIgnored } from './match.js'

/** Guard against a runaway tree turning one tick into an unbounded walk. */
const DEFAULT_MAX_ENTRIES = 20_000

/** Depth cap for the same reason: a watch should not crawl an entire drive. */
const DEFAULT_MAX_DEPTH = 12

/**
 * Read one entry's metadata, treating a race as "it vanished".
 *
 * Files disappear between `readdir` and `stat` all the time — that is normal in
 * a watched tree, not an error worth reporting.
 *
 * @param {string} absolute - absolute path to stat.
 * @returns {Promise<{ size: number, mtimeMs: number, kind: 'file' | 'directory' } | undefined>} metadata, or undefined.
 */
async function statEntry(absolute) {
  try {
    const info = await stat(absolute)
    if (info.isDirectory()) return { size: 0, mtimeMs: info.mtimeMs, kind: 'directory' }
    if (info.isFile()) return { size: info.size, mtimeMs: info.mtimeMs, kind: 'file' }
    /* Sockets, FIFOs, device nodes: present but not something to report. */
    return { size: 0, mtimeMs: info.mtimeMs, kind: 'file' }
  } catch {
    return undefined
  }
}

/**
 * Walk a tree and produce a snapshot keyed by POSIX-relative path.
 *
 * Symlinks are not followed. A watch that follows links can escape its root and
 * can loop forever; the honest behaviour is to record the link itself as a file
 * and leave traversal to the user's own tooling.
 *
 * @param {string} root - absolute root directory to walk.
 * @param {{ ignore?: string[], recursive?: boolean, maxEntries?: number, maxDepth?: number, signal?: AbortSignal }} [options] - walk options.
 * @returns {Promise<{ entries: Map<string, { size: number, mtimeMs: number, kind: 'file' | 'directory' }>, truncated: boolean, unreadable: string[] }>} snapshot.
 */
export async function takeSnapshot(root, options = {}) {
  const entries = new Map()
  const unreadable = []
  const ignore = Array.isArray(options.ignore) ? options.ignore : []
  const recursive = options.recursive !== false
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH
  const signal = options.signal
  let truncated = false

  /**
   * Walk one directory level.
   *
   * @param {string} absolute - directory to read.
   * @param {string} relative - its path relative to the root, `''` at the root.
   * @param {number} depth - current depth.
   * @returns {Promise<void>} resolves when the subtree is recorded.
   */
  async function walk(absolute, relative, depth) {
    if (truncated || signal?.aborted === true) return
    let dirents
    try {
      dirents = await readdir(absolute, { withFileTypes: true })
    } catch {
      unreadable.push(relative === '' ? '.' : relative)
      return
    }
    /* Deterministic order keeps snapshots comparable and reports stable. */
    dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

    for (const dirent of dirents) {
      if (truncated || signal?.aborted === true) return
      const child = relative === '' ? dirent.name : `${relative}/${dirent.name}`
      if (isIgnored(child, ignore)) continue
      if (entries.size >= maxEntries) {
        truncated = true
        return
      }
      const childAbsolute = join(absolute, dirent.name)
      const info = await statEntry(childAbsolute)
      if (info === undefined) continue
      entries.set(child, info)
      if (info.kind === 'directory' && recursive && depth < maxDepth) {
        await walk(childAbsolute, child, depth + 1)
      }
    }
  }

  await walk(root, '', 0)
  return { entries, truncated, unreadable }
}

/**
 * Whether two snapshots describe the same tree state.
 *
 * @param {{ entries: Map<string, unknown> }} left - first snapshot.
 * @param {{ entries: Map<string, unknown> }} right - second snapshot.
 * @returns {boolean} true when the key sets and every recorded value match.
 */
export function sameSnapshot(left, right) {
  if (left.entries.size !== right.entries.size) return false
  for (const [path, entry] of left.entries) {
    const other = right.entries.get(path)
    if (other === undefined) return false
    if (other.size !== entry.size || other.mtimeMs !== entry.mtimeMs || other.kind !== entry.kind) return false
  }
  return true
}

/**
 * Count entries by kind, for status reporting.
 *
 * @param {{ entries: Map<string, { kind: 'file' | 'directory' }> }} snapshot - snapshot to summarise.
 * @returns {{ files: number, directories: number, total: number }} counts.
 */
export function summarizeSnapshot(snapshot) {
  let files = 0
  let directories = 0
  for (const entry of snapshot.entries.values()) {
    if (entry.kind === 'directory') directories += 1
    else files += 1
  }
  return { files, directories, total: snapshot.entries.size }
}

export { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_DEPTH }
