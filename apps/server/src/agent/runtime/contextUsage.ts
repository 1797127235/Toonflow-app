import { formatSkillsForPrompt, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentContextSegment } from "@/agent/runtime/types";
import { createAgentResources } from "@/agent/runtime/resources";
import { createAgentTools } from "@/agent/tools";
import { createMemoryTool } from "@/agent/tools/memory";
import { isMemoryEnabled } from "@/utils/personalization";

type ContextTool = Pick<ToolDefinition, "name" | "description" | "parameters">;

// ACT: 与 pi-coding-agent 的 estimateTokens 相同，按字符数 ÷ 4 向上取整，不是模型 tokenizer。
function estimateText(text: string) {
  return Math.ceil(text.length / 4);
}

function projectContext(files: { path: string; content: string }[]) {
  if (!files.length) return "";
  const instructions = files.map(file => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`).join("");
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${instructions}</project_context>\n`;
}

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
