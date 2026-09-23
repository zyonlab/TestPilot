import type { Request } from "express";
import type { Principal } from "@testpilot/harness-core/run-contracts";
import { LedgerError } from "./runLedger.js";

/** Local operator actions require no login. This records an action source, not verified identity.
 * Explicit agent credentials never confer operator authority; their run routes validate capabilities.
 * Without authentication, this local API is not an isolation boundary against clients omitting a token.
 */
export function reviewerPrincipal(req: Pick<Request, "headers">): Principal {
  if (req.headers.authorization !== undefined || req.headers["x-testpilot-actor"] !== undefined) throw new LedgerError(403, "operator_action_required");
  return { kind: "human", id: "local-operator" };
}
