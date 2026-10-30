const version = "2.5.0";

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

/**
 * C2A 中转（Codex2API）全协议适配。
 *
 * 上游协议按模型 ID 分流：
 *   1. Grok 图片      POST /v1/images/generations、/v1/images/edits(multipart)
 *   1b.GPT Image      POST /v1/images/generations、/v1/images/edits(multipart)，OpenAI 原生参数
 *   1c. MidJourney    POST /v1/images/generations（仅 JSON，n=1，固定返回 4 张）
 *   2. Grok 视频      POST /v1/videos                    → GET /v1/videos/{id}(/content)
 *   3. MiniMax-H3     POST /v1/videos                    → GET /v1/videos/{id}(/content)
 *   4. MiniMax-H3-Max POST /v1/videos                    → GET /v1/videos/{id}(/content)
 *   5. 万相 3.0       POST /api/v1/services/aigc/...     → GET /api/v1/tasks/{id}
 *   6. Seedance 2.x   POST /api/v3/contents/generations/tasks → GET 同路径/{id}
 *
 * Grok 视频的参考素材有两条路径：
 *   · 素材网关（对象存储）：内容寻址三段式上传，换 24 小时公网签名 URL，参考视频必须走这条。
 *   · 内联 Base64 降级：网关不可用时参考图压进请求体预算；参考视频无法降级，直接报错。
 * 万相走 DashScope 原生路径，不叠加 /v1 前缀，因此单独用 gatewayRoot 拼根地址。
 */

const MB = 1024 * 1024;

// ─────────────────────────────── 基础工具 ───────────────────────────────

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("C2A 响应格式错误");
  return value as Record<string, unknown>;
}

function apiKeyOf(context: ProviderContext): string {
  const value = typeof context.config.apiKey === "string" ? context.config.apiKey.trim() : "";
  return value.replace(/^Bearer(?:\s+|$)/i, "").trim();
}

/** 统一补成带 /v1 的基址，用户填带不带 /v1 都能用。 */
function gateway(context: ProviderContext): string {
  const configured = typeof context.config.baseUrl === "string" ? context.config.baseUrl.trim() : "";
  const base = (configured || "https://www.codex2api.com/v1").replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

/** 万相等 DashScope 原生路径要的根地址：去掉尾部 /v1。 */
function gatewayRoot(context: ProviderContext): string {
  return gateway(context).replace(/\/v1$/i, "");
}

function assetGatewayOf(context: ProviderContext): string {
  const configured = typeof context.config.assetGateway === "string" ? context.config.assetGateway.trim() : "";
  return configured.replace(/\/+$/, "");
}

function sameHost(left: string, right: string): boolean {
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

/** 参考素材统一转 data URI；上游只认 URL 或 data URI。 */
function dataUri(input: MediaInput): string {
  if (input.type === "url") return input.url;
  const data = input.type === "binary"
    ? Buffer.from(input.data).toString("base64")
    : input.data.replace(/^data:[^;]+;base64,/, "");
  return `data:${input.mimeType || "image/jpeg"};base64,${data}`;
}

function byteLength(input: MediaInput): number {
  if (input.type === "binary") return input.data.byteLength;
  if (input.type === "base64") return Math.floor(input.data.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "").length * 3 / 4);
  return 0;
}

/** 统一成 Uint8Array<ArrayBuffer>，可直接作为 fetch body 与 Blob 分片。 */
function bytesOf(input: MediaInput): Uint8Array<ArrayBuffer> {
  const source = input.type === "binary" ? input.data
    : input.type === "base64" ? new Uint8Array(Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64"))
      : undefined;
  if (!source) throw new Error("该素材需要内联内容，无法直接使用远端地址");
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// 本机代理或网络抖动会让上游偶发 TLS 握手失败、连接被中途关闭（Bun 报 socket closed / certificate error）。
const transientNetworkError = /socket|certificate|ECONNRESET|ECONNREFUSED|ECONNABORTED|network|connection (?:closed|reset|refused|aborted)/i;

/**
 * 连接层有限重试。上限：POST 只重试 1 次，避免已送达的生成请求被重复创建并计费；
 * GET（轮询、下载）重试 3 次，无副作用。只匹配连接错误，HTTP 4xx/5xx 与主动取消直接抛出。
 */
async function httpRequest(context: ProviderContext, url: string, init: RequestInit, signal: AbortSignal, attempts: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await context.tool.fetch(url, { ...init, signal });
    } catch (error) {
      const message = String((error as Error)?.message ?? "");
      if (signal.aborted || attempt >= attempts || !transientNetworkError.test(message)) throw error;
      await wait(signal, 600 * attempt);
    }
  }
}

function readError(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
  const data = value as Record<string, unknown>;
  for (const key of ["error", "message", "msg", "detail"]) {
    const detail = data[key];
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (detail && typeof detail === "object") {
      const nested = (detail as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return "";
}

async function errorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    return `：${readError(JSON.parse(text))}`;
  } catch {
    return `：${text.slice(0, 500)}`;
  }
}

async function post(context: ProviderContext, url: string, body: Record<string, unknown>, signal: AbortSignal) {
  const response = await httpRequest(context, url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKeyOf(context)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  }, signal, 2);
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）${await errorBody(response)}`);
  return record(await response.json());
}

async function get(context: ProviderContext, url: string, signal: AbortSignal) {
  const response = await httpRequest(context, url, {
    headers: { Authorization: `Bearer ${apiKeyOf(context)}` },
    redirect: "error",
  }, signal, 4);
  if (!response.ok) throw new Error(`查询任务失败（HTTP ${response.status}）${await errorBody(response)}`);
  return record(await response.json());
}

/** 通用轮询。query 返回非 null 即结束；返回 null 继续等。 */
async function pollUntil<T>(signal: AbortSignal, intervalMs: number, timeoutMs: number, query: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal.throwIfAborted();
    const result = await query();
    if (result !== null) return result;
    if (Date.now() >= deadline) throw new Error("任务轮询超时；请到 C2A 任务记录核对结果，不要重复提交");
    await wait(signal, intervalMs);
  }
}

/** 任务对象可能在顶层、task 或 data 里，三种取值都兼容。 */
function taskOf(value: Record<string, unknown>): Record<string, unknown> {
  const task = value.task;
  if (task && typeof task === "object" && !Array.isArray(task)) return task as Record<string, unknown>;
  const data = value.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return value;
}

function taskFailed(task: Record<string, unknown>): boolean {
  const status = String(task.status ?? "").toLowerCase();
  return ["failed", "failure", "error", "expired", "cancelled", "canceled", "unknown"].includes(status);
}

function taskDone(task: Record<string, unknown>): boolean {
  const status = String(task.status ?? "").toLowerCase();
  return ["done", "completed", "succeeded", "success"].includes(status);
}

/**
 * 成片地址归一：上游可能返回绝对 URL，也可能是相对路径（实测 grok 为 "/v1/videos/{id}/content"）。
 * 相对路径按网关基址拼成绝对地址后，再判断是否需要带 Key 下载。
 */
function absoluteUrl(context: ProviderContext, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!url.startsWith("/")) throw new Error(`C2A 返回了无法解析的视频地址：${url.slice(0, 200)}`);
  return `${gatewayRoot(context)}${url}`;
}

/** 成片地址可能要求鉴权：只有与网关同域时才带 Key 下载，避免把密钥带去存储域名。 */
async function finalizeVideo(context: ProviderContext, rawUrl: string, apiKey: string, signal: AbortSignal): Promise<MediaAsset[]> {
  const url = absoluteUrl(context, rawUrl);
  if (!sameHost(url, gateway(context))) return [{ mediaType: "video", type: "url", url }];
  const response = await httpRequest(context, url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "error",
  }, signal, 4);
  if (!response.ok) throw new Error(`视频下载失败（HTTP ${response.status}）`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (!data.byteLength) throw new Error("C2A 视频下载内容为空");
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return [{ type: "binary", data, mimeType: contentType.startsWith("video/") ? contentType : "video/mp4", mediaType: "video" }];
}

// ─────────────────────────────── SHA-256 ───────────────────────────────
// 素材网关按内容寻址，init 要 sha256 十六进制。供应商沙箱只注入了
// Buffer/URL/TextEncoder/Blob/AbortController 等，没有 crypto，所以这里手写一份。

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(input: Uint8Array): string {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLength = input.length * 8;
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 长度按 64 位大端写入；素材远小于 2^53 位，用高 32 位直接算。
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(value => value.toString(16).padStart(8, "0")).join("");
}

// ─────────────────────────── 素材网关（对象存储）───────────────────────────
// 协议：POST /upload/init → 命中直接返回签名 URL，否则返回上传令牌；
//       PUT /upload/part?part=N 逐片上传；POST /upload/complete 合并后返回 24 小时签名 URL。

const ASSET_CHUNK_BYTES = 8 * MB;
const ASSET_MAX_BYTES = 20 * MB;
const ASSET_ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov",
};

/** 素材已有公网 URL、或网关未配置、或类型/体积不被接受时返回 null，由调用方降级。 */
async function uploadAsset(context: ProviderContext, input: MediaInput, signal: AbortSignal): Promise<string | null> {
  // 本来就是公网地址，上游能直接拉，不必再传一遍。
  if (input.type === "url") return input.url;
  const origin = assetGatewayOf(context);
  const apiKey = apiKeyOf(context);
  if (!origin || !apiKey) return null;

  const bytes = bytesOf(input);
  const contentType = (input.mimeType || (input.name?.match(/\.(mp4|mov)$/i) ? "video/mp4" : "image/jpeg")).toLowerCase();
  // 网关只收白名单类型与 20 MiB 以内，超限直接判为不可用，交给降级路径给出准确提示。
  if (!ASSET_ALLOWED[contentType]) throw new Error(`素材网关不支持 ${contentType}，仅支持 JPEG / PNG / WebP / MP4 / MOV`);
  if (!bytes.byteLength) throw new Error("参考素材内容为空");
  if (bytes.byteLength > ASSET_MAX_BYTES) throw new Error(`参考素材 ${(bytes.byteLength / MB).toFixed(1)} MB 超过素材网关 20 MB 上限，请先压缩`);

  const auth = { Authorization: `Bearer ${apiKey}` };
  const initResponse = await httpRequest(context, `${origin}/upload/init`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ sha256: sha256Hex(bytes), size: bytes.byteLength, contentType }),
    redirect: "error",
  }, signal, 2);
  if (!initResponse.ok) throw new Error(`素材网关初始化失败（HTTP ${initResponse.status}）${await errorBody(initResponse)}`);
  const init = record(await initResponse.json());
  // 内容寻址命中：同一素材已存在，直接换发新的签名 URL。
  if (typeof init.url === "string" && init.url) return init.url;

  const token = init.token;
  if (typeof token !== "string" || !token) throw new Error("素材网关没有返回上传令牌");
  const chunkBytes = Math.min(ASSET_CHUNK_BYTES, Number(init.chunkBytes) > 0 ? Number(init.chunkBytes) : ASSET_CHUNK_BYTES);

  const parts: { partNumber: number; etag: string }[] = [];
  for (let offset = 0, partNumber = 1; offset < bytes.byteLength; offset += chunkBytes, partNumber++) {
    const slice = bytes.slice(offset, Math.min(offset + chunkBytes, bytes.byteLength));
    const partResponse = await httpRequest(context, `${origin}/upload/part?part=${partNumber}`, {
      method: "PUT",
      headers: { "X-Upload-Token": token, "Content-Type": "application/octet-stream" },
      body: slice,
      redirect: "error",
    }, signal, 4);
    if (!partResponse.ok) throw new Error(`素材网关第 ${partNumber} 片上传失败（HTTP ${partResponse.status}）${await errorBody(partResponse)}`);
    const part = record(await partResponse.json());
    if (typeof part.etag !== "string" || !part.etag) throw new Error(`素材网关第 ${partNumber} 片没有返回 etag`);
    parts.push({ partNumber, etag: part.etag });
  }

  const completeResponse = await httpRequest(context, `${origin}/upload/complete`, {
    method: "POST",
    headers: { "X-Upload-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(parts),
    redirect: "error",
  }, signal, 2);
  if (!completeResponse.ok) throw new Error(`素材网关合并失败（HTTP ${completeResponse.status}）${await errorBody(completeResponse)}`);
  const complete = record(await completeResponse.json());
  if (typeof complete.url !== "string" || !complete.url) throw new Error("素材网关没有返回素材地址");
  return complete.url;
}

// ───────────────────────────── 媒体预处理 ─────────────────────────────

/**
 * 参考图预处理：先按上游边长限制等比缩放，再压到体积上限内。
 * 用宿主 media 工具（Bun.Image）完成，不依赖浏览器 DOM。远端 URL 交给上游自己拉，不做本地处理。
 */
async function fitImage(
  context: ProviderContext,
  input: MediaInput,
  options: { minSide?: number; maxSide?: number; capBytes?: number; forceJpeg?: boolean },
): Promise<MediaInput> {
  if (input.type === "url") return input;
  const minSide = options.minSide ?? 1;
  const maxSide = options.maxSide ?? 100000;
  let current: MediaInput = input;
  const info = await context.tool.media.inspectImage(current);
  const longest = Math.max(info.width, info.height);
  const shortest = Math.min(info.width, info.height);
  let scale = 1;
  if (longest > maxSide) scale = maxSide / longest;
  else if (shortest < minSide) scale = minSide / shortest;
  if (scale !== 1) {
    const width = Math.round(info.width * scale);
    const height = Math.round(info.height * scale);
    if (Math.min(width, height) < minSide || Math.max(width, height) > maxSide)
      throw new Error(`参考图 ${info.width}×${info.height} 缩放后仍超出 ${minSide}–${maxSide} px，宽高比过于极端，请先裁剪再试`);
    current = await context.tool.media.resizeImage(current, { width, height, format: "jpeg", quality: 92 });
  }
  // 万相不接受透明通道，即使尺寸合格也统一转 JPEG。
  if (options.forceJpeg && !/^jpe?g$/i.test(info.format))
    current = await context.tool.media.resizeImage(current, { width: info.width, height: info.height, format: "jpeg", quality: 92 });
  const capBytes = options.capBytes;
  if (capBytes === undefined || byteLength(current) <= capBytes) return current;
  // 逐级按「最长边」缩放，竖图/横图都能压下来。
  for (const step of [{ side: 2560, quality: 90 }, { side: 2048, quality: 80 }, { side: 1600, quality: 70 }, { side: 1280, quality: 60 }, { side: 1024, quality: 60 }]) {
    const meta = await context.tool.media.inspectImage(current);
    const ratio = Math.min(1, step.side / Math.max(meta.width, meta.height));
    current = await context.tool.media.resizeImage(current, {
      width: Math.max(1, Math.round(meta.width * ratio)),
      height: Math.max(1, Math.round(meta.height * ratio)),
      format: "jpeg",
      quality: step.quality,
    });
    if (byteLength(current) <= capBytes) return current;
  }
  throw new Error(`参考图压缩到 ${Math.floor(capBytes / 1024)} KB 以内仍不达标，请先裁剪或换更小的图片`);
}

/** 参考视频/音频只接受内联字节；体积受上游请求体上限约束。 */
function inlineMedia(input: MediaInput, label: string, capBytes: number): string {
  if (input.type === "url") return input.url;
  if (byteLength(input) > capBytes) throw new Error(`${label}超过 ${Math.floor(capBytes / MB)} MB，C2A 该接口只接受内联 Base64，请先压缩或改用公网 URL`);
  return dataUri(input);
}

// ─────────────────────────────── 1. Grok 图片 ───────────────────────────────

/** 比例换算成常见尺寸；网关普遍按 size 处理，不认 aspect_ratio 时靠这里兜底。 */
function imageSizeOf(request: ImageRequest): string | undefined {
  if (request.size) return request.size;
  const map: Record<string, string> = {
    "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536",
    "4:3": "1344x1008", "3:4": "1008x1344", "3:2": "1344x896", "2:3": "896x1344",
  };
  return request.ratio ? map[request.ratio] : undefined;
}

function imageFields(request: ImageRequest): Record<string, unknown> {
  // n 固定为 1（Grok Imagine 单次只出一张）；multipart 分支会统一 String() 化。
  const fields: Record<string, unknown> = { model: request.model, prompt: request.prompt, n: 1, response_format: "b64_json" };
  // ACT: grok-imagine 图片只认 1k/2k；其他尺寸写法交给上游按比例默认。
  const resolution = /^([12])k$/i.exec((request.size ?? "").trim());
  if (resolution) fields.resolution = `${resolution[1]}k`;
  if (request.ratio) fields.aspect_ratio = request.ratio;
  if (request.quality) fields.quality = request.quality;
  if (request.outputFormat) fields.output_format = request.outputFormat;
  return fields;
}

function parseImages(context: ProviderContext, payload: Record<string, unknown>): MediaAsset[] {
  const items = Array.isArray(payload.data) ? payload.data : [];
  if (!items.length) throw new Error(context.tool.errorMessage(payload) || "C2A 图片接口没有返回图片");
  const assets: MediaAsset[] = [];
  for (const raw of items) {
    const item = record(raw);
    if (item.respect_moderation === false) throw new Error("图片被上游内容策略拦截");
    if (typeof item.b64_json === "string" && item.b64_json) {
      // 上游可能返回 PNG 或 JPEG，按 base64 头判断，避免下游存错扩展名。
      const mimeType = item.b64_json.startsWith("iVBORw0KGgo") ? "image/png" : "image/jpeg";
      assets.push({ type: "base64", data: item.b64_json, mimeType, mediaType: "image" });
    } else if (typeof item.url === "string" && item.url) {
      assets.push({ type: "url", url: item.url, mediaType: "image" });
    }
  }
  if (!assets.length) throw new Error(context.tool.errorMessage(payload) || "C2A 图片接口没有返回图片");
  return assets;
}

/** 图生图走 multipart；部分网关只认旧的 JSON 图片对象写法，4xx 时回退一次。 */
async function editImage(context: ProviderContext, baseUrl: string, fields: Record<string, unknown>, images: MediaInput[], mask: MediaInput | undefined, signal: AbortSignal) {
  const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts: (string | Uint8Array<ArrayBuffer>)[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`);
  }
  const appendFile = (name: string, input: MediaInput, fallbackMime: string) => {
    const mime = input.mimeType || fallbackMime;
    const ext = mime.split("/")[1] || "jpg";
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`);
    parts.push(bytesOf(input));
    parts.push("\r\n");
  };
  // 多图用 image[]（OpenAI 规范），单图用 image。
  images.forEach(input => appendFile(images.length > 1 ? "image[]" : "image", input, "image/jpeg"));
  if (mask) appendFile("mask", mask, "image/png");
  parts.push(`--${boundary}--\r\n`);

  const response = await httpRequest(context, `${baseUrl}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKeyOf(context)}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: new Blob(parts),
    redirect: "error",
  }, signal, 2);
  if (response.ok) return parseImages(context, record(await response.json()));

  const status = response.status;
  const detail = await errorBody(response);
  if (![400, 404, 405, 415, 422].includes(status)) throw new Error(`请求失败（HTTP ${status}）${detail}`);

  const urls = images.map(dataUri);
  const legacy: Record<string, unknown> = { ...fields };
  if (urls.length === 1) legacy.image = { url: urls[0], type: "image_url" };
  else legacy.images = urls.map(url => ({ url, type: "image_url" }));
  if (mask) legacy.mask = { url: dataUri(mask), type: "image_url" };
  return parseImages(context, await post(context, `${baseUrl}/images/edits`, legacy, signal));
}

async function runImage(context: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  if (!apiKeyOf(context)) throw new Error("请填写 C2A API Key");
  // 单张图片最多等待 10 分钟。
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const baseUrl = gateway(context);

  // ACT: 实测 C2A 拒绝 2.5 MB 参考图，压到 512 KB 内最稳；URL 素材不下载不处理。
  const shrink = (input: MediaInput) => fitImage(context, input, { capBytes: 512 * 1024 });
  const images = await Promise.all((request.images ?? []).map(shrink));
  const mask = request.mask ? await shrink(request.mask) : undefined;

  if (!images.length) {
    const body: Record<string, unknown> = imageFields(request);
    const size = imageSizeOf(request);
    // grok-imagine 只按 1k/2k 与比例出图；已知尺寸写法才透传 size。
    if (size && !body.resolution && /^\d+x\d+$/.test(size)) body.size = size;
    return parseImages(context, await post(context, `${baseUrl}/images/generations`, body, signal));
  }
  return editImage(context, baseUrl, imageFields(request), images, mask, signal);
}

// ─────────────────────────────── 1b. GPT Image ───────────────────────────────
// ACT: 上游对 1K/2K/4K 档位字符串的支持不一致（sunburst 会忽略、flare 只认字符串），
// 统一换算成显式 WxH 最稳。4K 上限按模型实测：flare 直接 400，gpt-image-2 会被钳到 2880。

const GPT_IMAGE_SIDE: Record<string, number> = { "1k": 1024, "2k": 2048, "4k": 4096 };

const GPT_RATIO: Record<string, [number, number]> = {
  "1:1": [1, 1],
  "16:9": [16, 9],
  "9:16": [9, 16],
  "4:3": [4, 3],
  "3:4": [3, 4],
  "3:2": [3, 2],
  "2:3": [2, 3],
};

/** 档位 + 比例换算成显式像素；长边取档位边长，短边按比例对齐 16 的倍数。 */
function gptImageSize(request: ImageRequest): string {
  const raw = (request.size ?? "").trim();
  if (/^\d+x\d+$/i.test(raw)) return raw.toLowerCase();
  const side = GPT_IMAGE_SIDE[raw.toLowerCase()] ?? 1024;
  const [w, h] = GPT_RATIO[request.ratio ?? "1:1"] ?? [1, 1];
  const short = Math.max(16, Math.round((side * Math.min(w, h)) / Math.max(w, h) / 16) * 16);
  return w >= h ? `${side}x${short}` : `${short}x${side}`;
}

function gptImageFields(request: ImageRequest): Record<string, unknown> {
  const count = Number(request.n ?? 1);
  const fields: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    size: gptImageSize(request),
    n: Number.isFinite(count) && count > 0 ? count : 1,
  };
  if (request.quality) fields.quality = request.quality;
  if (request.outputFormat) fields.output_format = request.outputFormat;
  return fields;
}

async function runGptImage(context: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  if (!apiKeyOf(context)) throw new Error("请填写 C2A API Key");
  // 单张图片最多等待 10 分钟；实测 4K 单张要 40s 以上。
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const baseUrl = gateway(context);
  const fields = gptImageFields(request);
  const images = request.images ?? [];
  if (!images.length) return parseImages(context, await post(context, `${baseUrl}/images/generations`, fields, signal));
  // 图生图与 Grok 共用 multipart 通道；参考图同样压到 512 KB 内。
  const shrink = (input: MediaInput) => fitImage(context, input, { capBytes: 512 * 1024 });
  const shrunk = await Promise.all(images.map(shrink));
  const mask = request.mask ? await shrink(request.mask) : undefined;
  return editImage(context, baseUrl, fields, shrunk, mask, signal);
}

// ─────────────────────────────── 1c. MidJourney ───────────────────────────────
// ACT: MJ 只支持 JSON 同步调用，n 必须为 1，单次固定返回 4 张并按 4 张计费。
// size 会被上游忽略（实测 2K/4K 仍出 1024×1024），比例只能通过 prompt 的 --ar 后缀表达。

const MJ_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);

function mjPrompt(request: ImageRequest): string {
  const ratio = (request.ratio ?? "").trim();
  // 已经手写 --ar 的不重复追加。
  if (!MJ_RATIOS.has(ratio) || /--ar\s/i.test(request.prompt)) return request.prompt;
  return `${request.prompt} --ar ${ratio}`;
}

async function runMjImage(context: ProviderContext, request: ImageRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  if (!apiKeyOf(context)) throw new Error("请填写 C2A API Key");
  // 实测单次 40~90 秒，留足余量。
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const baseUrl = gateway(context);
  const body: Record<string, unknown> = { model: request.model, prompt: mjPrompt(request), n: 1 };
  // 图生图也走 /images/generations，参考图按 images[].image_url 提交（multipart 会被拒）。
  const images = request.images ?? [];
  if (images.length) {
    const shrink = (input: MediaInput) => fitImage(context, input, { capBytes: 512 * 1024 });
    const shrunk = await Promise.all(images.map(shrink));
    body.images = shrunk.map(input => ({ image_url: dataUri(input) }));
  }
  const assets = parseImages(context, record(await post(context, `${baseUrl}/images/generations`, body, signal)));
  // 上游一次固定出 4 张并按 4 张计费，这里按需求只交付第一张。
  return assets.slice(0, 1);
}

// ─────────────────────────────── 2. Grok 视频 ───────────────────────────────

const GROK_BASE64_BUDGET = 440 * 1024;

/**
 * 参考素材按「素材网关优先、内联降级」两级解析，与上游行为保持一致：
 *   · 全部换到公网 URL → 直接提交，参考视频也能走这条路；
 *   · 任一失败 → 全部回退内联：参考图压进 Base64 预算，参考视频没有降级方案，直接报错。
 */
async function resolveGrokAssets(
  context: ProviderContext,
  images: MediaInput[],
  videos: MediaInput[],
  signal: AbortSignal,
): Promise<{ urls: string[]; videoUrls: string[]; viaGateway: boolean }> {
  // 网关路径对参考图的要求更宽（20 MB / 边长由上游决定），先按 3 MB 归一化再上传。
  const normalized = await Promise.all(images.map(input => fitImage(context, input, { minSide: 256, maxSide: 5760, capBytes: 3 * MB })));

  const uploaded: string[] = [];
  let viaGateway = normalized.length + videos.length > 0;
  for (const input of [...normalized, ...videos]) {
    try {
      const url = await uploadAsset(context, input, signal);
      if (!url) { viaGateway = false; break; }
      uploaded.push(url);
    } catch {
      // 单张失败即整体降级，保证同一次请求里素材形态一致。
      viaGateway = false;
      break;
    }
  }

  if (viaGateway && uploaded.length === normalized.length + videos.length) {
    return { urls: uploaded.slice(0, normalized.length), videoUrls: uploaded.slice(normalized.length), viaGateway: true };
  }
  if (videos.length) {
    // Base64 通道的请求体上限（实测 ~675 KB）装不下参考视频，必须走网关。
    throw new Error("Grok 视频的参考视频必须经素材网关以公网链接提交；请检查「素材网关」配置或参考视频体积（上限 20 MB）");
  }
  // 参考图降级：总预算 440 KB 按图数分摊（×1.33 膨胀后约 585 KB 请求体）。
  const budget = normalized.length ? Math.floor(GROK_BASE64_BUDGET / normalized.length) : 0;
  const compressed = await Promise.all(normalized.map(input => fitImage(context, input, { minSide: 256, maxSide: 5760, capBytes: budget })));
  return { urls: compressed.map(dataUri), videoUrls: [], viaGateway: false };
}

// 实测上游枚举：adaptive 会被拒（"unknown variant `adaptive`"），只认这 9 个。
const GROK_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2"]);

async function generateGrokVideo(context: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  const apiKey = apiKeyOf(context);
  if (!apiKey) throw new Error("请填写 C2A API Key");
  const baseUrl = gateway(context);
  // 单条视频最多等待 10 分钟。
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(context.signal ? [context.signal] : [])]);

  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  const frames = [request.firstFrame, request.lastFrame].filter((item): item is MediaInput => Boolean(item));
  const images = request.images ?? [];
  const referenceMode = Array.isArray(request.mode) || videos.length > 0 || audios.length > 0 || images.length > 2 || (frames.length > 0 && images.length > 0);

  const sources = referenceMode ? images : [...frames, ...images];
  if (!referenceMode && sources.length > 2) throw new Error("Grok 视频首尾帧模式最多 2 张图；更多参考图请切换到全能参考模式");
  if (audios.length) throw new Error("Grok 视频暂不支持参考音频");

  const assets = await resolveGrokAssets(context, sources, videos, signal);

  // 实测 xAI 只认小写 480p/720p/1080p（1080P、4k 均 400）与 1–15 整数秒（20 秒被拒）。
  const duration = Math.round(Number(request.duration ?? 8));
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error("Grok 视频时长须为 1–15 秒的整数");
  const resolution = String(request.resolution ?? "720p").trim().toLowerCase();
  if (!["480p", "720p", "1080p"].includes(resolution)) throw new Error(`Grok 视频分辨率须为 480p / 720p / 1080p，收到 ${resolution}`);
  const ratio = String(request.ratio ?? "16:9").trim();
  if (!GROK_RATIOS.has(ratio)) throw new Error(`Grok 视频不支持输出比例 ${ratio}，可选 ${[...GROK_RATIOS].join(" / ")}`);
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    duration,
    resolution,
    aspect_ratio: ratio,
  };
  if (typeof request.generateAudio === "boolean") body.generate_audio = request.generateAudio;
  if (typeof request.watermark === "boolean") body.watermark = request.watermark;

  if (referenceMode) {
    if (assets.urls.length) body.reference_images = assets.urls.map(url => ({ url }));
  } else {
    if (assets.urls[0]) body.image = { url: assets.urls[0] };
    if (assets.urls[1]) body.last_frame = { url: assets.urls[1] };
  }
  if (assets.videoUrls.length) body.videos = assets.videoUrls.map(url => ({ url }));

  const created = await post(context, `${baseUrl}/videos`, body, signal);
  const task = created.data && typeof created.data === "object" && !Array.isArray(created.data) ? record(created.data) : created;
  const requestId = task.request_id ?? task.id ?? task.task_id;
  if (typeof requestId !== "string" || !requestId) throw new Error("C2A Grok 视频接口没有返回 request_id");

  const url = await pollUntil(signal, 5000, 600_000, async () => {
    const value = await get(context, `${baseUrl}/videos/${encodeURIComponent(requestId)}`, signal);
    const data = taskOf(value);
    if (taskFailed(data)) throw new Error(context.tool.errorMessage(value) || String(data.message ?? "") || "C2A Grok 视频生成失败");
    if (!taskDone(data)) return null;
    const video = data.video && typeof data.video === "object" && !Array.isArray(data.video) ? record(data.video) : undefined;
    const found = video?.url ?? data.url ?? data.video_url ?? data.result_url;
    if (typeof found !== "string" || !found) throw new Error("C2A Grok 视频任务完成但没有返回视频地址");
    return found;
  });
  return finalizeVideo(context, url, apiKey, signal);
}

// ─────────────────────────────── 3. MiniMax-H3 ───────────────────────────────

async function generateH3(context: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  const apiKey = apiKeyOf(context);
  if (!apiKey) throw new Error("请填写 C2A API Key");
  const baseUrl = gateway(context);
  // 单条视频最多等待 15 分钟。
  const signal = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(context.signal ? [context.signal] : [])]);

  const prompt = request.prompt ?? "";
  if (!prompt.trim() || Array.from(prompt).length > 7000) throw new Error("提示词须为 1–7000 个字符");

  // 实测上游：'seconds' must be an integer between 4 and 30。
  const seconds = Math.round(Number(request.duration ?? 8));
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) throw new Error("MiniMax-H3 时长须为 4–30 秒的整数");

  const ratio = request.ratio || "16:9";
  if (!["16:9", "9:16"].includes(ratio)) throw new Error("MiniMax-H3 只确认了 16:9 与 9:16，其他比例请使用 MiniMax-H3-Max");

  // 实测该模型只认 768p 与 2k 两档（按 size 提交为 1280×720 / 1792×1024），其余档位请改用 H3-Max。
  const tier = String(request.resolution ?? "768p").trim().toLowerCase();
  const resolution = ["1080p", "2k"].includes(tier) ? "2k" : ["720p", "768p"].includes(tier) ? "768p" : undefined;
  if (!resolution) throw new Error(`MiniMax-H3 只支持 768p 与 2k 两档，收到 ${tier}；其他档位请改用 MiniMax-H3-Max`);

  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  const sources = [request.firstFrame, request.lastFrame].filter((item): item is MediaInput => Boolean(item));
  const images = [...sources, ...(request.images ?? [])];
  if (images.length > 1 || videos.length || audios.length)
    throw new Error("MiniMax-H3 只支持单张参考图；首尾帧、参考视频和参考音频请改用 MiniMax-H3-Max");

  const image = images.length ? await fitImage(context, images[0], { minSide: 256, maxSide: 5760, capBytes: 3 * MB }) : undefined;

  const use2K = resolution === "2k";
  const size = use2K
    ? (ratio === "16:9" ? "1792x1024" : "1024x1792")
    : (ratio === "16:9" ? "1280x720" : "720x1280");

  const body: Record<string, unknown> = { model: request.model, prompt, seconds, size };
  if (image) body.input_reference = { image_url: dataUri(image) };

  const created = await post(context, `${baseUrl}/videos`, body, signal);
  const taskId = created.id ?? created.task_id;
  if (typeof taskId !== "string" || !taskId) throw new Error(readError(created) || "C2A H3 创建响应缺少任务 ID；请核对任务记录，不要重复提交");

  const result = await pollUntil<{ url?: string; content?: boolean }>(signal, 5000, 900_000, async () => {
    const task = taskOf(await get(context, `${baseUrl}/videos/${encodeURIComponent(taskId)}`, signal));
    if (taskFailed(task)) throw new Error(`任务 ${taskId}：${readError(task) || task.message || task.status}，请核对原任务，不要重复提交`);
    if (!taskDone(task)) return null;
    const content = task.content && typeof task.content === "object" && !Array.isArray(task.content) ? record(task.content) : undefined;
    for (const candidate of [content?.url, task.video_url, task.url]) {
      if (typeof candidate === "string" && candidate) return { url: candidate };
    }
    // 多数账号只在 /content 上给成片，交给下一步下载。
    return { content: true };
  });

  if (result.url) return finalizeVideo(context, result.url, apiKey, signal);

  const response = await httpRequest(context, `${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "error",
  }, signal, 4);
  if (!response.ok) throw new Error(`视频下载失败（HTTP ${response.status}）`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (!data.byteLength) throw new Error("C2A H3 视频下载内容为空");
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return [{ type: "binary", data, mimeType: contentType.startsWith("video/") ? contentType : "video/mp4", mediaType: "video" }];
}

// ──────────────────────────── 4. MiniMax-H3-Max ────────────────────────────

// 实测：480P / 768P / 1080P / 2K / 4K 可用；720P 被上游拒绝（"当前分辨率 720p 不支持"），归到最近的 768P。
const H3MAX_RESOLUTIONS: Record<string, string> = {
  "480p": "480P", "720p": "768P", "768p": "768P", "1080p": "1080P", "2k": "2K", "4k": "4K",
};

async function generateH3Max(context: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  const apiKey = apiKeyOf(context);
  if (!apiKey) throw new Error("请填写 C2A API Key");
  const baseUrl = gateway(context);
  // 单条视频最多等待 15 分钟。
  const signal = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(context.signal ? [context.signal] : [])]);

  const prompt = request.prompt ?? "";
  if (!prompt.trim() || Array.from(prompt).length > 7000) throw new Error("提示词须为 1–7000 个字符");

  const seconds = Math.round(Number(request.duration ?? 8));
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 15) throw new Error("MiniMax-H3-Max 时长须为 5–15 秒的整数");

  const ratio = String(request.ratio || "16:9");
  if (!["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error(`MiniMax-H3-Max 不支持输出比例 ${ratio}`);

  // 实测：480P / 768P / 1080P / 2K / 4K 可用，720P 上游明确拒绝，按最近的 768P 计。
  const resolutionKey = String(request.resolution ?? "768p").toLowerCase();
  const resolution = H3MAX_RESOLUTIONS[resolutionKey];
  if (!resolution) throw new Error(`MiniMax-H3-Max 分辨率须为 480p / 768p / 1080p / 2k / 4k，收到 ${resolutionKey}`);

  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  const frames = [request.firstFrame, request.lastFrame].filter((item): item is MediaInput => Boolean(item));
  const images = request.images ?? [];
  const referenceMode = Array.isArray(request.mode) || images.length > 2 || videos.length > 0 || audios.length > 0;

  // 实测视频协议不认 audios / audio（VIDEO_PARAMETER_UNKNOWN），H3-Max 在本网关没有参考音频。
  if (audios.length) throw new Error("MiniMax-H3-Max 不支持参考音频");
  if (images.length > 9 || videos.length > 3 || images.length + videos.length > 12)
    throw new Error("MiniMax-H3-Max 参考图最多 9 张、视频最多 3 段，混合素材合计最多 12 个");
  if (!images.length && !videos.length && ratio === "adaptive")
    throw new Error("纯文生视频必须选择具体比例，不能使用自适应");

  const ordered = referenceMode ? images : [...frames, ...images].slice(0, 2);
  const prepared = await Promise.all(ordered.map(input => fitImage(context, input, { minSide: 256, maxSide: 5760, capBytes: 3 * MB })));

  // 实测统一视频接口只接受 images[{url,role}] 与 videos[{url}]；
  // content[]、size、aigc_watermark 都会被拒（VIDEO_PARAMETER_*），比例字段是 aspect_ratio。
  const body: Record<string, unknown> = {
    model: request.model,
    prompt,
    duration: seconds,
    resolution,
    aspect_ratio: prepared.length && !referenceMode ? "adaptive" : ratio,
  };
  if (prepared.length)
    body.images = prepared.map((input, index) => ({
      url: dataUri(input),
      role: referenceMode ? "reference_image" : index === 0 ? "first_frame" : "last_frame",
    }));
  if (videos.length) {
    const refs: Record<string, unknown>[] = [];
    for (const video of videos) refs.push({ url: (await uploadAsset(context, video, signal)) ?? inlineMedia(video, "参考视频", 50 * MB), role: "reference_video" });
    body.videos = refs;
  }
  if (typeof request.generateAudio === "boolean") body.generate_audio = request.generateAudio;
  if (typeof request.watermark === "boolean") body.watermark = request.watermark;
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * MB) throw new Error("请求 JSON（含 Base64）不能超过 64 MB，请减少素材或先压缩");

  const created = await post(context, `${baseUrl}/videos`, body, signal);
  const taskId = created.id ?? created.task_id;
  if (typeof taskId !== "string" || !taskId) throw new Error(readError(created) || "C2A H3-Max 创建响应缺少任务 ID；请核对任务记录，不要重复提交");

  await pollUntil(signal, 5000, 900_000, async () => {
    const task = taskOf(await get(context, `${baseUrl}/videos/${encodeURIComponent(taskId)}`, signal));
    if (taskFailed(task)) throw new Error(`任务 ${taskId}：${readError(task) || task.message || task.status}，请核对原任务，不要重复提交`);
    return taskDone(task) ? true : null;
  });
  // 实测 H3-Max 的查询响应从不回视频地址，成片只挂在 /content 上。
  return finalizeVideo(context, `${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, apiKey, signal);
}

// ────────────────────────────── 6. Seedance 2.x ─────────────────────────────
// 火山方舟原生协议：https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api

async function generateSeedance(context: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  const apiKey = apiKeyOf(context);
  if (!apiKey) throw new Error("请填写 C2A API Key");
  const baseUrl = gatewayRoot(context);
  const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(context.signal ? [context.signal] : [])]);
  const model = request.model.toLowerCase();
  const is25 = model === "doubao-seedance-2-5-260628";
  const isStandard = model === "doubao-seedance-2-0-260128";
  const isMiniOrFast = model === "doubao-seedance-2-0-fast-260128" || model === "doubao-seedance-2-0-mini-260615";
  const prompt = request.prompt?.trim() ?? "";
  if (!prompt) throw new Error("提示词不能为空");

  const duration = Number(request.duration ?? 5);
  if (!Number.isInteger(duration) || (duration !== -1 && (duration < 4 || duration > (is25 ? 30 : 15))))
    throw new Error(`Seedance ${is25 ? "2.5" : "2.0"} 时长须为 4–${is25 ? 30 : 15} 秒的整数，或 -1 由模型决定`);

  const resolution = String(request.resolution ?? "720p").toLowerCase();
  const resolutions = isStandard ? ["480p", "720p", "1080p", "4k"] : isMiniOrFast ? ["480p", "720p"] : ["480p", "720p", "1080p"];
  if (!resolutions.includes(resolution)) throw new Error(`该 Seedance 模型不支持 ${resolution} 分辨率`);

  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  const images = request.images ?? [];
  const hasFrames = Boolean(request.firstFrame || request.lastFrame);
  const frameMode = !Array.isArray(request.mode) && request.mode !== "text"
    && (hasFrames || request.mode !== undefined || (images.length > 0 && images.length <= 2 && !videos.length && !audios.length));
  if (request.mode === "text" && (hasFrames || images.length || videos.length || audios.length))
    throw new Error("Seedance 文生视频模式不能携带参考素材");
  if (hasFrames && (!frameMode || images.length)) throw new Error("Seedance 首尾帧不能与全模态参考混用");
  if (request.lastFrame && !request.firstFrame) throw new Error("Seedance 不支持仅尾帧输入，请提供首帧");
  if (frameMode && (videos.length || audios.length || images.length > 2))
    throw new Error("Seedance 首尾帧模式只支持 1–2 张图片，不能混用参考视频或音频");
  const frames = hasFrames
    ? [request.firstFrame, request.lastFrame].filter((item): item is MediaInput => Boolean(item))
    : images;
  if (frameMode && (!frames.length || (request.mode === "startEndRequired" && frames.length !== 2)
    || (request.mode === "singleImage" && frames.length !== 1))) throw new Error("Seedance 输入图片数量与所选首尾帧模式不符");
  let ratio = request.ratio || "adaptive";
  if (!["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error(`Seedance 不支持输出比例 ${ratio}`);
  // 2.5 首帧/首尾帧比例由首帧决定；节点的通用比例不能原样传给上游。
  if (is25 && frameMode) ratio = "adaptive";
  const content: Record<string, unknown>[] = [{ type: "text", text: prompt }];
  if (frameMode) {
    for (const [index, frame] of frames.entries()) {
      const prepared = await fitImage(context, frame, { minSide: 300, maxSide: 6000, capBytes: 20 * MB });
      content.push({
        type: "image_url",
        image_url: { url: dataUri(prepared) },
        role: index === 0 ? "first_frame" : "last_frame",
      });
    }
  } else {
    if (images.length > (is25 ? 30 : 9) || videos.length > (is25 ? 10 : 3) || audios.length > (is25 ? 10 : 3))
      throw new Error(`Seedance ${is25 ? "2.5" : "2.0"} 参考素材数量超出模型限制`);
    if (!is25 && audios.length && !images.length && !videos.length)
      throw new Error("Seedance 2.0 参考音频必须搭配至少一张参考图或一段参考视频");
    for (const image of images) {
      const prepared = await fitImage(context, image, { minSide: 300, maxSide: 6000, capBytes: 20 * MB });
      content.push({ type: "image_url", image_url: { url: dataUri(prepared) }, role: "reference_image" });
    }
    for (const video of videos) {
      const url = await uploadAsset(context, video, signal);
      if (!url) throw new Error("Seedance 参考视频必须是公网 URL，或配置素材网关上传本地视频");
      content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    }
    for (const audio of audios) content.push({ type: "audio_url", audio_url: { url: inlineMedia(audio, "参考音频", 15 * MB) }, role: "reference_audio" });
  }

  const body: Record<string, unknown> = {
    model: request.model,
    content,
    resolution,
    duration,
    ratio,
  };
  if (typeof request.generateAudio === "boolean") body.generate_audio = request.generateAudio;
  if (typeof request.watermark === "boolean") body.watermark = request.watermark;
  const payload = JSON.stringify(body);
  if (new TextEncoder().encode(payload).byteLength > 64 * MB) throw new Error("Seedance 请求体不能超过 64 MB");

  const endpoint = `${baseUrl}/api/v3/contents/generations/tasks`;
  // 创建请求不重试：连接中断时上游仍可能已创建并计费。
  const response = await httpRequest(context, endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: payload,
    redirect: "error",
  }, signal, 1);
  if (!response.ok) throw new Error(`Seedance 创建任务失败（HTTP ${response.status}）${await errorBody(response)}`);
  const created = taskOf(record(await response.json()));
  const taskId = created.id ?? created.task_id;
  if (typeof taskId !== "string" || !taskId) throw new Error(readError(created) || "C2A Seedance 创建响应缺少任务 ID；请核对任务记录，不要重复提交");

  const url = await pollUntil(signal, 5000, 30 * 60_000, async () => {
    const task = taskOf(await get(context, `${endpoint}/${encodeURIComponent(taskId)}`, signal));
    const status = String(task.status ?? "").toLowerCase();
    if (taskFailed(task))
      throw new Error(`Seedance 任务 ${taskId} ${status}：${readError(task) || task.message || task.code || "生成失败"}；请核对原任务，不要重复提交`);
    if (status !== "succeeded") return null;
    const output = task.content && typeof task.content === "object" && !Array.isArray(task.content) ? record(task.content) : {};
    const videoUrl = output.video_url ?? task.video_url;
    if (typeof videoUrl !== "string" || !videoUrl) throw new Error(`Seedance 任务 ${taskId} 已完成但没有视频地址`);
    return videoUrl;
  });
  return finalizeVideo(context, url, apiKey, signal);
}

// ────────────────────────────── 5. 万相 3.0 ──────────────────────────────

const WAN_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const WAN_RESOLUTIONS: Record<string, string> = { "480p": "480P", "720p": "720P", "1080p": "1080P" };
// 实测中转网关不拦 body，但上游限制单条 data URI ≤ 20 MiB，按 14 MiB 拦留出 base64 膨胀余量。
const WAN_ITEM_CAP = 14 * MB;

async function generateWan3(context: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {
  context.signal?.throwIfAborted();
  const apiKey = apiKeyOf(context);
  if (!apiKey) throw new Error("请填写 C2A API Key");
  const root = gatewayRoot(context);
  // 单条视频最多等待 15 分钟。
  const signal = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(context.signal ? [context.signal] : [])]);

  const prompt = request.prompt ?? "";
  if (!prompt.trim()) throw new Error("提示词不能为空");
  if (Array.from(prompt).length > 20000) throw new Error("万相 3.0 提示词不能超过 20000 个字符");

  const resolution = WAN_RESOLUTIONS[String(request.resolution ?? "720p").toLowerCase()];
  if (!resolution) throw new Error("万相 3.0 只支持 480p / 720p / 1080p；未配置档位会按兜底价计费，已阻止提交");

  const requested = Math.round(Number(request.duration ?? 6));
  if (!Number.isInteger(requested) || requested < 2 || requested > 30) throw new Error("万相 3.0 时长须为 2–30 秒的整数");

  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  const frames = [request.firstFrame, request.lastFrame].filter((item): item is MediaInput => Boolean(item));
  const images = request.images ?? [];
  // 首尾帧与参考素材互斥（上游硬规则）：0–2 张图且无视频音频时才走首尾帧。
  const frameMode = !Array.isArray(request.mode) && images.length <= 2 && !videos.length && !audios.length;
  if (!frameMode && images.length > 10) throw new Error("万相 3.0 参考图片最多 10 张");
  if (videos.length > 5) throw new Error("万相 3.0 参考视频最多 5 段");
  if (audios.length > 5) throw new Error("万相 3.0 参考音频最多 5 段");

  const ordered = frameMode ? [...frames, ...images].slice(0, 2) : images;
  // 万相不接受透明通道，参考图统一转 JPEG 并压到 3 MB。
  const prepared = await Promise.all(ordered.map(input => fitImage(context, input, { minSide: 240, maxSide: 8000, capBytes: 3 * MB, forceJpeg: true })));

  const media: Record<string, unknown>[] = [];
  if (frameMode) {
    if (prepared[0]) media.push({ type: "first_frame", url: dataUri(prepared[0]) });
    if (prepared[1]) media.push({ type: "last_frame", url: dataUri(prepared[1]) });
  } else {
    for (const input of prepared) media.push({ type: "reference_image", url: dataUri(input) });
    for (const video of videos) media.push({ type: "reference_video", url: inlineMedia(video, "参考视频", WAN_ITEM_CAP) });
    for (const audio of audios) media.push({ type: "reference_audio", url: inlineMedia(audio, "参考音频", WAN_ITEM_CAP) });
  }

  // 首尾帧比例由图片决定；参考模式用请求比例，缺省 adaptive。
  const ratio = frameMode ? (media.length ? "adaptive" : request.ratio || "16:9") : request.ratio || "adaptive";
  if (!WAN_RATIOS.includes(ratio)) throw new Error(`万相 3.0 不支持输出比例 ${ratio}`);

  const parameters: Record<string, unknown> = { resolution, ratio, duration: requested };
  if (typeof request.generateAudio === "boolean") parameters.audio = request.generateAudio;
  if (typeof request.watermark === "boolean") parameters.watermark = request.watermark;

  const body = { model: request.model, input: media.length ? { prompt, media } : { prompt }, parameters };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * MB) throw new Error("请求 JSON（含 Base64）不能超过 64 MB，请减少素材或先压缩");

  const created = await post(context, `${root}/api/v1/services/aigc/video-generation/video-synthesis`, body, signal);
  const output = created.output && typeof created.output === "object" && !Array.isArray(created.output) ? record(created.output) : {};
  const taskId = output.task_id;
  if (typeof taskId !== "string" || !taskId) {
    const failure = created.error && typeof created.error === "object" ? record(created.error) : created;
    throw new Error(readError(failure) || "万相 3.0 创建响应缺少 task_id；请核对 C2A 任务记录，不要重复提交");
  }

  const url = await pollUntil(signal, 10000, 900_000, async () => {
    const task = record(await get(context, `${root}/api/v1/tasks/${encodeURIComponent(taskId)}`, signal));
    const result = task.output && typeof task.output === "object" && !Array.isArray(task.output) ? record(task.output) : {};
    const status = String(result.task_status ?? "").toUpperCase();
    if (status === "SUCCEEDED") {
      if (typeof result.video_url !== "string" || !result.video_url) throw new Error(`任务 ${taskId} 已完成但没有返回视频地址，请核对 C2A 任务记录`);
      return result.video_url;
    }
    if (["FAILED", "CANCELED", "UNKNOWN"].includes(status)) {
      const detail = readError(result) || result.message || result.code || (status === "UNKNOWN" ? "任务不存在或查询已过期（task_id 有效期 24 小时）" : status);
      throw new Error(`任务 ${taskId} ${status}：${detail}；请核对原任务，不要重复提交`);
    }
    return null;
  });
  return finalizeVideo(context, url, apiKey, signal);
}

// ─────────────────────────────── 估价 ───────────────────────────────
// 单价取自 C2A 定价页。视频按秒、图片按张；参考图附加费为 USD/张，仅 H3 系列有。

type C2aRate = {
  /** 档位单价；视频用 480p/720p…，图片用 1k/2k/4k 小写作键。 */
  rates: Record<string, number>;
  /** 未匹配档位时的兜底单价；缺省表示上游未公布兜底价，此时不报价。 */
  fallback?: number;
  /** 超出 5 张参考图的附加费，USD/张。 */
  extraImageUsd?: number;
  /** 上游单次固定产出并计费的张数，缺省按请求张数算。 */
  fixedCount?: number;
  /** 追加到报价提示里的说明。 */
  note?: string;
  unit: "秒" | "张";
};

const C2A_RATES: Record<string, C2aRate> = {
  "grok-imagine-image-2.0": { rates: { "1k": 0.081, "2k": 0.099, "4k": 0.15 }, unit: "张" },
  "grok-imagine-image-quality": { rates: { "1k": 0.081, "2k": 0.099, "4k": 0.15 }, unit: "张" },
  // GPT Image 定价页 1K/2K/4K 同价 0.12 CNY/张，故兜底也用同一价，像素写法也能报价。
  "gpt-image-2": { rates: { "1k": 0.12, "2k": 0.12, "4k": 0.12 }, fallback: 0.12, unit: "张" },
  "gpt-image-2.5": { rates: { "1k": 0.12, "2k": 0.12, "4k": 0.12 }, fallback: 0.12, unit: "张" },
  "gpt-image-2.5-flare": { rates: { "1k": 0.12, "2k": 0.12 }, fallback: 0.12, unit: "张" },
  "gpt-image-2.5-sunburst": { rates: { "1k": 0.12, "2k": 0.12, "4k": 0.12 }, fallback: 0.12, unit: "张" },
  // MJ 单次固定出 4 张、每张单独计费，报价按 4 张算（实际只交付第一张）。
  "mj-v7": { rates: { "1k": 0.408, "2k": 0.4896, "4k": 0.5712 }, fallback: 0.408, fixedCount: 4, note: "MidJourney 单次固定出 4 张并按 4 张计费，此处只返回第一张", unit: "张" },
  "mj-v8.1": { rates: { "1k": 0.408, "2k": 0.4896, "4k": 0.5712 }, fallback: 0.408, fixedCount: 4, note: "MidJourney 单次固定出 4 张并按 4 张计费，此处只返回第一张", unit: "张" },
  "mj-v8.2": { rates: { "1k": 0.408, "2k": 0.4896, "4k": 0.5712 }, fallback: 0.408, fixedCount: 4, note: "MidJourney 单次固定出 4 张并按 4 张计费，此处只返回第一张", unit: "张" },
  "grok-imagine-video-1.5": { rates: { "480p": 0.15, "720p": 0.198, "1080p": 0.3 }, unit: "秒" },
  "grok-imagine-video-1.5-preview": { rates: { "480p": 0.15, "720p": 0.198, "1080p": 0.3 }, unit: "秒" },
  "minimax-h3": { rates: { "768p": 0.18, "2k": 0.18 }, fallback: 0.204, extraImageUsd: 0.15, unit: "秒" },
  "minimax-h3-max": {
    rates: { "480p": 0.3366, "768p": 0.51, "1080p": 0.663, "2k": 0.816, "4k": 0.9792 },
    fallback: 0.816,
    extraImageUsd: 0.17,
    unit: "秒",
  },
  "wan3.0-video": { rates: { "480p": 0.2088, "720p": 0.4176, "1080p": 0.8352 }, fallback: 4.8, unit: "秒" },
  "wan3.0-video-prime": { rates: { "480p": 0.3672, "720p": 0.7344, "1080p": 1.47 }, fallback: 1.47, unit: "秒" },
};

/**
 * 报价 = 档位单价 × 数量。视频数量为秒数，图片为张数。
 * 超出 5 张参考图的附加费以 USD 单列，不与元混算。
 */
function quoteMedia(model: string, tier: unknown, quantity: number, imageCount: number): ProviderPrice | null {
  const table = C2A_RATES[model.toLowerCase()];
  if (!table) return null;
  // 上游固定产出张数优先于请求张数（MJ 一次出 4 张）。
  const count = table.fixedCount ?? quantity;
  if (!Number.isFinite(count) || count <= 0) return null;
  const key = typeof tier === "string" ? tier.trim().toLowerCase() : "";
  const matched = key !== "" && table.rates[key] !== undefined;
  const rate = matched ? table.rates[key] : table.fallback;
  // 上游未公布兜底价时，未知档位不报价，避免给出错误金额。
  if (rate === undefined) return null;
  const parts = [
    matched
      ? `${key} 档 ${rate} CNY/${table.unit} × ${count} ${table.unit}`
      : key
        ? `未匹配到 ${key} 档位，按兜底价 ${rate} CNY/${table.unit} × ${count} ${table.unit}`
        : `未指定档位，按兜底价 ${rate} CNY/${table.unit} × ${count} ${table.unit}`,
  ];
  if (table.extraImageUsd !== undefined)
    parts.push(
      imageCount > 5
        ? `另有参考图附加费：超出 5 张的 ${imageCount - 5} 张 × $${table.extraImageUsd.toFixed(5)} USD`
        : "前 5 张参考图免费",
    );
  if (table.note) parts.push(table.note);
  parts.push("以实际扣费为准");
  return { price: `¥${(rate * count).toFixed(2)}`, tips: parts.join("；") };
}

// ─────────────────────────────── 导出 ───────────────────────────────

export default {
  id: "c2a",
  label: "C2A 中转",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI4IiBmaWxsPSIjMjU2M0VCIi8+PHBhdGggZD0iTTEwIDIyVjEwaDUuNWEzLjUgMy41IDAgMCAxIDAgN0gxMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIuNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PGNpcmNsZSBjeD0iMjIiIGN5PSIyMiIgcj0iMi42IiBmaWxsPSIjZmZmIi8+PC9zdmc+",
  version,
  readme: `## C2A 中转（Codex2API）
把 C2A 网关的 Grok、MiniMax、万相、Seedance 模型接入 Toonflow 的图片与视频节点；文本模型请在「文本模型 → 添加自定义供应商」里另行配置。

- 网关地址默认 \`https://www.codex2api.com/v1\`，填不填末尾的 \`/v1\` 都能识别。
- **Grok 图片**：\`/images/generations\`；带参考图走 \`/images/edits\`（multipart，单图 \`image\`、多图 \`image[]\`）。
- **GPT Image**：同样 \`/images/generations\` 与 \`/images/edits\`，但走 OpenAI 原生参数（显式 \`size\` 像素与 \`quality\`）；1K/2K/4K 会换算成 WxH，\`gpt-image-2.5-flare\` 实测 4K 被上游拒绝，只开放到 2K。
- **MidJourney**：只支持 JSON 同步调用（multipart 会被拒），\`n\` 必须为 1，参考图按 \`images[].image_url\` 提交；\`size\` 会被上游忽略，比例只能写进 prompt 的 \`--ar\`，所以只开放 1K 档。单次固定返回 4 张并按 4 张计费，此处只交付第一张。
- **Grok 视频**：\`/videos\` 建任务、\`/videos/{request_id}\` 轮询、\`/videos/{request_id}/content\` 下载；1–15 秒，480p/720p/1080p，比例为 xAI 枚举（1:1、16:9、9:16、4:3、3:4、3:2、2:3、21:9、5:2）。参考素材优先经素材网关换成公网 URL，网关不可用时参考图降级内联 Base64，参考视频无法降级会直接报错。
- **MiniMax-H3**：\`/videos\` 建任务并轮询，\`size\` 提交 1280×720 / 1792×1024；4–30 秒，只支持 768p 与 2k 两档、16:9 / 9:16 与单张参考图。
- **MiniMax-H3-Max**：同样 \`/videos\`，参考素材按 \`images[{url,role}]\` / \`videos[{url}]\` 提交；5–15 秒，480p/768p/1080p/2k/4k（720p 上游拒绝），不接参考音频，成片只挂在 \`/content\` 上。
- **万相 3.0**：DashScope 原生 \`/api/v1/services/aigc/video-generation/video-synthesis\`，首尾帧与参考素材互斥。
- **Seedance 2.0 / Fast / Mini / 2.5**：火山方舟原生 \`/api/v3/contents/generations/tasks\`，使用 \`content[]\` + role 并轮询任务。支持文生视频、参考图生视频、视频生视频、音频生视频，以及图片/视频/音频混合参考；首帧/首尾帧与全模态参考互斥，2.5 首帧比例自动跟随图片。2.5 支持纯音频输入，2.0 系列的音频必须搭配图片或视频。本地参考视频复用素材网关转为公网 URL（当前网关单文件上限 20 MB），音频按公网 URL 或 Base64 发送。按实际 Token 用量结算，暂不提供按秒报价。

**素材网关**填 C2A 官方素材网关（默认 \`https://assets.antest.cc.cd\`），用同一枚 C2A API Key 鉴权：本地素材经三段式上传换成 24 小时公网签名 URL，绕开上游对 base64 请求体的限制。留空则只用内联 Base64。

参考素材会先在服务端按上游的边长与体积限制缩放压缩，无需手工处理。可用模型取决于 API Key 绑定的分组权限，无权限时请在编辑供应商里删掉对应模型。`,
  rules,
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
      id: "MJ-v7",
      label: "MJ v7",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "MJ-v8.1",
      label: "MJ v8.1",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "MJ-v8.2",
      label: "MJ v8.2",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "doubao-seedance-2-0-260128",
      label: "Seedance 2.0",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "4k"] }],
    },
    {
      id: "doubao-seedance-2-0-fast-260128",
      label: "Seedance 2.0 Fast",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      id: "doubao-seedance-2-0-mini-260615",
      label: "Seedance 2.0 Mini",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
    },
    {
      id: "doubao-seedance-2-5-260628",
      label: "Seedance 2.5",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
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
      id: "MiniMax-H3",
      label: "MiniMax H3",
      type: "video",
      mode: ["text", "singleImage"],
      durationResolutionMap: [
        { duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768p", "2k"] },
        { duration: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["768p", "2k"] },
      ],
    },
    {
      id: "MiniMax-H3-Max",
      label: "MiniMax H3 Max",
      type: "video",
      // 本网关 H3-Max 不接参考音频：视频协议对 audios / audio 直接报 VIDEO_PARAMETER_UNKNOWN。
      mode: ["text", "startFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3"]],
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "768p", "1080p", "2k", "4k"] }],
    },
    {
      id: "wan3.0-video",
      label: "万相 3.0 Video",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      id: "wan3.0-video-prime",
      label: "万相 3.0 Video Prime",
      type: "video",
      mode: ["text", "singleImage", "startEndRequired", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
    },
  ],
  async getPrice(request: ProviderPriceRequest): Promise<ProviderPrice | null> {
    const images = request.images?.length ?? 0;
    if (request.type === "image") {
      // 图片按张计价；n 为本次生成张数，缺省 1 张。
      const count = Number(request.n ?? 1);
      return quoteMedia(String(request.model), request.size, Number.isFinite(count) && count > 0 ? count : 1, images);
    }
    if (request.type === "video") return quoteMedia(String(request.model), request.resolution, Number(request.duration), images);
    return null;
  },
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const model = String(request.model);
    // GPT Image 走 OpenAI 原生参数（显式 size / quality），与 Grok 的 resolution 写法不同。
    if (/^gpt-image/i.test(model)) return runGptImage(this, request);
    // MJ 只认 JSON 同步调用，比例要写进 prompt 的 --ar。
    if (/^mj-/i.test(model)) return runMjImage(this, request);
    return runImage(this, request);
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const model = String(request.model);
    // H3-Max 必须先于 H3 判断，否则会被前缀匹配吃掉。
    if (/^minimax-h3-max$/i.test(model)) return generateH3Max(this, request);
    if (/^minimax-h3$/i.test(model)) return generateH3(this, request);
    if (/^wan3/i.test(model)) return generateWan3(this, request);
    if (/^doubao-seedance-2-[05]-/i.test(model)) return generateSeedance(this, request);
    if (/^grok-imagine-video/i.test(model)) return generateGrokVideo(this, request);
    throw new Error(`C2A 未适配该模型：${model}`);
  },
} satisfies ProviderDefinition<typeof rules>;
