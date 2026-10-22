<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";

import BaseModal from "../components/BaseModal.vue";
import DrawerShell from "../components/DrawerShell.vue";
import FormField from "../components/FormField.vue";
import Icon from "../components/Icon.vue";
import type { ModelGroup, ThinkLevel } from "../data/types";
import { GROUP_STRATEGIES, THINK_LEVELS } from "../data/types";
import { findDeclaredModel, groupStrategyDescription, groupStrategyLabel, parseReference } from "../lib/models";
import { modelOptionsLanguage, referencesForGroup, saveGroup, setDirty, store, toast } from "../store";

const props = defineProps<{ open: boolean; name?: string }>();
const emit = defineEmits<{ close: [saved?: boolean] }>();

const draft = reactive<ModelGroup>({
  name: "",
  strategy: "failover",
  models: [],
  circuitBreaker: { failureThreshold: 3, cooldownSeconds: 60 },
});
const memberToAdd = ref("");
const levelToAdd = ref<"" | ThinkLevel>("");
const saving = ref(false);
const serverError = ref("");
const errors = reactive<Record<string, string>>({});
const confirmDiscard = ref(false);
const baseline = ref("");

const isEditing = computed(() => props.name !== undefined);
const references = computed(() => (props.name === undefined ? [] : referencesForGroup(props.name)));
const lockedName = computed(() => references.value.length > 0);
const languageOptions = computed(() => modelOptionsLanguage.value.filter((option) => option.kind === "model" && !option.disabled));
const selectedName = computed(() => (isEditing.value ? props.name : ""));

function snapshot(): string {
  return JSON.stringify(draft);
}

const dirty = computed(() => props.open && baseline.value.length > 0 && snapshot() !== baseline.value);
watch(dirty, (value) => setDirty("group-editor", value));

function clearErrors(): void {
  for (const key of Object.keys(errors)) delete errors[key];
  serverError.value = "";
}

function hydrate(): void {
  clearErrors();
  baseline.value = "";
  memberToAdd.value = "";
  levelToAdd.value = "";
  const existing = props.name === undefined ? undefined : storeGroup(props.name);
  if (existing === undefined) {
    draft.name = "";
    draft.strategy = "failover";
    draft.models = [];
    draft.circuitBreaker = { failureThreshold: 3, cooldownSeconds: 60 };
  } else {
    draft.name = existing.name;
    draft.strategy = existing.strategy;
    draft.models = [...existing.models];
    draft.circuitBreaker = { ...existing.circuitBreaker };
  }
  nextTick(() => {
    baseline.value = snapshot();
    setDirty("group-editor", false);
  });
}

function storeGroup(name: string): ModelGroup | undefined {
  return store.groups.find((group) => group.name === name);
}

watch(
  () => props.open,
  (open) => {
    if (open) hydrate();
    else {
      setDirty("group-editor", false);
      confirmDiscard.value = false;
    }
  },
);

function memberLevel(reference: string): string | undefined {
  const parsed = parseReference(reference);
  return "group" in parsed ? undefined : parsed.level;
}

function addMember(): void {
  if (memberToAdd.value.length === 0) {
    errors.member = "先选择一个语言模型。";
    return;
  }
  const reference = levelToAdd.value.length === 0 ? memberToAdd.value : `${memberToAdd.value}:${levelToAdd.value}`;
  if (draft.models.includes(reference)) {
    errors.member = "该成员已经在列表里。";
    return;
  }
  if (levelToAdd.value.length > 0) {
    const found = findDeclaredModel(store.providers, memberToAdd.value);
    const efforts = found?.model.thinking?.efforts;
    if (efforts !== undefined && !efforts.includes(levelToAdd.value)) {
      errors.member = `该模型只声明了 ${efforts.join(", ")} 档思考，不能选择 ${levelToAdd.value}。`;
      return;
    }
  }
  delete errors.member;
  draft.models.push(reference);
  memberToAdd.value = "";
  levelToAdd.value = "";
}

function removeMember(index: number): void {
  draft.models.splice(index, 1);
}

function moveMember(index: number, direction: -1 | 1): void {
  const target = index + direction;
  if (target < 0 || target >= draft.models.length) return;
  const [item] = draft.models.splice(index, 1);
  draft.models.splice(target, 0, item);
}

function submit(): void {
  clearErrors();
  serverError.value = "";
  if (draft.name.trim().length === 0) errors.name = "模型组名称必填。";
  else if (draft.name.includes(":")) errors.name = "模型组名称不能包含冒号。";
  if (draft.models.length === 0) errors.members = "至少选择一个候选模型。";
  if (draft.circuitBreaker.failureThreshold < 1) errors.failureThreshold = "必须不小于 1。";
  if (draft.circuitBreaker.cooldownSeconds < 0) errors.cooldown = "不能小于 0。";
  if (Object.keys(errors).length > 0) return;

  saving.value = true;
  saveGroup(props.name, {
    name: draft.name,
    strategy: draft.strategy,
    models: [...draft.models],
    circuitBreaker: { ...draft.circuitBreaker },
  })
    .then((result) => {
      saving.value = false;
      if (!result.ok) {
        serverError.value = result.error ?? "保存失败。";
        toast("error", "模型组保存失败", serverError.value);
        return;
      }
      baseline.value = snapshot();
      setDirty("group-editor", false);
      toast("success", "模型组已保存", "Profile 的模型选择器已同步更新。");
      emit("close", true);
    })
    .catch((error: unknown) => {
      saving.value = false;
      serverError.value = error instanceof Error ? error.message : String(error);
      toast("error", "模型组保存失败", serverError.value);
    });
}

function requestClose(): void {
  if (dirty.value) confirmDiscard.value = true;
  else emit("close", false);
}

function discard(): void {
  confirmDiscard.value = false;
  setDirty("group-editor", false);
  emit("close", false);
}

onBeforeUnmount(() => setDirty("group-editor", false));
</script>

<template>
  <DrawerShell
    :open="open"
    :title="isEditing ? '编辑模型组' : '新建模型组'"
    desc="模型组决定候选顺序与熔断策略；Profile 的 model 可以直接填写组名。"
    width="min(720px, 100vw)"
    @close="requestClose"
  >
    <div v-if="serverError" class="error-panel" role="alert">
      <Icon name="alert" :size="16" />
      <div>
        <strong>无法保存</strong>
        <div>{{ serverError }}</div>
      </div>
    </div>

    <section class="form-section" :style="serverError ? { marginTop: '18px' } : undefined">
      <div class="form-grid">
        <FormField label="组名" required :error="errors.name" :hint="lockedName ? '被 Profile 引用，组名已锁定。' : '引用时不带冒号，例如 chat、vision。'">
          <input v-model="draft.name" class="input input-mono" :disabled="lockedName" :aria-invalid="errors.name !== undefined" placeholder="chat" />
        </FormField>
        <FormField label="候选策略" required :hint="groupStrategyDescription(draft.strategy)">
          <select v-model="draft.strategy" class="select">
            <option v-for="strategy in GROUP_STRATEGIES" :key="strategy" :value="strategy">{{ groupStrategyLabel(strategy) }} · {{ strategy }}</option>
          </select>
        </FormField>
      </div>

      <div v-if="lockedName" class="notice notice-warning" style="margin-top: 13px">
        <Icon name="warningCircle" :size="15" />
        <span>该组被 {{ references.join("、") }} 引用，组名不能修改；候选与熔断配置可以调整。</span>
      </div>
    </section>

    <section class="form-section">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">候选成员</div>
          <div class="form-section-desc">failover 按此顺序尝试；成员只接受语言模型，可附加思考档位。</div>
        </div>
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
            <option v-for="level in THINK_LEVELS" :key="level" :value="level">{{ level }}</option>
          </select>
        </div>
        <button type="button" class="btn btn-soft" @click="addMember"><Icon name="plus" :size="14" /> 添加</button>
      </div>
      <div v-if="errors.member" class="field-error" style="margin-bottom: 8px">{{ errors.member }}</div>

      <div v-if="draft.models.length === 0" class="notice">
        <Icon name="info" :size="15" />
        <span>还没有候选。组至少需要一个语言模型才能通过 gateway 构建。</span>
      </div>
      <div v-else class="stack-sm">
        <div v-for="(member, index) in draft.models" :key="member" class="member-row" style="padding: 8px 10px">
          <span class="member-index">{{ index + 1 }}</span>
          <span class="flex-1">{{ member }}</span>
          <span v-if="memberLevel(member)" class="badge badge-outline">{{ memberLevel(member) }}</span>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="上移" :disabled="index === 0" @click="moveMember(index, -1)">
            <Icon name="arrowUp" :size="13" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm"
            aria-label="下移"
            :disabled="index === draft.models.length - 1"
            @click="moveMember(index, 1)"
          >
            <Icon name="arrowDown" :size="13" />
          </button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="移除成员" @click="removeMember(index)">
            <Icon name="close" :size="13" />
          </button>
        </div>
      </div>
      <div v-if="errors.members" class="field-error" style="margin-top: 8px">{{ errors.members }}</div>
    </section>

    <section class="form-section">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">熔断器</div>
          <div class="form-section-desc">连续失败达到阈值后，候选进入冷却；冷却期内跳过该候选。</div>
        </div>
      </div>
      <div class="form-grid">
        <FormField label="失败阈值" :error="errors.failureThreshold" hint="默认 3。">
          <input
            v-model.number="draft.circuitBreaker.failureThreshold"
            type="number"
            min="1"
            class="input"
            :aria-invalid="errors.failureThreshold !== undefined"
          />
        </FormField>
        <FormField label="冷却时间（秒）" :error="errors.cooldown" hint="默认 60 秒。">
          <input v-model.number="draft.circuitBreaker.cooldownSeconds" type="number" min="0" class="input" :aria-invalid="errors.cooldown !== undefined" />
        </FormField>
      </div>
    </section>

    <template #footer>
      <span class="dirty-note">
        <template v-if="dirty"><span class="badge badge-warning">未保存</span> {{ draft.models.length }} 个候选</template>
        <template v-else>{{ selectedName.length > 0 ? `编辑 ${selectedName}` : "新模型组" }}</template>
      </span>
      <button type="button" class="btn" @click="requestClose">取消</button>
      <button type="button" class="btn btn-primary" :disabled="saving" @click="submit">
        <span v-if="saving" class="spinner" aria-hidden="true"></span>
        {{ saving ? "保存中…" : "保存模型组" }}
      </button>
    </template>
  </DrawerShell>

  <BaseModal :open="confirmDiscard" title="放弃未保存的修改？" desc="表单内容会丢失。" @close="confirmDiscard = false">
    <template #footer>
      <button type="button" class="btn" @click="confirmDiscard = false">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="discard">放弃修改</button>
    </template>
  </BaseModal>
</template>
