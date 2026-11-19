import { createHash, randomUUID } from "node:crypto";
import { extname, join, sep } from "node:path";
import { mkdir, open, readdir, rename, stat, unlink } from "@toonflow/file";
import { getAssetCacheDirectory } from "./index";
import type { SourceConfig } from "./sources";

const defaultLimitBytes = 2 * 1024 * 1024 * 1024;
const defaultSourceConcurrency = 4;
const contentTypes: Record<string, string> = {
  ".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

type CacheEntry = { bytes: number; mtimeMs: number };

const cacheEntries = new Map<string, CacheEntry>();
const activeTasks = new Map<string, number>();
const waiters = new Map<string, (() => void)[]>();
let indexed = false;
let totalBytes = 0;

/** 缩略图路径以 .thumb 结尾，真实扩展名要去掉这一段才算 */
function realPath(innerPath: string) {
  return innerPath.endsWith(".thumb") ? innerPath.slice(0, -".thumb".length) : innerPath;
}

export function contentTypeOf(innerPath: string, url?: string) {
  // 缩略图常与原图不同格式（原图 png、缩略图 jpg），扩展名以真实地址为准
  const ext = extname(url ?? realPath(innerPath)).toLowerCase();
  return contentTypes[ext] ?? contentTypes[extname(realPath(innerPath)).toLowerCase()] ?? "application/octet-stream";
}

export function cacheFileName(source: SourceConfig, innerPath: string, url?: string) {
  // 哈希用原始路径，缩略图与原图才有各自的缓存位；扩展名跟着真实地址走。
  const ext = extname(url ?? realPath(innerPath)).toLowerCase();
  return `${createHash("sha256").update(`${source.id}/${innerPath}`).digest("hex")}${ext || extname(realPath(innerPath)).toLowerCase() || ".bin"}`;
}

function cacheKey(source: SourceConfig, innerPath: string, url?: string) {
  return `${source.id}/${cacheFileName(source, innerPath, url)}`;
}

async function ensureIndex() {
  if (indexed) return;
  const root = await getAssetCacheDirectory();
  let names: string[] = [];
  // 扫描失败时不要标记成已索引，否则本次进程内缓存永远命中不了
  try { names = (await readdir(root, { recursive: true })) as string[]; }
  catch { return; }
  indexed = true;
  for (const name of names) {
    const path = join(root, name);
    if (name.endsWith(".tmp")) { void unlink(path).catch(() => {}); continue; }
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      cacheEntries.set(name.split(sep).join("/"), { bytes: info.size, mtimeMs: info.mtimeMs });
      totalBytes += info.size;
    }
    catch { /* 并发删除等，忽略 */ }
  }
}

/** 只做总量淘汰，不按时间过期：缩略图全量 124 MB，原图靠 LRU 周转 */
export async function pruneImageCache(limitBytes = defaultLimitBytes) {
  await ensureIndex();
  if (totalBytes <= limitBytes * 1.1) return;
  const root = await getAssetCacheDirectory();
  const ordered = [...cacheEntries].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
  for (const [key, entry] of ordered) {
    if (totalBytes <= limitBytes * 0.9) break;
    try { await unlink(join(root, key)); }
    catch { /* 已被删除 */ }
    cacheEntries.delete(key);
    totalBytes -= entry.bytes;
  }
}

export async function readCachedImage(source: SourceConfig, innerPath: string, url?: string) {
  await ensureIndex();
  const key = cacheKey(source, innerPath, url);
  if (!cacheEntries.has(key)) return null;
  const path = join(await getAssetCacheDirectory(), key);
  try {
    const info = await stat(path);
    // 命中即更新内存里的时间戳，淘汰才按最近使用而不是最近写入排序
    const entry = cacheEntries.get(key);
    if (entry) entry.mtimeMs = Date.now();
    return { path, size: info.size, name: cacheFileName(source, innerPath, url) };
  }
  catch {
    cacheEntries.delete(key);
    return null;
  }
}

/** 临时文件写完再 rename，命中时拿到的必然是完整文件 */
export async function beginCacheWrite(source: SourceConfig, innerPath: string, url?: string) {
  await ensureIndex();
  const directory = join(await getAssetCacheDirectory(), source.id);
  await mkdir(directory, { recursive: true });
  const name = cacheFileName(source, innerPath, url);
  const target = join(directory, name);
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  const key = `${source.id}/${name}`;
  let position = 0;
  return {
    async write(chunk: Uint8Array) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, position);
        offset += bytesWritten;
        position += bytesWritten;
      }
    },
    async commit() {
      await handle.close();
      try { await unlink(target); }
      catch { /* 目标本来就不存在 */ }
      try { await rename(temp, target); }
      catch (error) {
        // 同一张图被并发下载时，另一次 commit 可能已经写好了目标，这里按成功算
        const settled = await stat(target).catch(() => null);
        if (!settled) throw error;
        await unlink(temp).catch(() => {});
      }
      const previous = cacheEntries.get(key)?.bytes ?? 0;
      cacheEntries.set(key, { bytes: position, mtimeMs: Date.now() });
      totalBytes += position - previous;
      await pruneImageCache();
    },
    async abort() {
      await handle.close().catch(() => {});
      await unlink(temp).catch(() => {});
    },
  };
}

/** 同一上游并发上限，避免一次展开把站点打满 */
export async function withSourceSlot<T>(sourceId: string, task: () => Promise<T>) {
  while ((activeTasks.get(sourceId) ?? 0) >= defaultSourceConcurrency) {
    await new Promise<void>(resolve => {
      const queue = waiters.get(sourceId) ?? [];
      queue.push(resolve);
      waiters.set(sourceId, queue);
    });
  }
  activeTasks.set(sourceId, (activeTasks.get(sourceId) ?? 0) + 1);
  try { return await task(); }
  finally {
    activeTasks.set(sourceId, Math.max(0, (activeTasks.get(sourceId) ?? 1) - 1));
    waiters.get(sourceId)?.shift()?.();
  }
}