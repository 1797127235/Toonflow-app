import type { Node, Edge } from "@vue-flow/core";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { RemixRequest } from "./remixTemplates";

export async function createRemixCanvas(directory: string, request: RemixRequest) {
  const files = useWorkspaceFiles(directory);
  const { template, values, branch } = request;
  const steps = template.id === "danceCoverVideo"
    ? template.steps.filter(step => step.id === (branch === "motion" ? "step2" : "step1")) : template.steps;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const sources = new Map<string, { id: string; handle: string; depth: number }>();
  const rows = new Map<number, number>();
  const attachments = request.attachments.map(item => ({ ...item }));
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];

  function addNode(key: string, label: string, type: string, depth: number, data: Record<string, unknown> = {}) {
    const id = crypto.randomUUID();
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    const handle = type === "text" ? "text" : type;
    const dataType = type === "text" ? "STRING" : type.toUpperCase();
    const generation = steps.some(step => step.id === key) && type !== "text";
    const inputTypes = type === "image" ? ["IMAGE", "STRING"] : ["IMAGE", "VIDEO", "AUDIO", "STRING", "FILE"];
    nodes.push({
      id, type: `remote-${type}${generation ? "Generation" : ""}Node`, position: { x: depth * 560 + 40, y: row * 420 + 40 },
      data: {
        label, handles: [
          ...(type === "text" || generation ? [{ id: "in", type: "target", dataType: inputTypes, label: "参考输入" }] : []),
          { id: handle, type: "source", dataType, label: "输出" },
        ], outputs: {}, ...data,
      },
    });
    sources.set(key, { id, handle, depth });
    return nodes.at(-1)!;
  }

  function replaceFields(text: string) {
    if (template.id !== "skincareAd") return text;
    return text.replace(/\[(产品功效|INSERT THE PRODUCT BENEFIT)\]/g, () => values.productBenefit ?? "")
      .replace(/\[(目标人群|INSERT THE TARGET AUDIENCE)\]/g, () => values.targetAudience ?? "")
      .replace(/\[(使用场景|INSERT THE USAGE SCENARIO)\]/g, () => values.usageScene ?? "")
      .replace(/\[品牌风格[^\]]*\]/g, () => values.brandStyle ?? "");
  }

  try {
    await files.mkdir("assets");
    createdDirectories.push("assets");
    for (const material of request.materials) {
      const input = template.inputs.find(input => input.id === material.inputId);
      const attachment = attachments.find(item => item.name === material.name);
      if (!input || !attachment?.file) throw new Error("工作流素材不完整，请重新选择素材");
      const node = addNode(input.id, input.title.replace(/^替换/, ""), input.type, 0);
      const folder = `assets/${node.id}`;
      await files.mkdir(folder);
      createdDirectories.push(folder);
      const extension = attachment.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? "";
      const path = `${folder}/source${extension}`;
      await files.write(path, attachment.file, true);
      createdFiles.push(path);
      node.data.outputs = { [input.type]: { dataType: input.type.toUpperCase(), value: { url: path, mimeType: attachment.mimeType } } };
      attachment.path = path;
      attachment.file = undefined;
    }
    for (const text of template.texts) {
      addNode(text.id, text.title, "text", 0, { textSnapshot: replaceFields(values[text.id]?.trim() || text.content) });
    }
    if (request.notes.trim()) addNode("notes", "补充说明", "text", 0, { textSnapshot: request.notes.trim() });

    const remaining = [...steps];
    while (remaining.length) {
      const index = remaining.findIndex(step => step.dependsOn.every(id => sources.has(id)));
      if (index < 0) throw new Error("工作流步骤依赖无效，无法创建画布");
      const step = remaining.splice(index, 1)[0]!;
      const references = [...new Set([...step.references.map(ref => ref.source), ...step.connectedButNotReferenced, ...(request.notes.trim() ? ["notes"] : [])])];
      if (references.some(id => !sources.has(id))) throw new Error(`工作流步骤“${step.title}”缺少参考素材`);
      const depth = Math.max(0, ...[...references, ...step.dependsOn].map(id => sources.get(id)!.depth)) + 1;
      const prompt = replaceFields(step.promptTemplate).replace(/\{\{(\w+)\}\}/g, (token, key: string) => {
        const index = references.indexOf(key);
        return index < 0 ? token : `{{ref ${index + 1}}}`;
      });
      const size = typeof step.settings.size === "string" ? step.settings.size : "";
      const node = addNode(step.id, step.title, step.type, depth, {
        prompt, promptModel: prompt.split("\n").map(text => [{ type: "Write", text }]),
        ...(size.includes(":") ? { ratio: size } : size ? { size } : {}),
        ...(step.settings.seconds ? { duration: Number(step.settings.seconds) } : {}),
        ...(step.settings.vquality ? { resolution: step.settings.vquality } : {}),
        referenceOrder: { in: references.map(key => { const source = sources.get(key)!; return encodeURIComponent(JSON.stringify([source.id, source.handle])); }) },
      });
      for (const key of references) {
        const source = sources.get(key)!;
        edges.push({ id: crypto.randomUUID(), source: source.id, sourceHandle: source.handle, target: node.id, targetHandle: "in" });
      }
    }
    for (const node of nodes) {
      if (node.type !== "remote-textNode") continue;
      const folder = `assets/${node.id}`;
      await files.mkdir(folder);
      createdDirectories.push(folder);
      const path = `${folder}/content.md`;
      await files.write(path, typeof node.data.textSnapshot === "string" ? node.data.textSnapshot : "", true);
      createdFiles.push(path);
      node.data.textPath = path;
      delete node.data.textSnapshot;
    }
    await files.writeJson("画布1.json", { toonflowCanvas: true, nodes, edges, viewport: { x: 40, y: 40, zoom: 0.65 } }, true);
    return {
      attachments,
      prompt: `当前画布已创建同款工作流的素材、提示词、生成步骤和连线。请先读取并复用现有节点，不要重复搭建。节点对应：${JSON.stringify(Object.fromEntries(sources))}。\n${request.prompt}`,
    };
  } catch (error) {
    // 仅回收本次独占创建的文件；清理失败保留现场，不覆盖或递归删除目录。
    const cleanupErrors: string[] = [];
    for (const path of [...createdFiles.reverse(), ...createdDirectories.reverse()]) {
      try { await files.remove(path); }
      catch { cleanupErrors.push(path); }
    }
    if (cleanupErrors.length) throw new Error(`${error instanceof Error ? error.message : "创建工作流失败"}；部分文件未能清理，请检查目录：${directory}`);
    throw error;
  }
}
