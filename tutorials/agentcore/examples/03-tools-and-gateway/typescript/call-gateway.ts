// Call the gateway's MCP endpoint directly: list its tools, then check a claim (the shell).
// The gateway uses AWS_IAM inbound auth, so every request is signed with your
// AWS credentials (SigV4, service "bedrock-agentcore").
// Usage: GATEWAY_URL=https://<id>.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp \
//        npm run call-gateway
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignatureV4 } from "@smithy/signature-v4";
import { render } from "./core.ts";
import {
  type Claim,
  type GatewayToolName,
  type GatewayUrl,
  ParseError,
  eurToJson,
  formatToolName,
  parseClaim,
  parseGatewayUrl,
  parseVerdict,
} from "./domain.ts";

const CHECK_CLAIM: GatewayToolName = { target: "expenses", tool: "check_claim" };

const signer = new SignatureV4({
  service: "bedrock-agentcore",
  region: "eu-west-1",
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});

// A fetch that signs each request (adds Authorization and X-Amz-Date headers).
async function signedFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const signed = await signer.sign({
    method: init.method ?? "GET",
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port ? Number(target.port) : undefined,
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    headers: { host: target.host },
    body: typeof init.body === "string" ? init.body : undefined,
  });
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(signed.headers)) {
    if (name !== "host") headers.set(name, value);
  }
  return fetch(target, { ...init, headers });
}

async function check(gateway: GatewayUrl, claim: Claim): Promise<void> {
  const client = new Client({ name: "helpdesk-app", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway), { fetch: signedFetch }));
  try {
    const { tools } = await client.listTools();
    console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

    const result = await client.callTool({
      name: formatToolName(CHECK_CLAIM),
      arguments: toArguments(claim),
    });
    const content: unknown[] = Array.isArray(result.content) ? result.content : [];
    const text = content.map(textOf).find((t) => t !== undefined);
    if (result.isError || text === undefined) {
      throw new Error(`${formatToolName(CHECK_CLAIM)} failed`);
    }
    console.log(render(claim, parseVerdict(text))); // outside data -> domain type
  } finally {
    await client.close();
  }
}

// The text of an MCP content block, if it is a text block.
function textOf(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null || !("text" in block)) return undefined;
  return typeof block.text === "string" ? block.text : undefined;
}

// The tool arguments, as the tool schema in tools/expenses-tools.json defines them.
function toArguments(claim: Claim): Record<string, unknown> {
  return { category: claim.category, amount_eur: eurToJson(claim.amount), city_class: claim.city };
}

async function main(): Promise<number> {
  let gateway: GatewayUrl, claim: Claim;
  try {
    gateway = parseGatewayUrl(process.env.GATEWAY_URL ?? "");
    claim = parseClaim({ category: "hotel", amount_eur: 210, city_class: "major" });
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    console.error(`error: ${error.message}\nusage: GATEWAY_URL=https://... call-gateway.ts`);
    return 2;
  }
  await check(gateway, claim);
  return 0;
}

process.exitCode = await main();
