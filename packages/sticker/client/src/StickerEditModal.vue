<script setup lang="ts">
import { reactive, watch } from "vue";

import type { StickerRecord, StickerStatus, StickerUpdatePatch } from "./types";

const props = defineProps<{
  sticker: StickerRecord | null;
  previewSrc: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [id: string, patch: StickerUpdatePatch];
  retag: [id: string];
  ban: [id: string];
}>();

const form = reactive({
  pack: "",
  status: "active" as StickerStatus,
  category: "",
  characterName: "",
  workName: "",
  ocrText: "",
  description: "",
  tagsText: "",
  emotionsText: "",
  scenesText: "",
});

watch(
  () => props.sticker,
  (item) => {
    if (!item) return;
    form.pack = item.pack;
    form.status = item.status;
    form.category = item.category;
    form.characterName = item.characterName;
    form.workName = item.workName;
    form.ocrText = item.ocrText;
    form.description = item.description;
    form.tagsText = item.tags.join(", ");
    form.emotionsText = item.emotions.join(", ");
    form.scenesText = item.scenes.join(", ");
  },
  { immediate: true },
);

function splitList(raw: string): string[] {
  return raw
    .split(/[,，、\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function submitSave(): void {
  if (!props.sticker) return;
  emit("save", props.sticker.id, {
    pack: form.pack.trim() || "default",
    status: form.status,
    category: form.category.trim() || "未分类",
    characterName: form.characterName.trim(),
    workName: form.workName.trim(),
    ocrText: form.ocrText.trim(),
    description: form.description.trim(),
    tags: splitList(form.tagsText),
    emotions: splitList(form.emotionsText),
    scenes: splitList(form.scenesText),
  });
}
</script>

<template>
  <div v-if="sticker" class="st-modal-backdrop" @mousedown.self="emit('close')">
    <div class="st-modal">
      <div class="st-modal-head">
        <h2>
          编辑表情详情 · <span class="st-mono">{{ sticker.id }}</span>
        </h2>
        <button class="st-btn st-btn-sm" type="button" @click="emit('close')">关闭</button>
      </div>

      <div class="st-edit-grid">
        <div class="st-edit-preview">
          <img v-if="previewSrc" :src="previewSrc" :alt="sticker.description || sticker.id" />
          <div class="st-mono" style="font-size: 11.5px; color: var(--st-muted)">
            {{ sticker.width }}×{{ sticker.height }} · {{ (sticker.size / 1024).toFixed(1) }} KB · {{ sticker.ext.toUpperCase() }}
          </div>
          <div style="font-size: 12px; color: var(--st-muted)">发送 {{ sticker.usageCount }} 次 · 来源 {{ sticker.source.kind }}</div>
          <div class="st-row" style="justify-content: center; width: 100%; margin-top: 6px">
            <button class="st-btn st-btn-sm" type="button" :disabled="busy" @click="emit('retag', sticker.id)">结合线索重识别</button>
            <button class="st-btn st-btn-sm st-btn-danger" type="button" :disabled="busy" @click="emit('ban', sticker.id)">拉黑删除</button>
          </div>
        </div>

        <form class="st-form-grid" @submit.prevent="submitSave">
          <div class="st-field">
            <label>所属包（Pack）</label>
            <input v-model="form.pack" class="st-input" placeholder="default" />
          </div>
          <div class="st-field">
            <label>状态</label>
            <select v-model="form.status" class="st-select">
              <option value="active">已启用（active）</option>
              <option value="pending">待审核（pending）</option>
            </select>
          </div>
          <div class="st-field">
            <label>分类</label>
            <input v-model="form.category" class="st-input" placeholder="例如：开心 / 无语" />
          </div>
          <div class="st-field">
            <label>角色名</label>
            <input v-model="form.characterName" class="st-input" placeholder="例如：小桃" />
          </div>
          <div class="st-field">
            <label>作品名</label>
            <input v-model="form.workName" class="st-input" placeholder="例如：示例作品" />
          </div>
          <div class="st-field">
            <label>图上文字（OCR）</label>
            <input v-model="form.ocrText" class="st-input" placeholder="图里写的字" />
          </div>
          <div class="st-field full">
            <label>标签（逗号分隔）</label>
            <input v-model="form.tagsText" class="st-input" placeholder="萌, 摸头, 委屈" />
          </div>
          <div class="st-field">
            <label>情绪词（逗号分隔）</label>
            <input v-model="form.emotionsText" class="st-input" placeholder="开心, 期待" />
          </div>
          <div class="st-field">
            <label>适用场景（逗号分隔）</label>
            <input v-model="form.scenesText" class="st-input" placeholder="打招呼, 吐槽" />
          </div>
          <div class="st-field full">
            <label>画面描述</label>
            <textarea v-model="form.description" class="st-textarea" rows="3" placeholder="简述画面与用法"></textarea>
          </div>
          <div class="st-field full" style="flex-direction: row; justify-content: flex-end; gap: 8px; margin-top: 6px">
            <button class="st-btn" type="button" @click="emit('close')">取消</button>
            <button class="st-btn st-btn-primary" type="submit" :disabled="busy">保存修改</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
