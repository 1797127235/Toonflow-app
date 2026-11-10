import { Router } from "express";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AgentEvent } from "@/agent/runtime/types";
import { mapAcpUpdate } from "@/agent/acp/pi/mapEvents";
import { appendAcpTurn, createTurnRecorder } from "@/agent/acp/pi/turn";
import { openAcpConversation, readAcpModel } from "@/agent/acp/pi/conversation";
import { readSessionUsage } from "@/agent/acp/pi/sessionUsage";
import type { PromptBlock } from "@/agent/acp/client";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";

// ACP 的一轮对话：把前端消息交给 pi，再把 ACP 的 session/update 转成内置 agent 的 AgentEvent。
// 响应是 NDJSON 长连接，前端边收边渲染；连接断开等同于取消。
// 每轮结束都会把这轮内容写进 `.agent/sessions`，历史与重启恢复都以这份文件为准。
const inputSchema = z.object({
  // directory 是工作区绝对路径，由 resolveWorkspace 校验归属；prompt 是本轮文本。
  directory: z.string().min(1).max(4096),
  // sessionFile 是会话文件；空表示这轮开启新对话，服务端建好后通过响应头回传。
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(),
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
  const { directory, prompt, modelId, attachments, sessionFile } = req.body as z.infer<typeof inputSchema>;
  const files = attachments ?? [];
  const blocks: PromptBlock[] = [{ type: "text", text: prompt }];
  // pi 的 promptCapabilities 只有 image、没有 embeddedContext，附件只能以引用形式发；
  // 这里统一用 resource_link，避免把文件内容塞进 JSON-RPC 帧里。
  for (const item of files) {
    const file = await u.workspaceFile.resolveWorkspaceFile(req, directory, item.path);
    blocks.push({ type: "resource_link", uri: pathToFileURL(file.path).href, name: item.name });
  }

  // 会话文件与引擎会话在这一步定下来；失败会自己释放锁。
  const { cwd, path, fileName, entry, release } = await openAcpConversation(req, directory, sessionFile, modelId);
  const { client, sessionId, startupInfo, createdAt } = entry;
  // no-transform 与 X-Accel-Buffering 是让每一行事件立刻到达前端，不被中间层攒包。
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const send = (event: AgentEvent) => {
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const recorder = createTurnRecorder(send);
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
  let turnError: string | undefined;
  try {
    res.set("X-Toonflow-Agent-Run", agentRun.id);
    res.set("X-Toonflow-Session-File", fileName);
    res.flushHeaders();
    res.write("\n");
    // accepted 在内置协议里表示"已交给正在运行的会话"，前端收到会移除本地占位消息，这里不能发。
    const result = await client.prompt(sessionId, blocks, update => recorder.forward(mapAcpUpdate(update, startupInfo)), controller.signal);
    // 与内置一致，用户主动停止走 error，前端才会显示"已停止生成"而不是当作正常结束。
    if (result.stopReason === "cancelled") throw new Error("已停止生成");
    recorder.close();
    // ACP 只透出上下文占用，累计 token 从 pi 的会话文件补；读不到就只发占用。
    const usage = await readSessionUsage(cwd, createdAt);
    if (usage) {
      send({
        type: "stats",
        stats: { tokens: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite } },
        contextUsage: recorder.contextUsage(),
      });
    }
  } catch (error) {
    turnError = controller.signal.aborted ? "已停止生成" : error instanceof Error ? error.message : "ACP 执行失败";
  } finally {
    // 先落盘再发结束信号：前端收到 done 会立刻 refreshSession，文件必须已经写好。
    try {
      await appendAcpTurn(path, cwd, {
        prompt,
        attachments: files.map(item => ({ name: item.name, path: item.path, mimeType: item.mimeType ?? "application/octet-stream" })),
        ...recorder.snapshot(),
        model: readAcpModel(entry.configOptions),
        error: turnError,
      });
    } catch (error) {
      turnError ??= `对话保存失败：${error instanceof Error ? error.message : "未知错误"}`;
    }
    if (turnError) send({ type: "error", message: turnError });
    // done 是前端判定流结束的唯一信号，缺了会让三点加载动画一直转。
    else send({ type: "done" });
    // finish 必须在 res.end() 之前：释放登记后前端才能立刻发起下一轮，不会被误判成"仍在运行"。
    release();
    agentRun.finish();
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    if (!res.writableEnded) res.end();
  }
});