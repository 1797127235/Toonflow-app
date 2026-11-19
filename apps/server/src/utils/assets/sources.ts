/**
 * 素材源表。新增一个源 = 往 assetSources 里加一个对象，不在业务代码里写该源的任何分支。
 *
 * 字段一律来自上游索引的实测结果，改字段前先在真实索引上核对。
 * 授权状态（规格 docs/assetSources.md 第 7 节，不改代码）：
 * - pose / costume / shisei / giaAnime / portrait：上游 LICENSE 声明图片与索引不适用 MIT，
 *   禁止商业用途、禁止提取倒卖。本设计只代理不复制，图片不落到素材库目录。
 * - charadb：上游禁止再分发图片。
 */

export type SourceFileRole = "original" | "thumb" | "alternate";

export type SourceFile = {
  /** 产出文件名模板；role 为 thumb 时省略，该角色只产出条目的 thumbPath */
  name?: string;
  /** 图片地址模板，相对地址按所在源的 baseUrl 解析 */
  url: string;
  /** original 进文件树；alternate 作为同一条记录的第二视图；thumb 只做缩略图 */
  role?: SourceFileRole;
  /** 索引里的数组字段名，配置后每条记录按该数组逐项展开 */
  from?: string;
  /** 缩略图归属的角色，缺省 original；第二视图需要自己的缩略图 */
  thumbFor?: Exclude<SourceFileRole, "thumb">;
};

export type SourceConfig = {
  id: string;
  label: string;
  /** directory 走本地磁盘；index 走远程索引 + 图片代理 */
  mode: "directory" | "index";
  writable?: boolean;
  baseUrl?: string;
  /** 一个库可以由多份索引合成，label 作为条目的来源标记 */
  indexes?: { label: string; path: string }[];
  /** index 模式必填：只允许从这些 host 取图 */
  allowedHosts?: string[];
  /** 按该索引字段再分一层目录 */
  groupBy?: string;
  /** 不展示的分组（上游标注的限制级分类，本库只取常规素材） */
  hiddenGroups?: string[];
  /** 同一个姿势有多个视角时按该模板聚合，例如 "{姿势编号}"；聚合后的其他记录成为条目的变体 */
  mergeBy?: string;
  variantLabel?: string;
  /** 卡片左上角标签模板，例如编号 */
  badge?: string;
  /** 卡片右上角标签模板，例如角度 */
  meta?: string;
  files: SourceFile[];
};

export type AssetVariant = {
  label: string;
  path: string;
  name: string;
  thumbPath?: string;
  alternatePath?: string;
  alternateThumbPath?: string;
  alternateName?: string;
};

export type AssetEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: AssetEntry[];
  readOnly?: boolean;
  thumbPath?: string;
  stale?: boolean;
  /** 来自哪份索引，例如「ギア・现实服装」 */
  origin?: string;
  /** 同一条记录的第二视图（例如深度图），卡片内切换，不单独占一条 */
  alternatePath?: string;
  alternateThumbPath?: string;
  alternateName?: string;
  /** 卡片角标，例如编号与角度 */
  badge?: string;
  meta?: string;
  /** 目录条目下直接挂条目数，前端用一行 chips 展示分组 */
  count?: number;
  group?: string;
  /** 同一对象的不同视角，卡片内切换 */
  variants?: AssetVariant[];
};

export const localSourceId = "local";

export const assetSources: SourceConfig[] = [
  { id: localSourceId, label: "我的素材", mode: "directory", writable: true, files: [] },
  {
    id: "pose",
    label: "姿势库",
    mode: "index",
    baseUrl: "https://ai-pose-gallery.anhao.app",
    indexes: [{ label: "ギア・动作姿势", path: "/data/pose-zh.json" }],
    allowedHosts: ["ai-pose-gallery.anhao.app", "ai-pose-depth-gallery.pages.dev"],
    groupBy: "体系",
    hiddenGroups: ["全身单人・性感系", "双人缠绵"],
    mergeBy: "{姿势编号}",
    variantLabel: "{角度}",
    badge: "{姿势编号}",
    meta: "{分类}",
    files: [
      { name: "{姿势名称}（{角度}）{ext}", url: "{原图}" },
      { name: "{姿势名称}（{角度}）_深度{ext}", url: "https://ai-pose-depth-gallery.pages.dev/img/{id}.png", role: "alternate" },
      { url: "{缩略图}", role: "thumb" },
      { url: "https://ai-pose-depth-gallery.pages.dev/thumbs/{id}.jpg", role: "thumb", thumbFor: "alternate" },
    ],
  },
  {
    id: "costume",
    label: "服装穿搭库",
    mode: "index",
    baseUrl: "https://ai-pose-gallery.anhao.app",
    indexes: [
      { label: "ギア・现实服装", path: "/data/costume-zh.json" },
      { label: "ギア・动漫", path: "/data/costume-gia-anime-zh.json" },
      { label: "AI・CharaDB", path: "/data/costume-anime-zh.json" },
      { label: "Shisei・中国历代", path: "/data/costume-shisei-zh.json" },
    ],
    allowedHosts: ["ai-pose-gallery.anhao.app", "ai-costume-anime-gallery.pages.dev", "charadb-2fi.pages.dev"],
    groupBy: "分类",
    hiddenGroups: ["内衣・睡衣", "性感穿搭"],
    files: [
      { name: "{服装名称}（{id}）{ext}", url: "{原图}" },
      { url: "{缩略图}", role: "thumb" },
    ],
  },
  {
    id: "portrait",
    label: "人像库",
    mode: "index",
    baseUrl: "https://ai-pose-gallery.anhao.app",
    indexes: [{ label: "ギア・人像", path: "/data/portrait-zh.json" }],
    allowedHosts: ["ai-pose-gallery.anhao.app"],
    groupBy: "分区",
    meta: "{发长}",
    files: [
      { name: "{标题}（{id}）{ext}", url: "{原图}" },
      { url: "{缩略图}", role: "thumb" },
    ],
  },
];