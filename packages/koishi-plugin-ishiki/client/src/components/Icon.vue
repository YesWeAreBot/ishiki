<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ name: string; size?: number; label?: string; strokeWidth?: number }>(), {
  size: 18,
  strokeWidth: 1.7,
});

const paths: Record<string, string[]> = {
  models: ["M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z", "M4 12l8 4.5 8-4.5", "M4 16.5 12 21l8-4.5"],
  profile: ["M4 5.5h16v13H4z", "M8 9.5h4", "M8 13h7", "M16.5 9.5h.01"],
  sessions: ["M4 5.5h16v11H9l-5 4z", "M8 9h8", "M8 12.5h5"],
  runtimes: ["M3 12h3l2.2-5 3.6 10L14.5 12H21"],
  usage: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  cache: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
  plus: ["M12 5v14", "M5 12h14"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.3-4.3"],
  edit: ["M4 20h4l11-11-4-4L4 16z", "m13.5 6.5 4 4"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6.5 7l1 13h9l1-13", "M10 11v5", "M14 11v5"],
  play: ["m8 5 11 7-11 7z"],
  stop: ["M6 6h12v12H6z"],
  refresh: ["M20 11a8 8 0 1 0-2.3 6.4", "M20 4v7h-7"],
  chevron: ["m9 6 6 6-6 6"],
  chevronDown: ["m6 9 6 6 6-6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  check: ["m5 12.5 4.5 4.5L19 7"],
  alert: ["M12 3 22 20H2z", "M12 9v5", "M12 17h.01"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11v5", "M12 8h.01"],
  external: ["M14 4h6v6", "M20 4 11 13", "M19 14v5H5V5h5"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  sun: [
    "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
    "M12 1.5v2",
    "M12 20.5v2",
    "M1.5 12h2",
    "M20.5 12h2",
    "m4.6 4.6 1.4 1.4",
    "m18 18 1.4 1.4",
    "m19.4 4.6-1.4 1.4",
    "m6 18-1.4 1.4",
  ],
  moon: ["M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"],
  arrowLeft: ["M19 12H5", "m11 18-6-6 6-6"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  filter: ["M3 5h18", "M6 12h12", "M10 19h4"],
  terminal: ["m4 5 7 7-7 7", "M12 19h8"],
  eye: ["M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  lock: ["M6 10h12v10H6z", "M9 10V7a3 3 0 0 1 6 0v3"],
  link: ["M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1", "M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"],
  inbox: ["M4 5h16v14H4z", "M4 13h5l1.5 2h3L15 13h5"],
  pulse: ["M3 12h3l2-5 4 10 2-5h7"],
  memory: ["M6 4h12v16H6z", "M9 8h6", "M9 12h6", "M9 16h4"],
  tag: ["M4 4h7l9 9-7 7-9-9z", "M8 8h.01"],
  more: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z",
  ],
  file: ["M6 3h8l4 4v14H6z", "M14 3v5h4", "M9 13h6", "M9 17h5"],
  warningCircle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 8v5", "M12 16h.01"],
  checkCircle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m8 12 2.5 2.5L16.5 9"],
  xCircle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m9 9 6 6", "m15 9-6 6"],
  minimize: ["M6 12h12"],
  arrowUp: ["M12 19V5", "m6 11 6-6 6 6"],
  arrowDown: ["M12 5v14", "m6 13 6 6 6-6"],
  arrowUpRight: ["M7 17 17 7", "M9 7h8v8"],
};

const iconPaths = computed(() => paths[props.name] ?? paths.info);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="label === undefined ? 'true' : undefined"
    :role="label === undefined ? undefined : 'img'"
    :aria-label="label"
    focusable="false"
  >
    <path v-for="(path, index) in iconPaths" :key="index" :d="path" />
  </svg>
</template>
