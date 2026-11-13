import { formatSkillsForPrompt, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentContextSegment } from "@/agent/runtime/types";
import { createAgentResources } from "@/agent/runtime/resources";
import { createAgentTools } from "@/agent/tools";
import { createMemoryTool } from "@/agent/tools/memory";
import { isMemoryEnabled } from "@/utils/personalization";

/**
 * 上下文用量估算。只用在前端展示和压缩提示，不参与实际请求，也不要求精确：
 * 这里按字符数估算，和模型 tokenizer 会有偏差，但足够判断“快满了”。
 *
 * 单独成模块是因为读取历史会话时也要算用量，而那时并没有活动的 SDK 会话，
 * 只能按同一套资源构建逻辑重新推导系统提示、技能和工具定义的大小。
 */

type ContextTool = Pick<ToolDefinition, "name" | "description" | "parameters">;

// ACT: 与 pi-coding-agent 的 estimateTokens 相同，按字符数 ÷ 4 向上取整，不是模型 tokenizer。
function estimateText(text: string) {
  return Math.ceil(text.length / 4);
}

// 复刻 SDK 注入 AGENTS.md 的包装格式，估算值才能接近模型真正看到的文本。
function projectContext(files: { path: string; content: string }[]) {
  if (!files.length) return "";
  const instructions = files.map(file => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`).join("");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${instructions}</project_context>\n`;
}

// MCP 工具的描述和 schema 往往比内置工具大一个量级，单独分段，
// 用户才能看出上下文是被工具定义还是被对话占满的。
function isMcpTool(tool: ContextTool) {
  return tool.name.startsWith("mcp_") || tool.description.startsWith("[MCP:");
}

function estimateTools(tools: ContextTool[]) {
  return tools.reduce((total, tool) => total + estimateText(JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? {},
  })), 0);
}

/**
 * 把静态上下文拆成可展示的分段。顺序与模型实际看到的一致：
 * 系统提示 → 规则 → 技能目录 → 工具定义 → MCP，最后才是运行时追加的对话。
 */
export function contextSegments(input: {
  cwd: string;
  systemPrompt: string;
  appendSystemPrompt: readonly string[];
  agentsFiles: { path: string; content: string }[];
  skills: Skill[];
  tools: ContextTool[];
}): AgentContextSegment[] {
  const readTool = input.tools.some(tool => tool.name === "read") ? "read" : input.tools.some(tool => tool.name === "bash") ? "bash" : undefined;
  const rules = [
    input.appendSystemPrompt.length ? `\n\n${input.appendSystemPrompt.join("\n\n")}` : "",
    projectContext(input.agentsFiles),
  ].join("");
  const defined: AgentContextSegment[] = [
    { id: "system", label: "系统提示", tokens: estimateText(`${input.systemPrompt}\nCurrent working directory: ${input.cwd.replace(/\\/g, "/")}`) },
    { id: "rules", label: "规则", tokens: estimateText(rules) },
    { id: "skills", label: "技能目录", tokens: readTool ? estimateText(formatSkillsForPrompt(input.skills, readTool)) : 0 },
    { id: "tools", label: "工具定义", tokens: estimateTools(input.tools.filter(tool => !isMcpTool(tool))) },
    { id: "mcp", label: "MCP", tokens: estimateTools(input.tools.filter(isMcpTool)) },
  ];
  return defined.filter(segment => segment.tokens > 0);
}

/**
 * 为“没有活动会话”的历史读取重建静态分段。这里必须走和 run 相同的
 * createAgentTools / createAgentResources，否则展示的用量会和真实请求对不上。
 */
export async function loadContextPrefix(cwd: string, instructions = "") {
  const tools = await createAgentTools(cwd, undefined, undefined, false);
  if (isMemoryEnabled()) {
    const memoryTool = createMemoryTool();
    if (!tools.some(tool => tool.name === memoryTool.name)) tools.push(memoryTool);
  }
  const resources = await createAgentResources(cwd, tools, undefined, instructions);
  return contextSegments({
    cwd,
    systemPrompt: resources.resourceLoader.getSystemPrompt() ?? "",
    appendSystemPrompt: resources.resourceLoader.getAppendSystemPrompt(),
    agentsFiles: resources.resourceLoader.getAgentsFiles().agentsFiles,
    skills: resources.resourceLoader.getSkills().skills,
    tools,
  });
}
