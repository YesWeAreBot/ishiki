<script setup lang="ts">
import { computed } from "vue";

import { formatCompact } from "../lib/format";
import { describeQuery, loadRemoteModels, remoteEntry } from "../lib/remote";
import type { RemoteModelInfo, RemoteModelsQuery } from "../types";
import Icon from "./Icon.vue";

/**
 * 从提供商在线名单选择模型。名单由服务端代理获取；已声明的模型即使
 * 暂时不在名单里也会列出并明确标记，当前已保存的值始终可见。
 */
const props = defineProps<{
  query: RemoteModelsQuery | undefined;
  /** 该供应商下已声明的模型，用于标记状态与兜底展示。 */
  declared: readonly RemoteModelInfo[];
  disabled?: boolean;
}>();

const emit = defineEmits<{ pick: [model: RemoteModelInfo] }>();

const entry = computed(() => remoteEntry(props.query));
const target = computed(() => describeQuery(props.query ?? {}));

const declaredIds = computed(() => new Set(props.declared.map((model) => model.id)));

/** 在线名单 + 已声明但不在名单里的模型，避免已保存值从选择器里消失。 */
const merged = computed<RemoteModelInfo[]>(() => {
  const models = entry.value?.models ?? [];
  const ids = new Set(models.map((model) => model.id));
  return [...models, ...props.declared.filter((model) => !ids.has(model.id))];
});

function optionLabel(model: RemoteModelInfo): string {
  const name = model.name === undefined || model.name.length === 0 || model.name === model.id ? model.id : `${model.name} · ${model.id}`;
  return declaredIds.value.has(model.id) && (entry.value?.models.some((item) => item.id === model.id) ?? false) ? `${name}（已声明）` : name;
}

function optionDetail(model: RemoteModelInfo): string {
  const parts: string[] = [];
  if (model.contextWindow !== undefined) parts.push(`上下文 ${formatCompact(model.contextWindow)}`);
  if (model.maxTokens !== undefined) parts.push(`输出 ${formatCompact(model.maxTokens)}`);
  if (!declaredIds.value.has(model.id)) parts.push("未声明");
  else if (!(entry.value?.models.some((item) => item.id === model.id) ?? false)) parts.push("不在在线名单中");
  return parts.join(" · ");
}

function onPick(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  if (id.length === 0) return;
  const model = merged.value.find((item) => item.id === id);
  if (model !== undefined) emit("pick", model);
}

function reload(): void {
  if (props.query !== undefined) void loadRemoteModels(props.query, true);
}
</script>

<template>
  <div class="remote-picker stack-sm">
    <div v-if="query === undefined" class="field-hint">先选择供应商并填写访问信息，再获取在线模型名单。</div>

    <template v-else-if="entry === undefined">
      <button type="button" class="btn btn-soft btn-sm" :disabled="disabled" @click="reload"><Icon name="refresh" :size="13" /> 获取在线模型</button>
    </template>

    <template v-else-if="entry.state === 'loading'">
      <div class="row muted small"><span class="spinner" aria-hidden="true"></span> 正在从 {{ target }} 获取模型名单…</div>
    </template>

    <template v-else-if="entry.state === 'error'">
      <div class="error-panel">
        <Icon name="alert" :size="14" />
        <div class="flex-1">
          <div class="strong">在线名单获取失败</div>
          <div class="mono small">{{ entry.error }}</div>
        </div>
        <button type="button" class="btn btn-sm" :disabled="disabled" @click="reload"><Icon name="refresh" :size="13" /> 重试</button>
      </div>
    </template>

    <template v-else>
      <div class="row remote-picker-head">
        <select class="select" aria-label="从在线名单选择模型" :disabled="disabled" @change="onPick">
          <option value="">从在线名单选择（{{ entry.models.length }} 个）…</option>
          <option v-for="model in merged" :key="model.id" :value="model.id">
            {{ optionLabel(model) }}<template v-if="optionDetail(model).length > 0"> · {{ optionDetail(model) }}</template>
          </option>
        </select>
        <button type="button" class="btn btn-sm" :disabled="disabled" title="重新获取名单" @click="reload">
          <Icon name="refresh" :size="13" />
        </button>
      </div>
      <p class="field-hint">选择后自动填入标识、展示名称与该模型上报的默认配置；能力字段需要自行核对。</p>
    </template>
  </div>
</template>

<style scoped>
.remote-picker-head {
  gap: 6px;
}

.remote-picker-head .select {
  flex: 1;
  min-width: 0;
}
</style>
