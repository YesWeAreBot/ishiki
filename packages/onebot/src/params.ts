import type { Context } from "koishi";
import type { ResourceCenter } from "koishi-plugin-ishiki";

import type { CatalogAction } from "./catalog/types.js";
import type { MediaPublisher } from "./media.js";

export interface MediaOptions {
  resources: ResourceCenter;
  publisher: MediaPublisher;
  maxInlineBytes: number;
  baseUrl?: string;
  /** 发布 HTTP URL 时需要的 Koishi Context；未配置 server 时 publish 自己会抛。 */
  ctx: Context;
}

/**
 * 递归替换 params 里的资源 URL。
 *
 * 只处理已注册 scheme 的 URL：http(s)、base64、data、file 和宿主路径原样保留，
 * 因为协议端本来就认这些写法。动作声明为 `http` 的参数发布成临时 URL，
 * 其余转成 base64://。文本资源与超限字节都直接报错，不做截断。
 */
export async function resolveParams(
  params: Record<string, unknown>,
  action: CatalogAction,
  options: MediaOptions,
  schemes: readonly string[] = options.resources.listSchemes(),
): Promise<Record<string, unknown>> {
  const walk = async (value: unknown, key: string | undefined): Promise<unknown> => {
    if (typeof value === "string") return replace(value, key, action, options, schemes);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await walk(item, key));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) out[childKey] = await walk(child, childKey);
      return out;
    }
    return value;
  };
  return (await walk(params, undefined)) as Record<string, unknown>;
}

function resourceScheme(value: string, schemes: readonly string[]): string | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  if (match === null) return undefined;
  const scheme = match[1]!.toLowerCase();
  return schemes.includes(scheme) ? scheme : undefined;
}

async function replace(value: string, key: string | undefined, action: CatalogAction, options: MediaOptions, schemes: readonly string[]): Promise<string> {
  if (resourceScheme(value, schemes) === undefined) return value;
  const payload = await options.resources.resolve(value);
  if (payload.type === "text") {
    throw new Error(`${key ?? "参数"} 需要二进制媒体，但 ${value} 是文本资源；请改用图片或文件的资源 URL`);
  }
  const transport = key === undefined ? undefined : action.media?.[key];
  // 上限只管 base64 内联：发布成 URL 的字节由发布器的配额管理。
  if (transport !== "http" && payload.bytes.byteLength > options.maxInlineBytes) {
    throw new Error(`${value} 有 ${payload.bytes.byteLength} 字节，超过 maxInlineBytes=${options.maxInlineBytes}；调大该配置或改用更小的文件`);
  }
  if (transport === "http") return options.publisher.publish(options.ctx, payload.bytes, payload.mediaType, options.baseUrl);
  return `base64://${Buffer.from(payload.bytes).toString("base64")}`;
}
