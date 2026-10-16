/**
 * dsh-folderwatch — arm a directory and wake the agent when it changes.
 *
 * The harness can already wake an agent on a clock (scheduled tasks) and on an
 * HTTP request (webhooks). Neither covers the case that actually matters in a
 * working session: something outside the conversation touches a file. A build
 * finishes, a formatter rewrites the tree, a test runner drops a report, a
 * colleague pushes into a shared folder, a download lands. Today the agent finds
 * out only if it happens to look.
 *
 * This plugin closes that gap. A watch is armed against a directory and the
 * agent that armed it; when the tree changes — after the burst settles — the
 * agent receives a message describing exactly what changed, and can be woken to
 * act on it or simply have it waiting at its next step.
 *
 * Three design choices are worth stating up front, because they are the
 * difference between a watcher you keep and one you uninstall:
 *
 * 1. **Snapshots, not raw events.** `fs.watch` reports that something happened,
 *    not what; it double-fires on Windows and can miss changes under load. The
 *    watcher takes snapshots and diffs them, so renames, deletions and bursts
 *    are classified correctly on every platform. `fs.watch` is kept only as a
 *    hint to rescan sooner.
 * 2. **Echo suppression.** The agent's own writes must not wake the agent.
 *    Tool calls that name a file are recorded in a short-lived ledger, and
 *    changes to those paths inside the window are counted as suppressed rather
 *    than delivered. Without this, an agent editing a watched tree talks to
 *    itself in a loop.
 * 3. **Delivery is opt-in per watch.** `mode: 'wake'` calls `followup` and
 *    starts a turn; `mode: 'queue'` calls `inject` and waits for the agent's
 *    next step. A watcher that can always interrupt is a watcher nobody leaves
 *    armed, so the quieter option is one argument away.
 *
 * @module dsh-folderwatch
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { countEvents } from './diff.js'
import { createEchoLedger, pathsFromToolCall } from './echo.js'
import {
  renderArm,
  renderCheck,
  renderEvents,
  renderList,
  renderNotification,
  renderProblem,
  renderRemoval,
} from './format.js'
import { caseInsensitive, matchesAny, normalizePath, relativeTo, resolveWatchPath } from './match.js'
import { FolderWatch } from './watch.js'

/** Plugin name, as the profile's patch file refers to it. */
export const name = 'dsh-folderwatch'

/**
 * Services this plugin needs.
 *
 * A static array, not a function: the harness rejects a function form by
 * disabling the whole bundle, and a plugin that declares its services wrongly
 * fails silently rather than loudly. `sessionController` and `sessions` are
 * optional and reached through `ctx.get`, so a deployment without them loses
 * session-based delivery but keeps everything else.
 */
export const inject = ['tools', 'commands']

/** Directory names no watcher wants to hear about. */
const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  'coverage',
  '.DS_Store',
  'Thumbs.db',
]

/**
 * Per-profile configuration.
 *
 * Every knob that could reasonably differ between machines lives here rather
 * than in a constant, so tuning a profile never means editing code.
 */
export const Config = Schema.object({
  watches: Schema.array(
    Schema.object({
      path: Schema.string().description('Directory to watch, absolute or relative to the workspace.'),
      id: Schema.string().description('Optional stable id; derived from the path when omitted.'),
      label: Schema.string().description('Human-readable name shown in listings and notifications.'),
      prompt: Schema.string().description('Instruction appended to the notification the agent receives.'),
      pattern: Schema.string().description('Glob selecting which paths are reported, e.g. "**/*.ts".'),
      ignore: Schema.array(Schema.string()).description('Extra ignore patterns for this watch.'),
      recursive: Schema.boolean().description('Descend into subdirectories. Defaults to true.'),
      once: Schema.boolean().description('Disarm after the first delivery. Defaults to false.'),
      mode: Schema.string().description('"wake" starts a turn; "queue" waits for the next step.'),
      sessionId: Schema.string().description('Session to notify when the watch was not armed by a tool call.'),
    }),
  )
    .description('Watches armed at load time. Tool-armed watches are the usual path.')
    .default([]),
  ignore: Schema.array(Schema.string())
    .description('Ignore patterns applied to every watch, merged with the per-watch list.')
    .default(DEFAULT_IGNORE),
  quietMs: Schema.number().description('Quiet period before a batch is delivered.').default(400),
  maxWaitMs: Schema.number().description('Ceiling on how long changes may wait for quiet.').default(5000),
  cooldownMs: Schema.number().description('Minimum gap between deliveries for one watch.').default(5000),
  pollIntervalMs: Schema.number().description('How often the tree is rescanned.').default(1500),
  maxWatches: Schema.number().description('Maximum number of simultaneously armed watches.').default(16),
  maxEntries: Schema.number().description('Snapshot entry cap, guarding against a runaway tree.').default(20000),
  echoWindowMs: Schema.number().description('How long a path stays suppressed after this session writes it.').default(2500),
  maxEventsPerMessage: Schema.number().description('Events listed in one notification before truncation.').default(60),
})

/**
 * Turn a path into a stable, readable watch id.
 *
 * @param {string} root - absolute watch root.
 * @returns {string} id.
 */
function deriveId(root) {
  const tail = normalizePath(root).replace(/[:/]+/gu, '-').replace(/^-+|-+$/gu, '')
  const trimmed = tail.length > 48 ? tail.slice(tail.length - 48) : tail
  return trimmed === '' ? 'watch' : trimmed.toLowerCase()
}

/**
 * Resolve the workspace root for a tool call, when the harness can tell us.
 *
 * Optional service, optional answer: a deployment without a workspace registry
 * still watches absolute paths, it just cannot resolve relative ones against a
 * workspace.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ agent?: { session?: { id?: string } } }} exec - the tool execution.
 * @returns {string | undefined} absolute workspace root.
 */
function workspaceRootFor(ctx, exec) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry === undefined) return undefined
    const session = exec?.agent?.session
    if (session !== undefined && typeof registry.forSession === 'function') {
      const root = registry.forSession(session)
      if (typeof root === 'string' && root !== '') return root
    }
    if (typeof registry.current === 'function') {
      const root = registry.current()
      if (typeof root === 'string' && root !== '') return root
    }
    if (typeof registry.defaultRoot === 'function') {
      const root = registry.defaultRoot()
      if (typeof root === 'string' && root !== '') return root
    }
  } catch {
    /* An optional service that misbehaves must not break the tool. */
  }
  return undefined
}

/**
 * Verify that a watch target exists and is a directory.
 *
 * Failing here, at arm time, with the actual path in the message is much better
 * than arming a watch that silently never fires because the path was a typo.
 *
 * @param {string} root - absolute path to check.
 * @returns {string | undefined} an error message, or undefined when usable.
 */
function checkTarget(root) {
  if (!existsSync(root)) return `no such path: ${root}`
  try {
    const info = statSync(root)
    if (info.isDirectory()) return undefined
    return `not a directory: ${root}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Build the plugin's live state.
 *
 * Kept in one closure so `apply()` reads as configuration rather than
 * bookkeeping, and so tests can construct it without a harness.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated configuration.
 * @returns {object} the registry and its helpers.
 */
function createRegistry(ctx, config) {
  /** @type {Map<string, FolderWatch>} */
  const watches = new Map()
  const echo = createEchoLedger({
    windowMs: config.echoWindowMs,
    caseInsensitive: caseInsensitive(),
  })
  let lastAgent

  /**
   * Remember the most recent agent seen, so a watch declared in configuration
   * (with no arming tool call) still has somewhere to deliver.
   *
   * @param {unknown} agent - candidate agent.
   * @returns {void}
   */
  function rememberAgent(agent) {
    if (agent !== undefined && agent !== null) lastAgent = agent
  }

  /**
   * Find a live agent to deliver to.
   *
   * Order: the agent that armed the watch, then the session it named, then the
   * most recent agent this plugin has seen. Each step is guarded — a session
   * that has since been archived must degrade to the next option, not throw.
   *
   * @param {FolderWatch} watch - the watch that fired.
   * @returns {Promise<object | undefined>} a live agent, when one can be found.
   */
  async function resolveAgent(watch) {
    if (watch.boundAgent !== undefined) {
      try {
        if (watch.boundAgent.session?.id !== undefined) return watch.boundAgent
      } catch {
        /* Disposed agents can throw on property access; fall through. */
      }
    }
    if (watch.sessionId !== undefined) {
      try {
        const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
        if (controller !== undefined && typeof controller.resolveAgent === 'function') {
          const found = await controller.resolveAgent(watch.sessionId)
          if (found?.agent !== undefined) return found.agent
        }
      } catch {
        /* Fall through to the session registry. */
      }
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        const session = sessions?.get?.(watch.sessionId)
        if (session?.agent !== undefined) return session.agent
      } catch {
        /* Fall through to the last-seen agent. */
      }
    }
    return lastAgent
  }

  /**
   * Deliver one batch to the agent behind a watch.
   *
   * @param {{ diff: object, suppressed: number, truncated: boolean }} batch - the batch to deliver.
   * @param {FolderWatch} watch - the watch that fired.
   * @returns {Promise<void>} resolves after the message is handed over.
   */
  async function deliver(batch, watch) {
    const agent = await resolveAgent(watch)
    if (agent === undefined) {
      throw new Error('no live agent to notify; arm the watch from a session or set sessionId')
    }
    const text = renderNotification(
      { id: watch.id, root: watch.root, label: watch.label, prompt: watch.prompt },
      batch,
      { limit: config.maxEventsPerMessage, at: new Date().toISOString() },
    )
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'folderwatch' },
    })
    if (watch.mode === 'queue' && typeof agent.inject === 'function') agent.inject(message)
    else if (typeof agent.followup === 'function') agent.followup(message)
    else if (typeof agent.inject === 'function') agent.inject(message)
    else throw new Error('the resolved agent exposes neither followup nor inject')
  }

  /**
   * Arm a new watch.
   *
   * @param {object} spec - watch specification.
   * @param {{ agent?: unknown, signal?: AbortSignal }} [origin] - the call that armed it.
   * @returns {Promise<{ ok: true, status: object } | { ok: false, error: string }>} the outcome.
   */
  async function arm(spec, origin = {}) {
    if (watches.size >= config.maxWatches) {
      return { ok: false, error: `too many watches armed (limit ${config.maxWatches}); remove one first` }
    }
    let root
    try {
      root = resolveWatchPath(spec.path, spec.workspace, resolve)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const problem = checkTarget(root)
    if (problem !== undefined) return { ok: false, error: problem }

    const id = typeof spec.id === 'string' && spec.id !== '' ? spec.id : deriveId(root)
    if (watches.has(id)) return { ok: false, error: `a watch with id "${id}" is already armed` }

    const ignore = [...config.ignore, ...(Array.isArray(spec.ignore) ? spec.ignore : [])]
    const watch = new FolderWatch(
      {
        id,
        root,
        label: spec.label,
        pattern: spec.pattern,
        ignore,
        recursive: spec.recursive,
        once: spec.once,
        mode: spec.mode,
        prompt: spec.prompt,
        sessionId: spec.sessionId,
        quietMs: config.quietMs,
        maxWaitMs: config.maxWaitMs,
        cooldownMs: config.cooldownMs,
        pollIntervalMs: config.pollIntervalMs,
        maxEntries: config.maxEntries,
        echo,
      },
      deliver,
      (error) => {
        ctx.logger?.warn?.(`dsh-folderwatch: watch "${id}": ${error.message}`)
      },
    )
    if (origin.agent !== undefined) watch.boundAgent = origin.agent
    watches.set(id, watch)
    try {
      await watch.start(origin.signal)
    } catch (error) {
      watches.delete(id)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, status: watch.status() }
  }

  /**
   * Disarm a watch and release its handles.
   *
   * @param {string} id - watch id.
   * @returns {Promise<object | undefined>} the final status, when it existed.
   */
  async function disarm(id) {
    const watch = watches.get(id)
    if (watch === undefined) return undefined
    const status = watch.status()
    await watch.stop()
    watches.delete(id)
    return status
  }

  /**
   * Disarm everything; used when the plugin unloads.
   *
   * @returns {Promise<void>} resolves once every watch is stopped.
   */
  async function disarmAll() {
    for (const watch of watches.values()) await watch.stop()
    watches.clear()
  }

  return {
    watches,
    echo,
    arm,
    disarm,
    disarmAll,
    rememberAgent,
    resolveAgent,
    statuses: () => [...watches.values()].map((watch) => watch.status()),
    get: (id) => watches.get(id),
  }
}

/**
 * Register the tools, the command and the observation hooks.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const registry = createRegistry(ctx, config)

  /* Registered before the first await, as the plugin contract requires: an
   * await here would place the registrations outside the disposer window and
   * they would leak on unload. */
  ctx.effect(() => () => {
    void registry.disarmAll()
  })

  /**
   * Record the agent behind every tool result.
   *
   * Two jobs in one observer. It keeps `lastAgent` current, which is how a
   * configuration-declared watch finds somewhere to deliver; and it records the
   * paths this session wrote, which is what echo suppression reads. It is a
   * read-only observer of an immutable result, so it can never change what a
   * tool call returns.
   */
  ctx.on('tools/result', (exec) => {
    registry.rememberAgent(exec?.agent)
    if (typeof exec?.name !== 'string') return
    const { paths, certain } = pathsFromToolCall(exec.name, exec.arguments)
    if (paths.length === 0) return
    const absolute = paths.map((path) => resolveWatchPath(path, undefined, resolve))
    registry.echo.record(absolute, { certain })
  })

  ctx.tools.register(
    defineTool({
      name: 'folderwatch_add',
      description:
        'Watch a directory and wake this agent when its contents change. Use it when work depends on something outside the conversation that you cannot poll: a build output directory, a test report location, a shared hand-off folder, a download target. Changes are batched after the tree goes quiet, and this session\'s own writes are filtered out so the watch never reports the agent back to itself. Delivery defaults to waking the agent with a new turn; pass mode: "queue" to have the report wait until the agent\'s next step instead.',
      parameters: {
        path: { type: 'string', required: true, description: 'Directory to watch. Absolute, or relative to the workspace.' },
        label: { type: 'string', description: 'Short name for this watch, shown in listings and notifications.' },
        prompt: { type: 'string', description: 'Instruction appended to each notification, e.g. "re-run the failing test".' },
        pattern: { type: 'string', description: 'Glob selecting which paths are reported, e.g. "**/*.log" or "src/**".' },
        ignore: {
          type: 'array',
          description: 'Extra ignore patterns for this watch. A bare name like "tmp" matches that name at any depth.',
          items: { type: 'string' },
        },
        recursive: { type: 'boolean', description: 'Descend into subdirectories. Defaults to true.' },
        once: { type: 'boolean', description: 'Disarm after the first delivery. Defaults to false.' },
        mode: {
          type: 'string',
          description: 'Delivery mode: "wake" (default) starts a turn; "queue" waits for the next step.',
          enum: ['wake', 'queue'],
        },
        sessionId: { type: 'string', description: 'Session to notify, when it is not the calling one.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: renderArm(value.status) }]
            : [{ type: 'text', text: renderProblem(value.id ?? 'watch', value.error) }],
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const workspace = workspaceRootFor(ctx, exec)
        const outcome = await registry.arm({ ...args, workspace }, { agent: exec.agent, signal: exec.signal })
        if (outcome.ok !== true) return { ok: false, id: args.label ?? args.path, error: outcome.error }
        return { ok: true, status: outcome.status }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'folderwatch_list',
      description:
        'List the directory watches armed in this session, with what each one is watching, how often it has fired, and whether any changes are pending delivery. Use it to check whether a watch is still worth keeping before adding another.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderList(value.watches, { now: Date.now() }) }],
      },
      timeoutMs: 10_000,
      async execute() {
        return { watches: registry.statuses() }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'folderwatch_check',
      description:
        'Rescan a watched directory right now and report what changed since the last scan, without delivering a message. Use it to answer "has anything happened yet" during a turn, instead of waiting for the watch to wake you.',
      parameters: {
        id: { type: 'string', required: true, description: 'Watch id, as returned by folderwatch_add or folderwatch_list.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: renderCheck(value.watch, { diff: value.diff, events: value.events, suppressed: value.suppressed }) }]
            : [{ type: 'text', text: renderProblem(value.id, value.error) }],
      },
      timeoutMs: 60_000,
      async execute(args) {
        const watch = registry.get(args.id)
        if (watch === undefined) return { ok: false, id: args.id, error: 'no such watch' }
        const result = await watch.check()
        return { ok: true, watch: watch.status(), diff: result.diff, events: result.events, suppressed: result.suppressed }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'folderwatch_fire',
      description:
        'Deliver a watch\'s pending changes immediately instead of waiting for the quiet period. Use it to confirm the delivery path works, or when a batch is known to be complete and waiting would only add latency. Returns what was delivered; when nothing is pending there is nothing to send.',
      parameters: {
        id: { type: 'string', required: true, description: 'Watch id.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          if (value.ok !== true) return [{ type: 'text', text: renderProblem(value.id, value.error) }]
          if (value.delivered === 0) {
            return [{ type: 'text', text: `dsh-folderwatch · "${value.id}" has nothing pending; nothing was delivered.` }]
          }
          const lines = [`dsh-folderwatch · "${value.id}" delivered ${value.delivered} change(s)`]
          lines.push(...renderEvents(value.diff))
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      timeoutMs: 60_000,
      async execute(args) {
        const watch = registry.get(args.id)
        if (watch === undefined) return { ok: false, id: args.id, error: 'no such watch' }
        const observed = await watch.check()
        if (observed.events > 0) watch.batcher.push(observed.diff)
        const pending = watch.batcher.pending()
        if (pending === 0) return { ok: true, id: args.id, delivered: 0, diff: { created: [], changed: [], deleted: [] } }
        const before = watch.deliveries
        await watch.deliver()
        return {
          ok: true,
          id: args.id,
          delivered: watch.deliveries > before ? pending : 0,
          diff: observed.diff,
          status: watch.status(),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'folderwatch_remove',
      description:
        'Disarm a directory watch and release its filesystem handles. Use it when the thing being waited on has arrived, or when the watch turned out to be noisier than it was worth.',
      parameters: {
        id: { type: 'string', required: true, description: 'Watch id to disarm.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: renderRemoval(value.status) }]
            : [{ type: 'text', text: renderProblem(value.id, value.error) }],
      },
      timeoutMs: 10_000,
      async execute(args) {
        const status = await registry.disarm(args.id)
        if (status === undefined) return { ok: false, id: args.id, error: 'no such watch' }
        return { ok: true, status }
      },
    }),
  )

  ctx.commands.register({
    name: 'watch',
    description: 'Arm a directory watch, list the armed ones, or check and disarm them.',
    input: { hint: '[add <path> [--pattern GLOB] [--queue] [--once]] [rm <id>] [check <id>] [fire <id>]' },
    async handler(invocation) {
      const agent = invocation.agent
      registry.rememberAgent(agent)
      const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const tokens = raw === '' ? [] : raw.split(/\s+/u)
      const subcommand = tokens[0] ?? 'list'
      const flags = new Set(tokens.filter((token) => token.startsWith('--')))
      const positional = tokens.slice(1).filter((token) => !token.startsWith('--'))
      const valueOf = (name) => {
        const index = tokens.indexOf(`--${name}`)
        return index === -1 ? undefined : tokens[index + 1]
      }

      try {
        if (subcommand === 'list') {
          return { kind: 'success', text: renderList(registry.statuses(), { now: Date.now() }) }
        }
        if (subcommand === 'add') {
          if (positional.length === 0) return { kind: 'error', text: 'usage: /watch add <path> [--pattern GLOB] [--queue] [--once]' }
          const workspace = workspaceRootFor(ctx, { agent })
          const outcome = await registry.arm(
            {
              path: positional.join(' '),
              workspace,
              pattern: valueOf('pattern'),
              label: valueOf('label'),
              prompt: valueOf('prompt'),
              mode: flags.has('--queue') ? 'queue' : 'wake',
              once: flags.has('--once'),
              sessionId: agent?.session?.id,
            },
            { agent, signal: invocation.signal },
          )
          if (outcome.ok !== true) return { kind: 'error', text: renderProblem(positional.join(' '), outcome.error) }
          return { kind: 'success', text: renderArm(outcome.status) }
        }
        if (subcommand === 'rm' || subcommand === 'remove') {
          if (positional.length === 0) return { kind: 'error', text: 'usage: /watch rm <id>' }
          const status = await registry.disarm(positional[0])
          if (status === undefined) return { kind: 'error', text: `no watch with id "${positional[0]}"` }
          return { kind: 'success', text: renderRemoval(status) }
        }
        if (subcommand === 'check') {
          if (positional.length === 0) return { kind: 'error', text: 'usage: /watch check <id>' }
          const watch = registry.get(positional[0])
          if (watch === undefined) return { kind: 'error', text: `no watch with id "${positional[0]}"` }
          const result = await watch.check()
          return { kind: 'success', text: renderCheck(watch.status(), result) }
        }
        if (subcommand === 'fire') {
          if (positional.length === 0) return { kind: 'error', text: 'usage: /watch fire <id>' }
          const watch = registry.get(positional[0])
          if (watch === undefined) return { kind: 'error', text: `no watch with id "${positional[0]}"` }
          const observed = await watch.check()
          if (observed.events > 0) watch.batcher.push(observed.diff)
          const pending = watch.batcher.pending()
          if (pending === 0) return { kind: 'success', text: `"${watch.id}" has nothing pending.` }
          await watch.deliver()
          return { kind: 'success', text: `"${watch.id}" delivered ${pending} change(s).` }
        }
        return {
          kind: 'error',
          text: `unknown subcommand "${subcommand}"; expected list, add, rm, check or fire`,
        }
      } catch (error) {
        return { kind: 'error', text: `watch failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  /* Configuration-declared watches arm in the background: `apply()` must finish
   * synchronously, and a watch that fails to arm reports itself in the listing
   * rather than preventing the plugin from loading. */
  if (Array.isArray(config.watches) && config.watches.length > 0) {
    void (async () => {
      for (const spec of config.watches) {
        if (typeof spec?.path !== 'string' || spec.path === '') continue
        const outcome = await registry.arm({ ...spec }, {})
        if (outcome.ok !== true) {
          ctx.logger?.warn?.(`dsh-folderwatch: configured watch "${spec.path}" not armed: ${outcome.error}`)
        }
      }
    })()
  }
}

export { countEvents, createEchoLedger, FolderWatch, matchesAny, pathsFromToolCall, relativeTo }
