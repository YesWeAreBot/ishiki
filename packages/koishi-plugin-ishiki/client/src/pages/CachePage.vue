<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import type { ResourceCacheRow } from "../data/types";
import { formatBytes, formatCompact, formatNumber, formatPercent } from "../lib/format";
import { store } from "../store";

const loading = ref(true);

onMounted(() => {
  window.setTimeout(() => {
    loading.value = false;
  }, 420);
});

const promptRows = computed(() => store.cache.prompt);
const totalPromptInput = computed(() => promptRows.value.reduce((sum, row) => sum + row.input, 0));
const totalPromptRead = computed(() => promptRows.value.reduce((sum, row) => sum + row.cacheRead, 0));
const totalPromptWrite = computed(() => promptRows.value.reduce((sum, row) => sum + row.cacheWrite, 0));
const cacheRate = computed(() => (totalPromptInput.value === 0 ? null : totalPromptRead.value / totalPromptInput.value));

const resources = computed(() => store.cache.resources);
const diskAssets = computed(() => resources.value.reduce((sum, row) => sum + (row.assets ?? 0), 0));
const diskAssetBytes = computed(() => resources.value.reduce((sum, row) => sum + (row.assetBytes ?? 0), 0));
const diskArtifacts = computed(() => resources.value.reduce((sum, row) => sum + (row.artifacts ?? 0), 0));
const diskArtifactBytes = computed(() => resources.value.reduce((sum, row) => sum + (row.artifactBytes ?? 0), 0));
const lazyAssets = computed(() => resources.value.reduce((sum, row) => sum + (row.lazyAssets ?? 0), 0));
const memoryRate = computed(() => (store.cache.memoryUsedBytes === null ? null : store.cache.memoryUsedBytes / store.cache.memoryLimitBytes));

function resourceState(row: ResourceCacheRow): { label: string; tone: string } {
  if (row.status === "ok") return { label: "已采集", tone: "badge-success" };
  if (row.status === "empty") return { label: "已采集 · 为零", tone: "badge-neutral" };
  if (row.status === "unavailable") return { label: "尚未采集", tone: "badge-warning" };
  return { label: "读取失败", tone: "badge-danger" };
}

function promptState(row: { status: string }): { label: string; tone: string } {
  if (row.status === "ok") return { label: "已提供", tone: "badge-success" };
  if (row.status === "empty") return { label: "无记录", tone: "badge-neutral" };
  return { label: "provider 未提供", tone: "badge-warning" };
}
</script>

<template>
  <PageHeader title="缓存" desc="查看模型提示缓存的读写令牌与运行时资源缓存。当前版本只读，不提供清理或失效操作。" eyebrow="观测 / 缓存">
    <template #actions>
      <span class="badge badge-outline">只读</span>
    </template>
  </PageHeader>

  <div class="notice notice-info" style="margin-bottom: 16px">
    <Icon name="info" :size="15" />
    <span>
      提示缓存来自 assistant usage 的 cacheReadTokens / cacheWriteTokens；资源缓存来自 runtime 的 resources 目录。进程内 LRU
      占用当前没有查询接口，页面中的占用值为示例，完整实现需要新增缓存统计接口。
    </span>
  </div>

  <div v-if="loading" class="metric-grid" style="margin-bottom: 16px">
    <div v-for="index in 4" :key="index" class="metric">
      <div class="skeleton skeleton-line" style="width: 42%"></div>
      <div class="skeleton" style="height: 26px; width: 58%; margin-top: 8px"></div>
    </div>
  </div>
  <div v-else class="metric-grid" style="margin-bottom: 16px">
    <div class="metric">
      <div class="metric-label">提示缓存读取</div>
      <div class="metric-value">{{ formatCompact(totalPromptRead) }}</div>
      <div class="metric-note">占输入 {{ cacheRate === null ? "—" : formatPercent(cacheRate) }}</div>
    </div>
    <div class="metric">
      <div class="metric-label">提示缓存写入</div>
      <div class="metric-value">{{ formatCompact(totalPromptWrite) }}</div>
      <div class="metric-note">provider 未提供的记录不计入</div>
    </div>
    <div class="metric">
      <div class="metric-label">资源缓存上限</div>
      <div class="metric-value">{{ formatBytes(store.cache.memoryLimitBytes) }}</div>
      <div class="metric-note">ResourceStore 进程内 LRU 常量</div>
    </div>
    <div class="metric">
      <div class="metric-label">当前占用 <span class="badge badge-warning">示例</span></div>
      <div class="metric-value">{{ store.cache.memoryUsedBytes === null ? "未采集" : formatBytes(store.cache.memoryUsedBytes) }}</div>
      <div class="metric-note">{{ memoryRate === null ? "需要新增缓存统计接口" : `约 ${formatPercent(memoryRate)} · 示例值` }}</div>
    </div>
  </div>

  <div class="stack">
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">模型提示缓存</div>
          <div class="panel-sub">按模型引用汇总全部已记录调用；命中率 = 缓存读取 / 输入 tokens。</div>
        </div>
        <div class="panel-actions">
          <span class="badge badge-outline">{{ promptRows.length }} 个模型</span>
        </div>
      </div>
      <div v-if="promptRows.length === 0" class="empty">
        <div class="empty-title">没有提示缓存记录</div>
        <p class="empty-desc">assistant 消息的 usage 中没有 cacheReadTokens 或 cacheWriteTokens。</p>
      </div>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col" class="num">调用</th>
              <th scope="col" class="num">输入</th>
              <th scope="col" class="num">缓存读取</th>
              <th scope="col" class="num">缓存写入</th>
              <th scope="col" class="num">命中率</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in promptRows" :key="row.reference">
              <td class="mono">{{ row.reference }}</td>
              <td class="num">{{ formatNumber(row.calls) }}</td>
              <td class="num">{{ formatNumber(row.input) }}</td>
              <td class="num">{{ formatNumber(row.cacheRead) }}</td>
              <td class="num">{{ formatNumber(row.cacheWrite) }}</td>
              <td class="num">{{ row.input === 0 ? "—" : formatPercent(row.cacheRead / row.input) }}</td>
              <td>
                <span class="badge" :class="promptState(row).tone">{{ promptState(row).label }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">资源缓存</div>
          <div class="panel-sub">assets 与 artifacts 按 runtime 统计；lazy assets 表示尚未拉取字节的条目。</div>
        </div>
        <div class="panel-actions">
          <span class="badge badge-outline">{{ diskAssets }} assets · {{ formatBytes(diskAssetBytes) }}</span>
          <span class="badge badge-outline">{{ diskArtifacts }} artifacts · {{ formatBytes(diskArtifactBytes) }}</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Runtime</th>
              <th scope="col" class="num">Assets</th>
              <th scope="col" class="num">Asset 字节</th>
              <th scope="col" class="num">Artifacts</th>
              <th scope="col" class="num">Artifact 字节</th>
              <th scope="col" class="num">待拉取</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in resources" :key="row.runtimeId">
              <td>
                <div class="mono">{{ row.runtimeId }}</div>
                <div class="muted small">{{ row.profileId }}</div>
              </td>
              <td class="num">{{ row.assets === null ? "—" : formatNumber(row.assets) }}</td>
              <td class="num">{{ row.assetBytes === null ? "—" : formatBytes(row.assetBytes) }}</td>
              <td class="num">{{ row.artifacts === null ? "—" : formatNumber(row.artifacts) }}</td>
              <td class="num">{{ row.artifactBytes === null ? "—" : formatBytes(row.artifactBytes) }}</td>
              <td class="num">{{ row.lazyAssets === null ? "—" : formatNumber(row.lazyAssets) }}</td>
              <td>
                <span class="badge" :class="resourceState(row).tone">{{ resourceState(row).label }}</span>
                <div v-if="row.error" class="field-error" style="margin-top: 3px">{{ row.error }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="panel-body" style="border-top: 1px solid var(--line)">
        <div class="row row-wrap field-hint">
          <span><strong>0</strong>：目录已读取且没有条目。</span>
          <span><strong>— / 尚未采集</strong>：当前版本没有该统计来源。</span>
          <span><strong>读取失败</strong>：目录不可读或日志损坏，错误会就近显示。</span>
          <span class="spacer"></span>
          <span>待拉取 {{ formatNumber(lazyAssets) }} 个</span>
        </div>
      </div>
    </div>
  </div>
</template>
