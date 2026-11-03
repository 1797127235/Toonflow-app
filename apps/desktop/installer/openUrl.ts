const runtimeFile = process.env.TOONFLOW_RUNTIME_FILE;
const url = process.env.TOONFLOW_OPEN_URL;
if (!runtimeFile || !url || url.length > 8192 || !url.startsWith("toonflow://")) {
  console.error("安装链接无效，须为不超过 8192 个字符的 toonflow://install?type=node&url=编码后的下载地址。");
  process.exit(1);
}

let runtime: { pid?: unknown; port?: unknown };
try {
  runtime = JSON.parse(await Bun.file(runtimeFile).text());
} catch {
  process.exit(10);
}
const pid = runtime?.pid;
const port = runtime?.port;
if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0
  || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) process.exit(10);
try {
  process.kill(pid, 0);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") process.exit(10);
}

const origin = `http://127.0.0.1:${port}`;
try {
  const response = await fetch(`${origin}/api/desktop/openUrl`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-toonflow-desktop": "1" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(3000),
  });
  const result = await response.json().catch(() => null) as { code?: unknown; message?: unknown } | null;
  if (!response.ok || result?.code !== 200) {
    const message = typeof result?.message === "string" && result.message ? result.message : "Laywork 未接受安装请求，请更新应用后重试。";
    console.error(`Laywork 拒绝安装请求（HTTP ${response.status}）：${message}`);
    process.exit(1);
  }
} catch (error) {
  const name = error instanceof Error ? error.name : "";
  const code = (error as { code?: string }).code ?? "";
  if (name === "TimeoutError" || code === "TimeoutError" || code === "ETIMEDOUT") {
    console.error("提交安装请求超时，请等待 Laywork 响应后重试。");
    process.exit(1);
  }
  process.exit(10);
}
