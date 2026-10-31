<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";

import { ApiError, call } from "../api";
import BaseModal from "../components/BaseModal.vue";
import EmptyState from "../components/EmptyState.vue";
import ExpandableText from "../components/ExpandableText.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { formatDateTime, relativeTime } from "../lib/format";
import { store, toast } from "../store";
import type { RuntimeState, RuntimeView, RuntimeWakeResult } from "../types";

const query = ref("");
const profileFilter = ref("all");
const stateFilter = ref<string>("all");
const selectedId = ref("");
const busy = reactive<Record<string, boolean>>({});

const wakeId = ref<string | null>(null);
const wakePrompt = ref("");
const confirmation = ref<{ kind: "stop" | "interrupt"; id: string } | null>(null);

const stateOptions: Array<{ value: RuntimeState; label: string }> = [
  { value: "idle", label: "空闲" },
  { value: "running", label: "运行中" },
  { value: "stopped", label: "已停止" },
  { value: "failed", label: "失败" },
];

const profileIds = computed(() => {
  const ids = new Set(store.profiles.map((profile) => profile.id));
  for (const runtime of store.runtimes) ids.add(runtime.profileId);
  return [...ids].sort();
});

const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.runtimes.filter((runtime) => {
    if (profileFilter.value !== "all" && runtime.profileId !== profileFilter.value) return false;
    if (stateFilter.value !== "all" && runtime.state !== stateFilter.value) return false;
    if (term.length === 0) return true;
    return [runtime.id, runtime.profileId, runtime.domainLabel, runtime.model, runtime.sessionId, runtime.home].some((value) =>
      value.toLowerCase().includes(term),
    );
  });
});

const selected = computed(() => filtered.value.find((runtime) => runtime.id === selectedId.value) ?? filtered.value[0]);

watch(
  () => filtered.value.map((runtime) => runtime.id).join("|"),
  () => {
    if (!filtered.value.some((runtime) => runtime.id === selectedId.value)) selectedId.value = filtered.value[0]?.id ?? "";
  },
  { immediate: true },
);

const wakeTarget = computed(() => store.runtimes.find((runtime) => runtime.id === wakeId.value));
const confirmTarget = computed(() => (confirmation.value === null ? undefined : store.runtimes.find((runtime) => runtime.id === confirmation.value?.id)));
const bootstrapped = computed(() => store.models !== undefined || store.lastSyncAt > 0 || store.runtimes.length > 0);

function stateLabel(state: RuntimeState): string {
  return stateOptions.find((option) => option.value === state)?.label ?? state;
}

function badgeState(state: RuntimeState): string {
  return state === "failed" ? "error" : state;
}

function modeLabel(runtime: RuntimeView): string {
  return runtime.mode === "channel" ? "频道绑定" : "跨频道";
}

function isBusy(id: string): boolean {
  return busy[id] === true;
}

function describe(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
}

function select(runtime: RuntimeView): void {
  selectedId.value = runtime.id;
}

function openWake(runtime: RuntimeView): void {
  wakePrompt.value = "";
  wakeId.value = runtime.id;
}

function closeWake(): void {
  wakeId.value = null;
  wakePrompt.value = "";
}

function ask(kind: "stop" | "interrupt", runtime: RuntimeView): void {
  confirmation.value = { kind, id: runtime.id };
}

function closeConfirmation(): void {
  confirmation.value = null;
}

async function wake(): Promise<void> {
  const runtime = wakeTarget.value;
  if (runtime === undefined || isBusy(runtime.id)) return;
  busy[runtime.id] = true;
  const prompt = wakePrompt.value.trim();
  try {
    const result = await call<RuntimeWakeResult>("ishiki/runtimes/wake", runtime.id, prompt.length > 0 ? prompt : undefined);
    if (result.queued) {
      toast("success", "已合并到当前轮次", "实例正在处理轮次，本次唤醒并入了当前轮次。");
    } else {
      toast("success", "已唤醒运行实例", `轮次 ${result.turnId ?? "—"} 已开始。`);
    }
    closeWake();
  } catch (error) {
    toast("error", "唤醒失败", describe(error));
  } finally {
    busy[runtime.id] = false;
  }
}

async function restart(runtime: RuntimeView): Promise<void> {
  if (isBusy(runtime.id)) return;
  busy[runtime.id] = true;
  try {
    await call<RuntimeView>("ishiki/runtimes/restart", runtime.id);
    toast("success", "已重启运行实例", runtime.id);
  } catch (error) {
    toast("error", "重启失败", describe(error));
  } finally {
    busy[runtime.id] = false;
  }
}

async function confirmAction(): Promise<void> {
  const pending = confirmation.value;
  const runtime = confirmTarget.value;
  if (pending === null || runtime === undefined || isBusy(runtime.id)) return;
  busy[runtime.id] = true;
  try {
    await call<RuntimeView>(pending.kind === "stop" ? "ishiki/runtimes/stop" : "ishiki/runtimes/interrupt", runtime.id);
    toast("success", pending.kind === "stop" ? "已停止运行实例" : "已中断当前轮次", runtime.id);
    closeConfirmation();
  } catch (error) {
    toast("error", pending.kind === "stop" ? "停止失败" : "中断失败", describe(error));
  } finally {
    busy[runtime.id] = false;
  }
}
</script>

<template>
  <PageShell>
    <PageHeader
      title="运行实例"
      desc="运行实例由 Profile 按需创建，承载独立的会话日志与资源目录。这里的唤醒、重启、停止与中断直接调用服务端接口，状态随控制台推送更新。"
      eyebrow="运行 / 实例"
    >
      <template #actions>
        <span class="badge badge-outline">{{ store.runtimes.length }} 个实例</span>
      </template>
    </PageHeader>

    <div class="stack">
      <div v-if="!bootstrapped" class="panel">
        <div class="loading-list">
          <div v-for="index in 5" :key="index" class="skeleton skeleton-line" style="width: 100%"></div>
          <div class="skeleton skeleton-line" style="width: 72%"></div>
        </div>
      </div>

      <div v-else-if="store.runtimes.length === 0" class="panel">
        <EmptyState
          title="还没有运行实例"
          desc="运行实例不能单独创建。认领频道的第一条输入会派生实例，Profile 启动后这里会显示它承载的实例。"
          icon="runtimes"
        />
      </div>

      <div v-else class="split split-wide">
        <div class="panel detail-sticky">
          <div class="panel-head" style="padding-bottom: 12px">
            <div class="panel-title">实例列表</div>
            <div class="panel-actions">
              <span class="badge badge-outline">{{ filtered.length }} / {{ store.runtimes.length }}</span>
            </div>
          </div>
          <div class="list-search">
            <div class="search-box">
              <Icon name="search" :size="15" />
              <input v-model="query" class="input" aria-label="搜索运行实例" placeholder="搜索实例、频道、模型或目录" />
            </div>
            <div class="row" style="margin-top: 8px">
              <select v-model="profileFilter" class="select" aria-label="按 Profile 筛选">
                <option value="all">全部 Profile</option>
                <option v-for="id in profileIds" :key="id" :value="id">{{ id }}</option>
              </select>
              <select v-model="stateFilter" class="select" aria-label="按状态筛选" style="width: 120px">
                <option value="all">全部状态</option>
                <option v-for="option in stateOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </div>
          </div>

          <div v-if="filtered.length === 0" class="empty">
            <div class="empty-title">没有匹配的实例</div>
            <p class="empty-desc">调整 Profile、状态或搜索词后再试。</p>
            <button
              type="button"
              class="btn btn-soft btn-sm"
              @click="
                query = '';
                profileFilter = 'all';
                stateFilter = 'all';
              "
            >
              清除筛选
            </button>
          </div>
          <div v-else class="list">
            <button
              v-for="runtime in filtered"
              :key="runtime.id"
              type="button"
              class="list-item"
              :aria-current="selected?.id === runtime.id"
              @click="select(runtime)"
            >
              <div class="list-item-main">
                <div class="list-item-title">
                  <span class="mono">{{ runtime.domainLabel }}</span>
                  <StatusBadge :state="badgeState(runtime.state)" />
                </div>
                <div class="list-item-meta">
                  <span class="mono">{{ runtime.id }}</span>
                </div>
                <div class="list-item-meta">
                  <span>{{ runtime.profileId }}</span>
                  <span>{{ modeLabel(runtime) }}</span>
                </div>
              </div>
              <div class="list-item-side">
                <time :datetime="runtime.lastActivity === undefined ? undefined : new Date(runtime.lastActivity).toISOString()">
                  {{ relativeTime(runtime.lastActivity) }}
                </time>
              </div>
            </button>
          </div>
        </div>

        <div v-if="selected === undefined" class="panel">
          <EmptyState title="选择一个运行实例" desc="实例的状态、当前轮次、模型、引擎、工作目录与会话会显示在这里。" icon="runtimes" />
        </div>

        <div v-else class="stack">
          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title mono">{{ selected.domainLabel }}</div>
                <div class="panel-sub mono">{{ selected.id }}</div>
              </div>
              <div class="panel-actions">
                <button type="button" class="btn btn-sm" :disabled="isBusy(selected.id)" @click="openWake(selected)">
                  <Icon name="play" :size="14" /> 唤醒
                </button>
                <button type="button" class="btn btn-sm" :disabled="isBusy(selected.id)" @click="restart(selected)">
                  <span v-if="isBusy(selected.id)" class="spinner" aria-hidden="true"></span>
                  <Icon v-else name="refresh" :size="14" /> 重启
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="isBusy(selected.id) || selected.state !== 'running'"
                  :title="selected.state === 'running' ? '中断当前轮次' : '实例没有运行中的轮次'"
                  @click="ask('interrupt', selected)"
                >
                  <Icon name="xCircle" :size="14" /> 中断
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-danger"
                  :disabled="isBusy(selected.id) || selected.state === 'stopped'"
                  :title="selected.state === 'stopped' ? '实例已经停止' : '停止实例'"
                  @click="ask('stop', selected)"
                >
                  <Icon name="stop" :size="14" /> 停止
                </button>
              </div>
            </div>
            <div class="panel-body">
              <dl class="kv">
                <dt>状态</dt>
                <dd>
                  <StatusBadge :state="badgeState(selected.state)" />
                  <span class="muted small" style="margin-left: 8px">{{ stateLabel(selected.state) }}</span>
                </dd>

                <dt>Profile</dt>
                <dd>
                  <RouterLink class="link mono" :to="`/ishiki/profiles/${encodeURIComponent(selected.profileId)}`">
                    {{ selected.profileId }}
                  </RouterLink>
                </dd>

                <dt>域</dt>
                <dd>
                  <span class="mono">{{ selected.domainLabel }}</span>
                  <span class="muted small" style="margin-left: 8px">{{ modeLabel(selected) }}</span>
                </dd>

                <dt>当前轮次</dt>
                <dd class="mono">{{ selected.activeTurnId ?? "—" }}</dd>

                <dt>最近活动</dt>
                <dd>
                  <span>{{ formatDateTime(selected.lastActivity) }}</span>
                  <span class="muted small" style="margin-left: 8px">{{ relativeTime(selected.lastActivity) }}</span>
                </dd>

                <dt>模型</dt>
                <dd class="mono">{{ selected.model.length > 0 ? selected.model : "未配置" }}</dd>

                <dt>上下文引擎</dt>
                <dd class="mono">{{ selected.engines.context.length > 0 ? selected.engines.context : "未配置" }}</dd>

                <dt>唤醒引擎</dt>
                <dd class="mono">{{ selected.engines.wakeup.length > 0 ? selected.engines.wakeup : "未配置" }}</dd>

                <dt>工具调用引擎</dt>
                <dd class="mono">{{ selected.engines.toolcall.length > 0 ? selected.engines.toolcall : "未配置" }}</dd>

                <dt>工作目录</dt>
                <dd>
                  <ExpandableText :value="selected.home" mode="ends" mono :head="30" :tail="14" copy-label="工作目录" />
                </dd>

                <dt>会话</dt>
                <dd>
                  <RouterLink class="link mono" :to="`/ishiki/sessions/${encodeURIComponent(selected.sessionId)}`">
                    {{ selected.sessionId }}
                  </RouterLink>
                </dd>

                <dt>创建时间</dt>
                <dd>{{ formatDateTime(selected.createdAt) }}</dd>
              </dl>
            </div>
          </div>

          <div v-if="selected.error !== undefined" class="error-panel">
            <Icon name="alert" :size="15" />
            <div class="flex-1">
              <div class="strong">最近一次错误</div>
              <ExpandableText :value="selected.error" mode="clamp" mono copy-label="错误详情" />
            </div>
          </div>

          <div class="notice notice-info">
            <Icon name="info" :size="15" />
            <span> 唤醒会为实例排队一个轮次；实例正忙时唤醒会合并到当前轮次。停止会终止当前轮次并保留日志与资源目录，中断只取消当前轮次。 </span>
          </div>
        </div>
      </div>
    </div>

    <BaseModal :open="wakeTarget !== undefined" title="唤醒运行实例" :desc="wakeTarget?.id" @close="closeWake">
      <div v-if="wakeTarget !== undefined" class="stack-sm">
        <label class="field">
          <span class="field-label">提示词（可选）</span>
          <textarea v-model="wakePrompt" class="textarea" rows="4" placeholder="留空时按实例的默认唤醒流程处理。" :disabled="isBusy(wakeTarget.id)"></textarea>
          <span class="field-hint">实例正在处理轮次时，本次唤醒会合并到当前轮次。</span>
        </label>
        <div class="notice">
          <Icon name="info" :size="14" />
          <span>唤醒调用 <span class="mono">ishiki/runtimes/wake</span>，成功后会返回是否合并以及新的轮次 ID。</span>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" :disabled="wakeTarget !== undefined && isBusy(wakeTarget.id)" @click="closeWake">取消</button>
        <button type="button" class="btn btn-primary" :disabled="wakeTarget === undefined || isBusy(wakeTarget.id)" @click="wake">
          <span v-if="wakeTarget !== undefined && isBusy(wakeTarget.id)" class="spinner" aria-hidden="true"></span>
          唤醒
        </button>
      </template>
    </BaseModal>

    <BaseModal
      :open="confirmation !== null && confirmTarget !== undefined"
      :title="confirmation?.kind === 'stop' ? '停止运行实例' : '中断当前轮次'"
      :desc="confirmTarget?.id"
      @close="closeConfirmation"
    >
      <div v-if="confirmation !== null && confirmTarget !== undefined" class="stack-sm">
        <div class="notice" :class="confirmation.kind === 'stop' ? 'notice-warning' : 'notice-info'">
          <Icon name="warningCircle" :size="15" />
          <span v-if="confirmation.kind === 'stop'"> 停止后实例不再处理输入，当前轮次会被终止。会话日志与资源目录保留，后续可以重新唤醒。 </span>
          <span v-else>中断会取消当前轮次，实例保持可用，之后仍可继续接收输入。</span>
        </div>
        <div class="muted small">
          操作对象：<span class="mono">{{ confirmTarget.domainLabel }}</span>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="closeConfirmation">取消</button>
        <button
          type="button"
          class="btn"
          :class="confirmation?.kind === 'stop' ? 'btn-danger' : 'btn-primary'"
          :disabled="confirmTarget === undefined || isBusy(confirmTarget.id)"
          @click="confirmAction"
        >
          <span v-if="confirmTarget !== undefined && isBusy(confirmTarget.id)" class="spinner" aria-hidden="true"></span>
          {{ confirmation?.kind === "stop" ? "确认停止" : "确认中断" }}
        </button>
      </template>
    </BaseModal>
  </PageShell>
</template>

<style scoped>
.wrap {
  overflow-wrap: anywhere;
}
</style>
