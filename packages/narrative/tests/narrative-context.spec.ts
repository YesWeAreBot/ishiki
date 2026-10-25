import type { ExtensionContext, Agent, AgentEntry } from "koishi-plugin-ishiki";
import { createAgent, createAssistantMessage, createEntry, createMemoryStorage, createUserMessage } from "koishi-plugin-ishiki";
import { describe, expect, it } from "vitest";

import { NarrativeContextInstance } from "../src/context/narrative.engine.js";
import { narrativeOptions, readNarrativeMarker, type NarrativeInput, type NarrativeMarker } from "../src/narrative.js";

/** The tests drive storage and channel events directly; no model call ever runs. */
const MODEL = {} as never;
/** Only `warn` is ever reached by these tests. */
const LOGGER = { warn() {}, error() {}, info() {}, debug() {} } as never;

const fixture: ExtensionContext = {
  runtimeId: "narrative-test",
  domain: { mode: "channel", platform: "test", selfId: "self", channelId: "channel" },
  home: "",
  root: "",
  fiber: {} as never,
  logger: LOGGER,
  resources: {} as never,
};

function agentWith(entries: AgentEntry[] = []): Agent {
  return createAgent({ model: MODEL, storage: createMemoryStorage(entries) });
}

function messageEntry(id: string, content: string): AgentEntry<"message"> {
  return createEntry("message", createUserMessage(content), { id });
}

function incomingEntry(id: string, isDirect: boolean, channelId = "channel"): AgentEntry<"message"> {
  return createEntry(
    "message",
    {
      id: `message-${id}`,
      timestamp: 0,
      role: "custom",
      type: "ishiki.message.created",
      data: {
        timestamp: 0,
        platform: "test",
        selfId: "self",
        channelId,
        messageId: id,
        content: id,
        isDirect,
        user: { id: "visitor" },
      },
    },
    { id },
  );
}

interface MarkedAssistant {
  entryId: string;
  messageId: string;
  script: string;
  turnId?: string;
  marker: NarrativeMarker;
}

function markedAssistant(options: MarkedAssistant): AgentEntry<"message"> {
  const message = createAssistantMessage([{ type: "reasoning", text: options.script, providerOptions: narrativeOptions(options.marker) }], {
    id: options.messageId,
  });
  return createEntry("message", message, { id: options.entryId, turnId: options.turnId });
}

function delta(inputEntryIds: string[]): NarrativeMarker {
  return { kind: "delta", inputEntryIds, next: { kind: "stop" } };
}

function narration(ledger: readonly AgentEntry[]) {
  return ledger.flatMap((entry) => (entry.type === "ishiki.narrative" ? [entry.data] : []));
}

/** The consumer contract with the model wrapper: history prose, then the marked new-input message. */
function inputProjection(prepared: readonly AgentEntry[]): { marker: NarrativeInput; text: string } {
  let text = "";
  for (const entry of prepared) {
    if (entry.type !== "message" || entry.data.role !== "user") continue;
    const content = entry.data.content;
    if (typeof content === "string") {
      text += content;
      continue;
    }
    const markers = content.flatMap((part) => (part.type === "text" && part.providerOptions !== undefined ? [readNarrativeMarker(part.providerOptions)] : []));
    const marker = markers.find((value) => value?.kind === "input");
    if (marker?.kind === "input") return { marker, text };
    text += content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  throw new Error("prepared entries carry no narrative input marker");
}

describe("narrative context", () => {
  it.each([
    ["direct", true],
    ["group", false],
  ] as const)("preserves %s message context in a channel runtime", async (kind, isDirect) => {
    const instance = new NarrativeContextInstance({}, fixture);
    const prepared = await instance.prepareEntries([incomingEntry("greeting", isDirect)]);
    const rendered = instance.renderMessages(prepared.flatMap((entry) => (entry.type === "message" ? [entry.data] : [])));
    const input = rendered.at(-1);
    if (input?.role !== "user" || typeof input.content === "string") throw new Error("expected marked narrative input");
    const text = input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

    expect(text).toMatch(new RegExp(`\\[conversation type=${kind}\\]\\n\\[[^\\n]+\\] visitor #greeting: greeting`));
  });

  it("keeps conversation type with its target in mixed cross-channel history", async () => {
    const entries = [
      incomingEntry("private-greeting", true, "private-channel"),
      markedAssistant({
        entryId: "private-assistant",
        messageId: "private-narration",
        script: "She noticed a private greeting.",
        marker: delta(["private-greeting"]),
      }),
      incomingEntry("group-greeting", false, "group-channel"),
    ];
    const instance = new NarrativeContextInstance({}, { ...fixture, domain: { mode: "cross", channels: new Map() } });
    const agent = agentWith(entries);
    instance.attach(agent);
    const prepared = await instance.prepareEntries(await agent.storage.read());
    const rendered = instance.renderMessages(prepared.flatMap((entry) => (entry.type === "message" ? [entry.data] : [])));
    const input = rendered.at(-1);
    if (input?.role !== "user" || typeof input.content === "string") throw new Error("expected marked narrative input");
    const text = input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const fresh = text.split("<new_events>\n")[1]?.split("\n</new_events>")[0];
    const recent = text.split("<recent_evidence>\n")[1]?.split("\n</recent_evidence>")[0];

    expect(fresh).toContain('[conversation type=group]\n[channel target={"sid":"test:self","channelId":"group-channel"}]');
    expect(fresh).toContain("visitor #group-greeting: group-greeting");
    expect(fresh).not.toContain("private-greeting");
    expect(recent).toContain('[conversation type=direct]\n[channel target={"sid":"test:self","channelId":"private-channel"}]');
    expect(recent).toContain("visitor #private-greeting: private-greeting");
    expect(recent).not.toContain("group-greeting");
  });

  it("narrates each increment once and never consumes records joined after the snapshot", async () => {
    const agent = agentWith();
    const instance = new NarrativeContextInstance({}, fixture);
    instance.attach(agent);

    await agent.storage.append(messageEntry("event-1", "hello"));
    const before = inputProjection(await instance.prepareEntries(await agent.storage.read()));
    expect(before.marker.inputEntryIds).toEqual(["event-1"]);

    // The step persists its assistant first, joined input lands after it, then turn.step fires.
    await agent.storage.append(
      markedAssistant({
        entryId: "assistant-entry",
        messageId: "assistant-1",
        script: "narration one",
        turnId: "turn-1",
        marker: delta(["event-1", "joined-1"]),
      }),
      messageEntry("joined-1", "joined"),
    );
    await agent.channel.emit("agent", { type: "turn.step", turnId: "turn-1", stepNumber: 0 });

    const [projection] = narration(await agent.storage.read());
    expect(projection?.originMessageId).toBe("assistant-1");
    expect(projection?.script).toBe("narration one");
    if (projection?.kind !== "delta") throw new Error("expected the step's delta projection");
    // "joined-1" did not exist when the assistant replied, so the claim is dropped.
    expect(projection.inputEntryIds).toEqual(["event-1"]);

    const after = inputProjection(await instance.prepareEntries(await agent.storage.read()));
    expect(after.text).toContain("narration one");
    expect(after.marker.inputEntryIds).toEqual(["assistant-entry", "joined-1"]);
    expect(narration(await agent.storage.read())).toHaveLength(1);
  });

  it("records nothing when a step leaves no durable assistant", async () => {
    const agent = agentWith();
    const instance = new NarrativeContextInstance({}, fixture);
    instance.attach(agent);

    await agent.storage.append(messageEntry("event-1", "hello"));
    await instance.prepareEntries(await agent.storage.read());
    // An aborted or failed step persists no assistant, so turn.step has nothing to project.
    await agent.channel.emit("agent", { type: "turn.step", turnId: "turn-2", stepNumber: 0 });

    expect(narration(await agent.storage.read())).toHaveLength(0);
    expect(inputProjection(await instance.prepareEntries(await agent.storage.read())).marker.inputEntryIds).toEqual(["event-1"]);
  });

  it("recovers projection from a marked assistant after a restart", async () => {
    const agent = agentWith([
      messageEntry("event-1", "hello"),
      markedAssistant({ entryId: "assistant-entry", messageId: "assistant-1", script: "restored narration", turnId: "turn-3", marker: delta(["event-1"]) }),
    ]);
    const instance = new NarrativeContextInstance({}, fixture);
    instance.attach(agent);

    const prepared = inputProjection(await instance.prepareEntries(await agent.storage.read()));
    expect(prepared.text).toContain("restored narration");
    expect(prepared.marker.inputEntryIds).toEqual(["assistant-entry"]);
    expect(narration(await agent.storage.read())).toHaveLength(1);

    // A second prepare must not project the same origin again.
    await instance.prepareEntries(await agent.storage.read());
    expect(narration(await agent.storage.read())).toHaveLength(1);
  });

  it("replaces the narrated body with the latest summary and keeps the newer tail", async () => {
    const agent = agentWith([
      messageEntry("event-1", "one"),
      markedAssistant({ entryId: "d1-entry", messageId: "delta-1", script: "FIRST", marker: delta(["event-1"]) }),
      messageEntry("event-2", "two"),
      markedAssistant({ entryId: "d2-entry", messageId: "delta-2", script: "SECOND", marker: delta(["event-2"]) }),
      markedAssistant({ entryId: "summary-entry", messageId: "summary-1", script: "SUMMARY", marker: { kind: "summary", throughOriginMessageId: "delta-2" } }),
      messageEntry("event-3", "three"),
      markedAssistant({ entryId: "d3-entry", messageId: "delta-3", script: "TAIL", marker: delta(["event-3"]) }),
    ]);
    const instance = new NarrativeContextInstance({}, fixture);
    instance.attach(agent);

    const { text } = inputProjection(await instance.prepareEntries(await agent.storage.read()));
    expect(text).toContain("SUMMARY");
    expect(text).toContain("TAIL");
    expect(text).not.toContain("FIRST");
    expect(text).not.toContain("SECOND");
  });

  it("keeps exact evidence for the active turn without narrating it twice", async () => {
    const agent = agentWith([
      messageEntry("request-file", "Use /home/project/report-2026.txt"),
      markedAssistant({
        entryId: "plan-entry",
        messageId: "plan-message",
        script: "She has located the requested file and continues working.",
        turnId: "working",
        marker: delta(["request-file"]),
      }),
      messageEntry("later-event", "Continue the analysis"),
    ]);
    const instance = new NarrativeContextInstance({ recentEntries: 0 }, fixture);
    instance.attach(agent);
    const active = await instance.prepareEntries(await agent.storage.read(), { turnId: "working", signal: new AbortController().signal });
    expect(inputProjection(active).marker.inputEntryIds).not.toContain("request-file");
    const activeText = JSON.stringify(instance.renderMessages(active.flatMap((entry) => (entry.type === "message" ? [entry.data] : []))));
    expect(activeText).toContain("/home/project/report-2026.txt");

    const later = await instance.prepareEntries(await agent.storage.read(), { turnId: "different-turn", signal: new AbortController().signal });
    const laterText = JSON.stringify(instance.renderMessages(later.flatMap((entry) => (entry.type === "message" ? [entry.data] : []))));
    expect(laterText).not.toContain("/home/project/report-2026.txt");
    expect(laterText).toContain("She has located the requested file");
  });

  it("recovers a summary and new passage from the same assistant message", async () => {
    const combined = createAssistantMessage(
      [
        { type: "reasoning", text: "CONDENSED PAST", providerOptions: narrativeOptions({ kind: "summary", throughOriginMessageId: "old-message" }) },
        { type: "reasoning", text: "NEW PASSAGE", providerOptions: narrativeOptions({ kind: "delta", inputEntryIds: ["new-event"], next: { kind: "stop" } }) },
      ],
      { id: "combined-message" },
    );
    const agent = agentWith([
      messageEntry("old-event", "old stimulus"),
      markedAssistant({ entryId: "old-assistant", messageId: "old-message", script: "VERBOSE PAST", marker: delta(["old-event"]) }),
      messageEntry("new-event", "new stimulus"),
      createEntry("message", combined),
    ]);
    const instance = new NarrativeContextInstance({}, fixture);
    instance.attach(agent);
    const history = inputProjection(await instance.prepareEntries(await agent.storage.read())).text;
    expect(history).toContain("CONDENSED PAST");
    expect(history).toContain("NEW PASSAGE");
    expect(history).not.toContain("VERBOSE PAST");
    expect(
      narration(await agent.storage.read())
        .filter((entry) => entry.originMessageId === "combined-message")
        .map((entry) => entry.kind),
    ).toEqual(["summary", "delta"]);
    await instance.prepareEntries(await agent.storage.read());
    expect(
      narration(await agent.storage.read())
        .filter((entry) => entry.originMessageId === "combined-message")
        .map((entry) => entry.kind),
    ).toEqual(["summary", "delta"]);
  });

  it("renders tool calls and results as action and observation blocks", async () => {
    const agent = agentWith([
      messageEntry("event-1", "hello"),
      createEntry(
        "message",
        createAssistantMessage([
          { type: "tool-call", toolCallId: "call-1", toolName: "probe", input: { nested: { a: 1 }, text: "value" } },
          { type: "tool-result", toolCallId: "call-1", toolName: "probe", output: { type: "json", value: { ok: true } } },
        ]),
        { id: "assistant-entry" },
      ),
    ]);
    const instance = new NarrativeContextInstance({}, fixture);
    instance.attach(agent);
    const prepared = await instance.prepareEntries(await agent.storage.read());
    const rendered = instance.renderMessages(prepared.flatMap((entry) => (entry.type === "message" ? [entry.data] : [])));
    const text = JSON.stringify(rendered);

    expect(text).toContain("<action>");
    expect(text).toContain("<function>probe</function>");
    expect(text).toContain('<nested>{\\"a\\":1}</nested>');
    expect(text).toContain("<text>value</text>");
    expect(text).toContain("<observation>");
    expect(text).toContain("<status>success</status>");
    expect(text).toContain('{\\"ok\\":true}');
  });

  it("names file parts by media type and size instead of copying their bytes", async () => {
    const agent = agentWith([
      messageEntry("event-1", "hello"),
      createEntry(
        "message",
        createAssistantMessage([
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "probe",
            output: { type: "content", value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } }] },
          },
        ]),
        { id: "assistant-entry" },
      ),
    ]);
    const instance = new NarrativeContextInstance({}, fixture);
    instance.attach(agent);
    const prepared = await instance.prepareEntries(await agent.storage.read());
    const text = JSON.stringify(instance.renderMessages(prepared.flatMap((entry) => (entry.type === "message" ? [entry.data] : []))));

    expect(text).toContain("[image/png 3 B]");
    expect(text).not.toContain("AAAA");
  });

  it("keeps sessions isolated between context instances", async () => {
    const left = agentWith();
    const right = agentWith();
    const leftInstance = new NarrativeContextInstance({}, fixture);
    const rightInstance = new NarrativeContextInstance({}, fixture);
    leftInstance.attach(left);
    rightInstance.attach(right);

    await left.storage.append(messageEntry("left-event", "hello"));
    await right.storage.append(messageEntry("right-event", "hello"));
    expect(inputProjection(await leftInstance.prepareEntries(await left.storage.read())).marker.inputEntryIds).toEqual(["left-event"]);
    expect(inputProjection(await rightInstance.prepareEntries(await right.storage.read())).marker.inputEntryIds).toEqual(["right-event"]);

    await right.storage.append(
      markedAssistant({
        entryId: "right-assistant",
        messageId: "right-message",
        script: "right narration",
        turnId: "turn-right",
        marker: delta(["right-event"]),
      }),
    );
    await right.channel.emit("agent", { type: "turn.step", turnId: "turn-right", stepNumber: 0 });

    expect(narration(await left.storage.read())).toHaveLength(0);
    expect(inputProjection(await leftInstance.prepareEntries(await left.storage.read())).marker.inputEntryIds).toEqual(["left-event"]);
    expect(inputProjection(await rightInstance.prepareEntries(await right.storage.read())).marker.inputEntryIds).toEqual(["right-assistant"]);
  });
});
