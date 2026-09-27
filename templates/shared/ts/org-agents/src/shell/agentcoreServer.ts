/**
 * The AgentCore Runtime HTTP contract on `node:http` (the TypeScript counterpart of
 * `BedrockAgentCoreApp`):
 *
 *   GET  /ping        → {"status": "Healthy"} or {"status": "HealthyBusy"} while invocations run
 *   POST /invocations → body parsed as `unknown` → Incoming → injected handler → render(reply)
 *
 * The session id comes from `x-amzn-bedrock-agentcore-runtime-session-id`, the sender from the
 * forwarded JWT (`principalFromHeaders`). Invalid input yields
 * `{"status": "invalid_request", "path": ..., "error": ...}`, like the Python variants.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Reply } from "../core/conversation.ts";
import type { Incoming } from "../core/messages.ts";
import { SessionId } from "../domain.ts";
import { attempt, must, ParseError } from "../parsing.ts";
import { parseIncoming, principalFromHeaders } from "./invocation.ts";
import { dumps } from "./json.ts";
import { render } from "./replies.ts";

export const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";
export const LOCAL_SESSION = "local-session-0000000000000000000000";
const MAX_BODY_BYTES = 1024 * 1024;

export type InvocationHandler = (session: SessionId, incoming: Incoming) => Promise<Reply>;

export type AgentCoreServerOptions = {
  readonly handler: InvocationHandler;
  /** Default `0.0.0.0` (the AgentCore Runtime container contract). */
  readonly host?: string;
  /** Default 8080 (the AgentCore Runtime container contract); 0 picks a free port. */
  readonly port?: number;
  /** Unexpected handler failures (bugs, infrastructure). Default: log to stderr. */
  readonly onError?: (error: unknown) => void;
};

export type RunningAgentCoreServer = {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = dumps(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

const invalid = (error: ParseError): Record<string, unknown> => ({
  status: "invalid_request",
  path: error.path,
  error: error.detail,
});

type Parsed = { readonly session: SessionId; readonly incoming: Incoming };

function parseRequest(request: IncomingMessage, bodyText: string) {
  return attempt((): Parsed => {
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      throw new ParseError("$", "is not valid JSON");
    }
    const header = request.headers[SESSION_HEADER];
    const sessionRaw = (Array.isArray(header) ? header[0] : header) || LOCAL_SESSION;
    const session = must(SessionId.parse(sessionRaw, "$.session"));
    const sender = must(principalFromHeaders(request.headers));
    const incoming = must(parseIncoming(raw, sender));
    return { session, incoming };
  });
}

/** Build the request listener (usable with any `node:http` server, or in tests). */
export function agentCoreRequestListener(
  handler: InvocationHandler,
  onError: (error: unknown) => void = (error) => console.error("invocation failed:", error),
): { readonly listener: (request: IncomingMessage, response: ServerResponse) => void; readonly busy: () => number } {
  let inFlight = 0;

  const invocations = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let bodyText: string;
    try {
      bodyText = await readBody(request);
    } catch (error) {
      if (error instanceof BodyTooLarge) send(response, 413, invalid(new ParseError("$", "body is too large")));
      return;
    }
    const parsed = parseRequest(request, bodyText);
    if (parsed.kind === "err") {
      send(response, 200, invalid(parsed.error));
      return;
    }
    inFlight += 1;
    try {
      const reply = await handler(parsed.value.session, parsed.value.incoming);
      send(response, 200, render(reply));
    } catch (error) {
      onError(error);
      send(response, 500, { status: "error", error: "internal error" });
    } finally {
      inFlight -= 1;
    }
  };

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const path = (request.url ?? "/").split("?")[0];
    if (request.method === "GET" && path === "/ping") {
      send(response, 200, { status: inFlight > 0 ? "HealthyBusy" : "Healthy" });
    } else if (request.method === "POST" && path === "/invocations") {
      invocations(request, response).catch((error: unknown) => {
        onError(error);
        if (!response.headersSent) send(response, 500, { status: "error", error: "internal error" });
      });
    } else {
      send(response, 404, { status: "not_found" });
    }
  };

  return { listener, busy: () => inFlight };
}

/** Start the server and resolve once it is listening. */
export function startAgentCoreServer(options: AgentCoreServerOptions): Promise<RunningAgentCoreServer> {
  const { listener } = agentCoreRequestListener(options.handler, options.onError);
  const server = createServer(listener);
  const host = options.host ?? "0.0.0.0";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      const urlHost = host.includes(":") ? `[${host}]` : host;
      resolve({
        server,
        host,
        port: address.port,
        url: `http://${urlHost}:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
