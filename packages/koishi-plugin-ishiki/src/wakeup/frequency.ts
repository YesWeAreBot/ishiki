export type JevFrequencyBlock = "global-frequency" | "join-cooldown";

interface Reservation {
  channel: string;
  at: number;
}

interface JevFrequencyState {
  lastGlobalProactiveAt?: number;
  lastChannelProactiveAt?: number;
}

const MAX_CHANNELS = 4096;
const MAX_RESERVATIONS = 512;

/** Profile-scoped proactive-speech reservations shared by all JEV runtimes. */
export class JevFrequencyLedger {
  private lastGlobalAt?: number;
  private readonly channelTimes = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation>();

  state(channel: string): JevFrequencyState {
    let lastGlobalProactiveAt = this.lastGlobalAt;
    let lastChannelProactiveAt = this.channelTimes.get(channel);
    for (const reservation of this.reservations.values()) {
      lastGlobalProactiveAt = Math.max(lastGlobalProactiveAt ?? -Infinity, reservation.at);
      if (reservation.channel === channel) {
        lastChannelProactiveAt = Math.max(lastChannelProactiveAt ?? -Infinity, reservation.at);
      }
    }
    return {
      lastGlobalProactiveAt,
      lastChannelProactiveAt,
    };
  }

  reserve(id: string, channel: string, at: number, globalMs: number, channelMs: number): JevFrequencyBlock | undefined {
    const state = this.state(channel);
    if (globalMs > 0 && state.lastGlobalProactiveAt !== undefined && at - state.lastGlobalProactiveAt < globalMs) return "global-frequency";
    if (channelMs > 0 && state.lastChannelProactiveAt !== undefined && at - state.lastChannelProactiveAt < channelMs) return "join-cooldown";
    this.reservations.set(id, { channel, at });
    if (this.reservations.size > MAX_RESERVATIONS) this.reservations.delete(this.reservations.keys().next().value!);
    return undefined;
  }

  commit(id: string, at: number): void {
    const reservation = this.reservations.get(id);
    if (reservation === undefined) return;
    this.reservations.delete(id);
    this.lastGlobalAt = Math.max(this.lastGlobalAt ?? 0, at);
    this.channelTimes.set(reservation.channel, Math.max(this.channelTimes.get(reservation.channel) ?? 0, at));
    if (this.channelTimes.size > MAX_CHANNELS) this.channelTimes.delete(this.channelTimes.keys().next().value!);
  }

  release(id: string): void {
    this.reservations.delete(id);
  }

  releaseRuntime(runtimeId: string): void {
    const prefix = `${runtimeId}\0`;
    for (const id of this.reservations.keys()) {
      if (id.startsWith(prefix)) this.reservations.delete(id);
    }
  }
}

const ledgers = new WeakMap<object, JevFrequencyLedger>();

export function getJevFrequencyLedger(owner: object): JevFrequencyLedger {
  let ledger = ledgers.get(owner);
  if (ledger === undefined) {
    ledger = new JevFrequencyLedger();
    ledgers.set(owner, ledger);
  }
  return ledger;
}
