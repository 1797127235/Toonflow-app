import { chmod, mkdir, writeAtomic } from "@toonflow/file";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRuntimePlatform } from "@/lib/platform";
import conf from "@/utils/conf";

// pi-acp 只接受单个可执行命令，用脚本把 --mode rpc 与 bridge 扩展固定下来。
// 打包后 bridge 是构建产物 piBridge.js，开发时直接加载源码。
export async function createPiCommand() {
  const dataDirectory = dirname(conf.path);
  const windows = getRuntimePlatform().os === "win32";
  const bundled = join(import.meta.dir, "piBridge.js");
  const bridge = existsSync(bundled) ? bundled : join(import.meta.dir, "piBridge.ts");
  const file = join(dataDirectory, windows ? "piCommand.cmd" : "piCommand.sh");
  const quoted = windows ? `"${bridge.replace(/"/g, '""')}"` : `'${bridge.replace(/'/g, "'\\''")}'`;
  const content = windows
    ? `@echo off\r\npi --mode rpc --no-themes -e ${quoted} %*\r\n`
    : `#!/bin/sh\nexec pi --mode rpc --no-themes -e ${quoted} "$@"\n`;
  await mkdir(dataDirectory, { recursive: true });
  await writeAtomic(file, content, { mode: 0o755 });
  if (!windows) await chmod(file, 0o755);
  return file;
}