import type { NodeTypesObject } from "@vue-flow/core";
import { shallowReactive, type Component } from "vue";

type NodeComponent = Exclude<NodeTypesObject[string], string>;

const components = shallowReactive(new Map<string, NodeComponent>());
const requests = new Map<string, Promise<NodeComponent>>();
// 超时只释放重试槽位，不 reject；脚本晚到仍会回填组件，避免超时误杀后无法恢复。
// 弱机器上大画布首次加载可能接近 20s，阈值取宽，宁可多等也不要误报错误。
const loadTimeout = 20000;

export function getNodeIcon(type?: string): Component | undefined {
  if (!type?.startsWith("remote-")) return;
  return (components.get(type.slice(7)) as { icon?: Component } | undefined)?.icon;
}

export function loadNodeComponent(name: string, url: string, force = false): Promise<NodeComponent> {
  const pending = requests.get(name);
  if (pending) return pending;
  const nodeWindow = window as typeof window & { toonflowNodes?: NodeTypesObject };
  const cached = components.get(name) ?? (Object.hasOwn(nodeWindow.toonflowNodes ?? {}, name) ? nodeWindow.toonflowNodes?.[name] : undefined);
  if (!force && cached && (typeof cached === "object" || typeof cached === "function")) {
    components.set(name, cached);
    return Promise.resolve(cached);
  }
  components.delete(name);
  // 同名节点只加载一份脚本，所有画布共享进行中的重载，避免互相清除全局导出。
  const request = (async () => {
    const scriptUrl = force ? `${url}${url.includes("?") ? "&" : "?"}reload=${crypto.randomUUID()}` : url;
    const response = await fetch(scriptUrl);
    if (!response.ok) throw new Error(`节点脚本加载失败（HTTP ${response.status}）`);
    const code = await response.text();
    if (code.includes("toonflowTiptapHost")) await import("@/lib/tiptapHost");
    return new Promise<NodeComponent>((resolve, reject) => {
      delete nodeWindow.toonflowNodes?.[name];
      const script = document.createElement("script");
      script.src = scriptUrl;
      script.onload = () => {
        script.remove();
        const component = nodeWindow.toonflowNodes?.[name];
        if (!Object.hasOwn(nodeWindow.toonflowNodes ?? {}, name) || !component || (typeof component !== "object" && typeof component !== "function")) {
          reject(new Error(`节点脚本未导出 ${name} 组件`));
          return;
        }
        resolve(component);
      };
      script.onerror = () => {
        script.remove();
        delete nodeWindow.toonflowNodes?.[name];
        reject(new Error("节点脚本加载失败"));
      };
      document.head.append(script);
    });
  })().then((component) => {
    components.set(name, component);
    return component;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tracked = request.finally(() => {
    clearTimeout(timer);
    if (requests.get(name) === tracked) requests.delete(name);
  });
  requests.set(name, tracked);
  timer = setTimeout(() => {
    if (requests.get(name) === tracked) requests.delete(name);
  }, loadTimeout);
  return tracked;
}
