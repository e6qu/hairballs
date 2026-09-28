// Call a Gateway tool as the signed-in user (the imperative shell).
// Usage: ACCESS_TOKEN=<Auth0 token> GATEWAY_URL=https://.../mcp npm run call-tool
import { render, toolsCall } from "./core.ts";
import {
  type AccessToken,
  type Decision,
  type GatewayUrl,
  ParseError,
  type ToolName,
  parseAccessToken,
  parseGatewayUrl,
  parseToolName,
  parseToolReply,
} from "./domain.ts";

async function callTool(
  gateway: GatewayUrl,
  token: AccessToken,
  tool: ToolName,
  args: Readonly<Record<string, unknown>>,
): Promise<Decision> {
  const response = await fetch(gateway, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(toolsCall(1, tool, args)),
  });
  return parseToolReply(await response.json()); // outside data -> Decision, right here
}

async function main(): Promise<number> {
  let gateway: GatewayUrl, token: AccessToken, tool: ToolName;
  try {
    gateway = parseGatewayUrl(process.env.GATEWAY_URL ?? "");
    token = parseAccessToken(process.env.ACCESS_TOKEN ?? "");
    tool = parseToolName("tickets___create_ticket");
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    console.error(`error: ${error.message}`);
    return 2;
  }
  const decision = await callTool(gateway, token, tool, { title: "VPN down", description: "..." });
  const { text, code } = render(decision);
  (code === 0 ? console.log : console.error)(text);
  return code;
}

process.exitCode = await main();
