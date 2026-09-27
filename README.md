# dsh-carryover

[English](README.en.md) | 简体中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的**会话交接**插件。

一句话：**开新会话之前，先把上一段聊过的话写成笔记；笔记真的落到盘上了，才允许删掉旧会话轨迹。**

```
旧会话轨迹 ──摘要──▶ 笔记（memory/carryover/<通道>.md）──▶ 新会话自动带上
                 │
                 └─ 摘要失败 / 写盘失败 / 读不出来 ──▶ 什么都不删，下次再来
```

---

## 为什么需要它

dsh 的上下文会满。满了之后常见的做法是「开个新会话」，于是：

- 上一轮聊定的东西、还没做完的事、对方提过的细节 —— **全没了**；
- 你要是舍不得，就只剩一条路：不清会话，然后每次都在越来越长的上下文里烧钱；
- 更坏的一种：清是清了，**清之前那次摘要失败了，没人发现** —— 话就这么没了，而且不可逆。

这个插件把这件事变成一个有先后顺序的流程，并且**把顺序当成硬规矩**：

> **先摘要，后清理。摘要不成功，一条都不许删。**

它的取舍很明确：**宁可留着一份没清掉的垃圾轨迹，也不能把话弄丢。**
所以你会看到很多「看起来多余」的检查：笔记写完要读回来核对、目录路径要过护栏、
轨迹解压失败就不许删、认不出轨迹文件名也不许删。它们挡的都是同一种错 —— **不可逆的那种**。

## 它是怎么工作的

### 1. 交接（清之前）

对某条「通道」（channel：一个群、一段私聊，key 由宿主定义，比如 `group:demo`）：

1. 从映射文件里查出**这条通道的上一个会话 id**；
2. 打开它的轨迹目录，解压 `session.v*.jsonl.zstd`，挑出「人对人说的话」
   （系统注入的框、推理过程、工具调用都剔掉）；
3. 把正文喂给摘要模型，拿回一段「留给下一个自己」的便条；
4. **把便条追加到笔记文件，然后读回来核对**：会话 id 在不在、摘要正文在不在；
5. 核对通过 → 删掉旧轨迹目录（+ 它的投影缓存）；核对没过 → 什么都不删，写一行 `KEEP` 日志。

### 2. 接上（新会话开始）

新会话第一次组装 system prompt 时，插件反查「当前会话 id 属于哪条通道」，
把那条通道的笔记挂进上下文。全文永远留在磁盘上，注入只带最近的一段（默认 4000 字）。

## 安装

```bash
dsh plugin --profile web add github:JackZo400/dsh-carryover
```

装完确认三件事（细节见下面的「配置」和「映射文件」）：

1. `sessionsRoot` 指对了 —— 默认 `~/.dsh/sessions`；
2. `summary.apiKey` 有值 —— 建议用环境变量 `DSH_CARRYOVER_API_KEY`，别把 key 写进配置文件；
3. **映射文件有人在维护** —— 插件靠它知道「谁该被交接」「新会话属于哪条通道」。

## 配置

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

所有项都有默认值，配置是**浅合并**（`summary` / `labels` 这两层单独合，不会因为配了
`summary.model` 就把整个 `summary` 表打掉）。

### 映射文件（这个插件唯一的「外部契约」）

默认 `<workspace>/tmp/session-map.json`，格式：

```json
{
  "group:demo":  { "sessionId": "3f2a...c1", "carried": "1a9b...7e" },
  "c2c:alice":   { "sessionId": "88d0...4b" }
}
```

- `sessionId`：这条通道**当前**的会话 id（宿主每开一个新会话就更新它）；
- `carried`：已经交接过的那个会话 id（插件写，防止重复摘要、重复花钱）。

key 是什么由你定 —— 通道名、群号、用户 id、工作目录都行，它只用来给笔记文件起名
（会做文件名安全处理，`../..` 这种东西钻不出去）。

谁来写这份文件？两种都行：

- **宿主插件写**（推荐）：建新会话时顺手写一行，是顺手的事；
- **你自己/脚本写**：想让插件处理一批历史会话时，把要交接的 id 写进去就行。

没有这份文件，插件既不知道要交接谁，也不知道新会话属于哪条通道 —— 它会安静地什么都不做，
而不是去猜。

## 用法

### 一、宿主插件调服务（最准的时机）

```js
const carryover = ctx.get('carryover')

// 建新会话之前
const r = await carryover.carryOver({ key: 'group:demo' })
if (r.status === 'kept') log('这次没交接成，旧轨迹留着：', r.reason)
```

`status` 三态：

| status | 意思 |
| --- | --- |
| `none` | 没什么可交接的（没有上一个会话 / 轨迹已不在 / 已经交接过了） |
| `done` | 摘要 + 落盘 + 核对都成了，旧轨迹已删（`reason: too-thin` 是正文太薄、没花模型钱就直接清） |
| `kept` | **没交接成，旧轨迹一条没删**。`reason` 说明卡在哪 |

`reason` 的取值是可以直接照着查的：`summary-failed`（模型/网络）、`note-write-failed`（磁盘/权限）、
`note-not-verified`（写了但读回来不对）、`transcript-unreadable`（轨迹解不开）、
`sessions-root-missing`（`sessionsRoot` 配错，所以什么都找不到 —— 这种情况下**不记账**，
改回配置还能救）、`no-summarizer`（没配 key）、`summary-empty`、`too-thin`、`already-carried`、
`transcript-gone`。

### 二、Agent 自己调（三个工具）

| 工具 | 干什么 | 花钱吗 |
| --- | --- | --- |
| `carryover_status` | 看账：每条通道的上一个会话、交接了没、笔记在哪、多大 | 不花 |
| `carryover_note` | 读这条通道的笔记（想不起之前聊过什么时） | 不花 |
| `carryover_run` | 真做交接。`mode=peek` 只报「按现在的状态会怎么判」，`dry` 真摘要但不写不删 | 只有 `run`/`dry` 会调模型 |

### 三、别的插件读笔记

```js
const note = ctx.get('carryover').readNote('group:demo')   // 超长只带最近一段
```

### 四、不用 dsh 也能用

`src/carryover.js` 里没有一行 dsh 代码，所有外部依赖（fs、时钟、摘要函数、轨迹读取）
都是注入的：

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

## 它会删什么，不碰什么

**只删两样，而且都必须是「这次交接的这个会话 id」的：**

- `<sessionsRoot>/<projectKey>/<sessionId>/` —— 这个会话自己的轨迹目录；
- `<projCacheRoot>/<sessionId>.json` —— 它的投影缓存。

**护栏（路径不对就不删，只记账）：** 路径必须在 `sessionsRoot` 下面、只能深一两层、
目录名必须正好是这个会话 id、路径里不许出现 `..`。

**绝不碰：** 别的会话目录、`sessionsRoot` 本身、项目的 `projectKey` 目录、你的工作区。
笔记是**追加**写的（`## 时间 · 通道` 一段一段往上加），历史笔记永远不覆盖。

## 测试

```bash
node test/selftest.mjs         # 纯逻辑：决策表、截断、路径护栏、真文件系统的写/删
node test/plugin-selftest.mjs  # 插件接线：假 ctx + 假会话 + 假摘要器，跑完一整条流程
npm test                       # 两个都跑
```

两条自检都**不需要 dsh、不需要联网、不需要 API key、一次模型调用都没有**，
但删/不删是真发生在临时目录里的。重点覆盖：

1. 摘要成功 → 轨迹才被删（笔记真的落在盘上，含会话 id）；
2. 摘要失败 → 一条都不删，账本不标已交接（下次还会重试）；
3. 摘要超长 → 截断到 `maxSummaryChars`，头尾各留一半；
4. 写盘失败 → 一条都不删（真 `EACCES` 权限拒绝、真 `ENOSPC` 报错、
   以及「不报错但读回来是空的」这种最阴的静默丢写）；
5. 轨迹读不出来 / 认不出轨迹文件名 → 也不许删（**"读不出来" ≠ "没什么可说"**）；
6. `sessionsRoot` 配错时不许把会话记成「已交接」（否则配置改回来也永远不再被摘要）。

## 已知局限

- **它不自己找会话。** 谁该被交接、新会话属于哪条通道，都由那份映射文件说了算。
  这是故意的：按时间顺序猜「哪个会话是上一个」，在多个会话并行时会删掉活着的那个。
  宁可少做一件事，也不做错一件不可逆的事。
- **抄了一份 dsh 的 `projectKey` 算法**（`/x/y` → `--x-y--`），因为不想 import 宿主的内部模块。
  抄的东西会过期，所以定位轨迹时还有一层兜底：猜不到就按会话 id 在 `sessionsRoot` 下扫一层；
  再找不到就不交接、不删。
- **轨迹格式带版本号**（现在是 `session.v4.jsonl.zstd`，dsh 自己还会往前走），
  所以默认 `transcript: auto` 挑版本最大的那个，而不是写死 v4。认不出任何轨迹文件时**不删**。
- **解压优先叫 `zstd` 命令行**（dsh 的轨迹是多帧拼接，`node:zlib` 一次只吃第一帧，
  只解第一帧会悄悄少喂一大半对话）。CLI 不在就退回单帧。
- **摘要要花一次模型调用**（用最便宜的模型就够）。不想花这个钱，把 `enabled: false` 或
  干脆别装；`purgeThinSessions: true` 会在正文太薄时跳过摘要直接清。
- **不做加密**：笔记就是 markdown 明文，放在你的工作区里。敏感内容自己注意。

## License

MIT © 2026 JackZo400

---

## English

→ Full English README: [README.en.md](README.en.md)
