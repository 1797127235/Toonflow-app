<template>
  <component v-if="error" :is="UI.ErrorComponent" variant="image" :message="error" />
  <component v-else-if="pending || (!displayUrl && image.node.loading)" :is="UI.Spin" />
  <img v-else-if="displayUrl" class="chatImage" :src="displayUrl" :alt="image.node.alt || image.node.title || ''" @error="error = '图片预览失败'" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import { UI, type ImageNodeRendererProps } from "vue-stream-markdown";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const imageMimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
};

const props = defineProps<{ image: ImageNodeRendererProps; directory: string }>();
const imageUrl = ref("");
const error = ref("");
const remoteImage = computed(() => /^(?:https?:)?\/\//i.test(props.image.node.url));
const workspaceImage = computed(() => remoteImage.value || (!!props.image.node.url && !/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(props.image.node.url)));
// 工作区图在拿到 blob 前不要把空 url 交给库；库把「无 url」当成永久 loading。
const pending = computed(() => workspaceImage.value && !imageUrl.value && !error.value);
const displayUrl = computed(() => workspaceImage.value ? imageUrl.value : props.image.node.url);

function imageMimeType(path: string) {
  const extension = path.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase() ?? "";
  return imageMimeTypes[extension];
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
    const preview = files.acquireUrl(path, saved?.mimeType ?? imageMimeType(path));
    release = preview.release;
    // 同一轮读取已经完成时直接显示，避免虚拟列表重新挂载后又从转圈开始。
    if (preview.ready) {
      imageUrl.value = preview.ready;
      return;
    }
    const resolvedUrl = await Promise.race([
      preview.url,
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason ?? new Error("图片读取超时"));
        else controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("图片读取超时")), { once: true });
      }),
    ]);
    // 不在文档外的 Image 上等待解码。虚拟列表里的懒加载图也不会触发 load，转圈就停住。
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

<style scoped lang="scss">
.chatImage {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 8px 0;
  border-radius: 8px;
}
</style>
