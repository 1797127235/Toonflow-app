import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentContext, globalSections } from "@/agent/context";

/**
 * 构建 SDK 会话所需资源：agentDir、settings、resourceLoader。
 *
 * 关闭扩展、自动技能发现、提示模板和主题，是因为这些能力会读写 SDK 的全局状态；
 * 多个子 Agent 并发时，全局状态会互相覆盖。这里改为每个会话独立 loader，
 * 只注入当前工作区的 AGENTS.md 和按需读取的技能集。
 *
 * skillOperator 启用时把技能标成 disableModelInvocation：模型必须先通过操作器
 * 查询/读取，不能凭目录里的描述直接开跑。
 */
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
