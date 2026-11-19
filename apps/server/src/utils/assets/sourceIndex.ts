import { extname, join } from "node:path";
import { readFile, writeAtomic } from "@toonflow/file";
import { getAssetCacheDirectory } from "./index";
import { resolveRemoteUrl, validateSources } from "./sourcePath";
import type { AssetEntry, AssetVariant, SourceConfig, SourceFileRole } from "./sources";

type Row = Record<string, unknown>;
type IndexPart = { label: string; etag: string; items: Row[] };
/** 一个库可以由多份索引合成，每份单独记录 etag，避免一份变了整库重拉 */
type Snapshot = { version: 2; fetchedAt: number; stale?: boolean; parts: Record<string, IndexPart> };
type BuiltEntry = { role: SourceFileRole; name: string; url: string; innerPath: string; path: string; thumbPath?: string; alternate?: BuiltEntry };
/** 运行期状态：索引拉不到且没有快照的源要从目录树里彻底消失，而不是留给用户点进去报错 */
export async function sourceStatus(source: SourceConfig): Promise<{ available: boolean; stale: boolean }> {
  if (source.mode !== "index") return { available: true, stale: false };
  try {
    const snapshot = await ensureIndex(source);
    return { available: true, stale: snapshot.stale === true };
  }
  catch {
    return { available: false, stale: false };
  }
}

export type SourceTree = { groups: Map<string, AssetEntry[]>; all: AssetEntry[]; flat: AssetEntry[]; urlMap: Map<string, string>; keywords: Map<string, string>; stale: boolean };

const defaultTtlSeconds = 86400;
const requestTimeoutMs = 15000;
const fallbackGroupName = "未分组";
const failureCooldownMs = 60000;

const snapshots = new Map<string, Snapshot>();
const trees = new Map<string, SourceTree>();
const loading = new Map<string, Promise<void>>();
/** 失败冷却到期时间，避免源挂掉后每个 list 都干等一次超时 */
const failures = new Map<string, number>();

function textField(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === "object") : [];
}

function pickField(key: string, item: Row, view: Row | undefined) {
  if (key.startsWith("item.")) return view?.[key.slice(5)];
  if (view && key in view) return view[key];
  return item[key];
}

function renderTemplate(template: string, item: Row, view: Row | undefined, url?: string) {
  return template.replace(/\{([^{}]*)\}/g, (_, key: string) => {
    if (key === "ext") return url ? extname(url) : "";
    return textField(pickField(key, item, view));
  });
}

/** 目录段来自上游数据，斜杠会被当成层级，控制字符与 .. 直接判为不可用 */
function safeSegment(value: string) {
  const cleaned = value.replace(/[\\/]/g, "_").replace(/^@+/, "").trim();
  if (!cleaned || cleaned.includes("..") || /[\u0000-\u001f\u007f]/.test(cleaned)) return null;
  return cleaned;
}

async function readSnapshotFile(source: SourceConfig) {
  try {
    const content = await readFile(join(await getAssetCacheDirectory(), `${source.id}.json`));
    const parsed = JSON.parse(content.toString("utf8")) as Partial<Snapshot>;
    if (parsed.version !== 2 || !parsed.parts || typeof parsed.parts !== "object") return null;
    return { version: 2 as const, fetchedAt: Number(parsed.fetchedAt) || 0, parts: parsed.parts };
  }
  catch { return null; }
}

async function writeSnapshotFile(source: SourceConfig, snapshot: Snapshot) {
  const content = JSON.stringify({ version: 2, fetchedAt: snapshot.fetchedAt, parts: snapshot.parts });
  await writeAtomic(join(await getAssetCacheDirectory(), `${source.id}.json`), content);
}

/** 把多份索引的条目摊平，并记下来源，用于卡片上的来源标签 */
function snapshotItems(snapshot: Snapshot) {
  const rows: Row[] = [];
  for (const part of Object.values(snapshot.parts)) {
    for (const row of part.items) rows.push({ ...row, __origin: part.label });
  }
  return rows;
}

async function requestIndex(source: SourceConfig, cached: Snapshot | null) {
  const indexes = source.indexes ?? [];
  if (!indexes.length) throw Object.assign(new Error(`素材源缺少索引配置：${source.label}`), { status: 502 });
  const parts: Record<string, IndexPart> = {};
  let changed = false;
  for (const index of indexes) {
    const previous = cached?.parts?.[index.path];
    const headers: Record<string, string> = previous?.etag ? { "If-None-Match": previous.etag } : {};
    const response = await fetch(new URL(index.path, source.baseUrl), { headers, signal: AbortSignal.timeout(requestTimeoutMs) });
    if (response.status === 304 && previous) {
      parts[index.path] = { ...previous, label: index.label };
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`素材索引请求失败：${source.label} ${response.status}`), { status: 502 });
    const items = (await response.json()) as unknown;
    if (!Array.isArray(items)) throw Object.assign(new Error(`素材索引格式不正确：${source.label}`), { status: 502 });
    parts[index.path] = { label: index.label, etag: response.headers.get("etag") ?? "", items: items as Row[] };
    changed = true;
  }
  if (!changed && cached) {
    const refreshed: Snapshot = { ...cached, parts, fetchedAt: Date.now(), stale: false };
    snapshots.set(source.id, refreshed);
    await writeSnapshotFile(source, refreshed);
    return refreshed;
  }
  const snapshot: Snapshot = { version: 2, fetchedAt: Date.now(), parts };
  snapshots.set(source.id, snapshot);
  await writeSnapshotFile(source, snapshot);
  trees.delete(source.id);
  return snapshot;
}

/** 索引过期只影响刷新，不阻塞出树：优先用内存，其次磁盘快照，都失败才让该源缺席 */
async function ensureIndex(source: SourceConfig) {
  const cached = snapshots.get(source.id);
  if (cached && Date.now() - cached.fetchedAt < defaultTtlSeconds * 1000) return cached;
  // 失败冷却：源挂掉时不要让每次 list 都去等一次上游超时。
  if ((failures.get(source.id) ?? 0) > Date.now()) throw Object.assign(new Error(`素材源 ${source.label} 暂时不可用`), { status: 502 });
  const pending = loading.get(source.id);
  if (pending) {
    await pending;
    return snapshots.get(source.id)!;
  }
  const task = (async () => {
    try { await requestIndex(source, cached ?? await readSnapshotFile(source)); failures.delete(source.id); }
    catch (error) {
      const fallback = snapshots.get(source.id) ?? await readSnapshotFile(source);
      if (!fallback) {
        failures.set(source.id, Date.now() + failureCooldownMs);
        throw Object.assign(new Error(`素材源 ${source.label} 暂时不可用`), { status: 502, cause: error });
      }
      console.warn(`素材源 ${source.label} 索引刷新失败，改用本地快照：${(error as Error).message}`);
      snapshots.set(source.id, { ...fallback, stale: true });
    }
  })().finally(() => loading.delete(source.id));
  loading.set(source.id, task);
  await task;
  return snapshots.get(source.id)!;
}

function buildItem(source: SourceConfig, item: Row, urlMap: Map<string, string>) {
  const group = source.groupBy ? safeSegment(textField(item[source.groupBy])) ?? fallbackGroupName : "";
  const built: BuiltEntry[] = [];
  const alternates: BuiltEntry[] = [];
  const thumbs = source.files.filter(file => file.role === "thumb");
  for (const file of source.files) {
    const role = file.role ?? "original";
    if (role === "thumb") continue;
    for (const view of file.from ? rowsOf(item[file.from]) : [undefined]) {
      const url = renderTemplate(file.url, item, view);
      const name = safeSegment(renderTemplate(file.name ?? "", item, view, url));
      if (!name) throw new Error(`产出名不合法：${file.name} → ${renderTemplate(file.name ?? "", item, view, url)}`);
      const innerPath = group ? `${group}/${name}` : name;
      if (urlMap.has(innerPath)) throw new Error(`条目路径重复：${innerPath}`);
      urlMap.set(innerPath, resolveRemoteUrl(source, url));
      const entry: BuiltEntry = { role, name, url, innerPath, path: `@${source.id}/${innerPath}` };
      if (role === "alternate") alternates.push(entry);
      else built.push(entry);
    }
  }
  // 第二视图按出现顺序贴回原条目：同一条记录里第 N 个 alternate 配第 N 个 original
  alternates.forEach((entry, index) => {
    const target = built[index] ?? built[0];
    if (target) target.alternate = entry;
  });
  for (const file of thumbs) {
    const wanted = file.thumbFor ?? "original";
    const targets = wanted === "alternate" ? built.map(entry => entry.alternate).filter((entry): entry is BuiltEntry => !!entry) : built;
    const views = file.from ? rowsOf(item[file.from]) : [undefined];
    views.forEach((view, index) => {
      const target = targets[index] ?? targets[0];
      if (!target) return;
      const url = renderTemplate(file.url, item, view);
      urlMap.set(`${target.innerPath}.thumb`, resolveRemoteUrl(source, url));
      target.thumbPath = `${target.path}.thumb`;
    });
  }
  return built;
}

/** 搜索文本：索引记录里所有标量字段拼一串，不绑定字段名，换一份索引也不用改代码 */
function keywordOf(item: Row) {
  return Object.values(item).filter(value => typeof value === "string" || typeof value === "number").join(" ").toLocaleLowerCase();
}

function buildTree(source: SourceConfig, snapshot: Snapshot): SourceTree {
  const urlMap = new Map<string, string>();
  const groups = new Map<string, AssetEntry[]>();
  const all: AssetEntry[] = [];
  const keywords = new Map<string, string>();
  const flat: AssetEntry[] = [];
  /** mergeBy 命中的第一条占据列表位置，同组的其他记录变成它的变体 */
  const merged = new Map<string, AssetEntry>();
  let skipped = 0;
  snapshotItems(snapshot).forEach((item, index) => {
    try {
      const meta = source.meta ? safeSegment(renderTemplate(source.meta, item, undefined)) ?? "" : "";
      const mergeKey = source.mergeBy ? safeSegment(renderTemplate(source.mergeBy, item, undefined)) ?? "" : "";
      for (const built of buildItem(source, item, urlMap)) {
        const groupName = built.innerPath.includes("/") ? built.innerPath.slice(0, built.innerPath.lastIndexOf("/")) : "";
        if (groupName && (source.hiddenGroups?.includes(groupName) ?? false)) continue;
        const variant: AssetVariant = { label: source.variantLabel ? renderTemplate(source.variantLabel, item, undefined) : meta, path: built.path, name: built.name, ...(built.thumbPath ? { thumbPath: built.thumbPath } : {}) };
        if (built.alternate) {
          variant.alternatePath = built.alternate.path;
          variant.alternateName = built.alternate.name;
          if (built.alternate.thumbPath) variant.alternateThumbPath = built.alternate.thumbPath;
        }
        if (mergeKey) {
          const existing = merged.get(`${groupName}\u0000${mergeKey}`);
          if (existing) { existing.variants!.push(variant); continue; }
        }
        const entry: AssetEntry = { name: variant.name, path: variant.path, type: "file", readOnly: true };
        if (variant.thumbPath) entry.thumbPath = variant.thumbPath;
        if (variant.alternatePath) entry.alternatePath = variant.alternatePath;
        if (variant.alternateName) entry.alternateName = variant.alternateName;
        if (variant.alternateThumbPath) entry.alternateThumbPath = variant.alternateThumbPath;
        const badge = source.badge ? safeSegment(renderTemplate(source.badge, item, undefined)) : "";
        if (badge) entry.badge = badge;
        if (meta) entry.meta = meta;
        if (mergeKey) { entry.variants = [variant]; merged.set(`${groupName}\u0000${mergeKey}`, entry); }
        const origin = textField(item.__origin);
        if (origin) entry.origin = origin;
        if (groupName) entry.group = groupName;
        all.push(entry);
        keywords.set(built.path, `${keywordOf(item)} ${built.name.toLocaleLowerCase()}`);
        if (!groupName) { flat.push(entry); continue; }
        const bucket = groups.get(groupName) ?? [];
        bucket.push(entry);
        groups.set(groupName, bucket);
      }
    }
    catch (error) {
      skipped++;
      if (index < 3) throw new Error(`素材源 ${source.label} 的字段映射与索引不匹配：${(error as Error).message}`);
      if (skipped === 1) console.warn(`素材源 ${source.label} 有条目被跳过：${(error as Error).message}`);
    }
  });
  return { groups, all, flat, urlMap, keywords, stale: snapshot.stale === true };
}

async function readSourceTree(source: SourceConfig) {
  const key = source.id;
  const cached = trees.get(key);
  if (cached) return cached;
  const tree = buildTree(source, await ensureIndex(source));
  trees.set(key, tree);
  return tree;
}

/** 按层返回：根层是分组目录，组层是条目，避免一次把 7,771 条铺进前端 */
export async function listSourceEntries(source: SourceConfig, innerPath: string) {
  const tree = await readSourceTree(source);
  // 分类列表在每一层都回传：用户换分类不该先退回库根
  const groups: AssetEntry[] = [...tree.groups.keys()]
    .map(name => ({ name, path: `@${source.id}/${name}`, type: "directory" as const, readOnly: true, count: tree.groups.get(name)?.length ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  if (!innerPath) {
    // 根层给全部条目：分类是筛选条件，不是目录层级，别让用户点两层才看到图
    return { entries: tree.all, stale: tree.stale, groups };
  }
  const bucket = tree.groups.get(innerPath);
  if (!bucket) throw Object.assign(new Error("找不到这个素材文件夹"), { status: 404 });
  return { entries: bucket, stale: tree.stale, groups };
}

/**
 * 跨源搜索：索引全量驻留内存，6,162 条全表扫描实测 0.61–0.99 ms，不需要倒排表。
 * 单个源不可用时跳过它，其余源照常出结果。
 */
export async function searchSourceEntries(query: string, limit: number, offset: number) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { items: [], total: 0, partial: false };
  const items: { sourceId: string; sourceLabel: string; entry: AssetEntry }[] = [];
  let partial = false;
  for (const source of validateSources().available) {
    if (source.mode !== "index") continue;
    let tree: SourceTree;
    try { tree = await readSourceTree(source); }
    catch { partial = true; continue; }
    for (const entry of tree.all) {
      if (tree.keywords.get(entry.path)?.includes(needle)) {
        items.push({ sourceId: source.id, sourceLabel: source.label, entry });
      }
    }
  }
  return { items: items.slice(offset, offset + limit), total: items.length, partial };
}

/** 读图片时按源内路径反查上游地址 */
export async function resolveSourceImage(source: SourceConfig, innerPath: string) {
  const tree = await readSourceTree(source);
  const url = tree.urlMap.get(innerPath);
  if (!url) throw Object.assign(new Error("找不到这个素材文件"), { status: 404 });
  return url;
}