/**
 * 纯逻辑自检 —— 不联网、不调模型、不需要 dsh，也不碰私有目录。
 * clone 下来 `node test/selftest.mjs` 就该能跑，而且**真的断言**（不是打印一堆 OK）。
 *
 * 它在测什么：这个插件的卖点不是「会摘要」，是**什么时候允许删**。
 * 所以下面一半的篇幅是往「不该删」的方向使劲：摘要抛错、写盘报错、写进去但读回来是空的、
 * 轨迹读不出来、路径不对 —— 每一种都必须留下那句原话。
 *
 * 摘要器是假的（想返回什么就返回什么，想抛错就抛错），时间也是假的（好断言时间戳）。
 *   node test/selftest.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  DEFAULT_FS,
  appendNote,
  chatCompletionsUrl,
  clampText,
  createCarryover,
  decideAfterSummary,
  decideBeforeSummary,
  decodeTranscript,
  extractDialogue,
  findTranscript,
  formatNoteBlock,
  isSafePurgePath,
  locateSessionDir,
  noteFileOf,
  projectKey,
  readNote,
  slugKey,
  stampOf,
  summarizeViaHttp,
} from '../src/carryover.js'

let pass = 0
const fails = []
let sectionName = '（开头）'
const sections = []
function section(name) {
  sectionName = name
  sections.push({ name, n: 0 })
}
function ok(label, cond, extra) {
  const cur = sections[sections.length - 1]
  if (cond) {
    pass++
    if (cur) cur.n++
  } else {
    fails.push(`[${sectionName}] ` + label + (extra ? '  → ' + extra : ''))
  }
}
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)

/** 跑完把每节过了几项打出来 —— 一行 ✅ 看不出测了什么，这份清单才看得出。 */
function report(good) {
  console.log('──── 分节小计 ────')
  for (const s of sections) if (s.n > 0) console.log(`  ${s.name}：${s.n} 项`)
  if (fails.length) {
    console.log(`\n❌ ${fails.length} 项没过（过 ${pass} 项）：`)
    for (const f of fails) console.log('  · ' + f)
    process.exit(1)
  }
  console.log(`\n${good}：${pass} 项`)
}

const ROOT = mkdtempSync(join(tmpdir(), 'carryover-selftest-'))

// ───────────────────────── 假数据 ─────────────────────────

/** 造一棵「假 dsh 会话树」：轨迹根 + 工作区 + 映射文件，形状跟真的一样。 */
function fixture(name, { key = 'group:demo', sessionId = '11111111-2222-3333-4444-555555555555', body = '', transcript = 'session.v4.jsonl.zstd', extraFiles = [], base: sharedBase } = {}) {
  // base 可以几家共用 —— 想测「同一份账本里两条通道会不会串线」就得共用
  const base = sharedBase || join(ROOT, name)
  const workspace = join(base, 'workspace')
  const sessionsRoot = join(base, 'sessions')
  const projCacheRoot = join(base, 'projcache')
  const sessionDir = join(sessionsRoot, projectKey(workspace), sessionId)
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(join(workspace, 'tmp'), { recursive: true })
  const mapFile = join(workspace, 'tmp', 'session-map.json')
  let map = {}
  try {
    map = JSON.parse(readFileSync(mapFile, 'utf8'))
  } catch {
    map = {}
  }
  map[key] = { sessionId, at: 1 }
  writeFileSync(mapFile, JSON.stringify(map, null, 2))
  if (transcript) writeFileSync(join(sessionDir, transcript), body)
  for (const f of extraFiles) writeFileSync(join(sessionDir, f), 'x')
  return { base, workspace, sessionsRoot, projCacheRoot, sessionDir, key, sessionId }
}

/** 一条 user/message 事件。 */
const userLine = (text) => JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
/** 一条 assistant/message 事件（带推理块，提取时要被丢掉）。 */
const botLine = (text) => JSON.stringify({ type: 'assistant/message', data: { message: { content: [{ type: 'thinking', text: '内心戏' }, { type: 'text', text }] } } })

/** 一段够长的正文（正文去空白后要 > minDialogueChars）。 */
function longBody(text = '我们约好周五把插件发出去') {
  return [userLine(text), botLine('好，那我今天就把 README 写完'), userLine('顺便把自检也补上，别写空壳'), botLine('记下了')].join('\n')
}

/** 造一个引擎：摘要器、时间全注入，路径指向 fixture。 */
function engineOf(fx, over = {}) {
  const calls = []
  const engine = createCarryover({
    workspace: fx.workspace,
    cwd: fx.workspace,
    sessionsRoot: fx.sessionsRoot,
    projCacheRoot: fx.projCacheRoot,
    logPath: join(fx.workspace, 'memory', 'carryover.log'),
    summarize: async (dialogue) => {
      calls.push(dialogue)
      return '便条：今天把插件的 README 和自检写完了，还差发布前的脱敏检查。'
    },
    now: () => new Date('2026-09-28T03:12:00Z'),
    ...over,
  })
  return { engine, calls }
}

// ───────────────────────── 1. 文件名与路径（脏输入先在这一层挡住） ─────────────────────────
section('1 · 文件名与路径护栏')

eq('projectKey 认得普通路径', projectKey('/srv/app/workspace'), '--srv-app-workspace--')
// 尾部斜杠会多出一段横杠（dsh 的原算法就长这样）—— 记下来是想说明：
// projectKey 不是个干净的东西，所以定位轨迹不能只靠它，locateSessionDir 那边必须扫兜底。
eq('projectKey 尾部斜杠会多留一段横杠', projectKey('/srv/app/'), '--srv-app---')
ok('projectKey 空串也不炸（dsh 原版会抛，这里退化成一个兜底名）', projectKey('') === '--root--')

eq('slugKey 冒号变横杠', slugKey('group:demo'), 'group-demo')
eq('slugKey 挡目录穿越', slugKey('../../etc/passwd'), 'etc-passwd')
eq('slugKey 点开头结尾都收拾掉', slugKey('..'), 'unnamed')
eq('slugKey 空 key 有兜底名', slugKey(''), 'unnamed')
ok('slugKey 出来的东西一定没有斜杠', !slugKey('a/b\\c:d').includes('/') && !slugKey('a/b\\c:d').includes('\\'))

const SESS = '11111111-2222-3333-4444-555555555555'
eq('护栏：dsh 那种两层的正常路径放行', isSafePurgePath(`/s/--p--/${SESS}`, SESS, '/s'), true)
eq('护栏：平铺一层的也放行', isSafePurgePath(`/s/${SESS}`, SESS, '/s'), true)
eq('护栏：多一层不放行', isSafePurgePath(`/s/--p--/sub/${SESS}`, SESS, '/s'), false)
eq('护栏：目录名不是这个 id 不放行', isSafePurgePath('/s/--p--/other-id', SESS, '/s'), false)
eq('护栏：直接删根不放行', isSafePurgePath('/s', SESS, '/s'), false)
eq('护栏：直接删整个项目目录不放行', isSafePurgePath('/s/--p--', SESS, '/s'), false)
eq('护栏：跑出根外面不放行', isSafePurgePath(`/other/${SESS}`, SESS, '/s'), false)
eq('护栏：带 .. 不放行', isSafePurgePath(`/s/--p--/../${SESS}`, SESS, '/s'), false)
eq('护栏：空 id 不放行', isSafePurgePath('/s/--p--/', '', '/s'), false)

// ───────────────────────── 2. 截断：长度必须真的卡在上限内 ─────────────────────────
section('2 · 截断')

eq('没超长就原样返回', clampText('abc', 10), 'abc')
eq('超长时正好卡到上限', clampText('x'.repeat(100), 40).length, 40)
ok('超长时头尾都留着（尾巴是「还没完的事」，不能丢）', clampText('HEAD' + 'y'.repeat(100) + 'TAIL', 40).startsWith('HEAD') && clampText('HEAD' + 'y'.repeat(100) + 'TAIL', 40).endsWith('TAIL'))
eq('上限小于省略号本身也不越界', clampText('x'.repeat(100), 3).length, 3)
eq('上限 0 = 不截断（调用方自己负责）', clampText('x'.repeat(100), 0).length, 100)
ok('各种上限都真的 ≤ 上限', [1, 5, 12, 13, 20, 999].every((n) => clampText('q'.repeat(5000), n).length <= n))

eq('时间戳是稳定格式（不跟 locale 走）', stampOf(new Date(2026, 8, 28, 3, 12)), '2026-09-28 03:12')

// ───────────────────────── 3. 轨迹：定位、挑文件、解压 ─────────────────────────
section('3 · 轨迹定位与解压')

{
  const fx = fixture('locate')
  eq('按 projectKey 找得到轨迹目录', locateSessionDir(fx.sessionId, fx.workspace, { sessionsRoot: fx.sessionsRoot }), fx.sessionDir)
  // 换一个「算法不一样」的宿主：猜不到时应该扫一层兜底，而不是放弃
  const weird = locateSessionDir(fx.sessionId, '/totally/other/path', { sessionsRoot: fx.sessionsRoot })
  eq('projectKey 猜不中时扫一层兜底', weird, fx.sessionDir)
  eq('不存在的会话 id 老实返回空', locateSessionDir('no-such-id', fx.workspace, { sessionsRoot: fx.sessionsRoot }), '')

  eq('auto 挑得到轨迹', findTranscript(fx.sessionDir, {}), join(fx.sessionDir, 'session.v4.jsonl.zstd'))

  // dsh 的格式版本会往前走：v9 出现时必须挑 v9，别死认 v4
  writeFileSync(join(fx.sessionDir, 'session.v9.jsonl.zstd'), '{}')
  eq('auto 挑版本号最大的那个', findTranscript(fx.sessionDir, {}), join(fx.sessionDir, 'session.v9.jsonl.zstd'))
  eq('配了具体名字就用它', findTranscript(fx.sessionDir, { transcript: 'session.v4.jsonl.zstd' }), join(fx.sessionDir, 'session.v4.jsonl.zstd'))
  eq('目录里没有轨迹时返回空', findTranscript(join(ROOT, 'nope'), {}), '')
}

{
  const plain = await decodeTranscript(Buffer.from(longBody(), 'utf8'), {})
  ok('明文轨迹（测试用的假货）直接当文本读', plain.includes('周五'))
  if (typeof zstdCompressSync === 'function') {
    const packed = zstdCompressSync(Buffer.from(longBody(), 'utf8'))
    const out = await decodeTranscript(packed, {})
    ok('真 zstd 也解得出（多帧那种交给 CLI，单帧走 node:zlib）', out.includes('周五'))
  }
}

// ───────────────────────── 4. 从轨迹里挑「人对人说的话」 ─────────────────────────
section('4 · 正文提取')

{
  const jsonl = [
    userLine('<system-reminder>这是系统注入的框，不是人说的话</system-reminder>'),
    userLine('Current runtime context: 一堆环境信息'),
    userLine('<available_skills>技能目录</available_skills>'),
    userLine('alice：帮我把插件发出去'),
    'not json at all',
    botLine('好，我先把自检补上'),
    JSON.stringify({ type: 'tool/call', data: { name: 'bash' } }),
    '',
  ].join('\n')
  const out = extractDialogue(jsonl)
  ok('系统注入的框被剔掉', !out.includes('system-reminder') && !out.includes('runtime context') && !out.includes('available_skills'))
  ok('真说的话留下了（两边都在）', out.includes('对方：alice：帮我把插件发出去') && out.includes('我：好，我先把自检补上'))
  ok('推理块 / 工具调用没混进来', !out.includes('内心戏') && !out.includes('tool/call'))
  ok('坏行不毁整段（半行 JSON 跳过就行）', out.includes('周五') === false && out.split('\n').length === 2)

  const short = extractDialogue(jsonl, { maxChars: 20 })
  ok('超长时砍头留尾（最近说的最重要）', short.startsWith('（更早的内容已省略）') && short.endsWith(out.slice(-20)))

  const custom = extractDialogue(jsonl, { labels: { user: 'user', assistant: 'bot' } })
  ok('标签可换（非中文用户也能读）', custom.includes('user：') && custom.includes('bot：'))
}

// ───────────────────────── 4b. 默认摘要器：不联网也要能验 ─────────────────────────
section('4b · 默认摘要器（假 fetch）')

{
  eq('baseUrl 给根 → 自己补 /chat/completions', chatCompletionsUrl('https://api.example.com'), 'https://api.example.com/chat/completions')
  eq('baseUrl 给 /v1 → 补在后面', chatCompletionsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions')
  eq('baseUrl 已经给全 → 一个字都不动', chatCompletionsUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions')

  const seen = []
  const fakeFetch = (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '  便条：今天把自检补齐了。  ' } }] }),
      text: async () => '',
    })
  }
  const out = await summarizeViaHttp('对方：写自检了吗', {
    baseUrl: 'https://api.example.com',
    apiKey: 'demo-key',
    model: 'demo-model',
    fetchImpl: fakeFetch,
  })
  eq('摘要器拿回正文并 trim', out, '便条：今天把自检补齐了。')
  eq('请求打到了 /chat/completions', seen[0].url, 'https://api.example.com/chat/completions')
  eq('模型名传下去了', seen[0].body.model, 'demo-model')
  ok('提示词里带着「别编」这条底线', /别补、别猜、别编/.test(seen[0].body.messages[0].content))
  ok('正文作为 user 消息原样传下去', seen[0].body.messages[1].content.includes('写自检了吗'))
  ok('Authorization 头是 Bearer', seen[0].init.headers.Authorization === 'Bearer demo-key')

  const withExtra = await summarizeViaHttp('x', {
    baseUrl: 'https://api.example.com',
    apiKey: 'demo-key',
    extraPrompt: '顺手把这次新冒出来的说法抄出来。',
    fetchImpl: fakeFetch,
  })
  ok('extraPrompt 是追加，不是替换', withExtra && /别补、别猜、别编/.test(seen[1].body.messages[0].content) && /顺手把这次新冒出来的说法/.test(seen[1].body.messages[0].content))

  const custom = await summarizeViaHttp('x', {
    baseUrl: 'https://api.example.com',
    apiKey: 'demo-key',
    prompt: '你只要回一行字。',
    fetchImpl: fakeFetch,
  })
  ok('配了 prompt 就是整段替换（自家的语气自己定）', custom && seen[2].body.messages[0].content === '你只要回一行字。')

  // 失败必须抛 —— 悄悄返回空串会被上层当成「摘到了」，然后就是误删
  const boom = async (status, payload) => {
    try {
      await summarizeViaHttp('x', {
        baseUrl: 'https://api.example.com',
        apiKey: 'demo-key',
        fetchImpl: async () => ({ ok: false, status, text: async () => payload, json: async () => ({}) }),
      })
      return ''
    } catch (e) {
      return e.message
    }
  }
  ok('接口 500 → 抛错（不是返回空）', /500/.test(await boom(500, 'internal')))
  const empty = await (async () => {
    try {
      await summarizeViaHttp('x', {
        baseUrl: 'https://api.example.com',
        apiKey: 'demo-key',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }), text: async () => '' }),
      })
      return ''
    } catch (e) {
      return e.message
    }
  })()
  ok('返回空正文 → 抛错（空摘要不算摘要）', /返回空/.test(empty))
  const noKey = await (async () => {
    try {
      await summarizeViaHttp('x', { baseUrl: 'https://api.example.com', apiKey: '' })
      return ''
    } catch (e) {
      return e.message
    }
  })()
  ok('没 key → 抛错（上层会 keep，不会删）', /API key/.test(noKey))
}

// ───────────────────────── 5. 决策表：这是整个插件的心脏 ─────────────────────────
section('5 · 决策表（能不能删）')
{
  eq('没上一个会话 → 不动手', decideBeforeSummary({ hasPrevious: false }).action, 'none')
  eq('已经交接过了 → 不重复花摘要的钱', decideBeforeSummary({ hasPrevious: true, alreadyCarried: true }).action, 'none')
  eq('轨迹已经不在了 → 记一笔就行', decideBeforeSummary({ hasPrevious: true, sessionDirFound: false }).action, 'forget')
  eq('正文太薄 → 不值得调模型，直接清', decideBeforeSummary({ hasPrevious: true, sessionDirFound: true, transcriptOk: true, dialogueChars: 3, minDialogueChars: 40, purgeThin: true, canSummarize: true }).action, 'purge')
  eq('太薄但关掉了 purgeThin → 留着', decideBeforeSummary({ hasPrevious: true, sessionDirFound: true, transcriptOk: true, dialogueChars: 3, minDialogueChars: 40, purgeThin: false, canSummarize: true }).action, 'summarize')
  eq('没摘要器（没 key）→ keep', decideBeforeSummary({ hasPrevious: true, sessionDirFound: true, transcriptOk: true, dialogueChars: 999, canSummarize: false }).action, 'keep')
  eq('正常 → 去摘要', decideBeforeSummary({ hasPrevious: true, sessionDirFound: true, transcriptOk: true, dialogueChars: 999, canSummarize: true }).action, 'summarize')

  // 这条是「读不出来 ≠ 没什么可说」，第一版实现真的会在这里误删
  eq('轨迹读不出来 → keep（不许当太薄处理）', decideBeforeSummary({ hasPrevious: true, sessionDirFound: true, transcriptOk: false, dialogueChars: 0, minDialogueChars: 40, purgeThin: true, canSummarize: true }).action, 'keep')
  // 根目录没配对：不能当成「轨迹都不在了」，否则会把每条通道都记成已交接、再也摘不到
  eq('根目录不存在 → keep，不许当成 forget', decideBeforeSummary({ hasPrevious: true, sessionsRootOk: false, sessionDirFound: false, canSummarize: true }).action, 'keep')
  eq('根目录不存在的原因说得清', decideBeforeSummary({ hasPrevious: true, sessionsRootOk: false, sessionDirFound: false }).reason, 'sessions-root-missing')

  eq('摘要抛错 → keep', decideAfterSummary({ summaryError: '接口 500' }).action, 'keep')
  eq('摘要空 → keep', decideAfterSummary({ summary: '   ', minSummaryChars: 10, noteVerified: true }).action, 'keep')
  eq('摘要太短 → keep', decideAfterSummary({ summary: '嗯', minSummaryChars: 10, noteVerified: true }).action, 'keep')
  eq('笔记写失败 → keep', decideAfterSummary({ summary: 'ok'.repeat(20), minSummaryChars: 10, noteError: 'EACCES', noteVerified: false }).action, 'keep')
  eq('笔记写进去了但没核对过 → keep', decideAfterSummary({ summary: 'ok'.repeat(20), minSummaryChars: 10, noteVerified: false }).action, 'keep')
  eq('摘要 + 笔记 + 核对 三件都成立 → 才允许删', decideAfterSummary({ summary: 'ok'.repeat(20), minSummaryChars: 10, noteVerified: true }).action, 'purge')
}

// ───────────────────────── 6. 笔记文件：写、核对、读回、截断 ─────────────────────────
section('6 · 笔记文件')

{
  const dir = join(ROOT, 'notes')
  const file = noteFileOf(dir, 'group:demo')
  eq('笔记文件名跟着 key 走', file, join(dir, 'group-demo.md'))

  const block = formatNoteBlock({ stamp: '2026-09-28 03:12', key: 'group:demo', sessionId: SESS, chars: 120, summary: '便条正文' })
  const w = appendNote(file, block, { fs: DEFAULT_FS, dir, sessionId: SESS, summary: '便条正文' })
  eq('写笔记成功', w.ok, true)
  ok('笔记里带着会话 id（对账用）', readFileSync(file, 'utf8').includes(SESS))

  const w2 = appendNote(file, block, { fs: DEFAULT_FS, dir, sessionId: SESS, summary: '便条正文' })
  ok('第二次是追加，不覆盖历史', w2.ok && readFileSync(file, 'utf8').split('## 2026-09-28').length === 3)

  const only = readNote(file, 100000, { fs: DEFAULT_FS })
  ok('读得回来', only.includes('便条正文') && only.includes('group:demo'))
  const clamped = readNote(file, 30, { fs: DEFAULT_FS })
  ok(
    '注入超长时只带最近一段 + 指路全文',
    clamped.includes('只带最近的部分') && clamped.endsWith(only.slice(-30)) && clamped.length < only.length,
    `len=${clamped.length}`,
  )
  eq('没有笔记文件 → 空串（不是抛错）', readNote(join(dir, 'none.md'), 100, { fs: DEFAULT_FS }), '')

  // 会话 id 对不上 = 这份笔记不是这次写的 → 不许当成核对通过
  const w3 = appendNote(join(dir, 'mismatch.md'), formatNoteBlock({ stamp: 'x', key: 'k', sessionId: 'other', chars: 1, summary: '嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯' }), { fs: DEFAULT_FS, dir, sessionId: SESS, summary: '嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯' })
  eq('会话 id 对不上 → 核对不通过', w3.ok, false)
}

// ───────────────────────── 7. 四条硬要求：真的动盘，真的删/真的不删 ─────────────────────────
section('7 · 端到端（真临时目录）')

// ① 摘要成功 → 才允许删轨迹
section('7① 摘要成功才允许删')
{
  const fx = fixture('happy', { body: longBody() })
  const { engine, calls } = engineOf(fx)
  const r = await engine.carryOver({ key: fx.key })
  eq('① 摘要成功：状态 done', r.status, 'done')
  eq('① 摘要成功：轨迹真的删了', r.deleted, true)
  eq('① 摘要成功：目录从磁盘上没了', existsSync(fx.sessionDir), false)
  eq('① 摘要器被调了 1 次', calls.length, 1)
  eq('① 喂进去的正文带上人了', calls[0].includes('alice') || calls[0].includes('周五'), true)
  const note = readFileSync(engine.noteFileOf(fx.key), 'utf8')
  ok('① 笔记留在盘上（话没丢）', note.includes('便条：今天把插件的 README'))
  ok('① 笔记里记着是哪个会话', note.includes(fx.sessionId))
  ok('① 日志也记了一笔', readFileSync(engine.logPath, 'utf8').includes('DONE'))
  const map = JSON.parse(readFileSync(engine.sessionMapPath, 'utf8'))
  eq('① 账本标了已交接（不会重复摘要）', map[fx.key].carried, fx.sessionId)
  const again = await engine.carryOver({ key: fx.key })
  eq('① 第二次调不再动手', again.reason, 'already-carried')
  eq('① 第二次也没再调模型', calls.length, 1)
}

// ② 摘要失败 → 一条都不许删
section('7② 摘要失败不许删')
{
  const fx = fixture('sumfail', { body: longBody() })
  const { engine } = engineOf(fx, {
    summarize: async () => {
      throw new Error('摘要接口 500 Internal Server Error')
    },
  })
  const r = await engine.carryOver({ key: fx.key })
  eq('② 摘要失败：状态 kept', r.status, 'kept')
  eq('② 摘要失败：原因是 summary-failed', r.reason, 'summary-failed')
  eq('② 摘要失败：轨迹目录原样还在', existsSync(fx.sessionDir), true)
  eq('② 摘要失败：轨迹文件也还在', existsSync(join(fx.sessionDir, 'session.v4.jsonl.zstd')), true)
  eq('② 摘要失败：没写笔记', existsSync(engine.noteFileOf(fx.key)), false)
  ok('② 摘要失败：日志写的是 KEEP', readFileSync(engine.logPath, 'utf8').includes('KEEP'))
  const map = JSON.parse(readFileSync(engine.sessionMapPath, 'utf8'))
  eq('② 摘要失败：账本没标已交接（下次还会重试）', map[fx.key].carried, undefined)
}

// ③ 摘要超长 → 截断到上限（但仍然算成功、仍然可以删）
section('7③ 摘要超长要截断')
{
  const fx = fixture('toolong', { body: longBody() })
  const huge = '头' + '很'.repeat(5000) + '尾'
  const { engine } = engineOf(fx, { summarize: async () => huge, maxSummaryChars: 300 })
  const r = await engine.carryOver({ key: fx.key })
  eq('③ 超长摘要：状态还是 done', r.status, 'done')
  eq('③ 超长摘要：被截到 maxSummaryChars', r.summaryChars, 300)
  ok('③ 超长摘要：头尾都留着', readFileSync(engine.noteFileOf(fx.key), 'utf8').includes('头'))
  const note = readFileSync(engine.noteFileOf(fx.key), 'utf8')
  ok('③ 超长摘要：笔记里也不超过上限那一截', /中间省略/.test(note))
}

// ④ 写盘失败 → 一条都不许删（真权限 + 假 fs 两种都试）
section('7④ 写盘失败不许删')
{
  const fx = fixture('readonly', { body: longBody() })
  // 先探一下这个环境拦不拦得住：以 root 跑的话权限挡不住，那种情况下这条只能跳过
  mkdirSync(join(fx.workspace, 'memory', 'carryover'), { recursive: true })
  chmodSync(join(fx.workspace, 'memory', 'carryover'), 0o500)
  let blocked = false
  try {
    appendFileSync(join(fx.workspace, 'memory', 'carryover', 'probe.md'), 'x')
  } catch {
    blocked = true
  }
  if (blocked) {
    const { engine } = engineOf(fx)
    const r = await engine.carryOver({ key: fx.key })
    eq('④ 权限拒绝（真 EACCES）：状态 kept', r.status, 'kept')
    eq('④ 权限拒绝：原因是 note-write-failed', r.reason, 'note-write-failed')
    eq('④ 权限拒绝：轨迹一条没删', existsSync(fx.sessionDir), true)
    ok('④ 权限拒绝：错误说得清是写盘', /EACCES|permission/i.test(r.noteError || ''), r.noteError)
  } else {
    ok('④ 权限拒绝：跳过（这个环境是 root，权限挡不住写）', true)
  }
  chmodSync(join(fx.workspace, 'memory', 'carryover'), 0o700)
}

{
  const fx = fixture('enospc', { body: longBody() })
  const { engine } = engineOf(fx, {
    // 只让**笔记**这一条写失败（真的磁盘满会把日志也一起带走，但那样就没法断言日志了）
    fs: {
      ...DEFAULT_FS,
      appendFileSync: (p, ...rest) => {
        if (String(p).includes('/carryover/')) {
          const e = new Error('ENOSPC: no space left on device')
          e.code = 'ENOSPC'
          throw e
        }
        return appendFileSync(p, ...rest)
      },
    },
  })
  const r = await engine.carryOver({ key: fx.key })
  eq('④ 磁盘满（ENOSPC）：状态 kept', r.status, 'kept')
  eq('④ 磁盘满：原因是 note-write-failed', r.reason, 'note-write-failed')
  eq('④ 磁盘满：轨迹一条没删', existsSync(fx.sessionDir), true)
  ok('④ 磁盘满：错误说得清是 ENOSPC', /ENOSPC/.test(r.noteError || ''), r.noteError)
  ok('④ 磁盘满：日志写的是 KEEP', readFileSync(engine.logPath, 'utf8').includes('KEEP'))
}

{
  // 最阴的一种：appendFileSync 不抛错，但字节根本没落地（半截写 / 网络盘吞写）。
  // 只靠「没抛异常」判断就去删轨迹，那段话就没了 —— 所以必须读回来核对。
  const fx = fixture('silentdrop', { body: longBody() })
  const { engine } = engineOf(fx, {
    fs: {
      ...DEFAULT_FS,
      appendFileSync: () => {},
      readFileSync: (p, ...rest) => (String(p).includes('/carryover/') ? '' : readFileSync(p, ...rest)),
    },
  })
  const r = await engine.carryOver({ key: fx.key })
  eq('④ 静默丢写（不报错但读回来是空）：状态 kept', r.status, 'kept')
  eq('④ 静默丢写：原因是 note-write-failed', r.reason, 'note-write-failed')
  ok('④ 静默丢写：错误明说读回来是空的', /读回来是空/.test(r.noteError || ''), r.noteError)
  eq('④ 静默丢写：轨迹一条没删', existsSync(fx.sessionDir), true)
}

// ⑤ 轨迹读不出来 → 不许删（第一版实现会在这里误删：读失败 → 正文空 → 被判「太薄」）
section('7⑤ 轨迹读不出来不许删')
{
  const fx = fixture('badtranscript', { body: 'not jsonl at all\n{{{', transcript: 'session.v4.jsonl.zstd' })
  const { engine } = engineOf(fx, {
    readTranscript: async () => {
      throw new Error('zstd: 解压失败')
    },
  })
  const r = await engine.carryOver({ key: fx.key })
  eq('⑤ 解压失败：状态 kept', r.status, 'kept')
  eq('⑤ 解压失败：原因是 transcript-unreadable', r.reason, 'transcript-unreadable')
  eq('⑤ 解压失败：轨迹一条没删', existsSync(fx.sessionDir), true)

  // 目录里有文件、但没有一个是能认出来的轨迹文件（dsh 换了命名/格式）→ 也不许删
  const fx2 = fixture('nofile', { body: '', transcript: '', extraFiles: ['session.v5.jsonl.something-new'] })
  const { engine: e2 } = engineOf(fx2)
  const r2 = await e2.carryOver({ key: fx2.key })
  eq('⑤ 认不出轨迹文件：状态 kept', r2.status, 'kept')
  eq('⑤ 认不出轨迹文件：轨迹目录没动', existsSync(fx2.sessionDir), true)
}

// ⑥ 正文太薄：不花模型的钱，直接清（这条是「省」而不是「丢」）
section('7⑥ 正文太薄直接清')
{
  const fx = fixture('thin', { body: [userLine('在吗'), botLine('在')].join('\n') })
  const { engine, calls } = engineOf(fx)
  const r = await engine.carryOver({ key: fx.key })
  eq('⑥ 太薄：状态 done', r.status, 'done')
  eq('⑥ 太薄：原因是 too-thin', r.reason, 'too-thin')
  eq('⑥ 太薄：一次模型调用都没发', calls.length, 0)
  eq('⑥ 太薄：轨迹清了', existsSync(fx.sessionDir), false)
  // 关掉这个开关：再短也走一遍摘要（不省那点钱），摘成了照样删 —— 这才是它和「留着」的区别
  const fx2 = fixture('thin2', { body: [userLine('在吗'), botLine('在')].join('\n') })
  const { engine: e2, calls: c2 } = engineOf(fx2, { purgeThinSessions: false })
  const r2 = await e2.carryOver({ key: fx2.key })
  eq('⑥ 关掉 purgeThinSessions：短会话也照样摘要', c2.length, 1)
  eq('⑥ 关掉 purgeThinSessions：摘成了就正常删', r2.status, 'done')
  eq('⑥ 关掉 purgeThinSessions：轨迹清了', existsSync(fx2.sessionDir), false)
  // 短会话 + 摘要失败 → 还是不许删（「短」不是删的理由，「摘到了」才是）
  const fx3 = fixture('thin3', { body: [userLine('在吗'), botLine('在')].join('\n') })
  const { engine: e3 } = engineOf(fx3, {
    purgeThinSessions: false,
    summarize: async () => {
      throw new Error('接口超时')
    },
  })
  const r3 = await e3.carryOver({ key: fx3.key })
  eq('⑥ 短会话 + 摘要失败：轨迹留着', existsSync(fx3.sessionDir), true)
  eq('⑥ 短会话 + 摘要失败：状态 kept', r3.status, 'kept')
}

// ⑦ dry / peek：不写不删（peek 连模型都不发 —— 工具默认用它，不能偷偷花钱）
section('7⑦ dry / peek 不写不删')
{
  const dryFx = fixture('dry', { body: longBody() })
  const dryEngine = engineOf(dryFx)
  const d = await dryEngine.engine.carryOver({ key: dryFx.key, mode: 'dry' })
  eq('⑦ dry：摘要真拿到了', d.summaryChars > 0, true)
  eq('⑦ dry：轨迹没删', existsSync(dryFx.sessionDir), true)
  eq('⑦ dry：也没写笔记', existsSync(dryEngine.engine.noteFileOf(dryFx.key)), false)

  const peekFx = fixture('peek', { body: longBody() })
  const peekEngine = engineOf(peekFx)
  const p = await peekEngine.engine.carryOver({ key: peekFx.key, mode: 'peek' })
  eq('⑦ peek：一次模型调用都没发', peekEngine.calls.length, 0)
  eq('⑦ peek：报的是「本该去摘要」', p.reason, 'would-summarize')
  eq('⑦ peek：轨迹没删', existsSync(peekFx.sessionDir), true)
}

// ⑧ 「轨迹早就不在」要能自己记账，别每次都来一遍
section('7⑧ 轨迹已不在 / 根目录配错')
{
  const fx = fixture('gone', { body: longBody() })
  rmSync(fx.sessionDir, { recursive: true, force: true })
  const { engine, calls } = engineOf(fx)
  const r = await engine.carryOver({ key: fx.key })
  eq('⑧ 轨迹已不在：状态 none', r.status, 'none')
  eq('⑧ 轨迹已不在：原因是 transcript-gone', r.reason, 'transcript-gone')
  eq('⑧ 轨迹已不在：不调模型', calls.length, 0)
  ok('⑧ 轨迹已不在：日志记了 FORGET', readFileSync(engine.logPath, 'utf8').includes('FORGET'))

  // 但「轨迹不在」和「我把根目录配错了」是两回事：配错的时候绝不能记账，
  // 不然每条通道都会被标成已交接，配置改回来也永远不再被摘要。
  const fx2 = fixture('badroot', { body: longBody() })
  const { engine: e2, calls: c2 } = engineOf(fx2, { sessionsRoot: join(fx2.base, 'no-such-root') })
  const r2 = await e2.carryOver({ key: fx2.key })
  eq('⑧ 根目录配错：状态 kept', r2.status, 'kept')
  eq('⑧ 根目录配错：原因是 sessions-root-missing', r2.reason, 'sessions-root-missing')
  eq('⑧ 根目录配错：不调模型', c2.length, 0)
  eq('⑧ 根目录配错：轨迹当然也没动', existsSync(fx2.sessionDir), true)
  const map = JSON.parse(readFileSync(e2.sessionMapPath, 'utf8'))
  eq('⑧ 根目录配错：账本没被标成已交接（配置改回来还能救）', map[fx2.key].carried, undefined)
}

// ⑨ 没 key 又没注入摘要器 → keep（绝不能因为「摘要没配」就把话删了）
section('7⑨ 没摘要器就 keep')
{
  const fx = fixture('nokey', { body: longBody() })
  const engine = createCarryover({
    workspace: fx.workspace,
    cwd: fx.workspace,
    sessionsRoot: fx.sessionsRoot,
    projCacheRoot: fx.projCacheRoot,
    summary: { apiKey: '' },
  })
  const r = await engine.carryOver({ key: fx.key })
  eq('⑨ 没配摘要器：状态 kept', r.status, 'kept')
  eq('⑨ 没配摘要器：原因是 no-summarizer', r.reason, 'no-summarizer')
  eq('⑨ 没配摘要器：轨迹一条没删', existsSync(fx.sessionDir), true)
}

// ⑩ 真 zstd 轨迹走完整条路（证明不是只能吃测试用的明文假货）
section('7⑩ 真 zstd 轨迹')
if (typeof zstdCompressSync === 'function') {
  const fx = fixture('realzstd', { body: '' })
  writeFileSync(join(fx.sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(longBody('真压缩的轨迹也要能摘要'), 'utf8')))
  const { engine, calls } = engineOf(fx)
  const r = await engine.carryOver({ key: fx.key })
  eq('⑩ 真 zstd：状态 done', r.status, 'done')
  eq('⑩ 真 zstd：轨迹删了', existsSync(fx.sessionDir), false)
  ok('⑩ 真 zstd：正文真的解出来了', calls[0].includes('真压缩的轨迹也要能摘要'))

  // 投影缓存也要顺手清掉，不然会留下孤儿 json
  const fx2 = fixture('projcache', { body: longBody() })
  mkdirSync(fx2.projCacheRoot, { recursive: true })
  writeFileSync(join(fx2.projCacheRoot, `${fx2.sessionId}.json`), '{}')
  const { engine: e2 } = engineOf(fx2)
  const r2 = await e2.carryOver({ key: fx2.key })
  eq('⑩ 投影缓存也清了', r2.deletedCache, true)
  eq('⑩ 缓存文件真没了', existsSync(join(fx2.projCacheRoot, `${fx2.sessionId}.json`)), false)
}

// ⑪ status：只读体检（工具靠它，不能有任何副作用）
section('7⑪ status 只读体检')
{
  const fx = fixture('status', { body: longBody() })
  const { engine, calls } = engineOf(fx)
  const before = engine.status()
  eq('⑪ 账本里能看到这条通道', before.length, 1)
  eq('⑪ 还没交接', before[0].carried, false)
  eq('⑪ 找得到轨迹目录', before[0].sessionDir, fx.sessionDir)
  eq('⑪ 笔记还是 0 字', before[0].noteChars, 0)
  eq('⑪ 看一眼不花模型的钱', calls.length, 0)
  eq('⑪ 看一眼不动磁盘', existsSync(fx.sessionDir), true)
  await engine.carryOver({ key: fx.key })
  const after = engine.status()
  eq('⑪ 交接完标记成已交接', after[0].carried, true)
  ok('⑪ 交接完看得到笔记字数和时间', after[0].noteChars > 0 && /^\d{4}-\d{2}-\d{2}/.test(after[0].noteAt))
  eq('⑪ 轨迹没了也能报出来', after[0].sessionDir, '')
}

// ⑫ 一条通道一条笔记：串线是最难查的那种错
section('7⑫ 多通道不串线')
{
  const shared = join(ROOT, 'multi')
  const a = fixture('multi', { base: shared, key: 'group:demo', sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', body: longBody('A 群的事') })
  const b = fixture('multi', { base: shared, key: 'c2c:alice', sessionId: 'bbbbbbbb-0000-0000-0000-000000000002', body: longBody('跟 alice 私聊的事') })
  const ea = engineOf(a)
  const eb = engineOf(b)
  await ea.engine.carryOver({ key: a.key })
  await eb.engine.carryOver({ key: b.key })
  const noteA = readFileSync(ea.engine.noteFileOf('group:demo'), 'utf8')
  const noteB = readFileSync(eb.engine.noteFileOf('c2c:alice'), 'utf8')
  ok('⑫ A 的笔记里没有 B 的会话 id', !noteA.includes('bbbbbbbb'))
  ok('⑫ B 的笔记里没有 A 的会话 id', !noteB.includes('aaaaaaaa'))
  eq('⑫ 共用一份账本时两条通道都在', JSON.parse(readFileSync(ea.engine.sessionMapPath, 'utf8'))['c2c:alice'].carried.startsWith('bbbbbbbb'), true)
  eq('⑫ 笔记目录里正好两个文件（一条通道一份）', readdirSync(ea.engine.notesDir).length, 2)
  eq('⑫ 会话 id → 通道 key 反查得到', ea.engine.keyOfSession(a.sessionId), 'group:demo')
  eq('⑫ 反查不存在的 id → 空', ea.engine.keyOfSession('nope'), '')
  eq('⑫ A 的账本里 B 那条也记着', ea.engine.status().length, 2)
}

rmSync(ROOT, { recursive: true, force: true })

report('✅ 全过')
