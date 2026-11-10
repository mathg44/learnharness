import { enforcementReady } from "../../scripts/egress/state.mjs";
import { installServerEgressReadiness } from "../core/server-capabilities.ts";

// Read the guard's namespace-bound, expiring status on each capability check.
// The adapter remains outside the browser-safe core policy.
installServerEgressReadiness(() => enforcementReady());
