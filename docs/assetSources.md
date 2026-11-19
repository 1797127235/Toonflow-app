# 素材源规格（asset-sources）

范围：让全局素材库在现有本地目录之外，挂载只读的远程姿势/服装/人像素材源。本规格只覆盖第一个模块；跨源搜索见 `asset-search`，前端目录树与只读菜单见 `asset-library-ui`。

状态：已按架构评审修正（来源白名单、原子写、两层配置校验、列表按层返回），待批准。批准后再写 `tasks/plan.md` 与任务清单。

## 一、目标

用户的素材库现在只有一个目录 `data/assets`。要把上游三个素材库（姿势 1,439 条、服装 3,224 套、人像 1,499 条）挂进来，让用户在素材库里像浏览本地文件一样浏览、预览、拖进画布，同时：

- 不把远程图片灌进 `data/assets`（仓库 1.1GB，且上游 `LICENSE` 明确 `img/`、`thumbs/`、`data/` 不适用 MIT、禁止再分发）；
- 不把「三个库」的字段差异写死到代码分支里，源是配置数据，代码只认契约；
- 本地目录不被特殊对待：它只是 `mode: "directory"` 的一个源。

## 二、现状事实（全部实测，非推断）

### 2.1 上游数据通道

单域名 `https://ai-pose-gallery.anhao.app` 同时提供三库索引与大部分图片；两个外部图站承担剩余的服装库。

| 源 | 索引 | 条数 | 图片地址 | 实测 |
|---|---|---|---|---|
| 姿势 | `/data/pose-zh.json` | 1,439 | 域内相对路径 `img/…`、`thumbs/…` | 200 / 554,979 B |
| 服装·写实 | `/data/costume-zh.json` | 1,407 | 域内相对路径 `img/costume/…` | 200 / 998,438 B |
| 服装·Shisei | `/data/costume-shisei-zh.json` | 57 套 / 227 视角 | 域内路径 `img/costumes/shisei/…` | 200 / 136,677 B；`views[]` 每项含 `id/label/缩略图/预览图/原图`，56 套 4 视角、1 套 3 视角 |
| 服装·动漫 | `/data/costume-gia-anime-zh.json` | 1,320 | **绝对 URL** 热链 `ai-costume-anime-gallery.pages.dev` | 200 / 1,414,547 B |
| 服装·CharaDB | `/data/costume-anime-zh.json` | 440 | **绝对 URL** 热链 `charadb-2fi.pages.dev` | 200 / 348,692 B；`敏感` 布尔，396 false / 44 true |
| 人像 | `/data/portrait-zh.json` | 1,499 | 域内相对路径 `img/portrait/…` | 200 / 651,495 B |

字段完整性：上述六份索引中 `缩略图`、`原图` 缺失数均为 0（`views` 元素的三个图字段同样 0 缺失）。

深度图单独一个域 `https://ai-pose-depth-gallery.pages.dev`，URL 由同 id 换域得出：`…/img/<id>.png`（实测 `/img/full_sexy_P001_front.png` = 200 / 104,901 B `image/png`）。字面拼 `/img/depth/<id>.webp` 返回的是 200 的 `text/html` 兜底页，属无效地址。

缓存与限流：图片 `cache-control: public, max-age=31536000, immutable`、`cf-cache-status: HIT`；索引 `cache-control: public, max-age=86400` + `etag`；20 次连发缩略图全 200，未触发限流（未测 9,000 量级）。`anhao.app` 无 `access-control-allow-origin`，另两个图站返回 `ACAO: *`。服务端 Bun 直连验证：`fetch` 索引 200、TTFB 330 ms，图片 11,900 B 取回正常。

分组字段基数（用于决定树的第二层）：姿势 `体系` 4 类；写实服装 `分类` 8 类；Shisei `一级分类` 与 `分类` 各 1 类；动漫 `分类` 8 类；CharaDB `分类` 15 类；人像 `分区` 2 类。

### 2.2 项目侧接入点

| 位置 | 现状 |
|---|---|
| `apps/server/src/utils/assets/index.ts:13-21` | `getAssetsDirectory()` = `join(dirname(conf.path), "assets")`，纯本地 |
| `apps/server/src/utils/assets/index.ts:23-28` | `resolveAssetPath` 用 `resolveWorkspacePath` + `protectWorkspaceRoot` 锁死本地根 |
| `apps/server/src/utils/assets/index.ts:30-37` | 单文件上限 100 MB（`maxAssetBytes`） |
| `apps/server/src/utils/assets/index.ts:50-62` | `writeAssetFile` 带 revision 冲突 409 `ESTALE` |
| `apps/server/src/utils/assets/index.ts:102-117` | `importAssetFile` 复制到 `assets/imported/<uuid><ext>` |
| `apps/server/src/routes/assets/list.ts:11-24` | 递归 `readdir` 返回整棵树 `{name,path,type,children?}`，`localeCompare("zh-CN",{numeric:true})` 排序 |
| `apps/server/src/routes/assets/read.ts:11-19` | `validateFields` 校验 `path`(≤4096)、`download`，本地 `sendFile`，响应头 `Cache-Control: no-store` |
| `apps/server/src/app.ts:97-103` | 已挂 `cors()`、`express.json/raw` 100 MB；**没有 compression 中间件** |
| `apps/server/src/app.ts:126-130` | 统一错误出口走 `errorFromCause`，它读 `cause.status`（`responseFormat.ts:32-34`） |
| `apps/web/src/.../assetLibrary.vue:136-138` | `assetUrl(path)` = `/api/assets/read?path=…`（5 个调用点共用） |

调用 `/api/assets/read` 的既有位置：`assetMenu.vue:130`、`assetLibrary.vue:137`、`canvasDrop.ts:126`、`mentionThumbnail.vue:31`、`mentionContent.vue:70`、`utils/mcp/operations.ts:125`。

规模实测：按本规格展开后树里有 7,771 个文件条目（1,439+1,439 深度+1,407+227+1,320+440+1,499）。同规模目录实测：递归 `readdir` 88 ms、`JSON.stringify` 2 ms、响应体 606 KB（9,190 节点）—— 服务端不是瓶颈，瓶颈在前端 DOM，属 `asset-library-ui`。

## 三、契约（初版设计，现状以第十节为准）

### 3.1 源配置

```ts
type SourceFile = {
  name: string                              // 产出文件名模板，如 "{id}.png"；role 为 thumb 时可省
  url: string                               // 绝对 URL 或相对 baseUrl 的路径模板
  role?: "original" | "thumb" | "depth"     // 缺省 original
  from?: string                             // 数组字段名（如 "views"），逐项展开
};
// role 为 "thumb" 的条目只产出条目的 thumbPath，不产出独立文件条目，避免与原图同名冲突。
// role 为 "depth" 的条目照常产出独立文件条目（深度图是用户要单独取用的文件）。
type SourceConfig = {
  id: string; label: string
  mode: "directory" | "index"
  writable?: boolean
  root?: string                             // directory 模式
  baseUrl?: string; indexPath?: string      // index 模式
  allowedHosts?: string[]                   // index 模式必需：允许 fetch 的 host 白名单（见 3.5）
  dir?: string                              // 树里第二层的名字
  name?: string                             // 卡片显示名模板
  groupBy?: string                          // 可选：按该字段再分一层目录
  files: SourceFile[]
  license?: string; homepage?: string
  searchFields?: string[]
  ttlSeconds?: number                       // 索引 TTL，缺省 86400
  cacheLimitBytes?: number                  // 图片缓存上限，缺省 2 GB，全库共用
};
```

源表放在 `apps/server/src/utils/assets/sources.ts`，导出 `const assetSources: SourceConfig[]`。加一个库就是往数组里加一个对象。

插值规则：`{字段}` 取条目字段；`from` 展开时以元素字段优先、缺失回退条目字段，`{item.字段}` 显式取条目；`{ext}` 取 `url` 的扩展名。字符串值原样插值；产出名的合法性由 4 节的数据层校验兜住 —— 含 `/`、`\`、`..`、控制字符或以 `@` 开头的名字直接判该文件不可用（`@` 开头会与 3.2 的路径协议撞车）。

### 3.2 路径协议

远程源路径一律 `@<sourceId>/<相对路径>`。本地源不加前缀，保持现有调用点零改动。

- `@` 开头的路径**不得**进入 `resolveWorkspacePath`（`index.ts:25`），必须先按前缀分流，否则会被当成文件名去本地找。
- `sourceId` 限小驼峰 `[a-z][a-zA-Z0-9]{1,15}`。
- 分流规则定死为：取第一个 `/` 之前的部分去掉前导 `@`，**只有它命中已注册的非本地 source id 时才走远程**；否则整串回落本地路径解析。这样本地用户即使真建了一个叫 `@abc/x.png` 的文件，行为也是确定的（本地优先于未注册前缀）。
- 本地源的路径**永远不带前缀**，`local` 这个 id 只用于配置表引用，不出现在路径里。

### 3.3 条目结构

沿用 `routes/assets/list.ts:7` 的 `AssetEntry`，新增三个可选字段：

```ts
type AssetEntry = { name: string; path: string; type: "file" | "directory";
  children?: AssetEntry[]; readOnly?: boolean; thumbPath?: string; stale?: boolean };
```

`readOnly` 由源的 `writable` 决定；`thumbPath` 只在源配了 `role: "thumb"` 时出现，供前端卡片优先取缩略图；`stale` 只出现在源根目录这一层，表示本次呈现的是过期快照（上游拉取失败、用了本地缓存）。三个字段都可选，本地源的条目与改动前完全一致。

### 3.4 内置源（字段映射全部来自 2.1 实测）

```ts
// 本地目录：唯一可写源。路径不带前缀，既有 6 个调用点因此零改动。
{ id: "local", label: "我的素材", mode: "directory", writable: true,
  root: <getAssetsDirectory()>, files: [] }

{ id: "pose", label: "姿势库", mode: "index",
  baseUrl: "https://ai-pose-gallery.anhao.app",
  indexPath: "/data/pose-zh.json",
  allowedHosts: ["ai-pose-gallery.anhao.app", "ai-pose-depth-gallery.pages.dev"],
  dir: "姿势库", name: "{姿势名称}（{姿势编号}）", groupBy: "体系",
  files: [
    { name: "{id}.png",       url: "{原图}",   role: "original" },
    { name: "{id}_depth.png", url: "https://ai-pose-depth-gallery.pages.dev/img/{id}.png", role: "depth" },
    { url: "{缩略图}", role: "thumb" }
  ],
  searchFields: ["姿势名称", "姿势编号", "分类", "体系", "角度"] }

{ id: "costume", label: "服装库·写实", mode: "index",
  baseUrl: "https://ai-pose-gallery.anhao.app",
  indexPath: "/data/costume-zh.json",
  allowedHosts: ["ai-pose-gallery.anhao.app"],
  dir: "服装库·写实", name: "{服装名称}", groupBy: "分类",
  files: [
    { name: "{id}.webp", url: "{原图}", role: "original" },
    { url: "{缩略图}",   role: "thumb" }
  ],
  searchFields: ["服装名称", "标签", "关键词", "分类"] }

{ id: "shisei", label: "服装库·Shisei", mode: "index",
  baseUrl: "https://ai-pose-gallery.anhao.app",
  indexPath: "/data/costume-shisei-zh.json",
  allowedHosts: ["ai-pose-gallery.anhao.app"],
  dir: "服装库·Shisei", name: "{服装名称}",          // 无 groupBy：一级分类/分类各只有 1 类，分组无意义
  files: [
    { name: "{item.id}_{id}.webp", url: "{原图}", role: "original", from: "views" }
  ],
  searchFields: ["服装名称", "标签", "关键词"] }

{ id: "giaAnime", label: "服装库·动漫", mode: "index",
  baseUrl: "https://ai-pose-gallery.anhao.app",
  indexPath: "/data/costume-gia-anime-zh.json",
  allowedHosts: ["ai-pose-gallery.anhao.app", "ai-costume-anime-gallery.pages.dev"],
  dir: "服装库·动漫", name: "{服装名称}", groupBy: "分类",
  files: [ { name: "{id}.png", url: "{原图}", role: "original" } ] }

{ id: "charadb", label: "服装库·CharaDB", mode: "index",
  baseUrl: "https://ai-pose-gallery.anhao.app",
  indexPath: "/data/costume-anime-zh.json",
  allowedHosts: ["ai-pose-gallery.anhao.app", "charadb-2fi.pages.dev"],
  dir: "服装库·CharaDB", name: "{服装名称}", groupBy: "分类",
  files: [ { name: "{id}.jpg", url: "{原图}", role: "original" } ] }

{ id: "portrait", label: "人像库", mode: "index",
  baseUrl: "https://ai-pose-gallery.anhao.app",
  indexPath: "/data/portrait-zh.json",
  allowedHosts: ["ai-pose-gallery.anhao.app"],
  dir: "人像库", name: "{发型名称}", groupBy: "分区",
  files: [ { name: "{id}.webp", url: "{原图}", role: "original" } ] }
```

`shisei` 的 `{item.id}_{id}.webp` 实测产出 `shisei-C001_front.webp` 这类名字（元素 `id` 是 `front`/`diag` 等视角名）。

`searchFields` 只在已实测确认字段的源上给出。`giaAnime`、`charadb`、`portrait` 的取值留到实现时定：写代码前对各自索引跑 `jq '.[0]|keys'` 核对一次，不凭印象填。

### 3.5 URL 解析与来源校验

索引内容是**外部输入**：`giaAnime`、`charadb` 的 `原图` 字段本身就是完整绝对 URL，`pose` 的相对路径拼 `baseUrl` 之后也可能因上游改动而指向别处。因此每个由模板产出的 URL 在交给 `fetch` 之前，必须逐条通过下面的检查，任一不满足即判该文件不可用并记一条错误日志：

1. 协议只允许 `http:` 与 `https:`。
2. `host`（含端口归一后）必须命中该源的 `allowedHosts`，比较时忽略大小写，不做通配。
3. 不接受 URL 内的 userinfo（`user:pass@host`），出现即拒绝。
4. 端口只允许缺省，或与协议对应的 80/443，其余拒绝。
5. 相对路径与 `baseUrl` 拼接后若出现 `..` 越出 baseUrl 的路径层级，拒绝。

这些检查集中在一个 `resolveRemoteUrl(source, relativeOrAbsolute)` 里，索引加载、图片代理、`asset-search` 共用同一入口，不允许各处自行拼 `new URL`。白名单外的主机不发起任何请求——这是本规格唯一的安全边界，不能靠"上游不会那么坏"来省。

`allowedHosts` 的取值逐源来自 2.1 实测：

| 源 | `allowedHosts` |
|---|---|
| pose | `ai-pose-gallery.anhao.app`、`ai-pose-depth-gallery.pages.dev` |
| costume | `ai-pose-gallery.anhao.app` |
| shisei | `ai-pose-gallery.anhao.app` |
| giaAnime | `ai-pose-gallery.anhao.app`、`ai-costume-anime-gallery.pages.dev` |
| charadb | `ai-pose-gallery.anhao.app`、`charadb-2fi.pages.dev` |
| portrait | `ai-pose-gallery.anhao.app` |

## 四、行为规则

**配置校验（静态层，源表首次使用时一次）。** 逐源检查：`mode` 与 `root`/`indexPath` 是否配套；index 源 `allowedHosts` 非空且 `files` 非空；directory 源 `files` 必须为空（本地目录没有模板可跑）；`id` 唯一且合 3.2 格式；模板里的每个占位符都在该源声明的字段集合内（字段集合 = `name`/`groupBy`/`searchFields` 出现过的人名字段 + `from` 元素字段 + 内置 `id`/`ext`）。不合格的源**只标为不可用并记录原因**，其余源照常挂载 —— 素材库不能因为一个源配错整体打不开。

**配置校验（数据层，索引首次加载成功后每源一次）。** 取前三条记录跑一遍全部 `files` 模板，检查产物名非空、无残留 `{`、不含 `/`／`\`／`..`／控制字符、不以 `@` 开头，URL 通过 3.5 全部检查，`role: "thumb"` 的产物是图片扩展名。失败则整源标为不可用、从树中消失，日志写明哪条记录哪个模板。这次校验不发任何请求 —— URL 合法性靠 3.5 的静态规则判断，不做试探性 fetch。

**索引加载。** 首次访问某 index 源时 `fetch(baseUrl + indexPath)`；成功后原子写快照 `data/assetCache/<sourceId>.json`（含 `etag`、`fetchedAt`）并驻留内存。TTL 86400 s 与上游 `max-age` 对齐，TTL 内不重复请求。过期后带 `If-None-Match` 条件请求，304 则只更新 `fetchedAt`。请求失败（网络、非 2xx）时若有快照则继续用快照并在响应里标 `stale: true`，无快照则该源从树中缺席，不影响其他源。

**图片代理（流式 tee）。** 收到 `@` 路径后反查源与条目，经 3.5 得到 URL，然后一边把上游响应体写临时文件、一边把数据块写给客户端，写完再 `rename` 成正式缓存文件。首字节延迟因此等于上游 TTFB（实测 330 ms），而不是整文件下载时间；人像单张 3 MB 时这是秒级差别。向上游请求时显式带 `Accept-Encoding: identity`，避免落盘 gzip 字节导致缓存内容与 `content-type` 不符。上游若给了 `Content-Length` 就透传，让客户端能显示进度。

**原子写缓存。** 临时文件写完再 `rename`，`rename` 成功才算缓存存在。这样进程被杀、或两个请求同时拉同一张图时，缓存目录里不会出现半截文件被当成命中返回 —— 一旦命中就会带 `immutable` 一年，坏图在浏览器里赖着不走。

实现依据（已核对 `packages/file/src`）：`@toonflow/file` 导出 `open`（`index.ts:60`）、`createWriteStream`（`index.ts:143`）、`rename`（`index.ts:41`）、`unlink`（`index.ts:43`），以及 `writeAtomic`（`index.ts:147`）。`writeAtomic` 的签名收完整 `string | Uint8Array`，内部是 `.write-<uuid>.tmp` + `wx` 打开 + `handle.writeFile(content)` + 重试 rename（`index.ts:149-167`）—— **它要求一次性给出全部内容，流式场景用不了**。因此图片落盘走 `open(temp, "wx")`/`createWriteStream` 逐块写、`close` 后 `rename` 到最终名；目标已存在时先 `unlink` 再 `rename`（同源同路径的并发写由每源串行队列排掉）。索引快照这类一次性写入仍直接用 `writeAtomic`。

**淘汰。** 上游给 immutable 一年，因此缓存不做时间过期，只按总量 LRU 淘汰。淘汰**不在每次请求时扫盘**：进程内维护 `sha256 → {bytes, mtimeMs}` 表，启动扫一次目录建表；之后写入累加字节，累计超过上限 1.1 倍才触发一次按 `mtime` 的批量淘汰并重扫。上限 2 GB 全库共用，`cacheLimitBytes` 可调（依据见 9.1）。

**响应头。** `content-type` 取自上游（缺失则按扩展名推定）；`Cache-Control: public, max-age=31536000, immutable`；`ETag` 用 `"<sha256(源内路径)>"` —— 同一路径按上游 immutable 约定内容不变，因此路径哈希是稳定且能提前算出的 ETag（流式响应发头时还不知道内容哈希）；保留 `X-Content-Type-Options: nosniff`。单文件沿用 100 MB 上限，超限时只流式转发、不落缓存。

**不缓存失败。** 上游 404 与网络失败都不写缓存。404 让该条目在本次会话内标为失效，后续请求直接 404、不重复打上游；网络失败或超时返回 502/504 且不标失效，下次请求重试。

**列表返回粒度。** `GET /api/assets/list` 现状是一次递归返回整个本地树（`list.ts:11-24`），这个行为不改。远程源不参与这次递归展开：根列表里每个 index 源只占一个源目录节点，其 `children` 是 `groupBy` 声明的分组目录（无 `groupBy` 时为空）。进入远程目录时前端用新参数取该层 —— `GET /api/assets/list?path=@pose/<分组名>`，返回该目录下一层。`path` 缺省时行为与改动前逐字节一致（只扫本地 `data/assets`），因此既有前端、6 个调用点、agent 侧 `queryAssets` 全部不受影响。`validateFields` 增加可选 `path`（`z.string().min(1).max(4096)`）。

这条是硬约束而非优化：把 7,771 个条目一次性铺进 `el-tree`，前端要渲染同样数量的 `el-image`，而实测 9,190 节点的树在前端已经吃力（服务端递归只花 88 ms、响应 606 KB，瓶颈全在 DOM）。展开粒度控制在"一层"，是让远程源不把本地素材库一起拖慢的前提。

**只读。** `writable: false` 的源，`mkdir`／`rename`／`remove`／`save` 对 `@` 路径一律 403。`list` 与 `read` 不受限。

**错误码。** 源 id 不存在 / 源内无此路径 / 路径以 `@` 开头但源为 directory 模式 → 404；上游返回 4xx/5xx → 502；上游超时（连接 5 s、整体 30 s）→ 504；URL 被 3.5 拒绝 → 404（对外不区分"配置拒绝"与"没有这个文件"，避免把白名单规则暴露给客户端）。全部通过 `Object.assign(new Error(...), { status })` 交给统一错误出口，不另造响应格式。

## 五、不在本规格范围

- 跨源搜索接口（`asset-search`）。
- 前端目录树改造、根目录默认视图、只读菜单项、缩略图加载策略（`asset-library-ui`）。
- 远程源的下载到本地素材库（用户明确只需浏览与拖拽；`importAssetFile` 现有「拖进画布即复制到工作区」的路径不变）。
- 用户自定义添加源的界面。

## 六、验证策略

项目禁止新增测试文件与测试框架（`AGENTS.md`「测试与检查边界」），验证一律手工执行：

```bash
cd apps/server && bun run typecheck          # 类型
bun run routes                                # 仅在新增/改名路由文件后需要
TOONFLOW_DATA_DIR=/tmp/as-data bun src/index.ts   # 临时数据目录，不用真实 data/
```

```bash
curl -s localhost:PORT/api/assets/list | jq '[.data.entries[].name]'        # 期望含 7 个源目录
curl -sI 'localhost:PORT/api/assets/read?path=@pose/full_sexy_P001_front.png'  # 期望 200 image/png 523791
curl -sI 'localhost:PORT/api/assets/read?path=@pose/full_sexy_P001_front.png'  # 第二次：命中缓存
curl -sI 'localhost:PORT/api/assets/read?path=@nope/x.png'                    # 期望 404
curl -s -X POST 'localhost:PORT/api/assets/mkdir' -H 'Content-Type: application/json' \
     -d '{"path":"@pose/x"}'                                                  # 期望 403
curl -s localhost:PORT/api/assets/list | jq '.data.entries[]|select(.name=="姿势库")|.children|length'  # 期望 4（体系分组）
```

字节一致性用 `sha256sum` 比对本地缓存文件与 `curl` 直取上游的结果。

安全与校验负例（改配置、重启、观察隔离，不新增文件）：

```bash
# 1. 把 pose 的 allowedHosts 删掉 depth 域 → 只有该源整体不可用，其余 6 源照常
curl -s localhost:PORT/api/assets/list | jq '[.data.entries[].name]'   # 期望不含"姿势库"，其余在
# 2. 恢复配置；把某源 baseUrl 改成 allowedHosts 外的域 → 该源 404、日志写明拒绝的 host
# 3. 缓存目录不得有残留半截文件
find "$TOONFLOW_DATA_DIR/assetCache" -name '*.part' -o -name '*.tmp'   # 期望为空
# 4. 中断一次大图请求（portrait 3 MB），再请求同一路径 → 返回完整字节，sha256 与上游一致
```

`allowedHosts` 拒绝路径不靠试探性 `fetch`，因此上述负例只验证"配置错→源隔离"与"缓存不留半截"，不需要伪造恶意索引。

## 七、边界

- **Always**：磁盘操作走 `@toonflow/file`；磁盘缺省数据落在 `data/` 下（非工作区）；新增路由一个文件一个接口并跑 `bun run routes`；错误走 `errorFromCause` 的统一结构；中文 UI 文案；每条断言附实测出处。
- **Ask first**：缓存目录位置与上限、是否给用户开「刷新索引」入口、是否允许在 `settings.json` 覆盖源配置。
- **Never**：把远程图片写进 `data/assets`；把源 id、字段名写进代码分支；新增测试文件或测试框架；为单个源加特判；改动 `assetUrl` 的调用签名；对 `allowedHosts` 之外的主机发起任何请求；把缓存写成非原子（临时文件 + rename 是硬要求）；在每次图片请求时扫盘统计缓存体积。

## 八、成功标准

1. `GET /api/assets/list` 返回 7 个源目录，姿势库下恰有 4 个体系子目录；逐层展开后 7 个源合计 7,771 个文件条目（不含缩略图，缩略图只作卡片图）。
2. `@pose/<id>.png` 返回的字节与上游 `img/<id>.png` 完全一致（sha256 相等），且第二次请求读缓存、不再发上游请求。
3. 断网情况下带快照启动，`list` 仍返回全部源（标 `stale: true`），`read` 返回 502 而非 500。
4. 四个写接口对 `@` 路径返回 403，对本地路径行为与改动前完全一致。
5. `bun run typecheck` 通过；本地素材库既有功能（列目录、预览、拖进画布、agent 引用）在真实数据目录下人工回归无变化。
6. `GET /api/assets/list?path=@pose/<某个体系>` 返回该体系下的条目数，与索引按该字段统计的条数一致（4 类分别为 399/365/400/275）。
7. 任一源配置出错（缺 `allowedHosts`、模板占位符未知、`indexPath` 缺失）时，只有该源从树中消失，其余源与本地素材不受影响，日志能指名是哪个源哪条规则。
8. 缓存目录中不存在临时文件残留；一次被中断的下载不会让后续请求返回残缺字节。

## 九、已定决策

五个原本待定的点已按实测数据定下，写在这里连同理由，后续要改按此节改。

### 9.1 缓存上限：2 GB（可调 `cacheLimitBytes`）

全量体积实测（每库 20 条均匀抽样取 `content-length`，人像库用索引自带的 `字节数` 精确求和）：

| 源 | 文件数 | 平均大小 | 估算总量 |
|---|---|---|---|
| 姿势·原图 | 1,439 | 470,896 B | 646 MB |
| 姿势·深度 | 1,439 | 98,616 B | 135 MB |
| 服装·写实 | 1,407 | 93,212 B | 125 MB |
| 服装·Shisei | 227 | 24,701 B | 5 MB |
| 服装·动漫 | 1,320 | 349,919 B | 440 MB |
| 服装·CharaDB | 440 | 130,066 B | 55 MB |
| 人像 | 1,499 | — | **4,637 MB（精确）** |
| 合计 | 7,771 | — | **约 6,044 MB** |
| 缩略图 | 7,771 | 16,745 B | 约 124 MB |

2 GB 的依据：全部缩略图只有 124 MB，永远装得下（列表观感靠它）；剩下约 1.9 GB 给原图按需周转。全量 6 GB 没有意义 —— 人像库一个就占 4.6 GB（单张平均 3 MB），用户不会一次看完，也不该在本地囤 6 GB 上游图片。

### 9.2 敏感项：全部拉入，不过滤

CharaDB 索引里的 `敏感` 布尔字段（396 false / 44 true）只是上游的标注，不参与本规格的筛选逻辑。440 条全部进树、全部可读。源配置里因此不设 `exclude` 字段 —— 没有源需要它，留一个空机制就是死代码。

### 9.3 手动刷新索引入口：不做

TTL 24 h 加 `etag` 条件请求已经覆盖日常更新。加按钮要先在 `asset-library-ui` 里有落点，属于当前阶段之外。源配置留 `ttlSeconds` 字段，将来要开不用改结构。

### 9.4 `settings.json` 覆盖源配置：不做

源表是 `sources.ts` 里的具名常量数组，加一个库 = 加一个对象。走配置文件的代价是要做校验和错误路径（配错就整个素材库打不开），收益只是免一次代码改动。

这里要区分两件事：**写在代码里的数据结构**是配置驱动，**写在代码里的分支**才是硬编码。本规格实现后代码里不应出现 `if (source.id === "pose")` 这类判断 —— 七个源的差异全部在配置表里。

### 9.5 本地源命名：「我的素材」，排第一

与现状一致（现在根目录就是本地文件），用户自己的东西优先。`assetBrowser.vue:34` 根目录空标题仍是「全部素材」，`我的素材` 是它的第一个子目录。

### 9.6 缓存目录是可删的

图片缓存落 `data/assetCache/`，`.gitignore:4` 的 `/data/` 已经覆盖它，不会进版本库。这个目录**纯属可重建**：删掉只会导致下一次浏览重新下载（全部缩略图 124 MB，见 9.1），不丢任何用户数据。备份、迁移、排障时可以直接删。索引快照也在这里，删掉后首次访问重新拉索引。

### 9.7 核心取舍记进 ADR

本方案真正的架构决策不是"怎么接三个库"，而是**把远程只读源塞进现有的文件夹树 UI**：用一层薄的路径协议（`@<sourceId>/…`）换取 6 个既有调用点（`assetMenu.vue:130`、`assetLibrary.vue:137`、`canvasDrop.ts:126`、`mentionThumbnail.vue:31`、`mentionContent.vue:70`、`utils/mcp/operations.ts:125`）零改动。代价是 UI 心智与数据模型不完全贴合 —— 远程源没有真实目录（`groupBy` 造的是假目录，分组基数还会随上游变）、不能写、不能拖动、排序语义与本地不同。替代方案是独立"素材中心"页面，数据模型干净但拖拽/预览/agent 引用三条链路全要重做。选现在的路，这个账要写进 `tasks/plan.md` 的 ADR 段，否则半年后会有人问"为什么素材库里不能建文件夹"。

### 9.8 题材分组按配置隐藏

`SourceConfig.hiddenGroups?: string[]` —— `groupBy` 分出的分组若命中名单，该组全部条目在根层、搜索和树里都不出现。属于源配置数据，不是代码分支；加一组只改配置。当前 `pose` 隐藏「双人缠绵」。


## 十、实现后的契约变更（2026-11-20，以本节为准）

第三～四节是最初的设计稿。实现并按上游产品形态调整后，以下契约已变更，代码以本节为准。

### 10.1 `SourceConfig`

- `indexPath?: string` → `indexes: { label: string; path: string }[]`。一个源可挂多份索引，条目带 `origin`（该份索引的 `label`）。四份服装索引（写实 / 动漫 / CharaDB / Shisei）合成一个「服装穿搭库」。
- `hiddenGroups?: string[]` → `adultGroups?: string[]`。命中的分组**不是删除**，而是默认不返回：`list` / `search` 带 `adult=true` 才出现，响应里 `hiddenGroups` 回传被隐藏的分组名与数量，界面显示「另有 N 个 18+ 分组」。
- `groupBy` 的语义从「目录层级」改成「分类 chips」：库根一次返回该源全部条目（带 `group` 字段），`groupBy` 只用来分组供筛选，不再造二级目录。上游就是这样——分类是筛选器，不是文件夹。
- 新增 `mergeBy?: string`：模板，同一 `groupBy` 分组内键相同的条目聚合成一条，其余进 `variants`。姿势库用 `{姿势编号}` 把同一姿势的 5 个视角并成一张卡。
- 新增 `variantLabel?: string`：`variants` 每项的显示名，姿势库用 `{角度}`。
- 新增 `badge?: string` / `meta?: string`：卡片左上角标（`{姿势编号}`）与副标题（姿势库 `{分类}`、人像库 `{发长}`）。
- 源表最终 4 个：`local`（我的素材）、`pose`（姿势库）、`costume`（服装穿搭库）、`portrait`（人像库）。

### 10.2 `SourceFileRole`

`"original" | "thumb" | "depth"` → `"original" | "thumb" | "alternate"`。`alternate` 是同一素材的第二视图（姿势库的深度图），不再产出独立条目，而是贴回原条目的 `alternatePath` / `alternateThumbPath` / `alternateName`。`role: "thumb"` 配 `thumbFor`（`"original"` 或 `"alternate"`）决定挂到哪个视图上。

### 10.3 `AssetEntry`

新增：`readOnly?`、`thumbPath?`、`stale?`、`group?`（分类名）、`origin?`（来源库）、`adult?`、`badge?`、`meta?`、`count?`（分类条目数）、`alternatePath?`、`alternateThumbPath?`、`alternateName?`、`variants?: AssetVariant[]`。`AssetVariant = { label, path, name, thumbPath?, alternatePath?, alternateThumbPath?, alternateName? }`。

### 10.4 接口

- `GET /api/assets/list?path=&recursive=true&adult=true`：`path` 缺省返回本地一层 + `sources`（含 `readOnly`、`stale`、`adultGroups`、`multiOrigin`）；`path=@<sourceId>` 返回该库全部条目 + `groups`（分类 chips）+ `hiddenGroups`；`path=@local/...` 走本地；`recursive=true` 只给「移动到」用。**远程源不再返回二级目录**。
- `GET /api/assets/search?q=&limit=&offset=&adult=`：每项 `{ source, sourceLabel, readOnly, name, path, type: "file", thumbPath? }`。`type` 必须带，否则前端把图片当普通文件渲染成图标。
- `GET /api/assets/read?path=`：本地与远程共用；远程首次穿透缓存并在 `data/assetCache/<sourceId>/` 落磁盘，二次命中 0–1 ms。

### 10.5 界面结构（照上游）

侧栏 = 4 个库（不可展开）；库根 = 标题 + 状态摘要（`153 个素材 · 765 张图 · 另有 2 个 18+ 分组`）+ 分类 chips + 卡片网格；卡片 = 编号角标 / 角度角标 / 名称 / 5 张视角缩略图 / 分类副标题；顶部 = 页面级「素体白模 · 深度图」分段控件 + 搜索框 + 18+ 开关；分页 60 条 + 「加载更多」。只读库不显示任何写操作。
