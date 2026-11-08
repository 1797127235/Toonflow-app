import type { AgentEvent } from "@/agent/runtime/types";
import type { SessionUpdate } from "../client";

const toolStatus = {
  pending: "running",
  in_progress: "running",
  completed: "success",
  failed: "error",
  cancelled: "interrupted",
} as const;

function textOf(content: unknown) {
  const block = content as { type?: string; text?: string } | undefined;
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
}

function outputOf(value: unknown) {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function mapAcpUpdate(update: SessionUpdate, startupInfo?: string): AgentEvent | undefined {
  if (update.sessionUpdate === "agent_message_chunk") {
    const delta = textOf(update.content);
    if (!delta) return undefined;
    // pi-acp 会把 pi 启动摘要（版本 + Skills 列表）当正常回复发出，按 session/new 返回的原文丢弃。
    if (delta === startupInfo || (delta.startsWith("pi v") && delta.includes("## Skills"))) return undefined;
    // pi 每轮会附一条计时状态行，不属于回答内容。
    if (/^(Sent|Done at) \d{2}:\d{2}:\d{2}( · .+)?$/.test(delta)) return undefined;
    return { type: "text", blockId: "reply", delta };
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    const delta = textOf(update.content);
    return delta ? { type: "thinking", blockId: "thinking", delta } : undefined;
  }
  if (update.sessionUpdate === "usage_update") {
    const used = typeof update.used === "number" ? update.used : 0;
    const size = typeof update.size === "number" ? update.size : 0;
    // pi-acp 只透出上下文占用，token 明细（含 cacheRead）不过协议，累计用量留空由前端隐藏。
    return {
      type: "stats",
      stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      contextUsage: { tokens: used, contextWindow: size, percent: size > 0 ? used / size * 100 : null },
    };
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const id = String(update.toolCallId ?? "");
    if (!id) return undefined;
    const status = toolStatus[update.status as keyof typeof toolStatus] ?? "running";
    return {
      type: "tool", blockId: id,
      tool: {
        id, name: typeof update.title === "string" && update.title ? update.title : "tool",
        status,
        args: update.rawInput as Record<string, unknown> | undefined,
        result: outputOf(update.rawOutput),
      },
    };
  }
  return undefined;
}