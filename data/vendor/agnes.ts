/**
 * Toonflow AI供应商 - Agnes AI (Sapiens AI)
 * @version 1.0
 *
 * 文档：https://agnes-ai.com/zh-Hans/docs/overview
 * 1) 文本：OpenAI 兼容 POST /v1/chat/completions，支持 Thinking 模式
 * 2) 图片：POST /v1/images/generations，支持文生图 / 图生图（注意 response_format 必须放进 extra_body）
 * 3) 视频：异步任务，POST /v1/videos 创建 -> GET /agnesapi?video_id=xxx 轮询
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string; //唯一ID，作为文件名存储用户磁盘上，禁止符号
  version: string; //版本号，格式为x.y，需遵守语义化版本控制
  name: string; //供应商名称
  author: string; //作者
  description?: string; //描述，支持Markdown格式
  icon?: string; //图标，仅支持Base64格式，建议尺寸为128x128像素
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const logger: (msg: string) => void; // 日志函数
declare const urlToBase64: (url: string) => Promise<string>; // URL转Base64函数，返回有头base64字符串
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>; // 轮询函数
declare const createOpenAICompatible: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any; //文本模型
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>; //图片模型，返回有头base64字符串
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>; //视频模型，返回有头base64字符串
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>; //（暂未开放）语音模型，返回有头base64字符串
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "agnes",
  version: "1.0",
  author: "Toonflow",
  name: "Agnes AI",
  description: "Sapiens AI 旗下 Agnes AI 平台，支持文本（含Thinking）、图像（文生图/图生图）与视频（文生/图生/关键帧动画）。\n\n[官方文档](https://agnes-ai.com/zh-Hans/docs/overview)",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "sk-..." },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://apihub.agnes-ai.com" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://apihub.agnes-ai.com" },
  models: [
    { name: "Agnes 2.0 Flash", modelName: "agnes-2.0-flash", type: "text", think: true },
    { name: "Agnes Image 2.1 Flash", modelName: "agnes-image-2.1-flash", type: "image", mode: ["text", "singleImage", "multiReference"] },
    {
      name: "Agnes Video V2.0",
      modelName: "agnes-video-v2.0",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired"],
      audio: false,
      durationResolutionMap: [{ duration: [3, 5, 10, 18], resolution: ["480p", "720p", "1080p"] }],
    },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const getBaseUrl = () => vendor.inputValues.baseUrl.replace(/\/+$/, "");

const getHeaders = () => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
};

// Toonflow 的 size(1K/2K/4K) + aspectRatio 映射为 Agnes 要求的 WxH 字符串
const resolveImageSize = (size: string, aspectRatio: string): string => {
  const parts = String(aspectRatio || "1:1").split(":").map((n) => Number(n) || 1);
  const aw = parts[0];
  const ah = parts[1] || 1;
  const longSide = size === "4K" ? 2048 : size === "2K" ? 1536 : 1024;
  if (aw >= ah) {
    const width = longSide;
    const height = Math.max(1, Math.round((longSide * ah) / aw / 8) * 8);
    return `${width}x${height}`;
  }
  const height = longSide;
  const width = Math.max(1, Math.round((longSide * aw) / ah / 8) * 8);
  return `${width}x${height}`;
};

// 视频时长映射为符合 8n+1 规则且 <=441 的 num_frames，帧率固定 24
const resolveVideoFrames = (duration: number): { numFrames: number; frameRate: number } => {
  const frameRate = 24;
  const target = Math.max(1, Math.round((Number(duration) || 5) * frameRate));
  let numFrames = Math.round((target - 1) / 8) * 8 + 1;
  if (numFrames < 1) numFrames = 1;
  if (numFrames > 441) numFrames = 441;
  return { numFrames, frameRate };
};

// 分辨率 + 宽高比映射为 width/height
const resolveVideoDimensions = (resolution: string, aspectRatio: string): { width: number; height: number } => {
  const res = String(resolution || "720p").toLowerCase();
  const longSide = res.includes("1080") ? 1080 : res.includes("480") ? 480 : 720;
  const parts = String(aspectRatio || "16:9").split(":").map((n) => Number(n) || 16);
  const aw = parts[0];
  const ah = parts[1] || 9;
  if (aw >= ah) {
    const height = longSide;
    const width = Math.max(1, Math.round((longSide * aw) / ah / 8) * 8);
    return { width, height };
  }
  const width = longSide;
  const height = Math.max(1, Math.round((longSide * ah) / aw / 8) * 8);
  return { width, height };
};

// 给纯 base64 补全 data URI 头（Agnes 的图生图接受 Data URI Base64）
const ensureDataUri = (base64: string): string => {
  if (!base64) return base64;
  if (base64.startsWith("data:")) return base64;
  return `data:image/png;base64,${base64}`;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, _thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  // OpenAI 兼容端点，启用 Thinking 时通过 chat_template_kwargs.enable_thinking 注入
  return createOpenAICompatible({
    name: "agnes",
    baseURL: `${getBaseUrl()}/v1`,
    apiKey,
    fetch: async (url: string, options?: RequestInit) => {
      const rawBody = JSON.parse((options?.body as string) ?? "{}");
      const body = think ? { ...rawBody, chat_template_kwargs: { enable_thinking: true } } : rawBody;
      return await fetch(url, { ...options, body: JSON.stringify(body) });
    },
  }).chatModel(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const baseUrl = getBaseUrl();
  const headers = getHeaders();
  const imageRefs = (config.referenceList || []).map((ref) => ref.base64).filter(Boolean);
  const hasImage = imageRefs.length > 0;
  const size = resolveImageSize(config.size, config.aspectRatio);

  // 注意：response_format 必须放在 extra_body 内，不能放在顶层
  const requestBody: any = {
    model: model.modelName,
    prompt: config.prompt,
    size,
  };

  if (hasImage) {
    // 图生图：image 数组放进 extra_body，请求 b64_json 以稳定保留构图
    requestBody.extra_body = {
      image: imageRefs.map(ensureDataUri),
      response_format: "b64_json",
    };
  } else {
    // 文生图：请求 url 返回
    requestBody.extra_body = { response_format: "url" };
  }

  logger(`[Agnes 图片] 提交任务：${model.modelName}，尺寸：${size}，参考图：${imageRefs.length}张`);

  // 指数退避重试：针对队列满、限流等临时错误
  const maxRetries = 5;
  const isRetryable = (text: string) =>
    /queue is full|rate limit|too many requests|retry later|timeout| temporarily/i.test(text);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    // 读取响应文本（clone 避免 body 已读）
    const respText = await resp.text();

    if (!resp.ok || isRetryable(respText)) {
      logger(`[Agnes 图片] 第${attempt}次请求失败：${resp.status} ${respText.slice(0, 200)}`);
      if (attempt === maxRetries) {
        throw new Error(`图片生成失败：${respText}`);
      }
      const delay = Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 1000;
      logger(`[Agnes 图片] ${Math.round(delay)}ms 后重试...`);
      await new Promise((res) => setTimeout(res, delay));
      continue;
    }

    let respData: any;
    try {
      respData = JSON.parse(respText);
    } catch {
      throw new Error(`图片生成失败：响应非 JSON：${respText.slice(0, 500)}`);
    }
    const item = respData.data?.[0];
    if (!item) throw new Error(`图片生成失败：未返回数据。响应：${JSON.stringify(respData).slice(0, 500)}`);

    if (item.b64_json) return ensureDataUri(item.b64_json); // b64_json 无头，补头返回
    if (item.url) return await urlToBase64(item.url);
    throw new Error("图片生成失败：未返回图片地址或数据");
  }

  throw new Error("图片生成失败：重试次数耗尽");
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const baseUrl = getBaseUrl();
  const headers = getHeaders();

  const { numFrames, frameRate } = resolveVideoFrames(config.duration);
  const { width, height } = resolveVideoDimensions(config.resolution, config.aspectRatio);
  const imageRefs = (config.referenceList || []).filter((r) => r.type === "image").map((r) => r.base64).filter(Boolean);

  const requestBody: any = {
    model: model.modelName,
    prompt: config.prompt,
    width,
    height,
    num_frames: numFrames,
    frame_rate: frameRate,
  };

  // 关键帧动画用 extra_body.image + mode=keyframes；图生视频用顶层 image
  if (config.mode.includes("startEndRequired") && imageRefs.length >= 2) {
    requestBody.extra_body = {
      image: imageRefs.slice(0, 2).map(ensureDataUri),
      mode: "keyframes",
    };
  } else if (imageRefs.length >= 1) {
    requestBody.image = ensureDataUri(imageRefs[0]);
  }

  logger(`[Agnes 视频] 提交任务：${model.modelName}，${width}x${height}，${numFrames}帧@${frameRate}fps，参考图：${imageRefs.length}张`);
  const submitResp = await fetch(`${baseUrl}/v1/videos`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
  if (!submitResp.ok) {
    const errorReason = await submitResp.text();
    throw new Error(`视频任务提交失败：${errorReason}`);
  }
  const submitData = await submitResp.json();
  const videoId = submitData.video_id || submitData.id || submitData.task_id;
  if (!videoId) throw new Error(`视频任务提交失败：未获取到任务ID。响应：${JSON.stringify(submitData).slice(0, 500)}`);

  logger(`[Agnes 视频] 任务提交成功，video_id：${videoId}`);

  const pollResult = await pollTask(
    async () => {
      const resp = await fetch(`${baseUrl}/agnesapi?video_id=${encodeURIComponent(videoId)}`, { method: "GET", headers });
      if (!resp.ok) {
        const errorReason = await resp.text();
        throw new Error(`查询视频任务失败：${errorReason}`);
      }
      const data = await resp.json();
      const status = String(data.status || "").toLowerCase();
      if (status === "completed" && data.url) return { completed: true, data: data.url };
      if (status === "failed") return { completed: true, error: data.error ? JSON.stringify(data.error) : "视频生成失败" };
      logger(`[Agnes 视频] 生成中，进度：${data.progress ?? 0}%`);
      return { completed: false };
    },
    5000,
    1800000,
  );

  if (pollResult.error) throw new Error(pollResult.error);
  logger(`[Agnes 视频] 生成完成，开始转换Base64`);
  return await urlToBase64(pollResult.data!);
};

const ttsRequest = async (_config: TTSConfig, _model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: vendor.version, notice: "Agnes AI 供应商初版。" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

// 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
export {};
