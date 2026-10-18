import type { Context } from "koishi";

import { NarrativeContextEngine } from "./context/narrative.engine.js";
import { NarrativeToolcallEngine } from "./toolcall/narrative.engine.js";

/** Registers both narrative engine providers; profiles select them by name. */
export default function apply(ctx: Context): void {
  ctx.plugin(NarrativeContextEngine);
  ctx.plugin(NarrativeToolcallEngine);
}
