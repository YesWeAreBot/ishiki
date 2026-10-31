<script setup lang="ts">
import { computed, ref } from "vue";

import { formatClock, formatDateTime, formatNumber } from "../lib/format";
import type { LogEntry } from "../types";
import Icon from "./Icon.vue";

const props = defineProps<{ entry: LogEntry }>();

type Fields = Record<string, unknown>;

const ATTACHMENT_LIFETIME_LABELS: Record<string, string> = {
  once: "仅使用一次",
  recent: "近期保留",
  retain: "持续保留",
};
const FINISH_REASON_LABELS: Record<string, string> = {
  stop: "正常结束",
  length: "达到长度上限",
  "tool-calls": "等待工具结果",
  "content-filter": "内容被过滤",
  error: "发生错误",
  other: "其他原因",
};

const textOpen = ref(false);

function fields(value: unknown): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Fields;
}

function text(source: Fields | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function number(source: Fields | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list(source: Fields | undefined, key: string): unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}

function identifier(source: Fields | undefined, key: string): string {
  const value = source?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function json(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

const entryType = computed(() => String(props.entry.type));
const data = computed<Fields>(() => fields(props.entry.data) ?? {});
const isMessage = computed(() => entryType.value === "message");
const role = computed(() => (isMessage.value ? (text(data.value, "role") ?? "") : ""));
const customType = computed(() => (role.value === "custom" ? (text(data.value, "type") ?? "") : ""));
const eventType = computed(() => (entryType.value === "event" ? (text(data.value, "type") ?? "") : ""));

const created = computed(() => (customType.value === "ishiki.message.created" ? fields(data.value.data) : undefined));
const deleted = computed(() => (customType.value === "ishiki.message.deleted" ? fields(data.value.data) : undefined));
const attachment = computed(() => (customType.value === "ishiki.attachment" ? fields(data.value.data) : undefined));
const compact = computed(() => (entryType.value === "ishiki.compact" ? data.value : undefined));
const projection = computed(() => {
  if (entryType.value === "message" || entryType.value === "event" || entryType.value === "state") return undefined;
  if (compact.value !== undefined) return undefined;
  return data.value;
});

const createdUser = computed(() => fields(created.value?.user));
const createdUserName = computed(() => text(createdUser.value, "name") ?? text(createdUser.value, "id") ?? "未知用户");
const createdMessageId = computed(() => identifier(created.value, "messageId"));
const createdContent = computed(() => text(created.value, "content") ?? "");
const createdDirect = computed(() => created.value?.isDirect === true);
const createdTarget = computed(() => {
  const platform = text(created.value, "platform");
  if (platform === undefined) return "";
  return `${platform}:${text(created.value, "selfId") ?? "?"} / ${text(created.value, "channelId") ?? "?"}`;
});
const quote = computed(() => fields(created.value?.quote));
const quoteId = computed(() => identifier(quote.value, "id"));
const quoteContent = computed(() => text(quote.value, "content") ?? "");

const deletedSummary = computed(() => {
  const source = deleted.value;
  if (source === undefined) return "";
  const userId = text(source, "userId") ?? "未知用户";
  const operatorId = text(source, "operatorId");
  const messageId = identifier(source, "messageId") || "?";
  if (operatorId !== undefined && operatorId !== userId) return `${userId} 的消息被 ${operatorId} 撤回 #${messageId}`;
  return `${userId} 撤回了一条消息 #${messageId}`;
});

const attachmentItems = computed(() =>
  list(attachment.value, "items")
    .map((item) => fields(item))
    .filter((item): item is Fields => item !== undefined)
    .map((item) => {
      const lifetime = text(item, "lifetime") ?? "once";
      return {
        url: text(item, "url") ?? "",
        mediaType: text(item, "mediaType") ?? "未知类型",
        name: text(item, "filename") ?? text(item, "url") ?? "",
        lifetime,
        lifetimeLabel: ATTACHMENT_LIFETIME_LABELS[lifetime] ?? lifetime,
      };
    }),
);

const compactSummary = computed(() => text(compact.value, "summary") ?? "");
const compactLast = computed(() => text(compact.value, "lastEntryId") ?? "");
const projectionText = computed(() => text(projection.value, "script") ?? text(projection.value, "text") ?? "");
const projectionKind = computed(() => text(projection.value, "kind") ?? "");
const projectionOrigin = computed(() => text(projection.value, "originMessageId") ?? "");

const kind = computed(() => {
  if (entryType.value === "event") return "event";
  if (entryType.value === "state") return "state";
  if (compact.value !== undefined) return "compact";
  if (isMessage.value) {
    if (role.value === "assistant") return "assistant";
    if (role.value === "tool") return "tool";
    if (role.value === "user" || role.value === "system") return role.value;
    if (role.value === "custom") {
      if (customType.value === "ishiki.message.created") return "created";
      if (customType.value === "ishiki.message.deleted") return "deleted";
      if (customType.value === "ishiki.attachment") return "attachment";
      return "custom";
    }
    return "unknown";
  }
  if (projection.value !== undefined) return "projection";
  return "unknown";
});

const entryClass = computed(() => ({
  [`is-${kind.value}`]: true,
  "is-outgoing": kind.value === "user" || kind.value === "created",
  "is-meta": kind.value === "event" || kind.value === "state" || kind.value === "compact" || kind.value === "projection",
}));

const label = computed(() => {
  switch (kind.value) {
    case "assistant":
      return "助手";
    case "tool":
      return "工具结果";
    case "created":
    case "user":
      return "频道消息";
    case "deleted":
      return "消息撤回";
    case "attachment":
      return "附件";
    case "custom":
      return `自定义消息 · ${customType.value || "未知类型"}`;
    case "event":
      return eventLabel(eventType.value);
    case "state":
      return "智能体状态";
    case "compact":
      return "上下文压缩";
    case "projection":
      return "转换记录";
    case "system":
      return "系统消息";
    default:
      return role.value || entryType.value;
  }
});

const marker = computed(() => {
  switch (kind.value) {
    case "assistant":
      return "pulse";
    case "tool":
      return "terminal";
    case "created":
    case "user":
      return "sessions";
    case "deleted":
      return "trash";
    case "attachment":
      return "file";
    case "event":
      return eventType.value === "turn.failed" ? "alert" : "clock";
    case "state":
      return "memory";
    case "compact":
      return "minimize";
    case "projection":
      return "file";
    default:
      return "tag";
  }
});

const markerTone = computed(() => {
  if (eventType.value === "turn.failed" || eventType.value === "turn.aborted") {
    return { background: "var(--danger-soft)", color: "var(--danger-ink)" };
  }
  if (kind.value === "assistant") return { background: "var(--accent-soft)", color: "var(--accent-ink)" };
  if (kind.value === "tool") return { background: "var(--info-soft)", color: "var(--info-ink)" };
  if (kind.value === "deleted") return { background: "var(--danger-soft)", color: "var(--danger-ink)" };
  return undefined;
});

const badgeClass = computed(() => {
  if (kind.value === "assistant") return "badge-success";
  if (kind.value === "created" || kind.value === "user") return "badge-info";
  if (kind.value === "deleted" || eventType.value === "turn.failed") return "badge-danger";
  return "badge-neutral";
});

const contentParts = computed(() => (isMessage.value ? list(data.value, "content") : []));
const bodyText = computed(() => {
  const value = data.value.content;
  if (!isMessage.value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        const item = fields(part);
        return text(item, "type") === "text" ? (text(item, "text") ?? "") : "";
      })
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  if (value === undefined) return "";
  return json(value);
});

const reasoning = computed(() =>
  contentParts.value
    .map((part) => fields(part))
    .filter((part): part is Fields => part !== undefined && text(part, "type") === "reasoning")
    .map((part) => text(part, "text") ?? ""),
);

const toolCalls = computed(() =>
  contentParts.value
    .map((part) => fields(part))
    .filter((part): part is Fields => part !== undefined && text(part, "type") === "tool-call")
    .map((part) => ({
      id: text(part, "toolCallId") ?? "",
      name: text(part, "toolName") ?? "tool",
      input: part.input,
    })),
);

const toolResults = computed(() =>
  contentParts.value
    .map((part) => fields(part))
    .filter((part): part is Fields => part !== undefined && text(part, "type") === "tool-result")
    .map((part) => ({
      id: text(part, "toolCallId") ?? "",
      name: text(part, "toolName") ?? "tool",
      output: part.output,
      error: isErrorOutput(part.output),
    })),
);

const usage = computed(() => fields(data.value.usage));
const usageItems = computed(() => {
  const source = usage.value;
  if (source === undefined) return [] as Array<{ label: string; value: string }>;
  const inputDetails = fields(source.inputTokenDetails);
  const result: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: number | undefined): void => {
    if (value !== undefined) result.push({ label, value: formatNumber(value) });
  };
  push("输入", number(source, "inputTokens"));
  push("输出", number(source, "outputTokens"));
  push("缓存读取", number(inputDetails, "cacheReadTokens"));
  push("缓存写入", number(inputDetails, "cacheWriteTokens"));
  return result;
});
const finishReason = computed(() => (isMessage.value ? text(data.value, "finishReason") : undefined));
const finishReasonLabel = computed(() => {
  const reason = finishReason.value;
  if (reason === undefined) return "";
  return FINISH_REASON_LABELS[reason] ?? reason;
});

const modelId = computed(() => (role.value === "assistant" ? (text(data.value, "modelId") ?? "assistant") : ""));

const eventText = computed(() => {
  if (kind.value !== "event") return "";
  switch (eventType.value) {
    case "turn.failed": {
      const error = fields(data.value.error);
      return `${text(error, "name") ?? "错误"}：${text(error, "message") ?? "未知错误"}`;
    }
    case "turn.aborted":
      return `原因：${text(data.value, "reason") ?? "未提供"}`;
    case "turn.done": {
      const total = fields(data.value.totalUsage);
      if (total === undefined) return "";
      const input = number(total, "inputTokens");
      const output = number(total, "outputTokens");
      const all = number(total, "totalTokens");
      return `输入 ${formatNumber(input)} · 输出 ${formatNumber(output)} · 合计 ${formatNumber(all)} Token`;
    }
    default:
      return "";
  }
});

function isErrorOutput(value: unknown): boolean {
  const type = text(fields(value), "type");
  return type === "error-text" || type === "error-json";
}

const longSource = computed(() => {
  if (created.value !== undefined) return createdContent.value;
  if (compact.value !== undefined) return compactSummary.value;
  if (kind.value === "projection") return projectionText.value;
  return bodyText.value;
});

const long = computed(() => longSource.value.length > 520 || longSource.value.split("\n").length > 9);

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
      return `事件 · ${type || "未知类型"}`;
  }
}
</script>

<template>
  <article class="log-entry" :class="entryClass">
    <div class="log-marker" :style="markerTone" :title="label">
      <Icon :name="marker" :size="12" />
    </div>

    <div class="log-card">
      <header class="log-card-head">
        <span class="badge" :class="badgeClass">{{ label }}</span>
        <span v-if="created" class="log-who">{{ createdUserName }}</span>
        <span v-else-if="kind === 'assistant'" class="log-who mono">{{ modelId }}</span>
        <span v-else-if="kind === 'tool'" class="log-who mono">{{ toolResults.map((result) => result.name).join(", ") || "工具" }}</span>
        <span v-if="createdDirect" class="badge badge-outline">私聊</span>
        <span v-if="createdTarget.length > 0" class="msg-target">{{ createdTarget }}</span>
        <span class="log-time" :title="formatDateTime(entry.timestamp)">{{ formatClock(entry.timestamp) }}</span>
      </header>

      <div class="log-body">
        <template v-if="kind === 'created'">
          <div class="row" style="margin-bottom: 5px">
            <span v-if="createdMessageId.length > 0" class="badge badge-outline mono">#{{ createdMessageId }}</span>
            <span class="faint small">{{ createdUserName }}</span>
          </div>
          <div class="log-text" :class="{ clamped: long && !textOpen }">{{ createdContent || "（空消息）" }}</div>
          <button v-if="long" type="button" class="log-toggle" @click="textOpen = !textOpen">{{ textOpen ? "收起" : "展开全文" }}</button>
          <div v-if="quote" class="notice" style="margin-top: 8px">
            <Icon name="link" :size="14" />
            <span
              >引用 #{{ quoteId }}<template v-if="quoteContent.length > 0">：{{ quoteContent }}</template></span
            >
          </div>
        </template>

        <template v-else-if="kind === 'deleted'">
          <p>{{ deletedSummary }}</p>
        </template>

        <template v-else-if="kind === 'attachment'">
          <div class="row row-wrap">
            <Icon name="file" :size="15" />
            <span class="mono small">{{ attachmentItems.length }} 个附件</span>
            <span v-for="item in attachmentItems" :key="item.url" class="badge badge-outline mono">{{ item.mediaType }}</span>
          </div>
          <div class="field-hint" style="margin-top: 5px">
            <span v-for="item in attachmentItems" :key="`${item.url}:${item.lifetime}`">{{ item.name }}（{{ item.lifetimeLabel }}）</span>
          </div>
        </template>

        <template v-else-if="kind === 'compact'">
          <p class="muted small">
            压缩到条目 <span class="mono">{{ compactLast || "—" }}</span>
          </p>
          <div class="log-text" :class="{ clamped: long && !textOpen }">{{ compactSummary || "（空摘要）" }}</div>
          <button v-if="long" type="button" class="log-toggle" @click="textOpen = !textOpen">{{ textOpen ? "收起" : "展开全文" }}</button>
        </template>

        <template v-else-if="kind === 'projection'">
          <p class="small">
            <span v-if="projectionKind.length > 0" class="badge badge-outline">{{ projectionKind }}</span>
            <span v-if="projectionOrigin.length > 0" class="faint mono">来源 {{ projectionOrigin }}</span>
          </p>
          <div class="log-text" style="margin-top: 6px">{{ projectionText || json(entry.data) }}</div>
        </template>

        <template v-else-if="kind === 'assistant'">
          <details v-for="(item, index) in reasoning" :key="index" class="reasoning" style="margin-bottom: 8px">
            <summary>推理内容 · {{ item.length }} 字符</summary>
            <p>{{ item }}</p>
          </details>

          <div v-if="bodyText.length > 0" class="log-text" :class="{ clamped: long && !textOpen }">{{ bodyText }}</div>
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

          <div v-if="usageItems.length > 0 || finishReason !== undefined" class="usage-row">
            <span v-for="item in usageItems" :key="item.label"
              >{{ item.label }} <strong>{{ item.value }}</strong></span
            >
            <span v-if="finishReason !== undefined"
              >结束原因 <strong>{{ finishReasonLabel }}</strong></span
            >
          </div>
        </template>

        <template v-else-if="kind === 'tool'">
          <div class="tool-results">
            <details v-for="result in toolResults" :key="result.id" class="tool-result" open>
              <summary class="tool-result-head">
                <Icon :name="result.error ? 'alert' : 'check'" :size="13" />
                <span class="tool-result-name">{{ result.name }}</span>
                <span class="badge" :class="result.error ? 'badge-danger' : 'badge-success'">{{ result.error ? "错误" : "完成" }}</span>
                <span class="tool-result-id">{{ result.id }}</span>
                <Icon class="tool-result-chevron" name="chevronDown" :size="13" />
              </summary>
              <pre class="json-block">{{ json(result.output) }}</pre>
            </details>
          </div>
          <p v-if="toolResults.length === 0" class="muted small">没有工具结果内容。</p>
        </template>

        <template v-else-if="kind === 'event' || kind === 'state'">
          <div class="row row-wrap">
            <span class="mono small">{{ eventType || entryType }}</span>
            <span v-if="entry.turnId !== undefined" class="badge badge-outline mono">{{ entry.turnId }}</span>
            <span
              v-if="eventText.length > 0"
              class="small"
              :style="{ color: eventType === 'turn.failed' || eventType === 'turn.aborted' ? 'var(--danger-ink)' : 'var(--muted)' }"
              >{{ eventText }}</span
            >
          </div>
          <details style="margin-top: 8px">
            <summary class="log-toggle" style="margin: 0">{{ kind === "state" ? "状态快照" : "事件数据" }}</summary>
            <pre class="json-block">{{ json(entry.data) }}</pre>
          </details>
        </template>

        <template v-else-if="kind === 'unknown'">
          <pre class="json-block">{{ json(entry.data) }}</pre>
        </template>

        <template v-else>
          <div class="log-text" :class="{ clamped: long && !textOpen }">{{ bodyText || json(entry.data) }}</div>
          <button v-if="long" type="button" class="log-toggle" @click="textOpen = !textOpen">{{ textOpen ? "收起" : "展开全文" }}</button>
        </template>
      </div>
    </div>
  </article>
</template>

<style scoped>
.log-card-head {
  flex-wrap: wrap;
}

.log-card-head .badge,
.log-card-head .msg-target {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-call-head > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
