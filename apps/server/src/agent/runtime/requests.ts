/**
 * 请求层适配：在 SDK 把消息交给 provider 之前，统一处理图片外置、字节预算、
 * 历史图片迁移和 413 卸载重试。
 *
 * 不做在 provider 适配层，是因为这些规则要对所有 provider 一致生效；
 * 也不改会话落盘格式，历史里始终存“引用 + custom entry”，发送时才还原成
 * 各 provider 需要的 base64 或文件 ID。
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { getAgentImageReference, getOffloadedImageText, readAgentImage, saveAgentImage } from "@/agent/runtime/imageAttachments";
import type { AgentImageReference } from "@/agent/runtime/imageAttachments";
import { getRequestFiles, type RequestFile } from "@/utils/ai/requestFiles";
import { createFileTransport, FileRequestLimitError } from "@/utils/ai/files";
import conf from "@/utils/conf";

// 内容哈希用于两件事：把相同图片的多份引用归并到一张实际文件；
// SDK 构造 payload 后会丢失自定义元数据，只能靠消息/图片内容反查历史条目。
function contentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * 给一个会话挂上请求期行为。limits 来自 provider 配置，显式传入时优先；
 * 任何非正安全整数都直接报错——0 或负数会让预算判断永远成立，等于关闭保护。
 */
export function configureAgentRequests(session: AgentSession, limits?: { maxRequestImageBytes?: number; maxRequestBytes?: number }, runSignal?: AbortSignal) {
  for (const value of Object.values(limits ?? {})) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("图片请求预算必须为正安全整数");
  }
  const history = session.sessionManager;
  const cwd = history.getCwd();
  const afterToolCall = session.agent.afterToolCall;
  let toolFailure: { error: unknown } | undefined;
  // 工具结果里的图片先落盘成引用，再交给原 hook；顺序反了会让 SDK 先按自己的
  // 尺寸策略缩放，之后无法再按原图哈希去重。hook 返回的图片也要再处理一次，
  // 因为扩展可能在返回值里新塞图片。
  session.agent.afterToolCall = async (call, signal) => {
    if (runSignal) signal = signal ? AbortSignal.any([runSignal, signal]) : runSignal;
    try {
      signal?.throwIfAborted();
      const observationId = randomUUID();
      const content: (TextContent | ImageContent)[] = [];
      for (const [index, part] of call.result.content.entries()) {
        content.push(part.type === "image" ? await saveAgentImage(cwd, part, `tool:${observationId}:${index}`, signal) : part);
      }
      // 三个组合入口均禁用 Pi 扩展；先附件化再交原 hook，避免 SDK 二次缩放和重复尺寸说明。
      const previous = await afterToolCall?.({ ...call, result: { ...call.result, content } }, signal);
      const result: (TextContent | ImageContent)[] = [];
      for (const [index, part] of (previous?.content ?? content).entries()) {
        result.push(part.type === "image" ? await saveAgentImage(cwd, part, `hook:${observationId}:${index}`, signal) : part);
      }
      return { ...previous, content: result };
    } catch (error) {
      // 工具结果落盘失败不能吞：记下来，在真正发请求前抛出，避免模型基于缺失的
      // 工具结果继续推理。取消导致的失败不记录，否则用户停止也会被当成故障。
      if (!signal?.aborted) toolFailure = { error };
      throw error;
    }
  };

  const streamFunction = session.agent.streamFunction;
  // 自己创建事件流而不是直接返回 SDK 的流：遇到 413 或图片预算超限时，
  // 需要丢弃本次结果、重建请求并重新推流，而调用方只能看到一个连续的流。
  session.agent.streamFunction = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let partial: AssistantMessage | undefined;
      try {
        // prompt 预处理可能晚于 abort 完成；以本轮信号约束实际请求，并按流协议返回 aborted。
        if (runSignal) options = { ...options, signal: options?.signal ? AbortSignal.any([runSignal, options.signal]) : runSignal };
        options?.signal?.throwIfAborted();
        // 工具结果落盘失败要等到发请求前才抛：SDK 在工具轮结束后会继续构造下一轮，
        // 若当场抛出，调用方拿到的是“工具失败”，而不是“这一轮无法继续”。
        if (toolFailure) { const { error } = toolFailure; toolFailure = undefined; throw error; }

        // ── 1. 模型认证与传输 ──
        const providers = conf.get("settings", {}).customProviders;
        const provider = Array.isArray(providers) ? providers.find(item => item?.id === model.provider) : undefined;
        const auth = await session.modelRuntime.getAuth(model, { apiKey: options?.apiKey, env: options?.env, signal: options?.signal });
        const apiKey = options?.apiKey ?? auth?.auth.apiKey;
        const files = createFileTransport({
          apiUrl: auth?.auth.baseUrl ?? model.baseUrl,
          apiKey: apiKey ?? "",
          protocol: model.api,
        }, { fetch: options?.fetch, signal: options?.signal });
        const maxRequestImageBytes = limits?.maxRequestImageBytes ?? provider?.maxRequestImageBytes ?? 20 * 1024 * 1024;
        const maxRequestBytes = limits?.maxRequestBytes ?? provider?.maxRequestBytes ?? 32 * 1024 * 1024;
        for (const value of [maxRequestImageBytes, maxRequestBytes]) {
          if (!Number.isSafeInteger(value) || value <= 0) throw new Error("图片请求预算必须为正安全整数");
        }
        // 本次运行的内存索引：图片 id → 元数据（磁盘路径、mime、字节数、备注）。
        // 请求体里只保留 id，读文件前要先靠它换出 path；运行结束即丢弃，下次从日志重建。
        const references = new Map<string, AgentImageReference>();
        const offloaded = new Set<string>();
        const invalidThinking = new Set<string>();

        // ── 2. 从历史恢复图片状态 ──
        // 这些状态不挂在上下文对象上，进程重启或重建请求后只能从落盘 custom entry 恢复；
        // 否则已卸载的图片会在下一轮重新发送，失效的 thinking 也会重新进入请求。
        const branch = history.getBranch();
        // 消息内容哈希 → 历史条目 id，用来给旧版直接存 base64 的图片找稳定 id；
        // 内容完全相同的消息视为同一条，重发时能复用已有附件。
        const messageEntries = new Map(branch.flatMap(entry => entry.type === "message" ? [[contentHash(entry.message), entry.id] as const] : []));
        for (const entry of branch) {
          if (entry.type !== "custom") continue;
          if (entry.customType === "toonflowImageAttachment") {
            // 日志里存的就是 toonflowImage 对象本身；拼一个空文本 part 只为复用 schema 校验
            // （id、path 正则、mime、字节数）。校验失败说明日志损坏，直接报错而不跳过：
            // 跳过会让模型静默地少看一张图，比报错更难排查。
            const reference = getAgentImageReference({ type: "text", text: "", toonflowImage: entry.data });
            if (!reference) throw new Error("历史图片附件记录无效");
            references.set(reference.id, reference);
          }

          if (entry.customType === "toonflowImageOffload") {
            const data = entry.data as { images?: unknown; thinking?: unknown } | null;
            if (!data || !Array.isArray(data.images) || !data.images.every(id => typeof id === "string")
              || !Array.isArray(data.thinking) || !data.thinking.every(id => typeof id === "string")) throw new Error("历史图片卸载记录无效");
            for (const id of data.images) offloaded.add(id);
            for (const id of data.thinking) invalidThinking.add(id);
          }
        }
        const loaded = new Map<string, ImageContent>();
        // 同一引用可能在一轮请求里出现多次（用户贴同一张图、工具重复观察），
        // 按 path 缓存读取结果，避免重复解码和哈希校验。
        async function readImage(reference: AgentImageReference) {
          if (!loaded.has(reference.path)) loaded.set(reference.path, await readAgentImage(cwd, reference, options?.signal));
          return loaded.get(reference.path)!;
        }
        function recordOffload(ids: string[]) {
          // 卸载是单向的：记录写进 JSONL 后，重启、回滚分支都仍然生效。
          // thinking 一起作废，因为图片被替换成文字说明后，旧 thinking 的前缀
          // 已经和当前上下文不一致，再发回去会被模型当成无效推理。
          const images = ids.filter(id => !offloaded.has(id));
          const thinking = context.messages.filter(message => message.role === "assistant" && message.content.some(part => part.type === "thinking"))
            .map(contentHash).filter(key => !invalidThinking.has(key));
          if (!images.length && !thinking.length) return false;
          options?.signal?.throwIfAborted();
          history.appendCustomEntry("toonflowImageOffload", { images, thinking });
          for (const id of images) offloaded.add(id);
          for (const key of thinking) invalidThinking.add(key);
          return true;
        }
        function hasLaterAssistant(id: string) {
          // 只有“这张图后面已经有回答”时才需要让旧 thinking 失效；
          // 图片在最后一条消息里时，thinking 还没产生，强行作废没有意义。
          const entryId = id.startsWith("user:") ? id.split(":")[1] : id.startsWith("legacy:") ? id.split(":")[1] : undefined;
          const index = branch.findIndex(entry => entry.id === entryId);
          return index >= 0 && branch.slice(index + 1).some(entry => entry.type === "message" && entry.message.role === "assistant");
        }
        
        // ── 3. 重建循环与消息投影 ──
        let networkRecoveries = 0;
        // 重建请求的外层循环：每次 continue 都重新扫描上下文、重新分配图片引用，
        // 因为卸载会改变历史前缀，不能只在原 payload 上打补丁。
        for (;;) {
          options?.signal?.throwIfAborted();
          const imageQueue = new Map<string, AgentImageReference[]>();
          const messages: Message[] = [];
          for (const [messageIndex, message] of context.messages.entries()) {
            // 系统消息只承载提示词与工具状态，没有图片附件，原样直通。
            if (message.role === "assistant" || message.role === "system" || typeof message.content === "string") { messages.push(message); continue; }
            const content: (TextContent | ImageContent)[] = [];
            for (const [index, part] of message.content.entries()) {
              let reference = getAgentImageReference(part);
              if ("toonflowImage" in part && !reference) throw new Error("图片附件引用无效");
              if (part.type === "image") {
                const entryId = messageEntries.get(contentHash(message)) ?? contentHash(message);
                const id = `legacy:${entryId}:${index}`;
                reference = references.get(id);
                if (!reference) {
                  // 旧会话直接存了 base64；第一次遇到时落盘并登记引用，
                  // 之后的请求都走引用路径，不会反复迁移同一张图。
                  const saved = await saveAgentImage(cwd, part, id, options?.signal);
                  reference = saved.toonflowImage;
                  history.appendCustomEntry("toonflowImageAttachment", reference);
                  references.set(id, reference);
                  // 附件路径文本也改变历史前缀；首次迁移时退出旧 thinking 链，后续新 thinking 正常保留。
                  if (context.messages.slice(messageIndex + 1).some(item => item.role === "assistant")) recordOffload([]);
                }
              }
              if (!reference) { content.push(part); continue; }
              references.set(reference.id, reference);
              if (offloaded.has(reference.id)) {
                content.push({ type: "text", text: getOffloadedImageText(reference) });
                continue;
              }
              const image = await readImage(reference);
              // 同一图片内容可能对应多个引用（不同消息各存一份）；
              // onPayload 里按内容哈希取用，保证发送时仍能找回正确的引用说明。
              const key = contentHash(image.data);
              imageQueue.set(key, [...(imageQueue.get(key) ?? []), reference]);
              const text = part.type === "text" ? part.text
                : `[图片附件：${reference.sourcePath}]${reference.note ? `\n${reference.note}` : ""}`;
              content.push({ type: "text", text }, image);
            }
            messages.push({ ...message, content });
          }
          const requestContext = {
            ...context,
            // SDK 不认识 invalidThinking，这里在交给它之前把失效的 thinking 过滤掉；
            // 过滤后若消息只剩空内容，整条消息一起丢弃。
            messages: messages.flatMap((message, index) => {
              if (message.role !== "assistant" || !invalidThinking.has(contentHash(context.messages[index]))) return [message];
              const content = message.content.filter(part => part.type !== "thinking");
              return content.length ? [{ ...message, content }] : [];
            }),
          };
          // ── 4. 请求重建状态 ──
          let restart = false;
          const rebuildRequest = new Error("图片上下文已调整，重新构建请求");
          let http413 = false;
          let fatalError: { error: unknown } | undefined;
          let activeImages: { reference: AgentImageReference; file: RequestFile }[] = [];
          // 卸载按引用聚合：同一张图在上下文里出现多次时，卸载它等于一次性
          // 释放全部出现位置；只按单次出现卸载会误判收益。
          // useFileBytes 用于供应商的“文件总大小”限制，此时应看原文件字节，
          // 而不是已经按文件 ID 传输后剩余的内联字节。
          function offloadBytes(target: number, count = 0, useFileBytes = false) {
            const ids: string[] = [];
            let removed = 0;
            let removedCount = 0;
            const sizes = new Map<string, { bytes: number; count: number }>();
            for (const image of activeImages) {
              const previous = sizes.get(image.reference.id) ?? { bytes: 0, count: 0 };
              sizes.set(image.reference.id, {
                bytes: previous.bytes + (useFileBytes ? image.reference.bytes : image.file.inlineBytes),
                count: previous.count + 1,
              });
            }
            for (const [id, size] of sizes) {
              if (offloaded.has(id) || !size.bytes) continue;
              ids.push(id);
              removed += size.bytes;
              removedCount += size.count;
              if (removed >= target && removedCount >= count) break;
            }
            if (!ids.length) return false;
            recordOffload(ids);
            return true;
          }
          const request = files.fetch;
          const stream = await streamFunction(model, requestContext, {
            ...options,
            apiKey,
            // ── 5. 载荷重写与传输拦截（本地预检超预算时直接造 413，不发网络）──
            onPayload: async (payload, requestModel) => {
              try {
                // 先调用外部 onPayload，保持扩展可以改请求体；之后所有图片都必须
                // 能对应到已登记的引用，否则预算和卸载都管不到它。
                const body = await options?.onPayload?.(payload, requestModel) ?? payload;
                const images = getRequestFiles(body).filter(file => file.mimeType.toLowerCase().startsWith("image/"));
                const imageCursors = new Map<string, number>();
                activeImages = [];
                for (const image of images) {
                  options?.signal?.throwIfAborted();
                  const imageKey = contentHash(image.data);
                  const cursor = imageCursors.get(imageKey) ?? 0;
                  let reference = image.id ? references.get(image.id) : imageQueue.get(imageKey)?.[cursor];
                  if (!image.id) imageCursors.set(imageKey, cursor + 1);
                  const fromContext = !image.id && Boolean(reference);
                  if (!reference) {
                    if (!image.id) throw new Error("onPayload 注入的图片必须提供稳定的 toonflowImageId，每次重新观察图片时使用新 ID");
                    // 外部注入的新图片没有历史记录，先落盘成引用再参与预算；
                    // 同一 id 重复出现时复用已有引用，避免每次观察都复制一份。
                    const saved = await saveAgentImage(cwd, { type: "image", data: image.data, mimeType: image.mimeType }, image.id, options?.signal);
                    reference = saved.toonflowImage;
                    history.appendCustomEntry("toonflowImageAttachment", reference);
                    references.set(image.id, reference);
                    const fixed = await readImage(reference);
                    if (fixed.data !== image.data || fixed.mimeType !== image.mimeType || reference.note) {
                      // 同一 id 的内容变了，说明是“重新观察”而非同一张图；
                      // 若后面已有回答，旧 thinking 依赖的是旧图，必须作废。
                      if (hasLaterAssistant(image.id)) restart = recordOffload([]) || restart;
                    }
                  }
                  if (offloaded.has(reference.id)) { image.offload(getOffloadedImageText(reference)); continue; }
                  const fixed = await readImage(reference);
                  image.replace(fixed, fromContext ? undefined : reference.note);
                  activeImages.push({ reference, file: image });
                }
                if (restart) throw rebuildRequest;
                try { await files.prepare(body); }
                catch (error) {
                  // 文件 ID 只缩小 JSON；供应商仍限制图片总字节和张数，超限也按旧观察卸载。
                  if (error instanceof FileRequestLimitError && offloadBytes(error.excessBytes, error.excessCount, true)) {
                    restart = true;
                    throw rebuildRequest;
                  }
                  throw error;
                }
                const imageBytes = activeImages.reduce((sum, image) => sum + image.file.inlineBytes, 0);
                const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
                // 上传后再计内联 base64 与 JSON；文件 ID 不再占用内联预算，超限仍卸载旧观察。
                if (imageBytes > maxRequestImageBytes || bodyBytes > maxRequestBytes) {
                  // 先按图片超额卸载；如果卸载后仍超，说明非图片内容本身过大，
                  // 这时没有可卸载的东西，直接报错让用户压缩对话。
                  if (!offloadBytes(Math.max(imageBytes - maxRequestImageBytes, bodyBytes - maxRequestBytes))) {
                    throw new Error(`模型请求的非图片内容超过 ${maxRequestBytes} 字节预算，请压缩对话或减少附件内容后重试`);
                  }
                  restart = true;
                }
                if (restart) throw rebuildRequest;
                return body;
              } catch (error) {
                if (error !== rebuildRequest) fatalError = { error };
                throw error;
              }
            },
            fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              init?.signal?.throwIfAborted();
              if (typeof init?.body === "string" && Buffer.byteLength(init.body, "utf8") > maxRequestBytes) {
                // 本地预检：超过预算的请求体不再上传，直接返回 413 并禁止 SDK 重试，
                // 避免把几十 MB 数据先发给供应商再被拒绝。
                try {
                  restart = offloadBytes(Buffer.byteLength(init.body, "utf8") - maxRequestBytes);
                  if (!restart) fatalError = { error: new Error(`模型请求的非图片内容超过 ${maxRequestBytes} 字节预算，请压缩对话或减少附件内容后重试`) };
                } catch (error) { fatalError = { error }; }
                return new Response(JSON.stringify({ error: { message: "请求超过本地字节限制" } }), {
                  status: 413, headers: { "content-type": "application/json", "x-should-retry": "false" },
                });
              }
              // 工具或用户等待可能让代理关闭空闲连接；每轮重新握手，避免 Bun 复用失效 socket。
              const response = await request(input, { ...init, keepalive: false });
              if (response.status !== 413) return response;
              http413 = true;
              const headers = new Headers(response.headers);
              headers.set("x-should-retry", "false");
              return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
            }, request),
          });
          let visible = false;
          let start: AssistantMessageEvent | undefined;
          let retry = false;
          // 只有“还没向用户输出任何可见内容”时才允许重试；已经推过 text/tool 事件后
          // 重建请求会造成重复输出，前端也无法合并。
          // ── 6. 事件转发与重试判定 ──
          for await (const event of stream) {
            if ("partial" in event) partial = event.partial;
            if (event.type === "start") { start = event; continue; }
            if (event.type === "error") {
              options?.signal?.throwIfAborted();
              if (fatalError) throw fatalError.error;
              const imageBytes = activeImages.reduce((sum, image) => sum + image.file.inlineBytes, 0);
              // 413 时逐次减半卸载，最后一次性卸完；最多重试 4 次，避免无限循环。
              if (!visible && (restart || (http413 && networkRecoveries < 4
                && offloadBytes(Math.max(1, networkRecoveries === 3 ? imageBytes : imageBytes / 2))))) {
                if (http413) networkRecoveries++;
                retry = true;
                break;
              }
            }
            if (start) { output.push(start); start = undefined; }
            output.push(event);
            visible = true;
            if (event.type === "done" || event.type === "error") return;
          }
          if (retry) continue;
          // ── 7. 收尾 ──
          const message = await stream.result();
          if (start) output.push(start);
          output.push(message.stopReason === "error" || message.stopReason === "aborted"
            ? { type: "error", reason: message.stopReason, error: message }
            : { type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
          return;
        }
      } catch (error) {
        // 把已生成的部分内容带进错误消息：前端能显示截断的回复，
        // 而不是只在界面上留一个空错误。aborted 优先于 error，用户主动取消
        // 不应显示成模型故障。
        const message: AssistantMessage = {
          role: "assistant", content: partial?.content ?? [], api: model.api, provider: model.provider, model: model.id,
          stopReason: options?.signal?.aborted ? "aborted" : "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          timestamp: Date.now(),
        };
        output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
      } finally {
        output.end();
      }
    })();
    return output;
  };
}
