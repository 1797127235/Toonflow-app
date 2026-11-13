# 双编排：内置 Agent 与单 Agent 接口

日期：2026-11-13　范围：`apps/server/src/agent/runtime/`、`apps/server/src/utils/singleAgent/`　性质：问题记录，未改代码

## 问题

同一进程里有两套编排，各自定义了一套「会话」：主对话走 `agent/runtime/index.ts:76` 的 `run()`，对外单 Agent 接口走 `utils/singleAgent/index.ts`。共享的只有底层零件（模型创建、请求适配、工具上下文、提问桥），而会话所有权、取消与等待、事件出口、工具集合、SDK 钩子注册顺序这五件事各写了一遍——改一处要双写，且没有测试能发现两边不一致。

漂移已经发生：`singleAgent/index.ts:224` 调 `configureAgentRequests` 少传 `runSignal`，外部取消不进入请求层，而主对话 `runtime/index.ts:256` 与子 Agent `runtime/subAgent.ts:135` 都传了；单 Agent 路径没有 memory / report / subAgent 三个工具（`singleAgent/index.ts:127-128` 对比 `runtime/index.ts:188-207`）；事件 blockId 与 tool 状态机各算一套（`singleAgent/index.ts:239-270` 对比 `runtime/index.ts:168-178`）；请求期钩子由 `runtime/requests.ts:68`、`runtime/index.ts:260`、`runtime/index.ts:278` 三层叠加，顺序只体现在调用先后，没有任何声明。

## 建议

抽一个 `AgentRun`：会话所有权 + 事件出口 + 取消/等待 + 控制命令 + 钩子注册顺序，两个入口退化成参数。顺序是先收口四处 SDK 钩子（纯搬迁），再抽 `AgentRun`，最后合并 singleAgent。不要先拆 `run()`：它没有自动化测试，且对钩子叠加顺序敏感。合并的主要风险在 `utils/singleAgent` 是对外 API（`routes/singleAgent/*`、`routes/browser/*` 的浏览器工具会话），pause / control / toolResult 回填语义必须保留。