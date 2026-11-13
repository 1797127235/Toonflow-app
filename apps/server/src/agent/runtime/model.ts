import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@/lib/modelReasoning";
import { getConfiguredModel } from "@/utils/ai";

/**
 * 模型配置解析。这里只校验“这个模型能不能用这个思考档位”，不负责建连接。
 *
 * 思考档位有三层含义，容易混：
 * - undefined：用户没指定，沿用会话历史或模型默认；
 * - "off"：旧版用来表示“默认档”，不是真的关闭推理；
 * - 具体档位：必须在该模型声明的 reasoningLevels 里。
 * 这个区分决定了后面 reasoning 参数到底传不传。
 */
export function getAgentModelConfiguration(providerId: string, modelId: string, thinkingLevel?: ThinkingLevel) {
  const configured = getConfiguredModel(providerId, modelId);
  // ACT: 旧版用 off 保存默认档位；模型未声明关闭能力时按默认处理，显式支持 off 的模型仍可关闭。
  if (thinkingLevel === "off" && !configured.model.reasoningLevels.includes("off")) thinkingLevel = undefined;
  if (thinkingLevel !== undefined && !configured.model.reasoningLevels.includes(thinkingLevel)) {
    throw Object.assign(new Error(`模型 ${configured.model.label} 不支持推理等级 ${thinkingLevel}`), { status: 400, code: "UNSUPPORTED_REASONING_EFFORT" });
  }
  return { ...configured, thinkingLevel, effectiveThinkingLevel: thinkingLevel ?? "off" };
}

/**
 * 为单轮运行创建模型运行时。凭据只放内存，不写全局凭证库；modelsPath 设为 null，
 * 避免读取用户机器上的全局模型注册表，保证模型定义完全来自当前项目的 settings。
 */
export async function createAgentModel(providerId: string, modelId: string, thinkingLevel?: ThinkingLevel) {
  const configured = getAgentModelConfiguration(providerId, modelId, thinkingLevel);
  const { provider, model, baseUrl } = configured;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(providerId, {
    api: provider.protocol,
    baseUrl,
    models: [{
      // 未指定档位时 reasoning=false，SDK 就不会附带推理参数；否则它会把内部的 off
      // 升到模型支持的第一档，导致“没选思考档”却产生额外推理开销。
      id: model.id, name: model.label, reasoning: configured.thinkingLevel === undefined ? false : model.reasoning, thinkingLevelMap: model.thinkingLevelMap,
      compat: configured.thinkingLevel === undefined ? { ...model.compat, supportsMidConvoEffort: false } : model.compat,
      // 统一声明 text/image，真正是否支持由供应方校验；这里不能按模型名猜能力，
      // 否则自定义 provider 的视觉模型会被错误地当成纯文本。
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens,
    }],
  });
  await runtime.setRuntimeApiKey(providerId, provider.apiKey);
  return { ...configured, runtime };
}
