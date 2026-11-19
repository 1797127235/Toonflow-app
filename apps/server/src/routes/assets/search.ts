import { readdir } from "@toonflow/file";
import { join, relative, sep } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { searchSourceEntries } from "@/utils/assets/sourceIndex";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();
const maxLimit = 200;
const maxLocalMatches = 2000;

export default router.get("/", validateFields({
  q: z.string().min(1).max(200),
  limit: z.string().optional(),
  offset: z.string().optional(),
}, "query"), async (req, res) => {
  const query = (req.query.q as string).trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), maxLimit);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const local = await searchLocalAssets(query, limit + offset);
  const remote = await searchSourceEntries(query, limit + offset, 0);
  const items = [
    ...local.map(entry => ({ source: u.assets.localSourceId, sourceLabel: "我的素材", readOnly: false, ...entry })),
    ...remote.items.map(({ sourceId, sourceLabel, entry }) => ({
      source: sourceId,
      sourceLabel,
      readOnly: true,
      name: entry.name,
      path: entry.path,
      type: "file",
      ...(entry.thumbPath ? { thumbPath: entry.thumbPath } : {}),
    })),
  ].slice(offset, offset + limit);
  res.set("Cache-Control", "no-store").json(success({ items, total: local.length + remote.total, partial: remote.partial }));
});

/** 本地按文件名匹配，路径统一带 @local/ 前缀，前端只认一种写法 */
async function searchLocalAssets(query: string, take: number) {
  const root = await u.assets.getAssetsDirectory();
  const needle = query.toLocaleLowerCase();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const matches: { name: string; path: string; type: "file" }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLocaleLowerCase().includes(needle)) continue;
    matches.push({
      name: entry.name,
      path: `@${u.assets.localSourceId}/${relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")}`,
      type: "file",
    });
    if (matches.length >= Math.min(take, maxLocalMatches)) break;
  }
  return matches.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}