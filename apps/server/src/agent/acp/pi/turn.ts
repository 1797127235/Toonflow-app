/** 把 ACP 的一轮对话写成内置会话文件，UI 与恢复都从这份文件读。 */
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentContext, AgentEvent } from "@/agent/runtime/types";

export type AcpTurnTool = {
  id: string;
  name: string;
  args?: unknown;
  result?: string;
  status: "running" | "success" | "error" | "interrupted";
};

export type AcpTurn = {
  prompt: string;
  attachments: { name: string; path: string; mimeType: string }[];
  text: string;
  thinking: string;
  tools: AcpTurnTool[];
  /** ACP 的模型串，形如 "provider/model"；未选择时为 undefined。 */
  model?: string;
  error?: string;
};

/**
 * 边转发事件边累积这一轮的内容：前端看到什么，会话文件里就写什么。
 * 文本与思考交替时必须换 blockId，否则前端会把两段拼进同一个气泡。
 */
export function createTurnRecorder(send: (event: AgentEvent) => void) {
  let blockSeq = 0;
  let open: { type: "text" | "thinking"; blockId: string } | undefined;
  let text = "";
  let thinking = "";
  let contextUsage: AgentContext | undefined;
  const tools = new Map<string, AcpTurnTool>();

  const close = () => {
    if (open) send({ type: open.type, blockId: open.blockId, done: true });
    open = undefined;
  };

  const forward = (event: AgentEvent | undefined) => {
    if (!event) return;
    // 占用可能中途多次上报，只保留最后一次；token 明细统一放到收尾时的 stats。
    if (event.type === "stats") {
      if (event.contextUsage) contextUsage = event.contextUsage;
      return;
    }
    if (event.type === "text" || event.type === "thinking") {
      if (event.type === "text") text += event.delta ?? "";
      else thinking += event.delta ?? "";
      if (!open || open.type !== event.type) {
        close();
        open = { type: event.type, blockId: `${blockSeq++}:0` };
      }
      send({ ...event, blockId: open.blockId });
      return;
    }
    if (event.type === "tool") {
      // tool 会多次上报同一 id（running → success），保留已有的结果文本。
      const current = tools.get(event.tool.id);
      tools.set(event.tool.id, { ...event.tool, result: event.tool.result ?? current?.result });
    }
    close();
    send(event);
  };

  return {
    forward,
    close,
    contextUsage: () => contextUsage,
    snapshot: () => ({ text, thinking, tools: [...tools.values()] }),
  };
}

// ACP 不透出 token 与真实模型，占位值只用于让会话文件能被内置读取逻辑解析。
const acpUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export async function appendAcpTurn(path: string, cwd: string, turn: AcpTurn) {
  const history = SessionManager.open(path, dirname(path), cwd);
  const userId = history.appendMessage({ role: "user", content: [{ type: "text", text: turn.prompt }], timestamp: Date.now() });
  history.appendCustomEntry("toonflowUserMessage", { messageId: userId, content: turn.prompt, attachments: turn.attachments });
  const content: unknown[] = [];
  if (turn.thinking) content.push({ type: "thinking", thinking: turn.thinking });
  if (turn.text) content.push({ type: "text", text: turn.text });
  for (const tool of turn.tools) content.push({ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args ?? {} });
  // ACP 只有模型串，provider 从里面拆；都没有时保留占位值，内置读取逻辑仍能解析。
  const [provider, ...rest] = (turn.model ?? "acp").split("/");
  history.appendMessage({
    role: "assistant",
    content,
    api: "acp",
    provider,
    model: rest.join("/") || provider,
    usage: acpUsage,
    stopReason: turn.error ? "error" : "stop",
    timestamp: Date.now(),
    errorMessage: turn.error,
  } as unknown as Message);
  for (const tool of turn.tools) {
    history.appendMessage({
      role: "toolResult",
      toolCallId: tool.id,
      toolName: tool.name,
      content: [{ type: "text", text: tool.result ?? "" }],
      isError: tool.status === "error",
      timestamp: Date.now(),
    });
  }
}