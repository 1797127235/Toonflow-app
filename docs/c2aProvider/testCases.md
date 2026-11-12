# C2A 图片与视频模型测试用例

配套文档：`docs/c2aProvider/testPlan.md`（环境、成本策略、已通过的实测记录）
被测对象：`packages/providers/src/media/c2a.ts`（运行时 `data/providers/c2a.ts`）
范围：6 个图片模型 + 16 个视频模型，以及素材网关、业务链路、参数边界。

---

## 1. 使用说明

### 1.1 编号与优先级

| 前缀 | 含义 | 执行入口 |
| --- | --- | --- |
| `IMG-xx` | 图片模型 | `/api/providers/debug/run` |
| `VID-xx` | 视频模型 | `/api/providers/debug/run` |
| `AST-xx` | 素材网关 | `/api/providers/debug/run` |
| `API-xx` | 业务链路 / 报价 | `/api/ai/media/generate`、`/api/ai/media/price` |
| `NEG-xx` | 参数边界（应本地拒绝，不发上游） | `/api/providers/debug/run` |

- **P0**：主链路，必须先跑通；**P1**：模式覆盖；**P2**：边界与异常。
- 每条用例执行后填写「结果」列：`通过` / `失败：<上游原文>` / `跳过：<原因>`，并在 §9 记录原始请求响应。

### 1.2 统一判定

- 通过：上游 2xx；任务终态被 `taskDone` 识别；产物 mimeType 正确；日志里的请求体符合「预期请求」列。
- 失败：4xx/5xx、终态 `failed/expired`、产物缺失或 mime 错误、请求体字段与预期不符（即使上游碰巧成功）。
- 参数被上游拒绝时，必须区分「我方映射错」与「上游与文档不符」，写进结果列。

### 1.3 执行前置

- 服务在 `http://127.0.0.1:3000` 运行，`data/settings.json` 的 `mediaProviderConfigs.c2a` 已配置 `apiKey` / `baseUrl` / `assetGateway`。
- 素材：
  - 图 `data/workspaces/艾雷教堂/assets/generated/image6b860b8f-cd34-48b2-b7cb-475d530d22a4.png`（2048×1152，1.7 MB）
  - 视频 `data/workspaces/狗跳舞/assets/69f80c53-d530-4abd-b304-e63707165b0e/source.mp4`（748 KB）
- 请求模板见 `docs/c2aProvider/testPlan.md` §3。除非特别说明，视频一律用**该模型允许的最小时长 + 最便宜分辨率**。

---

## 2. 图片用例

`ImageRequest` 可用字段：`model`、`prompt`、`size`、`ratio`、`n`、`quality`、`outputFormat`、`images[]`、`mask`。

| 编号 | 优先级 | 模型 | 模式 / 档位 | 请求要点 | 预期请求（我方发出的） | 通过标准 | 费用 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-01 | P0 | `grok-imagine-image-2.0` | 文生 1K 1:1 | `size:"1K"`, `ratio:"1:1"` | `POST /images/generations`，body `{model,prompt,n:1,response_format:"b64_json",resolution:"1k",aspect_ratio:"1:1"}` | 返回 `data[0].b64_json`，mime 判定为 png/jpeg | 0.081 |
| IMG-02 | P1 | 同上 | 文生 2K 16:9 | `size:"2K"`, `ratio:"16:9"` | body 含 `resolution:"2k"` 与 `aspect_ratio:"16:9"`，**不含** `size` | 出图 | 0.099 |
| IMG-03 | P2 | 同上 | 文生 4K | `size:"4K"` | body **不含** `resolution`（正则只认 1k/2k），只带 `aspect_ratio` | 上游接受并出图；若上游忽略 4K，记录实际尺寸 | 0.15 |
| IMG-04 | P0 | 同上 | 图生单图 | `images:[图]` | `POST /images/edits`，multipart，文件字段名 **`image`**，参考图压缩后 ≤512 KB | 200 且返回图片；记录压缩后字节数 | 0.081 |
| IMG-05 | P1 | 同上 | 多参考 2 图 | `images:[图A,图B]` | multipart 字段名 **`image[]`**，两个 part | 200 | 0.081 |
| IMG-06 | P2 | 同上 | mask 蒙版 | `images:[图]`, `mask` | multipart 增加 `mask` part | 200 | 0.081 |
| IMG-07 | P1 | `grok-imagine-image-quality` | 文生 1K 9:16 | `size:"1K"`, `ratio:"9:16"` | 同 IMG-01，`aspect_ratio:"9:16"` | 出图，竖向 | 0.081 |
| IMG-08 | P0 | `gpt-image-2` | 文生 1K 1:1 | `size:"1K"`, `ratio:"1:1"` | `POST /images/generations`，body `{model,prompt,size:"1024x1024",n:1}`，**无** `response_format` | 200 | 0.12 |
| IMG-09 | P1 | `gpt-image-2` | 文生 2K 16:9 | `size:"2K"`, `ratio:"16:9"` | `size:"2048x1152"` | 200，记录实际返回尺寸 | 0.12 |
| IMG-10 | P1 | `gpt-image-2` | 图生单图 | `images:[图]` | `POST /images/edits` multipart，字段 `image`，`size` 仍为 WxH | 200 | 0.12 |
| IMG-11 | P0 | `gpt-image-2.5` | 文生 4K 1:1 | `size:"4K"` | `size:"4096x4096"`；若上游 400 记录原文（已知 gpt-image-2 会被钳到 2880） | 200 或记录上游钳制行为 | 0.12 |
| IMG-12 | P1 | `gpt-image-2.5-flare` | 文生 2K 16:9 | `size:"2K"`, `ratio:"16:9"` | `size:"2048x1152"` | 200 | 0.12 |
| IMG-13 | P2 | `gpt-image-2.5-flare` | 文生 4K（越界） | `size:"4K"` | 我方不拦截，发出 `4096x4096` | 记录上游是否 400；若 400，说明需我方拦截 | 0 |
| IMG-14 | P1 | `gpt-image-2.5-sunburst` | 文生 1K 3:4 | `size:"1K"`, `ratio:"3:4"` | `size:"768x1024"` | 200 | 0.12 |
| IMG-15 | P2 | `gpt-image-2.5-sunburst` | 文生 4K | `size:"4K"` | `size:"4096x4096"` | 记录上游是否忽略档位 | 0.12 |
| IMG-16 | P2 | `gpt-image-2` | 输出格式 | `outputFormat:"webp"` | body 含 `output_format:"webp"` | 产物 mime 为 webp，或记录上游忽略 | 0.12 |
| IMG-17 | P2 | `gpt-image-2` | 批量 | `n:2` | body `n:2`；Grok 侧则固定 `n:1` | 返回 2 张 | 0.24 |
| IMG-18 | P2 | 任一 | 内容策略拦截 | 明显违规提示词 | — | 返回 `respect_moderation:false` 时我方抛出「图片被上游内容策略拦截」 | 0 |

**参考图的压缩验证**：用 1.7 MB 的原图跑 IMG-04，日志里 multipart 的 `Content-Length` 应显著小于原图；若压缩失败会抛「参考图压缩到 512 KB 以内仍不达标」。

---

## 3. 视频用例 · Grok 分支

`grok-imagine-video-1.5` / `grok-imagine-video-1.5-preview`，模式由 `generateGrokVideo` 决定：

- 只有 `firstFrame`/`lastFrame` → 首尾帧模式，body 用 `image` / `last_frame`。
- 有 `images` 且无帧 → 全能参考模式，body 用 `reference_images`。
- 有 `videos` → 同样进全能参考模式，body 用 `videos`。
- 参考音频一律拒绝。

| 编号 | 优先级 | 模式 | 请求要点 | 预期请求体关键字段 | 通过标准 | 费用 |
| --- | --- | --- | --- | --- | --- | --- |
| VID-01 | P0 ✅ | 文生 | 480p / 1s / 16:9；`-1.5` 与 `-preview` 各测一次 | `{model,prompt,duration:1,resolution:"480p",aspect_ratio:"16:9"}` | 两条均通过，见 §9 | 0.30 |
| VID-02 | P0 ✅ | 图生·首帧 | `firstFrame` | `image:{url:<网关签名URL>}`，无 `reference_images` | 已通过 | 0.15 |
| VID-03 | P0 ✅ | 视频参考 | `videos:[mp4]`，480p / 1s | `videos:[{url:<网关URL>}]`，**无** `image`、无 `reference_images` | 200；`upload/init` 命中内容寻址缓存时直接返回 URL | 0.15 |
| VID-04 | P1 ✅ | 首尾帧 | `firstFrame` + `lastFrame` | `image` + `last_frame` 两个对象 | 200 | 0.15 |
| VID-05 | P1 | 全能参考·图+视频 | 1 图 + 1 视频 | 只有 `reference_images:[{url}]` 与 `videos:[{url}]` | 200 | 0.15 |
| VID-06 | P1 | 参考图上限 | 3 张图 | `reference_images` 长度 3 | 200 | 0.15 |
| VID-07 | P2 | 参考图越界 | 4 张图 | 不发请求 | 本地报「最多 2 张图」（非参考模式下 sources > 2 被拦） | 0 |
| VID-08 | P2 | 参考音频 | `audios:[音频]` | 不发请求 | 本地报「Grok 视频暂不支持参考音频」 | 0 |
| VID-09 | P1 ✅ | 音画同出 | `generateAudio:true` / `false` 各一次，480p/1s | 分别为 body `generate_audio:true` / `false` | 200；true 含 aac 音轨，false 无音轨 | 0.30 |
| VID-10 | P2 | 时长上限 | 480p / 15s | `duration:15` | 200；记录耗时（可能数分钟） | 2.25 |
| VID-11 | P2 | 分辨率档 | 1080p / 1s | `resolution:"1080p"` | 200 | 0.3 |
| VID-12 | P2 | 比例 | `ratio:"21:9"` | `aspect_ratio:"21:9"` | 200 或记录上游不支持 | 0.15 |
| VID-13 | P2 | 比例越界 | `ratio:"2:1"` | 不发请求 | 本地报「不支持输出比例 2:1」 | 0 |
| VID-14 | P2 | 时长越界 | `duration:0` / `16` | 不发请求 | 本地报「时长须为 1–15 秒的整数」 | 0 |
| VID-15 | P2 | 仅尾帧 | 只给 `lastFrame` | 视实现：Grok 分支 README 称输出参考图，需实测 | 记录实际行为（允许则校验 body，拒绝则记录原文） | 0.15 |

---

## 4. 视频用例 · 统一视频接口

请求体统一为 `{model,prompt,resolution,duration,aspect_ratio,images[{url,role}],videos[{url,role}],audios[{url}]}`；参考图内联 data URI，参考视频走素材网关，参考音频内联（≤15 MB）。

### 4.1 Seedance

| 编号 | 优先级 | 模型 | 模式 | 请求要点 | 预期 | 费用 |
| --- | --- | --- | --- | --- | --- | --- |
| VID-16 | **P0** | `doubao-seedance-2-0-260128` | 文生 | 480p / 4s | 200；`images` 字段不存在 | 3.2 |
| VID-17 | P1 | 同上 | 首帧 | `firstFrame` | `images:[{url:"data:image/...",role:"first_frame"}]` | 3.2 |
| VID-18 | P1 | 同上 | 参考视频 | 1 段 mp4 | `videos:[{url:<网关URL>,role:"reference_video"}]` | 3.2 |
| VID-19 | P1 | `doubao-seedance-2-0-fast-260128` | 文生 | 480p / 4s | 200 | 1.6 |
| VID-20 | P1 | `doubao-seedance-2-0-mini-260615` | 参考图 | 480p / 4s / 1 图 | `images:[{role:"reference_image"}]` | 1.2 |
| VID-21 | P1 | `doubao-seedance-2-5-260628` | 文生 | 720p / 4s | 200 | 4 |
| VID-22 | **P0** | `doubao-seedance-2-5-260628` | 参考视频 | 480p / 4s | 200；网关上传 748 KB 单分片 | 4 |
| VID-23 | P2 | 同上 | 长时长 | 720p / 30s | 30 分钟轮询内完成；记录实际耗时 | 30 |

### 4.2 Kling

| 编号 | 优先级 | 模型 | 模式 | 请求要点 | 预期 | 费用 |
| --- | --- | --- | --- | --- | --- | --- |
| VID-24 | P1 | `kling-3.0` | 文生 | 720p / 3s | 200；`images`/`videos` 均不存在 | 2.43 |
| VID-25 | P1 | `kling-3.0` | 首帧 | 720p / 3s | `role:"first_frame"` | 2.43 |
| VID-26 | P2 | `kling-3.0` | 参考视频（越界） | 带 1 段视频 | 不发请求，本地报「不支持参考视频」 | 0 |
| VID-27 | P1 | `kling-3.0-omni` | 参考视频 | 720p / 3s / 1 图 + 1 视频 | `images` + `videos` 同时存在，role 分别为 `reference_image` / `reference_video` | 2.97 |
| VID-28 | P1 | `kling-3.0-turbo` | 文生 | 720p / 3s | 200 | 2.16 |
| VID-29 | **P0** | `kling-4.0` | 参考图 | 720p / 3s / 1 图 | `images:[{role:"reference_image"}]` | 1.62 |
| VID-30 | P1 | `kling-4.0-Omni` | 参考音频 | 720p / 3s / 1 音频 | 顶层 `audios:[{url:"data:audio/..."}]` | 1.94 |
| VID-31 | P2 | `kling-4.0-Omni` | 音画同出 | 720p / 3s / `generateAudio:true` | body `generate_audio:true` | 1.94 |

### 4.3 MiniMax

| 编号 | 优先级 | 模型 | 模式 | 请求要点 | 预期 | 费用 |
| --- | --- | --- | --- | --- | --- | --- |
| VID-32 | P1 | `MiniMax-H3` | 文生（720p 传入） | 请求 `resolution:"720p"` | body 里被改写为 **`768p`**；报价按 768p | 2.04 |
| VID-33 | P1 | `MiniMax-H3` | 参考视频 | 768p / 4s | `videos:[{role:"reference_video"}]` | 2.04 |
| VID-34 | P1 | `MiniMax-H3-Max` | 参考音频 | 768p / 4s | 顶层 `audios` | 2.04 |
| VID-35 | P2 | `MiniMax-H3-open` | 文生 | 720p / 4s | 200 | 1.32 |

### 4.4 万相

| 编号 | 优先级 | 模型 | 模式 | 请求要点 | 预期 | 费用 |
| --- | --- | --- | --- | --- | --- | --- |
| VID-36 | **P0** | `wan3.0-video` | 文生 | 480p / 2s | 200 | 0.42 |
| VID-37 | P1 | `wan3.0-video` | 参考视频 | 480p / 2s | `videos:[{role:"reference_video"}]` | 0.42 |
| VID-38 | P2 | `wan3.0-video` | 参考音频 | 480p / 2s | 顶层 `audios:[{url}]`；**源码中 role 未声明，是已知风险点** | 0.42 |
| VID-39 | P2 | `wan3.0-video-prime` | 文生 | 480p / 2s | 200 | 0.73 |

---

## 5. 素材网关用例

| 编号 | 优先级 | 场景 | 操作 | 预期 | 费用 |
| --- | --- | --- | --- | --- | --- |
| AST-01 | P0 | 首次上传 | VID-03 的 mp4 | `upload/init` → `PUT part?part=1` → `upload/complete`，返回签名 URL | 计入 VID-03 |
| AST-02 | P1 | 内容寻址命中 | 重复跑 VID-03（同一文件） | 第二次 `upload/init` 返回已存在，不再 PUT part | 0.15 |
| AST-03 | P2 | 分片（>8 MB） | 用 >8 MB 视频/图片 | `part=1`、`part=2` 依次上传，`chunkBytes:8388608` | 0.15 |
| AST-04 | P2 | 超限（>20 MB） | 25 MB 文件 | 本地报错，不发起任何请求 | 0 |
| AST-05 | P2 | 不支持类型 | `.gif` 或 `.txt` | 本地报「不支持的文件类型」 | 0 |
| AST-06 | P2 | 网关不可达 + 首帧 | 把 `assetGateway` 改成无效域名跑 VID-02 | 回退内联 Base64（≤440 KB）仍出片；日志里没有网关请求 | 0.15 |
| AST-07 | P2 | 网关不可达 + 参考视频 | 同上跑 VID-03 | 明确报错，不静默降级 | 0 |

---

## 6. 业务链路与报价用例

| 编号 | 优先级 | 接口 | 用例 | 通过标准 | 费用 |
| --- | --- | --- | --- | --- | --- |
| API-01 | **P0** | `POST /api/ai/media/generate` | 视频：grok 图生视频，`directory` 指向 `data/workspaces/狗跳舞`，`firstFrame` 用工作区相对路径 | `assets/generated/` 出现 mp4，响应 `{code:200}` | 0.15 |
| API-02 | P1 | 同上 | 图片：grok 文生图 | `assets/generated/` 出现图片 | 0.081 |
| API-03 | P1 | 同上 | 传 `taskId` 走异步 | 立即返回 `{taskId}`，任务状态可由 `tasks` 接口查询 | 0.15 |
| API-04 | P2 | `tasks` 接口 | 查询进行中的任务、取消任务 | 状态流转正确；取消后不再落盘 | 0 |
| API-05 | P1 | `POST /api/ai/media/price` | 6 图 + 16 视频各报一次 | 金额等于 `C2A_RATES` 单价 × 数量；Seedance 带 note；未匹配档位走 fallback 或返回 null | 0 |
| API-06 | P2 | `GET /api/ai/media/models` | 核对 22 个模型的 `mode`、`durationResolutionMap` | 与本文档 §3/§4 的规格一致 | 0 |

---

## 7. 最小验证集（建议执行顺序）

预算约 9.5 元，覆盖图片两个分支 + 视频四种输入形态 + 落盘。

| 顺序 | 编号 | 说明 | 累计费用 |
| --- | --- | --- | --- |
| 1 | IMG-01 | Grok 文生图链路 | 0.08 |
| 2 | IMG-08 | GPT Image 显式 WxH | 0.20 |
| 3 | IMG-04 | Grok 图生图 multipart | 0.28 |
| 4 | VID-03 | **Grok 视频参考生视频** | 0.43 |
| 5 | VID-04 | 首尾帧 | 0.58 |
| 6 | VID-05 | 图 + 视频混合参考 | 0.73 |
| 7 | VID-16 | Seedance 文生（最贵模型族的入口） | 3.93 |
| 8 | VID-22 | **Seedance 视频参考** | 7.93 |
| 9 | VID-29 | Kling 图参考 | 9.55 |
| 10 | API-01 | 业务链路真实落盘 | 9.70 |

若预算更紧，只跑 `IMG-01 → VID-03 → VID-22 → API-01`（约 4.3 元），即可覆盖「图片可用、视频参考可用、落盘可用」三条主链路。

---

## 8. 参数边界清单（应全部在本地拒绝，零费用）

| 编号 | 输入 | 期望错误 |
| --- | --- | --- |
| NEG-01 | `model:"not-exist"` | `C2A 未适配该模型` |
| NEG-02 | `prompt:""` | `提示词不能为空` |
| NEG-03 | grok 视频 `duration:0` / `16` | `Grok 视频时长须为 1–15 秒的整数` |
| NEG-04 | seedance `duration:3` | `Seedance 2.0 时长须为 4–15 秒的整数` |
| NEG-05 | kling-3.0 `resolution:"480p"` | `Kling 3.0 只支持 720p / 1080p / 4k` |
| NEG-06 | grok `resolution:"1080P"` | 归一化为小写后通过（不算错误，验证大小写兼容） |
| NEG-07 | kling-3.0 2 张参考图 | `Kling 3.0 参考图最多 1 张` |
| NEG-08 | 首帧 + 参考图同时给 | `首尾帧不能与参考图、参考视频或参考音频混用` |
| NEG-09 | 仅 `lastFrame` | `不支持仅尾帧输入，请提供首帧` |
| NEG-10 | `ratio:"5:4"` | `不支持输出比例 5:4` |
| NEG-11 | 未配 `apiKey` | `请填写 C2A API Key` |

---

## 9. 执行记录

| 编号 | 时间 | 结论 | 上游状态/关键响应 | 产物 | 费用（上游 usage） | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| VID-01 | 2026-11-03 | 通过 | `POST /v1/videos` 200；5 次轮询 pending；终态 `done` | mp4 442 080 字节 | `cost_in_usd_ticks: 800000000` | 成片为相对路径 `/v1/videos/{id}/content` |
| VID-02 | 2026-11-03 | 通过 | 网关 init/part/complete 均 200；`POST /v1/videos` 200 | mp4 607 568 字节 | `cost_in_usd_ticks: 900000000` | body 用 `image`，非 `reference_images` |
| VID-01（preview） | 2026-11-03 | 通过 | `POST /v1/videos` 200，轮询至 `done` | mp4 1126040 字节 | 800000000 | 终态响应里 `model` 被上游归一化为 `grok-imagine-video-1.5` |
| VID-03 | 2026-11-03 | 通过 | 网关 init 直接返回已存在 URL；`POST /v1/videos` 200 | mp4 1554404 字节 | 800000000 | body 只有 `videos:[{url}]`，无 `image` |
| VID-04 | 2026-11-03 | 通过 | 两张图，一张命中缓存、一张走完整三段式；`POST /v1/videos` 200 | mp4 1906216 字节 | 1000000000 | body 为 `image` + `last_frame` |
| VID-09a | 2026-11-03 | 通过 | `POST /v1/videos` 200，39 s | mp4 1021220 字节，含 aac 流 | 800000000 | `generate_audio:true` |
| VID-09b | 2026-11-03 | 通过 | `POST /v1/videos` 200，29 s | mp4 275164 字节，无 aac 流 | — | `generate_audio:false`；**不传该字段时上游默认带音轨** |