// Lambda function behind the gateway, implementing the tool check_claim (the shell).
// Deploy compiled to JavaScript with runtime nodejs22.x and handler "expenses-tool.handler".
import { checkClaim } from "./core.ts";
import {
  ParseError,
  type Verdict,
  eurToJson,
  formatToolName,
  parseClaim,
  parseInvokedTool,
} from "./domain.ts";

export async function handler(event: unknown, context: unknown): Promise<Record<string, unknown>> {
  // The gateway passes the tool arguments as the event, and the tool name
  // as "<target>___<tool>" in the client context.
  const tool = parseInvokedTool(context);
  if (tool.tool !== "check_claim") throw new ParseError(`unknown tool: ${formatToolName(tool)}`);
  return toJson(checkClaim(parseClaim(event)));
}

// The tool result the model reads.
function toJson(verdict: Verdict): Record<string, unknown> {
  switch (verdict.kind) {
    case "within":
      return { within_policy: true, limit_eur: eurToJson(verdict.limit) };
    case "over":
      return {
        within_policy: false,
        limit_eur: eurToJson(verdict.limit),
        excess_eur: eurToJson(verdict.excess),
      };
  }
}
