import type { Usage } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@toonflow/tools-scaffold/runtime";
import { createAgentResources } from "@/agent/runtime/resources";
import { configureAgentRequests } from "@/agent/runtime/requests";

/**
 * 子 Agent 的模型配置：直接复用 SDK 建会话的三个参数（运行时、模型、思考档位）。
 * 为什么用 Pick 而不是自定义类型：子会话必须与父会话同模型、同思考档位，
 * 否则同一个任务委派出去后能力与成本会漂移；复用 SDK 类型也让父级新增选项时自动跟上。
 */
export type SubAgentModel = Pick<CreateAgentSessionOptions, "modelRuntime" | "model" | "thinkingLevel">;

/**
 * 子任务执行结果。用多态而不是 success/error 两态，是因为调用方要据此决定下一步：
 * - running：执行中，只在回调期间短暂出现
 * - completed：正常返回文本，父级可直接采用
 * - limited：命中模型长度限制，或结果超过 16000 字符被截断；结果不完整，不能当成功处理
 * - inputRequired：子任务正在向调用方提问，带原会话补充输入后可继续
 * - cancelled：父级取消或超时。与 error 分开，避免上层把用户主动停止当成故障去重试
 * - error：其他失败，失败原因放在 result
 */
export type SubAgentResult = {
  name: string;
  status: "running" | "completed" | "error" | "limited" | "cancelled" | "inputRequired";
  result: string;
  taskId?: string;
  contextId?: string;
};

/** 用量累加器初值：所有数字字段和 cost 都显式补零，addUsage 才能无条件相加，不必在热路径判空。 */
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * 把一次模型调用的用量累加进总计。
 * 为什么不做整体覆盖：一个子任务可能多轮调用模型，覆盖会丢掉前几轮的 token 与费用，
 * 父级统计和计费都会少算。
 */
export function addUsage(total: Usage, value: Usage) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += value[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += value.cost[key];
}

export async function runSubAgent(options: SubAgentModel & {
  /** 工作区根目录：路径授权、工具范围和相对路径解析都以它为准，不能由任务文本自行指定。 */
  cwd: string;
  /** 子任务名称：写进任务提示和进度日志，父级靠它区分并行子任务；同名不作为唯一标识。 */
  name: string;
  /** 任务正文：要求自包含，因为子会话不继承父对话历史，缺的上下文父级不会再补。 */
  task: string;
  /** 父会话已授权的工具集合：子会话只在这份列表内调用，不额外扩大权限。 */
  tools: ToolDefinition[];
  /** 追加到子会话系统提示的额外指令（团队、委派场景使用）；不覆盖基础系统提示。 */
  instructions?: string;
  /** 取消信号：并入每个工具调用，并在关键节点检查，保证父级停止后不再产生副作用。 */
  signal?: AbortSignal;
  /** 复用已有会话继续任务（A2A 追问）；不传则建内存会话，避免子任务在工作区留下孤儿会话文件。 */
  history?: SessionManager;
  /**
   * 返回非空字符串表示子任务在等待调用方补充输入，并暂停后续工具与轮次。
   * 返回字符串而不是布尔：提问原文要交回父级展示和回答，父级不必再回查子会话历史结构。
   */
  inputRequired?: () => string | undefined;
  /** 把子会话里的工具调用透传给父会话；目前只转发 askUser，父级看不到子会话自己的事件流。 */
  onTool?: (tool: ToolCall) => void;
  /** 进度文案回调，仅用于父会话展示；不写入会话历史，避免高频文案污染上下文。 */
  onProgress?: (message: string) => void;
}) {
  const { cwd, name, task, tools, instructions, signal = new AbortController().signal, history, inputRequired, onTool, onProgress, ...modelOptions } = options;
  // 先占位，父会话在子任务结束前就能显示一条“准备执行”。
  const result: SubAgentResult = { name, status: "running", result: "准备执行" };
  const usage = emptyUsage();
  let session: AgentSession | undefined;
  const abort = () => { void session?.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  // 复用历史时，getEntries() 里包含前几轮已经计过费的消息。
  // 先记下起始长度，finally 只累加之后新增的部分，避免重复统计。
  const previousEntries = history?.getEntries().length ?? 0;
  try {
    signal.throwIfAborted();
    // 复用父级工具定义，只在执行边界包一层，而不是给子会话另注册一套工具。
    // 另注册会让参数 schema、授权范围和实现两处漂移；包一层则能让取消、暂停、
    // 提问转发都收敛到同一个入口，不依赖每个工具各自实现。
    const activeTools = tools.map(tool => ({
      ...tool,
      async execute(...args: Parameters<ToolDefinition["execute"]>) {
        // SDK 自带的 signal 只覆盖它自己的会话，不含父级取消源；用 AbortSignal.any 合并，
        // 任一方取消都能中断工具，否则父会话已停、工具还在写文件。
        args[2] = args[2] ? AbortSignal.any([signal, args[2]]) : signal;
        // 取消后不再进入工具实现：这里拦一次，工具内部再抛也来不及撤销已有副作用。
        args[2].throwIfAborted();
        // ACT: SDK 会把整批工具执行完才停轮；提问之后剩余工具可能继续改文件，
        // 所以必须在每个工具入口就阻断，不能只靠 finishTurn。
        if (inputRequired?.()) throw new Error("任务正在等待调用方补充输入，不能继续执行工具");
        // 非提问工具原样执行：父会话不需要子 Agent 每次读文件、搜索的噪音，
        // 全部转发只会污染父上下文和 UI。
        if (tool.name !== "askUser" || !onTool) return tool.execute(...args);
        // 子会话的 toolCallId 可能和父会话重复，而回答通道靠 ID 找卡片（answerQuestion）。
        // 用独立 UUID 隔离命名空间，否则用户可能答到另一张卡片上。
        const id = crypto.randomUUID();
        // 先上报 running：父会话只有拿到卡片才能让用户作答，不能等工具返回后再补。
        onTool({ id, name: tool.name, args: args[1] as Record<string, unknown>, status: "running" });
        try {
          const output = await tool.execute(id, args[1], args[2], args[3], args[4]);
          // 文本结果直接回传：子会话随后可能 dispose，父会话不该依赖它的历史。
          onTool({ id, name: tool.name, status: "success", result: output.content.filter(part => part.type === "text").map(part => part.text).join("\n") });
          return output;
        } catch (error) {
          // 取消标 interrupted 而不是 error：用户主动停止不是故障，
          // UI 和上层重试逻辑要能区分这两者。
          onTool({ id, name: tool.name, status: signal.aborted ? "interrupted" : "error", result: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    }));
    // 子任务禁用自动压缩和自动重试，把兜底交给父级。
    // 压缩会改写子会话历史，让复用该会话的 A2A 追问上下文错乱；
    // 重试可能重复执行有副作用的工具（写文件、发请求）。子会话只做一次干净执行。
    const resources = await createAgentResources(cwd, activeTools, SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }), instructions);
    signal.throwIfAborted();
    ({ session } = await createAgentSession({
      ...modelOptions, ...resources, cwd,
      // 没有复用历史时用内存会话：子任务生命周期由父任务管理，落盘只会留下
      // 无法从 UI 恢复的孤儿会话，还会额外参与会话文件锁竞争。
      sessionManager: history ?? SessionManager.inMemory(cwd),
      customTools: activeTools,
      tools: activeTools.map(tool => tool.name),
    }));
    configureAgentRequests(session, undefined, signal);
    signal.throwIfAborted();
    // 一旦工具里提出了问题，本轮结束就停下，把控制权交回调用方等待答复。
    // 选在轮边界而不是在工具里阻塞：阻塞会占住工具执行、无法及时响应取消，
    // 也拿不到本轮完整的 usage 结算。
    session.agent.finishTurn = ({ message }) => {
      // error/aborted 本就是硬退出，保持 SDK 默认处理。
      if (message.stopReason === "error" || message.stopReason === "aborted") return;
      if (inputRequired?.()) return { action: "end" };
    };
    // 只做进度上报。取消后事件仍可能到达，直接忽略，
    // 避免残留的「正在处理」覆盖已经确定的最终状态。
    session.subscribe(event => {
      if (signal.aborted) return;
      if (event.type === "message_start" && event.message.role === "assistant") onProgress?.("正在处理");
      if (event.type === "tool_execution_start") onProgress?.(`正在调用 ${event.toolName}`);
    });
    // 任务契约：只做被委派的事、缺少授权就交回、结论精简、长产物落文件。
    // 要求长产物写文件，是为了父上下文只收结论，不被几千行文本挤占窗口；
    // 任务正文用 JSON 包裹，是为了任务里的换行、反引号或模板标记不会破坏提示结构。
    await session.prompt(`你正在执行委派的独立子任务。仅处理下述任务，遵守系统中的授权与工作区规则。缺少信息或授权时，说明阻碍并交回调用方；若提供 requestInput 则使用它等待补充。最终返回简明结论、实际修改的文件相对路径、验证情况与未完成项；长篇产物写入已授权的工作区文件。\n\n${JSON.stringify({ name, task })}`, {
      expandPromptTemplates: false,
      // preflight 返回 ok 说明请求即将发出，这是取消检查的最后时机；
      // 在这里再抛一次，避免取消后仍发起一次昂贵的模型调用。
      preflightResult(ok) { if (ok) signal.throwIfAborted(); },
    });
    signal.throwIfAborted();
    // 有提问时以提问文本为准：这一轮模型输出通常只是复述问题，
    // 父会话真正需要的是可渲染、可回答的提问内容。
    const question = inputRequired?.();
    const reply = session.messages.findLast(message => message.role === "assistant");
    if (!reply || reply.role !== "assistant") throw new Error("子任务没有返回回复");
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || "子任务执行失败");
    const text = question ?? reply.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    if (!text) throw new Error("子任务没有返回文本结果");
    // 优先级：等输入 > 受限（长度限制或超长截断）> 正常完成。
    // 等输入必须优先，否则会被当成完成而丢掉继续对话的入口；
    // length 或截断都表示结果不完整，标 limited 让上层提示用户，而不是静默采用。
    result.status = question ? "inputRequired" : reply.stopReason === "length" || text.length > 16000 ? "limited" : "completed";
    // 最多回传 16000 字符，与 report 工具、远端团队的上报上限保持一致；
    // 超出部分留在工作区文件，避免单条结果塞爆父会话上下文。
    result.result = `${text.slice(0, 16000)}${text.length > 16000 ? "\n[结果过长，已截断；请读取工作区产物]" : ""}${reply.stopReason === "length" ? "\n[模型输出达到长度限制，任务可能未完成]" : ""}`.trim();
  } catch (error) {
    // 取消和失败分开记录：取消时优先用 signal.reason，说明是用户停止、超时还是上游断开，
    // 父级据此决定是否提示或重试。
    result.status = signal.aborted ? "cancelled" : "error";
    const reason = signal.aborted ? signal.reason : error;
    result.result = reason instanceof Error ? reason.message : "子任务执行失败";
  } finally {
    // 先移除监听再 abort，避免 abort() 触发我们自己的 abort 回调造成重入。
    signal.removeEventListener("abort", abort);
    if (session) {
      try {
        // 先停会话再统计：本轮消息落盘后 usage 才完整。
        await session.abort();
        // 只汇总本次新增消息；复用历史时旧消息已经计过费，重复统计会虚增成本。
        for (const entry of session.sessionManager.getEntries().slice(previousEntries)) {
          if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") && entry.message.usage) addUsage(usage, entry.message.usage);
        }
      } finally {
        // 放在内层 finally：即使 abort 或统计抛错，也要释放会话资源。
        session.dispose();
      }
    }
  }
  return { result, usage };
}
