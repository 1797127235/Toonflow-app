import { lstat, readdir } from "@toonflow/file";
import { join, relative, sep } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { listSourceEntries, sourceStatus } from "@/utils/assets/sourceIndex";
import type { AssetEntry } from "@/utils/assets/sources";
import { validateSources } from "@/utils/assets/sourcePath";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

/** 只列一层：远程库有 7,771 条，递归返回会把前端 DOM 撑爆 */
async function listEntries(root: string, directory: string): Promise<AssetEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() || entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
    .map(entry => ({
      name: entry.name,
      path: relative(root, join(directory, entry.name)).split(sep).join("/"),
      type: entry.isDirectory() ? "directory" as const : "file" as const,
    }));
}

/** 递归整树：只给「移动到」这类需要一次看全本地目录的场景用，别拿它铺列表 */
async function listTree(root: string, directory: string): Promise<AssetEntry[]> {
  const entries = await listEntries(root, directory);
  return Promise.all(entries.map(async entry => entry.type === "directory"
    ? { ...entry, children: await listTree(root, join(root, entry.path)) }
    : entry));
}

async function resolveDirectory(root: string, path: string) {
  const resolved = await u.workspaceFile.resolveWorkspacePath(root, path);
  u.workspaceFile.protectWorkspaceRoot(resolved.directory, resolved.path);
  if (!(await lstat(resolved.path)).isDirectory()) throw Object.assign(new Error("只能列出文件夹"), { status: 400 });
  return resolved.path;
}

export default router.get("/", validateFields({
  path: z.string().max(4096).optional(),
  recursive: z.literal("true").optional(),
}, "query"), async (req, res) => {
  const path = typeof req.query.path === "string" ? req.query.path : "";
  const target = u.assets.parseAssetPath(path);
  if (target.kind === "remote") {
    const { entries, stale, groups } = await listSourceEntries(target.source, target.innerPath);
    return res.set("Cache-Control", "no-store").json(success({ entries, stale, groups }));
  }
  const root = await u.assets.getAssetsDirectory();
  const directory = target.path ? await resolveDirectory(root, target.path) : root;
  if (req.query.recursive === "true") return res.set("Cache-Control", "no-store").json(success({ entries: await listTree(root, directory) }));
  const entries = await listEntries(root, directory);
  // 源列表只在根层给：带 path 的请求是展开某一层，不需要再算一遍运行期状态。
  if (path) return res.set("Cache-Control", "no-store").json(success({ entries }));
  const described = await Promise.all(validateSources().available.map(async source => {
    const status = await sourceStatus(source);
    return status.available ? { id: source.id, label: source.label, readOnly: source.writable !== true, stale: status.stale, multiOrigin: (source.indexes?.length ?? 0) > 1 } : null;
  }));
  res.set("Cache-Control", "no-store").json(success({ entries, sources: described.filter(source => source !== null) }));
});