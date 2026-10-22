<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ state: string; pulse?: boolean }>();

const labels: Record<string, string> = {
  active: "运行中",
  stopped: "已停止",
  activating: "激活中",
  stopping: "停止中",
  error: "失败",
  waiting: "等待依赖",
  idle: "空闲",
  running: "运行中",
  empty: "空会话",
  unreadable: "读取失败",
};

const tones: Record<string, string> = {
  active: "badge-success",
  idle: "badge-success",
  running: "badge-info",
  stopped: "badge-neutral",
  empty: "badge-neutral",
  activating: "badge-warning",
  stopping: "badge-warning",
  waiting: "badge-warning",
  error: "badge-danger",
  unreadable: "badge-danger",
};

const label = computed(() => labels[props.state] ?? props.state);
const tone = computed(() => tones[props.state] ?? "badge-neutral");
const live = computed(() => props.pulse ?? (props.state === "active" || props.state === "running"));
</script>

<template>
  <span class="badge" :class="tone">
    <span v-if="live && state === 'running'" class="status-dot-live" aria-hidden="true"></span>
    <span v-else-if="live" class="dot" aria-hidden="true"></span>
    {{ label }}
  </span>
</template>
