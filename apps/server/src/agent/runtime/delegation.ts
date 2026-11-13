import { readFile } from "@toonflow/file";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { run } from "@/agent/runtime";
import { createAgentConversation, getToolResultText, trackAgentEvent, updateSubAgent } from "@/agent/runtime/sessions";
import { registerAgentRun } from "@/agent/runtime/runs";
import { addUsage, emptyUsage, type SubAgentResult } from "@/agent/runtime/subAgent";
import { createCanvasContext } from "@/agent/bridge/canvas";
import { createQuestionContext } from "@/agent/bridge/question";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { translateError, translateMessage } from "@/lib/i18n";
import type { ThinkingLevel } from "@/lib/modelReasoning";

/**
 * 临时子 Agent 的编排入口（subAgent 工具不指定 team 时走这里）。
 *
 * 与 subAgent.ts 的 runSubAgent 不同：这里是完整的 run()，子会话有独立文件、
 * 独立工具集和实时提问通道，能继续委派；runSubAgent 只是团队成员用的轻量会话。
 * 选择“完整 run”是为了让子 Agent 拥有和主 Agent 一致的能力，代价是每层都会
 * 重新加载系统提示与工具定义。
 */
export async function runDelegatedAgent(options: {
  cwd: string; parentFile: string; name: string; task: string;
  providerId: string; modelId: string; thinkingLevel?: ThinkingLevel;
  canvas?: CanvasContext; signal?: AbortSignal; send: (event: AgentEvent) => void; onProgress?: (text: string) => void;
}) {
  const { cwd, parentFile, name, task, providerId, modelId, thinkingLevel, canvas, signal, onProgress } = options;
  const child = await createAgentConversation(cwd, { parentFile, name, task, providerId, modelId, thinkingLevel });
  const agent = { file: child.file, parentFile, name, task, providerId, modelId, thinkingLevel, status: "running" as const };
  await updateSubAgent(cwd, parentFile, agent);
  // 所有子会话事件都带 file 前缀转发给父会话，前端据此把事件归到对应子会话；
  // trackAgentEvent 只关心 question，用于父级判断“整条链是否在等回答”。
  const send = (event: AgentEvent) => {
    trackAgentEvent(cwd, child.file, event);
    options.send({ type: "subAgentEvent", file: child.file, event });
    if (event.type === "tool" && event.tool.status === "running") onProgress?.(`正在调用 ${event.tool.name}`);
  };
  // 父级取消（用户停止父任务）和子级取消（提问被取消、画布操作中止）都要能停掉子会话；
  // 内部 controller 同时供 stopAgentRun 和提问取消使用。
  const controller = new AbortController();
  const childSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const agentRun = registerAgentRun(cwd, () => controller.abort());
  const bridge = canvas ? createCanvasContext(cwd, canvas, send, reason => controller.abort(reason)) : undefined;
  const questions = createQuestionContext(cwd, send, () => controller.abort());
  const result: SubAgentResult = { name, status: "running", result: "准备执行" };
  try {
    await run({ prompt: task, cwd, runId: agentRun.id, sessionFile: child.file, providerId, modelId, thinkingLevel, canvas: bridge?.context, question: questions.context, signal: childSignal, onCancel: () => controller.abort() }, send);
    result.status = childSignal.aborted ? "cancelled" : "completed";
  } catch (error) {
    result.status = childSignal.aborted ? "cancelled" : (error as { code?: string })?.code === "AGENT_LENGTH" ? "limited" : "error";
    result.result = error instanceof Error ? translateError(error) : translateMessage("子任务执行失败");
    if (result.status !== "limited") await updateSubAgent(cwd, parentFile, { ...agent, status: result.status, result: result.result });
    send({ type: "error", message: result.result });
  } finally {
    bridge?.dispose();
    questions.dispose();
    send({ type: "done" });
    agentRun.finish();
  }
  // 子会话的 usage 不在父会话里，只能等 run 结束后从子会话落盘条目重新统计；
  // 这样并发委派汇总时不会漏掉子 Agent 的消耗。
  const { path } = await resolveWorkspacePath(cwd, `.agent/sessions/${child.file}`);
  const entries = parseSessionEntries(await readFile(path, "utf8"));
  const usage = emptyUsage();
  for (const entry of entries) {
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") && entry.message.usage) addUsage(usage, entry.message.usage);
  }
  // 成功或达限时以子会话最后一条 assistant 文本作为结果；stopReason=length 表示
  // 内容被截断，必须降级为 limited，不能当成完整交付。
  if (result.status === "completed" || result.status === "limited") {
    const reply = entries.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    result.result = reply?.type === "message" && reply.message.role === "assistant" ? getToolResultText(reply.message.content.filter(part => part.type === "text")) : "";
    if (reply?.type === "message" && reply.message.role === "assistant" && reply.message.stopReason === "length") result.status = "limited";
  }
  return { result, usage };
}
