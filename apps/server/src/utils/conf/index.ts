import conf from "conf";
import { mkdirSync, readdirSync, realpathSync } from "@toonflow/file";
import { resolve } from "node:path";
import type { RemoteTeam } from "@/utils/teams";
import type { A2aSettings } from "@/agent/a2a/settings";
import type { desktopUpdateAttempt } from "@/types/desktop";
import type { MobileLinkConfig } from "@/utils/mobileLink";
import { normalizeNodeMenu, serializeNodeMenu } from "@/lib/nodeMenu";
import type { SavedMcpServer } from "@toonflow/mcp/client";

const c2a = {
  id: "c2a",
  label: "C2A",
  version: "1.0.0",
  apiUrl: "https://www.codex2api.com/v1",
  protocol: "openai-completions",
  models: [
    { id: "grok-4.7", label: "grok-4.7" },
    { id: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash" },
  ],
};
const autoInstallProviders = [c2a];
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
mkdirSync(dataDirectory, { recursive: true });
const configDirectory = realpathSync(dataDirectory);
process.env.TOONFLOW_DATA_DIR = configDirectory;

const config = new conf<{ settings: Record<string, unknown>; disabledSkills: string[]; mcpServers: SavedMcpServer[]; mcpBundles: Record<string, string>; toolConfigs: Record<string, Record<string, unknown>>; nodeConfigs: Record<string, Record<string, unknown>>; extConfigs: Record<string, Record<string, unknown>>; remoteConnections: Record<string, RemoteTeam>; a2a: A2aSettings; desktopUpdateAttempt: desktopUpdateAttempt; mobileLink: MobileLinkConfig }>({
  cwd: configDirectory,
  configName: "settings",
  configFileMode: 0o600,
  watch: true,
});

export function removeLegacySettings(settings: Record<string, unknown>) {
  let changed = false;
  // ACT: 只清理已废弃字段，保留其他设置和插件配置。
  for (const [record, key] of [[settings, "developerConfirmed"], [settings.general, "systemPrompt"], [settings.stores, "toonflow.developer"]] as const) {
    if (record && typeof record === "object" && !Array.isArray(record) && Object.hasOwn(record, key)) {
      Reflect.deleteProperty(record, key);
      changed = true;
    }
  }
  return changed;
}

export function cleanNodeMenuSettings(settings: Record<string, unknown>) {
  const general = settings.general;
  if (!general || typeof general !== "object" || Array.isArray(general) || !Object.hasOwn(general, "nodeMenu")) return false;
  const record = general as Record<string, unknown>;
  const installedTypes = new Set<string>();
  try {
    // ACT: 仅扫描已安装文件名；禁用节点保留配置，菜单清理与同步存盘间不插入异步等待。
    for (const file of readdirSync(resolve(configDirectory, "nodes"), { withFileTypes: true })) {
      if (file.isFile() && /^[a-z][a-zA-Z0-9]*\.umd\.js$/.test(file.name)) installedTypes.add(`remote-${file.name.slice(0, -7)}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const nodeMenu = serializeNodeMenu(normalizeNodeMenu(record.nodeMenu), installedTypes);
  if (!nodeMenu.length) {
    delete record.nodeMenu;
    return true;
  }
  if (JSON.stringify(record.nodeMenu) === JSON.stringify(nodeMenu)) return false;
  record.nodeMenu = nodeMenu;
  return true;
}

const settings = config.get("settings", {});
if (removeLegacySettings(settings)) config.set("settings", settings);

const defaultProvider = ({ id, label, version, apiUrl, protocol, models }: typeof c2a) =>
  ({ id, label, version, apiUrl, protocol, models, apiKey: "" });
const providers = settings.customProviders;
if (!Array.isArray(providers)) {
  config.set("settings.customProviders", autoInstallProviders.map(defaultProvider));
} else {
  const withoutTfRouter = providers.filter(item => typeof item?.id !== "string" || item.id.toLowerCase() !== "tfrouter");
  const hasC2a = withoutTfRouter.some(item => item?.id === c2a.id);
  if (withoutTfRouter.length !== providers.length || !hasC2a) {
    config.set("settings.customProviders", hasC2a ? withoutTfRouter : [...withoutTfRouter, defaultProvider(c2a)]);
  }
}

export default config;
