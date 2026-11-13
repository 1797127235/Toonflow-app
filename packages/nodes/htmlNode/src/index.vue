<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    :downloadUrl="downloadUrl"
    :downloadName="`${nodeProps.label || 'html'}.html`"
    @fullscreen="fullscreen = true; editing = true">
    <div class="htmlContent" :class="{ interactive }">
      <el-alert v-if="documentState.error" :title="documentState.error" type="error" :closable="false" showIcon />
      <iframe
        v-if="outputs.html.value.trim()"
        class="preview"
        :sandbox="sandbox"
        :srcdoc="previewSource"
        :title="`${nodeProps.label || 'HTML'} 预览`"
        referrerpolicy="no-referrer" />
      <div v-else class="emptyPreview">暂无内容，点击编辑输入 HTML 或 SVG</div>
      <el-button class="editButton nodrag nopan" :icon="IconEdit" :disabled="!htmlReady" text @dblclick.stop @click.stop="openEditor">编辑</el-button>
    </div>
    <template #topActions>
      <el-button :icon="IconPointer" :type="interactive ? 'primary' : 'default'" text :disabled="!outputs.html.value.trim()" title="允许在预览中交互" @click.stop="interactive = !interactive">
        {{ interactive ? "交互中" : "允许交互" }}
      </el-button>
    </template>
  </nodeSkeleton>
  <el-dialog v-model="editing" title="编辑 HTML / SVG" width="min(1080px, calc(100vw - 32px))" :fullscreen="fullscreen" alignCenter appendToBody @closed="fullscreen = false">
    <div class="editorBody" :class="{ fullscreen }">
      <textarea v-model="draft" class="sourceEditor" spellcheck="false" aria-label="HTML 或 SVG 源码" />
      <iframe class="editorPreview" :sandbox="sandbox" :srcdoc="toDocument(previewDoc)" title="编辑预览" referrerpolicy="no-referrer" />
    </div>
    <template #footer>
      <el-button @click="editing = false">取消</el-button>
      <el-button type="primary" :loading="applying" :disabled="!htmlReady" @click="applyDraft">应用</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import { ElAlert, ElButton, ElDialog, ElMessage } from "element-plus";
import { IconCode, IconEdit, IconPointer } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { useNodeDocumentState, type NodeDocumentContext } from "@toonflow/nodes-scaffold/nodeDocument";

defineOptions({
  inheritAttrs: false,
  icon: IconCode,
  handles: [
    { id: "html", type: "source", dataType: "STRING", label: "HTML / SVG 源码" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, files, nodeEvent } = useNode({
  label: "HTML / SVG",
  outputs: { html: { dataType: "STRING", value: "" } },
});
const sandbox = "allow-scripts allow-forms allow-modals allow-popups";
// 裸 SVG 片段在 HTML 里默认 300×150 且贴左上角，包一层容器按卡片尺寸居中缩放；完整 HTML 文档原样渲染。
function toDocument(source: string) {
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(source)) return source;
  return `<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center}svg{width:100%;height:100%}</style></head><body>${source}</body></html>`;
}
const documentState = useNodeDocumentState();
const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
const editing = ref(false);
const fullscreen = ref(false);
const applying = ref(false);
const interactive = ref(false);
const draft = ref("");
const previewDoc = ref("");
const downloadUrl = ref("");
const previewSource = computed(() => toDocument(outputs.value.html.value));
const htmlPath = `assets/${node.id}/content.html`;
let frameTimer: number | undefined;
const data = computed(() => node.data as typeof node.data & { htmlPath?: string; htmlSnapshot?: string });
const htmlReady = ref(false);
let htmlFiles: ReturnType<typeof files.getWorkspaceFiles>;
let htmlLoading: Promise<void> | undefined;
let htmlSaving = Promise.resolve();
let htmlSnapshot: Awaited<ReturnType<typeof htmlFiles.readTextSnapshot>> | undefined;
let htmlRevision = 0;

watch([() => outputs.value.html.value, () => node.selected || !!documentContext?.targets.has(node.id)], ([html, visible], _previous, onCleanup) => {
  downloadUrl.value = "";
  if (!visible || !html.trim()) return;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  downloadUrl.value = url;
  onCleanup(() => URL.revokeObjectURL(url));
}, { immediate: true });
watch(() => node.selected, selected => { if (!selected) interactive.value = false; });
watch(draft, value => {
  window.clearTimeout(frameTimer);
  frameTimer = window.setTimeout(() => { previewDoc.value = value; }, 350);
});

function saveHtml(value: string) {
  const revision = ++htmlRevision;
  documentState.dirty = true;
  htmlSaving = htmlSaving.catch(() => {}).then(async () => {
    if (!htmlSnapshot) throw new Error("内容尚未加载，无法保存");
    htmlSnapshot.revision = await htmlFiles.writeTextSnapshot(htmlPath, value, htmlSnapshot);
    htmlSnapshot.text = value;
    if (revision === htmlRevision && outputs.value.html.value === value) {
      documentState.dirty = false;
      documentState.error = "";
    }
  }).catch(error => {
    documentState.error = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      || (error instanceof Error ? error.message : "内容保存失败");
    throw error;
  });
  return htmlSaving;
}

watch(() => outputs.value.html.value, async value => {
  if (!htmlReady.value) return;
  documentState.dirty = true;
  try { await saveHtml(value); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "内容保存失败"); }
}, { flush: "sync" });

nodeEvent.on("save", async () => {
  await htmlLoading;
  if (!htmlReady.value) throw new Error("内容尚未加载，无法保存");
  let pending: Promise<void>;
  do {
    pending = htmlSaving;
    try { await pending; }
    catch { await saveHtml(outputs.value.html.value); }
  } while (pending !== htmlSaving);
});
nodeEvent.on("copy", () => {
  if (!htmlReady.value) throw new Error("内容尚未加载");
  return { htmlPath: undefined, htmlSnapshot: outputs.value.html.value };
});

function openEditor() {
  if (!htmlReady.value) return;
  draft.value = outputs.value.html.value;
  previewDoc.value = draft.value;
  editing.value = true;
}

async function applyDraft() {
  if (!htmlReady.value) return;
  applying.value = true;
  try {
    if (draft.value !== outputs.value.html.value) {
      outputs.value.html.value = draft.value;
      await htmlSaving;
    }
    editing.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "内容保存失败");
  } finally {
    applying.value = false;
  }
}

onMounted(() => { htmlLoading = loadHtml(); });

async function loadHtml() {
  htmlReady.value = false;
  try {
    if (!node.id || /[\\/]/.test(node.id) || node.id === "." || node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
    if (data.value.htmlPath !== undefined && data.value.htmlPath !== htmlPath) throw new Error("HTML 文件路径无效");
    htmlFiles = files.getWorkspaceFiles();
    if (data.value.htmlPath) htmlSnapshot = await htmlFiles.readTextSnapshot(htmlPath);
    const value = data.value.htmlSnapshot !== undefined ? String(data.value.htmlSnapshot) : htmlSnapshot?.text ?? outputs.value.html.value;
    if (!data.value.htmlPath) {
      for (const directory of ["assets", `assets/${node.id}`]) {
        await htmlFiles.mkdir(directory).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
          if (error.response?.data?.data?.code !== "EEXIST") throw error;
        });
      }
      await htmlFiles.write(htmlPath, value, true).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
      htmlSnapshot = await htmlFiles.readTextSnapshot(htmlPath);
      if (htmlSnapshot.text !== value) throw new Error("HTML 文件已存在且内容不同，请使用其他节点 ID");
    } else if (htmlSnapshot && htmlSnapshot.text !== value) {
      htmlSnapshot.revision = await htmlFiles.writeTextSnapshot(htmlPath, value, htmlSnapshot);
      htmlSnapshot.text = value;
    }
    outputs.value.html.value = value;
    data.value.htmlPath = htmlPath;
    delete data.value.htmlSnapshot;
    // 成功落盘后才排除内联正文；迁移失败时画布仍保留原内容。
    if (!Object.hasOwn(outputs.value, "toJSON")) Object.defineProperty(outputs.value, "toJSON", { value: () => ({}) });
    htmlSaving = Promise.resolve();
    htmlReady.value = true;
    documentState.dirty = false;
    documentState.error = "";
  } catch (error) {
    documentState.error = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      || (error instanceof Error ? error.message : "内容加载失败");
    ElMessage.error(documentState.error);
  }
}

nodeTools.register({
  name: "getHtml",
  description: "读取此节点的 HTML / SVG 源码",
  parameters: z.strictObject({}),
  execute() {
    if (!htmlReady.value) throw new Error("内容尚未加载");
    return { html: outputs.value.html.value };
  },
});
nodeTools.register({
  name: "setHtml",
  description: "整段替换此节点的 HTML / SVG 源码",
  parameters: z.strictObject({ html: z.string() }),
  async execute({ html }) {
    if (!htmlReady.value) throw new Error("内容尚未加载");
    outputs.value.html.value = html;
    await htmlSaving;
    return { html };
  },
});
nodeTools.register({
  name: "replaceHtml",
  description: "在 HTML / SVG 源码中替换一段文本，find 必须在源码中只出现一次",
  parameters: z.strictObject({ find: z.string().min(1), replace: z.string() }),
  async execute({ find, replace }) {
    if (!htmlReady.value) throw new Error("内容尚未加载");
    const source = outputs.value.html.value;
    const index = source.indexOf(find);
    if (index < 0) throw new Error("源码中未找到要替换的内容");
    if (source.indexOf(find, index + find.length) >= 0) throw new Error("要替换的内容出现多次，请提供更长的唯一片段");
    const html = source.slice(0, index) + replace + source.slice(index + find.length);
    outputs.value.html.value = html;
    await htmlSaving;
    return { html, replaced: 1 };
  },
});
</script>

<style lang="scss" scoped>
.htmlContent {
  position: relative;
  width: 420px;

  .preview {
    display: block;
    width: 100%;
    height: 280px;
    border: 1px solid var(--el-border-color);
    border-radius: 6px;
    background: #fff;
    pointer-events: none;
  }

  &.interactive .preview {
    pointer-events: auto;
  }

  .emptyPreview {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 120px;
    padding: 0 16px;
    border: 1px dashed var(--el-border-color);
    border-radius: 6px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    text-align: center;
  }

  .editButton {
    position: absolute;
    top: 6px;
    right: 6px;
    margin: 0;
  }
}

.editorBody {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  height: min(60vh, 620px);

  &.fullscreen {
    height: calc(100dvh - 160px);
  }

  .sourceEditor {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 10px 12px;
    border: 1px solid var(--el-border-color);
    border-radius: 6px;
    background: var(--el-fill-color-blank);
    color: var(--el-text-color-primary);
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    resize: none;
    outline: none;
  }

  .sourceEditor:focus {
    border-color: var(--el-color-primary);
  }

  .editorPreview {
    width: 100%;
    height: 100%;
    border: 1px solid var(--el-border-color);
    border-radius: 6px;
    background: #fff;
  }
}
</style>