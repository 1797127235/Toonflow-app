import { t } from "@/lib/i18n";
import { readFile } from "@toonflow/file";
import { buildSystemPrompt, type PromptTool } from "@/agent/runtime/prompt";
import { loadAgentSkills } from "@/agent/skills";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isMemoryEnabled, readDocument } from "@/utils/personalization";
import conf from "@/utils/conf";
import { getRuntimePlatform } from "@/lib/platform";

export type AgentContext = {
  systemPrompt: string;
  agents?: { path: string; content: string };
  skillSet: ReturnType<typeof loadAgentSkills>;
  globalAgents: string;
  memory: string;
};

/** 内置 Agent 与 ACP 外部引擎共用的上下文：设置项、工作区 AGENTS.md、技能清单与全局资料。 */
export async function createAgentContext(cwd: string, tools: readonly PromptTool[]): Promise<AgentContext> {
  const savedPrompt = conf.get("settings", {}).agentSystemPrompt;
  const systemPrompt = typeof savedPrompt === "string" ? savedPrompt : undefined;
  const { path: agentsPath } = await resolveWorkspacePath(cwd, "AGENTS.md");
  const agentsContent = await readFile(agentsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw new Error(t`读取工作区 AGENTS.md 失败：${error.message}`, { cause: error });
  });
  const [globalAgents, memory] = await Promise.all([readDocument("agents"), isMemoryEnabled() ? readDocument("memory") : { content: "" }]);
  const skillSet = loadAgentSkills(cwd);
  return {
    systemPrompt: buildSystemPrompt({ systemPrompt, tools, skills: skillSet.skills, platform: getRuntimePlatform().os }),
    agents: agentsContent.trim() ? { path: agentsPath, content: agentsContent.replace(/^\uFEFF/, "") } : undefined,
    skillSet,
    globalAgents: globalAgents.content,
    memory: memory.content,
  };
}

/** 全局协作规范与长期记忆，作为系统提示词的附加段。 */
export function globalSections({ globalAgents, memory }: Pick<AgentContext, "globalAgents" | "memory">) {
  return [
    globalAgents.trim() ? `## 全局协作规范（AGENTS.md）\n${globalAgents}` : "",
    memory.trim() ? `## 全局长期记忆\n以下是跨对话保存的偏好与事实，使用前核对适用项目，以用户本轮要求为准。\n<global_memory>\n${memory}\n</global_memory>` : "",
  ].filter(Boolean);
}
