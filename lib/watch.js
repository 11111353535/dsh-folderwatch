/**
 * The watch loop: arm a directory, notice changes, decide when to report them.
 *
 * Two mechanisms run together, and neither is sufficient alone:
 *
 * - `fs.watch` is the fast path. It reports that *something* happened, often
 *   twice, sometimes with no name at all. It is treated purely as a hint to
 *   rescan.
 * - A periodic rescan is the correctness path. It compares snapshots and gets
 *   renames, deletions and missed events right regardless of what the platform
 *   reported.
 *
 * Running both means a quiet filesystem costs one directory walk per interval
 * and a busy one is noticed immediately.
 *
 * @module dsh-folderwatch/lib/watch
 */

import { watch as fsWatch } from 'node:fs'
import { resolve } from 'node:path'

import { createBatcher, applyWatchRules } from './batch.js'
import { countEvents, diffSnapshots, filterDiff, isEmptyDiff } from './diff.js'
import { matchesAny, normalizePath, relativeTo } from './match.js'
import { summarizeSnapshot, takeSnapshot } from './snapshot.js'

/** How long to wait after an fs.watch hint before rescanning. */
const HINT_DEBOUNCE_MS = 120

/**
 * A live watch over one directory.
 *
 * Lifecycle is explicit: `start()` takes the first snapshot, `stop()` releases
 * every handle and timer. Nothing here touches the agent — delivery is a
 * callback the caller supplies, which keeps this class testable against a
 * temporary directory and free of any harness dependency.
 */
export class FolderWatch {
  /**
   * @param {object} spec - the watch definition.
   * @param {string} spec.id - stable identifier.
   * @param {string} spec.root - absolute directory being watched.
   * @param {string[]} [spec.ignore] - ignore patterns.
   * @param {string} [spec.pattern] - glob selecting which paths count.
   * @param {boolean} [spec.recursive] - whether to descend.
   * @param {boolean} [spec.once] - disarm after the first delivery.
   * @param {number} [spec.quietMs] - quiet period before delivering.
   * @param {number} [spec.maxWaitMs] - ceiling on how long events may wait.
   * @param {number} [spec.cooldownMs] - minimum gap between deliveries.
   * @param {number} [spec.pollIntervalMs] - rescan interval.
   * @param {number} [spec.maxEntries] - snapshot entry cap.
   * @param {{ isEcho: (path: string) => boolean }} [spec.echo] - ledger of this session's own writes.
   * @param {(batch: object, watch: FolderWatch) => Promise<void>} onBatch - delivery callback.
   * @param {(error: Error, watch: FolderWatch) => void} [onError] - error sink.
   * @param {() => number} [now] - clock, injectable for tests.
   * @param {(path: string, options: object, listener: Function) => object} [watchFactory] - fs.watch, injectable for tests.
   */
  constructor(spec, onBatch, onError, now, watchFactory) {
    this.id = spec.id
    this.root = normalizePath(spec.root)
    this.ignore = Array.isArray(spec.ignore) ? spec.ignore : []
    this.pattern = typeof spec.pattern === 'string' && spec.pattern !== '' ? spec.pattern : undefined
    this.recursive = spec.recursive !== false
    this.once = spec.once === true
    this.pollIntervalMs = Number.isFinite(spec.pollIntervalMs) ? spec.pollIntervalMs : 1500
    this.maxEntries = Number.isFinite(spec.maxEntries) ? spec.maxEntries : undefined
    this.sessionId = typeof spec.sessionId === 'string' ? spec.sessionId : undefined
    this.mode = spec.mode === 'queue' ? 'queue' : 'wake'
    this.prompt = typeof spec.prompt === 'string' ? spec.prompt : undefined
    this.label = typeof spec.label === 'string' && spec.label !== '' ? spec.label : undefined
    this.createdAt = (typeof now === 'function' ? now : Date.now)()
    this.echo = spec.echo

    this.onBatch = onBatch
    this.onError = onError
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.watchFactory = typeof watchFactory === 'function' ? watchFactory : fsWatch

    this.batcher = createBatcher({
      quietMs: Number.isFinite(spec.quietMs) ? spec.quietMs : 400,
      maxWaitMs: Number.isFinite(spec.maxWaitMs) ? spec.maxWaitMs : 5000,
      cooldownMs: Number.isFinite(spec.cooldownMs) ? spec.cooldownMs : 0,
    })

    this.state = 'idle'
    this.deliveries = 0
    this.deliveredEvents = 0
    this.suppressedEvents = 0
    this.lastDeliveryAt = undefined
    this.lastError = undefined
    this.watchKind = 'poll'
    this.truncatedSnapshot = false
    this.unreadable = []

    /** @type {Map<string, object>} */
    this.snapshot = new Map()
    this.handle = undefined
    this.timer = undefined
    this.hintTimer = undefined
    this.busy = false
    this.dirty = false
  }

  /**
   * Whether a relative path is selected by this watch.
   *
   * @param {string} path - path relative to the root.
   * @returns {boolean} true when the path is in scope.
   */
  select(path) {
    if (this.pattern === undefined) return true
    return matchesAny(path, [this.pattern])
  }

  /**
   * Drop changes that are echoes of this session's own writes.
   *
   * The ledger keys on absolute paths, because that is what a tool call names,
   * while a diff event carries a path relative to the root. The join happens
   * here so the ledger never has to know about roots.
   *
   * Suppressed events are counted rather than silently discarded: a report that
   * says "4 events suppressed as your own writes" is evidence the filter is
   * working, whereas a silent drop looks identical to a watcher that missed
   * them.
   *
   * @param {{ created: object[], changed: object[], deleted: object[] }} diff - change set.
   * @returns {{ diff: object, suppressed: number }} the filtered set and how many were dropped.
   */
  suppressEchoes(diff) {
    if (this.echo === undefined) return { diff, suppressed: 0 }
    const root = this.root
    let suppressed = 0
    const keep = (path) => {
      if (this.echo.isEcho(resolve(root, path)) !== true) return true
      suppressed += 1
      return false
    }
    return { diff: filterDiff(diff, keep), suppressed }
  }

  /**
   * Take a snapshot of the watched tree.
   *
   * @returns {Promise<{ entries: Map<string, object>, truncated: boolean, unreadable: string[] }>} the snapshot.
   */
  async scan() {
    return takeSnapshot(this.root, {
      ignore: this.ignore,
      recursive: this.recursive,
      maxEntries: this.maxEntries,
    })
  }

  /**
   * Arm the watch: snapshot the tree, start fs.watch, start the rescan timer.
   *
   * @param {AbortSignal} [signal] - cancellation signal.
   * @returns {Promise<void>} resolves once armed.
   */
  async start(signal) {
    if (this.state !== 'idle') return
    this.state = 'armed'
    const initial = await this.scan()
    this.snapshot = initial.entries
    this.truncatedSnapshot = initial.truncated
    this.unreadable = initial.unreadable
    if (signal?.aborted === true) {
      this.state = 'stopped'
      return
    }
    this.armFastPath()
    this.armTimer()
  }

  /**
   * Attach `fs.watch` as a change hint, degrading silently when unavailable.
   *
   * A platform without recursive watching still gets a working watcher through
   * the rescan timer, so a failure here is recorded and not surfaced as an
   * error the user must act on.
   *
   * @returns {void}
   */
  armFastPath() {
    try {
      this.handle = this.watchFactory(this.root, { recursive: this.recursive, persistent: false }, () => {
        this.dirty = true
        if (this.hintTimer !== undefined) return
        this.hintTimer = setTimeout(() => {
          this.hintTimer = undefined
          void this.tick()
        }, HINT_DEBOUNCE_MS)
        this.hintTimer.unref?.()
      })
      this.handle.on?.('error', (error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.handle?.close?.()
        this.handle = undefined
        this.watchKind = 'poll'
      })
      this.watchKind = 'watch+poll'
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.handle = undefined
      this.watchKind = 'poll'
    }
  }

  /**
   * Start the periodic rescan.
   *
   * The timer is unref'd so a watch never keeps the harness process alive, and
   * overlapping ticks are skipped: a slow walk must not queue up behind itself.
   *
   * @returns {void}
   */
  armTimer() {
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }

  /**
   * One rescan cycle: snapshot, diff, feed the batcher, deliver when due.
   *
   * @returns {Promise<void>} resolves when the cycle finishes.
   */
  async tick() {
    if (this.state !== 'armed' || this.busy) return
    this.busy = true
    try {
      const next = await this.scan()
      const diff = diffSnapshots(this.snapshot, next.entries)
      this.snapshot = next.entries
      this.truncatedSnapshot = next.truncated
      this.unreadable = next.unreadable
      this.dirty = false
      if (!isEmptyDiff(diff)) this.stage(diff)
      if (this.batcher.due()) await this.deliver()
    } catch (error) {
      this.report(error)
    } finally {
      this.busy = false
    }
  }

  /**
   * Filter a raw change set through this watch's rules and stage it for delivery.
   *
   * Both the timer path and the manual paths (`check`, `fire`) go through here,
   * so a caller-triggered delivery applies exactly the same pattern, ignore and
   * echo rules as an automatic one. Two paths with two sets of rules is how a
   * watcher starts reporting things it was told to ignore.
   *
   * @param {{ created: object[], changed: object[], deleted: object[] }} diff - raw change set.
   * @returns {{ diff: object, events: number, suppressed: number }} what was staged.
   */
  stage(diff) {
    const selected = applyWatchRules(diff, this)
    const { diff: filtered, suppressed } = this.suppressEchoes(selected)
    if (suppressed > 0) this.batcher.noteSuppressed(suppressed)
    this.batcher.push(filtered)
    return { diff: filtered, events: countEvents(filtered), suppressed }
  }

  /**
   * Force an immediate rescan and report what changed, without delivering.
   *
   * This is the dry-run path: it answers "has anything happened?" without
   * waking the agent, which is what a caller wants before deciding whether a
   * watch is still useful.
   *
   * @returns {Promise<{ diff: object, events: number, suppressed: number }>} the observed change set.
   */
  async check() {
    const next = await this.scan()
    const diff = diffSnapshots(this.snapshot, next.entries)
    const selected = applyWatchRules(diff, this)
    const { diff: filtered, suppressed } = this.suppressEchoes(selected)
    this.snapshot = next.entries
    this.truncatedSnapshot = next.truncated
    this.unreadable = next.unreadable
    return { diff: filtered, events: countEvents(filtered), suppressed }
  }

  /**
   * Deliver the pending batch through the caller's callback.
   *
   * @returns {Promise<void>} resolves after delivery.
   */
  async deliver() {
    const batch = this.batcher.drain()
    if (batch === undefined) return
    const events = countEvents(batch.diff)
    if (events === 0 && batch.suppressed === 0) return
    this.suppressedEvents += batch.suppressed
    try {
      await this.onBatch(batch, this)
      this.deliveries += 1
      this.deliveredEvents += events
      this.lastDeliveryAt = this.now()
      if (this.once) await this.stop()
    } catch (error) {
      this.report(error)
    }
  }

  /**
   * Note events dropped as echoes of the agent's own writes.
   *
   * @param {number} count - how many were dropped.
   * @returns {void}
   */
  noteSuppressed(count) {
    this.suppressedEvents += count
  }

  /**
   * Record an error without tearing the watch down.
   *
   * A watch that dies on the first transient filesystem error is worse than one
   * that reports the error and keeps trying.
   *
   * @param {unknown} error - the failure.
   * @returns {void}
   */
  report(error) {
    this.lastError = error instanceof Error ? error.message : String(error)
    try {
      this.onError?.(error instanceof Error ? error : new Error(this.lastError), this)
    } catch {
      /* An error sink that throws must not become the error. */
    }
  }

  /**
   * Release every handle and timer.
   *
   * @returns {Promise<void>} resolves once stopped.
   */
  async stop() {
    if (this.state === 'stopped') return
    this.state = 'stopped'
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.hintTimer !== undefined) {
      clearTimeout(this.hintTimer)
      this.hintTimer = undefined
    }
    try {
      this.handle?.close?.()
    } catch {
      /* Already closed. */
    }
    this.handle = undefined
    this.batcher.reset()
  }

  /**
   * A serialisable view of the watch, for listing.
   *
   * @returns {object} status snapshot.
   */
  status() {
    const counts = summarizeSnapshot({ entries: this.snapshot })
    return {
      id: this.id,
      root: this.root,
      label: this.label,
      pattern: this.pattern,
      ignore: this.ignore,
      recursive: this.recursive,
      once: this.once,
      mode: this.mode,
      prompt: this.prompt,
      sessionId: this.sessionId,
      state: this.state,
      watchKind: this.watchKind,
      files: counts.files,
      directories: counts.directories,
      pending: this.batcher.pending(),
      deliveries: this.deliveries,
      deliveredEvents: this.deliveredEvents,
      suppressedEvents: this.suppressedEvents,
      lastDeliveryAt: this.lastDeliveryAt === undefined ? undefined : new Date(this.lastDeliveryAt).toISOString(),
      lastError: this.lastError,
      truncatedSnapshot: this.truncatedSnapshot,
      unreadable: this.unreadable.slice(0, 20),
      createdAt: new Date(this.createdAt).toISOString(),
    }
  }
}

/**
 * Resolve a changed path into the relative form a watch reports.
 *
 * @param {FolderWatch} watch - the watch that owns the path.
 * @param {string} path - absolute path from a tool call.
 * @returns {string | undefined} relative path, or undefined when outside the root.
 */
export function relativizeFor(watch, path) {
  const relative = relativeTo(path, watch.root, { caseInsensitive: process.platform === 'win32' || process.platform === 'darwin' })
  return relative === null ? undefined : relative
}

export { HINT_DEBOUNCE_MS }
