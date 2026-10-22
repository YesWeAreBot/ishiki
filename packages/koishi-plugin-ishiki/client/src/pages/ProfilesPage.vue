<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";

import BaseModal from "../components/BaseModal.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import ProfileDetail from "../components/ProfileDetail.vue";
import ProfileEditor from "../components/ProfileEditor.vue";
import StatusBadge from "../components/StatusBadge.vue";
import type { ProfileView } from "../data/types";
import { relativeTime, truncate } from "../lib/format";
import { profileModeLabel } from "../lib/profile";
import {
  activateProfile,
  clearDirty,
  deleteProfile,
  navigate,
  profileById,
  restartProfile,
  runtimesForProfile,
  sessionsForProfile,
  stopProfile,
  store,
} from "../store";

const query = ref("");
const statusFilter = ref<"all" | "active" | "stopped" | "error">("all");
const selectedId = ref("");
const editing = ref(false);
const creating = ref(false);
const loading = ref(true);
const leaveConfirm = ref(false);
const action = reactive<{ kind: "stop" | "restart" | "delete" | null; target: ProfileView | null; busy: boolean; deleteInput: string; error: string }>({
  kind: null,
  target: null,
  busy: false,
  deleteInput: "",
  error: "",
});

const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.profiles.filter((profile) => {
    if (statusFilter.value !== "all" && profile.status !== statusFilter.value) return false;
    if (term.length === 0) return true;
    return (
      profile.id.toLowerCase().includes(term) ||
      profile.config.model.toLowerCase().includes(term) ||
      Object.keys(profile.config.channels).some((sid) => sid.includes(term))
    );
  });
});

const selected = computed(() => profileById(selectedId.value));
const selectedRuntimes = computed(() => (selected.value === undefined ? [] : runtimesForProfile(selected.value.id)));
const selectedSessions = computed(() => (selected.value === undefined ? [] : sessionsForProfile(selected.value.id)));
const deleteReady = computed(() => action.target !== null && action.deleteInput === action.target.id);

function readQuery(): string {
  const id = new URLSearchParams(store.query).get("id");
  return id ?? "";
}

function syncSelection(): void {
  const fromQuery = readQuery();
  if (fromQuery.length > 0 && profileById(fromQuery) !== undefined) {
    selectedId.value = fromQuery;
    return;
  }
  if (selectedId.value.length > 0 && profileById(selectedId.value) !== undefined) return;
  selectedId.value = store.profiles[0]?.id ?? "";
}

watch(() => store.query, syncSelection, { immediate: true });
watch(
  () => store.profiles.map((profile) => profile.id).join("|"),
  () => {
    if (profileById(selectedId.value) === undefined) selectedId.value = store.profiles[0]?.id ?? "";
  },
);

onMounted(() => {
  window.setTimeout(() => {
    loading.value = false;
  }, 480);
});

function select(profile: ProfileView): void {
  selectedId.value = profile.id;
  editing.value = false;
  creating.value = false;
  navigate("/profiles", `id=${encodeURIComponent(profile.id)}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startCreate(): void {
  creating.value = true;
  editing.value = true;
}

function startEdit(): void {
  if (selected.value === undefined) return;
  creating.value = false;
  editing.value = true;
}

function requestLeaveEditor(): void {
  if (store.dirty["profile-editor"] === true) {
    leaveConfirm.value = true;
    return;
  }
  leaveEditor();
}

function leaveEditor(): void {
  editing.value = false;
  creating.value = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function discardAndLeave(): void {
  leaveConfirm.value = false;
  clearDirty();
  leaveEditor();
}

function onSaved(id: string): void {
  selectedId.value = id;
  editing.value = false;
  creating.value = false;
  navigate("/profiles", `id=${encodeURIComponent(id)}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function activate(profile: ProfileView): Promise<void> {
  const result = await activateProfile(profile.id);
  if (!result.ok && result.error !== undefined) {
    // store 已经更新状态并弹出错误提示，这里只保持详情选中。
    selectedId.value = profile.id;
  }
}

function ask(kind: "stop" | "restart" | "delete", profile: ProfileView): void {
  action.kind = kind;
  action.target = profile;
  action.busy = false;
  action.deleteInput = "";
  action.error = "";
}

function closeAction(): void {
  action.kind = null;
  action.target = null;
  action.deleteInput = "";
  action.error = "";
}

async function runAction(): Promise<void> {
  if (action.target === null || action.kind === null) return;
  const profile = action.target;
  action.busy = true;
  if (action.kind === "stop") {
    const result = await stopProfile(profile.id);
    action.busy = false;
    if (!result.ok) {
      action.error = result.error ?? "停止失败。";
      return;
    }
    closeAction();
  } else if (action.kind === "restart") {
    const result = await restartProfile(profile.id);
    action.busy = false;
    if (!result.ok) {
      action.error = result.error ?? "重新激活失败。";
      return;
    }
    closeAction();
  } else {
    if (!deleteReady.value) return;
    const result = await deleteProfile(profile.id);
    action.busy = false;
    if (!result.ok) {
      action.error = result.error ?? "删除失败。";
      return;
    }
    closeAction();
    selectedId.value = store.profiles[0]?.id ?? "";
  }
}

function profileWarnings(profile: ProfileView): string | undefined {
  if (profile.savedAt > (profile.appliedAt ?? 0) && profile.status === "active") return "有未应用更改";
  if (profile.status === "error" && profile.lastError !== undefined) return `激活失败：${truncate(profile.lastError, 64)}`;
  return undefined;
}

function profileMeta(profile: ProfileView) {
  const runtimes = runtimesForProfile(profile.id).length;
  const sessions = sessionsForProfile(profile.id).length;
  return { runtimes, sessions };
}

function openRuntime(id: string): void {
  navigate("/runtimes", `id=${encodeURIComponent(id)}`);
}

function openSession(id: string): void {
  navigate("/sessions", `id=${encodeURIComponent(id)}`);
}
</script>

<template>
  <PageHeader
    title="Profile"
    desc="管理人格、频道认领、引擎与扩展配置，并激活或停止 Profile。保存配置与运行状态分开处理，编辑后的配置在重新激活后生效。"
    eyebrow="运行 / Profile"
  >
    <template #actions>
      <button v-if="editing" type="button" class="btn" @click="requestLeaveEditor"><Icon name="arrowLeft" :size="15" /> 返回列表</button>
      <button v-else type="button" class="btn btn-primary" @click="startCreate"><Icon name="plus" :size="15" /> 新建 Profile</button>
    </template>
  </PageHeader>

  <ProfileEditor v-if="editing" :key="creating ? 'new' : selected?.id" :profile="creating ? undefined : selected" @saved="onSaved" @cancel="leaveEditor" />

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
          <option value="all">全部状态</option>
          <option value="active">运行中</option>
          <option value="stopped">已停止</option>
          <option value="error">激活失败</option>
        </select>
      </div>

      <div v-if="loading" class="loading-list">
        <div class="skeleton skeleton-line" style="width: 42%"></div>
        <div class="skeleton skeleton-line" style="width: 78%"></div>
        <div class="skeleton skeleton-line" style="width: 55%"></div>
        <div class="skeleton skeleton-line" style="width: 66%; margin-top: 12px"></div>
        <div class="skeleton skeleton-line" style="width: 48%"></div>
      </div>
      <div v-else-if="filtered.length === 0" class="empty">
        <div class="empty-mark"><Icon name="profile" :size="20" /></div>
        <div class="empty-title">没有匹配的 Profile</div>
        <p class="empty-desc">清除搜索或切换状态筛选；也可以新建一个 Profile。</p>
        <button
          type="button"
          class="btn btn-soft"
          @click="
            query = '';
            statusFilter = 'all';
          "
        >
          清除筛选
        </button>
      </div>
      <div v-else class="list">
        <button
          v-for="profile in filtered"
          :key="profile.id"
          type="button"
          class="list-item"
          :aria-current="selectedId === profile.id ? 'true' : undefined"
          @click="select(profile)"
        >
          <div class="list-item-main">
            <div class="list-item-title">
              <span class="mono">{{ profile.id }}</span>
              <StatusBadge :state="profile.status" />
            </div>
            <div class="list-item-meta">
              <span>{{ profileModeLabel(profile.config.mode) }}</span>
              <span>{{ profileMeta(profile).runtimes }} 实例</span>
              <span>{{ profileMeta(profile).sessions }} 会话</span>
            </div>
            <div class="list-item-meta" style="margin-top: 5px">
              <span class="mono">{{ profile.config.model }}</span>
            </div>
            <div
              v-if="profileWarnings(profile)"
              class="small"
              :style="{ color: profile.status === 'error' ? 'var(--danger-ink)' : 'var(--warning-ink)', marginTop: '4px' }"
            >
              {{ profileWarnings(profile) }}
            </div>
          </div>
          <div class="list-item-side">
            <time>{{ relativeTime(profile.savedAt) }}</time>
            <Icon name="chevron" :size="14" />
          </div>
        </button>
      </div>
    </div>

    <div v-if="selected === undefined" class="panel">
      <EmptyState title="选择一个 Profile" desc="列表中的 Profile 会在这里显示运行状态、配置版本、实例、会话与人格。" icon="profile" />
    </div>

    <div v-else>
      <ProfileDetail
        :profile="selected"
        @edit="startEdit"
        @activate="activate(selected)"
        @stop="ask('stop', selected)"
        @restart="ask('restart', selected)"
        @delete="ask('delete', selected)"
      />

      <div class="panel" style="margin-top: 18px">
        <div class="panel-head">
          <div class="panel-title">快捷入口</div>
        </div>
        <div class="panel-body">
          <div class="row row-wrap">
            <button v-for="runtime in selectedRuntimes" :key="runtime.id" type="button" class="btn btn-sm" @click="openRuntime(runtime.id)">
              <Icon name="runtimes" :size="13" /> {{ runtime.domainLabel }}
            </button>
            <button v-for="session in selectedSessions" :key="session.id" type="button" class="btn btn-sm" @click="openSession(session.id)">
              <Icon name="sessions" :size="13" /> {{ session.domainLabel }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <BaseModal :open="leaveConfirm" title="放弃未保存的修改？" desc="返回列表会丢弃当前 Profile 表单内容。" @close="leaveConfirm = false">
    <template #footer>
      <button type="button" class="btn" @click="leaveConfirm = false">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="discardAndLeave">放弃修改并返回</button>
    </template>
  </BaseModal>

  <BaseModal
    :open="action.kind !== null"
    :title="action.kind === 'delete' ? '删除 Profile' : action.kind === 'stop' ? '停止 Profile' : '重新激活 Profile'"
    :desc="action.target === null ? '' : action.target.id"
    @close="closeAction"
  >
    <template v-if="action.target !== null">
      <template v-if="action.kind === 'stop'">
        <p>停止「{{ action.target.id }}」会立即停止它当前的全部运行实例。</p>
        <div class="impact-list">
          <span
            ><strong>{{ selectedRuntimes.length }} 个运行实例</strong>会停止并从运行时列表移除。</span
          >
          <span>会话日志与资源目录保留；不会删除历史。</span>
          <span>配置保持不变；再次激活后，runtime 在收到下一条认领消息时重建。</span>
          <span>该操作不写入示例以外的真实运行状态。</span>
        </div>
      </template>

      <template v-else-if="action.kind === 'restart'">
        <p>重新激活「{{ action.target.id }}」会先停止现有实例，再按已保存配置重建。</p>
        <div class="impact-list">
          <span
            ><strong>{{ selectedRuntimes.length }} 个运行实例</strong>会被替换；实例 ID 与工作目录保持不变。</span
          >
          <span>示例会读取当前已保存配置；完整实现需要新增 profile 配置重载接口。</span>
          <span>若依赖缺失或模型引用失效，重新激活会失败并保留错误。</span>
        </div>
        <div v-if="action.error" class="error-panel" style="margin-top: 10px"><Icon name="alert" :size="15" /> {{ action.error }}</div>
      </template>

      <template v-else>
        <p>确认永久删除「{{ action.target.id }}」？此操作会移除 profile 目录与其运行数据。</p>
        <div class="impact-list">
          <span
            >删除 <span class="mono">profiles/{{ action.target.id }}/</span> 下的配置、人格、记忆、runtime 与资源。</span
          >
          <span
            ><strong>{{ selectedSessions.length }} 个会话日志</strong>会一并移除。</span
          >
          <span>历史用量与审计记录保留，用于追踪已发生的调用。</span>
          <span>示例操作只修改内存数据，不会触碰真实 profile 目录。</span>
        </div>
        <div class="field" style="margin-top: 12px">
          <span class="field-label">输入 Profile 目录名以确认</span>
          <input v-model="action.deleteInput" class="input input-mono" :placeholder="action.target.id" aria-label="确认 Profile 目录名" />
        </div>
        <div v-if="action.error" class="field-error" style="margin-top: 8px">{{ action.error }}</div>
      </template>
    </template>

    <template #footer>
      <button type="button" class="btn" @click="closeAction">取消</button>
      <button v-if="action.kind === 'stop'" type="button" class="btn btn-danger" :disabled="action.busy" @click="runAction">
        <span v-if="action.busy" class="spinner" aria-hidden="true"></span>
        {{ action.busy ? "停止中…" : "停止 Profile" }}
      </button>
      <button v-else-if="action.kind === 'restart'" type="button" class="btn btn-primary" :disabled="action.busy" @click="runAction">
        <span v-if="action.busy" class="spinner" aria-hidden="true"></span>
        {{ action.busy ? "重新激活中…" : "重新激活" }}
      </button>
      <button v-else type="button" class="btn btn-danger" :disabled="action.busy || !deleteReady" @click="runAction">
        <span v-if="action.busy" class="spinner" aria-hidden="true"></span>
        {{ action.busy ? "删除中…" : "永久删除" }}
      </button>
    </template>
  </BaseModal>
</template>
