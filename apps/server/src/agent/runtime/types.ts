import type { CanvasToolCall, QuestionRequest, ToolCall } from "@toonflow/tools-scaffold/runtime";
import type { ThinkingLevel } from "../../lib/modelReasoning";

/**
 * Agent 运行时对外的公共契约：事件、统计、上下文用量和子 Agent 状态。
 * 前端只依赖这里的结构，不直接读 SDK 类型。修改字段时先搜索 apps/web 的消费方。
 */

// question 挂在工具上而不是单独维护：提问的生命周期属于对应的 askUser 工具调用，
// 工具结束或取消时问题状态自然失效，不需要额外清理表。
export type AgentToolCall = ToolCall & { question?: QuestionRequest & { callId: string } };

export type AgentMention = {
  id: string;
  label: string;
  source:
    | { kind: "canvas"; canvasId: string; canvasName: string; nodeId: string; nodeName: string; outputId: string; outputName: string }
    | { kind: "asset"; path: string };
  dataType: string;
  value: unknown;
};

export type AgentStats = {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  tokensPerSecond?: number;
};

/** 上下文占用估算分段。按字符数 ÷ 4 估算，不是模型 tokenizer；tokens 为 0 的分段不下发。 */
export type AgentContextSegment = {
  /** system 系统提示；rules 工作区/全局 AGENTS 与长期记忆；skills 预载技能目录；tools 内置工具 JSON；mcp MCP 工具 JSON；conversation 消息与按需读入内容。 */
  id: "system" | "rules" | "skills" | "tools" | "mcp" | "conversation";
  label: string;
  tokens: number;
};

/** 当前上下文占用。有模型 usage 时 tokens 以 usage 为准，分段占比按估算切分；尚无 usage 时总占用为各分段估算之和。 */
export type AgentContext = {
  tokens: number | null;
  contextWindow: number;
  /** 上下文窗口未知时为 null，前端勿用 0 做分母。 */
  percent: number | null;
  segments?: AgentContextSegment[];
};

/** 子 Agent 的展示状态。inputRequired 是“本轮结束、等调用方补充”，
 * 不是失败；前端不能把它和 error 混为一谈。 */
export type AgentSubAgent = {
  file: string;
  parentFile: string;
  name: string;
  task: string;
  status: "running" | "completed" | "error" | "limited" | "cancelled" | "inputRequired";
  result?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
};

/**
 * 流式事件。分组含义：
 * - text/thinking：按 blockId 聚合的增量，done 表示该块结束；
 * - tool/question/canvasCall：一次工具调用的状态与交互请求；
 * - subAgent/subAgentEvent/report：委派链的状态与事件转发；
 * - session/userMessage/stats/compaction/done：会话生命周期与统计。
 */
export type AgentEvent =
  | { type: "text" | "thinking"; blockId: string; delta?: string; content?: string; done?: boolean }
  | { type: "compaction"; active: boolean }
  | { type: "tool"; blockId: string; tool: AgentToolCall }
  | ({ type: "canvasCall"; callId: string } & CanvasToolCall)
  | ({ type: "question"; callId: string; toolCallId: string } & QuestionRequest)
  | { type: "error"; message: string }
  | { type: "session"; file: string; runId?: string }
  | { type: "userMessage"; id: string; content?: string; attachments?: { name: string; path: string; mimeType: string }[]; mentions?: AgentMention[] }
  | { type: "subAgent"; agent: AgentSubAgent }
  | { type: "subAgentEvent"; file: string; event: AgentEvent }
  | { type: "report"; parentFile: string; file: string; name: string; content: string; id: string }
  | { type: "accepted" }
  | { type: "stats"; stats: AgentStats; contextUsage?: AgentContext }
  | { type: "done" };
