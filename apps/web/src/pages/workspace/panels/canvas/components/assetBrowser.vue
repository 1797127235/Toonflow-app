<template>
  <div class="assetBrowser" role="region" aria-label="素材库">
    <aside class="browserSidebar" aria-label="素材目录">
      <button class="allAssets" :class="{ active: folder === '.' }" type="button" :disabled="navigationLocked" @click="navigateTo('.')">
        <icon-layout-grid :size="19" aria-hidden="true" />
        <span>全部素材库</span>
        <span class="assetCount">{{ sources.length }}</span>
      </button>
      <el-scrollbar class="directoryScroll">
        <el-tree class="directoryTree" :data="sourceNodes" lazy :load="loadNode" nodeKey="path" :props="treeProps" :icon="IconChevronRight" :currentNodeKey="folder === '.' ? undefined : folder" :defaultExpandedKeys="folder.startsWith('@local') ? [folder] : []" :expandOnClickNode="false" highlightCurrent emptyText="" @nodeClick="selectDirectory">
          <template #default="{ data, node }">
            <span class="directoryEntry" :title="data.name">
              <component :is="node.expanded && !node.isLeaf ? IconFolderOpen : IconFolder" :size="17" aria-hidden="true" />
              <span>{{ data.name }}</span>
              <icon-lock v-if="data.readOnly" :size="12" class="readOnlyMark" aria-label="只读" />
              <icon-cloud-off v-else-if="data.stale" :size="12" class="readOnlyMark" aria-label="离线快照" />
            </span>
          </template>
        </el-tree>
      </el-scrollbar>
    </aside>

    <section class="browserMain">
      <header class="browserHeader">
        <nav class="breadcrumb" aria-label="当前目录">
          <button type="button" :disabled="navigationLocked" @click="navigateTo('.')">素材库</button>
          <template v-for="part in breadcrumb" :key="part.path">
            <icon-chevron-right :size="13" aria-hidden="true" />
            <button type="button" :disabled="navigationLocked" :aria-current="part.path === folder ? 'page' : undefined" @click="navigateTo(part.path)">{{ part.name }}</button>
          </template>
        </nav>
        <div class="headingRow">
          <div class="directoryTitle">
            <div class="titleLine">
              <h2>{{ heading }}</h2>
              <el-button v-if="folder !== '.' && !readOnly" class="directoryMore" text :icon="IconDots" :aria-label="'更多 ' + heading" title="目录操作" @click="emit('menu', $event, currentEntry)" />
              <span v-if="readOnly && folder !== '.'" class="readOnlyTag">只读</span>
            </div>
            <p>{{ summary }}</p>
          </div>
          <div class="headerActions">
            <div v-if="hasAlternate" class="viewSwitch" role="group" aria-label="显示模式">
            <button type="button" class="viewOption" :class="{ active: !showAlternate }" :aria-pressed="!showAlternate" @click="toggleView()">素体白模</button>
            <button type="button" class="viewOption" :class="{ active: showAlternate }" :aria-pressed="showAlternate" @click="toggleView()">深度图</button>
          </div>
          <el-input v-model="searchQuery" class="searchInput" :prefixIcon="IconSearch" placeholder="搜索全部素材库" aria-label="搜索素材" clearable @keydown.esc.stop="searchQuery = ''" />
            <el-button v-if="!readOnly" class="createButton" :icon="IconFolderPlus" :disabled="newFolderParent !== undefined || loading" @click="emit('startFolder')">新建文件夹</el-button>
          </div>
        </div>
        <div v-if="!readOnly && !searchQuery.trim()" class="filterRow" role="group" aria-label="素材类型">
          <button v-for="item in filters" :key="item.value" class="filterButton" :class="{ active: selectedKind === item.value }" type="button" :aria-pressed="selectedKind === item.value" @click="selectedKind = item.value">
            {{ item.label }}<span>{{ item.count }}</span>
          </button>
        </div>
      </header>

      <form v-if="newFolderParent !== undefined" class="newFolderRow" @submit.prevent="emit('saveFolder')">
        <icon-folder-plus :size="20" aria-hidden="true" />
        <el-input ref="folderInput" v-model="newFolderName" class="folderNameInput" aria-label="新文件夹名称" :disabled="folderSaving" @keydown.esc.prevent.stop="emit('cancelFolder')" />
        <el-button type="primary" nativeType="submit" :loading="folderSaving" :disabled="!newFolderName.trim()">创建</el-button>
        <el-button text :disabled="folderSaving" @click="emit('cancelFolder')">取消</el-button>
      </form>

      <div v-if="groupChips.length" class="groupChips" role="tablist" aria-label="素材分类">
        <button v-for="chip in groupChips" :key="chip.path" class="groupChip" :class="{ activeChip: isActiveGroup(chip) }" type="button" role="tab" :aria-selected="isActiveGroup(chip)" :aria-label="chip.name" @click="selectGroup(chip)">
          {{ chip.name }}<span class="chipCount">{{ chip.count }}</span>
        </button>
      </div>

      <el-scrollbar ref="assetScrollRef" v-loading="loading" class="assetScroll" aria-label="素材列表" @scroll="onScroll">
        <div v-if="cards.length" class="assetGrid">
          <article v-for="entry in cards" :key="entry.path" class="assetCard" :draggable="entry.type === 'file'" @dragstart="startDrag($event, entry)" @contextmenu.prevent.stop="emit('menu', $event, entry)">
            <component :is="entry.type === 'directory' || mediaKind(entry) ? 'button' : 'div'" class="assetOpen" :type="entry.type === 'directory' || mediaKind(entry) ? 'button' : undefined" :disabled="entry.type === 'directory' && navigationLocked" :aria-label="entry.type === 'directory' ? '打开 ' + entry.name : mediaKind(entry) ? '预览素材 ' + displayName(entry) : undefined" @click="openEntry(entry)">
              <span class="assetVisual" :class="entry.type === 'directory' ? 'folderVisual' : mediaKind(entry) + 'Visual'">
                <el-image v-if="mediaKind(entry) === 'image'" class="assetImage" :src="assetUrl(visualThumb(entry))" fit="contain" loading="lazy" draggable="false">
                  <template #error><span class="imageError"><icon-photo :size="38" aria-hidden="true" /></span></template>
                </el-image>
                <icon-folder v-else-if="entry.type === 'directory'" :size="58" stroke="1.25" aria-hidden="true" />
                <template v-else-if="mediaKind(entry) === 'video'"><mentionThumbnail class="assetVideo" :thumbnail="{ url: entry.thumbPath ?? entry.path, mimeType: mentionAssetType(entry.path).mimeType }" globalAsset><icon-video class="mediaBackdrop" :size="76" stroke="1" aria-hidden="true" /></mentionThumbnail><span class="playButton"><icon-player-play :size="22" fill="currentColor" aria-hidden="true" /></span></template>
                <icon-music v-else-if="mediaKind(entry) === 'audio'" :size="52" stroke="1.25" aria-hidden="true" />
                <icon-file v-else :size="52" stroke="1.25" aria-hidden="true" />
                <span v-if="mediaKind(entry) && mediaKind(entry) !== 'image'" class="mediaBadge">{{ typeLabel(entry) }}</span>
                <span v-if="entry.badge" class="badgeTag overlay">{{ entry.badge }}</span>
                <span v-if="activeVariant(entry)" class="angleTag overlay">{{ previewVariant(entry)?.label }}</span>
                <span v-else-if="entry.readOnly && entry.type === 'directory'" class="readOnlyTag overlay">只读</span>
              </span>
              <span class="assetName" :title="displayName(entry)">{{ displayName(entry) }}</span>
            </component>
            <div v-if="entry.variants && entry.variants.length > 1" class="variantStrip">
              <button v-for="(variant, index) in entry.variants" :key="variant.path" class="variantThumb" type="button" :class="{ active: (hoverVariant[entry.path] ?? variantIndexes[entry.path] ?? 0) === index }" :aria-label="`视角 ${variant.label}`" @click.stop="selectVariant(entry, index)" @mouseenter="hoverVariant[entry.path] = index" @mouseleave="delete hoverVariant[entry.path]">
                <img :src="assetUrl(variantThumbOf(variant))" alt="" loading="lazy" draggable="false" />
                <span>{{ variant.label }}</span>
              </button>
            </div>
            <div class="cardFooter">
              <span class="assetDetails" :title="entry.path">{{ entry.type === 'directory' ? (entry.origin ?? '文件夹') : [entry.meta, entry.sourceLabel ?? (currentSource?.multiOrigin ? entry.origin : "")].filter(Boolean).join(' · ') || typeLabel(entry) }}</span>
              <el-button v-if="!readOnly" class="moreButton" text :icon="IconDots" :aria-label="'更多 ' + entry.name" title="更多操作" @click="emit('menu', $event, entry)" />
            </div>
          </article>
        </div>
        <div v-else-if="!loading && !cards.length" class="emptyState">
          <icon-search v-if="searchQuery.trim()" :size="40" stroke="1.25" aria-hidden="true" />
          <icon-folder v-else :size="44" stroke="1.25" aria-hidden="true" />
          <span>{{ searchQuery.trim() ? '没有找到匹配的素材' : folder === '.' ? '没有可用的素材库' : '这里是空的' }}</span>
        </div>
      </el-scrollbar>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { InputInstance, TreeNodeData } from "element-plus";
import { IconChevronRight, IconCloudOff, IconDots, IconFile, IconFolder, IconFolderOpen, IconFolderPlus, IconLayoutGrid, IconLock, IconMusic, IconPhoto, IconPlayerPlay, IconSearch, IconVideo } from "@tabler/icons-vue";
import { mentionAssetType } from "@toonflow/server/agent/mentionSources";
import mentionThumbnail from "@/components/agent/mentionThumbnail.vue";

type AssetEntry = { name: string; path: string; type: "file" | "directory"; readOnly?: boolean; thumbPath?: string; stale?: boolean; draft?: boolean; sourceLabel?: string; origin?: string; alternatePath?: string; alternateThumbPath?: string; alternateName?: string; badge?: string; meta?: string; count?: number; group?: string; variants?: AssetVariant[] };
type AssetVariant = { label: string; path: string; name: string; thumbPath?: string; alternatePath?: string; alternateThumbPath?: string; alternateName?: string };
type MediaKind = "image" | "audio" | "video";
type AssetSource = { id: string; label: string; readOnly: boolean; stale?: boolean; multiOrigin?: boolean };

const props = defineProps<{
  sources: AssetSource[];
  entries: AssetEntry[];
  results: AssetEntry[];
  searchTotal: number;
  loading?: boolean;
  newFolderParent?: string;
  folderSaving?: boolean;
  mediaKind: (entry: AssetEntry) => MediaKind | undefined;
  assetUrl: (path: string) => string;
  loadLayer: (path: string) => Promise<AssetEntry[]>;
  groups?: AssetEntry[];
}>();
const folder = defineModel<string>("folder", { default: "@local" });
const searchQuery = defineModel<string>("searchQuery", { default: "" });
const newFolderName = defineModel<string>("newFolderName", { default: "" });
const emit = defineEmits<{
  startFolder: [];
  saveFolder: [];
  cancelFolder: [];
  preview: [entry: AssetEntry];
  menu: [event: MouseEvent, entry: AssetEntry];
  drag: [event: DragEvent, entry: AssetEntry];
}>();

const folderInput = ref<InputInstance>();
const selectedKind = ref<"all" | MediaKind | "other">("all");
const isRemoteRoot = (data: TreeNodeData) => {
  const path = (data as AssetEntry).path ?? "";
  return path.startsWith("@") && !path.startsWith("@local") && path.slice(1).split("/").length === 1;
};
const treeProps = { label: "name", isLeaf: (data: TreeNodeData) => (data as AssetEntry).type === "file" || isRemoteRoot(data) };

const overview = computed(() => folder.value === ".");
const navigationLocked = computed(() => props.folderSaving === true || props.newFolderParent !== undefined);
const sourceNodes = computed<AssetEntry[]>(() => props.sources.map(source => ({ name: source.label, path: `@${source.id}`, type: "directory", readOnly: source.readOnly, stale: source.stale })));
const currentSource = computed(() => {
  if (!folder.value.startsWith("@")) return undefined;
  const id = folder.value.slice(1).split("/")[0];
  return props.sources.find(source => source.id === id);
});
const readOnly = computed(() => (folder.value.startsWith("@") ? folder.value !== "@local" : overview.value));
const heading = computed(() => {
  if (overview.value) return "全部素材库";
  const parts = folder.value.split("/");
  if (parts.length > 1) return parts[parts.length - 1];
  return currentSource.value?.label ?? "素材库";
});
const currentEntry = computed<AssetEntry>(() => ({ name: heading.value, path: folder.value, type: "directory", readOnly: readOnly.value }));
const hoverVariant = ref<Record<string, number>>({});
const variantIndexes = ref<Record<string, number>>({});
const showAlternate = ref(false);
const hasAlternate = computed(() => props.entries.some(entry => entry.alternatePath || entry.variants?.some(variant => variant.alternatePath)));

function displayName(entry: AssetEntry) {
  return entry.name.replace(/\.[^.]+$/, "").replace(/（[^（）]*）$/, "");
}

function previewVariant(entry: AssetEntry) {
  const variants = entry.variants;
  if (!variants?.length) return undefined;
  return variants[hoverVariant.value[entry.path] ?? variantIndexes.value[entry.path] ?? 0];
}

function activeVariant(entry: AssetEntry) {
  const variants = entry.variants;
  if (!variants?.length) return undefined;
  return variants[variantIndexes.value[entry.path] ?? 0];
}

function selectVariant(entry: AssetEntry, index: number) {
  variantIndexes.value = { ...variantIndexes.value, [entry.path]: index };
}

function variantThumbOf(variant: AssetVariant) {
  return variant.thumbPath ?? variant.path;
}

function visualThumb(entry: AssetEntry) {
  const current = previewVariant(entry) ?? entry;
  if (showAlternate.value) return current.alternateThumbPath ?? current.alternatePath ?? current.thumbPath ?? current.path;
  return current.thumbPath ?? current.path;
}

function toggleView() {
  showAlternate.value = !showAlternate.value;
}

function startDrag(event: DragEvent, entry: AssetEntry) {
  const variant = activeVariant(entry);
  if (!variant) {
    emit("drag", event, entry);
    return;
  }
  const alternate = showAlternate.value && variant.alternatePath;
  emit("drag", event, { ...entry, path: alternate || variant.path, name: variant.name, thumbPath: variant.thumbPath });
}
const summary = computed(() => {
  if (overview.value) return `${props.sources.length} 个素材库`;
  if (searchQuery.value.trim()) return props.searchTotal > props.results.length ? `找到 ${props.searchTotal} 条，显示前 ${props.results.length} 条` : `找到 ${props.searchTotal} 条`;
  if (groupChips.value.length && folder.value.startsWith("@") && !folder.value.slice(1).includes("/")) {
    const shots = allCards.value.reduce((sum, entry) => sum + (entry.variants?.length ?? 1), 0);
    const base = `${allCards.value.length} 个素材 · ${shots} 张图`;
    return base;
  }
  const visible = props.entries.filter(entry => entry.type === "file" && !entry.draft);
  const files = visible.length;
  const shots = visible.reduce((sum, entry) => sum + (entry.variants?.length ?? 1), 0);
  const directories = props.entries.filter(entry => entry.type === "directory" && !entry.draft).length;
  const base = `${files} 个素材${shots > files ? ` · ${shots} 张图` : ""}${directories ? ` · ${directories} 个文件夹` : ""}`;
  return base;
});
const breadcrumb = computed(() => {
  if (overview.value) return [];
  const parts = folder.value.startsWith("@") ? folder.value.slice(1).split("/") : folder.value.split("/");
  const sourceId = folder.value.startsWith("@") ? parts[0]! : "local";
  const label = props.sources.find(source => source.id === sourceId)?.label ?? sourceId;
  const trail = [{ name: label, path: `@${sourceId}` }];
  const rest = folder.value.startsWith("@") ? parts.slice(1) : parts;
  rest.forEach((name, index) => trail.push({ name, path: `@${sourceId}/${rest.slice(0, index + 1).join("/")}` }));
  return trail;
});
const filters = computed(() => {
  const files = props.entries.filter(entry => entry.type === "file" && !entry.draft);
  return [
    { value: "all" as const, label: "全部", count: files.length },
    { value: "image" as const, label: "图片", count: files.filter(entry => props.mediaKind(entry) === "image").length },
    { value: "video" as const, label: "视频", count: files.filter(entry => props.mediaKind(entry) === "video").length },
    { value: "audio" as const, label: "音频", count: files.filter(entry => props.mediaKind(entry) === "audio").length },
    { value: "other" as const, label: "其他", count: files.filter(entry => !props.mediaKind(entry)).length },
  ];
});
const displayEntries = computed(() => {
  return props.entries.filter(entry => {
    if (entry.draft) return true;
    if (selectedKind.value === "all") return true;
    return entry.type === "file" && (props.mediaKind(entry) ?? "other") === selectedKind.value;
  }).toSorted((left, right) => Number(right.type === "directory") - Number(left.type === "directory"));
});
const activeGroup = ref("all");
const visibleCount = ref(24);
const groupChips = computed(() => {
  if (searchQuery.value.trim() || overview.value || !props.groups?.length) return [];
  return props.groups;
});
const isActiveGroup = (chip: AssetEntry) => activeGroup.value === chip.name;
function selectGroup(chip: AssetEntry) {
  activeGroup.value = activeGroup.value === chip.name ? "all" : chip.name;
  visibleCount.value = 24;
}
const allCards = computed<AssetEntry[]>(() => {
  if (searchQuery.value.trim()) return props.results;
  if (overview.value) return sourceNodes.value;
  if (!folder.value.startsWith("@")) return displayEntries.value;
  const isSourceRoot = !folder.value.slice(1).includes("/");
  if (!isSourceRoot) return displayEntries.value;
  return displayEntries.value.filter(entry => activeGroup.value === "all" || entry.group === activeGroup.value);
});
const cards = computed<AssetEntry[]>(() => {
  if (searchQuery.value.trim() || overview.value || !folder.value.startsWith("@")) return allCards.value;
  if (folder.value.slice(1).includes("/")) return allCards.value;
  return allCards.value.slice(0, visibleCount.value);
});
const assetScrollRef = ref<{ wrapRef?: HTMLElement } | null>(null);
function onScroll({ scrollTop }: { scrollTop: number }) {
  const wrap = assetScrollRef.value?.wrapRef;
  if (!wrap) return;
  if (wrap.scrollHeight - scrollTop - wrap.clientHeight > 160) return;
  if (visibleCount.value >= allCards.value.length) return;
  visibleCount.value += 24;
}
watch(cards, async () => {
  await nextTick();
  const wrap = assetScrollRef.value?.wrapRef;
  if (!wrap) return;
  if (wrap.scrollHeight > wrap.clientHeight + 24) return;
  if (visibleCount.value >= allCards.value.length) return;
  visibleCount.value += 24;
}, { flush: "post" });

async function loadNode(node: TreeNodeData & { level: number }, resolve: (data: TreeNodeData[]) => void) {
  try {
    if (node.level === 0) {
      resolve(sourceNodes.value);
      return;
    }
    const layer = await props.loadLayer((node.data as AssetEntry).path);
    resolve(layer.filter(entry => entry.type === "directory"));
  } catch { resolve([]); }
}

function selectDirectory(entry: AssetEntry) {
  navigateTo(entry.path);
}

function navigateTo(path: string) {
  activeGroup.value = "all";
  visibleCount.value = 24;
  // 换目录/换筛选后旧的视角选择没有意义，顺手释放，避免表随浏览无界增长
  variantIndexes.value = {};
  hoverVariant.value = {};
  if (navigationLocked.value) return;
  folder.value = path;
  selectedKind.value = "all";
  searchQuery.value = "";
}

function openEntry(entry: AssetEntry) {
  const variant = activeVariant(entry);
  const alternate = showAlternate.value ? (variant?.alternatePath ?? entry.alternatePath) : undefined;
  if (alternate) entry = { ...entry, path: alternate, thumbPath: variant?.alternateThumbPath ?? entry.alternateThumbPath };
  else if (variant) entry = { ...entry, path: variant.path, name: variant.name, thumbPath: variant.thumbPath };
  if (entry.draft) return;
  if (entry.type === "directory") navigateTo(entry.path);
  else if (props.mediaKind(entry)) emit("preview", entry);
}

function typeLabel(entry: AssetEntry) {
  if (entry.type === "directory") return "文件夹";
  const kind = props.mediaKind(entry);
  return kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : entry.name.split(".").length > 1 ? entry.name.split(".").at(-1)?.toLocaleUpperCase() + " 文件" : "文件";
}

watch(() => props.newFolderParent, async parent => {
  if (parent === undefined) return;
  await nextTick();
  folderInput.value?.select();
}, { immediate: true });
</script>

<style scoped lang="scss">
.assetBrowser {
  display: flex;
  flex: 1;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  color: var(--el-text-color-primary);

  button:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: -2px;
  }

  .readOnlyMark {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--el-text-color-placeholder);
  }

  .readOnlyTag {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: var(--ui-radius-small);
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color);
    font-size: 11px;
    font-weight: 400;
    line-height: 17px;

    &.overlay {
      position: absolute;
      top: 9px;
      right: 10px;
      background: color-mix(in srgb, var(--el-bg-color-overlay) 88%, transparent);
    }
  }

  .activeChip {
    border-color: var(--el-color-primary);
    color: var(--el-color-primary);
  }

  .groupChips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 22px 10px;
  }

  .groupChip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 999px;
    color: var(--el-text-color-regular);
    background: transparent;
    font-size: 12px;
    line-height: 17px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;

    &:hover {
      color: var(--el-color-primary);
      border-color: var(--el-color-primary-light-5);
      background: var(--el-color-primary-light-9);
    }

    .chipCount {
      color: var(--el-text-color-placeholder);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

  }

  .variantStrip {
    display: flex;
    gap: 4px;
    padding: 8px 12px 0;
  }

  .variantThumb {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--el-fill-color-light);
    cursor: pointer;
    overflow: hidden;
    transition: border-color 0.15s;

    img {
      display: block;
      width: 100%;
      aspect-ratio: 1 / 1;
      object-fit: contain;
      background: #f7f7f8;
    }

    span {
      display: block;
      padding: 1px 0;
      overflow: hidden;
      color: var(--el-text-color-secondary);
      font-size: 10px;
      line-height: 13px;
      white-space: nowrap;
      text-overflow: clip;
    }

    &:hover { border-color: var(--el-color-primary-light-5); }

    &.active {
      border-color: var(--el-color-primary);

      span { color: var(--el-color-primary); }
    }
  }

  .loadMoreRow {
    display: flex;
    justify-content: center;
    padding: 6px 0 18px;
  }

  .viewSwitch {
    display: flex;
    flex-shrink: 0;
    margin-right: 8px;
    padding: 2px;
    border-radius: var(--ui-radius-small);
    background: var(--el-fill-color-light);
  }

  .viewOption {
    padding: 2px 10px;
    border: 0;
    border-radius: 5px;
    color: var(--el-text-color-regular);
    background: transparent;
    font-size: 12px;
    line-height: 20px;
    cursor: pointer;

    &.active {
      color: var(--el-text-color-primary);
      background: var(--el-bg-color-overlay);
      box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
    }
  }

  .angleTag {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--el-text-color-regular);
    background: var(--el-bg-color-overlay);
    font-size: 11px;
    line-height: 18px;
  }

  .badgeTag {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 1px 7px;
    border-radius: var(--ui-radius-small);
    color: var(--el-text-color-primary);
    background: color-mix(in srgb, var(--el-bg-color-overlay) 86%, transparent);
    font-size: 11px;
    font-weight: 500;
    line-height: 17px;
    letter-spacing: 0.2px;
  }

  .viewToggle {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 2px 8px;
    border: 0;
    border-radius: var(--ui-radius-small);
    color: var(--el-text-color-regular);
    background: color-mix(in srgb, var(--el-bg-color-overlay) 88%, transparent);
    font-size: 11px;
    line-height: 16px;
    cursor: pointer;
    opacity: 0.72;
    transition: opacity 0.15s ease, color 0.15s ease;

    &:hover,
    &:focus-visible { opacity: 1; color: var(--el-color-primary); }
  }

  .assetCard:hover .viewToggle,
  .assetCard:focus-within .viewToggle { opacity: 1; }

  .browserSidebar {
    display: flex;
    flex: 0 0 210px;
    flex-direction: column;
    min-width: 0;
    padding: 2px 12px 2px 2px;

    .allAssets {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      color: var(--el-text-color-regular);
      background: transparent;
      font: inherit;
      font-size: 14px;
      cursor: pointer;

      &.active {
        color: var(--el-color-primary);
        background: var(--el-color-primary-light-9);
      }

      &:hover { background: var(--el-fill-color-light); }
      &.active:hover { background: var(--el-color-primary-light-9); }

      .assetCount {
        margin-left: auto;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        opacity: 0.75;
      }
    }

    .directoryScroll {
      flex: 1;
      min-height: 0;

      .directoryTree {
        background: transparent;
        --el-tree-node-hover-bg-color: var(--el-fill-color);

        :deep(.el-tree-node__content) {
          height: 38px;
          border-radius: var(--el-border-radius-base);
        }

        :deep(.el-tree-node.is-current > .el-tree-node__content) {
          color: var(--el-color-primary);
          background: var(--el-color-primary-light-9);
        }

        .directoryEntry {
          display: flex;
          flex: 1;
          align-items: center;
          gap: 8px;
          min-width: 0;
          padding-right: 10px;
          font-size: 13px;

          svg { flex-shrink: 0; }
          span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        }
      }
    }
  }

  .browserMain {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;

    .browserHeader {
      padding: 0 20px;

      .breadcrumb {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 20px;
        overflow-x: auto;
        color: var(--el-text-color-placeholder);
        font-size: 12px;

        svg { flex-shrink: 0; }

        button {
          flex-shrink: 0;
          max-width: 180px;
          overflow: hidden;
          padding: 2px 0;
          border: 0;
          color: var(--el-text-color-secondary);
          background: transparent;
          font: inherit;
          text-overflow: ellipsis;
          white-space: nowrap;
          cursor: pointer;

          &:hover { color: var(--el-color-primary); }
          &[aria-current="page"] { color: var(--el-text-color-primary); }
        }
      }

      .headingRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        margin-top: 12px;

        .directoryTitle {
          min-width: 0;

          .titleLine {
            display: flex;
            align-items: center;
            gap: 6px;

            h2 {
              overflow: hidden;
              margin: 0;
              font-size: 18px;
              font-weight: 600;
              line-height: 1.5;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .directoryMore { flex-shrink: 0; padding: 6px; }
          }

          p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
        }

        .headerActions {
          display: flex;
          flex-shrink: 0;
          align-items: center;
          gap: 12px;

          .searchInput { width: 230px; }
          .createButton { margin-left: 0; }
        }
      }

      .filterRow {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        scrollbar-width: none;
        margin-top: 20px;
        padding-bottom: 0;

        &::-webkit-scrollbar { display: none; }

        .filterButton {
          display: inline-flex;
          flex-shrink: 0;
          align-items: center;
          gap: 8px;
          padding: 9px 12px;
          border: 0;
          border-radius: var(--ui-radius-large);
          color: var(--el-text-color-secondary);
          background: transparent;
          font: inherit;
          font-size: 13px;
          cursor: pointer;

          span { opacity: 0.6; font-size: 12px; font-variant-numeric: tabular-nums; }
          &:hover { color: var(--el-text-color-primary); }
          &.active { color: var(--el-text-color-primary); background: var(--el-fill-color); font-weight: 600; }
        }
      }
    }

    .newFolderRow {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      gap: 10px;
      margin: 16px 20px 0;
      padding: 12px;
      border: 1px solid var(--el-border-color-light);
      border-radius: var(--el-border-radius-base);
      background: var(--el-fill-color-light);

      > svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
      .folderNameInput { max-width: 320px; }
      :deep(.el-button + .el-button) { margin-left: 0; }
    }

    .assetScroll {
      flex: 1;
      min-height: 0;

      .assetGrid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(172px, 1fr));
        gap: 12px;
        padding: 14px;

        .assetCard {
          min-width: 0;
          overflow: hidden;
          border: 1px solid var(--el-border-color-lighter);
          border-radius: var(--ui-radius-large);
          background: var(--el-bg-color-overlay);
          transition: border-color 0.15s;

          &:hover { border-color: var(--el-border-color); }
          &:focus-within { border-color: var(--el-color-primary-light-5); }

          .assetOpen {
            display: block;
            width: 100%;
            padding: 0;
            border: 0;
            color: inherit;
            background: transparent;
            font: inherit;
            text-align: left;
            cursor: default;

            &[type="button"] { cursor: pointer; }

            .assetVisual {
              position: relative;
              display: flex;
              align-items: center;
              justify-content: center;
              aspect-ratio: 4 / 3;
              overflow: hidden;
              color: var(--el-text-color-placeholder);
              background: #f7f7f8;

              &.folderVisual, &.videoVisual, &.audioVisual { color: var(--el-text-color-secondary); }

              .assetImage {
                width: 100%;
                height: 100%;

                .imageError { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--el-text-color-placeholder); }
              }

              .assetVideo {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                border-radius: 0;

                .mediaBackdrop { opacity: 0.14; }
              }

              .playButton {
                position: absolute;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 43px;
                height: 43px;
                border: 1px solid var(--el-border-color-lighter);
                border-radius: 50%;
                background: var(--el-bg-color-overlay);

                svg { margin-left: 2px; }
              }

              .mediaBadge {
                position: absolute;
                bottom: 9px;
                left: 10px;
                padding: 3px 7px;
                border-radius: var(--ui-radius-small);
                color: var(--el-text-color-regular);
                background: color-mix(in srgb, var(--el-bg-color-overlay) 90%, transparent);
                font-size: 12px;
                line-height: 15px;
              }
            }

            .assetName {
              display: block;
              overflow: hidden;
              padding: 13px 13px 0;
              font-size: 14px;
              font-weight: 500;
              line-height: 20px;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
          }

          .cardFooter {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            padding: 1px 7px 7px 13px;

            .assetDetails { min-width: 0; overflow: hidden; color: var(--el-text-color-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
            .moreButton { flex-shrink: 0; width: 27px; height: 27px; padding: 4px; color: var(--el-text-color-secondary); }
          }
        }
      }

      .emptyState {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        min-height: 250px;
        padding: 40px 20px;
        color: var(--el-text-color-placeholder);
        font-size: 13px;
      }
    }
  }
}

@media (max-width: 1000px) {
  .assetBrowser {
    .browserSidebar { flex-basis: 180px; }
    .browserMain {
      .browserHeader {
        padding: 0 20px;
        .headingRow {
          align-items: flex-start;
          flex-direction: column;
          gap: 14px;
          .headerActions { width: 100%; .searchInput { flex: 1; width: auto; } }
        }
        .filterRow { margin-top: 18px; }
      }
      .newFolderRow { margin-right: 20px; margin-left: 20px; }
      .assetScroll .assetGrid { gap: 14px; padding: 20px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    }
  }
}

@media (max-width: 640px) {
  .assetBrowser {
    flex-direction: column;
    .browserSidebar {
      flex: 0 0 auto;
      padding: 10px 12px;
      .allAssets { padding: 9px 10px; }
      .directoryScroll { flex: 0 1 auto; max-height: 120px; }
    }
    .browserMain {
      .browserHeader { padding: 14px 14px 0; }
      .newFolderRow { gap: 6px; margin-right: 14px; margin-left: 14px; padding: 8px; > svg { display: none; } }
      .assetScroll .assetGrid { grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; padding: 14px 12px; }
    }
  }
}
</style>
