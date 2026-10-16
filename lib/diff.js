/**
 * Snapshot diffing: turn two directory snapshots into a classified change list.
 *
 * Pure. No filesystem access, no clock, no logging — the whole point is that the
 * classification rules (what counts as "changed", what counts as noise) can be
 * tested exhaustively without touching a disk.
 *
 * @module dsh-folderwatch/lib/diff
 */

/**
 * One entry inside a snapshot.
 *
 * @typedef {{ size: number, mtimeMs: number, kind: 'file' | 'directory' }} SnapshotEntry
 */

/**
 * One classified difference between two snapshots.
 *
 * @typedef {{ path: string, kind: 'file' | 'directory', size: number, mtimeMs: number, previous?: { size: number, mtimeMs: number } }} ChangeEvent
 */

/**
 * Order events by path so the same input always produces the same report.
 *
 * @param {ChangeEvent} left - first event.
 * @param {ChangeEvent} right - second event.
 * @returns {number} comparison result.
 */
function byPath(left, right) {
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  return 0
}

/**
 * Compare two snapshots and classify every difference.
 *
 * Directories are compared by existence only. A directory's mtime advances
 * whenever an entry inside it is created or removed, so comparing mtime would
 * report the containing folder as "changed" next to every file event —
 * technically true, and pure noise in a notification.
 *
 * @param {Map<string, SnapshotEntry>} previous - snapshot taken before.
 * @param {Map<string, SnapshotEntry>} next - snapshot taken after.
 * @returns {{ created: ChangeEvent[], changed: ChangeEvent[], deleted: ChangeEvent[] }} classified events.
 */
export function diffSnapshots(previous, next) {
  const created = []
  const changed = []
  const deleted = []

  for (const [path, entry] of next) {
    const before = previous.get(path)
    if (before === undefined) {
      created.push({ path, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs })
      continue
    }
    if (entry.kind === 'directory' || before.kind === 'directory') continue
    if (before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) {
      changed.push({
        path,
        kind: entry.kind,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        previous: { size: before.size, mtimeMs: before.mtimeMs },
      })
    }
  }

  for (const [path, entry] of previous) {
    if (next.has(path)) continue
    deleted.push({ path, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs })
  }

  created.sort(byPath)
  changed.sort(byPath)
  deleted.sort(byPath)
  return { created, changed, deleted }
}

/**
 * Whether a change set contains nothing at all.
 *
 * @param {{ created: ChangeEvent[], changed: ChangeEvent[], deleted: ChangeEvent[] }} diff - change set.
 * @returns {boolean} true when every list is empty.
 */
export function isEmptyDiff(diff) {
  return diff.created.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0
}

/**
 * Total number of events in a change set.
 *
 * @param {{ created: ChangeEvent[], changed: ChangeEvent[], deleted: ChangeEvent[] }} diff - change set.
 * @returns {number} event count.
 */
export function countEvents(diff) {
  return diff.created.length + diff.changed.length + diff.deleted.length
}

/**
 * Flatten a change set into one ordered list.
 *
 * @param {{ created: ChangeEvent[], changed: ChangeEvent[], deleted: ChangeEvent[] }} diff - change set.
 * @returns {{ action: 'created' | 'changed' | 'deleted', event: ChangeEvent }[]} flattened events.
 */
export function flattenDiff(diff) {
  const rows = []
  for (const event of diff.created) rows.push({ action: 'created', event })
  for (const event of diff.changed) rows.push({ action: 'changed', event })
  for (const event of diff.deleted) rows.push({ action: 'deleted', event })
  return rows
}

/**
 * Keep only events that match a glob pattern.
 *
 * The pattern is applied to the path relative to the watch root. Deletions are
 * matched too: a watch on `*.ts` should hear that `a.ts` disappeared.
 *
 * @param {{ created: ChangeEvent[], changed: ChangeEvent[], deleted: ChangeEvent[] }} diff - change set.
 * @param {(path: string) => boolean} select - predicate over relative paths.
 * @returns {{ created: ChangeEvent[], changed: ChangeEvent[], deleted: ChangeEvent[] }} filtered change set.
 */
export function filterDiff(diff, select) {
  return {
    created: diff.created.filter((event) => select(event.path)),
    changed: diff.changed.filter((event) => select(event.path)),
    deleted: diff.deleted.filter((event) => select(event.path)),
  }
}

/**
 * Drop deletions that are already implied by a deleted parent directory.
 *
 * Removing a folder produces one event per descendant. Listing all of them
 * buries the one fact that matters ("this folder is gone") under hundreds of
 * lines, so descendants of a deleted directory are folded away.
 *
 * @param {ChangeEvent[]} events - deletion events, any order.
 * @returns {ChangeEvent[]} deletions with nested paths removed.
 */
export function pruneNestedDeletions(events) {
  const directories = new Set()
  for (const event of events) {
    if (event.kind === 'directory') directories.add(event.path)
  }
  if (directories.size === 0) return [...events]
  return events.filter((event) => {
    let cursor = event.path
    for (;;) {
      const cut = cursor.lastIndexOf('/')
      if (cut === -1) return true
      cursor = cursor.slice(0, cut)
      if (directories.has(cursor)) return false
    }
  })
}

/**
 * Drop creations that are already implied by a created parent directory.
 *
 * Only used for the compact summary line; the full list keeps every file so the
 * agent can see exactly what arrived.
 *
 * @param {ChangeEvent[]} events - creation events, any order.
 * @returns {ChangeEvent[]} creations with nested paths removed.
 */
export function pruneNestedCreations(events) {
  return pruneNestedDeletions(events)
}
