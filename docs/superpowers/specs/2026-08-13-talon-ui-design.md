# talon-ui 设计文档

> 目标:为 DeepSeek Harness(dsh)设计并实现一套基于 dsh plugin 的终端 UI,名为 **talon-ui**。核心功能与可靠性不低于 Codex TUI;UI 样式与 Codex 明确区分,简洁美;交互与操控以当前 TUI 最佳实践为准绳。
>
> 证据基础:[《Codex 与 dsh 架构分析》](../../../../docs/codex-and-dsh-architecture.md)、[《dsh TUI 模块规划》](../../../../docs/dsh-tui-module-plan.md),加四路并行深度考古(2026-08-14 完成,125 万 token 阅读量):被删除的 `@deepseek-ai/dsh-tui` 全源码(commit `7248b5ec`,84 文件逐行)、pi-tui 0.84.1 完整 API 面(README + 全部 .d.ts + 关键 .js)、dsh 当前服务接口精确签名(current main)、旧测试基础设施与全部 ~45 篇 Agent Notes。下文所有签名/行为均以该考古为据,非推测。

## 0. 结论先行

- **进程模型**:同进程 Cordis 插件,直连 `packages/core` 服务。旧 TUI 验证过三周的路径,规划文档的明确建议(选项 A)。
- **渲染范式**:**内联主屏流(pi-tui `TuiMainScreen`)**——已提交内容进入终端原生 scrollback、永不重绘;这是 Codex 大会话流畅的根本机制,也是当前一代 coding-agent TUI 收敛出的形态。样式差异化靠视觉语言(§4),不靠范式。
- **框架**:`@earendil-works/pi-tui@0.84.x`。自带 Editor(多行/kill-ring/undo/自动补全/粘贴折叠)、Markdown(流式友好)、SelectList、overlay 栈、Kitty 键盘协议、CJK 宽度、OSC8 链接续行——相比 Codex 从零自研省掉整个编辑器与折行引擎。
- **范围**:v1 全量(M1 骨架→M2 富交互→M3 富渲染→M4 打磨),已拍板。
- **包边界**:独立仓库,npm 包 `talon-ui`(内含 `talon-boot` + `talon-ui` 两个 Cordis 插件),profile 名 `talon`。`dsh plugin --profile talon add <path|talon-ui>` 安装,`dsh --profile talon` 启动,**无需改 dsh 任何代码**(通用 add-a-bundle 流程,考古已验证机制)。
- **满足 dsh 复活前提**(删除记录原文四条):命名产品 ✓(talon-ui);独立包边界 ✓;具体交互 provider ✓——talon 将是 **dsh 历史上第一个真正的终端审批 UI**(考古证实旧 TUI 从未接线 approval,全部静默 fail-closed);组装级生命周期与转录验收 ✓(§7 测试策略)。

## 1. 决策记录

每条含备选、决定、依据。标 ⚡ 的是考古后新增/修正的决策。

### D1 进程模型:同进程 Cordis 插件
备选:A 同进程直连;B 走 Web 协议;C 扩展 sdk/protocol。**决定 A**。B 的 approval 路径官方标记缺口且绑死浏览器信任模型;C 无第二消费者无法验证。护栏:契约层(`backend/`)是唯一触碰 Cordis 的地方,UI 状态机只认内部 `AppEvent`,未来切协议只换翻译层。

### D2 渲染范式:内联主屏流
备选:内联(Codex/Claude Code);全屏 alt-buffer(旧 dsh TUI);混合。**决定内联**。人体工程学:终端原生滚动/搜索/复制全保留,SSH/tmux 可预期,异常退出后转录仍在 scrollback(不丢现场);性能:"已提交内容零重绘"只有内联能物理成立。旧 TUI 的"可复制转录"设计正是为补偿 alt-buffer 复制缺陷而生——内联天然免除。

### D3 框架:pi-tui 0.84.x,不 fork、不 patch(v1)
备选:pi-tui;ink(React 协调模型与零重绘原则冲突);自研(Codex 路线,4400 行编辑器)。**决定 pi-tui 0.84.x**。⚡考古修正:旧 TUI 对 0.80.7 的唯一 patch(borderless editor + prompt 前缀)**0.84.1 未上游化**——talon 改用**子类覆写 render()** 实现无边框输入(旧 TUI `HintEditor extends Editor` 先例验证过子类路线可行),避免 pnpm patch 维护负担;若覆写过脆,再退回 pnpm patch(346 行已知形状)。

### D4 ⚡包边界与依赖:本地链接开发,npm 滞后不可用
考古事实:npm 上 `@deepseek-ai/dsh-*` 为 0.0.1-rc.x,**显著落后**本地 monorepo 的 0.1.0-rc.5,且 dsh 预发布期无兼容承诺。**决定**:peerDependencies 声明 `@deepseek-ai/dsh-*`,开发与安装期一律用 `file:`/`pnpm add <本地路径>` 链接 `../deepseek-harness` 的包;npm 发布是 dsh 稳定后的事。engines: node >=22.19(pi-tui 与 dsh 的公共下限)。

### D5 键位:上下文持有路由,零全局模式变量
每个可交互组件持有自己的按键表(pi-tui `TUI_KEYBINDINGS` 注册表 + `KeybindingsManager` 已内建可重映射系统);v1 硬编码默认位,用户改键记 v2(成本已知很低)。全局输入监听器在**任何 overlay 激活时整体让路**(旧 TUI 验证的规则:对话框拥有 100% 键盘直到关闭)。所有功能可经斜杠命令到达;上下文键位提示常驻(dim)。

### D6 配色:照抄验证过的 paletteSpec 单表,品牌色换 talon 青
⚡考古取回精确 SGR 表,**整表照抄**(8 色role + 5 属性role,全 ANSI-16):`text`=零转义(继承终端前景)、`dim`='2;39'(刻意不用亮黑——浅色主题下亮黑常比正文重)、`accent`='95'、`code`=浅色'34'/深色'36'(唯一分 scheme 的 role)、`success/warning/error`='32/33/31'。真彩色唯二例外:启动 wordmark 渐变与 `brand` 文本——换成 **talon 青**(`#2DD4BF→#14B8A6→#0D9488` 三段渐变,ANSI 降级 36)。支持 `NO_COLOR`。`/palette` 命令自打印同一张表(结构上保证文档永不漂移)。

### D7 可靠性验收线(可测定义)
1. **终端恢复全路径**:正常退出 / Ctrl+C(raw mode 下是 0x03 字节非信号)/ 外部 SIGTERM·SIGHUP(旧 TUI 的缺口,talon 补上)/ unhandledRejection + uncaughtException(failLoud:先 dispose 恢复终端再退出,2s 超时兜底)。根 dispose 带 5s 硬超时(`disposeRootAndExit` 模式)。
2. **无闪烁**:pi-tui CSI 2026 同步输出 + 16ms 节流 + 行级差分,键盘输入走 `requestImmediateRender` 抢占。
3. **大会话性能**:参照系=旧 TUI 修复后实测(196k 事件:恢复 7.2s、按键回显 17ms)。talon 指标:100k 事件按键回显 <33ms、恢复提示可用 <8s;靠 §5 的两条已验证模式 + 挂载上限保底。
4. **审批安全**:fail-closed(服务本身保证)、FIFO 串行、选项动态渲染、请求 signal 中止时面板自动收回。
5. **输入不丢失**:流式期间键入零丢失;bracketed paste 完整(pi-tui 大粘贴折叠标记内建)。
6. **内存有界**:工具输出预览行数有界(maxToolOutputLines=6 起步),diff 超界走近似渲染(maxDiffEditLength=1000 + `approximate` 标记,防 Myers diff 阻塞渲染线程——旧 TUI 验证)。
7. **恢复正确**:进程内 resume(D8),preflight 双次 idle 校验 + provider 可用性校验(照抄旧模式)。
8. **不可信文本中和**:`displayText()` 在显示边界把 C0/C1(除 \n)转义为可见 `\xNN`,覆盖模型文本/工具输出/标题/问题元数据/启动失败信息(旧 TUI commit `b5e8e4e9c1` 全套照抄,三层测试钉死)。
9. 每条验收线均有语义快照或单元测试(§7)。

### D8 ⚡Resume:进程内切换,不做 execve
考古事实:旧 TUI 的 execve 接管在**已删除的启动器**(apps/cli/src/tui.ts)里,TUI 包只定义 `handoff()` 契约;talon 用通用 `dsh --profile talon` 启动,没有自定义启动器可托管 execve。**决定**:`ctx.agents.resume({resumeSessionId})` 进程内恢复——preflight(照抄:双 idle 校验、重读记录、`resumeRoute` provider 校验)→ `process.chdir(目标 cwd)`(先于任何拆卸,失败时终端还在)→ dispose 旧 agent 绑定 → resume → 转录从会话事件重建。跨 cwd 提示照旧。execve 换进程记 v2(需要自定义启动器时再做)。

### D9 ⚡审批 UI 是全新工作(dsh 第一个终端审批 provider)
考古证实:全库唯一 production 应答者是 ACP bridge;旧 TUI 零接线,一切工具升权静默 fail-closed。talon 实现:`ctx.on('approval/request', (req, next) => ...)` 通过 agent 归属过滤(对象同一性判定,非本 agent 的请求 `next()` 放行——照抄 ACP 模式),渲染进面板体系,用户选择即 resolve。审批与提问**保持两个独立机制**(dsh 的明确决策:封闭结果集/强制 fail-closed/审计事件 vs 自由问答——不合并)。

### D10 ⚡转录挂载上限(应对 pi-tui full-redraw 的 `\x1b[3J`)
考古发现:TuiMainScreen 的 full redraw(宽度变化必触发)会 `\x1b[3J` **清空整个终端 scrollback(含会话前 shell 历史)**并重写全文档,成本 O(全转录)。**决定**:①转录挂载行数上限(默认 ~5000 行,可配),超限从头部卸载并挂 `… earlier history not shown …` dim 标记(会话日志完整,resize 后损失与 Codex resize_reflow_cap 同类、有先例);②`setClearOnShrink(false)`——收缩用常规差分清尾行,杜绝面板关闭等收缩场景意外触发 full redraw;③已提交组件严格不可变,杜绝"改到视口上方"触发路径;④开发期 `PI_DEBUG_REDRAW=1` 监控意外 full redraw,快照测试断言常规交互零 full redraw。

### D11 ⚡流式渲染:沿用验证过的"每 chunk 重建 + 缓存承重"基线
旧 TUI 无任何节流:每个 `assistant/chunk` 同步 rebuild 流式组件 + requestRender,可行的前提是两条铁律(§5)让已定稿内容全部走缓存,pi-tui 行差分只发变化行。196k 实测无闪烁。**决定**:v1 照抄该基线(pi-tui 0.84 的 `trimPartialClosingFences` 已内建处理未闭合代码围栏抖动);块级提交优化仅在 T3 压测显示需要时上。

### D12 结构化卡片全量渲染(超越旧 TUI 与 Codex 的免费升级)
考古发现:presentation.ts 六类结果卡中 `read/search/web` 三类**旧 TUI 从未专门渲染**(数据早就有:行号读取/按文件分组匹配/来源引用)。talon 全部渲染(§4.4)——这是最大的一块"数据白送、只差渲染层"的体验升级。

### D13 XML 兜底:真解析器或明确拒绝,永不正则
未注册工具输出走 `renderUnknownXml`(saxes 真解析器;11 类畸形输入显式拒绝回退纯文本);注入上下文(`<system-reminder>` 类提示语)**永不当 XML 解析**——只剥精确包裹行,内文原样(两条规则都是 dsh 留下的明文教训)。

## 2. 系统架构

```
┌─ dsh 进程(dsh --profile talon)──────────────────────────────────┐
│  @deepseek-ai/dsh-base(9 个所需服务全部由它提供,考古验证)         │
│                    ▲ Cordis inject                               │
│  ┌─ talon-ui 包 ───┴────────────────────────────────────────┐    │
│  │ plugins:                                                  │    │
│  │  talon-boot   创建根 agent(cwd=process.cwd, sessionId 配置) │    │
│  │  talon-ui     等待 agent/created 后挂载 UI(不创建 agent)    │    │
│  │ src/backend/  契约层(唯一触碰 ctx.* 的地方)                │    │
│  │  events.ts    session/event + agent/* → AppEvent 翻译       │    │
│  │  approval.ts  approval/request waterfall 应答者(D9)        │    │
│  │  questions.ts userQuestions.registerProvider 提供者          │    │
│  │  commands.ts  ctx.commands 注册(agent 作用域)+ 执行         │    │
│  │  sessions.ts  sessionQuery 列表 / 标题阶梯 / 进程内 resume    │    │
│  │  model.ts     listModels + installModelSelection ref         │    │
│  │  metrics.ts   tokenUsage/contextPressure 投影读取            │    │
│  │ src/app/      AppEvent 总线 + 控制器(*Deps 显式依赖模式)    │    │
│  │ src/ui/       pi-tui 组件树(TuiMainScreen)                 │    │
│  │  transcript/  已提交单元(持久组件+宽度缓存,不可变)          │    │
│  │  live/        流式尾部(StreamingAssistant + 运行中卡片)     │    │
│  │  composer/    无边框 Editor 子类 + 状态线 + 提示线            │    │
│  │  panels/      审批/提问/选择器(inline 底部锚定,FIFO)       │    │
│  │  theme/       paletteSpec 单表 + displayText 中和            │    │
│  │ cordis.patch.yml  插入 talon-boot/talon-ui/                  │    │
│  │                   session-projection-cache(不在 dsh-base)   │    │
│  │ package.json  {"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}   │
│  └───────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

数据流单向:Cordis 事件 → `backend/events.ts` 翻译 → `AppEvent` 总线 → 控制器改状态 → 组件树增量渲染;用户输入 → 焦点组件按键表 → 控制器 → 契约层方法。异步结果一律经总线回流。

控制器遵循旧 TUI 重构后的显式依赖模式:稳定值协作者构造时解构一次;回调协作者(`appendNotice`/`requestRender`/`isDisposed`)留在 `deps` 对象上每次调用取当前实现(明文否决过"自由函数 + 共享可变上下文"方案)。状态动画(运行 glyph 渐隐/呼吸)刻意**不**抽控制器,与其读者同居(dsh 的原话:抽出去是"leaky seam for little gain")。

## 3. 契约层(考古取回的精确签名)

### 3.1 inject 与服务对照

```ts
export const name = 'talon-ui'
export const inject = ['agents','sessions','commands','userQuestions','approval',
                       'tools','llm','systemPrompt','tokenMeter']
```

⚡旧 TUI 的 `userInteraction` 已拆分为 `userQuestions`(单 provider 注册制)+ `approval`(waterfall 事件制);`tuiPrompt` 是旧包自有服务,不存在于外部。9 个服务全部由 dsh-base 单独提供。可选服务(`ctx.get()` 容忍缺席,不进 inject):`settings`、`skills`、`sessionPersistence`、`sessionQuery`、`sessionProjections`、`sessionProjectionCache`、`sessionReferences`、`subagents`、`goals`、`planMode`。

### 3.2 事件订阅(UI 的两路官方配对)

dsh agent-loop README 明文:UI = `session/event`(流/边界/工具活动)+ `agent/*` 控制事件。

- `agent.ctx.on('session/event', (session, event) => ...)`(agent 作用域自动过滤)。需处理的核心 SessionEventMap:`turn/start{turn}`、`turn/end{turn, reason}`(reason 联合:completed/aborted/blocked/error/max-tokens/interrupted + 插件扩展——**穷尽 switch + 具名默认分支**,未知 kind 打印 `Turn ended: <kind>.`,旧 TUI 教训)、`step/start`、`step/end`、`user/message`、`assistant/chunk{chunk: StreamChunk}`、`assistant/message{message, usage?}`、`tool/call{callId,name,arguments}`、`tool/result{message,error?}`、`todo/write{todos}`、`llm/retry`、`llm/retry-started`、`approval/asked|decided|policy`(转录审计行)、`session/title`、compaction 事件族。共 40 个已知类型,未识别的跳过。
- `StreamChunk` 联合(流式必须 switch):`block-start{index,blockType}` / `text-delta{index,text}` / `reasoning-delta{index,text}` / `tool-call-delta{index,id,name?,argumentsDelta}` / `block-end{index,block}` / `usage{usage}` / `finish`。
- `agent/*`:`agent/created`(挂载触发)、`agent/status{status:'idle'|'running'}`、`agent/disposed`(置 disposed 标志,拒绝僵尸派发)、`agent/error`(按 `${turn}:${step}` 去重,防与 turn/end error 双报)、`agent/inbox/inserted|claimed|discarded`(steering 队列徽标——下限近似,非负地板,任何非 running 转换硬清零)。
- 注册表事件:`commands/change` → 重建斜杠补全;`llm/adapters-updated` → 重试模型解析(`NO_ADAPTER` 视为瞬态静默停靠,不报错——旧 TUI 记录的激活竞态);`skills/change`(若有)。

### 3.3 审批应答者(D9,全新)

```ts
ctx.on('approval/request', (req: ApprovalRequest, next) => {
  if (req.agent !== boundAgent) return next()          // 对象同一性归属过滤(ACP 模式)
  if (req.signal?.aborted) return 'cancelled'
  return panelQueue.enqueueApproval(req)               // Promise<ApprovalOutcome>
})
```

`ApprovalRequest = {agent, toolName, callId?, reason?, signal?}`;`ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`。服务侧保证:policy 'never' 在监听器之前决断;无应答/异常归一为 'unavailable'(fail-closed)。面板尊重 `req.signal` 中止自动收回并返 'cancelled'。审计行由 `approval/asked|decided` durable 事件驱动渲染(resume 后依然完整)。

### 3.4 提问提供者

```ts
const unregister = ctx.userQuestions.registerProvider({
  ask: (request: AskUserQuestionRequest) => panelQueue.enqueueQuestions(request),
})
```

`AskUserQuestionItem{id,question,detail?,header?,options?,multiSelect?,intent?}`;`intent {kind:'plan-review',approve}` 渲染成计划审阅面板(approve 名字的选项高亮为主操作),不识别的 intent 回退通用列表(wire 形状不变)。DUPLICATE_PROVIDER 异常=组合错误,fail loud。teardown 时 `rejectAll()` 排空。

### 3.5 命令

TUI 自有命令经 `agent.ctx.inject(['commands'], c => c.commands.register(...))` 注册为 agent 作用域。v1 命令集:`/help /model /clear /details /palette /resume /status /agents /exit /quit`(exit/quit 同一 handler 别名)。执行:`ctx.commands.execute(agent, line, signal)`,每次调用独立 AbortController 入集合、teardown 全体 abort;`undefined` 返回渲染 "Unknown command"。`CommandResult = {kind:'success',text?}|{kind:'error',text}`。

### 3.6 会话列表与 resume

- 列表:`ctx.sessionQuery.listSessions()` → `SessionRecord{header:{id,createdAt,cwd?,...}, live, persisted}`(newest-first)。**无内建 preview 字段**——预览自行从标题阶梯推导。
- 标题三级阶梯(照抄):live 会话 `sessionProjections.snapshot(live).values.title` → `sessionProjectionCache.cachedSnapshot(header)`(零 I/O)→ `coldSnapshot(id)`(尾部回放,写回缓存);无缓存服务则批量 `readTitleSnapshots(ids)`。活动时间戳=元数据(live 尾事件时间 / 持久化文件 mtime),**永不为列表读全日志**。并发上限走配置(默认 4,手写 worker-pool)。
- resume:`ctx.agents.resume({resumeSessionId})`(要求 sessionPersistence + agent-loop factory 在场)。preflight 全抄(§1 D8)。
- 选择器:当前工作区默认 scope,Tab 切 all-workspaces;禁用三态(当前会话/本运行时已 live/无 cwd 记录),工作区不匹配是 scope 不是禁用。

### 3.7 /model

`readModelChoices` 照抄:`listProviders() × listModels() × resolveModelInfo()` 拍平,**当前 target 即使不在目录也追加**(手工设置的模型不消失于自己的选择器)。切换:`installModelSelection(agent.ctx, ref)` 一次安装,此后改 `ref.current = {provider, model, reasoningEffort}` 即于下一 step 生效。reasoningEffort 从 `resolveModelInfo().reasoning.efforts` 动态取,永不硬编码。Shift+Tab 循环高亮行的 effort(旧交互保留)。

### 3.8 指标

- 累计用量:`tokenUsage` 投影 `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`。
- KV 命中率(UI 计算):`cacheRead/(uncached+cacheRead+cacheWrite)`,**无计费输入前显示省略而非 0%**("0% 徽标是对不存在值的撒谎"——原话保留)。
- 上下文占用:`tokenMeter.measure(session).totalTokens / resolveModelInfo(...).context.contextWindow`(明文警告:不要独信 `contextPressure.contextWindow`,模型切换后会滞后)。measure() 克隆整个 surface,**不逐键轮询**,事件驱动更新。
- token 计数替换不累加:按 `${turn}:${step}` 键,先减旧值再加新值(重放/重发安全)。

### 3.9 多任务可视化(T4)

- subagent:`ctx.subagents.listDescendants(rootId)` → 现成树条目(depth/label/activity/diagnostic);live `subagent/start|end`(parent 作用域)驱动 footer 徽标;`/agents` 列表 + 转录内 durable `tool-workflow/*` 事件渲染 workflow 运行卡。
- goal/todo/plan:`goal` 投影(Web GoalBar 同源)、`todos` 投影(standing-plan 语义:turn/start 清空)、`planMode.get()` + plan-review intent 面板(§3.4)。全部优先 durable 投影,live 事件只做实时增噪。

### 3.10 设置(可选)

`ctx.settings?.register(settingsNamespace('talon'), TalonSettingsSchema)` → `{get, watch, update}`;服务缺席回退纯 config。会话内改动(如 Ctrl+O 可见性)是短暂 UI 态,**永不落盘、永不进会话日志**(旧 TUI 铁律:TUI 态要么短暂要么严格派生自已记录事件)。

## 4. 视觉语言(与 Codex/Claude Code 的显式区分)

关键词:**锐、静、少**。零边框、零竖线装饰、零背景填充(考古教训:背景填充与终端主题冲突,已被旧 TUI 摘除;reverse-video 只用于列表选中行)。

| | Codex | Claude Code | talon-ui |
|---|---|---|---|
| 消息标记 | `▌` 竖线贴边 | `●` + `⎿` 树线 | **加粗下划线角色头,正文零装饰**(拖选复制永不带杂质) |
| 工具卡片 | 框线块 | 缩进树 | **`◇`运行中/`◆`完成 单行头 + 统一 dim 内文** |
| 输入区 | 圆角框 | 圆角框 | **单条状态横线 + `❯` 提示符**(无边框 Editor 子类,省 2 行) |
| 强调色 | 品红/紫 | 橙 | **talon 青**(truecolor 渐变;ANSI 层沿用验证过的表) |
| 运行指示 | 框内 spinner | spinner+文字 | **提示符原位 glyph 相变**(◌→◍→◉→⚙,呼吸渐隐,零额外行列) |

### 4.1 转录

```
You
Change the login button to the theme color.

talon
Looking at the current styles first.

◆ read src/pages/Login.tsx · 42 lines
◇ bash pnpm test
  └ running… esc to interrupt
◆ edit src/pages/Login.tsx · +3 −1

Button now uses theme.primary; tests pass.
```

- 角色头 `messageHeader` 原样:`bold(underline(color(label)))`,无背景、无行前缀。`You` 默认色 / `talon` accent / `Steering` 同 You。
- UI 文案英文,集中常量(未来 i18n 单点)。
- 压缩标记:dim `… earlier context was compacted …` 永久行,live 与 replay 路径字节一致;被遮蔽历史**保留在上方**(位置书签,非涂改)。live 压缩指示("Context being compacted Xs" + `⊙` glyph)**只由 live 事件驱动、永不从重放历史重建**(孤儿 start 是正常历史,不是进行中证据)。
- 重试:撤回失败流式组件(部分文本从转录消失)+ 黄色通知 `Retrying model request (n/limit) in Xms: <msg>`(∞ 表示 always 模式);成功恢复**无**专门通知;耗尽=普通 error turn-end。turn/end 各 reason 映射照抄,`aborted` → `Turn cancelled.`。

### 4.2 工具卡片(六类全渲染,D12)

统一骨架:**状态色只在头部一行**(pending=warning、成功=success、失败=error),内文统一 dim("一块 dim 内文衬一条着色头")。三态可见性 Ctrl+O:collapsed(头 + ≤6 行头尾折叠预览,`preview()` 单一折叠规则)→ expanded → hidden(整卡消失;隐藏模式下多 step turn 折叠为单个 Assistant 头,tool-only step 零输出——旧 TUI 的折叠修复照抄)。失败卡强制 expanded。头部格式 `◇/◆ <name> · <关键参数>`(bash 附一段描述;刻意不加粗名字——SGR-1 在部分终端显示为变色)。

- **terminal**:`$ <command>` + cwd 前导,dim 输出,`[exit N]`/`[signal S]` 结构化尾徽(presenter 已剥模型侧标记,UI 渲染一次)。
- **diff**:每文件 bold 路径头(单文件且标题已含路径时抑制——旧修复);**行号列**(diffLines 遍历时双计数器现算,dim)+ `+`绿/`−`红/上下文 dim 两空格缩进;>maxEditLength 整侧近似渲染 + `[exact line diff omitted: >N changed lines]`;摘要 `└ +a −r · n file(s)[ · approximate]`;渲染结果按 view 对象同一性缓存。
- **read**(新):`path:offset` 头 + 行号列源码摘录(≤6 行折叠),`lang` 提示接高亮。
- **search**(新):按文件分组,`path` 行 + `  L42: match text` 缩进匹配行;paths 形态列路径;`truncated/total` 尾注。
- **web**(新):search=来源列表(title + dim url,OSC8 超链);fetch=`url · HTTP 200` 单行。
- **generic**:content 走共享 Markdown 主题渲染后再截断(截可见行不截源行——旧修复);原始 arguments 保持字面。
- **未注册工具**:saxes XML 树渲染或显式拒绝回退纯文本(D13)。

### 4.3 底部实时区

```
────────────────────────────────────────────────
❯ type a message…
  enter send · shift+enter newline · / commands · @ files
~/proj/app · main · deepseek-chat · cache 87% · 62% ctx        ⏳ 2 queued
```

- 状态横线=状态指示:空闲 dim / 流式 accent / 等待审批 warning。
- `❯` 提示符原位相变:运行时被阶段 glyph 替换(◌ model wait → ◍ thinking → ◉ responding → ⚙ tools;⊙ compacting),300ms 线性渐隐包络 × 1400ms 余弦呼吸,dim 灰而非 accent 色,opacity<0.12 截断不渲染(真渐隐不闪烁);非 truecolor 退化为包络门控稳定 glyph。50ms 单定时器仅活跃时运行(空闲零 CPU——pi-tui 按需调度考古验证)。
- footer=prompt 行左右分栏模板(`${cwd}${git}${model}${cache}${context}` / `${queued}`),缺席值连同邻接分隔符一起消失(whitespace-collapse 技巧照抄);窄屏先截左侧。↑↓ 计数含义:↑严格未缓存输入,cache% 独立段。
- 提示线上下文敏感;检测不到 Shift+Enter 能力时文案换 `\⏎ newline`(pi-tui 的反斜杠回车逃生门内建)。

### 4.4 面板(inline 底部锚定,非浮窗)

旧 TUI 的 QuestionDialog 正是 inline 布局(转录与编辑器之间),验证过。talon 全部面板走同一体系:`PanelManager` 单活跃 + FIFO 队列,`GuardedPanelComponent` try/catch 包裹(插件面板抛异常只关自己的面板,队列继续),owner fiber 效应绑定(调用方插件卸载即强关,`closeWith('owner-disposed')`)。面板激活期间全局键位让路、composer 失焦。

```
─ approval ─────────────────────────────────────
◇ bash · rm -rf node_modules && pnpm install
  ~/proj/app · sandbox: no network
  [1] allow once   [2] reject   esc cancel
```

- 审批:动态选项编号直达 + 方向键;决定后转录追加审计行(durable 事件驱动)。
- 提问:`Question 2/5 (3 unanswered)` 队列计数;options/custom 双模式(Tab/'c' 切换,custom Esc 回 options);Space 多选;两级分页(向后先翻超长选中项、向前先翻头部——旧对话框的分页优先级设计照抄);校验错误就地显示。
- 选择器(model/resume/details):SelectList + 模糊过滤,Esc 先清过滤再关闭;`/details` Tab 即改即用(背后转录就是实时预览)。
- 扩展面:`ctx.talon.openPanel()` 唯一扩展原语,冻结 host(viewport/theme/displayText/redraw/close/signal),**永不暴露 pi-tui 原始对象**(dsh 明文否决过;"最小原语先行,真实消费者出现再定下一个 seam")。

## 5. 性能铁律(196k 事件事故的两条修复模式,写进架构)

1. **render(width) 内零构造**:任何卡片组件禁止在 render 体内 new Text/Markdown/做折行——持久子组件 + 显式宽度键控行缓存(pi-tui 上游自己的约定),每个状态突变器负责失效缓存。谁忘了失效谁显示陈旧行:该契约用测试钉死(引用同一性断言 `.toBe`,照抄 transcript-card-cache.spec 的三条)。
2. **单向扫描累加器**:任何"逐转录项 × 全日志"的派生计算(step 计时、token 汇总)必须一个挂载共享一个前向游标累加器(StepTimingTracker 模式:`scanned` 游标只前进,step/end 后同坐标事件忽略,增量=全量重放等价性入测试)。
3. 流式组件 Map<index,Block> 累积,`assistant/message` 以**权威内容整体替换**(settle),不信累积缓冲;settle 后组件常驻转录,只有 turn/end 清引用、失败重试显式撤回。
4. 挂载上限 + clearOnShrink(false)(D10)。
5. 初始渲染预算:恢复大会话时 pi-tui 一次性布局是主项(196k 实测 ~4s,线性)——挂载上限直接把它变成 O(cap)。

## 6. 键位表(v1)

| 上下文 | 键 | 行为 |
|---|---|---|
| 全局(无面板时) | Ctrl+C | 三分支:运行中→取消 turn;编辑器非空→清空;否则→请求退出(取消后等 idle 再退,不硬杀) |
| 全局 | Esc | 运行中→取消 turn;否则落给焦点组件(补全菜单/多行清理) |
| 全局 | Ctrl+O | 工具卡三态循环 |
| 全局 | Ctrl+R | 推理块显隐 |
| 全局 | Ctrl+L | 强制全重绘 |
| composer | Enter / Shift+Enter(Ctrl+J、`\⏎` 兜底) | 发送 / 换行 |
| composer | ↑↓ | 历史(pi-tui 内建 100 条)/ 多行内移动 |
| composer | Tab | 补全接受 / 文件补全触发 |
| composer | Ctrl+D | 空输入退出;运行中提示先取消 |
| 面板 | ↑↓·数字·Enter·Space·Esc·Tab | 见 §4.4 各面板 |

面板激活=全局表整体挂起(第一行判断)。`/cancel` 类冗余命令不设(与 Esc 重复的 affordance 已被 dsh 明文移除过)。

## 7. 测试策略(照抄验证过的四层)

1. **语义终端快照**(主力,T0 建基座):`HeadlessTerminal implements Terminal`(pi-tui 精确接口)包 `@xterm/headless`;以 `\x1b[?2026l` 帧结束标记计帧,`waitForFrame` 2s 超时——**永不快照写入中前缀**。快照序列化语义状态(尺寸/生命周期计数/标题/光标/非空行文本 + 独立 style 运行段),文本与样式分开报告。`themeViolations()` 内嵌于每个 checkpoint 助手(truecolor/扩展色/显式背景全标violation;唯一豁免=品牌渐变且必须全部是 rgb-fg)——不变量长在快照助手里,不靠自觉。封闭清单 afterAll(const 数组 = 观察到的 checkpoint = 磁盘 .expected.txt 文件集,三方相等)。`vi.spyOn(Date,'now')` 冻结一切计时文案;footer 断言 cwd 固定 `/workspace`(检出深度不许影响断言——旧修复)。
2. **单元测试**:契约层独立于 UI(FakeAgent 记录 sent/steered/cancelled);审批 fail-closed/FIFO/signal 中止/归属过滤逐条;性能契约(缓存同一性、tracker 增量等价);穷尽 turn-end reason。
3. **录制会话真实回放**(组装级验收,dsh 复活前提第四条):`session.jsonl` 场景 + 子会话日志 + terminal.expected.txt;`dsh-llm-replay` 是**唯一** mock 边界,agent loop/工具/presenter/TUI 全部生产代码真跑;硬拒绝断言(工具序列不符/结果错误/turn 错误/生命周期不完整即败——防"截图好看路径已断")。`DSH_SNAPSHOT=record|refresh|replay` 三模式。
4. **PTY 冒烟**(仅限 TUI 自身——dsh 站规:PTY 只许用于 TUI,其余一律管道):真 Loader + 真终端起停,raw mode 接管/恢复是管道结构上无法证明的唯一事项。Windows 腿 node-pty/ConPTY,POSIX 腿 Python pty,同一断言集。

工程配置:独立仓库自带 vitest 配置(考古确认 dsh 根 config 已无 packages/*/tests/*.snapshot.ts glob,不能白搭车);coverage 对齐 dsh:v8 per-file 100% on src/,不可达行 `/* v8 ignore next -- 原因 */` 带因注释;tsconfig strict;`.expected.txt` 命名(当前约定)。

## 8. 里程碑(全量范围,每阶段可运行可演示)

| 阶段 | 内容 | 验收 |
|---|---|---|
| T0 骨架 | 仓库脚手架(pnpm/tsc strict/vitest/HeadlessTerminal 快照基座)、talon-boot + talon-ui 插件、bundle manifest、`dsh plugin --profile talon add` 打通、TTY fail-loud、退出全路径 | 启动进 UI 干净退出;终端恢复全路径(含 SIGTERM/failLoud)测试通过;快照基座跑通首个 checkpoint |
| T1 核心回路 | 契约层 events/AppEvent 总线、转录(角色头+纯文本流式+settle)、无边框 composer、状态线、Ctrl+C/Esc/Ctrl+D | 发消息→流式→退出;100k 行注入压测达标(D7.3);PI_DEBUG_REDRAW 常规交互零 full-redraw |
| T2 富交互 | PanelManager FIFO+Guarded、审批应答者(D9)、提问提供者(含 plan-review)、斜杠命令集、resume 选择器+进程内恢复、退出摘要行 | 审批一次危险命令(dsh 首次!)、答一次多选提问、跨工作区恢复一个会话;fail-closed/中止/归属过滤测试绿 |
| T3 富渲染 | Markdown 流式+语法高亮(highlight.js→ANSI-16 单例引擎,markdown/diff/terminal 三消费者共享)、六类工具卡(D12)、diff 行号、paletteSpec+/palette、footer 指标+glyph 动画、压缩/重试可视化 | 真实编码会话录制回放全绿;所有卡片类型有快照;untrusted-controls 对抗快照绿 |
| T4 打磨 | /model 选择器、@file(WorkspaceFileSearch 照抄:有界 BFS/tool-result 失效/引号语法/控制符防御)+@session 补全、OSC9 通知+OSC0 标题(标题清洗)、剪贴板+图片粘贴(insertTextAtCursor 标记 + dsh attachment)、/agents+workflow 卡、设置持久化、Windows 通过 | 全功能面逐项勾验;Windows 快照稳定(跨盘 cwd 处理照抄) |

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| pi-tui full-redraw 清 scrollback(\x1b[3J) | D10 四件套;残余暴露面=真实 resize(有界于挂载上限,与 Codex reflow-cap 同类损失);记录为已知行为,可后续上游 PR |
| 面板/overlay 关闭触发意外 full-redraw | setClearOnShrink(false) + T1 即用 PI_DEBUG_REDRAW 快照断言钉死 |
| 无边框 Editor 子类覆写脆弱 | 先例(HintEditor);失败退路=重建 346 行已知 pnpm patch |
| Shift+Enter 终端差异 | pi-tui 三重兜底内建(kitty 协议/原生修饰键探测 mac·win/反斜杠回车);Linux 原生探测缺失→提示线自适应文案 |
| dsh 预发布接口漂移 | 契约层单点隔离;本地链接开发;dsh 每次破坏性变更只改 backend/ |
| 大会话初始布局 O(n) | 挂载上限封顶;恢复>上限时头部标记 |
| 全量范围工期 | 里程碑严格可演示递进;T4 各项独立可并行 |

## 10. 非目标(v1)

用户改键系统(pi-tui 机制已在,v2 低成本)、vim 模式、execve 换进程 resume、多会话标签页、转录内联图片显示、`.gitignore` 感知文件补全、独立协议(选项 C)、主题选择器(单表方案的反面)。
