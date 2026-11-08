/**
 * ACP（Agent Client Protocol）客户端。
 *
 * 协议细节（JSON-RPC over NDJSON、请求 id、取消、流式更新）全部交给官方 SDK
 * `@agentclientprotocol/sdk`：`ndJsonStream` 负责分帧，`client()` 负责收发与错误类型，
 * `ActiveSession` 负责把某个 sessionId 的 `session/update` 收进队列。
 * 这里只做三件事：拉起子进程、维护进程生命周期、把 SDK 的 API 收敛成 toonflow 需要的那几个方法。
 *
 * 生命周期：一个 createAcpClient 对应一个长驻子进程（pi-acp → 它再拉起 pi），
 * 目录级复用与回收由 acp/pi/runtime.ts 负责；本文件只保证"进程没了，所有等待都立刻失败"。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type ActiveSession, type ContentBlock, type SessionUpdate } from "@agentclientprotocol/sdk";

/** prompt 的内容块，直接用 SDK 的 ContentBlock（text/image/resource_link 等）。 */
export type PromptBlock = ContentBlock;
export type { SessionUpdate };
/** session/new 的返回值；configOptions 里含模型/思考档位，startupInfo 是 pi 的启动摘要（需丢弃）。 */
export type AcpSession = { sessionId: string; configOptions: unknown[]; startupInfo?: string };

/** 普通请求的超时。session/new 实测 4 秒左右，60 秒足够覆盖冷启动与磁盘抖动。 */
const requestTimeout = 60_000;

const liveChildren = new Set<ChildProcess>();
// 应用退出时同步杀掉 pi-acp，避免残留进程；只注册一次。
// 只杀直接子进程：pi 由 pi-acp 自己拉起，pi-acp 收到 SIGTERM 时会一并收尾。
process.once("exit", () => { for (const child of liveChildren) child.kill("SIGTERM"); });

/** SDK 不内置超时，这里只给短请求兜底；prompt 是长任务，不套这个。 */
function withTimeout<T>(promise: Promise<T>, method: string) {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ACP 请求超时：${method}`)), requestTimeout);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createAcpClient(options: { command: string; args: string[]; cwd: string; env: Record<string, string> }) {
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));

  let closed = false;
  /** sessionId → SDK 的活跃会话；它的 nextUpdate() 队列消费 session/update。 */
  const sessions = new Map<string, ActiveSession>();
  /** sessionId → 正在执行的 prompt。aborted 标记"已请求取消但引擎还没收尾"。 */
  const activePrompts = new Map<string, { aborted: boolean; done: Promise<void> }>();
  /** 进程异常退出的订阅者（runtime.ts 用它把目录缓存清掉）。 */
  const exitListeners = new Set<(reason: Error) => void>();
  /** 进程退出时唤醒所有正在 nextUpdate() 的等待，避免请求挂到超时。 */
  let signalClosed!: () => void;
  const closedSignal = new Promise<void>(resolve => (signalClosed = resolve));

  // Node 的 stdio 是 Node 流，SDK 要 Web Streams；两端都是一次性转换。
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = client({ name: "laywork" }).connect(stream);
  const agent = connection.agent;

  /** 进入"已关闭"状态：通知订阅者、唤醒等待、清掉活跃会话。SDK 会自己拒绝挂起的请求。 */
  const fail = (reason: Error) => {
    if (closed) return;
    closed = true;
    signalClosed();
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
    for (const listener of exitListeners) listener(reason);
    exitListeners.clear();
  };

  // 引擎的 stderr 原样转发到宿主 stderr，用于排查 pi 自身报错；不参与协议。
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[pi-acp] ${chunk.toString("utf8")}`);
  });
  // 三条失败通道都要接：stdin 的 EPIPE、进程退出码、spawn 失败（命令不存在）。
  child.stdin?.on("error", error => fail(error));
  child.on("exit", code => fail(new Error(`pi-acp 已退出（${code ?? "未知"}）`)));
  child.on("error", error => fail(error));

  return {
    /**
     * 握手。clientCapabilities.fs 全为 false 是刻意的：我们不提供文件系统代理，
     * 引擎要读写文件就用自己的工具（pi 有内置 read/write），省掉一整套反向请求实现。
     */
    async initialize() {
      return await withTimeout(agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }), "initialize");
    },
    /**
     * 建会话。mcpServers 传空：
     * pi-acp 会丢弃调用方给的 mcpServers，真正注入 Laywork 工具的是 pi 侧的 piBridge 扩展（registerMcpServer），
     * 这就是唯一的标准通道，见 acp/pi/piBridge.ts。
     * startupInfo 是 pi 的启动摘要（"pi v1.5.0 … ## Skills"），mapEvents 需要原文做前缀丢弃。
     */
    async newSession(cwd: string) {
      const session = await withTimeout(agent.buildSession(cwd).start(), "session/new");
      const meta = session.meta as { piAcp?: { startupInfo?: string | null } } | null | undefined;
      sessions.set(session.sessionId, session);
      return {
        sessionId: session.sessionId,
        configOptions: session.newSessionResponse.configOptions ?? [],
        startupInfo: meta?.piAcp?.startupInfo ?? undefined,
      };
    },
    /** 切换模型 / 思考档位。configId 由 configOptions 给出（pi 是 "model" 与 "thought_level"）。 */
    async setConfigOption(sessionId: string, configId: string, value: string) {
      return await withTimeout(agent.request("session/set_config_option", { sessionId, configId, value }), "session/set_config_option");
    },
    /**
     * 发一轮消息并流式接收。
     * - 同一会话串行：上一条还在跑就报错；上一条已请求取消时最多等 30 秒让它收尾，避免 pi 端交叉执行。
     * - 取消只发 session/cancel 通知（协议没有"强制杀"），真正的收尾是引擎返回 stopReason。
     */
    async prompt(sessionId: string, blocks: PromptBlock[], onUpdate: (update: SessionUpdate) => void, signal: AbortSignal) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("ACP 会话不存在");
      const active = activePrompts.get(sessionId);
      if (active) {
        if (!active.aborted) throw new Error("该会话正在执行上一条消息");
        // 上一条已请求取消，等它收尾再发，避免 pi 端交叉执行；30s 仍未结束则放弃等待。
        await Promise.race([active.done, new Promise(resolve => setTimeout(resolve, 30_000))]);
        if (activePrompts.has(sessionId)) throw new Error("该会话正在执行上一条消息");
      }
      let finish!: () => void;
      const entry = { aborted: false, done: new Promise<void>(resolve => (finish = resolve)) };
      activePrompts.set(sessionId, entry);
      const abort = () => { entry.aborted = true; void agent.notify("session/cancel", { sessionId }); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      // prompt() 的结果同时会以 stop 消息进入 nextUpdate() 队列，这里只要它别成为未处理的 rejection。
      const turn = session.prompt(blocks).catch((error: unknown) => ({ stopReason: "cancelled" as const, error }));
      try {
        while (true) {
          const message = await Promise.race([
            session.nextUpdate(),
            closedSignal.then(() => { throw new Error("pi-acp 已退出"); }),
          ]);
          if (message.kind === "stop") return { stopReason: message.stopReason };
          onUpdate(message.update);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        activePrompts.delete(sessionId);
        finish();
        await turn;
      }
    },
    /** 外部取消（"停止"按钮）。只发通知；引擎不一定会立刻停，stopReason 才是最终信号。 */
    cancel(sessionId: string) {
      const active = activePrompts.get(sessionId);
      if (active) active.aborted = true;
      if (!closed) void agent.notify("session/cancel", { sessionId });
    },
    /** 订阅进程退出；已经关闭时立刻回调一次，方便调用方无差别使用。 */
    onExit(listener: (reason: Error) => void) {
      if (closed) { listener(new Error("pi-acp 已退出")); return () => {}; }
      exitListeners.add(listener);
      return () => { exitListeners.delete(listener); };
    },
    dispose() {
      // 先让等待方失败，再杀进程；只置 closed 会让 prompt 一直等到进程真的退出。
      fail(new Error("ACP 会话已关闭"));
      liveChildren.delete(child);
      child.kill("SIGTERM");
    },
    /** 进程是否还活着（用于判断缓存条目能不能复用）。 */
    get alive() { return !closed; },
    /** 是否有 prompt 在跑（runtime.ts 的闲置回收靠它避开正在执行的会话）。 */
    get busy() { return activePrompts.size > 0; },
  };
}

export type AcpClient = ReturnType<typeof createAcpClient>;