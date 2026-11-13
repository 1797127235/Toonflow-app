import { z } from "zod";
import { basename, dirname, resolve } from "node:path";
import { readFile, readdir } from "@toonflow/file";
import { calculateContextTokens, estimateTokens, getLastAssistantUsage, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentContextSegment, AgentEvent, AgentMention, AgentSubAgent, AgentToolCall } from "@/agent/runtime/types";
import { loadContextPrefix } from "@/agent/runtime/contextUsage";
import { agentMentionsSchema } from "@/agent/runtime/mentions";
import { readAcpBinding } from "@/agent/acp/pi/binding";
import conf from "@/utils/conf";
import { providerSchema, getModelLimits } from "@/utils/ai";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { getReadableFileMimeType } from "@/lib/documentFormats";
import { thinkingLevels } from "@/lib/modelReasoning";

/**
 * 会话运行时状态与磁盘读写。
 *
 * 这里同时处理三种“会话”：
 * - ActiveAgentSession：进程内正在运行的实例，持有 SDK session、实时工具表和取消入口。
 * - JSONL 文件：唯一持久化格式，一行一个 entry，树形关系用 parentId 表达。
 * - SessionManager：SDK 的读写封装；读取时会跳过损坏行。
 *
 * 文件锁只保护磁盘写入；运行中会话的复用靠 activeSessions，两者不能互相替代。
 */

// 附件只接受图片、视频或纯文本；其他格式必须能被文档解析器识别。
// 在这里统一归一化 mimeType，后续按 provider 协议转换时就不必重复判断扩展名。
export const agentAttachmentsSchema = z
  .array(
    z.strictObject({
      name: z.string().min(1).max(255),
      path: z.string().min(1).max(4096),
      mimeType: z.string().min(1).max(128),
    }).refine(attachment => /^(?:(image|video)\/[a-zA-Z0-9.+-]+|text\/plain)$/.test(attachment.mimeType)
      || !!getReadableFileMimeType(attachment.path, attachment.mimeType), "不支持此附件格式")
      .transform(attachment => ({ ...attachment, mimeType: getReadableFileMimeType(attachment.path, attachment.mimeType) ?? attachment.mimeType }))
  )
  .max(20);

/**
 * 一次运行在进程内的句柄。session 在 SDK 创建完成后才赋值：
 * 创建前收到 steer 只能拒绝，创建后才能把新消息注入当前回合。
 */
export type ActiveAgentSession = {
  history: SessionManager; session?: AgentSession; send: (event: AgentEvent) => void;
  /** 本次运行开始前的 entry 数，用于区分历史消息和本轮流式消息。 */
  entryOffset: number; tools: Map<string, AgentToolCall>;
  runId?: string;
  /** 触发取消并等待文件锁释放；返回后磁盘状态已稳定。 */
  abort(): Promise<void>;
};

// 返回给前端的消息视图，不是存储格式：同轮拆分的 entry 已合并，工具状态与流式标记已归一。
type SessionMessage = {
  id: string; entryId: string; role: "user" | "assistant"; content: string; replyTo?: string; error?: string;
  streaming?: boolean;
  attachments?: z.infer<typeof agentAttachmentsSchema>; report?: { file: string; name: string };
  mentions?: AgentMention[];
  parts: ({ id: string; type: "text" | "thinking"; content: string; collapsed?: boolean } | { id: string; type: "tool"; tool: AgentToolCall })[];
};

// 运行中的会话实例，按会话文件路径索引，供停止、读取和事件推送复用。
const activeSessions = new Map<string, ActiveAgentSession>();
// Windows 路径大小写不敏感，统一小写后再比较，避免同一文件被注册成两个键。
const sessionKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function getActiveAgentSession(path: string) {
  return activeSessions.get(sessionKey(path));
}

/**
 * 判断整条委派链是否在等用户回答。父会话只看到 subAgent 工具处于 running，
 * 真正的问题在子会话的 askUser 工具上，所以必须沿 toonflowSubAgent 记录递归查找。
 */
export function hasPendingAgentQuestion(active: ActiveAgentSession, visited = new Set<ActiveAgentSession>()): boolean {
  if (visited.has(active)) return false;
  visited.add(active);
  const tools = [...active.tools.values()];
  if (tools.some(tool => tool.status === "running" && tool.question)) return true;
  if (!tools.some(tool => tool.name === "subAgent" && tool.status === "running")) return false;
  const path = active.history.getSessionFile()!;
  return active.history.getEntries().some(entry => {
    if (entry.type !== "custom" || entry.customType !== "toonflowSubAgent") return false;
    const file = (entry.data as AgentSubAgent | undefined)?.file;
    if (!file || !/^[\w-]+\.jsonl$/.test(file)) return false;
    const child = getActiveAgentSession(resolve(dirname(path), file));
    return !!child && getParentSessionFile(child.history) === basename(path) && hasPendingAgentQuestion(child, visited);
  });
}

// question 事件只带 toolCallId；回写到实时工具记录后，
// hasPendingAgentQuestion 和前端查询才能看到“这个工具在等回答”。
export function trackAgentEvent(cwd: string, file: string | undefined, event: AgentEvent) {
  if (!file || event.type !== "question") return;
  const active = getActiveAgentSession(resolve(cwd, ".agent/sessions", file));
  const tool = active?.tools.get(event.toolCallId);
  if (tool) tool.question = { callId: event.callId, title: event.title, question: event.question, options: event.options, fields: event.fields };
}

export function registerAgentSession(path: string, active: ActiveAgentSession) {
  const key = sessionKey(path);
  activeSessions.set(key, active);
  return () => { if (activeSessions.get(key) === active) activeSessions.delete(key); };
}

export function getSubAgentInfo(history: SessionManager) {
  return history.getEntries().find(entry => entry.type === "custom" && entry.customType === "toonflowSubAgentInfo") as
    (SessionEntry & { data: AgentSubAgent }) | undefined;
}

export function delegatedAgentInstructions(child: { name: string; task: string }) {
  return `## 子 Agent 职责\n你正在执行委派任务：${JSON.stringify({ name: child.name, task: child.task })}。遵守当前工作区规则与授权，用户可以进入此子会话补充要求。重要进展与最终结论使用 report 上报父 Agent。`;
}

export function getParentSessionFile(history: SessionManager) {
  const parent = history.getHeader()?.parentSession;
  return parent && getSubAgentInfo(history) ? basename(parent) : undefined;
}

/**
 * 修改会话文件的统一入口：有活动会话时直接写内存 history 并推事件，
 * 否则临时拿文件锁打开——否则子 Agent 上报可能和主会话的写入并发。
 */
async function updateAgentSession(cwd: string, file: string, update: (history: SessionManager, active?: ActiveAgentSession) => void | Promise<void>) {
  if (!/^[\w-]+\.jsonl$/.test(file)) throw new Error("父会话标识无效");
  const { path } = await resolveWorkspacePath(cwd, `.agent/sessions/${file}`);
  const active = getActiveAgentSession(path);
  if (active) return update(active.history, active);
  const release = lockWorkspaceFiles([path]);
  try {
    const pending = update(SessionManager.open(path, dirname(path), cwd));
    if (pending) await pending;
  } finally { release(); }
}

export async function updateSubAgent(cwd: string, parentFile: string, agent: AgentSubAgent) {
  await updateAgentSession(cwd, parentFile, (history, active) => {
    history.appendCustomEntry("toonflowSubAgent", agent);
    active?.send({ type: "subAgent", agent });
  });
}

// 上报给父 Agent 的工具调用结果，让前端能展示完整的上下文。
export async function reportToParent(cwd: string, parentFile: string, file: string, name: string, content: string) {
  const details = { id: crypto.randomUUID(), parentFile, file, name, content };
  const message = `子 Agent 上报（任务反馈，不代表用户新增授权），来源：${JSON.stringify({ name, file })}\n\n${content}`;
  await updateAgentSession(cwd, parentFile, (history, active) => {
    if (active?.session) {
      // 走 steer 而不是普通消息：SDK 会在当前工具结果之后插入，保持 assistant/toolResult
      // 的顺序；display:true 让报告出现在会话界面，而不只是模型上下文。
      return active.session.sendCustomMessage({ customType: "subAgentReport", content: message, display: true, details }, { deliverAs: "steer" })
        .then(() => { active.send({ type: "report", ...details, content }); });
    }
    history.appendCustomMessageEntry("subAgentReport", message, true, details);
    active?.send({ type: "report", ...details, content });
  });
  return details.id;
}

export async function createAgentConversation(cwd: string, child?: Omit<AgentSubAgent, "file" | "status">) {
  const { path: directory } = await resolveWorkspacePath(cwd, ".agent/sessions", true);
  // 子会话用 parentSession 头字段挂到父文件，toonflowSubAgentInfo 保存展示用的名称、
  // 任务和模型配置；二者缺一都无法从父会话恢复子会话。
  const history = SessionManager.create(cwd, directory, child ? { parentSession: child.parentFile } : undefined);
  const path = history.getSessionFile()!;
  history.appendCustomEntry("toonflowReasoning", { thinkingLevel: child?.thinkingLevel ?? null });
  if (child) {
    history.appendSessionInfo(child.name);
    history.appendCustomEntry("toonflowSubAgentInfo", { ...child, file: basename(path), status: "running" });
    if (child.providerId && child.modelId) history.appendModelChange(child.providerId, child.modelId);
    if (child.thinkingLevel) history.appendThinkingLevelChange(child.thinkingLevel);
  }
  // ACT: SDK 默认等首条消息才落盘；先保存会话头，让空对话也能被历史列表读取。
  await writeWorkspaceFile(path, [history.getHeader(), ...history.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", true);
  return getAgentSession(cwd, path);
}

export async function renameAgentSession(cwd: string, path: string, name: string) {
  const release = lockWorkspaceFiles([path]);
  try {
    const entries = parseSessionEntries(await readFile(path, "utf8"));
    if (entries[0]?.type !== "session") throw Object.assign(new Error("会话文件无效"), { status: 400 });
    const history = SessionManager.open(path, dirname(path), cwd);
    history.appendSessionInfo(name);
    return { name: history.getSessionName()! };
  } finally {
    release();
  }
}

export async function forkAgentConversation(cwd: string, path: string, entryId: string) {
  if (getActiveAgentSession(path)) throw Object.assign(new Error("对话运行中，请稍后再分支"), { status: 409 });
  const release = lockWorkspaceFiles([path]);
  try {
    let entries: ReturnType<typeof parseSessionEntries>;
    try {
      // SDK 解析会跳过损坏行；分支前先逐行校验，损坏文件直接拒绝。
      const raw = await readFile(path, "utf8");
      for (const line of raw.split("\n")) if (line.trim()) JSON.parse(line);
      entries = parseSessionEntries(raw);
    } catch { throw Object.assign(new Error("会话文件无效"), { status: 400 }); }
    if (entries[0]?.type !== "session") throw Object.assign(new Error("会话文件无效"), { status: 400 });
    const history = SessionManager.open(path, dirname(path), cwd);
    if (getSubAgentInfo(history)) throw Object.assign(new Error("子会话不支持分支"), { status: 400 });
    const entry = history.getBranch().find(item => item.id === entryId);
    if (!entry || entry.type !== "message" || entry.message.role !== "user") throw Object.assign(new Error("消息不在当前对话中"), { status: 400 });
    const source = await getAgentSession(cwd, path);
    const question = source.messages.find(item => item.role === "user" && item.id === entryId);
    const draft = { prompt: question?.content ?? "", attachments: question?.attachments };
    const name = `${source.name}（分支）`;
    // 首条提问没有前缀历史：建新空对话，并继承源对话的模型与思考配置。
    if (!entry.parentId) {
      const created = await createAgentConversation(cwd);
      const forkPath = resolve(dirname(path), created.file);
      const releaseFork = lockWorkspaceFiles([forkPath]);
      try {
        const fork = SessionManager.open(forkPath, dirname(forkPath), cwd);
        fork.appendSessionInfo(name);
        if (source.providerId && source.modelId) fork.appendModelChange(source.providerId, source.modelId);
        if (source.thinkingLevel) {
          fork.appendCustomEntry("toonflowReasoning", { thinkingLevel: source.thinkingLevel });
          fork.appendThinkingLevelChange(source.thinkingLevel);
        }
      } finally { releaseFork(); }
      return { session: await getAgentSession(cwd, forkPath), ...draft };
    }
    const forkFile = history.createBranchedSession(entry.parentId);
    if (!forkFile) throw Object.assign(new Error("分支对话失败"), { status: 500 });
    // createBranchedSession 已把 history 切换到新分支文件；重新 open 空文件会重建 session 头，
    // 导致 header id 与文件名不一致，直接复用当前实例。
    // 停止可能让同批 toolCall 缺结果：只在新文件补齐，避免分叉上下文悬空调用。
    const results = new Set(history.getBranch().flatMap(item => item.type === "message" && item.message.role === "toolResult" ? [item.message.toolCallId] : []));
    for (const item of history.getBranch()) {
      if (item.type !== "message" || item.message.role !== "assistant") continue;
      for (const part of item.message.content) {
        if (part.type !== "toolCall" || results.has(part.id)) continue;
        results.add(part.id);
        history.appendMessage({ role: "toolResult", toolCallId: part.id, toolName: part.name, content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: Date.now() });
      }
    }
    history.appendSessionInfo(name);
    // 历史列表只列根会话：剥掉新文件头的 parentSession，只重写自己的新文件。
    // SDK 在分支路径里没有对话消息时不落盘，先读盘会 ENOENT，直接用内存条目重写。
    const forkEntries = [history.getHeader()!, ...history.getEntries()];
    const forkHeader = forkEntries[0];
    if (forkHeader?.type === "session") delete forkHeader.parentSession;
    await writeWorkspaceFile(forkFile, forkEntries.map(item => JSON.stringify(item)).join("\n") + "\n");
    return { session: await getAgentSession(cwd, forkFile), ...draft };
  } finally { release(); }
}

export async function listAgentSessions(cwd: string, directory: string) {
  const files = new Set((await readdir(directory, { withFileTypes: true })).filter((item) => item.isFile()).map((item) => item.name));
  const sessions = await SessionManager.list(cwd, directory);
  // 只列根会话；子 Agent 会话由父会话里的 toonflowSubAgent 记录展示，
  // 否则同一条委派链会在历史列表里重复出现。
  return sessions
    .filter((item) => files.has(basename(item.path)) && !item.parentSessionPath)
    .sort((left, right) => right.modified.getTime() - left.modified.getTime())
    .map((item) => ({
      file: basename(item.path),
      name: item.name || (item.messageCount ? item.firstMessage.trim().slice(0, 60) : "") || "新对话",
      modified: item.modified,
      messageCount: item.messageCount,
    }));
}

export async function getAgentSession(cwd: string, path: string) {
  const active = getActiveAgentSession(path);
  const entries = active
    ? [active.history.getHeader()!, ...active.history.getEntries()]
    : parseSessionEntries(await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw Object.assign(new Error("会话不存在，请重新打开对话"), { status: 404 });
      throw error;
    }));
  if (entries[0]?.type !== "session") throw Object.assign(new Error("会话文件无效"), { status: 400 });
  // 运行中的流式消息还没落盘，从 SDK 内存补一条临时 entry，
  // 否则刷新页面会看不到正在生成的回复。
  const partial = active?.session?.agent.state.streamingMessage;
  if (partial?.role === "assistant") entries.push({
    type: "message", id: "streaming", parentId: active!.history.getLeafId(), timestamp: new Date().toISOString(), message: partial,
  });
  // blockId 必须和运行中推送的 text/thinking 事件一致：运行前的历史用 entry id，
  // 本次运行的消息用“第几条 assistant:内容块序号”，前端才能把增量拼到正确位置。
  const messageIndices = new Map(active ? entries.slice(active.entryOffset + 1)
    .filter(entry => entry.type === "message" && entry.message.role === "assistant")
    .map((entry, index) => [(entry as SessionEntry).id, index + 1]) : []);
  const history = SessionManager.inMemory(cwd, undefined, entries);
  const branch = history.getBranch();
  const reasoning = branch.findLast(entry => entry.type === "custom" && entry.customType === "toonflowReasoning");
  const reasoningSelection = z.object({ thinkingLevel: z.enum(thinkingLevels).nullable() }).safeParse(reasoning?.type === "custom" ? reasoning.data : undefined);
  const attachmentMessages = new Map(
    branch.flatMap((entry) => {
      if (entry.type !== "custom" || !["toonflowAttachments", "toonflowUserMessage"].includes(entry.customType)) return [];
      const parsed = z.object({ messageId: z.string(), content: z.string(), attachments: agentAttachmentsSchema, mentions: agentMentionsSchema.optional() }).safeParse(entry.data);
      return parsed.success ? [[parsed.data.messageId, parsed.data] as const] : [];
    })
  );
  const toolResults = new Map(
    branch.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolCallId, entry.message] as const] : []
    )
  );
  let replyTo: string | undefined;
  const entriesMessages = branch.flatMap<SessionMessage>((entry) => {
    if (entry.type === "custom_message" && entry.customType === "subAgentReport") {
      const details = entry.details as { id?: string; file: string; name: string; content?: string };
      const content = details.content ?? (typeof entry.content === "string" ? entry.content : getToolResultText(entry.content));
      return [{
        id: details.id ?? entry.id, entryId: entry.id, replyTo: undefined, role: "assistant" as const,
        content, parts: [{ id: details.id ?? entry.id, type: "text", content }], error: undefined,
        attachments: undefined, report: { file: details.file, name: details.name },
      }];
    }
    if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
    const message = entry.message;
    if (message.role === "user") replyTo = entry.id;
    const attachmentMessage = message.role === "user" ? attachmentMessages.get(entry.id) : undefined;
    const attachments = attachmentMessage?.attachments;
    const parts =
      message.role === "assistant"
        ? message.content
            .map((part, index) => {
              const id = `${messageIndices.get(entry.id) ?? entry.id}:${index}`;
              if (part.type === "text") return { id, type: "text" as const, content: part.text };
              if (part.type === "thinking") return { id, type: "thinking" as const, content: part.thinking, collapsed: true };
              if (part.type === "toolCall") {
                const result = toolResults.get(part.id);
                return {
                  id,
                  type: "tool" as const,
                  tool: active?.tools.get(part.id) ?? {
                    id: part.id,
                    name: part.name,
                    args: part.arguments,
                    status: result ? (result.isError ? "error" as const : "success" as const) : "interrupted" as const,
                    result: result ? getToolResultText(result.content) : undefined,
                  },
                };
              }
            })
            .filter((part) => part !== undefined)
        : [];
    const content =
      message.role === "assistant"
        ? ""
        : attachmentMessage?.content ??
          (typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""));
    const error = message.role === "assistant" ? message.errorMessage : undefined;
    return [
      {
        id: entry.id,
        entryId: entry.id,
        replyTo: message.role === "assistant" ? replyTo : undefined,
        role: message.role,
        content,
        parts,
        error,
        attachments,
        mentions: attachmentMessage?.mentions,
        report: undefined,
      },
    ];
  });
  const groupedMessages: typeof entriesMessages = [];
  for (const message of entriesMessages) {
    const previous = groupedMessages.at(-1);
    if (message.role === "assistant" && message.replyTo && previous?.role === "assistant" && previous.replyTo === message.replyTo) {
      previous.parts.push(...message.parts);
      previous.error = message.error;
    } else groupedMessages.push(message);
  }
  // ACT: 同轮的工具调用与多步回复合并后，只拼接一次正文。
  for (const message of groupedMessages) {
    if (message.role === "assistant" && !message.report) message.content = message.parts.flatMap(part => part.type === "text" ? [part.content] : []).join("\n\n");
  }
  const latestUser = groupedMessages.findLast(message => message.role === "user");
  const activeReply = active && latestUser ? groupedMessages.findLast(message =>
    message.role === "assistant" && !message.report && message.replyTo === latestUser.id && messageIndices.has(message.entryId)
  ) : undefined;
  if (activeReply) activeReply.streaming = true;
  const messages = groupedMessages.filter((message) => message.content || message.parts.length || message.error || message.attachments?.length || message.mentions?.length);
  const firstUserMessage = messages.find((item) => item.role === "user");
  const context = history.buildSessionContext();
  const lastReply = history.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  const model =
    lastReply?.type === "message" && lastReply.message.role === "assistant"
      ? { provider: lastReply.message.provider, modelId: lastReply.message.model }
      : context.model;
  const providers = conf.get("settings", {}).customProviders;
  const provider = providerSchema.safeParse(Array.isArray(providers) ? providers.find((item) => item?.id === model?.provider) : undefined);
  const configuredModel = provider.success ? provider.data.models.find((item) => item.id === model?.modelId) : undefined;
  const subAgents = new Map<string, AgentSubAgent>();
  for (const entry of history.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== "toonflowSubAgent") continue;
    const agent = entry.data as AgentSubAgent;
    // 上次进程退出时子 Agent 可能停在 running；没有活动实例就视为中断，
    // 否则前端会一直显示“运行中”。
    const interrupted = agent.status === "running" && !active && !getActiveAgentSession(resolve(dirname(path), agent.file));
    subAgents.set(agent.file, interrupted ? { ...agent, status: "cancelled", result: "上次运行已中断" } : agent);
  }
  const child = getSubAgentInfo(history)?.data;
  const prefix = await loadContextPrefix(cwd, child ? delegatedAgentInstructions(child) : "").catch(() => []);
  return {
    file: basename(path),
    // 会话归属：ACP 会话与内置会话不能互相续聊，前端据此决定默认引擎。
    kind: readAcpBinding(branch) ? "acp" as const : "builtin" as const,
    name: history.getSessionName() || (firstUserMessage?.content.trim() || firstUserMessage?.attachments?.[0]?.name)?.slice(0, 60) || "新对话",
    messages,
    stats: getAgentStats(history),
    contextUsage: getAgentContext(history, active?.session?.model?.contextWindow ?? (configuredModel && model ? getModelLimits(model.provider, configuredModel).contextWindow : 0), prefix),
    providerId: model?.provider,
    modelId: model?.modelId,
    thinkingLevel: reasoningSelection.success ? reasoningSelection.data.thinkingLevel ?? undefined : context.thinkingLevel,
    parentFile: getParentSessionFile(history),
    subAgents: [...subAgents.values()],
    running: Boolean(active),
    runId: active?.runId,
  };
}

export function getToolResultText(content: { type: string; text?: string }[]) {
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

export function getAgentStats(history: SessionManager, timing?: { outputTokens: number; decodeMs: number }) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let outputTokens = timing?.outputTokens ?? 0;
  let decodeMs = timing?.decodeMs ?? 0;
  // 压缩和分支摘要同样消耗 token，但 usage 不在 message 上；不累计会低估成本，
  // 续聊后统计还会突然变小。
  for (const entry of history.getBranch()) {
    const usage =
      entry.type === "compaction" || entry.type === "branch_summary"
        ? entry.usage
        : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
        ? entry.message.usage
        : undefined;
    if (usage) {
      tokens.input += usage.input;
      tokens.output += usage.output;
      tokens.cacheRead += usage.cacheRead;
      tokens.cacheWrite += usage.cacheWrite;
    }
    if (entry.type === "custom" && entry.customType === "toonflowTiming") {
      const timing = entry.data as { outputTokens?: number; decodeMs?: number } | undefined;
      if (
        typeof timing?.outputTokens === "number" &&
        Number.isFinite(timing.outputTokens) &&
        timing.outputTokens > 0 &&
        typeof timing.decodeMs === "number" &&
        Number.isFinite(timing.decodeMs) &&
        timing.decodeMs > 0
      ) {
        outputTokens += timing.outputTokens;
        decodeMs += timing.decodeMs;
      }
    }
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { tokens, tokensPerSecond: decodeMs > 0 ? (outputTokens * 1000) / decodeMs : undefined };
}

// 静态分段（系统提示、技能等）是估算值，和模型实测总量可能不一致；
// 超出时按比例压缩，保证各分段之和不超过实测值。
function fitSegments(segments: AgentContextSegment[], total: number) {
  const sum = segments.reduce((count, segment) => count + segment.tokens, 0);
  if (sum <= total) return segments;
  if (total <= 0) return [];
  const fitted = segments.map(segment => ({ ...segment, tokens: Math.floor(segment.tokens * total / sum) }));
  const drift = total - fitted.reduce((count, segment) => count + segment.tokens, 0);
  if (drift > 0 && fitted[0]) fitted[0].tokens += drift;
  return fitted.filter(segment => segment.tokens > 0);
}

export function getAgentContext(history: SessionManager, contextWindow = 0, prefix: AgentContextSegment[] = []) {
  const branch = history.getBranch();
  const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const recent = branch.slice(compactionIndex + 1);
  const usage = getLastAssistantUsage(recent);
  const messages = history.buildSessionContext().messages;
  const usageIndex = messages.findLastIndex((message) => message.role === "assistant" && message.usage === usage);
  // ACT: 压缩后先按摘要与保留消息估算，首条新回复后再使用模型 usage。模型 usage 已包含当轮静态提示，对话段取剩余量。
  const includesStaticPrompt = Boolean(usage && usageIndex >= 0);
  const measured = includesStaticPrompt
    ? calculateContextTokens(usage!) + messages.slice(usageIndex + 1).reduce((total, message) => total + estimateTokens(message), 0)
    : messages.reduce((total, message) => total + estimateTokens(message), 0);
  const rawPrefix = prefix.filter(segment => segment.tokens > 0);
  const staticSegments = includesStaticPrompt ? fitSegments(rawPrefix, measured) : rawPrefix;
  const staticTokens = staticSegments.reduce((total, segment) => total + segment.tokens, 0);
  const conversation = includesStaticPrompt ? Math.max(0, measured - staticTokens) : measured;
  const tokens = conversation + staticTokens;
  if (contextWindow <= 0 && tokens <= 0) return undefined;
  return {
    tokens,
    contextWindow,
    percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
    segments: [
      ...staticSegments,
      ...(conversation > 0 ? [{ id: "conversation" as const, label: "对话", tokens: conversation }] : []),
    ],
  };
}
