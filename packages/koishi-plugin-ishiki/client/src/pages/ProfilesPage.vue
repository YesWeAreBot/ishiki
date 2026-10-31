<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { ApiError, call } from "../api";
import BaseModal from "../components/BaseModal.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import ProfileDetail from "../components/ProfileDetail.vue";
import ProfileEditor from "../components/ProfileEditor.vue";
import ProfileWizard from "../components/ProfileWizard.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { formatDateTime, relativeTime, truncate } from "../lib/format";
import { store, toast } from "../store";
import type { ProfileState, ProfileStatus, ProfileSummary, ProfileView } from "../types";

const route = useRoute();
const router = useRouter();

type BadgeState = "active" | "stopped" | "activating" | "error" | "idle" | "running";
type BusyAction = "apply" | "reload" | "stop" | "delete";

const query = ref("");
const statusFilter = ref<"all" | ProfileState>("all");
const editing = ref(false);
const detail = ref<ProfileView | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const busy = ref<BusyAction | null>(null);
const wizardOpen = ref(false);

const action = reactive<{
  kind: "stop" | "delete" | null;
  target: ProfileSummary | null;
  busy: boolean;
  deleteInput: string;
  error: string;
}>({ kind: null, target: null, busy: false, deleteInput: "", error: "" });

const profileId = computed(() => {
  const raw = route.params.page;
  const segments = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return segments[0] === "profiles" && typeof segments[1] === "string" ? segments[1] : "";
});

const snapshotReady = computed(() => store.engines !== undefined);
const summary = computed(() => store.profiles.find((profile) => profile.id === profileId.value));

const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.profiles.filter((profile) => {
    if (statusFilter.value !== "all") {
      const matches = statusFilter.value === "failed" ? profile.state === "failed" || profile.lastError !== undefined : profile.state === statusFilter.value;
      if (!matches) return false;
    }
    if (term.length === 0) return true;
    return (
      profile.id.toLowerCase().includes(term) ||
      profile.model.toLowerCase().includes(term) ||
      profile.channels.some((channel) => channel.toLowerCase().includes(term))
    );
  });
});

const targetRuntimes = computed(() => {
  const target = action.target;
  return target === null ? [] : store.runtimes.filter((runtime) => runtime.profileId === target.id);
});

const targetSessionCount = computed(() => {
  const target = action.target;
  if (target === null) return 0;
  if (detail.value !== null && detail.value.id === target.id) return detail.value.sessionCount;
  return store.sessions.filter((session) => session.profileId === target.id).length;
});

const deleteReady = computed(() => action.target !== null && action.deleteInput === action.target.id);

const stateFilters: Array<{ value: "all" | ProfileState; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "运行中" },
  { value: "inactive", label: "未运行" },
  { value: "loading", label: "应用中" },
  { value: "failed", label: "应用失败" },
];

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function badgeState(state: ProfileState): BadgeState {
  switch (state) {
    case "inactive":
      return "stopped";
    case "loading":
      return "activating";
    case "failed":
      return "error";
    default:
      return state;
  }
}

function modeLabel(mode: ProfileSummary["mode"]): string {
  return mode === "channel" ? "频道模式" : "跨频道模式";
}

function pendingLabel(profile: ProfileSummary): string | undefined {
  if (profile.savedAt <= (profile.appliedAt ?? 0)) return undefined;
  return profile.state === "active" ? "有未应用更改" : "未应用";
}

function listError(profile: ProfileSummary): string | undefined {
  return profile.lastError === undefined ? undefined : truncate(profile.lastError, 72);
}

function select(profile: ProfileSummary): void {
  if (profile.id === profileId.value) return;
  void router.push(`/ishiki/profiles/${encodeURIComponent(profile.id)}`);
}

function leaveDetail(): void {
  void router.push("/ishiki/profiles");
}

let loadSeed = 0;

async function load(id: string): Promise<void> {
  if (id.length === 0) {
    loadSeed += 1;
    detail.value = null;
    detailError.value = "";
    detailLoading.value = false;
    return;
  }
  const seed = ++loadSeed;
  detailLoading.value = true;
  detailError.value = "";
  if (detail.value !== null && detail.value.id !== id) detail.value = null;
  try {
    const view = await call<ProfileView>("ishiki/profiles/read", id);
    if (seed !== loadSeed) return;
    detail.value = view;
  } catch (error) {
    if (seed !== loadSeed) return;
    const message = describeError(error);
    if (editing.value && detail.value !== null) {
      detailError.value = message;
      toast("error", "重新读取失败", message);
    } else {
      detail.value = null;
      detailError.value = message;
    }
  } finally {
    if (seed === loadSeed) detailLoading.value = false;
  }
}

watch(
  profileId,
  (id) => {
    editing.value = false;
    action.kind = null;
    action.target = null;
    action.busy = false;
    action.deleteInput = "";
    action.error = "";
    detail.value = null;
    detailError.value = "";
    void load(id);
  },
  { immediate: true },
);

watch(
  () => summary.value?.revision,
  (revision) => {
    if (revision === undefined || editing.value || detailLoading.value) return;
    if (detail.value !== null && detail.value.revision === revision) return;
    void load(profileId.value);
  },
);

async function run(kind: "apply" | "reload"): Promise<void> {
  const profile = detail.value;
  if (profile === null || busy.value !== null) return;
  busy.value = kind;
  try {
    const view = await call<ProfileView>(`ishiki/profiles/${kind}`, profile.id);
    if (profileId.value === profile.id) detail.value = view;
    const moment = view.appliedAt === undefined ? "" : `（${formatDateTime(view.appliedAt)}）`;
    toast("success", kind === "apply" ? "Profile 已应用" : "Profile 已重新加载", `${view.id} 的配置已装载${moment}。`);
  } catch (error) {
    const message = describeError(error);
    toast("error", kind === "apply" ? "应用失败" : "重新加载失败", message);
    if (profileId.value === profile.id) await load(profile.id);
  } finally {
    busy.value = null;
  }
}

function ask(kind: "stop" | "delete", profile: ProfileSummary | null): void {
  if (profile === null) return;
  action.kind = kind;
  action.target = profile;
  action.busy = false;
  action.deleteInput = "";
  action.error = "";
}

function resetAction(): void {
  action.kind = null;
  action.target = null;
  action.busy = false;
  action.deleteInput = "";
  action.error = "";
}

function closeAction(): void {
  if (action.busy) return;
  resetAction();
}

async function runAction(): Promise<void> {
  const target = action.target;
  const kind = action.kind;
  if (target === null || kind === null || action.busy) return;
  if (kind === "delete" && !deleteReady.value) return;
  action.busy = true;
  action.error = "";
  try {
    if (kind === "stop") {
      await call<ProfileStatus>("ishiki/profiles/stop", target.id);
      toast("success", "Profile 已停止", `${target.id} 的运行实例已移除，配置与会话保留。`);
      resetAction();
      if (profileId.value === target.id) await load(target.id);
      return;
    }
    await call<null>("ishiki/profiles/remove", target.id);
    toast("success", "Profile 已删除", `${target.id} 的目录已移除。`);
    resetAction();
    if (profileId.value === target.id) {
      await router.push("/ishiki/profiles");
      if (profileId.value === target.id) {
        detail.value = null;
        detailError.value = "Profile 已删除，但页面未能跳转回列表，请刷新。";
      }
    }
  } catch (error) {
    const message = describeError(error);
    action.error = message;
    toast("error", kind === "stop" ? "停止失败" : "删除失败", message);
    if (kind === "stop" && profileId.value === target.id) await load(target.id);
  } finally {
    action.busy = false;
  }
}

function onSaved(view: ProfileView): void {
  if (view.id === profileId.value) detail.value = view;
  editing.value = false;
}

function onWizardCreated(view: ProfileView): void {
  wizardOpen.value = false;
  void router.push(`/ishiki/profiles/${encodeURIComponent(view.id)}`);
}

function clearFilters(): void {
  query.value = "";
  statusFilter.value = "all";
}
</script>

<template>
  <PageShell>
    <PageHeader
      title="Profile"
      desc="管理人格、频道认领、引擎与扩展配置，并应用或停止 Profile。保存配置与运行状态分开处理，保存后的配置需要应用才会生效。"
      eyebrow="运行 / Profile"
    >
      <template #actions>
        <button type="button" class="btn btn-primary" @click="wizardOpen = true"><Icon name="plus" :size="15" /> 新建 Profile</button>
        <button v-if="!editing && profileId !== ''" type="button" class="btn" :disabled="detailLoading" @click="load(profileId)">
          <span v-if="detailLoading" class="spinner" aria-hidden="true"></span>
          <Icon v-else name="refresh" :size="15" /> 刷新详情
        </button>
      </template>
    </PageHeader>

    <ProfileEditor
      v-if="editing && detail !== null"
      :key="`${detail.id}:${detail.revision}`"
      :profile="detail"
      @saved="onSaved"
      @cancel="editing = false"
      @refresh="load(profileId)"
    />

    <div v-else class="split split-wide">
      <div class="panel detail-sticky">
        <div class="panel-head" style="padding-bottom: 12px">
          <div class="panel-title">Profile 列表</div>
          <div class="panel-actions">
            <span class="badge badge-outline">{{ store.profiles.length }}</span>
          </div>
        </div>
        <div class="list-search">
          <div class="search-box">
            <Icon name="search" :size="15" />
            <input v-model="query" class="input" aria-label="搜索 Profile" placeholder="搜索目录、模型或账号" />
          </div>
          <select v-model="statusFilter" class="select" aria-label="按状态筛选" style="margin-top: 8px">
            <option v-for="option in stateFilters" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </div>

        <div v-if="!snapshotReady" class="loading-list">
          <div class="skeleton skeleton-line" style="width: 42%"></div>
          <div class="skeleton skeleton-line" style="width: 78%"></div>
          <div class="skeleton skeleton-line" style="width: 55%"></div>
          <div class="skeleton skeleton-line" style="width: 66%; margin-top: 12px"></div>
          <div class="skeleton skeleton-line" style="width: 48%"></div>
        </div>
        <div v-else-if="filtered.length === 0" class="empty">
          <div class="empty-mark"><Icon name="profile" :size="20" /></div>
          <div class="empty-title">{{ store.profiles.length === 0 ? "还没有 Profile" : "没有匹配的 Profile" }}</div>
          <p class="empty-desc">
            {{ store.profiles.length === 0 ? "点击「新建 Profile」通过配置向导创建第一个 Profile。" : "清除搜索或切换状态筛选后再试。" }}
          </p>
          <button v-if="store.profiles.length > 0" type="button" class="btn btn-soft" @click="clearFilters">清除筛选</button>
        </div>
        <div v-else class="list">
          <button
            v-for="profile in filtered"
            :key="profile.id"
            type="button"
            class="list-item"
            :aria-current="profile.id === profileId ? 'true' : undefined"
            @click="select(profile)"
          >
            <div class="list-item-main">
              <div class="list-item-title">
                <span class="mono">{{ profile.id }}</span>
                <StatusBadge :state="badgeState(profile.state)" :pulse="profile.state === 'loading'" />
                <span v-if="pendingLabel(profile) !== undefined" class="badge badge-warning">{{ pendingLabel(profile) }}</span>
              </div>
              <div class="list-item-meta">
                <span>{{ modeLabel(profile.mode) }}</span>
                <span>{{ profile.runtimeCount }} 实例</span>
                <span>{{ profile.channels.length }} 个账号</span>
              </div>
              <div class="list-item-meta" style="margin-top: 5px">
                <span class="mono">{{ profile.model }}</span>
              </div>
              <div v-if="listError(profile) !== undefined" class="small" style="color: var(--danger-ink); margin-top: 4px">
                {{ listError(profile) }}
              </div>
            </div>
            <div class="list-item-side">
              <span class="small faint">保存于</span>
              <time :title="formatDateTime(profile.savedAt)">{{ relativeTime(profile.savedAt) }}</time>
              <Icon name="chevron" :size="14" />
            </div>
          </button>
        </div>
      </div>

      <div>
        <div v-if="detailLoading && detail === null" class="panel">
          <div class="loading-list">
            <div class="skeleton skeleton-line" style="width: 38%"></div>
            <div class="skeleton skeleton-line" style="width: 72%"></div>
            <div class="skeleton skeleton-line" style="width: 54%"></div>
            <div class="skeleton skeleton-line" style="width: 64%; margin-top: 12px"></div>
            <div class="skeleton skeleton-line" style="width: 44%"></div>
          </div>
        </div>

        <div v-else-if="detailError !== '' && detail === null" class="panel">
          <div class="panel-head">
            <div class="panel-title">无法读取 Profile</div>
          </div>
          <div class="panel-body">
            <div class="error-panel" role="alert"><Icon name="alert" :size="15" /> {{ detailError }}</div>
            <div class="row" style="margin-top: 12px">
              <button type="button" class="btn" @click="load(profileId)"><Icon name="refresh" :size="14" /> 重试</button>
              <button v-if="profileId !== ''" type="button" class="btn btn-ghost" @click="leaveDetail">返回列表</button>
            </div>
          </div>
        </div>

        <div v-else-if="detail === null" class="panel">
          <EmptyState title="选择一个 Profile" desc="列表中的 Profile 会在这里显示运行状态、配置版本、实例、会话与人格。" icon="profile">
            <button v-if="summary !== undefined" type="button" class="btn btn-soft" @click="select(summary)">打开 {{ summary.id }}</button>
          </EmptyState>
        </div>

        <ProfileDetail
          v-else
          :profile="detail"
          :busy="busy"
          @edit="editing = true"
          @wizard="wizardOpen = true"
          @apply="run('apply')"
          @reload="run('reload')"
          @stop="ask('stop', detail)"
          @delete="ask('delete', detail)"
        />
      </div>
    </div>

    <ProfileWizard :open="wizardOpen" :profile="detail ?? undefined" @close="wizardOpen = false" @created="onWizardCreated" />

    <BaseModal
      :open="action.kind !== null"
      :title="action.kind === 'delete' ? '删除 Profile' : '停止 Profile'"
      :desc="action.target === null ? '' : action.target.id"
      :closable="!action.busy"
      :close-on-backdrop="!action.busy"
      @close="closeAction"
    >
      <template v-if="action.target !== null">
        <template v-if="action.kind === 'stop'">
          <p>停止「{{ action.target.id }}」会立即停止它当前的全部运行实例。</p>
          <div class="impact-list">
            <span
              ><strong>{{ targetRuntimes.length }} 个运行实例</strong>会停止并从运行时列表移除。</span
            >
            <span>会话日志与资源目录保留；不会删除历史。</span>
            <span>配置保持不变；再次应用后，runtime 在收到下一条认领消息时重建。</span>
          </div>
        </template>

        <template v-else>
          <p>确认永久删除「{{ action.target.id }}」？此操作会移除 profile 目录与其运行数据。</p>
          <div class="impact-list">
            <span
              >删除 <span class="mono">profiles/{{ action.target.id }}/</span> 下的配置、人格、记忆、runtime 与资源。</span
            >
            <span
              ><strong>{{ targetSessionCount }} 个会话日志</strong>会一并移除。</span
            >
            <span>历史用量记录保留，用于追踪已发生的调用。</span>
          </div>
          <div class="field" style="margin-top: 12px">
            <span class="field-label">输入 Profile 目录名以确认</span>
            <input
              v-model="action.deleteInput"
              class="input input-mono"
              :placeholder="action.target.id"
              aria-label="确认 Profile 目录名"
              :disabled="action.busy"
            />
          </div>
        </template>

        <div v-if="action.error !== ''" class="error-panel" role="alert" style="margin-top: 10px"><Icon name="alert" :size="15" /> {{ action.error }}</div>
      </template>

      <template #footer>
        <button type="button" class="btn" :disabled="action.busy" @click="closeAction">取消</button>
        <button v-if="action.kind === 'stop'" type="button" class="btn btn-danger" :disabled="action.busy" @click="runAction">
          <span v-if="action.busy" class="spinner" aria-hidden="true"></span>
          {{ action.busy ? "停止中…" : "停止 Profile" }}
        </button>
        <button v-else type="button" class="btn btn-danger" :disabled="action.busy || !deleteReady" @click="runAction">
          <span v-if="action.busy" class="spinner" aria-hidden="true"></span>
          {{ action.busy ? "删除中…" : "永久删除" }}
        </button>
      </template>
    </BaseModal>
  </PageShell>
</template>
