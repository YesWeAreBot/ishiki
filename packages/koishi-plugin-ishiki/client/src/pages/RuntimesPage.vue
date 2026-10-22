<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import BaseModal from "../components/BaseModal.vue";
import CopyButton from "../components/CopyButton.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import StatusBadge from "../components/StatusBadge.vue";
import type { RuntimeView } from "../data/types";
import { formatCompact, formatDateTime, relativeTime } from "../lib/format";
import { navigate, profileById, restartRuntime, sessionById, stopRuntime, store, wakeRuntime } from "../store";

const query = ref("");
const profileFilter = ref("all");
const selectedId = ref("");
const action = reactive<{
  kind: "wake" | "restart" | "stop" | null;
  target: RuntimeView | null;
  prompt: string;
  busy: boolean;
  error: string;
}>({ kind: null, target: null, prompt: "", busy: false, error: "" });

const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  return store.runtimes.filter((runtime) => {
    if (profileFilter.value !== "all" && runtime.profileId !== profileFilter.value) return false;
    if (term.length === 0) return true;
    return (
      runtime.id.toLowerCase().includes(term) ||
      runtime.profileId.toLowerCase().includes(term) ||
      runtime.domainLabel.toLowerCase().includes(term) ||
      runtime.model.toLowerCase().includes(term)
    );
  });
});

const selected = computed(() => store.runtimes.find((runtime) => runtime.id === selectedId.value));
const session = computed(() => (selected.value === undefined ? undefined : sessionById(selected.value.sessionId)));
const profile = computed(() => (selected.value === undefined ? undefined : profileById(selected.value.profileId)));
const busy = computed(() => (selected.value === undefined ? undefined : store.busyRuntimes[selected.value.id]));

function readQuery(): string {
  return new URLSearchParams(store.query).get("id") ?? "";
}

function syncSelection(): void {
  const fromQuery = readQuery();
  if (fromQuery.length > 0 && store.runtimes.some((runtime) => runtime.id === fromQuery)) {
    selectedId.value = fromQuery;
    return;
  }
  if (selectedId.value.length > 0 && store.runtimes.some((runtime) => runtime.id === selectedId.value)) return;
  selectedId.value = store.runtimes[0]?.id ?? "";
}

watch(() => store.query, syncSelection, { immediate: true });
watch(
  () => store.runtimes.map((runtime) => runtime.id).join("|"),
  () => {
    if (!store.runtimes.some((runtime) => runtime.id === selectedId.value)) selectedId.value = store.runtimes[0]?.id ?? "";
  },
);

function select(runtime: RuntimeView): void {
  selectedId.value = runtime.id;
  navigate("/runtimes", `id=${encodeURIComponent(runtime.id)}`);
}

function ask(kind: "wake" | "restart" | "stop", runtime: RuntimeView): void {
  action.kind = kind;
  action.target = runtime;
  action.prompt = "";
  action.busy = false;
  action.error = "";
}

function closeAction(): void {
  action.kind = null;
  action.target = null;
  action.prompt = "";
  action.error = "";
}

async function runAction(): Promise<void> {
  if (action.target === null || action.kind === null) return;
  action.busy = true;
  if (action.kind === "wake") {
    const result = await wakeRuntime(action.target.id, action.prompt);
    action.busy = false;
    if (!result.ok) {
      action.error = result.error ?? "唤醒失败。";
      return;
    }
    closeAction();
  } else if (action.kind === "restart") {
    const result = await restartRuntime(action.target.id);
    action.busy = false;
    if (!result.ok) {
      action.error = result.error ?? "重启失败。";
      return;
    }
    closeAction();
  } else {
    const id = action.target.id;
    const result = await stopRuntime(id);
    action.busy = false;
    if (!result.ok) {
      action.error = result.error ?? "停止失败。";
      return;
    }
    closeAction();
    selectedId.value = store.runtimes[0]?.id ?? "";
  }
}

function openProfile(id: string): void {
  navigate("/profiles", `id=${encodeURIComponent(id)}`);
}

function openSession(id: string): void {
  navigate("/sessions", `id=${encodeURIComponent(id)}`);
}
</script>

<template>
  <PageHeader
    title="AgentRuntime"
    desc="运行实例由 Profile 按需创建，承载一份独立的会话日志与资源目录。这里查看状态、关联会话，并执行已有的唤醒、重启和停止操作。"
    eyebrow="运行 / 实例"
  >
    <template #actions>
      <span class="badge badge-outline">{{ store.runtimes.length }} 个活跃实例</span>
    </template>
  </PageHeader>

  <div class="notice notice-info" style="margin-bottom: 16px">
    <Icon name="info" :size="15" />
    <span>
      runtime 不能单独创建；认领频道的第一条输入会派生实例。Profile 停止时实例停止，日志与资源保留。中断当前轮次与实时事件流尚未提供运行时接口，标记为待实现。
    </span>
  </div>

  <div class="split split-wide">
    <div class="panel detail-sticky">
      <div class="panel-head" style="padding-bottom: 12px">
        <div class="panel-title">运行实例</div>
        <div class="panel-actions">
          <span class="badge badge-outline">{{ store.runtimes.length }}</span>
        </div>
      </div>
      <div class="list-search">
        <div class="search-box">
          <Icon name="search" :size="15" />
          <input v-model="query" class="input" aria-label="搜索运行实例" placeholder="搜索实例、Profile 或频道" />
        </div>
        <select v-model="profileFilter" class="select" aria-label="按 Profile 筛选" style="margin-top: 8px">
          <option value="all">全部 Profile</option>
          <option v-for="item in store.profiles" :key="item.id" :value="item.id">{{ item.id }}</option>
        </select>
      </div>

      <div v-if="filtered.length === 0" class="empty">
        <div class="empty-mark"><Icon name="runtimes" :size="20" /></div>
        <div class="empty-title">没有匹配的运行实例</div>
        <p class="empty-desc">停止 Profile 后实例会被移除；会话日志仍可在会话浏览中查看。</p>
        <button
          type="button"
          class="btn btn-soft"
          @click="
            query = '';
            profileFilter = 'all';
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
          :aria-current="selectedId === runtime.id ? 'true' : undefined"
          @click="select(runtime)"
        >
          <div class="list-item-main">
            <div class="list-item-title">
              <span class="mono">{{ runtime.domainLabel }}</span>
              <StatusBadge :state="runtime.state" />
            </div>
            <div class="list-item-meta">
              <span>{{ runtime.profileId }}</span>
              <span>{{ runtime.mode }}</span>
              <span v-if="runtime.activeTurnId" class="mono">{{ runtime.activeTurnId }}</span>
            </div>
            <div class="list-item-meta" style="margin-top: 4px">
              <span class="mono" style="font-size: 10px">{{ runtime.id }}</span>
            </div>
          </div>
          <div class="list-item-side">
            <time>{{ relativeTime(runtime.lastActivity) }}</time
            ><Icon name="chevron" :size="14" />
          </div>
        </button>
      </div>
    </div>

    <div v-if="selected === undefined" class="panel">
      <EmptyState title="选择一个运行实例" desc="实例的状态、当前轮次、模型、引擎、工作目录和会话日志会显示在这里。" icon="runtimes" />
    </div>

    <div v-else class="stack">
      <div class="panel">
        <div class="panel-head">
          <div class="flex-1">
            <div class="row row-wrap">
              <span class="panel-title mono" style="font-size: 13px">{{ selected.id }}</span>
              <StatusBadge :state="selected.state" />
              <span class="badge badge-outline">{{ selected.mode }}</span>
            </div>
            <div class="panel-sub" style="margin-top: 4px">
              <button type="button" class="link" style="border: 0; background: none; padding: 0" @click="openProfile(selected.profileId)">
                Profile {{ selected.profileId }}
              </button>
              <span class="faint"> · </span>
              <button type="button" class="link" style="border: 0; background: none; padding: 0" @click="openSession(selected.sessionId)">打开会话</button>
            </div>
          </div>
          <div class="panel-actions">
            <CopyButton :value="selected.id" label="实例 ID" />
          </div>
        </div>
        <div class="panel-body">
          <div class="form-grid three">
            <div>
              <div class="field-label">当前轮次</div>
              <div class="row" style="margin-top: 4px">
                <span v-if="selected.state === 'running'" class="status-dot-live" aria-hidden="true"></span>
                <span class="mono small">{{ selected.activeTurnId ?? "空闲" }}</span>
              </div>
              <div class="field-hint">{{ selected.state === "running" ? "正在执行模型或工具步骤。" : "等待下一条输入或唤醒。" }}</div>
            </div>
            <div>
              <div class="field-label">模型</div>
              <div class="mono small" style="margin-top: 4px">{{ selected.model }}</div>
              <div class="field-hint">由 Profile 配置决定；运行中不可单独修改。</div>
            </div>
            <div>
              <div class="field-label">最后活动</div>
              <div class="small" style="margin-top: 4px">{{ relativeTime(selected.lastActivity) }}</div>
              <div class="field-hint mono">{{ formatDateTime(selected.lastActivity) }}</div>
            </div>
          </div>

          <div class="divider"></div>

          <div class="row row-wrap">
            <button type="button" class="btn btn-sm btn-primary" :disabled="busy !== undefined" @click="ask('wake', selected)">
              <span v-if="busy === 'waking'" class="spinner" aria-hidden="true"></span>
              <Icon v-else name="play" :size="13" /> 唤醒
            </button>
            <button type="button" class="btn btn-sm" :disabled="busy !== undefined" @click="ask('restart', selected)">
              <span v-if="busy === 'restarting'" class="spinner" aria-hidden="true"></span>
              <Icon v-else name="refresh" :size="13" /> 重启
            </button>
            <button type="button" class="btn btn-sm btn-danger" :disabled="busy !== undefined" @click="ask('stop', selected)">
              <span v-if="busy === 'stopping'" class="spinner" aria-hidden="true"></span>
              <Icon v-else name="stop" :size="13" /> 停止
            </button>
            <span class="divider-vertical"></span>
            <button type="button" class="btn btn-sm" disabled title="需要运行时接口支持">
              <Icon name="stop" :size="13" /> 中断轮次 <span class="badge badge-outline" style="margin-left: 4px">待实现</span>
            </button>
            <button type="button" class="btn btn-sm" disabled title="需要事件流推送接口">
              <Icon name="pulse" :size="13" /> 实时事件流 <span class="badge badge-outline" style="margin-left: 4px">待实现</span>
            </button>
          </div>
        </div>
      </div>

      <div class="form-grid">
        <div class="panel">
          <div class="panel-head"><div class="panel-title">实例信息</div></div>
          <div class="panel-body">
            <dl class="kv">
              <dt>实例 key</dt>
              <dd class="mono">{{ selected.id }}</dd>
              <dt>Profile</dt>
              <dd>
                <button type="button" class="link" style="border: 0; background: none; padding: 0" @click="openProfile(selected.profileId)">
                  {{ selected.profileId }}
                </button>
              </dd>
              <dt>模式</dt>
              <dd>{{ selected.mode === "cross" ? "cross · 共享上下文" : "channel · 单频道" }}</dd>
              <dt>频道</dt>
              <dd>{{ selected.domainLabel }}</dd>
              <dt>工作目录</dt>
              <dd class="mono" style="font-size: 10.5px">{{ selected.home }}</dd>
              <dt>创建时间</dt>
              <dd>{{ formatDateTime(selected.createdAt) }}</dd>
              <dt>引擎</dt>
              <dd class="mono">context:{{ selected.engines.context }} · wakeup:{{ selected.engines.wakeup }} · toolcall:{{ selected.engines.toolcall }}</dd>
            </dl>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">关联会话</div>
            <div class="panel-actions">
              <button type="button" class="btn btn-ghost btn-sm" @click="openSession(selected.sessionId)">打开</button>
            </div>
          </div>
          <div class="panel-body">
            <dl class="kv">
              <dt>会话 ID</dt>
              <dd class="mono">{{ selected.sessionId }}</dd>
              <dt>记录</dt>
              <dd>{{ session?.entries ?? "—" }} 条</dd>
              <dt>消息</dt>
              <dd>{{ session?.messages ?? "—" }} 条</dd>
              <dt>轮次</dt>
              <dd>{{ session?.turns ?? "—" }}</dd>
              <dt>tokens</dt>
              <dd class="mono">{{ formatCompact(session?.tokens) }}</dd>
              <dt>状态</dt>
              <dd><StatusBadge v-if="session" :state="session.state" /><span v-else class="muted">无日志</span></dd>
              <dt>文件</dt>
              <dd class="mono" style="font-size: 10.5px">{{ session?.file ?? "—" }}</dd>
            </dl>
            <div class="notice" style="margin-top: 12px">
              <Icon name="info" :size="14" />
              <span>runtime 与 events.jsonl 一一对应。重启实例沿用原会话文件；停止实例保留日志。</span>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">生命周期与配置</div></div>
        <div class="panel-body">
          <p class="muted small" style="max-width: 80ch">
            实例在认领频道首次输入时创建，使用 Profile 激活时读取的模型、引擎与扩展配置。停止操作调用已有的 deactivateRuntime；重启调用 restartRuntime，实例 ID
            与工作目录不变。要改变模型或引擎，必须编辑 Profile 并重新激活。
          </p>
          <div class="row" style="margin-top: 12px">
            <button type="button" class="btn btn-sm" @click="openProfile(selected.profileId)"><Icon name="profile" :size="13" /> 打开 Profile 配置</button>
            <span v-if="profile" class="field-hint">当前 Profile 状态：{{ profile.status }} · model {{ profile.config.model }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <BaseModal
    :open="action.kind !== null"
    :title="action.kind === 'wake' ? '唤醒运行实例' : action.kind === 'restart' ? '重启运行实例' : '停止运行实例'"
    :desc="action.target?.id ?? ''"
    @close="closeAction"
  >
    <template v-if="action.target !== null">
      <template v-if="action.kind === 'wake'">
        <p>请求实例开启一个新轮次。提示词可选；留空时只凭已存储历史开启。</p>
        <div class="field" style="margin-top: 10px">
          <span class="field-label">提示词（可选）</span>
          <textarea v-model="action.prompt" class="textarea" rows="3" placeholder="例如：检查最近的缓存命中率，给出可复现步骤。"></textarea>
        </div>
        <div v-if="action.target.state === 'running'" class="notice notice-warning" style="margin-top: 10px">
          <Icon name="warningCircle" :size="15" />
          <span>实例当前正忙。唤醒请求会合并进待处理队列，不会并行开启第二个轮次。</span>
        </div>
      </template>

      <template v-else-if="action.kind === 'restart'">
        <p>重启期间实例不可用；重启后 ID、工作目录与会话文件保持不变。</p>
        <div class="impact-list">
          <span>正在执行的轮次会被中断。</span>
          <span>模型、引擎与扩展配置来自当前 Profile 激活时的版本，不会重新读取未应用的编辑。</span>
          <span>历史日志不会被清空。</span>
        </div>
      </template>

      <template v-else>
        <p>停止后实例从运行时列表移除，该频道下次输入会创建新实例。</p>
        <div class="impact-list">
          <span>正在执行的轮次会被中断。</span>
          <span>会话日志与资源目录保留。</span>
          <span>停止不是删除；不会清理 events.jsonl。</span>
        </div>
      </template>

      <div v-if="action.error" class="error-panel" style="margin-top: 12px"><Icon name="alert" :size="15" /> {{ action.error }}</div>
    </template>

    <template #footer>
      <button type="button" class="btn" @click="closeAction">取消</button>
      <button type="button" class="btn" :class="action.kind === 'stop' ? 'btn-danger' : 'btn-primary'" :disabled="action.busy" @click="runAction">
        <span v-if="action.busy" class="spinner" aria-hidden="true"></span>
        {{ action.busy ? "执行中…" : action.kind === "wake" ? "请求唤醒" : action.kind === "restart" ? "重启实例" : "停止实例" }}
      </button>
    </template>
  </BaseModal>
</template>
