# dsh-folderwatch

**Wake the agent when the filesystem changes — not when you remember to look.**

An agent can already be woken on a clock (scheduled tasks) and on an HTTP request (webhooks). Neither covers the case that actually matters mid-session: something *outside* the conversation touches a file. A build finishes. A formatter rewrites the tree. A test runner drops a report. A download lands. A colleague pushes into a shared folder. Today the agent finds out only if it happens to look.

`dsh-folderwatch` arms a directory against the agent that armed it. When the tree changes, the agent receives an exact account of what changed — and can either be woken to act on it or simply find it waiting at its next step.

```
[folderwatch] 3 changes under /work/shop/reports
watch: reports · 14:02:11
1 created · 1 modified · 1 deleted
  + /work/shop/reports/run-42.json  18KB
  ~ /work/shop/reports/latest.json  18KB
  - /work/shop/reports/run-41.json
(4 events suppressed as this session's own writes)

Read the new report and summarise what failed.
```

## Why it is not just `fs.watch` and a callback

Three decisions separate a watcher you keep armed from one you uninstall after an afternoon:

### 1. Snapshots, not raw events

`fs.watch` reports that *something* happened, not *what*. It double-fires on Windows, sometimes reports no filename at all, and silently drops events under load. A watcher built directly on it tells the agent "something changed" — which is not enough to act on.

This plugin takes **snapshots and diffs them**. Renames, deletions and bursts are classified correctly on every platform, and each change arrives with its size. `fs.watch` is kept only as a *hint to rescan sooner*; the periodic rescan is the correctness path.

### 2. Echo suppression

A watcher on a directory the agent is editing has an obvious failure mode. The agent writes `src/app.ts`, the watcher fires, the agent is told `src/app.ts` changed, it reads the file it just wrote. That one settles — but a build, a formatter or a test runner the agent *itself* started keeps writing, and each write wakes the agent again. The result is a loop that burns tokens and reads as if the workspace were under attack by a stranger.

So tool calls that name a file are recorded in a short-lived ledger, and changes to those paths inside the window are counted as **suppressed** rather than delivered. The window is deliberately short (`echoWindowMs`, default 2500ms): a file the agent wrote ten minutes ago changing *now* is real news.

The suppression is visible rather than silent — every batch reports how many events it filtered, so you can tell "nothing happened" from "the agent did it itself".

### 3. Delivery is opt-in per watch

| mode | call | effect |
| --- | --- | --- |
| `wake` *(default)* | `agent.followup(message)` | starts a new turn |
| `queue` | `agent.inject(message)` | waits for the agent's next step |

A watcher that can always interrupt is a watcher nobody leaves armed. The quieter option is one argument away, so you can arm a watch for a whole session without handing it the power to interrupt you.

## Install

```
dsh plugin add dsh-folderwatch
```

The package declares no `dsh-*` peer dependency on purpose: it imports only `node:*` plus `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm` and `@deepseek-ai/schemastery`, all of which the harness resolves from its own installation. Nothing is bundled that could shadow the host's copy.

To tune it per profile, add a `config` block to the row the installer inserted in `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: folderwatch
      name: 'dsh-folderwatch'
      config:
        quietMs: 400
        cooldownMs: 5000
        watches:
          - path: E:/work/reports
            label: reports
            pattern: '**/*.json'
            prompt: Read the new report and summarise what failed.
            mode: wake
```

| key | default | meaning |
| --- | --- | --- |
| `watches` | `[]` | Watches armed at load time. Arming from a session with the tool is the usual path. |
| `ignore` | build/VCS/dependency dirs | Ignore patterns applied to every watch, merged with each watch's own list. |
| `quietMs` | `400` | Quiet period before a batch is delivered. |
| `maxWaitMs` | `5000` | Ceiling on how long changes may wait for quiet, so a never-quiet tree still reports. |
| `cooldownMs` | `5000` | Minimum gap between deliveries for one watch. |
| `pollIntervalMs` | `1500` | How often the tree is rescanned. |
| `maxWatches` | `16` | Maximum number of simultaneously armed watches. |
| `maxEntries` | `20000` | Snapshot entry cap, guarding against a runaway tree. |
| `echoWindowMs` | `2500` | How long a path stays suppressed after this session writes it. |
| `maxEventsPerMessage` | `60` | Events listed in one notification before truncation. |

## Tools

### `folderwatch_add`

Arm a watch. Returns the arm report, or the reason it could not be armed.

| argument | type | meaning |
| --- | --- | --- |
| `path` | string *(required)* | Directory to watch. Absolute, or relative to the workspace. |
| `label` | string | Short name shown in listings and notifications. |
| `prompt` | string | Instruction appended to each notification, e.g. `re-run the failing test`. |
| `pattern` | string | Glob selecting which paths are reported, e.g. `**/*.log`. |
| `ignore` | string[] | Extra ignore patterns for this watch. A bare name like `tmp` matches at any depth. |
| `recursive` | boolean | Descend into subdirectories. Defaults to `true`. |
| `once` | boolean | Disarm after the first delivery. Defaults to `false`. |
| `mode` | `"wake"` \| `"queue"` | Delivery mode. Defaults to `wake`. |
| `sessionId` | string | Session to notify, when it is not the calling one. |

```
dsh-folderwatch · armed "reports"
  root:      /work/shop/reports
  watching:  12 file(s), 3 directories (recursive)
  pattern:   **/*.json
  ignoring:  node_modules, .git
  deliver:   wake the agent (followup)

Changes are reported in batches after the tree goes quiet, and this session's own writes are filtered out.
```

### `folderwatch_list`

The inventory: what each watch is watching, how often it has fired, and whether anything is pending.

```
dsh-folderwatch · 2 watches
  reports  running  12 file(s)  2 delivery(ies)  last fired 1m ago
    /work/shop/reports  [**/*.json]
  inbox  stopped  12 file(s)  0 delivery(ies)  never fired
    /work/shop/inbox
    3 change(s) pending delivery
```

### `folderwatch_check`

Rescan now and report what changed **without delivering a message**. This is how you answer "has anything happened yet" during a turn instead of waiting to be woken.

```
dsh-folderwatch · check "reports" · 3 change(s) since the last scan
  + /work/shop/reports/run-42.json  18KB
  ~ /work/shop/reports/latest.json  18KB
  - /work/shop/reports/run-41.json
  (4 further event(s) were this session's own writes)

This was a check: the snapshot advanced and no message was delivered.
```

### `folderwatch_fire`

Deliver a watch's pending changes immediately instead of waiting for the quiet period. Useful to confirm the delivery path works, or when a batch is known to be complete. When nothing is pending, it says so and sends nothing.

### `folderwatch_remove`

Disarm a watch and release its filesystem handles. Reports what it delivered while armed.

```
dsh-folderwatch · disarmed "reports"
  root: /work/shop/reports
  delivered 2 batch(es) over 7 event(s) while armed
  filtered 4 event(s) that were this session's own writes
```

## Slash command

```
/watch                                              # inventory
/watch add ./reports --pattern '**/*.json'          # arm, waking the agent
/watch add ./build --queue                          # arm, waiting for the next step
/watch add ./inbox --once                           # disarm after the first delivery
/watch check reports                                # rescan without delivering
/watch fire reports                                 # deliver now
/watch rm reports                                   # disarm
```

## Behaviour notes

- **Batching.** Changes are collected until the tree has been quiet for `quietMs`, or until `maxWaitMs` has passed, then delivered as one message. A `cooldownMs` gap prevents a churning tree from producing a stream of messages.
- **Recursive on Windows.** `fs.watch` with `recursive: true` is used where the platform supports it and falls back to a polled walk where it does not. The arm report names which path is in use (`watch+poll`, `poll`, …).
- **Snapshot caps.** A tree larger than `maxEntries` produces a partial snapshot; the arm report says so rather than silently under-reporting.
- **Unreadable directories** are counted and named (up to three) in the arm report instead of failing the watch.
- **Lifecycle.** Watches are registered as effects, so unloading the plugin closes every handle. A watch armed at load time from config still needs a live agent to deliver to; it resolves one by `sessionId` through the session controller.
- **Deletions.** A directory disappearing takes its children with it; the diff prunes nested deletions so a removed folder is one event, not one per file.

## Development

```
npm test           # 110 unit tests, no harness needed
npm run test:live  # four real watch scenarios against a temporary directory
npm run setup:deps
```

`lib/` is plain ESM JavaScript with no build step. The unit tests cover the pure modules — glob compilation, snapshot diffing, batching, echo extraction, and every renderer — and the live test covers what fixtures cannot: that a real `fs.watch` plus poll loop notices an external write, suppresses the session's own write, classifies a deletion, and applies a pattern filter.

```
dsh-folderwatch live check · win32
  ✓ delivered after an external write: external.txt
  ✓ suppressed this session's own write
  ✓ classified a deletion correctly
  ✓ applied the pattern filter
  4/4 scenarios passed
```

`setup:deps` links the host packages `lib/` imports (`cordis`, `dsh-tools`, `dsh-llm`, `schemastery`) into a local `node_modules` so a bare checkout can run the tests. Set `DSH_HOST_NODE_MODULES` if the harness is not in a standard location.

## License

MIT
