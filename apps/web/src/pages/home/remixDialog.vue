<template>
  <el-dialog :modelValue="true" class="remixDialog" :title="template.title" width="min(1080px, calc(100vw - 32px))" alignCenter appendToBody :closeOnClickModal="false" :closeOnPressEscape="!submitting" :showClose="!submitting" @close="emit('close')">
    <p class="templateDescription">{{ template.description }}</p>
    <div class="remixContent">
      <div class="effectPreview">
        <video v-if="previewVideo" :src="previewVideo" :poster="coverUrl" controls playsinline loop preload="metadata" aria-label="工作流效果预览" />
        <img v-else :src="coverUrl" :alt="`${template.title}效果预览`" />
      </div>
      <form id="remixForm" class="remixForm" @submit.prevent="startCreation">
        <fieldset v-if="template.id === 'danceCoverVideo'" class="branchChoice" :disabled="submitting">
          <legend>动作参考方式</legend>
          <label><input v-model="branch" type="radio" value="teaching" />教学视频</label>
          <label><input v-model="branch" type="radio" value="motion" />动作捕捉</label>
        </fieldset>
        <div class="referenceHeader">
          <h3>参考素材</h3>
          <span>{{ materialCount }}/{{ inputFields.length }}</span>
        </div>
        <p class="uploadHint">图片或视频，每个文件不超过 100 MB。</p>
        <div class="referenceItems">
          <div v-for="field in inputFields" :key="field.id" class="referenceItem">
            <label class="referenceLabel" :for="`remixFile${field.id}`">{{ field.label }}<span>{{ field.type === 'video' ? '可使用模板参考' : '必填' }}</span></label>
            <label class="uploadArea" :class="{ hasMaterial: materials[field.id] }" :for="`remixFile${field.id}`">
              <img v-if="materials[field.id]?.url && field.type === 'image'" :src="materials[field.id]!.url" alt="" />
              <video v-else-if="field.type === 'video' && (materials[field.id]?.url || field.exampleUrl)" :src="materials[field.id]?.url || field.exampleUrl" muted playsinline preload="metadata" />
              <template v-else><icon-photo-plus :size="24" aria-hidden="true" /><span>选择{{ field.type === 'video' ? '视频' : '图片' }}</span></template>
              <input :id="`remixFile${field.id}`" class="fileInput" type="file" :accept="field.type === 'video' ? 'video/*' : 'image/*'" :disabled="submitting" :required="field.type !== 'video' && !materials[field.id]" @change="selectMaterial(field.id, field.type, $event)" />
            </label>
            <div v-if="materials[field.id]" class="materialActions">
              <span :title="materials[field.id]!.name">{{ materials[field.id]!.name }}</span>
              <button type="button" :disabled="submitting" :aria-label="`移除${field.label}`" @click="removeMaterial(field.id)"><icon-x :size="16" aria-hidden="true" /></button>
            </div>
            <p v-else-if="field.type === 'video'" class="defaultReference">使用模板动作视频，可选择文件替换</p>
          </div>
        </div>
        <div v-for="field in textFields" :key="field.id" class="textField">
          <label :for="`remixText${field.id}`">{{ field.label }}</label>
          <textarea :id="`remixText${field.id}`" v-model="textValues[field.id]" :required="field.required" :disabled="submitting" rows="2" />
        </div>
        <details class="extraNotes">
          <summary>补充说明（可选）</summary>
          <label class="notesLabel" for="remixNotes">补充要求</label>
          <textarea id="remixNotes" v-model="notes" :disabled="submitting" rows="4" />
        </details>
        <p v-if="formError" class="formError" role="alert">{{ formError }}</p>
      </form>
    </div>
    <template #footer>
      <el-button :disabled="submitting" @click="emit('close')">取消</el-button>
      <el-button type="primary" nativeType="submit" form="remixForm" :loading="submitting">开始创作</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { buildRemixPrompt, remixAssetUrl, remixTextFields, type RemixRequest, type RemixTemplate } from "./remixTemplates";
import type { AgentAttachment } from "@/components/agent/types";

const props = defineProps<{ template: RemixTemplate; busy?: boolean }>();
const emit = defineEmits<{ close: []; start: [request: RemixRequest] }>();
const branch = ref("teaching");
const materials = ref<Record<string, { file: File; url: string; name: string }>>({});
const textValues = ref<Record<string, string>>({});
const notes = ref("");
const preparing = shallowRef(false);
const formError = shallowRef("");
const submitting = computed(() => preparing.value || props.busy);
const coverUrl = remixAssetUrl(props.template.id, props.template.cover);
const previewVideo = props.template.previewVideo ? remixAssetUrl(props.template.id, props.template.previewVideo) : undefined;
const textFields = remixTextFields(props.template);
const inputFields = computed(() => props.template.inputs
  .filter(input => props.template.id !== "danceCoverVideo" || (branch.value === "teaching" ? ["input1", "input2"] : ["input3", "input4"]).includes(input.id))
  .map(input => ({
    ...input,
    label: props.template.id === "catDance" ? (input.type === "video" ? "舞蹈参考视频" : "动物照片")
      : props.template.id === "electronicsAd" ? "产品参考图" : input.title.replace(/^替换/, "").replace(/\s*·.*$/, "").trim(),
    exampleUrl: input.type === "video" && input.example ? remixAssetUrl(props.template.id, input.example) : undefined,
  }))
  .sort((left, right) => Number(left.type === "video") - Number(right.type === "video")));
const materialCount = computed(() => inputFields.value.filter(field => materials.value[field.id] || field.exampleUrl).length);
const lifetime = new AbortController();

onBeforeUnmount(() => {
  lifetime.abort();
  Object.values(materials.value).forEach(material => URL.revokeObjectURL(material.url));
});

function removeMaterial(id: string) {
  const material = materials.value[id];
  if (material) URL.revokeObjectURL(material.url);
  delete materials.value[id];
}

function selectMaterial(id: string, type: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  formError.value = "";
  if (!file.type.startsWith(`${type}/`)) { formError.value = `请选择${type === "video" ? "视频" : "图片"}文件`; return; }
  if (!file.size || file.size > 100 * 1024 * 1024) { formError.value = "素材不能为空且不能超过 100 MB"; return; }
  removeMaterial(id);
  materials.value[id] = { file, url: URL.createObjectURL(file), name: file.name };
}

async function startCreation() {
  if (submitting.value) return;
  formError.value = "";
  for (const field of textFields) {
    if (field.required && !textValues.value[field.id]?.trim()) { formError.value = `请填写${field.label}`; return; }
  }
  for (const input of inputFields.value) {
    if (!materials.value[input.id] && input.type !== "video") { formError.value = `请上传${input.label}`; return; }
  }
  preparing.value = true;
  try {
    const attachments: AgentAttachment[] = [];
    const mapping = [];
    for (const input of inputFields.value) {
      let file = materials.value[input.id]?.file;
      if (!file && input.type === "video" && input.example) {
        const url = remixAssetUrl(props.template.id, input.example);
        if (!url) throw new Error("模板参考视频不存在，请选择视频文件");
        const response = await fetch(url, { signal: lifetime.signal });
        if (!response.ok) throw new Error("读取模板参考视频失败，请重试或上传自己的视频");
        file = new File([await response.blob()], `${input.id}.mp4`, { type: "video/mp4" });
      }
      if (!file) throw new Error(`请上传${input.label}`);
      const name = `${input.id}_${file.name}`;
      attachments.push({ name, path: "", mimeType: file.type, file: new File([file], name, { type: file.type }) });
      mapping.push({ inputId: input.id, name });
    }
    lifetime.signal.throwIfAborted();
    emit("start", {
      prompt: buildRemixPrompt(props.template, textValues.value, mapping, notes.value, props.template.id === "danceCoverVideo" ? branch.value : ""),
      attachments,
      template: props.template,
      values: { ...textValues.value },
      materials: mapping,
      notes: notes.value,
      branch: props.template.id === "danceCoverVideo" ? branch.value : "",
    });
  } catch (error) {
    if (!lifetime.signal.aborted) formError.value = error instanceof Error ? error.message : "准备创作素材失败，请重试";
  } finally { preparing.value = false; }
}
</script>

<style lang="scss">
.remixDialog.el-dialog {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 32px);
  padding: 24px;
  border-radius: calc(var(--ui-radius) * 2.5);

  .el-dialog__header { flex-shrink: 0; margin: 0; padding-bottom: 6px; }
  .el-dialog__title { font-size: 22px; font-weight: 600; }
  .el-dialog__body {
    min-height: 0;
    overflow-y: auto;

    .templateDescription { margin: 0 36px 24px 0; color: var(--el-text-color-regular); font-size: 14px; line-height: 1.7; }
    .remixContent {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      align-items: start;
      gap: 40px;

      .effectPreview {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        min-height: 320px;
        background: var(--el-fill-color-light);
        border-radius: calc(var(--ui-radius) * 2);
        overflow: hidden;

        video, img { display: block; width: 100%; max-height: min(62dvh, 560px); object-fit: contain; }
      }

      .remixForm {
        min-width: 0;

        .branchChoice { display: flex; gap: 16px; margin: 0 0 20px; padding: 0; border: 0; font-size: 14px; legend { margin-bottom: 10px; } label { display: flex; align-items: center; gap: 6px; } }
        .referenceHeader { display: flex; justify-content: space-between; align-items: center; gap: 12px; h3 { margin: 0; font-size: 14px; font-weight: 500; } > span { font-size: 12px; color: var(--el-text-color-regular); } }
        .uploadHint { margin: 8px 0 16px; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.6; }
        .referenceItems {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
          margin-bottom: 24px;

          .referenceItem {
            min-width: 0;

            .referenceLabel { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin-bottom: 8px; font-size: 13px; line-height: 1.5; > span { font-size: 12px; color: var(--el-text-color-regular); } }
            .uploadArea {
              position: relative;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              aspect-ratio: 1;
              gap: 8px;
              overflow: hidden;
              border: 1px solid var(--el-border-color-light);
              border-radius: calc(var(--ui-radius) * 2);
              background: var(--el-fill-color-light);
              color: var(--el-text-color-regular);
              font-size: 13px;
              cursor: pointer;

              &:hover, &:focus-within { border-color: var(--el-color-primary); }
              &:focus-within { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
              > img, > video { width: 100%; height: 100%; position: absolute; inset: 0; object-fit: contain; }
              .fileInput { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
            }
            .materialActions { display: flex; align-items: center; gap: 4px; margin-top: 6px; > span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; } > button { display: grid; place-items: center; width: 28px; height: 28px; border: 0; background: transparent; color: inherit; cursor: pointer; } }
            .defaultReference { margin: 8px 0 0; font-size: 12px; line-height: 1.6; color: var(--el-text-color-regular); }
          }
        }
        .textField { margin-top: 20px; > label { display: block; margin-bottom: 8px; font-size: 14px; } }
        textarea { display: block; width: 100%; padding: 12px; border: 1px solid var(--el-border-color); border-radius: var(--ui-radius); background: var(--el-fill-color-blank); color: var(--el-text-color-primary); font: inherit; font-size: 14px; line-height: 1.7; resize: vertical; &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; } }
        .extraNotes { margin-top: 24px; > summary { width: fit-content; font-size: 14px; color: var(--el-text-color-regular); cursor: pointer; } .notesLabel { display: block; margin: 12px 0 8px; font-size: 13px; } }
        .formError { margin: 16px 0 0; color: var(--el-color-danger); font-size: 13px; }
      }
    }
  }
  .el-dialog__footer { flex-shrink: 0; padding-top: 24px; .el-button { min-height: 40px; } .el-button--primary { min-width: 160px; } }

  @media (max-width: 700px) {
    padding: 20px;
    .el-dialog__body .remixContent { grid-template-columns: minmax(0, 1fr); gap: 24px; .effectPreview { position: static; min-height: 0; video, img { max-height: 32dvh; } } }
  }
}
</style>
