<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { ApiError, call } from "../api";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import { formatDateTime, formatNumber, relativeTime } from "../lib/format";
import { store, toast } from "../store";
import type { JevDecisionView, JevSnapshot, JevStepView } from "../types";

type BooleanKey = "ready" | "receptive" | "worthwhile" | "social" | "withdrawn" | "closed" | "interested";

const RELATION_LABELS: Record<string, string> = {
  addressed: "对机器人说",
  followup: "延续对话",
  open: "公开讨论",
  other: "对别人说",
  ambient: "普通闲聊",
};

const BOOLEAN_ROWS: Array<{ key: BooleanKey; label: string; hint: string }> = [
  { key: "ready", label: "说完了", hint: "对方这句话是否完整" },
  { key: "receptive", label: "可插话", hint: "此刻插入是否自然" },
  { key: "worthwhile", label: "信息价值", hint: "能否提供实质内容" },
  { key: "social", label: "社交理由", hint: "是否有具体的玩梗或共情理由" },
  { key: "withdrawn", label: "已取消", hint: "对方是否让你别说" },
  { key: "closed", label: "已结束", hint: "这段对话是否收尾" },
  { key: "interested", label: "命中兴趣", hint: "话题是否匹配配置兴趣" },
];

const snapshot = ref<JevSnapshot | undefined>(store.jev);
const loading = ref(false);
const attempted = ref(false);
const errorText = ref("");

watch(
  () => store.jev,
  (value) => {
    if (value !== undefined) snapshot.value = value;
  },
);

const decisions = computed(() => snapshot.value?.decisions ?? []);
const bootstrapped = computed(() => store.jev !== undefined || attempted.value);

const counts = computed(() => {
  let reply = 0;
  let join = 0;
  let wait = 0;
  let skipped = 0;
  for (const item of decisions.value) {
    if (item.error !== undefined) continue;
    if (item.prefiltered) {
      skipped += 1;
      continue;
    }
    if (item.mode === "reply") reply += 1;
    else if (item.mode === "join") join += 1;
    else wait += 1;
  }
  return { reply, join, wait, skipped };
});

const STEP_TEXT: Record<string, string> = {
  withdrawn: "撤回检查",
  directed: "是否在跟机器人说话",
  ready: "是否说完",
  closed: "话题是否结束",
  "conversation-budget": "连续回复额度",
  "expired-conversation": "对话已过期",
  "global-frequency": "全局冷却",
  "turn-spacing": "判定间隔",
  "no-contribution": "贡献底线",
  "no-opening": "插话空间",
  "weak-contribution": "贡献门槛",
  "participation-enabled": "主动参与开关",
  "join-cooldown": "发言冷却",
  "participation-limit": "参与比例",
  "relevant-contribution": "主动加入（相关贡献）",
  "group-invitation": "主动加入（公开讨论）",
  addressed: "回复（对机器人说）",
  followup: "回复（延续对话）",
};

const STYLE_TEXT: Record<string, string> = { quiet: "安静", natural: "自然", talkative: "爱说" };
const PREFILTER_MODE_TEXT: Record<string, string> = { off: "关闭", safe: "安全", strict: "严格" };

function stepLabel(key: string): string {
  return STEP_TEXT[key] ?? key;
}

function formatStep(step: JevStepView): string {
  if (step.value === undefined) return "";
  if (step.key === "join-cooldown" || step.key === "global-frequency")
    return `${Math.round(step.value / 1000)} 秒 / 冷却 ${Math.round((step.line ?? 0) / 1000)} 秒`;
  const value = step.value.toFixed(2);
  return step.line === undefined ? value : `${value} / 线 ${step.line.toFixed(2)}`;
}

function prefilterText(reason: string): string {
  const key = reason.replace(/^prefilter:/, "");
  const labels: Record<string, string> = {
    duplicate: "同一人刚说过一样的话",
    "media-only": "只有表情或图片",
    cooldown: "还在冷却时间内",
    "global-frequency": "全局冷却时间内",
    spacing: "距上次主动唤醒过近",
    "participation-limit": "主动发言比例已满",
    "participation-disabled": "主动参与已关闭",
  };
  return labels[key] ?? key;
}

function reasonText(item: JevDecisionView): string {
  if (item.prefiltered) return `本地预筛跳过：${prefilterText(item.reason)}`;
  return item.reason;
}

function configRows(item: JevDecisionView): Array<{ label: string; value: string }> {
  const config = item.config;
  if (config === undefined) return [];
  return [
    { label: "本群主动加入倾向", value: STYLE_TEXT[config.style] ?? config.style },
    { label: "档位基准线", value: item.threshold.toFixed(2) },
    { label: "基础门槛", value: config.threshold.toFixed(2) },
    { label: "定向线", value: config.addressedThreshold.toFixed(2) },
    { label: "主动发言冷却（群）", value: `${Math.round(config.cooldownMs / 1000)} 秒` },
    { label: "主动发言冷却（全局）", value: `${Math.round(config.globalCooldownMs / 1000)} 秒` },
    { label: "唤醒间隔", value: `${Math.round(config.minIntervalMs / 1000)} 秒` },
    { label: "参与比例", value: `${Math.round(config.maxParticipation * 100)}%` },
    { label: "连续上限", value: String(config.maxConsecutiveReplies) },
    { label: "预筛", value: PREFILTER_MODE_TEXT[config.prefilter] ?? config.prefilter },
  ];
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function modeMeta(item: JevDecisionView): { tone: string; label: string } {
  if (item.error !== undefined) return { tone: "badge-danger", label: "调用失败" };
  if (item.mode === "reply") return { tone: "badge-success", label: "回复" };
  if (item.mode === "join") return { tone: "badge-warning", label: "主动加入" };
  return { tone: "badge-neutral", label: "保持沉默" };
}

function relationRows(item: JevDecisionView): Array<{ key: string; label: string; value: number }> {
  const relation = item.evidence?.relation ?? {};
  return Object.keys(RELATION_LABELS).map((key) => ({
    key,
    label: RELATION_LABELS[key],
    value: typeof relation[key] === "number" ? relation[key] : 0,
  }));
}

function booleanRows(item: JevDecisionView): Array<{ key: BooleanKey; label: string; hint: string; value: number }> {
  return BOOLEAN_ROWS.map((row) => ({
    ...row,
    value: typeof item.evidence?.[row.key] === "number" ? (item.evidence?.[row.key] as number) : 0,
  }));
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function width(value: number): string {
  return `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`;
}

async function refresh(silent = false): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await call<JevSnapshot>("ishiki/jev/trace");
    snapshot.value = result;
    errorText.value = "";
    if (!silent) toast("success", "判定记录已刷新", `共 ${formatNumber(result.decisions.length)} 条。`);
  } catch (error) {
    errorText.value = describe(error);
    toast("error", "读取判定记录失败", errorText.value);
  } finally {
    loading.value = false;
    attempted.value = true;
  }
}

onMounted(() => {
  if (store.jev === undefined) void refresh(true);
});
</script>

<template>
  <PageShell>
    <PageHeader
      title="唤醒判定"
      eyebrow="观测 / 唤醒判定"
      desc="每条记录保留模型给出的语义证据与本地规则的最终结论。各项证据独立计算，每条规则只与自己的阈值比较。"
    >
      <template #actions>
        <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="refresh(false)">
          <Icon v-if="loading" name="loading" :size="14" />
          <Icon v-else name="refresh" :size="14" />
          刷新
        </button>
      </template>
    </PageHeader>

    <div class="stack">
      <div v-if="errorText.length > 0" class="error-panel">
        <Icon name="alert" :size="15" />
        <div class="flex-1">
          <div class="strong">读取判定记录失败</div>
          <div class="mono">{{ errorText }}</div>
        </div>
        <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="refresh(false)">重试</button>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">最近判定汇总</div>
            <div class="panel-sub">只统计成功返回的判定；调用失败单独标记，不混进沉默。</div>
          </div>
          <div class="panel-actions">
            <span class="badge badge-success">回复 {{ counts.reply }}</span>
            <span class="badge badge-warning">加入 {{ counts.join }}</span>
            <span class="badge badge-neutral">沉默 {{ counts.wait }}</span>
            <span class="badge badge-outline">预筛跳过 {{ counts.skipped }}</span>
          </div>
        </div>
      </div>

      <div v-if="!bootstrapped" class="panel">
        <div class="loading-list">
          <div v-for="index in 4" :key="index" class="skeleton skeleton-line" style="width: 100%"></div>
          <div class="skeleton skeleton-line" style="width: 58%"></div>
        </div>
      </div>

      <div v-else-if="decisions.length === 0" class="panel">
        <EmptyState
          title="还没有判定记录"
          desc="判定发生在会话里有人说话之后。收到消息并完成一次判定后，这里会显示证据与结论；历史记录只保存在内存中，重启后清空。"
          icon="cache"
        >
          <button type="button" class="btn btn-sm btn-primary" :disabled="loading" @click="refresh(false)">重新读取</button>
        </EmptyState>
      </div>

      <div v-for="item in decisions" v-else :key="item.id" class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">
              {{ modeMeta(item).label }}
              <span class="muted">·</span>
              <span class="mono">{{ reasonText(item) }}</span>
            </div>
            <div class="panel-sub">
              {{ formatDateTime(item.at) }} · {{ relativeTime(item.at) }} · {{ item.context?.scene ?? "频道" }} {{ item.channelId }} ·
              {{ formatNumber(item.pendingCount) }} 条合批 · {{ item.durationMs }} 毫秒
            </div>
          </div>
          <div class="panel-actions">
            <span class="badge" :class="modeMeta(item).tone">{{ modeMeta(item).label }}</span>
            <span class="badge badge-outline mono">概率 {{ item.probability.toFixed(2) }}</span>
            <span class="badge badge-outline mono">门槛 {{ item.threshold.toFixed(2) }}</span>
          </div>
        </div>

        <div class="panel-body">
          <div v-if="item.error !== undefined" class="error-panel" style="margin-bottom: 12px">
            <Icon name="alert" :size="15" />
            <div class="flex-1 mono">{{ item.error }}</div>
          </div>

          <div v-if="item.steps !== undefined && item.steps.length > 0" class="jev-flow">
            <template v-for="(step, index) in item.steps" :key="index">
              <span class="jev-flow-node" :class="step.stop ? 'is-stop' : step.ok ? 'is-pass' : 'is-neutral'" :title="formatStep(step)">{{
                stepLabel(step.key)
              }}</span>
              <Icon v-if="index < item.steps.length - 1" class="jev-flow-arrow" name="chevron" :size="12" />
            </template>
          </div>
          <div v-else-if="item.prefiltered" class="jev-flow">
            <span class="jev-flow-node is-stop">{{ reasonText(item) }}</span>
          </div>

          <template v-if="item.messages !== undefined && item.messages.length > 0">
            <div class="jev-section-title">待判消息</div>
            <div class="jev-messages">
              <div v-for="(message, index) in item.messages" :key="index" class="jev-message">
                <span class="jev-message-author">{{ message.author }}</span>
                <span class="jev-message-text">{{ message.text }}</span>
              </div>
            </div>
          </template>

          <div v-if="item.focused.length > 0" class="jev-focus">
            <span class="jev-focus-label">焦点消息</span>
            <span>{{ item.focused }}</span>
          </div>

          <template v-if="item.evidence !== undefined">
            <div class="jev-section-title">消息关系分布</div>
            <div class="jev-rows">
              <div v-for="row in relationRows(item)" :key="row.key" class="jev-row">
                <span class="jev-row-label">{{ row.label }}</span>
                <span class="jev-track"><span class="jev-fill jev-fill-relation" :style="{ width: width(row.value) }" /></span>
                <span class="jev-row-value mono">{{ percent(row.value) }}</span>
              </div>
            </div>

            <div class="jev-section-title">独立语义证据</div>
            <div class="jev-chips">
              <span v-for="row in booleanRows(item)" :key="row.key" class="jev-chip" :class="{ 'is-on': row.value > 0.5 }" :title="row.hint">
                {{ row.label }} <span class="mono">{{ percent(row.value) }}</span>
              </span>
            </div>
          </template>

          <details class="jev-details">
            <summary>展开：模型上下文、判定链与本次配置</summary>

            <template v-if="item.context !== undefined">
              <div class="jev-section-title">
                模型上下文 · {{ item.context.scene }}
                <span v-if="item.context.secondsSinceBotLastSpoke !== undefined">
                  · 距机器人上次发言 {{ Math.round(item.context.secondsSinceBotLastSpoke) }} 秒</span
                >
              </div>
              <div class="jev-context">
                <div v-for="(line, index) in item.context.recent" :key="index" class="jev-context-line">
                  <span class="jev-context-time mono">{{ line.secondsAgo }} 秒前</span>
                  <span class="jev-context-author">{{ line.author }}</span>
                  <span v-if="line.isBot" class="jev-context-tag">机器人</span>
                  <span v-if="line.mentionsBot" class="jev-context-tag">@</span>
                  <span class="jev-context-text">{{ line.text }}</span>
                </div>
                <div v-if="item.context.recent.length === 0" class="jev-context-line">
                  <span class="jev-context-text">这次没有可用的历史上下文。</span>
                </div>
              </div>
              <template v-if="item.context.focusAuthor.length > 0">
                <div class="jev-section-title">焦点作者此前发言</div>
                <div class="jev-context">
                  <div v-for="(line, index) in item.context.focusAuthor" :key="index" class="jev-context-line">
                    <span class="jev-context-text">{{ line }}</span>
                  </div>
                </div>
              </template>
            </template>

            <template v-if="item.steps !== undefined && item.steps.length > 0">
              <div class="jev-section-title">判定链</div>
              <div class="jev-steps">
                <div v-for="(step, index) in item.steps" :key="index" class="jev-step" :class="{ 'is-stop': !step.ok }">
                  <span class="jev-step-mark">{{ step.ok ? "✓" : "×" }}</span>
                  <span class="jev-step-label">{{ stepLabel(step.key) }}</span>
                  <span v-if="step.value !== undefined" class="jev-step-value mono">{{ formatStep(step) }}</span>
                </div>
              </div>
            </template>

            <template v-if="item.config !== undefined">
              <div class="jev-section-title">本次配置</div>
              <div class="jev-chips">
                <span v-for="row in configRows(item)" :key="row.label" class="jev-chip"
                  >{{ row.label }} <span class="mono">{{ row.value }}</span></span
                >
              </div>
            </template>
          </details>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<style scoped>
.jev-flow {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
  padding: 11px 12px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
}

.jev-flow-node {
  padding: 2px 7px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
}

.jev-flow-node.is-pass {
  border-color: color-mix(in srgb, var(--success) 42%, var(--line));
  background: var(--success-soft);
  color: var(--success-ink);
}

.jev-flow-node.is-stop {
  border-color: color-mix(in srgb, var(--warning) 42%, var(--line));
  background: var(--warning-soft);
  color: var(--warning-ink);
}

.jev-flow-node.is-neutral {
  color: var(--muted);
}

.jev-flow-arrow {
  display: inline-flex;
  flex: none;
  color: var(--faint);
}

.jev-details {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.jev-details > summary {
  cursor: pointer;
  color: var(--accent-ink);
  font-size: 12px;
  font-weight: 500;
  line-height: 2;
}

.jev-context {
  display: grid;
  gap: 4px;
  margin-bottom: 12px;
}

.jev-context-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.jev-context-time {
  flex: none;
  width: 54px;
  color: var(--faint);
  text-align: right;
}

.jev-context-author {
  flex: none;
  max-width: 110px;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jev-context-tag {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface-raised);
  color: var(--muted);
  font-size: 11px;
}

.jev-context-text {
  flex: 1;
  color: var(--ink-soft);
}

.jev-messages {
  display: grid;
  gap: 4px;
  margin-bottom: 12px;
}

.jev-message {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.jev-message-author {
  flex: none;
  max-width: 120px;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jev-message-text {
  flex: 1;
  color: var(--ink);
}

.jev-steps {
  display: grid;
  gap: 5px;
  margin-bottom: 14px;
  font-size: 12px;
}

.jev-step {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  gap: 8px;
  align-items: baseline;
  color: var(--ink-soft);
}

.jev-step-mark {
  color: var(--success);
  text-align: center;
}

.jev-step-value {
  color: var(--muted);
}

.jev-step.is-stop {
  color: var(--warning-ink);
}

.jev-step.is-stop .jev-step-mark {
  color: var(--warning);
}

.jev-focus {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-left: 2px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--accent-soft);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.jev-focus-label {
  flex: none;
  color: var(--accent-ink);
  font-size: 12px;
}

.jev-section-title {
  margin: 4px 0 8px;
  color: var(--ink-soft);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0;
}

.jev-rows {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;
}

.jev-row {
  display: grid;
  grid-template-columns: 92px 1fr 48px;
  gap: 10px;
  align-items: center;
  font-size: 12px;
}

.jev-row-label {
  color: var(--ink-soft);
}

.jev-track {
  display: block;
  height: 5px;
  border-radius: 2px;
  background: var(--surface-head);
  overflow: hidden;
}

.jev-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}

.jev-fill-relation {
  background: var(--accent);
}

.jev-row-value {
  text-align: right;
  color: var(--muted);
}

.jev-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.jev-chip {
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface-raised);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.jev-chip.is-on {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-ink);
}
</style>
