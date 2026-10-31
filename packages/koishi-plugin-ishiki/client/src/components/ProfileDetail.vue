<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";

import { formatDateTime, relativeTime } from "../lib/format";
import { store } from "../store";
import type { ProfileState, ProfileView, RuntimeState } from "../types";
import Icon from "./Icon.vue";
import StatusBadge from "./StatusBadge.vue";

const props = withDefaults(
  defineProps<{
    profile: ProfileView;
    busy?: "apply" | "reload" | "stop" | "delete" | null;
  }>(),
  { busy: null },
);

const emit = defineEmits<{ edit: []; wizard: []; apply: []; reload: []; stop: []; delete: [] }>();
const router = useRouter();

type BadgeState = "active" | "stopped" | "activating" | "error" | "idle" | "running";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badgeState(state: ProfileState | RuntimeState): BadgeState {
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

function modeLabel(mode: ProfileView["mode"]): string {
  return mode === "channel" ? "频道模式" : "跨频道模式";
}

const config = computed<Record<string, unknown>>(() => (isRecord(props.profile.config) ? props.profile.config : {}));
const runtimes = computed(() => store.runtimes.filter((runtime) => runtime.profileId === props.profile.id));
const pending = computed(() => props.profile.savedAt > (props.profile.appliedAt ?? 0));
const modelLabel = computed(() => props.profile.model);

function engineName(kind: "context" | "wakeup" | "toolcall"): string {
  const value = config.value[kind];
  return isRecord(value) && typeof value.engine === "string" ? value.engine : "未配置";
}

const engineSummary = computed(() => [
  { label: "上下文", value: engineName("context") },
  { label: "唤醒", value: engineName("wakeup") },
  { label: "工具调用", value: engineName("toolcall") },
]);

interface ChannelRow {
  account: string;
  patterns: string[];
}

const channelRows = computed<ChannelRow[]>(() => {
  const channels = config.value.channels;
  if (isRecord(channels)) {
    return Object.entries(channels).map(([account, value]) => ({
      account,
      patterns: Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
    }));
  }
  return props.profile.channels.map((account) => ({ account, patterns: [] }));
});

interface ExtensionRow {
  name: string;
  enabled: boolean;
}

const extensionRows = computed<ExtensionRow[]>(() => {
  const extended = config.value.extends;
  if (!isRecord(extended)) return [];
  return Object.entries(extended)
    .map(([name, value]) => ({ name, enabled: isRecord(value) && value.enable !== false }))
    .sort((left, right) => left.name.localeCompare(right.name));
});

const enabledExtensionCount = computed(() => extensionRows.value.filter((entry) => entry.enabled).length);

const instructionRows = computed(() => props.profile.instructions);
const personaPath = computed(() => instructionRows.value.find((file) => !file.missing)?.path);

const errorTitle = "最近一次操作失败";

function openSession(sessionId: string): void {
  void router.push(`/ishiki/sessions/${encodeURIComponent(sessionId)}`);
}

function runtimeTarget(runtimeId: string): string {
  const runtime = runtimes.value.find((item) => item.id === runtimeId);
  return runtime?.sessionId ?? "";
}

function openRuntimeSession(sessionId: string): void {
  if (sessionId === "") return;
  openSession(sessionId);
}
</script>

<template>
  <div class="stack">
    <div class="panel">
      <div class="panel-head profile-head">
        <div class="flex-1">
          <div class="row row-wrap">
            <span class="panel-title mono">{{ profile.id }}</span>
            <StatusBadge :state="badgeState(profile.state)" :pulse="profile.state === 'loading'" />
            <span class="badge badge-outline">{{ modeLabel(profile.mode) }}</span>
            <span v-if="pending" class="badge badge-warning">{{ profile.appliedAt === undefined ? "未应用" : "有未应用更改" }}</span>
          </div>
        </div>
        <div class="panel-actions profile-actions">
          <button type="button" class="btn btn-sm" :disabled="busy !== null" @click="emit('edit')"><Icon name="edit" :size="14" /> 编辑</button>
          <button type="button" class="btn btn-sm" :disabled="busy !== null" title="按步骤重新核对基础配置" @click="emit('wizard')">
            <Icon name="settings" :size="14" /> 配置向导
          </button>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="busy !== null || profile.state === 'loading'"
            :title="profile.state === 'loading' ? '人格配置正在激活，等待完成后再试' : '应用已保存的配置并启动人格配置'"
            @click="emit('apply')"
          >
            <span v-if="busy === 'apply'" class="spinner" aria-hidden="true"></span>
            <Icon v-else name="play" :size="13" />
            {{ busy === "apply" ? "应用中…" : "应用" }}
          </button>
          <button
            v-if="profile.state === 'active'"
            type="button"
            class="btn btn-sm btn-soft"
            :disabled="busy !== null"
            title="从磁盘重新读取配置并重建运行实例"
            @click="emit('reload')"
          >
            <span v-if="busy === 'reload'" class="spinner" aria-hidden="true"></span>
            <Icon v-else name="refresh" :size="13" />
            {{ busy === "reload" ? "重新加载中…" : "重新加载" }}
          </button>
          <button
            v-if="profile.state === 'active' || profile.state === 'loading'"
            type="button"
            class="btn btn-sm"
            :disabled="busy !== null || profile.state === 'loading'"
            @click="emit('stop')"
          >
            <Icon name="stop" :size="13" /> 停止
          </button>
          <button
            type="button"
            class="btn btn-sm btn-danger"
            :disabled="busy !== null || profile.state === 'active' || profile.state === 'loading'"
            :title="profile.state === 'active' || profile.state === 'loading' ? '运行中的人格配置不能删除，先停止' : '删除人格配置'"
            @click="emit('delete')"
          >
            <Icon name="trash" :size="13" /> 删除
          </button>
        </div>
      </div>

      <div class="panel-body">
        <div class="profile-specs">
          <div class="profile-spec profile-model-spec">
            <span class="profile-spec-label">模型</span>
            <span class="profile-spec-value mono">{{ modelLabel }}</span>
          </div>
          <div class="profile-spec-grid">
            <div v-for="entry in engineSummary" :key="entry.label" class="profile-spec">
              <span class="profile-spec-label">{{ entry.label }}</span>
              <span class="profile-spec-value mono">{{ entry.value }}</span>
            </div>
          </div>
        </div>

        <div v-if="profile.lastError !== undefined" class="error-panel" role="alert" style="margin-bottom: 14px">
          <Icon name="alert" :size="16" />
          <div>
            <strong>{{ errorTitle }}</strong>
            <div>{{ profile.lastError }}</div>
            <div class="small" style="margin-top: 5px">配置仍然保存在磁盘上。修正后重新应用即可；停止人格配置会清除这条错误。</div>
          </div>
        </div>
        <div v-if="pending && profile.state === 'active'" class="notice notice-warning" style="margin-bottom: 14px">
          <Icon name="warningCircle" :size="15" />
          <span>
            配置保存于 {{ formatDateTime(profile.savedAt) }}，当前运行实例使用的是
            {{ profile.appliedAt === undefined ? "尚未应用" : formatDateTime(profile.appliedAt) }} 的版本。应用或重新加载后才会切换。
          </span>
        </div>

        <div class="form-grid three">
          <div>
            <div class="field-label">状态</div>
            <StatusBadge :state="badgeState(profile.state)" :pulse="profile.state === 'loading'" />
            <div class="field-hint" style="margin-top: 4px">
              {{
                profile.state === "active"
                  ? "配置已装载，运行实例按需创建。"
                  : profile.state === "loading"
                    ? "正在装载配置，完成后可停止或重新加载。"
                    : profile.state === "failed"
                      ? "最近一次应用被拒绝，配置仍保留。"
                      : "没有运行实例，应用后才会启动。"
              }}
            </div>
          </div>
          <div>
            <div class="field-label">保存时间</div>
            <div class="mono small" style="margin-top: 4px">{{ formatDateTime(profile.savedAt) }}</div>
            <div class="field-hint">{{ relativeTime(profile.savedAt) }}</div>
          </div>
          <div>
            <div class="field-label">应用时间</div>
            <div class="mono small" style="margin-top: 4px">
              {{ profile.appliedAt === undefined ? "未应用" : formatDateTime(profile.appliedAt) }}
            </div>
            <div class="field-hint">{{ profile.appliedAt === undefined ? "保存不会自动应用" : relativeTime(profile.appliedAt) }}</div>
          </div>
        </div>

        <div class="form-grid" style="margin-top: 12px">
          <div>
            <div class="field-label">运行实例</div>
            <div class="mono small" style="margin-top: 4px">{{ runtimes.length }} 个</div>
            <div class="field-hint">来自实时运行时快照。</div>
          </div>
          <div>
            <div class="field-label">会话</div>
            <div class="mono small" style="margin-top: 4px">{{ profile.sessionCount }} 个</div>
            <div class="field-hint">日志保留在 runtimes/&lt;实例&gt;/events.jsonl。</div>
          </div>
        </div>
      </div>
    </div>

    <div class="form-grid">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">频道认领</div>
          <div class="panel-actions">
            <span class="badge badge-outline">{{ channelRows.length }} 个账号</span>
          </div>
        </div>
        <div class="panel-body">
          <div v-if="channelRows.length === 0" class="field-hint">没有声明频道。这份人格配置不会被消息唤醒。</div>
          <div v-else class="stack-sm">
            <div v-for="row in channelRows" :key="row.account">
              <div class="mono small" style="margin-bottom: 4px">{{ row.account }}</div>
              <div v-if="row.patterns.length > 0" class="pill-row">
                <span v-for="pattern in row.patterns" :key="pattern" class="badge badge-outline mono">{{ pattern }}</span>
              </div>
              <div v-else class="field-hint">没有配置频道模式。</div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">扩展</div>
          <div class="panel-actions">
            <span class="badge badge-outline">{{ enabledExtensionCount }} / {{ extensionRows.length }} 启用</span>
          </div>
        </div>
        <div class="panel-body">
          <div v-if="extensionRows.length === 0" class="field-hint">没有声明扩展。基础工具仍然可用。</div>
          <div v-else class="stack-sm">
            <div v-for="row in extensionRows" :key="row.name" class="row">
              <Icon name="tag" :size="14" />
              <span class="mono small">{{ row.name }}</span>
              <span class="spacer"></span>
              <span class="badge" :class="row.enabled ? 'badge-success' : 'badge-neutral'">{{ row.enabled ? "已启用" : "已停用" }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">指令文件</div>
        <div class="panel-actions">
          <span class="panel-sub">路径相对于人格配置目录</span>
        </div>
      </div>
      <div class="panel-body">
        <div v-if="instructionRows.length === 0" class="field-hint">配置没有声明指令文件，保存人格时会写入默认的 PERSONA.md。</div>
        <div v-else class="stack-sm">
          <div v-for="file in instructionRows" :key="file.path" class="row row-wrap">
            <Icon :name="file.missing ? 'warningCircle' : 'file'" :size="14" />
            <span class="mono small">{{ file.path }}</span>
            <span v-if="file.path === personaPath" class="badge badge-info">人设文件</span>
            <span v-if="file.missing" class="badge badge-warning">缺失</span>
            <span v-else class="badge badge-success">存在</span>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">运行实例</div>
        <div class="panel-actions">
          <span class="panel-sub">{{ runtimes.length }} 个</span>
        </div>
      </div>
      <div v-if="runtimes.length === 0" class="empty" style="padding: 26px">
        <div class="empty-mark"><Icon name="runtimes" :size="20" /></div>
        <div class="empty-title">没有活跃实例</div>
        <p class="empty-desc">人格配置应用后，认领频道的第一条输入会创建运行实例。旧会话日志仍可在「会话日志」中查看。</p>
      </div>
      <div v-else class="list">
        <button
          v-for="runtime in runtimes"
          :key="runtime.id"
          type="button"
          class="list-item"
          :disabled="runtimeTarget(runtime.id) === ''"
          @click="openRuntimeSession(runtimeTarget(runtime.id))"
        >
          <div class="list-item-main">
            <div class="list-item-title">
              <span class="mono">{{ runtime.domainLabel }}</span>
              <StatusBadge :state="badgeState(runtime.state)" />
            </div>
            <div class="list-item-meta">
              <span class="mono">{{ runtime.id }}</span>
              <span v-if="runtime.platform !== undefined">{{ runtime.platform }}:{{ runtime.selfId ?? "" }}</span>
              <span v-if="runtime.channelId !== undefined">{{ runtime.channelId }}</span>
              <span v-if="runtime.error !== undefined" class="muted">{{ runtime.error }}</span>
            </div>
          </div>
          <div class="list-item-side">
            <time>{{ relativeTime(runtime.lastActivity) }}</time>
            <Icon v-if="runtimeTarget(runtime.id) !== ''" name="chevron" :size="14" />
          </div>
        </button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">人格</div>
        <div class="panel-actions">
          <span v-if="personaPath !== undefined" class="panel-sub mono">{{ personaPath }}</span>
        </div>
      </div>
      <div class="panel-body">
        <pre v-if="profile.persona.length > 0" class="json-block profile-persona">{{ profile.persona }}</pre>
        <div v-else class="field-hint">人设文件为空{{ personaPath === undefined ? "或全部缺失" : "" }}。点击「编辑」可以在人格分区写入内容。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile-persona {
  max-height: 240px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.profile-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.profile-specs {
  display: grid;
  grid-template-columns: minmax(260px, 1.7fr) minmax(0, 3fr);
  gap: 1px;
  margin-bottom: 14px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--line);
}

.profile-spec-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  background: var(--line);
}

.profile-spec {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px;
  background: var(--surface-inset);
}

.profile-model-spec {
  background: var(--surface-raised);
}

.profile-spec-label {
  color: var(--muted);
  font-size: 11px;
}

.profile-spec-value {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ink-soft);
  font-size: 11.5px;
  font-weight: 600;
}

@media (max-width: 900px) {
  .profile-head {
    flex-wrap: wrap;
  }

  .profile-actions {
    width: 100%;
    margin-left: 0;
    justify-content: flex-start;
  }

  .profile-specs {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 620px) {
  .profile-spec-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
