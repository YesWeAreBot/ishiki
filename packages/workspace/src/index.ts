import {} from "just-bash";
import { Context } from "koishi";

class IshikiWorkspace {
  constructor(ctx: Context, config: IshikiWorkspace.Config) {}
}

namespace IshikiWorkspace {
  export interface Config {}
}

export default IshikiWorkspace;
