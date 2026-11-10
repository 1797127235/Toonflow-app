import { chmod, writeAtomic } from "@toonflow/file";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRuntimePlatform } from "@/lib/platform";
import { createAcpContext } from "./acpContext";

// pi-acp 只接受单个可执行命令，用脚本把 --mode rpc、提示词与 bridge 扩展固定下来。
// 打包后 bridge 是构建产物 piBridge.js，开发时直接加载源码。
export async function createPiCommand(cwd: string) {
  const windows = getRuntimePlatform().os === "win32";
  const bundled = join(import.meta.dir, "piBridge.js");
  const bridge = existsSync(bundled) ? bundled : join(import.meta.dir, "piBridge.ts");
  const context = await createAcpContext(cwd);
  const file = join(context.directory, windows ? "piCommand.cmd" : "piCommand.sh");
  const quote = (value: string) => windows ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, "'\\''")}'`;
  // --system-prompt / --append-system-prompt 的值是文件路径时，pi 读取文件内容作为提示词。
  const command = `pi --mode rpc --no-themes --system-prompt ${quote(context.system)} --append-system-prompt ${quote(context.append)} -e ${quote(bridge)}`;
  const content = windows ? `@echo off\r\n${command} %*\r\n` : `#!/bin/sh\nexec ${command} "$@"\n`;
  await writeAtomic(file, content, { mode: 0o755 });
  if (!windows) await chmod(file, 0o755);
  return file;
}
