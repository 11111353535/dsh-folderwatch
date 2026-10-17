# dsh-folderwatch

**文件一改就把 agent 叫醒 —— 而不是等它想起来去看。**

agent 已经能被时钟叫醒（定时任务），也能被 HTTP 请求叫醒（webhook）。但这两种都覆盖不到真正要紧的那件事：会话之外、有东西动了文件。构建跑完了、格式化工具重写了整个目录树、测试跑完落下一份报告、下载完成了、同事往共享目录里推了一份文件。今天的做法是：agent 只有正好去看，才会知道。

`dsh-folderwatch` 把一个目录和「arm 它的那个 agent」绑定起来。目录一变，agent 就会收到一份**精确说明到底变了什么**的报告 —— 既可以立刻被叫醒来处理，也可以让它安静地在下一步看到。

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

## 为什么不是「`fs.watch` 加个回调」就完事

三个决定，区分了「会一直留着用的监视器」和「用一个下午就卸掉的监视器」：

### 1. 用快照，不用原始事件

`fs.watch` 只能告诉你「有东西动了」，说不出「动的是什么」。它在 Windows 上会重复触发，有时干脆不给你文件名，负载高时还会静默丢事件。直接建在它上面的监视器只能对 agent 说「有东西变了」—— 这个信息不足以让人动手。

本插件**拍快照再求差**。重命名、删除、突发批量变更在三个平台上都能被正确归类，每条变更还带着文件大小。`fs.watch` 只保留为**提示尽快重扫**的角色；周期性重扫才是正确性的来源。

### 2. 回声抑制

监视一个 agent 正在编辑的目录，有个显而易见的失效模式。agent 写 `src/app.ts`，监视器触发，agent 被告知 `src/app.ts` 变了，它去读自己刚写的文件。这一轮会平息 —— 但 agent **自己**启动的构建、格式化工具或测试runner会持续写文件，每一次写入又把 agent 叫醒一次。结果是一个烧 token 的循环，读起来像是工作区被陌生人攻击了。

所以：凡是点名了某个文件的工具调用，都会记进一份短期账本；窗口内这些路径的变更会被计为**已抑制**而不是投递出去。窗口故意设得很短（`echoWindowMs`，默认 2500ms）：agent 十分钟前写的文件**现在**变了，那是真消息。

抑制是可见的，不是静默的 —— 每批报告都会说明过滤掉了多少条事件，这样你能分清「什么都没发生」和「是 agent 自己干的」。

### 3. 投递方式按监视器单独选择

| mode | 调用 | 效果 |
| --- | --- | --- |
| `wake`（默认） | `agent.followup(message)` | 开启一个新回合 |
| `queue` | `agent.inject(message)` | 等 agent 的下一步 |

一个随时能打断你的监视器，是没人会留着 arm 的监视器。更安静的那个选项只隔着一个参数，于是你可以为整个会话 arm 一个监视器，而不必把「打断权」一起交出去。

## 安装

```
dsh plugin add https://github.com/11111353535/dsh-folderwatch
```

想从本地检出装，就直接给绝对路径：

```
dsh plugin add /absolute/path/to/dsh-folderwatch
```

本包故意不声明任何 `dsh-*` peer 依赖：它只 import `node:*` 以及 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`，这些都由 harness 从自己的安装目录解析。包里不带任何可能遮蔽宿主副本的东西。

按 profile 调参，就给出现在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里那一行加个 `config`：

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

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `watches` | `[]` | 加载时就 arm 的监视器。常规路径是在会话里用工具 arm。 |
| `ignore` | 构建/VCS/依赖目录 | 对所有监视器生效的忽略规则，会与每个监视器自己的列表合并。 |
| `quietMs` | `400` | 目录安静多久之后投递一批。 |
| `maxWaitMs` | `5000` | 变更最多等多久，保证一直不安静的目录树也会被报告。 |
| `cooldownMs` | `5000` | 同一个监视器两次投递之间的最小间隔。 |
| `pollIntervalMs` | `1500` | 重扫目录树的间隔。 |
| `maxWatches` | `16` | 同时 arm 的监视器上限。 |
| `maxEntries` | `20000` | 快照条目上限，防止目录树失控。 |
| `echoWindowMs` | `2500` | 本会话写过某个路径后，它被抑制多久。 |
| `maxEventsPerMessage` | `60` | 一条通知里最多列出多少条事件，超出截断。 |

## 工具

### `folderwatch_add`

arm 一个监视器。返回 arm 报告，或者无法 arm 的原因。

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `path` | string（必填） | 要监视的目录。绝对路径，或相对于工作区。 |
| `label` | string | 短名，用于列表与通知。 |
| `prompt` | string | 追加到每条通知后的指令，例如 `re-run the failing test`。 |
| `pattern` | string | 选择哪些路径被报告的 glob，例如 `**/*.log`。 |
| `ignore` | string[] | 该监视器额外的忽略规则。像 `tmp` 这样的裸名会在任意层级匹配。 |
| `recursive` | boolean | 是否下钻子目录。默认 `true`。 |
| `once` | boolean | 首次投递后自动解除。默认 `false`。 |
| `mode` | `"wake"` \| `"queue"` | 投递方式。默认 `wake`。 |
| `sessionId` | string | 要通知的会话（不是发起调用的那个时使用）。 |

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

清单：每个监视器在看什么、触发过几次、有没有待投递的变更。

```
dsh-folderwatch · 2 watches
  reports  running  12 file(s)  2 delivery(ies)  last fired 1m ago
    /work/shop/reports  [**/*.json]
  inbox  stopped  12 file(s)  0 delivery(ies)  never fired
    /work/shop/inbox
    3 change(s) pending delivery
```

### `folderwatch_check`

立刻重扫并报告变更，**但不投递消息**。这就是在回合中间回答「到现在有动静了吗」的办法，而不是等着被叫醒。

```
dsh-folderwatch · check "reports" · 3 change(s) since the last scan
  + /work/shop/reports/run-42.json  18KB
  ~ /work/shop/reports/latest.json  18KB
  - /work/shop/reports/run-41.json
  (4 further event(s) were this session's own writes)

This was a check: the snapshot advanced and no message was delivered.
```

### `folderwatch_fire`

不等安静期，立刻投递某个监视器待处理的变更。用于确认投递链路通不通，或者明知这一批已经完整、再等只是白加延迟。没有待处理内容时会直说，并且什么都不发。

### `folderwatch_remove`

解除监视并释放文件句柄。会报告它 arm 期间投递过什么。

```
dsh-folderwatch · disarmed "reports"
  root: /work/shop/reports
  delivered 2 batch(es) over 7 event(s) while armed
  filtered 4 event(s) that were this session's own writes
```

## 斜杠命令

```
/watch                                              # 清单
/watch add ./reports --pattern '**/*.json'          # arm，会叫醒 agent
/watch add ./build --queue                          # arm，等到下一步
/watch add ./inbox --once                           # 首次投递后自动解除
/watch check reports                                # 重扫但不投递
/watch fire reports                                 # 立刻投递
/watch rm reports                                   # 解除
```

## 行为说明

- **批量合并。** 变更先攒着，直到目录安静了 `quietMs`，或者已经等了 `maxWaitMs`，然后作为一条消息投递。`cooldownMs` 间隔防止一个反复变化的目录树产生消息洪流。
- **Windows 上的递归。** 平台支持时用 `recursive: true` 的 `fs.watch`，不支持时回退为轮询遍历。arm 报告会写明实际用的是哪条路径（`watch+poll`、`poll` 等）。
- **快照上限。** 目录树超过 `maxEntries` 会产生部分快照；arm 报告会明说，而不是悄悄少报。
- **不可读目录**会被计数并在 arm 报告里点名（最多三个），而不是让整个监视失败。
- **生命周期。** 监视器以 effect 注册，卸载插件会关闭所有句柄。从配置在加载时 arm 的监视器仍然需要一个活着的 agent 来投递；它通过 session controller 按 `sessionId` 解析。
- **删除。** 目录消失会带走它的子项；求差时会裁剪嵌套删除，所以删掉一个文件夹是一条事件，而不是每个文件一条。

## 开发

```
npm test           # 110 个单测，不需要 harness
npm run test:live  # 针对临时目录的 4 个真实监视场景
npm run setup:deps
```

`lib/` 是无构建步骤的纯 ESM JavaScript。单测覆盖纯模块 —— glob 编译、快照求差、批量合并、回声路径提取，以及所有渲染器 —— live 测试覆盖 fixtures 覆盖不到的部分：真实的 `fs.watch` 加轮询循环能发现外部写入、抑制本会话自己的写入、正确归类删除、并按 pattern 过滤。

```
dsh-folderwatch live check · win32
  ✓ delivered after an external write: external.txt
  ✓ suppressed this session's own write
  ✓ classified a deletion correctly
  ✓ applied the pattern filter
  4/4 scenarios passed
```

`setup:deps` 会把 `lib/` 用到的宿主包（`cordis`、`dsh-tools`、`dsh-llm`、`schemastery`）链接进本地 `node_modules`，让一份裸检出也能跑测试。如果 harness 不在标准位置，设置 `DSH_HOST_NODE_MODULES`。

## 许可

MIT
