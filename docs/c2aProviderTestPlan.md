# C2A 提供商真实调用测试计划

对象：`packages/providers/src/media/c2a.ts`（v2.9.1，运行时副本 `data/providers/c2a.ts`）
目标：用真实上游调用验证 6 个图片模型 + 16 个视频模型的协议适配，**重点是视频**：文生视频、图生视频（首帧/首尾帧）、视频参考生视频，以及素材网关的三段式上传。
不产生任何测试代码文件：全部通过既有 HTTP 接口执行，结果记录在本文件。

---

## 1. 判定口径

| 结论 | 条件 |
| --- | --- |
| 通过 | 上游返回 2xx；任务状态到达终态且被 `taskDone` 识别；成片可下载，`mimeType` 正确；业务链路能落盘 |
| 失败 | 任意 4xx/5xx、上游拒绝参数、轮询超 30 分钟仍未终态、成片下载失败、落盘失败 |
| 无法判定 | 只看到代码自洽、只做了参数校验、没有产生真实请求 |

一个用例只要上游报错就算失败，**不允许用「换个参数再试」掩盖协议错误**；参数错误要区分是我们的映射错，还是上游文档与实际不符。

---

## 2. 环境与前置

- 服务：`bun run dev`（`apps/server`），默认端口 `3000`；`apps/server/src/index.ts:6`。
- 配置来源：`data/settings.json` → `settings.mediaProviderConfigs.c2a`，包含 `apiKey`、`baseUrl`（`https://www.codex2api.com/v1`）、`assetGateway`（`https://assets.antest.cc.cd`）。`c2aYzh` 暂无 Key，本计划只测 `c2a`。
- `apps/server/src/app.ts:97` JSON 上限 100 MB；媒体请求体上限 64 MB（provider 内部检查）。
- 素材（工作区内，供图生视频 / 参考视频使用）：

| 用途 | 路径 | 规格 |
| --- | --- | --- |
| 首帧 / 参考图 | `data/workspaces/艾雷教堂/assets/generated/image6b860b8f-cd34-48b2-b7cb-475d530d22a4.png` | 2048×1152，1.7 MB |
| 参考视频 | `data/workspaces/狗跳舞/assets/69f80c53-d530-4abd-b304-e63707165b0e/source.mp4` | 748 KB |

- 鉴权差异：`/api/ai/media/price` 有 `assertAppRequest`（非页面来源返回 403）；`/api/providers/debug/run` 与 `/api/ai/media/generate` 没有该限制，可直接 curl。

---

## 3. 三个测试入口

### 3.1 调试接口（看原始 HTTP，不落盘）

`POST /api/providers/debug/run`，NDJSON 流：

```bash
cd /home/liu/桌面/Toonflow-app
jq -n --rawfile src data/providers/c2a.ts --slurpfile s data/settings.json \
  --arg b64 "$(base64 -w0 <图片路径>)" '{
    source: $src,
    config: $s[0].settings.mediaProviderConfigs.c2a,
    request: {
      model: "grok-imagine-video-1.5",
      prompt: "the scene comes alive, slow camera push in, cinematic",
      duration: 1, resolution: "480p", ratio: "16:9",
      firstFrame: { type: "base64", data: $b64, mimeType: "image/png" }
    }
  }' > /tmp/c2aCase.json

curl -sN -m 900 -H 'Content-Type: application/json' \
  --data-binary @/tmp/c2aCase.json \
  http://127.0.0.1:3000/api/providers/debug/run | tee /tmp/c2aCase.out
```

输出事件：

- `{type:"log", log:{id,state,method,url,request,status,duration,response,error}}`：每次上游 fetch 一条；请求头里的密钥显示为 `••••••`，超过 16 KB 的响应正文被截断，超过 4000 字符的字符串替换为 `[N 个字符]`。
- `{type:"result", duration, assets:[{mediaType,type,mimeType,data}]}`：媒体以 base64 回传，不写盘。
- `{type:"done"}` / `{type:"error", error:{message}}`。

限制：调试接口没有工作目录，`tool.ffmpeg()` 不可用（c2a 不使用，无影响）；参考素材只能内联 base64，不能传工作区路径。

### 3.2 业务链路（真实落盘）

`POST /api/ai/media/generate`，body 为 `{directory, mediaType, ...videoGenerationSchema}`：

```bash
curl -sN -m 900 -H 'Content-Type: application/json' -d '{
  "directory": "/home/liu/桌面/Toonflow-app/data/workspaces/狗跳舞",
  "mediaType": "video",
  "providerId": "c2a",
  "modelId": "grok-imagine-video-1.5",
  "prompt": "同一段动作，换一个机位",
  "duration": 1,
  "resolution": "480p",
  "ratio": "16:9",
  "firstFrame": { "path": "assets/generated/<file>.png", "mimeType": "image/png" },
  "videos": [{ "path": "assets/69f80c53-d530-4abd-b304-e63707165b0e/source.mp4", "mimeType": "video/mp4" }],
  "mode": ["videoReference:1"]
}' http://127.0.0.1:3000/api/ai/media/generate
```

- `directory` 必须是已授权工作区（`u.workspace.resolveWorkspace`）。
- 参考素材只接受工作区相对路径 + mimeType，不能传 base64 / 绝对路径。
- 产物落在 `assets/generated/`，响应为 `{code:200,data:[...]}`；流式期间每 20 秒写一个空行保活。
- 首尾帧与参考素材互斥（provider 会直接报错），用例里不要混用。

### 3.3 报价（零成本）

`POST /api/ai/media/price`，需要页面控制头。若不通过，用 `provider.getPrice` 的期望值直接比对 `C2A_RATES`。

---

## 4. 用例矩阵

优先级：**P0 = 视频主链路（用户核心诉求）**，P1 = 图片与落盘，P2 = 素材网关与边界。

### 4.1 视频模型与规格（来自 `VIDEO_SPECS`，`packages/providers/src/media/c2a.ts:707`）

| 模型 | 分辨率 | 时长（秒） | 参考图 | 参考视频 | 参考音频 | 最低成本试跑 |
| --- | --- | --- | --- | --- | --- | --- |
| `grok-imagine-video-1.5` | 480p / 720p / 1080p | 1–15 | 3 | 1 | 0 | 480p×1s = 0.15 元 |
| `grok-imagine-video-1.5-preview` | 同上 | 1–15 | 3 | 1 | 0 | 0.15 元 |
| `doubao-seedance-2-0-260128` | 480p / 720p / 1080p / 4k | 4–15 | 9 | 3 | 0 | 480p×4s = 3.2 元 |
| `doubao-seedance-2-0-fast-260128` | 480p / 720p | 4–15 | 9 | 3 | 0 | 1.6 元 |
| `doubao-seedance-2-0-mini-260615` | 480p / 720p | 4–10 | 9 | 3 | 0 | 1.2 元 |
| `doubao-seedance-2-5-260628` | 480p / 720p / 1080p | 4–30 | 30 | 10 | 0 | 4 元 |
| `kling-3.0` | 720p / 1080p / 4k | 3–15 | 1 | 0 | 0 | 720p×3s = 2.43 元 |
| `kling-3.0-omni` | 720p / 1080p / 2k / 4k | 3–15 | 7 | 1 | 0 | 2.97 元 |
| `kling-3.0-turbo` | 720p / 1080p | 3–15 | 5 | 0 | 0 | 2.16 元 |
| `kling-4.0` | 720p / 1080p / 2k / 4k | 3–30 | 10 | 0 | 0 | 1.62 元 |
| `kling-4.0-Omni` | 720p / 1080p / 2k / 4k | 3–30 | 10 | 5 | 3 | 1.94 元 |
| `MiniMax-H3` | 768p / 1080p / 2k / 4k | 4–15 | 9 | 3 | 0 | 768p×4s = 2.04 元 |
| `MiniMax-H3-Max` | 768p / 1080p | 4–15 | 9 | 3 | 3 | 2.04 元 |
| `MiniMax-H3-open` | 720p / 1080p / 2k / 4k | 4–15 | 9 | 3 | 3 | 720p×4s = 1.32 元 |
| `wan3.0-video` | 480p / 720p / 1080p | 2–30 | 10 | 5 | 5 | 480p×2s = 0.42 元 |
| `wan3.0-video-prime` | 480p / 720p / 1080p | 2–30 | 10 | 5 | 5 | 0.73 元 |

单价见 `C2A_RATES`（`packages/providers/src/media/c2a.ts:866`）。Seedance 按输出 Token 结算，秒价只是创建时冻结的预扣价，**实际扣费可能不同**，记录时要写上游 `usage`。

### 4.2 P0 视频用例

| 编号 | 用例 | 模型 | 关键断言 | 状态 |
| --- | --- | --- | --- | --- |
| V-01 | 文生视频 | grok-imagine-video-1.5 480p/1s | `POST /v1/videos` 200 → 轮询 → `GET /v1/videos/{id}/content` → mp4 | **已通过** |
| V-02 | 图生视频（首帧） | 同上 + `firstFrame` | 素材网关 upload/init → part → complete；body `image.url` 为签名 URL | **已通过** |
| V-03 | 视频参考生视频 | 同上 + `videos:[{path}]` | 网关上传 mp4；body `videos:[{url}]`；输出沿用参考动作 | **未完成（上次中断）** |
| V-04 | 首尾帧 | 同上 + `firstFrame` + `lastFrame` | body 为 `image` + `last_frame`，无 `reference_images` | 待测 |
| V-05 | 全能参考（图+视频） | 同上 + 2 图 + 1 视频 | `referenceMode` 生效：body 无 `image`，只有 `reference_images` 与 `videos` | 待测 |
| V-06 | 图片参考生视频 | kling-4.0-Omni + 1 图 | 统一接口 `images:[{url,role:"reference_image"}]`，base64 data URI | 待测 |
| V-07 | 视频参考生视频 | seedance-2-5 + 1 段视频 | 统一接口 `videos:[{url,role:"reference_video"}]` | 待测 |
| V-08 | 音频参考 | wan3.0-video + 1 段音频 | 顶层 `audios:[{url}]`（代码中有 shortcut 注释，最可能失败） | 待测 |
| V-09 | 音画同出 | grok / kling-4.0-Omni + `generateAudio:true` | body `generate_audio:true`，成片含音轨 | 待测 |
| V-10 | 长时长 | seedance-2-5 720p/30s | 30 分钟轮询内完成，记录耗时 | 待测 |
| V-11 | 应用链路落盘 | generate 接口 + 图生视频 | `assets/generated/` 出现 mp4，响应 code 200 | 待测 |

覆盖顺序（控制成本）：V-03 → V-06 → V-07 → V-04 → V-11 → V-05 → V-09 → V-08 → V-10。

每族只测一条最便宜档位；确认协议通过后，不再重复烧钱验证同一分支。

### 4.3 P1 图片用例

| 编号 | 用例 | 断言 |
| --- | --- | --- |
| I-01 | Grok 文生图 1K | `POST /images/generations` 200，返回图片 |
| I-02 | Grok 图生图 1 图 | `POST /images/edits` multipart，参考图 ≤512 KB |
| I-03 | Grok 多参考 | multipart 多文件 |
| I-04 | GPT Image 文生图 1K | `size` 为显式 `1024x1024`，不是 `1K` |
| I-05 | GPT Image 2K / 4K | `2048x...` / `4096x...`，验证 `gptImageSize` 换算 |

### 4.4 P2 素材网关

| 编号 | 用例 | 断言 |
| --- | --- | --- |
| A-01 | 同内容二次上传 | 第二次 `upload/init` 命中缓存，不再传 part |
| A-02 | 单文件 > 8 MB | 分片：`part=1`、`part=2` 依次 PUT |
| A-03 | 文件 > 20 MB | 本地拒绝并提示，不发请求 |
| A-04 | 不支持的 mime | `ASSET_ALLOWED` 之外直接报错 |
| A-05 | 网关不可达 + Grok 首帧 | 回退内联 Base64（≤440 KB）仍能出片 |
| A-06 | 网关不可达 + 参考视频 | 明确报错，不静默降级 |

### 4.5 P2 参数边界（应当本地拒绝，不发上游请求）

- 时长越界：grok 0 秒 / 16 秒；seedance 3 秒（最小 4）；kling 2 秒（最小 3）。
- 分辨率越界：grok `1080P`（大写）、`4k`；kling-3.0 `480p`。
- 参考数量超限：kling-3.0 给 2 张图；kling-3.0 给 1 段视频（videos=0）。
- 互斥：首帧 + 参考图同时给。
- 仅尾帧：应报「不支持仅尾帧输入」。
- 比例：grok `2:1`；统一接口 `5:4`。
- 空提示词。

---

## 5. 成本估算

| 范围 | 估算 |
| --- | --- |
| 已发生（V-01、V-02） | 报价口径 0.15 + 0.15 ≈ 0.3 元（上游返回 `cost_in_usd_ticks` 8e8 / 9e8，与报价表不是同一口径，以账单为准） |
| V-03、V-04、V-05、V-09、V-10、V-11 全部 grok 小样 | 6 × 0.15 ≈ 0.9 元 |
| V-06、V-07、V-08 各族一条最便宜档 | ≈ 7 元 |
| P1 图片 6 条 | ≈ 0.65 元（Grok 2×0.081 + GPT Image 4×0.12） |
| 全矩阵每个视频模型各一条最便宜档 | ≈ 28 元 |

建议：先跑 V-03 / V-06 / V-07（视频参考三条主线），确认后再决定是否补 V-04 / V-05 / V-08 / V-10。

---

## 6. 已有实测记录

### V-01 Grok 文生视频（通过）

请求：`grok-imagine-video-1.5`，480p，1 秒，16:9。

| 步骤 | 上游 | 结果 |
| --- | --- | --- |
| 创建 | `POST /v1/videos` | 200 `{"request_id":"bb0ec0b2-3a9b-96d4-a8c5-de5a0f495f1f"}`，2136 ms |
| 轮询 | `GET /v1/videos/{id}` ×5 | `pending`，progress 1 → 1 → 10 → 75 |
| 终态 | `GET /v1/videos/{id}` | `{"status":"done","progress":100,"video":{"duration":1,"url":"/v1/videos/{id}/content"},"usage":{"cost_in_usd_ticks":800000000}}` |
| 下载 | `GET /v1/videos/{id}/content` | 200，mp4 442 080 字节 |

总耗时 29.3 秒。结论：成片地址是**相对路径**，`absoluteUrl` + `gatewayRoot` 拼接正确；轮询响应是**顶层对象**（无 `data` 包装），`taskOf` 兼容；`done` 被 `taskDone` 识别。

### V-02 图生视频·首帧（通过）

首帧 2048×1152 PNG，1.7 MB。

| 步骤 | 上游 | 结果 |
| --- | --- | --- |
| 上传初始化 | `POST /upload/init` | 200，返回 token + key，`chunkBytes: 8388608` |
| 上传分片 | `PUT /upload/part?part=1` | 200，`etag: 750943976ab3f3ffa0cfd6b36a821a52` |
| 完成上传 | `POST /upload/complete` | 200，签名 URL `https://assets.antest.cc.cd/f/ref/<sha256>.png?exp=...&sig=...` |
| 创建 | `POST /v1/videos` | 200，body 含 `"image":{"url":"<签名 URL>"}` |
| 终态 + 下载 | 轮询 → `/content` | 27 秒出片，607 568 字节，`cost_in_usd_ticks: 900000000` |

结论：素材网关三段式可用；首帧走 `image` 字段、非 `reference_images`；`ratio` 被正确转成 `aspect_ratio`。

### V-03 视频参考生视频（未完成）

上一次执行在构造请求阶段被中断，未产生上游调用，也**未产生费用**。待重跑。

---

## 7. 结果记录模板

```markdown
### <编号> <用例名>

- 时间：
- 模型 / 档位 / 时长：
- 入口：debug-run | generate
- 上游链路：
  1. POST ... → 状态码，耗时，关键响应片段
  2. GET  ... → 状态码，状态流转
- 产物：mimeType / 字节数 / 是否落盘
- 结论：通过 | 失败（失败点 + 原文错误）
- 费用：上游 usage 原值
- 差异：代码假设 vs 上游实际
```

---

## 8. 已知风险与注意

1. **创建请求不重试**（`generateVideoById` 里 `httpRequest(..., 1)`）：连接中断时上游可能已计费，重试会造成重复扣费。测试时失败先查上游任务记录，不要直接重发。
2. 统一视频接口最长等待 30 分钟；Grok 分支 10 分钟。超过后明确超时，不要当成协议失败。
3. `wan3.0` 的参考音频只放了 `{url}`，`role` 字段上游未声明（源码中有 `shortcut:` 注释），是 V-08 的预期风险点。
4. `MiniMax-H3` 系列 720p 会被映射成 768p（上游只认 768p），报价按同价处理；测试时确认 body 里是 `768p`。
5. Grok 参考视频无法内联降级，**必须**配置素材网关或提供公网 URL；`assetGateway` 为空时这条路径不可用。
6. 上游模型 ID `doubao-seedance-2-0-260128` 等带日期，不能替换成短名；`kling-4.0-Omni` 的 `O` 是大写。
7. `models` 数组与 `VIDEO_SPECS` 是手工同步的两处，测试时顺带核对 `GET /api/ai/media/models` 的 `mode` / `durationResolutionMap` 是否与上表一致。