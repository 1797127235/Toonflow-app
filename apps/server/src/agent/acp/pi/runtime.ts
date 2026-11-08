import { getMcpRuntime } from "@/utils/mcp/runtime";
import { createAcpClient, type AcpClient } from "../client";
import { createPiCommand } from "./piCommand";

export type AcpConfigOption = { id: string; name?: string; currentValue: string; options: { value: string; name: string }[] };
type AcpEntry = { client: AcpClient; sessionId: string; startupInfo?: string; configOptions: unknown[]; createdAt: number; lastUsedAt: number };
const entries = new Map<string, Promise<AcpEntry>>();
const idleTimeout = 15 * 60_000;

// 每个目录常驻一个 pi-acp + pi + MCP 子进程，闲置 15 分钟后回收；正在执行的会话不回收。
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [directory, pending] of entries) {
    void pending.then(entry => {
      if (entry.client.busy || now - entry.lastUsedAt < idleTimeout) return;
      entries.delete(directory);
      entry.client.dispose();
    }).catch(() => {});
  }
}, 60_000);
sweep.unref();

async function create(directory: string): Promise<AcpEntry> {
  const mcp = getMcpRuntime();
  if (!mcp.endpoint) throw new Error("Laywork MCP 未启用：请先在设置中打开 MCP 并设置访问令牌");
  const stdio = mcp.stdio;
  if (!stdio) throw new Error("Laywork MCP 的 stdio 入口不可用，请重启应用后再试");
  const configured = process.env.TOONFLOW_PI_ACP_COMMAND;
  const client = createAcpClient({
    command: configured ?? "npx",
    args: configured ? [] : ["-y", "pi-acp"],
    cwd: directory,
    env: {
      PI_ACP_PI_COMMAND: await createPiCommand(),
      TOONFLOW_MCP_STDIO: JSON.stringify({ command: stdio.command, args: stdio.args }),
    },
  });
  const forget = client.onExit(() => entries.delete(directory));
  try {
    await client.initialize();
    const session = await client.newSession(directory);
    const now = Date.now();
    return { client, sessionId: session.sessionId, startupInfo: session.startupInfo, configOptions: session.configOptions, createdAt: now, lastUsedAt: now };
  } catch (error) {
    forget();
    client.dispose();
    throw error;
  }
}

export function getAcpEntry(directory: string) {
  const cached = entries.get(directory);
  if (cached) return cached.then(entry => { entry.lastUsedAt = Date.now(); return entry; });
  const pending = create(directory).catch(error => {
    entries.delete(directory);
    throw error;
  });
  entries.set(directory, pending);
  return pending;
}

export async function getExistingAcpEntry(directory: string) {
  const pending = entries.get(directory);
  if (!pending) return undefined;
  return await pending.catch(() => undefined);
}

export function disposeAcpEntries() {
  for (const [directory, pending] of entries) {
    entries.delete(directory);
    void pending.then(entry => entry.client.dispose()).catch(() => {});
  }
}