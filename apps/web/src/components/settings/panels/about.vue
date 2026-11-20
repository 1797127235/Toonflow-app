<template>
  <div class="about">
    <section class="settingSection">
      <div class="settingInfo">
        <h3>版本信息</h3>
        <p class="description">当前安装的客户端构建。检查更新会读取更新源上的最新版本清单，与本机的构建哈希比对。</p>
      </div>
      <dl class="versionGrid">
        <div class="versionItem">
          <dt>版本</dt>
          <dd>{{ version }}</dd>
        </div>
        <div class="versionItem">
          <dt>通道</dt>
          <dd>{{ channel }}</dd>
        </div>
        <div class="versionItem">
          <dt>构建</dt>
          <dd class="buildHash">{{ hash }}</dd>
        </div>
      </dl>
    </section>

    <section v-if="isDesktop" class="settingSection">
      <div class="settingInfo">
        <h3>更新</h3>
        <p class="description">{{ statusText }}</p>
      </div>
      <el-progress v-if="progressPercent !== undefined" :percentage="progressPercent" :stroke-width="8" :show-text="false" />
      <el-alert v-if="desktopUpdateError" :title="desktopUpdateError" type="error" :closable="false" showIcon />
      <div class="updateActions">
        <el-button :icon="IconRefresh" :loading="checking" :disabled="busy" aria-label="检查更新" @click="checkUpdate">检查更新</el-button>
        <el-button v-if="updateReady" type="primary" :loading="applying" :disabled="busy" aria-label="安装更新并重启" @click="applyUpdate">
          立即安装并重启
        </el-button>
        <el-button v-else-if="hasUpdate" type="primary" :icon="IconDownload" :loading="downloading" :disabled="busy" aria-label="下载更新" @click="downloadUpdate">
          下载更新
        </el-button>
      </div>
      <p v-if="snapshot?.canUpdate === false" class="hint">当前平台不支持应用内更新，请下载安装包手动安装。</p>
    </section>

    <section v-else class="settingSection">
      <div class="settingInfo">
        <h3>更新</h3>
        <p class="description">网页版随服务端一起部署，无需单独更新客户端。</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { IconDownload, IconRefresh } from "@tabler/icons-vue";
import { isDesktop } from "@/lib/platform";
import {
  checkDesktopUpdate,
  desktopUpdateAction,
  desktopUpdateError,
  desktopUpdateSnapshot,
  runDesktopUpdate,
} from "@/stores/desktopUpdate";

const snapshot = computed(() => desktopUpdateSnapshot.value);
const version = computed(() => snapshot.value?.version || "未知");
const channel = computed(() => snapshot.value?.channel || "未知");
const hash = computed(() => snapshot.value?.hash || "未知");
const checking = computed(() => desktopUpdateAction.value === "check");
const downloading = computed(() => desktopUpdateAction.value === "download");
const applying = computed(() => desktopUpdateAction.value === "apply");
const busy = computed(() => desktopUpdateAction.value !== null || snapshot.value?.updating === true);
const hasUpdate = computed(() => snapshot.value?.updateAvailable === true && snapshot.value?.updateReady !== true);
const updateReady = computed(() => snapshot.value?.updateReady === true);

const statusText = computed(() => {
  const current = snapshot.value;
  if (!current) return "正在读取更新状态…";
  if (current.installFailure) return `上次安装失败：${current.installFailure.message}`;
  if (current.updating) return current.updateProgress ? "正在下载更新包…" : "正在准备更新…";
  if (current.updateReady) return `新版本 ${current.latestVersion} 已下载，可以安装。安装后客户端会自动重启。`;
  if (current.updateAvailable) return `发现新版本 ${current.latestVersion}，当前为 ${current.version}。`;
  if (current.error) return `检查更新失败：${current.error}`;
  if (current.channel === "dev") return "开发通道不检查更新。";
  return `已是最新版本 ${current.version}。`;
});

const progressPercent = computed(() => {
  const progress = snapshot.value?.updateProgress;
  if (!progress || !progress.total) return undefined;
  return Math.min(100, Math.round((progress.received / progress.total) * 100));
});

onMounted(async () => {
  if (!isDesktop || snapshot.value) return;
  await runDesktopUpdate("read").catch(() => undefined);
});

async function checkUpdate() {
  await checkDesktopUpdate().catch(() => undefined);
}

async function downloadUpdate() {
  await runDesktopUpdate("download")
    .then(() => ElMessage.success("更新包已下载，可以安装。"))
    .catch((error: unknown) => ElMessage.error(error instanceof Error ? error.message : String(error)));
}

async function applyUpdate() {
  await runDesktopUpdate("apply").catch((error: unknown) =>
    ElMessage.error(error instanceof Error ? error.message : String(error)),
  );
}
</script>

<style lang="scss" scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 0 4px 8px;

  .settingSection {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 12px;

    h3 {
      margin: 0;
      color: var(--el-text-color-primary);
      font-size: 14px;
      font-weight: 600;
    }

    .settingInfo {
      min-width: 0;

      .description {
        margin: 6px 0 0;
        color: var(--el-text-color-secondary);
        font-size: 12px;
        line-height: 1.6;
      }
    }
  }

  .versionGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin: 0;

    .versionItem {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 12px;
      border: 1px solid var(--el-border-color-lighter);
      border-radius: var(--ui-radius-large, 8px);

      dt {
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }

      dd {
        margin: 0;
        color: var(--el-text-color-primary);
        font-size: 13px;
        word-break: break-all;
      }

      .buildHash {
        font-family: var(--el-font-family-mono, monospace);
        font-size: 12px;
      }
    }
  }

  .updateActions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .hint {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}
</style>