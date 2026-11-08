import { createVNode, render, type Component } from "vue";
import { loadToolComponent } from "@toonflow/tools-scaffold/client";
import type { QuestionRequest, ToolCall } from "@toonflow/tools-scaffold/runtime";

export async function askQuestion(request: QuestionRequest & { toolCallId?: string }, directory?: string) {
  const component = await loadToolComponent("askUser");
  if (!component) throw new Error("askUser 工具界面不可用");
  return await new Promise<{ answer?: string; values?: unknown; skipped?: boolean }>(resolve => {
    const host = document.createElement("div");
    Object.assign(host.style, {
      position: "fixed", inset: "0", zIndex: "3000", display: "flex",
      alignItems: "center", justifyContent: "center", padding: "24px", background: "rgba(0, 0, 0, 0.35)",
    });
    const style = document.createElement("style");
    style.textContent = ".askQuestionHost > * { width: min(640px, 100%); max-height: 100%; overflow: auto; }";
    document.head.append(style);
    host.className = "askQuestionHost";
    document.body.append(host);
    const close = (result: { answer?: string; values?: unknown; skipped?: boolean }) => {
      render(null, host);
      host.remove();
      style.remove();
      resolve(result);
    };
    const callId = request.toolCallId ?? crypto.randomUUID();
    const tool: ToolCall = {
      id: callId, name: "askUser", status: "running", args: {},
      question: { callId, title: request.title, question: request.question, options: request.options, fields: request.fields },
    };
    render(createVNode(component as Component, {
      tool, directory,
      submit: async (payload: { answer?: string; values?: unknown; skipped?: boolean }) => { close(payload); return payload; },
    }), host);
  });
}