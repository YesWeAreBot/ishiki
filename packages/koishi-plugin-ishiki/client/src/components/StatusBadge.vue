<script setup lang="ts">
import { computed } from "vue";

import { statusLabel, statusTone } from "../lib/status";

const props = defineProps<{ state: string; pulse?: boolean }>();

const label = computed(() => statusLabel(props.state));
const tone = computed(() => `badge-${statusTone(props.state)}`);
const live = computed(() => props.pulse ?? (props.state === "active" || props.state === "running"));
</script>

<template>
  <span class="badge" :class="tone">
    <span v-if="live && state === 'running'" class="status-dot-live" aria-hidden="true"></span>
    <span v-else-if="live" class="dot" aria-hidden="true"></span>
    {{ label }}
  </span>
</template>
