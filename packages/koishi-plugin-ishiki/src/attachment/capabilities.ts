import type { Gateway } from "@yesimagent/gateway";

/** Check every declared member, including those temporarily excluded by the circuit breaker. */
export function supportsImageInput(gateway: Gateway, reference: string): boolean {
  const references = gateway.groups().includes(reference) ? Object.keys(gateway.group(reference).status()) : [reference];
  return (
    references.length > 0 &&
    references.every((id) => {
      const declared = gateway
        .models("language")
        .find(
          (model) =>
            model.id === id ||
            (id.startsWith(`${model.id}:`) && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(id.slice(model.id.length + 1))),
        );
      return declared?.metadata.input?.includes("image") === true;
    })
  );
}
