<script setup lang="ts">
import { computed } from "vue";

import {
  fieldsForType,
  MODALITY_OPTIONS,
  readThinking,
  SECTION_DESCRIPTIONS,
  SECTION_LABELS,
  SECTION_ORDER,
  THINK_LEVEL_OPTIONS,
  typeOfDraft,
  type FieldErrors,
  type FieldKey,
  type FieldSection,
  type ModelFieldDef,
} from "../lib/modelFields";
import { MODEL_TYPE_OPTIONS } from "../lib/models";
import ChipSelect from "./ChipSelect.vue";
import FormField from "./FormField.vue";
import Icon from "./Icon.vue";
import ToggleSwitch from "./ToggleSwitch.vue";

/**
 * 模型声明的类型驱动表单：字段、提示与适用范围全部来自 modelFields 注册表。
 * 隐藏字段不渲染也不参与提交；字段级错误就地展示。
 */
const props = withDefaults(
  defineProps<{
    draft: Record<string, unknown>;
    errors?: FieldErrors;
    disabled?: boolean;
    /** 提供商选择等基础字段由外层渲染时，跳过 basic 分区。 */
    skipBasic?: boolean;
  }>(),
  { errors: () => ({}), skipBasic: false },
);

const emit = defineEmits<{ patch: [key: string, value: unknown] }>();

const type = computed(() => typeOfDraft(props.draft));

const sections = computed<Array<{ section: FieldSection; fields: ModelFieldDef[] }>>(() => {
  const fields = fieldsForType(type.value);
  return SECTION_ORDER.map((section) => ({ section, fields: fields.filter((field) => field.section === section) })).filter(
    (entry) => entry.fields.length > 0 && !(entry.section === "basic" && props.skipBasic),
  );
});

const thinking = computed(() => readThinking(props.draft));
const input = computed(() => (Array.isArray(props.draft.input) ? props.draft.input.filter((item): item is string => typeof item === "string") : []));
const efforts = computed(() => thinking.value.efforts);

function textValue(key: string): string {
  const value = props.draft[key];
  return typeof value === "string" ? value : "";
}

function numberText(key: string): string {
  const value = props.draft[key];
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function onNumber(key: string, raw: string): void {
  emit("patch", key, raw.trim().length === 0 ? undefined : Number(raw));
}

function errorOf(key: FieldKey): string | undefined {
  const message = props.errors?.[key];
  return message === undefined || message.length === 0 ? undefined : message;
}
</script>

<template>
  <div class="stack-sm model-fields">
    <section v-for="entry in sections" :key="entry.section" class="form-section">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">{{ SECTION_LABELS[entry.section] }}</div>
          <div class="form-section-desc">{{ SECTION_DESCRIPTIONS[entry.section] }}</div>
        </div>
      </div>

      <div class="form-grid">
        <template v-for="field in entry.fields" :key="field.key">
          <FormField
            :label="field.unit === undefined ? field.label : `${field.label}（${field.unit}）`"
            :required="field.required"
            :hint="field.hint"
            :error="errorOf(field.key)"
          >
            <select
              v-if="field.input === 'enum'"
              class="select"
              :value="type"
              :disabled="disabled"
              aria-label="模型类型"
              @change="emit('patch', 'type', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="option in MODEL_TYPE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>

            <input
              v-else-if="field.input === 'text'"
              class="input"
              :class="{ 'input-mono': field.key === 'id' }"
              :value="textValue(field.key)"
              :placeholder="field.placeholder"
              :disabled="disabled"
              autocomplete="off"
              @input="emit('patch', field.key, ($event.target as HTMLInputElement).value)"
            />

            <input
              v-else-if="field.input === 'number'"
              class="input"
              type="number"
              min="1"
              step="1"
              :value="numberText(field.key)"
              :placeholder="field.placeholder"
              :disabled="disabled"
              :aria-label="field.label"
              @input="onNumber(field.key, ($event.target as HTMLInputElement).value)"
            />

            <ToggleSwitch
              v-else-if="field.input === 'boolean'"
              :checked="draft[field.key] === true"
              :label="draft[field.key] === true ? '支持' : '未启用'"
              :disabled="disabled"
              @update:checked="emit('patch', field.key, $event)"
            />

            <ChipSelect
              v-else-if="field.input === 'modalities'"
              :model-value="input"
              :options="MODALITY_OPTIONS"
              :disabled="disabled"
              aria-label="输入类型"
              @update:model-value="emit('patch', 'input', $event)"
            />

            <div v-else-if="field.input === 'thinking'" class="thinking-field">
              <input
                class="input"
                :value="thinking.mode"
                placeholder="思考模式参数名，例如 reasoning_effort"
                :disabled="disabled"
                aria-label="思考模式参数名"
                @input="emit('patch', 'thinking', { mode: ($event.target as HTMLInputElement).value, efforts: thinking.efforts })"
              />
              <div class="thinking-efforts">
                <span class="field-label">可选档位</span>
                <ChipSelect
                  :model-value="efforts"
                  :options="THINK_LEVEL_OPTIONS"
                  :disabled="disabled"
                  aria-label="思考档位"
                  @update:model-value="emit('patch', 'thinking', { mode: thinking.mode, efforts: $event })"
                />
                <p class="field-hint">
                  <Icon name="info" :size="12" />
                  当前生效值：<span class="mono">{{ thinking.mode.length > 0 ? `${thinking.mode}（${efforts.join("、")}）` : "未声明" }}</span>
                </p>
              </div>
            </div>
          </FormField>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.model-fields .form-section {
  margin-top: 0;
}

.thinking-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.thinking-efforts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
