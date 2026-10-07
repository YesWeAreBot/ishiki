import { ToolSet } from "@yesimagent/core";
import { Awaitable, Service, type Context, type Logger, type Schema } from "koishi";

import type { InstanceDomain } from "./profile/index.js";
import type { ResourceCenter } from "./resources/center.js";

export interface ExtensionContext {
  readonly runtimeId: string;
  readonly domain: InstanceDomain;
  readonly home: string;
  readonly root: string;
  /** profile 的 fiber：profile 级共享资源挂它的 dispose。 */
  readonly fiber: Context;
  readonly logger: Logger;
  /** runtime 的资源中心：扩展经它读 asset/artifact、注册自定义 scheme。 */
  readonly resources: ResourceCenter;
}

export interface ExtensionInstance {
  extendInstructions?(): Awaitable<string>;
  extendTools?(): Awaitable<ToolSet>;
}

declare module "koishi" {
  interface Context {
    [name: `ishiki.ext.${string}`]: (Extension & Extension[typeof Service.invoke]) | undefined;
  }
}

export abstract class Extension<T = any> extends Service {
  /**
   * 扩展实例配置的 Schema，来自 profile 的 `extends.<名字>.config`。
   * 与插件自身的 Koishi 配置（构造器参数、`Config` 命名空间）无关。
   * 缺省表示实例配置原样透传。
   */
  static Schema: Schema | undefined;

  static GetName(name: string): `ishiki.ext.${string}` {
    return `ishiki.ext.${name}`;
  }

  static GetService(ctx: Context, name: string): Extension & Extension[typeof Service.invoke] {
    const service = Extension.GetName(name);
    const provider = ctx.get(service);
    if (provider === undefined) throw new Error(`extension service "${service}" is not available`);
    return provider;
  }

  public constructor(ctx: Context, name: string) {
    super(ctx, Extension.GetName(name));
  }

  /** 用 static Schema（若有）验证实例配置并补默认值；没有 Schema 就原样透传。 */
  public parse(config: unknown): T {
    const schema = (this.constructor as typeof Extension).Schema;
    return (schema === undefined ? config : schema(config ?? {})) as T;
  }

  public abstract [Service.invoke](config: T, context: ExtensionContext): ExtensionInstance | undefined;
}
