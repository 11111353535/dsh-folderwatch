/**
 * Unit tests for the pure modules.
 *
 * Everything here runs without a harness, without a filesystem (except the
 * snapshot tests, which use a real temporary directory because that is the only
 * honest way to test a directory walk), and without real timers — the batcher
 * takes an injected clock precisely so its timing branches can be driven by hand.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { applyWatchRules, createBatcher } from '../lib/batch.js'
import { countEvents, diffSnapshots, filterDiff, flattenDiff, isEmptyDiff, pruneNestedDeletions } from '../lib/diff.js'
import { createEchoLedger, pathsFromCommand, pathsFromToolCall } from '../lib/echo.js'
import { humanAge, humanBytes, renderArm, renderCheck, renderEvents, renderList, renderNotification, shortenPath } from '../lib/format.js'
import { caseInsensitive, compileGlob, isIgnored, matchesAny, normalizePath, relativeTo, resolveWatchPath } from '../lib/match.js'
import { summarizeSnapshot, takeSnapshot } from '../lib/snapshot.js'
import { FolderWatch } from '../lib/watch.js'

/** Build a snapshot map from `{ path: [size, mtimeMs] }`. */
function snapshotOf(rows) {
  const entries = new Map()
  for (const [path, value] of Object.entries(rows)) {
    entries.set(path, { size: value[0], mtimeMs: value[1], kind: value[2] ?? 'file' })
  }
  return entries
}

describe('normalizePath', () => {
  it('folds backslashes, duplicates and leading ./', () => {
    assert.equal(normalizePath('src\\a.ts'), 'src/a.ts')
    assert.equal(normalizePath('./src/a.ts'), 'src/a.ts')
    assert.equal(normalizePath('src//a.ts'), 'src/a.ts')
    assert.equal(normalizePath('src/'), 'src')
  })

  it('survives non-strings', () => {
    assert.equal(normalizePath(undefined), '')
    assert.equal(normalizePath(42), '')
  })
})

describe('compileGlob', () => {
  it('matches a bare pattern at any depth', () => {
    assert.equal(compileGlob('*.md').test('readme.md'), true)
    assert.equal(compileGlob('*.md').test('notes/readme.md'), true)
    assert.equal(compileGlob('*.md').test('notes/readme.txt'), false)
  })

  it('anchors a pattern that names a directory', () => {
    assert.equal(compileGlob('src/*.ts').test('src/a.ts'), true)
    assert.equal(compileGlob('src/*.ts').test('other/src/a.ts'), false)
    assert.equal(compileGlob('src/*.ts').test('src/deep/a.ts'), false)
  })

  it('lets ** cross separators and match nothing', () => {
    assert.equal(compileGlob('**/*.ts').test('a.ts'), true)
    assert.equal(compileGlob('**/*.ts').test('src/deep/a.ts'), true)
    assert.equal(compileGlob('src/**').test('src/deep/a.ts'), true)
  })

  it('treats ? as one character and {a,b} as alternation', () => {
    assert.equal(compileGlob('a?.ts').test('ab.ts'), true)
    assert.equal(compileGlob('a?.ts').test('a/b.ts'), false)
    assert.equal(compileGlob('*.{ts,tsx}').test('a.tsx'), true)
    assert.equal(compileGlob('*.{ts,tsx}').test('a.js'), false)
  })

  it('escapes regex metacharacters in the pattern', () => {
    assert.equal(compileGlob('a+b.ts').test('a+b.ts'), true)
    assert.equal(compileGlob('a+b.ts').test('aab.ts'), false)
  })

  it('folds case only when asked', () => {
    assert.equal(compileGlob('*.MD', { caseInsensitive: true }).test('readme.md'), true)
    assert.equal(compileGlob('*.MD', { caseInsensitive: false }).test('readme.md'), false)
  })
})

describe('matchesAny', () => {
  it('matches everything when the list is empty', () => {
    assert.equal(matchesAny('anything', []), true)
    assert.equal(matchesAny('anything', undefined), true)
  })

  it('lets a negation carve an exception out of a broad include', () => {
    assert.equal(matchesAny('src/a.ts', ['**/*.ts', '!**/*.test.ts']), true)
    assert.equal(matchesAny('src/a.test.ts', ['**/*.ts', '!**/*.test.ts']), false)
  })

  it('treats a list of only negations as "everything except"', () => {
    assert.equal(matchesAny('src/a.ts', ['!**/*.test.ts']), true)
    assert.equal(matchesAny('src/a.test.ts', ['!**/*.test.ts']), false)
  })
})

describe('isIgnored', () => {
  it('matches a bare name at any depth', () => {
    assert.equal(isIgnored('node_modules/pkg/index.js', ['node_modules']), true)
    assert.equal(isIgnored('a/b/node_modules', ['node_modules']), true)
    assert.equal(isIgnored('src/index.js', ['node_modules']), false)
  })

  it('matches a path-shaped pattern against the whole relative path', () => {
    assert.equal(isIgnored('build/a.map', ['build/*.map']), true)
    assert.equal(isIgnored('other/build/a.map', ['build/*.map']), false)
  })

  it('re-includes with a leading bang, checked last', () => {
    assert.equal(isIgnored('src/a.ts', ['**', '!src/**']), false)
    assert.equal(isIgnored('other/a.ts', ['**', '!src/**']), true)
  })

  it('ignores nothing for an empty list', () => {
    assert.equal(isIgnored('anything', []), false)
  })
})

describe('relativeTo', () => {
  const options = { caseInsensitive: true }

  it('strips the root and returns a POSIX path', () => {
    assert.equal(relativeTo('E:\\work\\repo\\src\\a.ts', 'E:\\work\\repo', options), 'src/a.ts')
  })

  it('returns an empty string for the root itself', () => {
    assert.equal(relativeTo('E:\\work\\repo', 'E:/work/repo', options), '')
  })

  it('returns null for a path outside the root', () => {
    assert.equal(relativeTo('E:\\other\\a.ts', 'E:/work/repo', options), null)
  })

  it('does not confuse a sibling with a prefix match', () => {
    assert.equal(relativeTo('E:\\work\\repo2\\a.ts', 'E:/work/repo', options), null)
  })
})

describe('resolveWatchPath', () => {
  const fakeResolve = (...parts) => parts.join('/')

  it('resolves a relative path against the workspace', () => {
    assert.equal(resolveWatchPath('reports', '/work', fakeResolve), '/work/reports')
  })

  it('keeps an absolute POSIX path', () => {
    assert.equal(resolveWatchPath('/tmp/reports', '/work', fakeResolve), '/tmp/reports')
  })

  it('keeps an absolute Windows path', () => {
    assert.equal(resolveWatchPath('E:\\reports', '/work', fakeResolve), 'E:/reports')
  })

  it('falls back to plain resolution without a workspace', () => {
    assert.equal(resolveWatchPath('reports', undefined, (...parts) => parts.join('/')), 'reports')
  })

  it('refuses an empty path', () => {
    assert.throws(() => resolveWatchPath('   ', '/work', fakeResolve), /needs a path/u)
  })
})

describe('caseInsensitive', () => {
  it('folds on Windows and macOS only', () => {
    assert.equal(caseInsensitive('win32'), true)
    assert.equal(caseInsensitive('darwin'), true)
    assert.equal(caseInsensitive('linux'), false)
  })
})

describe('diffSnapshots', () => {
  it('classifies created, changed and deleted', () => {
    const before = snapshotOf({ 'a.ts': [10, 100], 'b.ts': [20, 200], 'gone.ts': [1, 1] })
    const after = snapshotOf({ 'a.ts': [10, 100], 'b.ts': [21, 300], 'new.ts': [5, 5] })
    const diff = diffSnapshots(before, after)
    assert.deepEqual(diff.created.map((e) => e.path), ['new.ts'])
    assert.deepEqual(diff.changed.map((e) => e.path), ['b.ts'])
    assert.deepEqual(diff.deleted.map((e) => e.path), ['gone.ts'])
    assert.deepEqual(diff.changed[0].previous, { size: 20, mtimeMs: 200 })
  })

  it('reports a same-size rewrite by mtime', () => {
    const diff = diffSnapshots(snapshotOf({ 'a.ts': [10, 100] }), snapshotOf({ 'a.ts': [10, 101] }))
    assert.equal(diff.changed.length, 1)
  })

  it('does not report a directory whose mtime advanced', () => {
    const before = snapshotOf({ src: [0, 100, 'directory'] })
    const after = snapshotOf({ src: [0, 999, 'directory'] })
    assert.equal(isEmptyDiff(diffSnapshots(before, after)), true)
  })

  it('reports a new directory as created', () => {
    const diff = diffSnapshots(new Map(), snapshotOf({ src: [0, 5, 'directory'] }))
    assert.deepEqual(diff.created.map((e) => [e.path, e.kind]), [['src', 'directory']])
  })

  it('sorts every list by path', () => {
    const diff = diffSnapshots(new Map(), snapshotOf({ 'z.ts': [1, 1], 'a.ts': [1, 1], 'm.ts': [1, 1] }))
    assert.deepEqual(diff.created.map((e) => e.path), ['a.ts', 'm.ts', 'z.ts'])
  })
})

describe('countEvents / flattenDiff / filterDiff', () => {
  const diff = {
    created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }],
    changed: [{ path: 'b.ts', size: 1, mtimeMs: 1 }],
    deleted: [{ path: 'c.ts', size: 1, mtimeMs: 1 }],
  }

  it('counts across all three lists', () => {
    assert.equal(countEvents(diff), 3)
    assert.equal(countEvents({ created: [], changed: [], deleted: [] }), 0)
  })

  it('flattens with an action label', () => {
    assert.deepEqual(flattenDiff(diff).map((row) => [row.action, row.event.path]), [
      ['created', 'a.ts'],
      ['changed', 'b.ts'],
      ['deleted', 'c.ts'],
    ])
  })

  it('filters deletions too', () => {
    const filtered = filterDiff(diff, (path) => path !== 'b.ts')
    assert.equal(countEvents(filtered), 2)
  })
})

describe('pruneNestedDeletions', () => {
  it('drops descendants of a deleted directory', () => {
    const events = [
      { path: 'src', kind: 'directory' },
      { path: 'src/a.ts', kind: 'file' },
      { path: 'src/deep/b.ts', kind: 'file' },
      { path: 'other.ts', kind: 'file' },
    ]
    assert.deepEqual(pruneNestedDeletions(events).map((e) => e.path), ['src', 'other.ts'])
  })

  it('keeps everything when no directory was deleted', () => {
    const events = [{ path: 'src/a.ts', kind: 'file' }, { path: 'src/b.ts', kind: 'file' }]
    assert.equal(pruneNestedDeletions(events).length, 2)
  })
})

describe('createEchoLedger', () => {
  it('suppresses a path inside the window and releases it after', () => {
    let clock = 1000
    const ledger = createEchoLedger({ windowMs: 500, now: () => clock })
    ledger.record(['E:\\repo\\a.ts'])
    assert.equal(ledger.isEcho('e:/repo/a.ts'), true)
    clock = 1600
    assert.equal(ledger.isEcho('e:/repo/a.ts'), false)
  })

  it('folds case so a Windows path matches its own spelling', () => {
    const ledger = createEchoLedger({ windowMs: 500, now: () => 0 })
    ledger.record(['E:\\Repo\\A.TS'])
    assert.equal(ledger.isEcho('E:/repo/a.ts'), true)
  })

  it('splits a path list into kept and suppressed', () => {
    const ledger = createEchoLedger({ windowMs: 500, now: () => 0 })
    ledger.record(['a.ts'])
    const split = ledger.suppress(['a.ts', 'b.ts'])
    assert.deepEqual(split.suppressed, ['a.ts'])
    assert.deepEqual(split.kept, ['b.ts'])
  })

  it('bounds the ledger size', () => {
    const ledger = createEchoLedger({ windowMs: 10_000, limit: 3, now: () => 0 })
    ledger.record(['a', 'b', 'c', 'd', 'e'])
    assert.equal(ledger.size(), 3)
  })

  it('forgets nothing when nothing was recorded', () => {
    const ledger = createEchoLedger({ now: () => 0 })
    assert.equal(ledger.isEcho('a.ts'), false)
  })
})

describe('pathsFromToolCall', () => {
  it('reads file_path from a write call, with certainty', () => {
    const result = pathsFromToolCall('write', { file_path: 'E:\\repo\\a.ts', content: 'x' })
    assert.deepEqual(result, { paths: ['E:\\repo\\a.ts'], certain: true })
  })

  it('reads path from a str_replace_editor call', () => {
    const result = pathsFromToolCall('str_replace_editor', { path: '/repo/a.ts', old_str: 'a' })
    assert.deepEqual(result, { paths: ['/repo/a.ts'], certain: true })
  })

  it('guesses from shell command text, marked uncertain', () => {
    const result = pathsFromToolCall('pwsh', { command: 'Set-Content -Path E:\\repo\\out.txt -Value hi' })
    assert.equal(result.certain, false)
    assert.ok(result.paths.includes('E:\\repo\\out.txt'))
  })

  it('returns nothing for an unrelated tool', () => {
    assert.deepEqual(pathsFromToolCall('web_search', { query: 'x' }), { paths: [], certain: false })
  })

  it('survives malformed input', () => {
    assert.deepEqual(pathsFromToolCall(undefined, undefined), { paths: [], certain: false })
    assert.deepEqual(pathsFromToolCall('write', null), { paths: [], certain: false })
  })
})

describe('pathsFromCommand', () => {
  it('extracts quoted paths', () => {
    assert.deepEqual(pathsFromCommand('cp "src/a.ts" "dst/b.ts"'), ['src/a.ts', 'dst/b.ts'])
  })

  it('extracts bare path-shaped tokens', () => {
    const found = pathsFromCommand('node ./scripts/build.mjs --out dist/bundle.js')
    assert.ok(found.includes('./scripts/build.mjs'))
    assert.ok(found.includes('dist/bundle.js'))
  })

  it('skips flags, urls and short tokens', () => {
    const found = pathsFromCommand('curl --output-file https://example.com/a.json -v')
    assert.equal(found.includes('https://example.com/a.json'), false)
    assert.equal(found.some((value) => value.startsWith('-')), false)
  })

  it('returns nothing for an empty command', () => {
    assert.deepEqual(pathsFromCommand(''), [])
    assert.deepEqual(pathsFromCommand(undefined), [])
  })
})

describe('createBatcher', () => {
  const empty = { created: [], changed: [], deleted: [] }

  it('waits for quiet before reporting due', () => {
    let clock = 0
    const batcher = createBatcher({ quietMs: 400, maxWaitMs: 5000, now: () => clock })
    batcher.push({ created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] })
    assert.equal(batcher.due(), false)
    clock = 399
    assert.equal(batcher.due(), false)
    clock = 400
    assert.equal(batcher.due(), true)
  })

  it('reports due at the ceiling even while changes keep arriving', () => {
    let clock = 0
    const batcher = createBatcher({ quietMs: 10_000, maxWaitMs: 1000, now: () => clock })
    for (let index = 0; index < 20; index += 1) {
      clock = index * 100
      batcher.push({ created: [{ path: `f${index}.ts`, size: 1, mtimeMs: 1 }], changed: [], deleted: [] })
    }
    assert.equal(batcher.due(), true)
  })

  it('coalesces a path written twice into one latest record', () => {
    const batcher = createBatcher({ quietMs: 0, maxWaitMs: 1, now: () => 0 })
    batcher.push({ created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] })
    batcher.push({ created: [], changed: [{ path: 'a.ts', size: 2, mtimeMs: 2 }], deleted: [] })
    const batch = batcher.drain()
    assert.equal(countEvents(batch.diff), 1)
    assert.equal(batch.diff.changed[0].size, 2)
  })

  it('respects the cooldown between deliveries', () => {
    let clock = 0
    const batcher = createBatcher({ quietMs: 0, maxWaitMs: 1, cooldownMs: 1000, now: () => clock })
    batcher.push({ created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] })
    batcher.drain()
    clock = 500
    batcher.push({ created: [{ path: 'b.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] })
    assert.equal(batcher.due(), false)
    clock = 1000
    assert.equal(batcher.due(), true)
  })

  it('truncates past the event cap and says so', () => {
    const batcher = createBatcher({ quietMs: 0, maxWaitMs: 1, maxEvents: 2, now: () => 0 })
    batcher.push({
      created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }, { path: 'b.ts', size: 1, mtimeMs: 1 }, { path: 'c.ts', size: 1, mtimeMs: 1 }],
      changed: [],
      deleted: [],
    })
    const batch = batcher.drain()
    assert.equal(batch.truncated, true)
    assert.equal(countEvents(batch.diff), 2)
  })

  it('counts suppressed events into the next batch', () => {
    const batcher = createBatcher({ quietMs: 0, maxWaitMs: 1, now: () => 0 })
    batcher.push({ created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] })
    batcher.noteSuppressed(4)
    assert.equal(batcher.drain().suppressed, 4)
  })

  it('has nothing to drain when nothing was pushed', () => {
    const batcher = createBatcher({ now: () => 0 })
    batcher.push(empty)
    assert.equal(batcher.due(), false)
    assert.equal(batcher.drain(), undefined)
    assert.equal(batcher.pending(), 0)
  })

  it('drops pending events on reset', () => {
    const batcher = createBatcher({ quietMs: 0, maxWaitMs: 1, now: () => 0 })
    batcher.push({ created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] })
    batcher.reset()
    assert.equal(batcher.pending(), 0)
  })
})

describe('applyWatchRules', () => {
  it('keeps only what the watch selects', () => {
    const watch = { select: (path) => path.endsWith('.ts') }
    const diff = {
      created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }, { path: 'b.js', size: 1, mtimeMs: 1 }],
      changed: [],
      deleted: [{ path: 'c.js', size: 1, mtimeMs: 1 }],
    }
    assert.equal(countEvents(applyWatchRules(diff, watch)), 1)
  })
})

describe('takeSnapshot', () => {
  let root

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'folderwatch-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'readme.md'), 'hello')
    await writeFile(join(root, 'src', 'a.ts'), 'export {}')
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}')
  })

  after(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('walks a tree and records files and directories', async () => {
    const snapshot = await takeSnapshot(root, { ignore: ['node_modules'] })
    assert.equal(snapshot.entries.has('readme.md'), true)
    assert.equal(snapshot.entries.has('src/a.ts'), true)
    assert.equal(snapshot.entries.get('src').kind, 'directory')
    assert.equal(snapshot.entries.has('node_modules'), false)
    assert.equal(snapshot.truncated, false)
  })

  it('honours the entry cap', async () => {
    const snapshot = await takeSnapshot(root, { maxEntries: 1 })
    assert.equal(snapshot.truncated, true)
    assert.equal(snapshot.entries.size, 1)
  })

  it('stops descending at the depth cap', async () => {
    const shallow = await takeSnapshot(root, { maxDepth: 0, ignore: [] })
    assert.equal(shallow.entries.has('src/a.ts'), false)
    assert.equal(shallow.entries.has('src'), true)
  })

  it('reports a missing root as unreadable rather than throwing', async () => {
    const snapshot = await takeSnapshot(join(root, 'does-not-exist'))
    assert.equal(snapshot.entries.size, 0)
    assert.deepEqual(snapshot.unreadable, ['.'])
  })

  it('summarises counts by kind', async () => {
    const snapshot = await takeSnapshot(root, { ignore: ['node_modules'] })
    const summary = summarizeSnapshot(snapshot)
    assert.equal(summary.total, snapshot.entries.size)
    assert.equal(summary.files + summary.directories, summary.total)
  })

  it('sees a real change between two snapshots', async () => {
    const before = await takeSnapshot(root, { ignore: ['node_modules'] })
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1')
    const after = await takeSnapshot(root, { ignore: ['node_modules'] })
    const diff = diffSnapshots(before.entries, after.entries)
    assert.deepEqual(diff.created.map((event) => event.path), ['src/b.ts'])
  })
})

describe('FolderWatch echo suppression', () => {
  /**
   * Build a watch over a synthetic root with no filesystem behind it.
   *
   * @param {object} options - ledger and spec overrides.
   * @returns {FolderWatch} the watch.
   */
  function watchOver(options = {}) {
    return new FolderWatch(
      { id: 'w', root: options.root ?? 'E:/repo', pattern: options.pattern, ignore: [], echo: options.echo },
      async () => {},
    )
  }

  it('drops a change to a path this session wrote', () => {
    const echo = createEchoLedger({ windowMs: 10_000, now: () => 0 })
    echo.record(['E:\\repo\\src\\a.ts'])
    const watch = watchOver({ echo })
    const diff = { created: [], changed: [{ path: 'src/a.ts', size: 1, mtimeMs: 1 }], deleted: [] }
    const result = watch.suppressEchoes(diff)
    assert.equal(countEvents(result.diff), 0)
    assert.equal(result.suppressed, 1)
  })

  it('keeps a change to a path this session never touched', () => {
    const echo = createEchoLedger({ windowMs: 10_000, now: () => 0 })
    echo.record(['E:\\repo\\src\\a.ts'])
    const watch = watchOver({ echo })
    const diff = { created: [{ path: 'src/b.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] }
    const result = watch.suppressEchoes(diff)
    assert.equal(countEvents(result.diff), 1)
    assert.equal(result.suppressed, 0)
  })

  it('joins the relative event path back onto the root before consulting the ledger', () => {
    /* The ledger keys on absolute paths because that is what a tool call names;
     * a diff event carries a path relative to the root. Getting this join wrong
     * means suppression silently never fires. */
    const echo = createEchoLedger({ windowMs: 10_000, now: () => 0 })
    echo.record(['E:/repo/deep/nested/x.ts'])
    const watch = watchOver({ echo })
    const diff = { created: [], changed: [{ path: 'deep/nested/x.ts', size: 1, mtimeMs: 1 }], deleted: [] }
    assert.equal(watch.suppressEchoes(diff).suppressed, 1)
  })

  it('does not suppress when no ledger was supplied', () => {
    const watch = watchOver()
    const diff = { created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] }
    const result = watch.suppressEchoes(diff)
    assert.equal(result.suppressed, 0)
    assert.equal(countEvents(result.diff), 1)
  })

  it('counts suppressed events into the pending batch', () => {
    const echo = createEchoLedger({ windowMs: 10_000, now: () => 0 })
    echo.record(['E:/repo/a.ts'])
    const watch = watchOver({ echo })
    const staged = watch.stage({
      created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }],
      changed: [{ path: 'b.ts', size: 1, mtimeMs: 1 }],
      deleted: [],
    })
    assert.equal(staged.events, 1)
    assert.equal(staged.suppressed, 1)
    const batch = watch.batcher.drain()
    assert.equal(batch.suppressed, 1)
    assert.equal(countEvents(batch.diff), 1)
  })

  it('applies the pattern before the echo check, so a filtered path is not counted as suppressed', () => {
    const echo = createEchoLedger({ windowMs: 10_000, now: () => 0 })
    echo.record(['E:/repo/notes.md'])
    const watch = watchOver({ echo, pattern: '**/*.ts' })
    const staged = watch.stage({
      created: [{ path: 'notes.md', size: 1, mtimeMs: 1 }, { path: 'code.ts', size: 1, mtimeMs: 1 }],
      changed: [],
      deleted: [],
    })
    assert.equal(staged.events, 1)
    assert.equal(staged.suppressed, 0, 'a path the pattern excluded was never a candidate for suppression')
  })

  it('has nothing staged for an empty diff', () => {
    const watch = watchOver()
    const staged = watch.stage({ created: [], changed: [], deleted: [] })
    assert.equal(staged.events, 0)
    assert.equal(watch.batcher.pending(), 0)
  })
})

describe('format', () => {
  it('renders bytes compactly without a pointless .0', () => {
    assert.equal(humanBytes(0), '0B')
    assert.equal(humanBytes(812), '812B')
    assert.equal(humanBytes(1024), '1KB')
    assert.equal(humanBytes(1536), '1.5KB')
    assert.equal(humanBytes(1024 * 1024 * 12), '12MB')
    assert.equal(humanBytes(-1), '0B')
  })

  it('renders ages at every scale', () => {
    assert.equal(humanAge(1), 'just now')
    assert.equal(humanAge(45), '45s')
    assert.equal(humanAge(600), '10m')
    assert.equal(humanAge(8000), '2h13m')
    assert.equal(humanAge(200_000), '2d7h')
    assert.equal(humanAge(Number.NaN), 'unknown')
  })

  it('shortens a long path from the left', () => {
    const long = `E:/${'x'.repeat(200)}/a.ts`
    const short = shortenPath(long, 20)
    assert.equal(short.length, 20)
    assert.ok(short.endsWith('a.ts'))
    assert.equal(shortenPath('a.ts', 20), 'a.ts')
  })

  it('renders one line per event with an action marker', () => {
    const lines = renderEvents({
      created: [{ path: 'a.ts', size: 10, mtimeMs: 1 }],
      changed: [{ path: 'b.ts', size: 20, mtimeMs: 1 }],
      deleted: [{ path: 'c.ts', size: 30, mtimeMs: 1 }],
    })
    assert.equal(lines.length, 3)
    assert.match(lines[0], /^\s+\+ a\.ts/u)
    assert.match(lines[1], /^\s+~ b\.ts/u)
    assert.match(lines[2], /^\s+- c\.ts/u)
  })

  it('truncates a long event list and says how many were hidden', () => {
    const created = Array.from({ length: 10 }, (_, index) => ({ path: `f${index}.ts`, size: 1, mtimeMs: 1 }))
    const lines = renderEvents({ created, changed: [], deleted: [] }, { limit: 3 })
    assert.equal(lines.length, 4)
    assert.match(lines[3], /and 7 more/u)
  })

  it('renders a notification with a self-describing heading', () => {
    const text = renderNotification(
      { id: 'reports', root: 'E:/work/reports', prompt: 'Summarise the failures.' },
      { diff: { created: [{ path: 'a.json', size: 12, mtimeMs: 1 }], changed: [], deleted: [] }, suppressed: 2, truncated: false },
      { at: '2026-10-16T00:00:00.000Z' },
    )
    assert.match(text, /^\[folderwatch\] 1 change under E:\/work\/reports/u)
    assert.match(text, /1 created/u)
    assert.match(text, /2 events suppressed as this session's own writes/u)
    assert.match(text, /Summarise the failures\./u)
  })

  it('does not repeat the id when the label says the same thing', () => {
    const text = renderNotification(
      { id: 'reports', label: 'reports', root: '/r' },
      { diff: { created: [], changed: [], deleted: [] }, suppressed: 0, truncated: false },
    )
    assert.match(text, /watch: reports$/mu)
    assert.doesNotMatch(text, /reports \(reports\)/u)
  })

  it('keeps a distinct label alongside the id', () => {
    const text = renderNotification(
      { id: 'reports', label: 'build output', root: '/r' },
      { diff: { created: [], changed: [], deleted: [] }, suppressed: 0, truncated: false },
    )
    assert.match(text, /watch: build output \(reports\)/u)
  })

  it('says so when a batch was truncated', () => {
    const text = renderNotification(
      { id: 'w', root: '/r' },
      { diff: { created: [], changed: [], deleted: [] }, suppressed: 0, truncated: true },
    )
    assert.match(text, /list truncated/u)
  })

  it('renders an arm report with the delivery mode spelled out', () => {
    const text = renderArm({
      id: 'reports',
      root: 'E:/work/reports',
      files: 3,
      directories: 1,
      watchKind: 'watch+poll',
      mode: 'queue',
      ignore: ['node_modules'],
      once: false,
      truncatedSnapshot: false,
      unreadable: [],
    })
    assert.match(text, /armed "reports"/u)
    assert.match(text, /3 file\(s\), 1 directory/u)
    assert.match(text, /queue for the next step/u)
  })

  it('warns in the arm report when the snapshot was partial', () => {
    const text = renderArm({ id: 'w', root: '/r', files: 1, directories: 0, watchKind: 'poll', mode: 'wake', ignore: [], truncatedSnapshot: true, unreadable: ['a', 'b'] })
    assert.match(text, /entry cap/u)
    assert.match(text, /could not read 2 directories/u)
  })

  it('renders an empty inventory with instructions', () => {
    const text = renderList([])
    assert.match(text, /no watches armed/u)
    assert.match(text, /folderwatch_add/u)
  })

  it('renders an inventory with firing history', () => {
    const text = renderList(
      [
        {
          id: 'reports',
          root: 'E:/work/reports',
          state: 'armed',
          files: 4,
          deliveries: 2,
          lastDeliveryAt: new Date(1_000_000).toISOString(),
          pending: 3,
          pattern: '**/*.json',
        },
      ],
      { now: 1_060_000 },
    )
    assert.match(text, /1 watch/u)
    assert.match(text, /reports\s+armed/u)
    assert.match(text, /last fired 1m ago/u)
    assert.match(text, /3 change\(s\) pending/u)
  })

  it('states a stopped watch once, not twice', () => {
    const text = renderList(
      [{ id: 'inbox', root: '/r', state: 'stopped', files: 1, deliveries: 0, pending: 0 }],
      { now: 0 },
    )
    assert.match(text, /inbox\s+stopped\s+1 file/u)
    assert.doesNotMatch(text, /stopped · stopped/u)
  })

  it('renders a check result that changed nothing', () => {
    const text = renderCheck({ id: 'w' }, { diff: { created: [], changed: [], deleted: [] }, events: 0 })
    assert.match(text, /nothing changed/u)
  })

  it('renders a check result that did change something', () => {
    const text = renderCheck(
      { id: 'w' },
      { diff: { created: [{ path: 'a.ts', size: 1, mtimeMs: 1 }], changed: [], deleted: [] }, events: 1 },
    )
    assert.match(text, /1 change\(s\) since the last scan/u)
    assert.match(text, /no message was delivered/u)
  })
})
