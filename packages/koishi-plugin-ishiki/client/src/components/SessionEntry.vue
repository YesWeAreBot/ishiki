<script setup lang="ts">
import { computed, ref } from "vue";

import type { LogEntry } from "../data/types";
import { formatClock, formatDateTime, formatNumber } from "../lib/format";
import Icon from "./Icon.vue";

const props = defineProps<{ entry: LogEntry }>();

const textOpen = ref(false);

const message = computed(() => (props.entry.type === "message" ? (props.entry.data as Record<string, any>) : undefined));
const role = computed(() => String(message.value?.role ?? ""));
const customType = computed(() => (role.value === "custom" ? String(message.value?.type ?? "") : ""));
const eventType = computed(() => (props.entry.type === "event" ? String(props.entry.data.type ?? "") : ""));

const kind = computed(() => {
  if (props.entry.type === "event") return "event";
  if (props.entry.type === "state") return "state";
  if (props.entry.type === "ishiki.compact") return "compact";
  if (props.entry.type === "ishiki.narrative") return "narrative";
  if (role.value === "assistant") return "assistant";
  if (role.value === "tool") return "tool";
  if (role.value === "custom") return customType.value === "ishiki.message.created" ? "user" : "custom";
  if (role.value === "user" || role.value === "system") return role.value;
  return "other";
});

const label = computed(() => {
  switch (kind.value) {
    case "assistant":
      return "助手";
    case "tool":
      return "工具结果";
    case "user":
      return "频道消息";
    case "event":
      return eventLabel(eventType.value);
    case "state":
      return "Agent 状态";
    case "compact":
      return "上下文压缩";
    case "narrative":
      return "叙事投影";
    case "custom":
      if (customType.value === "ishiki.tools.catalog") return "工具目录";
      if (customType.value === "ishiki.attachment") return "附件";
      if (customType.value === "ishiki.message.deleted") return "消息撤回";
      return `自定义消息 · ${customType.value || "unknown"}`;
    default:
      return role.value || props.entry.type;
  }
});

const marker = computed(() => {
  switch (kind.value) {
    case "assistant":
      return "pulse";
    case "tool":
      return "terminal";
    case "user":
      return "sessions";
    case "event":
      return eventType.value === "turn.failed" ? "alert" : "clock";
    case "state":
      return "memory";
    case "compact":
      return "minimize";
    case "narrative":
      return "file";
    default:
      return "tag";
  }
});

const markerTone = computed(() => {
  if (eventType.value === "turn.failed" || eventType.value === "turn.aborted") return { background: "var(--danger-soft)", color: "var(--danger-ink)" };
  if (kind.value === "assistant") return { background: "var(--accent-soft)", color: "var(--accent-ink)" };
  if (kind.value === "tool") return { background: "var(--info-soft)", color: "var(--info-ink)" };
  return undefined;
});

const text = computed(() => {
  const value = message.value?.content;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return String(part.text ?? "");
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
});

const long = computed(() => {
  const data = props.entry.data as Record<string, any>;
  const source =
    data?.role === "custom" && data.type === "ishiki.message.created"
      ? String(data.data?.content ?? "")
      : props.entry.type === "ishiki.compact"
        ? String(data.summary ?? "")
        : text.value;
  return source.length > 520 || source.split("\n").length > 9;
});

const reasoning = computed(() =>
  Array.isArray(message.value?.content)
    ? message.value.content.filter((part: any) => part?.type === "reasoning").map((part: any) => String(part.text ?? ""))
    : [],
);

const toolCalls = computed(() =>
  Array.isArray(message.value?.content)
    ? message.value.content
        .filter((part: any) => part?.type === "tool-call")
        .map((part: any) => ({
          id: String(part.toolCallId ?? ""),
          name: String(part.toolName ?? ""),
          input: part.input,
        }))
    : [],
);

const toolResults = computed(() =>
  Array.isArray(message.value?.content)
    ? message.value.content
        .filter((part: any) => part?.type === "tool-result")
        .map((part: any) => ({
          id: String(part.toolCallId ?? ""),
          name: String(part.toolName ?? ""),
          output: part.output,
          error: part.output?.type === "error-text" || part.output?.type === "error-json",
        }))
    : [],
);

const usage = computed(() => message.value?.usage as Record<string, any> | undefined);
const created = computed(() => (customType.value === "ishiki.message.created" ? (message.value?.data as Record<string, any>) : undefined));
const deleted = computed(() => (customType.value === "ishiki.message.deleted" ? (message.value?.data as Record<string, any>) : undefined));
const attachment = computed(() => (customType.value === "ishiki.attachment" ? (message.value?.data as Record<string, any>) : undefined));
const catalog = computed(() => (customType.value === "ishiki.tools.catalog" ? (message.value?.data as Record<string, any>) : undefined));
const compact = computed(() => (props.entry.type === "ishiki.compact" ? (props.entry.data as Record<string, any>) : undefined));
const narrative = computed(() => (props.entry.type === "ishiki.narrative" ? (props.entry.data as Record<string, any>) : undefined));

const eventText = computed(() => {
  if (props.entry.type !== "event") return "";
  const data = props.entry.data;
  if (data.type === "turn.failed") return `${data.error?.name ?? "Error"}: ${data.error?.message ?? "未知错误"}`;
  if (data.type === "turn.aborted") return `原因：${data.reason ?? "未提供"}`;
  if (data.type === "turn.done" && data.totalUsage !== undefined) {
    return `输入 ${formatNumber(data.totalUsage.inputTokens)} · 输出 ${formatNumber(data.totalUsage.outputTokens)} · 合计 ${formatNumber(data.totalUsage.totalTokens)} tokens`;
  }
  return "";
});

function eventLabel(type: string): string {
  switch (type) {
    case "turn.start":
      return "轮次开始";
    case "turn.done":
      return "轮次完成";
    case "turn.failed":
      return "轮次失败";
    case "turn.aborted":
      return "轮次中断";
    default:
      return `事件 · ${type}`;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}
</script>

<template>
  <article class="log-entry">
    <div class="log-marker" :style="markerTone" :title="label">
      <Icon :name="marker" :size="12" />
    </div>

    <div class="log-card">
      <header class="log-card-head">
        <span
          class="badge"
          :class="
            kind === 'user'
              ? 'badge-info'
              : kind === 'assistant'
                ? 'badge-success'
                : kind === 'event' && eventType === 'turn.failed'
                  ? 'badge-danger'
                  : 'badge-neutral'
          "
          >{{ label }}</span
        >
        <span v-if="created" class="log-who">{{ created.user?.name ?? created.user?.id }}</span>
        <span v-else-if="role === 'assistant'" class="log-who mono">{{ message?.modelId ?? "assistant" }}</span>
        <span v-else-if="role === 'tool'" class="log-who mono">{{ toolResults.map((result) => result.name).join(", ") || "tool" }}</span>
        <span v-if="created?.isDirect" class="badge badge-outline">私聊</span>
        <span v-if="created !== undefined" class="msg-target">{{ created.platform }}:{{ created.selfId }} / {{ created.channelId }}</span>
        <span class="log-time" :title="formatDateTime(entry.timestamp)">{{ formatClock(entry.timestamp) }}</span>
      </header>

      <div class="log-body">
        <template v-if="created">
          <div class="row" style="margin-bottom: 5px">
            <span class="badge badge-outline mono">#{{ created.messageId }}</span>
            <span class="faint small">{{ created.user?.name ?? created.user?.id }}</span>
          </div>
          <div class="log-text" :class="{ clamped: long && !textOpen }">{{ created.content || "（空消息）" }}</div>
          <button v-if="long" type="button" class="log-toggle" @click="textOpen = !textOpen">{{ textOpen ? "收起" : "展开全文" }}</button>
          <div v-if="created.quote" class="notice" style="margin-top: 8px">
            <Icon name="link" :size="14" />
            <span
              >引用 #{{ created.quote.id }}<template v-if="created.quote.content">：{{ created.quote.content }}</template></span
            >
          </div>
        </template>

        <template v-else-if="deleted">
          <p>
            {{ deleted.userId === deleted.operatorId ? `${deleted.userId} 撤回了一条消息` : `${deleted.userId} 的消息被 ${deleted.operatorId} 撤回` }} #{{
              deleted.messageId
            }}
          </p>
        </template>

        <template v-else-if="attachment">
          <div class="row row-wrap">
            <Icon name="file" :size="15" />
            <span class="mono small">{{ attachment.items?.length ?? 0 }} 个附件</span>
            <span v-for="item in attachment.items" :key="item.url" class="badge badge-outline mono">{{ item.mediaType }}</span>
          </div>
          <div class="field-hint" style="margin-top: 5px">
            <span v-for="item in attachment.items" :key="item.url">{{ item.filename ?? item.url }}（{{ item.lifetime ?? "once" }}）</span>
          </div>
        </template>

        <template v-else-if="catalog">
          <details>
            <summary class="log-toggle" style="margin: 0">
              工具目录 v{{ catalog.version ?? "?" }} · {{ catalog.tools?.length ?? 0 }} 个工具 · {{ catalog.mode ?? "full" }}
            </summary>
            <pre class="json-block" style="margin-top: 8px">{{ catalog.text }}</pre>
          </details>
        </template>

        <template v-else-if="compact">
          <p class="muted small">压缩到条目 {{ compact.lastEntryId }}</p>
          <div class="log-text" :class="{ clamped: long && !textOpen }">{{ compact.summary || "（空摘要）" }}</div>
          <button v-if="long" type="button" class="log-toggle" @click="textOpen = !textOpen">{{ textOpen ? "收起" : "展开全文" }}</button>
        </template>

        <template v-else-if="narrative">
          <p class="small">
            <span class="badge badge-outline">{{ narrative.kind }}</span>
            <span v-if="narrative.originMessageId" class="faint mono">origin {{ narrative.originMessageId }}</span>
          </p>
          <div class="log-text" style="margin-top: 6px">{{ narrative.script || narrative.text || json(narrative) }}</div>
        </template>

        <template v-else-if="role === 'assistant'">
          <details v-for="(item, index) in reasoning" :key="index" class="reasoning" style="margin-bottom: 8px">
            <summary>推理内容 · {{ item.length }} 字符</summary>
            <p>{{ item }}</p>
          </details>

          <div v-if="text.length > 0" class="log-text" :class="{ clamped: long && !textOpen }">{{ text }}</div>
          <button v-if="long" type="button" class="log-toggle" @click="textOpen = !textOpen">{{ textOpen ? "收起" : "展开全文" }}</button>

          <div v-for="call in toolCalls" :key="call.id" class="tool-call" style="margin-top: 8px">
            <div class="tool-call-head">
              <Icon name="terminal" :size="13" />
              <span>{{ call.name }}</span>
              <span class="faint">{{ call.id }}</span>
            </div>
            <details>
              <summary class="log-toggle" style="margin: 0 9px 7px">查看参数</summary>
              <pre class="json-block">{{ json(call.input) }}</pre>
            </details>
          </div>

          <div v-if="usage" class="usage-row">
            <span
              >in <strong>{{ formatNumber(usage.inputTokens) }}</strong></span
            >
            <span
              >out <strong>{{ formatNumber(usage.outputTokens) }}</strong></span
            >
            <span
              >cache read <strong>{{ formatNumber(usage.inputTokenDetails?.cacheReadTokens) }}</strong></span
            >
            <span
              >cache write <strong>{{ formatNumber(usage.inputTokenDetails?.cacheWriteTokens) }}</strong></span
            >
            <span
              >reasoning <strong>{{ formatNumber(usage.outputTokenDetails?.reasoningTokens) }}</strong></span
            >
            <span v-if="message?.finishReason"
              >finish <strong>{{ message.finishReason }}</strong></span
            >
          </div>
        </template>

        <template v-else-if="role === 'tool'">
          <div v-for="result in toolResults" :key="result.id" class="tool-call">
            <div class="tool-call-head">
              <Icon :name="result.error ? 'alert' : 'check'" :size="13" />
              <span>{{ result.name }}</span>
              <span class="badge" :class="result.error ? 'badge-danger' : 'badge-success'">{{ result.error ? "错误" : "完成" }}</span>
              <span class="faint">{{ result.id }}</span>
            </div>
            <details open>
              <summary class="log-toggle" style="margin: 0 9px 7px">查看结果</summary>
              <pre class="json-block">{{ json(result.output) }}</pre>
            </details>
          </div>
        </template>

        <template v-else-if="kind === 'event' || kind === 'state'">
          <div class="row row-wrap">
            <span class="mono small">{{ eventType || entry.type }}</span>
            <span v-if="entry.turnId" class="badge badge-outline mono">{{ entry.turnId }}</span>
            <span
              v-if="eventText"
              class="small"
              :style="{ color: eventType === 'turn.failed' || eventType === 'turn.aborted' ? 'var(--danger-ink)' : 'var(--muted)' }"
              >{{ eventText }}</span
            >
          </div>
          <details v-if="kind === 'state'" style="margin-top: 8px">
            <summary class="log-toggle" style="margin: 0">状态快照</summary>
            <pre class="json-block">{{ json(entry.data) }}</pre>
          </details>
        </template>

        <template v-else>
          <div class="log-text" :class="{ clamped: long && !textOpen }">{{ text || json(entry.data) }}</div>
          <button v-if="long" type="button" class="log-toggle" @click="textOpen = !textOpen">{{ textOpen ? "收起" : "展开全文" }}</button>
        </template>
      </div>
    </div>
  </article>
</template>
