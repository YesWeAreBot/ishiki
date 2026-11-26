// Koishi loads its plugins through CommonJS. Both entry points must share the host's service registry.
import bridge from "./lib/index.cjs";

export default bridge.default;
