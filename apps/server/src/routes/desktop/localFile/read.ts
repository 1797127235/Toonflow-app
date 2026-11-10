import { readFile, stat } from "@toonflow/file";
import { basename, extname, isAbsolute } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { t } from "@/lib/i18n";

const inputSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(32),
});

const mediaTypes: Record<string, string> = {
  ".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".apng": "image/apng",
  ".aac": "audio/aac", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
  ".avi": "video/x-msvideo", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".mp4": "video/mp4", ".webm": "video/webm",
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv", ".log": "text/plain",
  ".json": "application/json", ".xml": "application/xml", ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".ndjson": "application/x-ndjson",
};

async function readDroppedFile(path: string) {
  const target = path.trim();
  if (!target || target.includes("\0") || !isAbsolute(target)) throw new Error(t`拖入路径无效`);
  const info = await stat(target);
  const name = basename(target);
  if (!info.isFile()) throw new Error(t`“${name}”不是文件`);
  if (!info.size || info.size > 100 * 1024 * 1024) throw new Error(t`“${name}”为空或超过 100 MB`);
  const bytes = await readFile(target);
  return { name, mimeType: mediaTypes[extname(target).toLowerCase()] ?? "application/octet-stream", data: Buffer.from(bytes).toString("base64") };
}

// Linux WebKit 的拖放拿不到 File 内容，只留下 file:// 路径，由本机进程读取。
export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  u.desktop.getDesktopRuntime(req);
  const { paths } = req.body as z.infer<typeof inputSchema>;
  const files = [];
  for (const path of paths) files.push(await readDroppedFile(path));
  res.set("Cache-Control", "no-store");
  res.json(success({ files }));
});
