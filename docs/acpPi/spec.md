# Spec: ACP Client 首轮（嵌入 pi）

状态：已实现（2026-11-08，commit 5108985 起）。本文保留为需求基线。与计划的出入：实际改用上游 pi-acp（npx）+ piCommand 脚本 + piBridge 扩展，未建 vendored fork 与 ops/ 操作平面；提示词、技能清单与全局规范经 pi 原生参数 `--system-prompt` / `--append-system-prompt` 下发，与内置 Agent 共用 `apps/server/src/agent/context.ts`。核查未见本机门禁（isLocalWorkspaceRequest）与跨引擎 409 串行的对应实现，§Success Criteria 第 1 / 10 条待补齐或改判。
能力假设来源：实测 `pi-acp@0.0.34` + `pi@1.5.0`（2026-11，见 Plan §4.0）。

## Objective

让桌面端用户在已打开的**本地工作区**助手面板中，通过输入区 **Agent 选择器**选用「外部 pi（ACP）」，并在该会话中获得与内置 Agent **功能对等**的画布协作能力：会话与历史、流式展示、停止、模型与思考档位、工作区文件、插件与画布工具、mention 与附件。

**用户：** 使用 Toonflow 桌面端、已在本机安装并配置好 `pi` 的创作者 / 开发者。

**为什么：** 现有内置 Agent 是进程内 `@earendil-works/pi-coding-agent` SDK；用户还希望在同一助手壳里使用**本机独立 pi CLI**（及其生态）。ACP 是编辑器宿主对接外部 coding agent 的标准；Toonflow 做 Client，首轮只接 pi。

### 对等判定原则（本 Spec 的核心）

1. 判定单位是**用户能完成的任务**，不是内部通道一致。
2. 内置 Agent 用 `canvasCall` 事件让前端执行画布操作；外部 pi 通过 **ACP 标准 `mcpServers` 通道**获得同一组 MCP 工具，工具经 dispatcher 落到同一 `callControl`。传输不同、能力同源即视为对等。
3. 协议或适配器客观不支持的项，必须在 §功能对等矩阵中标「不支持」并写明原因，**不允许静默缺失**。
4. 首轮交付判据 = 矩阵中所有「必须」项通过；「受限」项须在 UI 有明确提示且行为可预期。

**非目标：** 做 ACP Agent 对外暴露；接入 Claude Code / Codex 等（第二轮）；Client 侧 `fs/*` `terminal/*` 委托；用 Toonflow provider 给外部 pi 配 Key；Web/远程一键用用户本机 pi；给 pi 提供第二条工具通道（CLI、prompt 注入工具清单、写配置文件均不做）。

## 架构：能力契约单一事实源 + 标准 MCP 通道

外部 pi 需要的画布/插件能力与内置 Agent 同源。能力定义只写一次，传输按 ACP 标准走。

```
registry（能力定义唯一真源：op / schema / 授权 / 超时类别）
        │  派生一次
        ▼
MCP server「laywork」（stdio，ACP 规范要求的 MUST 传输）
        │  session/new.mcpServers 下发（ACP 标准通道）
        ▼
pi-acp bridge：session 启动时 pi.registerMcpServer()（内存注册，不落盘）
        ▼
pi 原生 MCP 工具（exposure: codemode，schema 不常驻）
        ▼
dispatcher.invoke(op, input)
   参数校验 · 工作区授权 · 超时 · 错误归一 · 审计
        ▼
页面控制通道（callControl）— 唯一执行点
        ▼
     Toonflow 页面 / 插件
```

### 不变量（评审时逐条检查）

1. `registry` 只描述能力：名称、描述、入参/出参 schema、是否需要页面、超时类别、授权要求。不含传输、进程、HTTP 概念。
2. `dispatcher` 是唯一执行入口；`callControl` 只在 dispatcher 之下出现一次，MCP server 不得直连页面。
3. 对 pi 只有**一条工具通道**：`session/new.mcpServers`。不写 `~/.pi/agent/mcp.json`、不写 `.pi/mcp.json`、不注入工具清单或 schema、不提供 CLI。系统提示词、技能清单与全局规范属行为约定而非工具通道，经 pi 原生 `--system-prompt` / `--append-system-prompt` 参数下发。
4. 工具 schema 只存在一份：`apps/server/src/agent/ops/mcpAdapter.ts` 是唯一生成者；`apps/server/src/utils/mcp/tools.ts` 只调用它，不再手写声明。
5. ACP 模块不 import 操作平面的实现文件；两者唯一的耦合是建会话时把 MCP 配置当作**数据**放进 `session/new` 参数。
6. MCP server 不含业务判断：只做协议编解码、调 dispatcher、把结果与错误码翻译成 MCP 响应。

### 为什么是这条通道（已否决项留档）

`session/new.mcpServers` 是 ACP 规范定义的工具通道（v1 必填、v2 可选；stdio 为 MUST）。早期曾以三条理由否决它，现逐条消解：

| 当初的顾虑 | 现在的答案 |
| --- | --- |
| 需要用户执行 `pi mcp add` 外部命令 | 配置由 Client 在 `session/new` 下发，用户零操作 |
| 条目写死在用户全局文件、随端口漂移陈旧 | bridge 用 `pi.registerMcpServer()` 内存注册，不落盘、每次会话重建 |
| 工具 schema 常驻上下文 | pi 的 `exposure: "codemode"` 把 MCP 工具折叠成代码 API，只保留一句描述 |

因此透明通道不需要 backup：**标准路径就是唯一路径**。

### MCP 通道契约

- 传输：stdio。server 条目取 `utils/mcp/runtime.ts` 的 `stdio`（`command` + `args`），补 `name: "laywork"`；`env` 按 ACP 的 `EnvVariable[]`（`{ name, value }[]`）构造，不复用其它形状。
- 运行时：`command` 必须是能执行 stdio 入口的运行时。已实测桌面端 `build.mainProcess: "bun"`，`process.execPath` 即 bundle 内 bun，可直接执行 `stdio.js`；`initializeMcpRuntime` 仍显式传 bun，避免上游改运行时后静默失效（Plan P0）。
- 凭据：Laywork MCP 的 token 在 `--runtime` 指向的运行时文件内（0600），不进 `args` 明文、不进 `env`。
- server 名：`laywork`。工具名 = op 点分名转下划线（`canvas.getState` → `canvas_getState`），映射只在 `mcpAdapter.ts` 一处。
- 暴露：`exposure: "codemode"`；pi 把工具折叠成代码 API，只保留一行描述，参数细节按需获取，避免 schema 常驻上下文。
- 大输出：超过阈值（默认 32 KB）落工作区临时文件，工具返回路径 + 摘要，避免灌满上下文。
- 错误：MCP 响应 `isError: true`，首行为 `code: message`（`invalid_input` / `unauthorized` / `page_unavailable` / `timeout` / `internal`），其余为人类可读说明；不吞异常、不返回空成功。
- 无页面时：`requiresPage` 的能力返回 `page_unavailable`，pi 能看到原因并自行改换策略。

### 适配器：`packages/piAcpAdapter`

`pi-acp@0.0.34` 把 `mcpServers` 存进 session state 后丢弃，不符合规范的 stdio MUST。首轮改为**随应用发布的 vendored fork**（MIT，保留原 LICENSE 与上游 README）：

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 透传 MCP 配置 | `session/new` 处理 | 收到的 `mcpServers` 序列化进子进程环境变量 `LAYWORK_MCP_SERVERS` |
| 注册 MCP | `PiRpcProcess.spawn` | spawn 参数追加 `-e <包内>/bridge/registerMcp.js`，env 原样透传 |
| bridge | `bridge/registerMcp.js` | 读环境变量；把 ACP 的 `env` 数组转成 `config.env` 对象；逐个 `pi.registerMcpServer(name, config)`；注册后用 `pi.getMcpServers()` 自检，缺失只在日志与 UI 提示，不阻塞会话；无配置时静默返回 |

选固定 bridge 而非临时文件：不落盘、不清理、无路径转义问题。

不 fork 整个 ACP 协议栈：只 patch 上述两处，其余逻辑随上游同步；每次升级 `pi-acp` 后重放 patch（Plan P9 记录差异）。

## 功能对等矩阵

内置 Agent 的能力基线见 `apps/server/src/agent/runtime/{index,types}.ts`、`apps/server/src/agent/bridge/*`、`apps/server/src/agent/tools/index.ts`。

### 会话与历史

| 能力 | 外部 pi 实现 | 判定 |
| --- | --- | --- |
| 新建会话（绑定工作区目录） | `session/new`（`cwd` = `resolveWorkspace` 结果） | 必须 |
| 历史列表（按工作区） | `session/list`（`sessionCapabilities.list` 已声明） | 必须 |
| 打开历史会话并继续 | `session/load`（`loadSession: true`） | 必须 |
| 会话改名 | `session/set_session_name` | 必须 |
| 停止本回合 | `session/cancel` + 超时杀进程树 | 必须 |
| 关闭会话 / 退出回收进程 | close 接口 + 进程树 kill | 必须 |
| 删除单条消息 / 编辑后重发 | ACP 无对应方法 | **不支持**（保留「新建会话」替代） |

### 推理与展示

| 能力 | 外部 pi 实现 | 判定 |
| --- | --- | --- |
| 流式助手文本 | `session/update.agent_message_chunk` → `{type:"text"}` | 必须 |
| 思考过程 | 适配器目前多并入 message chunk | 受限：并入正文展示 |
| 工具调用卡片（名称/参数/状态/结果） | `tool_call` / `tool_call_update` → `{type:"tool"}` | 必须 |
| 错误事件 | 协议 / 进程错误 → `{type:"error"}` | 必须 |
| 上下文用量（总量） | `usage_update` → `{type:"stats"}` | 必须 |
| 上下文分段（system/rules/skills/tools/mcp/conversation） | `usage_update` 不含分段 | 受限：仅总量 |
| 压缩（compaction）指示 | 适配器不发对应 update | **不支持**（pi 侧自动压缩仍生效） |
| 可用命令 / 技能清单 | `available_commands_update` | 受限：仅展示，不做命令面板 |
| 吞吐（tokens/s） | `usage_update` 只给已用/总量，无耗时 | 受限：不显示 |
| 用户消息回显 / `accepted` / `session` 元信息 | 由服务端在发消息时本地生成，与 ACP 无关 | 必须 |
| 子 Agent 简报（`report`） | 无对应事件 | **不支持** |

### 模型与推理档位

| 能力 | 外部 pi 实现 | 判定 |
| --- | --- | --- |
| 选择模型 | `session/new` 返回 `models` + `session/set_config_option` | 必须 |
| 选择思考档位 | `modes`（`low/high/max`）+ `session/set_mode` | 必须 |
| 记住上次选择 | 前端本地状态 | 必须 |
| 隐藏模型下拉 | 不做：ACP 有模型与档位，隐藏等于削减能力 | 禁止 |

### 工具与画布

矩阵中的画布与插件能力全部来自 §架构 的操作平面，经 `session/new.mcpServers` 下发，用户零配置。前提是 pi 的 MCP 支持未被禁用（`--no-mcp` 或 `extensions: ["-builtin:mcp"]` 时工具不可见，属于用户侧强限制）。

| 能力 | MCP 工具（由 op 派生） | 判定 |
| --- | --- | --- |
| 读/写/改工作区文件 | pi 自带 file/bash 工具（cwd = 工作区） | 必须 |
| 画布/项目状态读取 | `canvas_getState`、`doc_get` | 必须 |
| 打开文档、切换面板 | `app_openProject`、`doc_open`、`app_switchPanel` | 必须 |
| 写画布文档 | `doc_write` | 必须 |
| 画布节点操作（创建/修改/连线等） | 插件工具组，经 dispatcher → `callControl` 由页面执行 | 必须 |
| 媒体生成（图/视频/语音等） | 插件工具组（`tools` 目录下已注册的生成能力），`timeoutClass: long` | 必须 |
| 应用级操作 | `app_operations`、`app_call` | 必须 |
| 子 Agent 委派 | `agent_run`（委托内置 Agent） | 受限：可委派，无子 Agent 面板事件 |
| 提问（question） | `user_ask`（`timeoutClass: interactive`） | 必须 |
| 长期记忆 | Toonflow memory 文档只读注入追加提示词段；memory 工具不外露 | 对等（只读，无写入工具；开关沿用个性化设置） |
| 技能 / 规则 | Laywork 提示词、`available_skills` 清单与全局协作规范经 pi 原生 `--system-prompt` / `--append-system-prompt` 注入；`AGENTS.md` 仍由 pi 自读 | 对等：清单进提示词，正文按需 `read`（Plan P6 结论：pi 不扫描 Laywork 技能目录，故不用首条 prompt 兜底） |
| 系统提示词（默认 / 用户自定义） | `apps/server/src/agent/acp/pi/acpContext.ts` 用同一个 `createAgentContext` 渲染后写入提示词文件，由 `piCommand.sh` 传入 | 必须 |
| 全局协作规范 | personalization 全局 AGENTS.md 并入追加提示词段 | 必须 |
| 权限审批 | `pi-acp` **未实现** `session/request_permission`；pi 无逐次审批 | **不支持**（无相关接口与 UI） |
| 子 Agent 进度面板 | 无对应事件流 | **不支持**（并入工具卡片） |

### 输入

| 能力 | 外部 pi 实现 | 判定 |
| --- | --- | --- |
| mention 工作区文件 / 资源 | 复用 `mentions.ts` 生成快照，prompt 内以路径引用 | 必须 |
| 图片附件 | ACP `promptCapabilities.image` 直接传 | 必须 |
| 视频 / 二进制附件 | 落工作区并以路径引用（pi 自读） | 受限 |
| 文本附件 | 全文内联进 prompt | 必须 |
| 语音输入 | 前端本地 ASR（`useVoiceInput`），与后端无关 | 必须（无需改动） |
| 非本机门禁 | `isLocalWorkspaceRequest` | 必须 |

## Tech Stack

| 层 | 技术 |
| --- | --- |
| 桌面 | Electrobun（`apps/desktop`），内嵌 `@toonflow/server` |
| 协议 | Agent Client Protocol（JSON-RPC 2.0 / stdio），`@agentclientprotocol/sdk` |
| 外部 Agent | `packages/piAcpAdapter`（vendored fork）→ `pi --mode rpc` |
| 工具通道 | ACP `session/new.mcpServers` → 本机 MCP server（stdio）→ `callControl` |
| 操作平面 | 单一 `registry` + `dispatcher`；MCP server 是它唯一的对外适配器 |
| 前端 | Vue 3 + 现有 `floatingAgent` / `conversation` NDJSON 流 |
| 配置 | 现有 `conf` → `settings.json` 中的 `acp` 段 |
| 语言 | TypeScript；命名与文件遵循仓库 `AGENTS.md`（小驼峰） |

## Commands

```bash
# 桌面开发（验收主路径）
bun run dev:desktop

# 服务端（可选：curl 验 API 旁路）
bun run --filter '@toonflow/server' dev

# 路由文件增删后
cd apps/server && bun run routes

# 类型检查（改 server 后）
cd apps/server && bun run typecheck

# 适配器构建（改 packages/piAcpAdapter 后）
bun run --filter '@toonflow/pi-acp-adapter' build

# 前置环境冒烟（不改代码也可做）
which pi && pi --version
```

禁止新增测试脚本 / `.test.ts` / `check*.ts`（见 Boundaries）。

## Project Structure

```text
docs/acpPi/
  spec.md                 → 本规格（需求真源）

packages/piAcpAdapter/    → 新建：vendored fork（MIT），仅 patch MCP 透传
  src/                    → 上游源码，改动集中在 session/new 与 spawn
  bridge/registerMcp.js   → 读 env → pi.registerMcpServer()
  LICENSE                 → 上游 MIT，保留

apps/server/src/agent/ops/        → 新建：操作平面（传输无关）
  registry.ts                → 能力定义唯一真源（schema + 授权/超时类别）
  dispatcher.ts              → 唯一执行入口：校验/授权/超时/错误归一
  mcpAdapter.ts              → 由 registry 派生 MCP 工具声明（替换手写部分）

apps/server/src/agent/acp/       → 新建：Client 运行时（旁路，不改 runtime/index.ts 主路径）
  index.ts
  process.ts                 → spawn / 杀进程树
  client.ts                  → initialize / session_* / set_config_option / set_mode
  mapEvents.ts               → session/update → AgentEvent
  sessions.ts                → 进程内会话句柄表（非历史真源）
  settings.ts                → 读 conf.acp
  mcpConfig.ts               → 生成 session/new 的 mcpServers（来自 utils/mcp/runtime.ts stdio 形态）

apps/server/src/routes/agent/acp/  → 新建：一接口一文件
  status.ts | create.ts | message.ts | stop.ts | config.ts
  sessions.ts | load.ts | rename.ts | close.ts

apps/web/src/components/agent/
  conversation/messageInput.vue  → modelPopover 左侧 agent 选择器
  index.vue / conversation.vue / menu.vue / replyStream.ts  → kind 分流与历史标记
```

## Code Style

遵循根目录 `AGENTS.md`：小驼峰文件/组件/类名 DOM；Vue 顺序 template → script → style；属性小驼峰；自有组件标签小驼峰；server 一路由一文件；磁盘经 `@toonflow/file`；工作区路径经 `resolveWorkspace`。

示意（事件映射，非最终实现）：

```ts
// apps/server/src/agent/acp/mapEvents.ts
import type { AgentEvent } from "@/agent/runtime/types";

export function mapAcpUpdate(update: unknown, blockId: string): AgentEvent[] {
  // agent_message_chunk → { type: "text", blockId, delta }
  // tool_call / tool_call_update → { type: "tool", blockId, tool: { id, name, args, status } }
  // usage_update → { type: "stats", ... }
  // 无法识别则返回 []
  return [];
}
```

ACT：ACP 会话句柄表仅进程内内存；历史真源是 ACP `session/list`，本表只存子进程与 runId 映射——重启后由 `session/load` 恢复。

## Testing Strategy

| 层级 | 策略 |
| --- | --- |
| 自动化单测 / 新测试文件 | **不做**（仓库禁止新增测试模块） |
| 类型 | `apps/server` 下 `bun run typecheck`；改路由后 `bun run routes` |
| 协议冒烟 | 本机对 `piAcpAdapter` 做 initialize / session/new / prompt（Plan §4.0） |
| 工具通道冒烟 | 建会话后 pi 能列出并调用 `laywork` 工具（`pi mcp list` 不加载 extension，看不到内存注册）；调一次 `canvas_getState` |
| 功能验收 | 桌面端手动：Plan §4.1–4.6（门禁、主路径、工具面、历史与模型、异常、回归） |
| 完成判据 | § Success Criteria 全部满足，并留下 Plan §4.7 记录 |

## Boundaries

**Always**

- ACP 走 `apps/server/src/agent/acp/` 旁路，不塞进 `runtime/index.ts` 的 `run()`。
- `cwd` 必须经 `resolveWorkspace`；仅本机工作区请求可 spawn（`isLocalWorkspaceRequest`）。
- 工具只经 `session/new.mcpServers` 下发；MCP server 只调 dispatcher，不直连页面。
- 前端 Agent 与 Model 分层：选择器在 `modelPopover` **旁边**；pi 的模型/档位来自 ACP `configOptions` / `modes`。
- 会话 `kind: "builtin" | "acpPi"`；已绑定后端的会话禁止原地改 kind（改选 = 确认后新建）。
- 同一工作区禁止 ACP 会话与内置 Agent 会话**同时**运行：外部 pi 不遵守进程内文件锁，并发写会丢数据。
- 关闭会话 / 停止超时 / 应用退出时回收 **进程树**（adapter + 子 `pi`）。
- 对外文案区分 A2A「远程 Agent」与「本机 Coding Agent / ACP」。
- 改动后做必要 typecheck / routes；验收按手动清单，不把编译通过当成功能通过。

**Ask first**

- 增加除 `@agentclientprotocol/sdk` 以外的新依赖，或升级 `packages/piAcpAdapter` 的上游基线。
- 改变 API 路径前缀或 `AgentEvent` 联合类型的破坏性扩展。
- 改变 MCP 工具命名规则（op → 工具名映射）或 server 名 `laywork`。
- 在 registry 新增需要用户交互的能力类别。

**Never**

- 实现 ACP Agent 对外服务、或首轮接入 Claude/Codex。
- 写 `~/.pi/agent/mcp.json`、写工作区 `.pi/mcp.json`、设置 `PI_CODING_AGENT_DIR`。
- 给 pi 提供第二条工具通道（CLI、prompt 注入工具清单、垫片脚本）。
- 实现或依赖 `session/request_permission`（适配器未实现）。
- 用 Toonflow 的 API Key / provider 配置驱动外部 pi。
- 把外部 pi 会话写入并按内置 `.agent/sessions/*.jsonl` 语义解析。
- 静默联网安装适配器（不执行 `npx -y`，适配器随应用发布）。
- 新增 `.test.ts` / `.spec.ts` / `check*.ts` 等测试或自检模块。
- 在非本机/Web 远程场景假装支持本机 spawn。

## UX（已定）

```text
输入区工具栏：
[ Agent: 内置 Agent | 外部 pi（ACP) ]  [ 模型▾（内置=Toonflow 模型；pi=ACP models） ]  附件 … 发送
```

| 场景 | 行为 |
| --- | --- |
| 空会话改 Agent | 直接切换；下一条按新 kind 建会话 |
| 已有消息/已绑定 session 时改 Agent | 确认后新建对话；禁止改当前会话 kind |
| 历史切换 | 历史按 kind 标记；选择器与模型区随会话更新 |
| 选中外部 pi | 模型下拉切换为 ACP `models`，思考档位切为 `modes` |
| 受限项 | 上下文用量只显示总量；无权限弹窗；无子 Agent 面板 |
| MCP 未连接（pi 侧禁用 MCP、bridge 未加载） | 会话顶部提示「画布工具不可用」并给出原因；纯对话不阻断 |
| 非桌面本机 | 「外部 pi」隐藏或禁用 |
| 默认 | `内置 Agent`；记住上次选择（本地 UI 状态） |

## API（草案，实现可微调文件名，语义不变）

均需本机工作区门禁；流式接口 NDJSON，事件为现有 `AgentEvent` 子集。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/agent/acp/status` | 是否允许、适配器可解析性、MCP 配置生成结果、`protocolVersion` |
| POST | `/api/agent/acp/create` | `directory` → `session/new`（附 `mcpServers`）；返回本地句柄 + `sessionId` + `configOptions` |
| POST | `/api/agent/acp/message` | 发 prompt（含附件/mention 展开）；流式 `AgentEvent`；头 `X-Toonflow-Agent-Run` |
| POST | `/api/agent/acp/stop` | `session/cancel`，超时杀进程树 |
| POST | `/api/agent/acp/config` | `set_config_option`（模型）/ `set_mode`（思考档位） |
| GET | `/api/agent/acp/sessions` | `directory` → `session/list` 历史列表 |
| POST | `/api/agent/acp/load` | `session/load` 恢复历史会话 |
| POST | `/api/agent/acp/rename` | `set_session_name` |
| POST | `/api/agent/acp/close` | 关会话并杀进程树 |

统一用 POST，不混用 DELETE；`session/request_permission` 相关接口不存在。

## 配置（草案）

```ts
acp: {
  enabled: boolean;
  agents: {
    pi: {
      command: string;                 // 适配器入口；留空则用随包的 packages/piAcpAdapter
      env: Record<string, string>;     // 如 PI_ACP_PI_COMMAND 指定本机 pi
      piCommand: string;               // pi 可执行文件；留空则用 PATH 上的 pi
    };
  };
}
```

启动顺序：`command` 显式配置 → 随包适配器。不存 pi 的 API Key；凭据在 pi 自有配置。不联网安装任何与 ACP 相关的依赖。

## Success Criteria

桌面端打开**本地**工作区后：

1. Agent 选择器可选「外部 pi（ACP）」；非本机环境不可用。
2. 发送文本 prompt，UI **流式**显示回复并以 `done` 收束；停止可中断本回合。
3. 模型下拉展示 ACP `models`，切换后生效；思考档位展示 `modes` 并可切换。
4. 要求 pi 在工作区写文件时，磁盘出现正确内容。
5. 新建会话后 pi 能发现并调用 `laywork` 工具，且**没有任何文件被写入或修改**于 `~/.pi` 或工作区 `.pi`。
6. 一次会话内可完成「读画布状态 → 改画布/生成素材 → 询问用户」类任务，全程不需要用户配置任何东西。
7. 工具调用失败时（非法参数、未授权路径、页面不可用、超时）错误码在工具卡片里可见，pi 能据此改换策略。
8. mention 工作区文件、图片附件在 prompt 中正确生效。
9. 历史列表可见并可用 `session/load` 继续；会话可改名。
10. 同工作区已有内置 Agent 会话在跑时，启动 ACP 会话被拒绝并给出明确提示。
11. 关闭会话或退出应用后，无残留 adapter / `pi` 僵尸进程。
12. 内置 Agent 主路径（发消息、停止、画布工具）回归不受影响。
13. 已绑定会话时切换 Agent 会新建对话，不会改掉原会话 kind。
14. 矩阵中「受限/不支持」项在 UI 有对应提示，不存在静默缺失。

未满足任一条则首轮未完成。

## 已知不支持项（必须在实现中显式处理）

| 项 | 原因 | 处理 |
| --- | --- | --- |
| 权限审批 | `pi-acp` 未实现 `session/request_permission` | 无接口、无 UI；文档写明 pi 在本机信任模型下直接执行 |
| 删除/编辑单条消息 | ACP 无方法 | 只提供新建/切换会话 |
| compaction 指示 | 适配器无事件 | 不显示；pi 侧仍自动压缩 |
| 上下文分段统计 | `usage_update` 无分段 | 仅显示总量 |
| 子 Agent 面板 | 无事件流 | 委派以普通工具卡片呈现 |

## 已定事项

1. **工具通道**：只走 ACP `session/new.mcpServers` + 本机 MCP server（stdio）。不写 pi 任何配置文件、不用 prompt 传工具清单或 schema、不做 CLI；行为约定经 pi 原生 `--system-prompt` / `--append-system-prompt` 下发。适配器补丁随应用发布。
2. **能力契约**：单一 registry；MCP 工具声明与内置 tools 均从它派生，不维护第二份。
3. **`user.ask`**：作为操作平面的 `interactive` 类别提供，复用现有 `askUser` 插件与卡片；MCP 调用阻塞等待答案，超时按类别处理。
4. **同工作区**：严格串行。另一侧有活跃 run 时返回 409，停止后可立即重试。
5. **记住上次 Agent 选择**：做，存 `localStorage`（与本项目其他前端偏好一致），不进 `settings.json`。

## 假设

1. 首轮只验收 **桌面端本机**；纯 Web / 移动端不提供 ACP spawn。判定沿用 `isLocalWorkspaceRequest`（桌面端与服务器本机放行，与 `routes/skills/*` 一致）。
2. 仓库内的 `@earendil-works/pi-coding-agent` **库** ≠ PATH 上的 `pi` **CLI**；用户须自备可运行的 `pi`（实测 1.5.0 可用）。
3. `pi-acp` 不走 ACP `fs/*`，文件由 pi 在 cwd 直接读写；信任模型与「本机已授权工作区」一致，但**不共享** Toonflow 的进程内文件锁。
4. 内置 Agent 与 ACP 会话隔离存储与列表展示；历史可并列，语义不合并。
5. pi 的 MCP 支持默认启用；用户若用 `--no-mcp` 关闭，画布工具不可见，属于用户侧强限制，UI 提示即可。
6. **技术前提（未验证，以 P0/P4 为准）**：`pi -e <bridge>` 在 `--mode rpc` 下加载 extension；`pi.registerMcpServer()` 在 RPC 会话内生效；`getMcpRuntime().stdio` 的 `command`/`args` 能在桌面端被 spawn 并完成 MCP 握手。三者任一不成立，回到对应环节修正，不引入第二通道。
7. 验证以手动清单为准，不新增自动化测试文件。