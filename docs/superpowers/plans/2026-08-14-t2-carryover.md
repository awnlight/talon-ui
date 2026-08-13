# T2 计划前置事项(T0+T1 终审移交)

来自 foundation 计划 ledger 的强制移交项,写 T2 计划时必须纳入:

1. **硬前置**:`FramelessEditor` 的 `slice(1,-1)` 假设最后一行是底边框;pi-tui 上游在 autocompleteState 激活时把补全行追加在底边框**之后**——接入任何 autocompleteProvider 前必须重审(否则会切掉真实内容行)。
2. 双 sessionId 默认值:`talon-boot` 与 `talon-ui` 各自 `?? 'main'`,只配置其一会导致 UI 永远等不到匹配 agent——cordis.patch.yml 注释或共享配置键。
3. Ctrl+D 运行中静默吞键——spec §6 要求提示"先取消再退出"。
4. 快照封闭清单(const 数组 = 观察到的 checkpoint = .expected.txt 文件三方相等的 afterAll)+ themeViolations 内嵌进 checkpoint 助手(spec §7.1),Task 9 的单快照未建全套。
5. turn-end reason 表驱动测试补 interrupted/max-tokens/blocked 三分支(T4 遗留)。
6. trim 标记 lineCountOf 硬编码 1 行,<~32 列会折行导致低估(parked,T2 顺手修)。
7. spacer guard 4 处重复 → 提取 spaceBeforeNewCell()(T6 遗留)。
8. PI_DEBUG_REDRAW 零 full-redraw 快照断言(spec §8 T1/D10④)——计划明确移交 T2(需要面板开合流)。
9. per-file 100% coverage 配置尚未建立(spec §7)——src/index.ts 曾为 0% 的教训;T2 建 coverage 基线。
10. spec §4 措辞微调:teal 是 truecolor 层,ANSI accent 回退仍为 95——D6 为准,T3 视觉落地时改表述。
