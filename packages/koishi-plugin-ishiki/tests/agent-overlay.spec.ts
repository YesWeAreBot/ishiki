import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { jsonSchema, tool } from "@yesimagent/core";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentOverlayPlugin } from "../src/debug/agent-overlay.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent overlay", () => {
  it("overrides tool and nested parameter descriptions without changing execution", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ishiki-overlay-"));
    roots.push(root);
    writeFileSync(
      path.join(root, "tools.md"),
      [
        "---",
        "version: 1",
        "tools:",
        "  send_message:",
        "    description: Send a precise message.",
        "    parameters:",
        "      target.sid: Copy the account target unchanged.",
        "---",
        "",
      ].join("\n"),
    );

    let executions = 0;
    const original = tool({
      description: "Send a message.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { sid: { type: "string", description: "old target" } },
            required: ["sid"],
          },
        },
        required: ["target"],
      }),
      execute: async () => {
        executions += 1;
        return { ok: true };
      },
    });

    const plugin = createAgentOverlayPlugin({ root, toolsFile: "tools.md" });
    const transformed = await plugin.transformTools!({ send_message: original }, "complete");
    const patched = transformed.send_message!;

    expect(patched.description).toBe("Send a precise message.");
    expect(patched.inputSchema.jsonSchema.properties.target.properties.sid.description).toBe("Copy the account target unchanged.");
    expect(original.description).toBe("Send a message.");
    expect(await patched.execute!({ target: { sid: "test" } }, {} as never)).toEqual({ ok: true });
    expect(executions).toBe(1);
  });

  it("rejects unknown tools and parameters", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ishiki-overlay-"));
    roots.push(root);
    writeFileSync(path.join(root, "unknown.md"), "---\nversion: 1\ntools:\n  missing:\n    description: no\n---\n");
    const plugin = createAgentOverlayPlugin({ root, toolsFile: "unknown.md" });
    expect(() => plugin.transformTools!({}, "complete")).toThrow('unknown tool "missing"');

    writeFileSync(path.join(root, "parameter.md"), "---\nversion: 1\ntools:\n  known:\n    parameters:\n      missing: no\n---\n");
    const parameterPlugin = createAgentOverlayPlugin({ root, toolsFile: "parameter.md" });
    const known = tool({
      description: "known",
      inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
      execute: async () => "ok",
    });
    expect(() => parameterPlugin.transformTools!({ known }, "complete")).toThrow('unknown parameter "known.missing"');
  });
});
