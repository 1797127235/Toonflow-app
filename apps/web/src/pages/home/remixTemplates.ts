import templateIndex from "@toonflow/assets/remixTemplates/index.json";
import type { AgentAttachment } from "@/components/agent/types";

export type RemixTemplate = {
  id: string;
  title: string;
  description: string;
  cover: string;
  previewVideo: string | null;
  inputs: { id: string; title: string; type: string; example: string | null }[];
  texts: { id: string; title: string; content: string }[];
  steps: {
    id: string;
    title: string;
    type: string;
    promptTemplate: string;
    references: { source: string; type: string; label: string }[];
    dependsOn: string[];
    settings: Record<string, unknown>;
    connectedButNotReferenced: string[];
  }[];
  outputs: string[];
  adaptationNotes: string[];
};
export type RemixRequest = {
  prompt: string;
  attachments: AgentAttachment[];
  template: RemixTemplate;
  values: Record<string, string>;
  materials: { inputId: string; name: string }[];
  notes: string;
  branch: string;
};
export type RemixTextField = { id: string; label: string; required: boolean };

const templateFiles = import.meta.glob<RemixTemplate>("@toonflow/assets/remixTemplates/*/template.json", { import: "default" });
const assetFiles = import.meta.glob<string>("@toonflow/assets/remixTemplates/*/*.{webp,png,jpg,jpeg,mp4}", { eager: true, query: "?url", import: "default" });
const templateLoaders = Object.fromEntries(Object.entries(templateFiles).map(([path, load]) => [path.split("/").at(-2), load]));
const assetUrls = Object.fromEntries(Object.entries(assetFiles).map(([path, url]) => [path.split("/").slice(-2).join("/"), url]));

export function remixAssetUrl(id: string, path: string) {
  return assetUrls[`${id}/${path}`];
}

export const remixTemplates = templateIndex.map(template => ({
  ...template,
  coverUrl: remixAssetUrl(template.id, "cover.webp"),
}));

export async function loadRemixTemplate(id: string) {
  const load = templateLoaders[id];
  if (!load) throw new Error("工作流不存在");
  return load();
}

export function remixTextFields(template: RemixTemplate): RemixTextField[] {
  if (template.id === "talkingProductAd") return [{ id: "text1", label: "口播文案", required: true }];
  if (template.id === "electronicsAd") return [{ id: "text1", label: "产品描述", required: true }];
  if (template.id === "skincareAd") return [
    { id: "productBenefit", label: "产品功效", required: true },
    { id: "targetAudience", label: "目标人群", required: true },
    { id: "usageScene", label: "使用场景", required: true },
    { id: "brandStyle", label: "品牌风格", required: true },
  ];
  return [];
}

export function buildRemixPrompt(template: RemixTemplate, values: Record<string, string>, materials: { inputId: string; name: string }[], notes: string, branch: string) {
  const texts = template.texts.map(text => ({ ...text, content: values[text.id]?.trim() || text.content }));
  const steps = template.id === "danceCoverVideo"
    ? template.steps.filter(step => step.id === (branch === "motion" ? "step2" : "step1"))
    : template.steps;
  const recipe = {
    id: template.id,
    title: template.title,
    materials,
    texts,
    steps: steps.map(({ id, title, type, promptTemplate, references, dependsOn, settings, connectedButNotReferenced }) => ({ id, title, type, promptTemplate, references, dependsOn, settings, connectedButNotReferenced })),
    outputs: template.outputs.filter(id => steps.some(step => step.id === id)),
    adaptationNotes: template.adaptationNotes,
    userFields: values,
    ...(branch ? { selectedBranch: branch } : {}),
  };
  return `请使用以下工作流为我的素材制作同款：${template.title}。
这是固定模板制作任务，请保留模板的核心效果、步骤和参考依赖，先核对实际可用工具、模型与参数。不要改成通用小说/剧本制作流程，也不要仅给计划就结束。
附件按 materials 中的 inputId 和 name 对应；历史示例不是本次已生成结果。所有下游必须使用本次真实产物，不能沿用历史节点 ID、模型 ID 或示例文件。
{{inputN}} 指向上传素材，{{textN}} 指向文本内容，{{stepN}} 指向步骤产物；references 保留参考类型和次序，需转换为当前工具真实支持的协议。按 dependsOn 执行，不按数组或旧标题的序号直接执行。
先处理 adaptationNotes 中的引用遗漏：模板意图要求且已经连接的 connectedButNotReferenced 应纳入对应步骤的真实参考。护肤模板的中英文产品功效、目标人群、场景和品牌风格占位词必须使用 userFields 替换。图像策划文本中的表格/编写要求与发给视频模型的画面动作提示应分开。仅执行当前选中的分支；没有选中分支时按模板输出范围制作。
付费图片、视频或音频生成前，展示实际模型、数量、规格及已知费用，按现有授权规则确认后执行；不支持的能力明确报告，不偷偷降级。把本次过程和成果保存到当前工作区并展示。
${notes.trim() ? `我的补充说明：${notes.trim()}\n` : ""}
工作流资料：
${JSON.stringify(recipe, null, 2)}`;
}
