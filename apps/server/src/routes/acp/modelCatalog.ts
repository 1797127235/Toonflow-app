import { Router } from "express";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "@toonflow/file";
import { success } from "@/lib/responseFormat";

// 模型目录读 pi的配置文件，
// 避免为了列模型去 spawn pi-acp 建会话（冷启动 7 秒）。格式由 pi 维护，解析失败返回 null 由前端回退。
type Catalog = { providers?: Record<string, { models?: { id: string; name?: string }[] }> };
type Settings = { defaultProvider?: string; defaultModel?: string };

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export default Router().get("/", async (_req, res) => {
  const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const [catalog, settings] = await Promise.all([readJson<Catalog>(join(root, "models.json")), readJson<Settings>(join(root, "settings.json"))]);
  const options = Object.entries(catalog?.providers ?? {}).flatMap(([providerId, provider]) =>
    (provider.models ?? []).map(model => ({ value: `${providerId}/${model.id}`, name: `${providerId}/${model.name ?? model.id}` })),
  );
  if (!options.length) return res.status(200).send(success({ models: null }));
  const currentValue = settings?.defaultProvider && settings?.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : options[0].value;
  res.status(200).send(success({ models: { type: "select", id: "model", name: "Model", currentValue, options } }));
});