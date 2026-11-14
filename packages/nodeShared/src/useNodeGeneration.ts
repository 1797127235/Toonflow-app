import { computed, ref, type Ref } from "vue";
import { ElNotification } from "element-plus";
import { nodeTools, z } from "@toonflow/nodes-scaffold/nodeTools";
import type { NodeOutputs } from "@toonflow/nodes-scaffold/values";
import { showNodeError } from "./showNodeError";

type MediaFile = { path: string; mimeType: string; mediaType: string };
type NodeGenerationMedia = {
  data: { value: { pendingTaskId?: string } };
  watch: (directory: string, taskId: string, signal?: AbortSignal, stall?: (stalled: boolean) => void) => Promise<MediaFile[]>;
  cancelTask: (directory: string, taskId: string) => Promise<void>;
  directory: () => Promise<string>;
  flush: () => Promise<void>;
  apply: (files: MediaFile[]) => void;
};

export function useNodeGeneration(outputs: Readonly<Ref<NodeOutputs>>, cancel: () => void, media?: NodeGenerationMedia) {
  const status = ref<"idle" | "running" | "succeeded" | "failed">("idle");
  const error = ref("");
  const stalled = ref(false);
  const generating = computed(() => status.value === "running");
  const getStatus = () => ({ status: status.value, outputs: outputs.value, ...(error.value ? { error: error.value } : {}) });

  async function run<T>(task: () => Promise<T>): Promise<T> {
    if (generating.value) throw new Error("节点正在生成，请等待完成");
    status.value = "running";
    error.value = "";
    try {
      const result = await task();
      status.value = "succeeded";
      if (media) media.data.value.pendingTaskId = undefined;
      return result;
    } catch (failure) {
      // 卸载/切画布 detach 保留 pendingTaskId 以便接回；显式停止已先清字段，终态失败清字段不重试。
      const aborted = (failure as Error)?.name === "AbortError";
      status.value = aborted ? "idle" : "failed";
      if (!aborted) {
        if (media) media.data.value.pendingTaskId = undefined;
        const message = (failure as { response?: { data?: { message?: string } } })?.response?.data?.message;
        error.value = message || (failure instanceof Error ? failure.message : "生成失败");
      }
      throw failure;
    }
  }

  // 提交前把 taskId 写进节点数据并 flush 画布，刷新后才能凭此接回；flush 失败则中止提交。
  async function onTaskId(taskId: string) {
    if (!media) return;
    media.data.value.pendingTaskId = taskId;
    await media.flush();
  }

  // 挂载时凭 pendingTaskId 接回已提交任务：成功回填清字段，终态失败清字段不重试，卸载 detach 保留字段。
  async function reconnect(signal: AbortSignal) {
    if (!media) return;
    const taskId = media.data.value.pendingTaskId;
    if (!taskId || generating.value) return;
    status.value = "running";
    error.value = "";
    try {
      const directory = await media.directory();
      const files = await media.watch(directory, taskId, signal, value => { stalled.value = value; });
      media.apply(files);
      media.data.value.pendingTaskId = undefined;
      status.value = "succeeded";
    } catch (failure) {
      const aborted = (failure as Error)?.name === "AbortError";
      status.value = aborted ? "idle" : "failed";
      if (!aborted) {
        media.data.value.pendingTaskId = undefined;
        error.value = failure instanceof Error ? failure.message : "生成失败";
      }
      throw failure;
    } finally {
      stalled.value = false;
    }
  }

  // 显式停止：清字段、detach 等待并取消服务端任务；现有供应商上游无取消接口，远程任务可能继续计费。
  function stop() {
    const taskId = media?.data.value.pendingTaskId;
    const wasGenerating = generating.value;
    if (media) media.data.value.pendingTaskId = undefined;
    cancel();
    if (wasGenerating) ElNotification({ title: "已停止生成", message: "远程任务可能继续计费。", type: "warning", duration: 5000 });
    if (media && taskId) {
      void media.directory()
        .then(directory => media.cancelTask(directory, taskId))
        .catch(error => showNodeError(error, "停止请求发送失败，远程任务可能继续计费"));
    }
  }

  nodeTools.register({
    name: "getGenerationStatus",
    description: "查询本次打开节点后的生成状态（idle/running/succeeded/failed）、当前输出和最近一次生成错误。当前输出可能来自之前的生成；idle 不表示没有历史输出，只有 succeeded 表示本次生成成功",
    parameters: z.strictObject({}),
    execute: getStatus,
  });
  nodeTools.register({
    name: "cancelGeneration",
    description: "请求停止当前后台生成；cancellationRequested 表示已发出停止请求，随后用 getGenerationStatus 查询终止状态。不会删除已有输出，不能保证供应商撤销任务或费用",
    parameters: z.strictObject({}),
    execute() {
      const cancellationRequested = generating.value;
      if (cancellationRequested) stop();
      return { ...getStatus(), cancellationRequested };
    },
  });

  return { generating, stalled, run, onTaskId, reconnect, stop };
}
