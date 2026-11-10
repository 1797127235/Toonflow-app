# ACP 外部 Agent 上下文注入问题清单

状态：已修复（2026-11-08）。提示词、技能清单与全局规范改用 pi 原生提示词参数注入，见文末「修复记录」。基于 2026-11-08 工作区代码与本机 `pi@1.5.0` 实测核查。
关联文档：`docs/acpClientPiSpec.md`（功能对等矩阵）、`docs/acpClientPiPlan.md`（P6 / M8 验证项）。

## 结论摘要

ACP 通道下，外部 pi 获得的能力与上下文并不对等：

| 项目 | 内置 Agent | 外部 pi（ACP） | 性质 |
| --- | --- | --- | --- |
| 画布 / 工作区 / 媒体工具 | 进程内工具 | ✅ laywork MCP（codemode 按需发现） | 对等（传输不同） |
| 默认系统提示词（创作搭档人设与行为规则） | `buildSystemPrompt` 注入 | ✅ 同一个 `createAgentContext` 经 `--system-prompt` 注入 | 已对等 |
| 用户自定义系统提示词（`agentSystemPrompt`） | 设置生效 | ✅ 提示词文件在引擎进程启动时读取 | 已对等（进程粒度刷新） |
| 全局协作规范 / 长期记忆 | `appendSystemPrompt` 注入 | ✅ `--append-system-prompt` 注入 | 已对等 |
| 全局技能 | 技能清单进提示词，按需读取 | ✅ `available_skills` 清单进追加段，正文按需 `read` | 已对等 |
| 工作区技能（`项目/skill`） | 同上 | ✅ 与全局技能合并成同一声明 | Spec P6 已有结论 |
| 工作区 AGENTS.md | 只读根目录一份 | ✅ pi 自动扫描（含祖先目录与 `~/.pi/agent`） | 渠道不同，基本可用 |

最严重的实际后果：**外部 pi 不知道"消耗算力前必须确认"等 Laywork 行为规则**，可能在未经用户批准方案的情况下直接调用媒体生成工具；回复风格、创作流程也与内置 Agent 明显不一致。

## 现状链路（证据）

1. 建会话只传目录，无提示词字段：
   `apps/server/src/agent/acp/client.ts` `newSession(cwd)` 仅传 `cwd`，`mcpServers` 为空（pi-acp 会丢弃调用方 mcpServers，实际注入靠桥接扩展）。
2. 启动注入只有环境变量：
   `apps/server/src/agent/acp/pi/runtime.ts` 传 `PI_ACP_PI_COMMAND` 与 `TOONFLOW_MCP_STDIO`；
   `piCommand.ts` 固定 `pi --mode rpc --no-themes -e piBridge`。
3. 桥接扩展只注册 MCP，不碰提示词：
   `apps/server/src/agent/acp/pi/piBridge.ts` 仅 `registerMcpServer("laywork", …)`，`exposure` 默认 `codemode`。
4. 外部 pi 的系统提示词由 pi 自己生成：
   pi 1.5.0 `dist/core/system-prompt.js` 默认开头为 "You are an expert coding assistant operating inside pi…"；
   `dist/core/resource-loader.js` 自动扫描 `AGENTS.override.md / AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD`（`~/.pi/agent` + cwd 全部祖先目录）。
5. Laywork 提示词只服务内置 Agent：
   `apps/server/src/agent/runtime/prompt.ts` 的 `defaultSystemPrompt` 仅被 `apps/server/src/agent/runtime/resources.ts` 的 `systemPromptOverride` 使用；设置项 `agentSystemPrompt` 同路。
6. MCP 侧唯一的规则文本是 instructions（按需读取，不进系统提示）：
   `packages/mcp/src/index.ts` initialize 返回"先调用 getAppState…禁止直接修改画布 JSON…"；
   经 `packages/mcp/src/stdio.ts` `client.getInstructions()` 透传，pi 仅在 codemode `describeNamespace("laywork")` 时交给模型。
   系统提示里只有一行服务器摘要（`mcp_servers` 段，取 bridge 配置的 description）。
7. 技能透出范围只有全局目录：
   `apps/server/src/utils/mcp/resources.ts` `loadSkillsFromDir({ dir: skillFile.directory() })` 只扫 `data/skills`；
   内置的 `apps/server/src/agent/skills/index.ts` 同时扫工作区 `cwd/skill` 与全局 `skills/`。
   pi 1.5.0 为带 resources 的服务器注册 `list_mcp_resources` / `read_mcp_resource`（同样 codemode 折叠），模型须主动发现。
8. 每轮消息不附加上下文：
   `apps/server/src/routes/acp/prompt.ts` 只发用户文本 + 附件 `resource_link`。

## 问题分级

### P1 系统提示词完全未注入（静默缺失，建议优先处理）

- 默认创作搭档提示词、用户自定义 `agentSystemPrompt` 均不生效。
- Spec 的"不注入 prompt"约束（§架构不变量 3、非目标）针对的是**工具通道**——不用 prompt 注入工具清单开第二条工具通道；功能对等矩阵中**没有系统提示词这一行**。
- 按 Spec 对等判定原则 3："协议或适配器客观不支持的项，必须在矩阵中标『不支持』并写明原因，不允许静默缺失"，当前状态违反该原则。
- 行为后果：算力确认规则、生成方案审批、回复风格、技能使用规则全部失效；外部 pi 以通用编码助手身份操作创作项目。

### P2 技能注入未按 Spec 兜底落地

- Spec 矩阵"技能 / 规则"行判定为"受限：不读则把技能文本注入首条 prompt"，Plan P6 / M8 要求验证 pi 是否扫描项目 `skill/`。
- 实测结论：pi 的技能扫描走 pi 自己的目录约定（`~/.pi/agent`、`.pi` 体系），**不扫描** Laywork 的 `项目/skill` 与 `data/skills`；兜底（注入首条 prompt）未实现。
- 现状只把全局技能做成 MCP resources，属于被动透出：无清单进提示词、无"先读正文再执行"规则，工作区技能完全缺失。P6 / M8 应记为未通过并补齐。

### P3 全局协作规范未注入（未决议）

- 内置 Agent 追加 personalization 的全局 AGENTS.md 与长期记忆；ACP 线两者皆无。
- 长期记忆在 Spec 中已明确"受限：不注入，行为由 pi 决定"，属有意决策。
- 全局协作规范（用户级 AGENTS.md）矩阵未提及；pi 只读 `~/.pi/agent` 下的上下文文件，读不到 Laywork personalization 存储。需要补决议。

### P4 已知且有意的设计差异（无需修复，留档）

- 工具 schema 不常驻（codemode）：为控制上下文占用的有意取舍，可用 `TOONFLOW_MCP_EXPOSURE=direct` 展开排查。
- pi 原生人设底座：ACP 协议 `session/new` 无系统提示词字段，对任意 ACP agent 无通用注入点；这是协议客观限制，应在矩阵中显式标注。
- AGENTS.md 扫描范围差异：外部 pi 扫祖先目录与 `~/.pi/agent`，内置只扫工作区根目录；可能引入工作区之外的约定，属 pi 生态行为。

## 根因

1. 协议层：ACP v1 `session/new` / `session/prompt` 没有系统提示词或上下文注入字段，通用 ACP agent 只能靠工作区 AGENTS.md 这类 agent 自读文件。
2. 实现层：piBridge 只用了 `registerMcpServer`，未使用 pi 扩展的提示词钩子；MCP instructions 承载了少量规则但只能按需读取。
3. 流程层：Spec 把"提示词/技能对等"留为待验证与受限项，实现完成后未回填验证结论，形成静默缺失。

## 可选修复路径（供决策，均未实施）

1. **piBridge 提示词钩子（仅 pi 有效）**：pi 1.5.0 扩展 API 提供 `before_agent_start` 事件，`systemPromptOptions.appendSystemPrompt` 可变，事件结果支持整段 `systemPrompt` 覆盖（`dist/core/extensions/types.d.ts`）。可把 Laywork 提示词经环境变量或本机接口传给 bridge，每轮追加；技能清单可一并注入。需评估与 Spec"不注入 prompt"约束的边界（该约束原文针对工具通道）。
2. **MCP 通道补强**：instructions 写全行为规则；resources 覆盖工作区技能（需要请求侧携带 directory，当前 resources 接口无工作区参数）。不改变"被动发现"的本质。
3. **首条 prompt 注入技能文本**：Spec 既定兜底，改动最小，但每会话一次性、无法随技能更新。
4. **通用兜底**：在工作区写入/合并 Laywork 约定的 AGENTS.md，对所有 ACP agent 生效，但会污染用户项目文件，需用户授权。

## 待办建议

- [x] Spec 功能对等矩阵补"系统提示词 / 用户自定义提示词 / 全局协作规范"行，标注判定与原因。
- [x] Plan P6 / M8 回填实测结论（pi 不扫描 Laywork 技能目录）。
- [x] 决策 P1 修复路径：见下方「修复记录」（不走 piBridge 钩子，改用 pi 原生提示词参数）。
- [x] 决策工作区技能透出方式：与全局技能合并进 `available_skills` 清单，不再依赖 pi 扫描目录。

## 修复记录（2026-11-08）

原则：提示词是引擎配置，经引擎官方通道下发；bridge 保持纯 MCP 适配器，不参与轮次生命周期。

1. **单一上下文来源** `apps/server/src/agent/context.ts`：`createAgentContext(cwd, tools)` 读取 `settings.agentSystemPrompt`、工作区 `AGENTS.md`、个性化全局 AGENTS.md 与长期记忆、`loadAgentSkills`，调用 `buildSystemPrompt` 渲染；`globalSections` 输出全局规范/记忆段。内置 Agent（`apps/server/src/agent/runtime/resources.ts`）与 ACP 现在共用它，两线不再各写一份。
2. **ACP 落盘** `apps/server/src/agent/acp/pi/acpContext.ts`：把结果写成 `data/acp/<sha256(cwd) 前16位>/systemPrompt.md` 与 `appendSystemPrompt.md`（0600）；追加段用 SDK 的 `formatSkillsForPrompt` 生成 `available_skills`（含工作区与全局技能、`disableModelInvocation` 自动跳过）。
3. **原生下发** `apps/server/src/agent/acp/pi/piCommand.ts`：启动命令改为 `pi --mode rpc --no-themes --system-prompt <file> --append-system-prompt <file> -e <bridge> "$@"`（值命中已有文件时 pi 读取文件内容，0.85.1 与 1.5.0 均支持）。脚本、提示词都按目录分文件，修掉原先所有工作区共用一份 `piCommand.sh` 的互相覆盖问题。
4. **刷新时机** `apps/server/src/agent/acp/pi/runtime.ts`：提示词在引擎进程启动时固化，匹配 pi 自身的资源加载语义；设置变化后回收空闲进程（忙的留给 15 分钟闲置回收），下一轮按新内容重新落盘。文件按目录固定，不需要额外清理。
5. **工具段**：ACP 的 `{{tools}}` 用一行 codemode 说明 + 一行引擎自带 `read/write/edit/bash`，不把 47 个工具 schema 塞回提示词，保持 codemode 设计。

保留的差异：`AGENTS.md` 仍由 pi 自读（扫描范围比内置更宽，属 P4 生态行为）；`disableModelInvocation` 技能在 ACP 侧通过清单不出现实现，无 `skillOperator` 的运行时开关差异。

验证：`apps/server` `bun run typecheck` 通过；实测 `createPiCommand` 生成的脚本、提示词文件内容正确，pi 1.5.0 能正常以该参数启动 rpc。