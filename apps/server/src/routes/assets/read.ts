import { once } from "node:events";
import { basename } from "node:path";
import { lstat } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { beginCacheWrite, cacheFileName, contentTypeOf, readCachedImage, withSourceSlot } from "@/utils/assets/imageCache";
import { resolveSourceImage } from "@/utils/assets/sourceIndex";
import type { SourceConfig } from "@/utils/assets/sources";
import { sendFile } from "@/utils/fileHttp";
import { validateFields } from "@/lib/middleware";

const router = Router();
const upstreamTimeoutMs = 30000;

function applyRemoteHeaders(res: Parameters<typeof sendFile>[0], innerPath: string, size: number | null, etagName: string, url: string, download: boolean) {
  const headers: Record<string, string | number> = {
    "Content-Type": contentTypeOf(innerPath, url),
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${etagName}"`,
    "X-Content-Type-Options": "nosniff",
  };
  if (size) headers["Content-Length"] = size;
  res.set(headers);
  if (download) res.attachment(basename(innerPath.endsWith(".thumb") ? innerPath.slice(0, -".thumb".length) : innerPath));
}

async function sendCached(res: Parameters<typeof sendFile>[0], path: string, size: number, name: string, innerPath: string, url: string, download: boolean, next: (error?: unknown) => void) {
  applyRemoteHeaders(res, innerPath, size, name, url, download);
  await sendFile(res, path, { dotfiles: "allow" }, error => { if (error) next(error); });
}

/** 未命中缓存时边下载边转发：首字节只等上游 TTFB，不再等整个文件落盘 */
async function streamRemote(res: Parameters<typeof sendFile>[0], source: SourceConfig, innerPath: string, download: boolean, next: (error?: unknown) => void) {
  const url = await resolveSourceImage(source, innerPath);
  const cached = await readCachedImage(source, innerPath, url);
  if (cached) return sendCached(res, cached.path, cached.size, cached.name, innerPath, url, download, next);
  await withSourceSlot(source.id, async () => {
    const arrived = await readCachedImage(source, innerPath, url);
    if (arrived) return sendCached(res, arrived.path, arrived.size, arrived.name, innerPath, url, download, next);
    let response: Response;
    try {
      // redirect: "manual" 是安全边界的一部分：跟随重定向会让白名单 host 之外的地址被访问，
      // 上游一旦返回 302 到内网就绕过了 resolveRemoteUrl 的校验。素材 CDN 实测直出 200。
      response = await fetch(url, { headers: { "Accept-Encoding": "identity" }, redirect: "manual", signal: AbortSignal.timeout(upstreamTimeoutMs) });
    }
    catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      throw Object.assign(new Error(timedOut ? "上游素材响应超时" : "上游素材连接失败"), { status: timedOut ? 504 : 502, cause: error });
    }
    if (response.status === 404) throw Object.assign(new Error("找不到这个素材文件"), { status: 404 });
    if (response.status >= 300 && response.status < 400) {
      console.warn("[assets] 上游返回重定向，按失败处理", source.id, innerPath, response.status, response.headers.get("location"));
      throw Object.assign(new Error("上游素材请求失败"), { status: 502 });
    }
    if (!response.ok || !response.body) {
      console.warn("[assets] 上游素材请求失败", source.id, innerPath, response.status);
      throw Object.assign(new Error("上游素材请求失败"), { status: 502 });
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    applyRemoteHeaders(res, innerPath, declared > 0 ? declared : null, cacheFileName(source, innerPath, url), url, download);
    const writer = await beginCacheWrite(source, innerPath, url);
    try {
      for await (const chunk of response.body) {
        if (res.destroyed) { await writer.abort(); return; }
        await writer.write(chunk as Uint8Array);
        if (!res.write(chunk as Uint8Array)) await once(res, "drain");
      }
      await writer.commit();
      res.end();
    }
    catch (error) {
      await writer.abort();
      if (!res.destroyed) throw error;
    }
  });
}

export default router.get("/", validateFields({ path: z.string().min(1).max(4096), download: z.literal("true").optional() }, "query"), async (req, res, next) => {
  const download = req.query.download === "true";
  const target = u.assets.parseAssetPath(req.query.path as string);
  if (target.kind === "remote") {
    if (!target.innerPath) throw Object.assign(new Error("只能读取文件"), { status: 400 });
    await streamRemote(res, target.source, target.innerPath, download, next);
    return;
  }
  const root = await u.assets.getAssetsDirectory();
  const { directory, path } = await u.workspaceFile.resolveWorkspacePath(root, target.path);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  if (!(await lstat(path)).isFile()) throw Object.assign(new Error("只能读取文件"), { status: 400 });
  if (download) res.attachment(basename(path));
  res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
  await sendFile(res, path, { dotfiles: "allow" }, err => { if (err) next(err); });
});