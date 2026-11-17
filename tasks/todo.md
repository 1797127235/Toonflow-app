# Todo: 媒体生成任务持久化

规格:`docs/mediaTaskPersistence.md`;设计决策与风险:`tasks/plan.md`。
验证约束(AGENTS.md):不新增测试文件/框架;验证 = typecheck、build、临时数据目录手工 HTTP、真机手工验收。真实 C2A 生成计费,先经用户确认。

进度(2026-11-14):Task 1/2/3/4 代码完成。Task 1/2:typecheck/build + 临时目录手工 HTTP 全过(落盘 0600、读盘往返、409 去重、跨工作区 404、interrupted/超时标记、cancel 终态守卫、重启扫描、7 天清理、非法 taskId 400)。Task 3:c2a/c2aYzh 同构拆分+resume,typecheck/build 过,真实 loader 加载验证(resume/generateVideo 存在、onSubmitted 注入、无 Key 先抛错、22/28 模型加载)。Task 4:generation.ts resumeMedia+tasks.ts triggerResume/扫描/status 续跑,typecheck/build 过,临时目录手工 HTTP 验证(无计费):tfRouter 无 resume→interrupted、c2a 有 resume 无 Key→failed(远程调用前)、cancelled/超时/created 不触发续跑、5 并发 status 去重单次恢复、重启启动扫描自动续跑。状态集去掉 running(无 hook 写入),规格已同步。真实生成 succeeded 落盘+余额刷新+onSubmitted/resume 运行时回归并入 Checkpoint A(计费经用户确认)。后续(用户 m00603 要求支持所有注册供应商):给 TF-Router 也实现 resume——契约 resume 加 mediaType 参数(三端点 getImageStatus/getVideoStatus/getAudioStatus 不同),宿主 resumeMedia 透传 record.mediaType;tfRouter generateTask 拆 create→onSubmitted→pollTask,新增 resume;C2A/c2aYzh 少参可赋值无需改。typecheck/build 过,真实 loader 验证三供应商 resume 均 function、tfRouter 无 Key 先抛「请填写 TF-router API Key」。TF-Router 图片/视频/音频均可续跑(均 taskICode),C2A 仅视频。真机验证(2026-11-14 17:12,用户 m00669 截图确认):TF-Router MiniMax-H3 视频生成中途重启 server,节点自动接回同一任务出片;remoteTaskId cgt-20261114170917-cb55q 前后一致(未重提交、只扣一次),磁盘 submitted→succeeded,结果 1.46MB 落工作区 assets/。供应商无关续跑机制真机闭环成立。Task 5/6/7/8 前端代码完成(2026-11-14 17:30):nodeAi generateImage/Video/Audio 加 onTaskId(POST 前持久化+flush)、新增 watchMediaTask(只轮询不重提)/cancelMediaTask、wait abort 只 detach、删 90s 自动取消改退避;useNodeGeneration 重写(run/onTaskId/reconnect/stop,media 配置);canvas provide flushCanvasSave;image/video/audio 三生成节点同构接线(pendingTaskId+onMounted reconnect+停止 stop);imageNode inpaint 加 onTaskId/resumeTaskId(续跑重做合成),imageGenerationNode inpaint 分支接回;imageVariationGenerator 委托子节点生成无需改。各包 vue-tsc + apps/web vue-tsc/build 全过,build:nodes 重建 10 插件含新代码。**部署关键教训(2026-11-14 17:46)**:运行中的 app 从 `data/nodes/`(已安装插件,路由 nodes/files.ts:14 `dirname(conf.path)/nodes`)加载节点,**不是 build/nodes**;`build:nodes` 只重建 build/nodes,不会安装到 data/nodes。首次「修复未生效」根因即此:data/nodes 是一周前(11-07)旧 bundle,浏览器一直跑旧代码。修复:经 `POST /api/nodes/install {fileName,source,force:true}`(headers x-toonflow-workspace:1 + Referer:http://localhost:3000/ + Host:localhost:3000,连 127.0.0.1)强制安装 10 个新 bundle 到 data/nodes,curl 验证服务 bundle 含 watchMediaTask/pendingTaskId/reconnect。**今后改节点代码:build:nodes 后必须安装到 data/nodes 并 curl 服务路由验证,再让用户硬刷新(Ctrl+Shift+R)。** 刷新/切画布/停止真机手工验收待用户硬刷新后浏览器验证。

评审修复(2026-11-14 18:24,用户 m00950 调用 code-review-and-quality skill 派 3 reviewer 后 m00994「修复」):修完全部 Critical+Required。C1 imageInpaint 中止保留临时目录(`requested && !signal.aborted` 才清理,避免销毁已付费续跑结果);C2 onSubmitted 落盘失败降级不中止已计费任务(persist.catch);R1 start 改 writeAtomic exclusive+EEXIST→409(删 stat 预检,闭并发双提交 TOCTOU);R2 新增 serialize 按 taskId 互斥锁,settleDisk/triggerResume 认领入锁+tasks.has 守卫(闭 cancel 被迟到 succeeded 覆盖);R3 status 读盘后复查内存 live 任务+settleDisk tasks.has(闭刚 start 任务被误标 interrupted);R4 generateMedia catch 仅 `!controller.signal.aborted`(scope 存活=显式停止)才取消,卸载/切画布 detach 不杀计费任务;R5 cancel 改返回 Promise+失败重试 3 次+最终失败 showNodeError 告知;R6 stop 弹 ElNotification「远程任务可能继续计费」;R7 三节点解构 stalled+v-loading element-loading-text「连接中断，正在重试…」。8 处 typecheck(6 包+web+server)全过;build:nodes 重建+force 安装 10 bundle 到 data/nodes+curl 验证含新代码(连接中断/远程任务可能继续计费/stalled/停止请求发送失败)+重启 server(PID 370863)加载新 tasks.ts。Optional/Nit 未修(O1 resume 兜底超时死代码/O2 readRecord deadline 校验/O3 强转与 media 配置重复等),待用户决定。真机刷新续跑+C2A 视频回归(Checkpoint A/B 计费)待用户硬刷新验收。

## Task 1: 服务端任务记录落盘

**Description:** `tasks.ts` 从纯内存 Map 改为磁盘事实源 + 内存缓存。新增记录读写(`data/mediaTasks/<sha256(realpath(cwd)).slice(0,16)>/<taskId>.json`,`writeAtomic` + `0o600`,taskId 保留 uuid 校验);所有写入收口单函数,「非终态→终态」守卫;start 写 created(deadline=createdAt+30min)、409 查内存+盘;status 内存未命中读盘(保留 cwd 相等校验);cancel 写 cancelled;删除 :27 的 120s 心跳 abort;启动扫描(created/submitted→interrupted[本任务尚无续跑],过 deadline→failed,终态>7天→删除)+ 每小时定时清理。

**Acceptance criteria:**

- [x] 生成完成后重启服务,status 从磁盘返回 succeeded 与结果,不再 404
- [x] 重启后 created/submitted 记录标 interrupted;过 deadline 标 failed;终态 7 天后清理
- [x] 关页超过 120 秒任务不再被 abort;cancelled 不被迟到的 succeeded/failed 覆盖;跨工作区读盘被拒

**Verification:**

- [x] `cd apps/server && bun run typecheck && bun run build`
- [x] 手工 HTTP:临时 `TOONFLOW_DATA_DIR` 下 start/status/cancel,kill 进程重启后 status 读盘;检查记录文件权限 0600、非法 taskId 被拒

**Dependencies:** None(与 Task 2 可并行)

**Files likely touched:**

- `apps/server/src/utils/media/tasks.ts`

**Estimated scope:** Medium(单文件但逻辑密集)

## Task 2: Provider 契约 + loader + generation hooks

**Description:** `types.d.ts` 的 `ProviderContext` 加 `onSubmitted?: (remoteTaskId: string) => void | Promise<void>`;provider 定义加 `resume?: (this: ProviderContext, remoteTaskId: string) => Promise<MediaAsset[]>`。`provider.ts` loader 对 resume 做与 generate* 相同的 context 注入、signal 接线、错误富化,并把 hooks.onSubmitted 注入 context。`generation.ts` 加可选 hooks 参数;把「assetBytes→独占写盘→失败回滚」尾部抽成共享函数供生成与续跑复用。

**Acceptance criteria:**

- [x] onSubmitted 经 loader 到达 provider 的 this;resume 被包装(取消信号可中断、错误含供应商正文且隐藏密钥)
- [ ] generateMedia 的 hooks 参数贯通;共享落盘尾部被正常生成调用,行为与现状一致(独占创建、失败回滚)

**Verification:**

- [x] `cd apps/server && bun run typecheck && bun run build`(provider 类型随 server tsc 覆盖)
- [ ] 手工:现有图片/视频生成走通一次(计费项经用户确认),确认 hooks 缺省时行为不变

**Dependencies:** None(与 Task 1 可并行)

**Files likely touched:**

- `packages/providers/types.d.ts`
- `apps/server/src/utils/media/provider.ts`
- `apps/server/src/utils/media/generation.ts`

**Estimated scope:** Medium(3 文件)

## Task 3: C2A 视频拆分 + resume

**Description:** `c2a.ts`/`c2aYzh.ts` 同构修改(自包含,不新增 import):generateVideo 拆为 create → **await this.onSubmitted?.(taskId)** → poll;新增 resume,只轮询远程状态、完成时取新鲜 URL(video_url ?? task.url ?? `${endpoint}/${taskId}/content`),超时仅用 context.signal,不另起。上游无取消接口(已确认),不实现 provider.cancel。规格第 3 节已同步修订(同构、无 cancel 契约、TF-Router 已内置)。

**Acceptance criteria:**

- [x] create 成功后先 await onSubmitted 落盘再轮询;resume 不依赖落盘旧 URL、不重置超时
- [x] 两文件保持自包含(rejectImport 不触发)、函数同构

**Verification:**

- [x] `cd apps/server && bun run typecheck && bun run build`
- [ ] 真机(经用户确认):一次视频生成,观察 remoteTaskId 在轮询开始前已落盘

**Dependencies:** Task 2

**Files likely touched:**

- `packages/providers/src/media/c2a.ts`
- `packages/providers/src/media/c2aYzh.ts`

**Estimated scope:** Medium(2 源码文件 + 文档)

## Task 4: 服务端接入续跑

**Description:** `tasks.ts` 启动扫描与 status 读盘回落中,submitted 且 provider 支持 resume、未过 deadline → 触发恢复:`Set<taskId>` 去重(含 Map 内任务);恢复前读盘确认未 cancelled;按 record 的 providerId/model 从 conf 取配置加载 provider;`context.signal` 带 `deadline - now` 剩余时间;结果走共享落盘尾部与 beginGeneration/finish 余额刷新;终态写入走单写者守卫。

**Acceptance criteria:**

- [ ] 重启后 submitted 自动续跑至 succeeded,结果文件落 assets/generated,remoteTaskId 不变
- [ ] 多窗口/重复 status 不产生重复恢复;已 cancelled 的记录不被续跑覆盖;续跑完成触发余额刷新

**Verification:**

- [x] `cd apps/server && bun run typecheck && bun run build`
- [ ] 手工 HTTP + Checkpoint A 真机重启实验(手工 HTTP 无计费部分已过:续跑触发/去重/终态守卫/重启扫描;真机 succeeded 落盘+余额刷新待 Checkpoint A)

**Dependencies:** Task 1、2、3

**Files likely touched:**

- `apps/server/src/utils/media/tasks.ts`

**Estimated scope:** Small–Medium(单文件)

## Checkpoint A: 服务端闭环(Task 1–4 后)

- [ ] apps/server typecheck/build 全绿
- [ ] 真机(先经用户确认计费):10 分钟级视频生成中 kill 并重启 server → 自动续跑 → 结果落盘、节点可查、只扣一次;下载途中重启同样恢复
- [ ] 临时数据目录验证:created→interrupted、deadline→failed、7 天清理、跨工作区拒绝
- [ ] 与用户确认后再进 Phase 3



## Task 5: nodeAi detach/cancel 拆分与重接入

**Description:** `nodeAi.ts`:generateMedia 加 `onTaskId` 回调(POST 之前交出 taskId);新增 `watchMediaTask(directory, taskId)` 只轮询不重提;**wait 的 abort 监听不再发 cancel POST**,onScopeDispose 只 detach;显式停止/删节点路径才 cancel(提交失败后的清理性 cancel 保留);删 90s 自动取消,改退避重试 + 「连接中断」标记;cancel POST 失败重试,最终失败明确报错。

**Acceptance criteria:**

- [ ] 节点卸载/切画布不发 cancel;用户停止发 cancel 且失败有重试与提示
- [ ] onTaskId 在 POST 前调用;watchMediaTask 不产生新提交;状态接口抖动不再自动取消

**Verification:**

- [x] `cd packages/nodeScaffold && bun run typecheck`
- [x] `cd apps/web && bun run typecheck && bun run build`
- [ ] 手工:生成中切画布,抓请求确认无 cancel POST;停止按钮仍取消

**Dependencies:** Task 1(集成验证需要 status 读盘;开发可并行)

**Files likely touched:**

- `packages/nodeScaffold/src/nodeAi.ts`

**Estimated scope:** Medium(单文件,波及所有生成调用点)

## Task 6: 视频节点垂直切片(pendingTaskId + flush + 恢复)

**Description:** `useNodeGeneration`(nodeShared)加恢复入口:挂载时见 `pendingTaskId` → watchMediaTask,成功写结果清字段,404 清字段显示「已过期」不重试。videoGenerationNode 接线:onTaskId 写 data.pendingTaskId → 经 inject("canvas") 的 flushSave 通道 flush 成功 → 才 POST;flush 失败中止提交报错;完成/失败清字段走正常保存。已确认 CanvasContext 不含 flushSave:在 canvas/index.vue 补 `provide("flushCanvasSave", flushCanvasSave)`(同 batchCanvasHistory 模式),useNodeGeneration inject,不改 CanvasContext 契约。

**Acceptance criteria:**

- [ ] 提交后 500ms 内刷新页面,节点仍显示生成中并自动回填,不产生第二条远程任务
- [ ] 停止提示含「远程任务可能继续计费」
- [ ] flush 失败不提交;切画布再切回能接回;恢复 404 清字段不无限重试

**Verification:**

- [x] `cd packages/nodeShared && bun run typecheck`;`cd packages/nodes/videoGenerationNode && bun run typecheck`
- [x] `cd apps/web && bun run typecheck && bun run build`
- [ ] 手工:刷新/切画布/flush 失败(临时只读目录模拟)三场景

**Dependencies:** Task 5

**Files likely touched:**

- `packages/nodeShared/src/useNodeGeneration.ts`
- `packages/nodes/videoGenerationNode/src/index.vue`
- `apps/web/src/pages/workspace/panels/canvas/index.vue`(补一行 provide flushCanvasSave)

**Estimated scope:** Medium(2–3 文件)

## Task 7: image/audio 生成节点接线

**Description:** 复用 Task 6 的共享恢复入口,把 pendingTaskId 提交前 flush + 挂载恢复接入 imageGenerationNode 与 audioGenerationNode。无 remoteTaskId 的任务(当前 C2A 图片/音频同步路径)重启后按 interrupted 展示「已中断(可能已提交)」,不自动重提。

**Acceptance criteria:**

- [ ] 两节点刷新后按 pendingTaskId 恢复;interrupted 文案正确、可手动重试
- [ ] 不重复提交;旧画布无字段不报错

**Verification:**

- [x] 两插件目录各自 `bun run typecheck`;`cd apps/web && bun run typecheck && bun run build`
- [ ] 手工:图片/音频生成中刷新、重启后 interrupted 展示

**Dependencies:** Task 6

**Files likely touched:**

- `packages/nodes/imageGenerationNode/src/index.vue`
- `packages/nodes/audioGenerationNode/src/index.vue`

**Estimated scope:** Small(2 文件)

## Task 8: imageNode 两处接线

**Description:** 把同一共享恢复入口接入 imageNode 的修复与变体生成两处调用点,行为与 Task 7 一致。

**Acceptance criteria:**

- [ ] 修复/变体生成刷新后可恢复;取消/停止语义与视频节点一致
- [ ] 不重复提交;旧数据无报错

**Verification:**

- [x] `cd packages/nodes/imageNode && bun run typecheck`;`cd apps/web && bun run typecheck && bun run build`
- [ ] 手工:修复/变体生成中刷新与切画布

**Dependencies:** Task 6

**Files likely touched:**

- `packages/nodes/imageNode/src/imageInpaint.ts`
- `packages/nodes/imageNode/src/components/imageVariationGenerator.vue`

**Estimated scope:** Small(2 文件)

## Checkpoint B: 完整验收(Task 5–8 后)

- [ ] 规格验收 1–7 全部手工通过(真实生成计费项先经用户确认)
- [ ] 旧画布、旧数据打开无报错;恢复 404 清理、cancel 失败提示、网络抖动不自动取消逐项确认
- [ ] 各 workspace typecheck/build 全绿;人工复核后交付