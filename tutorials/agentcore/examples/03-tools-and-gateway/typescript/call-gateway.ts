// Call the gateway's MCP endpoint directly: list its tools, then call one.
// The gateway uses AWS_IAM inbound auth, so every request is signed with your
// AWS credentials (SigV4, service "bedrock-agentcore").
// Usage: GATEWAY_URL=https://<id>.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp \
//        npm run call-gateway
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignatureV4 } from "@smithy/signature-v4";

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

async function main(gatewayUrl: string): Promise<void> {
  const client = new Client({ name: "helpdesk-app", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gatewayUrl), { fetch: signedFetch }),
  );

  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(tool.name); // "<target>___<tool>", e.g. expenses___check_claim
  }

  const result = await client.callTool({
    name: "expenses___check_claim",
    arguments: { category: "hotel", amount_eur: 210, city_class: "major" },
  });
  console.log(JSON.stringify(result.content));
  await client.close();
}

const gatewayUrl = process.env.GATEWAY_URL;
if (!gatewayUrl) throw new Error("Set GATEWAY_URL");
await main(gatewayUrl);
