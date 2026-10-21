import { Context } from "koishi";

import { V3ContextEngine } from "./context-engine.js";
import { V3ToolcallEngine } from "./toolcall-engine.js";
import { V3WakeupEngine } from "./wakeup-engine.js";

export default function apply(ctx: Context) {
  ctx.plugin(V3ContextEngine);
  ctx.plugin(V3ToolcallEngine);
  ctx.plugin(V3WakeupEngine);
}
