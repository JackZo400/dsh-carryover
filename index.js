/**
 * dsh-carryover —— 让「开新会话」不再等于「把话丢了」。
 *
 * 它解决的问题：dsh 的会话上下文迟早会满。人一开新会话，上一轮聊过的东西就没了。
 * 这个插件的规矩只有一条，但它是硬的：
 *
 *   **先把这一段写成笔记，笔记落盘核对成功，才允许删旧会话轨迹；
 *     摘要失败、写盘失败、轨迹读不出来 —— 一条都不删。**
 *
 * 宁可不清理，也不丢话。所以你会看到核心逻辑（`src/carryover.js`）里到处是
 * 「读不回来就不删」「路径不对就不删」这种看起来多余的检查 —— 它们挡的都是不可逆的错。
 *
 * 出口：
 *   · `carryover_status` / `carryover_note` / `carryover_run` 三个工具 —— Agent 自己调
 *   · `carryover` 服务 —— 宿主插件调（`ctx.get('carryover').carryOver({ key })`），
 *     推荐在「建新会话之前」调一次，这是最准的时机
 *   · 一个 system prompt 注入钩子 —— 新会话第一次组装上下文时，
 *     把这条通道的笔记挂上去（宿主只要维护 `sessionMapPath` 那份映射就行，见 README）
 *
 * 摘要默认走任何 OpenAI 兼容的 `/chat/completions`（配 `summary.*`），
 * 也可以直接注入自己的摘要函数（`summarize`）—— 自检就是这么跑的，一次网络请求都没有。
 *
 * @module dsh-carryover
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createCarryover, projectKey } from './src/carryover.js'

/** Cordis 插件名。 */
export const name = 'dsh-carryover'

/** 需要的能力：注册工具 + 往 system prompt 里挂一段。 */
export const inject = ['tools', 'systemPrompt']

export const DEFAULTS = {
  /** 总开关。出问题时整个关掉，插件变成什么都不做 */
  enabled: true,

  // —— 去哪儿找 dsh 的会话轨迹 ——
  /** 会话轨迹根目录（dsh 默认 `~/.dsh/sessions`） */
  sessionsRoot: process.env.DSH_CARRYOVER_SESSIONS_ROOT || join(homedir(), '.dsh', 'sessions'),
  /** 会话投影缓存目录（标题/统计那份 json，删会话时顺手清） */
  projCacheRoot:
    process.env.DSH_CARRYOVER_PROJCACHE_ROOT || join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'),
  /** 轨迹文件名。'auto' = 在会话目录里挑版本号最大的 `session.v<N>.jsonl.zstd` */
  transcript: 'auto',

  // —— 笔记与账本放哪 ——
  /** 工作目录：笔记、账本、日志默认都在这下面 */
  workspace: process.env.DSH_CARRYOVER_WORKSPACE || '',
  /** 轨迹按哪个工作目录分桶（一般等于 workspace，做多工作区宿主时才要分开） */
  cwd: '',
  /** 笔记目录，默认 `<workspace>/memory/carryover` */
  notesDir: '',
  /** 通道 → 会话 id 的映射文件，默认 `<workspace>/tmp/session-map.json` */
  sessionMapPath: '',
  /** 交接日志，默认 `<workspace>/memory/carryover.log` */
  logPath: '',

  // —— 注入 ——
  /** 新会话要不要自动带上笔记 */
  inject: true,
  /** 挂进上下文的顺序（越小越靠前）。默认排在人设之后、不抢戏 */
  injectOrder: 40,
  /** 注入那段的标题 */
  injectHeading: '# 上一个会话留下的笔记（自动摘要，不是全本）',
  /** 一次最多注入多少字符（全文永远在磁盘上） */
  maxInjectChars: 4000,

  // —— 摘要的闸门 ——
  /** 喂给摘要的正文上限（字符）；超了砍头留尾 */
  maxInputChars: 60000,
  /** 摘要本身的上限；超了头尾各留一半地截断 */
  maxSummaryChars: 1200,
  /** 正文去空白后不到这个长度 = 太薄，不值得花一次模型调用（可关，见 purgeThinSessions） */
  minDialogueChars: 40,
  /** 太薄的正文直接清掉轨迹（关掉它 = 再短也留着，等人工处理） */
  purgeThinSessions: true,
  /** 摘不到这个长度就当没摘到，不删 */
  minSummaryChars: 10,
  /** 删会话时顺手清投影缓存 */
  purgeProjCache: true,
  /** 对话里两种角色的标签（摘要提示词按这个理解谁说了什么） */
  labels: { user: '对方', assistant: '我' },

  /** 摘要接口（任何 OpenAI 兼容；配 baseUrl 到根或 /v1 都行，会自己补 /chat/completions） */
  summary: {
    baseUrl: process.env.DSH_CARRYOVER_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.DSH_CARRYOVER_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DSH_CARRYOVER_MODEL || 'deepseek-chat',
    maxTokens: 900,
    temperature: 0.3,
    timeoutMs: 120_000,
    /** 整段替换掉内置提示词；留空 = 用内置那份 */
    prompt: '',
    /** 追加一句额外要求（比如「顺手把这轮新冒出来的说法抄出来」） */
    extraPrompt: '',
  },

  // —— 注入点：YAML 里写不了函数，只有拿 JS 装插件/跑自检时才用得上 ——
  /** 自定义摘要函数 `(dialogue, extraPrompt) => Promise<string>` */
  summarize: null,
  /** 自定义轨迹读取 `(file) => Promise<{jsonl, dialogue}>` */
  readTranscript: null,
  /** 自定义 fs（签名同 node:fs 的同步那套） */
  fs: null,
  /** 自定义时钟 `() => Date` */
  now: null,
  /** 自定义「当前会话属于哪条通道」 */
  keyOfSession: null,
}

/**
 * DEFAULTS + rawConfig 合并。
 * 两层嵌套（labels / summary）要单独合，不然配了 `summary.model` 会把整个 summary 表打掉。
 */
export function mergeConfig(rawConfig) {
  const raw = rawConfig ?? {}
  return {
    ...DEFAULTS,
    ...raw,
    labels: { ...DEFAULTS.labels, ...(raw.labels || {}) },
    summary: { ...DEFAULTS.summary, ...(raw.summary || {}) },
  }
}

/**
 * 配置里的 `~/x` 要自己展开。
 * 这里不是 shell，YAML 读出来的就是字面量 `~/.dsh/sessions`；
 * 不展开的话 resolve() 会把它拼成 `<cwd>/~/.dsh/sessions` —— 一个永远不存在的目录，
 * 然后插件就静悄悄地什么都不交接了（最难查的那种坏法）。
 */
export function expandHome(p) {
  const s = String(p ?? '')
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2))
  return s
}

/**
 * 工具的返回值要**正好**是 schema 里声明的那几个字段。
 * 引擎的原始结果里还带着 reason 之外的一堆细节（noteError / prevSessionId / mode…），
 * 而 output schema 写的是 additionalProperties: false —— 多塞字段在严格校验下会被拒。
 * 所以在这里收口：想让人看见的挑出来，其余的进日志。
 */
function normalizeRun(r, key) {
  const detail = r?.summaryError || r?.noteError || r?.note || ''
  return {
    status: String(r?.status ?? 'kept'),
    reason: String(r?.reason ?? 'unknown'),
    key: String(r?.key || key || ''),
    chars: Number(r?.chars) || 0,
    summaryChars: Number(r?.summaryChars) || 0,
    deleted: Boolean(r?.deleted),
    ...(r?.noteFile ? { noteFile: String(r.noteFile) } : {}),
    ...(detail ? { note: String(detail).slice(0, 300) } : {}),
  }
}

export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig)

  // 直接写 stderr，不走 ctx.logger —— cordis 的 logger 默认只挂一个内存环形缓冲，
  // info 既不落文件也不上屏，插件看着像根本没加载。
  const log = (...args) => {
    try {
      process.stderr.write(`${new Date().toISOString()} [dsh-carryover] ${args.join(' ')}\n`)
    } catch {
      // stderr 都没了就算了
    }
  }

  const workspace = resolve(expandHome(config.workspace) || process.cwd())
  const engine = createCarryover({
    ...config,
    sessionsRoot: expandHome(config.sessionsRoot),
    projCacheRoot: expandHome(config.projCacheRoot),
    workspace,
    cwd: config.cwd ? resolve(expandHome(config.cwd)) : workspace,
    notesDir: config.notesDir ? resolve(expandHome(config.notesDir)) : '',
    sessionMapPath: config.sessionMapPath ? resolve(expandHome(config.sessionMapPath)) : '',
    logPath: config.logPath ? resolve(expandHome(config.logPath)) : '',
    summarize: config.summarize,
    readTranscript: config.readTranscript,
    fs: config.fs,
    now: config.now,
    keyOfSession: config.keyOfSession,
    projectKey: config.projectKey || projectKey,
  })

  /** 当前这条会话的通道 key。宿主认不出来就返回空 —— 工具会让人自己传 key。 */
  const currentKey = () => {
    try {
      // 可选访问一律用 ctx.get：直接点 ctx.agents 在没 inject 那个服务时会抛
      const id = ctx.get?.('agents')?.currentInitiator?.()?.id
      return id ? engine.keyOfSession(String(id)) : ''
    } catch {
      return ''
    }
  }

  const pickKey = (asked) => String(asked || '').trim() || currentKey()

  // ---------------- 出口一：三个工具 ----------------

  ctx.tools.register({
    name: 'carryover_status',
    description:
      '看看会话交接的账：每条通道的上一个会话是谁、交接了没有、笔记在哪、有多大。只读，不花钱、不删任何东西。想确认"上一个会话到底存下来没有"就问它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '只看这一条通道（比如 group:demo）；不给就全列出来。' },
      },
    },
    output: {
      // dsh 只收 JSON Schema 的一个子集：required 必须写成 object 上的字符串数组
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '给人看的一行一条清单。' },
          count: { type: 'integer', description: '列了几条。' },
          notesDir: { type: 'string', description: '笔记放在哪个目录。' },
        },
        required: ['text', 'count'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const only = String(args?.key || '').trim()
      const all = engine.status()
      const rows = only ? all.filter((r) => r.key === only) : all
      if (rows.length === 0) {
        return {
          text: only
            ? `账上没有「${only}」这条通道（映射文件：${engine.sessionMapPath}）。`
            : `账上还没有任何通道（映射文件：${engine.sessionMapPath}）。宿主没往里写过会话 id 的话，这里就是空的。`,
          count: 0,
          notesDir: engine.notesDir,
        }
      }
      const lines = [`交接账（${rows.length} 条）：`]
      for (const r of rows) {
        lines.push(
          `· ${r.key}：上一个会话 ${r.previousSessionId ? r.previousSessionId.slice(0, 8) : '（无）'}` +
            `${r.carried ? '（已交接）' : '（还没交接）'}` +
            `${r.sessionDir ? '' : '（轨迹已不在）'}` +
            ` · 笔记 ${r.noteChars} 字${r.noteAt ? `（最近 ${r.noteAt}）` : ''}`,
        )
      }
      lines.push('', `笔记目录：${engine.notesDir}`)
      return { text: lines.join('\n'), count: rows.length, notesDir: engine.notesDir }
    },
  })

  ctx.tools.register({
    name: 'carryover_note',
    description:
      '读上一个会话留下的交接笔记（这条通道自己的那份，不是全本）。新会话里想不起之前聊过什么、或者怀疑笔记没注入成功时用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '哪条通道的笔记；不给就用当前这条会话的通道。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '读到没有。' },
          key: { type: 'string', description: '读的是哪条通道。' },
          text: { type: 'string', description: '笔记正文（超长时只带最近的一段）。' },
          chars: { type: 'integer', description: '这次带回来的字符数。' },
          noteFile: { type: 'string', description: '全文在哪个文件里。' },
          note: { type: 'string', description: '没读到时的说明。' },
        },
        required: ['ok'],
      },
      render: (_args, v) => [{ type: 'text', text: v.ok ? v.text : `没读到：${v.note || '不知道为啥'}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const key = pickKey(args?.key)
      if (!key) return { ok: false, note: '认不出当前是哪条通道，直接给 key 吧（先用 carryover_status 看一眼）。' }
      const text = engine.readNote(key)
      const noteFile = engine.noteFileOf(key)
      if (!text) return { ok: false, key, noteFile, note: `这条通道还没有笔记（${noteFile}）。` }
      return { ok: true, key, text, chars: text.length, noteFile }
    },
  })

  ctx.tools.register({
    name: 'carryover_run',
    description:
      '给一条通道做会话交接：把上一个会话摘要成笔记，**笔记落盘核对成功才删**旧轨迹；摘要或写盘任何一步失败就什么都不删。mode=peek 只报"按现在的状态会怎么判"（不花钱、不动盘），dry 会真摘要但不写不删。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '哪条通道；不给就用当前这条会话的通道。' },
        mode: {
          type: 'string',
          enum: ['run', 'dry', 'peek'],
          description: 'run=真做（默认）；dry=真摘要但不写不删；peek=只判断不动手、不花钱。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'none=没什么可交接 / done=做完了 / kept=没做成，旧轨迹原样留着。' },
          reason: { type: 'string', description: '为什么是这个结果。' },
          key: { type: 'string', description: '哪条通道。' },
          chars: { type: 'integer', description: '这次读出来的正文多少字。' },
          summaryChars: { type: 'integer', description: '摘要多少字。' },
          deleted: { type: 'boolean', description: '旧轨迹删掉没有。' },
          noteFile: { type: 'string', description: '笔记文件。' },
          note: { type: 'string', description: '没做成时的原因（错误原文）。' },
        },
        required: ['status', 'reason'],
      },
      render: (_args, v) => {
        const verdict =
          v.status === 'done'
            ? v.deleted
              ? '笔记存好了，旧轨迹已删。'
              : '笔记存好了（这次没删轨迹）。'
            : v.status === 'kept'
              ? '没交接成，旧轨迹一条没删 —— 下次再来。'
              : '没什么可交接的。'
        return [
          {
            type: 'text',
            text: `${verdict}\n通道：${v.key || '?'} · 结果：${v.status}/${v.reason} · 正文 ${v.chars ?? 0} 字 · 摘要 ${v.summaryChars ?? 0} 字${v.noteFile ? `\n笔记：${v.noteFile}` : ''}${v.note ? `\n卡在：${v.note}` : ''}`,
          },
        ]
      },
    },
    // 它会写文件、删目录 —— 别让两个调用挤在一起跑
    isConcurrencySafe: () => false,
    async execute(args) {
      const key = pickKey(args?.key)
      if (!key) return { status: 'none', reason: 'no-key', key: '', chars: 0, summaryChars: 0 }
      try {
        const r = await engine.carryOver({ key, mode: args?.mode || 'run', log: (...a) => log(...a) })
        return normalizeRun(r, key)
      } catch (e) {
        // 交接出岔子不能把整轮带下水：如实说，轨迹没动
        log('交接异常（旧轨迹未动）：', String(e?.message || e))
        return { status: 'kept', reason: 'exception', key, note: String(e?.message || e).slice(0, 200) }
      }
    },
  })

  // ---------------- 出口二：新会话自动带上笔记 ----------------
  // 时机：新会话第一次组装 system prompt。这时宿主已经把映射写成新会话 id 了，
  // 所以「当前会话 id → 通道 key」是反查出来的，不需要宿主额外告诉我任何东西。
  try {
    if (config.inject) {
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const result = await next()
        try {
          const id = ctx.get?.('agents')?.currentInitiator?.()?.id
          if (!id) return result
          const key = engine.keyOfSession(String(id))
          if (!key) return result
          const note = engine.readNote(key)
          if (!note) return result
          return {
            ...result,
            contexts: [
              ...(result?.contexts ?? []),
              {
                name: 'carryover',
                order: config.injectOrder,
                text: `${config.injectHeading}\n\n${note}`,
              },
            ],
          }
        } catch (e) {
          // 注入失败绝不能影响正常回复
          log('注入交接笔记出错：', String(e?.message || e))
          return result
        }
      })
    }
  } catch (e) {
    log('注册注入钩子失败（工具和别的出口不受影响）：', String(e?.message || e))
  }

  // ---------------- 出口三：给别的插件用的服务 ----------------
  try {
    ctx.provide('carryover', {
      notesDir: engine.notesDir,
      sessionMapPath: engine.sessionMapPath,
      /** 交接一条通道的上一个会话（宿主在建新会话之前调它） */
      carryOver: (opts) => engine.carryOver(opts),
      /** 只读账本 */
      status: () => engine.status(),
      /** 读某条通道的笔记 */
      readNote: (key, maxChars) => engine.readNote(key, maxChars),
      /** 会话 id → 通道 key */
      keyOfSession: (id) => engine.keyOfSession(id),
      /** 这条通道的笔记文件在哪 */
      noteFileOf: (key) => engine.noteFileOf(key),
      /** 摘要器配好了没有（没配就只能 keep，不会误删） */
      canSummarize: () => engine.canSummarize,
    })
  } catch (e) {
    log('暴露 carryover 服务失败（不影响工具本身）：', String(e?.message || e))
  }

  log(
    `就绪：笔记=${engine.notesDir} 轨迹根=${config.sessionsRoot} 注入=${config.inject ? '开' : '关'} ` +
      `摘要=${typeof config.summarize === 'function' ? '注入的函数' : config.summary.model || '(没配)'}` +
      `${engine.canSummarize ? '' : '（没 key，只会 keep，不会删）'}`,
  )
  if (!isAbsolute(String(config.sessionsRoot || ''))) {
    log('提示：sessionsRoot 不是绝对路径，可能找不到会话轨迹。')
  }
}
