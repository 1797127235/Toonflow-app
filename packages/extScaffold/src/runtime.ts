// 扩展的「运行时契约」：类型 + 一个校验函数。
// 这个文件会被扩展源码和扩展产物间接引用，运行在浏览器里，
// 所以只能 import 类型和 form-create 的类型，绝不能引 vite / node:fs / zod。
import type { Component } from "vue";
import type { Rule } from "@form-create/element-ui";

// 扩展能接管两种东西：
// - file：工作区里的某个文件（文本编辑器、图片/视频预览）
// - canvasNode：画布上的某个节点（换一种方式展示节点内容）
// directory + path 就是宿主当前项目的相对路径，扩展不需要自己拼绝对路径。
export type ExtResource =
  | { kind: "file"; directory: string; path: string; label: string }
  | { kind: "canvasNode"; directory: string; path: string; nodeId: string; label: string };

// 宿主替扩展做的文件操作。全部是工作区内的相对路径。
// 为什么是宿主提供而不是让扩展直接调接口：工作区校验、编码识别、保存队列、
// 外部修改冲突检测都在宿主一处实现，扩展各自实现必然不一致。
export interface ExtFiles {
  list(path?: string, signal?: AbortSignal): Promise<{ directory: string; entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  read(path: string): Promise<ArrayBuffer>;
  readText(path: string, maxBytes?: number, signal?: AbortSignal): Promise<string>;
  readJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T>;
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean, signal?: AbortSignal): Promise<void>;
  writeJson(path: string, data: unknown, exclusive?: boolean): Promise<void>;
  // 二进制预览用：拿到可直接给 img/video 的 URL，用完必须 release()，由宿主回收。
  acquireUrl(path: string, mimeType?: string): { url: Promise<string>; release(): void };
  rename(path: string, target: string): Promise<void>;
  copy(path: string, target: string): Promise<void>;
  reveal(path: string): Promise<void>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
}

// 宿主传给扩展组件的唯一接口。组件是纯展示，状态和持久化都在宿主手里。
// 这样同一个文件可以在多个分屏里共用一份正文和一个保存队列，不会互相覆盖。
export interface ExtContext {
  resource: ExtResource;
  files: ExtFiles;
  text: string;
  loading: boolean;
  error: string;
  dirty: boolean;
  active: boolean;
  config: Record<string, unknown>;
  saveConfig: (config: Record<string, unknown>) => Promise<void>;
  // 文本编辑一律走 updateText，宿主负责自动保存；不要让扩展自己 files.write 正文。
  updateText: (text: string) => void;
  flushSave: () => Promise<void>;
  writeClipboardText: (text: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  location?: { line: number; column: number; query: string; revision: number };
  // 仅画布节点扩展有：把原节点界面挂到传入元素，返回释放函数。
  mountNode?: (element: HTMLElement) => Promise<() => void>;
}

// 扩展的对外声明。它同时是两样东西：
// 1. src/index.ts 里的运行时导出（宿主加载 UMD 后拿到）；
// 2. 构建时写进产物头部注释的元数据（宿主没执行代码前就能列出扩展、按后缀匹配）。
export interface ExtDefinition {
  id: string;
  displayName: string;
  icon?: string;
  configRules?: Rule[];
  extensions: string[];
  resourceKind: ExtResource["kind"];
  text?: boolean;
  load: () => Promise<{ default: Component }>;
}

// 声明校验。放在这里是因为它在两个时机都会跑：
// - 构建扩展时（createExtConfig 先调一次），坏声明在打包阶段就报错；
// - 宿主加载 UMD 时，能拦住手工改坏的产物。
// 宁可安装/构建失败，也不要用户点开文件才崩在界面里。
export function defineExt(definition: ExtDefinition): ExtDefinition {
  if (typeof definition.id !== "string" || definition.id.length > 96 || !/^ext-[a-z][a-zA-Z0-9]*$/.test(definition.id)) throw new Error(`扩展 ID 必须为 ext- 加小驼峰名称，最多 96 个字符：${definition.id}`);
  if (typeof definition.displayName !== "string" || !definition.displayName.trim()) throw new Error("扩展显示名不能为空");
  // 图标只允许图片 data URL 或 http(s) 地址：它会被直接放进 <img src>，
  // 放开 javascript:、file: 之类等于把扩展市场变成注入入口。
  if (definition.icon !== undefined) {
    const icon = definition.icon;
    if (typeof icon !== "string" || (icon && !/^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif)(?:;[^,]*)?,/i.test(icon)
      && !(URL.canParse(icon) && ["http:", "https:"].includes(new URL(icon).protocol)))) throw new Error("扩展图标必须是 HTTP、HTTPS 或图片 data URL");
  }
  if (definition.configRules !== undefined && (!Array.isArray(definition.configRules) || definition.configRules.length > 100)) throw new Error("扩展配置规则必须为最多 100 项的表单规则数组");
  if (definition.resourceKind !== "file" && definition.resourceKind !== "canvasNode") throw new Error("扩展资源类型无效");
  if (definition.text !== undefined && typeof definition.text !== "boolean") throw new Error("扩展文本标记必须为布尔值");
  if (!Array.isArray(definition.extensions) || definition.extensions.some(extension => typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension))) throw new Error("文件后缀必须是不带点的小写字母或数字");
  if (definition.resourceKind === "file" && !definition.extensions.length) throw new Error("文件扩展至少需要一个后缀");
  if (new Set(definition.extensions).size !== definition.extensions.length) throw new Error("文件后缀不能重复");
  if (typeof definition.load !== "function") throw new Error("扩展必须提供组件加载函数");
  return definition;
}
