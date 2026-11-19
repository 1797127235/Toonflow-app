# Implementation Plan: 素材源接入（asset-sources）

规格：`docs/assetSources.md`（334 行，已按架构评审修订）。任务明细见 `tasks/todo.md`。

## Overview

让全局素材库在现有本地目录 `data/assets` 之外挂载 6 个只读远程源（姿势 1,439、写实服装 1,407、Shisei 227、动漫服装 1,320、CharaDB 440、人像 1,499，合计 7,771 个文件），用户在素材库里能像浏览本地文件一样逐层展开、预览、拖进画布。图片不进 `data/assets`，由服务端代理并按 2 GB LRU 缓存。

本计划只覆盖第一个模块 `asset-sources`。跨源搜索（`asset-search`）与前端目录树改造（`asset-library-ui`）是后续两个独立模块，不在本计划范围内。

## Architecture Decisions

- **远程源用路径协议 `@<sourceId>/<相对路径>` 接入，不另开接口、不复制文件。** 读写统一走已有的 `assets/list`、`assets/read`，6 个既有调用点（`assetMenu.vue:130`、`assetLibrary.vue:137`、`canvasDrop.ts:126`、`mentionThumbnail.vue:31`、`mentionContent.vue:70`、`utils/mcp/operations.ts:125`）零改动。替代方案是独立"素材中心"页面，数据模型更干净，但拖拽、预览、agent 引用三条链路全要重做 —— 用一层薄协议换六处零改动，这笔账划算，代价是远程源在树里表现得像个本地文件夹（没有真实目录、不能写、分组基数随上游变）。
- **源表是 `apps/server/src/utils/assets/sources.ts` 里的常量数组，不做 `settings.json` 覆盖。** 数据结构写在代码里是配置驱动，分支写在代码里才是硬编码；验收标准是 `grep -rn 'source.id ===' apps/server/src` 无命中。配置覆盖要额外做校验与错误路径，配错会让整个素材库打不开，收益只是省一次代码改动。
- **索引全量驻留内存，不建数据库。** 六份索引合计 4.2 MB、6,162 条，全表扫描实测 0.61–0.99 ms。SQLite 或倒排索引在 7,771 条量级是过度设计，`asset-search` 直接查这份内存索引即可。
- **`list` 增加可选 `path` 参数，远程源逐层返回，`path` 缺省时行为与改动前逐字节一致。** 现状 `list.ts:11-24` 递归返回整棵树；把 7,771 条一次铺进 `el-tree` 会让前端渲染同样数量的 `el-image`，而实测服务端递归只花 88 ms、响应 606 KB —— 压力全在 DOM。参数缺省路径不变是兼容底线，既有前端与 `queryAssets` 因此不受影响。
- **所有远程 URL 经 `resolveRemoteUrl` 集中校验，白名单在源配置里。** 索引内容是外部输入：`giaAnime`、`charadb` 的 `原图` 本身就是绝对 URL，上游被投毒或改字段就能让服务端替攻击者发任意请求。只允许 `http(s)` + `allowedHosts` 命中的 host，拒绝 userinfo、非标准端口、`..` 越界。这是本模块唯一的安全边界。
- **配置错误隔离到单源，不让素材库整体打不开。** 两层校验：静态层（进程内首次使用，检查 mode 配套、白名单非空、模板占位符已声明）、数据层（索引首次加载后取前三条跑模板，检查产出名与 URL）。失败只把该源标为不可用并在日志指名原因。模板写错若无声产出 404，是最贵的一类 bug —— 用户看到裂图，你查缓存、查网络、查 CORS，最后发现少写一个 `item.`。
- **图片缓存原子写 + 流式 tee + 内存 LRU 表。** 三点都是硬要求：不原子就会留下半截文件，一旦命中就带 `immutable` 一年赖在浏览器里；不流式则首字节延迟等于整个文件下载时间（人像单张 3 MB，秒级差别）；每次请求扫盘统计体积就是给每张图加一次 7,771 项 `stat`。`@toonflow/file` 的 `writeAtomic`（`packages/file/src/index.ts:147`）收完整 buffer，流式场景用不了，图片走 `open("wx")` + 逐块写 + `rename`，索引快照才用 `writeAtomic`。
- **`role: "thumb"` 只产出条目的 `thumbPath`，不产出独立文件条目。** 缩略图与原图同名（如都是 `<id>.png`）时会产生冲突；缩略图的用途只是卡片图，前端用 `thumbPath` 取，不进文件树。
- **不新增路由文件。** `assets/list`、`assets/read` 已存在，本次只加参数与分流，因此无需 `bun run routes`。新增 `/api/assets/search` 属 `asset-search` 模块。
- **约束**：不新增依赖；不新增测试文件或测试框架（AGENTS.md）；磁盘操作走 `@toonflow/file`；错误统一走 `errorFromCause`；文件与函数小驼峰。

## Task List

明细（验收标准、验证命令、涉及文件）在 `tasks/todo.md`。

#### Decision 11: 源可用性按运行期判定，不按静态配置判定

`GET /api/assets/list` 的 `sources` 由 `sourceStatus()`（内部 `ensureIndex`）实时给出：索引拉不到且无快照的源直接不出现在列表里，有快照的源带 `stale: true`。静态配置只能说"配置合法"，不能说"源现在能用"；让用户点进一个必然报错的目录更糟。索引有 24 h 内存缓存，只有首次或过期才付出网络代价。

### Decision 12: 失败源 60 s 冷却

`ensureIndex` 失败后写 `failures` 冷却表，冷却期内直接抛 502，避免源挂掉时每次 `list` 都干等一次 15 s 超时。

### Decision 13: 一个库由多份索引合成，来源是条目属性

上游四份服装索引在产品上是一个「服装穿搭库」（3,224 = 1,407 + 57 + 1,320 + 440）。把「来源」做成库级会让库数虚高，做成条目属性才能既合并又区分。`indexes[].label` 落到条目的 `origin`，缓存的 `parts` 按索引路径分开存 etag。

### Decision 14: 18+ 是分组属性，默认隐藏而不是删除

上游的 `全身单人・性感系` / `双人缠绵` / `内衣・睡衣` / `性感穿搭` 是带 18+ 标记的分类，默认不显示、开关可打开。所以用 `adultGroups` + 请求参数，而不是把分组从配置里删掉（删了数据就永久丢了）。

### Decision 15: 深度图是视图，不是条目

索引里每条姿势记录同时有白模与深度图。深度图独立成条目会让列表条数翻倍（798 vs 399），且用户挑的是姿势不是图种。`role: "alternate"` 把第二视图贴在原条目上，卡片内切换，拖拽时取当前视图。

## Phase 1：骨架与安全边界（无网络）
- Task 1：源表与类型 + 路径分流 + `resolveRemoteUrl` + 静态校验

### Phase 2：索引与目录树
- Task 2：索引加载、快照、TTL/etag、数据层校验、条目树生成（`list` 可用）

### Phase 3：图片代理与缓存
- Task 3：缓存层（原子写、LRU 表、淘汰）+ `read` 分流 + 流式 tee

### Phase 4：只读与错误语义
- Task 4：四个写接口对 `@` 路径 403 + 错误码映射

### Phase 5：验证
- Task 5：typecheck + 临时数据目录手工 HTTP 全量验证（含负例）

## Risks

| 风险 | 影响 | 缓解 |
|---|---|---|
| 上游索引字段改名或结构变动 | 源失效、条目错乱 | 数据层校验在加载后立刻发现并隔离该源；快照 `stale` 兜住断网 |
| 上游限流/封 IP（未测 9,000 量级连续请求） | 该源不可用 | 每源并发上限 4 + 磁盘缓存；失败只影响单源，其余照常 |
| Windows 上 `rename` 覆盖已存在目标失败 | 缓存写不进去 | 落盘前先 `unlink` 目标；同源同路径并发由每源串行队列排掉 |
| `list` 加参数影响既有前端 | 本地素材库回归 | `path` 缺省时走原代码路径，逐字节一致；验收含本地树人工回归 |
| 首次进入远程目录要等索引（554 KB–1.4 MB） | 首次 1–3 秒空白 | 索引快照 24 h + etag；加载态提示属 `asset-library-ui`，本模块不碰前端 |
| 2 GB 缓存占用户磁盘 | 磁盘压力 | 上限可配；缓存目录纯可重建，删掉只损失一次下载（规格 9.6） |
| 上游 `LICENSE` 禁止再分发 | 合规 | 不把图片写进 `data/assets`，只代理；用户拖进画布复制到工作区是既有行为，不新增复制路径 |

## Verification

按 AGENTS.md 不新增测试文件，全部手工执行：

```bash
cd apps/server && bun run typecheck
TOONFLOW_DATA_DIR=/tmp/as-data bun src/index.ts
```

再用规格第六节的 curl 清单验证正向路径、缓存命中、404/403 分支、源隔离负例与缓存残留检查。

## Out of Scope

- 跨源搜索接口（`asset-search`）。
- 前端树的源分组、只读菜单、缩略图优先加载（`asset-library-ui`）。
- 把远程图片下载进本地素材库。
- 用户自定义添加源的界面。