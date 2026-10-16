import { afterEach, describe, expect, it, vi } from "vitest";

import { createWaitTool, WaitConditionMachine } from "../src/builtin-tools/wait.js";

const logger = { warn() {}, error() {}, info() {}, debug() {}, level: 1 } as never;

function harness() {
  const wakes: string[] = [];
  const agent = {
    continue: (reason?: string) => {
      wakes.push(reason ?? "");
      return "wake-turn";
    },
  } as never;
  const machine = new WaitConditionMachine(logger);
  machine.bind(agent);
  return { machine, wakes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wait tool", () => {
  it("rejects out-of-range windows", async () => {
    const { machine } = harness();
    const wait = createWaitTool(machine);
    await expect(wait.execute!({ msgs: -1 }, {} as never)).resolves.toMatchObject({ ok: false });
    await expect(wait.execute!({ msgs: 1.5 }, {} as never)).resolves.toMatchObject({ ok: false });
    await expect(wait.execute!({ msgs: 1001 }, {} as never)).resolves.toMatchObject({ ok: false });
    await expect(wait.execute!({ secs: 0 }, {} as never)).resolves.toMatchObject({ ok: false });
    await expect(wait.execute!({ secs: 2.5 }, {} as never)).resolves.toMatchObject({ ok: false });
  });

  it("echoes the declared windows, and none when nothing is declared", async () => {
    const { machine } = harness();
    const wait = createWaitTool(machine);
    await expect(wait.execute!({ msgs: 2 }, {} as never)).resolves.toEqual({ ok: true, declared: { msgs: 2 } });
    await expect(wait.execute!({ secs: 30 }, {} as never)).resolves.toEqual({ ok: true, declared: { secs: 30 } });
    await expect(wait.execute!({ msgs: 2, secs: 30 }, {} as never)).resolves.toEqual({ ok: true, declared: { msgs: 2, secs: 30 } });
    // 没有配置兜底：空调用与 {msgs: 0} 都是「不声明」。
    await expect(wait.execute!({}, {} as never)).resolves.toEqual({ ok: true, none: true });
    await expect(wait.execute!({ msgs: 0 }, {} as never)).resolves.toEqual({ ok: true, none: true });
    // secs 单独给出时 msgs:0 被忽略，仍是一次有效声明。
    await expect(wait.execute!({ msgs: 0, secs: 30 }, {} as never)).resolves.toEqual({ ok: true, declared: { secs: 30 } });
  });
});

describe("WaitConditionMachine", () => {
  it("stays idle when a turn ends without a declaration", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.onTurnEnd("done");
    machine.countInput();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(wakes).toEqual([]);
  });

  it("stays idle on failed and aborted turns even with a declaration", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.declare({ msgs: 1 });
    machine.onTurnEnd("failed");
    machine.countInput();
    expect(wakes).toEqual([]);

    machine.declare({ msgs: 1 });
    machine.onTurnEnd("aborted");
    machine.countInput();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(wakes).toEqual([]);
  });

  it("the msgs window wakes first-come and clears on trigger", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.declare({ msgs: 2 });
    machine.onTurnEnd("done");
    machine.countInput();
    expect(wakes).toEqual([]);
    machine.countInput();
    expect(wakes).toEqual(["2 new inputs"]);
    // 触发即清空：一次性声明，后续输入不再触发。
    machine.countInput();
    expect(wakes).toEqual(["2 new inputs"]);
  });

  it("the secs window wakes once and does not repeat", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.declare({ secs: 30 });
    machine.onTurnEnd("done");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(wakes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(wakes).toEqual(["timer 30s expired"]);
    // 不是节拍器：不再来第二响。
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(wakes).toEqual(["timer 30s expired"]);
  });

  it("keeps the last declaration of a turn", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.declare({ msgs: 1 });
    machine.declare({ secs: 30 });
    machine.onTurnEnd("done");
    // 最后一次生效：消息窗口不再起作用，只有定时器。
    machine.countInput();
    expect(wakes).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wakes).toEqual(["timer 30s expired"]);
  });

  it("treats a bare call as no declaration", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.declare({ msgs: 1 });
    machine.declare({});
    machine.onTurnEnd("done");
    machine.countInput();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(wakes).toEqual([]);
  });

  it("settles inputs that arrived during a turn when the declared msgs window is already satisfied", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    // 轮进行期间到达两条（条件未生效 → duringTurn 暂记）。
    machine.onTurnStart();
    machine.countInput();
    machine.countInput();
    // 轮末声明 msgs:1：已到达数已满足，生效即结算触发，不等下一条。
    machine.declare({ msgs: 1 });
    machine.onTurnEnd("done");
    expect(wakes).toEqual(["2 new inputs"]);
  });

  it("does not count inputs that arrived during a turn toward the new condition", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.onTurnStart();
    machine.countInput();
    // 轮末声明 msgs:2：本轮已见过的这一条不占名额，还差两条。
    machine.declare({ msgs: 2 });
    machine.onTurnEnd("done");
    machine.countInput();
    expect(wakes).toEqual([]);
    machine.countInput();
    expect(wakes).toEqual(["2 new inputs"]);
  });

  it("clears the condition at turn start so a signal turn cannot double-count the same inputs", async () => {
    vi.useFakeTimers();
    const { machine, wakes } = harness();

    machine.declare({ msgs: 2 });
    machine.onTurnEnd("done");
    // 信号轮开轮：轮内到达的消息记进 duringTurn，不再叠加到生效中的 count 上。
    machine.onTurnStart();
    machine.countInput();
    machine.declare({ msgs: 2 });
    machine.onTurnEnd("done");
    expect(wakes).toEqual([]);
    machine.countInput();
    machine.countInput();
    expect(wakes).toEqual(["2 new inputs"]);
  });
});
