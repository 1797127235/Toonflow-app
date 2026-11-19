import { assetSources, localSourceId, type SourceConfig } from "./sources";

export type AssetPathTarget =
  | { kind: "local"; path: string }
  | { kind: "remote"; source: SourceConfig; innerPath: string };

export type SourceValidation = { available: SourceConfig[]; disabled: { id: string; reason: string }[] };

const allowedPorts = new Set(["", "80", "443"]);
const placeholderPattern = /\{([^{}]*)\}/g;
const placeholderName = /^(?:item\.)?[\p{L}\p{N}_]+$/u;

let sourceValidation: SourceValidation | null = null;

/** 对外不区分「配置拒绝」与「没有这个文件」，避免把白名单内容回显给调用方 */
function assetNotFound() {
  return Object.assign(new Error("找不到这个素材文件"), { status: 404 });
}

/**
 * 只有第一段命中已注册的源 id 才走远程，其余整串回落本地。
 * 本地源同时接受 `@local/…` 前缀：前端树里所有源共用同一种路径写法，
 * 不带前缀的旧路径继续按本地解析，既有调用点不用改。
 */
export function parseAssetPath(path: string): AssetPathTarget {
  if (!path.startsWith("@")) return { kind: "local", path };
  const separator = path.indexOf("/");
  const id = separator === -1 ? path.slice(1) : path.slice(1, separator);
  const rest = separator === -1 ? "" : path.slice(separator + 1);
  if (id === localSourceId) return { kind: "local", path: rest };
  const source = sourceById(id);
  if (!source) return { kind: "local", path };
  return { kind: "remote", source, innerPath: rest };
}

function templateIssue(template: string) {
  for (const match of template.matchAll(placeholderPattern)) {
    if (!placeholderName.test(match[1]!)) return `模板占位符不合法：${match[0]}`;
  }
  if (/[{}]/.test(template.replace(placeholderPattern, ""))) return `模板括号不配对：${template}`;
  return null;
}

function sourceIssue(source: SourceConfig) {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(source.id)) return `源 id 不合格式：${source.id}`;
  if (!source.label) return "缺少显示名称";
  if (source.mode === "directory") {
    if (source.files.length > 0) return "本地目录源不能配置图片模板";
    if (source.writable !== true) return "本地目录源必须可写";
    return null;
  }
  if (source.mode !== "index") return `未知的源模式：${String(source.mode)}`;
  if (!source.baseUrl) return "缺少 baseUrl";
  if (!source.indexes?.length) return "缺少 indexes";
  for (const index of source.indexes) {
    if (!index.label?.trim()) return `索引缺少来源名称：${index.path}`;
    if (!index.path?.startsWith("/")) return `索引路径必须以 / 开头：${index.path}`;
  }
  if (!source.allowedHosts?.length) return "缺少 allowedHosts，远程源必须限制取图域名";
  if (source.files.length === 0) return "缺少图片模板";
  let baseIssue: string | null = null;
  try { new URL(source.baseUrl); }
  catch { baseIssue = `baseUrl 不是合法地址：${source.baseUrl}`; }
  if (baseIssue) return baseIssue;
  for (const file of source.files) {
    if (!file.url) return "图片模板缺少地址";
    if (file.role !== "thumb" && !file.name) return `图片模板缺少文件名：${file.url}`;
    const nameIssue = file.name ? templateIssue(file.name) : null;
    if (nameIssue) return nameIssue;
    const urlIssue = templateIssue(file.url);
    if (urlIssue) return urlIssue;
  }
  return null;
}

/** 静态校验只在进程内算一次；单个源配错只隔离该源，不影响其余源。 */
export function validateSources(): SourceValidation {
  if (sourceValidation) return sourceValidation;
  const available: SourceConfig[] = [];
  const disabled: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const source of assetSources) {
    const reason = seen.has(source.id) ? `源 id 重复：${source.id}` : sourceIssue(source);
    seen.add(source.id);
    if (reason) {
      disabled.push({ id: source.id, reason });
      console.warn(`素材源 ${source.id} 已跳过：${reason}`);
    }
    else available.push(source);
  }
  sourceValidation = { available, disabled };
  return sourceValidation;
}

export function sourceById(id: string) {
  return validateSources().available.find(source => source.id === id);
}

/**
 * 唯一的安全边界：索引内容是外部输入，绝对 URL 尤其可能被上游投毒。
 * 只允许 http(s) + 白名单 host，拒绝 userinfo、非标准端口与相对路径越界。
 */
export function resolveRemoteUrl(source: SourceConfig, value: string) {
  const raw = value.trim();
  if (!raw) throw assetNotFound();
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  let url: URL;
  try { url = new URL(raw, source.baseUrl); }
  catch { throw assetNotFound(); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw assetNotFound();
  if (url.username || url.password) throw assetNotFound();
  if (!allowedPorts.has(url.port)) throw assetNotFound();
  if (!source.allowedHosts?.includes(url.hostname)) throw assetNotFound();
  if (!absolute && /(^|\/)\.\.(\/|$)/.test(raw)) throw assetNotFound();
  return url.href;
}