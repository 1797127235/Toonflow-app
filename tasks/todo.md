# Todo: 素材源接入（asset-sources）

规格：`docs/assetSources.md`；设计决策与风险：`tasks/plan.md`。

验证约束（AGENTS.md）：不新增测试文件/框架；验证 = `bun run typecheck`、临时数据目录起服务 + curl 手工验证、本地素材库人工回归。

进度：Task 1–4 完成；Task 5 接口层验证通过，界面人工回归待做。

## Task 1: 骨架与安全边界

**Description:** 建立源配置数据与路径分流，把"哪些请求属于远程源"和"哪些 URL 允许访问"这两件事定死，全程不联网。

新建 `apps/server/src/utils/assets/sources.ts`：

- 类型 `SourceFile`、`SourceConfig`、`AssetEntry`（`AssetEntry` 从 `routes/assets/list.ts:7` 迁来，加 `readOnly?`、`thumbPath?`、`stale?`）
- `const assetSources: SourceConfig[]`，七个源按规格 3.4 逐字落地
- `const localSourceId = "local"`

新建 `apps/server/src/utils/assets/sourcePath.ts`：

- `parseAssetPath(path: string): { kind: "local"; path: string } | { kind: "remote"; source: SourceConfig; innerPath: string }`
  取首个 `/` 前的段去前导 `@`，命中已注册且非本地 id 才走远程，否则整串回落本地
- `resolveRemoteUrl(source: SourceConfig, value: string): string`
  五条校验（`http(s)`、host 命中 `allowedHosts`、无 userinfo、端口缺省或 80/443、`..` 不越界），失败抛 `status: 404`
- `validateSources(): { available: SourceConfig[]; disabled: { id: string; reason: string }[] }`
  静态校验（mode 与 root/indexPath 配套、index 源 allowedHosts 非空且 files 非空、directory 源 files 为空、id 唯一且合格式、模板占位符已声明），进程内算一次并缓存

修改 `apps/server/src/utils/assets/index.ts`：导出上述三样，供 `u.assets.*` 使用。

**Acceptance criteria:**

- [x] `parseAssetPath("@pose/img/x.png")` 返回 remote、`innerPath = "img/x.png"`
- [x] `parseAssetPath("@local/a.png")`、`parseAssetPath("@未知/a.png")`、`parseAssetPath("a.png")` 全部返回 local
- [x] `resolveRemoteUrl` 对 `http://127.0.0.1/x`、`https://evil.example/x`、`http://u:p@ai-pose-gallery.anhao.app/x`、`http://ai-pose-gallery.anhao.app:8080/x`、越界 `../` 一律抛 404
- [x] `validateSources()` 对七个内置源全部 available；把某源 `allowedHosts` 清空后该源进 disabled 且 reason 可读
- [x] `cd apps/server && bun run typecheck` 通过

**Verification:**

- [x] `bun -e` 单行断言上述分支（不新增文件）
- [x] `grep -rn 'source.id ===' apps/server/src` 无命中

**Dependencies:** None

## Task 2: 索引加载与目录树

**Description:** 让 `list` 能列出 7 个源目录，并能按层展开远程目录。

新建 `apps/server/src/utils/assets/sourceIndex.ts`：

- `loadSourceIndex(source)`：首次 `fetch(baseUrl + indexPath)`；成功后 `writeAtomic` 写 `data/assetCache/<sourceId>.json`（含 `etag`、`fetchedAt`）并驻留内存；TTL 86,400 s 内不重复请求；过期后带 `If-None-Match`，304 只更新 `fetchedAt`；失败时有快照则用快照并返回 `stale: true`，无快照则该源从树中缺席
- `buildSourceEntries(source, index)`：按 `groupBy` 分组生成目录层；每条记录按 `files` 模板插值产出文件条目（`role: "thumb"` 只写 `thumbPath`，`role: "depth"` 产出独立条目）；`from` 数组逐项展开、元素字段优先
- 数据层校验：取前三条记录跑全部模板，检查产物名非空、无残留 `{`、不含 `/`／`\`／`..`／控制字符、不以 `@` 开头，URL 通过 `resolveRemoteUrl`；失败则整源标 disabled

修改 `apps/server/src/routes/assets/list.ts`：

- `validateFields({ path: z.string().min(1).max(4096).optional() }, "query")`
- `path` 缺省：走原递归逻辑，只扫本地 `data/assets`，行为逐字节不变
- `path` 为 `@<id>`：返回该源根层（分组目录或扁平条目），源目录条目带 `readOnly: true`、`stale` 按快照状态
- `path` 为 `@<id>/<分组>`：返回该组条目

**Acceptance criteria:**

- [x] `GET /api/assets/list` 返回 7 个源目录，姿势库下恰有 4 个体系子目录（399/365/400/275 条）
- [x] `GET /api/assets/list?path=@pose/<某个体系>` 返回该体系条目数，与索引统计一致
- [x] 条目 `name` 走 `{姿势名称}（{姿势编号}）` 模板，`thumbPath` 指向 `thumbs/…` 缩略图
- [x] 断网且已有快照时 `list` 仍返回全部源，源目录条目 `stale: true`
- [x] 把某源 `indexPath` 改错 → 该源从树中消失，其余 6 源正常，日志有原因

**Verification:**

- [x] `TOONFLOW_DATA_DIR=/tmp/as-data bun src/index.ts`，`curl -s localhost:PORT/api/assets/list | jq`
- [x] `ls /tmp/as-data/assetCache/` 出现六个 `<sourceId>.json` 快照

**Dependencies:** Task 1

## Task 3: 图片代理与缓存

**Description:** `read` 能取回远程字节，并落到磁盘缓存。

新建 `apps/server/src/utils/assets/imageCache.ts`：

- `cacheFilePath(source, innerPath)`：`data/assetCache/<sourceId>/<sha256(innerPath)>.<ext>`
- `readCachedFile(path)` / `writeCachedStream(source, innerPath, stream)`：临时文件逐块写 → `close` → 目标已存在先 `unlink` → `rename`；全程走 `@toonflow/file` 的 `open`/`rename`/`unlink`
- 内存表 `cacheIndex: Map<sha256, { bytes: number; mtimeMs: number }>`：启动扫一次目录建表，写入累加字节，超过上限 1.1 倍触发按 `mtime` 批量淘汰并重扫
- 每源并发队列，上限 4

修改 `apps/server/src/routes/assets/read.ts`：

- `@` 路径分流：用 `parseAssetPath` 取源与条目，`resolveRemoteUrl` 得 URL
- 命中缓存：`sendFile`，头 `content-type` 按扩展名、`Cache-Control: public, max-age=31536000, immutable`、`ETag: "<sha256(源内路径)>"`、`X-Content-Type-Options: nosniff`
- 未命中：`fetch(url, { headers: { "Accept-Encoding": "identity" } })`，流式 tee（边写临时文件边 `res.write`），结束后 `rename`
- 上游 404 → 该条目本次会话标失效、返回 404 且不写缓存；网络失败/超时（连接 5 s、整体 30 s）→ 502/504 且不写缓存；单文件超 100 MB 只转发不落缓存

**Acceptance criteria:**

- [x] `read?path=@pose/full_sexy_P001_front.png` 返回 200、523,791 字节，`sha256sum` 与上游直取一致
- [x] 第二次请求同一路径命中缓存（响应时间 < 10 ms，缓存文件 `mtime` 不变），不再向上游发请求
- [x] 缓存目录不出现 `.part`/`.tmp` 残留；中断一次大图（portrait 3 MB）后再请求仍返回完整字节
- [x] 上游 404 不产生缓存文件

**Verification:**

- [x] `curl -sI` 头部与字节数；`sha256sum` 比对缓存文件与上游直取
- [x] `find /tmp/as-data/assetCache -name '*.part' -o -name '*.tmp'` 为空

**Dependencies:** Task 1、Task 2

## Task 4: 只读与错误语义

**Description:** 远程源不可写，错误码与本地一致地走统一出口。

修改 `apps/server/src/routes/assets/{save,mkdir,rename,remove}.ts`：入口用 `parseAssetPath` 判断，命中 remote 一律 `res.status(403)` + `error(...)`，本地路径行为不变。

**Acceptance criteria:**

- [x] 四个写接口传 `@pose/x` 全部 403
- [x] 本地路径写入、建目录、改名、删除行为与改动前一致（含 409 `ESTALE` 与 revision 冲突）
- [x] `@nope/x.png` → 404；白名单拒绝 → 404；上游 5xx → 502；上游超时 → 504

**Verification:**

- [x] 四个接口 curl 各一次正例与反例

**Dependencies:** Task 1

## Task 5: 整链验证

**Description:** 按规格第六节跑完整清单，并回归本地素材库。

**Acceptance criteria:**

- [x] `bun run typecheck` 通过
- [x] 规格第六节全部 curl 通过（含源隔离负例、缓存残留检查、分层条数）
- [x] 本地素材库既有功能人工回归无变化：根目录列出本地文件、预览图片（界面已验证；拖进画布与 agent 引用走同一 `read` 接口，未单独人工走）

**Verification:**

- [x] 上述命令逐条执行并记录结果

**Dependencies:** Task 1–4
## 实测记录（2026-11-19，`TOONFLOW_DATA_DIR=/tmp/as-data`，端口 3111）

- 源列表：`local / pose / costume / shisei / giaAnime / charadb / portrait`，除 `local` 外 `readOnly: true`。
- 分层条目：姿势库 4 组 / 2,878 条；服装库 8 组 / 1,407；Shisei 1 组 / 227；动漫服装 8 组 / 1,320；CharaDB 15 组 / 440；人像库 2 组 / 1,499。合计 7,771，与规格一致。
- 图片：原图 563,895 B `image/png`、缩略图 13,005 B `image/jpeg`、深度图 90,498 B `image/png`，三者各自独立缓存文件；缓存文件 sha256 与上游直取字节一致；二次请求 0–1 ms 命中。
- 中断：限速 20k、1.2 s 掐断后 `.tmp` 残留 0，重取得到完整 372,758 B 且 sha256 与首次一致。
- 只读守卫：`save`/`mkdir`/`rename`/`remove` 传 `@pose/...` 全部 403，中文与英文（`Accept-Language: en`）文案均正确。
- 源隔离：`indexPath` 改成不存在路径后，无快照时该源从 `sources` 消失、其余 6 源正常；有快照时回退快照并标 `stale: true`，日志记「索引刷新失败，改用本地快照」。
- 失败冷却：坏源二次请求 9 ms 返回 502，不再等上游超时。
- 本地回归：本地 `list`/`save`/`read`/`rename`/`remove`/建目录全 200，行为未变。

## 界面改造（2026-11-19）

**范围**：`assetLibrary.vue`、`assetBrowser.vue`、`assetMenu.vue` 三个组件改为按层懒加载、只读源隐藏写操作、跨源搜索。

- [x] 侧栏树按源分组、懒加载（`:data="sourceNodes"` + `lazy :load`，只读源带锁标记）
- [x] 主区按层加载（进入分组才请求该层，不再一次性拉整棵树）
- [x] 面包屑可回退，根层显示 7 个素材库
- [x] 只读源隐藏「新建文件夹」「目录操作」与类型筛选
- [x] 跨源搜索：250 ms 防抖打 `GET /api/assets/search`，标题显示「找到 N 条，显示前 M 条」
- [x] 缩略图统一走 `thumbPath`，未命中回落原图
- [x] 保存对话框与「移动到」目录树懒加载
- [x] `assetMenu.vue` 按 `entry.readOnly` 只留「下载」
- [x] 顺序修正：组内与搜索结果保持索引原序，原图与深度图成对相邻

**验证**（headless Chrome + CDP，端口 3111）：

- 素材库弹窗列出 7 个库，「我的素材」默认展开，只读库显示 `Read-only`。
- 姿势库 → 4 个体系目录；全身单人・性感系 → 798 条（399 原图 + 399 深度），首条 `S形站姿・胯部侧顶（P001・正面）.png`，其后紧邻 `_depth.png`；缩略图 300×400 正常加载。
- 只读层无「新建文件夹」；面包屑为 `素材库 / 姿势库`。
- 搜索「坐姿」→ 标题「找到 298 条，显示前 60 条」，卡片带来源标签「姿势库」。
- 动漫服装 → 8 组；泳装・度假 → 52 套，热链缩略图经服务端代理后 360×540 正常显示。
- `bun run typecheck`（web）：本次改动文件无新增错误（`addCustomProviderDialog.vue` 的 TS2769 为既有错误）；`bun run build` 成功。

## 题材过滤（2026-11-20）

- [x] `SourceConfig.hiddenGroups` 配置项，`sourceIndex.buildTree` 跳过命中的分组（不进树、不进搜索）
- [x] `pose` 源隐藏「双人缠绵」：根层由 4 组变 3 组，`@pose` 层实测 3 个目录

## 按上游产品结构重构（2026-11-20）

参照 `https://ai-pose-gallery.anhao.app/poses` 的实际产品形态（三大参考图库、库内分类 chips、18+ 完整模式开关、卡片内多视角/深度图切换）改。

- [x] 源表合并为 4 个（我的素材 / 姿势库 / 服装穿搭库 / 人像库）：`SourceConfig.indexPath` 改为 `indexes: { label, path }[]`，四份服装索引合成一个库，条目带 `origin`（ギア・现实服装 / ギア・动漫 / AI・CharaDB / Shisei・中国历代）
- [x] `Snapshot` 升到 `version: 2`，按 `parts[path] = { label, etag, items }` 分别缓存，一份索引 304 不影响其余；旧快照自动失效重建
- [x] `hiddenGroups` 换成 `adultGroups`：18+ 分组默认不进树、不进搜索，`list` / `search` 加 `adult=true` 才返回，`hiddenGroups` 回传隐藏数量，界面显示「另有 N 个 18+ 分组」
- [x] 深度图从独立条目改为第二视图：`SourceFileRole` 的 `depth` 改成 `alternate`，`buildItem` 按出现顺序贴回原条目（`alternatePath` / `alternateThumbPath` / `alternateName`），姿势库单组条目数由 798 降到 399（实测 365 = 全身单人・标准系）
- [x] 卡片角标：`SourceConfig.badge` / `meta` 模板，姿势库用 `{姿势编号}` 与 `{角度}`，卡片标题去掉重复的角度后缀
- [x] 库根层改为一行分类 chips（带条目数、18+ 标记），`listSourceEntries` 根层回传 `count`；服装库实测 24 个分类合计 3,224，与上游截图逐项一致
- [x] 远程库在侧栏不再展开二级目录（分类交给 chips），本地库仍可展开
- [x] `resolveSourceImage` 补查完整树，18+ 条目的图片照常可读（实测 P001 523,791 B）
- [x] 同一姿势的 5 个视角按 `mergeBy: "{姿势编号}"` 聚合成一张卡：`SourceConfig.mergeBy` + `AssetEntry.variants`，`buildTree` 里同组同键只占位一次，其余进 `variants`；卡片底部视角按钮切换缩略图与拖拽路径，与「深度」按钮可叠加（切到仰视再开深度 = 仰视深度图）
- [x] 摘要文案区分条目与图片：`73 个素材 · 365 张图`（聚合后条目数 + 视角总数），避免与上游 365 的记录数口径混淆
- [x] 实测：`bun run typecheck`（server / web）通过；`bun run build`（web）成功；姿势库 4 组 2,878 条、服装库 24 类 3,224 条、人像库 2 类 1,499 条；搜索「坐姿」默认 75 条、开启 18+ 后 149 条

## 界面按上游交互重做（2026-11-20）

上游姿势库是「库根直接铺卡片 + 顶部一行筛选 + 卡片内视角条」，此前我做成了「先选分类目录再进二层」。这轮改成照抄该结构。

- [x] 库根直接返回全部条目：`listSourceEntries` 根层返回 `tree.all`（含 `group` 字段），分类降级为筛选条件；`AssetEntry.group` 由 `buildTree` 写入
- [x] 分类 chips 变成同层筛选：`activeGroup` 点击切换、再点取消，`multiOrigin` 时才显示来源副标题
- [x] 分页 60 条 + 「加载更多」（`visibleCount`），避免一次渲染 1,499 个节点
- [x] 深度图从卡片按钮改为页面级分段控件（`素体白模 / 深度图`），视角条缩略图跟随切换（`variantThumbOf`）
- [x] 视角条从文字方块改成 5 张缩略图 + 标签，卡片右上角显示当前角度、左上角显示编号、副标题显示分类（`meta: "{分类}"`）
- [x] 网格 5 列、`fit="contain"` + 浅色底，整张构图不再被裁切
- [x] 只读库隐藏「新建文件夹」与卡片「更多」菜单；本地库保留
- [x] 名称统一去掉末尾 `（…）` 段（编号与角度已用角标表达）
- [x] 搜索接口结果补 `type: "file"`，否则卡片退化成「文件」图标；搜索结果副标题显示来源库
- [x] 实测：`bun run typecheck`（server）通过、`bun run build`（web）成功；姿势库根 153 条 60 张/页、chips 2 项（73 / 80）、视角切换后 `img.src` 由「正面」变「仰视」、深度模式变 `…_深度.png`、点 chips 后首卡变「上半身单人」的 P001、加载更多 60→120；服装库 22 chips + 3 类来源、人像库副标题「短发」、本地库 2 条且「新建文件夹」可见、搜索「旗袍」6 条带缩略图
