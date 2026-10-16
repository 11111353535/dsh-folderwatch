/**
 * Plugin seam tests.
 *
 * These run the real entry module against a stub host. The point is not to test
 * behaviour — the unit tests do that — but to test the contract the harness
 * enforces and that nothing else catches: that `inject` is a static array, that
 * every service `apply()` touches is declared, that the tools it registers are
 * well-formed, and that the destructive paths say what they do.
 *
 * The stub's `get()` returns undefined and its proxy throws on undeclared
 * property access, which is exactly the failure mode the guide warns about: a
 * plugin that reaches for a service it never declared gets disabled silently at
 * boot rather than failing loudly.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as plugin from '../lib/index.js'

/**
 * Build a minimal host context.
 *
 * @returns {{ ctx: object, tools: object[], commands: object[], effects: number, listeners: object[] }} the stub and its records.
 */
function stubHost() {
  const tools = []
  const commands = []
  const listeners = []
  const record = { effects: 0 }

  const base = {
    tools: { register: (tool) => tools.push(tool) },
    commands: { register: (command) => commands.push(command) },
    on: (event, handler) => listeners.push({ event, handler }),
    effect: (factory) => {
      record.effects += 1
      return factory()
    },
    get: () => undefined,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }

  const ctx = new Proxy(base, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      throw new Error(`plugin touched undeclared service "${String(property)}"`)
    },
  })
  return { ctx, tools, commands, listeners, get effects() { return record.effects } }
}

/** Validate a tool the way the harness will. */
function assertWellFormedTool(tool) {
  assert.equal(typeof tool.name, 'string', 'tool needs a name')
  assert.match(tool.name, /^[a-z][a-z0-9_]*$/u, `tool name "${tool.name}" must be snake_case`)
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 40, `tool "${tool.name}" needs a description the model can select on`)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.parameters.type, 'object', `tool "${tool.name}" parameters must compile to an object schema`)
  assert.equal(typeof tool.parameters.properties, 'object')
  /* `{ type: 'json' }` is the authoring form for "any JSON value" and compiles
   * to an annotation-only schema — no `type` key at all. Asserting `type ===
   * 'json'` here would be asserting the authoring form survived compilation,
   * which it must not. */
  assert.equal(tool.output.schema.type, undefined, `tool "${tool.name}" should accept any JSON value root`)
  assert.deepEqual(Object.keys(tool.output.schema), [], `tool "${tool.name}" output schema must be unconstrained`)
  assert.equal(typeof tool.output.render, 'function')
  assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, `tool "${tool.name}" needs a positive timeout`)
}

describe('plugin contract', () => {
  it('exports a static inject array', () => {
    /* A function form makes the harness declare zero dependencies and then
     * disable the whole bundle — the failure recorded in the plugin guide. */
    assert.ok(Array.isArray(plugin.inject), 'inject must be a static array, not a function')
    assert.deepEqual([...plugin.inject].sort(), ['commands', 'tools'])
  })

  it('names itself after the package', () => {
    assert.equal(plugin.name, 'dsh-folderwatch')
  })

  it('exposes a Schemastery Config that fills defaults', () => {
    const config = plugin.Config({})
    assert.ok(Array.isArray(config.watches))
    assert.equal(config.quietMs, 400)
    assert.equal(config.maxWaitMs, 5000)
    assert.ok(Array.isArray(config.ignore))
    assert.ok(config.ignore.includes('node_modules'))
  })

  it('keeps every tunable out of the code', () => {
    const config = plugin.Config({})
    for (const key of ['quietMs', 'maxWaitMs', 'cooldownMs', 'pollIntervalMs', 'maxWatches', 'maxEntries', 'echoWindowMs', 'maxEventsPerMessage']) {
      assert.equal(typeof config[key], 'number', `${key} must be configurable`)
    }
  })

  it('registers its tools and command without touching an undeclared service', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    assert.deepEqual(host.tools.map((tool) => tool.name).sort(), [
      'folderwatch_add',
      'folderwatch_check',
      'folderwatch_fire',
      'folderwatch_list',
      'folderwatch_remove',
    ])
    assert.deepEqual(host.commands.map((command) => command.name), ['watch'])
  })

  it('registers every tool with a usable schema', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    for (const tool of host.tools) assertWellFormedTool(tool)
  })

  it('subscribes to the tool-result observer', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    assert.deepEqual(host.listeners.map((entry) => entry.event), ['tools/result'])
  })

  it('registers a teardown effect so unload disarms watches', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    assert.ok(host.effects >= 1, 'apply must register an effect')
  })

  it('declares that arming needs a path', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    const add = host.tools.find((tool) => tool.name === 'folderwatch_add')
    assert.deepEqual(add.parameters.required, ['path'])
  })

  it('declares that checking, firing and removing need an id', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    for (const name of ['folderwatch_check', 'folderwatch_fire', 'folderwatch_remove']) {
      const tool = host.tools.find((candidate) => candidate.name === name)
      assert.deepEqual(tool.parameters.required, ['id'], `${name} must require id`)
    }
  })

  it('documents the delivery modes as an enum the model can pick from', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    const add = host.tools.find((tool) => tool.name === 'folderwatch_add')
    assert.deepEqual(add.parameters.properties.mode.enum, ['wake', 'queue'])
  })

  it('refuses an unknown watch id instead of throwing', async () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    for (const name of ['folderwatch_check', 'folderwatch_fire', 'folderwatch_remove']) {
      const tool = host.tools.find((candidate) => candidate.name === name)
      const value = await tool.execute({ id: 'nope' }, { agent: undefined, signal: undefined })
      assert.equal(value.ok, false, `${name} must report a missing watch as a domain result`)
      assert.equal(value.error, 'no such watch')
    }
  })

  it('reports arming a nonexistent path as a domain result, not an error', async () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    const add = host.tools.find((tool) => tool.name === 'folderwatch_add')
    const value = await add.execute({ path: 'E:/dsh-work/definitely-not-here-9f3a2b' }, { agent: undefined, signal: undefined })
    assert.equal(value.ok, false)
    assert.match(value.error, /no such path/u)
  })

  it('renders an arming failure without throwing', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    const add = host.tools.find((tool) => tool.name === 'folderwatch_add')
    const blocks = add.output.render({ path: 'x' }, { ok: false, id: 'x', error: 'no such path: x' })
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /could not be armed/u)
  })

  it('renders an empty inventory', () => {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    const list = host.tools.find((tool) => tool.name === 'folderwatch_list')
    const blocks = list.output.render({}, { watches: [] })
    assert.match(blocks[0].text, /no watches armed/u)
  })
})

describe('the /watch command', () => {
  /**
   * Invoke the registered command handler.
   *
   * @param {string} rawInput - text after the command name.
   * @returns {Promise<object>} the command result.
   */
  async function run(rawInput) {
    const host = stubHost()
    plugin.apply(host.ctx, plugin.Config({}))
    return host.commands[0].handler({ commandId: 'c1', agent: undefined, rawInput, attachments: [], signal: undefined })
  }

  it('lists watches when invoked bare', async () => {
    const result = await run('')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /no watches armed/u)
  })

  it('accepts list as an explicit subcommand', async () => {
    assert.equal((await run('list')).kind, 'success')
  })

  it('returns usage when add has no path', async () => {
    const result = await run('add')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /usage: \/watch add/u)
  })

  it('returns usage when rm has no id', async () => {
    const result = await run('rm')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /usage: \/watch rm/u)
  })

  it('reports an unknown id as an error result', async () => {
    const result = await run('check missing')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /no watch with id "missing"/u)
  })

  it('rejects an unknown subcommand with the expected list', async () => {
    const result = await run('frobnicate')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /expected list, add, rm, check or fire/u)
  })

  it('turns an arming failure into an error result, not a throw', async () => {
    const result = await run('add E:/dsh-work/definitely-not-here-9f3a2b')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /could not be armed/u)
  })

  it('always returns a shape the command runtime accepts', async () => {
    for (const input of ['', 'list', 'add', 'rm', 'check x', 'fire x', 'bogus']) {
      const result = await run(input)
      assert.ok(result.kind === 'success' || result.kind === 'error', `"${input}" returned kind ${String(result.kind)}`)
      if (result.kind === 'error') assert.ok(typeof result.text === 'string' && result.text.length > 0)
      else if (result.text !== undefined) assert.equal(typeof result.text, 'string')
    }
  })
})
