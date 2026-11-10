import { ensureAgentMcpStdio } from "@/utils/mcp/runtime";
import conf from "@/utils/conf";
import { createAcpClient, type AcpClient } from "../client";
import { createPiCommand } from "./piCommand";

export type AcpConfigOption = { id: string; name?: string; currentValue: string; options: { value: string; name: string }[] };
export type AcpEntry = {
  client: AcpClient;
  sessionId: string;
  startupInfo?: string;
  configOptions: unknown[];
  createdAt: number;
  lastUsedAt: number;
};
type AcpHost = { client: AcpClient; sessions: Map<string, AcpEntry>; default?: AcpEntry; lastUsedAt: number };
const hosts = new Map<string, Promise<AcpHost>>();
const idleTimeout = 15 * 60_000;

// 提示词与全局资料在引擎进程启动时固化；设置变化后回收空闲进程，下一轮按新设置重新生成。
conf.onDidChange("settings", () => {
  for (const [directory, pending] of hosts) {
    void pending.then(host => {
      if (host.client.busy || hosts.get(directory) !== pending) return;
      hosts.delete(directory);
      host.client.dispose();
    }).catch(() => {});
  }
});

// 每个目录常驻一个 pi-acp + pi + MCP 子进程，进程内可持有多个会话；闲置 15 分钟后回收。
// 只在没有 prompt 执行时回收，避免打断正在跑的会话。
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [directory, pending] of hosts) {
    void pending.then(host => {
      if (host.client.busy) return;
      for (const [sessionId, entry] of host.sessions) {
        if (now - entry.lastUsedAt >= idleTimeout) host.sessions.delete(sessionId);
      }
      if (host.sessions.size || now - host.lastUsedAt < idleTimeout) return;
      hosts.delete(directory);
      host.client.dispose();
    }).catch(() => {});
  }
}, 60_000);
sweep.unref();

async function createHost(directory: string): Promise<AcpHost> {
  const stdio = ensureAgentMcpStdio();
  if (!stdio) throw new Error("Laywork MCP 的 stdio 入口不可用，请重启应用后再试");
  const configured = process.env.TOONFLOW_PI_ACP_COMMAND;
  const client = createAcpClient({
    command: configured ?? "npx",
    args: configured ? [] : ["-y", "pi-acp"],
    cwd: directory,
    env: {
      PI_ACP_PI_COMMAND: await createPiCommand(directory),
      TOONFLOW_MCP_STDIO: JSON.stringify({ command: stdio.command, args: stdio.args }),
    },
  });
  const forget = client.onExit(() => hosts.delete(directory));
  try {
    await client.initialize();
    return { client, sessions: new Map(), lastUsedAt: Date.now() };
  } catch (error) {
    forget();
    client.dispose();
    throw error;
  }
}

function getHost(directory: string) {
  const cached = hosts.get(directory);
  if (cached) return cached;
  const pending = createHost(directory).catch(error => {
    hosts.delete(directory);
    throw error;
  });
  hosts.set(directory, pending);
  return pending;
}

async function createSession(host: AcpHost, directory: string) {
  const session = await host.client.newSession(directory);
  const now = Date.now();
  const entry: AcpEntry = {
    client: host.client,
    sessionId: session.sessionId,
    startupInfo: session.startupInfo,
    configOptions: session.configOptions,
    createdAt: now,
    lastUsedAt: now,
  };
  host.sessions.set(entry.sessionId, entry);
  return entry;
}

/**
 * 取会话：已有 sessionId 且 pi 侧还在就复用或 session/load，否则新建。
 * load 失败（pi 的会话文件被清理）时静默降级，调用方负责把新 sessionId 写回会话文件。
 */
export async function ensureAcpSession(directory: string, sessionId?: string): Promise<AcpEntry> {
  const host = await getHost(directory);
  host.lastUsedAt = Date.now();
  if (sessionId) {
    const cached = host.sessions.get(sessionId);
    if (cached && host.client.hasSession(sessionId)) {
      cached.lastUsedAt = Date.now();
      return cached;
    }
    try {
      const restored = await host.client.loadSession(directory, sessionId);
      const now = Date.now();
      const entry: AcpEntry = {
        client: host.client,
        sessionId,
        configOptions: restored.configOptions,
        createdAt: now,
        lastUsedAt: now,
      };
      host.sessions.set(sessionId, entry);
      return entry;
    } catch {
      // 上下文已经不可恢复；历史仍在会话文件里，下一轮重新建立并重新绑定。
    }
  }
  return await createSession(host, directory);
}

/** 目录级默认会话，给只需要 configOptions 的接口（模型列表）使用，不绑定会话文件。 */
export async function getAcpEntry(directory: string) {
  const host = await getHost(directory);
  host.lastUsedAt = Date.now();
  if (host.default && host.client.hasSession(host.default.sessionId)) {
    host.default.lastUsedAt = Date.now();
    return host.default;
  }
  host.default = await createSession(host, directory);
  return host.default;
}

export async function getExistingAcpClient(directory: string) {
  const pending = hosts.get(directory);
  if (!pending) return undefined;
  const host = await pending.catch(() => undefined);
  return host?.client;
}

export function disposeAcpEntries() {
  for (const [directory, pending] of hosts) {
    hosts.delete(directory);
    void pending.then(host => host.client.dispose()).catch(() => {});
  }
}