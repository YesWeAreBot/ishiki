<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { formatCompact, formatNumber } from "../lib/format";
import { aggregateUsage, navigate, store } from "../store";

const range = ref<"24h" | "7d" | "all">("7d");
const loading = ref(true);

onMounted(() => {
  window.setTimeout(() => {
    loading.value = false;
  }, 400);
});

const rangeStart = computed(() => {
  if (range.value === "24h") return store.now - 24 * 60 * 60 * 1000;
  if (range.value === "7d") return store.now - 7 * 24 * 60 * 60 * 1000;
  return 0;
});

const filtered = computed(() => store.usageRecords.filter((record) => record.timestamp >= rangeStart.value));
const totals = computed(() => aggregateUsage(filtered.value));

const byModel = computed(() => {
  const map = new Map<string, { reference: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; missing: number }>();
  for (const record of filtered.value) {
    const row = map.get(record.reference) ?? { reference: record.reference, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missing: 0 };
    if (record.source === "missing") row.missing += 1;
    else {
      row.calls += 1;
      row.input += record.input;
      row.output += record.output;
      row.cacheRead += record.cacheRead;
      row.cacheWrite += record.cacheWrite;
    }
    map.set(record.reference, row);
  }
  return [...map.values()].sort((left, right) => right.input - left.input);
});

const empty = computed(() => !loading.value && byModel.value.length === 0);
</script>

<template>
  <PageHeader
    title="成本"
    desc="当前 models.yaml 没有价格字段，provider usage 也不包含标准化费用。这里只展示可用的 token 基础，费用明确标为未采集，不把推算值伪装成记录值。"
    eyebrow="观测 / 成本"
  >
    <template #actions>
      <button type="button" class="btn" @click="navigate('/usage')"><Icon name="usage" :size="15" /> 查看用量</button>
    </template>
  </PageHeader>

  <div class="notice notice-warning" style="margin-bottom: 16px">
    <Icon name="warningCircle" :size="15" />
    <span>
      费用不可计算：<span class="mono">providers.models[]</span> 没有单价字段，AI SDK 的 usage 只有 token
      数，没有统一费用字段。完整实现需要先确认价格配置与币种，并明确估算口径。
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
        <span class="spacer"></span>
        <span class="field-hint">金额状态：未采集 · 币种：未配置</span>
      </div>
    </div>
  </div>

  <div v-if="loading" class="metric-grid" style="margin-bottom: 16px">
    <div v-for="index in 4" :key="index" class="metric">
      <div class="skeleton skeleton-line" style="width: 40%"></div>
      <div class="skeleton" style="height: 26px; width: 58%; margin-top: 8px"></div>
    </div>
  </div>
  <div v-else class="metric-grid" style="margin-bottom: 16px">
    <div class="metric">
      <div class="metric-label">估算费用</div>
      <div class="metric-value" style="font-size: 18px">未采集</div>
      <div class="metric-note">缺少单价与币种，不能计算</div>
    </div>
    <div class="metric">
      <div class="metric-label">已记录费用</div>
      <div class="metric-value" style="font-size: 18px">无来源</div>
      <div class="metric-note">provider 响应没有统一费用字段</div>
    </div>
    <div class="metric">
      <div class="metric-label">计费 token 基础</div>
      <div class="metric-value">{{ empty ? "无记录" : formatCompact(totals.total) }}</div>
      <div class="metric-note">{{ empty ? "当前时间范围没有调用" : `输入 ${formatCompact(totals.input)} · 输出 ${formatCompact(totals.output)}` }}</div>
    </div>
    <div class="metric">
      <div class="metric-label">缓存 tokens</div>
      <div class="metric-value">{{ empty ? "无记录" : formatCompact(totals.cacheRead + totals.cacheWrite) }}</div>
      <div class="metric-note">{{ empty ? "当前时间范围没有调用" : `读取 ${formatCompact(totals.cacheRead)} · 写入 ${formatCompact(totals.cacheWrite)}` }}</div>
    </div>
  </div>

  <div v-if="empty" class="panel">
    <EmptyState title="当前时间范围没有 token 记录" desc="没有可用来估算费用的调用。即使有 token，也不会在缺少单价时显示金额。" icon="cost">
      <button type="button" class="btn btn-soft" @click="range = 'all'">查看全部时间</button>
    </EmptyState>
  </div>

  <div v-else class="stack">
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">按模型</div>
          <div class="panel-sub">费用列保持「未配置」，不使用 0 或猜测单价填充。</div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col" class="num">调用</th>
              <th scope="col" class="num">输入</th>
              <th scope="col" class="num">输出</th>
              <th scope="col" class="num">缓存读取</th>
              <th scope="col" class="num">缓存写入</th>
              <th scope="col">币种</th>
              <th scope="col">单价</th>
              <th scope="col">费用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in byModel" :key="row.reference">
              <td>
                <div class="mono">{{ row.reference }}</div>
                <div v-if="row.missing > 0" class="small" style="color: var(--warning-ink)">另有 {{ row.missing }} 条缺失 usage</div>
              </td>
              <td class="num">{{ formatNumber(row.calls) }}</td>
              <td class="num">{{ formatNumber(row.input) }}</td>
              <td class="num">{{ formatNumber(row.output) }}</td>
              <td class="num">{{ formatNumber(row.cacheRead) }}</td>
              <td class="num">{{ formatNumber(row.cacheWrite) }}</td>
              <td class="muted">未配置</td>
              <td class="muted">未配置</td>
              <td><span class="badge badge-warning">未采集</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="form-grid">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">计算口径</div></div>
        <div class="panel-body">
          <dl class="kv">
            <dt>币种</dt>
            <dd>未配置。必须由价格表显式声明，不从 provider 猜测。</dd>
            <dt>计费单位</dt>
            <dd>输入 / 输出 / 缓存读取 / 缓存写入 tokens，按百万 token 或单 token 定价。</dd>
            <dt>数值性质</dt>
            <dd>若未来按 token 与价格表计算，属于<strong>估算</strong>；只有在接入 provider 账单或对账记录后，才标记为<strong>已记录费用</strong>。</dd>
            <dt>缺失数据</dt>
            <dd>没有 usage 的调用不按 0 计入；会单独显示缺失条数。</dd>
            <dt>零值</dt>
            <dd>已采集且实际为 0 的 token 显示 0；与「未采集」分开。</dd>
          </dl>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">需要确认的价格配置</div>
          <div class="panel-actions"><span class="badge badge-outline">提案，未实现</span></div>
        </div>
        <div class="panel-body">
          <ul class="quality-note" style="margin: 0; padding-left: 16px">
            <li><span class="mono">currency</span>：结算币种，例如 CNY 或 USD。</li>
            <li><span class="mono">inputPerMillion</span> / <span class="mono">outputPerMillion</span>：每百万 token 单价。</li>
            <li><span class="mono">cacheReadPerMillion</span> / <span class="mono">cacheWritePerMillion</span>：缓存读写单价。</li>
            <li><span class="mono">effectiveFrom</span>：价格生效时间，避免历史调用按新价格重算。</li>
            <li>计价作用域：provider、model 或 profile；是否含税、是否有最低消费。</li>
          </ul>
          <div class="notice" style="margin-top: 12px">
            <Icon name="info" :size="14" />
            <span>这些字段尚未写入 <span class="mono">models.yaml</span>，也没有被 gateway 读取。页面只展示 token 基础，不生成金额。</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
