import { dlopen, ptr } from "bun:ffi";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";

export default async function prepareWebviewRuntime(resourcesFolder: string) {
  if (process.platform !== "win32") return;

  // Core 监听线程跟随进程退出，保留 DLL 引用，避免线程运行时卸载。
  const core = dlopen(resolve(resourcesFolder, "../bin/ElectrobunCore.dll"), {
    configureWebviewRuntime: { args: ["u32", "ptr", "ptr"], returns: "bool" },
    electrobun_core_last_error: { args: [], returns: "cstring" },
  });
  const emptyPreload = Buffer.alloc(1);
  let lastError = "Failed to configure webview runtime";

  // 2.0.1 会将 Windows 端口冲突报成 Unexpected；先启动通信，SDK 随后写入真实 preload。上游修复后可移除。
  // 探测端口释放后仍可能被抢占，最多重新申请 16 次，以原生绑定成功为准。
  for (let attempt = 0; attempt < 16; attempt++) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (core.symbols.configureWebviewRuntime(port, ptr(emptyPreload), ptr(emptyPreload))) {
      console.log(`桌面通信：127.0.0.1:${port}`);
      return;
    }
    lastError = String(core.symbols.electrobun_core_last_error() || lastError);
    if (!lastError.startsWith("Failed to start websocket server:")) break;
  }
  throw new Error(lastError);
}
