/**
 * dsh-carryover 的核心逻辑 —— 这个文件**不 import 任何 dsh / cordis 的东西**。
 *
 * 为什么非要这么切：这段逻辑最难的部分不是「压缩一段对话」，是**什么时候可以删东西**。
 * 删错了就是把人的话永久弄没了，所以每个判断都得能被单独测。把它和插件入口分开之后，
 * 自检可以拿假会话、假摘要器、假文件系统把它按在桌子上问清楚：
 *   · 摘要失败了会不会误删？
 *   · 笔记写进去了但读回来是空的，会不会误删？
 *   · 轨迹读不出来（解压失败）时，会不会把「没读到」当成「没什么可说」然后删掉？
 *
 * 文件系统（fs）、时间（now）、摘要函数（summarize）、轨迹读取（readTranscript）全都从外面注入，
 * 默认值在下面，测试想换哪个换哪个。
 *
 * fs 注入面（只需要这几个方法，签名同 node:fs）：
 *   existsSync / mkdirSync / readFileSync / appendFileSync / writeFileSync / rmSync / readdirSync / statSync
 */
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, sep as PATH_SEP } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const runFile = promisify(execFileCb)

/** 真实的 fs —— 注入 fs 就是拿自己的对象把它盖掉（测试里用得到）。 */
export const DEFAULT_FS = {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
}

/** dsh 的会话轨迹是「多帧拼接」的 zstd，node:zlib 一次只吃第一帧 → 默认先叫 zstd CLI。 */
async function runZstd(file) {
  const { stdout } = await runFile('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
  return String(stdout || '')
}

// ───────────────────────── 1. 路径与命名 ─────────────────────────

/**
 * dsh 的「项目目录名」算法（`/x/y` → `--x-y--`）。
 *
 * 为什么要抄一份：轨迹目录名就是这么算出来的，不抄就只能去 import dsh 内部模块 ——
 * 而插件不该依赖宿主的私有路径。抄的代价是**算法变了就会找错地方**，
 * 所以 locateSessionDir() 里还有一层「找不到就按 id 扫一层」的兜底，别信死这个函数。
 */
export function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 通道 key → 文件名（`group:demo` → `group-demo`）。
 *
 * 除了「不能当文件名的字符」，还得挡目录穿越：key 是从配置/宿主来的字符串，
 * 一个 `../..` 就能让笔记写到别处去。所以顺手把点开头结尾也收拾干净。
 */
export function slugKey(key) {
  const s = String(key ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
  return s || 'unnamed'
}

/** 日志里只露前 8 位 id 就够了 —— 全量 id 又长又没人看。 */
export function shortId(id) {
  return String(id ?? '').slice(0, 8)
}

/**
 * 文本截断：**头尾各留一半**，不是砍尾巴。
 *
 * 为什么留尾：笔记的结构是「发生了什么 / 定了什么 / 还没完的事」，
 * 最要紧的「还没完的事」在最后；只留头等于把最该带走的丢掉。
 * 保证返回值长度 **≤ max**（调用方要靠这个算注入预算，不能只是"大概"）。
 */
export function clampText(text, maxChars, marker = '\n（…中间省略…）\n') {
  const t = String(text ?? '')
  const max = Math.max(0, Number(maxChars) || 0)
  if (max <= 0 || t.length <= max) return t
  if (max <= marker.length) return t.slice(0, max)
  const room = max - marker.length
  const head = Math.ceil(room / 2)
  const tail = room - head
  return t.slice(0, head) + marker + (tail > 0 ? t.slice(-tail) : '')
}

// ───────────────────────── 2. 轨迹：在哪、叫什么、能不能删 ─────────────────────────

/**
 * 找这个会话的轨迹目录。
 *
 * 先按 projectKey 猜，猜不到就**在 sessionsRoot 下扫一层**找同名目录 ——
 * 因为 projectKey 是抄来的，dsh 改过算法（或宿主改了命名）我就找不到了。
 * 找不到的后果只是「这次不交接」，比删错强；扫一层是有界的，不会翻遍磁盘。
 */
export function locateSessionDir(sessionId, cwd, opts = {}) {
  const fs = opts.fs || DEFAULT_FS
  const root = opts.sessionsRoot
  const keyOf = opts.projectKey || projectKey
  const id = String(sessionId || '')
  if (!id || !root) return ''
  try {
    const guess = join(root, keyOf(String(cwd || '')), id)
    if (isDir(fs, guess)) return guess
  } catch {
    // projectKey 都能炸的话（比如 cwd 不是字符串）走兜底
  }
  try {
    for (const name of fs.readdirSync(root)) {
      const p = join(root, name, id)
      if (isDir(fs, p)) return p
    }
  } catch {
    // 根目录不在 / 读不动 —— 当作找不到
  }
  return ''
}

function isDir(fs, p) {
  try {
    return Boolean(fs.existsSync(p)) && fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 轨迹文件名。
 *
 * dsh 的会话格式是有版本号的（`session.v4.jsonl.zstd`），而且**版本会往前走**
 * （writer 已经到 v4，还有 v5 在路上）。写死一个名字，等于等 dsh 升级那天插件悄悄瞎掉。
 * 所以默认 auto：列目录，挑版本号最大的那个；`transcript` 配了具体名字就用它。
 */
export function findTranscript(dir, opts = {}) {
  const fs = opts.fs || DEFAULT_FS
  const want = String(opts.transcript || 'auto')
  if (want && want !== 'auto') {
    const p = join(dir, want)
    return fs.existsSync(p) ? p : ''
  }
  let best = ''
  let bestVer = -1
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name)
      if (!m) continue
      const v = Number(m[1])
      if (v > bestVer) {
        bestVer = v
        best = join(dir, name)
      }
    }
  } catch {
    return ''
  }
  return best
}

/**
 * 删之前最后一道闸：这个路径**只能是会话根下面的一两层**，且目录名就是这个会话 id。
 *
 * 具体形状：`<sessionsRoot>/<projectKey>/<sessionId>`（dsh 就这样），
 * 也容忍宿主把会话平铺在根下（`<sessionsRoot>/<sessionId>`）。
 * 多一层、少一层、目录名不是这个 id、带 `..` —— 一律不放行。
 * 删会话是不可逆的，而路径是拼出来的：拼错一个字段就可能 `rm -rf` 掉整个 sessions 目录。
 * 这个函数是纯的，自检可以拿一堆畸形/恶意路径往它身上试。
 */
export function isSafePurgePath(dir, sessionId, root, pathSep = PATH_SEP) {
  const d = String(dir || '')
  const id = String(sessionId || '')
  const r = String(root || '')
  if (!d || !id || !r) return false
  if (basename(d) !== id) return false
  if (d.includes('..')) return false // 别管操作系统怎么解释 `..`，直接不许出现
  const prefix = r.replace(/[/\\]+$/, '') + pathSep
  if (!d.startsWith(prefix)) return false
  const segs = d.slice(prefix.length).split(/[/\\]/).filter(Boolean)
  if (segs.length < 1 || segs.length > 2) return false
  return segs[segs.length - 1] === id
}

/** 投影缓存（会话标题/统计那份 json）—— 删会话时顺手清掉，不然会留下孤儿。 */
export function projCacheFileOf(root, sessionId) {
  return join(String(root || ''), `${String(sessionId || '')}.json`)
}

// ───────────────────────── 3. 读轨迹 → 对话正文 ─────────────────────────

/**
 * 解压轨迹。
 *
 * zstd 的多帧拼接是第一版踩的坑：node:zlib 只解第一帧，解出来少一大半，
 * 于是「摘要」看起来正常、其实只喂了前几分钟的对话。默认走 zstd CLI（-dc 能连着解），
 * CLI 不在就退回单帧 —— 少一点总比整条读不出来强。
 * 另外：如果这段字节根本不是 zstd（测试里用明文 jsonl 冒充轨迹），就直接当文本读。
 */
export async function decodeTranscript(buf, opts = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8')
  const magic = b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd
  if (!magic) return b.toString('utf8')
  try {
    const decoder = opts.zstdCli || (opts.run ? (f) => opts.run(f) : runZstd)
    const out = await decoder(opts.file)
    if (out) return String(out)
  } catch {
    // CLI 不在 / 被杀 —— 退回单帧
  }
  return zstdDecompressSync(b).toString('utf8')
}

/**
 * 从轨迹 jsonl 里挑出「人对人说的话」。
 *
 * 三件事要滤掉，否则摘要里全是机读的东西、真正说的话被挤掉：
 *   1. 系统注入的框（system-reminder / runtime context / 技能目录）—— 不是谁说了什么
 *   2. 推理过程（assistant 正文里只要 text 块）
 *   3. 工具调用
 * 超长时**砍头留尾**：上一个会话的最后几句，才是下一个自己最需要的上下文。
 */
export function extractDialogue(jsonl, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 60000
  const labels = opts.labels || {}
  const userLabel = labels.user || '对方'
  const assistantLabel = labels.assistant || '我'
  const skipPrefixes = [
    '<system-reminder>',
    'Current runtime context',
    '<available_skills>',
    ...(Array.isArray(opts.skipPrefixes) ? opts.skipPrefixes.map(String) : []),
  ]
  const lines = []
  for (const raw of String(jsonl ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue // 半行 / 坏行：跳过，不能让一行脏数据毁掉整段
    }
    const type = o?.type
    if (type === 'user/message') {
      const text = pickText(o?.data?.content)
      if (!text) continue
      if (skipPrefixes.some((p) => text.startsWith(p))) continue
      lines.push(`${userLabel}：${text}`)
    } else if (type === 'assistant/message') {
      const text = pickText(o?.data?.message?.content)
      if (text) lines.push(`${assistantLabel}：${text}`)
    }
  }
  const out = lines.join('\n')
  if (out.length <= maxChars) return out
  return `（更早的内容已省略）\n${out.slice(-maxChars)}`
}

function pickText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c?.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n')
    .trim()
}

/** 读一份轨迹 → 正文文本。抛错 = 读不出来（调用方必须当成「不删」的理由）。 */
export async function readTranscriptText(file, opts = {}) {
  const fs = opts.fs || DEFAULT_FS
  const buf = fs.readFileSync(file)
  const jsonl = await decodeTranscript(buf, { ...opts, file })
  return { jsonl, dialogue: extractDialogue(jsonl, opts) }
}

// ───────────────────────── 4. 摘要 ─────────────────────────

/**
 * 默认摘要提示词。
 *
 * 它要写得像「给下一个自己的便条」，不能写成公文 —— 这是踩过的坑：
 * 摘要会连语体一起传给下一个自己，笔记写得像档案，人说话就变成档案腔。
 * 想换成你家的语气，配 `summary.prompt`（整段替换）或 `summary.extraPrompt`（追加一句要求）。
 */
export const DEFAULT_SUMMARY_PROMPT = [
  '你是这个助手的「上一个自己」。下面是你刚结束的一段会话记录。',
  '请把它写成一段留给「下一个自己」看的便条。',
  '要求：',
  '- 用第一人称，300~500 字，分三小块：发生了什么 / 定了什么（结论·约定） / 还没完的事。',
  '- 只写记录里真有的东西，别补、别猜、别编。',
  '- 像小声交代事，不要公文腔，别用「档案」「记录」「待定」「成立」这类词。',
  '- 人名、项目名、文件路径、数字、时间这些具体的东西要留下。',
  '- 不要复述工具调用，不要写「作为一个 AI」这类话，不要客套。',
].join('\n')

export function buildSummaryPrompt(opts = {}) {
  const base = String(opts.prompt || '').trim() || DEFAULT_SUMMARY_PROMPT
  const extra = String(opts.extraPrompt || '').trim()
  return extra ? `${base}\n${extra}` : base
}

/** 兼容两种写法：给到 `/chat/completions` 就不动，给到根（或 `/v1`）就自己补。 */
export function chatCompletionsUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) return ''
  if (/\/chat\/completions$/.test(b)) return b
  return `${b}/chat/completions`
}

/**
 * 默认摘要器：任何 OpenAI 兼容的 `/chat/completions`。
 * 失败一律抛错 —— 上层的规矩是「摘要抛错 = 不删」，所以这里绝不能悄悄返回空串装成功。
 */
export async function summarizeViaHttp(dialogue, opts = {}) {
  const url = chatCompletionsUrl(opts.baseUrl)
  const apiKey = String(opts.apiKey || '')
  if (!url) throw new Error('没配摘要接口地址（summary.baseUrl）')
  if (!apiKey) throw new Error('没有可用的 API key（summary.apiKey / DSH_CARRYOVER_API_KEY）')
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('这个 Node 没有 fetch，自己传一个 fetchImpl')
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: String(opts.model || 'deepseek-chat'),
      messages: [
        { role: 'system', content: buildSummaryPrompt(opts) },
        { role: 'user', content: String(dialogue ?? '') },
      ],
      max_tokens: Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 900,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      stream: false,
    }),
    signal: AbortSignal.timeout(Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120_000),
  })
  if (!r.ok) throw new Error(`摘要接口 ${r.status} ${String(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  const text = String(j?.choices?.[0]?.message?.content ?? '').trim()
  if (!text) throw new Error('摘要接口返回空')
  return text
}

// ───────────────────────── 5. 笔记文件 ─────────────────────────

export function noteFileOf(notesDir, key) {
  return join(String(notesDir || '.'), `${slugKey(key)}.md`)
}

/**
 * 笔记块。表头带着**会话 id**，这不是装饰：
 * 写完要读回来核对这个 id 在不在，用来证明「这次摘要真的落到了这条通道的笔记里」。
 * 时间用 `YYYY-MM-DD HH:MM` 这种自己拼的格式，不用 toLocaleString ——
 * 同一份代码在不同机器上 locale 不一样，写出来的时间戳会飘，自检也没法断言。
 */
export function formatNoteBlock(opts = {}) {
  const stamp = String(opts.stamp || '')
  const key = String(opts.key || '')
  const sessionId = String(opts.sessionId || '')
  const chars = Number(opts.chars) || 0
  const summary = String(opts.summary ?? '').trim()
  return `\n## ${stamp} · ${key}\n（上一个会话 \`${sessionId}\`，正文 ${chars} 字）\n\n${summary}\n`
}

export function stampOf(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 追加笔记，**并且读回来核对**。
 *
 * 为什么非要核对：`appendFileSync` 不抛错不等于写进去了 —— 磁盘满（ENOSPC）会留下半截文件，
 * 某些网络盘/NFS 也会吞写。而下一步就是删轨迹，一旦「笔记其实没落地」我们还删了，
 * 那段话就永久没了。核对只要读一遍文件，代价极小，挡的是最贵的那种错。
 *
 * 核对两条：这次块的会话 id 在文件里；摘要的尾巴也在（防止只落了表头）。
 */
export function appendNote(file, block, opts = {}) {
  const fs = opts.fs || DEFAULT_FS
  const sessionId = String(opts.sessionId || '')
  const summary = String(opts.summary ?? '').trim()
  const tailProbe = summary.slice(-24)
  try {
    fs.mkdirSync(opts.dir || '.', { recursive: true })
    fs.appendFileSync(file, block)
  } catch (e) {
    return { ok: false, error: `写笔记失败：${msgOf(e)}` }
  }
  let back = ''
  try {
    back = String(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return { ok: false, error: `笔记写完了但读不回来：${msgOf(e)}` }
  }
  if (!back.trim()) return { ok: false, error: '笔记写完了但读回来是空的' }
  if (sessionId && !back.includes(sessionId)) return { ok: false, error: '笔记里找不到这次会话的 id' }
  if (tailProbe && !back.includes(tailProbe)) return { ok: false, error: '笔记里找不到这次摘要的正文' }
  return { ok: true, error: '' }
}

/**
 * 读笔记给新会话用。
 * 太长时**只带最近的一段**（尾巴）—— 全文永远留在磁盘上，谁想看全文去看文件。
 */
export function readNote(file, maxChars, opts = {}) {
  const fs = opts.fs || DEFAULT_FS
  try {
    if (!fs.existsSync(file)) return ''
    const t = String(fs.readFileSync(file, 'utf8')).trim()
    if (!t) return ''
    const max = Number(maxChars) > 0 ? Number(maxChars) : 4000
    if (t.length <= max) return t
    return `（只带最近的部分，全文在 ${file}）\n${t.slice(-max)}`
  } catch {
    return ''
  }
}

// ───────────────────────── 6. 决策（这个文件真正的核心） ─────────────────────────

/**
 * 摘要**之前**该干什么。纯函数：给一堆事实，回一个动作，不碰磁盘。
 *
 * 顺序是有讲究的，几句话解释为什么这么排：
 *   · 没上一个会话 / 已经交接过了 → 什么都不做
 *   · **根目录就没配对 → keep**。不挡这一条的话，配错一次会把所有会话都判成
 *     「轨迹已不在」、记成已交接；等你把配置改回来，它们反而永远不再被摘要。
 *   · 轨迹目录已经不在了 → 没什么可交接，记账走人（forget）
 *   · **轨迹读不出来 → keep**。这是第一版的一个真 bug：解压失败时正文是空串，
 *     于是被「正文太薄 → 直接删」那条规则顺手删掉了 —— 读不出来 ≠ 没什么可说。
 *     宁可留着一份读不动的垃圾，也不能把没读到的话删了。
 *   · 正文确实太薄（就一两句寒暄）→ 不必花这次摘要的钱，直接删（可关）
 *   · 没摘要器（没 key 也没注入函数）→ keep
 *   · 其余 → 去摘要
 */
export function decideBeforeSummary(s = {}) {
  if (!s.hasPrevious) return { action: 'none', reason: 'no-previous-session' }
  if (s.alreadyCarried) return { action: 'none', reason: 'already-carried' }
  if (s.sessionsRootOk === false) return { action: 'keep', reason: 'sessions-root-missing' }
  if (!s.sessionDirFound) return { action: 'forget', reason: 'transcript-gone' }
  if (!s.transcriptOk) return { action: 'keep', reason: 'transcript-unreadable' }
  if (s.purgeThin && Number(s.dialogueChars) < Number(s.minDialogueChars)) {
    return { action: 'purge', reason: 'too-thin' }
  }
  if (!s.canSummarize) return { action: 'keep', reason: 'no-summarizer' }
  if (!s.dialogueChars) return { action: 'keep', reason: 'no-dialogue' }
  return { action: 'summarize', reason: 'ok' }
}

/**
 * 摘要**之后**该不该删。同样纯函数。
 *
 * 一句话：**只有「摘要拿到手 + 笔记落盘 + 读回来核对过」三件事全成立，才允许 purge。**
 * 任何一条不成立 → keep（旧轨迹留着，下次再来一遍）。这条规矩不许有例外分支。
 */
export function decideAfterSummary(s = {}) {
  if (s.summaryError) return { action: 'keep', reason: 'summary-failed' }
  const summaryChars = String(s.summary ?? '').trim().length
  if (summaryChars < Number(s.minSummaryChars ?? 1)) return { action: 'keep', reason: 'summary-empty' }
  if (s.noteError) return { action: 'keep', reason: 'note-write-failed' }
  if (!s.noteVerified) return { action: 'keep', reason: 'note-not-verified' }
  return { action: 'purge', reason: 'ok' }
}

function msgOf(e) {
  return String((e && e.message) || e || '未知错误').slice(0, 200)
}

// ───────────────────────── 7. 引擎 ─────────────────────────

/**
 * 造一个 carryover 引擎。所有外部依赖从这里进：
 *   fs / now / summarize / readTranscript / projectKey / keyOfSession / log
 * 插件入口只是把配置摊平了喂进来，测试则是拿假的喂进来 —— 同一份逻辑，两种活法。
 */
export function createCarryover(options = {}) {
  const cfg = {
    enabled: true,
    sessionsRoot: '',
    projCacheRoot: '',
    workspace: process.cwd(),
    cwd: '',
    notesDir: '',
    sessionMapPath: '',
    logPath: '',
    transcript: 'auto',
    maxInputChars: 60000,
    maxSummaryChars: 1200,
    maxInjectChars: 4000,
    minDialogueChars: 40,
    minSummaryChars: 10,
    purgeThinSessions: true,
    purgeProjCache: true,
    labels: { user: '对方', assistant: '我' },
    extraPrompt: '',
    summary: {},
    ...options,
  }
  const fs = cfg.fs || DEFAULT_FS
  const now = typeof cfg.now === 'function' ? cfg.now : () => new Date()
  const cwd = String(cfg.cwd || cfg.workspace || process.cwd())
  const notesDir = String(cfg.notesDir || join(String(cfg.workspace || '.'), 'memory', 'carryover'))
  const sessionMapPath = String(cfg.sessionMapPath || join(String(cfg.workspace || '.'), 'tmp', 'session-map.json'))
  const logPath = String(cfg.logPath || join(String(cfg.workspace || '.'), 'memory', 'carryover.log'))

  /** 摘要器：注入的函数优先，否则用 HTTP 那个（key 缺失时 summarizeViaHttp 会抛，正是我们要的）。 */
  const summarizer =
    typeof cfg.summarize === 'function'
      ? cfg.summarize
      : (dialogue, extraPrompt) =>
          summarizeViaHttp(dialogue, {
            ...cfg.summary,
            prompt: cfg.summary?.prompt,
            extraPrompt: extraPrompt || cfg.summary?.extraPrompt || cfg.extraPrompt,
          })
  const canSummarize = typeof cfg.summarize === 'function' || Boolean(String(cfg.summary?.apiKey || '').trim())

  const readTranscript =
    typeof cfg.readTranscript === 'function'
      ? cfg.readTranscript
      : (file) => readTranscriptText(file, { fs, maxChars: cfg.maxInputChars, labels: cfg.labels, zstdCli: cfg.zstdCli })

  const projectKeyFn = typeof cfg.projectKey === 'function' ? cfg.projectKey : projectKey

  function logLine(line) {
    try {
      fs.mkdirSync(join(String(cfg.workspace || '.'), 'memory'), { recursive: true })
      fs.appendFileSync(logPath, `${now().toISOString()} ${line}\n`)
    } catch {
      // 日志写不进去不能影响正事
    }
  }

  function readMap() {
    try {
      const m = JSON.parse(String(fs.readFileSync(sessionMapPath, 'utf8')))
      return m && typeof m === 'object' ? m : {}
    } catch {
      return {}
    }
  }

  function writeMap(map) {
    try {
      fs.mkdirSync(dirname(sessionMapPath), { recursive: true })
      fs.writeFileSync(sessionMapPath, JSON.stringify(map, null, 2))
      return true
    } catch {
      return false
    }
  }

  /** 当前会话 id → 通道 key（给注入用）。宿主想自己认，就注入 keyOfSession。 */
  function keyOfSession(sessionId) {
    if (typeof cfg.keyOfSession === 'function') {
      try {
        return String(cfg.keyOfSession(sessionId) || '')
      } catch {
        return ''
      }
    }
    const id = String(sessionId || '')
    if (!id) return ''
    for (const [k, v] of Object.entries(readMap())) {
      if (v && String(v.sessionId || '') === id) return k
    }
    return ''
  }

  /** 删除：路径护栏过了才动手，且**只删这一个 id 自己**。 */
  function purge(sessionId, dir) {
    const out = { dir: false, cache: false, skipped: '', error: '' }
    if (!isSafePurgePath(dir, sessionId, cfg.sessionsRoot)) {
      out.skipped = 'unsafe-path'
      return out
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      out.dir = true
    } catch (e) {
      out.error = msgOf(e)
      return out
    }
    if (cfg.purgeProjCache && cfg.projCacheRoot) {
      try {
        const c = projCacheFileOf(cfg.projCacheRoot, sessionId)
        if (fs.existsSync(c)) {
          fs.rmSync(c, { force: true })
          out.cache = true
        }
      } catch (e) {
        out.error = out.error || msgOf(e)
      }
    }
    return out
  }

  /** 只读体检：谁还没交接、笔记在哪、多大。给工具和自检用，不花钱、不动盘。 */
  function status() {
    const map = readMap()
    const keys = Object.keys(map)
    return keys.map((key) => {
      const rec = map[key] || {}
      const prev = String(rec.sessionId || '')
      const dir = prev ? locateSessionDir(prev, cwd, { fs, sessionsRoot: cfg.sessionsRoot, projectKey: projectKeyFn }) : ''
      const noteFile = noteFileOf(notesDir, key)
      let noteChars = 0
      let noteAt = ''
      try {
        if (fs.existsSync(noteFile)) {
          const t = String(fs.readFileSync(noteFile, 'utf8'))
          noteChars = t.length
          const m = /^## (.*?) · /m.exec(t)
          noteAt = m ? m[1] : ''
        }
      } catch {
        // 读不动就当没有
      }
      return {
        key,
        previousSessionId: prev,
        carried: String(rec.carried || '') === prev && Boolean(prev),
        sessionDir: dir,
        noteFile,
        noteChars,
        noteAt,
      }
    })
  }

  /**
   * 交接一条通道的上一个会话。
   *
   * mode:
   *   · run  —— 真干：摘要 → 写笔记 → 核对 → 删轨迹（默认）
   *   · dry  —— 真摘要，但不写不删（想看看摘要长什么样、值不值）
   *   · peek —— 一个模型调用都不发，只报「按现在的状态会怎么判」（给工具/自检用，不花钱）
   */
  async function carryOver(opts = {}) {
    const key = String(opts.key || '')
    const mode = ['run', 'dry', 'peek'].includes(opts.mode) ? opts.mode : 'run'
    const log = typeof opts.log === 'function' ? opts.log : () => {}
    const result = (status_, reason, extra = {}) => ({ status: status_, reason, key, mode, ...extra })

    if (!cfg.enabled && mode === 'run') return result('none', 'disabled')
    if (!key) return result('none', 'no-key')

    const map = readMap()
    const rec = map[key] || {}
    const prev = String(rec.sessionId || '')
    const dir = prev ? locateSessionDir(prev, cwd, { fs, sessionsRoot: cfg.sessionsRoot, projectKey: projectKeyFn }) : ''
    const transcript = dir ? findTranscript(dir, { fs, transcript: cfg.transcript }) : ''

    let transcriptOk = false
    let transcriptNote = ''
    let dialogue = ''
    let transcriptChars = 0
    if (dir && transcript) {
      try {
        const r = await readTranscript(transcript)
        transcriptChars = String(r?.jsonl ?? '').length
        dialogue = String(r?.dialogue ?? '')
        transcriptOk = true
      } catch (e) {
        // 读不出来 = 不删。上面 decideBeforeSummary 会把它判成 keep。
        transcriptNote = msgOf(e)
        log('读旧会话轨迹失败（这次不删）：', transcriptNote)
      }
    } else if (dir) {
      // 目录在、但里面认不出哪个是轨迹文件（名字变了？被谁挪走了？）。
      // 只有**空目录**才敢当「没东西可交接」；有文件却读不懂 → 不删。
      // 这一条是防 dsh 换格式版本：认不出来还照删，就是把话弄没了。
      let leftovers = 0
      try {
        leftovers = fs.readdirSync(dir).length
      } catch {
        leftovers = 1
      }
      if (leftovers === 0) {
        transcriptOk = true
      } else {
        transcriptNote = `目录里没有认得出的轨迹文件（${leftovers} 个其它文件）`
        log('认不出轨迹文件（这次不删）：', dir)
      }
    }

    const before = decideBeforeSummary({
      hasPrevious: Boolean(prev),
      alreadyCarried: Boolean(prev) && String(rec.carried || '') === prev,
      // 根目录不在 = 配置错（不是「这个会话没了」）。判成 keep，别记账 —— 见 decideBeforeSummary 的注释。
      sessionsRootOk: Boolean(cfg.sessionsRoot) && isDir(fs, cfg.sessionsRoot),
      sessionDirFound: Boolean(dir),
      transcriptOk,
      dialogueChars: dialogue.replace(/\s/g, '').length,
      minDialogueChars: cfg.minDialogueChars,
      purgeThin: cfg.purgeThinSessions,
      canSummarize,
    })

    const markCarried = () => {
      if (mode !== 'run') return
      map[key] = { ...rec, carried: prev }
      writeMap(map)
    }

    if (before.action === 'none') return result('none', before.reason, { prevSessionId: prev })
    if (before.action === 'forget') {
      markCarried()
      logLine(`FORGET ${key} ${prev} 轨迹已经不在了，记一笔`)
      return result('none', before.reason, { prevSessionId: prev })
    }
    if (before.action === 'keep') {
      logLine(`KEEP ${key} ${prev} ${before.reason}，旧轨迹保留${transcriptNote ? `（${transcriptNote}）` : ''}`)
      log('这次不删旧轨迹：', before.reason, transcriptNote)
      return result('kept', before.reason, { prevSessionId: prev, chars: dialogue.length, note: transcriptNote })
    }
    if (before.action === 'purge') {
      // 正文太薄：没必要为了两句寒暄花一次模型调用
      if (mode === 'peek') return result('done', before.reason, { prevSessionId: prev, chars: dialogue.length, deleted: false })
      const p = purge(prev, dir)
      markCarried()
      logLine(`DONE ${key} ${prev} 正文太薄（${dialogue.length} 字），直接清掉轨迹 deleted=${p.dir}`)
      return result('done', before.reason, { prevSessionId: prev, chars: dialogue.length, deleted: p.dir })
    }

    if (mode === 'peek') {
      return result('done', 'would-summarize', { prevSessionId: prev, chars: dialogue.length, deleted: false })
    }

    let summary = ''
    let summaryError = ''
    try {
      summary = String((await summarizer(dialogue, cfg.extraPrompt)) ?? '').trim()
    } catch (e) {
      summaryError = msgOf(e)
    }
    // 摘要可能比上下文预算还长 —— 截到上限（头尾各留一半，见 clampText）
    const clamped = clampText(summary, cfg.maxSummaryChars)

    const noteFile = noteFileOf(notesDir, key)
    let noteError = ''
    let noteVerified = false
    let noteWriteAttempted = false

    // dry：摘要已经拿到手了，够判断「值不值」，写和删都省掉（不落盘就无所谓核对）
    if (mode === 'dry') {
      logLine(`DRY ${key} ${prev} 摘要${clamped.length}字（本该写 ${noteFile}，不写不删）`)
      return result('done', summaryError ? 'summary-failed' : 'dry', {
        prevSessionId: prev,
        chars: dialogue.length,
        summaryChars: clamped.length,
        summaryError,
        noteFile,
        deleted: false,
      })
    }

    if (!summaryError && clamped.trim()) {
      noteWriteAttempted = true
      const written = appendNote(
        noteFile,
        formatNoteBlock({
          stamp: stampOf(now()),
          key,
          sessionId: prev,
          chars: dialogue.length,
          summary: clamped,
        }),
        { fs, dir: notesDir, sessionId: prev, summary: clamped },
      )
      noteError = written.error
      noteVerified = written.ok
    }

    const after = decideAfterSummary({
      summaryError,
      summary: clamped,
      minSummaryChars: cfg.minSummaryChars,
      noteError,
      noteVerified,
    })

    if (after.action === 'keep') {
      logLine(
        `KEEP ${key} ${prev} ${after.reason}` +
          (summaryError ? `：${summaryError}` : '') +
          (noteError ? `：${noteError}` : '') +
          ' —— 旧轨迹保留',
      )
      log('摘要/落盘这一环没成，旧轨迹没删：', after.reason, summaryError || noteError)
      return result('kept', after.reason, {
        prevSessionId: prev,
        chars: dialogue.length,
        summaryChars: clamped.length,
        summaryError,
        noteError,
        noteWriteAttempted,
        deleted: false,
      })
    }

    const p = purge(prev, dir)
    markCarried()
    logLine(
      `DONE ${key} ${prev} 轨迹${transcriptChars}字 → 正文${dialogue.length}字 → 摘要${clamped.length}字；` +
        `轨迹删除=${p.dir} 缓存删除=${p.cache} 笔记=${noteFile}`,
    )
    log('交接完成：上一个', shortId(prev), '→ 摘要', clamped.length, '字 →', noteFile)
    return result('done', 'ok', {
      prevSessionId: prev,
      chars: dialogue.length,
      summaryChars: clamped.length,
      deleted: p.dir,
      deletedCache: p.cache,
      noteFile,
    })
  }

  return {
    config: cfg,
    notesDir,
    sessionMapPath,
    logPath,
    noteFileOf: (key) => noteFileOf(notesDir, key),
    readNote: (key, maxChars) => readNote(noteFileOf(notesDir, key), maxChars ?? cfg.maxInjectChars, { fs }),
    keyOfSession,
    status,
    purge,
    carryOver,
    locateSessionDir: (id) => locateSessionDir(id, cwd, { fs, sessionsRoot: cfg.sessionsRoot, projectKey: projectKeyFn }),
    canSummarize,
  }
}
