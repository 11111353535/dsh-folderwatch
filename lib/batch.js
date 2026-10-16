/**
 * Batching: turn a burst of file changes into one notification.
 *
 * A build writes hundreds of files in under a second. Delivering one message per
 * change would be unusable, so events accumulate until the tree goes quiet for
 * `quietMs`, then ship as a single report. A `maxWaitMs` ceiling bounds the wait:
 * a tree that is written to continuously must still produce notifications, not
 * defer forever waiting for a silence that never comes.
 *
 * The state machine is pure — the clock is injected — so every timing branch is
 * testable without real timers.
 *
 * @module dsh-folderwatch/lib/batch
 */

import { countEvents, filterDiff, isEmptyDiff } from './diff.js'

/**
 * Accumulate classified change sets and decide when to emit.
 *
 * @param {{ quietMs?: number, maxWaitMs?: number, cooldownMs?: number, maxEvents?: number, now?: () => number }} [options] - batching options.
 * @returns {{
 *   push: (diff: { created: object[], changed: object[], deleted: object[] }) => void,
 *   due: () => boolean,
 *   drain: () => { diff: object, suppressed: number, truncated: boolean } | undefined,
 *   pending: () => number,
 *   lastDeliveryAt: () => number | undefined,
 *   reset: () => void,
 * }} the batcher.
 */
export function createBatcher(options = {}) {
  const quietMs = Number.isFinite(options.quietMs) ? options.quietMs : 400
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : 5000
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 0
  const maxEvents = Number.isFinite(options.maxEvents) ? options.maxEvents : 200
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  let created = []
  let changed = []
  let deleted = []
  let firstPendingAt
  let lastChangeAt
  let deliveredAt
  let suppressedCount = 0
  let truncated = false

  /**
   * Whether the accumulator holds nothing.
   *
   * @returns {boolean} true when empty.
   */
  function empty() {
    return created.length === 0 && changed.length === 0 && deleted.length === 0
  }

  /**
   * Add a change set to the accumulator.
   *
   * Re-adding the same path replaces the earlier record, so a file written
   * twice in one window is reported once with its latest state.
   *
   * @param {{ created: object[], changed: object[], deleted: object[] }} diff - change set to add.
   * @returns {void}
   */
  function push(diff) {
    if (diff === undefined || isEmptyDiff(diff)) return
    const at = now()
    if (empty()) firstPendingAt = at
    lastChangeAt = at

    /** @type {Map<string, object>} */
    const byPath = new Map()
    for (const event of created) byPath.set(event.path, { action: 'created', event })
    for (const event of changed) byPath.set(event.path, { action: 'changed', event })
    for (const event of deleted) byPath.set(event.path, { action: 'deleted', event })
    for (const event of diff.created) byPath.set(event.path, { action: 'created', event })
    for (const event of diff.changed) byPath.set(event.path, { action: 'changed', event })
    for (const event of diff.deleted) byPath.set(event.path, { action: 'deleted', event })

    created = []
    changed = []
    deleted = []
    for (const row of byPath.values()) {
      if (row.action === 'created') created.push(row.event)
      else if (row.action === 'changed') changed.push(row.event)
      else deleted.push(row.event)
    }

    if (countEvents({ created, changed, deleted }) > maxEvents) {
      truncated = true
      created = created.slice(0, maxEvents)
      changed = changed.slice(0, maxEvents)
      deleted = deleted.slice(0, maxEvents)
    }
  }

  /**
   * Record that some events were dropped as echoes.
   *
   * @param {number} count - how many were dropped.
   * @returns {void}
   */
  function noteSuppressed(count) {
    if (Number.isFinite(count) && count > 0) suppressedCount += count
  }

  /**
   * Whether the accumulator is ready to deliver.
   *
   * Ready means: something is pending, the tree has been quiet for `quietMs` or
   * the `maxWaitMs` ceiling has passed, and the post-delivery cooldown has
   * elapsed.
   *
   * @returns {boolean} true when a delivery should happen now.
   */
  function due() {
    if (empty()) return false
    const at = now()
    if (deliveredAt !== undefined && cooldownMs > 0 && at - deliveredAt < cooldownMs) return false
    const quiet = lastChangeAt !== undefined && at - lastChangeAt >= quietMs
    const ceiling = firstPendingAt !== undefined && at - firstPendingAt >= maxWaitMs
    return quiet || ceiling
  }

  /**
   * Take the pending events, clearing the accumulator.
   *
   * @returns {{ diff: { created: object[], changed: object[], deleted: object[] }, suppressed: number, truncated: boolean } | undefined} the batch, or undefined when empty.
   */
  function drain() {
    if (empty()) return undefined
    const batch = {
      diff: { created, changed, deleted },
      suppressed: suppressedCount,
      truncated,
    }
    created = []
    changed = []
    deleted = []
    firstPendingAt = undefined
    lastChangeAt = undefined
    suppressedCount = 0
    truncated = false
    deliveredAt = now()
    return batch
  }

  /**
   * Drop everything without delivering.
   *
   * Used when a watch is removed or its root disappears: pending events are
   * about a tree nobody is watching any more.
   *
   * @returns {void}
   */
  function reset() {
    created = []
    changed = []
    deleted = []
    firstPendingAt = undefined
    lastChangeAt = undefined
    suppressedCount = 0
    truncated = false
  }

  return {
    push,
    noteSuppressed,
    due,
    drain,
    reset,
    pending: () => countEvents({ created, changed, deleted }),
    lastDeliveryAt: () => deliveredAt,
  }
}

/**
 * Keep only the events a watch's pattern and ignore rules accept.
 *
 * @param {{ created: object[], changed: object[], deleted: object[] }} diff - change set.
 * @param {{ select: (path: string) => boolean }} watch - watch whose rules apply.
 * @returns {{ created: object[], changed: object[], deleted: object[] }} filtered change set.
 */
export function applyWatchRules(diff, watch) {
  return filterDiff(diff, (path) => watch.select(path))
}
