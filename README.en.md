# dsh-carryover

[简体中文](README.md) | English

A **session handover** plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

In one sentence: **before you open a new session, write down what the previous one talked
about; only once that note has really landed on disk are you allowed to delete the old
session transcript.**

```
旧会话轨迹 ──摘要──▶ 笔记（memory/carryover/<通道>.md）──▶ 新会话自动带上
                 │
                 └─ 摘要失败 / 写盘失败 / 读不出来 ──▶ 什么都不删，下次再来
```

---

## Why you need it

dsh's context fills up. Once it does, the usual move is "just open a new session", and
then:

- everything settled in the last round, the unfinished work, the details the other side
  mentioned — **all gone**;
- if you cannot bear to lose it, only one road is left: never clear the session, and keep
  burning money on an ever-growing context;
- and the worst kind: you do clear it, **the summary right before the purge failed, and
  nobody noticed** — the words are simply gone, and irreversibly so.

This plugin turns that into a process with a strict order, and treats the order as a hard
rule:

> **Summarize first, purge second. If the summary did not succeed, not one thing may be
> deleted.**

Its trade-off is explicit: **it would rather keep a stale transcript it failed to clear
than lose the words.** So you will see a lot of "looks redundant" checks: a note has to be
read back and verified after it is written, directory paths have to pass guardrails, a
transcript that fails to unpack may not be deleted, an unrecognized transcript filename
may not be deleted either. They all block the same kind of mistake — **the irreversible
kind**.

## How it works

### 1. Handover (before the purge)

For a given "channel" (a group, a private chat; the key is defined by the host, e.g.
`group:demo`):

1. look up **this channel's previous session id** in the session map;
2. open that session's transcript directory, unpack `session.v*.jsonl.zstd`, and pick out
   "what people said to each other" (injected system frames, reasoning traces and tool
   calls are all filtered out);
3. feed the body to the summarizer and get back a note "left for the next me";
4. **append the note to the note file, then read it back to verify**: is the session id
   there, is the summary body there;
5. verification passes → delete the old transcript directory (+ its projection cache);
   verification fails → delete nothing, write one `KEEP` line to the log.

### 2. Picking up (a new session starts)

The first time a new session assembles its system prompt, the plugin looks up which
channel the current session id belongs to and hangs that channel's note into the context.
The full text always stays on disk; the injection carries only the most recent part (4000
characters by default).

## Install

```bash
dsh plugin --profile web add github:JackZo400/dsh-carryover
```

After installing, confirm three things (details in "Configuration" and "The session map"
below):

1. `sessionsRoot` points at the right place — the default is `~/.dsh/sessions`;
2. `summary.apiKey` has a value — prefer the environment variable `DSH_CARRYOVER_API_KEY`,
   do not write the key into a config file;
3. **somebody is maintaining the session map** — it is how the plugin knows who should be
   handed over and which channel a new session belongs to.

## Configuration

```yaml
- insert:
    - id: carryover
      name: dsh-carryover
      config:
        enabled: true

        sessionsRoot: ~/.dsh/sessions                                   # 轨迹根
        projCacheRoot: ~/.dsh/storages/session_projcache/sessions       # 投影缓存
        transcript: auto            # auto = 自己挑 session.v<N>.jsonl.zstd 里版本最大的那个

        workspace: .                # 笔记/账本/日志默认都在这下面
        # notesDir: ''              # 默认 <workspace>/memory/carryover
        # sessionMapPath: ''        # 默认 <workspace>/tmp/session-map.json
        # logPath: ''               # 默认 <workspace>/memory/carryover.log

        inject: true                # 新会话自动带上笔记
        injectOrder: 40             # 挂进上下文的顺序（越小越靠前）
        maxInjectChars: 4000

        summary:
          baseUrl: https://api.deepseek.com   # 任何 OpenAI 兼容接口，给根或 /v1 都行
          apiKey: ''                          # 强烈建议走 DSH_CARRYOVER_API_KEY
          model: deepseek-chat
          maxTokens: 900
          prompt: ''                          # 留空 = 内置提示词（写便条，不写公文）
          extraPrompt: ''                     # 追加一句额外要求

        minDialogueChars: 40        # 正文太薄就不值得花一次模型调用
        purgeThinSessions: true     # true = 太薄的直接清；false = 再短也走一遍摘要
        minSummaryChars: 10         # 摘要短于这个长度 = 没摘到，不删
        maxSummaryChars: 1200       # 摘要超长就截断（头尾各留一半）
        maxInputChars: 60000        # 喂给摘要的正文上限
```

Every option has a default, and configuration is **shallow-merged** (`summary` and
`labels` are merged one level deeper, so configuring `summary.model` does not wipe out the
whole `summary` table).

### The session map (this plugin's only "external contract")

Default `<workspace>/tmp/session-map.json`, format:

```json
{
  "group:demo":  { "sessionId": "3f2a...c1", "carried": "1a9b...7e" },
  "c2c:alice":   { "sessionId": "88d0...4b" }
}
```

- `sessionId`: this channel's **current** session id (the host updates it every time it
  opens a new session);
- `carried`: the session id that has already been handed over (written by the plugin, so
  it does not summarize — and pay — twice).

The keys are yours to choose — a channel name, a group number, a user id, a working
directory are all fine; they are only used to name the note file (with filename
sanitizing, so things like `../..` cannot climb out).

Who writes this file? Both ways work:

- **the host plugin writes it** (recommended): writing one line while creating a new
  session is a trivial thing to do;
- **you / a script write it**: when you want the plugin to process a batch of historical
  sessions, just write the ids to be handed over into it.

Without this file the plugin neither knows who should be handed over nor which channel a
new session belongs to — it quietly does nothing, rather than going off to guess.

## Usage

### 1. A host plugin calls the service (the most precise moment)

```js
const carryover = ctx.get('carryover')

// 建新会话之前
const r = await carryover.carryOver({ key: 'group:demo' })
if (r.status === 'kept') log('这次没交接成，旧轨迹留着：', r.reason)
```

`status` has three states:

| status | meaning |
| --- | --- |
| `none` | nothing to hand over (no previous session / transcript already gone / already handed over) |
| `done` | summary + write + read-back all succeeded, the old transcript is deleted (`reason: too-thin` means the body was too thin, purged without spending on a model) |
| `kept` | **the handover did not happen, not one old transcript was deleted**. `reason` says where it got stuck |

The `reason` values can be looked up directly: `summary-failed` (model/network),
`note-write-failed` (disk/permissions), `note-not-verified` (written but read back wrong),
`transcript-unreadable` (the transcript cannot be unpacked), `sessions-root-missing`
(`sessionsRoot` is misconfigured, so nothing can be found — in that case **nothing is
recorded in the ledger**, so fixing the config back still saves you), `no-summarizer` (no
key configured), `summary-empty`, `too-thin`, `already-carried`, `transcript-gone`.

### 2. The agent calls it itself (three tools)

| tool | what it does | does it cost money |
| --- | --- | --- |
| `carryover_status` | read the ledger: each channel's previous session, whether it was handed over, where the note is, how big it is | no |
| `carryover_note` | read this channel's note (for when you cannot recall what was discussed before) | no |
| `carryover_run` | really do a handover. `mode=peek` only reports "how it would decide given the current state", `dry` really summarizes but neither writes nor deletes | only `run`/`dry` call the model |

### 3. Other plugins read the note

```js
const note = ctx.get('carryover').readNote('group:demo')   // 超长只带最近一段
```

### 4. Usable without dsh

`src/carryover.js` contains not a single line of dsh code; every external dependency (fs,
clock, summarizer function, transcript reader) is injected:

```js
import { createCarryover } from 'dsh-carryover/carryover'

const engine = createCarryover({
  workspace: '/srv/app',
  sessionsRoot: '/srv/app/.dsh-sessions',
  summarize: async (dialogue) => myOwnSummarizer(dialogue),   // 换掉默认的 HTTP 摘要
  now: () => new Date(),
})
await engine.carryOver({ key: 'group:demo' })
```

## What it deletes, and what it leaves alone

**It deletes exactly two things, and both must belong to "the session id being handed over
this time":**

- `<sessionsRoot>/<projectKey>/<sessionId>/` — this session's own transcript directory;
- `<projCacheRoot>/<sessionId>.json` — its projection cache.

**Guardrails (a wrong path means no delete, only a ledger entry):** the path must be under
`sessionsRoot`, one or two levels deep at most, the directory name must be exactly this
session id, and the path must not contain `..`.

**Never touched:** other session directories, `sessionsRoot` itself, the project's
`projectKey` directory, your workspace. Notes are written by **appending** (one
`## time · channel` block after another), historical notes are never overwritten.

## Tests

```bash
node test/selftest.mjs         # 纯逻辑：决策表、截断、路径护栏、真文件系统的写/删
node test/plugin-selftest.mjs  # 插件接线：假 ctx + 假会话 + 假摘要器，跑完一整条流程
npm test                       # 两个都跑
```

Both self-tests **need no dsh, no network, no API key, and make zero model calls**, yet
the delete/no-delete outcome really happens in a temporary directory. Key coverage:

1. summary succeeds → only then is the transcript deleted (the note really lands on disk,
   session id included);
2. summary fails → nothing is deleted, the ledger is not marked as handed over (it will be
   retried next time);
3. an over-long summary → truncated to `maxSummaryChars`, half from the head and half from
   the tail;
4. a disk-write failure → nothing is deleted (a real `EACCES` permission denial, a real
   `ENOSPC` error, and the sneakiest one: a silent write loss that reports no error but
   reads back empty);
5. an unreadable transcript / an unrecognized transcript filename → also no delete
   (**"cannot read it" ≠ "nothing to say"**);
6. when `sessionsRoot` is misconfigured, the session may not be recorded as "handed over"
   (otherwise it would never be summarized again even after the config is fixed back).

## Known limitations

- **It does not find sessions by itself.** Who should be handed over, and which channel a
  new session belongs to, is decided by that session map alone. This is deliberate:
  guessing "which session was the previous one" by time order would, when several sessions
  run in parallel, delete the one that is still alive. Better to do one thing less than to
  do one irreversible thing wrong.
- **It copies dsh's `projectKey` algorithm** (`/x/y` → `--x-y--`), because it did not want
  to import the host's internal modules. A copy goes stale, so there is one more fallback
  when locating the transcript: if it cannot be guessed, scan one level under
  `sessionsRoot` by session id; if that finds nothing either, no handover and no delete.
- **The transcript format is versioned** (currently `session.v4.jsonl.zstd`, and dsh
  itself keeps moving forward), so the default `transcript: auto` picks the highest
  version instead of hard-coding v4. When no transcript file is recognized, **nothing is
  deleted**.
- **Decompression prefers the `zstd` command line** (dsh transcripts are multi-frame
  concatenations, and `node:zlib` eats only the first frame — unpacking just the first
  frame would silently feed barely half the conversation). If the CLI is not there, it
  falls back to a single frame.
- **Summarizing costs one model call** (the cheapest model is enough). If you do not want
  to spend that money, set `enabled: false` or simply do not install it;
  `purgeThinSessions: true` skips the summary and purges directly when the body is too
  thin.
- **No encryption**: the note is plain markdown, sitting in your workspace. Watch out for
  sensitive content yourself.

## License

MIT © 2026 JackZo400
