/** Tool authorization decisions (pure). Unlisted tools are denied; approval rules win over allow. */

import { type ToolName, ToolPattern, type ToolPolicy } from "../domain.ts";

export type Allowed = { readonly kind: "allowed" };
export type NeedsApproval = { readonly kind: "needs_approval"; readonly reason: string };
export type Denied = { readonly kind: "denied"; readonly reason: string };
export type ToolDecision = Allowed | NeedsApproval | Denied;

export function decideTool(tool: ToolName, policy: ToolPolicy): ToolDecision {
  const matches = (pattern: ToolPattern): boolean => ToolPattern.matches(pattern, tool);
  if (!policy.allowed.some(matches)) {
    return { kind: "denied", reason: `tool '${tool}' is not in the allowlist` };
  }
  if (policy.approvalRequired.some(matches)) {
    return { kind: "needs_approval", reason: `tool '${tool}' changes external state and needs approval` };
  }
  return { kind: "allowed" };
}
