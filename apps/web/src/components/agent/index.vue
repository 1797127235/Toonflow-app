<template>
  <section v-show="visible" class="agent">
    <agentMenu
      :key="conversationKey"
      :name="name"
      :history="history"
      :sessionFile="sessionFile"
      :parentFile="selectedConversation?.parentFile"
      :subAgents="selectedConversation?.subAgents"
      :loading="loading || historyLoading"
      @open-sub-agent="selectConversation"
      @back="backToParent"
      @new-chat="newConversation"
      @history="loadHistory(!initialized)"
      @select="selectConversation"
      @rename="renameConversation"
      @remove="removeConversation"
      @close="visible = false">
      <template #actions><slot name="menuActions" /></template>
    </agentMenu>
    <conversation
      v-for="item in conversations"
      v-show="item.key === conversationKey"
      :key="item.key"
      :ref="instance => setConversationRef(item, instance)"
      :active="visible && item.key === conversationKey"
      :initialSession="item.session"
      :sessionFile="item.file"
      v-model:engine="item.engine"
      :disabled="loading || !initialized"
      :forkingId="forkingId"
      @session="setSessionFile(item, $event)"
      @event="receiveAgentEvent"
      @sent="updateConversationName(item, $event)"
      @fork="forkConversation(item, $event)" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from "vue";
import axios from "axios";
import { translate } from "@toonflow/i18n/vue";
import { ElMessage } from "element-plus";
import { useWorkspaceStore } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { AgentAttachment, AgentConversation, AgentHistory, AgentMessage } from "./types";
import type { AgentEvent, AgentSubAgent } from "@toonflow/server/agent/types";
import agentMenu from "./menu.vue";
import conversation from "./conversation.vue";

const visible = defineModel<boolean>({ default: false });
const engine = defineModel<"builtin" | "acp">("engine", { default: "builtin" });
type OpenConversation = { key: number; name: string; file?: string; parentFile?: string; subAgents: AgentSubAgent[]; session: AgentConversation | null; engine: "builtin" | "acp" };
// ACT: 会话实例保留到工作区关闭，让切换后的回复继续接收流式内容。
const conversations = ref<OpenConversation[]>([]);
const conversationKey = ref(0);
const selectedConversation = computed(() => conversations.value.find(item => item.key === conversationKey.value));
// ACT: 新对话是现有自动命名逻辑使用的保留值；仅翻译显示，不改变存储或比较值。
const name = computed(() => {
  const value = selectedConversation.value?.name;
  return value && value !== "新对话" ? value : translate("新对话");
});
const sessionFile = computed(() => selectedConversation.value?.file);
const workspaceStore = useWorkspaceStore();
const history = ref<AgentHistory[]>([]);
const loading = ref(false);
const historyLoading = ref(false);
const forkingId = ref<string>();
const initialized = ref(false);
let requestId = 0;
let nextConversationKey = 0;
const conversationRefs = new Map<number, InstanceType<typeof conversation>>();
const pendingEvents = new Map<number, AgentEvent[]>();

function showConversation(session: AgentConversation | null, activate = true) {
  const existing = session && conversations.value.find(item => item.file === session.file);
  if (existing) {
    if (activate) conversationKey.value = existing.key;
    return existing;
  }
  const key = ++nextConversationKey;
  const item = { key, name: session?.name || "新对话", file: session?.file, parentFile: session?.parentFile, subAgents: session?.subAgents ?? [], session, engine: session?.kind === "acp" ? "acp" : engine.value };
  conversations.value.push(item);
  if (activate) conversationKey.value = key;
  return conversations.value[conversations.value.length - 1]!;
}

function setConversationRef(item: OpenConversation, instance: Element | ComponentPublicInstance | null) {
  if (!instance) { conversationRefs.delete(item.key); return; }
  const view = instance as InstanceType<typeof conversation>;
  conversationRefs.set(item.key, view);
  for (const event of pendingEvents.get(item.key) ?? []) view.receiveEvent(event);
  pendingEvents.delete(item.key);
}

function deliverEvent(item: OpenConversation, event: AgentEvent) {
  const view = conversationRefs.get(item.key);
  if (view) view.receiveEvent(event);
  else {
    const events = pendingEvents.get(item.key) ?? [];
    events.push(event);
    pendingEvents.set(item.key, events);
  }
}

function receiveAgentEvent(event: AgentEvent) {
  if (event.type === "subAgent") {
    const parent = conversations.value.find(item => item.file === event.agent.parentFile);
    if (!parent) return;
    const current = parent.subAgents.find(agent => agent.file === event.agent.file);
    if (current) Object.assign(current, event.agent);
    else parent.subAgents.push(event.agent);
    if (event.agent.status === "running" && !conversations.value.some(item => item.file === event.agent.file)) {
      showConversation({ ...event.agent, parentFile: parent.file, messages: [], running: true }, false);
    }
    return;
  }
  if (event.type === "subAgentEvent") {
    const child = conversations.value.find(item => item.file === event.file);
    if (event.event.type === "error") {
      const agent = conversations.value.find(item => item.file === child?.parentFile)?.subAgents.find(agent => agent.file === event.file);
      if (agent?.status === "running") Object.assign(agent, { status: "cancelled", result: event.event.message });
    }
    if (child) deliverEvent(child, event.event);
    return;
  }
  if (event.type === "report") {
    const parent = conversations.value.find(item => item.file === event.parentFile);
    if (parent) deliverEvent(parent, event);
  }
}

function backToParent() {
  const file = selectedConversation.value?.parentFile;
  if (file) void selectConversation(file);
}

function updateConversationName(item: OpenConversation, prompt: string) {
  if (item.name !== "新对话") return;
  item.name = prompt.slice(0, 80);
  const entry = history.value.find(entry => entry.file === item.file);
  if (entry) entry.name = item.name;
}

function setSessionFile(item: OpenConversation, file: string) {
  item.file = file;
  if (item.parentFile) return;
  if (!history.value.some(entry => entry.file === file)) {
    history.value.unshift({ file, name: item.name, modified: new Date().toISOString(), messageCount: 0 });
  }
}

async function newConversation() {
  if (loading.value || historyLoading.value) return;
  const directory = workspaceStore.project?.directory;
  if (!directory) return ElMessage.warning("请先打开项目");
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const { data } = await axios.post<{ code: number; data: AgentConversation; message?: string }>("/api/agent/create", {
      directory,
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (data.code !== 200) throw new Error(data.message || "新建对话失败");
    if (currentRequest !== requestId) return;
    const session = data.data;
    history.value.unshift({ file: session.file, name: session.name, modified: new Date().toISOString(), messageCount: 0 });
    const opened = showConversation(session);
    // 新对话的文件是刚建的，按当前选择的 agent 打开，而不是按会话文件的默认类型。
    opened.engine = engine.value;
    initialized.value = true;
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(axios.isAxiosError(error)
      ? error.response?.data?.message || "新建对话失败"
      : error instanceof Error ? error.message : "新建对话失败");
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

async function forkConversation(item: OpenConversation, message: AgentMessage) {
  const directory = workspaceStore.project?.directory;
  const entryId = message.entryId ?? message.id;
  if (!directory || !item.file || loading.value || historyLoading.value || forkingId.value) return;
  const currentRequest = ++requestId;
  loading.value = true;
  forkingId.value = entryId;
  let openedKey: number | undefined;
  let draft: { prompt: string; attachments?: AgentAttachment[] } | undefined;
  try {
    const { data } = await axios.post<{ code: number; data: { session: AgentConversation; prompt: string; attachments?: AgentAttachment[] }; message?: string }>("/api/agent/fork", {
      directory, sessionFile: item.file, entryId,
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (data.code !== 200) throw new Error(data.message || "分支对话失败");
    if (currentRequest !== requestId) return;
    const { session, prompt, attachments } = data.data;
    history.value.unshift({ file: session.file, name: session.name, modified: new Date().toISOString(), messageCount: session.messages.length });
    openedKey = showConversation(session).key;
    initialized.value = true;
    draft = { prompt, attachments };
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(axios.isAxiosError(error)
      ? error.response?.data?.message || "分支对话失败"
      : error instanceof Error ? error.message : "分支对话失败");
  } finally {
    if (currentRequest === requestId) loading.value = false;
    forkingId.value = undefined;
  }
  if (!draft || openedKey === undefined || currentRequest !== requestId) return;
  await nextTick();
  conversationRefs.get(openedKey)?.fillPrompt(draft.prompt, draft.attachments);
}

async function readConversation(directory: string, file: string) {
  const { data } = await axios.get<{ code: number; data: AgentConversation; message?: string }>("/api/agent/get", {
    params: { directory, sessionFile: file }, headers: { "x-toonflow-workspace": "1" },
  });
  if (data.code !== 200) throw new Error(data.message || "读取对话失败");
  return data.data;
}

async function loadHistory(openLatest = false) {
  const directory = workspaceStore.project?.directory;
  if (!directory || loading.value || historyLoading.value) return;
  const currentRequest = ++requestId;
  historyLoading.value = true;
  loading.value = openLatest;
  try {
    const { data } = await axios.get<{ code: number; data: AgentHistory[]; message?: string }>("/api/agent/list", {
      params: { directory }, headers: { "x-toonflow-workspace": "1" },
    });
    if (data.code !== 200) throw new Error(data.message || "读取历史对话失败");
    if (currentRequest !== requestId) return;
    history.value = data.data;
    // 首条回复结束前会话可能尚未落盘，仍允许从历史菜单切回。
    for (const item of conversations.value) if (item.file) setSessionFile(item, item.file);
    if (openLatest) {
      const session = !workspaceStore.pendingAgentMessage && data.data[0] ? await readConversation(directory, data.data[0].file) : null;
      if (currentRequest !== requestId) return;
      showConversation(session);
      initialized.value = true;
    }
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(error instanceof Error ? error.message : "读取历史对话失败");
  } finally {
    if (currentRequest === requestId) {
      historyLoading.value = false;
      loading.value = false;
    }
  }
}

async function selectConversation(file: string) {
  const directory = workspaceStore.project?.directory;
  if (!directory || loading.value || historyLoading.value || file === sessionFile.value) return;
  const existing = conversations.value.find(item => item.file === file);
  if (existing) {
    conversationKey.value = existing.key;
    return;
  }
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const session = await readConversation(directory, file);
    if (currentRequest !== requestId) return;
    showConversation(session);
    initialized.value = true;
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(error instanceof Error ? error.message : "读取对话失败");
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

async function renameConversation(file: string, value: string) {
  const directory = workspaceStore.project?.directory;
  const item = history.value.find(item => item.file === file);
  const nextName = value.trim();
  if (!directory || loading.value || historyLoading.value || (!item && file !== sessionFile.value)) return;
  if (!nextName || nextName.length > 80) return ElMessage.warning("请输入 1–80 个字符的对话名称");
  if (nextName === (file === sessionFile.value ? name.value : item?.name)) return;
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    const { data } = await axios.patch<{ code: number; data: { name: string }; message?: string }>("/api/agent/rename", {
      directory, sessionFile: file, name: nextName,
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (data.code !== 200) throw new Error(data.message || "重命名对话失败");
    if (currentRequest !== requestId) return;
    if (item) item.name = data.data.name;
    const opened = conversations.value.find(item => item.file === file);
    if (opened) opened.name = data.data.name;
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(axios.isAxiosError(error)
      ? error.response?.data?.message || "重命名对话失败"
      : error instanceof Error ? error.message : "重命名对话失败");
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

async function removeConversation(file: string) {
  const directory = workspaceStore.project?.directory;
  if (!directory || loading.value || historyLoading.value || history.value.length <= 1 || !history.value.some(item => item.file === file)) return;
  if (!/^[\w-]+\.jsonl$/.test(file)) return ElMessage.error("对话文件名无效");
  const currentRequest = ++requestId;
  loading.value = true;
  try {
    await useWorkspaceFiles(directory).remove(`.agent/sessions/${file}`);
    if (currentRequest !== requestId) return;
    history.value = history.value.filter(item => item.file !== file);
    if (file === sessionFile.value) {
      showConversation(null);
      initialized.value = true;
    }
    conversations.value = conversations.value.filter(item => item.file !== file);
  } catch (error) {
    if (currentRequest === requestId) ElMessage.error(axios.isAxiosError(error)
      ? error.response?.data?.message || "移除历史对话失败"
      : error instanceof Error ? error.message : "移除历史对话失败");
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
}

watch(() => selectedConversation.value?.engine, value => {
  // 当前会话的 agent 作为新对话的默认值，避免在 ACP 会话里新建又跳回内置。
  if (value) engine.value = value;
}, { immediate: true });
watch(() => workspaceStore.project?.directory, directory => {
  requestId++;
  history.value = [];
  conversations.value = [];
  conversationRefs.clear();
  pendingEvents.clear();
  initialized.value = false;
  loading.value = false;
  historyLoading.value = false;
  showConversation(null);
  if (visible.value && directory) void loadHistory(true);
}, { immediate: true });
watch(visible, active => {
  if (active && !initialized.value) void loadHistory(true);
});
onBeforeUnmount(() => { requestId++; });

</script>

<style scoped lang="scss">
.agent {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  padding-bottom: 8px;
  overflow: hidden;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
</style>
