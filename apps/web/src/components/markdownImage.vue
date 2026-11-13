<template>
  <component v-if="error" :is="UI.ErrorComponent" variant="image" :message="error" />
  <component v-else-if="pending" :is="UI.Spin" />
  <component v-else :is="COMPONENT_RENDERERS.image" :key="directory + image.node.url" v-bind="image" :node="resolvedNode" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import { COMPONENT_RENDERERS, UI, useContext, type ImageNodeRendererProps } from "vue-stream-markdown";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const props = defineProps<{ image: ImageNodeRendererProps; directory: string }>();
const imageUrl = ref("");
const error = ref("");
const remoteImage = computed(() => /^(?:https?:)?\/\//i.test(props.image.node.url));
const workspaceImage = computed(() => remoteImage.value || (!!props.image.node.url && !/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(props.image.node.url)));
// 工作区图在拿到 blob 前不要把空 url 交给库；库把「无 url」当成永久 loading。
const pending = computed(() => workspaceImage.value && !imageUrl.value && !error.value);
const resolvedNode = computed(() => workspaceImage.value
  ? { ...props.image.node, url: imageUrl.value, loading: false }
  : props.image.node);
const { parsedNodes, provideContext } = useContext();
// 落盘图片按单张预览；多图切换需集中维护解析后的地址，避免重新请求原网址或相对路径。
provideContext({ parsedNodes: computed(() => workspaceImage.value ? [resolvedNode.value] : parsedNodes.value) });

function preloadImage(url: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const image = new Image();
    const stop = () => {
      image.onload = null;
      image.onerror = null;
      image.src = "";
    };
    const onAbort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    image.onload = () => {
      signal.removeEventListener("abort", onAbort);
      stop();
      resolve();
    };
    image.onerror = () => {
      signal.removeEventListener("abort", onAbort);
      stop();
      reject(new Error("图片预览失败"));
    };
    image.src = url;
  });
}

// 流式未闭合时允许暂时无地址；静态空地址不再交给库转圈。
watch(() => !props.image.node.url && !props.image.node.loading, invalid => {
  if (invalid) error.value = "图片地址无效";
}, { immediate: true });

watch([() => props.directory, () => props.image.node.url] as const, async ([directory, url], _previous, onCleanup) => {
  imageUrl.value = "";
  if (!url || !workspaceImage.value) return;
  error.value = "";
  // 即使 AST 仍标 loading，只要 url 已完整就解析；勿因 loading 标志永久跳过取图。
  let cancelled = false;
  let release = () => {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("图片读取超时")), 60_000);
  onCleanup(() => {
    cancelled = true;
    clearTimeout(timer);
    controller.abort();
    release();
  });
  try {
    const files = useWorkspaceFiles(directory);
    const saved = remoteImage.value ? await files.importImage(url.startsWith("//") ? `https:${url}` : url) : undefined;
    if (cancelled) return;
    const path = saved?.path ?? decodeURIComponent(url.split(/[?#]/, 1)[0]!);
    const preview = files.acquireUrl(path, saved?.mimeType);
    release = preview.release;
    const resolvedUrl = await Promise.race([
      preview.url,
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason ?? new Error("图片读取超时"));
        else controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("图片读取超时")), { once: true });
      }),
    ]);
    await preloadImage(resolvedUrl, controller.signal);
    if (!cancelled) imageUrl.value = resolvedUrl;
  } catch (cause) {
    if (cancelled) return;
    error.value = axios.isAxiosError<{ message?: string }>(cause)
      ? cause.response?.data?.message || "图片保存或读取失败"
      : cause instanceof Error ? cause.message : "图片保存或读取失败";
  } finally {
    clearTimeout(timer);
  }
}, { immediate: true });
</script>
