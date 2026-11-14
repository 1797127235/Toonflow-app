import type { GeneratedMedia, MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeAtomic } from "@toonflow/file";
import { dirname, join } from "node:path";
import { error, errorFromCause, success, type ApiResponse } from "@/lib/responseFormat";
import conf from "@/utils/conf";
import { generateMedia, resumeMedia } from "@/utils/media/generation";

type MediaTaskState = "created" | "submitted" | "succeeded" | "failed" | "cancelled" | "interrupted";

type MediaTaskRecord = {
  taskId: string;
  cwd: string;
  mediaType: "image" | "video" | "audio";
  providerId: string;
  modelId: string;
  outputDirectory: string;
  state: MediaTaskState;
  createdAt: number;
  deadline: number;
  remoteTaskId?: string;
  settledAt?: number;
  result?: ApiResponse<GeneratedMedia[]>;
};

type MediaTask = { record: MediaTaskRecord; controller: AbortController };

const taskStates = new Set<MediaTaskState>(["created", "submitted", "succeeded", "failed", "cancelled", "interrupted"]);
const terminalStates = new Set<MediaTaskState>(["succeeded", "failed", "cancelled", "interrupted"]);
// 磁盘是事实源，内存只做热缓存：结果内存保留 5 分钟、磁盘保留 7 天；页面断开不再心跳停止。
const tasks = new Map<string, MediaTask>();
const taskDuration = 30 * 60 * 1000;

function recordPath(cwd: string, taskId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw Object.assign(new Error("任务 ID 无效"), { status: 400 });
  return join(dirname(conf.path), "mediaTasks", createHash("sha256").update(cwd).digest("hex").slice(0, 16), `${taskId}.json`);
}

async function persist(record: MediaTaskRecord) {
  const path = recordPath(record.cwd, record.taskId);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, JSON.stringify(record), { mode: 0o600 });
}

async function readRecord(cwd: string, taskId: string): Promise<MediaTaskRecord | null> {
  const text = await readFile(recordPath(cwd, taskId), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const record = JSON.parse(text) as MediaTaskRecord;
    return record && record.taskId === taskId && typeof record.cwd === "string" && taskStates.has(record.state) ? record : null;
  } catch { return null; }
}

// 按 taskId 串行化「读-判-写」状态转换，关闭 start/续跑认领与 cancel/status 落盘之间的竞态窗口。
const taskLocks = new Map<string, Promise<void>>();
function serialize<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const run = (taskLocks.get(taskId) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  taskLocks.set(taskId, tail);
  void tail.then(() => { if (taskLocks.get(taskId) === tail) taskLocks.delete(taskId); });
  return run;
}

// 单写者终态守卫：内存任务统一在此落定，终态永不被覆盖。
function settle(task: MediaTask, state: "succeeded" | "failed" | "cancelled", result: ApiResponse<GeneratedMedia[]>) {
  if (terminalStates.has(task.record.state)) return;
  Object.assign(task.record, { state, result, settledAt: Date.now() });
  // 落盘失败仅降级为「重启后按中断处理」，不影响本进程返回结果。
  void persist(task.record).catch(cause => console.error("媒体任务落盘失败", task.record.taskId, cause));
}

// 仅存于磁盘的记录（重启后）标记终态：写前重读最新状态，终态不覆盖。
async function settleDisk(cwd: string, taskId: string, state: "failed" | "cancelled" | "interrupted", result: ApiResponse<GeneratedMedia[]>) {
  await serialize(taskId, async () => {
    // 内存任务由其所有者落定；此处只处理仅存于磁盘的记录，避免覆盖运行中任务。
    if (tasks.has(taskId)) return;
    const record = await readRecord(cwd, taskId);
    if (!record || record.cwd !== cwd || terminalStates.has(record.state)) return;
    Object.assign(record, { state, result, settledAt: Date.now() });
    await persist(record);
  });
}

function stop(task: MediaTask, message: string) {
  if (terminalStates.has(task.record.state)) return;
  task.controller.abort(new Error(message));
  settle(task, "cancelled", error<GeneratedMedia[]>(message, null, 499));
}

function cleanup() {
  const now = Date.now();
  for (const [taskId, task] of tasks) {
    if (task.record.settledAt !== undefined && task.record.settledAt + 300000 <= now) tasks.delete(taskId);
  }
}

// 续跑去重：覆盖「重读磁盘 → 加入内存」之间的异步窗口，避免多窗口/重复 status 重复恢复。
const resuming = new Set<string>();
function triggerResume(record: MediaTaskRecord) {
  if (resuming.has(record.taskId) || tasks.has(record.taskId)) return;
  resuming.add(record.taskId);
  void (async () => {
    try {
      // 认领与 cancel/status 落盘串行：重读磁盘确认仍 submitted；认领后内存接管，取消改走 stop。
      const claimed = await serialize(record.taskId, async () => {
        const latest = await readRecord(record.cwd, record.taskId);
        if (!latest || latest.cwd !== record.cwd || latest.state !== "submitted" || !latest.remoteTaskId || latest.deadline <= Date.now() || tasks.has(record.taskId)) return null;
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(latest.deadline - Date.now())]);
        const task: MediaTask = { record: latest, controller };
        tasks.set(record.taskId, task);
        return { task, signal, latest, remoteTaskId: latest.remoteTaskId };
      });
      if (!claimed) return;
      const { task, signal, latest, remoteTaskId } = claimed;
      try {
        const files = await resumeMedia({ ...latest, remoteTaskId }, signal);
        if (files === null) {
          // 供应商不支持续跑：移出内存并标中断。
          tasks.delete(record.taskId);
          await settleDisk(record.cwd, record.taskId, "interrupted", error<GeneratedMedia[]>("任务已中断（可能已提交）", null, 499));
        } else {
          settle(task, "succeeded", success(files));
        }
      } catch (cause) {
        settle(task, "failed", { ...errorFromCause(cause), data: null });
      }
    } catch (cause) {
      console.error("媒体任务续跑失败", record.taskId, cause);
    } finally {
      resuming.delete(record.taskId);
    }
  })();
}

// 扫描全部工作区记录：终态超 7 天清理；interruptActive 时把仍活跃的记录标为超时/中断或触发续跑（启动恢复）。
async function scanRecords(interruptActive: boolean) {
  const root = join(dirname(conf.path), "mediaTasks");
  const now = Date.now();
  for (const directory of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!directory.isDirectory()) continue;
    const folder = join(root, directory.name);
    for (const file of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const path = join(folder, file.name);
      const record = await readFile(path, "utf8").then(text => JSON.parse(text) as MediaTaskRecord).catch(() => null);
      if (!record || typeof record.cwd !== "string" || !taskStates.has(record.state) || tasks.has(record.taskId)) continue;
      if (terminalStates.has(record.state)) {
        if (record.settledAt !== undefined && record.settledAt + 7 * 86400000 <= now) await unlink(path).catch(() => {});
      } else if (interruptActive) {
        const timeout = record.deadline <= now;
        if (timeout) {
          await settleDisk(record.cwd, record.taskId, "failed", error<GeneratedMedia[]>("生成超时", null, 500))
            .catch(cause => console.error("媒体任务扫描失败", path, cause));
        } else if (record.state === "submitted" && record.remoteTaskId) {
          triggerResume(record);
        } else {
          await settleDisk(record.cwd, record.taskId, "interrupted", error<GeneratedMedia[]>("任务已中断（可能已提交）", null, 499))
            .catch(cause => console.error("媒体任务扫描失败", path, cause));
        }
      }
    }
  }
}

export async function start(cwd: string, taskId: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest) {
  cleanup();
  if (tasks.has(taskId)) throw Object.assign(new Error("生成任务已存在，请勿重复提交"), { status: 409 });
  // 最多 1000 个任务；取消后仍等待生成 Promise 收尾，避免忽略取消的供应商绕过上限。
  if (tasks.size >= 1000) throw Object.assign(new Error("生成任务过多，请稍后重试"), { status: 429 });
  const createdAt = Date.now();
  const record: MediaTaskRecord = {
    taskId, cwd, mediaType, providerId: request.providerId, modelId: request.modelId,
    outputDirectory: request.outputDirectory ?? "assets/generated",
    state: "created", createdAt, deadline: createdAt + taskDuration,
  };
  const task: MediaTask = { record, controller: new AbortController() };
  // exclusive 落盘即原子去重（EEXIST→409），并与认领/落盘串行，避免先检查再覆盖的竞态。
  await serialize(taskId, async () => {
    const path = recordPath(cwd, taskId);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeAtomic(path, JSON.stringify(record), { exclusive: true, mode: 0o600 });
    } catch (cause) {
      if ((cause as { code?: string }).code === "EEXIST") throw Object.assign(new Error("生成任务已存在，请勿重复提交"), { status: 409 });
      throw cause;
    }
    tasks.set(taskId, task);
  });
  void generateMedia(cwd, mediaType, request, task.controller.signal, {
    onSubmitted: async remoteTaskId => {
      if (task.record.state !== "created") return;
      task.record.state = "submitted";
      task.record.remoteTaskId = remoteTaskId;
      // 落盘失败仅降级为「重启后按中断处理」，不中止已提交、已计费的远程任务。
      await persist(task.record).catch(cause => console.error("媒体任务落盘失败", task.record.taskId, cause));
    },
  }).then(
    files => settle(task, "succeeded", success(files)),
    cause => settle(task, "failed", { ...errorFromCause(cause), data: null }),
  );
}

export async function status(cwd: string, taskIds: string[]) {
  cleanup();
  return Promise.all(taskIds.map(async taskId => {
    const task = tasks.get(taskId);
    if (task && task.record.cwd === cwd) return { taskId, ...(task.record.result ? { result: task.record.result } : {}) };
    const record = await readRecord(cwd, taskId);
    if (!record || record.cwd !== cwd) return { taskId, result: error<GeneratedMedia[]>("生成任务不存在或已过期", null, 404) };
    // 读盘期间任务可能已被 start/续跑认领，复查内存避免把运行中任务误标中断。
    const live = tasks.get(taskId);
    if (live && live.record.cwd === cwd) return { taskId, ...(live.record.result ? { result: live.record.result } : {}) };
    if (!terminalStates.has(record.state)) {
      // 磁盘上仍活跃说明所属进程已不在：可续跑的触发恢复，其余标终态。
      const timeout = record.deadline <= Date.now();
      if (timeout) {
        const result = error<GeneratedMedia[]>("生成超时", null, 500);
        await settleDisk(cwd, taskId, "failed", result).catch(() => {});
        return { taskId, result };
      }
      if (record.state === "submitted" && record.remoteTaskId) {
        triggerResume(record);
        return { taskId };
      }
      const result = error<GeneratedMedia[]>("任务已中断（可能已提交）", null, 499);
      await settleDisk(cwd, taskId, "interrupted", result).catch(() => {});
      return { taskId, result };
    }
    return { taskId, result: record.result ?? error<GeneratedMedia[]>("任务记录损坏", null, 500) };
  }));
}

export async function cancel(cwd: string, taskIds: string[]) {
  for (const taskId of taskIds) {
    const task = tasks.get(taskId);
    if (task && task.record.cwd === cwd) { stop(task, "生成已取消"); continue; }
    await settleDisk(cwd, taskId, "cancelled", error<GeneratedMedia[]>("生成已取消", null, 499));
  }
}

let cleanupTicks = 0;
const cleanupTimer = setInterval(() => {
  cleanup();
  if (++cleanupTicks % 120 === 0) void scanRecords(false);
}, 30000);
cleanupTimer.unref();
// 启动扫描延迟几秒等待应用初始化；活跃记录标中断/超时，可续跑的 submitted 触发恢复。
setTimeout(() => void scanRecords(true), 3000).unref();
