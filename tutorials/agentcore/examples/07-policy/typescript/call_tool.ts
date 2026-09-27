// Call a Gateway tool over MCP and tell a policy denial apart from other errors.
const GATEWAY_URL =
  process.env.GATEWAY_URL ??
  "https://helpdesk-tools-abc123xyz.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp";
const DENIED = "AuthorizeActionException"; // the Gateway's text for a Cedar deny

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

/** The policy engine refused this tool call. Retrying will not help. */
export class PolicyDenied extends Error {}

export function textOrThrow(result: ToolResult): string {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (result.isError) {
    if (text.startsWith(DENIED)) throw new PolicyDenied(text);
    throw new Error(text);
  }
  return text;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  token: string,
): Promise<string> {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const reply = (await response.json()) as { result: ToolResult };
  return textOrThrow(reply.result);
}

const token = process.env.ACCESS_TOKEN!; // Auth0 access token, audience https://agents.fintech.example
try {
  console.log(
    await callTool("tickets___create_ticket", { title: "VPN down", description: "..." }, token),
  );
} catch (err) {
  if (!(err instanceof PolicyDenied)) throw err;
  console.error(`not allowed: ${err.message}`);
  process.exitCode = 2;
}
