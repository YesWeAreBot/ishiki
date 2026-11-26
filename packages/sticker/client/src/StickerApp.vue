<script setup lang="ts">
import { store, useColorMode } from "@koishijs/client";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { callApi, onApiEvent } from "./api";
import StickerEditModal from "./StickerEditModal.vue";
import StickerImportModal, { type PendingUploadFile } from "./StickerImportModal.vue";
import type {
  BlacklistRecord,
  CategoryCount,
  PackSummary,
  ReviewQueueSnapshot,
  StickerListResult,
  StickerOverview,
  StickerRecord,
  StickerSort,
  StickerStatus,
  StickerUpdatePatch,
} from "./types";

defineOptions({ name: "StickerApp" });

const mode = useColorMode();
const isDark = computed(() => mode.value === "dark");
const authUser = computed(() => (store as unknown as { user?: { id?: unknown; authority?: number } | null }).user);

const loading = ref(false);
const busy = ref(false);
const notice = ref<{ tone: "info" | "success" | "error"; text: string } | null>(null);

const overview = ref<StickerOverview | null>(null);
const items = ref<StickerRecord[]>([]);
const total = ref(0);
const packs = ref<PackSummary[]>([]);
const categories = ref<CategoryCount[]>([]);
const blacklist = ref<BlacklistRecord[]>([]);
const queue = ref<ReviewQueueSnapshot>({ pending: 0, running: 0, completed: 0, failed: 0 });
const fallbackPreviews = reactive<Record<string, string>>({});

const filters = reactive({
  pack: "all",
  view: "active" as StickerStatus | "blacklist",
  category: "all",
  query: "",
  sort: "newest" as StickerSort,
  page: 1,
  pageSize: 48,
});

const selectedIds = ref<string[]>([]);
const batchValue = ref("");
const editing = ref<StickerRecord | null>(null);
const importModal = ref<"upload" | "import" | null>(null);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / filters.pageSize)));
const selectedSet = computed(() => new Set(selectedIds.value));

function setNotice(tone: "info" | "success" | "error", text: string): void {
  notice.value = { tone, text };
}

function previewUrlFor(item: StickerRecord): string {
  const base = overview.value?.mediaBasePath;
  if (base) return `${base}/${item.sha256}`;
  return fallbackPreviews[item.sha256] ?? "";
}

async function ensureFallbackPreviews(list: StickerRecord[]): Promise<void> {
  if (overview.value?.mediaBasePath) return;
  for (const item of list) {
    if (fallbackPreviews[item.sha256]) continue;
    try {
      fallbackPreviews[item.sha256] = await callApi<string>("ishiki-sticker/data-url", item.sha256);
      const keys = Object.keys(fallbackPreviews);
      if (keys.length > 120) {
        for (const oldest of keys.slice(0, keys.length - 120)) {
          delete fallbackPreviews[oldest];
        }
      }
    } catch {
      // Ignore individual preview errors.
    }
  }
}

let refreshToken = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function clearRetryTimer(): void {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
}

async function refresh(attempt = 0): Promise<void> {
  clearRetryTimer();
  const token = ++refreshToken;
  loading.value = true;
  let scheduledRetry = false;
  try {
    const ov = await callApi<StickerOverview>("ishiki-sticker/overview");
    if (token !== refreshToken) return;
    overview.value = ov;
    queue.value = ov.queue;
    packs.value = ov.packs;

    if (filters.view === "blacklist") {
      const list = await callApi<BlacklistRecord[]>("ishiki-sticker/blacklist/list");
      if (token !== refreshToken) return;
      blacklist.value = list;
      items.value = [];
      total.value = list.length;
    } else {
      const res = await callApi<StickerListResult>("ishiki-sticker/list", {
        pack: filters.pack,
        status: filters.view,
        category: filters.category,
        query: filters.query,
        sort: filters.sort,
        page: filters.page,
        pageSize: filters.pageSize,
      });
      if (token !== refreshToken) return;
      items.value = res.items;
      total.value = res.total;
      packs.value = res.packs;
      categories.value = res.categories;
      await ensureFallbackPreviews(res.items);
    }
    if (notice.value?.tone === "error") {
      notice.value = null;
    }
  } catch (error) {
    if (token !== refreshToken) return;
    const message = error instanceof Error ? error.message : String(error);
    const isUnauth = /unauthorized/i.test(message);
    if (isUnauth && authUser.value === undefined && attempt < 8) {
      scheduledRetry = true;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void refresh(attempt + 1);
      }, 250);
      return;
    }
    if (isUnauth) {
      setNotice("error", "当前控制台未登录或权限不足，请先登录 Koishi 控制台后再查看图库");
    } else {
      setNotice("error", message);
    }
  } finally {
    if (token === refreshToken && !scheduledRetry) {
      loading.value = false;
    }
  }
}

function toggleSelect(id: string): void {
  if (selectedSet.value.has(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id);
  } else {
    selectedIds.value = [...selectedIds.value, id];
  }
}

function selectAllPage(): void {
  selectedIds.value = items.value.map((item) => item.id);
}

async function runBatch(action: "approve" | "delete" | "ban" | "movePack" | "setCategory", value?: string): Promise<void> {
  if (selectedIds.value.length === 0) return;
  busy.value = true;
  try {
    const res = await callApi<{ affected: number }>("ishiki-sticker/batch", { action, ids: selectedIds.value, value });
    selectedIds.value = [];
    batchValue.value = "";
    setNotice("success", `批量操作完成，共处理 ${res.affected} 项`);
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function batchRetag(): Promise<void> {
  if (selectedIds.value.length === 0) return;
  busy.value = true;
  try {
    const res = await callApi<{ queued: number }>("ishiki-sticker/retag", selectedIds.value);
    selectedIds.value = [];
    setNotice("success", `已将 ${res.queued} 张表情加入 VLM 重新识别队列`);
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function saveEdit(id: string, patch: StickerUpdatePatch): Promise<void> {
  busy.value = true;
  try {
    await callApi<StickerRecord>("ishiki-sticker/update", id, patch);
    editing.value = null;
    setNotice("success", `已保存表情 ${id} 的修改`);
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function retagSingle(id: string): Promise<void> {
  busy.value = true;
  try {
    const res = await callApi<{ queued: number }>("ishiki-sticker/retag", [id]);
    setNotice("info", res.queued > 0 ? `已将 ${id} 加入 VLM 重新识别队列` : "未配置可用视觉模型，无法加入识别队列");
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function banSingle(id: string): Promise<void> {
  busy.value = true;
  try {
    await callApi<{ affected: number }>("ishiki-sticker/batch", { action: "ban", ids: [id], value: "webui_ban" });
    if (editing.value?.id === id) editing.value = null;
    setNotice("success", `已删除并拉黑表情 ${id}`);
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function approveSingle(id: string): Promise<void> {
  busy.value = true;
  try {
    await callApi<{ affected: number }>("ishiki-sticker/batch", { action: "approve", ids: [id] });
    setNotice("success", `已通过表情 ${id}`);
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function handleUpload(payload: { pack: string; files: PendingUploadFile[]; autoTag: boolean; character: string; work: string }): Promise<void> {
  busy.value = true;
  try {
    const res = await callApi<{ created: number; duplicate: number; rejected: number; queued: number; errors: string[] }>("ishiki-sticker/upload", payload);
    importModal.value = null;
    const errText = res.errors.length > 0 ? `（部分失败：${res.errors.slice(0, 3).join("；")}）` : "";
    setNotice("success", `上传完成：新增 ${res.created}，重复 ${res.duplicate}，拒绝 ${res.rejected}，排队识别 ${res.queued}${errText}`);
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function handleImportDir(payload: { dirPath: string; pack: string; autoTag: boolean }): Promise<void> {
  busy.value = true;
  try {
    const res = await callApi<{ scanned: number; imported: number; duplicate: number; rejected: number; queuedForReview: number }>(
      "ishiki-sticker/import-dir",
      payload,
    );
    importModal.value = null;
    setNotice(
      "success",
      `目录导入完成：扫描 ${res.scanned}，新增 ${res.imported}，重复 ${res.duplicate}，拒绝 ${res.rejected}，排队识别 ${res.queuedForReview}`,
    );
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function cancelQueue(): Promise<void> {
  busy.value = true;
  try {
    const res = await callApi<{ cancelled: number }>("ishiki-sticker/queue/cancel");
    setNotice("info", `已清空 ${res.cancelled} 条待识别任务`);
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function unbanItem(sha256: string): Promise<void> {
  busy.value = true;
  try {
    await callApi<{ removed: boolean }>("ishiki-sticker/blacklist/remove", sha256);
    setNotice("success", "已从黑名单移除");
    await refresh();
  } catch (error) {
    setNotice("error", error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

let disposeChanged: (() => void) | undefined;
let disposeQueue: (() => void) | undefined;

onMounted(() => {
  void refresh();
  disposeChanged = onApiEvent("ishiki-sticker/changed", () => {
    void refresh();
  });
  disposeQueue = onApiEvent<ReviewQueueSnapshot>("ishiki-sticker/queue", (snapshot) => {
    queue.value = snapshot;
  });
});

onBeforeUnmount(() => {
  clearRetryTimer();
  disposeChanged?.();
  disposeQueue?.();
});

watch(
  () => [authUser.value?.id, authUser.value?.authority],
  ([id, authority]) => {
    if (id !== undefined || (authority ?? 0) >= 1) {
      void refresh();
    }
  },
);

watch(
  () => [filters.pack, filters.view, filters.category, filters.sort, filters.page],
  () => {
    selectedIds.value = [];
    void refresh();
  },
);
</script>

<template>
  <k-layout main="darker">
    <div class="ishiki-sticker-root" :class="{ 'is-dark': isDark }">
      <div class="st-header">
        <div class="st-title-wrap">
          <h1>Ishiki 表情图库</h1>
          <div v-if="overview" class="st-stats">
            <span>可用 {{ overview.totalActive }}</span>
            <span>·</span>
            <span>待审核 {{ overview.totalPending }}</span>
            <span>·</span>
            <span>黑名单 {{ overview.totalBanned }}</span>
            <span>·</span>
            <span>{{ overview.packs.length }} 个表情包</span>
          </div>
        </div>

        <div class="st-actions">
          <button class="st-btn" type="button" :disabled="loading" @click="refresh">刷新</button>
          <button class="st-btn" type="button" @click="importModal = 'import'">目录导入</button>
          <button class="st-btn st-btn-primary" type="button" @click="importModal = 'upload'">上传表情</button>
        </div>
      </div>

      <div v-if="notice" class="st-toast" :class="notice.tone" style="display: flex; justify-content: space-between; align-items: center">
        <span>{{ notice.text }}</span>
        <button class="st-btn st-btn-sm" type="button" @click="notice = null">关闭</button>
      </div>

      <div v-if="queue.pending > 0 || queue.running > 0" class="st-queue-bar">
        <div>
          <strong>VLM 识别队列</strong>：进行中 {{ queue.running }} · 排队 {{ queue.pending }} · 已完成 {{ queue.completed }}
          <span v-if="queue.failed > 0" style="color: var(--st-danger)"> · 失败 {{ queue.failed }}</span>
        </div>
        <button class="st-btn st-btn-sm st-btn-danger" type="button" :disabled="busy" @click="cancelQueue">停止排队</button>
      </div>

      <div class="st-toolbar">
        <div class="st-row">
          <div class="st-tabs">
            <button
              class="st-tab"
              :class="{ active: filters.view === 'active' }"
              type="button"
              @click="
                filters.view = 'active';
                filters.page = 1;
              "
            >
              已启用
            </button>
            <button
              class="st-tab"
              :class="{ active: filters.view === 'pending' }"
              type="button"
              @click="
                filters.view = 'pending';
                filters.page = 1;
              "
            >
              待审核 ({{ overview?.totalPending ?? 0 }})
            </button>
            <button
              class="st-tab"
              :class="{ active: filters.view === 'blacklist' }"
              type="button"
              @click="
                filters.view = 'blacklist';
                filters.page = 1;
              "
            >
              黑名单 ({{ overview?.totalBanned ?? 0 }})
            </button>
          </div>
        </div>

        <template v-if="filters.view !== 'blacklist'">
          <div class="st-row">
            <div class="st-tabs">
              <button
                class="st-tab"
                :class="{ active: filters.pack === 'all' }"
                type="button"
                @click="
                  filters.pack = 'all';
                  filters.page = 1;
                "
              >
                全部包
              </button>
              <button
                v-for="p in packs"
                :key="p.pack"
                class="st-tab"
                :class="{ active: filters.pack === p.pack }"
                type="button"
                @click="
                  filters.pack = p.pack;
                  filters.page = 1;
                "
              >
                {{ p.pack }} ({{ p.totalCount }})
              </button>
            </div>
          </div>

          <div class="st-row">
            <input
              v-model="filters.query"
              class="st-input st-search"
              placeholder="搜索角色、分类、标签、描述或图上文字..."
              @keydown.enter="
                filters.page = 1;
                refresh();
              "
            />
            <select v-model="filters.category" class="st-select" @change="filters.page = 1">
              <option value="all">全部分类</option>
              <option v-for="c in categories" :key="c.category" :value="c.category">{{ c.category }} ({{ c.count }})</option>
            </select>
            <select v-model="filters.sort" class="st-select" @change="filters.page = 1">
              <option value="newest">最新入库</option>
              <option value="most_used">最常发送</option>
              <option value="updated">最近更新</option>
            </select>
            <button
              class="st-btn"
              type="button"
              @click="
                filters.page = 1;
                refresh();
              "
            >
              搜索
            </button>
            <button v-if="items.length > 0" class="st-btn" type="button" @click="selectAllPage">全选本页</button>
          </div>
        </template>
      </div>

      <div v-if="selectedIds.length > 0 && filters.view !== 'blacklist'" class="st-batch-bar">
        <strong>已选 {{ selectedIds.length }} 项</strong>
        <button v-if="filters.view === 'pending'" class="st-btn st-btn-sm st-btn-primary" type="button" :disabled="busy" @click="runBatch('approve')">
          批量通过
        </button>
        <input v-model="batchValue" class="st-input" style="width: 140px" placeholder="目标包名或分类" />
        <button class="st-btn st-btn-sm" type="button" :disabled="busy || !batchValue.trim()" @click="runBatch('movePack', batchValue)">移动包</button>
        <button class="st-btn st-btn-sm" type="button" :disabled="busy || !batchValue.trim()" @click="runBatch('setCategory', batchValue)">改分类</button>
        <button class="st-btn st-btn-sm" type="button" :disabled="busy" @click="batchRetag">批量重识别</button>
        <button class="st-btn st-btn-sm st-btn-danger" type="button" :disabled="busy" @click="runBatch('delete')">批量删除</button>
        <button class="st-btn st-btn-sm st-btn-danger" type="button" :disabled="busy" @click="runBatch('ban', 'webui_batch_ban')">批量拉黑</button>
        <button class="st-btn st-btn-sm" type="button" @click="selectedIds = []">取消选择</button>
      </div>

      <template v-if="filters.view === 'blacklist'">
        <div v-if="blacklist.length === 0" class="st-empty">黑名单为空。</div>
        <table v-else class="st-ban-table">
          <thead>
            <tr>
              <th>SHA-256</th>
              <th>拉黑原因</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in blacklist" :key="entry.sha256">
              <td class="st-mono">{{ entry.sha256 }}</td>
              <td>{{ entry.reason }}</td>
              <td>
                <button class="st-btn st-btn-sm" type="button" :disabled="busy" @click="unbanItem(entry.sha256)">移出黑名单</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-else>
        <div v-if="items.length === 0 && !loading" class="st-empty">当前筛选条件下暂无表情包，可以点击右上角「上传表情」或「目录导入」快速建库。</div>

        <div v-else class="st-grid">
          <article v-for="item in items" :key="item.id" class="st-card" :class="{ selected: selectedSet.has(item.id) }">
            <div class="st-thumb-wrap" @click="editing = item">
              <input class="st-check" type="checkbox" :checked="selectedSet.has(item.id)" @click.stop @change="toggleSelect(item.id)" />
              <span class="st-badge-pack">{{ item.pack }}</span>
              <img v-if="previewUrlFor(item)" :src="previewUrlFor(item)" :alt="item.description || item.id" loading="lazy" />
            </div>

            <div class="st-card-body">
              <div class="st-card-meta">
                <span class="st-pill">{{ item.category }}</span>
                <span v-if="item.characterName" class="st-pill st-pill-char">{{ item.characterName }}</span>
                <span v-if="item.status === 'pending'" class="st-pill st-pill-pending">待审核</span>
              </div>
              <div v-if="item.ocrText" class="st-ocr-tag" :title="item.ocrText">配字：{{ item.ocrText }}</div>
              <div class="st-desc" :title="item.description || item.ocrText">
                {{ item.description || "暂无描述" }}
              </div>
              <div class="st-card-foot">
                <span class="st-mono">{{ item.id.slice(0, 8) }} · {{ item.usageCount }}次</span>
                <div class="st-row" style="gap: 4px">
                  <button
                    v-if="item.status === 'pending'"
                    class="st-btn st-btn-sm st-btn-primary"
                    type="button"
                    :disabled="busy"
                    @click="approveSingle(item.id)"
                  >
                    通过
                  </button>
                  <button class="st-btn st-btn-sm" type="button" @click="editing = item">编辑</button>
                  <button class="st-btn st-btn-sm st-btn-danger" type="button" :disabled="busy" @click="banSingle(item.id)">拉黑</button>
                </div>
              </div>
            </div>
          </article>
        </div>

        <div v-if="total > filters.pageSize" class="st-pagination">
          <button class="st-btn st-btn-sm" type="button" :disabled="filters.page <= 1" @click="filters.page -= 1">上一页</button>
          <span>第 {{ filters.page }} / {{ totalPages }} 页（共 {{ total }} 张）</span>
          <button class="st-btn st-btn-sm" type="button" :disabled="filters.page >= totalPages" @click="filters.page += 1">下一页</button>
        </div>
      </template>

      <StickerEditModal
        :sticker="editing"
        :preview-src="editing ? previewUrlFor(editing) : ''"
        :busy="busy"
        @close="editing = null"
        @save="saveEdit"
        @retag="retagSingle"
        @ban="banSingle"
      />

      <StickerImportModal
        :open="importModal !== null"
        :mode="importModal ?? 'upload'"
        :default-pack="overview?.defaultPack ?? 'default'"
        :busy="busy"
        @close="importModal = null"
        @upload="handleUpload"
        @import-dir="handleImportDir"
      />
    </div>
  </k-layout>
</template>
