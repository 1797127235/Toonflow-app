import { createC2aProvider, type C2aRate, type C2aVideoSpec } from "./c2aProtocol";

const version = "2.9.1";

const rules = [
  {
    type: "input",
    field: "apiKey",
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl",
    title: "网关地址",
    value: "https://www.codex2api.com/v1",
    props: { placeholder: "https://www.codex2api.com/v1" },
  },
  {
    type: "input",
    field: "assetGateway",
    title: "素材网关（可选）",
    value: "https://assets.antest.cc.cd",
    props: { placeholder: "https://assets.antest.cc.cd，留空则只用内联 Base64" },
  },
] as const;

const videoSpecs: Record<string, C2aVideoSpec> = {
  // 上游模型 ID 就是拼错的 vedio，不能改。
  // 档位按「价卡匹配」原则只开放文档给了价格的档位，未报价档位不开放；
  // audios 为 0 表示该模型文档写明参考音频未映射（Seedance 2.x、MiniMax-H3），不是漏填。
  "doubao-seedance-2-0-260128": { label: "Seedance 2.0", resolutions: ["480p", "720p", "1080p", "4k"], duration: [4, 15], images: 9, videos: 3, audios: 0 },
  "doubao-seedance-2-0-fast-260128": { label: "Seedance 2.0 Fast", resolutions: ["480p", "720p"], duration: [4, 15], images: 9, videos: 3, audios: 0 },
  "doubao-seedance-2-0-mini-260615": { label: "Seedance 2.0 Mini", resolutions: ["480p", "720p"], duration: [4, 10], images: 9, videos: 3, audios: 0 },
  "doubao-seedance-2-5-260628": { label: "Seedance 2.5", resolutions: ["480p", "720p", "1080p"], duration: [4, 30], images: 30, videos: 10, audios: 0 },
  "kling-3.0": { label: "Kling 3.0", resolutions: ["720p", "1080p", "4k"], duration: [3, 15], images: 1, videos: 0, audios: 0 },
  "kling-3.0-omni": { label: "Kling 3.0 Omni", resolutions: ["720p", "1080p", "2k", "4k"], duration: [3, 15], images: 7, videos: 1, audios: 0 },
  "kling-3.0-turbo": { label: "Kling 3.0 Turbo", resolutions: ["720p", "1080p"], duration: [3, 15], images: 5, videos: 0, audios: 0 },
  "kling-4.0": { label: "Kling 4.0", resolutions: ["720p", "1080p", "2k", "4k"], duration: [3, 30], images: 10, videos: 0, audios: 0 },
  "kling-4.0-Omni": { label: "Kling 4.0 Omni", resolutions: ["720p", "1080p", "2k", "4k"], duration: [3, 30], images: 10, videos: 5, audios: 3 },
  "MiniMax-H3": { label: "MiniMax H3", resolutions: ["768p", "1080p", "2k", "4k"], duration: [4, 15], images: 9, videos: 3, audios: 0 },
  // 实测上游 Hailuo H3-Max 只接受 [5, 15]，4 秒直接 400（区别于 H3 的 4 秒可用）。
  "MiniMax-H3-Max": { label: "MiniMax H3 Max", resolutions: ["768p", "1080p"], duration: [5, 15], images: 9, videos: 3, audios: 3 },
  "MiniMax-H3-open": { label: "MiniMax H3 Open", resolutions: ["720p", "1080p", "2k", "4k"], duration: [4, 15], images: 9, videos: 3, audios: 3 },
  "wan3.0-video": { label: "万相 3.0", resolutions: ["480p", "720p", "1080p"], duration: [2, 30], images: 10, videos: 5, audios: 5 },
  "wan3.0-video-prime": { label: "万相 3.0 Prime", resolutions: ["480p", "720p", "1080p"], duration: [2, 30], images: 10, videos: 5, audios: 5 }
};

const rates: Record<string, C2aRate> = {
  // Seedance 实际按输出 Token 结算，秒价是创建时冻结的预扣价，只能当估算。
  "doubao-seedance-2-0-260128": { rates: { "480p": 0.8, "720p": 0.8, "1080p": 0.8, "4k": 0.8 }, unit: "秒", note: "按输出 Token 结算，此处为创建时的秒价预扣" },
  "doubao-seedance-2-0-fast-260128": { rates: { "480p": 0.4, "720p": 0.4 }, unit: "秒", note: "按输出 Token 结算，此处为创建时的秒价预扣" },
  "doubao-seedance-2-0-mini-260615": { rates: { "480p": 0.3, "720p": 0.3 }, unit: "秒", note: "按输出 Token 结算，此处为创建时的秒价预扣" },
  "doubao-seedance-2-5-260628": { rates: { "480p": 1, "720p": 1, "1080p": 1 }, unit: "秒", note: "按输出 Token 结算，此处为创建时的秒价预扣" },
  "kling-3.0": { rates: { "720p": 0.81, "1080p": 1.08, "4k": 2.7 }, unit: "秒" },
  "kling-3.0-omni": { rates: { "720p": 0.99, "1080p": 1.26, "2k": 1.62, "4k": 2.7 }, unit: "秒" },
  "kling-3.0-turbo": { rates: { "720p": 0.72, "1080p": 0.9 }, unit: "秒" },
  "kling-4.0": { rates: { "720p": 0.54, "1080p": 1.35, "2k": 1.944, "4k": 2.7 }, unit: "秒" },
  "kling-4.0-Omni": { rates: { "720p": 0.648, "1080p": 1.62, "2k": 1.944, "4k": 3.24 }, unit: "秒" },
  "MiniMax-H3": { rates: { "768p": 0.51, "1080p": 0.663, "2k": 0.816, "4k": 0.9792 }, fallback: 0.51, extraImage: 0.17, unit: "秒" },
  "MiniMax-H3-Max": { rates: { "768p": 0.51, "1080p": 0.663 }, fallback: 0.663, extraImage: 0.17, unit: "秒" },
  "MiniMax-H3-open": { rates: { "720p": 0.33, "1080p": 0.429, "2k": 0.528, "4k": 0.6336 }, fallback: 0.33, extraImage: 0.17, unit: "秒" },
  "wan3.0-video": { rates: { "480p": 0.2088, "720p": 0.4176, "1080p": 0.8352 }, unit: "秒" },
  "wan3.0-video-prime": { rates: { "480p": 0.3672, "720p": 0.7344, "1080p": 1.4688 }, unit: "秒" }
};

export default createC2aProvider({
  id: "c2a",
  label: "C2A 中转 · km",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI4IiBmaWxsPSIjMjU2M0VCIi8+PHBhdGggZD0iTTEwIDIyVjEwaDUuNWEzLjUgMy41IDAgMCAxIDAgN0gxMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIuNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PGNpcmNsZSBjeD0iMjIiIGN5PSIyMiIgcj0iMi42IiBmaWxsPSIjZmZmIi8+PC9zdmc+",
  version,
  readme: `## C2A 中转（Codex2API）
把 C2A 网关的图片与视频模型接入 Laywork；文本模型请在「文本模型 → 添加自定义供应商」里另行配置。

- 网关地址默认 \`https://www.codex2api.com/v1\`，填不填末尾的 \`/v1\` 都能识别。
- **图片**：Grok 图片走 \`/images/generations\`，带参考图走 \`/images/edits\`（multipart，单图 \`image\`、多图 \`image[]\`）；GPT Image 用同一对接口，但走 OpenAI 原生参数（显式 \`size\` 像素与 \`quality\`），1K/2K/4K 会换算成 WxH，\`gpt-image-2.5-flare\` 只开放到 2K。
- **视频**：除 Grok 外全部走 OpenAI Videos 统一入口——\`POST /v1/videos\` 建任务、\`GET /v1/videos/{id}\` 轮询、\`GET /v1/videos/{id}/content\` 下载。请求体为 \`prompt\`、\`images[{url,role}]\`、\`videos[{url,role}]\`、\`audios[{url}]\`、\`duration\`、\`resolution\`、\`aspect_ratio\`；\`extra.*\` 除万相的 \`prompt_extend\` 外会被网关拒绝。各模型的分辨率、时长与素材上限见 \`videoSpecs\`：Seedance / 即梦 / Kling / MiniMax-H3 / Vidu / 万相 都在这一条路径上，差异只在档位和数量上限；首尾帧与混合参考互斥，给了首/尾帧就按帧提交。
- **Grok 视频**仍走 xAI 参数（\`reference_images\` / \`image\` / \`last_frame\`），1–15 秒、480p/720p/1080p。参考素材优先经素材网关换成公网 URL，网关不可用时参考图降级内联 Base64，参考视频无法降级会直接报错。
- **分辨率**：分组页写 720p 的 MiniMax 实际只接受 768p，供应商会自动改名提交。

分组：\`[haishu-视频模型-km渠道]-1.2x\`（doubao-seedance-2-0-*-260128/260615/260628、Kling 3.0/4.0、MiniMax-H3 系列、万相 3.0 video）。价卡按秒；Seedance 四个模型实际按输出 Token 结算，秒价是创建时的预扣估算；MiniMax-H3 系列另有「超出 5 张参考图 ¥0.17/张」的附加费。

**素材网关**填 C2A 官方素材网关（默认 \`https://assets.antest.cc.cd\`），用同一枚 C2A API Key 鉴权：本地素材经三段式上传换成 24 小时公网签名 URL，绕开上游对 base64 请求体的限制。留空则只用内联 Base64。

参考素材会先在服务端按上游的边长与体积限制缩放压缩，无需手工处理。可用模型取决于 API Key 绑定的分组权限，未开放的分组连 \`/v1/models\` 都查不到；请按实际分组维护模型列表。`,
  rules,
  videoSpecs,
  rates,
  // 宿主只解析这份字面量。图片与 Grok 模型两个分组相同，分组视频模型须与 videoSpecs 一致。
  models: [
    {
      id: "grok-imagine-image-2.0",
      label: "Grok Imagine Image 2.0",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "grok-imagine-image-quality",
      label: "Grok Imagine Image Quality",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "gpt-image-2",
      label: "GPT Image 2",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "gpt-image-2.5",
      label: "GPT Image 2.5",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "gpt-image-2.5-flare",
      label: "GPT Image 2.5 Flare",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "gpt-image-2.5-sunburst",
      label: "GPT Image 2.5 Sunburst",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "grok-imagine-video-1.5",
      label: "Grok Imagine Video 1.5",
      type: "video",
      mode: ["text", "singleImage", "startFrameOptional", "startEndRequired", ["imageReference:3", "videoReference:1"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "grok-imagine-video-1.5-preview",
      label: "Grok Imagine Video 1.5 Preview",
      type: "video",
      mode: ["text", "singleImage", "startFrameOptional", "startEndRequired", ["imageReference:3", "videoReference:1"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "doubao-seedance-2-0-260128",
      label: "Seedance 2.0",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "4k"] }],
    },
    {
      id: "doubao-seedance-2-0-fast-260128",
      label: "Seedance 2.0 Fast",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      id: "doubao-seedance-2-0-mini-260615",
      label: "Seedance 2.0 Mini",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10], resolution: ["480p", "720p"] }],
    },
    {
      id: "doubao-seedance-2-5-260628",
      label: "Seedance 2.5",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:30", "videoReference:10"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "kling-3.0",
      label: "Kling 3.0",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:1"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p", "1080p", "4k"] }],
    },
    {
      id: "kling-3.0-omni",
      label: "Kling 3.0 Omni",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:7", "videoReference:1"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p", "1080p", "2k", "4k"] }],
    },
    {
      id: "kling-3.0-turbo",
      label: "Kling 3.0 Turbo",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:5"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p", "1080p"] }],
    },
    {
      id: "kling-4.0",
      label: "Kling 4.0",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:10"]],
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["720p", "1080p", "2k", "4k"] }],
    },
    {
      id: "kling-4.0-Omni",
      label: "Kling 4.0 Omni",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:10", "videoReference:5", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["720p", "1080p", "2k", "4k"] }],
    },
    {
      id: "MiniMax-H3",
      label: "MiniMax H3",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p", "1080p", "2k", "4k"] }],
    },
    {
      id: "MiniMax-H3-Max",
      label: "MiniMax H3 Max",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p", "1080p"] }],
    },
    {
      id: "MiniMax-H3-open",
      label: "MiniMax H3 Open",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p", "1080p", "2k", "4k"] }],
    },
    {
      id: "wan3.0-video",
      label: "万相 3.0",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "wan3.0-video-prime",
      label: "万相 3.0 Prime",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
  ],
});
