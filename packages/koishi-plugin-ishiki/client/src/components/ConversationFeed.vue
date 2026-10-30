<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { LogEntry } from "../types";
import Icon from "./Icon.vue";
import SessionEntry from "./SessionEntry.vue";

const props = withDefaults(
  defineProps<{
    entries: LogEntry[];
    hasOlder?: boolean;
    loadingOlder?: boolean;
  }>(),
  {
    hasOlder: false,
    loadingOlder: false,
  },
);

const emit = defineEmits<{
  "load-older": [];
}>();

const OVERSCAN = 720;
const LOAD_TRIGGER = 260;
const LOAD_RESET = 420;
const BOTTOM_THRESHOLD = 72;

interface FeedLayout {
  offsets: number[];
  total: number;
}

interface ScrollAnchor {
  id: string;
  delta: number;
}

const viewport = ref<HTMLDivElement | null>(null);
const content = ref<HTMLDivElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
const atBottom = ref(true);
const stickToBottom = ref(true);
const newCount = ref(0);
const heights = reactive(new Map<string, number>());

const indexById = computed(() => new Map(props.entries.map((entry, index) => [entry.id, index])));

function estimatedHeight(entry: LogEntry): number {
  if (entry.type === "message") {
    const data = typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : undefined;
    return data?.role === "assistant" ? 142 : 108;
  }
  if (entry.type === "event" || entry.type === "state") return 82;
  return 112;
}

function buildLayout(entries: LogEntry[]): FeedLayout {
  const offsets = Array.from({ length: entries.length + 1 }, () => 0);
  offsets[0] = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    offsets[index + 1] = offsets[index] + Math.max(1, heights.get(entry.id) ?? estimatedHeight(entry));
  }
  return { offsets, total: offsets[entries.length] };
}

const layout = computed(() => buildLayout(props.entries));

function indexAt(offsets: number[], position: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= position) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, count - 1);
}

const range = computed(() => {
  if (props.entries.length === 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop.value - OVERSCAN);
  const bottom = scrollTop.value + Math.max(viewportHeight.value, 320) + OVERSCAN;
  const start = indexAt(layout.value.offsets, top);
  const end = Math.min(props.entries.length, indexAt(layout.value.offsets, bottom) + 1);
  return { start, end };
});

const visibleEntries = computed(() => props.entries.slice(range.value.start, range.value.end));
const topSpace = computed(() => {
  const fill = Math.max(0, viewportHeight.value - layout.value.total);
  return (layout.value.offsets[range.value.start] ?? 0) + (range.value.start === 0 ? fill : 0);
});
const bottomSpace = computed(() => {
  return layout.value.total - (layout.value.offsets[range.value.end] ?? layout.value.total);
});

function captureAnchor(entries = props.entries, currentLayout = layout.value): ScrollAnchor | undefined {
  const element = viewport.value;
  if (element === null || entries.length === 0) return undefined;
  const top = element.scrollTop;
  const index = indexAt(currentLayout.offsets, top);
  const entry = entries[index];
  if (entry === undefined) return undefined;
  return { id: entry.id, delta: top - currentLayout.offsets[index] };
}

async function restoreAnchor(anchor: ScrollAnchor | undefined): Promise<void> {
  if (anchor === undefined) return;
  await nextTick();
  const element = viewport.value;
  const index = indexById.value.get(anchor.id);
  if (element === null || index === undefined) return;
  element.scrollTop = Math.max(0, layout.value.offsets[index] + anchor.delta);
  scrollTop.value = element.scrollTop;
}

function nearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD;
}

function scrollToLatest(smooth = true): void {
  const element = viewport.value;
  if (element === null) return;
  stickToBottom.value = true;
  atBottom.value = true;
  newCount.value = 0;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollTo({ top: element.scrollHeight, behavior: smooth && !reduceMotion ? "smooth" : "auto" });
  scrollTop.value = element.scrollTop;
}

let scrollFrame = 0;
let loadLatched = false;

function handleScroll(): void {
  if (scrollFrame !== 0) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const element = viewport.value;
    if (element === null) return;
    scrollTop.value = element.scrollTop;
    const bottom = nearBottom(element);
    atBottom.value = bottom;
    stickToBottom.value = bottom;
    if (bottom) {
      newCount.value = 0;
    }

    if (element.scrollTop > LOAD_RESET) loadLatched = false;
    if (element.scrollTop < LOAD_TRIGGER && props.hasOlder && !props.loadingOlder && !loadLatched) {
      loadLatched = true;
      emit("load-older");
    }
  });
}

let measureFrame = 0;

function scheduleMeasure(): void {
  if (measureFrame !== 0) return;
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    const element = content.value;
    if (element === null) return;
    const anchor = stickToBottom.value ? undefined : captureAnchor();
    let changed = false;
    for (const item of element.querySelectorAll<HTMLElement>("[data-entry-id]")) {
      const id = item.dataset.entryId;
      if (id === undefined) continue;
      const measured = item.getBoundingClientRect().height;
      if (measured <= 0) continue;
      const previous = heights.get(id);
      if (previous === undefined || Math.abs(previous - measured) > 0.5) {
        heights.set(id, measured);
        changed = true;
      }
    }
    if (!changed) return;
    void nextTick().then(() => {
      if (stickToBottom.value) scrollToLatest(false);
      else void restoreAnchor(anchor);
    });
  });
}

let resizeObserver: ResizeObserver | undefined;

onMounted(() => {
  const viewportElement = viewport.value;
  const contentElement = content.value;
  if (viewportElement === null || contentElement === null) return;
  viewportHeight.value = viewportElement.clientHeight;
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === viewportElement) {
        const anchor = stickToBottom.value ? undefined : captureAnchor();
        viewportHeight.value = viewportElement.clientHeight;
        if (stickToBottom.value) void nextTick().then(() => scrollToLatest(false));
        else void restoreAnchor(anchor);
      } else {
        scheduleMeasure();
      }
    }
  });
  resizeObserver.observe(viewportElement);
  resizeObserver.observe(contentElement);
  void nextTick().then(() => {
    scrollToLatest(false);
    scheduleMeasure();
  });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (scrollFrame !== 0) cancelAnimationFrame(scrollFrame);
  if (measureFrame !== 0) cancelAnimationFrame(measureFrame);
});

watch(
  () => props.entries,
  async (next, previous) => {
    const element = viewport.value;
    if (element === null) return;
    const shouldStick = nearBottom(element);
    const appended =
      previous.length > 0 && next.length > previous.length && previous.every((entry, index) => next[index]?.id === entry.id)
        ? next.length - previous.length
        : 0;
    if (appended > 0 && !shouldStick) newCount.value += appended;
    const anchor = shouldStick ? undefined : captureAnchor(previous, buildLayout(previous));
    await nextTick();
    if (shouldStick) {
      stickToBottom.value = true;
      atBottom.value = true;
      scrollToLatest(false);
    } else {
      stickToBottom.value = false;
      await restoreAnchor(anchor);
    }
    scheduleMeasure();
  },
  { flush: "pre" },
);

defineExpose({ scrollToLatest });
</script>

<template>
  <div class="conversation-viewport-wrap">
    <div ref="viewport" class="conversation-viewport" role="log" aria-label="会话消息，向上滚动加载更早记录" tabindex="0" @scroll.passive="handleScroll">
      <div ref="content" class="conversation-content">
        <div :style="{ height: `${topSpace}px` }" aria-hidden="true"></div>
        <div v-for="entry in visibleEntries" :key="entry.id" class="conversation-item" :data-entry-id="entry.id">
          <SessionEntry :entry="entry" />
        </div>
        <div :style="{ height: `${bottomSpace}px` }" aria-hidden="true"></div>
      </div>
    </div>

    <div v-if="loadingOlder" class="conversation-loading" role="status">
      <span class="spinner" aria-hidden="true"></span>
      正在加载更早记录
    </div>

    <Transition name="jump">
      <button v-if="!atBottom" type="button" class="conversation-jump" @click="scrollToLatest()">
        <Icon name="arrowDown" :size="14" />
        <span>回到最新消息</span>
        <span v-if="newCount > 0" class="conversation-new-count">{{ newCount }} 条新消息</span>
      </button>
    </Transition>
    <span class="visually-hidden" role="status" aria-live="polite">
      {{ newCount > 0 && !atBottom ? `收到 ${newCount} 条新消息` : "" }}
    </span>
  </div>
</template>

<style scoped>
.conversation-viewport-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--line);
  background:
    radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--line-strong) 52%, transparent) 1px, transparent 0) 0 0 / 22px 22px,
    linear-gradient(180deg, var(--surface-inset), color-mix(in srgb, var(--surface-muted) 64%, var(--surface)) 68%, var(--surface));
}

.conversation-viewport {
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.conversation-content {
  width: min(100%, 1080px);
  min-height: 100%;
  margin: 0 auto;
}

.conversation-item {
  padding: 5px 20px;
}

.conversation-loading {
  position: absolute;
  top: 10px;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  box-shadow: var(--shadow);
  color: var(--muted);
  font-size: 11px;
  transform: translateX(-50%);
  backdrop-filter: blur(10px);
}

.conversation-jump {
  position: absolute;
  right: 20px;
  bottom: 18px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line));
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 95%, transparent);
  box-shadow: var(--shadow-overlay);
  color: var(--accent-ink);
  font-size: 11.5px;
  font-weight: 600;
  backdrop-filter: blur(12px);
}

.conversation-jump:hover {
  background: var(--surface);
}

.conversation-new-count {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-ink);
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 500;
}

.jump-enter-active,
.jump-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.jump-enter-from,
.jump-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 720px) {
  .conversation-item {
    padding-right: 12px;
    padding-left: 12px;
  }

  .conversation-jump {
    right: 12px;
    bottom: 12px;
  }
}
</style>
