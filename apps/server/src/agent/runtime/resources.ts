import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentContext, globalSections } from "@/agent/context";

export async function createAgentResources(cwd: string, tools: ToolDefinition[], settings = SettingsManager.inMemory(), instructions = "") {
  const agentDir = join(cwd, ".agent");
  const context = await createAgentContext(cwd, tools);
  const sdkSkills = tools.some(tool => tool.name === "skillOperator")
    ? { ...context.skillSet, skills: context.skillSet.skills.map(skill => ({ ...skill, disableModelInvocation: true })) }
    : context.skillSet;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // ACT: 仅自动载入工作区根目录的 AGENTS.md，关闭 SDK 向父目录和其他指令文件的自动扫描。
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: context.agents ? [context.agents] : [] }),
    // ACT: 技能正文按需读取；每个会话独立创建 loader，避免 SDK 的会话绑定互相覆盖。
    skillsOverride: () => sdkSkills,
    systemPrompt: "",
    systemPromptOverride: () => [context.systemPrompt, instructions].filter(Boolean).join("\n\n"),
    appendSystemPrompt: globalSections(context),
  });
  await resourceLoader.reload();
  return { agentDir, settingsManager: settings, resourceLoader };
}
