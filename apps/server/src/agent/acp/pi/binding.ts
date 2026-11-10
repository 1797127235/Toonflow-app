/**
 * ACP 会话与 `.agent/sessions/*.jsonl` 的绑定。
 *
 * ACP 的会话身份是 `sessionId`，toonflow 的身份是会话文件；pi 的会话文件只是上下文缓存，
 * 不保证跨版本/跨机器存在。恢复时先读绑定，pi 侧丢了就降级新建并重新绑定。
 */
import { dirname } from "node:path";
import { readFile } from "@toonflow/file";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { writeWorkspaceFile } from "@/utils/workspace/files";

export type AcpBinding = { kind: "acpPi"; sessionId: string };
const bindingType = "toonflowAgentKind";

// 会话头、历史条目都只用到这三个字段，避免把 FileEntry / SessionEntry 的区别带到调用方。
type BindingEntry = { type: string; customType?: string; data?: unknown };

export function readAcpBinding(entries: BindingEntry[]): AcpBinding | undefined {
  const entry = entries.findLast(item => item.type === "custom" && item.customType === bindingType);
  const data = entry?.type === "custom" ? entry.data as Partial<AcpBinding> | undefined : undefined;
  return data?.kind === "acpPi" && typeof data.sessionId === "string" ? { kind: "acpPi", sessionId: data.sessionId } : undefined;
}

export async function readAcpBindingFromFile(path: string) {
  const entries = parseSessionEntries(await readFile(path, "utf8"));
  if (entries[0]?.type !== "session") throw Object.assign(new Error("会话文件无效"), { status: 400 });
  return readAcpBinding(entries);
}

/** 写入绑定。SDK 要等首条 assistant 才落盘，这里直接覆盖整份快照，绑定立刻生效。 */
export async function bindAcpSession(path: string, cwd: string, sessionId: string) {
  const history = SessionManager.open(path, dirname(path), cwd);
  history.appendCustomEntry(bindingType, { kind: "acpPi", sessionId });
  await writeWorkspaceFile(path, [history.getHeader(), ...history.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
}