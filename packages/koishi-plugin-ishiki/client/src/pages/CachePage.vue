<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { ApiError, call } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ExpandableText from "../components/ExpandableText.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import { classifyReference, entityBadge } from "../lib/entities";
import { formatBytes, formatDateTime, formatNumber, relativeTime } from "../lib/format";
import { store, toast } from "../store";
import type { CacheSnapshot, ResourceCacheRow } from "../types";

const snapshot = ref<CacheSnapshot | undefined>(store.cache);
const attempted = ref(false);
const loading = ref(false);
const errorText = ref("");

watch(
  () => store.cache,
  (value) => {
    if (value !== undefined) snapshot.value = value;
  },
);

const promptRows = computed(() => snapshot.value?.prompt ?? []);
const resourceRows = computed(() => snapshot.value?.resources ?? []);
const status = computed(() => snapshot.value?.status);
const reason = computed(() => snapshot.value?.reason);
const collectedAt = computed(() => snapshot.value?.collectedAt);
const bootstrapped = computed(() => store.cache !== undefined || attempted.value);

const statusMeta = computed(() => {
  if (status.value === "ok") return { tone: "badge-success", label: "可用" };
  if (status.value === "empty") return { tone: "badge-warning", label: "尚未采集" };
  if (status.value === "unavailable") return { tone: "badge-danger", label: "读取失败" };
  return { tone: "badge-neutral", label: "未知" };
});

const promptEmptyTitle = computed(() => (status.value === "empty" ? "尚未采集" : "没有 prompt 缓存数据"));
const resourceEmptyTitle = computed(() => (status.value === "empty" ? "尚未采集" : "没有资源缓存数据"));

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function resourceStatus(row: ResourceCacheRow): { tone: string; label: string } {
  if (row.status === "ok") return { tone: "badge-success", label: "可用" };
  if (row.status === "empty") return { tone: "badge-neutral", label: "无资源" };
  return { tone: "badge-danger", label: "读取失败" };
}

/** prompt 缓存行的引用与用量页同一套实体分类，模型组不会混进模型。 */
function referenceBadge(reference: string): { tone: string; label: string } {
  return entityBadge(classifyReference(reference, store.providers, store.groups));
}

async function refresh(silent = false): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await call<CacheSnapshot>("ishiki/observability/cache");
    snapshot.value = result;
    errorText.value = "";
    if (!silent) {
      toast("success", "缓存快照已更新", `${formatNumber(result.prompt.length)} 行 prompt，${formatNumber(result.resources.length)} 行资源。`);
    }
  } catch (error) {
    errorText.value = describe(error);
    toast("error", "缓存读取失败", errorText.value);
  } finally {
    loading.value = false;
    attempted.value = true;
  }
}

onMounted(() => {
  if (store.cache === undefined) void refresh(true);
});
</script>

<template>
  <PageShell>
    <PageHeader
      title="缓存观测"
      desc="缓存快照汇总会话中的 prompt 缓存与运行时资源目录。服务端没有采集或读取失败的字段会直接标记，页面不会补 0 或估算。"
      eyebrow="观测 / 缓存"
    >
      <template #actions>
        <span v-if="snapshot !== undefined" class="badge" :class="statusMeta.tone">{{ statusMeta.label }}</span>
        <span v-if="snapshot !== undefined" class="badge badge-outline">采集于 {{ formatDateTime(collectedAt) }}</span>
        <button type="button" class="btn btn-sm" :disabled="loading" @click="refresh(false)">
          <span v-if="loading" class="spinner" aria-hidden="true"></span>
          <Icon v-else name="refresh" :size="14" />
          刷新
        </button>
      </template>
    </PageHeader>

    <div class="stack">
      <div v-if="errorText.length > 0" class="error-panel">
        <Icon name="alert" :size="15" />
        <div class="flex-1">
          <div class="strong">缓存读取失败</div>
          <div class="mono">{{ errorText }}</div>
        </div>
        <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="refresh(false)">重试</button>
      </div>

      <div v-if="!bootstrapped" class="panel">
        <div class="loading-list">
          <div v-for="index in 4" :key="index" class="skeleton skeleton-line" style="width: 100%"></div>
          <div class="skeleton skeleton-line" style="width: 62%"></div>
        </div>
      </div>

      <div v-else-if="snapshot === undefined" class="panel">
        <EmptyState title="缓存数据尚不可用" desc="服务端还没有返回缓存快照。确认控制台连接正常后重试，页面不会用示例数值填充。" icon="cache">
          <button type="button" class="btn btn-sm btn-primary" :disabled="loading" @click="refresh(false)">重新读取</button>
        </EmptyState>
      </div>

      <template v-else>
        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">快照状态</div>
              <div class="panel-sub">状态与原因由服务端给出，采集时间与计数直接取自快照。</div>
            </div>
            <div class="panel-actions">
              <span class="badge" :class="statusMeta.tone">{{ statusMeta.label }}</span>
              <span class="badge badge-outline mono">{{ status }}</span>
            </div>
          </div>
          <div class="panel-body">
            <dl class="kv">
              <dt>采集时间</dt>
              <dd>
                <span>{{ formatDateTime(collectedAt) }}</span>
                <span class="muted small" style="margin-left: 8px">{{ relativeTime(collectedAt) }}</span>
              </dd>
              <dt>Prompt 数据</dt>
              <dd>{{ formatNumber(promptRows.length) }} 行</dd>
              <dt>资源数据</dt>
              <dd>{{ formatNumber(resourceRows.length) }} 行</dd>
              <dt>原因</dt>
              <dd>
                <span v-if="reason !== undefined" class="wrap">{{ reason }}</span>
                <span v-else class="muted">服务端没有附加原因。</span>
              </dd>
            </dl>
          </div>
        </div>

        <div v-if="status === 'unavailable'" class="panel">
          <EmptyState title="读取失败" :desc="reason ?? '服务端没有返回可读取的缓存数据。'" icon="cache">
            <button type="button" class="btn btn-sm btn-primary" :disabled="loading" @click="refresh(false)">重新读取</button>
          </EmptyState>
        </div>

        <template v-else>
          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">Prompt 缓存</div>
                <div class="panel-sub">按模型引用汇总的调用次数、缓存读取与写入。未上报的响应不提供缓存字段。</div>
              </div>
              <div class="panel-actions">
                <span class="badge badge-outline">{{ promptRows.length }} 行</span>
              </div>
            </div>
            <div v-if="promptRows.length === 0" class="empty" style="padding: 28px 24px">
              <div class="empty-title">{{ promptEmptyTitle }}</div>
              <p class="empty-desc">这里只展示服务端实际采集到的缓存行，不会用 0 值代替缺失数据。</p>
            </div>
            <div v-else class="table-wrap">
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>引用</th>
                    <th>模型</th>
                    <th class="num">调用</th>
                    <th class="num">缓存读取</th>
                    <th class="num">缓存写入</th>
                    <th>是否上报</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in promptRows" :key="`${row.reference}:${row.modelId}`">
                    <td>
                      <span class="badge" :class="referenceBadge(row.reference).tone">{{ referenceBadge(row.reference).label }}</span>
                    </td>
                    <td>
                      <ExpandableText :value="row.reference" mode="ends" mono copy-label="对象引用" />
                    </td>
                    <td>
                      <ExpandableText :value="row.modelId" mode="ends" mono :copyable="row.modelId !== 'unknown'" copy-label="模型标识" />
                    </td>
                    <td class="num">{{ formatNumber(row.calls) }}</td>
                    <td class="num">{{ formatNumber(row.cacheRead) }}</td>
                    <td class="num">{{ formatNumber(row.cacheWrite) }}</td>
                    <td>
                      <span class="badge" :class="row.cacheReported ? 'badge-success' : 'badge-warning'">
                        {{ row.cacheReported ? "已上报" : "未上报" }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="panel-body" style="padding-top: 0">
              <div class="notice">
                <Icon name="info" :size="14" />
                <span>未上报的响应不会携带缓存字段，读取与写入按服务端记录的原值展示，无法据此判断缓存是否命中。</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">运行时资源</div>
                <div class="panel-sub">每个运行实例的资源目录统计，状态与错误直接取自采集结果。</div>
              </div>
              <div class="panel-actions">
                <span class="badge badge-outline">{{ resourceRows.length }} 行</span>
              </div>
            </div>
            <div v-if="resourceRows.length === 0" class="empty" style="padding: 28px 24px">
              <div class="empty-title">{{ resourceEmptyTitle }}</div>
              <p class="empty-desc">服务端还没有可统计的资源目录，页面不会用示例资产数填充。</p>
            </div>
            <div v-else class="table-wrap">
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th>运行实例</th>
                    <th>Profile</th>
                    <th>状态</th>
                    <th class="num">资产数</th>
                    <th class="num">工件数</th>
                    <th class="num">字节</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in resourceRows" :key="row.runtimeId">
                    <td class="mono wrap">{{ row.runtimeId }}</td>
                    <td class="mono">{{ row.profileId }}</td>
                    <td>
                      <span class="badge" :class="resourceStatus(row).tone">{{ resourceStatus(row).label }}</span>
                      <div v-if="row.error !== undefined" class="row-error mono">{{ row.error }}</div>
                    </td>
                    <td class="num">{{ formatNumber(row.assets) }}</td>
                    <td class="num">{{ formatNumber(row.artifacts) }}</td>
                    <td class="num">
                      <span>{{ formatBytes(row.bytes) }}</span>
                      <div class="faint small">{{ formatNumber(row.bytes) }} B</div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="status === 'empty'" class="notice notice-warning">
            <Icon name="warningCircle" :size="15" />
            <span>
              <strong>尚未采集</strong> 服务端已建立缓存观测，但还没有采集到 prompt 或资源数据。缺失状态会单独标记，页面不会把缺失数据当作空缓存展示。
            </span>
          </div>
        </template>
      </template>
    </div>
  </PageShell>
</template>

<style scoped>
.wrap {
  overflow-wrap: anywhere;
}

.row-error {
  margin-top: 4px;
  max-width: 220px;
  color: var(--danger);
  font-size: 10.5px;
  overflow-wrap: anywhere;
}
</style>
