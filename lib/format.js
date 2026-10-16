/**
 * Rendering: everything the human and the model actually read.
 *
 * Pure string work, no filesystem and no clock beyond what is passed in. The
 * same renderers serve the tool results and the notification text, so a watch
 * looks the same whether you asked for it or it woke you.
 *
 * @module dsh-folderwatch/lib/format
 */

import { countEvents, flattenDiff, pruneNestedDeletions } from './diff.js'

/** Bytes rendered compactly: `0B`, `812B`, `1.4KB`, `12MB`. */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rendered = unit > 0 && value < 10 ? value.toFixed(1).replace(/\.0$/u, '') : String(Math.round(value))
  return `${rendered}${units[unit]}`
}

/** Elapsed time rendered compactly: `just now`, `45s`, `10m`, `2h13m`, `3d4h`. */
export function humanAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

/**
 * Trim a path for display, keeping the tail where the information is.
 *
 * @param {string} value - path to shorten.
 * @param {number} [max] - maximum width.
 * @returns {string} display path.
 */
export function shortenPath(value, max = 72) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  return `…${text.slice(text.length - max + 1)}`
}

/**
 * One-line-per-event rendering of a change set.
 *
 * @param {{ created: object[], changed: object[], deleted: object[] }} diff - change set.
 * @param {{ limit?: number, prefix?: string }} [options] - rendering options.
 * @returns {string[]} rendered lines.
 */
export function renderEvents(diff, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 60
  const prefix = typeof options.prefix === 'string' ? options.prefix : '  '
  const rows = flattenDiff(diff)
  const lines = []
  for (const row of rows.slice(0, limit)) {
    const marker = row.action === 'created' ? '+' : row.action === 'changed' ? '~' : '-'
    const size = row.action === 'deleted' ? '' : `  ${humanBytes(row.event.size)}`
    lines.push(`${prefix}${marker} ${shortenPath(row.event.path)}${size}`)
  }
  if (rows.length > limit) lines.push(`${prefix}… and ${rows.length - limit} more`)
  return lines
}

/**
 * Render a batch of changes as the text of a notification.
 *
 * The first line carries the essential facts — how many changes, where, and
 * which watch — because that line is what shows in a collapsed transcript and
 * what the model reads first.
 *
 * @param {{ id: string, root: string, label?: string, prompt?: string }} watch - the watch that fired.
 * @param {{ diff: object, suppressed: number, truncated: boolean }} batch - the delivered batch.
 * @param {{ limit?: number, at?: string }} [options] - rendering options.
 * @returns {string} notification text.
 */
export function renderNotification(watch, batch, options = {}) {
  const total = countEvents(batch.diff)
  /* Only spell out the id when the label adds nothing: a watch named after its
   * own path would otherwise read as `reports (reports)`. */
  const name = watch.label === undefined || watch.label === watch.id ? watch.id : `${watch.label} (${watch.id})`
  const heading = `[folderwatch] ${total} change${total === 1 ? '' : 's'} under ${watch.root}`
  const lines = [heading, `watch: ${name}${options.at === undefined ? '' : ` · ${options.at}`}`]

  const created = batch.diff.created.length
  const changed = batch.diff.changed.length
  const deleted = batch.diff.deleted.length
  const parts = []
  if (created > 0) parts.push(`${created} created`)
  if (changed > 0) parts.push(`${changed} modified`)
  if (deleted > 0) parts.push(`${deleted} deleted`)
  if (parts.length > 0) lines.push(parts.join(' · '))

  lines.push(...renderEvents(batch.diff, { limit: options.limit }))

  if (batch.suppressed > 0) {
    lines.push(`(${batch.suppressed} event${batch.suppressed === 1 ? '' : 's'} suppressed as this session's own writes)`)
  }
  if (batch.truncated === true) {
    lines.push('(list truncated; the tree changed faster than it could be reported)')
  }
  if (typeof watch.prompt === 'string' && watch.prompt !== '') {
    lines.push('', watch.prompt)
  }
  return lines.join('\n')
}

/**
 * Render the result of arming a watch.
 *
 * @param {object} status - watch status from `FolderWatch#status`.
 * @returns {string} report text.
 */
export function renderArm(status) {
  const lines = [
    `dsh-folderwatch · armed "${status.id}"`,
    `  root:      ${status.root}`,
    `  watching:  ${status.files} file(s), ${status.directories} director${status.directories === 1 ? 'y' : 'ies'} (${status.watchKind})`,
  ]
  if (status.pattern !== undefined) lines.push(`  pattern:   ${status.pattern}`)
  if (Array.isArray(status.ignore) && status.ignore.length > 0) lines.push(`  ignoring:  ${status.ignore.join(', ')}`)
  lines.push(`  deliver:   ${status.mode === 'wake' ? 'wake the agent (followup)' : 'queue for the next step (inject)'}`)
  if (status.once === true) lines.push('  once:      disarms itself after the first delivery')
  if (status.sessionId !== undefined) lines.push(`  session:   ${status.sessionId}`)
  if (status.truncatedSnapshot === true) {
    lines.push('  note:      the tree is large; the snapshot hit its entry cap and may be partial')
  }
  if (Array.isArray(status.unreadable) && status.unreadable.length > 0) {
    lines.push(`  note:      could not read ${status.unreadable.length} director${status.unreadable.length === 1 ? 'y' : 'ies'} (${status.unreadable.slice(0, 3).join(', ')})`)
  }
  lines.push('', 'Changes are reported in batches after the tree goes quiet, and this session\'s own writes are filtered out.')
  return lines.join('\n')
}

/**
 * Render the watch inventory.
 *
 * @param {object[]} watches - status objects.
 * @param {{ now?: number }} [options] - rendering options.
 * @returns {string} inventory text.
 */
export function renderList(watches, options = {}) {
  if (!Array.isArray(watches) || watches.length === 0) {
    return 'dsh-folderwatch · no watches armed\nArm one with folderwatch_add, or a `/watch add <path>` command.'
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const lines = [`dsh-folderwatch · ${watches.length} watch${watches.length === 1 ? '' : 'es'}`]
  for (const watch of watches) {
    const age = watch.lastDeliveryAt === undefined
      ? 'never fired'
      : `last fired ${humanAge((now - Date.parse(watch.lastDeliveryAt)) / 1000)} ago`
    /* `state` already reads `stopped`, so it is not repeated as a suffix. */
    lines.push(`  ${watch.id}  ${watch.state}  ${watch.files} file(s)  ${watch.deliveries} delivery(ies)  ${age}`)
    lines.push(`    ${watch.root}${watch.pattern === undefined ? '' : `  [${watch.pattern}]`}`)
    if (watch.pending > 0) lines.push(`    ${watch.pending} change(s) pending delivery`)
    if (watch.lastError !== undefined) lines.push(`    last error: ${watch.lastError}`)
  }
  return lines.join('\n')
}

/**
 * Render the result of a dry-run check.
 *
 * @param {object} status - watch status.
 * @param {{ diff: object, events: number, suppressed?: number }} result - the check result.
 * @returns {string} report text.
 */
export function renderCheck(status, result) {
  const lines = [`dsh-folderwatch · check "${status.id}" · ${result.events} change(s) since the last scan`]
  if (result.events === 0) {
    lines.push('  nothing changed')
    if (Number.isFinite(result.suppressed) && result.suppressed > 0) {
      lines.push(`  (${result.suppressed} event(s) were this session's own writes and are not reported)`)
    }
    return lines.join('\n')
  }
  lines.push(...renderEvents(result.diff))
  if (Number.isFinite(result.suppressed) && result.suppressed > 0) {
    lines.push(`  (${result.suppressed} further event(s) were this session's own writes)`)
  }
  lines.push('', 'This was a check: the snapshot advanced and no message was delivered.')
  return lines.join('\n')
}

/**
 * Render the removal of a watch.
 *
 * @param {object} status - status of the watch that was removed.
 * @returns {string} report text.
 */
export function renderRemoval(status) {
  const lines = [`dsh-folderwatch · disarmed "${status.id}"`]
  lines.push(`  root: ${status.root}`)
  lines.push(`  delivered ${status.deliveries} batch(es) over ${status.deliveredEvents} event(s) while armed`)
  if (status.suppressedEvents > 0) {
    lines.push(`  filtered ${status.suppressedEvents} event(s) that were this session's own writes`)
  }
  return lines.join('\n')
}

/**
 * Render a watch problem as a one-line explanation.
 *
 * @param {string} id - watch id.
 * @param {string} message - the problem.
 * @returns {string} error text.
 */
export function renderProblem(id, message) {
  return `dsh-folderwatch · "${id}" could not be armed: ${message}`
}

/**
 * Render the deletion summary used in compact listings.
 *
 * @param {object[]} deletions - deletion events.
 * @returns {string} summary line.
 */
export function renderDeletionSummary(deletions) {
  const pruned = pruneNestedDeletions(deletions)
  if (pruned.length === 0) return 'nothing deleted'
  return `${pruned.length} top-level deletion(s): ${pruned.slice(0, 5).map((event) => event.path).join(', ')}`
}
