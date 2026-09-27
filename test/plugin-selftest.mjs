/**
 * 插件入口的自检 —— **不需要 dsh**：拿一个假 ctx 把 `apply()` 跑起来，再把注册出来的工具一个个真调一遍。
 *
 * 测的是接线（工具注册了没、schema 是 dsh 认的那个方言不、新会话会不会真的带上笔记），
 * 不是交接逻辑本身（那个归 test/selftest.mjs）。所以这里故意用**假轨迹 + 假摘要器**：
 * 一次模型调用都没有，一秒内跑完，但删/不删都是真的发生在临时目录里。
 *
 *   node test/plugin-selftest.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, apply, expandHome, inject, mergeConfig, name as pluginName } from '../index.js'
import { projectKey } from '../src/carryover.js'

let pass = 0
const fails = []
let sectionName = '（开头）'
const sections = []
function section(name) {
  sectionName = name
  sections.push({ name, n: 0 })
}
const ok = (n, cond, extra) => {
  const cur = sections[sections.length - 1]
  if (cond) {
    pass++
    if (cur) cur.n++
  } else {
    fails.push(`[${sectionName}] ` + n + (extra ? '  → ' + extra : ''))
  }
}
const eq = (n, got, want) => ok(n, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)

/** 一行 ✅ 看不出测了什么，把每节过了几项打出来。 */
function report() {
  console.log('──── 分节小计 ────')
  for (const s of sections) if (s.n > 0) console.log(`  ${s.name}：${s.n} 项`)
  if (fails.length) {
    console.log(`\n❌ ${fails.length} 项没过（过 ${pass} 项）：`)
    for (const f of fails) console.log('  · ' + f)
    process.exit(1)
  }
  console.log(`\n✅ 全过：${pass} 项`)
}

const ROOT = mkdtempSync(join(tmpdir(), 'carryover-plugin-'))
const SESS = 'cccccccc-1111-2222-3333-444444444444'
const KEY = 'group:demo'

/** 假 dsh 会话树（跟 selftest 里那套同形）。 */
function scaffold(name) {
  const base = join(ROOT, name)
  const workspace = join(base, 'workspace')
  const sessionsRoot = join(base, 'sessions')
  const sessionDir = join(sessionsRoot, projectKey(workspace), SESS)
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(join(workspace, 'tmp'), { recursive: true })
  writeFileSync(join(workspace, 'tmp', 'session-map.json'), JSON.stringify({ [KEY]: { sessionId: SESS } }, null, 2))
  // 正文要够长：去空白后得超过 minDialogueChars（默认 40），否则会被判「太薄」直接清掉、不摘要。
  // 这里故意写满几句来回，就是为了走到「摘要 → 写笔记 → 删」那条真正的路上。
  const body = [
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'alice：把插件发出去吧，README 用中文写就行' }] } }),
    JSON.stringify({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好，今晚就发，先把自检补上' }] } } }),
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '记得先脱敏，真实昵称和本机路径都不能留' }] } }),
    JSON.stringify({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '记下了，示例数据一律用 alice/bob/group:demo' }] } } }),
    JSON.stringify({ type: 'system-reminder', data: { content: [{ type: 'text', text: '这条是系统注入的，不该进摘要' }] } }),
  ].join('\n')
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), body)
  return { base, workspace, sessionsRoot, sessionDir }
}

/** 假 ctx：把工具、服务、事件处理器都收下来，方便逐个验。 */
function fakeCtx() {
  const tools = new Map()
  const provided = {}
  const handlers = {}
  let current = SESS
  const ctx = {
    logger: { info: () => {} },
    tools: {
      register: (t) => {
        tools.set(t.name, t)
        return () => {}
      },
    },
    provide: (k, v) => {
      provided[k] = v
    },
    on: (ev, fn) => {
      ;(handlers[ev] ||= []).push(fn)
    },
    get: (k) => (k === 'agents' ? { currentInitiator: () => ({ id: current }) } : undefined),
    effect: () => {},
  }
  return { ctx, tools, provided, handlers, setCurrent: (id) => { current = id } }
}

const call = (tools, name_, args) => tools.get(name_).execute(args, {})

// ───────────────────────── 0. 身份与配置合并 ─────────────────────────
section('0. 身份与配置合并')

eq('插件名对', pluginName, 'dsh-carryover')
eq('要的能力对', JSON.stringify(inject), JSON.stringify(['tools', 'systemPrompt']))

{
  const merged = mergeConfig({ summary: { model: 'my-model' }, labels: { user: 'user' }, 乱塞的字段: 1 })
  eq('rawConfig 盖得住顶层', merged.maxInjectChars, DEFAULTS.maxInjectChars)
  eq('rawConfig 盖得住嵌套（summary.model）', merged.summary.model, 'my-model')
  eq('嵌套里没提到的字段不会被抹掉', merged.summary.maxTokens, DEFAULTS.summary.maxTokens)
  eq('labels 也是浅合并不是整段替换', merged.labels.assistant, DEFAULTS.labels.assistant)
  eq('不认识的字段照样传下去（宿主扩展用）', merged.乱塞的字段, 1)
  eq('不传 rawConfig 也不炸', mergeConfig().maxSummaryChars, DEFAULTS.maxSummaryChars)
}

{
  // `~/x`：YAML 给的是字面量，不展开就会变成「<cwd>/~/.dsh/sessions」这种永远不存在的目录
  eq('~ 展开成家目录', expandHome('~/.dsh/sessions'), join(homedir(), '.dsh/sessions'))
  eq('单独一个 ~ 也认', expandHome('~'), homedir())
  eq('绝对路径原样不动', expandHome('/var/lib/dsh'), '/var/lib/dsh')
  eq('空串不炸', expandHome(''), '')
  eq('undefined 不炸', expandHome(undefined), '')
}

// ───────────────────────── 1. 工具注册与 schema ─────────────────────────
section('1. 工具注册与 schema')

{
  const fx = scaffold('main')
  const { ctx, tools, provided, handlers } = fakeCtx()
  apply(ctx, {
    workspace: fx.workspace,
    sessionsRoot: fx.sessionsRoot,
    summarize: async () => '便条：今晚发插件，发之前先脱敏。',
  })

  ok('注册了 carryover_status', tools.has('carryover_status'))
  ok('注册了 carryover_note', tools.has('carryover_note'))
  ok('注册了 carryover_run', tools.has('carryover_run'))
  ok('暴露了 carryover 服务', Boolean(provided.carryover))
  ok('挂上了 system-prompt 注入钩子', (handlers['system-prompt/assemble'] || []).length === 1)
  ok('每个工具都有 description', [...tools.values()].every((t) => typeof t.description === 'string' && t.description.length > 10))
  ok('每个工具都有 output.schema', [...tools.values()].every((t) => t.output && t.output.schema))
  // dsh 只收 JSON Schema 的一个子集：required 必须是 object 上的字符串数组（写成 true 会被拒）
  ok(
    'required 全是字符串数组（dsh 的方言）',
    [...tools.values()].every((t) => {
      const req = [t.parameters, t.output.schema]
        .filter(Boolean)
        .map((s) => s.required)
        .filter((r) => r !== undefined)
      return req.every((r) => Array.isArray(r) && r.every((x) => typeof x === 'string'))
    }),
  )
  ok('每个工具都有 render', [...tools.values()].every((t) => typeof t.output.render === 'function'))
  eq('会删东西的那个别声明成并发安全', tools.get('carryover_run').isConcurrencySafe(), false)
  eq('只读的两个可以并发', tools.get('carryover_status').isConcurrencySafe(), true)
  eq('服务说得出笔记目录', provided.carryover.notesDir, join(fx.workspace, 'memory', 'carryover'))
  eq('服务认得配好的摘要器', provided.carryover.canSummarize(), true)
  eq('会话 id → 通道 key（注入就靠这条反查）', provided.carryover.keyOfSession(SESS), KEY)

  // ---- status：还没交接 ----
  const s1 = await call(tools, 'carryover_status', {})
  eq('status 列出 1 条通道', s1.count, 1)
  ok('status 说得出「还没交接」', s1.text.includes('还没交接') && s1.text.includes('group:demo'))
  ok('status 带出笔记目录', s1.text.includes(join(fx.workspace, 'memory', 'carryover')))
  const s2 = await call(tools, 'carryover_status', { key: 'nope' })
  eq('status 查不存在的通道 → 0 条不炸', s2.count, 0)

  // ---- note：还没有笔记 ----
  const n1 = await call(tools, 'carryover_note', {})
  eq('note 还没东西时 ok=false', n1.ok, false)
  ok('note 会告诉你笔记该在哪个文件', (n1.note || '').includes('group-demo.md'))

  // ---- run：peek 不花钱不动盘 ----
  const p1 = await call(tools, 'carryover_run', { mode: 'peek' })
  eq('peek 报「本该去摘要」', p1.reason, 'would-summarize')
  eq('peek 不删轨迹', existsSync(fx.sessionDir), true)
  eq('peek 也不写笔记', existsSync(join(fx.workspace, 'memory', 'carryover', 'group-demo.md')), false)

  // ---- run：dry 真摘要不写不删 ----
  const d1 = await call(tools, 'carryover_run', { mode: 'dry' })
  ok('dry 拿到了摘要长度', d1.summaryChars > 0, JSON.stringify(d1))
  eq('dry 不删轨迹', existsSync(fx.sessionDir), true)

  // ---- run：真交接 ----
  const r1 = await call(tools, 'carryover_run', {})
  eq('真交接：done', r1.status, 'done')
  eq('真交接：轨迹删了', r1.deleted, true)
  eq('真交接：目录真没了', existsSync(fx.sessionDir), false)
  const noteFile = join(fx.workspace, 'memory', 'carryover', 'group-demo.md')
  ok('真交接：笔记落在盘上', existsSync(noteFile) && readFileSync(noteFile, 'utf8').includes('先脱敏'))
  ok('真交接：笔记里记着会话 id', readFileSync(noteFile, 'utf8').includes(SESS))

  // ---- render：工具结果得是给模型读的一段话 ----
  // output schema 写的是 additionalProperties: false，多塞字段在严格校验下会被拒 ——
  // 所以返回值必须「不多不少，正好是声明过的那些」。这是接插件最容易翻车的地方。
  for (const [toolName, value] of [
    ['carryover_run', r1],
    ['carryover_status', s1],
    ['carryover_note', await call(tools, 'carryover_note', {})],
  ]) {
    const allowed = new Set(Object.keys(tools.get(toolName).output.schema.properties))
    ok(
      `${toolName} 的返回值不多不少，正好是 schema 里那些字段`,
      Object.keys(value).every((k) => allowed.has(k)),
      Object.keys(value).filter((k) => !allowed.has(k)).join(','),
    )
  }
  const rendered = tools.get('carryover_run').output.render({}, r1)
  eq('run 的 render 出文本块', rendered[0]?.type, 'text')
  ok('run 的 render 说清了「笔记存好、轨迹已删」', /存好/.test(rendered[0].text) && /已删/.test(rendered[0].text))
  ok('note 的 render 给的是笔记原文', tools.get('carryover_note').output.render({}, await call(tools, 'carryover_note', {})).some((b) => b.text.includes('先脱敏')))
  ok('status 的 render 给的是清单', tools.get('carryover_status').output.render({}, s1)[0].text.includes('交接账'))

  // ---- 重复交接：第二次不该再动手 ----
  const r2 = await call(tools, 'carryover_run', {})
  eq('第二次交接：already-carried', r2.reason, 'already-carried')

  // ---- status：交接完的状态 ----
  const s3 = await call(tools, 'carryover_status', {})
  ok('status 现在说「已交接」', s3.text.includes('已交接'))
  ok('status 报得出笔记字数', /笔记 \d+ 字/.test(s3.text))
}

// ───────────────────────── 2. 摘要失败：工具也不能删 ─────────────────────────
section('2. 摘要失败：工具也不能删')

{
  const fx = scaffold('sumfail')
  const { ctx, tools, provided } = fakeCtx()
  apply(ctx, {
    workspace: fx.workspace,
    sessionsRoot: fx.sessionsRoot,
    summarize: async () => {
      throw new Error('摘要接口 502')
    },
  })
  const r = await call(tools, 'carryover_run', {})
  eq('摘要抛错：状态 kept', r.status, 'kept')
  eq('摘要抛错：原因 summary-failed', r.reason, 'summary-failed')
  eq('摘要抛错：轨迹一条没删', existsSync(fx.sessionDir), true)
  const rendered = tools.get('carryover_run').output.render({}, r)
  ok('render 说清了「一条没删」', /没删/.test(rendered[0].text))
  ok('服务那条路也是同一个结果', (await provided.carryover.carryOver({ key: KEY })).status === 'kept')
}

// ───────────────────────── 3. 没配摘要器 / 传了坏参数 ─────────────────────────
section('3. 没配摘要器 / 传了坏参数')

{
  const fx = scaffold('nokey')
  const { ctx, tools } = fakeCtx()
  apply(ctx, { workspace: fx.workspace, sessionsRoot: fx.sessionsRoot, summary: { apiKey: '' } })
  const r = await call(tools, 'carryover_run', {})
  eq('没 key 又没注入摘要器：kept', r.status, 'kept')
  eq('没 key：原因是 no-summarizer', r.reason, 'no-summarizer')
  eq('没 key：轨迹留着', existsSync(fx.sessionDir), true)
  const nokey = await call(tools, 'carryover_run', {})
  ok('没 key 也不抛异常', nokey.status === 'kept')
}

{
  const fx = scaffold('badargs')
  const { ctx, tools, setCurrent } = fakeCtx()
  apply(ctx, { workspace: fx.workspace, sessionsRoot: fx.sessionsRoot, summarize: async () => '便条：这个会话定了今晚发插件。' })
  setCurrent('') // 认不出当前会话，工具又没给 key → 只能老实说不知道
  const r = await call(tools, 'carryover_run', {})
  eq('认不出通道又没给 key：不炸，说 no-key', r.reason, 'no-key')
  const n = await call(tools, 'carryover_note', undefined)
  eq('note 无参也不炸', n.ok, false)
  ok('note 会说清该怎么办', /carryover_status/.test(n.note || ''))
  const s = await call(tools, 'carryover_status', undefined)
  eq('status 无参也不炸', typeof s.count, 'number')
  // 显式给 key 也能走（宿主没维护映射时的活路）
  setCurrent('')
  const r2 = await call(tools, 'carryover_run', { key: KEY })
  ok('认不出当前会话时，显式给 key 依然能用', r2.status === 'done', JSON.stringify(r2))
}

// ───────────────────────── 4. 新会话自动带上笔记（注入钩子） ─────────────────────────
section('4. 新会话自动带上笔记（注入钩子）')

{
  const fx = scaffold('inject')
  const { ctx, tools, handlers, setCurrent } = fakeCtx()
  apply(ctx, { workspace: fx.workspace, sessionsRoot: fx.sessionsRoot, summarize: async () => '便条：上个会话定了今晚发插件。' })
  await call(tools, 'carryover_run', {})

  const hook = handlers['system-prompt/assemble'][0]
  const base = { contexts: [{ name: 'base', order: 0, text: '原本就有的东西' }] }
  const next = async () => base

  const out = await hook(base, {}, next)
  eq('注入之后 contexts 多了一段', out.contexts.length, 2)
  const seg = out.contexts.find((c) => c.name === 'carryover')
  ok('注入段的名字是 carryover', Boolean(seg))
  ok('注入的是这条通道的笔记', seg.text.includes('今晚发插件'))
  ok('注入段带着标题（模型一眼看懂这是什么）', seg.text.includes('# 上一个会话留下的笔记'))
  eq('原样的东西没被动过', out.contexts[0].text, '原本就有的东西')
  eq('注入段有自己的 order（不让它抢戏）', seg.order, DEFAULTS.injectOrder)

  // 认不出的会话 → 什么都不加（宁可少带，也不能把别人的笔记挂上来）
  setCurrent('another-session-id')
  const out2 = await hook(base, {}, next)
  eq('认不出当前会话 → 不加段', out2.contexts.length, 1)

  // 没有笔记的通道 → 也不加（不能挂一段空标题）
  const fx2 = scaffold('inject-empty')
  const second = fakeCtx()
  apply(second.ctx, { workspace: fx2.workspace, sessionsRoot: fx2.sessionsRoot, summarize: async () => 'x' })
  const hook2 = second.handlers['system-prompt/assemble'][0]
  eq('还没有笔记 → 不加段', (await hook2(base, {}, second.ctx.get('agents').currentInitiator() && next)).contexts.length, 1)

  // next() 炸了也不能把整轮带下水？—— 这里 next 抛，钩子应该让异常正常冒出去（不吞别人的错）
  let threw = false
  try {
    await hook(base, {}, async () => {
      throw new Error('下游组装失败')
    })
  } catch {
    threw = true
  }
  ok('next() 失败时不吞异常（那是别人的锅，不该我兜）', threw)
}

{
  // inject:false = 一个钩子都不挂（有人就想自己接管注入）
  const fx = scaffold('noinject')
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { workspace: fx.workspace, sessionsRoot: fx.sessionsRoot, inject: false, summarize: async () => 'x' })
  eq('关掉 inject 就不挂钩子', (handlers['system-prompt/assemble'] || []).length, 0)
}

// ───────────────────────── 5. 服务出口：宿主插件走这条路 ─────────────────────────
section('5. 服务出口：宿主插件走这条路')

{
  const fx = scaffold('service')
  const { ctx, provided } = fakeCtx()
  apply(ctx, { workspace: fx.workspace, sessionsRoot: fx.sessionsRoot, summarize: async () => '便条：宿主调的，今晚发插件。' })
  const svc = provided.carryover
  const st = svc.status()
  eq('服务 status 看得到待交接的会话', st[0].previousSessionId, SESS)
  const r = await svc.carryOver({ key: KEY, log: () => {} })
  eq('服务交接成功', r.status, 'done')
  ok('服务交接后读得到笔记', svc.readNote(KEY).includes('宿主调的'))
  eq('服务报得出笔记文件路径', svc.noteFileOf(KEY), join(fx.workspace, 'memory', 'carryover', 'group-demo.md'))
  eq('服务也认得出没交接过的重复调用', (await svc.carryOver({ key: KEY })).reason, 'already-carried')
}

// ───────────────────────── 6. 关掉总开关 = 什么都不做 ─────────────────────────
section('6. 关掉总开关 = 什么都不做')

{
  const fx = scaffold('disabled')
  const { ctx, tools } = fakeCtx()
  apply(ctx, { workspace: fx.workspace, sessionsRoot: fx.sessionsRoot, enabled: false, summarize: async () => '便条。' })
  const r = await call(tools, 'carryover_run', {})
  eq('关掉之后 run 不动手', r.reason, 'disabled')
  eq('关掉之后轨迹留着', existsSync(fx.sessionDir), true)
  const p = await call(tools, 'carryover_run', { mode: 'peek' })
  ok('关掉之后 peek 还能看（不看一眼怎么知道该不该开回来）', p.reason !== 'disabled')
}

rmSync(ROOT, { recursive: true, force: true })

report()
