<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import BaseModal from "../components/BaseModal.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import type { AuditKind, AuditRecord } from "../data/types";
import { formatDateTime, relativeTime } from "../lib/format";
import { store } from "../store";

const range = ref<"24h" | "7d" | "all">("all");
const kindFilter = ref<"all" | AuditKind>("all");
const profileFilter = ref("all");
const search = ref("");
const loading = ref(true);
const selected = ref<AuditRecord | undefined>(undefined);

onMounted(() => {
  window.setTimeout(() => {
    loading.value = false;
  }, 380);
});

const rangeStart = computed(() => {
  if (range.value === "24h") return store.now - 24 * 60 * 60 * 1000;
  if (range.value === "7d") return store.now - 7 * 24 * 60 * 60 * 1000;
  return 0;
});

const profileIds = computed(() => [...new Set(store.audits.map((record) => record.profileId))].sort());

const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  return store.audits
    .filter((record) => {
      if (record.timestamp < rangeStart.value) return false;
      if (kindFilter.value !== "all" && record.kind !== kindFilter.value) return false;
      if (profileFilter.value !== "all" && record.profileId !== profileFilter.value) return false;
      if (term.length === 0) return true;
      return (
        record.summary.toLowerCase().includes(term) ||
        record.sessionId.toLowerCase().includes(term) ||
        record.runtimeId.toLowerCase().includes(term) ||
        (record.turnId ?? "").toLowerCase().includes(term) ||
        (record.detail ?? "").toLowerCase().includes(term)
      );
    })
    .sort((left, right) => right.timestamp - left.timestamp);
});

const kinds: Array<{ value: "all" | AuditKind; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "turn.failed", label: "轮次失败" },
  { value: "turn.aborted", label: "轮次中断" },
  { value: "message.deleted", label: "消息撤回" },
];

function kindLabel(kind: AuditKind): string {
  if (kind === "turn.failed") return "轮次失败";
  if (kind === "turn.aborted") return "轮次中断";
  return "消息撤回";
}

function kindTone(kind: AuditKind): string {
  if (kind === "turn.failed") return "badge-danger";
  if (kind === "turn.aborted") return "badge-warning";
  return "badge-info";
}

function resetFilters(): void {
  range.value = "all";
  kindFilter.value = "all";
  profileFilter.value = "all";
  search.value = "";
}

function refresh(): void {
  loading.value = true;
  window.setTimeout(() => {
    loading.value = false;
  }, 420);
}
</script>

<template>
  <PageHeader
    title="审计记录"
    desc="从 events.jsonl 中已持久化的轮次失败、轮次中断与消息撤回记录生成。配置变更、工具失败和激活/停止操作当前没有独立审计日志。"
    eyebrow="观测 / 审计"
  >
    <template #actions>
      <button type="button" class="btn" :disabled="loading" @click="refresh">
        <span v-if="loading" class="spinner" aria-hidden="true"></span>
        <Icon v-else name="refresh" :size="15" /> 刷新
      </button>
    </template>
  </PageHeader>

  <div class="notice notice-warning" style="margin-bottom: 16px">
    <Icon name="warningCircle" :size="15" />
    <span>
      这是运行事件视图，不是完整的配置审计。工具 start/done/failed 事件只广播给订阅者，不写入 events.jsonl；models.yaml 与 profile
      的修改也没有变更记录。完整实现需要新增审计写入点。
    </span>
  </div>

  <div class="panel" style="margin-bottom: 16px">
    <div class="panel-body" style="padding: 13px 16px">
      <div class="row row-wrap">
        <div class="segmented" role="group" aria-label="时间范围">
          <button type="button" :aria-pressed="range === '24h'" @click="range = '24h'">近 24 小时</button>
          <button type="button" :aria-pressed="range === '7d'" @click="range = '7d'">近 7 天</button>
          <button type="button" :aria-pressed="range === 'all'" @click="range = 'all'">全部</button>
        </div>
        <select v-model="kindFilter" class="select" aria-label="按事件类型筛选" style="width: 140px">
          <option v-for="item in kinds" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <select v-model="profileFilter" class="select" aria-label="按 Profile 筛选" style="width: 150px">
          <option value="all">全部 Profile</option>
          <option v-for="id in profileIds" :key="id" :value="id">{{ id }}</option>
        </select>
        <div class="search-box flex-1" style="min-width: 200px">
          <Icon name="search" :size="15" />
          <input v-model="search" class="input" aria-label="搜索审计记录" placeholder="搜索摘要、会话或 turn ID" />
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="resetFilters">重置</button>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <div class="panel-title">记录</div>
      <div class="panel-actions">
        <span class="panel-sub">{{ filtered.length }} 条</span>
      </div>
    </div>

    <div v-if="loading" class="loading-list">
      <div v-for="index in 4" :key="index" class="skeleton skeleton-line" style="width: 100%"></div>
      <div class="skeleton skeleton-line" style="width: 84%"></div>
    </div>

    <div v-else-if="filtered.length === 0" class="empty">
      <div class="empty-mark"><Icon name="audit" :size="20" /></div>
      <div class="empty-title">没有匹配的审计记录</div>
      <p class="empty-desc">当前时间范围内没有已持久化的失败、中断或撤回事件。清空筛选可以查看全部记录。</p>
      <button type="button" class="btn btn-soft" @click="resetFilters">清除筛选</button>
    </div>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">类型</th>
            <th scope="col">Profile</th>
            <th scope="col">摘要</th>
            <th scope="col">Turn</th>
            <th scope="col" class="actions">详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in filtered" :key="record.id">
            <td>
              <div>{{ relativeTime(record.timestamp) }}</div>
              <div class="muted mono" style="font-size: 10px">{{ formatDateTime(record.timestamp) }}</div>
            </td>
            <td>
              <span class="badge" :class="kindTone(record.kind)">{{ kindLabel(record.kind) }}</span>
            </td>
            <td class="mono">{{ record.profileId }}</td>
            <td>
              <div class="strong">{{ record.summary }}</div>
              <div class="muted mono" style="font-size: 10px">{{ record.sessionId }}</div>
            </td>
            <td class="mono muted">{{ record.turnId ?? "—" }}</td>
            <td class="actions">
              <button type="button" class="btn btn-ghost btn-sm" @click="selected = record">查看</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel" style="margin-top: 16px">
    <div class="panel-head"><div class="panel-title">当前缺口</div></div>
    <div class="panel-body">
      <div class="form-grid">
        <div>
          <div class="field-label">已有记录</div>
          <ul class="quality-note" style="margin: 5px 0 0; padding-left: 16px">
            <li>turn.failed / turn.aborted，随轮次终止写入 events.jsonl。</li>
            <li>ishiki.message.deleted，作为自定义消息持久化。</li>
          </ul>
        </div>
        <div>
          <div class="field-label">尚未写入</div>
          <ul class="quality-note" style="margin: 5px 0 0; padding-left: 16px">
            <li>工具失败与工具参数审计。</li>
            <li>models.yaml / profile 配置变更及操作者。</li>
            <li>Profile 激活、停止与依赖等待事件。</li>
            <li>控制台操作记录与 IP / 用户身份。</li>
          </ul>
        </div>
      </div>
    </div>
  </div>

  <BaseModal :open="selected !== undefined" title="审计详情" :desc="selected?.summary" width="min(680px, 100%)" @close="selected = undefined">
    <template v-if="selected">
      <dl class="kv">
        <dt>记录 ID</dt>
        <dd class="mono">{{ selected.id }}</dd>
        <dt>时间</dt>
        <dd>{{ formatDateTime(selected.timestamp) }}</dd>
        <dt>类型</dt>
        <dd>
          <span class="badge" :class="kindTone(selected.kind)">{{ kindLabel(selected.kind) }}</span>
        </dd>
        <dt>Profile</dt>
        <dd class="mono">{{ selected.profileId }}</dd>
        <dt>Runtime</dt>
        <dd class="mono">{{ selected.runtimeId }}</dd>
        <dt>会话</dt>
        <dd class="mono">{{ selected.sessionId }}</dd>
        <dt>Turn</dt>
        <dd class="mono">{{ selected.turnId ?? "—" }}</dd>
        <dt>说明</dt>
        <dd>{{ selected.detail ?? "—" }}</dd>
      </dl>
      <div class="section-title" style="margin-top: 16px">原始条目</div>
      <pre class="json-block" style="border: 1px solid var(--line); border-radius: 7px; max-height: 300px; overflow: auto">{{
        JSON.stringify(selected.raw, null, 2)
      }}</pre>
    </template>
    <template #footer>
      <button type="button" class="btn" @click="selected = undefined">关闭</button>
    </template>
  </BaseModal>
</template>
