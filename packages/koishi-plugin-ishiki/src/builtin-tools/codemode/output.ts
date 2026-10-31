import type { CodemodeResult } from "@earendil-works/pi-codemode";

import type { ResourceCenter } from "../../resource/center.js";
import { processOutput } from "../../resource/output.js";
import { renderTextPage, textFits, type TextBudget } from "../../resource/text.js";
import type { AttachmentItem } from "../../types/messages.js";

/** Rough model-visible size of one token; the profile budget is expressed in tokens. */
const CHARS_PER_TOKEN = 4;

export interface CodemodeOutputOptions {
  center: ResourceCenter;
  toolName: string;
  result: CodemodeResult;
  elapsedMs: number;
  maxOutputTokens: number;
  imageInput: boolean;
}

export interface PreparedCodemodeOutput {
  text: string;
  items: AttachmentItem[];
}

interface Preview {
  text: string;
  used: number;
}

/**
 * A preview that fits the remaining budget is shown as is. Longer text is stored
 * as a text artifact and paged by the `read` continuation contract, so the model
 * keeps a URL and a way forward instead of a truncated dead end.
 */
async function preview(text: string, remaining: number, center: ResourceCenter, toolName: string): Promise<Preview | undefined> {
  if (remaining <= 0) return undefined;
  const budget: TextBudget = { maxChars: remaining, maxLines: Number.MAX_SAFE_INTEGER };
  if (textFits(text, budget)) return { text, used: text.length };
  const url = await center.store.writeArtifact(toolName, Buffer.from(text, "utf8"), { mediaType: "text/plain" });
  const page = renderTextPage(text, { url, offset: 0, line: 1, column: 1 }, budget);
  return { text: page, used: page.length };
}

function renderError(error: { kind: string; name?: string; message: string; stack?: string }): string {
  const lines = [`${error.kind}: ${error.name ?? "Error"}: ${error.message}`];
  if (error.stack !== undefined && error.stack.length > 0) lines.push(error.stack);
  return lines.join("\n");
}

/**
 * Turns one sandbox result into the session tool-result text: fixed sections in a
 * fixed order, with a shared preview budget and every image stored as a resource.
 */
export async function prepareCodemodeOutput(options: CodemodeOutputOptions): Promise<PreparedCodemodeOutput> {
  const { result } = options;
  const text = result.output.flatMap((item) => (item.type === "text" && item.console !== true ? [item.text] : []));
  const consoleLines = result.output.flatMap((item) => (item.type === "text" && item.console === true ? [item.text] : []));

  let remaining = Math.max(0, Math.floor(options.maxOutputTokens) * CHARS_PER_TOKEN);
  const body: string[] = [];

  if (result.ok && result.value !== undefined) {
    const rendered = JSON.stringify(result.value) ?? "null";
    const page = await preview(rendered, remaining, options.center, options.toolName);
    if (page !== undefined) {
      body.push("=== RESULT ===", page.text);
      remaining -= page.used;
    }
  }

  if (text.length > 0) {
    const page = await preview(text.join("\n"), remaining, options.center, options.toolName);
    if (page !== undefined) {
      body.push("=== TEXT ===", page.text);
      remaining -= page.used;
    }
  }

  if (consoleLines.length > 0) {
    const page = await preview(consoleLines.join("\n"), remaining, options.center, options.toolName);
    if (page !== undefined) {
      body.push("=== CONSOLE ===", page.text);
      remaining -= page.used;
    }
  }

  const images = result.output.flatMap((item) => (item.type === "image" ? [item] : []));
  let items: AttachmentItem[] = [];
  if (images.length > 0) {
    const processed = await processOutput(
      options.center,
      options.toolName,
      {
        type: "content",
        value: images.map((image) => ({ type: "file" as const, mediaType: image.mimeType, data: { type: "data" as const, data: image.data } })),
      },
      undefined,
      options.imageInput,
    );
    items = processed.items;
    if (items.length > 0) {
      body.push("=== ATTACHMENTS ===", ...items.map((item) => `- ${item.url} (${item.mediaType})`));
    }
  }

  const head = ["=== STATUS ===", result.ok ? "completed" : "failed", "=== WALL TIME ===", `${(options.elapsedMs / 1000).toFixed(2)} seconds`];
  const tail = result.ok ? [] : ["=== ERROR ===", renderError(result.error)];
  return { text: [...head, ...body, ...tail].join("\n"), items };
}
