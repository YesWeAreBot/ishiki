import { Service, type Context } from "koishi";
import { Extension, type ExtensionHost } from "koishi-plugin-ishiki";

import { InstanceConfig, PluginConfig } from "./config.js";
import { SearchService } from "./service.js";
import { createSearchTools, searchInstructions } from "./tools.js";

class SearchExtension extends Extension<InstanceConfig> {
  static inject = ["ishiki"];
  static readonly usage = `
为 Agent 提供网络搜索与抓取。后端凭据在插件配置的 engines 列表维护；实例在 profile 的 <code>extends.search.config</code> 里配置 mode。

文档：https://ishiki.js.org/docs/guides/search/`;
  static readonly Config = PluginConfig;
  public readonly Schema = InstanceConfig;

  private readonly service: SearchService;

  constructor(ctx: Context, config: PluginConfig) {
    super(ctx, "search");
    this.logger.level = config.logLevel;
    this.service = new SearchService(config);
  }

  public [Service.invoke](_host: ExtensionHost, config: InstanceConfig) {
    this.service.select(config.mode, "search");
    const instructions = searchInstructions(this.service, config.mode);
    return {
      name: "ishiki.search",
      extendTools: async () => createSearchTools(this.service, config.mode),
      extendInstructions: async () => instructions,
    };
  }
}

export default SearchExtension;
