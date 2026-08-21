# Talon

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)agent 的终端 UI,以 dsh **插件 bundle** 形式交付。Talon 在不改动 harness 检出的前提下,在终端里呈现完整的交互式会话——流式转录、工具审批、用户提问、斜杠命令、跨工作区会话恢复。

> English documentation: [README.md](README.md).

## 功能

- **流式转录** —— 角色头 + 纯文本正文(拖选即可复制原文),流式 markdown 定稿后进入缓存的已提交单元格,上下文注入卡片,常规交互零 `ESC[3J` 滚回区清屏。
- **审批面板** —— dsh 的第一个终端审批 UI。当工具请求提权(例如 bash 命令被沙箱拒绝后携带 `sandbox_permissions` 重试),内联面板展示工具名、命令预览、cwd 与理由。`1` 允许一次,`2` 拒绝,`Esc` 取消。每次决定都在转录里留下一行审计记录。
- **用户提问** —— 模型可通过 `ask_user_question`(已组合进 bundle)向你提问:单选、多选、自定义自由输入、多问题串行作答,plan-review 意图会高亮批准项渲染。
- **斜杠命令** —— `/help`、`/status`、`/resume`、`/clear`、`/exit`、`/quit`,`/` 触发模糊补全。命令结果从持久会话事件渲染,恢复会话时逐字节重放一致。
- **会话恢复** —— `/resume` 打开选择器(输入过滤,`Tab` 在「本工作区 / 全部工作区」间切换,ISO 时间戳,live/persisted 标记)。恢复是进程内重绑定:先切换工作目录(chdir-first),再从活动会话日志重放转录,恢复后的 agent 立即可以继续对话。
- **干净退出** —— `/exit`(或空闲空输入框下 `Ctrl+C` / `Ctrl+D`)恢复终端并打印告别行,注明会话 id:`To resume: dsh --profile talon, then /resume — session <id>`。

## 环境要求

- Node >= 22.19,pnpm
- `deepseek-harness` 检出,且与本仓库为**同级目录**
- 交互式终端(非 TTY 下 talon 会 fail-loud;自动化请用 `dsh --profile headless`)

## 安装

先构建 harness(talon 的 typecheck 与 profile 都从同级检出解析 dsh 包):

```bash
cd deepseek-harness && pnpm install && pnpm run build:lib:host
```

再构建 talon 并安装进 dsh profile:

```bash
cd ../talon-ui && pnpm install && pnpm build
cd ../deepseek-harness
pnpm dsh plugin --profile talon add link:../talon-ui
```

`dsh plugin` 会在 `$DSH_HOME/profiles/talon`(默认 `~/.dsh/profiles/talon`)播种 `@deepseek-ai/dsh-base`,并把 `talon-ui` 追加为 bundle 层。`link:` 协议装的是指向本仓库的真符号链接,之后改代码只需 `pnpm build`,无需重装 profile。细节(含卸载方法、为何用 `link:` 而非 `file:`)见 [docs/INSTALL.md](docs/INSTALL.md)。

## 使用

```bash
cd deepseek-harness
pnpm dsh --profile talon
```

### 按键

| 按键 | 场景 | 动作 |
|---|---|---|
| `Enter` | 输入中 | 发送 |
| `Shift+Enter` | 输入中 | 换行 |
| `Esc` | turn 运行中 | 中断 |
| `Ctrl+C` | turn 运行中 | 中断 |
| `Ctrl+C` | 空闲且输入框有内容 | 清空输入框 |
| `Ctrl+C` / `Ctrl+D` | 空闲且输入框为空 | 退出 |
| `Ctrl+L` | 任意时刻 | 强制整屏重绘 |

### 面板

- **审批**:`1` 允许一次 · `2` 拒绝 · 方向键移动高亮 · `Enter` 选中 · `Esc` 取消。
- **提问**:`↑`/`↓` 或 `1`–`9` 移动 · `Space` 勾选/取消(多选)· `Tab`(或 `c`)切自定义输入 · `Enter` 提交 · `Esc` 取消(自定义模式下先回选项)· `PgUp`/`PgDn` 翻长题头。
- **恢复**:输入过滤 · `↑`/`↓` 移动 · `Tab` 切「本工作区 / 全部工作区」· `Enter` 恢复 · `Esc` 先清过滤、再关闭。

### 上手示例

- 流式:`Explain what this repository does.`
- 提问:`Use ask_user_question to ask me a multi-select question with options Alpha, Bravo, Charlie.`
- 审批:`Run exactly: touch ~/talon-demo` —— 沙箱拒绝工作区外写入,模型请求提权,审批面板弹出。
- 恢复:`/exit` 退出后重新启动,`/resume` 选中会话——转录重放,agent 接着上次继续,换个工作目录也可以。

## 开发

```bash
pnpm test        # vitest,v8 覆盖率,src/ 每文件 100% 阈值
pnpm typecheck   # tsc strict,对着 harness 检出的编译声明
pnpm build       # 产出 lib/(link 安装的 profile 实际运行的就是它)
pnpm test:e2e    # live PTY 冒烟:启动 → 流式 → 审批提权 → 告别行
```

`pnpm test:e2e` 在真实 PTY 上驱动一次 `pnpm dsh --profile talon` 的活模型会话。前置条件:已构建的 harness、`link:` 安装的 talon profile、`DEEPSEEK_API_KEY`、`python3`;缺任意一项时套件自动跳过,默认 `pnpm test` 永不运行它。审批阶段会创建并删除 `~/.talon-e2e-<pid>`。

设计文档位于 [docs/](docs/):设计 spec 在 [docs/specs/](docs/specs/),各里程碑实施计划在 [docs/plans/](docs/plans/)。

## 架构

两个 cordis 插件加一个 bundle patch:

- **`talon-ui/boot`**(`talon-boot`)—— 宿主侧:用组合的默认模型选择创建根 agent。UI 插件从不拥有 agent(专用前门设计)。
- **`talon-ui`** —— UI 本体:在真实 TTY 上挂载控制器,经 [pi-tui](https://github.com/earendil-works/pi-tui) 渲染,只通过窄服务切面消费 dsh(审批应答者、提问提供者、命令注册表、会话查询、agent 注册表)。
- **`cordis.patch.yml`** —— 叠在 `@deepseek-ai/dsh-base` 之上的 bundle 层:storage + session-projection 缓存(给恢复选择器提供廉价会话标题)、`dsh-tool-ask-user`(模型侧提问工具)、以及 talon 自己的两行。

渲染遵循事件驱动、重放一致的纪律:转录展示的一切都来自持久会话事件,活会话与事后恢复渲染同样的字节。不可信字符串(模型文本、工具输出、标题)先过清洗器再着色;已提交单元格缓存渲染行,只有状态变更才失效。

## 状态

里程碑 T0(骨架)、T1(核心回路)、T2(富交互:审批、提问、命令、恢复)已完成,均有单测、快照与 live PTY 测试覆盖。接下来:T3(富渲染——markdown 高亮、工具卡、diff)与 T4(打磨——模型选择器、`@file` 补全、通知、图片粘贴、Windows)。

## 许可证

MIT
