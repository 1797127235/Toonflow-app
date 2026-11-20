<template>
  <assetBrowser v-if="visible && expanded" :key="treeVersion" v-model:folder="folder" v-model:searchQuery="searchQuery" v-model:newFolderName="newFolderName" :sources="sources" :groups="groups" :entries="displayEntries" :results="results" :searchTotal="searchTotal" :loading="loading" :newFolderParent="newFolderParent" :folderSaving="folderSaving" :mediaKind="mediaKind" :assetUrl="assetUrl" :loadLayer="loadLayer" @startFolder="startFolder" @saveFolder="saveFolder" @cancelFolder="cancelFolder" @preview="openPreview" @menu="openItemMenu" @drag="startAssetDrag" />
  <el-card v-else-if="visible" class="assetLibrary" shadow="never" :style="{ width: `${drawerWidth}px` }" :bodyStyle="{ padding: '8px' }" role="region" aria-label="素材库" @dblclick.stop>
    <div class="libraryToolbar">
      <el-input v-model="searchQuery" class="searchInput" :prefixIcon="IconSearch" placeholder="搜索全部素材库" aria-label="搜索素材" clearable @keydown.esc.stop="searchQuery = ''" />
      <el-button v-if="!readOnlyFolder" class="toolbarButton" text :icon="IconFolderPlus" title="新建文件夹" aria-label="新建文件夹" :disabled="newFolderParent !== undefined" @click="startFolder" />
      <el-button class="toolbarButton" text :icon="IconX" title="关闭素材库" aria-label="关闭素材库" @click="visible = false" />
    </div>
    <div v-if="newFolderParent !== undefined" class="newFolderRow">
      <el-input ref="folderInput" v-model="newFolderName" class="folderNameInput" size="small" aria-label="新文件夹名称" placeholder="新文件夹名称" :disabled="folderSaving" @keydown.enter.prevent="saveFolder" @keydown.esc.prevent="cancelFolder" />
      <el-button size="small" type="primary" :loading="folderSaving" :disabled="!newFolderName.trim()" @click="saveFolder">创建</el-button>
      <el-button size="small" text :disabled="folderSaving" @click="cancelFolder">取消</el-button>
    </div>
    <div class="sourceTabs" role="tablist" aria-label="切换素材库">
      <button v-for="item in sources" :key="item.id" class="sourceTab" :class="{ active: sourceId === item.id }" type="button" role="tab" :aria-selected="sourceId === item.id" @click="sourceId = item.id">{{ item.label }}</button>
    </div>
    <div v-if="!searchQuery.trim() && canGoUp" class="folderTrail">
      <button class="upButton" type="button" @click="goUp">‹ 上级</button>
    </div>
    <div v-if="!searchQuery.trim() && chips.length > 6" class="chipSelectRow">
      <el-select v-model="activeGroup" class="chipSelect" filterable placeholder="全部分类" @change="onGroupSelect">
        <el-option label="全部分类" value="all" />
        <el-option v-for="item in chips" :key="item.path" :label="`${item.name}　${item.count ?? 0}`" :value="item.name" />
      </el-select>
    </div>
    <div v-else-if="!searchQuery.trim() && chips.length" class="gridChips" @wheel="onChipsWheel">
      <button v-for="item in chips" :key="item.path" class="gridChip" :class="{ active: isRemoteLayer && activeGroup === item.name }" type="button" @click="selectChip(item.name, item.path, $event)">
        {{ item.name }}<span v-if="item.count" class="chipCount">{{ item.count }}</span>
      </button>
    </div>
    <el-scrollbar ref="libraryScrollRef" class="libraryScroll" @scroll="onLibraryScroll">
      <div v-if="searchQuery.trim()" class="searchResults">
        <div v-for="item in results" :key="item.path" class="assetEntry" :title="item.name" draggable="true" @dragstart.stop="startAssetDrag($event, item)" @dblclick.stop="openPreview(item)" @contextmenu="openItemMenu($event, item)">
          <el-image class="assetThumbnail" :src="assetUrl(item.thumbPath ?? item.path)" fit="cover" loading="lazy" draggable="false" @click.stop="openPreview(item)">
            <template #error><icon-photo :size="18" /></template>
          </el-image>
          <span class="assetName">{{ item.name }}</span>
          <span class="sourceTag">{{ item.sourceLabel }}</span>
        </div>
        <div v-if="searching && !results.length" class="searchEmpty">正在搜索…</div>
        <div v-else-if="!results.length" class="searchEmpty">没有找到匹配的素材</div>
        <div v-else-if="searchTotal > results.length" class="searchEmpty">找到 {{ searchTotal }} 条，显示前 {{ results.length }} 条</div>
      </div>
      <template v-else>
        <div class="gridBody">
          <div v-for="item in gridEntries" :key="item.path" class="gridCard" :title="item.name" draggable="true" @dragstart.stop="startAssetDrag($event, item)" @dblclick.stop="openPreview(item)" @contextmenu="openItemMenu($event, item)">
            <el-image class="gridThumb" :src="assetUrl(item.thumbPath ?? item.path)" fit="cover" loading="lazy" draggable="false">
              <template #error><icon-photo :size="16" /></template>
            </el-image>
            <span class="gridName">{{ displayName(item) }}</span>
          </div>
          <div v-if="!gridEntries.length" class="gridEmpty">
            <span>{{ isRemoteLayer ? "这个分类里没有图片" : "这个文件夹是空的" }}</span>
            <span v-if="!isRemoteLayer" class="gridEmptyHint">切到上方的姿势库、服装穿搭库或人像库看看</span>
          </div>
        </div>
      </template>
    </el-scrollbar>
    <div class="statusBar">
      <span class="statusCount">{{ searchQuery.trim() ? `${results.length} / ${searchTotal} 条结果` : `${gridEntries.length} / ${gridTotal} 个素材` }}</span>
      <span v-if="sourceReadOnly" class="readOnlyTag">只读</span>
    </div>
    <div class="drawerHandle" role="separator" aria-label="拖动调整素材库宽度" @mousedown.prevent="startResize" />
    <div v-if="previewAsset?.kind === 'audio'" class="audioPreview">
      <div class="audioHeader">
        <span :title="previewAsset.name">{{ previewAsset.name }}</span>
        <el-button text :icon="IconX" aria-label="关闭音频预览" @click="previewAsset = undefined" />
      </div>
      <el-alert v-if="previewError" :title="previewError" type="error" :closable="false" showIcon />
      <audio v-else :key="previewAsset.url" :src="previewAsset.url" :aria-label="previewAsset.name" controls preload="metadata" @error="previewError = '音频无法播放，文件可能已损坏或当前浏览器不支持其编码。'" />
    </div>
  </el-card>

  <assetMenu v-if="visible" ref="assetMenuRef" :entries="menuEntries" @changed="refreshAssets" />

  <el-image-viewer v-if="previewAsset?.kind === 'image'" :urlList="[previewAsset.url]" teleported @close="previewAsset = undefined" />

  <el-dialog :modelValue="previewAsset?.kind === 'video'" :title="previewAsset?.name" width="min(800px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose @update:modelValue="previewAsset = undefined">
    <div v-if="previewAsset?.kind === 'video'" class="assetPreview">
      <el-alert v-if="previewError" :title="previewError" type="error" :closable="false" showIcon />
      <video v-else :key="previewAsset.url" class="previewVideo" :src="previewAsset.url" :aria-label="previewAsset.name" controls playsinline preload="metadata" @error="previewError = '视频无法播放，文件可能已损坏或当前浏览器不支持其编码。'" />
    </div>
  </el-dialog>

  <el-dialog v-if="expanded" :modelValue="previewAsset?.kind === 'audio'" :title="previewAsset?.name" width="min(560px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose @update:modelValue="previewAsset = undefined">
    <div v-if="previewAsset?.kind === 'audio'" class="assetPreview">
      <el-alert v-if="previewError" :title="previewError" type="error" :closable="false" showIcon />
      <audio v-else :key="previewAsset.url" class="previewAudio" :src="previewAsset.url" :aria-label="previewAsset.name" controls preload="metadata" @error="previewError = '音频无法播放，文件可能已损坏或当前浏览器不支持其编码。'" />
    </div>
  </el-dialog>

  <el-dialog v-model="saveVisible" title="保存到素材库" width="460px" alignCenter appendToBody :closeOnClickModal="false" @opened="assetNameInput?.select()">
    <el-form class="saveForm" labelPosition="top" @submit.prevent="saveAsset">
      <el-form-item label="素材名称">
        <el-input ref="assetNameInput" v-model="assetName" aria-label="素材名称" placeholder="输入完整文件名" :disabled="saving" @keydown.enter.prevent="saveAsset" />
      </el-form-item>
      <el-form-item v-if="outputs.length > 1" label="节点输出">
        <el-select v-model="selectedOutput" aria-label="节点输出" :disabled="saving">
          <el-option v-for="(item, index) in outputs" :key="index" :label="item.label" :value="index" />
        </el-select>
      </el-form-item>
      <div class="saveLocation">
        <div class="locationHeader">
          <span>保存位置</span>
          <el-button text :icon="IconFolderPlus" :disabled="saving || saveFolderName !== undefined" @click="startSaveFolder">新建文件夹</el-button>
        </div>
        <div class="locationPath" :title="saveLocationLabel">{{ saveLocationLabel }}</div>
        <el-scrollbar class="saveFolderScroll" maxHeight="220px">
          <el-tree class="saveFolderTree" :data="saveTreeData" lazy :load="loadSaveNode" nodeKey="path" :props="treeProps" :icon="IconChevronRight" :currentNodeKey="saveDirectory" :expandOnClickNode="false" highlightCurrent @nodeClick="(entry: AssetEntry) => { if (!saving && saveFolderName === undefined) saveDirectory = entry.path; }">
            <template #default="{ data, node }">
              <span class="saveFolderEntry"><component :is="node.expanded && !node.isLeaf ? IconFolderOpen : IconFolder" :size="18" aria-hidden="true" /><span>{{ data.name }}</span></span>
            </template>
          </el-tree>
        </el-scrollbar>
        <div v-if="saveFolderName !== undefined" class="createFolderRow">
          <el-input ref="saveFolderInput" v-model="saveFolderName" aria-label="新文件夹名称" :disabled="folderSaving" @keydown.enter.prevent="createFolder" @keydown.esc.stop="saveFolderName = undefined" />
          <el-button :loading="folderSaving" :disabled="!saveFolderName.trim()" @click="createFolder">创建</el-button>
          <el-button text :disabled="folderSaving" @click="saveFolderName = undefined">取消</el-button>
        </div>
      </div>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="saveVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!assetName.trim() || /[\\/]/.test(assetName) || saveFolderName !== undefined" @click="saveAsset">保存</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import axios from "axios";
import { ElMessage, ElTree, type InputInstance, type TreeNodeData } from "element-plus";
import { IconChevronRight, IconDots, IconEye, IconFile, IconFolder, IconFolderOpen, IconFolderPlus, IconMusic, IconPhoto, IconSearch, IconVideo, IconX } from "@tabler/icons-vue";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import { mentionAssetType } from "@toonflow/server/agent/mentionSources";
import mentionThumbnail from "@/components/agent/mentionThumbnail.vue";
import { startAssetDrag } from "../canvasDrop";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import assetMenu from "./assetMenu.vue";
import assetBrowser from "./assetBrowser.vue";

type AssetSource = { id: string; label: string; readOnly: boolean; stale?: boolean; multiOrigin?: boolean };
type AssetEntry = { name: string; path: string; type: "file" | "directory"; children?: AssetEntry[]; readOnly?: boolean; thumbPath?: string; stale?: boolean; draft?: boolean; sourceLabel?: string; origin?: string; group?: string; badge?: string; meta?: string; count?: number; variants?: AssetVariant[] };
type AssetVariant = { label: string; path: string; name: string; thumbPath?: string; alternatePath?: string }
type AssetOutput = { label: string; output: NodeOutput };

const props = defineProps<{ directory?: string; expanded?: boolean }>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ width: [value: number] }>();
const saveVisible = ref(false);
const saving = ref(false);
const sources = ref<AssetSource[]>([]);
const groups = ref<AssetEntry[]>([]);
const entries = ref<AssetEntry[]>([]);
const results = ref<AssetEntry[]>([]);
const searchTotal = ref(0);
const searching = ref(false);
const loading = ref(false);
const folder = ref("@local");
const treeVersion = ref(0);
const menuEntries = ref<AssetEntry[]>([]);
const assetName = ref("");
const assetNameInput = ref<InputInstance>();
const saveDirectory = ref("");
const saveFolderName = ref<string>();
const saveFolderInput = ref<InputInstance>();
const saveLocationLabel = computed(() => saveDirectory.value === "" ? "素材库" : `素材库 / ${saveDirectory.value.split("/").join(" / ")}`);
const searchQuery = ref("");
const folderInput = ref<InputInstance>();
const newFolderParent = ref<string>();
const newFolderName = ref("");
const folderSaving = ref(false);
const assetMenuRef = ref<InstanceType<typeof assetMenu>>();
const previewAsset = ref<{ name: string; url: string; kind: "image" | "audio" | "video" }>();
const previewError = ref("");
const treeProps = { label: "name", isLeaf: (data: TreeNodeData) => (data as AssetEntry).type !== "directory" };
const layerCache = new Map<string, AssetEntry[]>();
const layerRequests = new Map<string, Promise<AssetEntry[]>>();
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchRequest = 0;
const activeGroup = ref("all");
const visibleCount = ref(24);
const drawerWidth = ref(360);
const libraryScrollRef = ref<{ wrapRef?: HTMLElement }>();
watch(drawerWidth, value => emit("width", value), { immediate: true });
const groupCache = new Map<string, AssetEntry[]>();
const readOnlyFolder = computed(() => folder.value.startsWith("@") && !folder.value.startsWith("@local"));
function isRemoteSource(path: string) {
  return path.startsWith("@") && !path.startsWith("@local");
}

const sourceId = computed({
  get: () => folder.value.replace(/^@/, "").split("/")[0],
  set: (id: string) => {
    folder.value = `@${id}`;
  },
});

const isRemoteLayer = computed(() => isRemoteSource(folder.value));

const canGoUp = computed(() => {
  const parts = folder.value.replace(/^@/, "").split("/");
  return parts.length > 1;
});

const sourceReadOnly = computed(() => sources.value.find(source => source.id === sourceId.value)?.readOnly === true);

const chips = computed<{ name: string; path: string; count: number }[]>(() => {
  if (!isRemoteLayer.value) {
    return entries.value.filter(entry => entry.type === "directory").map(entry => ({ name: entry.name, path: entry.path, count: entry.count ?? 0 }));
  }
  const counts = new Map<string, number>();
  for (const entry of entries.value) {
    if (entry.group) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, path: `@${sourceId.value}/${name}`, count }));
});
const saveTreeData = ref<AssetEntry[]>([]);

onBeforeUnmount(() => {
  searchRequest++;
  clearTimeout(searchTimer);
});

function assetUrl(path: string) {
  return `/api/assets/read?path=${encodeURIComponent(path)}`;
}

function mediaKind(entry: AssetEntry) {
  if (entry.type !== "file" || entry.draft) return;
  if (/\.(avif|apng|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(entry.name)) return "image";
  if (/\.(mp3|wav|ogg|opus|flac|m4a|aac)$/i.test(entry.name)) return "audio";
  if (/\.(mp4|m4v|webm|mov|mkv|avi|ogv)$/i.test(entry.name)) return "video";
}

function localPath(path: string) {
  if (path === "@local") return "";
  if (path.startsWith("@local/")) return path.slice("@local/".length);
  return path.startsWith("@") ? "" : path;
}

function openPreview(entry: AssetEntry) {
  const kind = mediaKind(entry);
  if (!kind) return;
  previewError.value = "";
  previewAsset.value = { name: entry.name, url: assetUrl(entry.path), kind };
}

async function openItemMenu(event: MouseEvent, entry: AssetEntry) {
  if (entry.draft) return;
  event.preventDefault();
  event.stopPropagation();
  menuEntries.value = [];
  if (!entry.readOnly) {
    try {
      const { data } = await axios.get<{ data: { entries: AssetEntry[] } }>("/api/assets/list", { params: { recursive: "true" } });
      menuEntries.value = data.data.entries;
    } catch (error) {
      showError(error);
    }
  }
  assetMenuRef.value?.openMenu(event, entry);
}

async function fetchLayer(path: string) {
  const cached = layerCache.get(path);
  if (cached) return cached;
  const pending = layerRequests.get(path);
  if (pending) return pending;
  const request = (async () => {
    const { data } = await axios.get<{ data: { entries: AssetEntry[]; sources?: AssetSource[]; groups?: AssetEntry[] } }>("/api/assets/list", {
      params: path ? { path } : {},
    });
    if (!path && data.data.sources) sources.value = data.data.sources;
    if (data.data.groups) { groups.value = data.data.groups; if (path) groupCache.set(path, data.data.groups); }
    layerCache.set(path, data.data.entries);
    return data.data.entries;
  })();
  layerRequests.set(path, request);
  try {
    return await request;
  } finally {
    layerRequests.delete(path);
  }
}

async function loadLayer(path: string) {
  return fetchLayer(path);
}

async function loadSaveNode(node: { level: number; data: TreeNodeData }, resolve: (data: AssetEntry[]) => void) {
  try {
    if (node.level === 0) {
      resolve(saveTreeData.value);
      return;
    }
    const layer = await fetchLayer((node.data as AssetEntry).path);
    resolve(layer.filter(entry => entry.type === "directory"));
  } catch (error) {
    showError(error);
    resolve([]);
  }
}

async function loadFolder() {
  loading.value = true;
  try {
    const layer = await fetchLayer(folder.value === "." ? "" : folder.value);
    entries.value = folder.value === "." ? [] : layer;
  } finally {
    loading.value = false;
  }
}

const displayEntries = computed(() => entries.value);
const folderFiles = computed(() => entries.value.filter(entry => entry.type === "file"));
const gridFiltered = computed(() => (activeGroup.value === "all" ? folderFiles.value : folderFiles.value.filter(entry => entry.group === activeGroup.value)));
const gridTotal = computed(() => gridFiltered.value.length);

function startResize(event: MouseEvent) {
  const startX = event.clientX;
  const startWidth = drawerWidth.value;
  const onMove = (moveEvent: MouseEvent) => {
    drawerWidth.value = Math.min(480, Math.max(320, startWidth + moveEvent.clientX - startX));
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onLibraryScroll({ scrollTop }: { scrollTop: number }) {
  const wrap = libraryScrollRef.value?.wrapRef;
  if (!wrap || gridTotal.value <= gridEntries.value.length) return;
  if (wrap.scrollHeight - scrollTop - wrap.clientHeight > 160) return;
  visibleCount.value += 24;
}
const gridEntries = computed(() => gridFiltered.value.slice(0, visibleCount.value));

watch([gridEntries, loading], async () => {
  if (loading.value) return;
  await nextTick();
  const wrap = libraryScrollRef.value?.wrapRef as HTMLElement | undefined;
  if (!wrap) return;
  if (wrap.scrollHeight > wrap.clientHeight + 24) return;
  if (visibleCount.value >= gridTotal.value) return;
  visibleCount.value += 24;
}, { flush: "post" });


function selectGroup(name: string) {
  activeGroup.value = activeGroup.value === name ? "all" : name;
  visibleCount.value = 24;
}

function displayName(entry: AssetEntry) {
  return entry.name.replace(/\.[^.]+$/, "").replace(/（[^（）]*）$/, "");
}

function refreshAssets() {
  layerCache.clear();
  groupCache.clear();
  treeVersion.value++;
  loadFolder().catch(showError);
}

watch(searchQuery, query => {
  clearTimeout(searchTimer);
  const keyword = query.trim();
  if (!keyword) {
    searchRequest++;
    results.value = [];
    searchTotal.value = 0;
    searching.value = false;
    return;
  }
  searchTimer = setTimeout(() => void runSearch(keyword), 250);
});

async function runSearch(keyword: string) {
  const request = ++searchRequest;
  searching.value = true;
  try {
    const { data } = await axios.get<{ data: { items: AssetEntry[]; total: number } }>("/api/assets/search", {
      params: { q: keyword, limit: 60 },
    });
    if (request === searchRequest) {
      results.value = data.data.items;
      searchTotal.value = data.data.total;
    }
  } catch (error) {
    if (request === searchRequest) showError(error);
  } finally {
    if (request === searchRequest) searching.value = false;
  }
}


async function startFolder() {
  searchQuery.value = "";
  newFolderParent.value = folder.value;
  newFolderName.value = "新建文件夹";
  await nextTick();
  folderInput.value?.select();
}

function cancelFolder() {
  newFolderParent.value = undefined;
}

async function saveFolder() {
  if (newFolderParent.value === undefined || folderSaving.value) return;
  const name = newFolderName.value.trim();
  if (!name) return cancelFolder();
  const parent = localPath(newFolderParent.value);
  folderSaving.value = true;
  try {
    await createAssetFolder(parent, name);
    cancelFolder();
    refreshAssets();
  } catch (error) {
    showError(error);
    await nextTick();
    folderInput.value?.focus();
  } finally {
    folderSaving.value = false;
  }
}

const outputs = ref<AssetOutput[]>([]);
const selectedOutput = ref(0);
let sourceDirectory: string | undefined;
const extension = computed(() => {
  const output = outputs.value[selectedOutput.value]?.output;
  if (!output) return "";
  if (typeof output.value !== "object") return output.dataType === "STRING" ? ".txt" : ".json";
  return output.value.url.match(/\.[^./\\]+$/)?.[0] ?? "";
});

function showError(error: unknown) {
  ElMessage.error(axios.isAxiosError<{ message: string }>(error) ? error.response?.data.message || error.message : (error as Error).message);
}

watch(visible, opened => {
  if (opened) {
    searchQuery.value = "";
    fetchLayer("")
      .then(() => loadFolder())
      .catch(showError);
  } else {
    cancelFolder();
    previewAsset.value = undefined;
  }
}, { immediate: true });

watch(folder, () => {
  activeGroup.value = "all";
  visibleCount.value = 24;
  loadFolder().catch(showError);
});

function chipPathOf(name: string) {
  if (!name || name === "all") return folder.value;
  return chips.value.find(item => item.name === name)?.path ?? folder.value;
}

function onChipsWheel(event: WheelEvent) {
  const el = event.currentTarget as HTMLElement | null;
  if (!el || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  el.scrollLeft += event.deltaY;
  event.preventDefault();
}

// 下拉是单选语义：v-model 已经写入，这里不能再走 selectGroup 的「点同一个取消」逻辑，否则选完立刻回到全部分类。
function onGroupSelect(name: string) {
  activeGroup.value = name || "all";
  visibleCount.value = 24;
}

function selectChip(name: string, path: string, event?: MouseEvent) {
  (event?.currentTarget as HTMLElement | null)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  if (isRemoteLayer.value) {
    selectGroup(name);
    return;
  }
  folder.value = path;
}

function goUp() {
  const parts = folder.value.split("/");
  parts.pop();
  folder.value = parts.join("/") || "@local";
}

async function startSaveFolder() {
  saveFolderName.value = "新建文件夹";
  await nextTick();
  saveFolderInput.value?.select();
}

async function createFolder() {
  const name = saveFolderName.value?.trim();
  if (!name || folderSaving.value) return;
  folderSaving.value = true;
  try {
    const path = await createAssetFolder(saveDirectory.value, name);
    saveDirectory.value = path;
    saveFolderName.value = undefined;
  } catch (error) {
    showError(error);
  } finally {
    folderSaving.value = false;
  }
}

async function createAssetFolder(parent: string, name: string) {
  if (/[\\/]/.test(name)) throw new Error("文件夹名称不能包含斜杠");
  const path = parent === "" ? name : `${parent}/${name}`;
  await axios.post("/api/assets/mkdir", { path });
  return path;
}

async function openSave(label: string, items: AssetOutput[]) {
  outputs.value = items;
  selectedOutput.value = 0;
  assetName.value = label.endsWith(extension.value) ? label : `${label}${extension.value}`;
  saveDirectory.value = readOnlyFolder.value ? "" : localPath(folder.value);
  saveFolderName.value = undefined;
  sourceDirectory = props.directory;
  saveVisible.value = true;
  try {
    saveTreeData.value = (await fetchLayer("")).filter(entry => entry.type === "directory");
  } catch (error) {
    showError(error);
  }
}

async function saveAsset() {
  const output = outputs.value[selectedOutput.value]?.output;
  const name = assetName.value.trim();
  if (!output || !name || /[\\/]/.test(name) || saving.value || saveFolderName.value !== undefined) return;
  const path = saveDirectory.value === "" ? name : `${saveDirectory.value}/${name}`;
  saving.value = true;
  try {
    const content = typeof output.value === "object"
      ? await useWorkspaceFiles(() => sourceDirectory).read(output.value.url)
      : new Blob([String(output.value)]);
    await axios.put("/api/assets/save", content, { params: { path }, headers: { "Content-Type": "application/octet-stream" } });
    saveVisible.value = false;
    ElMessage.success("已保存到素材库");
    refreshAssets();
  } catch (error) {
    showError(error);
  } finally {
    saving.value = false;
  }
}

defineExpose({ openSave });
</script>
<style lang="scss" scoped>
.assetLibrary {
  position: relative;
  height: 100%;
  border: none;
  border-radius: 0;
  border-right: 1px solid var(--el-border-color-light);

  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
  }

  .libraryScroll {
    flex: 1 1 auto;
    min-height: 0;
  }

  .sourceTabs {
    display: flex;
    gap: 2px;
    padding: 0 0 6px;

    .sourceTab {
      flex: 1;
      min-width: 0;
      padding: 4px 2px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--el-text-color-regular);
      font-size: 12px;
      line-height: 18px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      &:hover { background: var(--el-fill-color-light); }

      &.active {
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
        font-weight: 600;
      }
    }
  }

  .folderTrail {
    padding: 0 0 4px;
  }

  .statusBar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    padding: 6px 2px 0;
    background: var(--el-bg-color);
    border-top: 1px solid var(--el-border-color-lighter);
    font-size: 11px;
    color: var(--el-text-color-secondary);

    .statusCount { margin-right: auto; }

  }

  .drawerHandle {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;

    &:hover { background: var(--el-color-primary-light-7); }
  }

  display: flex;
  flex-direction: column;


  .chipCount {
    margin-left: 4px;
    color: var(--el-text-color-placeholder);
    font-size: 10px;
  }

  .chipSelectRow {
    padding: 6px 2px 4px;
  }

  .chipSelect {
    width: 100%;
  }

  .gridChips {
    display: flex;
    gap: 4px;
    padding: 6px 24px 4px 2px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent 100%);

    &::-webkit-scrollbar { display: none; }
  }

  .gridChip {
    flex: none;
    padding: 2px 8px;
    border: 1px solid var(--el-border-color);
    border-radius: 999px;
    background: transparent;
    color: var(--el-text-color-regular);
    font-size: 12px;
    cursor: pointer;

    &.active {
      border-color: var(--el-color-primary);
      color: var(--el-color-primary);
    }
  }

  .gridBody {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    padding: 2px 0;
  }

  .gridCard {
    display: flex;
    flex-direction: column;
    gap: 3px;
    cursor: grab;
  }

  .gridThumb {
    width: 100%;
    aspect-ratio: 3 / 4;
    border-radius: 6px;
    overflow: hidden;
    background: var(--el-fill-color-light);
  }

  .gridName {
    overflow: hidden;
    color: var(--el-text-color-regular);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gridEmptyHint {
    font-size: 11px;
    color: var(--el-text-color-placeholder);
  }

  .gridEmpty {
    grid-column: 1 / -1;
    padding: 12px 0;
    color: var(--el-text-color-placeholder);
    font-size: 12px;
    text-align: center;
  }


  .libraryToolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    gap: 8px;
    height: 32px;
    margin-bottom: 8px;

    .toolbarButton {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      margin: 0;
      padding: 0;
    }

    .searchInput {
      flex: 1;
      min-width: 0;
    }
  }

  .libraryScroll {
    flex: 1 1 auto;
    min-height: 0;
  }

  .audioPreview {
    flex-shrink: 0;
    margin-top: 8px;

    .audioHeader {
      display: flex;
      align-items: center;
      gap: 8px;

      span {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--el-font-size-small);
      }
    }

    audio { display: block; width: 100%; }
  }

  .assetTree {
    :deep(.el-tree-node__content) {
      height: 36px;
      padding-right: 6px;
      border-radius: var(--el-border-radius-base);
    }
  }

  .newFolderRow {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;

    .folderNameInput { flex: 1; min-width: 0; }
    :deep(.el-button + .el-button) { margin-left: 0; }
  }

  .searchResults {
    display: flex;
    flex-direction: column;

    .searchEmpty { padding: 24px 0; color: var(--el-text-color-placeholder); font-size: 13px; text-align: center; }
  }

  .assetEntry {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 36px;
    padding-right: 6px;
    overflow: hidden;
    border-radius: var(--el-border-radius-base);

    &[draggable="true"] { cursor: grab; }
    &:hover { background: var(--el-fill-color-light); }

    .assetThumbnail,
    .fileIcon {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      border-radius: var(--el-border-radius-base);
      color: var(--el-text-color-secondary);
    }

    .assetThumbnail { background: var(--el-fill-color-light); }

    .moreButton {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      margin: 0;
      padding: 0;
      color: var(--el-text-color-secondary);
    }

    .assetName {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--el-font-size-base);
    }

    .sourceTag {
      flex-shrink: 0;
      color: var(--el-text-color-placeholder);
      font-size: 11px;
    }

    .readOnlyMark { flex-shrink: 0; color: var(--el-text-color-placeholder); }

    .folderNameInput {
      flex: 1;
      min-width: 0;
    }
  }
}

.assetPreview {
  .previewAudio { display: block; width: 100%; }
  .previewVideo {
    display: block;
    width: 100%;
    max-height: 65dvh;
    background: #000;
  }

}

.saveForm {
  .saveLocation {
    .locationHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: var(--el-font-size-base);
      color: var(--el-text-color-regular);
    }

    .locationPath {
      margin: 4px 0 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--el-font-size-small);
      color: var(--el-text-color-secondary);
    }

    .saveFolderScroll {
      height: auto;
      max-height: 220px;
    }

    .saveFolderTree {
      :deep(.el-tree-node__content) {
        height: 36px;
        border-radius: var(--el-border-radius-base);
      }

      .saveFolderEntry {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;

        svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
        span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      }
    }

    .createFolderRow {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;

      .el-input { flex: 1; min-width: 0; }
      .el-button { margin: 0; }
    }
  }
}
</style>
