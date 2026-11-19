<template>
  <div ref="pageRoot" class="skillsPage">
    <div class="skillsHeader">
      <h2 class="skillsTitle">技能</h2>
      <div class="skillsTabs" role="tablist" aria-label="技能范围">
        <button
          v-for="view in skillViews"
          :key="view.id"
          class="skillsTab"
          :class="{ active: activeView === view.id }"
          role="tab"
          :aria-selected="activeView === view.id"
          @click="activeView = view.id">
          {{ view.label }}
        </button>
      </div>
    </div>

    <template v-if="activeView === 'online'">
      <div class="onlineToolbar">
        <el-input v-model="searchQuery" class="onlineSearch" placeholder="搜索在线技能" clearable :prefix-icon="IconSearch" />
      </div>
      <div class="categoryBar" role="tablist" aria-label="技能分类">
        <button
          v-for="category in categories"
          :key="category.label"
          type="button"
          class="categoryChip"
          :class="{ active: categoryFilter === category.label }"
          role="tab"
          :aria-selected="categoryFilter === category.label"
          @click="selectCategory(category.label)">
          {{ category.label }}
          <span class="categoryCount">{{ category.count }}</span>
        </button>
      </div>
      <p v-if="indexError" class="onlineState">{{ indexError }}</p>
      <p v-else-if="indexLoading" class="onlineState">正在加载在线技能…</p>
      <p v-else-if="!matchedSkills.length" class="onlineState">没有匹配的技能</p>
      <div v-else ref="gridRef" class="onlineGrid">
        <el-card
          v-for="skill in pagedSkills"
          :key="skill.name"
          class="onlineCard"
          shadow="never"
          role="group"
          :aria-label="skill.title"
          aria-haspopup="dialog"
          tabindex="0"
          @click="openPreview(skill)"
          @keydown.enter.self.prevent="openPreview(skill)">
          <div class="cardHeader">
            <div class="cardHeading">
              <h3 class="cardName">
                <icon-book :size="18" aria-hidden="true" />
                <span class="cardTitle">{{ skill.title }}</span>
              </h3>
              <span class="cardId" :title="skill.name">{{ skill.name }}</span>
            </div>
            <div class="cardTags">
              <el-tag type="success" size="small">技能</el-tag>
            </div>
          </div>
          <p class="cardDescription">{{ skill.description }}</p>
          <div class="cardMeta">
            <span class="cardSize">{{ formatSize(skill.size) }}</span>
          </div>
          <div class="cardFooter" @click.stop>
            <el-button size="small" type="primary" :loading="installingName === skill.name" @click="installSkill(skill)">
              {{ installedNames.has(skill.name) ? "重新安装" : "安装" }}
            </el-button>
          </div>
        </el-card>
      </div>
      <el-pagination
        v-if="matchedSkills.length > pageSize"
        v-model:current-page="currentPage"
        class="onlinePager"
        layout="prev, pager, next"
        :page-size="pageSize"
        :pager-count="5"
        :total="matchedSkills.length"
        background />
    </template>

    <pluginMarket v-else initialType="skill" />

    <el-dialog v-model="previewVisible" :title="previewTitle" width="min(860px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose>
      <div class="previewContent">
        <messageMarkdown v-if="previewText" :content="previewText" />
        <p v-else class="onlineState">正在加载预览…</p>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "axios";
import { IconSearch } from "@tabler/icons-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import pluginMarket from "@/components/settings/panels/pluginMarket/index.vue";
import messageMarkdown from "@/components/messageMarkdown.vue";

// 技能仓库的公共域名；换存储时改这里。
const repositoryUrl = "https://pub-dc9e154f422442e3a428aaca78af6efa.r2.dev";

type OnlineSkill = {
  name: string;
  title: string;
  description: string;
  version: string;
  size: number;
  category: string;
  file: string;
  preview: string;
};

const skillViews = [
  { id: "online", label: "在线" },
  { id: "local", label: "本地" },
] as const;
const activeView = ref<(typeof skillViews)[number]["id"]>("online");
const pageRoot = ref<HTMLElement | null>(null);
const gridRef = ref<HTMLElement | null>(null);
const searchQuery = ref("");
const categoryFilter = ref("全部");
const pageSize = ref(12);
const currentPage = ref(1);
const onlineSkills = ref<OnlineSkill[]>([]);
const indexLoading = ref(false);
const indexError = ref("");
const installingName = ref("");
const installedNames = ref(new Set<string>());
const previewVisible = ref(false);
const previewTitle = ref("");
const previewText = ref("");

const matchedSkills = computed(() => {
  const pool = categoryFilter.value === "全部" ? onlineSkills.value : onlineSkills.value.filter((skill) => skill.category === categoryFilter.value);
  const keyword = searchQuery.value.trim().toLowerCase();
  if (!keyword) return pool;
  return pool.filter((skill) =>
    [skill.name, skill.title, skill.description].some((field) => field.toLowerCase().includes(keyword))
  );
});
const pagedSkills = computed(() => matchedSkills.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));

watch(currentPage, () => {
  pageRoot.value?.scrollTo({ top: 0, behavior: "smooth" });
});

watch(searchQuery, () => {
  currentPage.value = 1;
});

const categoryOrder = ["营销素材", "品牌视觉", "社媒内容", "产品设计", "创意风格", "其他"];
const categories = computed(() => {
  const counts = new Map<string, number>();
  for (const skill of onlineSkills.value) counts.set(skill.category, (counts.get(skill.category) ?? 0) + 1);
  return [
    { label: "全部", count: onlineSkills.value.length },
    ...categoryOrder.filter((name) => counts.has(name)).map((name) => ({ label: name, count: counts.get(name)! })),
  ];
});

function selectCategory(label: string) {
  categoryFilter.value = label;
  currentPage.value = 1;
}

const formatSize = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// 每页数量按当前窗口能完整显示的行列数算，翻完一页不用再滚动。
function fitPageSize() {
  const root = pageRoot.value;
  const grid = gridRef.value;
  if (!root || !grid) return;
  const card = grid.querySelector<HTMLElement>(".onlineCard");
  const cardHeight = card?.offsetHeight ?? 240;
  const columns = Math.max(1, Math.floor((grid.clientWidth + 10) / 250));
  const gridTop = grid.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
  const available = root.clientHeight - gridTop - 100;
  const rows = Math.max(1, Math.floor((available + 10) / (cardHeight + 10)));
  pageSize.value = Math.max(4, columns * rows);
}

async function loadIndex() {
  indexLoading.value = true;
  indexError.value = "";
  try {
    const { data } = await axios.get<{ skills: OnlineSkill[] }>(`${repositoryUrl}/skills/index.json`);
    onlineSkills.value = data.skills;
  } catch {
    indexError.value = "在线技能索引加载失败，请检查网络或存储地址";
  } finally {
    indexLoading.value = false;
  }
  await nextTick();
  fitPageSize();
}

async function openPreview(skill: OnlineSkill) {
  previewTitle.value = skill.title;
  previewText.value = "";
  previewVisible.value = true;
  try {
    const { data } = await axios.get<string>(`${repositoryUrl}/${skill.preview}`, { responseType: "text" });
    previewText.value = data;
  } catch {
    previewText.value = "预览加载失败";
  }
}

async function installSkill(skill: OnlineSkill) {
  installingName.value = skill.name;
  try {
    await axios.post(
      "/api/skills/install",
      { url: `${repositoryUrl}/${skill.file}`, fileName: `${skill.name}.zip` },
      { headers: { "x-toonflow-workspace": "1" } }
    );
    installedNames.value = new Set(installedNames.value).add(skill.name);
    window.dispatchEvent(new Event("toonflow:plugin-installed"));
    ElMessage.success(`已安装 ${skill.title}`);
  } catch (error) {
    ElMessage.error(axios.isAxiosError(error) ? error.response?.data?.message ?? "安装失败" : "安装失败");
  } finally {
    installingName.value = "";
  }
}

onMounted(() => {
  loadIndex();
  window.addEventListener("resize", fitPageSize);
});
onBeforeUnmount(() => window.removeEventListener("resize", fitPageSize));
</script>

<style lang="scss" scoped>
.skillsPage {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 24px clamp(20px, 4vw, 56px) 56px;

  .skillsHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 16px;

    .skillsTitle {
      margin: 0;
      font-size: 18px;
      line-height: 26px;
      font-weight: 600;
    }
  }

  .skillsTabs {
    display: flex;
    gap: 4px;
    padding: 3px;
    border-radius: 10px;
    background: var(--el-fill-color-light);

    .skillsTab {
      height: 28px;
      padding: 0 14px;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: var(--el-text-color-regular);
      font-size: 13px;
      cursor: pointer;

      &.active {
        background: var(--el-bg-color);
        color: var(--el-text-color-primary);
        box-shadow: var(--el-box-shadow-light);
      }
    }
  }

  .onlineToolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 12px;

    .onlineSearch {
      flex: 1;
      min-width: 0;
    }
  }

  .categoryBar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 0 14px;
  }

  .categoryChip {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--el-border-color);
    border-radius: 999px;
    background: var(--el-bg-color);
    color: var(--el-text-color-regular);
    font-size: 13px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background-color 0.15s;

    &:hover {
      border-color: var(--el-color-primary);
      color: var(--el-color-primary);
    }

    &.active {
      border-color: var(--el-color-primary);
      background: var(--el-color-primary);
      color: #fff;
    }
  }

  .categoryCount {
    margin-left: 6px;
    font-size: 12px;
    opacity: 0.65;
  }

  .onlineState {
    padding: 24px 4px;
    color: var(--el-text-color-secondary);
    font-size: 14px;
  }

  .onlineGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
    gap: 10px;
    padding-bottom: 4px;
  }

  .onlineCard {
    min-width: 0;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid var(--el-color-primary);
      outline-offset: 2px;
    }

    :deep(.el-card__body) {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 12px;
      box-sizing: border-box;
    }

    .cardHeader {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;

      .cardTags {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        flex-shrink: 0;
        max-width: 50%;
      }

      .cardHeading {
        min-width: 0;

        .cardName {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          overflow-wrap: anywhere;

          .cardTitle {
            min-width: 0;
          }

          svg {
            flex-shrink: 0;
          }
        }

        .cardId {
          display: block;
          margin-top: 6px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          line-height: 1.5;
          color: var(--el-text-color-placeholder);
        }
      }
    }

    .cardDescription {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      margin: 10px 0 0;
      font-size: 13px;
      line-height: 1.6;
      min-height: calc(1.6em * 3);
      color: var(--el-text-color-regular);
      overflow-wrap: anywhere;
    }

    .cardMeta {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      margin-top: 12px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--el-text-color-secondary);

      .cardSize {
        flex-shrink: 0;
      }
    }

    .cardFooter {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: auto;
      padding-top: 12px;

      &::before {
        width: 100%;
        border-top: 1px solid var(--el-border-color-lighter);
        content: "";
      }

      .el-button {
        margin-left: 0;
      }
    }
  }

  .onlinePager {
    display: flex;
    justify-content: center;
    margin-top: 20px;
  }

  .previewContent {
    max-height: min(64vh, 720px);
    overflow-y: auto;
  }

  :deep(.marketToolbar) {
    background: transparent;
  }
}
</style>

<style lang="scss">
// 点阵雾在深色下太亮，压一层底色让它退到卡片后面
html.dark .skillsPage {
  background: color-mix(in srgb, var(--el-bg-color) 72%, transparent);
}
</style>