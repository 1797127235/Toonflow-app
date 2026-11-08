import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type StdioConfig = { command: string; args: string[] };
// 项目依赖的类型定义（0.85.1）未声明 MCP 注册接口，运行时已支持；升级依赖后可删。
type McpApi = ExtensionAPI & {
  registerMcpServer(name: string, config: Record<string, unknown>): void;
  getMcpServers(): { name: string }[];
};

// 由 Toonflow 通过环境变量注入 Laywork MCP 的启动方式；pi 不读任何配置文件。
export default function (pi: ExtensionAPI) {
  const raw = process.env.TOONFLOW_MCP_STDIO;
  if (!raw) return;
  const stdio = JSON.parse(raw) as StdioConfig;
  const api = pi as McpApi;
  api.registerMcpServer("laywork", {
    command: stdio.command,
    args: stdio.args,
    description: "Laywork 画布、工作区文件与媒体生成工具",
    // 默认折叠为代码 API，避免 47 个工具 schema 常驻上下文；可用环境变量临时展开排查。
    exposure: process.env.TOONFLOW_MCP_EXPOSURE === "direct" ? "direct" : "codemode",
  });
  if (process.env.TOONFLOW_PI_BRIDGE_DEBUG === "1") {
    setTimeout(() => {
      const servers = api.getMcpServers().map(server => server.name);
      const tools = pi.getAllTools().map(tool => tool.name).filter(name => name.includes("laywork"));
      console.error(`[laywork-bridge] ${JSON.stringify({ servers, tools })}`);
    }, 2500);
  }
}