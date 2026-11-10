import { mkdir, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { createAgentContext, globalSections } from "@/agent/context";
import type { PromptTool } from "@/agent/runtime/prompt";
import conf from "@/utils/conf";

// 引擎自带的文件与命令工具，提示词由 Laywork 统一说明；业务工具以 codemode 形式按需发现，不常驻清单。
const promptTools: PromptTool[] = [
  ...["read", "write", "edit", "bash"].map(name => ({ name, description: "pi 引擎自带的文件与命令工具，参数以引擎提供的工具定义为准" })),
  { name: "laywork", description: "本项目业务工具（画布、工作区文件、媒体生成），经 laywork MCP 以 codemode 提供；先 describeNamespace 或 searchTools 查看，再调用 tools.<模块>.<方法>" },
];

// 目录级固定路径：pi 只在进程启动时读一次提示词，进程回收后重新落盘即可刷新。
const directory = (cwd: string) => join(dirname(conf.path), "acp", createHash("sha256").update(cwd).digest("hex").slice(0, 16));

/**
 * 把 Laywork 上下文落成 pi 的两个原生提示词文件（--system-prompt / --append-system-prompt）。
 * 技能清单用 SDK 的 available_skills 格式，与内置 Agent 的注入结果一致。
 */
export async function createAcpContext(cwd: string) {
  const context = await createAgentContext(cwd, promptTools);
  const target = directory(cwd);
  const system = join(target, "systemPrompt.md");
  const append = join(target, "appendSystemPrompt.md");
  await mkdir(target, { recursive: true });
  await writeAtomic(system, context.systemPrompt, { mode: 0o600 });
  await writeAtomic(append, [formatSkillsForPrompt(context.skillSet.skills, "read").trim(), ...globalSections(context)].filter(Boolean).join("\n\n"), { mode: 0o600 });
  return { directory: target, system, append };
}
