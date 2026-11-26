<script setup lang="ts">
import { ref } from "vue";

export interface PendingUploadFile {
  name: string;
  size: number;
  dataBase64: string;
}

const props = defineProps<{
  open: boolean;
  mode: "upload" | "import";
  defaultPack: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  upload: [payload: { pack: string; files: PendingUploadFile[]; autoTag: boolean; character: string; work: string }];
  importDir: [payload: { dirPath: string; pack: string; autoTag: boolean }];
}>();

const pack = ref(props.defaultPack || "default");
const character = ref("");
const work = ref("");
const autoTag = ref(true);
const dirPath = ref("");
const dragging = ref(false);
const pickedFiles = ref<PendingUploadFile[]>([]);

async function readFiles(fileList: FileList | null): Promise<void> {
  if (!fileList) return;
  const next: PendingUploadFile[] = [...pickedFiles.value];
  for (const file of Array.from(fileList)) {
    if (next.length >= 60) break;
    const dataBase64 = await fileToBase64(file);
    next.push({ name: file.name, size: file.size, dataBase64 });
  }
  pickedFiles.value = next;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  void readFiles(event.dataTransfer?.files ?? null);
}

function submitUpload(): void {
  if (pickedFiles.value.length === 0) return;
  emit("upload", {
    pack: pack.value.trim() || "default",
    files: pickedFiles.value,
    autoTag: autoTag.value,
    character: character.value.trim(),
    work: work.value.trim(),
  });
  pickedFiles.value = [];
}

function submitImportDir(): void {
  if (!dirPath.value.trim()) return;
  emit("importDir", {
    dirPath: dirPath.value.trim(),
    pack: pack.value.trim() || "default",
    autoTag: autoTag.value,
  });
}
</script>

<template>
  <div v-if="open" class="st-modal-backdrop" @mousedown.self="emit('close')">
    <div class="st-modal" style="width: min(560px, 100%)">
      <div class="st-modal-head">
        <h2>{{ mode === "upload" ? "批量上传表情包" : "服务器本地目录导入" }}</h2>
        <button class="st-btn st-btn-sm" type="button" @click="emit('close')">关闭</button>
      </div>

      <div class="st-form-grid" style="margin-bottom: 12px">
        <div class="st-field">
          <label>目标表情包（Pack）</label>
          <input v-model="pack" class="st-input" placeholder="default" />
        </div>
        <div class="st-field" style="justify-content: flex-end">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--st-ink)">
            <input v-model="autoTag" type="checkbox" />
            导入后加入 VLM 自动识别队列
          </label>
        </div>

        <template v-if="mode === 'upload'">
          <div class="st-field">
            <label>预设角色线索（可选）</label>
            <input v-model="character" class="st-input" placeholder="例如：小桃" />
          </div>
          <div class="st-field">
            <label>预设作品线索（可选）</label>
            <input v-model="work" class="st-input" placeholder="例如：示例作品" />
          </div>
        </template>
        <template v-else>
          <div class="st-field full">
            <label>服务器本地目录绝对路径（子目录名将自动作为默认分类）</label>
            <input v-model="dirPath" class="st-input st-mono" placeholder="例如：D:\stickers\my-pack" />
          </div>
        </template>
      </div>

      <template v-if="mode === 'upload'">
        <label
          class="st-dropzone"
          :class="{ active: dragging }"
          style="display: block"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp"
            style="display: none"
            @change="readFiles(($event.target as HTMLInputElement).files)"
          />
          <div>点击选择或拖拽多张图片到此处（支持 PNG / JPG / GIF / WebP，单批最多 60 张）</div>
          <div v-if="pickedFiles.length > 0" style="margin-top: 8px; color: var(--st-accent); font-weight: 600">已选择 {{ pickedFiles.length }} 个文件</div>
        </label>
        <div class="st-row" style="justify-content: flex-end">
          <button v-if="pickedFiles.length > 0" class="st-btn" type="button" @click="pickedFiles = []">清空列表</button>
          <button class="st-btn st-btn-primary" type="button" :disabled="busy || pickedFiles.length === 0" @click="submitUpload">开始上传</button>
        </div>
      </template>

      <template v-else>
        <div class="st-row" style="justify-content: flex-end">
          <button class="st-btn st-btn-primary" type="button" :disabled="busy || !dirPath.trim()" @click="submitImportDir">开始扫描导入</button>
        </div>
      </template>
    </div>
  </div>
</template>
