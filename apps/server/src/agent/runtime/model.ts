import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@/lib/modelReasoning";
import { getConfiguredModel } from "@/utils/ai";

export function getAgentModelConfiguration(providerId: string, modelId: string, thinkingLevel?: ThinkingLevel) {
  const configured = getConfiguredModel(providerId, modelId);
  // ACT: 旧版用 off 保存默认档位；模型未声明关闭能力时按默认处理，显式支持 off 的模型仍可关闭。
  if (thinkingLevel === "off" && !configured.model.reasoningLevels.includes("off")) thinkingLevel = undefined;
  if (thinkingLevel !== undefined && !configured.model.reasoningLevels.includes(thinkingLevel)) {
    throw Object.assign(new Error(`模型 ${configured.model.label} 不支持推理等级 ${thinkingLevel}`), { status: 400, code: "UNSUPPORTED_REASONING_EFFORT" });
  }
  return { ...configured, thinkingLevel, effectiveThinkingLevel: thinkingLevel ?? "off" };
}

export async function createAgentModel(providerId: string, modelId: string, thinkingLevel?: ThinkingLevel) {
  const configured = getAgentModelConfiguration(providerId, modelId, thinkingLevel);
  const { provider, model, baseUrl } = configured;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(providerId, {
    api: provider.protocol,
    baseUrl,
    models: [{
      // 默认不传推理参数，避免 SDK 把内部 off 升到模型支持的首档。
      id: model.id, name: model.label, reasoning: configured.thinkingLevel === undefined ? false : model.reasoning, thinkingLevelMap: model.thinkingLevelMap,
      compat: configured.thinkingLevel === undefined ? { ...model.compat, supportsMidConvoEffort: false } : model.compat,
      // 保留图片输入，由实际供应方判断该模型是否支持。
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens,
    }],
  });
  await runtime.setRuntimeApiKey(providerId, provider.apiKey);
  return { ...configured, runtime };
}
