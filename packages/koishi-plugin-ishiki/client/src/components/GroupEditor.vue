<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { findDeclaredModel, parseReference, THINK_LEVEL_LABELS, THINK_LEVELS } from "../lib/models";
import type { ThinkLevel } from "../lib/models";
import { schemaDefaults } from "../lib/schema";
import type { GroupView, ModelOption, ModelsSchemas, ProviderView } from "../types";
import BaseModal from "./BaseModal.vue";
import FormField from "./FormField.vue";
import Icon from "./Icon.vue";
import SchemaForm from "./SchemaForm.vue";

/** 服务端 SchemaNode 没有从 client/src/types.ts 重新导出，用同一份声明取别名。 */
type SchemaNode = ModelsSchemas["group"];

const props = defineProps<{
  open: boolean;
  /** 编辑目标：带 name 表示编辑已有模型组，否则新建。 */
  modelValue?: { name?: string };
  providers: readonly ProviderView[];
  groups: readonly GroupView[];
  options: readonly ModelOption[];
  schema: SchemaNode;
  /** 组名被 Profile 引用时锁定，避免引用失效。 */
  lockedName?: boolean;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  save: [payload: { name: string; group: GroupView; isNewGroup: boolean }];
  close: [];
}>();

const nameDraft = ref("");
const groupDraft = ref<Record<string, unknown>>({});
const members = ref<string[]>([]);
const memberToAdd = ref("");
const levelToAdd = ref<"" | ThinkLevel>("");
const memberError = ref("");
const formError = ref("");
const confirmDiscard = ref(false);
const baseline = ref("");

const editing = computed(() => props.modelValue?.name !== undefined);
const original = computed(() => (props.modelValue?.name === undefined ? undefined : props.groups.find((entry) => entry.name === props.modelValue?.name)));
const languageOptions = computed(() => props.options.filter((option) => option.kind === "model" && option.type === "language"));
const displayError = computed(() => formError.value || props.error || "");
const dirty = computed(() => props.open && baseline.value.length > 0 && snapshot() !== baseline.value);
/** 组表单只渲染策略与熔断器，候选成员在下方单独编辑。 */
const groupForm = computed(() => withoutKeys(props.schema, ["models"]));

watch(
  () => props.open,
  (open) => {
    if (open) hydrate();
    else {
      confirmDiscard.value = false;
      baseline.value = "";
    }
  },
  { immediate: true },
);

function hydrate(): void {
  formError.value = "";
  memberError.value = "";
  confirmDiscard.value = false;
  baseline.value = "";
  memberToAdd.value = "";
  levelToAdd.value = "";
  const found = original.value;
  const targetName = props.modelValue?.name;
  if (targetName !== undefined && found === undefined) {
    nameDraft.value = targetName;
    groupDraft.value = initialRecord(groupForm.value);
    members.value = [];
    formError.value = "该模型组已不在当前配置里，请关闭编辑器后重试。";
    return;
  }
  if (found === undefined) {
    nameDraft.value = "";
    groupDraft.value = initialRecord(groupForm.value);
    members.value = [];
  } else {
    const draft = initialRecord(groupForm.value);
    draft.strategy = found.strategy ?? "failover";
    draft.circuitBreaker = { ...asRecord(draft.circuitBreaker), ...asRecord(cloneJson(found.circuitBreaker)) };
    nameDraft.value = found.name;
    groupDraft.value = draft;
    members.value = [...found.models];
  }
  void nextTick(() => {
    baseline.value = snapshot();
  });
}

function snapshot(): string {
  return JSON.stringify({ name: nameDraft.value, group: groupDraft.value, members: members.value });
}

function memberLevel(reference: string): ThinkLevel | undefined {
  const parsed = parseReference(reference);
  return "group" in parsed ? undefined : parsed.level;
}

function levelLabel(reference: string): string | undefined {
  const level = memberLevel(reference);
  return level === undefined ? undefined : THINK_LEVEL_LABELS[level];
}

function memberLabel(reference: string): string {
  const parsed = parseReference(reference);
  if ("group" in parsed) return reference;
  const option = props.options.find((entry) => entry.reference === `${parsed.provider}:${parsed.modelId}`);
  return option?.label ?? reference;
}

function addMember(): void {
  memberError.value = "";
  const base = memberToAdd.value;
  if (base.length === 0) {
    memberError.value = "先选择一个语言模型。";
    return;
  }
  const reference = levelToAdd.value.length === 0 ? base : `${base}:${levelToAdd.value}`;
  if (members.value.includes(reference)) {
    memberError.value = "该成员已经在候选列表里。";
    return;
  }
  const found = findDeclaredModel(props.providers, base);
  if (found === undefined) {
    memberError.value = "该模型已不在当前配置里，请刷新后重试。";
    return;
  }
  if (found.model.type !== undefined && found.model.type !== "language") {
    memberError.value = "模型组的候选只接受语言模型。";
    return;
  }
  if (levelToAdd.value.length > 0) {
    const efforts = found.model.thinking?.efforts;
    if (efforts !== undefined && !efforts.includes(levelToAdd.value)) {
      memberError.value = `该模型只声明了 ${efforts.join("、")} 档思考，不能选择 ${levelToAdd.value}。`;
      return;
    }
  }
  members.value = [...members.value, reference];
  memberToAdd.value = "";
  levelToAdd.value = "";
}

function removeMember(index: number): void {
  members.value = members.value.filter((_, position) => position !== index);
}

function moveMember(index: number, direction: -1 | 1): void {
  const target = index + direction;
  if (target < 0 || target >= members.value.length) return;
  const next = [...members.value];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  members.value = next;
}

function submit(): void {
  if (props.busy === true) return;
  formError.value = "";
  const name = nameDraft.value.trim();
  const errors: string[] = [];
  if (name.length === 0) errors.push("模型组名称必填。");
  if (name.includes(":")) errors.push("模型组名称不能包含冒号。");
  if (/\s/.test(name)) errors.push("模型组名称不能包含空白字符。");
  if (name.length > 0 && props.groups.some((entry) => entry.name === name && entry.name !== props.modelValue?.name)) errors.push(`模型组 ${name} 已存在。`);
  if (members.value.length === 0) errors.push("至少需要一个候选模型。");

  const draft = groupDraft.value;
  const strategy = text(draft.strategy);
  const breaker = asRecord(draft.circuitBreaker);
  const failureThreshold = positiveInteger(breaker.failureThreshold);
  const cooldownSeconds = positiveInteger(breaker.cooldownSeconds);
  if (failureThreshold === undefined) errors.push("失败阈值需要大于 0 的整数。");
  if (cooldownSeconds === undefined) errors.push("冷却时间需要大于 0 的整数。");
  if (errors.length > 0) {
    formError.value = errors.join(" ");
    return;
  }

  const group: GroupView = { name, models: [...members.value] };
  if (strategy !== undefined) group.strategy = strategy;
  if (failureThreshold !== undefined && cooldownSeconds !== undefined) group.circuitBreaker = { failureThreshold, cooldownSeconds };
  emit("save", { name, group, isNewGroup: !editing.value });
}

function requestClose(): void {
  if (props.busy === true) return;
  if (dirty.value) {
    confirmDiscard.value = true;
    return;
  }
  emit("close");
}

function discard(): void {
  confirmDiscard.value = false;
  baseline.value = "";
  emit("close");
}

function initialRecord(schema: SchemaNode): Record<string, unknown> {
  return asRecord(initialValue(schema));
}

function initialValue(node: SchemaNode): unknown {
  return schemaDefaults(node);
}

/** 复制 schema 并去掉指定字段：被去掉的字段由组件自己渲染。 */
function withoutKeys(node: SchemaNode, keys: readonly string[]): SchemaNode {
  const clone = cloneSchema(node);
  if (clone.dict !== undefined) for (const key of keys) delete clone.dict[key];
  return clone;
}

function cloneSchema(node: SchemaNode): SchemaNode {
  return {
    type: node.type,
    meta: { ...node.meta },
    dict: node.dict === undefined ? undefined : Object.fromEntries(Object.entries(node.dict).map(([key, child]) => [key, cloneSchema(child)])),
    list: node.list?.map((branch) => cloneSchema(branch)),
    inner: node.inner === undefined ? undefined : cloneSchema(node.inner),
    value: node.value,
  };
}

/** 配置内容都是 JSON 数据；用 JSON 往返复制可以避开响应式代理无法结构化克隆的问题。 */
function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="editing ? '编辑模型组' : '新建模型组'"
    desc="模型组决定候选顺序与熔断策略；Profile 的 model 可以直接填写组名。"
    width="min(720px, 100%)"
    @close="requestClose"
  >
    <div v-if="displayError.length > 0" class="error-panel" role="alert">
      <Icon name="alert" :size="16" />
      <div>
        <strong>无法保存</strong>
        <div>{{ displayError }}</div>
      </div>
    </div>

    <section class="form-section">
      <div class="form-grid one">
        <FormField label="组名" required :hint="lockedName === true ? '被 Profile 引用，组名已锁定。' : '引用时不带冒号，例如 chat、vision。'">
          <input v-model="nameDraft" class="input input-mono" :disabled="lockedName === true" placeholder="chat" autocomplete="off" />
        </FormField>
      </div>

      <div style="margin-top: 12px">
        <SchemaForm :schema="groupForm" :model-value="groupDraft" :disabled="busy === true" @update:model-value="groupDraft = asRecord($event)" />
      </div>

      <div v-if="lockedName === true" class="notice notice-warning" style="margin-top: 12px">
        <Icon name="warningCircle" :size="15" />
        <span>该组被 Profile 引用，组名不能修改；候选与熔断配置可以调整。</span>
      </div>
    </section>

    <section class="form-section">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">候选成员</div>
          <div class="form-section-desc">故障转移按此顺序尝试；成员只接受语言模型，可以附加思考档位。</div>
        </div>
      </div>

      <div v-if="languageOptions.length === 0" class="notice notice-warning" style="margin-bottom: 12px">
        <Icon name="warningCircle" :size="15" />
        <span>当前没有任何语言模型可供选择；请先在模型标签页声明一个语言模型，再回来添加候选。</span>
      </div>

      <div class="row row-wrap" style="align-items: flex-end; margin-bottom: 12px">
        <div class="field flex-1" style="min-width: 220px">
          <span class="field-label">添加语言模型</span>
          <select v-model="memberToAdd" class="select">
            <option value="">选择模型…</option>
            <option v-for="option in languageOptions" :key="option.reference" :value="option.reference">{{ option.reference }} · {{ option.label }}</option>
          </select>
        </div>
        <div class="field" style="width: 138px">
          <span class="field-label">思考档位</span>
          <select v-model="levelToAdd" class="select">
            <option value="">不指定</option>
            <option v-for="level in THINK_LEVELS" :key="level" :value="level">{{ THINK_LEVEL_LABELS[level] }}</option>
          </select>
        </div>
        <button type="button" class="btn btn-soft" :disabled="busy === true" @click="addMember">
          <Icon name="plus" :size="14" />
          添加
        </button>
      </div>
      <div v-if="memberError.length > 0" class="field-error" style="margin-bottom: 8px">{{ memberError }}</div>

      <div v-if="members.length === 0" class="notice">
        <Icon name="info" :size="15" />
        <span>还没有候选。模型组至少需要一个语言模型才能通过网关构建。</span>
      </div>
      <div v-else class="stack-sm">
        <div v-for="(member, index) in members" :key="member" class="member-row" style="padding: 8px 10px">
          <span class="member-index">{{ index + 1 }}</span>
          <span class="flex-1">
            {{ memberLabel(member) }}
            <span class="faint small mono">{{ member }}</span>
          </span>
          <span v-if="levelLabel(member) !== undefined" class="badge badge-outline">{{ levelLabel(member) }}</span>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="上移" :disabled="index === 0 || busy === true" @click="moveMember(index, -1)">
            <Icon name="arrowUp" :size="13" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm"
            aria-label="下移"
            :disabled="index === members.length - 1 || busy === true"
            @click="moveMember(index, 1)"
          >
            <Icon name="arrowDown" :size="13" />
          </button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="移除成员" :disabled="busy === true" @click="removeMember(index)">
            <Icon name="close" :size="13" />
          </button>
        </div>
      </div>
    </section>

    <template #footer>
      <span class="dirty-note" style="margin-right: auto">
        <template v-if="dirty"><span class="badge badge-warning">未保存</span> {{ members.length }} 个候选</template>
        <template v-else>{{ editing ? `编辑 ${nameDraft}` : "新模型组" }}</template>
      </span>
      <button type="button" class="btn" :disabled="busy === true" @click="requestClose">取消</button>
      <button type="button" class="btn btn-primary" :disabled="busy === true" @click="submit">
        <span v-if="busy === true" class="spinner" aria-hidden="true"></span>
        {{ busy === true ? "保存中…" : "保存模型组" }}
      </button>
    </template>
  </BaseModal>

  <BaseModal :open="confirmDiscard" title="放弃未保存的修改？" desc="表单内容会丢失，已保存的模型配置不受影响。" @close="confirmDiscard = false">
    <template #footer>
      <button type="button" class="btn" @click="confirmDiscard = false">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="discard">放弃修改</button>
    </template>
  </BaseModal>
</template>
