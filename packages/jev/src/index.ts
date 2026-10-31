import { type Context } from "koishi";

import { JevWakeupEngine } from "./wakeup.js";

export default function apply(ctx: Context): void {
  ctx.plugin(JevWakeupEngine);
}
