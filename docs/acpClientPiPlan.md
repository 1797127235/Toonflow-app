# ACP Client 首轮计划：接入 pi

状态：设计稿，尚未实现。
目标：Toonflow 作为 **ACP Client**，在桌面端工作区内嵌跑 **pi**，且在该会话里达到与内置 Agent **功能对等**的画布协作能力（见 `docs/acpClientPiSpec.md` §功能对等矩阵）。
不替代现有内置 Agent（`@earendil-works/pi-coding-agent` 进程内 `run()`）；二者并行，会话与进程隔离。

相关背景：

- ACP 规格：<https://agentclientprotocol.com>（`session/new.mcpServers` 是规范定义的工具通道，stdio 为 MUST）
- TypeScript SDK：`@agentclientprotocol/sdk`
- pi 适配器：上游 `pi-acp@0.0.34`（stdio JSON-RPC；内部再拉起 `pi --mode rpc`），本轮以 vendors fork 形式随应用发布
- 仓库现状：无 ACP 实现；已有 A2A / MCP / 内置 Agent HTTP NDJSON 流；**已有 Laywork MCP Server**（`apps/server/src/utils/mcp/`），对本机第三方 coding 工具暴露画布与插件能力

---

## 1. 首轮范围

### 1.1 做

| 项 | 说明 |
| --- | --- |
| 角色 | 仅做 **ACP Client**；不做 ACP Agent 对外暴露 |
| 首个 Agent | 仅 **pi**，经随包的 `packages/piAcpAdapter` |
| 运行环境 | **桌面端本机工作区**（Electrobun + 本机 spawn）；非本机 / 移动端入口拒绝或灰掉 |
| 协议控制面 | `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/load`、`session/list`、`session/set_session_name`、`session/set_config_option`、`session/set_mode`；消费 `session/update` |
| 工具通道 | ACP `session/new.mcpServers` → 本机 MCP server「laywork」（stdio）→ dispatcher → `callControl`；适配器补丁负责把参数交给 pi |
| 操作平面 | 单一 `registry` + `dispatcher`；MCP 工具声明是它唯一的对外投影 |
| UI | 复用悬浮 Agent 对话壳与 NDJSON 事件形态，会话 kind 标记为 `acpPi` |
| 工作区 | `session/new.cwd` = 当前工作区绝对路径 |

### 1.2 明确不做

- 响应 `session/request_permission`：`pi-acp@0.0.34` 的 `dist/index.js` 中该方法出现 **0 次**，pi 本身也无逐次审批。
- 写 `~/.pi/agent/mcp.json`、写工作区 `.pi/mcp.json`、设置 `PI_CODING_AGENT_DIR`。
- 给 pi 开第二条工具通道（CLI、prompt 注入工具清单、垫片脚本）。
- 删除 / 编辑单条历史消息（ACP 无对应方法）。
- compaction 指示、上下文分段统计、子 Agent 进度面板（适配器无对应事件）。
- 实现 Client 侧 `fs/*`、`terminal/*` 委托（pi-acp 也不走）。
- 把外部 pi 会话写入现有 `.agent/sessions/*.jsonl` 的 pi-SDK 语义。
- Claude Code / Codex / Cursor 等其它 ACP agent（第二轮）。
- 用 Toonflow provider / API Key 配置外部 pi（pi 自有 `~/.pi` 配置与登录）。
- Web 远程一键使用用户本机 `pi`。
- 新增测试文件 / `check*.ts`。

### 1.3 成功标准

等同于 `acpClientPiSpec.md` §Success Criteria（14 条）。**仅「能聊天 + 能改文件」不构成完成**：矩阵中「必须」项全部通过才算首轮完成。

### 1.4 用户在哪选择「外部 pi」（已定）

**主入口：输入区工具栏，放在现有 `modelPopover` 旁边，单独做 Agent 选择器**（不要塞进模型列表里）。

当前助手 UI 分工：

| 区域 | 现有能力 | 与 ACP 的关系 |
| --- | --- | --- |
| 输入区 `modelPopover` 左侧新增 **agent 选择器** | — | **首轮主入口**：`内置 Agent` / `外部 pi（ACP）` |
| 输入区 `modelPopover` | 选 Toonflow provider/model | 内置时显示 Toonflow 模型；选 pi 时展示 ACP `models`（`configOptions`），**不隐藏** |
| 思考档位选择 | 内置使用 `thinkingLevel` | 选 pi 时绑定 ACP `modes`（`set_mode`） |
| 顶栏 `agentMenu` | 新建对话、历史、子 Agent | 新建沿用当前 agent；历史可切换不同 kind 的会话 |
| 历史 popover | 在已有会话间切换 | **支持**内置会话 ↔ ACP 会话换焦点（ACP 历史来自 `session/list`） |

**为什么用「旁边的 agent 选择器」：**

- 模型列表语义是 Toonflow 的 provider；把 pi 塞进去会变成「又一个模型」。
- 输入区是每次说话前的视线落点，发现成本低于把类型藏进「新建」菜单。
- Agent 与 Model 分层：先选跟谁聊，再选模型——pi 的模型由 ACP 提供，不是 Toonflow provider。

**切换规则：**

1. **空会话 / 尚未产生后端会话时**：可直接改 agent；下一条发送按新 kind 建会话。
2. **当前会话已有消息或已绑定 session 时**：改 agent = 结束当前焦点并按新 kind 开一条新会话（可确认「将新建对话」），**禁止**原地改 kind。
3. **历史切换**：点历史项只切换会话；打开 ACP 会话时选择器显示 `外部 pi` 并拉取 `session/load`。
4. **非桌面本机**：`外部 pi` 隐藏或禁用。
5. **默认**：`内置 Agent`；记住上次选择（本地 UI 状态）。

---

## 2. 架构

```text
[floatingAgent / conversation UI]
        │  HTTP NDJSON（复用 AgentEvent 子集）
        ▼
[apps/server ACP Client 旁路]              [apps/server ops 平面]
  routes/agent/acp/*                        registry（能力契约唯一真源）
        │  控制面：ACP SDK                        │ 派生
        │  建会话时附 mcpServers                    ▼
        ▼                                   mcpAdapter → Laywork MCP server（stdio）
[piAcpAdapter 子进程]                              │ 调
        │  bridge → pi.registerMcpServer()          ▼
        ▼                                   dispatcher.invoke（校验/授权/超时/归一）
[pi]  cwd = 工作区                                 │
        ├─ 自带 file/bash                          ▼
        └─ 原生 MCP 工具 ──────────────▶   页面控制通道 callControl
                                                   │
                                                   ▼
                                           [Toonflow 页面 / 插件]
```

原则：

- **旁路**：不要把 ACP 塞进 `apps/server/src/agent/runtime/index.ts` 的 `run()`。
- **两个平面零耦合**：ACP 只管会话、流式、模型；ops 只管能力。两边**不互相 import**，唯一连接是 `session/new` 参数里的 MCP 配置（数据，不是代码依赖）。
- **契约单一**：registry 是能力的唯一定义；MCP 工具声明从它派生，禁止另写一份。
- **标准通道**：工具只走 `session/new.mcpServers`；不落盘、不注入 prompt、不开第二通道。
- **事件归一**：服务端把 ACP `session/update` 译成现有 `AgentEvent`，前端尽量少改。
- **进程边界**：一个 ACP 会话对应一条适配器连接；停止 = `session/cancel` + 必要时杀进程树。
- **产品边界**：与 A2A「连接远程 Agent」、MCP、安装团队并列，文案使用「本机 Coding Agent / ACP」。

---

## 3. 计划改动

### 3.1 依赖

| 包 | 用途 | 备注 |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | Client API、方法名、流封装 | 加在 `apps/server` |
| `packages/piAcpAdapter` | 外部适配器 | **新建 workspace 包**，包名 `@toonflow/pi-acp-adapter`；基线 `pi-acp@0.0.34`（MIT），保留上游 LICENSE |

仓库内已有 `@earendil-works/pi-coding-agent` **库依赖**，不等于桌面 PATH 上有 `pi` 二进制——验证时必须区分这两点。

`@agentclientprotocol/sdk` 当前未安装：装好后先读导出类型（client 工厂名、`session/new` 参数类型、`mcpServers` 元素结构），再写 `client.ts`，不照文档猜方法名。

### 3.2 后端新建

#### 操作平面（传输无关，先于 ACP 落地）

`apps/server/src/agent/ops/`：

| 文件 | 职责 | 依赖边界 |
| --- | --- | --- |
| `registry.ts` | 能力定义唯一真源：op 名（点分命名空间）、描述、入参/出参 schema、是否需要页面、超时类别、授权要求 | 不 import 任何适配器、HTTP、进程 |
| `dispatcher.ts` | 唯一执行入口：schema 校验 → `resolveWorkspace` 授权 → 超时 → 错误归一 → 审计；`callControl` 只在这里调用 | 只依赖 registry 与现有 bridge |
| `mcpAdapter.ts` | **唯一**生成 MCP 工具声明：从 registry 派生，op 名 → 工具名（`canvas.getState` → `canvas_getState`）；`utils/mcp/tools.ts` 只调用它 | 只依赖 registry |

#### ACP 运行时

`apps/server/src/agent/acp/`（小驼峰目录名）：

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 对外导出：创建连接、发 prompt、取消、配置、销毁 |
| `process.ts` | spawn / 回收适配器；stdio 流接到 SDK；本机门禁 |
| `client.ts` | `acp.client()` 注册 `session/update`；调用 `initialize` / `session/*` / `set_config_option` / `set_mode` |
| `mapEvents.ts` | ACP update → `AgentEvent` |
| `sessions.ts` | `sessionId`、cwd、runId、子进程句柄的**进程内**表（历史真源是 `session/list`） |
| `settings.ts` | 读 conf：启用、adapter 路径、pi 命令、探测结果缓存 |
| `mcpConfig.ts` | 生成 `session/new.mcpServers`：取 `utils/mcp/runtime.ts` 的 stdio 形态，原样转成 ACP 的 `McpServer` 结构 |

`acp/` **不得** import `ops/` 的任何实现文件；`mcpConfig.ts` 只做数据转换。

#### 适配器包

`packages/piAcpAdapter/`：

| 路径 | 改动 |
| --- | --- |
| `src/`（上游源码） | 仅两处 patch：`session/new` 把 `mcpServers` 存进 session；`PiRpcProcess.spawn` 追加 `-e <包内 bridge>` 并透传环境变量 |
| `bridge/registerMcp.js` | 读 `LAYWORK_MCP_SERVERS`，逐个 `pi.registerMcpServer(name, config)`；解析失败只记录，不阻塞会话 |
| `LICENSE` | 保留上游 MIT |

升级上游时重放这两处 patch，差异记录在 §4.0 的 P9。

### 3.3 路由

仅本机工作区请求可访问（复用 `isLocalWorkspaceRequest`）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/agent/acp/status` | 本机是否允许、适配器可解析性、`mcpServers` 生成结果、`protocolVersion` |
| POST | `/api/agent/acp/create` | `directory` → `session/new`（附 `mcpServers`）；返回句柄 + `configOptions` |
| POST | `/api/agent/acp/message` | 发 prompt；NDJSON `AgentEvent` 流；头 `X-Toonflow-Agent-Run` |
| POST | `/api/agent/acp/stop` | `session/cancel` + 超时杀进程树 |
| POST | `/api/agent/acp/config` | `set_config_option`（模型）/ `set_mode`（思考档位） |
| GET | `/api/agent/acp/sessions` | `directory` → `session/list` |
| POST | `/api/agent/acp/load` | `session/load` 恢复会话 |
| POST | `/api/agent/acp/rename` | `set_session_name` |
| POST | `/api/agent/acp/close` | 关闭会话并杀进程树 |

统一 POST（不混用 DELETE）；不存在 permission 接口，也不存在 `/api/ops`（工具只走 MCP）。

### 3.4 事件映射

| ACP `session/update` | → `AgentEvent` |
| --- | --- |
| `agent_message_chunk` | `{ type: "text", blockId, delta }` |
| `agent_thought_chunk`（若出现） | `{ type: "thinking", blockId, delta }`；适配器目前多并入 message chunk |
| `tool_call` / `tool_call_update` | `{ type: "tool", blockId, tool: { id, name, args, status, result } }` |
| `usage_update` | `{ type: "stats", stats }`（仅总量，无分段） |
| `available_commands_update` | 前端命令清单（只展示，不做面板） |
| prompt 返回 | `{ type: "done" }` |
| 协议/进程错误 | `{ type: "error", message }` |

映射注意：

- `userMessage` / `accepted` / `session` 三个事件不来自 ACP，由 `message.ts` 在发消息时本地生成（与内置 `agent.ts` 保持一致），否则前端会缺用户气泡与 runId。
- `report`、`subAgent`、`subAgentEvent`、`canvasCall`、`compaction` 不映射（见 Spec §已知不支持项）。
- `stats.tokensPerSecond` 无数据来源，不下发。
- `replyStream.ts` 要求 `question` 事件必须匹配已存在的 tool part。MCP 工具 `user_ask` 在 pi 侧本来就是一次工具调用，tool part 天然存在；服务端不得凭空注入 question 事件。
- 工具 `blockId` 与 `tool.id` 由 `toolCallId` 派生，保证 `tool_call_update` 能归并到同一卡片。
- 不映射 `plan`、`mode` 通知；没有 `permission` 分支。

### 3.5 操作平面与 MCP 通道

现状问题：能力定义目前散在三处——`utils/mcp/tools.ts`（MCP 工具声明）、`agent/tools/*`（内置）、插件 `createTools`。再手写第二份给 pi 的声明必然漂移。所以先立契约，再由契约投影出 MCP 工具。

#### 分层与依赖方向

```text
registry.ts        （能力契约，唯一真源；无传输概念）
      │ 派生
      ▼
mcpAdapter.ts      （op ↔ MCP 工具名/描述/schema 的映射）
      │
      ▼
utils/mcp/         （现有 Laywork MCP Server：stdio / HTTP，进程内）
      │ MCP 协议
      ▼
piAcpAdapter       （把 session/new.mcpServers 交给 pi）
      │
      ▼
pi（原生 MCP 工具，exposure: codemode）
      │ dispatcher.invoke
      ▼
dispatcher.ts      （校验/授权/超时/归一/审计）
      ▼
bridge/canvas.ts · bridge/question.ts（现有）
```

规则：

- `registry.ts` 不 import 任何适配器；文件中不得出现 HTTP、spawn、进程概念。
- `dispatcher.ts` 是唯一能调用 `callControl` 的地方。
- MCP server 只做协议编解码 + 调 dispatcher，不含业务判断。
- `acp/` 与 `ops/` 互不 import：ACP 只把 `mcpServers` 当数据处理。

#### registry 的能力条目

| 字段 | 说明 |
| --- | --- |
| `op` | 点分命名空间，稳定标识：`canvas.getState`、`doc.write`、`media.generate`、`user.ask`、`agent.run` |
| `title` / `description` | 给模型看的短描述；MCP 工具描述由它生成 |
| `input` / `output` | JSON Schema，唯一校验源（Zod 定义 → 一次转换） |
| `requiresPage` | 是否必须页面在线；`false` 时纯服务端执行 |
| `timeoutClass` | `default` / `interactive` / `long`：超时策略集中在这里 |
| `auth` | `workspace`（须 `resolveWorkspace`）/ `loopback` / `none` |

`timeoutClass` 取代现在两处硬编码 120s（`utils/mcp/control.ts`、`apps/web/src/lib/mcpControl.ts`）；`user.ask` 归 `interactive`，`media.*` 归 `long`。

#### dispatcher 的固定流水线

1. schema 校验（失败 → `error.code = invalid_input`，不产生任何副作用）；
2. 授权（`resolveWorkspace` / 回环判定）；
3. 页面可用性检查（`requiresPage` 且无连接 → `page_unavailable`）；
4. 执行（`callControl` 或服务端函数）；
5. 错误归一：所有失败收敛为 `{ code, message, retryable }`；
6. 审计：`op`、耗时、结果码（不记录参数内容，避免落盘敏感数据）。

#### MCP 工具投影

- 传输：stdio。`command` / `args` 取 `utils/mcp/runtime.ts` 的 stdio 形态，补 `name: "laywork"`；`env` 按 ACP 的 `EnvVariable[]` 构造。
- 运行时约束：`command` 必须是能执行 stdio 入口的运行时。已实测：`electrobun.config.ts` 的 `build.mainProcess: "bun"`，主进程即 bundle 内 bun，`process.execPath` 可执行 `stdio.js`；同文件 `copy` 段 `"build/mcp": "mcp"` 与 `PATHS.VIEWS_FOLDER/../mcp/stdio.js` 对齐。仍建议 `initializeMcpRuntime` 显式传 bun，避免上游改运行时后静默失效。
- server 名：`laywork`；工具名 = op 名把 `.` 换成 `_`（`canvas.getState` → `canvas_getState`）。
- 暴露：`exposure: "codemode"`。pi 把 MCP 工具折叠成代码 API，只保留一行描述，避免 schema 常驻上下文；需要时用 `searchTools()` 或显式调用。
- 大输出：超过阈值（默认 32 KB）落工作区临时文件，工具返回路径 + 摘要。
- 错误：MCP `isError: true`，首行 `code: message`，其余为人读说明；不返回空成功。
- 一次页面只处理一条 pending：`user_ask` 与其它页面命令的互斥写进工具描述，让模型知道要串行。

#### 为什么这条通道是唯一选择

| 早期顾虑 | 现在的答案 |
| --- | --- |
| 要用户执行 `pi mcp add` | `session/new.mcpServers` 下发，用户零操作 |
| 写死用户全局文件、端口漂移陈旧 | `pi.registerMcpServer()` 内存注册，每次会话重建，不落盘 |
| 工具 schema 常驻上下文 | `exposure: "codemode"` 折叠成代码 API |

三害都已消除，因此不再需要旁路通道。

### 3.6 提问（user.ask）

`askUser` 的工具与卡片已存在（`packages/tools/askUser`、`questionCard.vue`），缺的只是纳入操作平面：

- registry 增加 `user.ask`，`timeoutClass: "interactive"`，`input` 对齐现有参数（`title` / `question` / `options` / `fields`）；
- dispatcher 内复用 `bridge/question.ts` 的既有语义（答案 / 跳过 / 取消）；
- MCP 工具 `user_ask` 阻塞到用户回答；返回 `{ answer, values, skipped }`；
- 内置 tools 与 MCP 共用同一条目，无需各自实现；
- 超时后按 `interactive` 类别返回 `{ code: "timeout" }`，由 pi 自行决定是否重问。

注意：`apps/server/src/utils/mcp/tools.ts:122` 目前给 `createTools` 传 `question = undefined`，导致 `askUser` 在 MCP 侧返回空数组。改造后由 dispatcher 注入 question 桥，`askUser` 在 MCP 侧才真正可用。

### 3.7 适配器：vendored fork + bridge

上游 `pi-acp@0.0.34` 的行为（实测）：

- `session/new` 收到 `mcpServers` 后只存 session state；
- `PiRpcProcess.spawn` 的参数固定为 `["--mode", "rpc", "--no-themes"]`，只追加 `--session <path>`；
- 子进程 `env` 直接取 `process.env`。

patch 1（`session/new` 处理）：把 `params.mcpServers` 保留在 session 上。

patch 2（`PiRpcProcess.spawn`）：

```js
const args = ["--mode", "rpc", "--no-themes", "-e", bridgePath];
if (params.sessionPath) args.push("--session", params.sessionPath);
const child = start(cmd, args, {
  cwd: params.cwd,
  stdio: "pipe",
  env: {
    ...process.env,
    LAYWORK_MCP_SERVERS: JSON.stringify(params.mcpServers ?? []),
  },
});
```

`bridge/registerMcp.js`：

```js
const servers = JSON.parse(process.env.LAYWORK_MCP_SERVERS || "[]");
// ACP 的 env 是 [{ name, value }]，pi 的 config.env 是对象。
const toConfig = ({ name, command, args, env = [], cwd }) => ({
  ...(command ? { command, args, cwd } : {}),
  env: Object.fromEntries(env.map(({ name, value }) => [name, value])),
});
export default async function register(pi) {
  for (const server of servers) pi.registerMcpServer(server.name, toConfig(server));
  // 连接失败是静默的：command 不可执行时注册不报错、工具也不出现。
  const names = pi.getMcpServers().map((server) => server.name);
  if (!servers.every((server) => names.includes(server.name))) {
    console.error("MCP 注册失败：", servers.map((server) => server.name));
  }
}
```

为什么不生成临时 extension 文件：不落盘、不清理、无路径转义与权限问题。为什么不写 mcp.json：需要 trusted project，RPC 模式无法交互确认。

已知上限（写进代码注释）：

- `LAYWORK_MCP_SERVERS` 只含 server 配置（command/args/env），不含凭据；凭据在 `--runtime` 文件内。若将来配置里出现敏感项，同用户进程可从 `/proc/<pid>/environ` 读取。
- `pi.registerMcpServer` 的注册不落盘，`pi mcp list` **看不到**（该命令不加载 extension）；验证只能在会话内看工具是否可用。
- bridge 依赖 pi 的 `-e` 加载机制；pi 版本升级后需重跑 §4.0 的 P10。

### 3.8 启动与探测

启动顺序（`settings.ts`）：

1. `acp.agents.pi.command` 显式配置的适配器入口；
2. 随包的 `packages/piAcpAdapter`（`apps/server` 依赖里解析后的入口）。

`pi` 本身：

1. `acp.agents.pi.piCommand` 显式配置的绝对路径；
2. PATH 上的 `pi`。

不联网安装任何与 ACP 相关的依赖；`npx` 路径已移除。

### 3.9 前端改动

| 位置 | 改动 |
| --- | --- |
| `conversation/messageInput.vue` | `modelPopover` 左侧新增 agent 选择器；见 §1.4 |
| `agent/index.vue` / `conversation.vue` | 会话带 `kind: "builtin" \| "acpPi"`；已绑定时切换 agent 新建会话 |
| `agent/menu.vue` | 历史项展示 kind；ACP 历史来自 `/api/agent/acp/sessions` |
| `replyStream.ts` | `acpPi` 走 `/api/agent/acp/*`；事件解析共用 |
| mention / 附件 | 复用现有 `mentionSource` 解析与附件读取；发 prompt 前展开为文本或 ACP content block（图片走 `image`），不把 `@` 原样交给 pi |
| 模型/档位 | 选 pi 时模型下拉改用 `configOptions`，档位用 `modes` |
| 上下文用量 | 分段视图在 pi 会话下退化为总量（不显示空分段） |
| 提示 | MCP 未连接（pi 侧 `--no-mcp`、bridge 未加载）、受限项各一处文案 |
| 设置面板 | adapter 路径 / pi 路径 + status 探测结果；不提供「接入画布工具」按钮（无需用户操作） |
| 非桌面 / 非本机 | agent 选择器里禁用/隐藏「外部 pi」 |

### 3.10 配置（conf）

```ts
acp: {
  enabled: boolean;
  agents: {
    pi: {
      command: string;                 // 适配器入口；留空用随包实现
      piCommand: string;               // pi 可执行文件；留空用 PATH
      env: Record<string, string>;     // 透传适配器；PI_ACP_PI_COMMAND 变量名待核对 pi-acp 源码
    };
  };
}
```

不要把密钥写进 conf；pi 凭据留在 pi 自己的配置目录。

### 3.11 进程、安全与并发

- 仅 `getRuntimePlatform()` 允许本机 spawn 的环境启用（对标 MCP：移动端禁本地 stdio）。
- `cwd` 必须经 `resolveWorkspace`；禁止把未授权目录传给 `session/new`。
- pi **不**使用 ACP `fs/*`，文件由 pi 在 cwd 下直接改：接受「与内置 Agent 同等的本机信任」，UI 写明。
- **并发保护（必须实现，不是提示）**：外部 pi 不遵守 `lockWorkspaceFiles`。`agent/runtime/runs.ts` 现有 `agentRuns = Map<runId, { cwd, abort, finished }>`，只有 `registerAgentRun` / `stopAgentRun`，需补一个 `hasActiveRun(cwd)`（约 5 行）；ACP 的 prompt 期间同样调 `registerAgentRun(cwd, abort)`，并把返回的 `id` 作为对外 `X-Toonflow-Agent-Run`——两套 id 必须同一个，否则 `stopAgentRun` 停不掉 ACP run。冲突时对 ACP 创建/发消息返回 409 并提示「该工作区有会话正在运行，请先停止」，停止后可立即重试。
- 应用退出、会话关闭、`stop` 超时：确保杀掉进程树（适配器 + 其子 `pi`）。
- `cwd` 变更（切换工作区）必须新建会话，不允许复用旧连接。

### 3.12 明确不改 / 少改

- 不改 `runtime/index.ts` 主路径行为。
- 不改 A2A、`teams`、MCP 协议实现。
- 唯一触碰 MCP 的地方：`utils/mcp/tools.ts` 的工具声明改为从 registry 派生（对外工具名与参数不变，纯重组）；`createTools` 的 `question` 参数改由 dispatcher 注入。
- 不把 ACP 伪装成 A2A connect。
- 不新增测试文件 / `check*.ts`；验证用手动步骤（见下节）。

---

## 4. 验证清单

不新增自动化测试模块。以下均在真实桌面环境手动完成；每条记录「通过 / 失败 / 受阻」与现象。

### 4.0 前置探测（不写业务代码也可先做）

| # | 步骤 | 期望 |
| --- | --- | --- |
| P0 | 用 `status.stdio` 的 `command`/`args` 手工 spawn，发 `initialize` + `tools/list` | 能完成 MCP 握手并列出工具；已于 2026-11-07 用临时 MCP HTTP 端点 + 0600 runtime 文件实测通过 |
| P1 | `which pi && pi --version` | 能跑；实测 1.5.0 可用 |
| P2 | 对 `packages/piAcpAdapter` 入口发 `initialize` | 返回含 `protocolVersion` 的 result，且 `agentCapabilities.loadSession === true` |
| P3 | 同连接 `session/new`（cwd=临时空目录）→ `session/prompt` | 有 `session/update`；能 Ctrl+C 退出 |
| P4 | `session/new` 带一个临时 stdio MCP server，会话内让 pi 列出工具 | 能看到该 server 的工具；探测时 stdin 须保活（EOF 即退出，异步回调来不及执行） |
| P5 | 终端直接 `pi` 跑一轮 | 模型/登录已配置，否则 Client 接上也会失败 |
| P6 | 在带 `skill/<name>/SKILL.md` 的工作区里跑 `pi`，问它有哪些技能 | 确认 pi 是否扫描项目 `skill/`；不读则走 §4.3 M8 的处理 |
| P7 | 不传 `mcpServers` 建会话 | 无 `-e` 相关报错，会话可正常对话 |
| P8 | `pi --help` 复核 | 仍无 `--mcp-config` 类参数；工具注入只能靠 `-e` + `registerMcpServer` |
| P9 | 对比 patch 与上游 diff | 只有 `session/new` 与 `spawn` 两处；升级后重放。另核打包脚本的 `bun run --filter @toonflow/mcp build`（实测报 `ENOENT`），确认产出 `build/mcp/stdio.js` |
| P10 | pi 升级后重跑 P4 | `-e` 与 `registerMcpServer` 仍可用 |

P0–P5 失败则先修环境，不进入产品改动验收。

### 4.1 门禁与配置

| # | 步骤 | 期望 |
| --- | --- | --- |
| G1 | 非本机工作区请求打 ACP 创建/发消息 | 403 或明确错误，不 spawn |
| G2 | 移动端打开入口 | 不可用 |
| G3 | 适配器路径错误时 `status` | 返回可展示原因，不抛崩服务 |
| G4 | 配置自定义 `piCommand` 后 `status` | 指向自定义 pi |
| G5 | `status` 返回的 `mcpServers` | 含 `laywork`、stdio、绝对路径，无临时文件依赖 |

### 4.2 会话主路径

| # | 步骤 | 期望 |
| --- | --- | --- |
| S1 | 桌面打开本地工作区，选 pi ACP 新建会话 | 返回句柄；存在适配器（及子 `pi`） |
| S2 | 发「只回复 pong」 | 流式文本 + `done` |
| S3 | 发「在工作区根创建 `acpSmoke.txt` 写入 hello」 | 磁盘出现该文件且内容正确 |
| S4 | 回合中点停止 | 流结束；不再继续写文件 |
| S5 | 关闭会话 / 关面板 | `ps` 确认无适配器/`pi` 残留 |
| S6 | 同会话连续两轮 prompt | 第二轮可用，不新建僵尸进程 |

### 4.3 工具面与画布（本轮成败关键）

| # | 步骤 | 期望 |
| --- | --- | --- |
| M1 | 新建 ACP 会话后问 pi「你现在有哪些画布相关工具」 | 能列出 `canvas_*` / `doc_*` 等 `laywork` 工具（codemode 下经 `searchTools` 或代码 API） |
| M2 | 检查 `~/.pi/agent/mcp.json` 与工作区 `.pi/` | **不存在**新增或修改；`mtime` 未变；且 `mcp.json` 里没有同名 `laywork`（同名会覆盖内存注册） |
| M3 | 「读一下当前画布有哪些节点」 | 返回真实节点（经 MCP → dispatcher → `callControl`） |
| M4 | 「在画布上新建一个节点并写入文本」 | 画布出现节点，内容正确 |
| M5 | 「生成一张图片并放到画布」 | `long` 类别超时生效；素材落工作区并上画布 |
| M6 | 让 pi 用非法参数调用 `doc_write` | 工具返回 `isError` 且首行 `invalid_input`，无副作用 |
| M7 | 「问我一个问题再继续」 | 弹卡片，回答后工具继续；超时返回 `timeout` |
| M8 | 工作区 `skill/` 下有技能时发消息 | pi 能用该技能；不能用则把技能文本注入首条 prompt（与 §3.5 的通道无关） |
| M9 | 应用未运行 / MCP 端口不可达 | 工具调用返回可读错误，pi 说明「画布不可用」，不伪装成功 |

### 4.4 历史与模型

| # | 步骤 | 期望 |
| --- | --- | --- |
| H1 | 打开历史列表 | 来自 `session/list`，按工作区过滤 |
| H2 | 打开一条旧会话继续发消息 | `session/load` 生效，上下文延续 |
| H3 | 会话改名 | `set_session_name` 生效，列表同步 |
| C1 | 模型下拉 | 展示 ACP `models`，不显示 Toonflow 模型 |
| C2 | 切换模型后发消息 | 生效（`set_config_option` 返回新 `configOptions`） |
| C3 | 切换思考档位（low/high/max） | 生效（`set_mode`） |
| C4 | 切回内置会话 | 模型下拉恢复 Toonflow 模型，档位恢复 `thinkingLevel` |

### 4.5 异常与回收

| # | 步骤 | 期望 |
| --- | --- | --- |
| E1 | 故意杀掉适配器子进程 | UI 收到 error；可关闭会话；server 不崩 |
| E2 | cwd 传未授权目录 | 拒绝，不 spawn |
| E3 | prompt 过程中断开 HTTP 客户端 | 服务端 cancel/回收，无残留进程 |
| E4 | 同工作区内置 Agent 运行中再建 ACP 会话 | 409 + 明确提示（反向亦然） |
| E5 | 长时间空闲后发消息 | 连接仍可用（或按设计重建并提示） |
| E6 | 用户以 `--no-mcp` 启动 pi | 会话可聊，画布工具不可见，UI 有提示（不视为本方案失败） |

### 4.6 回归

| # | 步骤 | 期望 |
| --- | --- | --- |
| R1 | 内置 Agent 发消息、停止、画布工具 | 与改前一致 |
| R2 | MCP 列表 / stdio MCP / 对外工具名与参数 | 与改前一致（声明改为 registry 派生） |
| R3 | A2A 设置页开可关 | 不因 conf 新键崩溃 |
| R4 | 设置页保存 ACP 配置后重启 | 配置回读正确 |

### 4.7 验证记录模板

```text
日期：
桌面版本 / commit：
本机 pi 版本：
适配器版本 / patch 基线：
mcpServers（status 返回值）：
工作区路径：

P0–P10：
G1–G5：
S1–S6：
M1–M9：
H1–H3 / C1–C4：
E1–E6：
R1–R4：

阻塞问题：
结论：首轮通过 / 未通过
```

---

## 5. 建议实现顺序

1. **环境与适配器冒烟**：§4.0 的 P0–P5，先证明 `-e` + `registerMcpServer` 在 pi 1.5 上成立。
2. **操作平面**：registry + dispatcher + `mcpAdapter`，用现有 MCP 客户端（其它 IDE 或手写 JSON-RPC）手动打通 `canvas_getState`。
3. **adapter patch**：`session/new` 透传 + spawn 注入 `-e`；用 P4 验证临时 MCP server 可见。
4. **server 控制面最小闭环**：`process` + `client` + `message` 单路由，curl 看 NDJSON。
5. **事件映射 + stop/close + 进程树回收**。
6. **模型/档位/历史**：`config`、`sessions`、`load`、`rename`。
7. **`user.ask`**：registry 条目 + dispatcher 注入 question 桥。
8. **前端入口**：agent 选择器、kind 分流、模型下拉切换、状态提示。
9. **并发保护**与门禁收尾，按第 4 节填记录。

每步只合入「可手动验证」的增量。

---

## 6. 风险与已知上限

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| stdio 运行时失效 | Electrobun 换运行时或改 copy 路径后 `process.execPath` 不再能跑 `stdio.js` | P0 复验；`initializeMcpRuntime` 显式传 bun |
| `mcp.json` 同名覆盖 | pi 的同名文件配置优先于内存注册 | `status` 检查同名项并在 UI 提示 |
| 适配器 fork 维护 | 上游 0.0.34 早期版本，迭代快 | patch 只两处；P9 记录 diff；升级重跑 P4 / P10 |
| bridge 未加载 | `-e` 或 `registerMcpServer` 在 pi 新版本变化 | P4 前置验证；失败时 UI 明示「画布工具不可用」而非静默 |
| 用户禁用 MCP | `--no-mcp` / `extensions: ["-builtin:mcp"]` | 属于用户强限制；E6 验证提示文案 |
| 工具输出过大 | 画布状态、生成结果可能几 MB | 32 KB 阈值落文件 + 摘要 |
| 能力契约腐化 | 多份手写声明必然漂移 | registry 单一定义；评审检查 `mcpAdapter` 只做映射 |
| registry 改造回归 | 触碰 `utils/mcp/tools.ts`，影响其它 IDE | 对外工具名与参数不变；R1 / R2 回归 |
| PATH / 双份 pi | 仓库依赖的 coding-agent 库 ≠ PATH 上的 `pi` CLI | status 探测；允许显式 `piCommand` |
| 写并发丢数据 | 外部 pi 不遵守 `lockWorkspaceFiles` | 同工作区串行（§3.11），服务端拒绝而非提示 |
| 信任模型 | pi 在 cwd 直接读写，Client 拦不住 | 仅本机桌面；cwd 必须已授权；UI 明示 |
| 会话双轨 | `.agent/sessions` vs pi 自有 session | 分离存储与列表；ACP 历史只用 `session/list` |
| 进程泄漏 | 适配器再 spawn pi，只杀父进程留孤儿 | 杀进程树；S5 / E3 验证 |
| 端口漂移 | Laywork MCP 端口从 10588 起顺延 | 走 stdio，不起端口；status 只展示实际配置 |
| 产品混淆 | A2A / MCP / ACP 三种「外部」 | 独立文案与设置入口 |

ACT 注释建议（实现时）：

- ACP 会话句柄表放内存即可，历史真源是 ACP `session/list`；多进程部署不共享句柄。
- `LAYWORK_MCP_SERVERS` 走环境变量，同用户进程可读；与 token 文件同权限级别，若将来要求更严，改为经 stdio 首帧握手传递。

---

## 7. 第二轮预留（本轮不实现）

- 预置 Codex（`@agentclientprotocol/codex-acp`）、Claude（`@agentclientprotocol/claude-agent-acp`）同一 Client 壳
- ACP Registry 式一键安装 / 更新适配器
- 操作平面的能力分组与权限细分（当前按 op 平铺）
- 子 Agent 委派的面板级呈现（若 pi 侧提供事件）
- 与内置 Agent 的跨进程文件互斥（当前只做串行拒绝）

---

## 8. 已定事项

1. **工具通道**：只走 ACP `session/new.mcpServers` + 本机 stdio MCP（server 名 `laywork`）。适配器补丁随应用发布，用户零配置；不写 pi 任何配置文件、不注入 prompt、不做第二通道（§3.5、§3.7）。
2. **能力契约**：单一 `registry`；MCP 工具声明与内置 tools 均从它派生，不维护第二份。
3. **`user.ask`**：作为操作平面的 `interactive` 能力提供，复用现有 `askUser` 插件与卡片；超时由 `timeoutClass` 统一（§3.6）。
4. **同工作区**：允许建多个 ACP 会话，但同时只跑一个活跃 run；跨内置 / ACP 双向 409（§3.11）。
5. **记住上次 Agent 选择**：做，存 `localStorage`，不进 `settings.json`。