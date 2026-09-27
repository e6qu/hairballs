/**
 * Keep pi's Bedrock credentials fresh from the AgentCore Runtime execution role (shell).
 *
 * pi-ai's Bedrock provider reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
 * `AWS_SESSION_TOKEN` from the environment on every request (bedrock-converse-stream.js
 * `getConfiguredBedrockCredentials`) and does not detect instance-metadata credentials, which is
 * how AgentCore Runtime vends the role (AGENT_PI_BEDROCK.md §3.1). So we fetch them from the
 * metadata service (`fromInstanceMetadata`, honouring `AWS_EC2_METADATA_SERVICE_ENDPOINT`) and
 * write them into `process.env`, refreshing 5 minutes before expiry.
 *
 * Active only on AgentCore (`AGENTCORE_RUNTIME=1`); locally the normal AWS environment applies.
 * `fromInstanceMetadata` is `@smithy/credential-provider-imds`, already in pi-ai's AWS SDK tree
 * (the same function `@aws-sdk/credential-providers` re-exports), so no extra dependency.
 * Credential values are never logged.
 */

import { type Clock, type Env, Instant } from "@org/agents";

import { refreshDelay, RETRY_DELAY } from "../core/credentials.ts";
import { loadImds } from "./piAi.ts";

export type AwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  readonly expiration?: Date | undefined;
};

export type CredentialSource = () => Promise<AwsCredentials>;

export type CredentialRefresher = { stop(): void };

export function refreshEnabled(env: Env): boolean {
  return (env["AGENTCORE_RUNTIME"] ?? "").trim() === "1";
}

export async function instanceMetadataSource(): Promise<CredentialSource> {
  const { fromInstanceMetadata } = await loadImds();
  return fromInstanceMetadata({ maxRetries: 3, timeout: 1000 });
}

/** Fetch once (failing startup if that fails), then keep refreshing in the background. */
export async function startCredentialRefresh(options: {
  readonly source: CredentialSource;
  readonly env: Record<string, string | undefined>;
  readonly clock: Clock;
  readonly log?: (message: string) => void;
}): Promise<CredentialRefresher> {
  const { source, env, clock } = options;
  const log = options.log ?? ((message: string) => console.error(message));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const apply = (credentials: AwsCredentials): number => {
    env["AWS_ACCESS_KEY_ID"] = credentials.accessKeyId;
    env["AWS_SECRET_ACCESS_KEY"] = credentials.secretAccessKey;
    if (credentials.sessionToken === undefined) delete env["AWS_SESSION_TOKEN"];
    else env["AWS_SESSION_TOKEN"] = credentials.sessionToken;
    const expiration = credentials.expiration === undefined ? null : Instant.fromDate(credentials.expiration);
    return refreshDelay(expiration, clock.now());
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      source().then(
        (credentials) => schedule(apply(credentials)),
        (error: unknown) => {
          log(`credential refresh failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
          schedule(RETRY_DELAY);
        },
      );
    }, delayMs);
    timer.unref();
  };

  schedule(apply(await source()));
  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
