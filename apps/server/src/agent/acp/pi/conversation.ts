/**
 * 一轮 ACP 对话要用的会话文件与引擎会话：建文件、读绑定、加锁、恢复、回写全在这里。
 * 路由只负责请求解析与流式转发。
 */
import type { Request } from "express";
import { resolve } from "node:path";
import { ensureAcpSession, type AcpEntry } from "./runtime";
import { bindAcpSession, readAcpBindingFromFile } from "./binding";
import { lockWorkspaceFiles } from "@/utils/workspace/files";
import u from "@/utils";

export type OpenedAcpConversation = {
  cwd: string;
  path: string;
  fileName: string;
  entry: AcpEntry;
  /** 调用方必须在请求结束时释放；重复调用是安全的。 */
  release: () => void;
};

/**
 * 打开本轮对话的会话：没有文件就新建，有文件就按里面的 sessionId 恢复。
 * 中途失败会先释放文件锁再抛，调用方不需要清理。
 */
export async function openAcpConversation(req: Request, directory: string, sessionFile: string | undefined, modelId: string | undefined): Promise<OpenedAcpConversation> {
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  // 新对话立刻建文件，历史列表与恢复都有落点。
  const resolved = sessionFile
    ? await u.workspaceFile.resolveWorkspaceFile(req, directory, `.agent/sessions/${sessionFile}`)
    : undefined;
  const created = resolved ? undefined : await u.agent.createAgentConversation(cwd);
  const fileName = sessionFile ?? created!.file;
  const path = resolved?.path ?? resolve(cwd, ".agent/sessions", fileName);
  const binding = resolved ? await readAcpBindingFromFile(path) : undefined;
  const release = lockWorkspaceFiles([path]);
  try {
    // 同一目录复用常驻的 pi-acp 进程；目录首次使用要等 npx 拉起与 pi 初始化（实测 4~7 秒）。
    const entry = await ensureAcpSession(cwd, binding?.sessionId);
    // pi 侧的会话丢了会新建；把新 sessionId 写回文件，下一轮继续命中。
    if (entry.sessionId !== binding?.sessionId) await bindAcpSession(path, cwd, entry.sessionId);
    // 放在流开始之前：切换失败要能按普通 500 返回，而不是在流里塞一条错误。
    if (modelId) {
      const updated = await entry.client.setConfigOption(entry.sessionId, "model", modelId) as { configOptions?: unknown[] } | undefined;
      // 切换响应带回新的 configOptions，覆盖后本轮落盘才能记下真正的模型。
      if (updated?.configOptions) entry.configOptions = updated.configOptions;
    }
    return { cwd, path, fileName, entry, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** 从 configOptions 里取当前模型串（pi 的 config id 是 "model"），写进会话文件供 UI 显示。 */
export function readAcpModel(configOptions: unknown[]) {
  const option = configOptions.find(item => (item as { id?: string }).id === "model") as { currentValue?: unknown } | undefined;
  return typeof option?.currentValue === "string" ? option.currentValue : undefined;
}