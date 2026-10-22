<script setup lang="ts">
import { computed } from "vue";

import type { ProfileView } from "../data/types";
import { formatDateTime, relativeTime } from "../lib/format";
import { profileModeLabel } from "../lib/profile";
import { navigate, sessionsForProfile, runtimesForProfile, store } from "../store";
import Icon from "./Icon.vue";
import StatusBadge from "./StatusBadge.vue";

const props = defineProps<{ profile: ProfileView }>();
const emit = defineEmits<{ edit: []; activate: []; stop: []; restart: []; delete: [] }>();

const runtimes = computed(() => runtimesForProfile(props.profile.id));
const sessions = computed(() => sessionsForProfile(props.profile.id));
const busy = computed(() => store.busyProfiles[props.profile.id]);
const configPending = computed(() => props.profile.savedAt > (props.profile.appliedAt ?? 0));
const canDelete = computed(() => props.profile.status !== "active" && props.profile.status !== "activating" && props.profile.status !== "stopping");
const enabledExtensions = computed(() => Object.entries(props.profile.config.extensions).filter(([, value]) => value.enable));

const engineSummary = computed(() => [
  { label: "context", value: props.profile.config.context.engine },
  { label: "wakeup", value: props.profile.config.wakeup.engine },
  { label: "toolcall", value: props.profile.config.toolcall.engine },
]);

const modelSummary = computed(() => {
  if (props.profile.config.model === undefined) return "未配置";
  return props.profile.config.model;
});

function openRuntime(id: string): void {
  navigate("/runtimes", `id=${encodeURIComponent(id)}`);
}

function openSession(id: string): void {
  navigate("/sessions", `id=${encodeURIComponent(id)}`);
}
</script>

<template>
  <div class="stack">
    <div class="panel">
      <div class="panel-head">
        <div class="flex-1">
          <div class="row row-wrap">
            <span class="panel-title mono">{{ profile.id }}</span>
            <StatusBadge :state="profile.status" />
            <span class="badge badge-outline">{{ profileModeLabel(profile.config.mode) }}</span>
            <span v-if="configPending && profile.status === 'active'" class="badge badge-warning">有未应用更改</span>
          </div>
          <div class="panel-sub" style="margin-top: 5px">
            model <span class="mono">{{ modelSummary }}</span> · {{ engineSummary.map((entry) => `${entry.label}:${entry.value}`).join(" · ") }}
          </div>
        </div>
        <div class="panel-actions">
          <button type="button" class="btn btn-sm" @click="emit('edit')"><Icon name="edit" :size="14" /> 编辑</button>
          <button v-if="profile.status === 'active'" type="button" class="btn btn-sm" :disabled="busy !== undefined" @click="emit('stop')">
            <span v-if="busy === 'stopping'" class="spinner" aria-hidden="true"></span>
            <Icon v-else name="stop" :size="13" />
            {{ busy === "stopping" ? "停止中…" : "停止" }}
          </button>
          <button v-if="profile.status === 'active'" type="button" class="btn btn-sm btn-soft" :disabled="busy !== undefined" @click="emit('restart')">
            <span v-if="busy === 'restarting'" class="spinner" aria-hidden="true"></span>
            <Icon v-else name="refresh" :size="13" />
            {{ busy === "restarting" ? "重新激活中…" : "重新激活" }}
          </button>
          <button
            v-else
            type="button"
            class="btn btn-sm btn-primary"
            :disabled="busy !== undefined || profile.status === 'activating'"
            @click="emit('activate')"
          >
            <span v-if="profile.status === 'activating'" class="spinner" aria-hidden="true"></span>
            <Icon v-else name="play" :size="13" />
            {{ profile.status === "activating" ? "激活中…" : "激活" }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-danger"
            :disabled="!canDelete"
            :title="canDelete ? '删除 Profile' : '运行中的 Profile 不能删除'"
            @click="emit('delete')"
          >
            <Icon name="trash" :size="13" /> 删除
          </button>
        </div>
      </div>

      <div class="panel-body">
        <div v-if="profile.status === 'error'" class="error-panel" role="alert" style="margin-bottom: 14px">
          <Icon name="alert" :size="16" />
          <div>
            <strong>激活失败</strong>
            <div>{{ profile.lastError }}</div>
            <div class="small" style="margin-top: 5px">配置仍然保存。修正字段后重新激活；不会丢失 profile 目录。</div>
          </div>
        </div>
        <div v-if="configPending && profile.status === 'active'" class="notice notice-warning" style="margin-bottom: 14px">
          <Icon name="warningCircle" :size="15" />
          <span>
            配置保存于 {{ formatDateTime(profile.savedAt) }}，当前运行实例读取的是 {{ formatDateTime(profile.appliedAt) }} 的版本。重新激活后才会切换。
          </span>
        </div>

        <div class="form-grid three">
          <div>
            <div class="field-label">当前状态</div>
            <StatusBadge :state="profile.status" />
            <div class="field-hint" style="margin-top: 4px">
              {{ profile.status === "active" ? "配置已装载，runtime 按需创建。" : profile.status === "error" ? "配置存在，激活被拒绝。" : "没有运行实例。" }}
            </div>
          </div>
          <div>
            <div class="field-label">运行实例</div>
            <div class="metric-value" style="font-size: 18px">{{ runtimes.length }}<small> 个</small></div>
            <div class="field-hint">{{ runtimes.length === 0 ? "收到下一条认领消息时创建。" : "按频道或 cross 模式派生。" }}</div>
          </div>
          <div>
            <div class="field-label">配置时间</div>
            <div class="mono small" style="margin-top: 4px">保存 {{ relativeTime(profile.savedAt) }}</div>
            <div class="mono small muted">应用 {{ profile.appliedAt === undefined ? "尚未应用" : relativeTime(profile.appliedAt) }}</div>
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
        <p class="empty-desc">Profile 激活后，认领频道的第一条输入会创建 runtime。旧会话日志仍可在「会话浏览」中查看。</p>
      </div>
      <div v-else class="list">
        <button v-for="runtime in runtimes" :key="runtime.id" type="button" class="list-item" @click="openRuntime(runtime.id)">
          <div class="list-item-main">
            <div class="list-item-title">
              <span class="mono">{{ runtime.domainLabel }}</span>
              <StatusBadge :state="runtime.state" />
            </div>
            <div class="list-item-meta">
              <span class="mono">{{ runtime.id }}</span>
              <span v-if="runtime.activeTurnId !== undefined">turn {{ runtime.activeTurnId }}</span>
            </div>
          </div>
          <div class="list-item-side">
            <time>{{ relativeTime(runtime.lastActivity) }}</time>
            <Icon name="chevron" :size="14" />
          </div>
        </button>
      </div>
    </div>

    <div class="form-grid">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">频道认领</div>
          <div class="panel-actions">
            <span class="badge badge-outline">{{ Object.keys(profile.config.channels).length }} 个账号</span>
          </div>
        </div>
        <div class="panel-body">
          <div class="stack-sm">
            <div v-for="(patterns, account) in profile.config.channels" :key="account">
              <div class="mono small" style="margin-bottom: 4px">{{ account }}</div>
              <div class="pill-row">
                <span v-for="pattern in patterns" :key="pattern" class="badge badge-outline mono">{{ pattern }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">扩展</div>
          <div class="panel-actions">
            <span class="badge badge-outline">{{ enabledExtensions.length }} 个启用</span>
          </div>
        </div>
        <div class="panel-body">
          <div v-if="enabledExtensions.length === 0" class="field-hint">没有启用扩展。基础工具 read、send_message、finish、wait 仍然可用。</div>
          <div v-else class="stack-sm">
            <div v-for="[name] in enabledExtensions" :key="name" class="row">
              <Icon name="tag" :size="14" />
              <span class="mono small">{{ name }}</span>
              <span class="spacer"></span>
              <span class="badge badge-success">已启用</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">会话</div>
        <div class="panel-actions"><span class="panel-sub">日志保留在 runtimes/&lt;实例&gt;/events.jsonl</span></div>
      </div>
      <div v-if="sessions.length === 0" class="empty" style="padding: 24px">
        <div class="empty-title">还没有会话日志</div>
      </div>
      <div v-else class="list">
        <button v-for="session in sessions" :key="session.id" type="button" class="list-item" @click="openSession(session.id)">
          <div class="list-item-main">
            <div class="list-item-title">
              <span class="mono">{{ session.domainLabel }}</span>
              <StatusBadge :state="session.state" />
            </div>
            <div class="list-item-meta">
              <span>{{ session.entries }} 条记录</span>
              <span>{{ session.turns }} 轮</span>
              <span>{{ session.messages }} 条消息</span>
            </div>
          </div>
          <div class="list-item-side">
            <time>{{ relativeTime(session.lastActivity) }}</time
            ><Icon name="chevron" :size="14" />
          </div>
        </button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">人格 persona.md</div></div>
      <div class="panel-body">
        <p style="color: var(--ink-soft); max-width: 78ch">{{ profile.persona || "没有填写人格文件。" }}</p>
      </div>
    </div>
  </div>
</template>
