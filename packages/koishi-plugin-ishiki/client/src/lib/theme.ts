import { useColorMode } from "@koishijs/client";
import { computed } from "vue";

/** 控制台主题模式，供页面根节点与传送层同步。 */
export function useIshikiTheme() {
  const mode = useColorMode();
  return { isDark: computed(() => mode.value === "dark") };
}
