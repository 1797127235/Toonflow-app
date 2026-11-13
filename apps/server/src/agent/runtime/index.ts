import { z } from "zod";
import { basename } from "node:path";
import { readFile, stat, unlink } from "@toonflow/file";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CanvasContext, QuestionContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent, AgentMention, AgentToolCall } from "@/agent/runtime/types";
import { agentMentionsSchema, mentionPrompt, snapshotMentions, validateMentionTokens } from "@/agent/runtime/mentions";
import { readAiReferences, referenceContent } from "@/utils/ai";
import { createAgentTools } from "@/agent/tools";
import { contextSegments } from "@/agent/runtime/contextUsage";
import { createAgentResources } from "@/agent/runtime/resources";
import { createAgentModel, getAgentModelConfiguration } from "@/agent/runtime/model";
import { configureAgentRequests } from "@/agent/runtime/requests";
import { getAgentImageReference, getOffloadedImageText, readAgentImage } from "@/agent/runtime/imageAttachments";
import { createSubAgentTool } from "@/agent/tools/subAgent";
import { createMemoryTool } from "@/agent/tools/memory";
import { createReportTool } from "@/agent/tools/report";
import { runDelegatedAgent } from "@/agent/runtime/delegation";
import {
  agentAttachmentsSchema, delegatedAgentInstructions, getActiveAgentSession, getAgentContext, getAgentStats, getParentSessionFile, getSubAgentInfo,
  getToolResultText, hasPendingAgentQuestion, registerAgentSession, updateSubAgent,
  type ActiveAgentSession,
} from "@/agent/runtime/sessions";
import { isMemoryEnabled } from "@/utils/personalization";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { t } from "@/lib/i18n";
import { decodeTextFile } from "@/lib/documentFormats";
import type { ThinkingLevel } from "@/lib/modelReasoning";

/**
 * Agent 的单次运行入口。这里不是“一个常驻 Agent”，而是每次用户发消息调用一次 run，
 * 由它负责：校验输入、锁定会话、组装工具/资源/会话、订阅 SDK 事件并翻译成前端事件、
 * 运行结束后落盘统计与子 Agent 状态。
 *
 * 之所以把生命周期收在一个函数里，是因为文件锁、会话注册和 finally 清理必须成对出现；
 * 拆成多个入口会让“谁负责释放锁”变得依赖调用顺序。
 */
type AgentOptions = {
  /** 本轮用户输入；为空时仍可用附件或提及发起对话。 */
  prompt: string;
  /** 附件只保存工作区相对路径，正文按需读取；文本附件在入口处一次性读入上下文。 */
  attachments?: z.infer<typeof agentAttachmentsSchema>;
  /** 提及是画布节点/工作区资源的引用，与附件走不同的快照与协议转换路径。 */
  mentions?: AgentMention[];
  /** 工作区根目录，所有相对路径和文件锁都以它为边界。 */
  cwd: string;
  providerId: string;
  modelId: string;
  /** 不传时沿用会话历史里的思考档位，避免续聊时无意改变模型行为。 */
  thinkingLevel?: ThinkingLevel;
  /** 目标会话文件名；省略时新建，存在时续写。 */
  sessionFile?: string;
  /** 运行标识，供 stopAgentRun 定位；与 sessionFile 不同，它标识“这一次运行”。 */
  runId?: string;
  /** 从历史某条用户消息重新生成；会截断当前分支，旧记录仍留在 JSONL 中。 */
  resendFrom?: string;
  canvas?: CanvasContext;
  /** 提问通道；主会话由 bridge 注入，子 Agent 由 delegation 注入。 */
  question?: QuestionContext;
  /** 外部取消源；内部还会再建一个 controller，两者合并成 runSignal。 */
  signal?: AbortSignal;
  /** 仅在本轮被主动取消时触发，用于区分用户停止和自然结束。 */
  onCancel?: () => void;
};

/**
 * 运行一轮对话。整体分四段：
 * 1. 校验与附件读取：在拿锁之前完成，失败不会影响会话文件。
 * 2. 活动会话复用：有正在跑的会话时，要么中止旧提问，要么以 steer 注入新消息。
 * 3. 新建/续写会话：锁文件、注册活动会话、组装工具与资源、创建 SDK 会话。
 * 4. 事件翻译与收尾：订阅事件推给前端，finally 中清队列、写统计、更新子 Agent 状态。
 */
export async function run(
  {
    prompt,
    attachments = [],
    mentions = [],
    cwd,
    providerId,
    modelId,
    thinkingLevel,
    sessionFile,
    runId,
    resendFrom,
    canvas,
    question,
    signal,
    onCancel,
  }: AgentOptions,
  send: (event: AgentEvent) => void
) {
  attachments = agentAttachmentsSchema.parse(attachments);
  mentions = agentMentionsSchema.parse(mentions);
  validateMentionTokens(prompt, mentions);
  if (!prompt.trim() && !attachments.length && !mentions.length) throw Object.assign(new Error("请输入消息、提及或添加附件"), { status: 400 });
  getAgentModelConfiguration(providerId, modelId, thinkingLevel);
  const attachmentContents: (z.infer<typeof agentAttachmentsSchema>[number] & { content?: string })[] = [];
  // 附件在锁会话之前全部校验并读取：失败时直接返回 400，不会留下半个会话或未释放的锁。
  for (const attachment of attachments) {
    const { path } = await resolveWorkspacePath(cwd, attachment.path);
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) {
      throw Object.assign(new Error("附件必须是工作区内非空且不超过 100 MB 的文件"), { status: 400 });
    }
    if (attachment.mimeType !== "text/plain") { attachmentContents.push(attachment); continue; }
    // ACT: 与文本引用保持同一上限，完整读取并保存到模型上下文，超限直接拒绝而不截断。
    if (info.size > 400000) throw Object.assign(new Error("文本附件最多支持 100000 个字符，请缩小内容后重试"), { status: 400 });
    const bytes = await readFile(path, { signal });
    const content = decodeTextFile(bytes);
    if (bytes.length > 400000 || content.length > 100000) throw Object.assign(new Error("文本附件最多支持 100000 个字符，请缩小内容后重试"), { status: 400 });
    attachmentContents.push({ ...attachment, content });
  }
  if (resendFrom && !sessionFile) throw Object.assign(new Error("重发需要指定原对话"), { status: 400 });
  signal?.throwIfAborted();
  const { path: sessionsDir } = await resolveWorkspacePath(cwd, ".agent/sessions", true);
  // 同一时刻一个会话只能有一个活动实例，靠进程内注册表判断；文件锁保护的是磁盘写入，
  // 注册表保护的是“复用同一个 SDK 会话对象”，两者不能互相替代。
  const sessionPath = sessionFile ? (await resolveWorkspacePath(sessionsDir, sessionFile)).path : undefined;
  const active = sessionPath ? getActiveAgentSession(sessionPath) : undefined;
  if (active && hasPendingAgentQuestion(active)) {
    // ACT: 新消息结束旧提问，必须等旧执行释放文件锁后再继续，避免并发写入同一会话。
    await active.abort();
    signal?.throwIfAborted();
  } else if (active) {
    // 子 Agent 会话不支持 steer：它的输入来自父级委派，直接插话会绕开父级的任务边界。
    if (!getParentSessionFile(active.history)) throw Object.assign(new Error("对话正在运行，请等待回复完成"), { status: 409 });
    // 附件和提及需要重新建快照并改写上下文，运行中插入会破坏消息顺序，只允许纯文本 steer。
    if (resendFrom) throw Object.assign(new Error("子 Agent 运行时不能重发历史消息"), { status: 409 });
    if (!active.session?.isStreaming) throw Object.assign(new Error("子 Agent 正在准备或结束回复，请稍后发送"), { status: 409 });
    if (attachments.length || mentions.length) throw Object.assign(new Error("请等子 Agent 当前回复结束后发送附件或提及"), { status: 400 });
    await active.session.prompt(prompt.trim(), { streamingBehavior: "steer", expandPromptTemplates: false });
    send({ type: "accepted" });
    return;
  }
  const { provider, runtime, effectiveThinkingLevel } = await createAgentModel(providerId, modelId, thinkingLevel);
  signal?.throwIfAborted();
  if (sessionPath) {
    const file = await stat(sessionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw Object.assign(new Error("会话不存在，请重新打开对话"), { status: 404 });
      throw error;
    });
    if (!file.isFile()) throw Object.assign(new Error("会话必须是普通文件"), { status: 400 });
  }
  // ACT: SDK 新会话先分配文件名、首条消息才落盘；只锁所属文件，允许不同对话同时运行。
  const newHistory = sessionPath ? undefined : SessionManager.create(cwd, sessionsDir);
  const release = lockWorkspaceFiles([sessionPath ?? newHistory!.getSessionFile()!]);
  const controller = new AbortController();
  // 父级取消（HTTP 断开、用户停止）和本轮内部取消（stopAgentRun、提问中止）都要生效；
  // 用 any 合并后，后续只需传递一个信号，避免每个环节各自判断两个来源。
  const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  signal = runSignal;
  // finished 让 abort() 能等到文件锁释放和会话落盘后再返回；
  // 否则调用方以为已停止，紧接着的下一轮可能和旧运行并发写同一个文件。
  const finished = Promise.withResolvers<void>();
  let unregister = () => {};
  let mentionFiles: string[] = [];
  let messageAccepted = false;
  try {
    const history = newHistory ?? SessionManager.open(sessionPath!, sessionsDir, cwd);
    const file = basename(history.getSessionFile()!);
    const parentFile = getParentSessionFile(history);
    const child = getSubAgentInfo(history)?.data;
    // liveTools 是工具调用的实时状态表：SDK 的 tool_execution_* 事件不带完整参数，
    // 这里把开始事件的 args 与结束事件的结果合并，供会话读取和提问状态查询使用。
    const liveTools = new Map<string, AgentToolCall>();
    const publish = send;
    send = event => {
      if (event.type === "tool") {
        const tool = { ...liveTools.get(event.tool.id), ...event.tool };
        if (tool.status !== "running") delete tool.question;
        liveTools.set(tool.id, tool);
      }
      publish(event);
    };
    const active: ActiveAgentSession = {
      history, send, tools: liveTools, runId,
      // entryOffset 记录本次运行开始前的消息数，读取会话时只把之后的消息标成 streaming，
      // 避免把历史里最后一轮也误判为正在生成。
      entryOffset: history.getEntries().length,
      abort: () => { controller.abort(); onCancel?.(); return finished.promise; },
    };
    unregister = registerAgentSession(history.getSessionFile()!, active);
    // 工具按场景叠加：基础工具由插件提供，记忆是全局开关，report 只给子 Agent，
    // subAgent 最后注入并拿到已组装的列表，子任务因此能继承当前会话的工具。
    const tools = await createAgentTools(cwd, canvas, question);
    runSignal.throwIfAborted();
    if (isMemoryEnabled()) {
      const memoryTool = createMemoryTool();
      // 工具名是模型选择工具的契约，重名会让其中一个被静默覆盖，所以直接拒绝启动。
      if (tools.some(tool => tool.name === memoryTool.name)) throw new Error("工具名称 memory 已被内置全局记忆工具占用");
      tools.push(memoryTool);
    }
    if (parentFile && child) {
      // 只有子 Agent 有父会话可上报；主 Agent 拿到 report 也无处投递。
      if (tools.some(tool => tool.name === "report")) throw new Error("工具名称 report 已被内置上报工具占用");
      tools.push(createReportTool(cwd, parentFile, file, child.name, send));
    }
    // runTask 用闭包捕获当前会话的 send、父文件名和模型配置，临时子 Agent 才能复用
    // 父会话的事件流与工作区，而不是另起一套运行入口。
    tools.push(await createSubAgentTool({
      cwd, tools, canvas, modelRuntime: runtime, model: runtime.getModel(providerId, modelId), thinkingLevel: effectiveThinkingLevel,
      runTask: (name, task, taskSignal, onProgress) => runDelegatedAgent({
        cwd, parentFile: file, name, task, providerId, modelId, thinkingLevel, canvas, signal: taskSignal, send, onProgress,
      }),
    }));
    const resources = await createAgentResources(cwd, tools, undefined, child ? delegatedAgentInstructions(child) : "");
    // 上下文用量分段必须在会话创建前算好：它只用于展示和预算，不参与实际请求；
    // 放到创建后再算会拿不到系统提示与技能的最终内容。
    const contextPrefix = contextSegments({
      cwd,
      systemPrompt: resources.resourceLoader.getSystemPrompt() ?? "",
      appendSystemPrompt: resources.resourceLoader.getAppendSystemPrompt(),
      agentsFiles: resources.resourceLoader.getAgentsFiles().agentsFiles,
      skills: resources.resourceLoader.getSkills().skills,
      tools,
    });
    runSignal.throwIfAborted();
    // 重发前必须先在当前分支里确认消息存在且是 user，否则截断到一半才发现 ID 无效，
    // 会留下无法恢复的分支指针。
    const resendEntry = resendFrom ? history.getBranch().find((item) => item.id === resendFrom) : undefined;
    if (resendFrom && (resendEntry?.type !== "message" || resendEntry.message.role !== "user")) {
      throw Object.assign(new Error("重发消息不在当前对话中，请重新打开对话"), { status: 400 });
    }
    const savedMentions = resendFrom ? history.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "toonflowUserMessage" && (entry.data as { messageId?: string })?.messageId === resendFrom) : undefined;
    const previousMentions = savedMentions?.type === "custom" ? agentMentionsSchema.safeParse((savedMentions.data as { mentions?: unknown })?.mentions) : undefined;
    const snapshots = await snapshotMentions(cwd, mentions, previousMentions?.success ? previousMentions.data : [], signal);
    mentionFiles = snapshots.created;
    mentions = agentMentionsSchema.parse(snapshots.mentions);
    const previous = history.buildSessionContext();
    if (previous.model && (previous.model.provider !== providerId || previous.model.modelId !== modelId))
      history.appendModelChange(providerId, modelId);
    if (previous.messages.length && previous.thinkingLevel !== effectiveThinkingLevel) history.appendThinkingLevelChange(effectiveThinkingLevel);
    history.appendCustomEntry("toonflowReasoning", { thinkingLevel: thinkingLevel ?? null });
    const { session } = await createAgentSession({
      cwd,
      ...resources,
      modelRuntime: runtime,
      model: runtime.getModel(providerId, modelId),
      thinkingLevel: effectiveThinkingLevel,
      sessionManager: history,
      tools: tools.map((tool) => tool.name),
      customTools: tools.map(tool => ({
        ...tool,
        // SDK 执行工具时可能用自身 signal 覆盖 session 级取消，这里再合一次 runSignal，
        // 保证用户停止能立即传给正在跑的工具，而不只是停掉 agent loop。
        async execute(...args: Parameters<typeof tool.execute>) {
          args[2] = args[2] ? AbortSignal.any([runSignal, args[2]]) : runSignal;
          args[2].throwIfAborted();
          return tool.execute(...args);
        },
      })),
    });
    configureAgentRequests(session, undefined, runSignal);
    active.session = session;

    const streamFunction = session.agent.streamFunction;
    session.agent.streamFunction = async (...args) => {
      const compacting = session.isCompacting;
      const stream = await streamFunction(...args);
      // ACT: 摘要落盘前拒绝空正文，压缩、重试和普通回复仍由 SDK 处理。
      if (compacting) {
        const response = await stream.result();
        if (response.stopReason === "stop" && !response.content.some(part => part.type === "text" && part.text.trim())) {
          throw new Error("模型返回了空摘要，已保留原上下文");
        }
      }
      return stream;
    };

    // ACT: 历史和本轮引用共用文件能力判断与协议转换，会话只保存工作区快照路径。
    // payload 里已经丢失自定义元数据，无法按消息 ID 定位附件；user 消息原文在会话中唯一，
    // 按文本反查是跨 provider 最稳的关联方式。
    const mediaContents = new Map<string, ReturnType<typeof readAiReferences>>();
    const onPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, requestModel) => {
      runSignal.throwIfAborted();
      const body = (await onPayload?.(payload, requestModel) ?? payload) as Record<string, unknown>;
      runSignal.throwIfAborted();
      sendUserMessage();
      const imageReferences = new Map(history.getBranch().flatMap(entry => {
        const reference = entry.type === "custom" && entry.customType === "toonflowImageAttachment"
          ? getAgentImageReference({ type: "text", text: "", toonflowImage: entry.data }) : undefined;
        return reference ? [[reference.id, reference] as const] : [];
      }));
      const offloadedImages = new Set(history.getBranch().flatMap(entry => {
        const images = entry.type === "custom" && entry.customType === "toonflowImageOffload" ? (entry.data as { images?: unknown })?.images : undefined;
        return Array.isArray(images) ? images.filter((id): id is string => typeof id === "string") : [];
      }));
      const mediaMessages = new Map<string, { id: string; references: Parameters<typeof readAiReferences>[1] }>();
      for (const entry of history.getBranch()) {
        if (entry.type !== "custom" || !["toonflowAttachments", "toonflowUserMessage"].includes(entry.customType)) continue;
        const parsed = z.object({ messageId: z.string(), attachments: agentAttachmentsSchema, mentions: agentMentionsSchema.optional() }).safeParse(entry.data);
        if (!parsed.success) continue;
        const references: Parameters<typeof readAiReferences>[1] = [
          ...parsed.data.attachments.filter(item => item.mimeType.startsWith("video/")).map(item => ({ dataType: "VIDEO" as const, value: { url: item.path, mimeType: item.mimeType } })),
          ...(parsed.data.mentions ?? []).filter(item => ["IMAGE", "MASK", "VIDEO"].includes(item.dataType)).map(item => ({
            dataType: item.dataType === "VIDEO" ? "VIDEO" as const : "IMAGE" as const, value: item.value as { url: string; mimeType: string },
          })),
        ];
        const message = history.getEntry(parsed.data.messageId);
        if (!references.length || message?.type !== "message" || message.message.role !== "user") continue;
        const content = message.message.content;
        for (const part of typeof content === "string" ? [{ type: "text", text: content }] : content) {
          if (part.type === "text") mediaMessages.set(part.text, { id: entry.id, references });
        }
      }
      if (!mediaMessages.size) return body;
      const field = provider.protocol === "openai-responses" ? "input" : "messages";
      const textType = provider.protocol === "openai-responses" ? "input_text" : "text";
      const messages = body[field] as { role?: string; content?: string | { type: string; text?: string }[] }[];
      return { ...body, [field]: await Promise.all(messages.map(async message => {
        if (message.role !== "user") return message;
        const parts = typeof message.content === "string" ? [{ type: textType, text: message.content }] : message.content;
        if (!parts?.some(part => part.type === textType && mediaMessages.has(part.text ?? ""))) return message;
        const content = await Promise.all(parts.map(async (part, partIndex) => {
          const source = part.type === textType && part.text ? mediaMessages.get(part.text) : undefined;
          if (!source) return [part];
          const content = referenceContent(provider.protocol, part.text!, []);
          for (const [index, media] of source.references.entries()) {
            const id = `user:${source.id}:${partIndex}:${index}`;
            const saved = imageReferences.get(id);
            if (saved && offloadedImages.has(id)) {
              content.push({ type: textType, text: `{{ref ${index + 1}}}` });
              content.push({ type: textType, text: getOffloadedImageText(saved) });
              continue;
            }
            // 同一张图会在多轮请求里反复出现，按引用路径缓存读取结果，
            // 避免每轮重新读盘和 base64 编码。
            const key = saved ? saved.path : `${source.id}:${index}`;
            if (!mediaContents.has(key)) mediaContents.set(key, saved
              ? readAgentImage(cwd, saved, signal).then(image => [{ dataType: "IMAGE", value: `data:${image.mimeType};base64,${image.data}` }])
              : readAiReferences(cwd, [media], signal, provider));
            content.push(...referenceContent(provider.protocol, "", await mediaContents.get(key)!, index).slice(1).map(content =>
              ["image", "image_url", "input_image"].includes((content as { type: string }).type) ? { ...content, toonflowImageId: id } : content));
          }
          return content;
        }));
        return { ...message, content: content.flat() };
      })) };
    };

    const resumeLeafId = history.getLeafId();
    let userMessageId = history.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    // SDK 的 user 消息会混入附件说明和 mention 替换后的文本，原始输入另存在
    // toonflowUserMessage 里；这里优先还原原始内容，前端才能显示用户真正输入的文字。
    function sendUserMessage() {
      const entry = history.getBranch().findLast((item) => item.type === "message" && item.message.role === "user");
      if (!entry || entry.id === userMessageId) return;
      userMessageId = entry.id;
      const firstMessage = !messageAccepted;
      messageAccepted = true;
      if (firstMessage && (attachments.length || mentions.length || prompt.trimStart().startsWith("/skill:"))) {
        history.appendCustomEntry("toonflowUserMessage", { messageId: entry.id, content: prompt.trim(), attachments, mentions });
        if (!history.getSessionName() && history.getBranch().filter((item) => item.type === "message" && item.message.role === "user").length === 1) {
          history.appendSessionInfo((prompt.trim().replace(/\{\{mention:([^{}]+)\}\}/g, (text, id: string) => {
            const mention = mentions.find(item => item.id === id);
            return mention ? `@${mention.label}` : text;
          }) || attachments[0]?.name || mentions[0]?.label || "新对话").slice(0, 60));
        }
      }
      const saved = history.getBranch().findLast(item => item.type === "custom" && item.customType === "toonflowUserMessage" && (item.data as { messageId?: string })?.messageId === entry.id);
      const original = saved?.type === "custom" ? saved.data as { content: string; attachments: z.infer<typeof agentAttachmentsSchema>; mentions?: AgentMention[] } : undefined;
      const content = entry.type === "message" && entry.message.role === "user" ? entry.message.content : "";
      send({ type: "userMessage", id: entry.id, content: original?.content ?? (typeof content === "string" ? content : getToolResultText(content)), attachments: original?.attachments, mentions: original?.mentions });
    }
    let firstTokenAt: number | undefined;
    let modelError: string | undefined;
    let limited = false;
    let compactionError: string | undefined;
    let messageIndex = 0;
    const toolBlocks = new Map<string, string>();
    const timing = { outputTokens: 0, decodeMs: 0 };
    // 事件翻译层：SDK 的增量事件按 blockId 聚合，工具事件用 toolBlocks 关联参数块；
    // 统计必须等本次落盘后再读，否则会少最后一条消息。
    session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        send({ type: "compaction", active: event.type === "compaction_start" });
        if (event.type === "compaction_end" && event.errorMessage) {
          compactionError = t`上下文压缩失败：${event.errorMessage}`;
        }
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        sendUserMessage();
        messageIndex++;
        firstTokenAt = undefined;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
          if (update.delta) firstTokenAt ??= performance.now();
        }
        if ("contentIndex" in update) {
          const blockId = `${messageIndex}:${update.contentIndex}`;
          if (update.type === "text_start" || update.type === "thinking_start") {
            const part = update.partial.content[update.contentIndex];
            send({
              type: update.type === "text_start" ? "text" : "thinking",
              blockId,
              content: part?.type === "thinking" && part.redacted ? part.thinking : "",
            });
          }
          if (update.type === "text_delta" || update.type === "thinking_delta") {
            send({ type: update.type === "text_delta" ? "text" : "thinking", blockId, delta: update.delta });
          }
          if (update.type === "text_end" || update.type === "thinking_end") {
            send({ type: update.type === "text_end" ? "text" : "thinking", blockId, content: update.content, done: true });
          }
          if (update.type === "toolcall_start" || update.type === "toolcall_end") {
            const part = update.type === "toolcall_end" ? update.toolCall : update.partial.content[update.contentIndex];
            if (part?.type === "toolCall") {
              toolBlocks.set(part.id, blockId);
              send({ type: "tool", blockId, tool: { id: part.id, name: part.name, args: part.arguments, status: "running" } });
            }
          }
        }
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        const tool = { id: event.toolCallId, name: event.toolName };
        send({
          type: "tool",
          blockId: toolBlocks.get(event.toolCallId) ?? event.toolCallId,
          tool:
            event.type === "tool_execution_start"
              ? { ...tool, args: event.args, status: "running" }
              : { ...tool, status: event.isError ? "error" : "success", result: getToolResultText(event.result.content) },
        });
      }
      if (event.type === "tool_execution_update") {
        send({
          type: "tool",
          blockId: toolBlocks.get(event.toolCallId) ?? event.toolCallId,
          tool: { id: event.toolCallId, name: event.toolName, status: "running", result: getToolResultText(event.partialResult.content) },
        });
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        event.message.content.forEach((part, index) => {
          const blockId = `${messageIndex}:${index}`;
          if (part.type === "text" || part.type === "thinking") {
            send({ type: part.type, blockId, content: part.type === "text" ? part.text : part.thinking, done: true });
          } else if (part.type === "toolCall") {
            toolBlocks.set(part.id, blockId);
            send({ type: "tool", blockId, tool: { id: part.id, name: part.name, args: part.arguments, status: "running" } });
          }
        });
        if (firstTokenAt !== undefined && event.message.usage.output > 0) {
          const decodeMs = performance.now() - firstTokenAt;
          if (decodeMs > 0) {
            timing.outputTokens += event.message.usage.output;
            timing.decodeMs += decodeMs;
          }
        }
        firstTokenAt = undefined;
        modelError = event.message.stopReason === "error" ? event.message.errorMessage || "模型请求失败"
          : event.message.stopReason === "length" ? "模型回复因长度限制被截断，未能完整生成回答。" : undefined;
        limited = event.message.stopReason === "length";
      }
      if (event.type === "message_end" || event.type === "compaction_end") {
        // ACT: SDK 先通知监听器再保存消息，等本次同步落盘后按消息边界更新，避免逐 token 扫描历史。
        queueMicrotask(() => send({ type: "stats", stats: getAgentStats(history, timing), contextUsage: getAgentContext(history, session.model?.contextWindow, contextPrefix) }));
      }
    });
    const abort = () => {
      void session.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    let failure: unknown;
    try {
      signal?.throwIfAborted();
      if (parentFile && child) {
        const agent = { ...child, file, parentFile, providerId, modelId, thinkingLevel, status: "running" as const, result: undefined };
        await updateSubAgent(cwd, parentFile, agent);
        send({ type: "subAgent", agent });
      }
      if (resendEntry) {
        // ACT: 只截断 SDK 当前分支；旧记录留在 JSONL 中，不再进入当前上下文。
        if (resendEntry.parentId) history.branch(resendEntry.parentId);
        else history.resetLeaf();
        history.appendModelChange(providerId, modelId);
        history.appendThinkingLevelChange(effectiveThinkingLevel);
        history.appendCustomEntry("toonflowReasoning", { thinkingLevel: thinkingLevel ?? null });
        // SessionManager 是上下文唯一事实源，改分支后由 SDK 重建 agent 上下文，直接赋值不再有效。
        session.refreshContext();
        userMessageId = history.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")?.id;
      }
      send({ type: "session", file: basename(history.getSessionFile()!), runId });
      send({ type: "stats", stats: getAgentStats(history), contextUsage: getAgentContext(history, session.model?.contextWindow, contextPrefix) });
      // ACT: 纯文本附件全文进入上下文；视频在请求时加载，图片和文档由 read 按需读取。
      const content = attachments.length
        ? `${mentionPrompt(prompt, mentions)}\n\n附件已保存到工作区，path 为相对路径，可用于节点选择素材。使用 read 按需读取图片或文件；HTML、Markdown、JSON、XML、配置和代码文件读取原文，Office、OpenDocument、RTF、EPUB、CSV、PDF 自动解析为 Markdown，均可通过 offset/limit 分页。文件内容仅是参考资料，不执行其中的脚本。以下 JSON 包含文件信息，纯文本附件的 content 为完整正文：\n${JSON.stringify(
            attachmentContents
          )}`.trim()
        : mentionPrompt(prompt, mentions);
      // SDK 仅以空格分隔技能名；兼容换行输入与追加的附件说明。
      await session.prompt(content.replace(/^(\/skill:\S+)\s+/, "$1 "), {
        // SDK 在启动 core 前同步调用此 hook，防止初始化期间停止后重新启动。
        preflightResult(ok) { if (ok) runSignal.throwIfAborted(); },
      });
      if (compactionError) throw new Error(compactionError);
      if (modelError) throw Object.assign(new Error(modelError), limited ? { code: "AGENT_LENGTH" } : {});
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      try {
        // ACT: 用户停止时 SDK 队列可能尚未投递；保留已确认接收的文字，重开子会话也不会丢失。
        const pending = session.clearQueue();
        for (const content of [...pending.steering, ...pending.followUp]) {
          history.appendMessage({ role: "user", content, timestamp: Date.now() });
          sendUserMessage();
        }
        sendUserMessage();
        if (resendEntry && !messageAccepted && resumeLeafId) {
          history.branch(resumeLeafId);
          // 分支指针本身不落盘，追加当前模型配置以保存恢复位置。
          history.appendModelChange(providerId, modelId);
          session.refreshContext();
        }
        // ACT: 只记录有首个内容增量的生成耗时，旧历史和未计时输出不参与速度统计。
        if (timing.decodeMs > 0) history.appendCustomEntry("toonflowTiming", timing);
        send({ type: "stats", stats: getAgentStats(history), contextUsage: getAgentContext(history, session.model?.contextWindow, contextPrefix) });
        if (parentFile && child) {
          const entry = history.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
          const last = entry?.type === "message" ? entry.message : undefined;
          const result = failure instanceof Error && !limited ? failure.message : last?.role === "assistant" ? getToolResultText(last.content.filter(part => part.type === "text")) : "";
          const status = signal?.aborted ? "cancelled" : limited ? "limited" : failure ? "error" : "completed";
          const agent = { ...child, file, parentFile, providerId, modelId, thinkingLevel, status, result } as const;
          await updateSubAgent(cwd, parentFile, agent);
          send({ type: "subAgent", agent });
        }
      } finally {
        session.dispose();
      }
    }
  } finally {
    unregister();
    release();
    try {
      if (!messageAccepted) await Promise.all(mentionFiles.map(path => unlink(path)));
    } finally {
      finished.resolve();
    }
  }
}

export * from "@/agent/runtime/sessions";
export * from "@/agent/runtime/runs";
export { agentMentionsSchema } from "@/agent/runtime/mentions";
