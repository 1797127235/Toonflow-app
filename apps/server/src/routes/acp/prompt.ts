import { Router } from "express";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AgentContext, AgentEvent } from "@/agent/runtime/types";
import { getAcpEntry } from "@/agent/acp/pi/runtime";
import { mapAcpUpdate } from "@/agent/acp/pi/mapEvents";
import { readSessionUsage } from "@/agent/acp/pi/sessionUsage";
import type { PromptBlock } from "@/agent/acp/client";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";

// ACP 的一轮对话：把前端消息交给 pi，再把 ACP 的 session/update 转成内置 agent 的 AgentEvent。
// 响应是 NDJSON 长连接，前端边收边渲染；连接断开等同于取消。
const inputSchema = z.object({
  // directory 是工作区绝对路径，由 resolveWorkspace 校验归属；prompt 是本轮文本。
  directory: z.string().min(1).max(4096),
  prompt: z.string().trim().min(1),
  // modelId 只在本轮需要换模型时出现，对应 ACP 的 config option "model"。
  modelId: z.string().min(1).max(256).optional(),
  // 附件用工作区相对 path 传入，服务端解析成真实文件后再转成 ACP 的 resource_link。
  attachments: z.array(z.object({
    name: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    mimeType: z.string().max(256).optional(),
  })).max(50).optional(),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  const { directory, prompt, modelId, attachments } = req.body as z.infer<typeof inputSchema>;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const blocks: PromptBlock[] = [{ type: "text", text: prompt }];
  // pi 的 promptCapabilities 只有 image、没有 embeddedContext，附件只能以引用形式发；
  // 这里统一用 resource_link，避免把文件内容塞进 JSON-RPC 帧里。
  for (const item of attachments ?? []) {
    const file = await u.workspaceFile.resolveWorkspaceFile(req, directory, item.path);
    blocks.push({ type: "resource_link", uri: pathToFileURL(file.path).href, name: item.name });
  }
  // 同一目录复用常驻的 pi-acp 进程；目录首次使用要等 npx 拉起与 pi 初始化（实测 4~7 秒）。
  const { client, sessionId, startupInfo, createdAt } = await getAcpEntry(cwd);
  // 放在流开始之前：切换失败要能按普通 500 返回，而不是在流里塞一条错误。
  if (modelId) await client.setConfigOption(sessionId, "model", modelId);
  // no-transform 与 X-Accel-Buffering 是让每一行事件立刻到达前端，不被中间层攒包。
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const send = (event: AgentEvent) => {
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const controller = new AbortController();
  // 长任务可能几十秒没有输出，空行保活；客户端写不动（needDrain）时跳过，避免发送缓冲堆积。
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write("\n");
  }, 20_000);
  const close = () => {
    clearInterval(heartbeat);
    controller.abort();
  };
  // 与内置一致注册取消通道，前端才能拿到 runId 并在刷新/切面板后停止。
  // close 同时挂在三处：客户端断开、请求中断、/api/agent/stop 触发的 abort。
  const agentRun = u.agent.registerAgentRun(cwd, close);
  res.once("close", close);
  req.once("aborted", close);
  // 内置 agent 按 message:content 分段并发送 done；这里保持同样的块语义，前端才能复用同一套渲染与动画。
  // 文本与思考交替时必须换新的 blockId，否则前端会把两段拼进同一个气泡。
  let blockSeq = 0;
  let open: { type: "text" | "thinking"; blockId: string } | undefined;
  // 占用可能中途多次上报，只保留最后一次；token 明细统一放到收尾时的 stats。
  let lastContext: AgentContext | undefined;
  // done 事件不带 content：前端只据此收起该块（折叠思考、结束流式合并），不会覆盖已渲染文字。
  const closeBlock = () => {
    if (open) send({ type: open.type, blockId: open.blockId, done: true });
    open = undefined;
  };
  const forward = (event: AgentEvent | undefined) => {
    if (!event) return;
    if (event.type === "stats") {
      if (event.contextUsage) lastContext = event.contextUsage;
      return;
    }
    if (event.type === "text" || event.type === "thinking") {
      if (!open || open.type !== event.type) {
        closeBlock();
        open = { type: event.type, blockId: `${blockSeq++}:0` };
      }
      send({ ...event, blockId: open.blockId });
      return;
    }
    closeBlock();
    send(event);
  };
  try {
    res.set("X-Toonflow-Agent-Run", agentRun.id);
    res.flushHeaders();
    res.write("\n");
    // accepted 在内置协议里表示"已交给正在运行的会话"，前端收到会移除本地占位消息，这里不能发。
    const result = await client.prompt(sessionId, blocks, update => forward(mapAcpUpdate(update, startupInfo)), controller.signal);
    // 与内置一致，用户主动停止走 error，前端才会显示"已停止生成"而不是当作正常结束。
    if (result.stopReason === "cancelled") throw new Error("已停止生成");
    closeBlock();
    // ACP 只透出上下文占用，累计 token 从 pi 的会话文件补；读不到就只发占用。
    const usage = await readSessionUsage(cwd, createdAt);
    if (usage) {
      send({
        type: "stats",
        stats: { tokens: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite } },
        contextUsage: lastContext,
      });
    }
    // done 是前端判定流结束的唯一信号，缺了会让三点加载动画一直转。
    send({ type: "done" });
  } catch (error) {
    send({ type: "error", message: controller.signal.aborted ? "已停止生成" : error instanceof Error ? error.message : "ACP 执行失败" });
  } finally {
    // finish 必须在 res.end() 之前：释放登记后前端才能立刻发起下一轮，不会被误判成"仍在运行"。
    agentRun.finish();
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    if (!res.writableEnded) res.end();
  }
});