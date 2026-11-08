import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, stat } from "@toonflow/file";

export type SessionUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * 从 pi 自己的会话文件读取累计 token 用量。
 * ACP 只透出上下文占用（used/size），token 明细只在 pi 的 jsonl 会话里；文件名按 cwd 编码，
 * 这里取 sinceMs 之后最新写入的那个，多标签并发同一 cwd 时可能取到另一个会话。
 */
export async function readSessionUsage(cwd: string, sinceMs: number): Promise<SessionUsage | undefined> {
  const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const dir = join(root, "sessions", `--${cwd.replace(/^\/+/, "").replace(/\//g, "-")}--`);
  const names = await readdir(dir).catch(() => [] as string[]);
  let newest: { name: string; time: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (!info || info.mtimeMs < sinceMs) continue;
    if (!newest || info.mtimeMs > newest.time) newest = { name, time: info.mtimeMs };
  }
  if (!newest) return undefined;
  const text = await readFile(join(dir, newest.name), "utf8").catch(() => "");
  const lines = text.split("\n");
  // 与内置一致，只统计最后一轮用户消息之后的用量；整会话累加会在第二条消息时翻倍。
  let start = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].includes('"role":"user"')) { start = index; break; }
  }
  const usage: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let found = false;
  for (const line of lines.slice(start)) {
    if (!line.includes('"usage"')) continue;
    try {
      const item = (JSON.parse(line) as { message?: { usage?: Partial<SessionUsage> } }).message?.usage;
      if (!item) continue;
      found = true;
      usage.input += item.input ?? 0;
      usage.output += item.output ?? 0;
      usage.cacheRead += item.cacheRead ?? 0;
      usage.cacheWrite += item.cacheWrite ?? 0;
    } catch {
      // 半行或损坏行跳过，不影响其余统计。
    }
  }
  return found ? usage : undefined;
}