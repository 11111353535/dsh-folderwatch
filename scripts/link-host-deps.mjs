/**
 * Point this checkout at the harness's own copies of the host packages.
 *
 * This plugin ships no dependencies on purpose: at runtime the harness resolves
 * `@deepseek-ai/*` from its own installation, and a bundled copy would shadow
 * the real one. But a checkout with no `node_modules` cannot import those
 * packages at all, so this script links the few that `lib/` imports.
 *
 * Junctions on Windows, symlinks elsewhere — `ln -s` needs developer mode on
 * Windows and `mklink /J` needs cmd, so the platform is branched explicitly.
 *
 * Usage: `npm run setup:deps` (or `node scripts/link-host-deps.mjs`).
 *
 * @module dsh-folderwatch/scripts/link-host-deps
 */

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Packages `lib/` imports, by their directory name under the host scope. */
const HOST_PACKAGES = ['cordis', 'dsh-tools', 'dsh-llm', 'schemastery']

/** Package that must exist for a candidate to count as the harness. */
const SENTINEL = 'dsh-tools'

/** Suffix every packaged harness install puts its libraries behind. */
const APP_SUFFIX = ['resources', 'app', 'node_modules']

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Whether a directory holds the harness's `@deepseek-ai` scope.
 *
 * A directory merely existing is not enough: the sentinel package must be
 * there, because an empty or unrelated scope would link nothing and produce a
 * confusing import failure much later.
 *
 * @param {string} nodeModules - candidate `node_modules` directory.
 * @returns {string | undefined} the `@deepseek-ai` scope, when present.
 */
function scopeIn(nodeModules) {
  const scope = join(nodeModules, '@deepseek-ai')
  return existsSync(join(scope, SENTINEL, 'package.json')) ? scope : undefined
}

/**
 * Read a directory's immediate subdirectories, tolerating a failure.
 *
 * @param {string} directory - directory to list.
 * @returns {string[]} absolute child directory paths.
 */
function childDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
  } catch {
    return []
  }
}

/**
 * Every `node_modules` directory that plausibly belongs to a harness install.
 *
 * Cheap candidates first — the ones a standard install uses — then a bounded
 * sweep for a portable or unusually-placed install. The sweep stays at depth
 * two and only descends into directories whose name looks harness-related, so
 * it costs a handful of `readdir` calls rather than a filesystem crawl.
 *
 * @returns {string[]} candidate `node_modules` directories.
 */
function candidateNodeModules() {
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '') candidates.push(value)
  }

  push(process.env.DSH_HOST_NODE_MODULES)

  const home = process.env.DSH_HOME
  if (home !== undefined) {
    const runtimes = join(home, 'dsh-runtimes')
    for (const runtime of childDirectories(runtimes)) {
      push(join(runtime, 'node_modules'))
      push(join(runtime, 'dependencies', 'node_modules'))
    }
  }
  if (process.env.LOCALAPPDATA !== undefined) {
    push(join(process.env.LOCALAPPDATA, 'Programs', 'dsh', ...APP_SUFFIX))
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[key]
    if (base !== undefined) push(join(base, 'DSH', ...APP_SUFFIX))
  }

  /* Bounded sweep: a packaged harness is always `<something>/resources/app`.
   * Only directories named after the product are descended into. */
  const roots = process.platform === 'win32'
    ? ['C:\\', 'D:\\', 'E:\\', 'F:\\']
    : ['/opt', '/usr/local', '/Applications']
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const first of childDirectories(root)) {
      const name = first.toLowerCase()
      if (!name.includes('dsh') && !name.includes('deepseek')) continue
      push(join(first, ...APP_SUFFIX))
      for (const second of childDirectories(first)) {
        push(join(second, ...APP_SUFFIX))
      }
    }
  }
  return candidates
}

/**
 * Locate the harness installation that owns `@deepseek-ai/*`.
 *
 * @returns {string | undefined} the `@deepseek-ai` directory, when found.
 */
function findHostScope() {
  for (const candidate of candidateNodeModules()) {
    const scope = scopeIn(candidate)
    if (scope !== undefined) return scope
  }
  return undefined
}

const scope = findHostScope()
if (scope === undefined) {
  console.error('Could not find the harness installation.')
  console.error('Set DSH_HOST_NODE_MODULES to the harness node_modules directory and retry, e.g.')
  console.error('  $env:DSH_HOST_NODE_MODULES = "C:\\path\\to\\DSH Desktop\\resources\\app\\node_modules"')
  process.exit(1)
}

const target = join(packageRoot, 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })

let linked = 0
for (const name of HOST_PACKAGES) {
  const source = join(scope, name)
  if (!existsSync(source)) {
    console.warn(`skip ${name}: not present in ${scope}`)
    continue
  }
  const destination = join(target, name)
  rmSync(destination, { recursive: true, force: true })
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`linked ${name} -> ${source}`)
  linked += 1
}

console.log(`\n${linked} package(s) linked from ${scope}`)
console.log('Run `npm test` for the pure modules, then `npm run test:live` against a real filesystem.')
