import { THINK_LEVELS, type Gateway } from "@yesimagent/gateway";

/**
 * Whether every model a reference can resolve to declares image input.
 *
 * A group is checked member by member, including members the circuit breaker
 * currently hides — a failover must not land on a text-only model. A
 * `provider:model[:thinkLevel]` reference resolves through `gateway.model`,
 * the same catalog key the gateway itself uses, so the lookup is one map
 * read instead of a scan over the whole catalog.
 */
export function supportsImageInput(gateway: Gateway, reference: string): boolean {
  if (gateway.groups().includes(reference)) {
    const members = Object.keys(gateway.group(reference).status());
    return members.length > 0 && members.every((member) => declaresImage(gateway, member));
  }
  return declaresImage(gateway, reference);
}

/**
 * Read the model's declared input. A trailing `:level` counts only when the
 * reference already has a provider and a model id — the same rule the gateway
 * uses, so a model whose id is itself a level name (`provider:high`) stays intact.
 */
function declaresImage(gateway: Gateway, reference: string): boolean {
  const levelAt = reference.lastIndexOf(":");
  const modelAt = reference.lastIndexOf(":", levelAt - 1);
  const level = reference.slice(levelAt + 1);
  const base = modelAt !== -1 && (THINK_LEVELS as readonly string[]).includes(level) ? reference.slice(0, levelAt) : reference;
  const metadata = gateway.model(base)?.metadata as { input?: readonly string[] } | undefined;
  return metadata?.input?.includes("image") === true;
}
