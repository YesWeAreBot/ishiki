import type { Context } from "koishi";

const stores = new WeakMap<Context, Map<string, unknown>>();
const names = new WeakMap<object, string>();

/** cordis 的根上下文在运行时存在；koishi 的类型声明没有暴露它。 */
function appOf(ctx: Context): Context {
  return (ctx as Context & { root?: Context }).root ?? ctx;
}

/** 引擎和扩展按应用各存一份，控制台查询时不需要再猜服务名。 */
export function registerService(ctx: Context, namespace: string, name: string, value: object): void {
  const root = appOf(ctx);
  let store = stores.get(root);
  if (store === undefined) {
    store = new Map();
    stores.set(root, store);
  }
  const key = `${namespace}:${name}`;
  store.set(key, value);
  names.set(value, name);
  ctx.on("dispose", () => void store.delete(key));
}

/** 服务的短名称；service 自身的 name 带有命名空间前缀。 */
export function serviceName(value: object): string | undefined {
  return names.get(value);
}

export function listServices<T>(ctx: Context, namespace: string): T[] {
  const store = stores.get(appOf(ctx));
  if (store === undefined) return [];
  const prefix = `${namespace}:`;
  return [...store.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value as T)
    .sort((left, right) => String((left as { name?: unknown }).name).localeCompare(String((right as { name?: unknown }).name)));
}
