# Implementation Plan: 媒体生成任务持久化

规格:`docs/mediaTaskPersistence.md`(2026-11-14 评审修订版)。任务明细见 `tasks/todo.md`。

## Overview

把媒体生成任务从「进程内存 Map + 标签页 globalThis」改为「磁盘事实源 + 内存缓存」:任务记录落盘、实现 resume 契约的供应商按 remoteTaskId 续跑(首批 C2A 视频)、前端把 taskId 持久化进节点并拆分「停止等待」与「取消任务」。完成后,服务端重启、刷新、切画布、关标签都不丢任务、不重复提交。

## Architecture Decisions

- **磁盘是事实源,Map 降级为缓存**。记录放数据根 `mediaTasks/<workspaceHash>/<taskId>.json`(不污染工作区),`writeAtomic` + `0o600`。所有写入收口 `tasks.ts` 单写者,「非终态→终态」守卫防 cancelled 被迟到结果覆盖。
- **onSubmitted 放 ProviderContext(宿主注入),resume 放 provider 定义(`this: ProviderContext` 约定)**。方向不能混:provider 定义是供应商文件,宿主不可能替它实现回调。loader 对 resume 做与 generate* 相同的 context/signal/错误包装。
- **机制与供应商解耦,宿主零 providerId 分支**:续跑分发判据只有两条——记录有 remoteTaskId、加载出的 provider 定义实现了可选 `resume`;不区分供应商与媒体类型,未实现契约的任务重启标 interrupted。C2A、TF-Router 均在供应商自身文件实现契约(正是插件边界该在的位置);TF-Router 已按同一契约实现 resume(`get*Status` by `taskICode`,覆盖图片/视频/音频),宿主零改动。
- **不新增 provider 构建/内联机制**。已安装供应商是自包含单文件(VM 禁 import),`c2a.ts`/`c2aYzh.ts` 本就是近似重复;首版同构修改两处,不造打包步骤(对规格第 3 节的有意简化,Task 3 同步修订文档)。内置文件由 app.ts revision 机制自动同步到 `data/providers`,无需手工迁移。
- **deadline 归宿主**:首版统一 `createdAt + 30min`;resume 的剩余时间经 `context.signal` 注入,provider 不得另起超时,防反复重启无限续命。
- **前端恢复逻辑放 nodeShared/useNodeGeneration**,插件只接线;不允许 4 插件 5 调用点各抄一份。
- **提交前持久化复用现有 flush 通道**:已确认节点 `inject("canvas")` 的 `CanvasContext`(toolScaffold/runtime.ts:75)只有 id/tools/getNodeLabel/call,**不含 flushSave**(它是 useCanvasTools 私有 option)。按节点能力既有模式(batchCanvasHistory 等专用 key)在 canvas/index.vue 补一行 `provide("flushCanvasSave", flushCanvasSave)`,useNodeGeneration inject;不改 CanvasContext agent 契约。节点写 `pendingTaskId` → flush 成功 → 才 POST。
- **detach ≠ cancel**:`onScopeDispose` 只停本地轮询;用户停止/删节点才 POST cancel。删服务端 120s 心跳与前端 90s 自动取消;cancel 失败重试后明确报错(心跳兜底已不存在)。现有供应商上游均无取消接口(C2A 用户已确认;TF-Router 代码仅 create+轮询):不加 `provider.cancel` 契约,服务端 cancel = 本地 abort + 写 cancelled + 阻止续跑;UI 明示「远程任务可能继续计费」。
- **范围**:C2A/c2aYzh 视频与 TF-Router 图片/视频/音频均实现 onSubmitted/resume;无 remoteTaskId 的任务(C2A 图片/音频同步路径)重启标 interrupted;agent 工具路径与无 taskId 同步路径不接入(规格非目标)。
- **约束**:不新增依赖、不新增测试文件(AGENTS.md);验证 = 各 workspace typecheck/build + 临时数据目录手工 HTTP + 真机验收。路由文件不变,无需 `bun run routes`。

## Task List

明细(验收标准/验证/文件)在 `tasks/todo.md`。

### Phase 1:服务端持久化
- [ ] Task 1:任务记录落盘 + 单写者守卫 + 删心跳 + 启动扫描(无续跑)
- [ ] Task 2:Provider 契约 + loader 包装 + generation hooks 与共享落盘尾部(与 Task 1 可并行)

### Phase 2:续跑
- [ ] Task 3:C2A 视频 create/poll 拆分 + onSubmitted + resume(两文件同构)
- [ ] Task 4:tasks.ts 接入续跑(启动扫描/status 触发、去重、余额刷新)

### Checkpoint A:服务端闭环(Task 1–4 后)
- [ ] server typecheck/build 全绿
- [ ] 真机:一次真实 C2A 视频(先经用户确认计费),生成中重启 → 自动续跑 → 结果落盘、只扣一次

### Phase 3:前端
- [ ] Task 5:nodeAi detach/cancel 拆分 + onTaskId + watchMediaTask + 删 90s 自动取消
- [ ] Task 6:视频节点垂直切片(pendingTaskId 提交前 flush + 挂载恢复)
- [ ] Task 7:image/audio 生成节点接线
- [ ] Task 8:imageNode 修复/变体两处接线

### Checkpoint B:完整验收(Task 5–8 后)
- [ ] 规格验收 1–7 全部手工通过(真机计费项先经用户确认)
- [ ] 旧画布、旧数据无报错;人工复核后交付

## Risks and Mitigations

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| created 窗口双扣(create 已发出、onSubmitted 前崩溃) | 高 | 无供应商幂等键消不掉;interrupted 文案「可能已提交,重试前核对供应商记录」 |
| 停止后远程任务继续计费 | 低 | 上游无取消接口(已确认),UI 明示「远程任务可能继续计费」 |
| nodeAi detach 拆分波及全部生成调用点 | 中 | Task 5 单独做、先过 typecheck;Checkpoint B 全量手工回归 |
| flush 失败阻断提交改变 UX | 低 | 明确报错「无法保存任务追踪,未提交」,不静默放行 |
| 真机验收产生费用 | 低 | Checkpoint A/B 的真实生成先经用户确认 |
| 两文件同构修改漂移 | 低 | 不引入构建机制的代价;改动保持函数同构,后续重复成本高再抽源码模块 |

## Open Questions

- 真机验收的时间与费用确认(Checkpoint A/B 前问用户)。
