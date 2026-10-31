<script setup lang="ts">
import { computed } from "vue";

/**
 * RAW 模式编辑器：透明文字的 textarea 叠在按行渲染的高亮层上。textarea 关闭软换行
 * （wrap="off"），高亮层逐行 white-space: pre，两侧渲染结果完全一致；宽度由最长行
 * 决定，容器横向滚动。支持 Tab 缩进、Shift+Tab 反缩进、回车自动缩进和错误行标记。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    errorLine?: number;
    readOnly?: boolean;
    ariaLabel?: string;
    minHeight?: number;
  }>(),
  { ariaLabel: "原始配置编辑器", minHeight: 320 },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const lines = computed(() => props.modelValue.split("\n"));

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightValue(rest: string): string {
  return escapeHtml(rest).replace(
    /('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")|\b(true|false|null)\b|(?<![\w.])[-+]?\d+(?:\.\d+)?(?![\w.])/g,
    (match, quoted: string | undefined, keyword: string | undefined) => {
      if (quoted !== undefined) return `<span class="tk-string">${quoted}</span>`;
      if (keyword !== undefined) return `<span class="tk-bool">${keyword}</span>`;
      return `<span class="tk-number">${match}</span>`;
    },
  );
}

/** 单行 YAML：缩进 + 键 + 冒号 + 值；值里的字符串、数字、布尔单独着色。 */
function highlightLine(line: string): string {
  const match = line.match(/^(\s*(?:-\s+)?)([^:#]*?)(:)(\s?.*)$/);
  if (match === null) return highlightValue(line);
  return `${escapeHtml(match[1])}<span class="tk-key">${escapeHtml(match[2])}</span>${escapeHtml(match[3])}${highlightValue(match[4])}`;
}

/** 空行用一个空格占位，保证 pre 里对应行仍然渲染。 */
const rendered = computed(() => lines.value.map((line) => (line.length === 0 ? " " : highlightLine(line))));

function indentOf(line: string): string {
  const match = line.match(/^[ \t]*/);
  return match === null ? "" : match[0];
}

function onInput(event: Event): void {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}

function applyEdit(textarea: HTMLTextAreaElement, next: string, caret: number): void {
  emit("update:modelValue", next);
  requestAnimationFrame(() => {
    textarea.setSelectionRange(caret, caret);
  });
}

function onKeydown(event: KeyboardEvent): void {
  const textarea = event.target as HTMLTextAreaElement;
  const { selectionStart, selectionEnd } = textarea;
  const value = props.modelValue;

  if (event.key === "Tab") {
    event.preventDefault();
    if (event.shiftKey) {
      const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
      const indent = indentOf(value.slice(lineStart));
      if (indent.length === 0) return;
      const removed = Math.min(2, indent.length);
      const next = value.slice(0, lineStart) + value.slice(lineStart + removed);
      applyEdit(textarea, next, Math.max(lineStart, selectionStart - removed));
      return;
    }
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    applyEdit(textarea, next, selectionStart + 2);
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    const currentLine = value.slice(lineStart, selectionStart);
    let indent = indentOf(currentLine);
    const trimmed = currentLine.trimEnd();
    if (trimmed.endsWith(":") || trimmed.endsWith("{") || trimmed.endsWith("[")) indent += "  ";
    const insert = `\n${indent}`;
    const next = `${value.slice(0, selectionStart)}${insert}${value.slice(selectionEnd)}`;
    applyEdit(textarea, next, selectionStart + insert.length);
  }
}
</script>

<template>
  <div class="raw-editor" :style="{ minHeight: `${minHeight}px` }">
    <div class="raw-inner">
      <div class="raw-gutter" aria-hidden="true">
        <div v-for="(line, index) in lines" :key="index" class="raw-line-number" :class="{ 'raw-line-error': errorLine === index + 1 }">
          {{ index + 1 }}
        </div>
      </div>
      <div class="raw-canvas">
        <pre class="raw-highlight" :style="{ minHeight: `${minHeight}px` }"><code
v-for="(line, index) in rendered"
:key="index"
class="raw-line"
:class="{ 'raw-line-error': errorLine === index + 1 }"
v-html="line"
></code></pre>
        <textarea
          class="raw-input"
          wrap="off"
          :value="modelValue"
          :aria-label="ariaLabel"
          spellcheck="false"
          :readonly="readOnly"
          autocapitalize="off"
          autocomplete="off"
          @input="onInput"
          @keydown="onKeydown"
        ></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped>
.raw-editor {
  overflow: auto;
  max-height: 60vh;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.raw-editor:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
}

.raw-inner {
  position: relative;
  display: flex;
  width: max-content;
  min-width: 100%;
}

.raw-gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  flex: none;
  min-width: 46px;
  padding: 8px 8px 8px 0;
  border-right: 1px solid var(--line);
  background: var(--surface-muted);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 20px;
  text-align: right;
  user-select: none;
}

.raw-canvas {
  position: relative;
  flex: 1 0 auto;
  min-width: 0;
}

.raw-highlight {
  position: relative;
  z-index: 0;
  margin: 0;
  padding: 8px 12px 28px;
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre;
}

.raw-line {
  display: block;
  min-height: 20px;
  line-height: 20px;
}

.raw-line-error {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
}

.raw-line-number.raw-line-error {
  color: var(--danger-ink);
  font-weight: 700;
}

.raw-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 8px 12px 28px;
  border: 0;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 20px;
  white-space: pre;
  overflow: hidden;
  resize: none;
}

.raw-input::selection {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
}

.tk-key {
  color: var(--c2);
}

.tk-string {
  color: var(--accent-ink);
}

.tk-number {
  color: var(--warning-ink);
}

.tk-bool {
  color: var(--danger-ink);
}
</style>
