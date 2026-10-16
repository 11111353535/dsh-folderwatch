/**
 * Live watcher smoke test.
 *
 * The unit tests cover every pure function, but none of them prove the thing
 * this plugin exists for: that a real directory change produces a real
 * notification. That requires a real filesystem, real timers and a real
 * `fs.watch`, which is what this script uses.
 *
 * It runs entirely in a temporary directory and never touches the harness. Two
 * scenarios are checked:
 *
 *   1. An external write is noticed and delivered.
 *   2. A write recorded in the echo ledger is noticed but suppressed.
 *
 * Run with `npm run test:live`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createEchoLedger } from '../lib/echo.js'
import { renderNotification } from '../lib/format.js'
import { FolderWatch } from '../lib/watch.js'

/** Fast timings so the script finishes quickly. */
const QUIET_MS = 120
const POLL_MS = 60
const MAX_WAIT_MS = 8000

/**
 * Wait for a condition, polling until it holds or the deadline passes.
 *
 * @param {() => boolean} predicate - condition to wait for.
 * @param {number} timeoutMs - how long to wait.
 * @param {string} label - description used in the failure message.
 * @returns {Promise<void>} resolves when the condition holds.
 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Arm a watch over a fresh temporary directory.
 *
 * @param {object} options - ledger and callback overrides.
 * @returns {Promise<{ watch: FolderWatch, root: string, deliveries: object[], cleanup: () => Promise<void> }>} the armed watch.
 */
async function arm(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'folderwatch-live-'))
  const deliveries = []
  const errors = []
  const watch = new FolderWatch(
    {
      id: 'live',
      root,
      quietMs: QUIET_MS,
      maxWaitMs: 1000,
      cooldownMs: 0,
      pollIntervalMs: POLL_MS,
      maxEntries: 5000,
      echo: options.echo,
      ignore: [],
    },
    async (batch, owner) => {
      deliveries.push({
        batch,
        text: renderNotification({ id: owner.id, root: owner.root }, batch, { at: 'live' }),
      })
    },
    (error) => errors.push(error),
  )
  await watch.start()
  return {
    watch,
    root,
    deliveries,
    errors,
    cleanup: async () => {
      await watch.stop()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Run the live checks.
 *
 * @returns {Promise<void>} resolves when every check passed.
 */
async function main() {
  const results = []

  /* Scenario 1: an external writer is reported. */
  {
    const { watch, root, deliveries, errors, cleanup } = await arm()
    try {
      await writeFile(join(root, 'external.txt'), 'hello')
      await waitFor(() => deliveries.length > 0, MAX_WAIT_MS, 'a delivery after an external write')
      const first = deliveries[0]
      const paths = first.batch.diff.created.map((event) => event.path)
      assert.ok(paths.includes('external.txt'), `expected external.txt in ${JSON.stringify(paths)}`)
      assert.match(first.text, /\[folderwatch\] 1 change/u)
      assert.match(first.text, /\+ external\.txt/u)
      assert.equal(errors.length, 0, `unexpected watcher errors: ${errors.map((e) => e.message).join('; ')}`)
      results.push(`delivered after an external write: ${paths.join(', ')}`)
    } finally {
      await cleanup()
    }
  }

  /* Scenario 2: this session's own write is seen and suppressed. */
  {
    const echo = createEchoLedger({ windowMs: 30_000 })
    const { root, deliveries, cleanup } = await arm({ echo })
    try {
      const target = join(root, 'ours.txt')
      /* Record before writing, exactly as the tools/result observer does. */
      echo.record([resolve(target)])
      await writeFile(target, 'written by us')
      await new Promise((done) => setTimeout(done, 900))
      const deliveredPaths = deliveries.flatMap((entry) =>
        [...entry.batch.diff.created, ...entry.batch.diff.changed].map((event) => event.path),
      )
      assert.equal(deliveredPaths.includes('ours.txt'), false, `ours.txt should have been suppressed, got ${JSON.stringify(deliveredPaths)}`)
      results.push('suppressed this session\'s own write')
    } finally {
      await cleanup()
    }
  }

  /* Scenario 3: a deletion is reported as a deletion, not a mystery. */
  {
    const { watch, root, deliveries, cleanup } = await arm()
    try {
      const target = join(root, 'doomed.txt')
      await writeFile(target, 'here')
      await waitFor(() => deliveries.length > 0, MAX_WAIT_MS, 'the create to be delivered')
      const before = deliveries.length
      await rm(target, { force: true })
      await waitFor(() => deliveries.length > before, MAX_WAIT_MS, 'the deletion to be delivered')
      const last = deliveries[deliveries.length - 1]
      assert.deepEqual(last.batch.diff.deleted.map((event) => event.path), ['doomed.txt'])
      assert.match(last.text, /- doomed\.txt/u)
      results.push('classified a deletion correctly')
    } finally {
      await cleanup()
    }
  }

  /* Scenario 4: the pattern filter actually filters. */
  {
    const root = await mkdtemp(join(tmpdir(), 'folderwatch-live-'))
    const deliveries = []
    const watch = new FolderWatch(
      { id: 'pattern', root, quietMs: QUIET_MS, maxWaitMs: 1000, pollIntervalMs: POLL_MS, pattern: '**/*.log', ignore: [] },
      async (batch) => deliveries.push(batch),
    )
    await watch.start()
    try {
      await writeFile(join(root, 'ignored.txt'), 'no')
      await writeFile(join(root, 'kept.log'), 'yes')
      await waitFor(() => deliveries.length > 0, MAX_WAIT_MS, 'a delivery matching the pattern')
      const paths = deliveries.flatMap((batch) => batch.diff.created.map((event) => event.path))
      assert.ok(paths.includes('kept.log'), `expected kept.log, got ${JSON.stringify(paths)}`)
      assert.equal(paths.includes('ignored.txt'), false, `ignored.txt should not match **/*.log`)
      results.push('applied the pattern filter')
    } finally {
      await watch.stop()
      await rm(root, { recursive: true, force: true })
    }
  }

  console.log(`dsh-folderwatch live check · ${process.platform}`)
  for (const line of results) console.log(`  ✓ ${line}`)
  console.log(`  ${results.length}/${results.length} scenarios passed`)
}

await main()
