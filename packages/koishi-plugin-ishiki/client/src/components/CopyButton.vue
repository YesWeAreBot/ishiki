<script setup lang="ts">
import { toast } from "../store";
import Icon from "./Icon.vue";

const props = defineProps<{ value: string; label?: string }>();

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value);
    toast("success", "已复制", props.label ?? "内容已写入剪贴板。");
  } catch {
    toast("error", "复制失败", "浏览器拒绝了剪贴板访问。");
  }
}
</script>

<template>
  <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="`复制${label ?? ''}`" @click="copy">
    <Icon name="copy" :size="14" />
  </button>
</template>
