// Lambda function behind the gateway. It implements one tool: check_claim.
// Deploy compiled to JavaScript with runtime nodejs22.x and handler "expenses-tool.handler".

const LIMITS_EUR: Record<string, Record<string, number>> = {
  hotel: { major: 180, standard: 120 },
  meals: { major: 60, standard: 60 },
};

interface ClaimInput {
  category: string;
  amount_eur: number;
  city_class?: string;
}

interface ClaimResult {
  within_policy: boolean;
  limit_eur: number;
}

interface GatewayContext {
  // Node receives the client context as sent; handle both spellings of "custom".
  clientContext?: { custom?: Record<string, string>; Custom?: Record<string, string> };
}

function checkClaim({ category, amount_eur, city_class = "standard" }: ClaimInput): ClaimResult {
  const limit = LIMITS_EUR[category]?.[city_class];
  if (limit === undefined) throw new Error(`unknown category: ${category}/${city_class}`);
  return { within_policy: amount_eur <= limit, limit_eur: limit };
}

export async function handler(event: ClaimInput, context: GatewayContext): Promise<ClaimResult> {
  // The gateway passes the tool arguments as the event, and the tool name
  // as "<target>___<tool>" in the client context.
  const custom = context.clientContext?.custom ?? context.clientContext?.Custom ?? {};
  const tool = (custom.bedrockAgentCoreToolName ?? "").split("___").pop();
  if (tool !== "check_claim") throw new Error(`unknown tool: ${tool}`);
  return checkClaim(event);
}
