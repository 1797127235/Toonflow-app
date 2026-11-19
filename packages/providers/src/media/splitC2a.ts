import { readFileSync, writeFileSync } from "node:fs";

const c2a = readFileSync(new URL("./c2a.ts", import.meta.url), "utf8");
const yzh = readFileSync(new URL("./c2aYzh.ts", import.meta.url), "utf8");

function between(text: string, start: string, end: string) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`找不到区间：${start} → ${end}`);
  return text.slice(from, to);
}

const helpers = between(c2a, "const MB = 1024 * 1024;", "// ────────────────────── 3. 统一视频接口");
let specFns = between(c2a, "function videoSpecOf", "// ─────────────────────────────── 估价").replaceAll("VideoSpec", "C2aVideoSpec");
specFns = specFns.replace(
  `function videoSpecOf(model: string): C2aVideoSpec | undefined {
  const id = Object.keys(VIDEO_SPECS).find(key => key.toLowerCase() === model.toLowerCase());
  return id ? VIDEO_SPECS[id] : undefined;
}`,
  `function videoSpecOf(specs: Record<string, C2aVideoSpec>, model: string): C2aVideoSpec | undefined {
  const id = Object.keys(specs).find(key => key.toLowerCase() === model.toLowerCase());
  return id ? specs[id] : undefined;
}`,
);
specFns = specFns.replace(
  "async function generateVideoById(context: ProviderContext, request: VideoRequest): Promise<MediaAsset[]> {",
  "async function generateVideoById(context: ProviderContext, request: VideoRequest, specs: Record<string, C2aVideoSpec>): Promise<MediaAsset[]> {",
);
specFns = specFns.replace(
  "const spec = VIDEO_SPECS[String(request.model)] ?? videoSpecOf(String(request.model));",
  "const spec = specs[String(request.model)] ?? videoSpecOf(specs, String(request.model));",
);

let quote = between(c2a, "/** 报价 = 档位单价", "// ─────────────────────────────── 导出");
quote = quote.replace(
  `function quoteMedia(model: string, tier: unknown, quantity: number, imageCount = 0): ProviderPrice | null {
  const table = C2A_RATES[model]
    ?? C2A_RATES[Object.keys(C2A_RATES).find(key => key.toLowerCase() === model.toLowerCase()) ?? ""];`,
  `function quoteMedia(rates: Record<string, C2aRate>, model: string, tier: unknown, quantity: number, imageCount = 0): ProviderPrice | null {
  const table = rates[model]
    ?? rates[Object.keys(rates).find(key => key.toLowerCase() === model.toLowerCase()) ?? ""];`,
);

const ratesBody = objectBody(c2a, "const C2A_RATES");
const sharedCut = ratesBody.indexOf("// Seedance 实际按输出 Token");
if (sharedCut < 0) throw new Error("缺少共享价卡分界");
const sharedRates = ratesBody.slice(0, sharedCut).trim().replace(/,\s*$/, "");
const rules = between(c2a, "const rules = ", "as const;").trim();

function objectBody(text: string, marker: string) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(marker);
  const brace = text.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}") {
      depth--;
      if (depth === 0) return text.slice(brace + 1, index).trim();
    }
  }
  throw new Error(`对象未闭合：${marker}`);
}

function channelRates(text: string) {
  const body = objectBody(text, "const C2A_RATES");
  const cut = body.indexOf("// Seedance 实际按输出 Token");
  if (cut < 0) throw new Error("缺少分组价卡");
  return body.slice(cut).replace(/,\s*\/\/ ── yzh 分组：按次或按秒 ──\s*$/, "").trim();
}

function channelSpecs(text: string) {
  return objectBody(text, "const VIDEO_SPECS")
    .replace(/,\s*\/\/ ── yzh 分组（haishu-视频模型-yzh渠道-1\.2x）：取自分组页模型定价 ──\s*$/, "")
    .trim();
}

function readmeOf(text: string) {
  const start = text.indexOf("readme: `");
  const end = text.indexOf("`,", start);
  return text.slice(start + "readme: `".length, end);
}

function modelsOf(text: string) {
  const start = text.indexOf("models: [");
  const end = text.indexOf("],\n  async getPrice", start);
  return text.slice(start + "models: ".length, end + 1);
}

function field(text: string, name: string) {
  const exported = text.slice(text.indexOf("export default"));
  const match = new RegExp(`${name}: ("(?:\\\\.|[^"\\\\])*")`).exec(exported);
  if (!match) throw new Error(name);
  return match[1];
}

function catalog(text: string) {
  return `import { createC2aProvider, type C2aRate, type C2aVideoSpec } from "./c2aProtocol";

const version = "2.9.1";

const rules = ${rules} as const;

const videoSpecs: Record<string, C2aVideoSpec> = {
  ${channelSpecs(text)}
};

const rates: Record<string, C2aRate> = {
  ${channelRates(text)}
};

export default createC2aProvider({
  id: ${field(text, "id")},
  label: ${field(text, "label")},
  icon: ${field(text, "icon")},
  version,
  readme: \`${readmeOf(text)}\`,
  rules,
  videoSpecs,
  rates,
  // 宿主只解析这份字面量。图片与 Grok 模型两个分组相同，分组视频模型须与 videoSpecs 一致。
  models: ${modelsOf(text)},
});
`;
}

const protocol = `/**
 * C2A（Codex2API）图片与视频协议。
 * km / yzh 两个分组只在模型、价卡和说明上不同，请求、上传、轮询和续跑走这里。
 * 供应商文件在沙箱中求值，不能导入其它模块；宿主只放行这一份协议源码。
 *
 * 上游协议按模型 ID 分流：
 *   1. Grok 图片      POST /v1/images/generations、/v1/images/edits(multipart)
 *   1b.GPT Image      POST /v1/images/generations、/v1/images/edits(multipart)，OpenAI 原生参数
 *   2. Grok 视频      POST /v1/videos → GET /v1/videos/{id}(/content)，xAI 参数
 *   3. 其余视频       POST /v1/videos → GET /v1/videos/{id}(/content)，OpenAI Videos 统一入口
 *                     （Seedance / 即梦 / Kling / MiniMax-H3 / Vidu / 万相，差异只在分组的 videoSpecs）
 *
 * Grok 视频的参考素材有两条路径：
 *   · 素材网关（对象存储）：内容寻址三段式上传，换 24 小时公网签名 URL，参考视频必须走这条。
 *   · 内联 Base64 降级：网关不可用时参考图压进请求体预算；参考视频无法降级，直接报错。
 */

${helpers}
export type C2aVideoSpec = {
  label: string;
  resolutions: string[];
  /** 允许的时长区间（秒，闭区间）。 */
  duration: [number, number];
  images: number;
  videos: number;
  audios: number;
  /** 上游只接受这一种比例。 */
  fixedRatio?: string;
};

const VIDEO_RATIOS = new Set(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

${specFns}
export type C2aRate = {
  /** 档位单价；视频用 480p/720p…，图片用 1k/2k/4k 小写作键。 */
  rates: Record<string, number>;
  /** 未匹配档位时的兜底单价；缺省表示上游未公布兜底价，此时不报价。 */
  fallback?: number;
  /** 追加到报价提示里的说明。 */
  note?: string;
  /** 超出 5 张参考图的附加费，元/张。 */
  extraImage?: number;
  unit: "秒" | "次" | "张";
};

// 图片与 Grok 视频两个分组同价，写在协议里。分组视频价卡由各自供应商传入。
const sharedRates: Record<string, C2aRate> = {${sharedRates}
};

${quote}
export function createC2aProvider<const TRules extends readonly ProviderFormRule[]>(catalog: {
  id: string;
  label: string;
  icon: string;
  version: string;
  readme: string;
  rules: TRules;
  videoSpecs: Record<string, C2aVideoSpec>;
  rates: Record<string, C2aRate>;
  models: ProviderModel[];
}) {
  const rates = { ...sharedRates, ...catalog.rates };
  return {
    id: catalog.id,
    label: catalog.label,
    icon: catalog.icon,
    version: catalog.version,
    readme: catalog.readme,
    rules: catalog.rules,
    models: catalog.models,
    async getPrice(request: ProviderPriceRequest): Promise<ProviderPrice | null> {
      if (request.type === "image") {
        const count = Number(request.n ?? 1);
        return quoteMedia(rates, String(request.model), request.size, Number.isFinite(count) && count > 0 ? count : 1);
      }
      if (request.type === "video")
        return quoteMedia(rates, String(request.model), request.resolution, Number(request.duration), request.images?.length ?? 0);
      return null;
    },
    async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
      if (/^gpt-image/i.test(String(request.model))) return runGptImage(this, request);
      return runImage(this, request);
    },
    async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
      if (/^grok-imagine-video/i.test(String(request.model))) return generateGrokVideo(this, request);
      return generateVideoById(this, request, catalog.videoSpecs);
    },
    async resume(remoteTaskId: string): Promise<MediaAsset[]> {
      const apiKey = apiKeyOf(this);
      if (!apiKey) throw new Error("请填写 C2A API Key");
      const signal = this.signal ?? AbortSignal.timeout(30 * 60_000);
      return pollVideoTask(this, \`\${gateway(this)}/videos\`, remoteTaskId, apiKey, signal, Infinity, "C2A");
    },
  } satisfies ProviderDefinition<TRules>;
}
`;

writeFileSync(new URL("./c2aProtocol.ts", import.meta.url), protocol);
writeFileSync(new URL("./c2a.ts", import.meta.url), catalog(c2a));
writeFileSync(new URL("./c2aYzh.ts", import.meta.url), catalog(yzh));
