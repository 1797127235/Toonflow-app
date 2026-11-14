# Spec: 媒体生成任务持久化

状态：待实现（2026-11-14，评审修订版）。本文记录问题、现状证据与第一版方案，未改动代码。修订要点：拆分「停止等待」与「取消任务」、提交前持久化 taskId、修正 created 中断的计费表述、下载途中重启改为照常续跑、修正 provider 契约方向与共享轮询的落地方式。

## Objective

让图片、视频、音频的生成任务在**服务端重启、页面刷新、切换或关闭画布**之后仍然可查询、可续跑、结果可找回；不重复提交，也不重复扣费。

**用户：** 本地部署的创作者（桌面端或浏览器单用户）。

**为什么：** 视频生成常见 5–10 分钟，期间刷新页面、切换项目或让桌面端自动更新都不罕见。当前实现把任务状态同时放在服务端进程内存和标签页内存里，任何一边丢失，用户就只能看到「生成任务不存在或已过期」，而供应商侧的任务往往还在跑、还在计费。

## 现状

| 环节 | 代码 | 行为 |
| --- | --- | --- |
| 任务表 | `apps/server/src/utils/media/tasks.ts:13-14` | 单进程 `Map`，注释明确「重启和结果过期后不恢复」 |
| 结果保留 | `apps/server/src/utils/media/tasks.ts:26` | 结束后只保留 5 分钟 |
| 页面心跳 | `apps/server/src/utils/media/tasks.ts:27` | 120 秒没有页面轮询就 `abort`，报「生成任务因页面长时间未连接而停止」 |
| 容量 | `apps/server/src/utils/media/tasks.ts:38` | 最多 1000 个任务，超出直接 429，没有排队 |
| 查询 | `apps/server/src/routes/ai/media/tasks/status.ts`、`apps/server/src/utils/media/tasks.ts:51` | 只查内存 `Map`，查不到返回 404 |
| 取消 | `apps/server/src/utils/media/tasks.ts:56-61` | 只 `abort` 本地信号，不保证停掉供应商任务 |
| taskId 来源 | `packages/nodeScaffold/src/nodeAi.ts:356` | 浏览器生成 `crypto.randomUUID()`，不暴露给调用方 |
| 前端任务表 | `packages/nodeScaffold/src/nodeAi.ts:100` | 挂在标签页的 `globalThis` 上，刷新即丢失 |
| 前端轮询 | `packages/nodeScaffold/src/nodeAi.ts:117-166` | 状态接口连续失败 90 秒就主动取消（`:158`） |
| 节点卸载 | `packages/nodeScaffold/src/nodeAi.ts` `useNodeAi` | `onScopeDispose` → abort → `mediaTasks.wait` 的 abort 监听 → POST cancel：**切画布、关节点会主动取消服务端任务**，不只是丢失 |
| C2A 视频 | `packages/providers/src/media/c2a.ts:834-847` | 创建和轮询写在同一个函数里，远程 ID 不外露，30 分钟超时（`:760`） |
| 结果文件 | `apps/server/src/utils/media/generation.ts:164-211` | 落到 `assets/generated`；`downloadAsset` 先在内存缓冲完整字节再独占写盘，失败整体回滚，不会留半截文件 |
| 节点数据 | 全仓库搜索 `taskId` | 除 `nodeAi.ts` 外没有节点保存 taskId，刷新后无法把结果接回节点 |

TF-Router 已注册为内置媒体供应商（`packages/providers/src/media/tfRouter.ts`，`packages/providers/index.ts` 的 `mediaProviders` 含 `tfRouter`、`c2a`、`c2aYzh`），随 app.ts revision 机制安装到 `data/providers`，并实现 resume 契约。

## 失败场景

1. **服务端重启 / 桌面端自动更新 / `bun dev` 热重启**：`Map` 清空，前端立刻收到 404。远程任务继续跑并计费；用户以为失败再点一次，就是双份消耗。
2. **切换画布 / 关闭节点**：节点卸载触发 `useNodeAi` 的 `onScopeDispose` → abort → POST cancel，任务被**显式取消**（见现状表「节点卸载」行）。只删心跳超时修不掉这条链路。
3. **刷新页面 / 关闭标签**：前端 `pending` 表随标签页消失，节点上又没有 taskId，即使结果已经写进 `assets/generated` 也接不回来。关闭页面超过 2 分钟，服务端还会因心跳超时主动 `abort`。
4. **结果 5 分钟过期**：10 分钟的视频生成完成后再回来查，已经是 404；批量生成超过 1000 个任务直接 429。
5. **网络抖动**：状态接口连续失败 90 秒，前端主动取消（`nodeAi.ts:158`），但供应商侧可能仍在执行。

共同点是：**文件在，索引没了**。结果本身已经落盘，丢的是「哪个节点、哪个任务、对应哪个远程 ID」这层元数据。

## 目标与非目标

**目标**

- 任务元数据落盘，服务端重启后仍能读到。
- 已提交到供应商的任务能续跑（先支持 C2A 视频）。
- 页面刷新后按 taskId 恢复进度与结果，不重新提交。
- 任务生命周期与页面连接解耦：切画布、关节点、关标签都不取消任务。
- 明确取消语义：能停的停，不能停的必须在 UI 说清。

**非目标**

- 不做任务队列、并发调度、优先级（后续单独设计）。
- 不做多租户、账户体系或计费网关。
- 不持久化完整请求体与参考图 blob：只存续跑所需的最小字段；未提交就被重启的任务标为中断，让用户决定是否重试，避免隐式重提。
- 不做用量账本，另立文档。
- agent 工具路径（`apps/server/src/agent/tools/index.ts:95-97` 直接调 `generateMedia`）与 `routes/ai/media/generate.ts` 的无 taskId 同步路径本次不持久化，仍随连接生命周期；接入任务层另行设计。
- 图片、音频的续跑不在首版：C2A 的图片/音频是同步生成、没有远程任务 ID，重启后只能标中断；慢图片（如 gpt-image）同样如此。

## 方案

### 1. 记录模型

每个任务一条 JSON，状态机：

```text
created ──onSubmitted──> submitted ──> succeeded
   │                         │      └─> failed
   │                         ├──> cancelled
   │                         └──(重启且 provider 不支持续跑)──> interrupted
   └──(重启)──> interrupted
```

- `created`：服务端已受理、尚未拿到远程 ID。重启后无法安全续跑，标 `interrupted`，让用户决定是否重试。注意：**此时 create 请求可能已发出、上游可能已创建并计费**（`c2a.ts:829` 注释即承认此窗口），UI 必须提示「可能已提交，重试前请核对供应商任务记录」，不能承诺未提交。
- `submitted`：已有 `remoteTaskId`，重启后按原 deadline 继续轮询；provider 不支持续跑时标 `interrupted`。
- `succeeded` / `failed` / `cancelled`：终态。
- `interrupted`：仅由重启扫描写入，表示「需要用户决定是否重试」。

记录内容：

```json
{
  "taskId": "0f9c2c1e-...",
  "cwd": "/Users/me/Movies/Laywork",
  "mediaType": "video",
  "providerId": "c2a",
  "modelId": "doubao-seedance-2-0-260128",
  "outputDirectory": "assets/generated",
  "state": "succeeded",
  "remoteTaskId": "cgt-20261114-...",
  "createdAt": 1763199000000,
  "deadline": 1763200800000,
  "settledAt": 1763199060000,
  "result": { "code": 200, "data": [{ "path": "assets/generated/video1.mp4", "mimeType": "video/mp4", "mediaType": "video" }], "message": "Success" }
}
```

`result` 为完整响应体 `{ code, data, message }`：`data` 复用现有 `GeneratedMedia[]`（相对路径 + mimeType + mediaType），错误信息在 `message`，status 读盘后原样返回；`settledAt` 为终态写入时间，用于内存 5 分钟 / 磁盘 7 天清理。不写 prompt、不写参考图、不写 API Key。

### 2. 落盘位置与写入

- 目录：数据根下的 `mediaTasks/<workspaceHash>/<taskId>.json`。数据根见 `apps/server/src/utils/conf/index.ts:23`（`TOONFLOW_DATA_DIR` 或仓库 `data/`）。
- `workspaceHash = sha256(realpath(cwd)).slice(0, 16)`，避免把用户路径直接拼进目录名。taskId 拼路径前必须保留 `z.uuid()` 校验（`routes/ai/media/tasks/status.ts:8` 已有）。
- 写入用 `@toonflow/file` 的 `writeAtomic(path, content, { mode: 0o600 })`（`packages/file/src/index.ts:147`），单文件、无跨任务锁。
- 放在数据根而不是工作区：不污染用户项目、不会被项目导出或同步带走。

### 3. Provider 契约

目前 provider 把「创建」和「轮询」封在一个调用里，这是无法续跑的根因。新增能力分两处，方向不能混：

**宿主注入、provider 调用**——加在 `ProviderContext`（`packages/providers/types.d.ts`，与 `tool`、`config` 同级）：

```ts
onSubmitted?: (remoteTaskId: string) => void | Promise<void>;
```

创建成功后立刻回调，服务端落盘 `remoteTaskId`。provider 必须 **await 回调完成再开始轮询**，否则这段窗口内崩溃会丢掉远程 ID。它不是 provider 定义上的可选实现——provider 定义是供应商文件，宿主不可能替它实现。

**provider 定义上的可选实现**——沿用现有 `this: ProviderContext` 约定：

```ts
resume?: (this: ProviderContext, remoteTaskId: string) => Promise<MediaAsset[]>;
```

- `resume` 只做轮询与结果下载：重新查询远程状态、拿新鲜的结果 URL（C2A 完成时本就有 `${endpoint}/${taskId}/content` 兜底），不依赖落盘的旧 URL。剩余时间由宿主经 `context.signal` 注入（`deadline - now`），resume 内部**不得另起超时**，否则反复重启会无限续命。
- 未实现 `resume` 的 provider：重启后标 `interrupted`，不自动重试。
- 现有供应商（C2A、TF-Router）上游均无取消任务接口：**不加 `provider.cancel` 契约**。用户停止 = 本地取消（abort + 写 `cancelled` + 阻止续跑），远程任务可能继续执行并计费，UI 必须明确提示「远程任务可能继续计费」。
- **加载器包装**：`apps/server/src/utils/media/provider.ts` 的 `loadMediaProviderSource` 目前只对 `generateImage/Video/Audio` 做 context 注入、signal 接线与错误富化；`resume` 必须同样包装，否则取消信号中断不了续跑、报错没有供应商正文。
- **不新增构建/内联机制**：已安装供应商是自包含单文件，VM 里 `rejectImport` 禁止任何 import，不存在可共享的运行时模块。`c2a.ts`/`c2aYzh.ts` 本就是近似重复，首版同构修改两处（create/poll 拆分 + resume），不造打包步骤；后续重复成本高再抽源码模块。内置文件由 `apps/server/src/app.ts:59-68` 按源码 hash 计算 revision、`utils/plugins/initialize.ts:29-33` 强制同步到 `data/providers`——resume 能力随应用更新自动落地，无需手工迁移已安装文件。自定义供应商无 resume，标 interrupted，符合预期。
- 调用链：`generateMedia` 增加可选 `hooks` 参数，`tasks.ts` 传入写盘回调，经加载器注入 `ProviderContext.onSubmitted`（`apps/server/src/utils/media/generation.ts:164`）。
- **分发判据与供应商无关**：宿主只按「记录有 remoteTaskId 且 provider 实现了 resume」触发续跑，不含 providerId/媒体类型分支。
- 首批改动：`packages/providers/src/media/c2a.ts:834-847` 与 `c2aYzh.ts`，仅视频；C2A 图片/音频同步生成、无远程 ID，见非目标。
- 续跑覆盖所有已注册供应商：C2A/c2aYzh 视频、TF-Router 图片/视频/音频（均按远程任务 ID 轮询恢复）。无 remoteTaskId 的同步任务（C2A 图片/音频）重启标 interrupted。

### 4. 服务端生命周期

- **start**：写 `created` 记录（`deadline = createdAt + 30 分钟`，首版宿主统一定；provider 进程内超时仍由各自实现）→ 调 `generateMedia` → `onSubmitted` 写 `submitted + remoteTaskId` → 结束时写终态与结果。重复 taskId 的 409 去重同时查内存与磁盘。
- **status**：先查内存 `Map`（热路径不变）；未命中则读盘，保留 `record.cwd === cwd` 校验防跨工作区读取。读到 `submitted` 且可续跑时触发一次恢复轮询，用 `Set<taskId>` 去重（含已在 Map 中的任务），避免多窗口重复恢复；终态直接返回结果。
- **cancel**：`abort` 本地信号 + 写 `cancelled`（上游无取消接口，远程任务可能继续计费）。
- **单写者与终态守卫**：所有记录写入收口在 `tasks.ts`，只允许「非终态 → 终态」，`cancelled` 不能被迟到的 `succeeded/failed` 覆盖。重启后恢复前先读盘确认未被取消（另一窗口可能已取消）。`writeAtomic` 只保证单文件原子，这条守卫是语义正确性的前提。
- **停止页面心跳超时**：删除 `tasks.ts:27` 的 120 秒 `abort`。任务生命周期与页面连接解耦，只有显式取消或到达 deadline 才停止。这是持久化能成立的前提之一——否则「关页 2 分钟」依然会丢掉正在计费的任务。前提之二是前端拆分 detach/cancel（见第 5 节），否则切画布仍会显式取消。
- **启动扫描**：服务起来后延迟几秒（等配置加载）扫描 `mediaTasks`：
  - `created` → `interrupted`；
  - `submitted` 且 provider 支持续跑、未过 deadline → 恢复轮询；不支持续跑 → `interrupted`；
  - 已过 deadline → `failed`；
  - 终态且超过 7 天 → 删除记录（结果文件不动）。定时扫描（每小时）同样清理过期终态——桌面端可能数周不重启，不能只靠启动扫描。
- 内存 `Map` 保留为缓存与去重层，磁盘是事实源。
- 续跑完成与正常生成一样走 `beginGeneration`/`finish` 的余额刷新（`apps/server/src/utils/media/billing.ts:154`）。

### 5. 前端

- **nodeAi API 变更**（现状 taskId 不暴露，插件拿不到 id，此步是后续一切的前提）：
  - `generateMedia` 增加 `onTaskId` 回调，在 POST 之前把 taskId 交给调用方；
  - 新增按 taskId 重新接入的入口（如 `watchMediaTask(directory, taskId)`），只轮询、不重新提交。
- **拆分「停止等待」与「取消任务」**：节点卸载、切画布只 detach（停止本地轮询，不发 cancel）；用户点停止、删除节点才 POST cancel。现状 `useNodeAi` 的 `onScopeDispose → controller.abort()` 经 `mediaTasks.wait` 的 abort 监听直接发 cancel，是「切画布丢任务」的直接原因，必须拆开。
- **提交前持久化**：拿到 taskId 后写进节点 data（可选字段 `pendingTaskId`），并在 POST 之前 flush 画布保存（复用 `apps/web/src/pages/workspace/panels/canvas/index.vue` 已暴露的 `flushCanvasSave`）。画布保存是 500ms debounce 且失败只弹 toast：不 flush，提交后立刻刷新就会丢 taskId，产生孤儿计费任务、诱发双扣。flush 失败则中止提交并报错，不提交无法追踪的任务。提交前落盘的 taskId 若最终未提交成功，恢复时按 404 过期清理，无副作用。
- 完成或失败后清空 `pendingTaskId`、写结果字段，走正常画布保存。旧画布没有该字段，按「无任务」处理。
- 画布加载后扫描节点上的 `pendingTaskId`，调 `watchMediaTask` 恢复；不要重新提交。恢复收到 404（记录已过 7 天清理）时清空字段、显示「已过期」，不无限重试。
- 网络抖动策略调整：状态接口失败只标记「连接中断」并继续退避重试，不再 90 秒直接取消（`nodeAi.ts:158`）；是否取消交给用户。
- **cancel 失败兜底**：现状注释「取消失败由服务端无心跳过期兜底」——心跳删除后此兜底不存在。cancel POST 失败必须重试，最终失败要明确告知用户「任务可能继续运行至超时」。
- **共享落点**：恢复与状态机逻辑放 `nodeScaffold`/`nodeShared`，插件只调用。受影响调用点共 5 处、跨 4 个插件：`imageGenerationNode`、`videoGenerationNode`、`audioGenerationNode`、`imageNode/src/imageInpaint.ts`、`imageNode/src/components/imageVariationGenerator.vue`，不允许每个插件各抄一份。

### 6. 兼容与迁移

- 旧的 `Map` 行为保留为缓存；磁盘记录不存在时回落到当前逻辑。
- 老画布、老任务没有 `pendingTaskId` / 记录，打开不报错，行为与现在一致。
- 记录带 `version`，后续字段变更按版本读。
- 工作区改名/移动后 `workspaceHash` 变化，旧记录成为孤儿：按「已过期」处理，7 天后清理，不做迁移。

## 验收

仓库不引入自动化测试（`AGENTS.md` 测试与检查边界），以下全部手工验证：

1. 10 分钟视频生成中重启 server：前端恢复进度并拿到结果，供应商侧 `remoteTaskId` 不变，只扣一次。重启发生在下载途中同样恢复（重新轮询拿新鲜 URL 重下，本地无半截文件）。
2. 生成中刷新页面（包括提交后 500ms 内立刻刷新）：节点仍显示生成中，完成后自动回填，不产生第二条远程任务。
3. 生成中关闭页面 5 分钟再打开：任务仍在跑或已完成，结果能接回。
4. 生成中切换画布、关闭节点再切回：不发送 cancel，任务继续，结果能接回；用户点停止才取消。
5. 取消后若 provider 不支持取消，UI 明确提示远程可能继续计费；cancel 请求失败有重试与明确提示。
6. 重启时处于 `created` 的任务显示「已中断（可能已提交）」，可手动重试，不自动重提。
7. 打开旧画布、旧数据无报错；恢复时 404 的旧 taskId 被清理，不无限重试。

## 风险与未决问题

- **TF-Router**：已内置安装并实现 resume（`get*Status` by `taskICode`，覆盖图片/视频/音频），重启后按 remoteTaskId 续跑；真机回归并入 Checkpoint A。
- **取消是否真能停止计费**：未知，必须在文案上兜底。
- **created 窗口的双扣风险**：create 请求发出后、`onSubmitted` 回调前崩溃，上游可能已创建并计费。没有供应商幂等键就消不掉这个窗口；interrupted 文案必须提示用户核对供应商任务记录。
- **cancel 失败无兜底**：心跳超时删除后，取消请求失败的任务会一直跑到 deadline，前端必须重试并明确告知。
- **多窗口**：多个页面可能同时轮询同一 taskId；status 只读、天然幂等，恢复轮询用服务端去重；终态写入靠单写者守卫防覆盖。
- **记录含绝对路径**：本地单用户可接受；不要写 prompt、参考图或密钥。

## 工作量

| 步骤 | 内容 | 预估 |
| --- | --- | --- |
| 1 | 记录模型 + 落盘 + 启动扫描 + status/cancel 读盘 + 终态守卫 | 0.5–1 天 |
| 2 | provider `onSubmitted` / `resume` / `cancel` + 加载器包装 + 源码级共享轮询（C2A 视频） | 1–1.5 天 |
| 3 | 前端：nodeAi taskId 暴露与重接入、detach/cancel 拆分、提交前 flush、共享恢复逻辑接入 4 插件 5 调用点 | 1–1.5 天 |
| 4 | 手工验收与边界 | 0.5–1 天 |

完整方案约 4–5 天。只做 1 + 3（不做续跑）能消掉大部分 404 并修好切画布/刷新场景，但重启中的任务只能标中断；第 3 步必须包含 detach/cancel 拆分与提交前持久化，否则验收 2、4 过不了。

## 后续

用量账本（报价、余额差、按项目/模型聚合）单独设计，不并入本规格。
