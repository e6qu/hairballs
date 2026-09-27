/**
 * `credential_process` helper for opencode's Bedrock provider (AGENTS_OPENCODE_BEDROCK.md §3.1).
 *
 * opencode only enables the AWS SDK credential chain when it sees a profile (among others), and
 * AgentCore Runtime vends the execution-role credentials through an instance-metadata endpoint.
 * The image therefore ships an AWS config profile
 *
 *     [profile agentcore]
 *     credential_process = node /app/generic-agents/opencode-harness/src/shell/imdsCredentials.ts
 *
 * and sets AWS_PROFILE=agentcore for the opencode child. The SDK calls this script whenever the
 * cached credentials approach `Expiration`, so they refresh automatically (no long-lived keys, no
 * one-time snapshot). It prints the credential_process JSON on stdout and nothing else.
 *
 * Replaces the curl + jq sketch in the design doc: node is already in the image.
 */

import { fileURLToPath } from "node:url";

import { attempt, expectObject, expectString, field, must, type Parsed } from "@org/agents";

export type ProcessCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: string;
};

/** Parse the IMDS security-credentials document (boundary). */
export function parseImdsCredentials(raw: unknown): Parsed<ProcessCredentials> {
  return attempt(() => {
    const doc = must(expectObject(raw, "$"));
    const text = (name: string): string => must(expectString(must(field(doc, name, "$")), `$.${name}`));
    return {
      accessKeyId: text("AccessKeyId"),
      secretAccessKey: text("SecretAccessKey"),
      sessionToken: text("Token"),
      expiration: text("Expiration"),
    };
  });
}

/** The credential_process output format (Version 1). */
export function renderCredentialProcess(credentials: ProcessCredentials): string {
  return JSON.stringify({
    Version: 1,
    AccessKeyId: credentials.accessKeyId,
    SecretAccessKey: credentials.secretAccessKey,
    SessionToken: credentials.sessionToken,
    Expiration: credentials.expiration,
  });
}

/** IMDSv2: token → role name → credentials. */
export async function fetchImdsCredentials(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<ProcessCredentials> {
  const base = endpoint.replace(/\/$/, "");
  const timeout = (): AbortSignal => AbortSignal.timeout(2_000);
  const tokenResponse = await fetchImpl(`${base}/latest/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "300" },
    signal: timeout(),
  });
  if (!tokenResponse.ok) throw new Error(`IMDS token request failed: ${tokenResponse.status}`);
  const headers = { "x-aws-ec2-metadata-token": await tokenResponse.text() };
  const rolesResponse = await fetchImpl(`${base}/latest/meta-data/iam/security-credentials/`, { headers, signal: timeout() });
  if (!rolesResponse.ok) throw new Error(`IMDS role request failed: ${rolesResponse.status}`);
  const role = (await rolesResponse.text()).split("\n")[0]?.trim() ?? "";
  if (!/^[\w+=,.@-]{1,128}$/.test(role)) throw new Error("IMDS returned no valid role name");
  const credsResponse = await fetchImpl(`${base}/latest/meta-data/iam/security-credentials/${role}`, {
    headers,
    signal: timeout(),
  });
  if (!credsResponse.ok) throw new Error(`IMDS credentials request failed: ${credsResponse.status}`);
  const parsed = parseImdsCredentials(await credsResponse.json());
  if (parsed.kind === "err") throw parsed.error;
  return parsed.value;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const endpoint = process.env["AWS_EC2_METADATA_SERVICE_ENDPOINT"] ?? "http://169.254.169.254";
  fetchImdsCredentials(endpoint).then(
    (credentials) => process.stdout.write(`${renderCredentialProcess(credentials)}\n`),
    (error: unknown) => {
      process.stderr.write(`imds credentials: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
