<template>
  <section class="remixGallery" data-home-section="workflows" aria-labelledby="workflowListTitle">
    <h2 id="workflowListTitle">一键生同款</h2>
    <div class="workflowItems">
      <button v-for="template in remixTemplates" :key="template.id" class="workflowCard" type="button" :disabled="disabled || !!loadingId" aria-haspopup="dialog" @click="openTemplate(template.id)">
        <img class="workflowCover" :src="template.coverUrl" alt="" loading="lazy" />
        <span class="workflowInfo">
          <span class="workflowTitle">{{ template.title }}</span>
          <span class="workflowDescription">{{ template.description }}</span>
          <span class="workflowAction">{{ loadingId === template.id ? '正在打开…' : '生同款' }}<icon-arrow-up-right :size="16" aria-hidden="true" /></span>
        </span>
      </button>
    </div>
    <remixDialog v-if="selectedTemplate" :template="selectedTemplate" :busy="busy" @close="selectedTemplate = undefined" @start="emit('start', $event)" />
  </section>
</template>

<script setup lang="ts">
import { shallowRef } from "vue";
import { ElMessage } from "element-plus";
import { loadRemixTemplate, remixTemplates, type RemixRequest, type RemixTemplate } from "./remixTemplates";
import remixDialog from "./remixDialog.vue";

defineProps<{ disabled?: boolean; busy?: boolean }>();
const emit = defineEmits<{ start: [request: RemixRequest] }>();
const selectedTemplate = shallowRef<RemixTemplate>();
const loadingId = shallowRef("");

async function openTemplate(id: string) {
  if (loadingId.value) return;
  loadingId.value = id;
  try { selectedTemplate.value = await loadRemixTemplate(id); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "打开工作流失败"); }
  finally { loadingId.value = ""; }
}
</script>

<style scoped lang="scss">
.remixGallery {
  max-width: 1280px;
  margin: 48px auto 0;

  h2 { margin: 0 0 20px; font-size: 22px; font-weight: 600; line-height: 1.5; }

  .workflowItems {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
    gap: 20px;

    .workflowCard {
      display: flex;
      flex-direction: column;
      min-width: 0;
      padding: 0;
      overflow: hidden;
      border: 1px solid var(--el-border-color-lighter);
      border-radius: calc(var(--ui-radius) * 2.5);
      background: var(--el-bg-color-overlay);
      color: var(--el-text-color-primary);
      font: inherit;
      text-align: start;
      cursor: pointer;

      &:hover:not(:disabled) { border-color: var(--el-color-primary-light-5); }
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
      &:disabled { cursor: wait; }

      .workflowCover { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: var(--el-fill-color-light); }
      .workflowInfo {
        display: flex;
        flex: 1;
        flex-direction: column;
        width: 100%;
        gap: 8px;
        padding: 16px;

        .workflowTitle { font-size: 15px; font-weight: 600; line-height: 1.5; }
        .workflowDescription { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular); }
        .workflowAction { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 8px; font-size: 13px; font-weight: 500; }
      }
    }
  }
}
</style>
